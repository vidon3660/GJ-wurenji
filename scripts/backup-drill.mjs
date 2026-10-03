import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { Client as MinioClient } from "minio"
import pg from "pg"

const execFile = promisify(execFileCallback)
const { Client: PgClient } = pg
const argumentsByName = parseArguments(process.argv.slice(2))
const runId = timestamp()
const rootPath = resolve(argumentsByName.output ?? `artifacts/backup-drill/${runId}`)
const sourcePath = resolve(rootPath, "source")
const sourceAuditPath = resolve(rootPath, "source-audit.json")
const databaseName = `wurenji_restore_drill_${runId}`
const bucketName = `wurenji-restore-drill-${runId}`
const restoreRoot = resolve(rootPath, "restore-files")
const sourceDatabaseUrl = process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
const targetLabel = process.env.ACCEPTANCE_TARGET_LABEL?.trim() || "local-docker"
const reportPath = resolve(rootPath, "drill-report.json")
const startedAt = Date.now()
let temporaryDatabaseCreated = false
let temporaryBucketCreated = false
let report

await mkdir(rootPath, { recursive: true })
try {
  const audit = await runBackupCommand("audit", ["--output", sourceAuditPath], sourceEnvironment())
  if (audit.code !== 0) {
    report = blockedReport("SOURCE_AUDIT_FAILED", audit)
  } else {
    const created = await runBackupCommand("create", ["--output", sourcePath], sourceEnvironment())
    if (created.code !== 0) {
      report = blockedReport("BACKUP_CREATE_FAILED", created)
    } else {
      const manifest = JSON.parse(await readFile(resolve(sourcePath, "manifest.json"), "utf8"))
      await createTemporaryDatabase()
      temporaryDatabaseCreated = true
      await createTemporaryBucket()
      temporaryBucketCreated = true
      const restored = await runBackupCommand("restore", ["--input", sourcePath, "--confirm", "RESTORE"], restoreEnvironment())
      if (restored.code !== 0) {
        report = blockedReport("RESTORE_FAILED", restored, manifest)
      } else {
        const counts = await readTableCounts()
        const fileCheck = await verifyRestoredFiles(manifest)
        report = {
          format: "wurenji-backup-drill",
          formatVersion: 1,
          status: fileCheck.findings.length === 0 ? "PASSED" : "FAILED",
          runId,
          startedAt: new Date(startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          rpoSeconds: 0,
          rtoSeconds: Math.round((Date.now() - startedAt) / 1000),
          source: { recoveryPoint: sourcePath, manifest: manifest.format, fileAssets: manifest.fileAssets.length },
          isolatedTarget: { database: databaseName, bucket: bucketName },
          tableCounts: counts,
          fileCheck,
          output: "临时数据库和对象存储桶将在报告写入后清理"
        }
      }
    }
  }
} catch (error) {
  report = {
    format: "wurenji-backup-drill",
    formatVersion: 1,
    status: isEnvironmentBlocked(error) ? "BLOCKED" : "FAILED",
    runId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    reason: error instanceof Error ? error.message : String(error)
  }
} finally {
  report ??= { format: "wurenji-backup-drill", formatVersion: 1, status: "FAILED", runId, reason: "未生成演练结果" }
  report.completedAt ??= new Date().toISOString()
  report.environment = { ...report.environment, targetLabel }
  report.cleanup = await cleanup()
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\nReport ${reportPath}\n`)
if (report.status !== "PASSED") process.exitCode = 1

function sourceEnvironment() {
  return {
    ...process.env,
    DATABASE_URL: sourceDatabaseUrl,
    PG_TOOLS_MODE: process.env.PG_TOOLS_MODE ?? "docker",
    V3_FILE_STORAGE_PROVIDER: process.env.V3_FILE_STORAGE_PROVIDER ?? "MINIO"
  }
}

function restoreEnvironment() {
  return {
    ...sourceEnvironment(),
    DATABASE_URL: replaceDatabase(sourceDatabaseUrl, databaseName),
    MINIO_BUCKET: bucketName,
    V3_FILE_STORAGE_DIR: resolve(restoreRoot, "v3-files"),
    SIMULATION_DATA_DIR: resolve(restoreRoot, "simulation-runs"),
    RESULT_DATA_DIR: resolve(restoreRoot, "evaluation-results")
  }
}

async function runBackupCommand(command, args, environment) {
  try {
    const result = await execFile(process.execPath, ["scripts/backup.mjs", command, ...args], { cwd: process.cwd(), env: environment, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return { code: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    return { code: Number(error?.code ?? 1), stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? error) }
  }
}

async function createTemporaryDatabase() {
  assertTemporaryName(databaseName, "database")
  const client = new PgClient({ connectionString: replaceDatabase(sourceDatabaseUrl, "postgres") })
  await client.connect()
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName])
    if (exists.rowCount) throw new Error(`临时数据库已存在，拒绝覆盖：${databaseName}`)
    await client.query(`CREATE DATABASE "${databaseName}"`)
  } finally {
    await client.end()
  }
}

async function createTemporaryBucket() {
  assertTemporaryName(bucketName, "bucket")
  const client = createMinioClient()
  if (await client.bucketExists(bucketName)) throw new Error(`临时对象桶已存在，拒绝覆盖：${bucketName}`)
  await client.makeBucket(bucketName)
}

async function readTableCounts() {
  const client = new PgClient({ connectionString: replaceDatabase(sourceDatabaseUrl, databaseName) })
  await client.connect()
  try {
    const names = ["file_assets", "resource_packages", "student_projects", "teaching_assignments", "project_activity_events", "runtime_sessions"]
    const counts = {}
    for (const name of names) {
      const result = await client.query(`SELECT count(*)::integer AS count FROM "${name}"`)
      counts[name] = Number(result.rows[0]?.count ?? 0)
    }
    return counts
  } finally {
    await client.end()
  }
}

async function verifyRestoredFiles(manifest) {
  const assets = manifest.fileAssets.filter((asset) => asset.status !== "DELETED")
  const artifacts = new Map(manifest.artifacts.filter((artifact) => artifact.kind === "V3_FILE" || artifact.kind === "V3_FILE_LOCAL").map((artifact) => [`${artifact.storageProvider}:${artifact.objectKey}`, artifact]))
  const client = createMinioClient()
  const findings = []
  for (const asset of assets) {
    const artifact = artifacts.get(`${asset.storageProvider}:${asset.objectKey}`)
    if (!artifact) {
      findings.push({ type: "MISSING_ARTIFACT", objectKey: asset.objectKey })
      continue
    }
    try {
      const content = asset.storageProvider === "LOCAL"
        ? await readFile(resolve(restoreRoot, "v3-files", asset.objectKey))
        : await readMinioObject(client, bucketName, asset.objectKey)
      if (content.byteLength !== asset.sizeBytes || sha256(content) !== asset.sha256) findings.push({ type: "CONTENT_MISMATCH", objectKey: asset.objectKey })
    } catch (error) {
      findings.push({ type: "MISSING_RESTORED_FILE", objectKey: asset.objectKey, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { expected: assets.length, checked: assets.length - findings.length, findings }
}

async function cleanup() {
  const result = { database: "SKIPPED", bucket: "SKIPPED", files: "SKIPPED" }
  if (temporaryDatabaseCreated) {
    assertTemporaryName(databaseName, "database")
    const client = new PgClient({ connectionString: replaceDatabase(sourceDatabaseUrl, "postgres") })
    await client.connect()
    try {
      await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      result.database = "DROPPED"
    } finally {
      await client.end()
    }
  }
  if (temporaryBucketCreated) {
    assertTemporaryName(bucketName, "bucket")
    const client = createMinioClient()
    for await (const object of client.listObjects(bucketName, "", true)) if (object.name) await client.removeObject(bucketName, object.name)
    await client.removeBucket(bucketName)
    result.bucket = "REMOVED"
  }
  await rm(restoreRoot, { recursive: true, force: true })
  result.files = "REMOVED"
  return result
}

function blockedReport(reason, commandResult, manifest) {
  return {
    format: "wurenji-backup-drill",
    formatVersion: 1,
    status: "BLOCKED",
    runId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date().toISOString(),
    reason,
    source: manifest ? { recoveryPoint: sourcePath, fileAssets: manifest.fileAssets.length } : undefined,
    command: { code: commandResult.code, stdout: commandResult.stdout.slice(-4000), stderr: commandResult.stderr.slice(-4000) }
  }
}

function isEnvironmentBlocked(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|failed to connect|connection refused|docker daemon|docker desktop|cannot connect to the docker|spawn docker ENOENT|超时|timeout/i.test(message)
}

function createMinioClient() {
  return new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT?.trim() || "localhost",
    port: Number(process.env.MINIO_PORT ?? 59000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY?.trim() || "wurenji",
    secretKey: process.env.MINIO_SECRET_KEY?.trim() || ""
  })
}

async function readMinioObject(client, bucket, objectKey) {
  const stream = await client.getObject(bucket, objectKey)
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function replaceDatabase(value, database) {
  const url = new URL(value)
  url.pathname = `/${database}`
  return url.toString()
}

function assertTemporaryName(value, kind) {
  const prefix = kind === "database" ? "wurenji_restore_drill_" : "wurenji-restore-drill-"
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`拒绝操作非演练${kind}：${value}`)
}

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

function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").toLowerCase() }
function sha256(content) { return createHash("sha256").update(content).digest("hex") }
