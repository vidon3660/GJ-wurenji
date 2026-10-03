import { stat, writeFile, mkdir } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { Client as MinioClient } from "minio"
import pg from "pg"

const { Client: PgClient } = pg
const command = process.argv[2] ?? "audit"
const argumentsByName = parseArguments(process.argv.slice(3))
if (!['audit', 'repair'].includes(command)) throw new Error("命令必须为 audit 或 repair")
if (command === "repair" && argumentsByName.confirm !== "REPAIR") throw new Error("执行清理必须提供 --confirm REPAIR")
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
const localRoot = resolve(process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files")
const outputPath = resolve(argumentsByName.output ?? `artifacts/file-repair/unreferenced-assets-${timestamp()}.json`)
const database = new PgClient({ connectionString: databaseUrl })
const minio = createMinioClient()
const bucket = process.env.MINIO_BUCKET?.trim() || "wurenji"
const results = []

await database.connect()
try {
  const assets = await readCandidates()
  for (const asset of assets) results.push(await inspectAsset(asset))
} finally {
  await database.end()
}

const report = {
  format: "wurenji-unreferenced-file-cleanup",
  formatVersion: 1,
  command,
  generatedAt: new Date().toISOString(),
  summary: {
    candidates: results.length,
    missing: results.filter((item) => item.storageStatus === "MISSING").length,
    present: results.filter((item) => item.storageStatus === "PRESENT").length,
    repaired: results.filter((item) => item.action === "MARKED_DELETED").length,
    errors: results.filter((item) => item.action === "ERROR").length
  },
  results
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
if (report.summary.errors > 0) process.exitCode = 1

async function readCandidates() {
  const result = await database.query(`
    SELECT fa.id AS "assetId", fa.category, fa."storageProvider", fa."objectKey", fa."sizeBytes", fa.sha256,
           fa.status, fa."ownerType", fa."ownerId", fa."createdAt",
           EXISTS (SELECT 1 FROM student_projects p WHERE p.id = fa."ownerId") AS "ownerProjectExists"
    FROM file_assets fa
    WHERE fa.status <> 'DELETED'
      AND NOT EXISTS (SELECT 1 FROM resource_packages rp WHERE rp."archiveAssetId" = fa.id)
      AND NOT EXISTS (SELECT 1 FROM show_area_plan_versions apv WHERE apv."planningMapAssetId" = fa.id)
      AND NOT EXISTS (SELECT 1 FROM show_project_document_versions dv WHERE dv."assetId" = fa.id)
      AND NOT EXISTS (SELECT 1 FROM show_project_documents d WHERE d."currentAssetId" = fa.id)
      AND NOT EXISTS (SELECT 1 FROM show_project_reports r WHERE r."assetId" = fa.id)
    ORDER BY fa."createdAt", fa.id
  `)
  return result.rows
}

async function inspectAsset(asset) {
  const base = {
    assetId: asset.assetId,
    category: asset.category,
    storageProvider: asset.storageProvider,
    objectKey: asset.objectKey,
    status: asset.status,
    ownerType: asset.ownerType,
    ownerId: asset.ownerId,
    ownerProjectExists: asset.ownerProjectExists,
    createdAt: asset.createdAt
  }
  try {
    const storageStatus = await objectStatus(asset)
    if (storageStatus === "PRESENT") return { ...base, storageStatus, action: "NO_CHANGE" }
    if (command === "audit") return { ...base, storageStatus, action: "READY_TO_MARK_DELETED" }
    const updated = await database.query(`
      UPDATE file_assets fa SET status = 'DELETED'
      WHERE fa.id = $1 AND fa.status <> 'DELETED'
        AND fa."ownerType" = 'PROJECT'
        AND NOT EXISTS (SELECT 1 FROM student_projects p WHERE p.id = fa."ownerId")
        AND NOT EXISTS (SELECT 1 FROM resource_packages rp WHERE rp."archiveAssetId" = fa.id)
        AND NOT EXISTS (SELECT 1 FROM show_area_plan_versions apv WHERE apv."planningMapAssetId" = fa.id)
        AND NOT EXISTS (SELECT 1 FROM show_project_document_versions dv WHERE dv."assetId" = fa.id)
        AND NOT EXISTS (SELECT 1 FROM show_project_documents d WHERE d."currentAssetId" = fa.id)
        AND NOT EXISTS (SELECT 1 FROM show_project_reports r WHERE r."assetId" = fa.id)
    `, [asset.assetId])
    if (updated.rowCount !== 1) throw new Error(`资产引用或状态已变化：${asset.assetId}`)
    return { ...base, storageStatus, action: "MARKED_DELETED" }
  } catch (error) {
    return { ...base, storageStatus: "UNKNOWN", action: "ERROR", message: error instanceof Error ? error.message : String(error) }
  }
}

async function objectStatus(asset) {
  if (asset.storageProvider === "LOCAL") {
    try {
      const details = await stat(resolveObjectKey(localRoot, asset.objectKey))
      return details.isFile() ? "PRESENT" : "MISSING"
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "MISSING"
      throw error
    }
  }
  try {
    await minio.statObject(bucket, asset.objectKey)
    return "PRESENT"
  } catch (error) {
    if (isMissingObject(error)) return "MISSING"
    throw error
  }
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

function resolveObjectKey(root, objectKey) {
  if (!objectKey || objectKey.includes("\0") || objectKey.startsWith("/") || objectKey.split("/").includes("..")) throw new Error(`对象键无效：${objectKey}`)
  const target = resolve(root, objectKey.replaceAll("/", sep))
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`对象键越界：${objectKey}`)
  return target
}

function isMissingObject(error) {
  return error instanceof Error && "code" in error && ["NoSuchKey", "NoSuchObject", "NotFound", "NoSuchBucket"].includes(String(error.code))
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
