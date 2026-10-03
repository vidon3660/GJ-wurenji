import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

test("missing target evidence remains pending instead of failing", async (context) => {
  const fixture = await createFixture(context)
  const report = await runAcceptance(fixture, "target-lab")

  assert.equal(report.status, "PENDING")
  assert.equal(report.summary.failed, 0)
  for (const code of ["SECURITY", "DEPLOYMENT", "BACKUP-RESTORE", "SOFTWARE-UPGRADE"]) {
    assert.equal(check(report, code).status, "PENDING")
  }
})

test("target evidence selection prefers a matching label over newer foreign evidence", async (context) => {
  const fixture = await createFixture(context)
  await writeEvidence(fixture.artifactsRoot, "security/matching.json", {
    format: "wurenji-security-smoke",
    generatedAt: new Date().toISOString(),
    environment: { targetLabel: "target-lab" },
    summary: { total: 13, passed: 13, failed: 0 }
  })
  await writeEvidence(fixture.artifactsRoot, "security/newer-foreign.json", {
    format: "wurenji-security-smoke",
    generatedAt: new Date(Date.now() + 1_000).toISOString(),
    environment: { targetLabel: "other-lab" },
    summary: { total: 13, passed: 12, failed: 1 }
  })

  const report = await runAcceptance(fixture, "target-lab")

  assert.equal(check(report, "SECURITY").status, "PASS")
  assert.match(check(report, "SECURITY").evidence, /matching[.]json$/)
  assert.equal(report.summary.failed, 0)
})

test("matching VTL long-run evidence enters the target gate", async (context) => {
  const fixture = await createFixture(context)
  await writeEvidence(fixture.artifactsRoot, "performance/vtl-long-run.json", {
    format: "wurenji-browser-runtime-baseline",
    generatedAt: new Date().toISOString(),
    environment: { targetLabel: "target-lab" },
    results: [{
      sceneType: "VTOL_INSPECTION",
      scale: { qualified: true, consistent: true, actual: { aircraft: 20 } },
      rendering: { durationMs: 30 * 60_000 },
      checks: { functionalPassed: true, streamStayedLive: true, memoryGrowthWithinLimit: true },
      browserMemory: { peakGrowthBytes: 32 * 1024 * 1024 }
    }]
  })

  const report = await runAcceptance(fixture, "target-lab")

  assert.equal(check(report, "BROWSER-VTL-LONG-RUN").status, "PASS")
})

test("matching formal VTL map evidence enters the target gate", async (context) => {
  const fixture = await createFixture(context)
  await writeEvidence(fixture.artifactsRoot, "vtl-resources/formal-ready.json", {
    format: "wurenji-vtl-resource-readiness",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    status: "PASSED",
    environment: { targetLabel: "target-lab" },
    summary: { totalRegions: 1, formalReadyRegions: 1, pendingRegions: 0, contractFailed: false },
    regions: [{ packageId: "region-1", regionCode: "VTL-FORMAL-01", formalReady: true }]
  })

  const report = await runAcceptance(fixture, "target-lab")

  assert.equal(check(report, "VTL-FORMAL-MAP-RESOURCES").status, "PASS")
  assert.match(check(report, "VTL-FORMAL-MAP-RESOURCES").evidence, /formal-ready[.]json$/)
})

test("separate browser reports merge into exact three-scene scale evidence", async (context) => {
  const fixture = await createFixture(context)
  const generatedAt = new Date().toISOString()
  const reports = [
    ["show.json", "CITY_SHOW", { aircraft: 3000 }],
    ["logistics.json", "CITY_LOGISTICS", { aircraft: 50, orders: 100 }],
    ["vtl.json", "VTOL_INSPECTION", { aircraft: 20 }]
  ]
  for (const [filename, sceneType, actual] of reports) {
    await writeEvidence(fixture.artifactsRoot, `performance/${filename}`, {
      format: "wurenji-browser-runtime-baseline",
      generatedAt,
      environment: { targetLabel: "target-lab" },
      results: [{
        sceneType,
        scale: { qualified: true, consistent: true, actual },
        rendering: { durationMs: 30 * 60_000 },
        checks: { functionalPassed: true, streamStayedLive: true, memoryGrowthWithinLimit: true },
        browserMemory: { peakGrowthBytes: 32 * 1024 * 1024 }
      }]
    })
  }

  const report = await runAcceptance(fixture, "target-lab")

  for (const code of ["BROWSER-SHOW-SCALE", "BROWSER-LOGISTICS-SCALE", "BROWSER-VTL-SCALE", "BROWSER-SHOW-LONG-RUN", "BROWSER-LOGISTICS-LONG-RUN", "BROWSER-VTL-LONG-RUN"]) {
    assert.equal(check(report, code).status, "PASS")
  }
  assert.match(check(report, "BROWSER-SHOW-SCALE").evidence, /show[.]json$/)
  assert.match(check(report, "BROWSER-LOGISTICS-SCALE").evidence, /logistics[.]json$/)
  assert.match(check(report, "BROWSER-VTL-SCALE").evidence, /vtl[.]json$/)
})

test("stale target evidence returns to pending", async (context) => {
  const fixture = await createFixture(context)
  await writeEvidence(fixture.artifactsRoot, "security/stale.json", {
    format: "wurenji-security-smoke",
    generatedAt: new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
    environment: { targetLabel: "target-lab" },
    summary: { total: 13, passed: 13, failed: 0 }
  })

  const report = await runAcceptance(fixture, "target-lab")

  assert.equal(check(report, "SECURITY").status, "PENDING")
  assert.match(check(report, "SECURITY").message, /超过 168 小时有效期/)
})

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "wurenji-target-acceptance-"))
  const artifactsRoot = join(root, "artifacts")
  const outputPath = join(root, "report.json")
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/api/healthz") response.end(JSON.stringify({ status: "ok" }))
    else if (request.url === "/api/readyz") response.end(JSON.stringify({ status: "ready", database: "ok" }))
    else { response.statusCode = 404; response.end(JSON.stringify({ status: "not-found" })) }
  })
  await new Promise((resolveListen, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const address = server.address()
  assert(address && typeof address === "object")
  context.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose))
    await rm(root, { recursive: true, force: true })
  })
  return { artifactsRoot, outputPath, baseUrl: `http://127.0.0.1:${address.port}` }
}

async function runAcceptance(fixture, targetLabel) {
  await execFile(process.execPath, ["scripts/target-environment-acceptance.mjs", "--output", fixture.outputPath], {
    cwd: resolve("."),
    env: {
      ...process.env,
      ACCEPTANCE_ARTIFACTS_DIR: fixture.artifactsRoot,
      APP_BASE_URL: fixture.baseUrl,
      TARGET_ACCEPTANCE_ALLOW_HTTP: "true",
      TARGET_ACCEPTANCE_TARGET_LABEL: targetLabel
    },
    windowsHide: true
  })
  return JSON.parse(await readFile(fixture.outputPath, "utf8"))
}

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
