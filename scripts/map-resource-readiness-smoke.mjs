import { mkdir, writeFile } from "node:fs/promises"
import { hostname, platform, release } from "node:os"
import { dirname, resolve } from "node:path"

const baseUrl = (argument("base-url") ?? process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const targetLabel = process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const origin = process.env.ACCEPTANCE_ORIGIN?.trim() || new URL(baseUrl).origin
const email = process.env.ACCEPTANCE_TEACHER_EMAIL?.trim() || "teacher@demo.local"
const password = process.env.ACCEPTANCE_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? ""
const requirePass = process.env.MAP_RESOURCE_ACCEPTANCE_REQUIRE_PASS === "true"
const outputPath = resolve(argument("output") ?? `artifacts/map-resources/map-resource-readiness-${timestamp()}.json`)
const scenes = ["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"]
const requiredKinds = ["TERRAIN", "IMAGERY", "ELEVATION_SNAPSHOT"]

let report
try {
  await waitForReadiness()
  const cookie = await login()
  const regions = []
  const blockingReasonCounts = new Map()
  let contractFailed = false
  for (const sceneType of scenes) {
    const catalog = await requestJson(`/api/v3/resource-packages/regions/catalog?sceneType=${sceneType}`, cookie)
    if (!Array.isArray(catalog)) throw new Error(`${sceneType} 区域目录响应不是数组`)
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
      const blockingChecks = requiredChecks.filter((check) => check && check.status !== "READY")
      for (const check of blockingChecks) blockingReasonCounts.set(check.message, (blockingReasonCounts.get(check.message) ?? 0) + 1)
      if (!contractValid || (readiness?.formalReady === true) !== resourcesReady) contractFailed = true
      regions.push({
        sceneType,
        packageId: region.packageId,
        regionCode: region.regionCode,
        title: region.title,
        packageVersion: region.packageVersion,
        checkedAt: readiness?.checkedAt ?? null,
        identityMatches,
        contractValid,
        formalReady,
        blockingKinds: blockingChecks.map((check) => check.kind),
        blockingMessages: blockingChecks.map((check) => check.message),
        environmentDiagnostics: readiness?.environmentDiagnostics ?? null,
        checks: requiredChecks.filter(Boolean).map((check) => ({
          kind: check.kind,
          status: check.status,
          message: check.message,
          expectedSha256: check.expectedSha256 ?? null,
          actualSha256: check.actualSha256 ?? null
        }))
      })
    }
  }

  const sceneSummary = Object.fromEntries(scenes.map((sceneType) => {
    const items = regions.filter((region) => region.sceneType === sceneType)
    return [sceneType, {
      totalRegions: items.length,
      formalReadyRegions: items.filter((region) => region.formalReady).length,
      pendingRegions: items.filter((region) => !region.formalReady).length
    }]
  }))
  const formalReadyScenes = scenes.filter((sceneType) => sceneSummary[sceneType].formalReadyRegions > 0).length
  const status = contractFailed ? "FAILED" : formalReadyScenes === scenes.length ? "PASSED" : "PENDING"
  report = {
    format: "wurenji-map-resource-readiness",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    status,
    environment: { targetLabel, baseUrl, hostname: hostname(), platform: platform(), release: release() },
    configuration: { requirePass, scenes, requiredKinds },
    summary: {
      totalRegions: regions.length,
      formalReadyRegions: regions.filter((region) => region.formalReady).length,
      pendingRegions: regions.filter((region) => !region.formalReady).length,
      formalReadyScenes,
      requiredScenes: scenes.length,
      contractFailed,
      blockingReasons: [...blockingReasonCounts.entries()].map(([message, regionCount]) => ({ message, regionCount })),
      byScene: sceneSummary
    },
    regions
  }
} catch (error) {
  report = {
    format: "wurenji-map-resource-readiness",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED",
    environment: { targetLabel, baseUrl, hostname: hostname(), platform: platform(), release: release() },
    configuration: { requirePass, scenes, requiredKinds },
    summary: { totalRegions: 0, formalReadyRegions: 0, pendingRegions: 0, formalReadyScenes: 0, requiredScenes: scenes.length, contractFailed: true, blockingReasons: [], byScene: {} },
    reason: error instanceof Error ? error.message : String(error),
    regions: []
  }
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ status: report.status, summary: report.summary, report: outputPath })}\n`)
if (report.status === "FAILED" || report.status === "BLOCKED" || (requirePass && report.status !== "PASSED")) process.exitCode = 1

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
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} 返回 HTTP ${response.status} ${text}`)
  try { return text ? JSON.parse(text) : null } catch { throw new Error(`${path} 未返回有效 JSON`) }
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}
