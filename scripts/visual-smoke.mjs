import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const candidates = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env["ProgramFiles(x86)"] ? `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined
].filter(Boolean)
const executablePath = candidates.find((candidate) => existsSync(candidate))
if (!executablePath) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")

const baseUrl = process.env.APP_URL ?? "http://localhost:3000"
const outputDirectory = process.env.VISUAL_OUTPUT_DIR ?? resolve(process.cwd(), "artifacts", "visual")
const blockMapTiles = process.env.BLOCK_MAP_TILES !== "false"
const blockTerrainEndpoint = process.env.BLOCK_TERRAIN_ENDPOINT === "true"
const headless = process.env.HEADLESS !== "false"
const mapSettleMs = Number(process.env.MAP_SETTLE_MS ?? 1800)
const viewportWidth = positiveInteger(process.env.VISUAL_VIEWPORT_WIDTH, 1440)
const viewportHeight = positiveInteger(process.env.VISUAL_VIEWPORT_HEIGHT, 900)
const minimumCanvasWidth = viewportWidth < 600 ? 260 : 400
await mkdir(outputDirectory, { recursive: true })

const browser = await chromium.launch({ executablePath, headless })

function safeUrl(value) {
  try {
    const url = new URL(value)
    url.search = ""
    return url.toString()
  } catch {
    return value.split("?")[0]
  }
}

async function inspectRole(role, buttonName) {
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors = []
  const networkErrors = []
  const requestHosts = new Map()
  const responseHosts = new Map()
  page.on("pageerror", (error) => pageErrors.push(error.message))
  page.on("request", (request) => {
    try {
      const host = new URL(request.url()).host
      if (/cesium\.com|openstreetmap\.org/.test(host)) requestHosts.set(host, (requestHosts.get(host) ?? 0) + 1)
    } catch {
    }
  })
  page.on("requestfailed", (request) => {
    const url = request.url()
    if (/cesium\.com|openstreetmap\.org/.test(url)) networkErrors.push({ type: "requestfailed", url: safeUrl(url), error: request.failure()?.errorText })
  })
  page.on("response", (response) => {
    const url = response.url()
    try {
      const host = new URL(url).host
      if (/cesium\.com|openstreetmap\.org/.test(host)) {
        const key = `${host}:${response.status()}`
        responseHosts.set(key, (responseHosts.get(key) ?? 0) + 1)
      }
    } catch {
    }
    if (response.status() >= 400 && /cesium\.com|openstreetmap\.org/.test(url)) networkErrors.push({ type: "response", url: safeUrl(url), status: response.status() })
  })
  if (blockTerrainEndpoint) await page.route("https://api.cesium.com/v1/assets/1/endpoint**", (route) => route.abort())
  if (blockMapTiles) await page.route("https://tile.openstreetmap.org/**", (route) => route.abort())

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: buttonName, exact: true }).click()
  await page.locator(".platform-shell").waitFor()
  await page.locator(".education-page .el-loading-mask").waitFor({ state: "hidden", timeout: 15_000 })
  await page.locator(".legacy-compat-section").waitFor({ state: "visible", timeout: 15_000 })
  const legacyNavigationLabel = role === "teacher" ? "V2 仿真工作台" : "V2 历史工作台"
  const legacyNavigation = page.getByRole("button", { name: legacyNavigationLabel, exact: true })
  if (await legacyNavigation.count() && await legacyNavigation.first().isVisible()) await legacyNavigation.first().click()
  else await page.locator(".platform-nav nav button").last().click()
  await page.locator(".async-view-loading").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {})
  if (await page.locator(".async-view-error").count()) throw new Error(`${role} 工作台异步模块加载失败`)
  await page.locator(".app-shell").waitFor({ state: "attached", timeout: 30_000 })
  await page.locator(".app-shell").waitFor({ state: "visible", timeout: 5_000 })
  await page.locator(".cesium-map canvas").waitFor()
  await page.waitForTimeout(mapSettleMs)

  const layout = await page.evaluate(() => {
    const canvas = document.querySelector(".cesium-map canvas")
    const stage = document.querySelector(".map-stage")
    const rightPane = document.querySelector(".right-pane")
    if (!(canvas instanceof HTMLCanvasElement) || !stage || !rightPane) throw new Error("工作台关键元素缺失")
    const canvasRect = canvas.getBoundingClientRect()
    const stageRect = stage.getBoundingClientRect()
    const rightRect = rightPane.getBoundingClientRect()
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    const timeline = document.querySelector(".timeline-panel")
    const attribution = document.querySelector(".cesium-viewer-bottom")
    const credits = document.querySelector(".cesium-widget-credits")
    const timelineRect = timeline?.getBoundingClientRect()
    const attributionRect = attribution?.getBoundingClientRect()
    const creditsRect = credits?.getBoundingClientRect()
    const resourceHosts = performance.getEntriesByType("resource").reduce((counts, entry) => {
      try {
        const host = new URL(entry.name).host
        if (/cesium\.com|openstreetmap\.org/.test(host)) counts[host] = (counts[host] ?? 0) + 1
      } catch {
      }
      return counts
    }, {})
    return {
      canvas: { width: canvasRect.width, height: canvasRect.height },
      stage: { width: stageRect.width, height: stageRect.height },
      rightPane: { left: rightRect.left, width: rightRect.width },
      webgl: gl !== null,
      bodyOverflowX: document.body.scrollWidth > document.body.clientWidth,
      resourceHosts,
      timeline: timelineRect && { top: timelineRect.top, bottom: timelineRect.bottom },
      attribution: attributionRect && {
        top: attributionRect.top,
        bottom: attributionRect.bottom,
        computedBottom: getComputedStyle(attribution).bottom
      },
      credits: creditsRect && { top: creditsRect.top, bottom: creditsRect.bottom },
      timelineAttributionOverlap: Boolean(
        timelineRect && creditsRect &&
        creditsRect.bottom > timelineRect.top &&
        creditsRect.top < timelineRect.bottom
      )
    }
  })

  if (!layout.webgl || layout.canvas.width < minimumCanvasWidth || layout.canvas.height < 300) throw new Error(`${role} Cesium 画布未正确初始化`)
  if (layout.bodyOverflowX) throw new Error(`${role} 桌面视口出现横向溢出`)
  if (layout.timelineAttributionOverlap) {
    throw new Error(`${role} 时间轴遮挡 Cesium 版权信息：${JSON.stringify({ timeline: layout.timeline, attribution: layout.attribution, credits: layout.credits })}`)
  }

  const initialScreenshot = `${outputDirectory}/${role}-initial.png`
  await page.screenshot({ path: initialScreenshot, fullPage: true })

  await page.getByRole("button", { name: "2D 精确规划视角" }).click()
  await page.locator('.cesium-map[data-scene-mode="2d"]').waitFor({ timeout: 5000 })
  await page.waitForTimeout(mapSettleMs)
  const mode2d = await page.locator(".map-mode-switch button.active").textContent()
  const mode2dScreenshot = `${outputDirectory}/${role}-2d.png`
  await page.screenshot({ path: mode2dScreenshot, fullPage: true })
  await page.getByRole("button", { name: "3D 空间理解视角" }).click()
  await page.locator('.cesium-map[data-scene-mode="3d"]').waitFor({ timeout: 5000 })
  await page.waitForTimeout(mapSettleMs)
  const mode3d = await page.locator(".map-mode-switch button.active").textContent()
  if (!mode2d?.includes("2D") || !mode3d?.includes("3D")) throw new Error(`${role} 2D/3D 切换失败`)

  const screenshot = `${outputDirectory}/${role}.png`
  await page.screenshot({ path: screenshot, fullPage: true })
  if (pageErrors.length > 0) throw new Error(`${role} 页面异常：${pageErrors.join("；")}`)
  await context.close()
  return {
    role,
    viewport: { width: viewportWidth, height: viewportHeight },
    layout,
    pageErrors,
    networkErrors,
    requestHosts: Object.fromEntries(requestHosts),
    responseHosts: Object.fromEntries(responseHosts),
    initialScreenshot,
    mode2dScreenshot,
    screenshot
  }
}

try {
  const teacher = await inspectRole("teacher", "教师演示")
  const student = await inspectRole("student", "学生演示")
  process.stdout.write(`${JSON.stringify({ teacher, student }, null, 2)}\n`)
} finally {
  await browser.close()
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("视觉烟测视口必须为正整数")
  return parsed
}
