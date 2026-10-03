import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { test } from "node:test"
import { join, resolve } from "node:path"
import yauzl from "yauzl"

const execFileAsync = promisify(execFile)

test("show document package keeps each DOCX mapped to its declared source", async () => {
  const directory = await mkdtemp(join(process.cwd(), ".tmp-show-document-package-"))
  const sourceDirectory = join(directory, "source")
  const payloadDirectory = join(sourceDirectory, "payload")
  const outputPath = join(directory, "show-documents.zip")
  const privateKeyPath = join(directory, "private.pem")
  const documents = [
    ["airspace-application-form.docx", Buffer.from("PK\x03\x04FORM", "ascii")],
    ["airspace-application-letter.docx", Buffer.from("PK\x03\x04LETTER", "ascii")],
    ["safety-emergency-plan.docx", Buffer.from("PK\x03\x04PLAN", "ascii")]
  ]

  try {
    const { privateKey } = generateKeyPairSync("ed25519")
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    await mkdir(payloadDirectory, { recursive: true })
    await Promise.all(documents.map(([filename, content]) => writeFile(join(payloadDirectory, filename), content)))
    await execFileAsync(process.execPath, [
      resolve(process.cwd(), "scripts/build-show-document-package.mjs"),
      "--source", sourceDirectory,
      "--private-key", privateKeyPath,
      "--key-id", "regression-key",
      "--version", "1.0.0",
      "--output", outputPath
    ])

    const archiveEntries = await readZipEntries(await readFile(outputPath))
    const manifest = JSON.parse(archiveEntries.get("manifest.json").toString("utf8"))
    const declaredDocuments = new Map(manifest.content.documents.map((document) => [document.code, document.path]))
    const expected = new Map([
      ["AIRSPACE_APPLICATION_FORM", documents[0][1]],
      ["AIRSPACE_APPLICATION_LETTER", documents[1][1]],
      ["SAFETY_EMERGENCY_PLAN", documents[2][1]]
    ])

    for (const [code, content] of expected) {
      const path = declaredDocuments.get(code)
      assert.ok(path)
      assert.deepEqual(archiveEntries.get(path), content)
      const descriptor = manifest.files.find((file) => file.path === path)
      assert.equal(descriptor.sha256, sha256(content))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function readZipEntries(content) {
  return new Promise((resolveEntries, reject) => {
    yauzl.fromBuffer(content, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error("Unable to open archive"))
      const entries = new Map()
      zip.on("error", reject)
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError ?? new Error("Unable to read archive entry"))
          const chunks = []
          stream.on("data", (chunk) => chunks.push(chunk))
          stream.on("error", reject)
          stream.on("end", () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            zip.readEntry()
          })
        })
      })
      zip.on("end", () => resolveEntries(entries))
      zip.readEntry()
    })
  })
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex")
}
