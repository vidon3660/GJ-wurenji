import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

test("VTL scale and long-run evidence enter the candidate report", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wurenji-acceptance-evidence-"))
  const artifactsRoot = join(root, "artifacts")
  const outputPath = join(root, "acceptance.json")
  const markdownPath = join(root, "acceptance.md")
  const mapDirectory = join(root, "map")
  context.after(() => rm(root, { recursive: true, force: true }))

  await mkdir(mapDirectory, { recursive: true })
  await writeEvidence(artifactsRoot, "performance/vtl.json", {
    format: "wurenji-browser-runtime-baseline",
    generatedAt: "2026-08-20T10:00:00.000Z",
    results: [{
      sceneType: "VTOL_INSPECTION",
      scale: { qualified: true, consistent: true, actual: { aircraft: 20 } },
      rendering: { durationMs: 30 * 60_000 },
      checks: { functionalPassed: true, streamStayedLive: true, memoryGrowthWithinLimit: true },
      browserMemory: { peakGrowthBytes: 32 * 1024 * 1024 }
    }]
  })
  await writeEvidence(artifactsRoot, "regression/local.json", {
    format: "wurenji-local-regression",
    generatedAt: "2026-08-20T10:00:00.000Z",
    status: "PASSED",
    checks: [
      { code: "TEST-ALL", status: "PASSED", command: "npm test" },
      { code: "TYPECHECK", status: "PASSED", command: "npm run typecheck" }
    ]
  })

  try {
    await execFile(process.execPath, ["scripts/acceptance-evidence.mjs", "--output", outputPath, "--markdown", markdownPath], {
      cwd: resolve("."),
      env: {
        ...process.env,
        ACCEPTANCE_ARTIFACTS_DIR: artifactsRoot,
        MAP_DATA_DIR: mapDirectory
      },
      windowsHide: true
    })
  } catch (error) {
    assert.equal(error.code, 1, `unexpected acceptance command failure: ${error}`)
  }

  const report = JSON.parse(await readFile(outputPath, "utf8"))
  assert.equal(check(report, "TEST-ALL").status, "PASS")
  assert.equal(check(report, "TYPECHECK").status, "PASS")
  assert.equal(check(report, "BACKUP-SOURCE").status, "PENDING")
  assert.equal(check(report, "BROWSER-VTL").status, "PASS")
  assert.equal(check(report, "BROWSER-VTL-LONG-RUN").status, "PASS")
  assert.match(await readFile(markdownPath, "utf8"), /垂起巡检 20 架目标浏览器规模/)
})

test("environment-blocked upgrade evidence remains pending", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wurenji-acceptance-blocked-upgrade-"))
  const artifactsRoot = join(root, "artifacts")
  const outputPath = join(root, "acceptance.json")
  context.after(() => rm(root, { recursive: true, force: true }))

  await writeEvidence(artifactsRoot, "software-upgrade/drill.json", {
    format: "wurenji-software-upgrade-drill",
    generatedAt: "2026-09-27T10:00:00.000Z",
    status: "BLOCKED",
    reason: "failed to connect to the Docker API"
  })

  try {
    await execFile(process.execPath, ["scripts/acceptance-evidence.mjs", "--output", outputPath], {
      cwd: resolve("."),
      env: { ...process.env, ACCEPTANCE_ARTIFACTS_DIR: artifactsRoot, MAP_DATA_DIR: join(root, "map") },
      windowsHide: true
    })
  } catch (error) {
    assert.equal(error.code, 1, `unexpected acceptance command failure: ${error}`)
  }

  const report = JSON.parse(await readFile(outputPath, "utf8"))
  assert.equal(check(report, "SOFTWARE-UPGRADE").status, "PENDING")
  assert.match(check(report, "SOFTWARE-UPGRADE").message, /环境阻断/)
})

test("environment-blocked resource lifecycle evidence remains pending", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wurenji-acceptance-blocked-resource-"))
  const artifactsRoot = join(root, "artifacts")
  const outputPath = join(root, "acceptance.json")
  context.after(() => rm(root, { recursive: true, force: true }))

  await writeEvidence(artifactsRoot, "resource-lifecycle/report.json", {
    format: "wurenji-resource-lifecycle-acceptance",
    generatedAt: "2026-09-27T10:00:00.000Z",
    status: "BLOCKED",
    reason: "正式资源验收夹具不存在"
  })

  try {
    await execFile(process.execPath, ["scripts/acceptance-evidence.mjs", "--output", outputPath], {
      cwd: resolve("."),
      env: { ...process.env, ACCEPTANCE_ARTIFACTS_DIR: artifactsRoot, MAP_DATA_DIR: join(root, "map") },
      windowsHide: true
    })
  } catch (error) {
    assert.equal(error.code, 1, `unexpected acceptance command failure: ${error}`)
  }

  const report = JSON.parse(await readFile(outputPath, "utf8"))
  assert.equal(check(report, "RESOURCE-LIFECYCLE").status, "PENDING")
  assert.match(check(report, "RESOURCE-LIFECYCLE").message, /环境阻断/)
})

test("environment-blocked class concurrency evidence remains pending", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wurenji-acceptance-blocked-class-"))
  const artifactsRoot = join(root, "artifacts")
  const outputPath = join(root, "acceptance.json")
  context.after(() => rm(root, { recursive: true, force: true }))

  await writeEvidence(artifactsRoot, "class-concurrency/report.json", {
    format: "wurenji-class-concurrency-smoke",
    generatedAt: "2026-09-27T10:00:00.000Z",
    status: "BLOCKED",
    summary: { total: 0, passed: 0, failed: 0 },
    reason: "应用健康探针不可用"
  })

  try {
    await execFile(process.execPath, ["scripts/acceptance-evidence.mjs", "--output", outputPath], {
      cwd: resolve("."),
      env: { ...process.env, ACCEPTANCE_ARTIFACTS_DIR: artifactsRoot, MAP_DATA_DIR: join(root, "map") },
      windowsHide: true
    })
  } catch (error) {
    assert.equal(error.code, 1, `unexpected acceptance command failure: ${error}`)
  }

  const report = JSON.parse(await readFile(outputPath, "utf8"))
  assert.equal(check(report, "CLASS-CONCURRENCY").status, "PENDING")
})

test("failed class concurrency evidence cannot pass without a failure count", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "wurenji-acceptance-failed-class-"))
  const artifactsRoot = join(root, "artifacts")
  const outputPath = join(root, "acceptance.json")
  context.after(() => rm(root, { recursive: true, force: true }))

  await writeEvidence(artifactsRoot, "class-concurrency/report.json", {
    format: "wurenji-class-concurrency-smoke",
    generatedAt: "2026-09-27T10:00:00.000Z",
    status: "FAILED",
    reason: "并发隔离断言失败"
  })

  try {
    await execFile(process.execPath, ["scripts/acceptance-evidence.mjs", "--output", outputPath], {
      cwd: resolve("."),
      env: { ...process.env, ACCEPTANCE_ARTIFACTS_DIR: artifactsRoot, MAP_DATA_DIR: join(root, "map") },
      windowsHide: true
    })
  } catch (error) {
    assert.equal(error.code, 1, `unexpected acceptance command failure: ${error}`)
  }

  const report = JSON.parse(await readFile(outputPath, "utf8"))
  assert.equal(check(report, "CLASS-CONCURRENCY").status, "FAIL")
})

async function writeEvidence(root, relativePath, value) {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function check(report, code) {
  const result = report.checks.find((item) => item.code === code)
  assert(result, `missing check ${code}`)
  return result
}
