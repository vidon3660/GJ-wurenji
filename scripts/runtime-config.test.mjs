import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { test } from "node:test"
import { requiresObjectStorage } from "./backup-storage.mjs"

const execFile = promisify(execFileCallback)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"))

test("operational commands load local configuration and preserve explicit environment overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wurenji-command-env-"))
  try {
    await writeFile(join(directory, ".env"), "WURENJI_CONFIG_TEST_FILE=loaded-from-file\nWURENJI_CONFIG_TEST_OVERRIDE=file-value\n")
    const operationalCommands = ["backup:create", "backup:restore", "backup:drill", "visual:smoke", "accessibility:browser", "map:resources:acceptance", "performance:browser-runtime", "acceptance:onboarding:browser"]
    for (const name of operationalCommands) {
      const [node, ...argumentsWithScript] = packageJson.scripts[name].split(" ")
      assert.equal(node, "node", name)
      const scriptIndex = argumentsWithScript.findIndex((argument) => argument.startsWith("scripts/"))
      assert.ok(scriptIndex >= 0, name)
      const result = await execFile(process.execPath, [...argumentsWithScript.slice(0, scriptIndex), "--eval", "console.log(JSON.stringify([process.env.WURENJI_CONFIG_TEST_FILE, process.env.WURENJI_CONFIG_TEST_OVERRIDE]))"], {
        cwd: directory,
        env: { PATH: process.env.PATH, WURENJI_CONFIG_TEST_OVERRIDE: "shell-value" }
      })
      assert.deepEqual(JSON.parse(result.stdout), ["loaded-from-file", "shell-value"], name)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("LOCAL deployment enables workers and backups without starting MinIO", async (context) => {
  try {
    await execFile("docker", ["compose", "version"])
  } catch {
    context.skip("Docker Compose is not installed")
    return
  }
  const directory = await mkdtemp(join(tmpdir(), "wurenji-compose-config-"))
  try {
    const envPath = join(directory, "compose.env")
    await writeFile(envPath, ["POSTGRES_PASSWORD=config-test", "JWT_SECRET=config-test", "MINIO_ACCESS_KEY=config-test", "MINIO_SECRET_KEY=config-test", "ONLYOFFICE_JWT_SECRET=config-test", "V3_FILE_STORAGE_PROVIDER=MINIO", "VITE_API_BASE_URL=http://localhost:3000/api", "VITE_MAP_TILE_URL=https://tiles.example.edu/{z}/{x}/{y}.png", "VITE_LOGISTICS_OFFLINE_IMAGERY_URL=/map/custom/imagery.jpg", "VITE_LOGISTICS_BUILDINGS_URL=/map/custom/buildings.geojson"].join("\n"))
    const { stdout } = await execFile("docker", ["compose", "--env-file", envPath, "-f", join(root, "docker-compose.yml"), "-f", join(root, "docker-compose.local.yml"), "--profile", "worker", "--profile", "backup", "config", "--format", "json"], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    const configuration = JSON.parse(stdout)
    assert.equal(configuration.services.minio, undefined)
    for (const name of ["app", "worker", "backup"]) {
      const service = configuration.services[name]
      assert.equal(service.environment.V3_FILE_STORAGE_PROVIDER, "LOCAL", name)
      assert.equal(service.depends_on.minio, undefined, name)
      assert.ok(service.depends_on.db, name)
      const fileVolume = service.volumes.find((volume) => volume.target === "/app/data/v3-files")
      assert.equal(fileVolume?.source, "v3-file-data", name)
    }
    assert.equal(configuration.services.backup.environment.BACKUP_ROOT, "/app/backups")
    for (const name of ["app", "migrate", "worker"]) {
      const args = configuration.services[name].build.args
      assert.equal(args.VITE_API_BASE_URL, "/api", name)
      assert.equal(args.VITE_MAP_TILE_URL, "https://tiles.example.edu/{z}/{x}/{y}.png", name)
      assert.equal(args.VITE_LOGISTICS_OFFLINE_IMAGERY_URL, "/map/custom/imagery.jpg", name)
      assert.equal(args.VITE_LOGISTICS_BUILDINGS_URL, "/map/custom/buildings.geojson", name)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("production deployment keeps object storage enabled for app, worker, and backup", async (context) => {
  try {
    await execFile("docker", ["compose", "version"])
  } catch {
    context.skip("Docker Compose is not installed")
    return
  }
  const directory = await mkdtemp(join(tmpdir(), "wurenji-compose-prod-"))
  try {
    const envPath = join(directory, "compose.env")
    await writeFile(envPath, [
      "POSTGRES_PASSWORD=config-test",
      "PRODUCTION_DATABASE_URL=postgresql://wurenji:config-test@db:5432/wurenji",
      "WEB_ORIGIN=https://training.example.edu",
      "JWT_SECRET=config-test",
      "MINIO_ACCESS_KEY=config-test",
      "MINIO_SECRET_KEY=config-test",
      "ONLYOFFICE_JWT_SECRET=config-test",
      "ONLYOFFICE_PUBLIC_URL=https://office.example.edu",
      "ONLYOFFICE_INTERNAL_URL=http://onlyoffice"
    ].join("\n"))
    const { stdout } = await execFile("docker", ["compose", "--env-file", envPath, "-f", join(root, "docker-compose.yml"), "-f", join(root, "deploy/docker-compose.production.yml"), "--profile", "worker", "--profile", "backup", "config", "--format", "json"], { cwd: root, env: { PATH: process.env.PATH, HOME: process.env.HOME } })
    const configuration = JSON.parse(stdout)
    for (const name of ["app", "worker", "backup"]) assert.equal(configuration.services[name].environment.V3_FILE_STORAGE_PROVIDER, "MINIO", name)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("LOCAL recovery exercises require no object-store connection", () => {
  assert.equal(requiresObjectStorage({ storage: { provider: "LOCAL" }, artifacts: [], fileAssets: [{ storageProvider: "LOCAL", status: "AVAILABLE" }] }), false)
  assert.equal(requiresObjectStorage({ storage: { provider: "LOCAL" }, artifacts: [], fileAssets: [{ storageProvider: "MINIO", status: "DELETED" }] }), false)
})

test("recovery exercises preserve object-store data when storage providers are mixed", () => {
  assert.equal(requiresObjectStorage({ storage: { provider: "MINIO" }, artifacts: [], fileAssets: [] }), true)
  assert.equal(requiresObjectStorage({ storage: { provider: "LOCAL" }, artifacts: [], fileAssets: [{ storageProvider: "MINIO", status: "AVAILABLE" }] }), true)
  assert.equal(requiresObjectStorage({ storage: { provider: "LOCAL" }, artifacts: [{ kind: "V3_FILE", storageProvider: "MINIO" }], fileAssets: [] }), true)
})
