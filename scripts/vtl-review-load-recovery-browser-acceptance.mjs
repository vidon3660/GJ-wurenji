import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const fixturePath = resolve(process.env.VTL_REVIEW_RECOVERY_FIXTURE ?? "artifacts/vtl-alert-browser-fixture-review-ready-console.json")
const outputPath = resolve(process.env.VTL_REVIEW_RECOVERY_OUTPUT ?? "artifacts/ux/vtl-review-load-recovery-latest.json")
const screenshotDirectory = resolve(process.env.VTL_REVIEW_RECOVERY_SCREENSHOTS ?? "artifacts/ux/vtl-review-load-recovery")
const fixtureText = await readFile(fixturePath, "utf8")
const fixture = JSON.parse(fixtureText.slice(fixtureText.indexOf("{")))
const viewports = [
  { name: "desktop", width: 1366, height: 768 },
  { name: "narrow", width: 390, height: 844 }
]

if (!fixture.projectId || !fixture.title) throw new Error(`垂起复盘验收夹具无效：${fixturePath}`)
await mkdir(dirname(outputPath), { recursive: true })
await mkdir(screenshotDirectory, { recursive: true })
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const results = []

try {
  for (const viewport of viewports) results.push(await inspectRecovery(viewport))
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-vtl-review-load-recovery-browser-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  appUrl,
  fixture: { projectId: fixture.projectId, title: fixture.title },
  results,
  passed: results.length === viewports.length && results.every((result) => result.passed)
}
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, results }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function inspectRecovery(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = []
  let injected = false
  const screenshotPath = resolve(screenshotDirectory, `${viewport.name}-${viewport.width}x${viewport.height}.png`)
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized") && !(injected && message.text().includes("503"))) errors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/api/auth/me") && !(injected && response.status() === 503)) errors.push(`${response.status()} ${response.url()}`)
  })

  try {
    await enterTeacherDemo(page)
    await openFixtureProject(page)
    await page.route(`**/api/v3/vtl-projects/${fixture.projectId}/review`, async (route) => {
      if (!injected) {
        injected = true
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "验收注入的垂起复盘加载失败" }) })
        return
      }
      await route.continue()
    })

    const reviewStage = page.getByRole("button", { name: /复盘评价/ }).first()
    await reviewStage.waitFor({ timeout: 15_000 })
    await reviewStage.click()
    const workspace = page.locator(".vtl-review-workspace")
    const errorPanel = page.locator(".vtl-review-load-error-full")
    await workspace.waitFor({ timeout: 15_000 })
    await errorPanel.waitFor({ timeout: 15_000 })
    const failureState = await page.evaluate(() => {
      const panel = document.querySelector(".vtl-review-load-error-full")
      const rect = panel?.getBoundingClientRect()
      return {
        panelVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
        reasonVisible: panel?.textContent?.includes("验收注入的垂起复盘加载失败") ?? false,
        recoveryExplanationVisible: panel?.textContent?.includes("当前没有可保留的复盘数据") ?? false,
        retryVisible: Boolean(panel?.querySelector("button")),
        noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth
      }
    })
    await page.screenshot({ path: screenshotPath, fullPage: true })

    const successfulReload = page.waitForResponse((response) => response.url().endsWith(`/api/v3/vtl-projects/${fixture.projectId}/review`) && response.status() === 200, { timeout: 30_000 })
    await errorPanel.getByRole("button", { name: "重新加载复盘", exact: true }).click()
    await successfulReload
    await errorPanel.waitFor({ state: "detached", timeout: 15_000 })
    await workspace.locator(".vtl-review-main").waitFor({ timeout: 15_000 })
    const recovered = await workspace.locator(".vtl-review-side").count() === 1
      && await workspace.locator(".review-metrics").count() === 1
      && await workspace.locator(".vtl-review-load-error").count() === 0
    const passed = injected && Object.values(failureState).every(Boolean) && recovered && errors.length === 0
    return { viewport, injected, failureState, recovered, errors, screenshotPath, passed }
  } catch (error) {
    return { viewport, injected, failureState: null, recovered: false, errors: [...errors, error instanceof Error ? error.message : String(error)], screenshotPath, passed: false }
  } finally {
    await context.close()
  }
}

async function enterTeacherDemo(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "教师演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  await page.locator(".platform-shell .el-loading-mask").waitFor({ state: "hidden", timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
}

async function openFixtureProject(page) {
  await page.getByRole("button", { name: "学生进度", exact: true }).click()
  await page.locator(".progress-page").waitFor({ timeout: 15_000 })
  const internalScope = page.getByRole("checkbox", { name: "包含演示/验收数据" })
  if (await internalScope.count() && !(await internalScope.isChecked())) await internalScope.locator("xpath=..").click()
  await page.locator(".progress-filter-band input[placeholder='搜索学生或任务']").fill(fixture.title)
  const project = page.locator(".progress-table-row").filter({ hasText: fixture.title }).first()
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
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
