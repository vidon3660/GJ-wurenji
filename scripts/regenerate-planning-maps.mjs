import { createHash } from "node:crypto"
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { Client as MinioClient } from "minio"
import pg from "pg"
import { PlanningMapRenderer } from "../apps/server/dist/v3/show-project/planning-map.renderer.js"
import { parseRegionCatalogItem } from "../apps/server/dist/v3/resources/region-catalog.js"

const { Client: PgClient } = pg
const command = process.argv[2] ?? "audit"
const argumentsByName = parseArguments(process.argv.slice(3))
if (!['audit', 'repair'].includes(command)) throw new Error("命令必须为 audit 或 repair")
if (command === "repair" && argumentsByName.confirm !== "REPAIR") throw new Error("执行修复必须提供 --confirm REPAIR")
const acceptChangedHash = argumentsByName["accept-regenerated-hash"] === "YES"
const outputPath = resolve(argumentsByName.output ?? `artifacts/file-repair/planning-maps-${timestamp()}.json`)
const databaseUrl = process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji"
const localRoot = resolve(process.env.V3_FILE_STORAGE_DIR ?? "data/v3-files")
const targetProvider = normalizeTargetProvider(process.env.V3_FILE_STORAGE_PROVIDER)
const renderer = new PlanningMapRenderer()
const database = new PgClient({ connectionString: databaseUrl })
const minio = targetProvider === "LOCAL" ? null : createMinioClient()
const bucket = process.env.MINIO_BUCKET?.trim() || "wurenji"
const startedAt = Date.now()
const results = []

await database.connect()
try {
  if (minio && !await minio.bucketExists(bucket)) {
    if (command === "audit") throw new Error(`目标对象存储桶不存在：${bucket}`)
    await minio.makeBucket(bucket)
  }
  const assets = await readRepairCandidates(database)
  for (const asset of assets) results.push(await inspectAsset(asset))
} finally {
  await database.end()
}

const report = {
  format: "wurenji-planning-map-repair",
  formatVersion: 1,
  command,
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  targetProvider,
  summary: {
    candidates: results.length,
    sourcePresent: results.filter((item) => item.sourceStatus === "PRESENT").length,
    exactMatches: results.filter((item) => item.hashStatus === "MATCH").length,
    changedHashes: results.filter((item) => item.hashStatus === "MISMATCH").length,
    repaired: results.filter((item) => item.action === "REPAIRED").length,
    blocked: results.filter((item) => item.action.startsWith("BLOCKED")).length,
    errors: results.filter((item) => item.action === "ERROR").length
  },
  results
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(report.summary)}\nReport ${outputPath}\n`)
if (report.summary.blocked > 0 || report.summary.errors > 0) process.exitCode = 1

async function inspectAsset(asset) {
  const base = {
    assetId: asset.assetId,
    projectId: asset.projectId,
    versionId: asset.versionId,
    versionNo: asset.versionNo,
    objectKey: asset.objectKey,
    expectedSizeBytes: asset.sizeBytes,
    expectedSha256: asset.sha256
  }
  try {
    const sourceStatus = await localFileStatus(asset.objectKey, asset.sizeBytes, asset.sha256)
    if (sourceStatus === "PRESENT") return { ...base, sourceStatus, hashStatus: "MATCH", action: "NO_CHANGE" }
    const region = await readRegion(asset.regionPackageId)
    const features = await readFeatures(asset.versionId)
    const content = await renderer.render({
      taskTitle: asset.taskTitle,
      studentName: asset.studentName,
      versionNo: asset.versionNo,
      submittedAt: new Date(asset.submittedAt),
      scaleTemplateCode: asset.scaleTemplateCode,
      region,
      features,
      annotations: Array.isArray(asset.annotations) ? asset.annotations : [],
      rendererVersion: "V1"
    })
    const regeneratedSha256 = sha256(content)
    const hashStatus = regeneratedSha256 === asset.sha256 && content.byteLength === asset.sizeBytes ? "MATCH" : "MISMATCH"
    if (command === "audit") return { ...base, sourceStatus, hashStatus, regeneratedSizeBytes: content.byteLength, regeneratedSha256, action: hashStatus === "MATCH" ? "READY" : "BLOCKED_HASH_MISMATCH" }
    if (hashStatus === "MISMATCH" && !acceptChangedHash) return { ...base, sourceStatus, hashStatus, regeneratedSizeBytes: content.byteLength, regeneratedSha256, action: "BLOCKED_HASH_MISMATCH" }
    await repairAsset(asset, content, regeneratedSha256)
    return { ...base, sourceStatus, hashStatus, regeneratedSizeBytes: content.byteLength, regeneratedSha256, action: "REPAIRED" }
  } catch (error) {
    return { ...base, sourceStatus: "UNKNOWN", hashStatus: "UNKNOWN", action: "ERROR", message: error instanceof Error ? error.message : String(error) }
  }
}

async function readRepairCandidates(client) {
  const result = await client.query(`
    SELECT fa.id AS "assetId", fa."objectKey", fa."sizeBytes", fa.sha256,
           v.id AS "versionId", v."versionNo", v.annotations, v."submittedAt",
           p.id AS "projectId", u."displayName" AS "studentName",
           s.title AS "taskTitle", s.config->>'scaleTemplateCode' AS "scaleTemplateCode",
           s.config->>'regionPackageId' AS "regionPackageId"
    FROM file_assets fa
    JOIN show_area_plan_versions v ON v."planningMapAssetId" = fa.id
    JOIN student_projects p ON p.id = v."projectId"
    JOIN users u ON u.id = p."studentId"
    JOIN assignment_snapshots s ON s.id = p."snapshotId"
    WHERE fa."storageProvider" = 'LOCAL' AND fa.category = 'PLANNING_MAP' AND fa.status <> 'DELETED'
    ORDER BY fa."createdAt", fa.id
  `)
  return result.rows
}

async function readRegion(packageId) {
  if (!packageId) throw new Error("任务快照缺少 regionPackageId")
  const result = await database.query(`
    SELECT id, "packageType", name, version, sha256, status, manifest
    FROM resource_packages WHERE id = $1
  `, [packageId])
  const item = result.rows[0]
  if (!item) throw new Error(`冻结区域资源不存在：${packageId}`)
  const region = parseRegionCatalogItem(item)
  if (!region) throw new Error(`冻结区域资源无法解析：${packageId}`)
  return region
}

async function readFeatures(versionId) {
  const result = await database.query(`
    SELECT "featureKey", type, label, ST_AsGeoJSON(geometry)::json AS geometry,
           "heightDatum", "minimumHeightMeters", "maximumHeightMeters", properties
    FROM show_area_features WHERE "versionId" = $1 ORDER BY type, "featureKey"
  `, [versionId])
  return result.rows.map((feature) => ({
    id: feature.featureKey,
    type: feature.type,
    label: feature.label,
    positions: positionsFromGeometry(feature.geometry),
    ...(feature.heightDatum && feature.minimumHeightMeters !== null && feature.maximumHeightMeters !== null
      ? { heightRange: { datum: feature.heightDatum, minimumMeters: Number(feature.minimumHeightMeters), maximumMeters: Number(feature.maximumHeightMeters) } }
      : {}),
    properties: feature.properties ?? {}
  }))
}

async function repairAsset(asset, content, contentSha256) {
  let targetCreated = false
  try {
    const target = await targetObjectStatus(asset.objectKey, content)
    if (target === "MISSING") {
      await writeTargetObject(asset.objectKey, content)
      targetCreated = true
    } else if (target !== "MATCH") {
      throw new Error(`目标对象已存在但内容不同：${asset.objectKey}`)
    }
    const updated = await database.query(`
      UPDATE file_assets
      SET "storageProvider" = $1, "sizeBytes" = $2, sha256 = $3
      WHERE id = $4 AND "storageProvider" = 'LOCAL' AND "objectKey" = $5
    `, [targetProvider, content.byteLength, contentSha256, asset.assetId, asset.objectKey])
    if (updated.rowCount !== 1) throw new Error(`文件资产状态已变化：${asset.assetId}`)
  } catch (error) {
    if (targetCreated) await deleteTargetObject(asset.objectKey).catch(() => undefined)
    throw error
  }
}

async function localFileStatus(objectKey, expectedSize, expectedSha256) {
  const path = resolveObjectKey(localRoot, objectKey)
  try {
    const details = await stat(path)
    if (!details.isFile()) return "MISSING"
    const content = await readFile(path)
    return content.byteLength === expectedSize && sha256(content) === expectedSha256 ? "PRESENT" : "CORRUPT"
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "MISSING"
    throw error
  }
}

async function targetObjectStatus(objectKey, expectedContent) {
  if (targetProvider === "LOCAL") {
    try {
      const content = await readFile(resolveObjectKey(localRoot, objectKey))
      return content.equals(expectedContent) ? "MATCH" : "DIFFERENT"
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "MISSING"
      throw error
    }
  }
  try {
    const content = await readMinioObject(minio, bucket, objectKey)
    return content.equals(expectedContent) ? "MATCH" : "DIFFERENT"
  } catch (error) {
    if (isMissingObject(error)) return "MISSING"
    throw error
  }
}

async function writeTargetObject(objectKey, content) {
  if (targetProvider === "LOCAL") {
    const path = resolveObjectKey(localRoot, objectKey)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, { flag: "wx" })
    return
  }
  await minio.putObject(bucket, objectKey, content, content.byteLength, { "Content-Type": "image/png" })
}

async function deleteTargetObject(objectKey) {
  if (targetProvider !== "LOCAL") await minio.removeObject(bucket, objectKey)
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

function positionsFromGeometry(geometry) {
  const ring = Array.isArray(geometry?.coordinates?.[0]) ? geometry.coordinates[0] : []
  const open = ring.length > 1 && ring[0]?.[0] === ring.at(-1)?.[0] && ring[0]?.[1] === ring.at(-1)?.[1] ? ring.slice(0, -1) : ring
  return open.map((point) => ({ longitude: Number(point[0]), latitude: Number(point[1]) }))
}

function resolveObjectKey(root, objectKey) {
  if (!objectKey || objectKey.includes("\0") || objectKey.startsWith("/") || objectKey.split("/").includes("..")) throw new Error(`对象键无效：${objectKey}`)
  const target = resolve(root, objectKey.replaceAll("/", sep))
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`对象键越界：${objectKey}`)
  return target
}

function normalizeTargetProvider(value) {
  const provider = value?.trim().toUpperCase() || "MINIO"
  if (provider !== "LOCAL" && provider !== "MINIO" && provider !== "S3") throw new Error("V3_FILE_STORAGE_PROVIDER 必须为 LOCAL、MINIO 或 S3")
  return provider
}

function isMissingObject(error) {
  return error instanceof Error && "code" in error && ["NoSuchKey", "NoSuchObject", "NotFound"].includes(String(error.code))
}

function sha256(content) { return createHash("sha256").update(content).digest("hex") }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
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
