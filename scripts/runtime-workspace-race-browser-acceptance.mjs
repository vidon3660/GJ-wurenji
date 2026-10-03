import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.RUNTIME_WORKSPACE_RACE_OUTPUT ?? "artifacts/runtime-stream/runtime-workspace-race-browser-acceptance-latest.json")
const fixture = JSON.parse(await readFile(resolve(process.env.RUNTIME_WORKSPACE_RACE_FIXTURE ?? "artifacts/performance/p0-long-fixture-current.json"), "utf8"))
const scenes = [
  {
    sceneType: "CITY_SHOW",
    homeTab: "表演",
    stagePattern: /表演运行/,
    workspaceSelector: ".show-runtime-workspace",
    runtimePath: (projectId) => `/api/v3/show-projects/${projectId}/runtime`,
    startPath: (projectId) => `/api/v3/show-projects/${projectId}/runtime/start`,
    mutatePath: (projectId) => `/api/v3/show-projects/${projectId}/runtime/clock-rate`,
    project: fixture.projects.CITY_SHOW
  },
  {
    sceneType: "CITY_LOGISTICS",
    homeTab: "物流",
    stagePattern: /配送运行/,
    workspaceSelector: ".logistics-runtime-workspace",
    runtimePath: (projectId) => `/api/v3/logistics-projects/${projectId}/runtime-workspace`,
    startPath: (projectId) => `/api/v3/logistics-projects/${projectId}/runtime/start`,
    mutatePath: (projectId) => `/api/v3/logistics-projects/${projectId}/runtime/clock`,
    project: fixture.projects.CITY_LOGISTICS
  }
]

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const results = []

try {
  for (const scene of scenes) results.push(await acceptScene(scene))
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-runtime-workspace-race-browser-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  appUrl,
  scenes: results,
  passed: results.length === scenes.length && results.every((result) => result.passed)
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, scenes: results.map(({ sceneType, passed }) => ({ sceneType, passed })) }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function acceptScene(scene) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  const failedRequests = []
  let held = false
  let holdRequests = false
  let releaseHeldResponse
  let resolveHeldResponse
  const heldResponse = new Promise((resolve) => { resolveHeldResponse = resolve })
  const release = new Promise((resolve) => { releaseHeldResponse = resolve })

  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)") && !message.text().includes("ERR_FAILED")) errors.push(message.text())
  })
  page.on("requestfailed", (request) => {
    if (request.url().includes("/runtime/stream")) return
    if (request.url().includes("/api/")) failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    if (holdRequests && !held && route.request().method() === "GET" && url.pathname === scene.runtimePath(scene.project.projectId)) {
      held = true
      const response = await route.fetch()
      const body = await response.body()
      resolveHeldResponse({ status: response.status(), headers: response.headers(), body })
      await release
      await route.fulfill({ status: response.status(), headers: response.headers(), body })
      return
    }
    await route.continue()
  })

  try {
    await loginPage(page)
    await openProject(page, scene, scene.project.title)
    await page.locator(scene.workspaceSelector).waitFor({ timeout: 15_000 })
    let baseline = await runtimeSnapshot(page, scene.runtimePath(scene.project.projectId))
    if (baseline.session.status === "READY") {
      await mutateRuntime(page, scene.startPath(scene.project.projectId), { expectedRevision: baseline.session.revision })
      baseline = await runtimeSnapshot(page, scene.runtimePath(scene.project.projectId))
    }
    if (!["RUNNING", "PAUSED"].includes(baseline.session.status)) throw new Error(`${scene.sceneType} 夹具当前状态为 ${baseline.session.status}，不能执行刷新竞态验收`)
    if (baseline.session.status === "RUNNING") {
      baseline = await pauseRuntime(page, scene, baseline)
    }
    holdRequests = true
    const refreshButton = page.locator(`${scene.workspaceSelector} button[title="刷新运行快照"], ${scene.workspaceSelector} .el-button[title="刷新运行快照"]`).first()
    await refreshButton.click()
    await heldResponse
    const mutationBaseline = await runtimeSnapshot(page, scene.runtimePath(scene.project.projectId))

    const mutation = await mutateRuntime(page, scene.mutatePath(scene.project.projectId), {
      expectedRevision: mutationBaseline.session.revision,
      rate: mutationBaseline.clockRate,
      status: mutationBaseline.session.status
    })
    const newRevision = mutation.session.revision
    await page.locator(`${scene.workspaceSelector}[data-runtime-revision="${newRevision}"]`).waitFor({ timeout: 15_000 })
    releaseHeldResponse()
    await page.waitForTimeout(500)
    const displayedRevision = await page.locator(scene.workspaceSelector).getAttribute("data-runtime-revision")
    const current = await runtimeSnapshot(page, scene.runtimePath(scene.project.projectId))
    const unexpectedErrors = errors.filter((item) => !item.includes("409 (Conflict)"))
    const checks = {
      staleResponseWasHeld: held,
      mutationAdvancedRevision: newRevision > mutationBaseline.session.revision,
      newerSnapshotDisplayed: Number(displayedRevision) === newRevision,
      staleResponseDidNotOverwrite: Number(displayedRevision) === newRevision,
      serverRevisionMatches: current.session.revision === newRevision,
      noUnexpectedErrors: unexpectedErrors.length === 0 && failedRequests.length === 0
    }
    return {
      sceneType: scene.sceneType,
      projectId: scene.project.projectId,
      baselineRevision: baseline.session.revision,
      mutationRevision: newRevision,
      displayedRevision: displayedRevision ? Number(displayedRevision) : null,
      errors,
      expectedConcurrencyConflicts: errors.length - unexpectedErrors.length,
      unexpectedErrors,
      failedRequests,
      checks,
      passed: Object.values(checks).every(Boolean)
    }
  } finally {
    await page.unroute("**/api/**")
    await context.close()
  }
}

async function loginPage(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
  const demoLogin = page.getByRole("button", { name: "学生演示", exact: true })
  if (await demoLogin.count() && await demoLogin.first().isVisible()) await demoLogin.first().click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const reloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click()
    await reloaded
  }
}

async function openProject(page, scene, title) {
  await page.locator(".home-scene-segment button").filter({ hasText: scene.homeTab }).click()
  await page.locator(".student-task-search input").fill(title)
  const project = page.locator(".v3-home-project-list > button").filter({ hasText: title }).first()
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".v3-stage-nav > button").filter({ hasText: scene.stagePattern }).click()
}

async function runtimeSnapshot(page, path) {
  return page.evaluate(async (snapshotPath) => {
    const response = await fetch(snapshotPath, { credentials: "include" })
    if (!response.ok) throw new Error(`运行快照读取失败：${response.status}`)
    return response.json()
  }, path)
}

async function mutateRuntime(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    const value = await response.json()
    if (!response.ok) throw new Error(`竞态推进请求失败：${response.status} ${JSON.stringify(value)}`)
    return value
  }, { path, body })
}

async function pauseRuntime(page, scene, initial) {
  let current = initial
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await mutateRuntime(page, scene.mutatePath(scene.project.projectId), {
        expectedRevision: current.session.revision,
        rate: current.clockRate,
        status: "PAUSED"
      })
    } catch (error) {
      if (attempt === 2) throw error
      current = await runtimeSnapshot(page, scene.runtimePath(scene.project.projectId))
    }
  }
  return current
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}
