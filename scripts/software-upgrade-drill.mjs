import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { Client as MinioClient } from "minio"

const execFile = promisify(execFileCallback)
const argumentsByName = parseArguments(process.argv.slice(2))
const runId = timestamp()
const projectName = `wurenji_upgrade_drill_${runId}`
const oldVersion = argumentsByName["old-version"] ?? "0.1.0"
const candidateVersion = argumentsByName["candidate-version"] ?? `0.1.1-drill.${runId}`
const targetLabel = process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const outputRoot = resolve(argumentsByName.output ?? `artifacts/software-upgrade-drill/${runId}`)
const workspace = resolve(outputRoot, "workspace")
const releasePath = resolve(workspace, "release")
const statePath = resolve(workspace, "installation")
const reportPath = resolve(outputRoot, "drill-report.json")
const imagePrefix = `wurenji-upgrade-${runId}`
const oldPlatformImage = `${imagePrefix}-platform:${oldVersion}`
const oldBackupImage = `${imagePrefix}-backup:${oldVersion}`
const candidatePlatformImage = `${imagePrefix}-platform:${candidateVersion}`
const candidateBackupImage = `${imagePrefix}-backup:${candidateVersion}`
const ports = await allocatePorts(4)
const baseUrl = `http://localhost:${ports[0]}`
const environment = {
  ...process.env,
  COMPOSE_PROJECT_NAME: projectName,
  APP_PORT: String(ports[0]),
  POSTGRES_PORT: String(ports[1]),
  MINIO_API_PORT: String(ports[2]),
  MINIO_CONSOLE_PORT: String(ports[3]),
  POSTGRES_PASSWORD: "upgrade-drill-postgres",
  MINIO_ACCESS_KEY: "upgrade-drill",
  MINIO_SECRET_KEY: "upgrade-drill-minio-secret",
  MINIO_BUCKET: "wurenji",
  JWT_SECRET: "upgrade-drill-jwt-secret-01234567890123456789",
  SEED_DEMO_DATA: "false",
  PLATFORM_VERSION: oldVersion,
  PLATFORM_IMAGE: oldPlatformImage,
  BACKUP_IMAGE: oldBackupImage,
  V3_FILE_STORAGE_PROVIDER: "MINIO"
}
const startedAt = Date.now()
const checks = []
let report

await mkdir(workspace, { recursive: true })
try {
  await compose(["up", "-d", "db", "minio"])
  await compose(["build", "app", "backup"])
  await compose(["up", "-d", "migrate"])
  await compose(["up", "-d", "--no-build", "app", "worker"])
  const initialReadiness = await waitForVersion(oldVersion)
  pass("OLD_VERSION_READY", `旧版本 ${oldVersion} 已就绪`)

  await databaseCommand([
    "CREATE TABLE software_upgrade_drill_markers (marker text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())",
    "INSERT INTO software_upgrade_drill_markers(marker) VALUES ('BEFORE_UPGRADE')"
  ].join("; "))
  const minio = createMinioClient()
  if (!await minio.bucketExists(environment.MINIO_BUCKET)) await minio.makeBucket(environment.MINIO_BUCKET)
  await minio.putObject(environment.MINIO_BUCKET, "upgrade-drill/before.txt", Buffer.from("before-upgrade"))
  pass("PRE_UPGRADE_DATA", "升级前数据库标记和对象已写入")

  await runNode([
    "scripts/software-release.mjs", "build",
    "--version", candidateVersion,
    "--minimum-compatible-version", oldVersion,
    "--platform-image", candidatePlatformImage,
    "--backup-image", candidateBackupImage,
    "--output", releasePath
  ])
  const releaseManifest = JSON.parse(await readFile(resolve(releasePath, "manifest.json"), "utf8"))
  pass("RELEASE_BUILT", `候选发布包含 ${releaseManifest.artifacts.length} 个校验文件`)

  await runNode([
    "scripts/software-release.mjs", "install",
    "--input", releasePath,
    "--state-output", statePath,
    "--base-url", baseUrl,
    "--confirm", "INSTALL"
  ])
  const installEvidence = JSON.parse(await readFile(resolve(statePath, "install-evidence.json"), "utf8"))
  assert(installEvidence.status === "PASSED", `升级安装失败：${installEvidence.reason ?? "未知原因"}`)
  const candidateReadiness = await waitForVersion(candidateVersion)
  pass("CANDIDATE_READY", `候选版本 ${candidateVersion} 已就绪`)

  await databaseCommand("INSERT INTO software_upgrade_drill_markers(marker) VALUES ('AFTER_UPGRADE')")
  await minio.putObject(environment.MINIO_BUCKET, "upgrade-drill/after.txt", Buffer.from("after-upgrade"))
  assert((await readMarkers()).includes("AFTER_UPGRADE"), "候选版本数据库写入失败")
  assert(await objectExists(minio, "upgrade-drill/after.txt"), "候选版本对象写入失败")
  pass("CANDIDATE_WRITES", "候选版本期间数据库和对象写入成功")

  await runNode([
    "scripts/software-release.mjs", "rollback",
    "--state", statePath,
    "--base-url", baseUrl,
    "--allow-external-state", "true",
    "--confirm", "ROLLBACK",
    "--confirm-data-restore", "RESTORE_PRE_UPGRADE_DATA"
  ])
  const rollbackEvidenceName = (await readdir(statePath)).find((name) => name.startsWith("rollback-evidence-") && name.endsWith(".json"))
  assert(rollbackEvidenceName, "未生成回滚证据")
  const rollbackEvidence = JSON.parse(await readFile(resolve(statePath, rollbackEvidenceName), "utf8"))
  assert(rollbackEvidence.status === "PASSED", `回滚失败：${rollbackEvidence.reason ?? "未知原因"}`)
  const rollbackReadiness = await waitForVersion(oldVersion)
  pass("ROLLBACK_READY", `旧版本 ${oldVersion} 已恢复就绪`)

  const restoredMarkers = await readMarkers()
  assert(JSON.stringify(restoredMarkers) === JSON.stringify(["BEFORE_UPGRADE"]), `回滚后数据库标记不一致：${restoredMarkers.join(", ")}`)
  assert(await objectExists(minio, "upgrade-drill/before.txt"), "回滚后升级前对象缺失")
  assert(!await objectExists(minio, "upgrade-drill/after.txt"), "回滚后候选版本对象仍存在")
  pass("DATA_ROLLBACK_EXACT", "升级前数据保留，升级后数据库和对象写入已清除")

  report = {
    format: "wurenji-software-upgrade-drill",
    formatVersion: 1,
    status: "PASSED",
    runId,
    projectName,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    versions: { old: oldVersion, candidate: candidateVersion },
    release: {
      manifestSha256: sha256(await readFile(resolve(releasePath, "manifest.json"))),
      artifacts: releaseManifest.artifacts.length,
      migrationSha256: releaseManifest.migrations.sha256,
      platformImageId: releaseManifest.images.platform.id,
      backupImageId: releaseManifest.images.backup.id
    },
    installation: summarizeEvidence(installEvidence),
    rollback: summarizeEvidence(rollbackEvidence),
    readiness: { initial: initialReadiness, candidate: candidateReadiness, rollback: rollbackReadiness },
    restoredMarkers,
    checks
  }
} catch (error) {
  report = {
    format: "wurenji-software-upgrade-drill",
    formatVersion: 1,
    status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED",
    runId,
    projectName,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    versions: { old: oldVersion, candidate: candidateVersion },
    reason: error instanceof Error ? error.message : String(error),
    checks
  }
} finally {
  report ??= { format: "wurenji-software-upgrade-drill", formatVersion: 1, status: "FAILED", reason: "未生成演练结果" }
  report.environment = { ...report.environment, targetLabel }
  report.cleanup = await cleanup()
  await mkdir(outputRoot, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport: ${reportPath}\n`)
if (report.status !== "PASSED") process.exitCode = 1

async function compose(argumentsList) {
  return run("docker", ["compose", "--profile", "worker", "--profile", "backup", ...argumentsList])
}

async function runNode(argumentsList) { return run(process.execPath, argumentsList) }

async function run(commandName, argumentsList) {
  try {
    return await execFile(commandName, argumentsList, { cwd: process.cwd(), env: environment, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000 })
  } catch (error) {
    const stdout = String(error?.stdout ?? "").slice(-8_000)
    const stderr = String(error?.stderr ?? error?.message ?? error).slice(-8_000)
    throw new Error(`${commandName} ${argumentsList.join(" ")} 执行失败\n${stdout}\n${stderr}`, { cause: error })
  }
}

function isEnvironmentBlocked(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /failed to connect to the docker api|docker daemon|docker desktop|cannot connect to the docker/i.test(message)
}

async function databaseCommand(sql) {
  await compose(["exec", "-T", "db", "psql", "--username", "wurenji", "--dbname", "wurenji", "--set", "ON_ERROR_STOP=1", "--command", sql])
}

async function readMarkers() {
  const result = await compose(["exec", "-T", "db", "psql", "--username", "wurenji", "--dbname", "wurenji", "--tuples-only", "--no-align", "--command", "SELECT marker FROM software_upgrade_drill_markers ORDER BY marker"])
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
}

async function waitForVersion(version) {
  const timeoutAt = Date.now() + 180_000
  let lastReason = "尚未请求"
  while (Date.now() < timeoutAt) {
    try {
      const response = await fetch(`${baseUrl}/api/readyz`, { signal: AbortSignal.timeout(5_000) })
      const body = await response.json()
      if (response.ok && body.status === "ready" && body.database === "ok" && body.version === version) return body
      lastReason = `HTTP ${response.status} ${JSON.stringify(body)}`
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
  }
  throw new Error(`等待 ${version} 就绪超时：${lastReason}`)
}

function createMinioClient() {
  return new MinioClient({
    endPoint: "localhost",
    port: ports[2],
    useSSL: false,
    accessKey: environment.MINIO_ACCESS_KEY,
    secretKey: environment.MINIO_SECRET_KEY
  })
}

async function objectExists(client, objectKey) {
  try { await client.statObject(environment.MINIO_BUCKET, objectKey); return true } catch (error) { if (error?.code === "NotFound" || error?.code === "NoSuchKey") return false; throw error }
}

async function cleanup() {
  const result = { compose: "SKIPPED", images: {}, workspace: "SKIPPED" }
  if (!projectName.startsWith("wurenji_upgrade_drill_")) return { ...result, reason: "拒绝清理非演练项目" }
  try { await compose(["down", "-v", "--remove-orphans", "--timeout", "30"]); result.compose = "REMOVED" } catch (error) { result.compose = error instanceof Error ? error.message.slice(-2_000) : String(error) }
  for (const image of [oldPlatformImage, oldBackupImage, candidatePlatformImage, candidateBackupImage]) {
    try { await run("docker", ["image", "rm", image]); result.images[image] = "REMOVED" } catch { result.images[image] = "SKIPPED" }
  }
  try { await rm(workspace, { recursive: true, force: true }); result.workspace = "REMOVED" } catch (error) { result.workspace = error instanceof Error ? error.message : String(error) }
  return result
}

async function allocatePorts(count) {
  const result = []
  for (let index = 0; index < count; index += 1) result.push(await allocatePort())
  return result
}

async function allocatePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port))
    })
  })
}

function summarizeEvidence(value) {
  return { status: value.status, startedAt: value.startedAt, completedAt: value.completedAt, recoveryPoint: value.recoveryPoint, readiness: value.readiness }
}

function pass(code, message) { checks.push({ code, status: "PASS", message }) }
function assert(condition, message) { if (!condition) throw new Error(message) }
function sha256(content) { return createHash("sha256").update(content).digest("hex") }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "z").toLowerCase() }

function parseArguments(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index]
    const value = values[index + 1]
    if (!name?.startsWith("--") || value === undefined) throw new Error(`参数无效：${name ?? ""}`)
    result[name.slice(2)] = value
  }
  return result
}
