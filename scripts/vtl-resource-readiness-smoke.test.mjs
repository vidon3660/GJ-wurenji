import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

test("passes when one VTL region has all formal map resources ready", async (context) => {
  const fixture = await createFixture(context, readiness(true))
  const report = await runSmoke(fixture)

  assert.equal(report.status, "PASSED")
  assert.equal(report.summary.formalReadyRegions, 1)
  assert.equal(report.regions[0].contractValid, true)
  assert.deepEqual(report.regions[0].checks.map((check) => check.kind), ["TERRAIN", "IMAGERY", "ELEVATION_SNAPSHOT"])
})

test("keeps a teaching fallback pending and preserves each missing resource reason", async (context) => {
  const fixture = await createFixture(context, readiness(false))
  const report = await runSmoke(fixture)

  assert.equal(report.status, "PENDING")
  assert.equal(report.summary.formalReadyRegions, 0)
  assert.equal(report.summary.contractFailed, false)
  assert.deepEqual(report.regions[0].checks.map((check) => check.status), ["MISSING", "UNCONFIGURED", "MISSING"])
})

test("fails when readiness identity does not match the selected region package", async (context) => {
  const value = readiness(true)
  value.regionPackageId = "other-region"
  const fixture = await createFixture(context, value)
  await assert.rejects(runSmoke(fixture))
  const report = JSON.parse(await readFile(fixture.outputPath, "utf8"))

  assert.equal(report.status, "FAILED")
  assert.equal(report.summary.contractFailed, true)
  assert.equal(report.regions[0].identityMatches, false)
})

async function createFixture(context, readinessValue) {
  const root = await mkdtemp(join(tmpdir(), "wurenji-vtl-resource-readiness-"))
  const outputPath = join(root, "report.json")
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/api/auth/login" && request.method === "POST") {
      response.statusCode = 201
      response.setHeader("Set-Cookie", "wurenji_token=test-token; Path=/; HttpOnly")
      response.end(JSON.stringify({ user: { role: "teacher" } }))
      return
    }
    if (request.headers.cookie !== "wurenji_token=test-token") {
      response.statusCode = 401
      response.end(JSON.stringify({ message: "unauthorized" }))
      return
    }
    if (request.url === "/api/v3/resource-packages/regions/catalog?sceneType=VTOL_INSPECTION") {
      response.end(JSON.stringify([{ packageId: "region-1", regionCode: "VTL-FORMAL-01", title: "正式巡检区", packageVersion: "1.0.0" }]))
      return
    }
    if (request.url === "/api/v3/resource-packages/regions/region-1/readiness") {
      response.end(JSON.stringify(readinessValue))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ message: "not found" }))
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, outputPath }
}

async function runSmoke(fixture) {
  await execFile(process.execPath, ["scripts/vtl-resource-readiness-smoke.mjs", "--base-url", fixture.baseUrl, "--output", fixture.outputPath], {
    cwd: resolve("."),
    env: { ...process.env, ACCEPTANCE_TARGET_LABEL: "target-lab" },
    windowsHide: true
  })
  return JSON.parse(await readFile(fixture.outputPath, "utf8"))
}

function readiness(formalReady) {
  return {
    regionPackageId: "region-1",
    regionCode: "VTL-FORMAL-01",
    packageVersion: "1.0.0",
    checkedAt: "2026-08-20T00:00:00.000Z",
    formalReady,
    checks: [
      check("TERRAIN", formalReady ? "READY" : "MISSING", formalReady ? "DEM ready" : "DEM missing"),
      check("IMAGERY", formalReady ? "READY" : "UNCONFIGURED", formalReady ? "Imagery ready" : "Imagery unconfigured"),
      check("ELEVATION_SNAPSHOT", formalReady ? "READY" : "MISSING", formalReady ? "Elevation ready" : "Elevation missing")
    ]
  }
}

function check(kind, status, message) {
  return { kind, status, required: true, message, expectedSha256: null, actualSha256: null }
}
