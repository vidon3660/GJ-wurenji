import { createHash } from "node:crypto"
import { execFile as execFileCallback, spawn } from "node:child_process"
import { createReadStream, createWriteStream } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { finished } from "node:stream/promises"
import { promisify } from "node:util"
import { dirname, relative, resolve, sep } from "node:path"
import { Client as MinioClient } from "minio"
import pg from "pg"

const execFile = promisify(execFileCallback)
const { Client: PgClient } = pg
const command = process.argv[2] ?? "help"
const argumentsByName = parseArguments(process.argv.slice(3))
const backupPath = resolve(argumentsByName.output ?? argumentsByName.input ?? `data/backups/${timestamp()}`)

if (command === "create") await createBackup()
else if (command === "verify") await verifyBackup(backupPath)
else if (command === "restore") await restoreBackup(backupPath)
else if (command === "audit") await auditBackupSource()
else printUsage()

async function createBackup() {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
  await mkdir(backupPath, { recursive: true })
  const databaseDumpPath = resolve(backupPath, "database.dump")
  await dumpDatabase(databaseUrl, databaseDumpPath)

  const fileAssets = await readFileAssetReferences(databaseUrl)
  const artifacts = []
  artifacts.push(...await copyLocalTree("v3-files", process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files", backupPath))
  artifacts.push(...await copyLocalTree("simulation-runs", process.env.SIMULATION_DATA_DIR ?? "data/simulation-runs", backupPath))
  artifacts.push(...await copyLocalTree("evaluation-results", process.env.RESULT_DATA_DIR ?? "data/evaluation-results", backupPath))
  artifacts.push(...await copyObjectStorage(backupPath))

  const manifest = {
    format: "wurenji-recovery-point",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    applicationVersion: process.env.PLATFORM_VERSION ?? "unknown",
    database: {
      dumpFile: "database.dump",
      format: "custom",
      sha256: await hashFile(databaseDumpPath),
      tableCounts: await readTableCounts(databaseUrl)
    },
    storage: {
      provider: normalizeStorageProvider(process.env.V3_FILE_STORAGE_PROVIDER),
      bucket: process.env.MINIO_BUCKET?.trim() || "wurenji",
      localRoots: {
        v3Files: process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files",
        simulationRuns: process.env.SIMULATION_DATA_DIR ?? "data/simulation-runs",
        evaluationResults: process.env.RESULT_DATA_DIR ?? "data/evaluation-results"
      }
    },
    fileAssets,
    artifacts
  }
  await writeJson(resolve(backupPath, "manifest.json"), manifest)
  await verifyBackup(backupPath)
  process.stdout.write(`Backup created: ${backupPath}\n`)
}

async function verifyBackup(inputPath) {
  const manifest = JSON.parse(await readFile(resolve(inputPath, "manifest.json"), "utf8"))
  validateManifest(manifest)
  if (await hashFile(safePath(inputPath, manifest.database.dumpFile)) !== manifest.database.sha256) throw new Error("database.dump SHA-256 校验失败")
  for (const artifact of manifest.artifacts) {
    const artifactPath = safePath(inputPath, artifact.archivePath)
    const details = await stat(artifactPath)
    if (!details.isFile() || details.size !== artifact.sizeBytes) throw new Error(`备份文件大小不匹配：${artifact.archivePath}`)
    if (await hashFile(artifactPath) !== artifact.sha256) throw new Error(`备份文件 SHA-256 校验失败：${artifact.archivePath}`)
  }
  const artifactKeys = new Set(manifest.artifacts.filter((artifact) => artifact.kind === "V3_FILE").map((artifact) => `${artifact.storageProvider}:${artifact.objectKey}`))
  const localArtifactKeys = new Set(manifest.artifacts.filter((artifact) => artifact.kind === "V3_FILE_LOCAL").map((artifact) => `LOCAL:${artifact.objectKey}`))
  const missingReferences = manifest.fileAssets.filter((asset) => asset.status !== "DELETED" && !artifactKeys.has(`${asset.storageProvider}:${asset.objectKey}`) && !localArtifactKeys.has(`LOCAL:${asset.objectKey}`))
  if (missingReferences.length > 0) throw new Error(`备份缺少 ${missingReferences.length} 个文件资产引用`)
  process.stdout.write(`Backup verified: ${inputPath} (${manifest.artifacts.length} artifacts)\n`)
}

async function restoreBackup(inputPath) {
  await verifyBackup(inputPath)
  if (argumentsByName.confirm !== "RESTORE") throw new Error("恢复操作需要参数 --confirm RESTORE")
  const manifest = JSON.parse(await readFile(resolve(inputPath, "manifest.json"), "utf8"))
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
  const restoreMode = normalizeRestoreMode(argumentsByName.mode)
  if (restoreMode === "EXACT" && argumentsByName["confirm-exact"] !== "REPLACE_DATABASE_AND_FILES") {
    throw new Error("严格恢复会重建数据库并清空目标文件，需要参数 --confirm-exact REPLACE_DATABASE_AND_FILES")
  }
  if (restoreMode === "EXACT") {
    await recreateDatabase(databaseUrl)
    await clearLocalStorageRoots()
    await clearObjectStorage(manifest)
  }
  await restoreDatabase(databaseUrl, safePath(inputPath, manifest.database.dumpFile), restoreMode === "EXACT")
  await restoreLocalArtifacts(inputPath, manifest)
  await restoreObjectStorage(inputPath, manifest)
  await verifyLiveFileAssetReferences(databaseUrl, manifest)
  await verifyLiveTableCounts(databaseUrl, manifest)
  if (restoreMode === "EXACT") await verifyExactRestoredArtifacts(inputPath, manifest)
  process.stdout.write(`Backup restored: ${inputPath} (${restoreMode})\n`)
}

async function auditBackupSource() {
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
  const assets = await readFileAssetReferences(databaseUrl)
  const referenceTables = await readAssetReferenceTables(databaseUrl, assets.map((asset) => asset.id))
  const minioAssets = assets.filter((asset) => asset.status !== "DELETED" && asset.storageProvider !== "LOCAL")
  const minio = minioAssets.length > 0 ? createMinioClient() : null
  const bucket = process.env.MINIO_BUCKET?.trim() || "wurenji"
  if (minio && !await minio.bucketExists(bucket)) throw new Error(`对象存储桶不存在：${bucket}`)
  const findings = []
  for (const asset of assets) {
    if (asset.status === "DELETED") continue
    try {
      const content = asset.storageProvider === "LOCAL"
        ? await readFile(resolve(process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files", asset.objectKey))
        : await readMinioObject(minio, bucket, asset.objectKey)
      const actualSha256 = sha256(content)
      if (content.byteLength !== asset.sizeBytes || actualSha256 !== asset.sha256) {
        findings.push({ type: "CONTENT_MISMATCH", assetId: asset.id, category: asset.category, objectKeyPrefix: asset.objectKey.split("/")[0] ?? "UNKNOWN", referencedBy: referenceTables.get(asset.id) ?? [], storageProvider: asset.storageProvider, objectKey: asset.objectKey, expectedSizeBytes: asset.sizeBytes, actualSizeBytes: content.byteLength, expectedSha256: asset.sha256, actualSha256 })
      }
    } catch (error) {
      findings.push({ type: "MISSING_OBJECT", assetId: asset.id, category: asset.category, objectKeyPrefix: asset.objectKey.split("/")[0] ?? "UNKNOWN", referencedBy: referenceTables.get(asset.id) ?? [], storageProvider: asset.storageProvider, objectKey: asset.objectKey, message: error instanceof Error ? error.message : String(error) })
    }
  }
  const report = {
    format: "wurenji-backup-source-audit",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    database: databaseUrl.replace(/:\/\/[^/@]+:[^/@]+@/, "://***:***@"),
    assets: { total: assets.length, checked: assets.filter((asset) => asset.status !== "DELETED").length, deleted: assets.filter((asset) => asset.status === "DELETED").length, findings: findings.length },
    summary: summarizeAuditFindings(findings),
    references: summarizeAssetReferences(referenceTables, findings.map((finding) => finding.assetId)),
    findings
  }
  const outputPath = argumentsByName.output ? resolve(argumentsByName.output) : null
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeJson(outputPath, report)
  }
  process.stdout.write(`${JSON.stringify(outputPath ? { ...report, findings: undefined } : report, null, 2)}\n`)
  if (findings.length > 0) throw new Error(`备份源数据存在 ${findings.length} 个文件资产问题，请先修复 audit 报告中的对象`)
}

async function readAssetReferenceTables(databaseUrl, assetIds) {
  const references = new Map(assetIds.map((assetId) => [assetId, []]))
  if (assetIds.length === 0) return references
  const client = new PgClient({ connectionString: databaseUrl })
  await client.connect()
  try {
    const referenceSources = [
      ["resource_packages", "archiveAssetId"],
      ["show_area_plan_versions", "planningMapAssetId"],
      ["show_project_document_versions", "assetId"],
      ["show_project_documents", "currentAssetId"],
      ["show_project_reports", "assetId"]
    ]
    for (const [table, column] of referenceSources) {
      const result = await client.query(`SELECT "${column}" AS "assetId", count(*)::int AS count FROM "${table}" WHERE "${column}" = ANY($1::uuid[]) GROUP BY "${column}"`, [assetIds])
      for (const row of result.rows) references.get(String(row.assetId))?.push({ table, count: Number(row.count) })
    }
    return references
  } finally {
    await client.end()
  }
}

function summarizeAssetReferences(referenceTables, assetIds) {
  const summary = {}
  for (const assetId of assetIds) {
    const entries = referenceTables.get(assetId) ?? []
    for (const entry of entries) summary[entry.table] = (summary[entry.table] ?? 0) + entry.count
  }
  return summary
}

function summarizeAuditFindings(findings) {
  const by = (key) => Object.fromEntries(
    [...findings.reduce((counts, finding) => {
      const value = finding[key] ?? "UNKNOWN"
      counts.set(value, (counts.get(value) ?? 0) + 1)
      return counts
    }, new Map())].sort((left, right) => right[1] - left[1])
  )
  return {
    byStorageProvider: by("storageProvider"),
    byObjectCategory: by("category"),
    byObjectPrefix: by("objectKeyPrefix")
  }
}

async function dumpDatabase(databaseUrl, outputPath) {
  const connection = parseDatabaseUrl(databaseUrl)
  const nativeArguments = [...connection.arguments, "--format=custom", "--no-owner", "--no-acl", "--file", outputPath]
  await runPostgresTool(
    process.env.PG_DUMP_COMMAND ?? "pg_dump",
    nativeArguments,
    connection,
    "pg_dump",
    ["--format=custom", "--no-owner", "--no-acl"],
    { outputPath }
  )
}

async function restoreDatabase(databaseUrl, dumpPath, emptyDatabase = false) {
  const connection = parseDatabaseUrl(databaseUrl)
  const restoreArguments = emptyDatabase ? ["--no-owner", "--no-acl"] : ["--clean", "--if-exists", "--no-owner", "--no-acl"]
  const nativeArguments = [...connection.arguments, ...restoreArguments, dumpPath]
  await runPostgresTool(
    process.env.PG_RESTORE_COMMAND ?? "pg_restore",
    nativeArguments,
    connection,
    "pg_restore",
    restoreArguments,
    { inputPath: dumpPath }
  )
}

async function recreateDatabase(databaseUrl) {
  const target = new URL(databaseUrl)
  const database = decodeURIComponent(target.pathname.replace(/^\//, ""))
  const owner = decodeURIComponent(target.username)
  if (!database || ["postgres", "template0", "template1"].includes(database)) throw new Error(`拒绝重建系统数据库：${database || "<empty>"}`)
  if (!owner) throw new Error("DATABASE_URL 缺少数据库用户名")
  const maintenance = new URL(target)
  maintenance.pathname = "/postgres"
  const client = new PgClient({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", [database])
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`)
    await client.query(`CREATE DATABASE ${quoteIdentifier(database)} OWNER ${quoteIdentifier(owner)}`)
  } finally {
    await client.end()
  }
}

async function runPostgresTool(commandName, argumentsList, connection, dockerTool, dockerArguments, streams) {
  const mode = normalizePgToolsMode(process.env.PG_TOOLS_MODE)
  let nativeError
  if (mode !== "docker") {
    try {
      await runPostgresCommand(commandName, argumentsList, connection.environment)
      return
    } catch (error) {
      if (mode === "native") throw error
      nativeError = error
    }
  }

  try {
    await runDockerPostgresCommand(connection, dockerTool, dockerArguments, streams)
  } catch (dockerError) {
    const nativeDetails = nativeError instanceof Error ? nativeError.message : "未尝试本机 PostgreSQL 工具"
    const dockerDetails = dockerError instanceof Error ? dockerError.message : String(dockerError)
    throw new Error(`PostgreSQL 工具执行失败。本机：${nativeDetails}；Docker：${dockerDetails}`)
  }
}

async function runPostgresCommand(commandName, argumentsList, environment) {
  try {
    await execFile(commandName, argumentsList, { env: { ...process.env, ...environment }, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(`${commandName} 执行失败：${details}`, { cause: error })
  }
}

async function runDockerPostgresCommand(connection, tool, toolArguments, { inputPath, outputPath }) {
  const dockerCommand = process.env.DOCKER_COMMAND?.trim() || "docker"
  const service = process.env.POSTGRES_DOCKER_SERVICE?.trim() || "db"
  const argumentsList = [
    "compose", "exec", "-T",
    ...(connection.password ? ["-e", `PGPASSWORD=${connection.password}`] : []),
    service,
    tool,
    "--username", connection.username,
    "--dbname", connection.database,
    ...toolArguments
  ]
  const child = spawn(dockerCommand, argumentsList, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    stdio: [inputPath ? "pipe" : "ignore", outputPath ? "pipe" : "ignore", "pipe"]
  })
  const errors = []
  child.stderr.on("data", (chunk) => {
    if (errors.reduce((total, item) => total + item.length, 0) < 4 * 1024 * 1024) errors.push(Buffer.from(chunk))
  })
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once("error", rejectCompletion)
    child.once("close", (code) => {
      if (code === 0) resolveCompletion()
      else rejectCompletion(new Error(`${dockerCommand} ${argumentsList.slice(0, 6).join(" ")} 退出码 ${code}：${Buffer.concat(errors).toString("utf8").trim()}`))
    })
  })

  const streamTasks = []
  if (inputPath) {
    const input = createReadStream(inputPath)
    input.pipe(child.stdin)
    streamTasks.push(finished(input))
  }
  if (outputPath) {
    const output = createWriteStream(outputPath)
    child.stdout.pipe(output)
    streamTasks.push(finished(output))
  }
  await Promise.all([completion, ...streamTasks])
}

async function readFileAssetReferences(databaseUrl) {
  const client = new PgClient({ connectionString: databaseUrl })
  await client.connect()
  try {
    const result = await client.query(`SELECT id, category, "storageProvider", "objectKey", "sizeBytes", sha256, status, "ownerType", "ownerId" FROM file_assets`)
    return result.rows.map((row) => ({
      id: String(row.id), storageProvider: String(row.storageProvider), objectKey: String(row.objectKey),
      sizeBytes: Number(row.sizeBytes), sha256: String(row.sha256), status: String(row.status),
      ownerType: String(row.ownerType), ownerId: String(row.ownerId), category: String(row.category ?? "UNKNOWN")
    }))
  } finally {
    await client.end()
  }
}

async function readTableCounts(databaseUrl) {
  const client = new PgClient({ connectionString: databaseUrl })
  await client.connect()
  try {
    const names = ["users", "teaching_assignments", "student_projects", "resource_packages", "file_assets", "project_activity_events", "runtime_sessions"]
    const counts = {}
    for (const name of names) {
      const exists = await client.query("SELECT to_regclass($1) AS name", [`public.${name}`])
      if (!exists.rows[0]?.name) continue
      const result = await client.query(`SELECT count(*)::integer AS count FROM ${quoteIdentifier(name)}`)
      counts[name] = Number(result.rows[0]?.count ?? 0)
    }
    return counts
  } finally {
    await client.end()
  }
}

async function copyLocalTree(kind, source, rootPath) {
  const sourcePath = resolve(source)
  if (!await exists(sourcePath)) return []
  const result = []
  for (const file of await walkFiles(sourcePath)) {
    const relativePath = relative(sourcePath, file).split(sep).join("/")
    const archivePath = `files/${kind}/${relativePath}`
    const destination = safePath(rootPath, archivePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, await readFile(file))
    result.push({
      kind: kind === "v3-files" ? "V3_FILE_LOCAL" : "RUNTIME_FILE", storageProvider: "LOCAL",
      objectKey: kind === "v3-files" ? relativePath : `${kind}/${relativePath}`, archivePath,
      rootKind: kind, sizeBytes: (await stat(file)).size, sha256: await hashFile(file)
    })
  }
  return result
}

async function copyObjectStorage(rootPath) {
  const provider = normalizeStorageProvider(process.env.V3_FILE_STORAGE_PROVIDER)
  if (provider === "LOCAL") return []
  const client = createMinioClient()
  const bucket = process.env.MINIO_BUCKET?.trim() || "wurenji"
  if (!await client.bucketExists(bucket)) throw new Error(`对象存储桶不存在：${bucket}`)
  const result = []
  for await (const object of client.listObjects(bucket, "", true)) {
    if (!object.name) continue
    const content = await readMinioObject(client, bucket, object.name)
    const archivePath = `objects/${object.name}`
    const destination = safePath(rootPath, archivePath)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
    result.push({ kind: "V3_FILE", storageProvider: provider, objectKey: object.name, archivePath, sizeBytes: content.byteLength, sha256: sha256(content) })
  }
  return result
}

async function restoreLocalArtifacts(rootPath, manifest) {
  for (const artifact of manifest.artifacts.filter((item) => item.kind === "V3_FILE_LOCAL" || item.kind === "RUNTIME_FILE")) {
    const content = await readFile(safePath(rootPath, artifact.archivePath))
    const destinationRoot = artifact.kind === "V3_FILE_LOCAL"
      ? process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files"
      : artifact.rootKind === "simulation-runs" ? process.env.SIMULATION_DATA_DIR ?? "data/simulation-runs" : process.env.RESULT_DATA_DIR ?? "data/evaluation-results"
    const destinationKey = artifact.kind === "V3_FILE_LOCAL" ? artifact.objectKey : artifact.objectKey.split("/").slice(1).join("/")
    const destination = safePath(destinationRoot, destinationKey)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content)
  }
}

async function restoreObjectStorage(rootPath, manifest) {
  const artifacts = manifest.artifacts.filter((item) => item.kind === "V3_FILE" && item.storageProvider !== "LOCAL")
  if (artifacts.length === 0) return
  const client = createMinioClient()
  const bucket = process.env.MINIO_BUCKET?.trim() || manifest.storage.bucket
  if (!await client.bucketExists(bucket)) await client.makeBucket(bucket)
  for (const artifact of artifacts) {
    const content = await readFile(safePath(rootPath, artifact.archivePath))
    await client.putObject(bucket, artifact.objectKey, content, content.byteLength)
  }
}

async function clearLocalStorageRoots() {
  const roots = [
    process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files",
    process.env.SIMULATION_DATA_DIR ?? "data/simulation-runs",
    process.env.RESULT_DATA_DIR ?? "data/evaluation-results"
  ]
  for (const root of new Set(roots.map((value) => resolve(value)))) {
    assertReplaceableDirectory(root)
    await mkdir(root, { recursive: true })
    for (const entry of await readdir(root)) await rm(safePath(root, entry), { recursive: true, force: true })
  }
}

async function clearObjectStorage(manifest) {
  const artifacts = manifest.artifacts.filter((item) => item.kind === "V3_FILE" && item.storageProvider !== "LOCAL")
  if (artifacts.length === 0 && normalizeStorageProvider(process.env.V3_FILE_STORAGE_PROVIDER) === "LOCAL") return
  const client = createMinioClient()
  const bucket = process.env.MINIO_BUCKET?.trim() || manifest.storage.bucket
  if (!await client.bucketExists(bucket)) {
    await client.makeBucket(bucket)
    return
  }
  for await (const object of client.listObjects(bucket, "", true)) if (object.name) await client.removeObject(bucket, object.name)
}

async function verifyLiveFileAssetReferences(databaseUrl, manifest) {
  const references = await readFileAssetReferences(databaseUrl)
  const artifacts = new Map(manifest.artifacts.filter((item) => item.kind === "V3_FILE" || item.kind === "V3_FILE_LOCAL").map((item) => [`${item.storageProvider}:${item.objectKey}`, item]))
  const missing = references.filter((asset) => asset.status !== "DELETED" && !artifacts.has(`${asset.storageProvider}:${asset.objectKey}`))
  if (missing.length > 0) throw new Error(`恢复后数据库仍有 ${missing.length} 个文件资产找不到备份对象`)
}

async function verifyLiveTableCounts(databaseUrl, manifest) {
  if (!manifest.database.tableCounts) return
  const actual = await readTableCounts(databaseUrl)
  for (const [name, expected] of Object.entries(manifest.database.tableCounts)) {
    if (actual[name] !== expected) throw new Error(`恢复后关键表计数不一致：${name} 期望 ${expected}，实际 ${actual[name] ?? "缺失"}`)
  }
}

async function verifyExactRestoredArtifacts(rootPath, manifest) {
  const expectedObjectKeys = new Set()
  for (const artifact of manifest.artifacts) {
    if (artifact.kind === "V3_FILE" && artifact.storageProvider !== "LOCAL") {
      expectedObjectKeys.add(artifact.objectKey)
      continue
    }
    if (artifact.kind !== "V3_FILE_LOCAL" && artifact.kind !== "RUNTIME_FILE") continue
    const destinationRoot = artifact.kind === "V3_FILE_LOCAL"
      ? process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files"
      : artifact.rootKind === "simulation-runs" ? process.env.SIMULATION_DATA_DIR ?? "data/simulation-runs" : process.env.RESULT_DATA_DIR ?? "data/evaluation-results"
    const destinationKey = artifact.kind === "V3_FILE_LOCAL" ? artifact.objectKey : artifact.objectKey.split("/").slice(1).join("/")
    const destination = safePath(destinationRoot, destinationKey)
    const details = await stat(destination)
    if (!details.isFile() || details.size !== artifact.sizeBytes || await hashFile(destination) !== artifact.sha256) {
      throw new Error(`严格恢复文件校验失败：${artifact.archivePath}`)
    }
  }
  if (expectedObjectKeys.size === 0) return
  const client = createMinioClient()
  const bucket = process.env.MINIO_BUCKET?.trim() || manifest.storage.bucket
  const actualObjectKeys = new Set()
  for await (const object of client.listObjects(bucket, "", true)) if (object.name) actualObjectKeys.add(object.name)
  if (actualObjectKeys.size !== expectedObjectKeys.size || [...actualObjectKeys].some((key) => !expectedObjectKeys.has(key))) {
    throw new Error(`严格恢复对象集合不一致：期望 ${expectedObjectKeys.size}，实际 ${actualObjectKeys.size}`)
  }
  for (const artifact of manifest.artifacts.filter((item) => item.kind === "V3_FILE" && item.storageProvider !== "LOCAL")) {
    const content = await readMinioObject(client, bucket, artifact.objectKey)
    if (content.byteLength !== artifact.sizeBytes || sha256(content) !== artifact.sha256) throw new Error(`严格恢复对象校验失败：${artifact.objectKey}`)
  }
}

function createMinioClient() {
  return new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT?.trim() || "localhost", port: Number(process.env.MINIO_PORT ?? 59000),
    useSSL: process.env.MINIO_USE_SSL === "true", accessKey: process.env.MINIO_ACCESS_KEY?.trim() || "wurenji",
    secretKey: process.env.MINIO_SECRET_KEY?.trim() || ""
  })
}

async function readMinioObject(client, bucket, objectKey) {
  const stream = await client.getObject(bucket, objectKey)
  const chunks = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function walkFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) result.push(...await walkFiles(path))
    else if (entry.isFile()) result.push(path)
  }
  return result
}

function validateManifest(manifest) {
  if (manifest?.format !== "wurenji-recovery-point" || manifest.formatVersion !== 1) throw new Error("不支持的备份清单格式")
  if (!manifest.database?.dumpFile || !/^[^/\\]+$/.test(manifest.database.dumpFile)) throw new Error("备份数据库文件路径无效")
  if (!Array.isArray(manifest.artifacts) || !Array.isArray(manifest.fileAssets)) throw new Error("备份清单缺少 artifacts 或 fileAssets")
  if (manifest.database.tableCounts !== undefined && (typeof manifest.database.tableCounts !== "object" || Array.isArray(manifest.database.tableCounts))) throw new Error("备份关键表计数格式无效")
  for (const artifact of manifest.artifacts) {
    if (!artifact.archivePath || !artifact.objectKey || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isInteger(artifact.sizeBytes)) throw new Error("备份 artifact 清单无效")
  }
}

function assertReplaceableDirectory(value) {
  const target = resolve(value)
  const filesystemRoot = resolve(target, sep)
  if (target === filesystemRoot || target === resolve(".")) throw new Error(`拒绝清空高风险目录：${target}`)
}

function quoteIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"` }

function safePath(rootPath, childPath) {
  const root = resolve(rootPath)
  const target = resolve(root, childPath)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`备份路径越界：${childPath}`)
  return target
}

async function hashFile(path) { return sha256(await readFile(path)) }
function sha256(content) { return createHash("sha256").update(content).digest("hex") }
async function writeJson(path, value) { await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8") }
async function exists(path) { try { await stat(path); return true } catch { return false } }

function parseDatabaseUrl(value) {
  const url = new URL(value)
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""))
  if (!database) throw new Error("DATABASE_URL 缺少数据库名")
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  return {
    arguments: ["--host", url.hostname, "--port", String(url.port || 5432), "--username", username, "--dbname", database],
    environment: password ? { PGPASSWORD: password } : {},
    username,
    password,
    database
  }
}

function normalizePgToolsMode(value) {
  const mode = value?.trim().toLowerCase() || "auto"
  if (!['auto', 'native', 'docker'].includes(mode)) throw new Error("PG_TOOLS_MODE 必须为 auto、native 或 docker")
  return mode
}

function normalizeStorageProvider(value) {
  const provider = value?.trim().toUpperCase() || "LOCAL"
  if (!["LOCAL", "MINIO", "S3"].includes(provider)) throw new Error(`不支持的文件存储提供方：${provider}`)
  return provider
}

function normalizeRestoreMode(value) {
  const mode = value?.trim().toUpperCase() || "MERGE"
  if (!["MERGE", "EXACT"].includes(mode)) throw new Error("恢复模式必须为 MERGE 或 EXACT")
  return mode
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

function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
function printUsage() {
  process.stdout.write([
    "用法：",
    "  npm run backup:create -- --output data/backups/<恢复点目录>",
    "  npm run backup:verify -- --input data/backups/<恢复点目录>",
    "  npm run backup:restore -- --input data/backups/<恢复点目录> --confirm RESTORE",
    "  npm run backup:restore -- --input data/backups/<恢复点目录> --mode EXACT --confirm RESTORE --confirm-exact REPLACE_DATABASE_AND_FILES",
    "  npm run backup:audit -- --output artifacts/backup-audit.json",
    "",
    "恢复前必须停止应用写入，并确认 DATABASE_URL、V3_FILE_STORAGE_*、MINIO_* 指向目标环境。"
  ].join("\n") + "\n")
}
