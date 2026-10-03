const apiBase = (process.env.APP_BASE_URL ?? "http://localhost:3000/api").replace(/\/$/, "")
const projectId = process.env.QUESTIONNAIRE_PROJECT_ID?.trim()
const outputPath = process.env.QUESTIONNAIRE_RUNTIME_OUTPUT?.trim() || "artifacts/question-bank/questionnaire-runtime-acceptance-latest.json"
if (!projectId) throw new Error("QUESTIONNAIRE_PROJECT_ID is required")

const student = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
const teacher = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const initial = await request(`/v3/projects/${projectId}/questionnaire`, { cookie: student })
if (!initial.available || initial.actor !== "STUDENT") throw new Error(`学生题库不可用：${JSON.stringify(initial)}`)
const answers = initial.questions
  .filter((question) => question.type !== "SIMULATION_EVIDENCE")
  .map((question) => ({ questionCode: question.code, answer: answerFor(question) }))

let attempt = initial.attempt
if (!attempt) {
  if (!initial.canEdit) throw new Error(`学生题库不可首次作答：${JSON.stringify(initial)}`)
  const saved = await request(`/v3/projects/${projectId}/questionnaire`, { method: "PUT", cookie: student, body: { responses: answers } })
  if (saved.attempt?.status !== "IN_PROGRESS") throw new Error(`首次保存未创建作答记录：${JSON.stringify(saved.attempt)}`)
  attempt = saved.attempt
}
if (attempt.status === "IN_PROGRESS") {
  const submitted = await request(`/v3/projects/${projectId}/questionnaire/submit`, {
    method: "POST",
    cookie: student,
    body: { expectedRevision: attempt.revision, responses: answers }
  })
  if (submitted.attempt?.status !== "SUBMITTED") throw new Error(`学生提交失败：${JSON.stringify(submitted.attempt)}`)
  attempt = submitted.attempt
}
const teacherView = await request(`/v3/projects/${projectId}/questionnaire`, { cookie: teacher })
const graded = await request(`/v3/projects/${projectId}/questionnaire/regrade`, {
  method: "POST",
  cookie: teacher,
  body: { expectedRevision: teacherView.attempt.revision }
})
const pending = graded.responses.filter((response) => response.judgment === "PENDING")
if (graded.attempt?.status !== "GRADED" || pending.length > 0) throw new Error(`仿真证据仍未完成判定：${JSON.stringify({ attempt: graded.attempt, pending })}`)
const result = {
  format: "wurenji-questionnaire-runtime-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  projectId,
  bank: graded.bank,
  attempt: graded.attempt,
  responses: graded.responses.map((response) => ({ questionCode: response.questionCode, judgment: response.judgment, autoScore: response.autoScore, maxScore: response.maxScore, evidence: response.evidence }))
}
const { mkdir, writeFile } = await import("node:fs/promises")
const { dirname, resolve } = await import("node:path")
const resolved = resolve(outputPath)
await mkdir(dirname(resolved), { recursive: true })
await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function answerFor(question) {
  const fields = question.answerFields ?? ["answer"]
  return Object.fromEntries(fields.map((field) => [field, `验收填写：${field}`]))
}

async function login(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) })
  if (!response.ok) throw new Error(`登录失败 ${response.status}: ${await response.text()}`)
  const setCookie = response.headers.getSetCookie?.() ?? []
  return setCookie.map((cookie) => cookie.split(";", 1)[0]).join("; ")
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: { "content-type": "application/json", ...(options.cookie ? { cookie: options.cookie } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : null } catch { value = text }
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} ${response.status}: ${JSON.stringify(value)}`)
  return value
}
