import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { chromium } from "playwright-core"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const apiBase = (process.env.APP_BASE_URL ?? `${baseUrl}/api`).replace(/\/$/, "")
const fixturePath = resolve(process.env.SHOW_ALERT_FIXTURE_JSON ?? "artifacts/show-alert-browser-fixture-latest.json")
const outputPath = resolve(process.env.SHOW_ALERT_BROWSER_OUTPUT ?? "artifacts/show-alert-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.SHOW_ALERT_BROWSER_SCREENSHOT ?? "artifacts/show-alert-browser-student.png")
const viewport = { width: positiveInteger(process.env.RUNTIME_ACCEPTANCE_VIEWPORT_WIDTH, 1440), height: positiveInteger(process.env.RUNTIME_ACCEPTANCE_VIEWPORT_HEIGHT, 900) }
const expectedEventCode = process.env.SHOW_ALERT_EVENT_CODE?.trim() || "BATTERY_ANOMALY"
const expectedActionCode = process.env.SHOW_ALERT_ACTION_CODE?.trim() || "SINGLE_LAND"
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const fixtureDocument = JSON.parse(await readFile(fixturePath, "utf8"))
const fixture = fixtureDocument.projects?.CITY_SHOW ?? fixtureDocument
if (!fixture.projectId || !fixture.title || fixture.stage !== "SHOW_RUNTIME" || fixture.isAcceptanceData !== true) throw new Error("城市表演告警夹具无效")

const teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const studentCookie = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
let before = await request(`/v3/show-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
if (before.phase !== "PERFORMANCE" || before.totals.airborneCount <= 0) {
  await request(`/v3/show-projects/${fixture.projectId}/runtime/clock-rate`, {
    method: "POST",
    cookie: studentCookie,
    body: { expectedRevision: before.session.revision, rate: 120, status: "RUNNING" }
  })
  const performanceRuntime = await waitForRuntime((value) => value.phase === "PERFORMANCE" && value.totals.airborneCount > 0, 50)
  before = await request(`/v3/show-projects/${fixture.projectId}/runtime/clock-rate`, {
    method: "POST",
    cookie: studentCookie,
    body: { expectedRevision: performanceRuntime.session.revision, rate: 120, status: "PAUSED" }
  })
}
const eventBefore = before.events.find((item) => item.code === expectedEventCode && item.status !== "RESOLVED")
if (!eventBefore) throw new Error(`城市表演告警夹具缺少 ${expectedEventCode} 可处置事件：${JSON.stringify(before.events)}`)
let activeRuntime = before
if (!before.alerts.some((item) => matchesEvent(item, eventBefore) && item.status !== "RESOLVED")) {
  const triggeredRuntime = eventBefore.status === "SCHEDULED"
    ? await request(`/v3/show-projects/${fixture.projectId}/runtime/events/${eventBefore.code}/trigger`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: before.session.revision, requestId: randomUUID() }
    })
    : before
  if (triggeredRuntime.session.status === "PAUSED") {
    await request(`/v3/show-projects/${fixture.projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: triggeredRuntime.session.revision, rate: 5, status: "RUNNING" }
    })
  }
  activeRuntime = await waitForRuntime((value) => value.alerts.some((item) => matchesEvent(item, eventBefore) && item.status !== "RESOLVED"), 50)
  if (activeRuntime.session.status === "RUNNING") {
    activeRuntime = await request(`/v3/show-projects/${fixture.projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: activeRuntime.session.revision, rate: 5, status: "PAUSED" }
    })
  }
}
const activeAlert = activeRuntime.alerts.find((item) => matchesEvent(item, eventBefore) && item.status !== "RESOLVED")
if (!activeAlert) throw new Error("城市表演事件触发后未生成活动告警")

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const errors = []
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
const page = await context.newPage()
const actionEndpoint = `${apiBase}/v3/show-projects/${fixture.projectId}/runtime/actions`
let failureInjected = false
page.on("pageerror", (error) => errors.push(error.stack ?? error.message))
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
  await page.getByRole("button", { name: "学生演示", exact: true }).click()
  await page.locator(".platform-shell").waitFor({ timeout: 15_000 })
  const skip = page.getByRole("button", { name: "跳过引导", exact: true })
  if (await skip.count() && await skip.first().isVisible()) await skip.first().click()
  const internalDataToggle = page.locator(".student-task-toolbar .el-checkbox")
  if (await internalDataToggle.count() && await internalDataToggle.first().isVisible() && !(await internalDataToggle.first().locator("input").isChecked())) {
    const projectsReloaded = page.waitForResponse((response) => response.url().includes("/v3/my-projects?includeInternalData=true") && response.status() === 200)
    await internalDataToggle.first().click()
    await projectsReloaded
  }
  await page.locator(".home-scene-segment button").filter({ hasText: "表演" }).click()
  await page.locator(".student-task-search input").fill(fixture.title)
  const project = page.getByText(fixture.title, { exact: true }).first()
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".show-runtime-workspace").waitFor({ timeout: 15_000 })
  const quickNav = page.locator(".show-runtime-quick-nav [data-runtime-jump]")
  const quickNavCheck = { visible: viewport.width <= 760 ? await quickNav.count() === 3 : true, targetsPresent: viewport.width <= 760 ? await page.locator(".runtime-map-panel, .runtime-control-panel, .runtime-alert-deck").count() >= 3 : true, clicks: 0 }
  if (viewport.width <= 760) {
    for (const selector of ["map", "handling", "alerts"]) {
      await page.locator(`[data-runtime-jump="${selector}"]`).click()
      quickNavCheck.clicks += 1
    }
    await page.locator('[data-runtime-jump="map"]').click()
  }
  const show3dButton = page.getByRole("button", { name: "3D 俯视", exact: true })
  await show3dButton.waitFor({ timeout: 10_000 })
  await show3dButton.click()
  await page.waitForFunction(() => document.querySelector(".show-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "3d")
  const mapView = page.locator('.view-segment[aria-label="地图视角"]')
  await mapView.getByRole("button", { name: "3D 空间理解视角", exact: true }).click()
  await page.waitForFunction(() => document.querySelector(".show-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "3d")
  const threeD = await readStaticMap(page, ".show-runtime-map-shell")
  await mapView.getByRole("button", { name: "2D 精确规划视角", exact: true }).click()
  await page.waitForFunction(() => document.querySelector(".show-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "2d")
  const twoD = await readStaticMap(page, ".show-runtime-map-shell")
  await mapView.getByRole("button", { name: "3D 空间理解视角", exact: true }).click()
  await page.waitForFunction(() => document.querySelector(".show-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "3d")
  const final3D = await readStaticMap(page, ".show-runtime-map-shell")
  const runtimeLayout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    cesiumCanvas: Boolean(document.querySelector(".show-runtime-workspace canvas")),
    alertDeck: Boolean(document.querySelector(".runtime-alert-deck")),
    timeline: Boolean(document.querySelector(".runtime-event-strip"))
  }))
  const alertCard = page.locator(".runtime-alert-list article").filter({ hasText: activeAlert.title }).first()
  await alertCard.waitFor({ timeout: 15_000 })
  await alertCard.click()
  const npcBriefing = page.locator(".show-event-briefing")
  await npcBriefing.waitFor({ timeout: 10_000 })
  const npcBriefingText = await npcBriefing.innerText()
  const npcBriefingComplete = await npcBriefing.locator("dt").count() === 7
    && ["业务角色", "业务请求", "影响对象", "处置目标", "成功判据", "处置时限", "评分关注", "机队设备监控系统", "编队缺口", "邻机安全复核"].every((text) => npcBriefingText.includes(text))
  if (!npcBriefingComplete) throw new Error(`城市表演 NPC 简报不完整：${npcBriefingText}`)
  const actionTitle = showActionTitle(expectedActionCode)
  const actionSelect = page.locator(".runtime-action-console .el-select").first()
  await actionSelect.click()
  await page.getByRole("option", { name: new RegExp(actionTitle) }).click()
  const targetSelect = page.locator(".runtime-action-console .el-select").nth(1)
  await targetSelect.waitFor({ timeout: 10_000 })
  const selectedTargetText = async () => (await targetSelect.innerText()).trim()
  await page.waitForTimeout(250)
  if (!(await selectedTargetText())) {
    await targetSelect.click()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelectorAll(".runtime-action-console .el-select")[1]?.textContent?.includes("单架"))
  }
  if (!(await selectedTargetText()).includes("单架")) throw new Error("城市表演单机处置未选择可执行目标")
  const reasoning = page.locator(".action-reasoning-fields textarea")
  if (await reasoning.count() < 3) throw new Error("城市表演应急处置缺少三项决策输入")
  await reasoning.nth(0).fill("发现单架无人机电池压差扩大，继续表演可能失去安全返航余度")
  await reasoning.nth(1).fill("依据设备告警、受影响编队和当前节目阶段，优先安排异常单机安全退出")
  await reasoning.nth(2).fill("异常单机降落后形成可识别的编队缺口，并继续复核图案、时序和邻机安全")
  const actionButton = page.getByRole("button", { name: "执行处置", exact: true })
  await actionButton.waitFor({ timeout: 10_000 })
  if (await actionButton.isDisabled()) throw new Error("填写完整表演处置依据后执行按钮仍不可用")
  await page.route(actionEndpoint, async (route) => {
    if (failureInjected) return route.continue()
    failureInjected = true
    const body = route.request().postDataJSON()
    const conflict = await requestOutcome(`/v3/show-projects/${fixture.projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: body.expectedRevision, rate: 5, status: "PAUSED" }
    })
    if (!conflict.ok) throw new Error(`制造旧 revision 冲突失败：${conflict.status} ${JSON.stringify(conflict.body)}`)
    await route.continue()
  })
  const submittedActionRequest = page.waitForRequest((request) => request.url() === actionEndpoint && request.method() === "POST")
  const failedActionResponse = page.waitForResponse((response) => response.url() === actionEndpoint && response.request().method() === "POST" && response.status() === 409)
  await actionButton.click()
  const submittedActionBody = (await submittedActionRequest).postDataJSON()
  if (!submittedActionBody.requestId) throw new Error("城市表演处置请求缺少 requestId，无法验证幂等保护")
  await failedActionResponse
  const failureNotice = page.locator(".runtime-action-error")
  await failureNotice.waitFor({ timeout: 10_000 })
  const retainedReasoning = await page.locator(".action-reasoning-fields textarea").evaluateAll((items) => items.map((item) => item.value))
  const expectedReasoning = [
    "发现单架无人机电池压差扩大，继续表演可能失去安全返航余度",
    "依据设备告警、受影响编队和当前节目阶段，优先安排异常单机安全退出",
    "异常单机降落后形成可识别的编队缺口，并继续复核图案、时序和邻机安全"
  ]
  const failureRecovery = {
    conflictStatus: 409,
    failureNoticeVisible: await failureNotice.isVisible(),
    noticeText: await failureNotice.innerText(),
    inputsRetained: JSON.stringify(retainedReasoning) === JSON.stringify(expectedReasoning),
    retryVisible: await failureNotice.getByRole("button", { name: "重试处置", exact: true }).isVisible(),
    firstRequestId: submittedActionBody.requestId
  }
  if (!failureRecovery.failureNoticeVisible || !failureRecovery.inputsRetained || !failureRecovery.retryVisible) {
    throw new Error(`城市表演失败处置恢复体验不完整：${JSON.stringify(failureRecovery)}`)
  }
  const retryRequest = page.waitForRequest((request) => request.url() === actionEndpoint && request.method() === "POST" && request.postDataJSON()?.requestId !== submittedActionBody.requestId)
  const retryResponse = page.waitForResponse((response) => response.url() === actionEndpoint && response.request().method() === "POST" && response.status() >= 200 && response.status() < 300)
  await failureNotice.getByRole("button", { name: "重试处置", exact: true }).click()
  const retryBody = (await retryRequest).postDataJSON()
  await retryResponse
  failureRecovery.retrySucceeded = retryBody.requestId !== submittedActionBody.requestId
  const successfulActionBody = retryBody
  const after = await waitForRuntime((value) => value.actions.some((item) => (item.eventId === eventBefore.id || item.eventCode === eventBefore.code) && item.actionCode === expectedActionCode) && value.events.some((item) => item.id === eventBefore.id && item.status === "RESOLVED"))
  const actionResultPanel = page.locator(".show-action-result")
  await actionResultPanel.waitFor({ timeout: 10_000 })
  const actionResultText = await actionResultPanel.innerText()
  const actionResultComplete = ["实际业务后果", "退出当前表演任务", "编队缺口", "图案完整性", "节目时序", "邻机安全间距", "评分证据", "时限判定：达标", "事件控制：成功"].every((text) => actionResultText.includes(text))
  if (!actionResultComplete) throw new Error(`城市表演处置结果不完整：${actionResultText}`)
  const actionResultGeometry = await actionResultPanel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const controlPanel = element.closest(".runtime-control-panel")
    const controlRect = controlPanel?.getBoundingClientRect()
    return {
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      controlPanelTop: controlRect ? Math.round(controlRect.top) : null,
      controlPanelBottom: controlRect ? Math.round(controlRect.bottom) : null,
      controlPanelScrollTop: controlPanel instanceof HTMLElement ? Math.round(controlPanel.scrollTop) : null
    }
  })
  const resultInViewport = actionResultGeometry.top >= 0 && actionResultGeometry.bottom <= actionResultGeometry.viewportHeight && actionResultGeometry.left >= 0 && actionResultGeometry.right <= actionResultGeometry.viewportWidth
  const resolvedAlertCard = page.locator(".runtime-alert-list article.resolved").filter({ hasText: activeAlert.title }).first()
  await resolvedAlertCard.waitFor({ timeout: 10_000 })
  await resolvedAlertCard.getByRole("button", { name: "查看结果", exact: true }).click()
  const resolvedReviewable = await page.getByRole("button", { name: "该事件已处置", exact: true }).isDisabled()
    && (await actionResultPanel.innerText()).includes("事件控制：成功")
  const action = after.actions.find((item) => item.eventId === eventBefore.id || item.eventCode === eventBefore.code)
  const replayTargetId = after.availableActions.find((item) => item.code === expectedActionCode)?.eligibleTargetIds.find((item) => item !== action?.targetId)
  if (!replayTargetId) throw new Error("城市表演已解决事件重放验收缺少第二个可执行目标")
  const identicalRetryResponse = await requestOutcome(`/v3/show-projects/${fixture.projectId}/runtime/actions`, {
    method: "POST",
    cookie: studentCookie,
    body: successfulActionBody
  })
  const afterIdenticalRetry = await request(`/v3/show-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
  const identicalRetrySafe = identicalRetryResponse.ok
    && identicalRetryResponse.body.session?.revision === after.session.revision
    && afterIdenticalRetry.session.revision === after.session.revision
    && afterIdenticalRetry.actions.length === after.actions.length
    && afterIdenticalRetry.totals.airborneCount === after.totals.airborneCount
    && JSON.stringify(afterIdenticalRetry.actions.find((item) => item.id === action?.id)?.result) === JSON.stringify(action?.result)
  const mismatchResponse = await requestOutcome(`/v3/show-projects/${fixture.projectId}/runtime/actions`, {
    method: "POST",
    cookie: studentCookie,
    body: { ...successfulActionBody, targetId: replayTargetId }
  })
  const afterMismatch = await request(`/v3/show-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
  const mismatchProtected = mismatchResponse.status === 409
    && JSON.stringify(mismatchResponse.body).includes("同一请求号不能提交不同的城市表演处置命令")
    && afterMismatch.session.revision === after.session.revision
    && afterMismatch.actions.length === after.actions.length
    && afterMismatch.totals.airborneCount === after.totals.airborneCount
    && JSON.stringify(afterMismatch.actions.find((item) => item.id === action?.id)?.result) === JSON.stringify(action?.result)
  const replayResponse = await requestOutcome(`/v3/show-projects/${fixture.projectId}/runtime/actions`, {
    method: "POST",
    cookie: studentCookie,
    body: {
      expectedRevision: after.session.revision,
      actionCode: expectedActionCode,
      eventId: eventBefore.id,
      alertId: activeAlert.id,
      targetType: "AIRCRAFT",
      targetId: replayTargetId,
      requestId: randomUUID(),
      reasoning: {
        observation: "刷新后误将已解决告警再次作为活动事件提交",
        rationale: "验证服务端不能仅依赖前端按钮禁用保护权威状态",
        expectedOutcome: "拒绝重复处置并保持机群状态不变"
      }
    }
  })
  const afterRejectedReplay = await request(`/v3/show-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
  const resolvedReplayProtected = replayResponse.status === 409
    && JSON.stringify(replayResponse.body).includes("当前事件已经处置完成")
    && afterRejectedReplay.session.revision === after.session.revision
    && afterRejectedReplay.actions.length === after.actions.length
    && afterRejectedReplay.totals.airborneCount === after.totals.airborneCount
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const postActionLayout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    activeStage: document.querySelector(".v3-stage-nav button.active")?.textContent?.trim() ?? null
  }))
  const modeRoundTrip = threeD.mode === "3d" && twoD.mode === "2d" && final3D.mode === "3d" && threeD.buildingExtrusions > 0 && threeD.obstacleCylinders > 0 && twoD.buildingExtrusions === 0 && twoD.obstacleCylinders === 0 && final3D.buildingExtrusions > 0 && final3D.obstacleCylinders > 0 && twoD.featureIds.includes(":BUILDINGS:")
  const layout = { ...runtimeLayout, ...postActionLayout, staticFeatureMode: final3D.mode, staticFeatureIds: final3D.featureIds, buildingExtrusions: final3D.buildingExtrusions, obstacleCylinders: final3D.obstacleCylinders, actionCount: after.actions.filter((item) => item.eventId === eventBefore.id || item.eventCode === eventBefore.code).length, modeRoundTrip, actionResultGeometry }
  layout.twoD = twoD
  layout.threeD = threeD
  layout.final3D = final3D
  const report = { format: "wurenji-show-alert-browser-acceptance", formatVersion: 8, generatedAt: new Date().toISOString(), viewport, projectId: fixture.projectId, title: fixture.title, eventCode: eventBefore.code, before: { eventStatus: eventBefore.status, alertCount: before.alerts.length }, after: { eventStatus: "RESOLVED", actionCode: action?.actionCode ?? null, actionResult: action?.result ?? null, groupCount: after.groups.length }, teaching: { npcBriefingComplete, actionResultComplete, resolvedReviewable, resultInViewport }, failurePaths: { studentRecovery: failureRecovery, idempotency: { identicalRetrySafe, identicalRetryStatus: identicalRetryResponse.status, mismatchProtected, mismatchStatus: mismatchResponse.status, mismatchMessage: mismatchResponse.body, requestId: retryBody.requestId, originalTargetId: action?.targetId ?? null, mismatchedTargetId: replayTargetId, revisionUnchanged: afterMismatch.session.revision === after.session.revision, actionCountUnchanged: afterMismatch.actions.length === after.actions.length, airborneCountUnchanged: afterMismatch.totals.airborneCount === after.actions.length, originalResultUnchanged: JSON.stringify(afterMismatch.actions.find((item) => item.id === action?.id)?.result) === JSON.stringify(action?.result) }, resolvedReplay: { protected: resolvedReplayProtected, status: replayResponse.status, message: replayResponse.body, targetId: replayTargetId, revisionUnchanged: afterRejectedReplay.session.revision === after.session.revision, actionCountUnchanged: afterRejectedReplay.actions.length === after.actions.length, airborneCountUnchanged: afterRejectedReplay.totals.airborneCount === after.totals.airborneCount } }, quickNav: quickNavCheck, layout, errors, screenshot: screenshotPath, passed: errors.length === 0 && quickNavCheck.visible && quickNavCheck.targetsPresent && quickNavCheck.clicks === (viewport.width <= 760 ? 3 : 0) && layout.noHorizontalOverflow && layout.cesiumCanvas && layout.staticFeatureMode === "3d" && layout.staticFeatureIds.includes(":BUILDINGS:") && layout.buildingExtrusions > 0 && layout.obstacleCylinders > 0 && layout.modeRoundTrip && layout.actionCount > 0 && layout.alertDeck && action?.actionCode === expectedActionCode && npcBriefingComplete && actionResultComplete && resolvedReviewable && resultInViewport && failureRecovery.retrySucceeded && identicalRetrySafe && mismatchProtected && resolvedReplayProtected }
  report.failurePaths.idempotency.airborneCountUnchanged = afterMismatch.totals.airborneCount === after.totals.airborneCount
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshot: screenshotPath }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}

async function waitForRuntime(predicate, intervalMs = 150) {
  const deadline = Date.now() + 15_000
  let value = await request(`/v3/show-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs))
    value = await request(`/v3/show-projects/${fixture.projectId}/runtime`, { cookie: studentCookie })
  }
  if (!predicate(value)) throw new Error(`等待城市表演告警状态超时：${JSON.stringify(value.events)}`)
  return value
}

function matchesEvent(alert, event) {
  return alert.eventId === event.id || alert.code === event.code || alert.payload?.code === event.code
}

async function readStaticMap(page, selector) {
  return page.locator(selector).evaluate((element) => ({
    mode: element.getAttribute("data-static-feature-mode"),
    featureIds: element.getAttribute("data-static-feature-ids") ?? "",
    buildingExtrusions: Number(element.getAttribute("data-static-3d-building-count") ?? 0),
    obstacleCylinders: Number(element.getAttribute("data-static-3d-obstacle-count") ?? 0)
  }))
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function showActionTitle(code) {
  return ({ SINGLE_LAND: "单架降落", BATCH_LAND: "小批量降落", REMOVE_FROM_MISSION: "移出任务", GROUP_RETURN: "分组返航", GROUP_LAND: "分组降落" })[code] ?? code
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
