import { createHash, sign, type KeyObject } from "node:crypto"
import { ZipFile } from "yazl"
import type { ResourcePackageType, V3ResourceArchiveManifest } from "@wurenji/shared"
import { canonicalJson } from "../common/canonical-json.js"

export interface ResourceArchiveFixtureOptions {
  privateKey: KeyObject
  keyId: string
  name: string
  version?: string
  packageType?: ResourcePackageType
  content?: Record<string, unknown>
  payloadPath?: string
  payload?: Buffer
  archivedPayload?: Buffer
  payloads?: Array<{ path: string; content: Buffer; mimeType: string; role: string }>
}

export async function createSignedResourceArchive(options: ResourceArchiveFixtureOptions): Promise<Buffer> {
  const packageType = options.packageType ?? "RULE"
  const payloadPath = options.payloadPath ?? "payload/rules.json"
  const payload = options.payload ?? Buffer.from(JSON.stringify({ rules: ["stage"] }), "utf8")
  const payloads = options.payloads ?? [{ path: payloadPath, content: payload, mimeType: "application/json", role: "PRIMARY" }]
  const schemaPath = "schemas/manifest.schema.json"
  const schema = Buffer.from(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }), "utf8")
  const content = options.content ?? defaultContent(packageType)
  const manifest: V3ResourceArchiveManifest = {
    formatVersion: 1,
    packageType,
    name: options.name,
    version: options.version ?? "1.0.0",
    schemaVersion: 1,
    minimumPlatformVersion: "0.1.0",
    publishedAt: "2026-08-11T00:00:00.000Z",
    signature: { algorithm: "Ed25519", keyId: options.keyId },
    dependencies: [],
    files: [
      { path: schemaPath, role: "MANIFEST_SCHEMA", mimeType: "application/schema+json", sizeBytes: schema.byteLength, sha256: sha256(schema) },
      ...payloads.map((item) => ({ path: item.path, role: item.role, mimeType: item.mimeType, sizeBytes: item.content.byteLength, sha256: sha256(item.content) }))
    ],
    content
  }
  const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8")
  const checksums = {
    algorithm: "SHA-256" as const,
    files: {
      "manifest.json": sha256(manifestBuffer),
      [schemaPath]: sha256(schema),
      ...Object.fromEntries(payloads.map((item) => [item.path, sha256(item.content)]))
    }
  }
  const checksumsBuffer = Buffer.from(JSON.stringify(checksums), "utf8")
  const signature = sign(null, Buffer.from(canonicalJson({ manifest, checksums }), "utf8"), options.privateKey)
  return createZip([
    ["manifest.json", manifestBuffer],
    [schemaPath, schema],
    ...payloads.map((item, index) => [item.path, index === 0 && options.archivedPayload ? options.archivedPayload : item.content] as [string, Buffer]),
    ["checksums.json", checksumsBuffer],
    ["signature.ed25519", signature]
  ])
}

function createZip(entries: Array<[string, Buffer]>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile()
    const chunks: Buffer[] = []
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.once("error", reject)
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)))
    for (const [path, content] of entries) zip.addBuffer(content, path)
    zip.end()
  })
}

function defaultContent(packageType: ResourcePackageType): Record<string, unknown> {
  if (packageType === "RULE") return { rules: ["stage"] }
  if (packageType === "AIRCRAFT") return { modelCode: "TEST-UAV" }
  if (packageType === "EVENT") return {
    sceneType: "CITY_SHOW",
    events: [{
      code: "WEATHER_LIMIT",
      title: "风力接近运行限制",
      category: "WEATHER",
      severity: "WARNING",
      detectionDelaySeconds: 3,
      escalationDelaySeconds: 45,
      recommendedActions: ["PAUSE_PROGRAM"]
    }]
  }
  if (packageType === "SHOW_PROGRAM") return {
    sceneType: "CITY_SHOW",
    format: "LOCAL_ENU_CSV_V1",
    sourceSoftware: "Test Dance Studio",
    aircraftCount: 100,
    groupSize: 100,
    keyframeCount: 2,
    sourceRowCount: 200,
    durationMs: 10_000,
    maximumAltitudeMeters: 80,
    horizontalRadiusMeters: 30,
    maximumSpeedMetersPerSecond: 3,
    groupTracks: [{ groupId: "G01", points: [
      { timeMs: 0, eastMeters: 0, northMeters: 0, upMeters: 0 },
      { timeMs: 10_000, eastMeters: 10, northMeters: 0, upMeters: 20 }
    ] }]
  }
  if (packageType === "DOCUMENT_TEMPLATE") return { documents: [{ code: "TEST", path: "payload/rules.json" }] }
  if (packageType === "REPORT") return { output: "PDF" }
  if (packageType === "SCALE_TEMPLATE") return { sceneType: "CITY_SHOW", templates: [{ code: "SHOW_100" }] }
  return {
    sceneType: "CITY_SHOW",
    regionCode: "TEST-REGION",
    title: "测试区域",
    center: { longitude: 114, latitude: 22 },
    boundary: [{ longitude: 113.9, latitude: 21.9 }, { longitude: 114.1, latitude: 21.9 }, { longitude: 114, latitude: 22.1 }],
    heightDatum: "AGL",
    layers: [{ code: "BUILDINGS" }]
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}
