import { createHash, createPrivateKey, sign } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { ZipFile } from "yazl"

const argumentsByName = parseArguments(process.argv.slice(2))
const sourceDirectory = resolve(argumentsByName.source ?? "")
const privateKeyPath = resolve(argumentsByName["private-key"] ?? "")
const outputPath = resolve(argumentsByName.output ?? "data/resource-builds/show-document-templates-1.0.0.zip")
const keyId = argumentsByName["key-id"]?.trim() || "show-documents-local"
const version = argumentsByName.version?.trim() || "1.0.0"

if (!argumentsByName.source || !argumentsByName["private-key"]) {
  throw new Error("用法：npm run resource:show-documents -- --source <三件套目录> --private-key <Ed25519私钥PEM> [--key-id id] [--version 1.0.0] [--output file.zip]")
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("version 必须使用语义版本")

const templates = [
  {
    code: "AIRSPACE_APPLICATION_FORM",
    title: "无人机临时飞行空域申请表",
    filename: "无人机临时飞行空域申请表_教学模板.docx",
    sourceFilename: "payload/airspace-application-form.docx",
    path: "payload/airspace-application-form.docx"
  },
  {
    code: "AIRSPACE_APPLICATION_LETTER",
    title: "关于申请无人机临时飞行空域的函",
    filename: "关于申请无人机临时飞行空域的函_教学模板.docx",
    sourceFilename: "payload/airspace-application-letter.docx",
    path: "payload/airspace-application-letter.docx"
  },
  {
    code: "SAFETY_EMERGENCY_PLAN",
    title: "安全应急预案",
    filename: "安全应急预案_教学模板.docx",
    sourceFilename: "payload/safety-emergency-plan.docx",
    path: "payload/safety-emergency-plan.docx"
  }
]

const schemaPath = "schemas/manifest.schema.json"
const schema = Buffer.from(JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }), "utf8")
const payloads = await Promise.all(templates.map(async (template) => ({ ...template, content: await readFile(resolve(sourceDirectory, template.sourceFilename)) })))
const files = [
  { path: schemaPath, role: "MANIFEST_SCHEMA", mimeType: "application/schema+json", content: schema },
  ...payloads.map((template) => ({ path: template.path, role: template.code, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", content: template.content }))
]
const manifest = {
  formatVersion: 1,
  packageType: "DOCUMENT_TEMPLATE",
  name: "城市编队表演申报母版",
  version,
  schemaVersion: 1,
  minimumPlatformVersion: "0.1.0",
  publishedAt: new Date().toISOString(),
  signature: { algorithm: "Ed25519", keyId },
  dependencies: [],
  files: files.map((file) => ({ path: file.path, role: file.role, mimeType: file.mimeType, sizeBytes: file.content.byteLength, sha256: sha256(file.content) })),
  content: { sceneType: "CITY_SHOW", documents: templates.map(({ code, title, filename, path }) => ({ code, title, filename, path })) }
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
const privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"))
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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
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
