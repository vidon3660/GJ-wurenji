import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolve } from "node:path"
import { resolveLocalStorageRoot, V3FileStorageService } from "./file-storage.service.js"

describe("V3 file storage", () => {
  let storageDirectory: string
  const previousProvider = process.env.V3_FILE_STORAGE_PROVIDER
  const previousDirectory = process.env.V3_FILE_STORAGE_DIR

  beforeEach(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), "wurenji-file-storage-"))
    process.env.V3_FILE_STORAGE_PROVIDER = "LOCAL"
    process.env.V3_FILE_STORAGE_DIR = storageDirectory
  })

  afterEach(async () => {
    restoreEnvironment("V3_FILE_STORAGE_PROVIDER", previousProvider)
    restoreEnvironment("V3_FILE_STORAGE_DIR", previousDirectory)
    await rm(storageDirectory, { recursive: true, force: true })
  })

  it("writes, verifies and deletes a local object", async () => {
    const storage = new V3FileStorageService()
    const content = Buffer.from("planning-map-content", "utf8")

    const stored = await storage.write("planning-maps/project/map.png", content, "image/png")

    expect(stored).toEqual({
      storageProvider: "LOCAL",
      objectKey: "planning-maps/project/map.png",
      sizeBytes: content.byteLength,
      sha256: "10d3737ffd87c52be2590fa6fa2cb71651c4fa860d1a839cfe47274d4c62ef32"
    })
    await expect(storage.read(stored.objectKey, stored.storageProvider)).resolves.toEqual(content)
    await storage.delete(stored.objectKey, stored.storageProvider)
    await expect(storage.read(stored.objectKey, stored.storageProvider)).rejects.toMatchObject({ status: 404 })
  })

  it("rejects object keys that escape the storage root", async () => {
    const storage = new V3FileStorageService()

    await expect(storage.write("../outside.txt", Buffer.from("blocked"))).rejects.toThrow("文件对象键无效")
  })

  it("supports starting from either the repository root or apps/server", () => {
    expect(resolveLocalStorageRoot("", "E:/project/wurenji", () => true))
      .toBe(resolve("E:/project/wurenji/apps/server/data/v3-files"))
    expect(resolveLocalStorageRoot("", "E:/project/wurenji/apps/server", (path) => path.endsWith("apps/server/data/v3-files")))
      .toBe(resolve("E:/project/wurenji/apps/server/data/v3-files"))
  })

  it("always honors an explicitly configured storage directory", () => {
    expect(resolveLocalStorageRoot("custom/files", "E:/project/wurenji", () => false))
      .toBe(resolve("E:/project/wurenji/custom/files"))
  })

  it("resolves a repository-relative directory when started from apps/server", () => {
    expect(resolveLocalStorageRoot(
      "./apps/server/data/v3-files",
      "E:/project/wurenji/apps/server",
      (path) => path === resolve("E:/project/wurenji/apps/server/data/v3-files")
    )).toBe(resolve("E:/project/wurenji/apps/server/data/v3-files"))
  })
})

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
