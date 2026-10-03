import { generateKeyPairSync } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const argumentsByName = parseArguments(process.argv.slice(2))
const keyId = argumentsByName["key-id"]?.trim() || "local-resource-key"
const outputDirectory = resolve(argumentsByName.output ?? "data/resource-builds/keys")
const privateKeyPath = resolve(outputDirectory, `${keyId}-private.pem`)
const publicKeyPath = resolve(outputDirectory, `${keyId}-public.pem`)
const trustedKeysPath = resolve(outputDirectory, "trusted-keys.json")
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" })
const publicPem = publicKey.export({ type: "spki", format: "pem" })

await mkdir(dirname(privateKeyPath), { recursive: true })
await writeFile(privateKeyPath, privatePem, { flag: "wx", mode: 0o600 })
await writeFile(publicKeyPath, publicPem, { flag: "wx" })
await writeFile(trustedKeysPath, JSON.stringify({ [keyId]: String(publicPem) }), { flag: "wx" })
process.stdout.write(`${privateKeyPath}\n${publicKeyPath}\n${trustedKeysPath}\n`)

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
