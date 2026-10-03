import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.REGION_RESOURCE_BROWSER_OUTPUT ?? "artifacts/map-resources/region-resource-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.REGION_RESOURCE_BROWSER_SCREENSHOT ?? "artifacts/map-resources/region-resource-browser-acceptance-latest.png")
const viewport = { width: positiveInteger(process.env.REGION_RESOURCE_VIEWPORT_WIDTH, 390), height: positiveInteger(process.env.REGION_RESOURCE_VIEWPORT_HEIGHT, 844) }
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
let failureInjected = false
let expectedInjectedConsoleError = false
page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
page.on("console", (message) => {
  const value = message.text()
  if (message.type() !== "error" || value.includes("401 (Unauthorized)")) return
  if (expectedInjectedConsoleError && value.includes("503 (Service Unavailable)")) {
    expectedInjectedConsoleError = false
    return
  }
  errors.push(value)
})
page.on("response", (response) => { if (response.status() >= 400 && !(failureInjected && response.status() === 503 && response.url().includes("/readiness")) && !response.url().endsWith("/api/auth/me")) errors.push(`${response.status()} ${response.url()}`) })

await page.route("**/api/v3/resource-packages/regions/*/readiness", async (route) => {
  if (!failureInjected) {
    failureInjected = true
    expectedInjectedConsoleError = true
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "验收注入的资源检查失败" }) })
    return
  }
  await route.continue()
})

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "教师演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  await page.getByRole("main").getByRole("button", { name: "预设区域", exact: true }).click()
  await page.locator(".region-library-page").waitFor({ timeout: 15_000 })
  const regionButtons = page.locator(".region-catalog-pane > button")
  await regionButtons.first().waitFor({ timeout: 15_000 })
  await page.getByRole("alert").filter({ hasText: "地图资源检查失败" }).waitFor({ timeout: 15_000 })
  const firstRegionCode = await regionButtons.first().locator("span").innerText()
  const retryResponse = page.waitForResponse((response) => response.url().includes("/readiness") && response.status() === 200)
  await page.getByRole("button", { name: "重新检查", exact: true }).click()
  await retryResponse
  await page.locator(".region-readiness-error").waitFor({ state: "detached", timeout: 15_000 })

  const regionCount = await regionButtons.count()
  if (regionCount < 2) throw new Error("区域库至少需要两个区域才能验证切换清理")
  const secondRegionCode = await regionButtons.nth(1).locator("span").innerText()
  await regionButtons.nth(1).click()
  await page.waitForFunction((expected) => document.querySelector(".v3-region-map-shell")?.getAttribute("data-region-code") === expected, secondRegionCode)
  await page.locator(".v3-region-map-shell canvas").waitFor({ timeout: 15_000 })
  const layout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    canvas: Boolean(document.querySelector(".v3-region-map-shell canvas")),
    regionCode: document.querySelector(".v3-region-map-shell")?.getAttribute("data-region-code") ?? null,
    regionEntityIds: document.querySelector(".v3-region-map-shell")?.getAttribute("data-region-entity-ids") ?? "",
    readinessErrorVisible: Boolean(document.querySelector(".region-readiness-error")),
    resourceIssuesVisible: Boolean(document.querySelector(".region-readiness-issues"))
  }))
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const report = {
    format: "wurenji-region-resource-browser-acceptance",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    viewport,
    firstRegionCode,
    secondRegionCode,
    failureInjected,
    retryRecovered: !layout.readinessErrorVisible,
    regionSwitched: layout.regionCode === secondRegionCode,
    layout,
    errors,
    screenshot: screenshotPath,
    passed: failureInjected && !layout.readinessErrorVisible && layout.regionCode === secondRegionCode && layout.regionEntityIds.includes(secondRegionCode) && !layout.regionEntityIds.includes(firstRegionCode) && layout.canvas && layout.noHorizontalOverflow && errors.length === 0
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshot: screenshotPath }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await page.unroute("**/api/v3/resource-packages/regions/*/readiness")
  await context.close()
  await browser.close()
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
