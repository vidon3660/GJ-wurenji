import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const fixturePath = resolve(process.env.VTL_ALERT_FIXTURE_JSON ?? "artifacts/vtl-alert-browser-fixture-latest.json")
const outputPath = resolve(process.env.RUNTIME_STREAM_BROWSER_OUTPUT ?? "artifacts/runtime-stream/runtime-stream-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.RUNTIME_STREAM_BROWSER_SCREENSHOT ?? "artifacts/runtime-stream/runtime-stream-browser-recovered.png")
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
if (!fixture.projectId || !fixture.title || fixture.stage !== "VTL_RUNTIME") throw new Error("VTL 运行夹具无效")

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
const failedRequests = []
let streamRequests = 0
let abortedStreamCount = 0
let runtimeSnapshotResponses = 0

page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("401 (Unauthorized)") && !message.text().includes("ERR_FAILED")) errors.push(message.text())
})
page.on("requestfailed", (request) => {
  if (request.url().includes("/runtime/stream") && abortedStreamCount > 0) return
  if (request.url().includes("/api/")) failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`)
})
page.on("response", (response) => {
  const runtimePath = `/api/v3/vtl-projects/${fixture.projectId}/runtime`
  if (response.status() === 200 && new URL(response.url()).pathname === runtimePath) runtimeSnapshotResponses += 1
})

await page.route("**/api/v3/vtl-projects/*/runtime/stream", async (route) => {
  streamRequests += 1
  if (abortedStreamCount < 3) {
    abortedStreamCount += 1
    await route.abort("failed")
    return
  }
  await route.continue()
})

let report
try {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "学生演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()

  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click()
    await projectsReloaded
  }

  await page.locator(".home-scene-segment button").filter({ hasText: "巡检" }).click()
  await page.locator(".student-task-search input").fill(fixture.title)
  const project = page.getByText(fixture.title, { exact: true }).first()
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".vtl-runtime-workspace").waitFor({ timeout: 15_000 })

  const before = await runtimeSnapshot(page, fixture.projectId)
  const fallbackResponseBaseline = runtimeSnapshotResponses
  const stateAfterWorkspaceLoad = await streamState(page)

  await page.locator(".stream-state.reconnecting, .stream-state.fallback").first().waitFor({ timeout: 15_000 }).catch(() => undefined)
  const transientState = await streamState(page)
  const fallbackEvidence = await waitForFallbackRequest(page, fallbackResponseBaseline)
  await page.locator(".stream-state.live").waitFor({ timeout: 20_000 })
  const recoveredState = await streamState(page)
  const after = await runtimeSnapshot(page, fixture.projectId)

  const layout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    cesiumCanvas: Boolean(document.querySelector(".vtl-runtime-workspace canvas")),
    streamStatus: document.querySelector(".stream-state")?.textContent?.trim() ?? ""
  }))
  await page.screenshot({ path: screenshotPath, fullPage: true })
  report = {
    format: "wurenji-runtime-stream-browser-acceptance",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    appUrl,
    projectId: fixture.projectId,
    title: fixture.title,
    streamRequests,
    abortedStreamCount,
    states: { afterWorkspaceLoad: stateAfterWorkspaceLoad, transient: transientState, after: recoveredState },
    revisions: { before: before.session?.revision ?? null, after: after.session?.revision ?? null },
    runtimeSnapshotResponses,
    fallbackLoaded: fallbackEvidence.httpSnapshotLoaded,
    fallbackStateSeen: fallbackEvidence.fallbackStateSeen,
    layout,
    errors,
    failedRequests,
    screenshot: screenshotPath,
    checks: {
      firstStreamWasInterrupted: abortedStreamCount > 0,
      fallbackSnapshotLoaded: fallbackEvidence.httpSnapshotLoaded && fallbackEvidence.fallbackStateSeen,
      streamReconnected: recoveredState === "实时在线",
      revisionDidNotRegress: Number(after.session?.revision ?? 0) >= Number(before.session?.revision ?? 0),
      noUnexpectedErrors: errors.length === 0 && failedRequests.length === 0,
      layoutUsable: layout.noHorizontalOverflow && layout.cesiumCanvas
    }
  }
  report.passed = Object.values(report.checks).every(Boolean)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshot: screenshotPath, states: report.states }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await page.unroute("**/api/v3/vtl-projects/*/runtime/stream")
  await context.close()
  await browser.close()
}

async function runtimeSnapshot(currentPage, projectId) {
  return currentPage.evaluate(async (id) => {
    const response = await fetch(`/api/v3/vtl-projects/${id}/runtime`, { credentials: "include" })
    if (!response.ok) throw new Error(`运行快照读取失败：${response.status}`)
    return response.json()
  }, projectId)
}

async function streamState(currentPage) {
  return currentPage.locator(".stream-state").textContent().then((value) => value?.trim() ?? "")
}

async function waitForFallbackRequest(currentPage, baseline) {
  const deadline = Date.now() + 12_000
  let fallbackStateSeen = false
  while (Date.now() < deadline) {
    if (await currentPage.locator(".stream-state.fallback").count()) fallbackStateSeen = true
    if (streamRequests >= 3 && runtimeSnapshotResponses > baseline) return { httpSnapshotLoaded: true, fallbackStateSeen }
    await currentPage.waitForTimeout(50)
  }
  return { httpSnapshotLoaded: runtimeSnapshotResponses > baseline, fallbackStateSeen }
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}
