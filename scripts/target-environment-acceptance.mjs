import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { hostname, platform, release } from "node:os"
import { dirname, relative, resolve } from "node:path"
import { browserLongRunQualification, browserScaleQualification, classConcurrencyFormalQualification } from "./delivery-qualification.mjs"
import { browserEvidencePath, browserEvidenceSource, mergeBrowserRuntimeEvidence } from "./evidence-selection.mjs"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")
const targetLabel = process.env.TARGET_ACCEPTANCE_TARGET_LABEL?.trim() || process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker-preflight"
const allowHttp = process.env.TARGET_ACCEPTANCE_ALLOW_HTTP === "true"
const requirePass = process.env.TARGET_ACCEPTANCE_REQUIRE_PASS === "true"
const maximumEvidenceAgeHours = positiveNumber(process.env.TARGET_ACCEPTANCE_MAX_EVIDENCE_AGE_HOURS, 7 * 24)
const artifactsRoot = resolve(process.env.ACCEPTANCE_ARTIFACTS_DIR ?? "artifacts")
const outputPath = resolve(argument("output") ?? `artifacts/target-environment/target-environment-${timestamp()}.json`)
const signoffPath = process.env.TARGET_ACCEPTANCE_SIGNOFF_FILE?.trim() ? resolve(process.env.TARGET_ACCEPTANCE_SIGNOFF_FILE) : null
const evidence = await loadEvidence(await collectJsonFiles(artifactsRoot))
const signoff = signoffPath ? await readJson(signoffPath) : null
const [health, readiness] = await Promise.all([probe("/api/healthz"), probe("/api/readyz")])
const checks = []
const isPreflightTarget = targetLabel.endsWith("-preflight")

const protocol = new URL(baseUrl).protocol
record("HTTPS", protocol === "https:" ? "PASS" : allowHttp || isPreflightTarget ? "PENDING" : "FAIL", protocol === "https:" ? "目标入口使用 HTTPS" : "当前入口不是 HTTPS", null)
record("HEALTH", health.status === 200 ? "PASS" : health.status === 0 ? "PENDING" : "FAIL", `healthz 返回 ${health.status}`, null)
record("READINESS", readiness.status === 200 && readiness.body?.status === "ready" && readiness.body?.database === "ok" ? "PASS" : readiness.status === 0 ? "PENDING" : "FAIL", `readyz 返回 ${readiness.status}，应用 ${readiness.body?.status ?? "?"}，数据库 ${readiness.body?.database ?? "?"}`, null)

const classFormal = qualifiedForTarget(
  classConcurrencyFormalQualification(evidence.classConcurrency),
  evidence.classConcurrency,
  "班级并发"
)
const showScale = qualifiedBrowserForTarget(
  browserScaleQualification(evidence.browserRuntime, "CITY_SHOW"),
  evidence.browserRuntime,
  "CITY_SHOW",
  "表演 3000 架规模"
)
const logisticsScale = qualifiedBrowserForTarget(
  browserScaleQualification(evidence.browserRuntime, "CITY_LOGISTICS"),
  evidence.browserRuntime,
  "CITY_LOGISTICS",
  "物流 50 架/100 单规模"
)
const vtlScale = qualifiedBrowserForTarget(
  browserScaleQualification(evidence.browserRuntime, "VTOL_INSPECTION"),
  evidence.browserRuntime,
  "VTOL_INSPECTION",
  "垂起巡检 20 架规模"
)
const showLongRun = qualifiedBrowserForTarget(
  browserLongRunQualification(evidence.browserRuntime, "CITY_SHOW"),
  evidence.browserRuntime,
  "CITY_SHOW",
  "表演长时"
)
const logisticsLongRun = qualifiedBrowserForTarget(
  browserLongRunQualification(evidence.browserRuntime, "CITY_LOGISTICS"),
  evidence.browserRuntime,
  "CITY_LOGISTICS",
  "物流长时"
)
const vtlLongRun = qualifiedBrowserForTarget(
  browserLongRunQualification(evidence.browserRuntime, "VTOL_INSPECTION"),
  evidence.browserRuntime,
  "VTOL_INSPECTION",
  "垂起巡检长时"
)
const vtlFormalMap = qualifiedForTarget(
  vtlFormalMapQualification(evidence.vtlResourceReadiness),
  evidence.vtlResourceReadiness,
  "垂起巡检正式地图资源"
)
const formalMap = qualifiedForTarget(
  formalMapQualification(evidence.mapResourceReadiness),
  evidence.mapResourceReadiness,
  "三场景正式地图资源"
)
const security = qualifiedForTarget(
  evidenceResult(evidence.security, evidence.security?.summary?.failed === 0, "未找到安全烟测证据"),
  evidence.security,
  "安全烟测"
)
const deployment = qualifiedForTarget(
  evidenceResult(evidence.deployment, evidence.deployment?.summary?.failed === 0, "未找到部署烟测证据"),
  evidence.deployment,
  "部署烟测"
)
const backupRestore = qualifiedForTarget(
  evidenceResult(evidence.backupDrill, evidence.backupDrill?.status === "PASSED", "未找到备份恢复演练证据"),
  evidence.backupDrill,
  "备份恢复"
)
const softwareUpgrade = qualifiedForTarget(
  evidenceResult(evidence.softwareUpgrade, evidence.softwareUpgrade?.status === "PASSED", "未找到软件升级回滚演练证据"),
  evidence.softwareUpgrade,
  "软件升级回滚"
)
record("CLASS-CONCURRENCY-FORMAL", classFormal.status, classFormal.message, evidence.classConcurrency?.path ?? null)
record("BROWSER-SHOW-SCALE", showScale.status, showScale.message, browserEvidencePath(evidence.browserRuntime, "CITY_SHOW"))
record("BROWSER-LOGISTICS-SCALE", logisticsScale.status, logisticsScale.message, browserEvidencePath(evidence.browserRuntime, "CITY_LOGISTICS"))
record("BROWSER-VTL-SCALE", vtlScale.status, vtlScale.message, browserEvidencePath(evidence.browserRuntime, "VTOL_INSPECTION"))
record("BROWSER-SHOW-LONG-RUN", showLongRun.status, showLongRun.message, browserEvidencePath(evidence.browserRuntime, "CITY_SHOW"))
record("BROWSER-LOGISTICS-LONG-RUN", logisticsLongRun.status, logisticsLongRun.message, browserEvidencePath(evidence.browserRuntime, "CITY_LOGISTICS"))
record("BROWSER-VTL-LONG-RUN", vtlLongRun.status, vtlLongRun.message, browserEvidencePath(evidence.browserRuntime, "VTOL_INSPECTION"))
record("VTL-FORMAL-MAP-RESOURCES", vtlFormalMap.status, vtlFormalMap.message, evidence.vtlResourceReadiness?.path ?? null)
record("FORMAL-MAP-RESOURCES", formalMap.status, formalMap.message, evidence.mapResourceReadiness?.path ?? null)
record("SECURITY", security.status, evidence.security && security.status !== "PENDING" ? `${evidence.security.summary?.passed ?? 0}/${evidence.security.summary?.total ?? 0} 项安全检查通过` : security.message, evidence.security?.path ?? null)
record("DEPLOYMENT", deployment.status, evidence.deployment && deployment.status !== "PENDING" ? `${evidence.deployment.summary?.passed ?? 0}/${evidence.deployment.summary?.total ?? 0} 项部署检查通过` : deployment.message, evidence.deployment?.path ?? null)
record("BACKUP-RESTORE", backupRestore.status, evidence.backupDrill && backupRestore.status !== "PENDING" ? (backupRestore.status === "PASS" ? "备份恢复演练通过" : `备份恢复演练状态为 ${evidence.backupDrill.status ?? "未知"}`) : backupRestore.message, evidence.backupDrill?.path ?? null)
record("SOFTWARE-UPGRADE", softwareUpgrade.status, evidence.softwareUpgrade && softwareUpgrade.status !== "PENDING" ? (softwareUpgrade.status === "PASS" ? "离线升级和严格回滚演练通过" : `软件升级回滚演练状态为 ${evidence.softwareUpgrade.status ?? "未知"}`) : softwareUpgrade.message, evidence.softwareUpgrade?.path ?? null)

const requiredApprovals = ["tlsCertificate", "formalSecrets", "authorizedFonts", "backupRestoreWitnessed", "upgradeRollbackWitnessed"]
const signoffValid = signoff
  && signoff.targetLabel === targetLabel
  && typeof signoff.approvedBy === "string"
  && signoff.approvedBy.trim().length > 0
  && Number.isFinite(Date.parse(signoff.approvedAt))
  && requiredApprovals.every((key) => signoff.approvals?.[key] === true)
record("MANUAL-SIGNOFF", signoffValid ? "PASS" : "PENDING", signoffValid ? `由 ${signoff.approvedBy} 于 ${signoff.approvedAt} 完成目标环境签字` : "缺少目标标签一致且五项审批全部确认的签字文件", signoffPath ? relative(resolve("."), signoffPath) : null)

const summary = {
  total: checks.length,
  passed: checks.filter((item) => item.status === "PASS").length,
  pending: checks.filter((item) => item.status === "PENDING").length,
  failed: checks.filter((item) => item.status === "FAIL").length
}
const status = summary.failed > 0 ? "FAILED" : summary.pending > 0 ? "PENDING" : "PASSED"
const report = {
  format: "wurenji-target-environment-acceptance",
  formatVersion: 2,
  generatedAt: new Date().toISOString(),
  status,
  target: { label: targetLabel, baseUrl, hostname: hostname(), platform: platform(), release: release() },
  configuration: { allowHttp, requirePass, maximumEvidenceAgeHours, signoffPath: signoffPath ? relative(resolve("."), signoffPath) : null },
  summary,
  checks
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ status, summary, report: outputPath })}\n`)
if (status === "FAILED" || (requirePass && status !== "PASSED")) process.exitCode = 1

function qualifiedForTarget(result, source, title) {
  if (!source) return result
  return qualifyEvidenceSource(result, {
    targetLabel: source.environment?.targetLabel,
    generatedAt: evidenceTimestamp(source)
  }, title)
}

function qualifiedBrowserForTarget(result, source, sceneType, title) {
  if (!source) return result
  return qualifyEvidenceSource(result, browserEvidenceSource(source, sceneType), title)
}

function qualifyEvidenceSource(result, source, title) {
  if (!source) return result
  const sourceLabel = source.targetLabel
  if (!sourceLabel || sourceLabel !== targetLabel) {
    return { status: "PENDING", message: `${title}证据目标标签为 ${sourceLabel ?? "未标注"}，当前目标为 ${targetLabel}` }
  }
  const generatedAt = Date.parse(source.generatedAt ?? "")
  if (!Number.isFinite(generatedAt)) return { status: "PENDING", message: `${title}证据缺少有效生成时间` }
  const ageHours = (Date.now() - generatedAt) / 3_600_000
  if (ageHours < -5 / 60) return { status: "PENDING", message: `${title}证据生成时间晚于当前目标环境时钟` }
  if (ageHours > maximumEvidenceAgeHours) {
    return { status: "PENDING", message: `${title}证据已超过 ${maximumEvidenceAgeHours} 小时有效期，需在目标环境重跑` }
  }
  return result
}

function evidenceResult(source, passed, missingMessage) {
  if (!source) return { status: "PENDING", message: missingMessage }
  return { status: statusFrom(passed), message: passed ? "检查通过" : "检查失败" }
}

function vtlFormalMapQualification(source) {
  if (!source) return { status: "PENDING", message: "未找到 VTL 正式地图资源验收证据" }
  const ready = Number(source.summary?.formalReadyRegions ?? 0)
  const total = Number(source.summary?.totalRegions ?? 0)
  if (source.status === "FAILED" || source.summary?.contractFailed === true) {
    return { status: "FAIL", message: `VTL 区域 readiness 契约失败，正式就绪 ${ready}/${total}` }
  }
  return {
    status: source.status === "PASSED" && ready > 0 ? "PASS" : "PENDING",
    message: `VTL 正式地图就绪区域 ${ready}/${total}`
  }
}

function formalMapQualification(source) {
  if (!source) return { status: "PENDING", message: "未找到三场景正式地图资源验收证据" }
  const requiredScenes = Number(source.summary?.requiredScenes ?? 3)
  const readyScenes = Number(source.summary?.formalReadyScenes ?? 0)
  if (source.status === "FAILED" || source.summary?.contractFailed === true) {
    return { status: "FAIL", message: `三场景地图 readiness 契约失败，正式就绪场景 ${readyScenes}/${requiredScenes}` }
  }
  return {
    status: source.status === "PASSED" && readyScenes >= requiredScenes ? "PASS" : "PENDING",
    message: `三场景正式地图就绪 ${readyScenes}/${requiredScenes}`
  }
}

async function probe(path) {
  try {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Accept: "application/json" } })
    const text = await response.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, body: null, error: error instanceof Error ? error.message : String(error) }
  }
}

async function collectJsonFiles(directory) {
  const result = []
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await collectJsonFiles(path))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) result.push(path)
  }
  return result
}

async function loadEvidence(files) {
  const candidates = {}
  const browserCandidates = []
  for (const path of files) {
    const value = await readJson(path)
    const key = {
      "wurenji-class-concurrency-smoke": "classConcurrency",
      "wurenji-browser-runtime-baseline": "browserRuntime",
      "wurenji-security-smoke": "security",
      "wurenji-deployment-smoke": "deployment",
      "wurenji-backup-drill": "backupDrill",
      "wurenji-software-upgrade-drill": "softwareUpgrade",
      "wurenji-vtl-resource-readiness": "vtlResourceReadiness",
      "wurenji-map-resource-readiness": "mapResourceReadiness"
    }[value?.format]
    if (!key) continue
    const candidate = { ...value, path: relative(resolve("."), path) }
    if (key === "browserRuntime") {
      browserCandidates.push(candidate)
      continue
    }
    if (!candidates[key] || preferred(key, candidate, candidates[key])) candidates[key] = candidate
  }
  const browserRuntime = mergeBrowserRuntimeEvidence(browserCandidates, { targetLabel })
  if (browserRuntime) candidates.browserRuntime = browserRuntime
  return candidates
}

function preferred(key, candidate, current) {
  const candidateMatchesTarget = candidate.environment?.targetLabel === targetLabel
  const currentMatchesTarget = current.environment?.targetLabel === targetLabel
  if (candidateMatchesTarget !== currentMatchesTarget) return candidateMatchesTarget
  return evidenceTime(candidate) > evidenceTime(current)
}

function evidenceTime(value) {
  const parsed = Date.parse(evidenceTimestamp(value))
  return Number.isFinite(parsed) ? parsed : 0
}

function evidenceTimestamp(value) {
  return value?.generatedAt ?? value?.verifiedAt ?? value?.completedAt ?? ""
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")) } catch { return null }
}

function record(code, status, message, evidencePath) { checks.push({ code, status, message, evidence: evidencePath }) }
function statusFrom(value) { return value === true ? "PASS" : value === false ? "FAIL" : "PENDING" }
function positiveNumber(value, fallback) { const parsed = Number(value ?? fallback); return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
