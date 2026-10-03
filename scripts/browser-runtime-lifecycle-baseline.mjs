import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "").replace(/\/api$/i, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const sceneType = process.env.RUNTIME_SCENE?.trim() || "CITY_SHOW"
const projectId = process.env.RUNTIME_PROJECT_ID?.trim()
const cycles = positiveInteger(process.env.BROWSER_LIFECYCLE_CYCLES, 5)
const outputPath = resolve(process.env.BROWSER_LIFECYCLE_OUTPUT ?? `artifacts/performance/browser-runtime-lifecycle-${sceneType.toLowerCase()}.json`)
const scene = {
  CITY_SHOW: { homeTab: null, stage: "表演运行", workspace: ".show-runtime-workspace", stream: ".runtime-stream-status.live" },
  CITY_LOGISTICS: { homeTab: "物流", stage: "配送运行", workspace: ".logistics-runtime-workspace", stream: ".runtime-stream-status.live" },
  VTOL_INSPECTION: { homeTab: "巡检", stage: "巡检运行", workspace: ".vtl-runtime-workspace", stream: ".stream-state.live" }
}[sceneType]
if (!scene || !projectId) throw new Error("需要设置 RUNTIME_SCENE 和 RUNTIME_PROJECT_ID")

const browserPath = browserExecutable()
const browser = await chromium.launch({ executablePath: browserPath, headless: process.env.HEADLESS !== "false", args: ["--enable-precise-memory-info", "--ignore-gpu-blocklist"] })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const pageErrors = []
const consoleErrors = []
page.on("pageerror", (error) => pageErrors.push(error.message))
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()) })
const cdp = await context.newCDPSession(page)
await cdp.send("HeapProfiler.enable")
const heapSamples = []

try {
  const login = await context.request.post(`${baseUrl}/api/auth/login`, { headers: { Origin: origin }, data: { email: process.env.RUNTIME_STUDENT_EMAIL ?? "student@demo.local", password: process.env.RUNTIME_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "" } })
  if (!login.ok()) throw new Error(`学生登录失败：${login.status()} ${await login.text()}`)
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    await openProjectWorkspace()
    await page.locator(`${scene.workspace} canvas`).waitFor({ timeout: 15_000 })
    await page.locator(`${scene.workspace} ${scene.stream}`).waitFor({ timeout: 15_000 })
    const mounted = await page.locator(scene.workspace).count()
    await page.getByRole("button", { name: "返回教学首页", exact: true }).click()
    await page.locator(scene.workspace).waitFor({ state: "detached", timeout: 15_000 })
    await cdp.send("HeapProfiler.collectGarbage")
    const heap = await cdp.send("Runtime.getHeapUsage")
    heapSamples.push({ cycle, mounted, usedSize: heap.usedSize, totalSize: heap.totalSize })
  }
  const report = {
    format: "wurenji-browser-runtime-lifecycle-baseline",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    sceneType,
    projectId,
    cycles,
    environment: { baseUrl, browser: browser.version(), browserPath, viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } },
    heapSamples,
    errors: { page: pageErrors, console: consoleErrors },
    checks: {
      allMounted: heapSamples.length === cycles && heapSamples.every((sample) => sample.mounted === 1),
      allUnmounted: await page.locator(scene.workspace).count() === 0,
      noPageErrors: pageErrors.length === 0,
      noConsoleErrors: consoleErrors.length === 0
    }
  }
  report.checks.passed = Object.values(report.checks).every(Boolean)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.checks.passed, heapSamples, errors: report.errors, output: outputPath })}\n`)
  if (!report.checks.passed) process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}

async function openProjectWorkspace() {
  const projectsResponse = await context.request.get(`${baseUrl}/api/v3/my-projects?includeInternalData=true`)
  if (!projectsResponse.ok()) throw new Error(`读取项目失败：${projectsResponse.status()}`)
  const projects = await projectsResponse.json()
  const project = projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`找不到项目：${projectId}`)
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.locator(".platform-shell").waitFor({ timeout: 30_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  if (scene.homeTab) await page.locator(".home-scene-segment button").filter({ hasText: scene.homeTab }).click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click()
    await projectsReloaded
  }
  const projectButton = page.locator(".v3-home-project-list > button").filter({ hasText: project.title })
  if (!await projectButton.count()) {
    const search = page.locator(".student-task-search input")
    if (await search.count() && await search.isVisible()) await search.fill(project.title)
    await page.waitForResponse((response) => response.url().includes("/v3/my-projects") && response.status() === 200, { timeout: 15_000 }).catch(() => undefined)
  }
  const button = page.locator(".v3-home-project-list > button").filter({ hasText: project.title })
  if (!await button.count()) {
    const loadMore = page.getByRole("button", { name: /加载更多/ })
    if (await loadMore.count() && await loadMore.isVisible()) await loadMore.click()
  }
  const projectButtonReady = page.locator(".v3-home-project-list > button").filter({ hasText: project.title }).first()
  await projectButtonReady.waitFor({ timeout: 15_000 })
  await projectButtonReady.click()
  await page.locator(".v3-stage-nav > button").filter({ hasText: scene.stage }).click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const selected = candidates.find((candidate) => existsSync(candidate))
  if (!selected) throw new Error("未找到 Chrome 或 Edge；可通过 CHROME_PATH 指定浏览器路径")
  return selected
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("循环次数必须为正整数")
  return parsed
}
