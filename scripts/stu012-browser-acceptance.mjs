import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const fixturePath = resolve(process.env.STU012_FIXTURE_JSON ?? "artifacts/stu012-browser-fixture-latest.json")
const outputPath = resolve(process.env.STU012_BROWSER_OUTPUT ?? "artifacts/stu012-browser-acceptance-latest.json")
const screenshotDirectory = resolve(process.env.STU012_BROWSER_SCREENSHOTS ?? dirname(outputPath))
const targetStudentName = process.env.STU012_STUDENT_NAME ?? "张同学"
const executablePath = browserExecutable()
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
if (!fixture.projectId || !fixture.title || fixture.isAcceptanceData !== true) throw new Error("STU-012 浏览器验收数据无效或未标记为验收数据")

await mkdir(screenshotDirectory, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: process.env.HEADLESS !== "false" })
const results = []

try {
  results.push(await inspectStudent())
  results.push(await inspectTeacher())
} finally {
  await browser.close()
}

const report = {
  format: "wurenji-stu012-browser-acceptance",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  fixture: { projectId: fixture.projectId, assignmentId: fixture.assignmentId, title: fixture.title, isAcceptanceData: fixture.isAcceptanceData },
  results,
  passed: results.length === 2 && results.every((item) => item.passed)
}
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshots: results.flatMap((item) => item.screenshots) }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1

async function inspectStudent() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = collectPageErrors(page)
  try {
    await enterDemo(page, "学生演示")
    await page.locator(".home-scene-segment button").filter({ hasText: "物流" }).click()
    const internalDataCheckbox = page.locator(".student-task-toolbar .el-checkbox").first()
    if (!(await internalDataCheckbox.locator("input").isChecked())) await internalDataCheckbox.click()
    await page.waitForTimeout(1_000)
    await page.locator(".student-task-search input").fill(fixture.title)
    const showCompleted = page.getByRole("button", { name: /显示已完成/ }).first()
    if (await showCompleted.count() && await showCompleted.isVisible()) await showCompleted.click()
    await openProject(page, "student")
    await page.getByRole("button", { name: "题库作答与判定" }).click()
    const panel = page.locator(".questionnaire-panel")
    await panel.waitFor({ timeout: 10_000 })
    await waitForProjectReady(page)
    await waitForQuestionnaireReady(page)
    const bodyText = await panel.innerText()
    const result = await inspectLayout(page)
    const submitButton = page.getByRole("button", { name: "提交作答", exact: true })
    const screenshot = resolve(screenshotDirectory, "stu012-student.png")
    await page.screenshot({ path: screenshot, fullPage: true })
    const passed = bodyText.includes("教师复核已完成")
      && !bodyText.includes("正确答案")
      && !bodyText.includes("评分规则")
      && (await submitButton.count() === 0 || await submitButton.isDisabled())
      && result.noHorizontalOverflow
      && errors.length === 0
    return { role: "student", passed, questionnaireState: "REVIEWED", noAnswerLeak: !bodyText.includes("正确答案") && !bodyText.includes("评分规则"), questionnaireText: bodyText, layout: result, screenshots: [screenshot], errors }
  } finally {
    await context.close()
  }
}

async function inspectTeacher() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const errors = collectPageErrors(page)
  try {
    await enterDemo(page, "教师演示")
    await page.getByRole("button", { name: "学生进度", exact: true }).click()
    await page.locator(".progress-page").waitFor({ timeout: 15_000 })
    const dataScope = page.getByRole("checkbox", { name: "只显示已停滞项目" })
    if (await dataScope.count() && await dataScope.isChecked()) await dataScope.click()
    const internalScope = page.getByRole("checkbox", { name: "包含演示/验收数据" })
    if (await internalScope.count() && !(await internalScope.isChecked())) await internalScope.locator("xpath=..") .click()
    await page.locator(".progress-filter-band input[placeholder='搜索学生或任务']").fill(fixture.title)
    await openProject(page, "teacher")
    await page.getByRole("button", { name: "题库作答与判定" }).click()
    const panel = page.locator(".questionnaire-panel")
    await panel.waitFor({ timeout: 10_000 })
    await waitForProjectReady(page)
    await waitForQuestionnaireReady(page)
    const bodyText = await panel.innerText()
    const result = await inspectLayout(page)
    const closeQuestionnaire = page.getByRole("button", { name: "关闭", exact: true }).first()
    if (await closeQuestionnaire.count() && await closeQuestionnaire.isVisible()) await closeQuestionnaire.click()
    const reviewStage = page.getByRole("button", { name: /复盘评价/ }).first()
    await reviewStage.waitFor({ timeout: 15_000 })
    await reviewStage.click()
    const review = page.locator(".show-review-workspace")
    await review.waitFor({ timeout: 15_000 })
    const reviewText = await review.innerText()
    const reviewMetrics = await review.locator(".review-metric-strip > div").count()
    const reviewEvidence = {
      metricsWithBasis: await review.locator(".review-metric-strip .metric-detail").count(),
      timeline: await review.locator(".review-timeline-panel").count(),
      singleReportEntry: (await review.locator(".report-actions").count()) === 1,
      reportPolicyVisible: reviewText.includes("每次保留一个当前格式文件"),
      cesiumCanvas: await review.locator("canvas").count() > 0
    }
    const screenshot = resolve(screenshotDirectory, "stu012-teacher.png")
    await page.screenshot({ path: screenshot, fullPage: true })
    const passed = bodyText.includes("教师复核已完成")
      && bodyText.includes("教师得分")
      && bodyText.includes("标准答案")
      && await page.getByRole("button", { name: "保存教师复核", exact: true }).count() === 0
      && result.noHorizontalOverflow
      && reviewMetrics > 0
      && reviewEvidence.metricsWithBasis === reviewMetrics
      && reviewEvidence.timeline
      && reviewEvidence.singleReportEntry
      && reviewEvidence.reportPolicyVisible
      && reviewEvidence.cesiumCanvas
      && errors.length === 0
    return { role: "teacher", passed, questionnaireState: "REVIEWED", answerReferenceVisible: bodyText.includes("标准答案"), questionnaireText: bodyText, reviewEvidence, layout: result, screenshots: [screenshot], errors }
  } finally {
    await context.close()
  }
}

async function enterDemo(page, buttonName) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: buttonName, exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  await page.locator(".platform-shell .el-loading-mask").waitFor({ state: "hidden", timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
}

async function openProject(page, role) {
  const listSelector = role === "teacher" ? ".progress-table-row" : ".v3-home-project-list > button"
  const project = page.locator(listSelector).filter({ hasText: fixture.title }).filter({ hasText: role === "teacher" ? targetStudentName : fixture.title })
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
}

async function inspectLayout(page) {
  return page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    projectShell: Boolean(document.querySelector(".v3-project-shell")),
    cesiumCanvas: Boolean(document.querySelector(".v3-project-shell canvas")),
    viewport: { width: window.innerWidth, height: window.innerHeight }
  }))
}

async function waitForQuestionnaireReady(page) {
  await page.waitForFunction(() => {
    const panel = document.querySelector(".questionnaire-panel")
    return Boolean(panel) && !panel.textContent?.includes("正在读取当前任务绑定的题库版本。")
  }, undefined, { timeout: 15_000 })
}

async function waitForProjectReady(page) {
  await page.waitForFunction(() => {
    const shell = document.querySelector(".v3-project-shell")
    return Boolean(shell?.querySelector("canvas"))
  }, undefined, { timeout: 15_000 })
}

function collectPageErrors(page) {
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) errors.push(message.text()) })
  page.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/api/auth/me")) errors.push(`${response.status()} ${response.url()}`) })
  return errors
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
