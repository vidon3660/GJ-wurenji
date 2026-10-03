import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLocalEnvironment, setupLocalEnvironment } from "./setup-local-env.mjs"

const template = await readFile(new URL("../.env.example", import.meta.url), "utf8")

function configuration(content) {
  return Object.fromEntries(content.split(/\r?\n/).filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
}

test("generates independent credentials and a matching local database URL", () => {
  const first = configuration(createLocalEnvironment(template))
  const second = configuration(createLocalEnvironment(template))
  const names = ["POSTGRES_PASSWORD", "JWT_SECRET", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "ONLYOFFICE_JWT_SECRET", "DEMO_ADMIN_PASSWORD", "DEMO_TEACHER_PASSWORD", "DEMO_STUDENT_PASSWORD", "DEMO_STUDENT2_PASSWORD"]
  assert.equal(new Set(names.map((name) => first[name])).size, names.length)
  for (const name of names) {
    assert.ok(first[name].length >= (name === "MINIO_ACCESS_KEY" ? 16 : 24))
    assert.notEqual(first[name], second[name])
    assert.doesNotMatch(first[name], /replace/)
  }
  const database = new URL(first.DATABASE_URL)
  assert.equal(database.password, first.POSTGRES_PASSWORD)
  assert.equal(database.hostname, "localhost")
  assert.equal(database.port, first.POSTGRES_PORT)
  assert.equal(first.SEED_DEMO_DATA, "true")
  assert.ok(first.WEB_ORIGIN.includes("localhost:3000"))
  assert.ok(first.WEB_ORIGIN.includes("localhost:5173"))
})

test("keeps an existing local environment unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wurenji-env-existing-"))
  try {
    const existing = "CUSTOM_CONFIG=keep-existing-value\n"
    await writeFile(join(directory, ".env"), existing)
    const result = await setupLocalEnvironment(directory)
    assert.equal(result.created, false)
    assert.equal(await readFile(join(directory, ".env"), "utf8"), existing)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("creates one private environment file during concurrent setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wurenji-env-create-"))
  try {
    await writeFile(join(directory, ".env.example"), template)
    const results = await Promise.all([setupLocalEnvironment(directory), setupLocalEnvironment(directory)])
    assert.equal(results.filter((result) => result.created).length, 1)
    const values = configuration(await readFile(join(directory, ".env"), "utf8"))
    assert.ok(values.DEMO_TEACHER_PASSWORD.length >= 8)
    if (process.platform !== "win32") assert.equal((await stat(join(directory, ".env"))).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("rejects an incomplete template before writing credentials", () => {
  assert.throws(() => createLocalEnvironment("POSTGRES_PASSWORD=replace-before-use\n"), /环境模板缺少配置项/)
})
