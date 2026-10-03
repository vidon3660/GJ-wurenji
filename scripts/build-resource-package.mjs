import { createHash, createPrivateKey, sign } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"
import { ZipFile } from "yazl"

const argumentsByName = parseArguments(process.argv.slice(2))
const descriptorPath = resolveRequired(argumentsByName.manifest, "--manifest")
const sourceDirectory = resolve(argumentsByName["source-dir"] ?? dirname(descriptorPath))
const privateKeyPath = resolveRequired(argumentsByName["private-key"], "--private-key")
const outputPath = resolve(argumentsByName.output ?? `data/resource-builds/${basename(descriptorPath, ".json")}.zip`)
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"))
const privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"))

const packageTypes = ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "DOCUMENT_TEMPLATE", "REPORT"]
const packageType = requireString(descriptor.packageType, "packageType")
if (!packageTypes.includes(packageType)) throw new Error(`packageType 无效：${packageType}`)
const version = requireString(descriptor.version, "version")
const minimumPlatformVersion = requireString(descriptor.minimumPlatformVersion, "minimumPlatformVersion")
if (!isSemanticVersion(version) || !isSemanticVersion(minimumPlatformVersion)) throw new Error("version 和 minimumPlatformVersion 必须使用语义版本")
const name = requireString(descriptor.name, "name")
const schemaVersion = Number(descriptor.schemaVersion ?? 1)
if (!Number.isInteger(schemaVersion) || schemaVersion < 1) throw new Error("schemaVersion 必须为正整数")
const keyId = String(argumentsByName["key-id"] ?? descriptor.keyId ?? "").trim()
if (!/^[A-Za-z0-9._:-]+$/.test(keyId)) throw new Error("keyId 必须使用字母、数字、点、下划线、冒号或短横线")
if (!isPlainObject(descriptor.content)) throw new Error("content 必须是 JSON 对象")

const schemaContent = descriptor.schema
  ? await readFile(resolveInside(sourceDirectory, descriptor.schema), "utf8")
  : JSON.stringify(createPackageSchema(packageType, name), null, 2)
const schemaEntry = { path: "schemas/manifest.schema.json", role: "MANIFEST_SCHEMA", mimeType: "application/schema+json", content: Buffer.from(schemaContent, "utf8") }
const payloadEntries = await readPayloadEntries(sourceDirectory, descriptor.files)
const files = [schemaEntry, ...payloadEntries]
const manifest = {
  formatVersion: 1,
  packageType,
  name,
  version,
  schemaVersion,
  minimumPlatformVersion,
  publishedAt: new Date().toISOString(),
  signature: { algorithm: "Ed25519", keyId },
  dependencies: normalizeDependencies(descriptor.dependencies),
  files: files.map((file) => ({ path: file.path, role: file.role, mimeType: file.mimeType, sizeBytes: file.content.byteLength, sha256: sha256(file.content) })),
  content: descriptor.content
}
const manifestBuffer = Buffer.from(JSON.stringify(manifest), "utf8")
const checksums = {
  algorithm: "SHA-256",
  files: Object.fromEntries([
    ["manifest.json", sha256(manifestBuffer)],
    ...files.map((file) => [file.path, sha256(file.content)])
  ])
}
const checksumsBuffer = Buffer.from(JSON.stringify(checksums), "utf8")
const signature = sign(null, Buffer.from(canonicalJson({ manifest, checksums }), "utf8"), privateKey)
const archive = await createZip([
  ["manifest.json", manifestBuffer],
  ...files.map((file) => [file.path, file.content]),
  ["checksums.json", checksumsBuffer],
  ["signature.ed25519", signature]
])
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, archive)
process.stdout.write(`${basename(outputPath)}\nSHA-256 ${sha256(archive)}\nKey ${keyId}\n`)

async function readPayloadEntries(root, values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error("files 必须至少声明一个 payload 文件")
  const paths = new Set()
  const entries = []
  for (const value of values) {
    if (!isPlainObject(value)) throw new Error("files 条目必须是对象")
    const path = requireString(value.path, "files.path")
    const source = requireString(value.source ?? path.replace(/^payload\//, ""), "files.source")
    if (!path.startsWith("payload/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`payload 路径无效：${path}`)
    if (paths.has(path)) throw new Error(`payload 路径重复：${path}`)
    paths.add(path)
    const content = await readFile(resolveInside(root, source))
    entries.push({ path, role: requireString(value.role, "files.role"), mimeType: requireString(value.mimeType, "files.mimeType"), content })
  }
  return entries
}

function normalizeDependencies(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("dependencies 必须是数组")
  return value.map((dependency) => {
    if (!isPlainObject(dependency)) throw new Error("dependency 必须是对象")
    const packageType = requireString(dependency.packageType, "dependency.packageType")
    const name = requireString(dependency.name, "dependency.name")
    const version = requireString(dependency.version, "dependency.version")
    if (!packageTypes.includes(packageType) || !isSemanticVersion(version)) throw new Error("dependency 类型或版本无效")
    return { packageType, name, version }
  })
}

function createPackageSchema(packageType, name) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: `${name} (${packageType})`,
    type: "object",
    required: ["formatVersion", "packageType", "name", "version", "schemaVersion", "minimumPlatformVersion", "publishedAt", "signature", "dependencies", "files", "content"],
    properties: { formatVersion: { const: 1 }, packageType: { const: packageType }, content: { type: "object" } }
  }
}

function resolveInside(root, child) {
  const target = resolve(root, child)
  const normalizedRoot = resolve(root)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) throw new Error(`文件路径越界：${child}`)
  return target
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

function resolveRequired(value, name) {
  if (!value?.trim()) throw new Error(`缺少 ${name}`)
  return resolve(value)
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`)
  return value.trim()
}

function isSemanticVersion(value) { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) }
function isPlainObject(value) { return typeof value === "object" && value !== null && !Array.isArray(value) }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
}
function createZip(entries) {
  return new Promise((resolveArchive, reject) => {
    const zip = new ZipFile()
    const chunks = []
    zip.outputStream.on("data", (chunk) => chunks.push(chunk))
    zip.outputStream.once("error", reject)
    zip.outputStream.once("end", () => resolveArchive(Buffer.concat(chunks)))
    for (const [path, content] of entries) zip.addBuffer(content, path)
    zip.end()
  })
}
