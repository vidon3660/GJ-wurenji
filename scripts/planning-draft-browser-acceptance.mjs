/**
 * Run: node scripts/planning-draft-browser-acceptance.mjs
 * Real Chromium, Vue workspace, Element Plus and Cesium; API responses are local
 * fixtures, never a database/backend. Terrain/imagery use the teaching fallback.
 * Requires built shared/simulation packages and Chromium (or CHROME_PATH).
 */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { planningProject, planningSnapshot, planningRegion, planningWorkspace } from "../apps/web/src/test-fixtures/planning-draft.ts"
import { createServer } from "vite"
import { chromium } from "playwright-core"

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const webRoot = resolve(repository, "apps/web")
const artifactDirectory = resolve(repository, "artifacts/planning-draft-browser")
await mkdir(artifactDirectory, { recursive: true })
const executablePath = [process.env.CHROME_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome"].find((path) => path && existsSync(path))
if (!executablePath) throw new Error("Chromium unavailable; set CHROME_PATH")

// Node 24 strips the fixture types; no test runner or source evaluation is needed.
const fixture = { workspace: planningWorkspace, region: planningRegion }
const parentFixture = { project: planningProject, snapshot: planningSnapshot }
const clone = (value) => JSON.parse(JSON.stringify(value))
const virtualId = "virtual:planning-draft-acceptance"
const virtualModule = `
  import { createApp, h } from 'vue';
  import ElementPlus from 'element-plus';
  import 'element-plus/dist/index.css';
  import '/src/style.css';
  import Workspace from '/src/components/V3ProjectWorkspaceView.vue';
  window.__planningAcceptance = { backCount: 0 };
  createApp({ render: () => h(Workspace, {
    user: { id: 'student-1', email: 'student@example.com', displayName: '验收学生', role: 'student' },
    projectId: 'project-1', onBack: () => window.__planningAcceptance.backCount++
  }) }).use(ElementPlus).mount('#app');
`
let browser
let server
const report = {
  generatedAt: new Date().toISOString(),
  boundary: "Real V3ProjectWorkspaceView, V3VtlPlanningWorkspace, Element Plus dialogs/CSS, Cesium WebGL and Chromium; all /api requests are intercepted local fixtures. No database, account, production API, formal imagery/DEM or backend validation is exercised.",
  scenarios: [],
  passed: false
}
try {
  server = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, "vite.config.ts"),
    envDir: resolve(artifactDirectory, "no-env-files"),
    server: { host: "127.0.0.1", port: 0, open: false, hmr: false },
    plugins: [{
      name: "planning-draft-acceptance-harness",
      resolveId(id) { if (id === virtualId) return `\0${virtualId}` },
      load(id) { if (id === `\0${virtualId}`) return virtualModule },
      configureServer(vite) {
        vite.middlewares.use("/__planning_acceptance", (_request, response) => {
          response.setHeader("Content-Type", "text/html; charset=utf-8")
          response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Planning draft acceptance — mock API</title></head><body><div id="app"></div><script type="module" src="/@id/${virtualId}"></script></body></html>`)
        })
      }
    }]
  })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"] })
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    report.scenarios.push(await runScenario(browser, origin, viewport))
  }
  report.passed = report.scenarios.every((scenario) => scenario.passed)
} catch (error) {
  report.error = error.stack ?? String(error)
} finally {
  await browser?.close()
  await server?.close()
  const output = resolve(artifactDirectory, "acceptance.json")
  await writeFile(output, JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ passed: report.passed, output, scenarios: report.scenarios.map(({ viewport, passed, error }) => ({ viewport, passed, error })), error: report.error }, null, 2))
  if (!report.passed) process.exitCode = 1
}

async function runScenario(browser, origin, viewport) {
  const context = await browser.newContext({ viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const result = { viewport, passed: false, checks: [], pageErrors: [], consoleErrors: [], unexpectedRequests: [], mutations: [], screenshots: [] }
  const project = clone(parentFixture.project)
  project.mode = "TRAINING"
  project.currentStageCode = "VTL_ROUTE_PLANNING"
  project.stages = [
    { stageCode: "VTL_ROUTE_PLANNING", sequence: 1, title: "航线规划", description: "编辑双机巡检航线", openCondition: "分配完成", status: "IN_PROGRESS", revision: 1, allowedActions: [] },
    { stageCode: "VTL_RUNTIME", sequence: 2, title: "仿真运行", description: "执行巡检", openCondition: "规划完成", status: "LOCKED", revision: 1, allowedActions: [] }
  ]
  const snapshot = clone(parentFixture.snapshot)
  snapshot.mode = "TRAINING"
  delete snapshot.config.questionBankVersionId
  let workspace = clone(fixture.workspace())
  const region = clone(fixture.region)
  region.title = "本地验收教学区域 · API fixture"
  region.boundary = [{ longitude: 119.99, latitude: 29.99 }, { longitude: 120.02, latitude: 29.99 }, { longitude: 120.02, latitude: 30.02 }, { longitude: 119.99, latitude: 30.02 }]
  workspace.region = region
  for (const route of workspace.plan.routes) {
    route.waypoints.push({ ...clone(route.waypoints[0]), id: "return-waypoint", sequence: 1, phase: "RETURN", taskObjectId: null, position: { longitude: 120.002, latitude: 30.002, altitudeMeters: 150 } })
  }
  let failNextPut = false
  let holdNextPut = false
  let releasePut
  page.on("pageerror", (error) => { result.pageErrors.push(error.stack || error.message || String(error)); console.error(`[${viewport.width}] pageerror: ${error.stack || error.message || String(error)}`) })
  page.on("console", (message) => {
    if (message.type() === "error") { result.consoleErrors.push(message.text()); console.error(`[${viewport.width}] console: ${message.text()}`) }
  })
  await page.addInitScript(() => {
    window.__planningRawErrors = []
    window.addEventListener("error", (event) => window.__planningRawErrors.push({
      message: event.message, name: event.error?.name, detail: event.error?.message,
      stack: event.error?.stack, text: String(event.error),
      properties: event.error ? Object.fromEntries(Object.getOwnPropertyNames(event.error).map((name) => [name, String(event.error[name])])) : {}
    }))
  })
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const send = (value) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) })
    if (method === "GET" && path.endsWith("/stages")) return send(project)
    if (method === "GET" && path.endsWith("/snapshot")) return send(snapshot)
    if (method === "GET" && path.includes("/resource-packages/regions/")) return send(region)
    if (method === "GET" && path.endsWith("/activities")) return send([])
    if (method === "GET" && path.endsWith("/planning-workspace")) return send(workspace)
    const body = request.postDataJSON()
    result.mutations.push({ method, path, body })
    if (method === "PUT" && /\/routes\/aircraft-[ab]$/.test(path)) {
      if (failNextPut) { failNextPut = false; return route.abort("internetdisconnected") }
      if (holdNextPut) { holdNextPut = false; await new Promise((resolve) => { releasePut = resolve }) }
      workspace.plan.revision += 1
      const saved = workspace.plan.routes.find((item) => path.endsWith(`/routes/${item.aircraftId}`))
      Object.assign(saved, { revision: workspace.plan.revision, transitionHeightMeters: body.transitionHeightMeters, alternateLandingSiteId: body.alternateLandingSiteId, waypoints: body.waypoints })
      return send(workspace)
    }
    if (method === "POST" && path.endsWith("/routes/complete")) { workspace.plan.revision += 1; return send(workspace) }
    result.unexpectedRequests.push({ method, path })
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "Unconfigured acceptance fixture" }) })
  })
  const height = page.locator(".route-parameters input")
  const longitude = page.locator(".waypoint-list article").first().locator("input").nth(0)
  const aircraft = page.getByLabel("编辑航空器", { exact: true })
  const unsaved = page.locator(".unsaved-state")
  async function check(name, action) {
    console.log(`[${viewport.width}] ${name}`)
    await action()
    result.checks.push({ name, passed: true })
  }
  async function screenshot(name) {
    const path = resolve(artifactDirectory, `${viewport.width}-${name}.png`)
    await page.waitForFunction(() => document.querySelectorAll(".el-message").length === 0)
    await page.evaluate(() => {
      window.scrollTo(0, 0)
      for (const element of [document.documentElement, document.body, document.querySelector('#app'), document.querySelector('.v3-project-shell')]) if (element) element.scrollLeft = 0
    })
    await page.screenshot({ path, fullPage: true })
    result.screenshots.push(path)
  }
  async function cancelDialog() {
    await page.locator(".el-message-box").getByRole("button", { name: "继续编辑", exact: true }).click()
    await page.locator(".el-message-box").waitFor({ state: "hidden" })
  }
  async function assertDraft() {
    assert.equal(await height.inputValue(), "125")
    assert.equal(await longitude.inputValue(), "120.003")
    assert.equal(await aircraft.inputValue(), "aircraft-a")
    assert.equal(await unsaved.count(), 1)
  }
  try {
    await page.goto(`${origin}/__planning_acceptance`, { waitUntil: "domcontentloaded" })
    await height.waitFor({ timeout: 90_000 })
    await page.locator(".cesium-widget canvas").waitFor({ timeout: 90_000 })
    await page.waitForFunction(() => document.querySelector(".v3-map-scale-bar")?.__vueParentComponent?.props?.viewer?.scene.mode === 2)
    await height.fill("125")
    await longitude.fill("120.003")
    await check("waypoint and transition edits mark draft dirty", assertDraft)
    await check("six real Cesium 2D/3D switches retain the draft", async () => {
      result.mapSwitches = []
      for (const mode of ["3D", "2D", "3D", "2D", "3D", "2D"]) {
        await page.getByRole("button", { name: mode === "2D" ? "2D 精确规划视角" : "3D 空间理解视角", exact: true }).click()
        await page.waitForFunction((expected) => {
          const viewer = document.querySelector(".v3-map-scale-bar")?.__vueParentComponent?.props?.viewer
          return viewer && !viewer.isDestroyed() && viewer.scene.mode === expected
        }, mode === "2D" ? 2 : 3)
        await assertDraft()
        result.mapSwitches.push(await page.evaluate(() => {
          const viewer = document.querySelector(".v3-map-scale-bar").__vueParentComponent.props.viewer
          return { sceneMode: viewer.scene.mode, morphListeners: viewer.scene.morphComplete.numberOfListeners, webgl: Boolean(viewer.scene.context), destroyed: viewer.isDestroyed() }
        }))
      }
      assert.equal(new Set(result.mapSwitches.map((item) => item.morphListeners)).size, 1)
    })
    await screenshot("edited-map")
    await check("simulation navigation cancellation retains editor and draft", async () => {
      await page.locator(".simulation-command").click()
      await cancelDialog()
      await assertDraft()
    })
    await check("return navigation cancellation retains editor and draft", async () => {
      await page.getByRole("button", { name: "返回教学首页", exact: true }).click()
      await cancelDialog()
      await assertDraft()
      assert.equal(await page.evaluate(() => window.__planningAcceptance.backCount), 0)
    })
    await check("aircraft switch cancellation retains selection and draft", async () => {
      await aircraft.selectOption("aircraft-b")
      await cancelDialog()
      await assertDraft()
    })
    await screenshot("cancelled-navigation")
    await check("confirmed aircraft switch loads its saved route", async () => {
      await aircraft.selectOption("aircraft-b")
      await page.locator(".el-message-box").getByRole("button", { name: "切换航空器", exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.vtl-panel > select')?.value === 'aircraft-b')
      assert.equal(await height.inputValue(), "90")
      assert.equal(await unsaved.count(), 0)
      await aircraft.selectOption("aircraft-a")
    })
    await check("offline completion save retains draft; retry saves before completing", async () => {
      await height.fill("125")
      await longitude.fill("120.003")
      failNextPut = true
      const start = result.mutations.length
      await page.getByRole("button", { name: "完成航线规划", exact: true }).click()
      await page.waitForFunction(() => !document.querySelector('.vtl-command-actions button.primary')?.disabled)
      await assertDraft()
      assert.deepEqual(result.mutations.slice(start).map((item) => item.method), ["PUT"])
      await page.getByRole("button", { name: "完成航线规划", exact: true }).click()
      await unsaved.waitFor({ state: "detached" })
      const calls = result.mutations.slice(start)
      assert.deepEqual(calls.map((item) => item.method), ["PUT", "PUT", "POST"])
      assert.equal(calls[2].body.expectedRevision, calls[1].body.expectedRevision + 1)
      assert.equal(calls[1].body.waypoints[0].position.longitude, 120.003)
    })
    await check("repeated save/completion clicks issue only one pending PUT", async () => {
      await height.fill("130")
      holdNextPut = true
      const start = result.mutations.length
      await page.getByRole("button", { name: "保存航线", exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.vtl-command-actions button.primary')?.disabled)
      await page.getByRole("button", { name: "保存航线", exact: true }).evaluate((button) => { button.click(); button.click() })
      await page.getByRole("button", { name: "完成航线规划", exact: true }).evaluate((button) => button.click())
      assert.equal(result.mutations.length - start, 1)
      releasePut()
      releasePut = undefined
      await unsaved.waitFor({ state: "detached" })
      assert.equal(result.mutations.length - start, 1)
    })
    await screenshot("saved")
    assert.deepEqual(result.unexpectedRequests, [])
    assert.deepEqual(result.pageErrors, [])
    assert.deepEqual(result.consoleErrors.filter((message) => !message.includes("net::ERR_INTERNET_DISCONNECTED")), [])
    result.rawErrors = await page.evaluate(() => window.__planningRawErrors)
    assert.deepEqual(result.rawErrors, [])
    result.passed = true
  } catch (error) {
    result.error = error.stack ?? String(error)
    await screenshot("failure").catch(() => {})
  } finally {
    result.rawErrors = await page.evaluate(() => window.__planningRawErrors).catch(() => [])
    releasePut?.()
    await context.close()
  }
  return result
}
