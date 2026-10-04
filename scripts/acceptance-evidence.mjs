import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { browserLongRunQualification, browserScaleQualification, classConcurrencyFormalQualification } from "./delivery-qualification.mjs"
import { browserEvidencePath, mergeBrowserRuntimeEvidence } from "./evidence-selection.mjs"

const artifactsRoot = resolve(process.env.ACCEPTANCE_ARTIFACTS_DIR ?? "artifacts")
const outputPath = resolve(argument("output") ?? `artifacts/acceptance/acceptance-${timestamp()}.json`)
const markdownPath = resolve(argument("markdown") ?? outputPath.replace(/\.json$/i, ".md"))
const evidenceFiles = await collectJsonFiles(artifactsRoot)
const evidence = await loadEvidence(evidenceFiles)
const workspaceRoot = fileURLToPath(new URL("../", import.meta.url))
const mapRoot = resolve(workspaceRoot, process.env.MAP_DATA_DIR?.trim() || "apps/web/dist/map")
const mapEvidence = await inspectMapReadiness(mapRoot)
const classFormal = classConcurrencyFormalQualification(evidence.classConcurrency, {
  minimumStudents: process.env.ACCEPTANCE_CLASS_MIN_STUDENTS,
  minimumRounds: process.env.ACCEPTANCE_CLASS_MIN_ROUNDS,
  maximumP95Ms: process.env.ACCEPTANCE_CLASS_MAX_P95_MS
})
const showLongRun = browserLongRunQualification(evidence.browserRuntime, "CITY_SHOW", { minimumDurationMs: process.env.ACCEPTANCE_BROWSER_MIN_DURATION_MS })
const logisticsLongRun = browserLongRunQualification(evidence.browserRuntime, "CITY_LOGISTICS", { minimumDurationMs: process.env.ACCEPTANCE_BROWSER_MIN_DURATION_MS })
const vtlLongRun = browserLongRunQualification(evidence.browserRuntime, "VTOL_INSPECTION", { minimumDurationMs: process.env.ACCEPTANCE_BROWSER_MIN_DURATION_MS })
const showScale = browserScaleQualification(evidence.browserRuntime, "CITY_SHOW")
const logisticsScale = browserScaleQualification(evidence.browserRuntime, "CITY_LOGISTICS")
const vtlScale = browserScaleQualification(evidence.browserRuntime, "VTOL_INSPECTION")

const checks = [
  evidenceCheck("SOFTWARE-UPGRADE", "offline software upgrade and rollback", softwareUpgradeStatus(evidence.softwareUpgrade), softwareUpgradeMessage(evidence.softwareUpgrade), evidence.softwareUpgrade?.path ?? null),
  evidenceCheck("CLASS-CONCURRENCY", "class scope, project isolation, and concurrent access", classConcurrencyStatus(evidence.classConcurrency), classConcurrencyMessage(evidence.classConcurrency), evidence.classConcurrency?.path ?? null),
  evidenceCheck("CLASS-CONCURRENCY-FORMAL", "真实班级规模、轮次与延迟门禁", classFormal.status, classFormal.message, evidence.classConcurrency?.path ?? null),
  evidenceCheck("TEST-ALL", "全量单元测试", localRegressionStatus(evidence.localRegression, "TEST-ALL", process.env.ACCEPTANCE_TEST_SUMMARY), localRegressionMessage(evidence.localRegression, "TEST-ALL", process.env.ACCEPTANCE_TEST_SUMMARY, "未提供本次候选版全量测试摘要"), localRegressionPath(evidence.localRegression, "TEST-ALL")),
  evidenceCheck("TYPECHECK", "全量类型检查", localRegressionStatus(evidence.localRegression, "TYPECHECK", process.env.ACCEPTANCE_TYPECHECK_SUMMARY), localRegressionMessage(evidence.localRegression, "TYPECHECK", process.env.ACCEPTANCE_TYPECHECK_SUMMARY, "未提供本次候选版全量类型检查摘要"), localRegressionPath(evidence.localRegression, "TYPECHECK")),
  evidenceCheck("PERF-SERVER", "后端仿真与 API 性能基线", statusFrom(evidence.performance?.summary?.passed), performanceMessage(evidence.performance), evidence.performance?.path ?? null),
  evidenceCheck("SECURITY", "安全烟测", securityStatus(evidence.security), securityMessage(evidence.security), evidence.security?.path ?? null),
  evidenceCheck("DEPLOYMENT", "Docker 拓扑、生产覆盖与健康探针", statusFrom(evidence.deployment?.summary?.failed === 0), deploymentMessage(evidence.deployment), evidence.deployment?.path ?? null),
  evidenceCheck("WORKER", "Outbox、独立 Worker 与报告作业幂等闭环", statusFrom(evidence.worker?.summary?.passed), workerMessage(evidence.worker), evidence.worker?.path ?? null),
  evidenceCheck("DOCUMENTS", "三份申报文档与报告结构", documentStatus(evidence.documents), documentMessage(evidence.documents), evidence.documents?.path ?? null),
  evidenceCheck("SSE", "运行流首帧与断线续传", runtimeStreamStatus(evidence.runtimeStream), runtimeStreamMessage(evidence.runtimeStream), evidence.runtimeStream?.path ?? null),
  evidenceCheck("RESOURCE-LIFECYCLE", "签名资源包生命周期", resourceLifecycleStatus(evidence.resourceLifecycle), resourceMessage(evidence.resourceLifecycle), evidence.resourceLifecycle?.path ?? null),
  evidenceCheck("BACKUP-SOURCE", "备份源文件资产完整性", backupSourceStatus(evidence.backupSource), backupSourceMessage(evidence.backupSource), evidence.backupSource?.path ?? null),
  evidenceCheck("BACKUP-RESTORE", "隔离环境备份恢复演练", backupDrillStatus(evidence.backupDrill), backupDrillMessage(evidence.backupDrill), evidence.backupDrill?.path ?? null),
  evidenceCheck("MAP-OFFLINE", "区域 DEM、影像、高程快照正式交付", mapEvidence.status, mapEvidence.message, mapEvidence.evidence),
  evidenceCheck("BROWSER-SHOW", "表演 3000 架目标浏览器规模", showScale.status, showScale.message, browserEvidencePath(evidence.browserRuntime, "CITY_SHOW")),
  evidenceCheck("BROWSER-LOGISTICS", "物流 50 架/100 单目标浏览器规模", logisticsScale.status, logisticsScale.message, browserEvidencePath(evidence.browserRuntime, "CITY_LOGISTICS")),
  evidenceCheck("BROWSER-VTL", "垂起巡检 20 架目标浏览器规模", vtlScale.status, vtlScale.message, browserEvidencePath(evidence.browserRuntime, "VTOL_INSPECTION")),
  evidenceCheck("BROWSER-SHOW-LONG-RUN", "表演正式规模浏览器长时运行", showLongRun.status, showLongRun.message, browserEvidencePath(evidence.browserRuntime, "CITY_SHOW")),
  evidenceCheck("BROWSER-LOGISTICS-LONG-RUN", "物流正式规模浏览器长时运行", logisticsLongRun.status, logisticsLongRun.message, browserEvidencePath(evidence.browserRuntime, "CITY_LOGISTICS")),
  evidenceCheck("BROWSER-VTL-LONG-RUN", "垂起巡检正式规模浏览器长时运行", vtlLongRun.status, vtlLongRun.message, browserEvidencePath(evidence.browserRuntime, "VTOL_INSPECTION")),
  evidenceCheck("PRODUCTION", "生产 HTTPS、正式密钥和目标环境恢复/升级复跑", targetEnvironmentStatus(evidence.targetEnvironment), targetEnvironmentMessage(evidence.targetEnvironment), evidence.targetEnvironment?.path ?? null)
]

const summary = {
  total: checks.length,
  passed: checks.filter((item) => item.status === "PASS").length,
  pending: checks.filter((item) => item.status === "PENDING").length,
  failed: checks.filter((item) => item.status === "FAIL").length
}
const report = {
  format: "wurenji-acceptance-evidence",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  project: "高巨低空集群虚拟仿真实训平台",
  requirementsBaseline: "软件功能需求-markdown/总体介绍.md",
  evidenceRoot: artifactsRoot,
  summary,
  checks,
  limitations: [
    "本报告不把代码级 DEM 契约当作真实授权 DEM 交付证据。",
    "本报告不把 100 架或小规模浏览器运行结果当作 3000 架表演正式规模证据。",
    "本机两账号隔离烟测不能替代真实班级规模、轮次和延迟验收。",
    "短时正式规模浏览器基线不能替代至少 30 分钟的持续连接、帧率和内存验收。",
    "目标环境 HTTPS、正式密钥、恢复和升级回滚仍需现场复跑并签字。"
  ]
}

await mkdir(dirname(outputPath), { recursive: true })
await mkdir(dirname(markdownPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
await writeFile(markdownPath, renderMarkdown(report), "utf8")
process.stdout.write(`${JSON.stringify({ summary, json: outputPath, markdown: markdownPath })}\n`)
if (summary.failed > 0) process.exitCode = 1

async function collectJsonFiles(directory) {
  const result = []
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return result }
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
    let value
    try { value = JSON.parse(await readFile(path, "utf8")) } catch { continue }
    const format = value?.format
    const key = formatKey(format)
    if (!key) continue
    const candidate = { ...value, path: relative(resolve("."), path) }
    if (key === "browserRuntime") {
      browserCandidates.push(candidate)
      continue
    }
    if (!candidates[key] || isPreferredEvidence(key, candidate, candidates[key])) candidates[key] = candidate
  }
  const browserRuntime = mergeBrowserRuntimeEvidence(browserCandidates)
  if (browserRuntime) candidates.browserRuntime = browserRuntime
  return candidates
}

function isPreferredEvidence(key, candidate, current) {
  return evidenceTime(candidate) > evidenceTime(current)
}

function formatKey(format) {
  return {
    "wurenji-performance-baseline": "performance",
    "wurenji-security-smoke": "security",
    "wurenji-document-acceptance": "documents",
    "wurenji-runtime-stream-smoke": "runtimeStream",
    "wurenji-resource-lifecycle-acceptance": "resourceLifecycle",
    "wurenji-backup-source-audit": "backupSource",
    "wurenji-backup-drill": "backupDrill",
    "wurenji-browser-runtime-baseline": "browserRuntime",
    "wurenji-deployment-smoke": "deployment",
    "wurenji-worker-smoke": "worker",
    "wurenji-software-upgrade-drill": "softwareUpgrade",
    "wurenji-class-concurrency-smoke": "classConcurrency",
    "wurenji-target-environment-acceptance": "targetEnvironment",
    "wurenji-local-regression": "localRegression"
  }[format] ?? null
}

function evidenceTime(value) {
  const raw = value.generatedAt ?? value.verifiedAt ?? value.completedAt ?? value.createdAt ?? value.startedAt ?? ""
  const time = Date.parse(raw)
  return Number.isFinite(time) ? time : 0
}

function evidenceCheck(code, title, status, message, path) {
  return { code, title, status, message, evidence: path }
}

function localRegressionStatus(value, code, override) {
  if (override?.trim()) return "PASS"
  const check = value?.checks?.find((item) => item.code === code)
  return check?.status === "PASSED" ? "PASS" : check?.status === "FAILED" ? "FAIL" : "PENDING"
}

function localRegressionMessage(value, code, override, missingMessage) {
  if (override?.trim()) return override.trim()
  const check = value?.checks?.find((item) => item.code === code)
  if (!check) return missingMessage
  const outcome = check.status === "PASSED" ? "通过" : "失败"
  return `${check.command}：${outcome}（${check.durationMs ?? "?"} ms）`
}

function localRegressionPath(value, code) {
  return value?.checks?.some((item) => item.code === code) ? value.path ?? null : null
}

function statusFrom(value) { return value === true ? "PASS" : value === false ? "FAIL" : "PENDING" }

function performanceMessage(value) {
  if (!value) return "未找到性能基线证据"
  const results = value.results ?? {}
  return `表演 P95 ${results.show?.p95Ms ?? "?"}ms；物流 P95 ${results.logistics?.p95Ms ?? "?"}ms；API P95 ${results.api?.p95Ms ?? "?"}ms；错误率 ${results.api?.errorRate ?? "?"}`
}

function securityMessage(value) {
  if (!value) return "未找到安全烟测证据"
  if (value.status === "BLOCKED") return `安全烟测被环境阻断：${value.reason ?? "未知原因"}`
  return `${value.summary?.passed ?? 0}/${value.summary?.total ?? 0} 项通过`
}

function securityStatus(value) {
  if (!value) return "PENDING"
  return value.status === "PASSED" ? "PASS" : value.status === "BLOCKED" ? "PENDING" : "FAIL"
}

function deploymentMessage(value) {
  if (!value) return "未找到部署烟测证据"
  return `${value.summary?.passed ?? 0}/${value.summary?.total ?? 0} 项通过`
}

function workerMessage(value) {
  if (!value) return "未找到 Worker 闭环证据"
  if (!value.summary?.passed) return `Worker 闭环未通过：${value.error ?? value.job?.lastError ?? "未知错误"}`
  return `Outbox 已发布，作业 ${value.job?.status ?? "?"}，尝试 ${value.job?.attempts ?? "?"} 次，幂等资产保持不变`
}

function documentMessage(value) {
  if (!value) return "未找到文档验收证据"
  if (value.summary?.blocked) return `文档验收被环境阻断：${value.summary.blocker ?? value.reason ?? "未知原因"}`
  return `三份文档与报告 DOCX/PDF 检查：${value.summary?.passed ? "通过" : "未通过"}`
}

function documentStatus(value) {
  if (!value || value.summary?.blocked) return "PENDING"
  return statusFrom(value.summary?.passed)
}

function runtimeStreamMessage(value) {
  if (!value) return "未找到 SSE 运行流证据"
  if (value.status === "BLOCKED") return `SSE 烟测被环境阻断：${value.reason ?? "未知原因"}`
  return `首帧 revision ${value.first?.revision ?? "?"}，续传起点 ${value.resumed?.resumedFromRevision ?? "?"}`
}

function runtimeStreamStatus(value) {
  if (!value) return "PENDING"
  return value.status === "PASSED" ? "PASS" : value.status === "BLOCKED" ? "PENDING" : "FAIL"
}

function resourceMessage(value) {
  if (!value) return "未找到资源生命周期证据"
  return value.status === "BLOCKED"
    ? `资源生命周期验收被环境阻断：${value.reason ?? "未知原因"}`
    : `签名包、激活、轮换、回滚和历史快照检查：${value.status}`
}

function resourceLifecycleStatus(value) {
  if (!value) return "PENDING"
  return value.status === "PASSED" ? "PASS" : value.status === "BLOCKED" ? "PENDING" : "FAIL"
}

function backupSourceMessage(value) {
  if (!value) return "未找到备份源审计证据"
  return `有效文件 ${value.assets?.checked ?? 0} 个，发现问题 ${value.assets?.findings ?? "?"} 个`
}

function backupSourceStatus(value) {
  if (!value) return "PENDING"
  return value.assets?.findings === 0 ? "PASS" : "FAIL"
}

function backupDrillStatus(value) {
  if (!value) return "PENDING"
  return value.status === "PASSED" ? "PASS" : value.status === "BLOCKED" ? "PENDING" : "FAIL"
}

function backupDrillMessage(value) {
  if (!value) return "未找到隔离恢复演练证据"
  return value.status === "PASSED" ? "隔离恢复演练通过" : `最近演练状态为 ${value.status}，需要在修复后重新演练`
}

function softwareUpgradeStatus(value) {
  if (!value) return "PENDING"
  return value.status === "PASSED" ? "PASS" : value.status === "BLOCKED" ? "PENDING" : "FAIL"
}

function softwareUpgradeMessage(value) {
  if (!value) return "未找到离线软件升级回滚演练证据"
  return value.status === "PASSED"
    ? `旧版本 ${value.versions?.old ?? "?"}、候选版本 ${value.versions?.candidate ?? "?"} 安装、写入、严格数据恢复和回切均通过`
    : value.status === "BLOCKED"
      ? `软件升级演练被环境阻断：${value.reason ?? "未知原因"}`
      : `软件升级演练状态为 ${value.status}：${value.reason ?? "未知原因"}`
}

function classConcurrencyStatus(value) {
  if (!value) return "PENDING"
  if (value.status === "BLOCKED") return "PENDING"
  if (value.status !== "PASSED") return "FAIL"
  return Number(value.summary?.failed) === 0 ? "PASS" : "FAIL"
}

function classConcurrencyMessage(value) {
  if (!value) return "未找到班级并发隔离验收证据"
  const students = value.configuration?.studentCount ?? value.scope?.students?.length ?? 2
  const p95 = value.load?.latency?.p95Ms
  return `${value.summary?.passed ?? 0}/${value.summary?.total ?? 0} 项通过，${students} 名学生、${value.configuration?.rounds ?? "?"} 轮并发读取${p95 === undefined ? "" : `，P95 ${p95} ms`}`
}

function targetEnvironmentStatus(value) {
  if (!value || value.status === "PENDING") return "PENDING"
  return value.status === "PASSED" ? "PASS" : "FAIL"
}

function targetEnvironmentMessage(value) {
  if (!value) return "未找到目标环境验收报告"
  return `${value.target?.label ?? "未命名目标"}：${value.summary?.passed ?? 0} PASS / ${value.summary?.pending ?? 0} PENDING / ${value.summary?.failed ?? 0} FAIL`
}

async function inspectMapReadiness(mapRoot) {
  const regionsRoot = resolve(mapRoot, "regions")
  const mapDirectory = relative(workspaceRoot, mapRoot).replaceAll("\\", "/") || "."
  const entries = await readdir(regionsRoot, { withFileTypes: true }).catch(() => [])
  const regionDirectories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  if (regionDirectories.length === 0) {
    return {
      status: "PENDING",
      message: "当前仓库未归档真实授权 quantized-mesh、离线影像瓦片和区域高程采样快照",
      evidence: mapDirectory
    }
  }
  const regions = await Promise.all(regionDirectories.map((entry) => inspectMapRegion(join(regionsRoot, entry.name), entry.name)))
  const invalid = regions.filter((region) => region.status === "FAIL")
  if (invalid.length > 0) {
    return {
      status: "FAIL",
      message: `地图区域资源校验失败：${invalid.map((region) => `${region.regionCode}（${region.message}）`).join("；")}`,
      evidence: mapDirectory
    }
  }
  const readyByScene = new Set(regions.filter((region) => region.status === "PASS").map((region) => region.sceneType))
  if (readyByScene.has("CITY_SHOW") && readyByScene.has("CITY_LOGISTICS") && readyByScene.has("VTOL_INSPECTION")) {
    return {
      status: "PASS",
      message: `表演区域 ${regions.filter((region) => region.sceneType === "CITY_SHOW" && region.status === "PASS").length} 块、物流区域 ${regions.filter((region) => region.sceneType === "CITY_LOGISTICS" && region.status === "PASS").length} 块、垂起区域 ${regions.filter((region) => region.sceneType === "VTOL_INSPECTION" && region.status === "PASS").length} 块均通过本地地图资源门禁`,
      evidence: mapDirectory
    }
  }
  return {
    status: "PENDING",
    message: `已发现 ${regions.length} 块区域，但尚未同时准备三个场景的正式资源`,
    evidence: mapDirectory
  }
}

async function inspectMapRegion(regionRoot, regionCode) {
  const descriptorPath = resolve(regionRoot, "package", "region-package.json")
  const descriptor = await readJson(descriptorPath)
  const content = descriptor?.content
  const sceneType = content?.sceneType
  if (sceneType !== "CITY_SHOW" && sceneType !== "CITY_LOGISTICS" && sceneType !== "VTOL_INSPECTION") {
    return { status: "FAIL", regionCode, sceneType: null, message: "区域包描述缺少有效 sceneType" }
  }
  const terrain = content.terrain
  const imagery = content.imagery
  const mapManifest = await readJson(resolve(regionRoot, "manifest.json"))
  if (!terrain || !imagery || !mapManifest) {
    return { status: "FAIL", regionCode, sceneType, message: "缺少区域 manifest、terrain 或 imagery 描述" }
  }
  const terrainDirectory = resolve(regionRoot, "terrain")
  const imageryDirectory = resolve(regionRoot, "imagery")
  const terrainLayer = await readJson(resolve(terrainDirectory, "layer.json"))
  const terrainFiles = await listFiles(terrainDirectory)
  const imageryFiles = await listFiles(imageryDirectory)
  if (!terrainLayer || !isQuantizedMeshLayer(terrainLayer) || !terrainFiles.some((file) => /[.]terrain(?:[.]gz)?$/i.test(file))) {
    return { status: "FAIL", regionCode, sceneType, message: "terrain 缺少有效 layer.json 或 quantized-mesh 瓦片" }
  }
  if (!imageryFiles.some((file) => /[.](png|jpe?g|webp)$/i.test(file))) {
    return { status: "FAIL", regionCode, sceneType, message: "imagery 缺少 PNG、JPEG 或 WebP 瓦片" }
  }
  const terrainSha256 = await directorySha256(terrainDirectory)
  const imagerySha256 = await directorySha256(imageryDirectory)
  const elevationPath = resolve(regionRoot, "elevation-samples.json")
  const elevationContent = await readFile(elevationPath, "utf8").catch(() => null)
  const elevationValue = elevationContent ? parseJsonText(elevationContent) : null
  const samples = Array.isArray(elevationValue) ? elevationValue : elevationValue?.samples
  const elevationSha256 = elevationContent ? sha256(Buffer.from(elevationContent, "utf8")) : null
  if (!Array.isArray(samples) || samples.length === 0) {
    return { status: "FAIL", regionCode, sceneType, message: "高程快照缺少非空 samples 数组" }
  }
  if (terrain.sha256 !== terrainSha256 || mapManifest.terrain?.sha256 !== terrainSha256 || imagery.sha256 !== imagerySha256 || mapManifest.imagery?.sha256 !== imagerySha256) {
    return { status: "FAIL", regionCode, sceneType, message: "terrain 或 imagery 文件树 SHA-256 与区域描述不一致" }
  }
  if (terrain.elevationSampleSha256 !== elevationSha256) {
    return { status: "FAIL", regionCode, sceneType, message: "高程快照 SHA-256 与区域描述不一致" }
  }
  return { status: "PASS", regionCode, sceneType, message: `区域资源完整，${samples.length} 个高程采样点通过` }
}

async function readJson(path) {
  const content = await readFile(path, "utf8").catch(() => null)
  return content ? parseJsonText(content) : null
}

function parseJsonText(content) {
  try { return JSON.parse(content) } catch { return null }
}

function isQuantizedMeshLayer(value) {
  return (Array.isArray(value?.tiles) && value.tiles.length > 0)
    || (typeof value?.format === "string" && value.format.toLowerCase().includes("quantized"))
}

async function listFiles(directory) {
  const result = []
  const rootStat = await stat(directory).catch(() => null)
  if (!rootStat?.isDirectory()) return result
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) result.push(path)
    }
  }
  await visit(directory)
  return result
}

async function directorySha256(directory) {
  const files = await listFiles(directory)
  if (files.length === 0) return null
  const hash = createHash("sha256")
  for (const file of files.sort()) {
    const content = await readFile(file)
    hash.update(relative(directory, file).replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(sha256(content))
    hash.update("\n")
  }
  return hash.digest("hex")
}

function sha256(content) { return createHash("sha256").update(content).digest("hex") }

function renderMarkdown(value) {
  const lines = [
    "# 候选版验收证据汇总",
    "",
    `生成时间：${value.generatedAt}`,
    `需求基线：${value.requirementsBaseline}`,
    "",
    `| 汇总 | 数量 |`,
    `|---|---:|`,
    `| 检查项 | ${value.summary.total} |`,
    `| PASS | ${value.summary.passed} |`,
    `| PENDING | ${value.summary.pending} |`,
    `| FAIL | ${value.summary.failed} |`,
    "",
    "| 编号 | 检查项 | 状态 | 说明 | 证据 |",
    "|---|---|---|---|---|",
    ...value.checks.map((item) => `| ${item.code} | ${item.title} | ${item.status} | ${item.message.replaceAll("|", "\\|")} | ${item.evidence ?? "待补"} |`),
    "",
    "## 交付限制",
    "",
    ...value.limitations.map((item) => `- ${item}`),
    ""
  ]
  return `${lines.join("\n")}\n`
}

function argument(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
}
