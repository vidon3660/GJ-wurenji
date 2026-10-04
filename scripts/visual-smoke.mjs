import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const executablePath = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined
].filter(Boolean).find((candidate) => existsSync(candidate))
if (!executablePath) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputDirectory = process.env.VISUAL_OUTPUT_DIR ?? resolve(process.cwd(), "artifacts", "visual")
const blockMapTiles = process.env.BLOCK_MAP_TILES !== "false"
const blockTerrainEndpoint = process.env.BLOCK_TERRAIN_ENDPOINT === "true"
const headless = process.env.HEADLESS !== "false"
const mapSettleMs = Number(process.env.MAP_SETTLE_MS ?? 1800)
const viewportWidth = positiveInteger(process.env.VISUAL_VIEWPORT_WIDTH, 1440)
const viewportHeight = positiveInteger(process.env.VISUAL_VIEWPORT_HEIGHT, 900)
const minimumMapWidth = viewportWidth < 600 ? 260 : 400
await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({ executablePath, headless })

async function inspectRole(role, sceneButton) {
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  const networkErrors = []
  const requestHosts = new Map()
  const responseHosts = new Map()
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("request", (request) => recordMapHost(request.url(), requestHosts))
  page.on("requestfailed", (request) => {
    if (isMapHost(request.url())) networkErrors.push({ type: "requestfailed", url: safeUrl(request.url()), error: request.failure()?.errorText })
  })
  page.on("response", (response) => {
    if (isMapHost(response.url())) {
      const key = `${new URL(response.url()).host}:${response.status()}`
      responseHosts.set(key, (responseHosts.get(key) ?? 0) + 1)
      if (response.status() >= 400) networkErrors.push({ type: "response", url: safeUrl(response.url()), status: response.status() })
    }
  })
  if (blockTerrainEndpoint) await page.route("https://api.cesium.com/v1/assets/1/endpoint**", (route) => route.abort())
  if (blockMapTiles) await page.route("https://tile.openstreetmap.org/**", (route) => route.abort())

  const email = role === "teacher" ? process.env.VISUAL_TEACHER_EMAIL ?? "teacher@demo.local" : process.env.VISUAL_STUDENT_EMAIL ?? "student@demo.local"
  const password = role === "teacher" ? process.env.VISUAL_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD : process.env.VISUAL_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD
  if (!password) throw new Error(`${role} 视觉烟测缺少密码，请设置 ${role === "teacher" ? "DEMO_TEACHER_PASSWORD" : "DEMO_STUDENT_PASSWORD"}`)
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.locator('input[name="email"]').fill(email)
  await page.locator('input[name="password"]').fill(password)
  const onboardingLoaded = page.waitForResponse((response) => response.url().endsWith("/api/v1/education/onboarding"), { timeout: 15_000 }).catch(() => null)
  await page.getByRole("button", { name: "登录平台", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 30_000 })
  await onboardingLoaded
  await page.waitForTimeout(150)
  const skipGuide = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skipGuide.count() && await skipGuide.first().isVisible()) await skipGuide.first().click()

  const targetName = role === "teacher" ? "预设区域管理" : sceneButton
  const target = page.getByRole("button", { name: targetName, exact: true })
  await target.first().click()
  await page.locator(".async-view-loading").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {})
  if (await page.locator(".async-view-error").count()) throw new Error(`${role} V3 模块加载失败`)
  if (role === "teacher") {
    await page.locator(".region-library-page").waitFor({ timeout: 30_000 })
    await page.locator(".region-library-page > .el-loading-mask").waitFor({ state: "hidden", timeout: 30_000 })
    if (await page.locator(".region-catalog-empty.failed").count()) throw new Error("预设区域读取失败")
    if (await page.locator(".region-map-canvas").count()) await page.locator(".v3-region-map canvas").waitFor({ timeout: 30_000 })
  }
  await page.waitForTimeout(role === "teacher" ? mapSettleMs : 250)
  const layout = await page.evaluate(() => {
    const content = document.querySelector(".platform-content")
    if (!content) throw new Error("V3 平台内容区域缺失")
    const map = document.querySelector(".v3-region-map")
    const canvas = map?.querySelector("canvas")
    if (!(canvas instanceof HTMLCanvasElement) || !map) return { hasMap: false, bodyOverflowX: document.body.scrollWidth > document.body.clientWidth }
    const canvasRect = canvas.getBoundingClientRect()
    const mapRect = map.getBoundingClientRect()
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    return { hasMap: true, canvas: { width: canvasRect.width, height: canvasRect.height }, map: { width: mapRect.width, height: mapRect.height }, webgl: gl !== null, bodyOverflowX: document.body.scrollWidth > document.body.clientWidth }
  })
  if (role === "teacher" && await page.locator(".region-map-canvas").count() && !layout.hasMap) throw new Error("已选区域的 Cesium 地图未初始化")
  if (layout.bodyOverflowX) throw new Error(`${role} 视口出现横向溢出`)
  if (layout.hasMap && (!layout.webgl || layout.canvas.width < minimumMapWidth || layout.canvas.height < 240)) throw new Error(`${role} Cesium 地图画布未正确初始化`)
  const initialScreenshot = `${outputDirectory}/${role}-initial.png`
  await page.screenshot({ path: initialScreenshot, fullPage: true })

  let mode2dScreenshot = null
  let mode2d = null
  let mode3d = null
  if (layout.hasMap) {
    await page.getByRole("button", { name: "2D 精确规划视角" }).click()
    await page.waitForTimeout(mapSettleMs)
    mode2d = await page.getByRole("button", { name: "2D 精确规划视角" }).getAttribute("aria-pressed")
    mode2dScreenshot = `${outputDirectory}/${role}-2d.png`
    await page.screenshot({ path: mode2dScreenshot, fullPage: true })
    await page.getByRole("button", { name: "3D 空间理解视角" }).click()
    await page.waitForTimeout(mapSettleMs)
    mode3d = await page.getByRole("button", { name: "3D 空间理解视角" }).getAttribute("aria-pressed")
    if (mode2d !== "true" || mode3d !== "true") throw new Error(`${role} 2D/3D 切换失败`)
  }
  const screenshot = `${outputDirectory}/${role}.png`
  await page.screenshot({ path: screenshot, fullPage: true })
  if (pageErrors.length > 0) throw new Error(`${role} 页面异常：${pageErrors.join("；")}`)
  await context.close()
  return { role, coverage: role === "student" ? "V3_STUDENT_SCENE_LIST" : layout.hasMap ? "V3_REGION_MAP_2D_3D" : "V3_REGION_CATALOG_EMPTY", viewport: { width: viewportWidth, height: viewportHeight }, layout, pageErrors, networkErrors, requestHosts: Object.fromEntries(requestHosts), responseHosts: Object.fromEntries(responseHosts), initialScreenshot, mode2dScreenshot, mode2d, mode3d, screenshot }
}

try {
  const teacher = await inspectRole("teacher", "编队表演")
  const student = await inspectRole("student", "编队表演")
  process.stdout.write(`${JSON.stringify({ teacher, student }, null, 2)}\n`)
} finally {
  await browser.close()
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("视觉烟测视口必须为正整数")
  return parsed
}
function isMapHost(value) {
  try { return /cesium\.com|openstreetmap\.org/.test(new URL(value).host) } catch { return false }
}
function recordMapHost(value, hosts) {
  if (!isMapHost(value)) return
  const host = new URL(value).host
  hosts.set(host, (hosts.get(host) ?? 0) + 1)
}
function safeUrl(value) {
  try { const url = new URL(value); url.search = ""; return url.toString() } catch { return value.split("?")[0] }
}
