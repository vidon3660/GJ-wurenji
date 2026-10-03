import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)
const root = await mkdtemp(join(tmpdir(), "wurenji-backup-test-"))
try {
  const databaseDump = Buffer.from("test-database-dump")
  const object = Buffer.from("test-object")
  await writeFile(join(root, "database.dump"), databaseDump)
  await mkdir(join(root, "files", "v3-files", "planning"), { recursive: true })
  await writeFile(join(root, "files", "v3-files", "planning", "map.bin"), object)
  const hash = (value) => createHash("sha256").update(value).digest("hex")
  const manifest = {
    format: "wurenji-recovery-point",
    formatVersion: 1,
    database: { dumpFile: "database.dump", sha256: hash(databaseDump) },
    storage: { provider: "LOCAL", bucket: "wurenji" },
    fileAssets: [{ storageProvider: "LOCAL", objectKey: "planning/map.bin", sizeBytes: object.byteLength, sha256: hash(object), status: "AVAILABLE" }],
    artifacts: [{ kind: "V3_FILE_LOCAL", storageProvider: "LOCAL", objectKey: "planning/map.bin", archivePath: "files/v3-files/planning/map.bin", sizeBytes: object.byteLength, sha256: hash(object) }]
  }
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(manifest)}\n`)
  const verified = await execFile(process.execPath, ["scripts/backup.mjs", "verify", "--input", root], { cwd: process.cwd() })
  if (!verified.stdout.includes("Backup verified")) throw new Error("备份校验输出不符合预期")
  try {
    await execFile(process.execPath, ["scripts/backup.mjs", "restore", "--input", root, "--mode", "EXACT", "--confirm", "RESTORE"], { cwd: process.cwd() })
    throw new Error("严格恢复缺少二次确认时不应继续")
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}${error instanceof Error ? error.message : String(error)}`
    if (!output.includes("--confirm-exact REPLACE_DATABASE_AND_FILES")) throw error
  }
  const loaded = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
  loaded.artifacts[0].sha256 = "0".repeat(64)
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(loaded)}\n`)
  try {
    await execFile(process.execPath, ["scripts/backup.mjs", "verify", "--input", root], { cwd: process.cwd() })
    throw new Error("篡改后的备份不应通过校验")
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}${error instanceof Error ? error.message : String(error)}`
    if (!output.includes("SHA-256")) throw error
  }
  process.stdout.write("backup script checks passed\n")
} finally {
  await rm(root, { recursive: true, force: true })
}
