import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const outputPath = resolve(argument("output") ?? `artifacts/runtime-stream/runtime-stream-${timestamp()}.json`)
const projectIdOverride = process.env.RUNTIME_PROJECT_ID?.trim() || ""
const sceneOverride = process.env.RUNTIME_SCENE?.trim() || ""

await ensureServiceAvailable()

const student = await login()
const project = await selectProject(student.cookie)
if (!project) throw new Error("没有找到可访问的表演、物流或垂起巡检运行项目，请设置 RUNTIME_PROJECT_ID")

const endpoint = runtimeEndpoint(project)
const first = await readSnapshot(student.cookie, endpoint)
const resumed = await readSnapshot(student.cookie, endpoint, first.id)

const evidence = {
  format: "wurenji-runtime-stream-smoke",
  formatVersion: 1,
  status: "PASSED",
  verifiedAt: new Date().toISOString(),
  baseUrl,
  project: { id: project.id, title: project.title, sceneType: project.sceneType, stageCode: project.stageCode, stageStatus: project.stageStatus },
  endpoint,
  first: summarizeSnapshot(first),
  resumed: summarizeSnapshot(resumed),
  checks: {
    contentType: first.contentType.includes("text/event-stream") && resumed.contentType.includes("text/event-stream"),
    firstEventIsSnapshot: first.event === "snapshot" && resumed.event === "snapshot",
    firstRevisionMatchesId: first.id === first.snapshot.revision && first.snapshot.revision === first.snapshot.workspace.session.revision,
    resumedRevisionMatchesId: resumed.id === resumed.snapshot.revision && resumed.snapshot.revision === resumed.snapshot.workspace.session.revision,
    resumedFromRevision: resumed.snapshot.resumedFromRevision === first.id
  }
}
evidence.summary = { passed: Object.values(evidence.checks).every(Boolean), failedChecks: Object.entries(evidence.checks).filter(([, passed]) => !passed).map(([name]) => name) }

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(evidence.summary)}\nProject ${project.id}\nReport ${outputPath}\n`)
if (!evidence.summary.passed) process.exitCode = 1

async function ensureServiceAvailable() {
  try {
    const response = await fetch(`${baseUrl}/api/healthz`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(`healthz 返回 HTTP ${response.status}`)
  } catch (error) {
    const evidence = {
      format: "wurenji-runtime-stream-smoke",
      formatVersion: 1,
      status: "BLOCKED",
      verifiedAt: new Date().toISOString(),
      baseUrl,
      summary: { passed: false, blocked: true, failedChecks: [] },
      reason: error instanceof Error ? error.message : String(error)
    }
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
    process.stdout.write(`${JSON.stringify(evidence.summary)}\nReport ${outputPath}\n`)
    process.exit(1)
  }
}

async function login() {
  const response = await request("/api/auth/login", {
    method: "POST",
    origin,
    json: {
      email: process.env.RUNTIME_STUDENT_EMAIL ?? "student@demo.local",
      password: process.env.RUNTIME_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? ""
    },
    includeSetCookie: true
  })
  if (response.status !== 200 && response.status !== 201) throw new Error(`学生登录失败：${response.status}`)
  const setCookie = response.setCookie ?? ""
  const cookie = setCookie.split(";", 1)[0]
  if (!cookie) throw new Error("学生登录未返回 Cookie")
  return { cookie }
}

async function selectProject(cookie) {
  const response = await request("/api/v3/my-projects", { cookie })
  if (response.status !== 200) throw new Error(`读取学生项目失败：${response.status}`)
  const projects = Array.isArray(response.body) ? response.body : []
  const candidates = projects.flatMap((project) => {
    const runtimeStageCode = runtimeStage(project.sceneType)
    if (!runtimeStageCode) return []
    const stage = project.stages?.find((item) => item.stageCode === runtimeStageCode)
    if (!stage || !["IN_PROGRESS", "ACCEPTED"].includes(stage.status)) return []
    if (projectIdOverride && project.id !== projectIdOverride) return []
    if (sceneOverride && project.sceneType !== sceneOverride) return []
    return [{ id: project.id, title: project.title, sceneType: project.sceneType, stageCode: stage.stageCode, stageStatus: stage.status }]
  })
  return candidates[0] ?? null
}

function runtimeStage(sceneType) {
  return ({
    CITY_SHOW: "SHOW_RUNTIME",
    CITY_LOGISTICS: "LOGISTICS_DELIVERY_RUNTIME",
    VTOL_INSPECTION: "VTL_RUNTIME"
  })[sceneType] ?? null
}

function runtimeEndpoint(project) {
  if (project.sceneType === "CITY_SHOW") return `/api/v3/show-projects/${project.id}/runtime/stream`
  if (project.sceneType === "CITY_LOGISTICS") return `/api/v3/logistics-projects/${project.id}/runtime/stream`
  if (project.sceneType === "VTOL_INSPECTION") return `/api/v3/vtl-projects/${project.id}/runtime/stream`
  throw new Error(`不支持的运行场景：${project.sceneType}`)
}

async function readSnapshot(cookie, endpoint, lastEventId) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  const headers = { Cookie: cookie, Origin: origin, Accept: "text/event-stream" }
  if (lastEventId !== undefined) headers["Last-Event-ID"] = String(lastEventId)
  try {
    const response = await fetch(`${baseUrl}${endpoint}`, { headers, signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`SSE 请求失败：${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error("SSE 在首个 snapshot 事件前结束")
      buffer += decoder.decode(value, { stream: true })
      const boundary = buffer.indexOf("\n\n")
      if (boundary < 0) continue
      const frame = buffer.slice(0, boundary)
      const id = Number(frame.match(/^id: (\d+)$/m)?.[1])
      const event = frame.match(/^event: (.+)$/m)?.[1] ?? ""
      const data = frame.match(/^data: (.+)$/m)?.[1]
      if (!Number.isSafeInteger(id) || !data) throw new Error(`SSE 首帧格式无效：${frame}`)
      return { contentType: response.headers.get("content-type") ?? "", id, event, snapshot: JSON.parse(data) }
    }
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}

function summarizeSnapshot(value) {
  return {
    contentType: value.contentType,
    id: value.id,
    event: value.event,
    protocol: value.snapshot.protocol,
    revision: value.snapshot.revision,
    resumedFromRevision: value.snapshot.resumedFromRevision,
    sessionRevision: value.snapshot.workspace?.session?.revision,
    sessionStatus: value.snapshot.workspace?.session?.status
  }
}

async function request(path, options = {}) {
  const headers = new Headers()
  if (options.origin) headers.set("Origin", options.origin)
  if (options.cookie) headers.set("Cookie", options.cookie)
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json")
    options.body = JSON.stringify(options.json)
  }
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers, body: options.body })
  const text = await response.text()
  let body = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body, setCookie: response.headers.get("set-cookie") ?? "" }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}
