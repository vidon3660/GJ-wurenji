import { mkdir, writeFile } from "node:fs/promises"
import { hostname, platform, release } from "node:os"
import { dirname, resolve } from "node:path"

const baseUrl = (argument("base-url") ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const targetLabel = process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const origin = process.env.ACCEPTANCE_ORIGIN?.trim() || new URL(baseUrl).origin
const email = process.env.ACCEPTANCE_TEACHER_EMAIL?.trim() || "teacher@demo.local"
const password = process.env.ACCEPTANCE_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? ""
const requirePass = process.env.VTL_RESOURCE_ACCEPTANCE_REQUIRE_PASS === "true"
const outputPath = resolve(argument("output") ?? `artifacts/vtl-resources/vtl-resource-readiness-${timestamp()}.json`)
const requiredKinds = ["TERRAIN", "IMAGERY", "ELEVATION_SNAPSHOT"]
const generatedAt = new Date().toISOString()

let report
try {
  const cookie = await login()
  const catalog = await requestJson("/api/v3/resource-packages/regions/catalog?sceneType=VTOL_INSPECTION", cookie)
  if (!Array.isArray(catalog)) throw new Error("VTL 区域目录响应不是数组")

  const regions = []
  let contractFailed = false
  for (const region of catalog) {
    const readiness = await requestJson(`/api/v3/resource-packages/regions/${encodeURIComponent(region.packageId)}/readiness`, cookie)
    const identityMatches = readiness?.regionPackageId === region.packageId
      && readiness?.regionCode === region.regionCode
      && readiness?.packageVersion === region.packageVersion
    const checks = Array.isArray(readiness?.checks) ? readiness.checks : []
    const requiredChecks = requiredKinds.map((kind) => checks.find((check) => check?.kind === kind && check.required === true) ?? null)
    const contractValid = identityMatches
      && requiredChecks.every(Boolean)
      && requiredChecks.every((check) => typeof check.status === "string" && typeof check.message === "string")
    const resourcesReady = contractValid && requiredChecks.every((check) => check.status === "READY")
    const formalReady = readiness?.formalReady === true && resourcesReady
    if (!contractValid || (readiness?.formalReady === true) !== resourcesReady) contractFailed = true
    regions.push({
      packageId: region.packageId,
      regionCode: region.regionCode,
      title: region.title,
      packageVersion: region.packageVersion,
      checkedAt: readiness?.checkedAt ?? null,
      identityMatches,
      contractValid,
      formalReady,
      checks: requiredChecks.filter(Boolean).map((check) => ({
        kind: check.kind,
        status: check.status,
        message: check.message,
        expectedSha256: check.expectedSha256 ?? null,
        actualSha256: check.actualSha256 ?? null
      }))
    })
  }

  const formalReadyRegions = regions.filter((region) => region.formalReady).length
  const status = contractFailed ? "FAILED" : formalReadyRegions > 0 ? "PASSED" : "PENDING"
  report = {
    format: "wurenji-vtl-resource-readiness",
    formatVersion: 1,
    generatedAt,
    status,
    environment: { targetLabel, baseUrl, hostname: hostname(), platform: platform(), release: release() },
    configuration: { requirePass, regionCount: regions.length },
    summary: {
      totalRegions: regions.length,
      formalReadyRegions,
      pendingRegions: regions.length - formalReadyRegions,
      contractFailed
    },
    regions
  }
} catch (error) {
  report = {
    format: "wurenji-vtl-resource-readiness",
    formatVersion: 1,
    generatedAt,
    status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED",
    environment: { targetLabel, baseUrl, hostname: hostname(), platform: platform(), release: release() },
    configuration: { requirePass },
    summary: { totalRegions: 0, formalReadyRegions: 0, pendingRegions: 0, contractFailed: true },
    reason: normalizeError(error),
    regions: []
  }
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ status: report.status, summary: report.summary, report: outputPath })}\n`)
if (report.status === "FAILED" || report.status === "BLOCKED" || (requirePass && report.status !== "PASSED")) process.exitCode = 1

function isEnvironmentBlocked(error) {
  const message = normalizeError(error)
  return /等待服务就绪超时|ECONNREFUSED|fetch failed|数据库|服务未就绪/i.test(message)
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
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status} ${text}`)
  try { return text ? JSON.parse(text) : null } catch { throw new Error(`${path} 未返回有效 JSON`) }
}

function normalizeError(error) { return error instanceof Error ? error.message : String(error) }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
