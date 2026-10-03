import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { cpus, hostname, platform, release, totalmem } from "node:os"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const trustedOrigin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const rounds = positiveInteger(process.env.CLASS_CONCURRENCY_ROUNDS, 8)
const minimumStudents = positiveInteger(process.env.CLASS_CONCURRENCY_MIN_STUDENTS, 20)
const minimumRounds = positiveInteger(process.env.CLASS_CONCURRENCY_MIN_ROUNDS, 20)
const maximumP95Ms = positiveNumber(process.env.CLASS_CONCURRENCY_MAX_P95_MS, 2_000)
const requireFormalClass = process.env.CLASS_CONCURRENCY_REQUIRE_FORMAL === "true"
const targetLabel = process.env.CLASS_CONCURRENCY_TARGET_LABEL?.trim() || process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const classroomOverride = process.env.CLASS_CONCURRENCY_CLASS_ID?.trim() || ""
const outputPath = resolve(argument("output") ?? `artifacts/class-concurrency/class-concurrency-${timestamp()}.json`)
await ensureServiceAvailable()
const credentialSet = await loadCredentialSet()
const checks = []

if (credentialSet.students.length < 2) throw new Error("班级并发验收至少需要两个学生账号")

const teacher = await login("teacher", credentialSet.teacher)
const students = await Promise.all(credentialSet.students.map((credentials, index) => login(`student-${index + 1}`, credentials)))
const teacherClasses = await request("/api/v1/education/classes", { cookie: teacher.cookie })
const studentInitial = await Promise.all(students.map(async (student) => {
  const [classes, projects, forbiddenOverview, forbiddenProgress] = await Promise.all([
    request("/api/v1/education/classes", { cookie: student.cookie }),
    request("/api/v3/my-projects", { cookie: student.cookie }),
    request("/api/v3/teaching/overview", { cookie: student.cookie }),
    request("/api/v3/teaching/progress", { cookie: student.cookie })
  ])
  return { student, classes, projects, forbiddenOverview, forbiddenProgress }
}))
const [teacherOverview, teacherProgress] = await Promise.all([
  request("/api/v3/teaching/overview", { cookie: teacher.cookie }),
  request("/api/v3/teaching/progress", { cookie: teacher.cookie })
])

const classroom = selectClassroom(teacherClasses.body, studentInitial.map((item) => item.classes.body), classroomOverride)
if (teacherClasses.status !== 200 || !classroom?.id) throw new Error("教师与学生没有共同可访问的教学班")

const studentScopes = studentInitial.map((item) => {
  const projects = collection(item.projects.body)
  const selectedProject = projects[0]
  if (item.projects.status !== 200 || !selectedProject?.id) throw new Error(`${item.student.actor} 没有可访问的 V3 项目`)
  return { ...item, projects, selectedProject }
})
const memberResponses = await Promise.all([teacher, ...students].map((actor) => request(`/api/v1/education/classes/${classroom.id}/students`, { cookie: actor.cookie })))
const crossAccess = await Promise.all(studentScopes.flatMap((scope, index) => {
  const next = studentScopes[(index + 1) % studentScopes.length]
  return [
    request(`/api/v3/projects/${scope.selectedProject.id}/stages`, { cookie: scope.student.cookie }),
    request(`/api/v3/projects/${next.selectedProject.id}/stages`, { cookie: scope.student.cookie })
  ]
}))

record("TEACHER_CLASS_SCOPE", teacherClasses.status === 200 && ids(teacherClasses.body).includes(classroom.id), {
  classroomId: classroom.id,
  teacherClassCount: collection(teacherClasses.body).length
})
record("STUDENT_CLASS_SCOPE", studentScopes.every((scope) => scope.classes.status === 200 && ids(scope.classes.body).includes(classroom.id)), {
  classroomId: classroom.id,
  studentCount: students.length,
  classCounts: studentScopes.map((scope) => collection(scope.classes.body).length)
})
record("CLASS_MEMBER_SCOPE", memberResponses.every((response) => response.status === 200), {
  statuses: memberResponses.map((response) => response.status),
  visibleMemberCounts: memberResponses.map((response) => collection(response.body).length)
})
record("TEACHER_AGGREGATE_SCOPE", teacherOverview.status === 200 && teacherProgress.status === 200, {
  overviewStatus: teacherOverview.status,
  progressStatus: teacherProgress.status,
  progressCount: collection(teacherProgress.body).length
})
record("STUDENT_AGGREGATE_FORBIDDEN", studentScopes.every((scope) => scope.forbiddenOverview.status === 403 && scope.forbiddenProgress.status === 403), {
  statuses: studentScopes.map((scope) => ({ actor: scope.student.actor, overview: scope.forbiddenOverview.status, progress: scope.forbiddenProgress.status }))
})
record("PROJECT_ISOLATION", crossAccess.every((response, index) => response.status === (index % 2 === 0 ? 200 : 403)), {
  statuses: crossAccess.map((response) => response.status)
})
const projectIsolation = projectSetsPairwiseDisjoint(studentScopes.map((scope) => scope.projects))
record("PROJECT_LIST_ISOLATION", projectIsolation.disjoint, {
  studentCount: students.length,
  collisions: projectIsolation.collisions,
  projectCounts: studentScopes.map((scope) => scope.projects.length)
})

const concurrentRounds = []
const durationSamples = []
for (let round = 0; round < rounds; round += 1) {
  const plan = buildRoundPlan(teacher, classroom.id, studentScopes)
  const responses = await Promise.all(plan.map((item) => request(item.path, { cookie: item.cookie })))
  durationSamples.push(...responses.map((response) => response.durationMs))
  const assertions = responses.map((response, index) => {
    const item = plan[index]
    return response.status === item.expectedStatus && (!item.stableIds || sameIds(response.body, item.stableIds))
  })
  concurrentRounds.push({
    round: round + 1,
    passed: assertions.every(Boolean),
    unexpectedResponses: assertions.filter((passed) => !passed).length,
    statuses: responses.map((response) => response.status),
    durationMs: roundNumber(Math.max(...responses.map((response) => response.durationMs)))
  })
}
record("CONCURRENT_ISOLATION", concurrentRounds.every((round) => round.passed), {
  rounds,
  passedRounds: concurrentRounds.filter((round) => round.passed).length,
  requestsPerRound: buildRoundPlan(teacher, classroom.id, studentScopes).length,
  results: concurrentRounds
})

const latency = summarizeDurations(durationSamples)
const functionalPassed = checks.every((check) => check.passed)
const formalClassQualified = functionalPassed
  && students.length >= minimumStudents
  && rounds >= minimumRounds
  && latency.p95Ms <= maximumP95Ms
const report = {
  format: "wurenji-class-concurrency-smoke",
  formatVersion: 2,
  status: functionalPassed ? "PASSED" : "FAILED",
  generatedAt: new Date().toISOString(),
  environment: {
    targetLabel,
    hostname: hostname(),
    platform: platform(),
    release: release(),
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    baseUrl
  },
  configuration: {
    rounds,
    studentCount: students.length,
    minimumStudents,
    minimumRounds,
    maximumP95Ms,
    requireFormalClass,
    credentialsSource: process.env.CLASS_CONCURRENCY_CREDENTIALS_FILE ? "FILE" : "ENV_OR_DEMO"
  },
  scope: {
    classroomId: classroom.id,
    teacherClassCount: collection(teacherClasses.body).length,
    students: studentScopes.map((scope) => ({
      actor: scope.student.actor,
      userId: scope.student.user?.id ?? null,
      projectCount: scope.projects.length,
      projectIdsSha256: digestIds(scope.projects),
      selectedProjectId: scope.selectedProject.id
    }))
  },
  load: {
    totalRequests: durationSamples.length,
    requestsPerRound: buildRoundPlan(teacher, classroom.id, studentScopes).length,
    latency
  },
  qualification: {
    functionalPassed,
    studentScaleQualified: students.length >= minimumStudents,
    roundsQualified: rounds >= minimumRounds,
    latencyQualified: latency.p95Ms <= maximumP95Ms,
    formalClassQualified
  },
  summary: {
    total: checks.length,
    passed: checks.filter((check) => check.passed).length,
    failed: checks.filter((check) => !check.passed).length,
    functionalPassed,
    formalClassQualified
  },
  checks
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
if (!functionalPassed || (requireFormalClass && !formalClassQualified)) process.exitCode = 1

async function ensureServiceAvailable() {
  try {
    const response = await fetch(`${baseUrl}/api/healthz`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(`healthz 返回 HTTP ${response.status}`)
  } catch (error) {
    const report = {
      format: "wurenji-class-concurrency-smoke",
      formatVersion: 2,
      status: "BLOCKED",
      generatedAt: new Date().toISOString(),
      environment: { targetLabel, baseUrl },
      summary: { total: 0, passed: 0, failed: 0, functionalPassed: false, formalClassQualified: false },
      checks: [],
      reason: error instanceof Error ? error.message : String(error)
    }
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
    process.exit(1)
  }
}

function buildRoundPlan(teacherActor, classroomId, scopes) {
  const plan = [
    { path: "/api/v1/education/classes", cookie: teacherActor.cookie, expectedStatus: 200 },
    { path: `/api/v1/education/classes/${classroomId}/students`, cookie: teacherActor.cookie, expectedStatus: 200 },
    { path: "/api/v3/teaching/overview", cookie: teacherActor.cookie, expectedStatus: 200 },
    { path: "/api/v3/teaching/progress", cookie: teacherActor.cookie, expectedStatus: 200 }
  ]
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index]
    const next = scopes[(index + 1) % scopes.length]
    plan.push(
      { path: "/api/v3/my-projects", cookie: scope.student.cookie, expectedStatus: 200, stableIds: ids(scope.projects) },
      { path: `/api/v3/projects/${scope.selectedProject.id}/stages`, cookie: scope.student.cookie, expectedStatus: 200 },
      { path: `/api/v3/projects/${next.selectedProject.id}/stages`, cookie: scope.student.cookie, expectedStatus: 403 },
      { path: "/api/v3/teaching/progress", cookie: scope.student.cookie, expectedStatus: 403 }
    )
  }
  return plan
}

async function loadCredentialSet() {
  const path = process.env.CLASS_CONCURRENCY_CREDENTIALS_FILE?.trim()
  if (path) {
    const value = JSON.parse(await readFile(resolve(path), "utf8"))
    return {
      teacher: normalizeCredential(value.teacher, "teacher"),
      students: collection(value.students).map((item, index) => normalizeCredential(item, `students[${index}]`))
    }
  }
  return {
    teacher: normalizeCredential({ email: process.env.CLASS_TEACHER_EMAIL ?? "teacher@demo.local", password: process.env.CLASS_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? "" }, "teacher"),
    students: [
      normalizeCredential({ email: process.env.CLASS_STUDENT_EMAIL ?? "student@demo.local", password: process.env.CLASS_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "" }, "student"),
      normalizeCredential({ email: process.env.CLASS_STUDENT2_EMAIL ?? "student2@demo.local", password: process.env.CLASS_STUDENT2_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "" }, "student2")
    ]
  }
}

function normalizeCredential(value, label) {
  const email = typeof value?.email === "string" ? value.email.trim() : ""
  const password = typeof value?.password === "string" ? value.password : ""
  if (!email || !password) throw new Error(`${label} 缺少 email 或 password`)
  return { email, password }
}

function selectClassroom(teacherClassValue, studentClassValues, override) {
  const teacherClasses = collection(teacherClassValue)
  const common = teacherClasses.find((item) => studentClassValues.every((value) => ids(value).includes(item.id)))
  if (!override) return common ?? null
  return teacherClasses.find((item) => item.id === override && studentClassValues.every((value) => ids(value).includes(item.id))) ?? null
}

async function login(actor, credentials) {
  const response = await request("/api/auth/login", { method: "POST", origin: trustedOrigin, json: credentials, includeSetCookie: true })
  if (response.status !== 200 && response.status !== 201) throw new Error(`${actor} 登录失败：${response.status}`)
  const cookie = (response.setCookie ?? "").split(";", 1)[0]
  if (!cookie) throw new Error(`${actor} 登录未返回 Cookie`)
  return { actor, cookie, user: response.body?.user ?? null }
}

async function request(path, options = {}) {
  const startedAt = performance.now()
  const headers = new Headers()
  if (options.origin) headers.set("Origin", options.origin)
  else if (options.method && options.method !== "GET") headers.set("Origin", trustedOrigin)
  if (options.cookie) headers.set("Cookie", options.cookie)
  let body
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json")
    body = JSON.stringify(options.json)
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers, body, redirect: "manual" })
    const text = await response.text()
    let bodyValue = null
    try { bodyValue = text ? JSON.parse(text) : null } catch { bodyValue = text }
    return {
      status: response.status,
      body: bodyValue,
      setCookie: options.includeSetCookie ? response.headers.get("set-cookie") ?? "" : "",
      durationMs: performance.now() - startedAt,
      error: null
    }
  } catch (error) {
    return { status: 0, body: null, setCookie: "", durationMs: performance.now() - startedAt, error: error instanceof Error ? error.message : String(error) }
  }
}

function projectSetsPairwiseDisjoint(projectSets) {
  const owners = new Map()
  const collisions = []
  projectSets.forEach((projects, studentIndex) => {
    for (const projectId of ids(projects)) {
      if (owners.has(projectId)) collisions.push({ projectId, owners: [owners.get(projectId), studentIndex] })
      else owners.set(projectId, studentIndex)
    }
  })
  return { disjoint: collisions.length === 0, collisions }
}

function summarizeDurations(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  const sum = sorted.reduce((total, value) => total + value, 0)
  return {
    samples: sorted.length,
    averageMs: roundNumber(sorted.length ? sum / sorted.length : 0),
    p50Ms: roundNumber(percentile(sorted, 0.5)),
    p95Ms: roundNumber(percentile(sorted, 0.95)),
    p99Ms: roundNumber(percentile(sorted, 0.99)),
    maxMs: roundNumber(sorted.at(-1) ?? 0)
  }
}

function percentile(sorted, ratio) { return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? 0 }
function digestIds(value) { return createHash("sha256").update(ids(value).sort().join("\n")).digest("hex") }
function record(code, passed, evidence) { checks.push({ code, passed, evidence }) }
function collection(value) { return Array.isArray(value) ? value : Array.isArray(value?.projects) ? value.projects : Array.isArray(value?.students) ? value.students : [] }
function ids(value) { return collection(value).map((item) => item?.id).filter(Boolean) }
function sameIds(value, expectedIds) { return JSON.stringify(ids(value).sort()) === JSON.stringify([...expectedIds].sort()) }
function roundNumber(value) { return Math.round(value * 1_000) / 1_000 }
function positiveInteger(value, fallback) { const parsed = Number.parseInt(value ?? "", 10); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback }
function positiveNumber(value, fallback) { const parsed = Number(value ?? fallback); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
