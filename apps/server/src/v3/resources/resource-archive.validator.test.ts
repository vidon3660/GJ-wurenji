import { afterEach, describe, expect, it } from "vitest"
import { generateKeyPairSync } from "node:crypto"
import { ResourceArchiveValidationError, ResourceArchiveValidator } from "./resource-archive.validator.js"
import { createSignedResourceArchive } from "./resource-archive.fixtures.js"

describe("signed resource archive", () => {
  const previousTrustedKeys = process.env.RESOURCE_PACKAGE_TRUSTED_KEYS_JSON
  const keys = generateKeyPairSync("ed25519")
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()

  afterEach(() => restoreEnvironment("RESOURCE_PACKAGE_TRUSTED_KEYS_JSON", previousTrustedKeys))

  it("validates archive structure, checksums, schema and Ed25519 signature", async () => {
    process.env.RESOURCE_PACKAGE_TRUSTED_KEYS_JSON = JSON.stringify({ "test-key": publicKey })
    const content = await createSignedResourceArchive({ privateKey: keys.privateKey, keyId: "test-key", name: "签名规则包" })
    const validator = new ResourceArchiveValidator()

    const inspected = await validator.inspect(content)
    const validated = await validator.validate(inspected)

    expect(validated.manifest).toMatchObject({ packageType: "RULE", name: "签名规则包", version: "1.0.0" })
    expect(validated.checks.map((check) => check.code)).toEqual(["FILE_CHECKSUMS", "MANIFEST_SCHEMA", "FILE_MANIFEST", "SIGNATURE"])
    expect(validated.checks.every((check) => check.passed)).toBe(true)
  })

  it("rejects a payload changed after signing", async () => {
    process.env.RESOURCE_PACKAGE_TRUSTED_KEYS_JSON = JSON.stringify({ "test-key": publicKey })
    const content = await createSignedResourceArchive({
      privateKey: keys.privateKey,
      keyId: "test-key",
      name: "篡改规则包",
      archivedPayload: Buffer.from("tampered", "utf8")
    })
    const validator = new ResourceArchiveValidator()
    const inspected = await validator.inspect(content)

    await expect(validator.validate(inspected)).rejects.toMatchObject<ResourceArchiveValidationError>({ code: "FILE_CHECKSUMS" })
  })

  it("rejects signatures from an untrusted key", async () => {
    process.env.RESOURCE_PACKAGE_TRUSTED_KEYS_JSON = JSON.stringify({})
    const content = await createSignedResourceArchive({ privateKey: keys.privateKey, keyId: "unknown-key", name: "未知签名包" })
    const validator = new ResourceArchiveValidator()
    const inspected = await validator.inspect(content)

    await expect(validator.validate(inspected)).rejects.toMatchObject<ResourceArchiveValidationError>({ code: "SIGNATURE" })
  })

  it("rejects executable files before extraction", async () => {
    const content = await createSignedResourceArchive({
      privateKey: keys.privateKey,
      keyId: "test-key",
      name: "脚本资源包",
      payloadPath: "payload/install.js"
    })

    await expect(new ResourceArchiveValidator().inspect(content)).rejects.toThrow("不允许携带可执行")
  })
})

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
