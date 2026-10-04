import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.QUESTIONNAIRE_PROGRESS_OUTPUT ?? "artifacts/question-bank/questionnaire-progress-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.QUESTIONNAIRE_PROGRESS_SCREENSHOT ?? "artifacts/question-bank/questionnaire-progress-browser-acceptance-latest.png")
const viewportWidth = positiveInteger(process.env.QUESTIONNAIRE_PROGRESS_VIEWPORT_WIDTH, 1440)
const viewportHeight = positiveInteger(process.env.QUESTIONNAIRE_PROGRESS_VIEWPORT_HEIGHT, 900)
const injectSaveFailure = process.env.QUESTIONNAIRE_INJECT_SAVE_FAILURE === "true"
const injectRevisionConflict = process.env.QUESTIONNAIRE_INJECT_REVISION_CONFLICT === "true"
if ([injectSaveFailure, injectRevisionConflict].filter(Boolean).length > 1) throw new Error("题库失败注入模式不能同时启用")
const injectFailure = injectSaveFailure || injectRevisionConflict
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = collectPageErrors(page)
let injectedFailure = false

if (injectFailure) {
  const injectRoute = async (route) => {
    const shouldInject = !injectedFailure && route.request().method() === "PUT"
    if (shouldInject) {
      injectedFailure = true
      const status = injectRevisionConflict ? 409 : 503
    const message = injectRevisionConflict ? "验收注入的题库版本冲突" : "验收注入的题库保存失败"
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ message }) })
      return
    }
    await route.continue()
  }
  await page.route("**/api/v3/projects/*/questionnaire", injectRoute)
}

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  // The demo buttons only choose the account; submit the password when the
  // current session is not already authenticated.  The previous exact
  // label also became stale after the login UI added the “需密码” hint.
  const loginPage = page.locator(".login-page")
  if (await loginPage.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /^学生演示/ }).first().click()
    const studentPassword = process.env.DEMO_STUDENT_PASSWORD
    if (!studentPassword) {
      throw new Error("问卷进度浏览器验收需要登录学生账号；请设置 DEMO_STUDENT_PASSWORD，或传入已有登录会话")
    }
    await page.locator('input[name="password"]').fill(studentPassword)
    await page.getByRole("button", { name: "登录平台", exact: true }).click()
  }
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()

  const target = await findEditableQuestionnaire(page)
  await page.locator(".home-scene-segment button").filter({ hasText: "物流" }).click()
  const internalDataCheckbox = page.locator(".student-task-toolbar .el-checkbox").first()
  if (!(await internalDataCheckbox.locator("input").isChecked())) await internalDataCheckbox.click()
  await page.locator(".student-task-search input").fill(target.title)
  const project = page.locator(".v3-home-project-list > button").filter({ hasText: target.title })
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.getByRole("button", { name: "题库作答与判定" }).click()

  const panel = page.locator(".questionnaire-panel")
  await panel.waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => !document.querySelector(".questionnaire-panel")?.textContent?.includes("正在读取当前任务绑定的题库版本。"), undefined, { timeout: 15_000 })
  const manualCount = await panel.locator(".question-card:not(:has(.evidence-placeholder))").count()
  const initialProgress = await panel.locator(".questionnaire-score").innerText()
  const initialUnansweredCount = await panel.locator(".question-card.unanswered:not(:has(.evidence-placeholder))").count()
  if (initialUnansweredCount < 1) throw new Error("题库验收夹具没有可作答的未答题")
  const firstUnansweredCard = panel.locator(".question-card.unanswered:not(:has(.evidence-placeholder))").first()
  const firstUnansweredCode = await firstUnansweredCard.getAttribute("data-question-code")
  if (!firstUnansweredCode) throw new Error("未答题缺少题目编号")
  const answerCard = panel.locator(`.question-card[data-question-code="${firstUnansweredCode}"]`)
  await answerFirstUnanswered(answerCard)
  const expectedAnsweredCount = manualCount - initialUnansweredCount + 1
  try {
    await page.waitForFunction((expected) => {
      const text = document.querySelector(".questionnaire-score")?.textContent ?? ""
      return new RegExp(`作答进度\\s*${expected}\\s*/`).test(text)
    }, expectedAnsweredCount)
  } catch (error) {
    const diagnostics = await answerCard.evaluate((element) => ({
      code: element.getAttribute("data-question-code"),
      classes: element.className,
      values: [...element.querySelectorAll("input, textarea")].map((item) => ({ value: (item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement) ? item.value : "", aria: item.getAttribute("aria-label") }))
    }))
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n结构化题输入诊断：${JSON.stringify(diagnostics)}`)
  }
  const updatedProgress = await panel.locator(".questionnaire-score").innerText()

  let retryEvidence = null
  if (injectSaveFailure || injectRevisionConflict) {
    await page.getByRole("button", { name: "保存草稿", exact: true }).click()
    const error = panel.locator(".questionnaire-error")
    await error.waitFor({ timeout: 10_000 })
    const errorText = await error.innerText()
    const retryButton = page.getByRole("button", { name: "重试保存", exact: true })
    const retryVisible = await retryButton.isVisible()
    const retryResponse = page.waitForResponse((response) => response.url().includes("/questionnaire") && response.request().method() === "PUT" && response.status() === 200)
    await retryButton.click()
    await retryResponse
    await error.waitFor({ state: "detached", timeout: 10_000 })
    retryEvidence = { injected: injectedFailure, failureMode: injectRevisionConflict ? "REVISION_CONFLICT" : "SAVE_FAILURE", errorText, retryVisible, retrySucceeded: true }
  }

  await page.getByRole("button", { name: "提交作答", exact: true }).click()
  const confirm = page.locator(".el-message-box")
  await confirm.waitFor({ timeout: 10_000 })
  const confirmText = await confirm.innerText()
  const remainingUnansweredCount = initialUnansweredCount - 1
  await page.getByRole("button", { name: remainingUnansweredCount > 0 ? "返回补充" : "继续编辑", exact: true }).click()
  await confirm.waitFor({ state: "detached", timeout: 10_000 })
  await page.waitForTimeout(500)

  const unansweredCards = panel.locator(".question-card.unanswered:not(:has(.evidence-placeholder))")
  const unansweredLocator = panel.locator(".questionnaire-score button")
  const unansweredText = await unansweredLocator.count() ? await unansweredLocator.textContent() : null
  const visibleUnansweredCount = unansweredText ? Number(unansweredText.match(/(\d+)/)?.[1] ?? 0) : 0
  const firstUnansweredPosition = await unansweredCards.count()
    ? await unansweredCards.first().evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight }
    })
    : null
  const result = {
    projectId: target.id,
    title: target.title,
    manualCount,
    initialProgress,
    updatedProgress,
    initialUnansweredCount,
    unansweredCount: visibleUnansweredCount,
    confirmText,
    firstUnansweredVisible: firstUnansweredPosition ? firstUnansweredPosition.bottom > 0 && firstUnansweredPosition.top < firstUnansweredPosition.viewportHeight : false,
    retryEvidence,
    noHorizontalOverflow: await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth),
    viewport: { width: viewportWidth, height: viewportHeight },
    errors,
    screenshot: screenshotPath
  }
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const passed = manualCount > 1
    && initialUnansweredCount > 0
    && updatedProgress.includes(`${expectedAnsweredCount}`)
    && result.unansweredCount === initialUnansweredCount - 1
    && (remainingUnansweredCount > 0
      ? confirmText.includes(`仍有 ${remainingUnansweredCount} 道题未完成`) && confirmText.includes("按未作答判定") && result.firstUnansweredVisible
      : confirmText.includes("提交后本次题库作答不能继续修改") && !result.firstUnansweredVisible)
    && result.noHorizontalOverflow
    && (!injectFailure || (retryEvidence?.injected && retryEvidence.retryVisible && retryEvidence.retrySucceeded))
    && errors.length === 0
  const report = { format: "wurenji-questionnaire-progress-browser-acceptance", formatVersion: 1, generatedAt: new Date().toISOString(), baseUrl, result, passed }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed, outputPath, screenshot: screenshotPath, result }, null, 2)}\n`)
  if (!passed) process.exitCode = 1
} finally {
  if (injectFailure) {
    await page.unroute("**/api/v3/projects/*/questionnaire")
  }
  await context.close()
  await browser.close()
}

async function findEditableQuestionnaire(page) {
  return page.evaluate(async () => {
    const projectsResponse = await fetch("/api/v3/my-projects?includeInternalData=true", { credentials: "include" })
    if (!projectsResponse.ok) throw new Error("无法读取学生验收项目")
    const projects = await projectsResponse.json()
    const candidates = []
    for (const project of projects) {
      if (project.sceneType !== "CITY_LOGISTICS") continue
      const response = await fetch(`/api/v3/projects/${project.id}/questionnaire`, { credentials: "include" })
      if (!response.ok) continue
      const questionnaire = await response.json()
      const manualCodes = new Set(questionnaire.questions.filter((question) => question.type !== "SIMULATION_EVIDENCE").map((question) => question.code))
      const unansweredCount = questionnaire.responses.filter((response) => manualCodes.has(response.questionCode) && response.judgment === "UNANSWERED").length
      if (questionnaire.available && questionnaire.canEdit && questionnaire.questions.length > 1 && unansweredCount > 0) candidates.push({ id: project.id, title: project.title, unansweredCount })
    }
    const preferred = candidates.find((project) => project.title.startsWith("STU-012 物流完整往返仿真"))
    if (preferred) return preferred
    if (candidates.length > 0) return candidates[0]
    throw new Error("没有可编辑的物流题库验收项目")
  })
}

function collectPageErrors(targetPage) {
  const values = []
  targetPage.on("pageerror", (error) => values.push(error.message))
  targetPage.on("console", (message) => {
    const expectedInjectedFailure = injectFailure && message.type() === "error" && (message.text().includes("503") || message.text().includes("409"))
    if (message.type() === "error" && !message.text().includes("401 (Unauthorized)") && !expectedInjectedFailure) values.push(message.text())
  })
  targetPage.on("response", (response) => {
    const expectedInjectedFailure = injectFailure && (response.status() === 503 || response.status() === 409) && response.request().method() === "PUT" && response.url().includes("/questionnaire")
    if (response.status() >= 400 && !response.url().endsWith("/api/auth/me") && !expectedInjectedFailure) values.push(`${response.status()} ${response.url()}`)
  })
  return values
}

async function answerFirstUnanswered(card) {
  const radio = card.locator(".el-radio:visible").first()
  if (await radio.count() && await radio.isVisible()) {
    await radio.click()
    return
  }
  const checkbox = card.locator(".el-checkbox:visible").first()
  if (await checkbox.count() && await checkbox.isVisible()) {
    await checkbox.click()
    return
  }
  const inputs = card.locator("input.el-input__inner")
  if (await inputs.count()) {
    for (let index = 0; index < await inputs.count(); index += 1) {
      await inputs.nth(index).scrollIntoViewIfNeeded()
      await inputs.nth(index).fill("验收填写")
      await inputs.nth(index).press("Tab")
    }
    return
  }
  const textareas = card.locator("textarea.el-textarea__inner")
  if (await textareas.count()) {
    for (let index = 0; index < await textareas.count(); index += 1) {
      await textareas.nth(index).scrollIntoViewIfNeeded()
      await textareas.nth(index).fill("验收填写：完成结构化作答")
      await textareas.nth(index).press("Tab")
    }
    return
  }
  throw new Error("未找到可操作的未答题控件")
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
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}
