import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const origin = process.env.ACCEPTANCE_ORIGIN?.trim() || new URL(baseUrl).origin
const email = process.env.ACCEPTANCE_TEACHER_EMAIL?.trim() || "teacher@demo.local"
const password = process.env.ACCEPTANCE_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? ""
const requireClean = process.env.QUESTION_BANK_AUDIT_REQUIRE_CLEAN === "true"
const outputPath = resolve(process.env.QUESTION_BANK_AUDIT_OUTPUT ?? "artifacts/question-bank/question-bank-readiness-latest.json")

let report
try {
  await waitForReadiness()
  const cookie = await login()
  const audit = await requestJson("/api/v1/education/question-banks/audit", cookie)
  const invalidVersions = Array.isArray(audit?.versions) ? audit.versions.filter((version) => version.valid !== true) : []
  report = {
    format: "wurenji-question-bank-readiness",
    formatVersion: 1,
    generatedAt: audit?.generatedAt ?? new Date().toISOString(),
    environment: { baseUrl, origin },
    status: invalidVersions.length === 0 ? "PASSED" : "PENDING",
    summary: audit?.summary ?? null,
    invalidVersions,
    versions: Array.isArray(audit?.versions) ? audit.versions : []
  }
} catch (error) {
  report = {
    format: "wurenji-question-bank-readiness",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: { baseUrl, origin },
    status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED",
    summary: null,
    invalidVersions: [],
    versions: [],
    reason: error instanceof Error ? error.message : String(error)
  }
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ status: report.status, summary: report.summary, invalidVersionCount: report.invalidVersions.length, report: outputPath })}\n`)
if (report.status === "FAILED" || report.status === "BLOCKED" || (requireClean && report.status !== "PASSED")) process.exitCode = 1

function isEnvironmentBlocked(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /等待服务就绪超时|ECONNREFUSED|fetch failed|数据库|服务未就绪/i.test(message)
}

async function waitForReadiness() {
  const deadline = Date.now() + 15_000
  let lastError = "服务未就绪"
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/readyz`, { signal: AbortSignal.timeout(2_000) })
      const body = await response.text()
      if (response.ok) {
        const value = body ? JSON.parse(body) : null
        if (value?.status === "ready" && value?.database === "ok") return
        lastError = `就绪探针返回异常：${body}`
      } else {
        lastError = `就绪探针返回 HTTP ${response.status}：${body}`
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error(`等待服务就绪超时：${lastError}`)
}

async function login() {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000)
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`教师登录失败：HTTP ${response.status} ${body}`)
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0]
  if (!cookie) throw new Error("教师登录响应缺少会话 Cookie")
  return cookie
}

async function requestJson(path, cookie) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: "application/json", Cookie: cookie, Origin: origin },
    signal: AbortSignal.timeout(15_000)
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status} ${body}`)
  try { return body ? JSON.parse(body) : null } catch { throw new Error(`${path} 未返回有效 JSON`) }
}
