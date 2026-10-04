import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const outputPath = resolve(process.env.QUESTION_BANK_BROWSER_OUTPUT ?? "artifacts/question-bank/question-bank-management-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.QUESTION_BANK_BROWSER_SCREENSHOT ?? "artifacts/question-bank/question-bank-management-browser-acceptance-latest.png")
const mobileScreenshotPath = screenshotPath.replace(/(\.[^.]+)$/, "-mobile$1")
const title = process.env.QUESTION_BANK_ACCEPTANCE_TITLE ?? `AI-UI-ACCEPTANCE-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`
const emptyDraftTitle = `${title}-EMPTY-DRAFT`
const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()
const errors = collectPageErrors(page)

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  // The login page requires selecting the demo account and then submitting
  // the configured password.  Keep the acceptance flow compatible with both
  // an already-authenticated storage state and the current explicit login UI.
  const loginPage = page.locator(".login-page")
  if (await loginPage.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: /^教师演示/ }).first().click()
    const teacherPassword = process.env.DEMO_TEACHER_PASSWORD
    if (!teacherPassword) {
      throw new Error("题库浏览器验收需要登录教师账号；请设置 DEMO_TEACHER_PASSWORD，或传入已有登录会话")
    }
    await page.locator('input[name="password"]').fill(teacherPassword)
    await page.getByRole("button", { name: "登录平台", exact: true }).click()
  }
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  await page.getByRole("button", { name: "题库管理", exact: true }).click()
  await page.locator(".question-bank-page").waitFor({ timeout: 15_000 })

  await page.getByRole("button", { name: "新建题库", exact: true }).first().click()
  await page.getByRole("textbox", { name: "题库名称", exact: true }).fill(title)
  await page.getByRole("textbox", { name: "题库说明", exact: true }).fill("浏览器验收数据，不作为正式教学题库。")
  await page.getByRole("button", { name: "创建", exact: true }).click()
  await page.getByRole("heading", { name: title, exact: true }).waitFor({ timeout: 15_000 })

  await page.getByRole("button", { name: "添加题目", exact: true }).click()
  const card = page.locator(".question-editor-card").last()
  await card.locator(".el-form-item", { hasText: "题目编号" }).locator("input").fill("UI-ACCEPTANCE-01")
  await card.locator(".el-form-item", { hasText: "题干" }).locator("textarea").fill("验收题：当前题库版本是否可追溯？")
  await card.locator(".el-form-item", { hasText: "正确答案" }).locator("textarea").fill("A")
  await page.getByRole("button", { name: "保存新版本", exact: true }).click()
  try {
    await page.getByText("新题库版本已保存", { exact: true }).waitFor({ timeout: 15_000 })
  } catch (error) {
    const diagnostic = resolve(outputPath, "..", "question-bank-management-browser-acceptance-failure.png")
    await page.screenshot({ path: diagnostic, fullPage: true })
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n页面状态：${(await page.locator(".question-bank-editor").innerText()).slice(0, 1200)}\n失败请求：${errors.join(" | ")}\n截图：${diagnostic}`)
  }
  await page.getByRole("button", { name: "发布当前版本", exact: true }).click()
  await page.getByRole("button", { name: "发布", exact: true }).click()
  await page.getByText("题库版本已发布", { exact: true }).waitFor({ timeout: 15_000 })

  await page.getByRole("button", { name: "版本审计", exact: true }).click()
  const auditDialog = page.getByRole("dialog", { name: "题库版本审计", exact: true })
  await auditDialog.waitFor({ timeout: 15_000 })
  await auditDialog.locator(".el-radio-button").filter({ hasText: /全部版本/ }).click()
  const auditText = await auditDialog.innerText()
  const auditVersionRow = auditDialog.locator(".audit-row:not(.audit-row-head)").filter({ hasText: title }).first()
  const auditVersionRowText = await auditVersionRow.count() > 0 ? await auditVersionRow.innerText() : ""
  const auditVersionVisible = auditVersionRowText.includes("可执行")
  await auditDialog.getByRole("button", { name: "关闭", exact: true }).click()

  await page.getByRole("button", { name: "新建题库", exact: true }).first().click()
  await page.getByRole("textbox", { name: "题库名称", exact: true }).fill(emptyDraftTitle)
  await page.getByRole("textbox", { name: "题库说明", exact: true }).fill("浏览器验收生成的空草稿，用于验证安全归档。")
  await page.getByRole("button", { name: "创建", exact: true }).click()
  await page.getByRole("heading", { name: emptyDraftTitle, exact: true }).waitFor({ timeout: 15_000 })
  await page.getByRole("button", { name: "版本审计", exact: true }).click()
  await auditDialog.waitFor({ timeout: 15_000 })
  const emptyDraftRow = auditDialog.locator(".audit-row").filter({ hasText: emptyDraftTitle }).first()
  await emptyDraftRow.waitFor({ timeout: 15_000 })
  await emptyDraftRow.getByRole("button", { name: "归档", exact: true }).click()
  await page.getByRole("button", { name: "确认归档", exact: true }).click()
  await page.getByText(/空草稿已归档/).waitFor({ timeout: 15_000 })
  const removedFromIssues = await auditDialog.locator(".audit-row").filter({ hasText: emptyDraftTitle }).count() === 0
  await auditDialog.locator(".el-radio-button").filter({ hasText: /已归档/ }).click()
  const archivedDraftRow = auditDialog.locator(".audit-row").filter({ hasText: emptyDraftTitle }).first()
  await archivedDraftRow.waitFor({ timeout: 15_000 })
  const archivedDraftRowText = await archivedDraftRow.innerText()
  const archivedDraftVisible = archivedDraftRowText.includes("已归档") && archivedDraftRowText.includes("保留审计记录")
  await auditDialog.getByRole("button", { name: "关闭", exact: true }).click()

  const editor = page.locator(".question-bank-editor")
  const bodyText = await editor.innerText()
  const publishedNotice = editor.getByText("已发布版本不可直接修改。如需调整，请先创建新版本。", { exact: true })
  const codeInput = card.locator(".el-form-item", { hasText: "题目编号" }).locator("input")
  const desktopNoHorizontalOverflow = await page.evaluate(() => document.body.scrollWidth <= document.body.clientWidth)
  await page.screenshot({ path: screenshotPath, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "版本审计", exact: true }).click()
  await auditDialog.waitFor({ timeout: 15_000 })
  const auditTable = auditDialog.locator(".audit-table")
  await auditTable.waitFor({ timeout: 15_000 })
  const mobileLayout = await page.evaluate(() => {
    const dialog = document.querySelector(".question-bank-audit-dialog")
    const table = document.querySelector(".question-bank-audit-dialog .audit-table")
    const scope = document.querySelector(".question-bank-audit-dialog .el-radio-group")
    const dialogRect = dialog?.getBoundingClientRect()
    const tableRect = table?.getBoundingClientRect()
    const scopeRect = scope?.getBoundingClientRect()
    return {
      noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
      dialogWithinViewport: Boolean(dialogRect && dialogRect.left >= 0 && dialogRect.right <= window.innerWidth),
      tableContained: Boolean(tableRect && tableRect.left >= 0 && tableRect.right <= window.innerWidth),
      scopeContained: Boolean(scopeRect && dialogRect && scopeRect.left >= dialogRect.left && scopeRect.right <= dialogRect.right)
    }
  })
  await page.screenshot({ path: mobileScreenshotPath })
  await auditDialog.getByRole("button", { name: "关闭", exact: true }).click()

  const result = {
    title,
    published: bodyText.includes("已发布版本"),
    publishedNotice: await publishedNotice.count() > 0,
    questionCount: bodyText.includes("1 题"),
    inputsReadOnly: await codeInput.isDisabled(),
    auditVersionVisible,
    auditVersionRowText,
    removedFromIssues,
    archivedDraftVisible,
    archivedDraftRowText,
    noHorizontalOverflow: desktopNoHorizontalOverflow,
    mobileLayout,
    errors,
    screenshot: screenshotPath,
    mobileScreenshot: mobileScreenshotPath
  }
  const report = { format: "wurenji-question-bank-management-browser-acceptance", formatVersion: 4, generatedAt: new Date().toISOString(), baseUrl, result, passed: result.published && result.publishedNotice && result.questionCount && result.inputsReadOnly && result.auditVersionVisible && result.removedFromIssues && result.archivedDraftVisible && result.noHorizontalOverflow && Object.values(result.mobileLayout).every(Boolean) && errors.length === 0 }
  await mkdir(resolve(outputPath, ".."), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshot: screenshotPath, mobileScreenshot: mobileScreenshotPath }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}

function collectPageErrors(targetPage) {
  const values = []
  targetPage.on("pageerror", (error) => values.push(error.message))
  targetPage.on("console", (message) => { if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) values.push(message.text()) })
  targetPage.on("response", (response) => { if (response.status() >= 400 && !response.url().endsWith("/api/auth/me")) values.push(`${response.status()} ${response.url()}`) })
  return values
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
