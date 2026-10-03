import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const trustedOrigin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const targetLabel = process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const outputPath = resolve(argument("output") ?? `artifacts/security/security-${timestamp()}.json`)
const checks = []

await ensureServiceAvailable()

const noOriginLogin = await request("/api/auth/login", { method: "POST", omitOrigin: true, json: credentials("teacher") })
record("CSRF_MISSING_ORIGIN", noOriginLogin.status === 403, { status: noOriginLogin.status })
const foreignOriginLogin = await request("/api/auth/login", { method: "POST", origin: "https://invalid.example", json: credentials("teacher") })
record("CORS_FOREIGN_ORIGIN", foreignOriginLogin.status >= 400, { status: foreignOriginLogin.status })
const unauthenticated = await request("/api/v3/my-projects")
record("AUTH_REQUIRED", unauthenticated.status === 401, { status: unauthenticated.status })

const teacher = await login("teacher")
const student = await login("student")
const student2 = await login("student2")
record("COOKIE_HTTP_ONLY", /(?:^|;\s*)HttpOnly(?:;|$)/i.test(teacher.setCookie), { setCookie: redactCookie(teacher.setCookie) })
record("COOKIE_SAME_SITE", /SameSite=Lax/i.test(teacher.setCookie), { setCookie: redactCookie(teacher.setCookie) })

const studentProjects = await request("/api/v3/my-projects", { cookie: student.cookie })
const student2Projects = await request("/api/v3/my-projects", { cookie: student2.cookie })
record("STUDENT_PROJECT_LIST", studentProjects.status === 200 && student2Projects.status === 200, { firstStatus: studentProjects.status, secondStatus: student2Projects.status })
const firstProject = findProject(studentProjects.body, "CITY_SHOW")
const secondProject = findProject(student2Projects.body, "CITY_SHOW")
if (!firstProject || !secondProject) throw new Error("安全验收需要两个学生各至少一个表演项目")

const crossProject = await request(`/api/v3/projects/${secondProject.id}/stages`, { cookie: student.cookie })
record("CROSS_STUDENT_PROJECT", crossProject.status === 403, { status: crossProject.status, targetProjectId: secondProject.id })
const reverseCrossProject = await request(`/api/v3/projects/${firstProject.id}/stages`, { cookie: student2.cookie })
record("CROSS_STUDENT_PROJECT_REVERSE", reverseCrossProject.status === 403, { status: reverseCrossProject.status, targetProjectId: firstProject.id })

const area = await request(`/api/v3/show-projects/${firstProject.id}/area-plan`, { cookie: student.cookie })
const assetId = latestPlanningMapAssetId(area.body)
if (!assetId) throw new Error(`学生项目没有可用于文件越权验证的规划图：${firstProject.id}`)
const ownDownload = await request(`/api/v3/files/${assetId}/download`, { cookie: student.cookie, raw: true })
record("OWN_FILE_DOWNLOAD", ownDownload.status === 200 && ownDownload.byteLength > 0, { status: ownDownload.status, byteLength: ownDownload.byteLength })
const crossDownload = await request(`/api/v3/files/${assetId}/download`, { cookie: student2.cookie, raw: true })
record("CROSS_PROJECT_FILE_DOWNLOAD", crossDownload.status === 403, { status: crossDownload.status, assetId })

const studentResourceMutation = await request("/api/v3/resource-packages", {
  method: "POST",
  cookie: student.cookie,
  json: { packageType: "RULE", name: "unauthorized", version: "1.0.0", schemaVersion: 1, minimumPlatformVersion: "0.1.0", sha256: "0".repeat(64), manifest: { rules: ["x"] } }
})
record("RESOURCE_ADMIN_ONLY", studentResourceMutation.status === 403, { status: studentResourceMutation.status })

const invalidOfficeAsset = await request(`/api/v3/office/assets/00000000-0000-0000-0000-000000000000?access_token=invalid`, { raw: true })
record("ONLYOFFICE_ASSET_TOKEN", invalidOfficeAsset.status === 401, { status: invalidOfficeAsset.status })
const invalidOfficeCallback = await request(`/api/v3/office/callbacks/00000000-0000-0000-0000-000000000000?access_token=invalid`, { method: "POST", json: { status: 2, key: "invalid", url: "http://127.0.0.1/private" } })
record("ONLYOFFICE_CALLBACK_TOKEN", invalidOfficeCallback.status === 401, { status: invalidOfficeCallback.status })

const report = {
  format: "wurenji-security-smoke",
  formatVersion: 1,
  status: checks.every((item) => item.passed) ? "PASSED" : "FAILED",
  generatedAt: new Date().toISOString(),
  environment: { targetLabel },
  baseUrl,
  trustedOrigin,
  summary: { total: checks.length, passed: checks.filter((item) => item.passed).length, failed: checks.filter((item) => !item.passed).length },
  checks
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
if (report.summary.failed > 0) process.exitCode = 1

async function ensureServiceAvailable() {
  try {
    const response = await fetch(`${baseUrl}/api/healthz`, { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error(`healthz 返回 HTTP ${response.status}`)
  } catch (error) {
    const report = {
      format: "wurenji-security-smoke",
      formatVersion: 1,
      status: "BLOCKED",
      generatedAt: new Date().toISOString(),
      environment: { targetLabel },
      baseUrl,
      trustedOrigin,
      summary: { total: 0, passed: 0, failed: 0 },
      checks: [],
      reason: error instanceof Error ? error.message : String(error)
    }
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
    process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
    process.exit(1)
  }
}

async function login(role) {
  const response = await request("/api/auth/login", { method: "POST", origin: trustedOrigin, json: credentials(role), includeSetCookie: true })
  if (response.status !== 201 && response.status !== 200) throw new Error(`${role} 登录失败：${response.status}`)
  const setCookie = response.setCookie ?? ""
  const cookie = setCookie.split(";", 1)[0]
  if (!cookie) throw new Error(`${role} 登录未返回 Cookie`)
  return { cookie, setCookie }
}

async function request(path, options = {}) {
  const headers = new Headers()
  if (options.origin) headers.set("Origin", options.origin)
  else if (!options.omitOrigin && options.method && options.method !== "GET") headers.set("Origin", trustedOrigin)
  if (options.cookie) headers.set("Cookie", options.cookie)
  let body
  if (options.json !== undefined) {
    headers.set("Content-Type", "application/json")
    body = JSON.stringify(options.json)
  }
  const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers, body, redirect: "manual" })
  const setCookie = response.headers.get("set-cookie") ?? ""
  if (options.raw) {
    const content = Buffer.from(await response.arrayBuffer())
    return { status: response.status, byteLength: content.byteLength, setCookie }
  }
  const text = await response.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { status: response.status, body: parsed, setCookie }
}

function findProject(value, sceneType) {
  const projects = Array.isArray(value) ? value : Array.isArray(value?.projects) ? value.projects : []
  return projects.find((item) => item?.sceneType === sceneType) ?? projects[0]
}

function latestPlanningMapAssetId(value) {
  const versions = Array.isArray(value?.versions) ? value.versions : []
  return versions.find((item) => item?.planningMapAsset?.id)?.planningMapAsset?.id ?? null
}

function credentials(role) {
  if (role === "teacher") return { email: process.env.SECURITY_TEACHER_EMAIL ?? "teacher@demo.local", password: process.env.SECURITY_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? "" }
  if (role === "student2") return { email: process.env.SECURITY_STUDENT2_EMAIL ?? "student2@demo.local", password: process.env.SECURITY_STUDENT2_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "" }
  return { email: process.env.SECURITY_STUDENT_EMAIL ?? "student@demo.local", password: process.env.SECURITY_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "" }
}

function record(code, passed, evidence) { checks.push({ code, passed, evidence }) }
function redactCookie(value) { return value.replace(/wurenji_token=[^;]+/i, "wurenji_token=<redacted>") }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
