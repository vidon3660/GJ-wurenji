import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const apiBase = (process.env.APP_BASE_URL ?? `${baseUrl}/api`).replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const fixturePath = resolve(process.env.TEACHER_ALERT_FIXTURE_JSON ?? "artifacts/vtl-aircraft-detail-fixture-latest.json")
const outputPath = resolve(process.env.TEACHER_ALERT_BROWSER_OUTPUT ?? "artifacts/teacher-alert-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.TEACHER_ALERT_BROWSER_SCREENSHOT ?? "artifacts/teacher-alert-browser.png")
const viewportWidth = Number(process.env.TEACHER_ALERT_VIEWPORT_WIDTH ?? 1440)
const viewportHeight = Number(process.env.TEACHER_ALERT_VIEWPORT_HEIGHT ?? 900)
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
if (!fixture.projectId || !fixture.title) throw new Error("教师告警夹具无效")

const teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const runtimeBefore = await request(`/v3/vtl-projects/${fixture.projectId}/runtime`, { cookie: teacherCookie })
const weatherEvent = runtimeBefore.events.find((event) => event.code === "VTL_WEATHER")
if (!weatherEvent) throw new Error("教师告警夹具缺少 VTL_WEATHER 事件")
if (weatherEvent.status === "PENDING") {
  await request(`/v3/vtl-projects/${fixture.projectId}/runtime/events/VTL_WEATHER/trigger`, {
    method: "POST",
    cookie: teacherCookie,
    body: { expectedRevision: runtimeBefore.session.revision, requestId: `teacher-alert-${Date.now()}` }
  })
}

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 })
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
  await page.getByRole("button", { name: "学生进度", exact: true }).click()
  await page.locator(".progress-page").waitFor({ timeout: 15_000 })
  const internalToggle = page.getByRole("checkbox", { name: "包含演示/验收数据", exact: true })
  if (await internalToggle.count() && !(await internalToggle.isChecked())) {
    await page.locator(".progress-filter-band .el-checkbox").filter({ hasText: "包含演示/验收数据" }).click()
    await page.waitForTimeout(300)
  }
  const pageRowsBeforeLoadMore = await page.locator(".progress-table-row").count()
  const loadMoreButton = page.getByRole("button", { name: /加载更多/ })
  await loadMoreButton.waitFor({ timeout: 10_000 })
  await loadMoreButton.click()
  await page.waitForFunction((previousCount) => document.querySelectorAll(".progress-table-row").length > previousCount, pageRowsBeforeLoadMore, { timeout: 15_000 })
  const paginationApplied = (await page.locator(".progress-table-row").count()) > pageRowsBeforeLoadMore
  await page.getByRole("button", { name: /告警中心/ }).click()
  await page.locator(".progress-page").waitFor({ timeout: 15_000 })
  const alertInternalToggle = page.getByRole("checkbox", { name: "包含演示/验收数据", exact: true })
  if (await alertInternalToggle.count() && !(await alertInternalToggle.isChecked())) {
    await page.locator(".progress-filter-band .el-checkbox").filter({ hasText: "包含演示/验收数据" }).click()
    await page.waitForTimeout(300)
  }
  await page.locator(".progress-filter-band input[placeholder='搜索学生或任务']").fill(fixture.title)
  const row = page.locator(".progress-table-row").filter({ hasText: fixture.title }).first()
  await row.waitFor({ timeout: 15_000 })
  const clearFiltersButton = page.getByRole("button", { name: /清除筛选/ })
  await clearFiltersButton.waitFor({ timeout: 10_000 })
  await clearFiltersButton.click()
  await page.waitForFunction(() => !(document.querySelector(".progress-filter-band input[placeholder='搜索学生或任务']")?.value), null, { timeout: 10_000 })
  const clearFiltersApplied = !(await page.locator(".progress-filter-band input[placeholder='搜索学生或任务']").inputValue())
  await page.locator(".progress-filter-band input[placeholder='搜索学生或任务']").fill(fixture.title)
  await row.waitFor({ timeout: 10_000 })
  const fixtureRowsBeforeClassFilter = await page.locator(".progress-table-row").count()
  const classroomSelect = page.getByRole("combobox", { name: "按班级筛选学生进度", exact: true })
  const classroomSelectShell = page.locator(".progress-filter-band .el-select").filter({ has: classroomSelect })
  await classroomSelect.waitFor({ timeout: 10_000 })
  await classroomSelectShell.click()
  const classroomOption = page.getByRole("option").first()
  await classroomOption.waitFor({ timeout: 10_000 })
  const classroomLabel = (await classroomOption.innerText()).trim()
  await classroomOption.click()
  await page.waitForTimeout(300)
  const selectedClassroomLabel = (await classroomSelectShell.locator(".el-select__selected-item:not(.el-select__input-wrapper)").innerText()).trim()
  const classroomFilterApplied = selectedClassroomLabel === classroomLabel && (await classroomSelect.getAttribute("aria-expanded")) === "false"
  const fixtureRowsAfterClassFilter = await page.locator(".progress-table-row").count()
  const classroomFilterChangedResult = fixtureRowsAfterClassFilter !== fixtureRowsBeforeClassFilter
  if (classroomFilterChangedResult) {
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
    const reloadSkip = page.getByRole("button", { name: "跳过引导", exact: true })
    if (await reloadSkip.count() && await reloadSkip.first().isVisible()) await reloadSkip.first().click()
    await page.getByRole("button", { name: /告警中心/ }).click()
    await page.locator(".progress-page").waitFor({ timeout: 15_000 })
    const reloadInternalToggle = page.getByRole("checkbox", { name: "包含演示/验收数据", exact: true })
    if (await reloadInternalToggle.count() && !(await reloadInternalToggle.isChecked())) {
      await page.locator(".progress-filter-band .el-checkbox").filter({ hasText: "包含演示/验收数据" }).click()
      await page.waitForTimeout(300)
    }
    await page.locator(".progress-filter-band input[placeholder='搜索学生或任务']").fill(fixture.title)
  }
  const restoredRow = page.locator(".progress-table-row").filter({ hasText: fixture.title }).first()
  await restoredRow.waitFor({ timeout: 10_000 })
  const stalledToggle = page.getByRole("checkbox", { name: "只显示已停滞项目", exact: true })
  const stalledToggleLabel = page.locator(".progress-filter-band .el-checkbox").filter({ hasText: "只看已停滞" })
  await stalledToggleLabel.waitFor({ timeout: 10_000 })
  await stalledToggleLabel.click()
  await page.waitForFunction(() => document.querySelectorAll(".progress-table-row").length > 0, null, { timeout: 10_000 })
  const stalledFilterApplied = await stalledToggle.isChecked()
  await stalledToggleLabel.click()
  await restoredRow.waitFor({ timeout: 10_000 })
  const progressFilters = page.locator(".progress-filter-band .el-select")
  await progressFilters.nth(5).click()
  await page.getByRole("option", { name: "警告", exact: true }).click()
  const alertLink = row.locator(".progress-alert-link")
  await alertLink.waitFor({ timeout: 10_000 })
  const globalToolbar = page.locator(".teacher-alert-global-toolbar")
  await globalToolbar.waitFor({ timeout: 10_000 })
  const globalBatchToolbarVisible = await globalToolbar.isVisible()
  await globalToolbar.getByRole("button", { name: "全选匹配告警", exact: true }).click()
  await page.getByText(/已选 [1-9]\d* 条 · 当前已加载/).waitFor({ timeout: 10_000 })
  const matchingAlertSelectionApplied = /已选 [1-9]\d* 条/.test(await globalToolbar.innerText())
  await row.locator(".progress-alert-actions input[type='checkbox']").first().check()
  await globalToolbar.getByRole("button", { name: "关注选中告警", exact: true }).click()
  await page.waitForFunction(() => !document.querySelector(".teacher-alert-global-toolbar .el-button.is-loading"), null, { timeout: 10_000 })
  await progressFilters.nth(6).click()
  await page.getByRole("option", { name: "教师关注中", exact: true }).click()
  await row.waitFor({ timeout: 10_000 })
  await alertLink.click()
  const drawer = page.locator(".teacher-alert-drawer")
  await drawer.waitFor({ timeout: 10_000 })
  const followUpCheckbox = drawer.locator("input[type='checkbox']").first()
  await followUpCheckbox.check()
  await drawer.getByPlaceholder("可选：记录本次教学跟踪备注").fill("浏览器验收教师跟踪")
  await drawer.getByRole("button", { name: "关注选中告警", exact: true }).click()
  await page.getByText("教师关注中", { exact: true }).first().waitFor({ timeout: 10_000 })
  await page.waitForFunction(() => !document.querySelector(".teacher-alert-follow-up-form .el-button.is-loading"), null, { timeout: 10_000 })
  await drawer.locator("input[type='checkbox']").first().check()
  await drawer.getByRole("button", { name: "关闭关注", exact: true }).click()
  await drawer.locator(".teacher-follow-up-tag.closed").first().waitFor({ timeout: 10_000 })
  const bodyText = await drawer.innerText()
  const readableFollowUpText = !bodyText.includes("待处置教师") && !bodyText.includes("未填写备注更新于")
  const layout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    drawer: Boolean(document.querySelector(".teacher-alert-drawer")),
    recommendation: Array.from(document.querySelectorAll(".teacher-alert-detail dt")).some((item) => item.textContent?.includes("推荐动作")),
    ruleDeadline: Array.from(document.querySelectorAll(".teacher-alert-detail dt")).some((item) => item.textContent?.includes("处置规则")),
    projectEntry: Boolean(document.querySelector(".teacher-alert-drawer-actions")),
    globalBatchToolbar: Boolean(document.querySelector(".teacher-alert-global-toolbar")),
    matchingAlertSelection: false,
    filterControls: document.querySelectorAll(".progress-filter-band .el-select").length >= 8,
    followUpControls: Boolean(document.querySelector(".teacher-alert-follow-up-form")),
    followUpStatus: Array.from(document.querySelectorAll(".teacher-follow-up-tag")).some((item) => item.textContent?.includes("教师已关闭关注")),
    classroomFilter: Boolean(document.querySelector(".progress-filter-band input[aria-label='按班级筛选学生进度']")),
    clearFilters: Boolean(document.querySelector(".progress-clear-filters")),
    pagination: Boolean(document.querySelector(".progress-load-more"))
  }))
  layout.globalBatchToolbar = globalBatchToolbarVisible
  layout.matchingAlertSelection = matchingAlertSelectionApplied
  layout.stalledFilter = stalledFilterApplied
  layout.classroomFilter = classroomFilterApplied && classroomFilterChangedResult && layout.classroomFilter
  layout.clearFilters = clearFiltersApplied && layout.clearFilters
  layout.pagination = paginationApplied
  layout.readableFollowUpText = readableFollowUpText
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const report = { format: "wurenji-teacher-alert-browser-acceptance", formatVersion: 10, generatedAt: new Date().toISOString(), viewport: { width: viewportWidth, height: viewportHeight }, projectId: fixture.projectId, title: fixture.title, classroomLabel, layout, errors, screenshot: screenshotPath, bodyText, passed: errors.length === 0 && layout.noHorizontalOverflow && layout.drawer && layout.recommendation && layout.ruleDeadline && layout.projectEntry && layout.globalBatchToolbar && layout.matchingAlertSelection && layout.filterControls && layout.followUpControls && layout.followUpStatus && layout.readableFollowUpText && layout.stalledFilter && layout.classroomFilter && layout.clearFilters && layout.pagination }
  await mkdir(dirname(outputPath), { recursive: true })
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
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}

async function login(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`登录失败：${response.status} ${JSON.stringify(body)}`)
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
  if (!cookie) throw new Error("登录未返回 Cookie")
  return cookie
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { method: options.method ?? "GET", headers: { Origin: origin, ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function parseBody(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text }
}
