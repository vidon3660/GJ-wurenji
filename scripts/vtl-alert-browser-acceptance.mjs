import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const apiBase = (process.env.APP_BASE_URL ?? `${baseUrl}/api`).replace(/\/$/, "")
const fixturePath = resolve(process.env.VTL_ALERT_FIXTURE_JSON ?? "artifacts/vtl-alert-browser-fixture-latest.json")
const outputPath = resolve(process.env.VTL_ALERT_BROWSER_OUTPUT ?? "artifacts/vtl-alert-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.VTL_ALERT_BROWSER_SCREENSHOT ?? "artifacts/vtl-alert-browser-student.png")
const viewportWidth = Number(process.env.VTL_ALERT_VIEWPORT_WIDTH ?? 1440)
const viewportHeight = Number(process.env.VTL_ALERT_VIEWPORT_HEIGHT ?? 900)
const eventCode = process.env.VTL_ALERT_EVENT_CODE?.trim() || "VTL_ENERGY_POWER"
const actionCode = process.env.VTL_ALERT_ACTION_CODE?.trim() || "DIVERT_AIRCRAFT"
const testTimeout = process.env.VTL_ALERT_TEST_TIMEOUT === "true"
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
if (!fixture.projectId || !fixture.title || fixture.stage !== "VTL_RUNTIME") throw new Error("VTL 告警夹具无效")

const teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const studentCookie = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
let before = await request(`/v3/vtl-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
if (before.session.status === "READY") {
  before = await request(`/v3/vtl-projects/${fixture.projectId}/runtime/start`, {
    method: "POST",
    cookie: studentCookie,
    body: { expectedRevision: before.session.revision }
  })
}
if (before.session.status === "PAUSED" && !before.events.some((item) => item.status === "ACTIVE")) {
  before = await request(`/v3/vtl-projects/${fixture.projectId}/runtime/clock-rate`, {
    method: "POST",
    cookie: studentCookie,
    body: { expectedRevision: before.session.revision, rate: Math.max(0.25, Number(before.clockRate ?? 1)), status: "RUNNING" }
  })
}
const eventBefore = [...before.events].reverse().find((item) => item.code === eventCode) ?? null
const triggeredRuntime = await request(`/v3/vtl-projects/${fixture.projectId}/runtime/events/${eventCode}/trigger`, {
  method: "POST",
  cookie: teacherCookie,
  body: { expectedRevision: before.session.revision, requestId: randomUUID() }
})
const trackedEvent = [...triggeredRuntime.events].reverse().find((item) => item.code === eventCode && item.status !== "RESOLVED")
if (!trackedEvent) throw new Error(`VTL 触发后未返回当前事件：${JSON.stringify(triggeredRuntime.events)}`)
let activeRuntime = await waitForRuntime((value) => value.alerts.some((item) => item.eventId === trackedEvent.id && item.status !== "RESOLVED")
  && value.events.some((item) => item.id === trackedEvent.id && item.status === "ACTIVE"))
let timeoutPath = { requested: testTimeout, escalated: false, withinDeadline: null, evidenceVisible: false }
if (testTimeout) {
  const accelerated = await request(`/v3/vtl-projects/${fixture.projectId}/runtime/clock-rate`, {
    method: "POST",
    cookie: studentCookie,
    body: { expectedRevision: activeRuntime.session.revision, rate: 600, status: "RUNNING" }
  })
  activeRuntime = await waitForRuntime((value) => {
    const event = value.events.find((item) => item.id === trackedEvent.id)
    return Number(event?.payload?.escalatedSimulationTimeMs ?? Number.POSITIVE_INFINITY) <= Number(value.session.simulationTimeMs)
      || String(event?.detail ?? "").includes("处置超时")
  })
  timeoutPath.escalated = true
  if (activeRuntime.session.status === "RUNNING") {
    activeRuntime = await request(`/v3/vtl-projects/${fixture.projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: activeRuntime.session.revision, rate: 5, status: "PAUSED" }
    })
  }
}

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const errors = []
const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 })
const page = await context.newPage()
const actionEndpoint = `${apiBase}/v3/vtl-projects/${fixture.projectId}/runtime/actions`
let failureInjected = false
page.on("pageerror", (error) => errors.push(error.message))
page.on("console", (message) => {
  const expectedFailure = failureInjected && message.type() === "error" && message.text().includes("409") && message.text().includes("Conflict")
  if (message.type() === "error" && !message.text().includes("401 (Unauthorized)") && !expectedFailure) errors.push(message.text())
})
page.on("response", (response) => {
  const expectedFailure = failureInjected && response.url() === actionEndpoint && response.status() === 409
  if (response.status() >= 400 && !response.url().endsWith("/api/auth/me") && !expectedFailure) errors.push(`${response.status()} ${response.url()}`)
})

try {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" })
  await page.getByRole("button", { name: "\u5b66\u751f\u6f14\u793a", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "\u8df3\u8fc7\u5f15\u5bfc", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click()
    await projectsReloaded
  }
  await page.locator(".home-scene-segment button").filter({ hasText: "\u5de1\u68c0" }).click()
  await page.locator(".student-task-search input").fill(fixture.title)
  const project = page.getByText(fixture.title, { exact: true }).first()
  try {
    await project.waitFor({ timeout: 15_000 })
  } catch (error) {
    await page.screenshot({ path: screenshotPath.replace(/\.png$/, "-debug.png"), fullPage: true })
    process.stderr.write(`${await page.locator("body").innerText()}\n`)
    throw error
  }
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".vtl-runtime-workspace").waitFor({ timeout: 15_000 })
  const quickNav = page.locator(".vtl-runtime-quick-nav [data-runtime-jump]")
  const quickNavCheck = { visible: viewportWidth <= 680 ? await quickNav.count() === 4 : true, targetsPresent: viewportWidth <= 680 ? await page.locator(".vtl-situation-panel, .vtl-runtime-map, .vtl-event-panel, .student-action-console").count() >= 4 : true, clicks: 0 }
  if (viewportWidth <= 680) {
    for (const selector of ["situation", "map", "alerts", "handling"]) {
      const button = page.locator(`[data-runtime-jump="${selector}"]`)
      await button.click()
      quickNavCheck.clicks += 1
    }
  }
  const eventCard = page.locator(".event-list button").filter({ hasText: trackedEvent.title }).first()
  await eventCard.waitFor({ timeout: 15_000 })
  await eventCard.click()
  const pauseState = await page.evaluate(() => {
    const notice = document.querySelector(".event-pause-state")
    const pauseButton = [...document.querySelectorAll(".vtl-runtime-actions button")].find((button) => button.getAttribute("aria-label") === "继续仿真")
    return {
      visible: Boolean(notice && (notice instanceof HTMLElement) && notice.offsetWidth > 0 && notice.offsetHeight > 0),
      text: notice?.textContent?.trim() ?? "",
      accessibleName: notice?.getAttribute("aria-label") ?? "",
      continueDisabled: pauseButton instanceof HTMLButtonElement && pauseButton.disabled,
      noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth
    }
  })
  const pauseStateValid = pauseState.visible
    && pauseState.text.includes("未处置事件，仿真已暂停")
    && pauseState.text.includes("处置时限按仿真时间计算")
    && pauseState.accessibleName.includes("完成当前事件后才能继续")
    && pauseState.continueDisabled
    && pauseState.noHorizontalOverflow
  if (!pauseStateValid) throw new Error(`巡检暂停提示验收失败：${JSON.stringify(pauseState)}`)
  const actionSelect = page.getByLabel("选择应急处置动作")
  await actionSelect.selectOption(actionCode)
  const targetSelect = page.getByLabel("选择处置航空器")
  const affectedAircraftId = trackedEvent.affectedAircraftIds[0]
  if (!affectedAircraftId) throw new Error("垂起能源事件未提供受影响航空器")
  await targetSelect.selectOption(affectedAircraftId)
  const reasoning = page.locator(".student-action-console textarea")
  const expectedReasoning = [
    "发现目标航空器能源余度不足，继续巡检可能无法安全返航",
    "比较剩余能源、未完成巡检任务与备降点后，选择立即备降",
    "航空器停止当前巡检并转向备降点，剩余任务进入重新安排"
  ]
  await reasoning.nth(0).fill(expectedReasoning[0])
  await reasoning.nth(1).fill(expectedReasoning[1])
  await reasoning.nth(2).fill(expectedReasoning[2])
  const submit = page.locator(".student-action-console button.primary")
  if (await submit.isDisabled()) throw new Error("填写完整处置依据后执行按钮仍不可用")
  await page.route(actionEndpoint, async (route) => {
    if (failureInjected) return route.continue()
    failureInjected = true
    const body = route.request().postDataJSON()
    const conflict = await requestOutcome(`/v3/vtl-projects/${fixture.projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: body.expectedRevision, rate: Math.max(0.25, Number(activeRuntime.clockRate ?? 1)), status: "PAUSED" }
    })
    if (!conflict.ok) throw new Error(`制造垂起旧 revision 冲突失败：${conflict.status} ${JSON.stringify(conflict.body)}`)
    await route.continue()
  })
  const failedRequest = page.waitForRequest((request) => request.url() === actionEndpoint && request.method() === "POST")
  const failedResponse = page.waitForResponse((response) => response.url() === actionEndpoint && response.request().method() === "POST" && response.status() === 409)
  await submit.click()
  const failedBody = (await failedRequest).postDataJSON()
  await failedResponse
  const failureNotice = page.locator(".runtime-action-error")
  await failureNotice.waitFor({ timeout: 10_000 })
  const retainedReasoning = await reasoning.evaluateAll((items) => items.map((item) => item.value))
  const retryButton = failureNotice.getByRole("button", { name: "重试处置", exact: true })
  const studentFailureRecovery = {
    conflictStatus: 409,
    failureNoticeVisible: await failureNotice.isVisible(),
    noticeText: await failureNotice.innerText(),
    inputsRetained: JSON.stringify(retainedReasoning) === JSON.stringify(expectedReasoning),
    retryVisible: await retryButton.isVisible(),
    firstRequestId: failedBody.requestId ?? null,
    retryRequestId: null,
    retrySucceeded: false
  }
  if (!studentFailureRecovery.failureNoticeVisible || !studentFailureRecovery.inputsRetained || !studentFailureRecovery.retryVisible) {
    throw new Error(`垂起失败处置恢复体验不完整：${JSON.stringify(studentFailureRecovery)}`)
  }
  const retryRequest = page.waitForRequest((request) => request.url() === actionEndpoint && request.method() === "POST" && request.postDataJSON()?.requestId !== failedBody.requestId)
  const retryResponse = page.waitForResponse((response) => response.url() === actionEndpoint && response.request().method() === "POST" && response.status() >= 200 && response.status() < 300)
  await retryButton.click()
  const retryBody = (await retryRequest).postDataJSON()
  await retryResponse
  studentFailureRecovery.retryRequestId = retryBody.requestId ?? null
  studentFailureRecovery.retrySucceeded = Boolean(retryBody.requestId && retryBody.requestId !== failedBody.requestId)
  const resolvedRuntime = await waitForRuntime((value) => value.actions.some((item) => item.actionCode === actionCode && item.eventId === trackedEvent.id)
    && value.events.some((item) => item.id === trackedEvent.id && item.status === "RESOLVED"))
  const appliedAction = [...resolvedRuntime.actions].reverse().find((item) => item.actionCode === actionCode && item.eventId === trackedEvent.id)
  if (!appliedAction) throw new Error("处置完成后未返回对应动作结果")
  const resultPanel = page.locator(".vtl-action-result")
  await resultPanel.waitFor({ timeout: 15_000 })
  await eventCard.click()
  await resultPanel.scrollIntoViewIfNeeded()
  const resolvedButton = page.locator(".student-action-console button.primary")
  const briefing = await page.evaluate(() => ({
    role: document.querySelector(".vtl-event-briefing .briefing-role dd")?.textContent?.trim() ?? "",
    request: document.querySelector(".vtl-event-briefing .briefing-request dd")?.textContent?.trim() ?? "",
    impact: document.querySelector(".vtl-event-briefing .briefing-impact dd")?.textContent?.trim() ?? "",
    objective: document.querySelector(".vtl-event-briefing .briefing-objective dd")?.textContent?.trim() ?? "",
    successCriteria: document.querySelector(".vtl-event-briefing .briefing-success dd")?.textContent?.trim() ?? "",
    deadline: document.querySelector(".vtl-event-briefing .briefing-deadline dd")?.textContent?.trim() ?? "",
    scoring: document.querySelector(".vtl-event-briefing .briefing-scoring dd")?.textContent?.trim() ?? ""
  }))
  const resultText = await resultPanel.innerText()
  const decisionText = await page.locator(".action-decision-log").innerText()
  const layout = await page.evaluate(() => {
    const result = document.querySelector(".vtl-action-result")?.getBoundingClientRect()
    return { noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth, cesiumCanvas: Boolean(document.querySelector(".vtl-runtime-workspace canvas")), decisionCount: document.querySelectorAll(".action-decision-log li").length, aircraftProfile: Boolean(document.querySelector(".aircraft-detail-panel")), currentTaskLabel: Boolean(document.querySelector(".aircraft-task-summary")), nextTaskLabel: Boolean(document.querySelector(".aircraft-task-summary.next")), resultInViewport: Boolean(result && result.top >= 0 && result.bottom <= window.innerHeight) }
  })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const consequences = Array.isArray(appliedAction.result.businessConsequences) ? appliedAction.result.businessConsequences.filter((item) => typeof item === "string" && item.trim()) : []
  const npcBriefingComplete = Object.values(briefing).every((value) => value.length > 0)
  const actionResultComplete = consequences.length > 0
    && Number.isFinite(Number(appliedAction.result.responseTimeMs))
    && typeof appliedAction.result.withinDeadline === "boolean"
    && appliedAction.result.eventControlled === true
    && consequences.every((item) => resultText.includes(item))
    && consequences.some((item) => decisionText.includes(item))
  timeoutPath.withinDeadline = appliedAction.result.withinDeadline
  timeoutPath.evidenceVisible = !testTimeout || resultText.includes("时限判定：超时")
  const resolvedReviewable = await resolvedButton.isDisabled() && (await resolvedButton.innerText()).includes("该事件已处置") && resultText.includes("评分证据") && layout.resultInViewport
  const report = { format: "wurenji-vtl-alert-browser-acceptance", formatVersion: 7, generatedAt: new Date().toISOString(), viewport: { width: viewportWidth, height: viewportHeight }, projectId: fixture.projectId, title: fixture.title, eventCode, eventId: trackedEvent.id, before: { eventStatus: eventBefore?.status ?? null, alertCount: before.alerts.length }, pauseState, after: { eventStatus: "RESOLVED", actionCode, responseTimeMs: appliedAction.result.responseTimeMs, withinDeadline: appliedAction.result.withinDeadline, eventControlled: appliedAction.result.eventControlled, businessConsequences: consequences }, teaching: { briefing, npcBriefingComplete, actionResultComplete, resolvedReviewable }, failurePaths: { studentRecovery: studentFailureRecovery, timeout: timeoutPath }, quickNav: quickNavCheck, layout, errors, screenshot: screenshotPath, passed: errors.length === 0 && pauseStateValid && npcBriefingComplete && actionResultComplete && resolvedReviewable && studentFailureRecovery.retrySucceeded && timeoutPath.escalated === testTimeout && timeoutPath.evidenceVisible && (!testTimeout || timeoutPath.withinDeadline === false) && quickNavCheck.visible && quickNavCheck.targetsPresent && quickNavCheck.clicks === (viewportWidth <= 680 ? 4 : 0) && layout.noHorizontalOverflow && layout.cesiumCanvas && layout.decisionCount > 0 && layout.aircraftProfile && layout.currentTaskLabel && layout.nextTaskLabel }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshot: screenshotPath }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}

async function waitForRuntime(predicate) {
  const deadline = Date.now() + 15_000
  let value = await request(`/v3/vtl-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    value = await request(`/v3/vtl-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
  }
  if (!predicate(value)) throw new Error(`等待 VTL 告警状态超时：${JSON.stringify(value.events)}`)
  return value
}

async function login(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`登录失败 ${email}: ${response.status} ${JSON.stringify(body)}`)
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
  if (!cookie) throw new Error(`登录未返回 Cookie: ${email}`)
  return cookie
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { method: options.method ?? "GET", headers: { Origin: origin, ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function requestOutcome(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { method: options.method ?? "GET", headers: { Origin: origin, ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
  return { status: response.status, ok: response.ok, body: await parseBody(response) }
}

async function parseBody(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text }
}

function browserExecutable() {
  const candidates = [process.env.CHROME_PATH, process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : undefined, process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean)
  const value = candidates.find((candidate) => existsSync(candidate))
  if (!value) throw new Error("未找到 Chrome，请通过 CHROME_PATH 指定浏览器路径")
  return value
}
