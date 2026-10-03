import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const apiOrigin = appUrl.replace(/\/api$/i, "")
const outputPath = resolve(process.env.RUNTIME_STREAM_BROWSER_ALL_OUTPUT ?? "artifacts/runtime-stream/runtime-stream-browser-acceptance-all-latest.json")
const fixturePath = resolve(process.env.RUNTIME_STREAM_BROWSER_ALL_FIXTURE ?? "artifacts/runtime-stream/race-fixture.json")
const logisticsFixturePath = resolve(process.env.RUNTIME_STREAM_BROWSER_ALL_LOGISTICS_FIXTURE ?? "artifacts/stu013-logistics-alert-browser-fixture-latest.json")
const vtlFixturePath = resolve(process.env.RUNTIME_STREAM_BROWSER_ALL_VTL_FIXTURE ?? "artifacts/runtime-stream/vtl-runtime-active-fixture-current-3000.json")
const abortAttempts = Number(process.env.RUNTIME_STREAM_ABORT_ATTEMPTS ?? 3)
const scenes = requestedScenes()

if (!Number.isInteger(abortAttempts) || abortAttempts < 1 || abortAttempts > 10) throw new Error("RUNTIME_STREAM_ABORT_ATTEMPTS 必须是 1 到 10 的整数")

const fixtures = {
  CITY_SHOW: await readFixture(fixturePath, "CITY_SHOW"),
  CITY_LOGISTICS: await readFixture(logisticsFixturePath, "CITY_LOGISTICS"),
  VTOL_INSPECTION: await readFixture(vtlFixturePath, "VTOL_INSPECTION")
}

const definitions = {
  CITY_SHOW: {
    sceneLabel: "城市表演",
    homeTab: "表演",
    stagePattern: /表演运行/,
    workspaceSelector: ".show-runtime-workspace",
    streamSelector: ".runtime-stream-status",
    runtimePath: (projectId) => `/api/v3/show-projects/${projectId}/runtime`,
    streamPath: (projectId) => `/api/v3/show-projects/${projectId}/runtime/stream`
  },
  CITY_LOGISTICS: {
    sceneLabel: "城市物流",
    homeTab: "物流",
    stagePattern: /配送运行/,
    workspaceSelector: ".logistics-runtime-workspace",
    streamSelector: ".runtime-stream-status",
    runtimePath: (projectId) => `/api/v3/logistics-projects/${projectId}/runtime-workspace`,
    streamPath: (projectId) => `/api/v3/logistics-projects/${projectId}/runtime/stream`
  },
  VTOL_INSPECTION: {
    sceneLabel: "垂起巡检",
    homeTab: "巡检",
    stagePattern: /巡检运行/,
    workspaceSelector: ".vtl-runtime-workspace",
    streamSelector: ".stream-state",
    runtimePath: (projectId) => `/api/v3/vtl-projects/${projectId}/runtime`,
    streamPath: (projectId) => `/api/v3/vtl-projects/${projectId}/runtime/stream`
  }
}

const browserPath = browserExecutable()
const browser = await chromium.launch({ executablePath: browserPath, headless: process.env.HEADLESS !== "false" })
const results = []

try {
  for (const sceneType of scenes) results.push(await acceptScene(sceneType))
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-runtime-stream-browser-acceptance-all",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  appUrl,
  abortAttempts,
  scenes,
  results,
  passed: results.length > 0 && results.every((result) => result.passed)
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, scenes: results.map(({ sceneType, passed }) => ({ sceneType, passed })) }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function acceptScene(sceneType) {
  const definition = definitions[sceneType]
  const fixture = fixtures[sceneType]
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  const failedRequests = []
  let streamRequests = 0
  let abortedStreamCount = 0
  let runtimeSnapshotResponses = 0
  let fallbackStateSeen = false

  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)") && !message.text().includes("ERR_FAILED")) errors.push(message.text())
  })
  page.on("requestfailed", (request) => {
    if (request.url().includes("/runtime/stream") && abortedStreamCount > 0) return
    if (request.url().includes("/api/")) failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
  })
  page.on("response", (response) => {
    if (response.status() === 200 && new URL(response.url()).pathname === definition.runtimePath(fixture.projectId)) runtimeSnapshotResponses += 1
  })
  await page.route(`**${definition.streamPath("*")}`.replace("*", "**"), async (route) => {
    streamRequests += 1
    if (abortedStreamCount < abortAttempts) {
      abortedStreamCount += 1
      await route.abort("failed")
      return
    }
    await route.continue()
  })

  try {
    await loginPage(page)
    await openProject(page, definition, fixture)
    await page.locator(definition.workspaceSelector).waitFor({ timeout: 15_000 })
    await page.locator(`${definition.workspaceSelector} canvas`).waitFor({ timeout: 15_000 })

    const before = await runtimeSnapshot(page, definition.runtimePath(fixture.projectId))
    const responseBaseline = runtimeSnapshotResponses
    const stateAfterLoad = await connectionState(page, definition)
    const fallbackDeadline = Date.now() + 15_000
    while (Date.now() < fallbackDeadline) {
      const state = await connectionState(page, definition)
      if (state.includes("回退") || state.includes("重连")) fallbackStateSeen = true
      if (streamRequests >= abortAttempts && runtimeSnapshotResponses > responseBaseline && fallbackStateSeen) break
      await page.waitForTimeout(100)
    }
    const fallbackLoaded = runtimeSnapshotResponses > responseBaseline
    await page.locator(`${definition.workspaceSelector} ${definition.streamSelector}.live`).waitFor({ timeout: 20_000 })
    const after = await runtimeSnapshot(page, definition.runtimePath(fixture.projectId))
    const layout = await page.evaluate((selector) => {
      const canvas = document.querySelector(`${selector} canvas`)
      return {
        noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
        canvas: Boolean(canvas),
        canvasWidth: canvas?.getBoundingClientRect().width ?? 0,
        canvasHeight: canvas?.getBoundingClientRect().height ?? 0
      }
    }, definition.workspaceSelector)
    const checks = {
      firstStreamWasInterrupted: abortedStreamCount >= abortAttempts,
      fallbackSnapshotLoaded: fallbackLoaded,
      fallbackStateSeen,
      streamReconnected: await page.locator(`${definition.workspaceSelector} ${definition.streamSelector}.live`).count() === 1,
      revisionDidNotRegress: Number(after.session?.revision ?? 0) >= Number(before.session?.revision ?? 0),
      noUnexpectedErrors: errors.length === 0 && failedRequests.length === 0,
      layoutUsable: layout.noHorizontalOverflow && layout.canvasWidth > 0 && layout.canvasHeight > 0
    }
    return {
      sceneType,
      sceneLabel: definition.sceneLabel,
      projectId: fixture.projectId,
      title: fixture.title,
      streamRequests,
      abortedStreamCount,
      runtimeSnapshotResponses,
      states: { afterWorkspaceLoad: stateAfterLoad, final: await connectionState(page, definition) },
      revisions: { before: before.session?.revision ?? null, after: after.session?.revision ?? null },
      layout,
      errors,
      failedRequests,
      checks,
      passed: Object.values(checks).every(Boolean)
    }
  } finally {
    await page.unroute(`**/api/v3/${sceneType === "CITY_SHOW" ? "show-projects" : sceneType === "CITY_LOGISTICS" ? "logistics-projects" : "vtl-projects"}/*/runtime/stream`)
    await context.close()
  }
}

async function loginPage(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
  const demoLogin = page.getByRole("button", { name: "学生演示", exact: true })
  const platform = page.locator(".platform-shell")
  try {
    await demoLogin.first().click({ timeout: 15_000 })
  } catch (error) {
    if (await platform.count() === 0) throw error
  }
  await platform.waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click()
    await projectsReloaded
  }
}

async function openProject(page, definition, fixture) {
  await page.locator(".home-scene-segment button").filter({ hasText: definition.homeTab }).click()
  const search = page.locator(".student-task-search input")
  await search.waitFor({ timeout: 15_000 })
  await search.fill(fixture.title)
  const project = page.locator(`.v3-home-project-list > button[data-project-id="${fixture.projectId}"]`).or(
    page.locator(".v3-home-project-list > button").filter({ hasText: fixture.title })
  ).first()
  await project.waitFor({ timeout: 15_000 })
  await project.click({ timeout: 30_000 })
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".v3-stage-nav > button").filter({ hasText: definition.stagePattern }).click()
}

async function runtimeSnapshot(page, path) {
  return page.evaluate(async (snapshotPath) => {
    const response = await fetch(snapshotPath, { credentials: "include" })
    if (!response.ok) throw new Error(`运行快照读取失败：${response.status}`)
    return response.json()
  }, path)
}

async function connectionState(page, definition) {
  return page.locator(`${definition.workspaceSelector} ${definition.streamSelector}`).first().textContent().then((value) => value?.trim() ?? "")
}

async function readFixture(path, sceneType) {
  const fixture = JSON.parse(await readFile(path, "utf8"))
  const project = fixture.projectId && fixture.title ? fixture : fixture.projects?.[sceneType]
  if (!project?.projectId || !project.title) throw new Error(`${sceneType} 断线恢复夹具无效：${path}`)
  return project
}

function requestedScenes() {
  const raw = (process.env.RUNTIME_STREAM_SCENES ?? "CITY_SHOW,CITY_LOGISTICS,VTOL_INSPECTION").split(",").map((item) => item.trim()).filter(Boolean)
  const supported = new Set(["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"])
  if (!raw.length || raw.some((item) => !supported.has(item))) throw new Error(`RUNTIME_STREAM_SCENES 不支持：${raw.join(",")}`)
  return raw
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}
