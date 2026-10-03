import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const fixturePath = resolve(process.env.STUDENT_PROJECT_RECOVERY_FIXTURE ?? "artifacts/runtime-stream/race-fixture.json")
const outputPath = resolve(process.env.STUDENT_PROJECT_RECOVERY_OUTPUT ?? "artifacts/ux/student-project-load-recovery-latest.json")
const screenshotDirectory = resolve(process.env.STUDENT_PROJECT_RECOVERY_SCREENSHOTS ?? "artifacts/ux/student-project-load-recovery")
const fixture = await readFixture(fixturePath)
const viewports = [
  { name: "desktop", width: 1366, height: 768 },
  { name: "narrow", width: 390, height: 844 }
]

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
  format: "wurenji-student-project-load-recovery-browser-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  appUrl,
  fixture,
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
    await login(page)
    await page.locator(".home-scene-segment button").filter({ hasText: "表演" }).click()
    const search = page.locator(".student-task-search input")
    await search.fill(fixture.title)
    const project = page.locator(`.v3-home-project-list > button[data-project-id="${fixture.projectId}"]`).first()
    await project.waitFor({ timeout: 15_000 })
    await page.route(`**/api/v3/projects/${fixture.projectId}/stages`, async (route) => {
      if (!injected) {
        injected = true
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "验收注入的项目加载失败" }) })
        return
      }
      await route.continue()
    })
    await project.click()

    const workspace = page.locator(".v3-project-shell")
    const errorPanel = page.locator(".v3-project-load-error")
    await workspace.waitFor({ timeout: 15_000 })
    await errorPanel.waitFor({ timeout: 15_000 })
    const failureState = await page.evaluate(() => {
      const panel = document.querySelector(".v3-project-load-error")
      const rect = panel?.getBoundingClientRect()
      const button = panel?.querySelector("button")
      return {
        panelVisible: Boolean(rect && rect.width > 0 && rect.height > 0),
        titleVisible: panel?.textContent?.includes("项目暂时无法加载") ?? false,
        recoveryExplanationVisible: panel?.textContent?.includes("已保存的任务数据不会因本次加载失败被清除") ?? false,
        retryVisible: Boolean(button && button.getBoundingClientRect().width > 0),
        noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth
      }
    })
    await page.screenshot({ path: screenshotPath, fullPage: true })

    const successfulReload = page.waitForResponse((response) => response.url().endsWith(`/api/v3/projects/${fixture.projectId}/stages`) && response.status() === 200, { timeout: 30_000 })
    await errorPanel.getByRole("button", { name: "重新加载项目", exact: true }).click()
    await successfulReload
    await errorPanel.waitFor({ state: "detached", timeout: 15_000 })
    await page.locator(".v3-stage-nav > button").first().waitFor({ timeout: 15_000 })
    const recovered = await page.locator(".v3-stage-nav > button").count() > 0
      && await page.locator(".v3-project-title strong").filter({ hasText: "学生项目" }).count() === 0

    const passed = injected
      && Object.values(failureState).every(Boolean)
      && recovered
      && errors.length === 0
    return { viewport, injected, failureState, recovered, errors, screenshotPath, passed }
  } catch (error) {
    return {
      viewport,
      injected,
      failureState: null,
      recovered: false,
      errors: [...errors, error instanceof Error ? error.message : String(error)],
      screenshotPath,
      passed: false
    }
  } finally {
    await context.close()
  }
}

async function login(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "学生演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const reloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click({ force: true })
    await reloaded
  }
}

async function readFixture(path) {
  const raw = JSON.parse(await readFile(path, "utf8"))
  const fixture = raw.projectId && raw.title ? raw : raw.projects?.CITY_SHOW
  if (!fixture?.projectId || !fixture.title) throw new Error(`城市表演学生夹具无效：${path}`)
  return { projectId: fixture.projectId, title: fixture.title }
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
