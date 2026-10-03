import assert from "node:assert/strict"
import { execFile as execFileCallback } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

test("requires formal map resources in all three scenes", async (context) => {
  const fixture = await createFixture(context, true)
  const report = await runSmoke(fixture)

  assert.equal(report.status, "PASSED")
  assert.equal(report.summary.formalReadyScenes, 3)
  assert.equal(report.summary.byScene.CITY_SHOW.formalReadyRegions, 1)
  assert.equal(report.summary.byScene.CITY_LOGISTICS.formalReadyRegions, 1)
  assert.equal(report.summary.byScene.VTOL_INSPECTION.formalReadyRegions, 1)
  assert.equal(report.regions.length, 3)
})

test("keeps the target gate pending when one scene lacks formal resources", async (context) => {
  const fixture = await createFixture(context, false)
  const report = await runSmoke(fixture)

  assert.equal(report.status, "PENDING")
  assert.equal(report.summary.formalReadyScenes, 2)
  assert.equal(report.summary.byScene.CITY_LOGISTICS.formalReadyRegions, 0)
})

test("waits for the database readiness probe before authenticating", async (context) => {
  const fixture = await createFixture(context, true, 2)
  const report = await runSmoke(fixture)

  assert.equal(report.status, "PASSED")
  assert.equal(report.summary.totalRegions, 3)
})

async function createFixture(context, allReady, readinessFailures = 0) {
  const root = await mkdtemp(join(tmpdir(), "wurenji-map-resource-readiness-"))
  const outputPath = join(root, "report.json")
  let readinessRequests = 0
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json")
    if (request.url === "/api/readyz" && request.method === "GET") {
      readinessRequests += 1
      if (readinessRequests <= readinessFailures) {
        response.statusCode = 503
        response.end(JSON.stringify({ message: "database is starting" }))
        return
      }
      response.end(JSON.stringify({ status: "ready", database: "ok" }))
      return
    }
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
    const catalog = request.url?.match(/^\/api\/v3\/resource-packages\/regions\/catalog\?sceneType=(CITY_SHOW|CITY_LOGISTICS|VTOL_INSPECTION)$/)
    if (catalog) {
      const sceneType = catalog[1]
      response.end(JSON.stringify([{ packageId: `${sceneType}-region`, regionCode: `${sceneType}-01`, title: sceneType, packageVersion: "1.0.0" }]))
      return
    }
    const readiness = request.url?.match(/^\/api\/v3\/resource-packages\/regions\/([^/]+)\/readiness$/)
    if (readiness) {
      const packageId = decodeURIComponent(readiness[1])
      const sceneType = packageId.replace(/-region$/, "")
      const formalReady = allReady || sceneType !== "CITY_LOGISTICS"
      response.end(JSON.stringify({
        regionPackageId: packageId,
        regionCode: `${sceneType}-01`,
        packageVersion: "1.0.0",
        formalReady,
        checks: [
          check("TERRAIN", formalReady ? "READY" : "UNCONFIGURED", "DEM"),
          check("IMAGERY", formalReady ? "READY" : "UNCONFIGURED", "影像"),
          check("ELEVATION_SNAPSHOT", formalReady ? "READY" : "UNCONFIGURED", "高程快照")
        ]
      }))
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
  await execFile(process.execPath, ["scripts/map-resource-readiness-smoke.mjs", "--base-url", fixture.baseUrl, "--output", fixture.outputPath], {
    cwd: resolve("."),
    env: { ...process.env, ACCEPTANCE_TARGET_LABEL: "target-lab" },
    windowsHide: true
  })
  return JSON.parse(await readFile(fixture.outputPath, "utf8"))
}

function check(kind, status, message) {
  return { kind, status, required: true, message }
}
