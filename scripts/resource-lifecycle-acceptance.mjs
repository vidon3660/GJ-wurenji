import { execFile as execFileCallback, spawn } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import pg from "pg"
import { ZipFile } from "yazl"

const execFile = promisify(execFileCallback)
const { Client: PgClient } = pg
const runId = timestamp()
const outputPath = resolve(argument("output") ?? `artifacts/resource-lifecycle/resource-lifecycle-${runId}.json`)
const sourceDatabaseUrl = process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
const databaseName = `wurenji_resource_acceptance_${runId}`
const databaseUrl = replaceDatabase(sourceDatabaseUrl, databaseName)
const root = await mkdtemp(join(tmpdir(), "wurenji-resource-lifecycle-"))
const storageDirectory = join(root, "files")
const trustedKeysPath = join(root, "trusted-keys.json")
const formalPackageDirectory = resolve("artifacts/resource-builds")
let formalTrustedKeys = {}
const formalPackageDescriptors = [
  { key: "rule", filename: "teaching-rules-1.0.0.zip", packageType: "RULE", sceneType: null, keyId: "local-teaching-v3" },
  { key: "showEvent", filename: "show-events-1.0.0.zip", packageType: "EVENT", sceneType: "CITY_SHOW", keyId: "local-teaching-v3" },
  { key: "logisticsEvent", filename: "logistics-events-1.0.0.zip", packageType: "EVENT", sceneType: "CITY_LOGISTICS", keyId: "local-teaching-v3" },
  { key: "report", filename: "show-report-1.0.0.zip", packageType: "REPORT", sceneType: null, keyId: "local-teaching-v3" },
  { key: "showDocuments", filename: "show-document-templates-1.0.1.zip", packageType: "DOCUMENT_TEMPLATE", sceneType: "CITY_SHOW", keyId: "show-documents-v1-0-1" }
]
const origin = "http://localhost:5173"
const acceptanceNodeEnv = process.env.RESOURCE_ACCEPTANCE_NODE_ENV ?? "test"
const seedDemoData = process.env.RESOURCE_ACCEPTANCE_SEED_DEMO_DATA ?? "true"
const port = await availablePort()
const apiUrl = `http://127.0.0.1:${port}/api`
const packageName = `R7 资源生命周期验收 ${runId}`
const oldKeyId = `r7-old-${runId}`
const newKeyId = `r7-new-${runId}`
const oldKeys = generateKeyPairSync("ed25519")
const newKeys = generateKeyPairSync("ed25519")
const oldPublicKey = publicPem(oldKeys.publicKey)
const newPublicKey = publicPem(newKeys.publicKey)
const startedAt = Date.now()
let server = null
let serverOutput = ""
let databaseCreated = false
let report

await mkdir(dirname(outputPath), { recursive: true })
try {
  formalTrustedKeys = await loadFormalTrustedKeys()
  await buildServer()
  await createTemporaryDatabase()
  databaseCreated = true
  await migrateTemporaryDatabase()
  await writeTrustedKeys({ ...formalTrustedKeys, [oldKeyId]: oldPublicKey })
  server = startServer()
  await waitForServer()
  report = await executeAcceptance()
} catch (error) {
  report = {
    format: "wurenji-resource-lifecycle-acceptance",
    formatVersion: 1,
    status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED",
    runId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    reason: normalizeError(error),
    serverOutput: serverOutput.slice(-8_000)
  }
} finally {
  const cleanupResult = await cleanup()
  report ??= {
    format: "wurenji-resource-lifecycle-acceptance",
    formatVersion: 1,
    status: "FAILED",
    runId,
    reason: "验收流程未生成结果"
  }
  report.completedAt ??= new Date().toISOString()
  report.cleanup = cleanupResult
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

process.stdout.write(`${JSON.stringify({ status: report.status, checks: report.checks ?? null })}\nReport ${outputPath}\n`)
if (report.status !== "PASSED") process.exitCode = 1

async function executeAcceptance() {
  const adminCookie = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
  const teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
  const formalPackages = await uploadAndActivateFormalPackages(adminCookie)
  const formalSnapshots = await publishFormalAssignments(teacherCookie, formalPackages)
  const oldArchive = await createSignedArchive(oldKeys.privateKey, oldKeyId, "1.0.0")
  const oldPackage = await uploadArchive(oldArchive, adminCookie, "rules-1.0.0.zip")
  assert(oldPackage.status === "STAGED", "旧密钥资源包未通过预检")
  assert(oldPackage.validation?.signatureKeyId === oldKeyId, "旧密钥预检记录不一致")
  const activatedOld = await request(`/v3/resource-packages/${oldPackage.id}/activate`, {
    method: "POST",
    cookie: adminCookie,
    body: { reason: "建立轮换前基线" }
  })
  assert(activatedOld.status === "ACTIVE", "旧版本未激活")

  const snapshot = await publishFrozenAssignment(teacherCookie, oldPackage, formalPackages)
  const frozenReference = snapshot.resourceRefs.find((item) => item.packageId === oldPackage.id)
  assert(frozenReference?.version === "1.0.0" && frozenReference.sha256 === oldPackage.sha256, "任务快照未冻结旧资源版本")

  await writeTrustedKeys({ [newKeyId]: newPublicKey })
  const newArchive = await createSignedArchive(newKeys.privateKey, newKeyId, "1.1.0")
  const newPackage = await uploadArchive(newArchive, adminCookie, "rules-1.1.0.zip")
  assert(newPackage.status === "STAGED", "新密钥资源包未通过预检")
  assert(newPackage.validation?.signatureKeyId === newKeyId, "新密钥预检记录不一致")
  const activatedNew = await request(`/v3/resource-packages/${newPackage.id}/activate`, {
    method: "POST",
    cookie: adminCookie,
    body: { reason: "切换到轮换后密钥" }
  })
  assert(activatedNew.status === "ACTIVE", "新版本未激活")

  const afterUpgrade = await request(`/v3/assignments/${snapshot.id}/snapshot`, { cookie: teacherCookie })
  assert(afterUpgrade.checksum === snapshot.checksum, "资源升级后历史任务校验和发生变化")
  assert(equalJson(afterUpgrade.resourceRefs, snapshot.resourceRefs), "资源升级后历史任务引用发生漂移")
  const formalAfterKeyRemoval = {
    show: await request(`/v3/assignments/${formalSnapshots.show.id}/snapshot`, { cookie: teacherCookie }),
    logistics: await request(`/v3/assignments/${formalSnapshots.logistics.id}/snapshot`, { cookie: teacherCookie })
  }
  assert(snapshotStable(formalSnapshots.show, formalAfterKeyRemoval.show), "移除正式公钥后表演任务快照发生漂移")
  assert(snapshotStable(formalSnapshots.logistics, formalAfterKeyRemoval.logistics), "移除正式公钥后物流任务快照发生漂移")
  const oldAfterUpgrade = await request(`/v3/resource-packages/${oldPackage.id}`, { cookie: adminCookie })
  assert(oldAfterUpgrade.package.status === "RETIRED", "新版本激活后旧版本未退役")

  const staleArchive = await createSignedArchive(oldKeys.privateKey, oldKeyId, "1.2.0")
  const stalePackage = await uploadArchive(staleArchive, adminCookie, "rules-stale-key.zip")
  assert(stalePackage.status === "REJECTED", "已移除公钥签署的新包未被拒绝")
  assert(String(stalePackage.validation?.rejectionReason).includes("签名密钥未受信任"), "旧密钥拒绝原因不正确")

  const archiveDownload = await downloadArchive(oldPackage.id, adminCookie)
  assert(sha256(archiveDownload) === sha256(oldArchive), "退役归档下载内容发生变化")
  const rejectedRollback = await rawRequest(`/v3/resource-packages/${oldPackage.id}/rollback`, {
    method: "POST",
    cookie: adminCookie,
    body: { reason: "旧公钥已移除，不应允许回滚" }
  })
  assert(rejectedRollback.status === 409 && rejectedRollback.text.includes("签名密钥未受信任"), "旧公钥移除后回滚未被阻止")

  await writeTrustedKeys({ ...formalTrustedKeys, [oldKeyId]: oldPublicKey, [newKeyId]: newPublicKey })
  const rolledBack = await request(`/v3/resource-packages/${oldPackage.id}/rollback`, {
    method: "POST",
    cookie: adminCookie,
    body: { reason: "恢复归档验证公钥后回滚" }
  })
  assert(rolledBack.status === "ACTIVE", "恢复归档公钥后旧版本未成功回滚")
  const newAfterRollback = await request(`/v3/resource-packages/${newPackage.id}`, { cookie: adminCookie })
  assert(newAfterRollback.package.status === "RETIRED", "回滚后新版本未退役")
  const oldDetail = await request(`/v3/resource-packages/${oldPackage.id}`, { cookie: adminCookie })
  assert(oldDetail.lifecycle.some((event) => event.action === "ROLLED_BACK" && event.previousPackageId === newPackage.id), "回滚生命周期记录不完整")

  const afterRollback = await request(`/v3/assignments/${snapshot.id}/snapshot`, { cookie: teacherCookie })
  assert(afterRollback.checksum === snapshot.checksum && equalJson(afterRollback.resourceRefs, snapshot.resourceRefs), "回滚后历史任务快照发生漂移")
  const databaseVersion = await postgresVersion()
  const checks = {
    oldKeyPackageAccepted: true,
    newKeyPackageAccepted: true,
    staleKeyPackageRejected: true,
    activationRetiresPrevious: true,
    rollbackRequiresCurrentTrust: true,
    rollbackRestoresHistoricalVersion: true,
    historicalSnapshotStable: true,
    retiredArchiveImmutable: true,
    lifecycleAuditRecorded: true,
    formalBusinessPackagesActivated: Object.values(formalPackages).every((item) => item.status === "ACTIVE"),
    showSnapshotUsesSignedPackages: snapshotUsesPackages(formalSnapshots.show, [formalPackages.rule, formalPackages.showEvent, formalPackages.report, formalPackages.showDocuments]),
    logisticsSnapshotUsesSignedPackages: snapshotUsesPackages(formalSnapshots.logistics, [formalPackages.rule, formalPackages.logisticsEvent, formalPackages.report]),
    formalSnapshotsStableAfterKeyRemoval: snapshotStable(formalSnapshots.show, formalAfterKeyRemoval.show) && snapshotStable(formalSnapshots.logistics, formalAfterKeyRemoval.logistics)
  }
  return {
    format: "wurenji-resource-lifecycle-acceptance",
    formatVersion: 1,
    status: Object.values(checks).every(Boolean) ? "PASSED" : "FAILED",
    runId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    environment: { platform: process.platform, node: process.version, databaseVersion, isolatedDatabase: databaseName, storageProvider: "LOCAL" },
    keys: { original: oldKeyId, rotated: newKeyId, archivedKeyRestoredForRollback: true },
    packages: {
      original: { id: oldPackage.id, version: oldPackage.version, sha256: oldPackage.sha256, finalStatus: oldDetail.package.status },
      replacement: { id: newPackage.id, version: newPackage.version, sha256: newPackage.sha256, finalStatus: newAfterRollback.package.status },
      stale: { id: stalePackage.id, version: stalePackage.version, status: stalePackage.status }
    },
    formalPackages: Object.fromEntries(Object.entries(formalPackages).map(([key, item]) => [key, {
      id: item.id,
      packageType: item.packageType,
      name: item.name,
      version: item.version,
      sha256: item.sha256,
      signatureKeyId: item.validation?.signatureKeyId,
      status: item.status
    }])),
    formalSnapshots: {
      show: summarizeSnapshot(formalSnapshots.show),
      logistics: summarizeSnapshot(formalSnapshots.logistics)
    },
    snapshot: { id: snapshot.id, checksum: snapshot.checksum, frozenResource: frozenReference },
    checks
  }
}

async function loadFormalTrustedKeys() {
  const base = JSON.parse(await readFile(resolve("artifacts/resource-key/trusted-keys.json"), "utf8"))
  const documentKeys = JSON.parse(await readFile(resolve("artifacts/resource-key/v1-0-1/trusted-keys.json"), "utf8"))
  return { ...base, ...documentKeys }
}

function isEnvironmentBlocked(error) {
  const message = normalizeError(error)
  return /ENOENT|ECONNREFUSED|database|postgres|resource-key|docker/i.test(message)
}

async function uploadAndActivateFormalPackages(cookie) {
  const packages = {}
  for (const descriptor of formalPackageDescriptors) {
    const archive = await readFile(join(formalPackageDirectory, descriptor.filename))
    const uploaded = await uploadArchive(archive, cookie, descriptor.filename)
    assert(uploaded.status === "STAGED", `正式资源包未通过预检：${descriptor.filename}`)
    assert(uploaded.packageType === descriptor.packageType, `正式资源包类型不一致：${descriptor.filename}`)
    assert(uploaded.validation?.signatureKeyId === descriptor.keyId, `正式资源包签名密钥不一致：${descriptor.filename}`)
    if (descriptor.sceneType) assert(uploaded.manifest?.sceneType === descriptor.sceneType, `正式资源包场景不一致：${descriptor.filename}`)
    const activated = await request(`/v3/resource-packages/${uploaded.id}/activate`, {
      method: "POST",
      cookie,
      body: { reason: `R7 正式业务包隔离验收：${descriptor.filename}` }
    })
    assert(activated.status === "ACTIVE", `正式资源包未激活：${descriptor.filename}`)
    packages[descriptor.key] = activated
  }
  return packages
}

async function publishFormalAssignments(cookie, packages) {
  const show = await publishAssignment(cookie, {
    sceneType: "CITY_SHOW",
    title: `R7 正式表演资源冻结验收 ${runId}`,
    taskBrief: "验证正式签名规则、事件、报告和申报母版均冻结到表演任务快照",
    scaleTemplateCode: "SHOW_1000",
    showParameters: {
      projectBackground: "正式签名资源包双场景冻结验收",
      completionRequirements: "完成正式资源引用发布并验证历史任务快照稳定",
      plannedStartAt: new Date(Date.now() + 3_600_000).toISOString(),
      plannedEndAt: new Date(Date.now() + 5_400_000).toISOString(),
      plannedAudienceCount: 3000,
      maximumHeightMeters: 120,
      contactName: "R7 验收联系人",
      contactPhone: "13800000000",
      aircraftModel: "教学统一编队无人机"
    },
    scenario: { eventCodes: ["WEATHER_LIMIT", "POSITIONING_DRIFT"] },
    packages: [packages.rule, packages.showEvent, packages.report, packages.showDocuments]
  })
  const logistics = await publishAssignment(cookie, {
    sceneType: "CITY_LOGISTICS",
    title: `R7 正式物流资源冻结验收 ${runId}`,
    taskBrief: "验证正式签名规则、事件和报告均冻结到物流任务快照",
    scaleTemplateCode: "LOGISTICS_3",
    scenario: { orderCount: 3, orderReleaseMode: "BATCH", timeWindowMinutes: 30 },
    packages: [packages.rule, packages.logisticsEvent, packages.report]
  })
  assert(snapshotUsesPackages(show, [packages.rule, packages.showEvent, packages.report, packages.showDocuments]), "表演任务未完整冻结正式签名业务包")
  assert(snapshotUsesPackages(logistics, [packages.rule, packages.logisticsEvent, packages.report]), "物流任务未完整冻结正式签名业务包")
  return { show, logistics }
}

async function publishFrozenAssignment(cookie, rulePackage, formalPackages) {
  return publishAssignment(cookie, {
    sceneType: "CITY_LOGISTICS",
    title: `R7 资源冻结验收 ${runId}`,
    taskBrief: "验证升级和密钥轮换后历史任务仍使用发布时冻结资源",
    scaleTemplateCode: "LOGISTICS_3",
    scenario: { orderCount: 3, orderReleaseMode: "BATCH", timeWindowMinutes: 30 },
    packages: [rulePackage, formalPackages.logisticsEvent, formalPackages.report]
  })
}

async function publishAssignment(cookie, options) {
  const resources = await request("/v3/resource-packages", { cookie })
  const regions = await request(`/v3/resource-packages/regions/catalog?sceneType=${options.sceneType}`, { cookie })
  const region = regions[0]
  assert(region, `没有可用于 ${options.sceneType} 的区域资源`)
  const selected = [
    ...options.packages,
    resources.find((item) => item.status === "ACTIVE" && item.packageType === "REGION" && item.id === region.packageId),
    resources.find((item) => item.status === "ACTIVE" && item.packageType === "SCALE_TEMPLATE" && item.manifest.sceneType === options.sceneType),
    resources.find((item) => item.status === "ACTIVE" && item.packageType === "AIRCRAFT")
  ]
  assert(selected.every(Boolean), `${options.sceneType} 任务所需资源不完整`)
  const classes = await request("/v1/education/classes", { cookie })
  assert(classes.length > 0, "没有可用于验收的班级")
  const draft = await request("/v3/assignments/drafts", {
    method: "POST",
    cookie,
    body: {
      title: options.title,
      sceneType: options.sceneType,
      mode: "TRAINING",
      isAcceptanceData: true,
      config: {
        taskBrief: options.taskBrief,
        ...(options.showParameters ? { showParameters: options.showParameters } : {}),
        scaleTemplateCode: options.scaleTemplateCode,
        regionPackageId: region.packageId,
        availableAt: new Date(Date.now() - 60_000).toISOString(),
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        allowResubmission: true,
        allowedValidationAttempts: 3,
        allowedRuntimeAttempts: 2,
        resultVisibility: "FULL_REVIEW",
        scenario: options.scenario
      }
    }
  })
  const targets = [{ type: "CLASS", targetId: classes[0].id }]
  const resourcePackageIds = selected.map((item) => item.id)
  const preview = await request(`/v3/assignments/drafts/${draft.id}/preview`, {
    method: "POST",
    cookie,
    body: { expectedRevision: draft.revision, targets, resourcePackageIds }
  })
  const assignmentPreflight = await request(`/v3/assignments/drafts/${draft.id}/preflight`, {
    method: "POST",
    cookie,
    body: { expectedRevision: draft.revision, targets, resourcePackageIds }
  })
  const preflightWarnings = assignmentPreflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code)
  const published = await request(`/v3/assignments/drafts/${draft.id}/publish`, {
    method: "POST",
    cookie,
    body: {
      expectedRevision: draft.revision,
      configHash: preview.configHash,
      targets,
      resourcePackageIds,
      ...(preflightWarnings.length > 0 ? {
        preflightConfirmation: { checkedAt: assignmentPreflight.checkedAt, checkCodes: preflightWarnings }
      } : {})
    }
  })
  return published.snapshot
}

async function uploadArchive(content, cookie, filename) {
  const form = new FormData()
  form.append("file", new Blob([new Uint8Array(content)], { type: "application/zip" }), filename)
  const response = await fetch(`${apiUrl}/v3/resource-packages/upload`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
    body: form
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`资源包上传失败：${response.status} ${text}`)
  return JSON.parse(text)
}

async function downloadArchive(id, cookie) {
  const response = await fetch(`${apiUrl}/v3/resource-packages/${id}/archive`, { headers: { Cookie: cookie, Origin: origin } })
  if (!response.ok) throw new Error(`资源包下载失败：${response.status} ${await response.text()}`)
  return Buffer.from(await response.arrayBuffer())
}

async function login(email, password) {
  const response = await fetch(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  })
  if (!response.ok) throw new Error(`登录失败：${response.status} ${await response.text()}`)
  const cookie = (response.headers.get("set-cookie") ?? "").split(";", 1)[0]
  if (!cookie) throw new Error("登录响应缺少 Cookie")
  return cookie
}

async function request(path, options = {}) {
  const response = await rawRequest(path, options)
  if (response.status >= 400) throw new Error(`${options.method ?? "GET"} ${path} 失败：${response.status} ${response.text}`)
  return response.text ? JSON.parse(response.text) : null
}

async function rawRequest(path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers: { Origin: origin, ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  return { status: response.status, text: await response.text() }
}

async function buildServer() {
  if (process.env.RESOURCE_ACCEPTANCE_SKIP_BUILD === "true") return
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error("无法定位当前 npm CLI")
  for (const workspace of ["@wurenji/shared", "@wurenji/simulation", "@wurenji/server"]) {
    await execFile(process.execPath, [npmCli, "run", "build", "--workspace", workspace], { cwd: process.cwd(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  }
}

async function migrateTemporaryDatabase() {
  await execFile(process.execPath, ["apps/server/dist/database/migrate.js"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  })
}

function startServer() {
  const child = spawn(process.execPath, ["apps/server/dist/main.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      WEB_ORIGIN: origin,
      NODE_ENV: acceptanceNodeEnv,
      JWT_SECRET: `resource-acceptance-${runId}`,
      TYPEORM_SYNCHRONIZE: "false",
      TYPEORM_LOGGING: "false",
      SEED_DEMO_DATA: seedDemoData,
      V3_FILE_STORAGE_PROVIDER: "LOCAL",
      V3_FILE_STORAGE_DIR: storageDirectory,
      RESOURCE_PACKAGE_TRUSTED_KEYS_JSON: "",
      RESOURCE_PACKAGE_TRUSTED_KEYS_FILE: trustedKeysPath
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  })
  child.stdout.on("data", (chunk) => { serverOutput += chunk.toString("utf8") })
  child.stderr.on("data", (chunk) => { serverOutput += chunk.toString("utf8") })
  return child
}

async function waitForServer() {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`临时服务提前退出：${server.exitCode}\n${serverOutput.slice(-8_000)}`)
    try {
      const response = await fetch(`${apiUrl}/auth/me`, { headers: { Origin: origin } })
      if (response.status === 401) return
    } catch {
    }
    await delay(100)
  }
  throw new Error(`等待临时服务启动超时\n${serverOutput.slice(-8_000)}`)
}

async function createTemporaryDatabase() {
  assertTemporaryDatabase(databaseName)
  const client = new PgClient({ connectionString: replaceDatabase(sourceDatabaseUrl, "postgres") })
  await client.connect()
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName])
    if (exists.rowCount) throw new Error(`临时数据库已存在：${databaseName}`)
    await client.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await client.end()
  }
}

async function postgresVersion() {
  const client = new PgClient({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query("SHOW server_version")
    return result.rows[0]?.server_version ?? "unknown"
  } finally {
    await client.end()
  }
}

async function cleanup() {
  const result = { server: "SKIPPED", database: "SKIPPED", files: "SKIPPED" }
  if (server && server.exitCode === null) {
    server.kill()
    await Promise.race([new Promise((resolveExit) => server.once("exit", resolveExit)), delay(5_000)])
    result.server = server.exitCode === null && server.signalCode === null ? "TERMINATION_REQUESTED" : "STOPPED"
  }
  if (databaseCreated) {
    assertTemporaryDatabase(databaseName)
    const client = new PgClient({ connectionString: replaceDatabase(sourceDatabaseUrl, "postgres") })
    await client.connect()
    try {
      await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [databaseName])
      await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      result.database = "DROPPED"
    } finally {
      await client.end()
    }
  }
  await rm(root, { recursive: true, force: true })
  result.files = "REMOVED"
  return result
}

async function createSignedArchive(privateKey, keyId, version) {
  const schemaPath = "schemas/manifest.schema.json"
  const payloadPath = "payload/rules.json"
  const schema = Buffer.from(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }), "utf8")
  const payload = Buffer.from(JSON.stringify({ rules: [{ code: "RESOURCE_LIFECYCLE", version }] }), "utf8")
  const manifest = {
    formatVersion: 1,
    packageType: "RULE",
    name: packageName,
    version,
    schemaVersion: 1,
    minimumPlatformVersion: "0.1.0",
    publishedAt: new Date().toISOString(),
    signature: { algorithm: "Ed25519", keyId },
    dependencies: [],
    files: [
      { path: schemaPath, role: "MANIFEST_SCHEMA", mimeType: "application/schema+json", sizeBytes: schema.byteLength, sha256: sha256(schema) },
      { path: payloadPath, role: "RULE_DEFINITIONS", mimeType: "application/json", sizeBytes: payload.byteLength, sha256: sha256(payload) }
    ],
    content: { rules: [{ code: "RESOURCE_LIFECYCLE", title: "资源生命周期验收", sceneTypes: ["CITY_SHOW", "CITY_LOGISTICS"] }] }
  }
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8")
  const checksums = { algorithm: "SHA-256", files: { "manifest.json": sha256(manifestBuffer), [schemaPath]: sha256(schema), [payloadPath]: sha256(payload) } }
  const checksumsBuffer = Buffer.from(JSON.stringify(checksums), "utf8")
  const signature = sign(null, Buffer.from(canonicalJson({ manifest, checksums }), "utf8"), privateKey)
  return createZip([["manifest.json", manifestBuffer], [schemaPath, schema], [payloadPath, payload], ["checksums.json", checksumsBuffer], ["signature.ed25519", signature]])
}

function createZip(entries) {
  return new Promise((resolveArchive, rejectArchive) => {
    const zip = new ZipFile()
    const chunks = []
    zip.outputStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
    zip.outputStream.once("error", rejectArchive)
    zip.outputStream.once("end", () => resolveArchive(Buffer.concat(chunks)))
    for (const [path, content] of entries) zip.addBuffer(content, path)
    zip.end()
  })
}

async function writeTrustedKeys(keys) {
  await writeFile(trustedKeysPath, `${JSON.stringify(keys)}\n`, "utf8")
}

function publicPem(key) { return key.export({ type: "spki", format: "pem" }).toString() }
function replaceDatabase(value, database) { const url = new URL(value); url.pathname = `/${database}`; return url.toString() }
function assertTemporaryDatabase(value) { if (!value.startsWith("wurenji_resource_acceptance_") || !/^[a-z0-9_]+$/.test(value)) throw new Error(`拒绝操作非验收数据库：${value}`) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function equalJson(left, right) { return JSON.stringify(left) === JSON.stringify(right) }
function snapshotStable(expected, actual) { return expected.checksum === actual.checksum && equalJson(expected.resourceRefs, actual.resourceRefs) }
function snapshotUsesPackages(snapshot, packages) { const ids = new Set(snapshot.resourceRefs.map((item) => item.packageId)); return packages.every((item) => ids.has(item.id)) }
function summarizeSnapshot(snapshot) { return { id: snapshot.id, checksum: snapshot.checksum, resourceRefs: snapshot.resourceRefs } }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }
function canonicalJson(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}` }
function delay(value) { return new Promise((resolveDelay) => setTimeout(resolveDelay, value)) }
function normalizeError(error) { return error instanceof Error ? error.message : String(error) }
function argument(name) { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : undefined }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase() }
function availablePort() { return new Promise((resolvePort, rejectPort) => { const server = createServer(); server.once("error", rejectPort); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") return rejectPort(new Error("无法分配临时端口")); server.close((error) => error ? rejectPort(error) : resolvePort(address.port)) }) }) }
