import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.ACCESSIBILITY_BROWSER_OUTPUT ?? "artifacts/accessibility/accessibility-browser-smoke-latest.json")
const viewport = {
  width: Number(process.env.ACCESSIBILITY_VIEWPORT_WIDTH ?? 390),
  height: Number(process.env.ACCESSIBILITY_VIEWPORT_HEIGHT ?? 844)
}

const executablePath = [
  process.env.CHROME_PATH,
  process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium"
].filter(Boolean).find((candidate) => existsSync(candidate))
if (!executablePath) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
if (!Number.isInteger(viewport.width) || viewport.width < 1 || !Number.isInteger(viewport.height) || viewport.height < 1) {
  throw new Error("可访问性验收视口必须为正整数")
}

const browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== "false" })
const results = []

try {
  for (const definition of [
    { role: "teacher", entry: "教师演示", workspace: "V2 仿真工作台" },
    { role: "student", entry: "学生演示", workspace: "V2 历史工作台" }
  ]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text())
    })

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
    await page.getByRole("button", { name: definition.entry, exact: true }).click()
    await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
    const skip = page.getByRole("button", { name: "跳过引导", exact: true })
    if (await skip.count() && await skip.first().isVisible()) await skip.first().click()

    const home = await auditPage(page)
    const workspaceButton = page.getByRole("button", { name: definition.workspace, exact: true })
    if (await workspaceButton.count() && await workspaceButton.first().isVisible()) await workspaceButton.first().click()
    await page.locator(".app-shell").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(500)
    const workspace = await auditPage(page)
    results.push({ role: definition.role, viewport, home, workspace, errors })
    await context.close()
  }
} finally {
  await browser.close()
}

const failed = results.flatMap((result) => [
  ...result.home.issues.map((issue) => `${result.role}/home: ${issue}`),
  ...result.workspace.issues.map((issue) => `${result.role}/workspace: ${issue}`),
  ...result.errors.map((error) => `${result.role}/error: ${error}`)
])
const report = {
  format: "wurenji-accessibility-browser-smoke",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  viewport,
  results,
  passed: failed.length === 0,
  failures: failed
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, failures: failed }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function auditPage(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none"
    }
    const controls = [...document.querySelectorAll("button, [role='button'], input, select, textarea")].filter(visible)
    const name = (element) => {
      const explicit = element.getAttribute("aria-label") || element.getAttribute("title")
      if (explicit) return explicit
      const labelledBy = element.getAttribute("aria-labelledby")
      if (labelledBy) {
        const labelledText = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()
        if (labelledText) return labelledText
      }
      if (element.id) {
        const associatedLabel = [...document.querySelectorAll("label[for]")].find((label) => label.getAttribute("for") === element.id)?.textContent?.trim()
        if (associatedLabel) return associatedLabel
      }
      const ancestorLabel = element.closest("label")?.textContent?.trim()
      if (ancestorLabel) return ancestorLabel
      const formItemLabel = element.closest(".el-form-item")?.querySelector(".el-form-item__label")?.textContent?.trim()
      return formItemLabel || element.textContent?.replace(/\s+/g, " ").trim() || ""
    }
    const issues = []
    controls.filter((element) => !name(element)).slice(0, 20).forEach((element) => issues.push(`无辅助名称: ${element.tagName}`))
    controls.filter((element) => element.tagName === "BUTTON" && !element.getAttribute("type")).slice(0, 20).forEach((element) => issues.push(`按钮缺少 type: ${name(element).slice(0, 50)}`))
    controls.filter((element) => element.hasAttribute("aria-pressed") && !["true", "false"].includes(element.getAttribute("aria-pressed"))).forEach((element) => issues.push(`aria-pressed 非布尔值: ${name(element).slice(0, 50)}`))
    if (document.body.scrollWidth > document.body.clientWidth) issues.push("页面出现横向溢出")
    return { url: location.pathname, controlCount: controls.length, issues }
  })
}
