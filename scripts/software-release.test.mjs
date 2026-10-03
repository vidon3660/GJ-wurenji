import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { promisify } from "node:util"
import test from "node:test"

const execFile = promisify(execFileCallback)

test("verify accepts a complete release and detects tampering", async () => {
  const root = await fixture()
  try {
    await runVerify(root)
    await writeFile(resolve(root, "release.env"), "PLATFORM_VERSION=9.9.9\n", "utf8")
    await assert.rejects(runVerify(root), /大小不匹配|SHA-256/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verify rejects undeclared files", async () => {
  const root = await fixture()
  try {
    await writeFile(resolve(root, "undeclared.txt"), "unexpected", "utf8")
    await assert.rejects(runVerify(root), /未声明文件/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verify rejects unsafe artifact paths", async () => {
  const root = await fixture()
  try {
    const manifestPath = resolve(root, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.artifacts[0].path = "../outside.tar"
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await assert.rejects(runVerify(root), /非法片段|路径越界/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("verify rejects an inconsistent migration digest", async () => {
  const root = await fixture()
  try {
    const manifestPath = resolve(root, "manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    manifest.migrations.sha256 = "0".repeat(64)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
    await assert.rejects(runVerify(root), /migration 清单摘要/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "wurenji-software-release-"))
  await mkdir(resolve(root, "images"), { recursive: true })
  await mkdir(resolve(root, "deployment", "deploy", "nginx"), { recursive: true })
  await writeFile(resolve(root, "images/platform.tar"), "platform", "utf8")
  await writeFile(resolve(root, "images/backup.tar"), "backup", "utf8")
  await writeFile(resolve(root, "release.env"), [
    "PLATFORM_VERSION=0.2.0",
    "PLATFORM_IMAGE=wurenji-platform:0.2.0",
    "BACKUP_IMAGE=wurenji-backup:0.2.0",
    ""
  ].join("\n"), "utf8")
  const deploymentFiles = [
    "deployment/docker-compose.yml",
    "deployment/deploy/docker-compose.production.yml",
    "deployment/deploy/nginx/nginx.conf",
    "deployment/deploy/nginx/default.conf",
    "deployment/deploy/nginx/map.conf"
  ]
  for (const path of deploymentFiles) await writeFile(resolve(root, path), path, "utf8")
  await writeFile(resolve(root, "ROLLBACK.md"), "rollback", "utf8")
  const artifactPaths = ["images/platform.tar", "images/backup.tar", "release.env", "ROLLBACK.md", ...deploymentFiles]
  const artifacts = []
  for (const path of artifactPaths) {
    const content = await readFile(resolve(root, path))
    artifacts.push({ path, sizeBytes: content.byteLength, sha256: sha256(content) })
  }
  const migrations = [{ path: "apps/server/src/database/migrations/1-Test.ts", sizeBytes: 12, sha256: "a".repeat(64) }]
  const migrationDigest = sha256(Buffer.from(migrations.map((item) => `${item.path}\0${item.sizeBytes}\0${item.sha256}`).join("\n")))
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify({
    format: "wurenji-software-release",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    version: "0.2.0",
    minimumCompatibleVersion: "0.1.0",
    platform: "linux/amd64",
    images: {
      platform: { reference: "wurenji-platform:0.2.0", id: `sha256:${"1".repeat(64)}`, archive: "images/platform.tar" },
      backup: { reference: "wurenji-backup:0.2.0", id: `sha256:${"2".repeat(64)}`, archive: "images/backup.tar" }
    },
    migrations: { sha256: migrationDigest, files: migrations },
    artifacts
  }, null, 2)}\n`, "utf8")
  return root
}

async function runVerify(root) {
  try {
    return await execFile(process.execPath, ["scripts/software-release.mjs", "verify", "--input", root], { cwd: process.cwd(), windowsHide: true })
  } catch (error) {
    const details = `${error?.stdout ?? ""}\n${error?.stderr ?? error?.message ?? error}`
    throw new Error(details, { cause: error })
  }
}

function sha256(value) { return createHash("sha256").update(value).digest("hex") }
