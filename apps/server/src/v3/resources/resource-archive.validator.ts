import { BadRequestException, Injectable } from "@nestjs/common"
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import yauzl from "yauzl"
import type {
  ResourcePackageType,
  V3ResourceArchiveManifest,
  V3ResourceValidationCheck
} from "@wurenji/shared"
import { canonicalJson } from "../common/canonical-json.js"
import { validateResourceManifest } from "./resource-package.schemas.js"

const requiredEntries = ["manifest.json", "checksums.json", "signature.ed25519", "schemas/manifest.schema.json"] as const
const forbiddenExtensions = new Set([".bat", ".cmd", ".com", ".dll", ".exe", ".html", ".hta", ".jar", ".js", ".mjs", ".cjs", ".ps1", ".py", ".sh", ".wasm", ".zip"])
const maximumArchiveBytes = 50 * 1024 * 1024
const maximumEntryBytes = 25 * 1024 * 1024
const maximumTotalBytes = 100 * 1024 * 1024
const maximumEntries = 200
const maximumCompressionRatio = 200

interface ArchiveChecksums {
  algorithm: "SHA-256"
  files: Record<string, string>
}

export interface InspectedResourceArchive {
  archiveSha256: string
  entries: ReadonlyMap<string, Buffer>
  rawManifest: Record<string, unknown>
  checksums: ArchiveChecksums
  signature: Buffer
  identity: {
    packageType: ResourcePackageType
    name: string
    version: string
    schemaVersion: number
    minimumPlatformVersion: string
  }
}

export interface ValidatedResourceArchive extends InspectedResourceArchive {
  manifest: V3ResourceArchiveManifest
  checks: V3ResourceValidationCheck[]
}

export class ResourceArchiveValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly checks: V3ResourceValidationCheck[] = []
  ) {
    super(message)
  }
}

@Injectable()
export class ResourceArchiveValidator {
  async inspect(content: Buffer): Promise<InspectedResourceArchive> {
    if (content.byteLength === 0 || content.byteLength > maximumArchiveBytes) throw new BadRequestException("资源包 ZIP 必须大于 0 且不超过 50 MB")
    const entries = await readZipEntries(content)
    for (const required of requiredEntries) {
      if (!entries.has(required)) throw new BadRequestException(`资源包缺少必需文件：${required}`)
    }
    if (![...entries.keys()].some((path) => path.startsWith("payload/"))) throw new BadRequestException("资源包必须至少包含一个 payload 文件")
    const rawManifest = parseJsonObject(entries.get("manifest.json")!, "manifest.json")
    const checksums = parseChecksums(entries.get("checksums.json")!)
    const signature = parseSignature(entries.get("signature.ed25519")!)
    return {
      archiveSha256: sha256(content),
      entries,
      rawManifest,
      checksums,
      signature,
      identity: parseIdentity(rawManifest)
    }
  }

  async validate(inspected: InspectedResourceArchive): Promise<ValidatedResourceArchive> {
    const checks: V3ResourceValidationCheck[] = []
    assertArchiveFiles(inspected, checks)
    const schemaResult = validateResourceManifest(inspected.rawManifest)
    if (!schemaResult.manifest) fail("MANIFEST_SCHEMA", `manifest schema 校验失败：${schemaResult.errors.join("；")}`, checks)
    const manifest = schemaResult.manifest
    pass("MANIFEST_SCHEMA", "manifest 基础 schema 和分类 content schema 校验通过", checks)
    assertManifestFiles(manifest, inspected, checks)
    await assertSignature(manifest, inspected, checks)
    return { ...inspected, manifest, checks }
  }
}

async function readZipEntries(content: Buffer): Promise<Map<string, Buffer>> {
  let zip: yauzl.ZipFile
  try {
    zip = await yauzl.fromBufferPromise(content, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    })
  } catch (error) {
    throw new BadRequestException(`无法读取资源包 ZIP：${normalizeError(error)}`)
  }
  const entries = new Map<string, Buffer>()
  let totalBytes = 0
  try {
    for await (const entry of zip.eachEntry()) {
      if (entry.fileName.endsWith("/")) continue
      validateArchivePath(entry.fileName)
      if (entries.has(entry.fileName)) throw new BadRequestException(`资源包包含重复文件：${entry.fileName}`)
      if (entries.size >= maximumEntries) throw new BadRequestException(`资源包文件数不能超过 ${maximumEntries}`)
      if (entry.isEncrypted()) throw new BadRequestException(`资源包不允许加密文件：${entry.fileName}`)
      if (!entry.canDecodeFileData()) throw new BadRequestException(`资源包包含不支持的压缩格式：${entry.fileName}`)
      if (entry.uncompressedSize > maximumEntryBytes) throw new BadRequestException(`资源包单个文件不能超过 25 MB：${entry.fileName}`)
      if (entry.uncompressedSize > Math.max(1, entry.compressedSize) * maximumCompressionRatio) throw new BadRequestException(`资源包文件压缩比异常：${entry.fileName}`)
      totalBytes += entry.uncompressedSize
      if (totalBytes > maximumTotalBytes) throw new BadRequestException("资源包解压后总大小不能超过 100 MB")
      validateAllowedFile(entry.fileName)
      const stream = await zip.openReadStreamPromise(entry)
      const chunks: Buffer[] = []
      let bytesRead = 0
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytesRead += buffer.byteLength
        if (bytesRead > maximumEntryBytes || bytesRead > entry.uncompressedSize) throw new BadRequestException(`资源包文件大小异常：${entry.fileName}`)
        chunks.push(buffer)
      }
      if (bytesRead !== entry.uncompressedSize) throw new BadRequestException(`资源包文件大小与目录记录不一致：${entry.fileName}`)
      entries.set(entry.fileName, Buffer.concat(chunks))
    }
  } catch (error) {
    if (error instanceof BadRequestException) throw error
    throw new BadRequestException(`读取资源包内容失败：${normalizeError(error)}`)
  } finally {
    if (zip.isOpen) zip.close()
  }
  return entries
}

function assertArchiveFiles(inspected: InspectedResourceArchive, checks: V3ResourceValidationCheck[]): void {
  if (inspected.checksums.algorithm !== "SHA-256") fail("FILE_CHECKSUMS", "checksums.json 只支持 SHA-256", checks)
  const expectedPaths = [...inspected.entries.keys()].filter((path) => path !== "checksums.json" && path !== "signature.ed25519").sort()
  const checksumPaths = Object.keys(inspected.checksums.files).sort()
  if (canonicalJson(expectedPaths) !== canonicalJson(checksumPaths)) fail("FILE_CHECKSUMS", "checksums.json 必须覆盖归档中的全部 manifest、schema 和 payload 文件，且不能包含额外项", checks)
  for (const path of expectedPaths) {
    const expected = inspected.checksums.files[path]
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) fail("FILE_CHECKSUMS", `文件校验和无效：${path}`, checks)
    if (sha256(inspected.entries.get(path)!) !== expected) fail("FILE_CHECKSUMS", `文件 SHA-256 不匹配：${path}`, checks)
  }
  pass("FILE_CHECKSUMS", `已验证 ${expectedPaths.length} 个归档文件的 SHA-256`, checks)
}

function assertManifestFiles(
  manifest: V3ResourceArchiveManifest,
  inspected: InspectedResourceArchive,
  checks: V3ResourceValidationCheck[]
): void {
  const listedPaths = new Set<string>()
  for (const file of manifest.files) {
    if (listedPaths.has(file.path)) fail("FILE_MANIFEST", `manifest.files 包含重复路径：${file.path}`, checks)
    listedPaths.add(file.path)
    if (!file.path.startsWith("schemas/") && !file.path.startsWith("payload/")) fail("FILE_MANIFEST", `manifest.files 只能声明 schemas 或 payload 文件：${file.path}`, checks)
    const content = inspected.entries.get(file.path)
    if (!content) fail("FILE_MANIFEST", `manifest 声明的文件不存在：${file.path}`, checks)
    if (content.byteLength !== file.sizeBytes) fail("FILE_MANIFEST", `manifest 文件大小不匹配：${file.path}`, checks)
    if (sha256(content) !== file.sha256 || inspected.checksums.files[file.path] !== file.sha256) fail("FILE_MANIFEST", `manifest 文件哈希不匹配：${file.path}`, checks)
  }
  const archiveContentPaths = [...inspected.entries.keys()].filter((path) => path.startsWith("schemas/") || path.startsWith("payload/"))
  if (archiveContentPaths.some((path) => !listedPaths.has(path)) || listedPaths.size !== archiveContentPaths.length) {
    fail("FILE_MANIFEST", "manifest.files 与 schemas/payload 实际文件集合不一致", checks)
  }
  pass("FILE_MANIFEST", `manifest 已声明 ${manifest.files.length} 个内容文件`, checks)
}

async function assertSignature(
  manifest: V3ResourceArchiveManifest,
  inspected: InspectedResourceArchive,
  checks: V3ResourceValidationCheck[]
): Promise<void> {
  const trustedKeys = await loadTrustedKeys()
  const publicKey = trustedKeys[manifest.signature.keyId]
  if (!publicKey) fail("SIGNATURE", `签名密钥未受信任：${manifest.signature.keyId}`, checks)
  const signedPayload = Buffer.from(canonicalJson({ manifest: inspected.rawManifest, checksums: inspected.checksums }), "utf8")
  let valid = false
  try {
    valid = verify(null, signedPayload, createPublicKey(publicKey), inspected.signature)
  } catch (error) {
    fail("SIGNATURE", `Ed25519 公钥或签名无效：${normalizeError(error)}`, checks)
  }
  if (!valid) fail("SIGNATURE", "Ed25519 签名验证失败", checks)
  pass("SIGNATURE", `Ed25519 签名验证通过，密钥 ${manifest.signature.keyId}`, checks)
}

async function loadTrustedKeys(): Promise<Record<string, string>> {
  let source = process.env.RESOURCE_PACKAGE_TRUSTED_KEYS_JSON?.trim()
  const path = process.env.RESOURCE_PACKAGE_TRUSTED_KEYS_FILE?.trim()
  if (path) source = await readFile(path, "utf8")
  if (!source) return {}
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error("资源包受信任公钥配置不是有效 JSON")
  }
  if (!isPlainObject(value) || Object.values(value).some((item) => typeof item !== "string")) throw new Error("资源包受信任公钥配置必须为 keyId 到 PEM 公钥的 JSON 对象")
  return value as Record<string, string>
}

function parseIdentity(manifest: Record<string, unknown>): InspectedResourceArchive["identity"] {
  const packageType = manifest.packageType
  const name = typeof manifest.name === "string" ? manifest.name.trim() : ""
  const version = typeof manifest.version === "string" ? manifest.version.trim() : ""
  const schemaVersion = Number(manifest.schemaVersion)
  const minimumPlatformVersion = typeof manifest.minimumPlatformVersion === "string" ? manifest.minimumPlatformVersion.trim() : ""
  const types: ResourcePackageType[] = ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "SHOW_PROGRAM", "DOCUMENT_TEMPLATE", "REPORT"]
  if (!types.includes(packageType as ResourcePackageType)) throw new BadRequestException("manifest.packageType 无效")
  if (!name || name.length > 120) throw new BadRequestException("manifest.name 无效")
  if (!isSemanticVersion(version) || !isSemanticVersion(minimumPlatformVersion)) throw new BadRequestException("manifest 版本字段必须使用语义版本")
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new BadRequestException("manifest.schemaVersion 无效")
  return { packageType: packageType as ResourcePackageType, name, version, schemaVersion, minimumPlatformVersion }
}

function parseChecksums(content: Buffer): ArchiveChecksums {
  const value = parseJsonObject(content, "checksums.json")
  if (value.algorithm !== "SHA-256" || !isPlainObject(value.files)) throw new BadRequestException("checksums.json 格式无效")
  if (Object.values(value.files).some((item) => typeof item !== "string")) throw new BadRequestException("checksums.json 文件哈希必须为字符串")
  return { algorithm: "SHA-256", files: value.files as Record<string, string> }
}

function parseJsonObject(content: Buffer, filename: string): Record<string, unknown> {
  if (content.byteLength > 2 * 1024 * 1024) throw new BadRequestException(`${filename} 不能超过 2 MB`)
  try {
    const value = JSON.parse(content.toString("utf8")) as unknown
    if (!isPlainObject(value)) throw new Error("根节点不是对象")
    return value
  } catch (error) {
    throw new BadRequestException(`${filename} 不是有效 JSON 对象：${normalizeError(error)}`)
  }
}

function parseSignature(content: Buffer): Buffer {
  if (content.byteLength === 64) return content
  const value = content.toString("utf8").trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new BadRequestException("signature.ed25519 必须为 64 字节原始签名或 Base64")
  const signature = Buffer.from(value, "base64")
  if (signature.byteLength !== 64) throw new BadRequestException("Ed25519 签名长度无效")
  return signature
}

function validateArchivePath(path: string): void {
  if (!path || path.length > 500 || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new BadRequestException(`资源包文件路径无效：${path}`)
  }
}

function validateAllowedFile(path: string): void {
  if (forbiddenExtensions.has(extname(path).toLowerCase())) throw new BadRequestException(`资源包不允许携带可执行或嵌套归档文件：${path}`)
  if (path !== "manifest.json" && path !== "checksums.json" && path !== "signature.ed25519" && !path.startsWith("schemas/") && !path.startsWith("payload/")) {
    throw new BadRequestException(`资源包文件必须位于 schemas 或 payload 目录：${path}`)
  }
}

function pass(code: string, message: string, checks: V3ResourceValidationCheck[]): void {
  checks.push({ code, passed: true, message })
}

function fail(code: string, message: string, checks: V3ResourceValidationCheck[]): never {
  checks.push({ code, passed: false, message })
  throw new ResourceArchiveValidationError(code, message, checks)
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function isSemanticVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
