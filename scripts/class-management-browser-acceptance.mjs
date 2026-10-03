import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.CLASS_BROWSER_OUTPUT ?? "artifacts/class-management/class-management-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.CLASS_BROWSER_SCREENSHOT ?? "artifacts/class-management/class-management-browser-acceptance-latest.png")
const viewport = { width: Number(process.env.CLASS_BROWSER_WIDTH ?? 1440), height: Number(process.env.CLASS_BROWSER_HEIGHT ?? 900) }
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text()) })
page.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/api/auth/me")) errors.push(`${response.status()} ${response.url()}`) })

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "教师演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  await page.getByRole("button", { name: "班级与学生", exact: true }).click()
  await page.locator(".class-page").waitFor({ timeout: 15_000 })
  const classButton = page.locator(".class-list > button").first()
  const hasClass = await classButton.count() > 0
  let searchWorks = false
  let filteredCount = 0
  if (hasClass) {
    await classButton.click()
    const studentSearch = page.getByRole("textbox", { name: "搜索当前班级学生", exact: true })
    await studentSearch.waitFor({ timeout: 10_000 })
    const rows = page.locator(".class-detail .el-table__body-wrapper tbody tr")
    const firstRow = rows.first()
    if (await firstRow.count() && await firstRow.isVisible()) {
      const studentName = (await firstRow.locator("td").first().innerText()).trim()
      await studentSearch.fill(studentName)
      await page.waitForTimeout(200)
      filteredCount = await rows.count()
      searchWorks = filteredCount > 0 && (await page.locator(".student-list-toolbar").innerText()).includes("/")
    } else {
      searchWorks = (await page.locator(".student-list-toolbar").innerText()).includes("0 / 0")
    }
  }
  const result = {
    hasClass,
    searchControl: await page.getByRole("textbox", { name: "搜索当前班级学生", exact: true }).count() > 0,
    searchWorks,
    filteredCount,
    noHorizontalOverflow: await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth),
    errors,
    screenshot: screenshotPath
  }
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const report = { format: "wurenji-class-management-browser-acceptance", formatVersion: 1, generatedAt: new Date().toISOString(), baseUrl, viewport, result, passed: result.searchControl && result.searchWorks && result.noHorizontalOverflow && errors.length === 0 }
  await mkdir(resolve(outputPath, ".."), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshot: screenshotPath }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome；可通过 CHROME_PATH 指定浏览器路径")
  return value
}
