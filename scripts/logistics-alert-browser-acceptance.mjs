import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { chromium } from "playwright-core"
import sharp from "sharp"

const baseUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")
const apiBase = (process.env.APP_BASE_URL ?? `${baseUrl}/api`).replace(/\/$/, "")
const fixturePath = resolve(process.env.LOGISTICS_ALERT_FIXTURE_JSON ?? "artifacts/stu013-logistics-alert-browser-fixture-latest.json")
const outputPath = resolve(process.env.LOGISTICS_ALERT_BROWSER_OUTPUT ?? "artifacts/logistics-alert-browser-acceptance-latest.json")
const screenshotPath = resolve(process.env.LOGISTICS_ALERT_BROWSER_SCREENSHOT ?? "artifacts/logistics-alert-browser-student.png")
const viewport = { width: positiveInteger(process.env.RUNTIME_ACCEPTANCE_VIEWPORT_WIDTH, 1440), height: positiveInteger(process.env.RUNTIME_ACCEPTANCE_VIEWPORT_HEIGHT, 900) }
const requireNextTaskDetails = process.env.LOGISTICS_REQUIRE_NEXT_TASK_DETAILS === "true"
const requireMapReverseLink = process.env.LOGISTICS_REQUIRE_MAP_REVERSE_LINK !== "false"
const requireAlertResolution = process.env.LOGISTICS_REQUIRE_ALERT_RESOLUTION !== "false"
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || baseUrl
const fixture = JSON.parse(await readFile(fixturePath, "utf8"))
if (!fixture.projectId || !fixture.title || fixture.stage !== "LOGISTICS_RUNTIME" || typeof fixture.isAcceptanceData !== "boolean") throw new Error("物流告警夹具无效")

const teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const studentCookie = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
const before = await request(`/v3/logistics-projects/${fixture.projectId}/runtime-workspace`, { cookie: studentCookie })
const preferredEventCodes = ["ORDER_PRIORITY_CHANGED", "WEATHER_CHANGE", "ROUTE_SUSPENDED"]
const eventBefore = preferredEventCodes.flatMap((code) => before.events.filter((item) => item.code === code && item.status === "SCHEDULED"))[0]
  ?? before.events.find((item) => item.status === "SCHEDULED")
  ?? preferredEventCodes.flatMap((code) => before.events.filter((item) => item.code === code && item.status === "ACTIVE"))[0]
  ?? before.events.find((item) => item.status === "ACTIVE")
if (!eventBefore) throw new Error(`物流告警夹具缺少待触发或活动事件：${JSON.stringify(before.events)}`)

if (eventBefore.status === "SCHEDULED") {
  await request(`/v3/logistics-projects/${fixture.projectId}/runtime/events/${eventBefore.id}/trigger`, {
    method: "POST",
    cookie: teacherCookie,
    body: { expectedRevision: before.session.revision, requestId: randomUUID() }
  })
}
const activeRuntime = await waitForRuntime((value) => value.alerts.some((item) => matchesEvent(item, eventBefore) && item.status !== "RESOLVED"))
const activeAlert = activeRuntime.alerts.find((item) => matchesEvent(item, eventBefore) && item.status !== "RESOLVED")
if (!activeAlert) throw new Error("物流事件触发后未生成活动告警")

const browser = await chromium.launch({ executablePath: browserExecutable(), headless: process.env.HEADLESS !== "false" })
const errors = []
const context = await browser.newContext({ viewport, deviceScaleFactor: 1 })
const page = await context.newPage()
const actionEndpoint = `${apiBase}/v3/logistics-projects/${fixture.projectId}/runtime/actions`
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
  await page.locator(".home-scene-segment button, .student-scene-card").filter({ hasText: "物流" }).first().click()
  await page.locator(".student-task-search input, .student-scene-search input").first().fill(fixture.title)
  const project = page.getByText(fixture.title, { exact: true }).first()
  await project.waitFor({ timeout: 15_000 })
  await project.click()
  await page.locator(".v3-project-shell").waitFor({ timeout: 15_000 })
  await page.locator(".logistics-runtime-workspace").waitFor({ timeout: 15_000 })
  const missionRowLocator = page.locator(".runtime-mission-body button")
  await missionRowLocator.first().waitFor({ timeout: 15_000 })
  const mobileQuickNavigation = await verifyMobileQuickNavigation(page)
  const expectedMissionOrder = [...activeRuntime.tasks]
    .sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs || left.orderCode.localeCompare(right.orderCode, "zh-CN") || left.scheduleItemId.localeCompare(right.scheduleItemId))
    .map((task) => task.scheduleItemId)
  const missionRows = await missionRowLocator.evaluateAll((rows) => rows.map((row) => ({
    scheduleItemId: row.getAttribute("data-schedule-item-id") ?? "",
    orderId: row.getAttribute("data-order-id") ?? "",
    aircraftId: row.getAttribute("data-aircraft-id") ?? "",
    destinationNodeId: row.getAttribute("data-destination-node-id") ?? "",
    plannedTakeoffTimeMs: Number(row.getAttribute("data-planned-takeoff-ms") ?? Number.NaN),
    orderCode: row.querySelector(".runtime-mission-order")?.textContent?.trim() ?? "",
    destinationLabel: row.querySelector(".runtime-mission-destination")?.textContent?.trim() ?? "",
    aircraftCode: row.querySelector(".runtime-mission-aircraft")?.textContent?.trim() ?? ""
  })))
  const simulationTimeMs = Number(activeRuntime.session.simulationTimeMs)
  const aircraftWithNextTask = activeRuntime.aircraft.find((aircraft) => activeRuntime.tasks.some((task) => task.aircraftId === aircraft.id
    && task.scheduleItemId !== aircraft.currentTaskId
    && task.status === "WAITING_EXECUTION"
    && task.plannedTakeoffTimeMs >= simulationTimeMs))
  const missionTargetIndex = aircraftWithNextTask
    ? missionRows.findIndex((row) => row.aircraftId === aircraftWithNextTask.id)
    : missionRows.length > 1 ? missionRows.length - 1 : 0
  const missionTarget = missionRows[missionTargetIndex]
  if (!missionTarget) throw new Error("物流任务板没有可验证的任务行")
  await missionRowLocator.nth(missionTargetIndex).click()
  try {
    await page.waitForFunction(({ orderId, aircraftId }) => {
      const selectedRow = document.querySelector(`.runtime-mission-body button[data-order-id="${CSS.escape(orderId)}"]`)
      const map = document.querySelector(".logistics-runtime-map-shell")
      return selectedRow?.getAttribute("aria-pressed") === "true" && map?.getAttribute("data-selected-aircraft-id") === aircraftId
    }, { orderId: missionTarget.orderId, aircraftId: missionTarget.aircraftId })
  } catch {
    const selectionDiagnostics = await page.evaluate(({ orderId, aircraftId }) => ({
      expected: { orderId, aircraftId },
      missionRows: [...document.querySelectorAll(".runtime-mission-body button")].slice(0, 3).map((row) => ({
        orderId: row.getAttribute("data-order-id"),
        aircraftId: row.getAttribute("data-aircraft-id"),
        pressed: row.getAttribute("aria-pressed")
      })),
      selectedRows: [...document.querySelectorAll('.runtime-mission-body button[aria-pressed="true"]')].map((row) => ({
        orderId: row.getAttribute("data-order-id"),
        aircraftId: row.getAttribute("data-aircraft-id")
      })),
      mapShells: [...document.querySelectorAll(".logistics-runtime-map-shell")].map((map) => ({
        selectedAircraftId: map.getAttribute("data-selected-aircraft-id"),
        staticFeatureMode: map.getAttribute("data-static-feature-mode")
      })),
      selectedFleet: [...document.querySelectorAll('.runtime-aircraft-list button[aria-pressed="true"]')].map((row) => row.getAttribute("data-aircraft-id"))
    }), { orderId: missionTarget.orderId, aircraftId: missionTarget.aircraftId })
    throw new Error(`物流任务到地图联动超时：${JSON.stringify(selectionDiagnostics)}`)
  }
  const missionSelection = await page.evaluate(() => ({
    selectedOrderId: document.querySelector('.runtime-mission-body button[aria-pressed="true"]')?.getAttribute("data-order-id") ?? "",
    selectedAircraftId: document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-selected-aircraft-id") ?? "",
    selectedAircraftCode: document.querySelector(".runtime-selected-aircraft-code")?.textContent?.trim() ?? ""
  }))
  const expectedNextTask = aircraftWithNextTask
    ? [...activeRuntime.tasks]
        .filter((task) => task.aircraftId === aircraftWithNextTask.id && task.scheduleItemId !== aircraftWithNextTask.currentTaskId && task.status === "WAITING_EXECUTION" && task.plannedTakeoffTimeMs >= simulationTimeMs)
        .sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)[0] ?? null
    : null
  const nextTaskDetails = await page.locator(".next-task-strip").evaluate((element) => ({
    nextTaskId: element.getAttribute("data-next-task-id") ?? "",
    modelCode: element.getAttribute("data-selected-aircraft-model") ?? "",
    visibleModelCode: document.querySelector(".runtime-selected-aircraft-model")?.textContent?.trim() ?? "",
    times: element.querySelector(".next-task-times")?.textContent?.trim() ?? "",
    window: element.querySelector(".next-task-window")?.textContent?.trim() ?? "",
    reason: element.querySelector(".next-task-reason")?.textContent?.trim() ?? ""
  }))
  if (viewport.width <= 860) {
    await page.locator('.runtime-mobile-nav button[data-runtime-jump="map"]').click()
    try {
      await page.waitForFunction(() => {
        const commandbar = document.querySelector(".runtime-commandbar")?.getBoundingClientRect()
        const controls = document.querySelector('.view-segment[aria-label="地图视角"]')?.getBoundingClientRect()
        return Boolean(commandbar && controls
          && (controls.bottom <= commandbar.top || controls.top >= commandbar.bottom + 2)
          && controls.top >= 0
          && controls.bottom <= window.innerHeight)
      }, undefined, { timeout: 5_000 })
    } catch {
      const geometry = await page.evaluate(() => {
        const workspace = document.querySelector(".logistics-runtime-workspace")
        const commandbar = document.querySelector(".runtime-commandbar")?.getBoundingClientRect()
        const map = document.querySelector(".runtime-map-panel")?.getBoundingClientRect()
        const controls = document.querySelector('.view-segment[aria-label="地图视角"]')?.getBoundingClientRect()
        return { scrollTop: workspace?.scrollTop ?? null, commandbar, map, controls, viewportHeight: window.innerHeight }
      })
      throw new Error(`窄屏地图快速入口未避开粘性运行栏：${JSON.stringify(geometry)}`)
    }
  }
  const logistics3dButton = page.getByRole("button", { name: /^(?:3D 俯视|俯视视角)$/ }).first()
  await logistics3dButton.waitFor({ timeout: 10_000 })
  await logistics3dButton.click()
  await page.waitForFunction(() => document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "3d")
  const mapView = page.locator('.view-segment[aria-label="地图视角"]')
  await mapView.getByRole("button", { name: "3D 空间理解视角", exact: true }).click()
  await page.waitForFunction(() => document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "3d")
  const threeD = await readStaticMap(page, ".logistics-runtime-map-shell")
  await mapView.getByRole("button", { name: "2D 精确规划视角", exact: true }).click()
  await page.waitForFunction(() => document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "2d")
  const twoD = await readStaticMap(page, ".logistics-runtime-map-shell")
  await mapView.getByRole("button", { name: "3D 空间理解视角", exact: true }).click()
  await page.waitForFunction(() => document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-static-feature-mode") === "3d")
  await page.waitForFunction(() => {
    const map = document.querySelector(".logistics-runtime-map-shell")
    const longitude = Number(map?.getAttribute("data-camera-longitude"))
    const latitude = Number(map?.getAttribute("data-camera-latitude"))
    const height = Number(map?.getAttribute("data-camera-height-meters"))
    return longitude >= 113 && longitude <= 115 && latitude >= 21.5 && latitude <= 23.5 && height > 0 && height < 50_000
  }, undefined, { timeout: 5_000 }).catch(() => {})
  const final3D = await readStaticMap(page, ".logistics-runtime-map-shell")
  const mapAircraftSelection = requireMapReverseLink
    ? await clickDistinctMapAircraft(page, ".logistics-runtime-map-shell")
    : { verified: false, skipped: true, reason: "响应式布局专项复用 V5.18 地图反向联动证据" }
  const responsive = await page.evaluate(responsiveLayoutSnapshot)
  const runtimeLayout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    cesiumCanvas: Boolean(document.querySelector(".logistics-runtime-workspace canvas")),
    alertCount: document.querySelectorAll(".runtime-alert-list article").length,
    missionTable: Boolean(document.querySelector(".runtime-mission-table")),
    eventStrip: Boolean(document.querySelector(".runtime-event-strip")),
    eventSourceText: document.querySelector(".runtime-event-strip")?.textContent?.trim() ?? ""
  }))
  const alertCard = page.locator(".runtime-alert-list article").filter({ hasText: activeAlert.title }).first()
  await alertCard.waitFor({ timeout: 15_000 })
  await alertCard.click()
  if (viewport.width <= 860) {
    await page.locator('.runtime-mobile-nav button[data-runtime-jump="handling"]').click()
    await page.waitForTimeout(500)
  }
  const teachingBriefing = await page.locator(".runtime-teaching-briefing").evaluate((element) => ({
    text: element.textContent?.trim() ?? "",
    rows: [...element.querySelectorAll(":scope > div")].map((row) => ({
      label: row.querySelector("dt")?.textContent?.trim() ?? "",
      value: row.querySelector("dd")?.textContent?.trim() ?? ""
    }))
  }))

  const reasoning = page.locator(".student-runtime-actions textarea, .action-reasoning-fields textarea")
  if (await reasoning.count() < 3) throw new Error("物流应急处置缺少三项决策输入")
  await reasoning.nth(0).fill("发现配送航线异常，受影响订单需要立即重新评估")
  await reasoning.nth(1).fill("根据告警影响对象和当前订单时限，先保持安全状态并确认后续安排")
  await reasoning.nth(2).fill("避免继续扩大风险，等待系统确认后再恢复配送")
  const actionButton = page.getByRole("button", { name: "执行处置", exact: true })
  await actionButton.waitFor({ timeout: 10_000 })
  if (await actionButton.isDisabled()) throw new Error("填写完整处置依据后执行按钮仍不可用")
  if (viewport.width <= 860) {
    await page.evaluate(() => {
      const workspace = document.querySelector(".logistics-runtime-workspace")
      const commandbar = document.querySelector(".runtime-commandbar")
      const panel = document.querySelector(".runtime-control-panel")
      if (!(workspace instanceof HTMLElement) || !(panel instanceof HTMLElement)) return
      workspace.scrollTo({ top: Math.max(0, panel.offsetTop - (commandbar instanceof HTMLElement ? commandbar.offsetHeight : 0) - 8), behavior: "auto" })
      panel.scrollTo({ top: panel.scrollHeight, behavior: "auto" })
    })
    await page.waitForTimeout(100)
  }
  let studentFailureRecovery = {
    conflictStatus: null,
    failureNoticeVisible: false,
    noticeText: "",
    inputsRetained: false,
    retryVisible: false,
    retrySucceeded: false,
    firstRequestId: null,
    retryRequestId: null
  }
  if (requireAlertResolution) {
    const expectedReasoning = [
      "发现配送航线异常，受影响订单需要立即重新评估",
      "根据告警影响对象和当前订单时限，先保持安全状态并确认后续安排",
      "避免继续扩大风险，等待系统确认后再恢复配送"
    ]
    await page.route(actionEndpoint, async (route) => {
      if (failureInjected) return route.continue()
      failureInjected = true
      const body = route.request().postDataJSON()
      const conflict = await requestOutcome(`/v3/logistics-projects/${fixture.projectId}/runtime/clock`, {
        method: "POST",
        cookie: studentCookie,
        body: { expectedRevision: body.expectedRevision, rate: 5, status: "PAUSED" }
      })
      if (!conflict.ok) throw new Error(`制造物流旧 revision 冲突失败：${conflict.status} ${JSON.stringify(conflict.body)}`)
      await route.continue()
    })
    const failedRequest = page.waitForRequest((request) => request.url() === actionEndpoint && request.method() === "POST")
    const failedResponse = page.waitForResponse((response) => response.url() === actionEndpoint && response.request().method() === "POST" && response.status() === 409)
    await actionButton.click()
    const failedBody = (await failedRequest).postDataJSON()
    await failedResponse
    studentFailureRecovery.firstRequestId = failedBody.requestId ?? null
    studentFailureRecovery.conflictStatus = 409
    const failureNotice = page.locator(".runtime-action-error")
    await failureNotice.waitFor({ timeout: 10_000 })
    if (viewport.width <= 860) {
      await page.evaluate(() => {
        const workspace = document.querySelector(".logistics-runtime-workspace")
        const panel = document.querySelector(".runtime-control-panel")
        if (workspace instanceof HTMLElement && panel instanceof HTMLElement) {
          workspace.scrollTo({ top: Math.max(0, panel.offsetTop - 8), behavior: "auto" })
          panel.scrollTo({ top: panel.scrollHeight, behavior: "auto" })
        }
      })
      await page.waitForTimeout(100)
    }
    const retainedReasoning = await reasoning.evaluateAll((items) => items.map((item) => item.value))
    const retryButton = failureNotice.getByRole("button", { name: "重试处置", exact: true })
    studentFailureRecovery = {
      ...studentFailureRecovery,
      failureNoticeVisible: await failureNotice.isVisible(),
      noticeText: await failureNotice.innerText(),
      inputsRetained: JSON.stringify(retainedReasoning) === JSON.stringify(expectedReasoning),
      retryVisible: await retryButton.isVisible()
    }
    if (!studentFailureRecovery.failureNoticeVisible || !studentFailureRecovery.inputsRetained || !studentFailureRecovery.retryVisible) {
      throw new Error(`物流失败处置恢复体验不完整：${JSON.stringify(studentFailureRecovery)}`)
    }
    const retryRequest = page.waitForRequest((request) => request.url() === actionEndpoint && request.method() === "POST" && request.postDataJSON()?.requestId !== failedBody.requestId)
    void retryRequest.catch(() => undefined)
    const retryResponse = page.waitForResponse((response) => response.url() === actionEndpoint && response.request().method() === "POST" && response.status() >= 200 && response.status() < 300).catch(() => null)
    await retryButton.click()
    let retryBody
    try {
      retryBody = (await retryRequest).postDataJSON()
    } catch (error) {
      const retryDiagnostics = await page.evaluate(() => {
        const button = document.querySelector(".runtime-action-error button")
        const map = document.querySelector(".logistics-runtime-map-shell")
        const element = button instanceof HTMLElement ? button : null
        const rect = element?.getBoundingClientRect()
        const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
        return {
          button: element ? { disabled: element.hasAttribute("disabled"), ariaDisabled: element.getAttribute("aria-disabled"), text: element.textContent?.trim() ?? "", rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null } : null,
          hitElement: hit?.outerHTML?.slice(0, 300) ?? null,
          actionError: document.querySelector(".runtime-action-error")?.textContent?.trim() ?? "",
          selectedAction: document.querySelector('select[aria-label="选择物流应急处置动作"]')?.getAttribute("value") ?? null,
          mapRevision: map?.getAttribute("data-selected-aircraft-id") ?? null
        }
      })
      throw new Error(`物流失败处置重试未发出新请求：${JSON.stringify({ retryDiagnostics, message: error instanceof Error ? error.message : String(error) })}`)
    }
    const retryResponseValue = await retryResponse
    if (!retryResponseValue) throw new Error("物流失败处置重试请求未返回成功响应")
    studentFailureRecovery.retryRequestId = retryBody.requestId ?? null
    studentFailureRecovery.retrySucceeded = Boolean(retryBody.requestId && retryBody.requestId !== failedBody.requestId)
  }

  const after = requireAlertResolution
    ? await waitForRuntime((value) => value.actions.some((item) => item.eventId === eventBefore.id || item.eventCode === eventBefore.code) && value.events.some((item) => item.id === eventBefore.id && item.status === "RESOLVED"))
    : await request(`/v3/logistics-projects/${fixture.projectId}/runtime-workspace`, { cookie: studentCookie })
  const action = after.actions.find((item) => item.eventId === eventBefore.id || item.eventCode === eventBefore.code)
  let resolvedReplay = { protected: false, status: null, message: null, targetId: null, revisionUnchanged: false, actionCountUnchanged: false, aircraftStateUnchanged: false, orderStateUnchanged: false, taskStateUnchanged: false, originalResultUnchanged: false }
  let requestPayloadConflict = { protected: false, status: null, message: null, revisionUnchanged: false, actionCountUnchanged: false, aircraftStateUnchanged: false, originalResultUnchanged: false }
  if (requireAlertResolution && action) {
    const actionDefinition = after.availableActions.find((item) => item.code === action.actionCode)
    const replayTargetId = actionDefinition?.eligibleTargetIds.find((targetId) => targetId !== action.targetId) ?? null
    if (!replayTargetId) throw new Error(`物流已解决事件重放验收缺少第二个合法目标：${JSON.stringify({ action, actionDefinition })}`)
    const beforeReplay = logisticsStateSnapshot(after)
    const { reasoning: _reasoning, rationale: _rationale, _requestId: _requestId, ...actionParameters } = action.payload ?? {}
    const replayResponse = await requestOutcome(`/v3/logistics-projects/${fixture.projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: after.session.revision,
        actionCode: action.actionCode,
        eventId: eventBefore.id,
        alertId: activeAlert.id,
        targetId: replayTargetId,
        requestId: randomUUID(),
        reasoning: {
          observation: "刷新后误将已解决物流告警再次作为活动事件提交",
          rationale: "验证服务端不能仅依赖前端按钮禁用保护订单和航班状态",
          expectedOutcome: "拒绝重复处置并保持物流运行状态不变"
        },
        payload: actionParameters
      }
    })
    const afterReplay = await request(`/v3/logistics-projects/${fixture.projectId}/runtime-workspace`, { cookie: studentCookie })
    const afterReplaySnapshot = logisticsStateSnapshot(afterReplay)
    resolvedReplay = {
      protected: replayResponse.status === 409 && JSON.stringify(replayResponse.body).includes("当前物流事件已经处置完成"),
      status: replayResponse.status,
      message: replayResponse.body,
      targetId: replayTargetId,
      revisionUnchanged: afterReplaySnapshot.revision === beforeReplay.revision,
      actionCountUnchanged: afterReplaySnapshot.actionCount === beforeReplay.actionCount,
      aircraftStateUnchanged: JSON.stringify(afterReplaySnapshot.aircraft) === JSON.stringify(beforeReplay.aircraft),
      orderStateUnchanged: JSON.stringify(afterReplaySnapshot.orders) === JSON.stringify(beforeReplay.orders),
      taskStateUnchanged: JSON.stringify(afterReplaySnapshot.tasks) === JSON.stringify(beforeReplay.tasks),
      originalResultUnchanged: JSON.stringify(afterReplay.actions.find((item) => item.id === action.id)?.result) === JSON.stringify(action.result)
    }
    resolvedReplay.protected = resolvedReplay.protected && resolvedReplay.revisionUnchanged && resolvedReplay.actionCountUnchanged && resolvedReplay.aircraftStateUnchanged && resolvedReplay.orderStateUnchanged && resolvedReplay.taskStateUnchanged && resolvedReplay.originalResultUnchanged
    const beforePayloadConflict = logisticsStateSnapshot(afterReplay)
    const originalRequestId = typeof action.payload?._requestId === "string" ? action.payload._requestId : null
    if (!originalRequestId) throw new Error("物流 requestId 载荷冲突验收缺少原动作请求号")
    const conflictingPayload = { ...actionParameters, __idempotencyProbe: randomUUID() }
    const payloadConflictResponse = await requestOutcome(`/v3/logistics-projects/${fixture.projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: afterReplay.session.revision,
        actionCode: action.actionCode,
        eventId: action.eventId,
        alertId: action.alertId,
        targetId: action.targetId,
        requestId: originalRequestId,
        reasoning: action.payload?.reasoning,
        payload: conflictingPayload
      }
    })
    const afterPayloadConflict = await request(`/v3/logistics-projects/${fixture.projectId}/runtime-workspace`, { cookie: studentCookie })
    const afterPayloadConflictSnapshot = logisticsStateSnapshot(afterPayloadConflict)
    requestPayloadConflict = {
      protected: payloadConflictResponse.status === 409 && JSON.stringify(payloadConflictResponse.body).includes("同一请求号不能提交不同的物流处置命令"),
      status: payloadConflictResponse.status,
      message: payloadConflictResponse.body,
      revisionUnchanged: afterPayloadConflictSnapshot.revision === beforePayloadConflict.revision,
      actionCountUnchanged: afterPayloadConflictSnapshot.actionCount === beforePayloadConflict.actionCount,
      aircraftStateUnchanged: JSON.stringify(afterPayloadConflictSnapshot.aircraft) === JSON.stringify(beforePayloadConflict.aircraft),
      originalResultUnchanged: JSON.stringify(afterPayloadConflict.actions.find((item) => item.id === action.id)?.result) === JSON.stringify(action.result)
    }
    requestPayloadConflict.protected = requestPayloadConflict.protected && requestPayloadConflict.revisionUnchanged && requestPayloadConflict.actionCountUnchanged && requestPayloadConflict.aircraftStateUnchanged && requestPayloadConflict.originalResultUnchanged
  }
  let postActionTeaching = { retained: false, visible: false, consequences: [], evidence: "", actionButtonLabel: "" }
  let resultScreenshotPath = ""
  if (requireAlertResolution) {
    if (viewport.width <= 860) {
      await page.locator('.runtime-mobile-nav button[data-runtime-jump="alerts"]').click()
      await page.waitForTimeout(500)
    }
    const resolvedCard = page.locator(".runtime-alert-list article.resolved").filter({ hasText: activeAlert.title }).first()
    await resolvedCard.waitFor({ timeout: 15_000 })
    if (await resolvedCard.getAttribute("aria-pressed") !== "true") {
      if (viewport.width <= 860) {
        await resolvedCard.evaluate((card) => {
          const workspace = document.querySelector(".logistics-runtime-workspace")
          const commandbar = document.querySelector(".runtime-commandbar")
          if (!(workspace instanceof HTMLElement) || !(card instanceof HTMLElement)) return
          workspace.scrollTo({
            top: Math.max(0, card.offsetTop - (commandbar instanceof HTMLElement ? commandbar.offsetHeight : 0) - 8),
            behavior: "auto"
          })
        })
        await page.waitForTimeout(100)
      }
      await resolvedCard.click()
    }
    const businessResult = page.locator(".runtime-business-result")
    await businessResult.waitFor({ timeout: 10_000 })
    if (viewport.width <= 860) {
      await page.locator('.runtime-mobile-nav button[data-runtime-jump="handling"]').click()
      await page.waitForTimeout(500)
    }
    postActionTeaching = await page.evaluate(() => ({
      retained: Boolean(document.querySelector(".runtime-alert-list article.resolved") && document.querySelector(".runtime-business-result")),
      visible: (() => {
        const workspace = document.querySelector(".logistics-runtime-workspace")?.getBoundingClientRect()
        const commandbar = document.querySelector(".runtime-commandbar")?.getBoundingClientRect()
        const panel = document.querySelector(".runtime-control-panel")?.getBoundingClientRect()
        const result = document.querySelector(".runtime-business-result")?.getBoundingClientRect()
        if (!workspace || !commandbar || !panel || !result) return false
        const visibleTop = Math.max(workspace.top, commandbar.bottom, panel.top)
        const visibleBottom = Math.min(workspace.bottom, panel.bottom)
        return result.height > 0 && result.top >= visibleTop - 1 && result.bottom <= visibleBottom + 1
      })(),
      geometry: (() => {
        const workspace = document.querySelector(".logistics-runtime-workspace")?.getBoundingClientRect()
        const commandbar = document.querySelector(".runtime-commandbar")?.getBoundingClientRect()
        const panelElement = document.querySelector(".runtime-control-panel")
        const panel = panelElement?.getBoundingClientRect()
        const result = document.querySelector(".runtime-business-result")?.getBoundingClientRect()
        return {
          workspace: workspace ? { top: Math.round(workspace.top), bottom: Math.round(workspace.bottom) } : null,
          commandbar: commandbar ? { top: Math.round(commandbar.top), bottom: Math.round(commandbar.bottom) } : null,
          panel: panel ? { top: Math.round(panel.top), bottom: Math.round(panel.bottom), scrollTop: Math.round(panelElement?.scrollTop ?? 0) } : null,
          result: result ? { top: Math.round(result.top), bottom: Math.round(result.bottom), height: Math.round(result.height) } : null
        }
      })(),
      consequences: [...document.querySelectorAll(".runtime-business-result li")].map((item) => item.textContent?.trim() ?? "").filter(Boolean),
      evidence: document.querySelector(".runtime-business-result small")?.textContent?.trim() ?? "",
      actionButtonLabel: [...document.querySelectorAll(".student-runtime-actions button")].map((item) => item.textContent?.trim() ?? "").find((text) => text.includes("该告警已处置")) ?? ""
    }))
    resultScreenshotPath = screenshotPath.replace(/(\.[^.]+)$/, "-result$1")
    await page.screenshot({ path: resultScreenshotPath })
  }
  const mapScreenshotPath = screenshotPath.replace(/(\.[^.]+)$/, "-map$1")
  await page.locator(".logistics-runtime-map-shell").screenshot({ path: mapScreenshotPath })
  await page.screenshot({ path: screenshotPath, fullPage: true })
  const mapPixels = await analyzeMapPixels(mapScreenshotPath)
  const postActionLayout = await page.evaluate(() => ({
    noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
    activeStage: document.querySelector(".v3-stage-nav button.active")?.textContent?.trim() ?? null
  }))
  const modeRoundTrip = threeD.mode === "3d" && twoD.mode === "2d" && final3D.mode === "3d" && threeD.buildingExtrusions > 0 && threeD.obstacleCylinders > 0 && twoD.buildingExtrusions === 0 && twoD.obstacleCylinders === 0 && final3D.buildingExtrusions > 0 && final3D.obstacleCylinders > 0 && twoD.featureIds.includes(":BUILDINGS:")
  const missionBoard = {
    expectedOrder: expectedMissionOrder,
    actualOrder: missionRows.map((row) => row.scheduleItemId),
    orderedByPlannedTakeoff: missionRows.every((row, index) => index === 0 || missionRows[index - 1].plannedTakeoffTimeMs <= row.plannedTakeoffTimeMs),
    exactStableOrder: JSON.stringify(expectedMissionOrder) === JSON.stringify(missionRows.map((row) => row.scheduleItemId)),
    businessDestinationLabels: missionRows.every((row) => Boolean(row.destinationLabel) && row.destinationLabel !== row.destinationNodeId),
    selectedOrderLinked: missionSelection.selectedOrderId === missionTarget.orderId,
    selectedAircraftLinked: missionSelection.selectedAircraftId === missionTarget.aircraftId && missionSelection.selectedAircraftCode === missionTarget.aircraftCode,
    nextTaskDetailsRequired: requireNextTaskDetails,
    nextTaskDetails: {
      ...nextTaskDetails,
      expectedTaskId: expectedNextTask?.scheduleItemId ?? "",
      expectedModelCode: aircraftWithNextTask?.modelCode ?? "",
      verified: Boolean(expectedNextTask)
        && nextTaskDetails.nextTaskId === expectedNextTask.scheduleItemId
        && Boolean(nextTaskDetails.modelCode)
        && nextTaskDetails.modelCode === aircraftWithNextTask?.modelCode
        && nextTaskDetails.visibleModelCode === aircraftWithNextTask?.modelCode
        && nextTaskDetails.times.includes("计划起飞 T+")
        && nextTaskDetails.times.includes("预计到达 T+")
        && nextTaskDetails.window.includes("配送窗口 T+")
        && Boolean(nextTaskDetails.reason)
    },
    selectedTarget: missionTarget,
    rows: missionRows
  }
  const cameraWithinTeachingView = Number.isFinite(final3D.camera.longitude)
    && Number.isFinite(final3D.camera.latitude)
    && Number.isFinite(final3D.camera.heightMeters)
    && final3D.camera.longitude >= 113 && final3D.camera.longitude <= 115
    && final3D.camera.latitude >= 21.5 && final3D.camera.latitude <= 23.5
    && final3D.camera.heightMeters > 0 && final3D.camera.heightMeters < 50_000
    && (final3D.camera.groundRangeMeters === null || final3D.camera.groundRangeMeters < 50_000)
  const mapVisualHealthy = mapPixels.nearBlackRatio < 0.08 && mapPixels.quantizedColorCount >= 8
  const briefingLabels = new Set(teachingBriefing.rows.map((item) => item.label))
  const teachingClosedLoop = teachingBriefing.text.length > 0
    && ["业务角色", "业务请求", "影响对象", "处置目标", "成功判据", "处置时限", "评分关注"].every((label) => briefingLabels.has(label))
    && (!requireAlertResolution || (postActionTeaching.retained && postActionTeaching.visible && postActionTeaching.consequences.length > 0 && postActionTeaching.evidence.includes("评分证据") && postActionTeaching.actionButtonLabel === "该告警已处置"))
  const layout = { ...runtimeLayout, ...postActionLayout, responsive, mobileQuickNavigation, staticFeatureMode: final3D.mode, staticFeatureIds: final3D.featureIds, buildingExtrusions: final3D.buildingExtrusions, obstacleCylinders: final3D.obstacleCylinders, actionCount: after.actions.filter((item) => item.eventId === eventBefore.id || item.eventCode === eventBefore.code).length, modeRoundTrip, cameraWithinTeachingView, mapVisualHealthy, mapPixels, mapAircraftSelection, missionBoard, teachingBriefing, postActionTeaching, teachingClosedLoop }
  layout.twoD = twoD
  layout.threeD = threeD
  layout.final3D = final3D
  const report = {
    format: "wurenji-logistics-alert-browser-acceptance",
    formatVersion: 5,
    viewport,
    generatedAt: new Date().toISOString(),
    projectId: fixture.projectId,
    title: fixture.title,
    eventCode: eventBefore.code,
    before: { eventStatus: eventBefore.status, alertCount: before.alerts.length },
    after: { eventStatus: "RESOLVED", actionCode: action?.actionCode ?? null, actionResult: action?.result ?? null, orderCount: after.orders.length, aircraftCount: after.aircraft.length },
    layout,
    errors,
    screenshot: screenshotPath,
    resultScreenshot: resultScreenshotPath || null,
    failurePaths: { studentRecovery: studentFailureRecovery, resolvedReplay, requestPayloadConflict },
    passed: errors.length === 0 && layout.noHorizontalOverflow && layout.cesiumCanvas && layout.staticFeatureMode === "3d" && layout.staticFeatureIds.includes(":BUILDINGS:") && layout.buildingExtrusions > 0 && layout.obstacleCylinders > 0 && layout.modeRoundTrip && layout.cameraWithinTeachingView && layout.mapVisualHealthy && (!requireMapReverseLink || layout.mapAircraftSelection.verified) && layout.responsive.complete && layout.mobileQuickNavigation.complete && (!requireAlertResolution || (layout.actionCount > 0 && action?.actionCode !== undefined && studentFailureRecovery.retrySucceeded && resolvedReplay.protected && requestPayloadConflict.protected)) && layout.missionTable && layout.eventStrip && layout.eventSourceText.length > 0 && layout.teachingClosedLoop && missionBoard.exactStableOrder && missionBoard.businessDestinationLabels && missionBoard.selectedOrderLinked && missionBoard.selectedAircraftLinked && (!requireNextTaskDetails || missionBoard.nextTaskDetails.verified)
  }
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  process.stdout.write(`${JSON.stringify({ passed: report.passed, outputPath, screenshot: screenshotPath }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}

function responsiveLayoutSnapshot() {
  const workspace = document.querySelector(".logistics-runtime-workspace")
  if (!workspace) return { complete: false, narrow: window.innerWidth <= 860, workspace: null, panels: [] }
  const workspaceRect = workspace.getBoundingClientRect()
  const panelSelectors = [".runtime-map-panel", ".runtime-fleet-panel", ".runtime-control-panel", ".runtime-mission-table", ".runtime-alert-deck"]
  const panels = panelSelectors.map((selector) => {
    const element = document.querySelector(selector)
    if (!element) return { selector, present: false, widthContained: false, nonZero: false }
    const rect = element.getBoundingClientRect()
    return {
      selector,
      present: true,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      widthContained: rect.left >= workspaceRect.left - 1 && rect.right <= workspaceRect.right + 1,
      nonZero: rect.width >= 120 && rect.height >= 80
    }
  })
  const narrow = window.innerWidth <= 860
  const overflowY = getComputedStyle(workspace).overflowY
  const narrowScrollable = !narrow || (["auto", "scroll"].includes(overflowY) && workspace.scrollHeight > workspace.clientHeight)
  return {
    complete: panels.every((panel) => panel.present && panel.widthContained && panel.nonZero) && narrowScrollable,
    narrow,
    narrowScrollable,
    workspace: {
      width: Math.round(workspaceRect.width),
      height: Math.round(workspaceRect.height),
      clientHeight: workspace.clientHeight,
      scrollHeight: workspace.scrollHeight,
      overflowY
    },
    panels
  }
}

async function verifyMobileQuickNavigation(page) {
  if (viewport.width > 860) return { required: false, complete: true, reason: "桌面布局不显示窄屏快速入口", targets: [] }
  const navigation = page.locator(".runtime-mobile-nav")
  await navigation.waitFor({ state: "visible", timeout: 10_000 })
  const summary = await page.locator(".runtime-mobile-summary").evaluate((element) => ({
    visible: element.getBoundingClientRect().height > 0,
    text: element.textContent?.replace(/\s+/g, " ").trim() ?? ""
  }))
  const definitions = [
    ["map", ".runtime-map-panel"],
    ["fleet", ".runtime-fleet-panel"],
    ["missions", ".runtime-mission-table"],
    ["alerts", ".runtime-alert-deck"],
    ["handling", ".runtime-control-panel"]
  ]
  const targets = []
  for (const [name, selector] of definitions) {
    await navigation.locator(`button[data-runtime-jump="${name}"]`).click()
    await page.waitForTimeout(450)
    targets.push(await page.evaluate(({ selector, name }) => {
      const workspace = document.querySelector(".logistics-runtime-workspace")
      const commandbar = document.querySelector(".runtime-commandbar")
      const navigation = document.querySelector(".runtime-mobile-nav")
      const target = document.querySelector(selector)
      if (!(workspace instanceof HTMLElement) || !(commandbar instanceof HTMLElement) || !(navigation instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        return { name, present: false, visible: false, focused: false, navigationVisible: false }
      }
      const workspaceRect = workspace.getBoundingClientRect()
      const commandbarRect = commandbar.getBoundingClientRect()
      const navigationRect = navigation.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const activeElement = document.activeElement
      return {
        name,
        present: true,
        visible: targetRect.bottom > commandbarRect.bottom + 4 && targetRect.top < workspaceRect.bottom - 4,
        focused: activeElement === target || target.contains(activeElement),
        navigationVisible: navigationRect.top >= workspaceRect.top - 1 && navigationRect.bottom <= workspaceRect.bottom + 1,
        targetTop: Math.round(targetRect.top),
        commandbarBottom: Math.round(commandbarRect.bottom),
        workspaceBottom: Math.round(workspaceRect.bottom)
      }
    }, { selector, name }))
  }
  await navigation.locator('button[data-runtime-jump="map"]').click()
  await page.waitForTimeout(450)
  return {
    required: true,
    summary,
    navigationButtonCount: await navigation.locator("button[data-runtime-jump]").count(),
    targets,
    complete: summary.visible
      && summary.text.includes("当前航空器")
      && summary.text.includes("下一任务")
      && summary.text.includes("待处理告警")
      && targets.length === definitions.length
      && targets.every((target) => target.present && target.visible && target.focused && target.navigationVisible)
  }
}

async function waitForRuntime(predicate) {
  const deadline = Date.now() + 15_000
  let value = await request(`/v3/logistics-projects/${fixture.projectId}/runtime-workspace`, { cookie: studentCookie })
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
    value = await request(`/v3/logistics-projects/${fixture.projectId}/runtime-workspace`, { cookie: studentCookie })
  }
  if (!predicate(value)) throw new Error(`等待物流告警状态超时：${JSON.stringify(value.events)}`)
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
    obstacleCylinders: Number(element.getAttribute("data-static-3d-obstacle-count") ?? 0),
    camera: {
      longitude: Number(element.getAttribute("data-camera-longitude")),
      latitude: Number(element.getAttribute("data-camera-latitude")),
      heightMeters: Number(element.getAttribute("data-camera-height-meters")),
      headingRadians: Number(element.getAttribute("data-camera-heading-radians")),
      pitchRadians: Number(element.getAttribute("data-camera-pitch-radians")),
      groundRangeMeters: element.getAttribute("data-camera-ground-range-meters") === null ? null : Number(element.getAttribute("data-camera-ground-range-meters"))
    }
  }))
}

async function analyzeMapPixels(path) {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  let nearBlackPixels = 0
  const colors = new Set()
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset] ?? 0
    const green = data[offset + 1] ?? 0
    const blue = data[offset + 2] ?? 0
    if (red < 24 && green < 24 && blue < 24) nearBlackPixels += 1
    colors.add(`${red >> 5}:${green >> 5}:${blue >> 5}`)
  }
  const totalPixels = info.width * info.height
  return {
    width: info.width,
    height: info.height,
    nearBlackRatio: totalPixels > 0 ? nearBlackPixels / totalPixels : 1,
    quantizedColorCount: colors.size
  }
}

async function clickDistinctMapAircraft(page, selector) {
  const map = page.locator(selector)
  const airborneRow = page.locator('.runtime-aircraft-list button[data-aircraft-status="TAKING_OFF"], .runtime-aircraft-list button[data-aircraft-status="OUTBOUND"], .runtime-aircraft-list button[data-aircraft-status="ARRIVED"], .runtime-aircraft-list button[data-aircraft-status="RETURNING"], .runtime-aircraft-list button[data-aircraft-status="LANDING"], .runtime-aircraft-list button[data-aircraft-status="HOLDING"], .runtime-aircraft-list button[data-aircraft-status="DIVERTING"], .runtime-aircraft-list button[data-aircraft-status="EMERGENCY_LANDING"]').first()
  if (await airborneRow.count() && await airborneRow.isVisible()) {
    const airborneAircraftId = await airborneRow.getAttribute("data-aircraft-id")
    await airborneRow.click()
    if (airborneAircraftId) await page.waitForFunction(({ selector, aircraftId }) => document.querySelector(selector)?.getAttribute("data-selected-aircraft-id") === aircraftId, { selector, aircraftId: airborneAircraftId })
  }
  await page.locator('.v3-map-view-controls button[aria-label="回到教学区域"]').click()
  await page.waitForTimeout(500)
  await page.locator(`${selector} canvas`).evaluate((canvas) => {
    const map = canvas.closest(".logistics-runtime-map-shell")
    const setup = map?.__vueParentComponent?.setupState
    const exposed = map?.__vueParentComponent?.exposed
    const viewerValue = exposed?.scaleViewer ?? setup?.scaleViewer
    const viewer = viewerValue?.value ?? viewerValue
    viewer?.camera.zoomOut(1_000)
    viewer?.scene.requestRender()
  })
  await page.locator(`${selector} canvas`).waitFor({ timeout: 15_000 })
  await page.waitForFunction((mapSelector) => {
    const map = document.querySelector(mapSelector)
    if (!map) return false
    try {
      const points = JSON.parse(map.getAttribute("data-aircraft-pick-points") ?? "[]")
      return Array.isArray(points) && points.length > 0
    } catch {
      return false
    }
  }, selector, { timeout: 15_000 })
  await page.waitForTimeout(1_000)
  try {
    await page.waitForFunction((mapSelector) => {
      const map = document.querySelector(mapSelector)
      if (!map) return false
      try {
        const points = JSON.parse(map.getAttribute("data-aircraft-pick-points") ?? "[]")
        return Array.isArray(points) && points.length > 0
      } catch {
        return false
      }
    }, selector, { timeout: 5_000 })
  } catch {
    const diagnostics = await page.locator(selector).evaluate((element) => ({
      pickPoints: element.getAttribute("data-aircraft-pick-points") ?? "[]",
      mode: element.getAttribute("data-static-feature-mode") ?? "",
      width: element.clientWidth,
      height: element.clientHeight,
      canvas: { width: element.querySelector("canvas")?.clientWidth ?? 0, height: element.querySelector("canvas")?.clientHeight ?? 0 },
      camera: {
        longitude: element.getAttribute("data-camera-longitude") ?? "",
        latitude: element.getAttribute("data-camera-latitude") ?? "",
        height: element.getAttribute("data-camera-height-meters") ?? "",
        range: element.getAttribute("data-camera-ground-range-meters") ?? ""
      }
    }))
    throw new Error(`地图航空器点位未稳定：${JSON.stringify(diagnostics)}`)
  }
  const targetResult = await map.evaluate((element) => {
    const setup = element.__vueParentComponent?.setupState
    const exposed = element.__vueParentComponent?.exposed
    const viewerValue = exposed?.scaleViewer ?? setup?.scaleViewer
    const sourceValue = exposed?.aircraftSource ?? setup?.aircraftSource
    const viewer = viewerValue?.value ?? viewerValue
    const source = sourceValue?.value ?? sourceValue
    const selectedAircraftId = element.getAttribute("data-selected-aircraft-id") ?? ""
    const pickPoints = (() => {
      try { return JSON.parse(element.getAttribute("data-aircraft-pick-points") ?? "[]") } catch { return [] }
    })()
    if (!viewer || !source) {
      const target = pickPoints
        .filter((point) => typeof point?.id === "string" && point.id.startsWith("runtime-aircraft:") && point.id.slice("runtime-aircraft:".length) !== selectedAircraftId)
        .sort((left, right) => right.y - left.y)[0]
      return {
        target: target ? { aircraftId: target.id.slice("runtime-aircraft:".length), aircraftCode: target.code, x: target.x, y: target.y } : null,
        diagnostics: { hasViewer: Boolean(viewer), hasSource: Boolean(source), selectedAircraftId, entityCount: pickPoints.length, projectedCount: pickPoints.length, pickedAircraftCount: target ? 1 : 0, pickPoints }
      }
    }
    if (!viewer || !source) return {
      target: null,
      diagnostics: {
        hasViewer: Boolean(viewer),
        hasSource: Boolean(source),
        selectedAircraftId,
        entityCount: 0,
        projectedCount: 0,
        pickedAircraftCount: 0,
        setupKeys: setup ? Object.keys(setup).filter((key) => ["scaleViewer", "aircraftSource"].includes(key)) : [],
        exposedKeys: exposed ? Object.keys(exposed) : [],
        componentKeys: element.__vueParentComponent ? Object.keys(element.__vueParentComponent).filter((key) => ["setupState", "exposed", "ctx"].includes(key)) : []
      }
    }
    const candidates = []
    let projectedCount = 0
    let pickedAircraftCount = 0
    let unobscuredAircraftCount = 0
    const elementRect = element.getBoundingClientRect()
    for (const entity of source.entities.values) {
      const position = entity.position?.getValue(viewer.clock.currentTime)
      const canvasPosition = position ? viewer.scene.cartesianToCanvasCoordinates(position) : undefined
      if (!canvasPosition
        || canvasPosition.x < 0
        || canvasPosition.y < 0
        || canvasPosition.x > element.clientWidth
        || canvasPosition.y > element.clientHeight) continue
      projectedCount += 1
      const pickedId = viewer.scene
        .drillPick({ x: canvasPosition.x, y: canvasPosition.y }, 12)
        .map((picked) => picked?.id?.id)
        .find((id) => typeof id === "string" && id.startsWith("runtime-aircraft:"))
      if (typeof pickedId !== "string" || !pickedId.startsWith("runtime-aircraft:")) continue
      pickedAircraftCount += 1
      const browserHit = document.elementFromPoint(elementRect.left + canvasPosition.x, elementRect.top + canvasPosition.y)
      if (!(browserHit instanceof HTMLCanvasElement) || !element.contains(browserHit)) continue
      unobscuredAircraftCount += 1
      const aircraftId = pickedId.slice("runtime-aircraft:".length)
      if (aircraftId === selectedAircraftId) continue
      const pickedEntity = source.entities.getById(pickedId)
      candidates.push({ aircraftId, aircraftCode: pickedEntity?.name ?? "", x: canvasPosition.x, y: canvasPosition.y })
    }
    return {
      target: candidates.sort((left, right) => right.y - left.y)[0] ?? null,
      diagnostics: { hasViewer: true, hasSource: true, selectedAircraftId, entityCount: source.entities.values.length, projectedCount, pickedAircraftCount, unobscuredAircraftCount }
    }
  })
  const target = targetResult.target
  if (!target) throw new Error(`地图中没有找到与当前选择不同且可见的航空器点位：${JSON.stringify(targetResult.diagnostics)}`)
  const box = await map.locator(".logistics-runtime-map").boundingBox()
  if (!box) throw new Error("无法读取物流运行地图边界")
  let targetSelected = false
  const maxCycles = Math.max(2, Math.min(32, Number(targetResult.diagnostics?.entityCount ?? 16)))
  for (let attempt = 0; attempt < maxCycles; attempt += 1) {
    await page.mouse.click(box.x + target.x, box.y + target.y)
    try {
      await page.waitForFunction(({ selector, aircraftId }) => document.querySelector(selector)?.getAttribute("data-selected-aircraft-id") === aircraftId, { selector, aircraftId: target.aircraftId }, { timeout: 800 })
      targetSelected = true
      break
    } catch {
      await page.waitForTimeout(80)
    }
  }
  if (!targetSelected) {
    const clickDiagnostics = await page.evaluate(({ selector, aircraftId, x, y }) => {
        const mapElement = document.querySelector(selector)
        const canvas = mapElement?.querySelector("canvas")
        const shell = mapElement?.querySelector(".logistics-runtime-map")?.parentElement
        const mapRect = mapElement?.querySelector(".logistics-runtime-map")?.getBoundingClientRect()
        const canvasRect = canvas?.getBoundingClientRect()
      let pickPoints = []
      try { pickPoints = JSON.parse(mapElement?.getAttribute("data-aircraft-pick-points") ?? "[]") } catch {}
      return {
        expectedAircraftId: aircraftId,
        selectedAircraftId: mapElement?.getAttribute("data-selected-aircraft-id") ?? "",
        mapRect: mapRect ? { left: mapRect.left, top: mapRect.top, width: mapRect.width, height: mapRect.height } : null,
        canvasRect: canvasRect ? { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height } : null,
        target: { x, y },
        devicePixelRatio: window.devicePixelRatio,
        canvasPixels: canvas ? { width: canvas.width, height: canvas.height } : null,
        pickPoints,
        hitElement: document.elementFromPoint((mapRect?.left ?? 0) + x, (mapRect?.top ?? 0) + y)?.outerHTML?.slice(0, 240) ?? null,
        hitPointerEvents: document.elementFromPoint((mapRect?.left ?? 0) + x, (mapRect?.top ?? 0) + y) instanceof Element
          ? getComputedStyle(document.elementFromPoint((mapRect?.left ?? 0) + x, (mapRect?.top ?? 0) + y)).pointerEvents
          : null,
        canvasStyle: canvas ? { display: getComputedStyle(canvas).display, visibility: getComputedStyle(canvas).visibility, pointerEvents: getComputedStyle(canvas).pointerEvents, zIndex: getComputedStyle(canvas).zIndex } : null,
        mapStyle: mapElement?.querySelector(".logistics-runtime-map") instanceof Element ? { display: getComputedStyle(mapElement.querySelector(".logistics-runtime-map")).display, pointerEvents: getComputedStyle(mapElement.querySelector(".logistics-runtime-map")).pointerEvents, zIndex: getComputedStyle(mapElement.querySelector(".logistics-runtime-map")).zIndex } : null,
        shellRect: shell instanceof Element ? (() => { const rect = shell.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height } })() : null,
        hitStack: document.elementsFromPoint((mapRect?.left ?? 0) + x, (mapRect?.top ?? 0) + y).slice(0, 6).map((item) => `${item.tagName}.${item.className ?? ""}`)
      }
    }, { selector, aircraftId: target.aircraftId, x: target.x, y: target.y })
    throw new Error(`地图点选后未同步航空器：${JSON.stringify(clickDiagnostics)}`)
  }
  const selected = await page.evaluate(() => ({
    mapAircraftId: document.querySelector(".logistics-runtime-map-shell")?.getAttribute("data-selected-aircraft-id") ?? "",
    fleetLabel: document.querySelector('.runtime-aircraft-list button[aria-pressed="true"]')?.getAttribute("aria-label") ?? "",
    monitorCode: document.querySelector(".runtime-selected-aircraft-code")?.textContent?.trim() ?? ""
  }))
  return {
    ...target,
    ...selected,
    verified: selected.mapAircraftId === target.aircraftId
      && selected.monitorCode === target.aircraftCode
      && selected.fleetLabel.startsWith(target.aircraftCode)
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
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

function logisticsStateSnapshot(runtime) {
  return {
    revision: runtime.session.revision,
    actionCount: runtime.actions.filter((item) => item.status === "APPLIED").length,
    aircraft: runtime.aircraft.map((item) => ({ id: item.id, status: item.status, currentTaskId: item.currentTaskId, position: item.position })).sort((left, right) => left.id.localeCompare(right.id)),
    orders: runtime.orders.map((item) => ({ id: item.id, status: item.status, priority: item.priority })).sort((left, right) => left.id.localeCompare(right.id)),
    tasks: runtime.tasks.map((item) => ({ id: item.scheduleItemId, status: item.status, aircraftId: item.aircraftId, activeRouteId: item.activeRouteId })).sort((left, right) => left.id.localeCompare(right.id))
  }
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
