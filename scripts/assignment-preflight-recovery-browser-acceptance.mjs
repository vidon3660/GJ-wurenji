import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.ASSIGNMENT_PREFLIGHT_RECOVERY_OUTPUT ?? "artifacts/assignment/assignment-preflight-recovery-browser-latest.json")
const screenshotPath = resolve(process.env.ASSIGNMENT_PREFLIGHT_RECOVERY_SCREENSHOT ?? "artifacts/assignment/assignment-preflight-recovery-browser-latest.png")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const viewport = {
  width: positiveInteger(process.env.ASSIGNMENT_PREFLIGHT_VIEWPORT_WIDTH, 1440),
  height: positiveInteger(process.env.ASSIGNMENT_PREFLIGHT_VIEWPORT_HEIGHT, 900)
}
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = []
let injectedFailure = false
const injectPublishConflict = process.env.ASSIGNMENT_PREFLIGHT_INJECT_PUBLISH_CONFLICT === "true"
let publishConflictInjected = false
let preflightAttempts = 0

page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized") && !(injectedFailure && message.text().includes("503")) && !(publishConflictInjected && message.text().includes("409"))) errors.push(message.text())
})
page.on("response", (response) => {
  if (response.status() >= 400 && !response.url().endsWith("/api/auth/me") && !(injectedFailure && response.status() === 503) && !(publishConflictInjected && response.status() === 409)) errors.push(`${response.status()} ${response.url()}`)
})

await page.route("**/api/v3/assignments/drafts/*/preflight", async (route) => {
  preflightAttempts += 1
  if (preflightAttempts === 2 && !injectedFailure) {
    injectedFailure = true
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "验收注入的预检失败" }) })
    return
  }
  await route.continue()
})

if (injectPublishConflict) {
  await page.route("**/api/v3/assignments/drafts/*/publish", async (route) => {
    if (!publishConflictInjected) {
      publishConflictInjected = true
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ message: "发布配置已变化，请重新预览" }) })
      return
    }
    await route.continue()
  })
}

const result = {
  format: "wurenji-assignment-preflight-recovery-browser-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  viewport,
  injectedFailure: false,
  draftRetained: false,
  stalePreviewCleared: false,
  failureVisible: false,
  retrySucceeded: false,
  publishConflictInjected: false,
  publishPreviewInvalidated: false,
  publishButtonEnabled: false,
  noHorizontalOverflow: false,
  errors,
  screenshot: screenshotPath
}

try {
  await mkdir(resolve(screenshotPath, ".."), { recursive: true })
  await mkdir(resolve(outputPath, ".."), { recursive: true })
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "教师演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  await page.getByRole("banner").getByRole("button", { name: "创建 V3 任务", exact: true }).click()
  const dialog = page.locator(".assignment-wizard")
  await dialog.waitFor({ timeout: 15_000 })

  await dialog.locator("input").first().fill(`预检恢复验收-${Date.now()}`)
  await dialog.locator("textarea").nth(0).fill("验证发布预检失败后的恢复流程。")
  await dialog.locator("textarea").nth(1).fill("完成一次任务预览和预检恢复。")
  await dialog.locator("textarea").nth(2).fill("预检失败后保留草稿并能重新检查成功。")
  await page.getByRole("button", { name: "下一步", exact: true }).click()

  const resourceStep = dialog.locator(".wizard-panel").filter({ hasText: "固定规模与预设区域" })
  await resourceStep.waitFor({ timeout: 15_000 })
  const resourceSelects = resourceStep.locator(".el-select")
  for (const select of await resourceSelects.all()) {
    if (await page.getByRole("button", { name: "下一步", exact: true }).isDisabled()) {
      await select.click()
      await selectFirstVisibleOption(page)
    }
  }
  await page.getByRole("button", { name: "下一步", exact: true }).click()

  const scenarioStep = dialog.locator(".wizard-panel").filter({ hasText: "场景变量与事件" })
  await scenarioStep.waitFor({ timeout: 15_000 })
  await scenarioStep.getByText("无人机型号", { exact: true }).locator("..").locator("input").fill("验收教学无人机")
  await scenarioStep.getByText("联系人", { exact: true }).locator("..").locator("input").fill("预检验收联系人")
  await scenarioStep.getByText("联系电话", { exact: true }).locator("..").locator("input").fill("13800000000")
  const eventButton = scenarioStep.locator(".event-selector > button:not([disabled])").first()
  if (await eventButton.count()) await eventButton.click()
  await page.getByRole("button", { name: "下一步", exact: true }).click()

  const classSelect = dialog.getByText("发布班级", { exact: true }).first().locator("..")
  await classSelect.locator(".el-select").click()
  await selectFirstVisibleOption(page)
  await page.getByRole("button", { name: "生成预览", exact: true }).click()
  await dialog.locator(".preview-panel").waitFor({ timeout: 30_000 })
  const draftBeforeFailure = await page.locator(".preview-summary").innerText()

  const failedPreflight = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/v3\/assignments\/drafts\/[^/]+\/preflight$/.test(response.url()) && response.status() === 503, { timeout: 15_000 })
  await dialog.getByRole("button", { name: "重新检查", exact: true }).click()
  await failedPreflight
  result.injectedFailure = injectedFailure
  await dialog.locator(".v3-operation-progress.failed").waitFor({ timeout: 15_000 })
  await dialog.locator(".preview-invalidated").waitFor({ timeout: 15_000 })
  result.failureVisible = await dialog.locator(".v3-operation-progress.failed").isVisible()
  result.stalePreviewCleared = await dialog.locator(".map-readiness-preview").count() === 0
    && await dialog.locator(".preview-invalidated").count() === 1
  result.draftRetained = (await dialog.locator(".preview-summary").count()) === 1
    && draftBeforeFailure.length > 0
    && (await page.locator(".wizard-dialog-title strong").innerText()).startsWith("预检恢复验收-")

  const retryPreflight = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/v3\/assignments\/drafts\/[^/]+\/preflight$/.test(response.url()) && response.status() >= 200 && response.status() < 300, { timeout: 30_000 })
  await dialog.getByRole("button", { name: "重新生成预览", exact: true }).click()
  await retryPreflight
  await dialog.locator(".assignment-preflight").waitFor({ timeout: 30_000 })
  result.retrySucceeded = await dialog.locator(".map-readiness-preview").count() === 1
  if (injectPublishConflict) {
    const confirmation = dialog.locator(".preflight-confirm input")
    if (await confirmation.count() && await confirmation.isVisible()) await confirmation.check()
    const publishButton = page.getByRole("button", { name: "确认发布", exact: true })
    await publishButton.waitFor({ state: "visible", timeout: 15_000 })
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "确认发布")
      return Boolean(button && !button.disabled)
    }, undefined, { timeout: 15_000 })
    result.publishButtonEnabled = await publishButton.isEnabled()
    const publishResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/v3\/assignments\/drafts\/[^/]+\/publish(?:\?|$)/.test(response.url()) && response.status() === 409, { timeout: 15_000 })
    await publishButton.click()
    await publishResponse
    await dialog.locator(".preview-invalidated").waitFor({ timeout: 15_000 })
    result.publishConflictInjected = publishConflictInjected
    result.publishPreviewInvalidated = await dialog.locator(".preview-invalidated").innerText().then((text) => text.includes("版本已变化") && text.includes("重新生成预览"))
  }
  result.noHorizontalOverflow = await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)
  await page.screenshot({ path: screenshotPath, fullPage: true })
} finally {
  result.errors = errors
  result.passed = result.injectedFailure && result.failureVisible && result.stalePreviewCleared && result.draftRetained && result.retrySucceeded && (!injectPublishConflict || (result.publishConflictInjected && result.publishPreviewInvalidated)) && result.noHorizontalOverflow && errors.length === 0
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  await context.close()
  await browser.close()
}

process.stdout.write(`${JSON.stringify({ passed: result.passed, outputPath, screenshot: screenshotPath, result }, null, 2)}\n`)
if (!result.passed) process.exitCode = 1

async function selectFirstVisibleOption(page) {
  const option = page.locator(".el-select-dropdown:visible .el-select-dropdown__item:visible").first()
  await option.waitFor({ state: "visible", timeout: 10_000 })
  await option.click({ force: true })
}

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

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
