import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.TEACHER_HOME_RESPONSIVE_OUTPUT ?? "artifacts/ux/teacher-home-responsive-latest.json")
const screenshotDirectory = resolve(process.env.TEACHER_HOME_RESPONSIVE_SCREENSHOTS ?? "artifacts/ux/teacher-home-responsive")
const viewports = [
  { name: "narrow", width: 390, height: 844 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 }
]

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const results = []

try {
  await mkdir(screenshotDirectory, { recursive: true })
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text())
    })
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.url().endsWith("/api/auth/me")) errors.push(`${response.status()} ${response.url()}`)
    })

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
    await page.getByRole("button", { name: "教师演示", exact: true }).click()
    await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
    const skip = page.getByRole("button", { name: "跳过引导", exact: true })
    if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
    await page.locator(".v3-teacher-home-grid").waitFor({ timeout: 15_000 })
    await page.waitForTimeout(300)

    const layout = await page.evaluate(() => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
      }
      const selectorResults = [
        ".platform-header",
        ".platform-user",
        ".education-page",
        ".page-heading",
        ".v3-home-metrics",
        ".teacher-progress-section",
        ".assignment-todo-section",
        ".assignment-filter-toolbar"
      ].map((selector) => {
        const element = document.querySelector(selector)
        if (!element || !visible(element)) return { selector, present: false }
        const rect = element.getBoundingClientRect()
        return {
          selector,
          present: true,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          contained: rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5,
          scrollContained: element.scrollWidth <= element.clientWidth + 1
        }
      })
      const clippedControls = [...document.querySelectorAll(".v3-teacher-home-grid button, .v3-teacher-home-grid input, .v3-teacher-home-grid [role='combobox']")]
        .filter(visible)
        .map((element) => {
          const rect = element.getBoundingClientRect()
          return { element, rect }
        })
        .filter(({ rect }) => rect.left < -0.5 || rect.right > window.innerWidth + 0.5)
        .map(({ element, rect }) => ({
          name: element.getAttribute("aria-label") || element.textContent?.replace(/\s+/g, " ").trim().slice(0, 60) || element.tagName,
          left: Math.round(rect.left),
          right: Math.round(rect.right)
        }))
      const topbarItems = [...document.querySelectorAll(".platform-header > *")].filter(visible)
      const topbarOverlaps = []
      for (let leftIndex = 0; leftIndex < topbarItems.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < topbarItems.length; rightIndex += 1) {
          const left = topbarItems[leftIndex].getBoundingClientRect()
          const right = topbarItems[rightIndex].getBoundingClientRect()
          const overlaps = left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top
          if (overlaps) topbarOverlaps.push(`${topbarItems[leftIndex].className || topbarItems[leftIndex].tagName} / ${topbarItems[rightIndex].className || topbarItems[rightIndex].tagName}`)
        }
      }
      return {
        bodyWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        horizontalOverflow: document.body.scrollWidth > document.body.clientWidth,
        selectorResults,
        clippedControls,
        topbarOverlaps
      }
    })

    const screenshotPath = resolve(screenshotDirectory, `${viewport.name}-${viewport.width}x${viewport.height}.png`)
    await page.screenshot({ path: screenshotPath, fullPage: true })
    const failures = [
      ...(layout.horizontalOverflow ? ["页面出现横向溢出"] : []),
      ...layout.selectorResults.filter((item) => !item.present).map((item) => `${item.selector} 不存在`),
      ...layout.selectorResults.filter((item) => item.present && !item.contained).map((item) => `${item.selector} 超出视口`),
      ...layout.selectorResults.filter((item) => item.present && !item.scrollContained).map((item) => `${item.selector} 内容被横向裁切`),
      ...layout.clippedControls.map((item) => `控件超出视口: ${item.name}`),
      ...layout.topbarOverlaps.map((item) => `顶栏元素重叠: ${item}`),
      ...errors.map((error) => `页面错误: ${error}`)
    ]
    results.push({ viewport, screenshotPath, layout, errors, failures, passed: failures.length === 0 })
    await context.close()
  }
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-teacher-home-responsive-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  results,
  passed: results.every((result) => result.passed)
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, results: results.map(({ viewport, screenshotPath, failures }) => ({ viewport, screenshotPath, failures })) }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

function browserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")
  return value
}
