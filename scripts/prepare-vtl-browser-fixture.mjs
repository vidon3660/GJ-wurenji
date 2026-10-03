import { randomUUID } from "node:crypto"

const apiBase = (process.env.APP_BASE_URL ?? "http://localhost:3000/api").replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || apiBase.replace(/\/api$/, "")
const scaleCode = process.env.VTL_FIXTURE_SCALE ?? "VTL_5"
const stopAt = (process.env.VTL_FIXTURE_STOP_AT ?? "RUNTIME_READY").toUpperCase()
const fixtureMode = (process.env.VTL_FIXTURE_MODE ?? "TRAINING").toUpperCase()
const assessmentDurationMinutes = Number(process.env.VTL_FIXTURE_ASSESSMENT_DURATION_MINUTES ?? 120)
const title = process.env.VTL_FIXTURE_TITLE ?? `VTL 浏览器验收 ${scaleCode} ${timestamp()}`
const outputPath = process.env.VTL_FIXTURE_OUTPUT?.trim() || "artifacts/vtl-alert-browser-fixture-latest.json"
const publishReview = ["1", "TRUE", "YES"].includes((process.env.VTL_FIXTURE_PUBLISH_REVIEW ?? "").trim().toUpperCase())
const eventTriggerOffsetSeconds = Number(process.env.VTL_FIXTURE_EVENT_TRIGGER_OFFSET_SECONDS ?? 0)
const routeSpeedMps = Number(process.env.VTL_FIXTURE_ROUTE_SPEED_MPS ?? 20)
const requestedRegionCode = process.env.VTL_FIXTURE_REGION_CODE?.trim() || ""
const isAcceptanceData = process.env.VTL_FIXTURE_IS_ACCEPTANCE_DATA !== "false"
const publishOnly = process.env.VTL_FIXTURE_PUBLISH_ONLY === "true"

const configuredEventConfigs = [
  { code: "VTL_DEVICE", triggerTimeSeconds: 65, targetIds: [aircraftId(19)], detectionDelaySeconds: 1, escalationDelaySeconds: 20 },
  { code: "VTL_TASK_CONDITION", triggerTimeSeconds: 70, targetIds: [aircraftId(20)], detectionDelaySeconds: 0, escalationDelaySeconds: 20 },
  { code: "VTL_POSITIONING", triggerTimeSeconds: 75, targetIds: [aircraftId(18)], detectionDelaySeconds: 1, escalationDelaySeconds: 20 },
  { code: "VTL_COMMUNICATION", triggerTimeSeconds: 80, targetIds: [aircraftId(17)], detectionDelaySeconds: 1, escalationDelaySeconds: 20 }
]
const supplementalEventCodes = ["VTL_WEATHER", "VTL_TRANSITION", "VTL_ROUTE_AREA", "VTL_ENERGY_POWER"]
const eventActionByCode = {
  VTL_TASK_CONDITION: "CANCEL_NOT_STARTED",
  VTL_DEVICE: "TRANSFER_TASK",
  VTL_COMMUNICATION: "ADJUST_GROUP",
  VTL_ROUTE_AREA: "ADJUST_GROUP",
  VTL_WEATHER: "HOLD",
  VTL_POSITIONING: "RETURN_AIRCRAFT",
  VTL_ENERGY_POWER: "DIVERT_AIRCRAFT",
  VTL_TRANSITION: "HOLD"
}
const scaleCases = {
  VTL_1: { aircraftCount: 1, taskObjectCount: 3, groupSizes: [1], groupOffsets: [0], eventCodes: [] },
  VTL_5: { aircraftCount: 5, taskObjectCount: 5, groupSizes: [5], groupOffsets: [0], eventCodes: ["VTL_WEATHER"] },
  VTL_20: { aircraftCount: 20, taskObjectCount: 20, groupSizes: [5, 5, 5, 5], groupOffsets: [0, 5, 10, 15], eventCodes: configuredEventConfigs, runtimeClockRate: 60 }
}
const scale = scaleCases[scaleCode]
if (!scale) throw new Error(`不支持的 VTL_FIXTURE_SCALE：${scaleCode}`)
const runtimeClockRate = Number(process.env.VTL_FIXTURE_RUNTIME_CLOCK_RATE ?? scale.runtimeClockRate ?? 3_600)

const allowedStops = new Set(["AREA", "ALLOCATION", "ROUTE", "VALIDATION_FAILED", "RUNTIME_READY", "RUNTIME_ACTIVE", "REVIEW_READY"])
if (!["TRAINING", "ASSESSMENT"].includes(fixtureMode)) throw new Error(`Unsupported VTL fixture mode: ${fixtureMode}`)
if (!Number.isInteger(assessmentDurationMinutes) || assessmentDurationMinutes < 1 || assessmentDurationMinutes > 1_440) {
  throw new Error(`VTL_FIXTURE_ASSESSMENT_DURATION_MINUTES must be an integer from 1 to 1440: ${assessmentDurationMinutes}`)
}
if (!Number.isFinite(runtimeClockRate) || runtimeClockRate < 0.25 || runtimeClockRate > 3_600) {
  throw new Error(`VTL_FIXTURE_RUNTIME_CLOCK_RATE must be between 0.25 and 3600: ${runtimeClockRate}`)
}
if (!Number.isFinite(eventTriggerOffsetSeconds) || eventTriggerOffsetSeconds < 0 || eventTriggerOffsetSeconds > 86_000) throw new Error(`VTL_FIXTURE_EVENT_TRIGGER_OFFSET_SECONDS must be between 0 and 86000: ${eventTriggerOffsetSeconds}`)
if (!Number.isFinite(routeSpeedMps) || routeSpeedMps < 1 || routeSpeedMps > 50) throw new Error(`VTL_FIXTURE_ROUTE_SPEED_MPS must be between 1 and 50: ${routeSpeedMps}`)
if (!allowedStops.has(stopAt)) throw new Error(`不支持的 VTL_FIXTURE_STOP_AT：${stopAt}`)
const fixtureEvents = scale.eventCodes.map((item) => typeof item === "string" ? item : { ...item, triggerTimeSeconds: item.triggerTimeSeconds + eventTriggerOffsetSeconds })
let currentProjectId = null

const teacherCookie = await login(process.env.VTL_FIXTURE_TEACHER_EMAIL ?? "teacher@demo.local", process.env.VTL_FIXTURE_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? "")
const studentCookie = await login(process.env.VTL_FIXTURE_STUDENT_EMAIL ?? "student@demo.local", process.env.VTL_FIXTURE_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "")
const resources = await request("/v3/resource-packages", { cookie: teacherCookie })
const regions = await request("/v3/resource-packages/regions/catalog?sceneType=VTOL_INSPECTION", { cookie: teacherCookie })
const classes = await request("/v1/education/classes", { cookie: teacherCookie })
const questionBanks = await request("/v1/education/question-banks?sceneType=VTOL_INSPECTION", { cookie: teacherCookie })
const region = regions.find((candidate) => !requestedRegionCode || candidate.regionCode === requestedRegionCode) ?? regions[0]
const classroom = classes[0]
if (!region?.packageId || !classroom?.id) throw new Error("缺少垂起巡检区域或教学班")
const questionBank = questionBanks.find((item) => item.sceneType === "VTOL_INSPECTION" && item.publishedVersionId)
if (!questionBank?.publishedVersionId) throw new Error("缺少已发布垂起巡检题库")
if ((region.vtlTaskObjects?.length ?? 0) < scale.taskObjectCount) throw new Error(`区域任务对象不足：需要 ${scale.taskObjectCount} 个`)

const main = region.vtlLandingSites?.find((site) => site.type === "MAIN")
const alternate = region.vtlLandingSites?.find((site) => site.type === "ALTERNATE")
if (!main?.id || !alternate?.id) throw new Error("区域缺少主起降点或备降点")

const selectedResources = selectResources(resources, region.packageId)
const draft = await request("/v3/assignments/drafts", {
  method: "POST",
  cookie: teacherCookie,
  body: {
    title,
    sceneType: "VTOL_INSPECTION",
    mode: fixtureMode,
    isAcceptanceData,
    config: {
      taskBrief: "浏览器验收：完成广域巡检任务确认、任务分区、航空器分配、八阶段航线规划、运行处置和复盘。",
      scaleTemplateCode: scaleCode,
      regionPackageId: region.packageId,
      questionBankVersionId: questionBank.publishedVersionId,
      availableAt: new Date(Date.now() + 1_000).toISOString(),
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      ...(fixtureMode === "ASSESSMENT" ? { assessmentDurationMinutes } : {}),
      allowResubmission: true,
      allowedValidationAttempts: 3,
      allowedRuntimeAttempts: 3,
      resultVisibility: "FULL_REVIEW",
      vtlParameters: {
        projectBackground: "丘陵线性目标与点状目标综合巡检教学",
        completionRequirements: "完成任务分区、航空器分配、八阶段航线、检查、执行计划、运行和复盘。",
        mainLandingSiteId: main.id,
        aircraftModelCode: "VTOL-TEACHING-01",
        aircraftParameterVersion: "1.0.0"
      },
      scenario: {
        simulationClockRate: 3_600,
        vtlRuntimeClockRate: runtimeClockRate,
        eventCodes: fixtureEvents.map((item) => typeof item === "string" ? item : item.code),
        eventConfigs: fixtureEvents
      }
    }
  }
})
const targets = [{ type: "CLASS", targetId: classroom.id }]
const resourcePackageIds = selectedResources.map((resource) => resource.id)
const preview = await request(`/v3/assignments/drafts/${draft.id}/preview`, {
  method: "POST",
  cookie: teacherCookie,
  body: { expectedRevision: draft.revision, targets, resourcePackageIds }
})
const preflight = await request(`/v3/assignments/drafts/${draft.id}/preflight`, {
  method: "POST",
  cookie: teacherCookie,
  body: { expectedRevision: draft.revision, targets, resourcePackageIds }
})
if (preflight.checks.some((check) => check.level === "BLOCKING")) throw new Error(`VTL 发布前检查未通过：${JSON.stringify(preflight)}`)
const published = await request(`/v3/assignments/drafts/${draft.id}/publish`, {
  method: "POST",
  cookie: teacherCookie,
  body: {
    expectedRevision: draft.revision,
    configHash: preview.configHash,
    targets,
    resourcePackageIds,
    preflightConfirmation: { checkedAt: preflight.checkedAt, checkCodes: ["MAP_RESOURCE"] }
  }
})
if (publishOnly) {
  const publishedProject = await waitForProject()
  await returnResult({
    stage: "PUBLISHED",
    region: { packageId: region.packageId, regionCode: region.regionCode, title: region.title },
    assignmentId: draft.id,
    projectId: publishedProject.id,
    checkpoints: { published: true, assignmentId: draft.id, projectId: publishedProject.id }
  })
}
const project = await waitForProject()
const projectId = project.id
currentProjectId = projectId

let stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_AREA_OBJECTS", stages)
let planning = await request(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: studentCookie })
const checkpoints = { published: true, projectId, assignmentId: draft.id }

if (stopAt === "AREA") await returnResult({ stage: "VTL_AREA_OBJECTS", planning })

planning = await request(`/v3/vtl-projects/${projectId}/area/confirm`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: planning.plan.revision }
})
stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_TASK_ALLOCATION", stages)

const groups = scale.groupSizes.map((size, groupIndex) => ({
  id: `VTL-GROUP-${groupIndex + 1}`,
  code: `G-${String(groupIndex + 1).padStart(2, "0")}`,
  title: `浏览器验收 ${groupIndex + 1} 组`,
  aircraftIds: Array.from({ length: size }, (_, index) => aircraftId(scale.groupOffsets[groupIndex] + index + 1))
}))
const assignments = Array.from({ length: scale.aircraftCount }, (_, index) => {
  const aircraftIdValue = aircraftId(index + 1)
  const taskObjectIds = scale.aircraftCount === 1
    ? planning.plan.taskObjects.map((task) => task.id)
    : [planning.plan.taskObjects[index].id]
  const group = groups.find((item) => item.aircraftIds.includes(aircraftIdValue))
  return { aircraftId: aircraftIdValue, groupId: group.id, available: true, taskObjectIds, taskSequence: taskObjectIds }
})
planning = await request(`/v3/vtl-projects/${projectId}/allocation`, {
  method: "PUT",
  cookie: studentCookie,
  body: {
    expectedRevision: planning.plan.revision,
    groups,
    assignments,
    taskZones: groups.map((group) => ({
      id: `${group.id}-ZONE`,
      title: group.title,
      boundary: region.boundary,
      groupId: group.id,
      taskObjectIds: assignments.filter((item) => item.groupId === group.id).flatMap((item) => item.taskObjectIds)
    }))
  }
})
checkpoints.allocation = { groupCount: groups.length, assignmentCount: assignments.length }
if (stopAt === "ALLOCATION") await returnResult({ stage: "VTL_TASK_ALLOCATION", planning, checkpoints })

planning = await request(`/v3/vtl-projects/${projectId}/allocation/submit`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: planning.plan.revision }
})
stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_ROUTE_PLANNING", stages)
for (const [index, assignment] of planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).entries()) {
  const tasks = assignment.taskObjectIds.map((id) => planning.plan.taskObjects.find((task) => task.id === id))
  planning = await request(`/v3/vtl-projects/${projectId}/routes/${assignment.aircraftId}`, {
    method: "PUT",
    cookie: studentCookie,
    body: {
      expectedRevision: planning.plan.revision,
      waypoints: createMultiTaskWaypoints(main.position, tasks, index, stopAt === "VALIDATION_FAILED" && index === 0, routeSpeedMps),
      transitionHeightMeters: 90,
      alternateLandingSiteId: alternate.id
    }
  })
}
if (stopAt === "ROUTE") await returnResult({ stage: "VTL_ROUTE_PLANNING", planning, checkpoints })

planning = await request(`/v3/vtl-projects/${projectId}/routes/complete`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: planning.plan.revision }
})
stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_PLAN_VALIDATION", stages)
planning = await request(`/v3/vtl-projects/${projectId}/validate`, { method: "POST", cookie: studentCookie })
checkpoints.validation = planning.plan.checkResult
if (stopAt === "VALIDATION_FAILED") await returnResult({ stage: "VTL_ROUTE_PLANNING", planning, checkpoints })
if (!planning.plan.checkResult?.passed) throw new Error(`VTL 航线检查未通过：${JSON.stringify(planning.plan.checkResult)}`)

planning = await request(`/v3/vtl-projects/${projectId}/validation/submit`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: planning.plan.revision }
})
stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_EXECUTION_PLAN", stages)
const activeAircraftIds = planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).map((item) => item.aircraftId)
planning = await request(`/v3/vtl-projects/${projectId}/execution-plan/submit`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: planning.plan.revision, takeoffOrder: activeAircraftIds, landingOrder: [...activeAircraftIds].reverse() }
})
checkpoints.executionPlan = planning.plan.executionPlan
stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_RUNTIME", stages)
let runtime = await request(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
if (stopAt === "RUNTIME_READY") await returnResult({ stage: "VTL_RUNTIME", planning, runtime, checkpoints })

runtime = await request(`/v3/vtl-projects/${projectId}/runtime/start`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: runtime.session.revision, requestId: randomUUID() }
})
if (runtimeClockRate !== runtime.clockRate) {
  runtime = await request(`/v3/vtl-projects/${projectId}/runtime/clock-rate`, {
    method: "POST",
    cookie: studentCookie,
    body: { expectedRevision: runtime.session.revision, rate: runtimeClockRate, status: "RUNNING" }
  })
}
checkpoints.runtime = { sessionId: runtime.session.id, status: runtime.session.status, aircraftCount: runtime.aircraft.length }
if (stopAt === "RUNTIME_ACTIVE") await returnResult({ stage: "VTL_RUNTIME", planning, runtime, checkpoints })

const handledEvents = []
if (scaleCode === "VTL_20") {
  for (const code of supplementalEventCodes) {
    const teacherRuntime = await request(`/v3/vtl-projects/${projectId}/runtime`, { cookie: teacherCookie })
    await request(`/v3/vtl-projects/${projectId}/runtime/events/${code}/trigger`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherRuntime.session.revision, requestId: randomUUID() }
    })
    runtime = await waitForRuntime((workspace) => workspace.session.status === "PAUSED" && workspace.events.some((event) => event.code === code && ["ACTIVE", "ESCALATED", "HANDLING"].includes(event.status)))
    const event = runtime.events.find((item) => item.code === code && ["ACTIVE", "ESCALATED", "HANDLING"].includes(item.status))
    if (!event) throw new Error(`教师注入 ${code} 后未找到可处置事件`)
    const handled = await handleRuntimeEvent(runtime, event, planning)
    runtime = handled.runtime
    handledEvents.push(handled.record)
    const holdStartedAt = runtime.session.simulationTimeMs
    if (runtime.session.status !== "COMPLETED") {
      runtime = await request(`/v3/vtl-projects/${projectId}/runtime/clock-rate`, {
        method: "POST",
        cookie: studentCookie,
        body: { expectedRevision: runtime.session.revision, rate: 60, status: "RUNNING" }
      })
    }
    if (handled.record.actionCode === "HOLD") {
      runtime = await waitForRuntime((workspace) => workspace.session.simulationTimeMs >= holdStartedAt + 15_000 && workspace.aircraft.find((aircraft) => aircraft.aircraftId === handled.record.targetId)?.status !== "HOLDING")
    }
  }
}

await request(`/v3/vtl-projects/${projectId}/runtime/clock-rate`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: runtime.session.revision, rate: 3_600, status: "RUNNING" }
})
runtime = await waitForRuntime((workspace) => workspace.session.status === "COMPLETED" || (workspace.session.status === "PAUSED" && workspace.events.some((event) => ["ACTIVE", "ESCALATED", "HANDLING"].includes(event.status))))
while (runtime.session.status !== "COMPLETED") {
  const event = runtime.events.find((item) => ["ACTIVE", "ESCALATED", "HANDLING"].includes(item.status))
  if (event) {
    const handled = await handleRuntimeEvent(runtime, event, planning)
    runtime = handled.runtime
    handledEvents.push(handled.record)
    continue
  }
  if (runtime.session.status !== "RUNNING") {
    runtime = await request(`/v3/vtl-projects/${projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: runtime.session.revision, rate: 3_600, status: "RUNNING" }
    })
  }
  runtime = await waitForRuntime((workspace) => workspace.session.status === "COMPLETED" || (workspace.session.status === "PAUSED" && workspace.events.some((item) => ["ACTIVE", "ESCALATED", "HANDLING"].includes(item.status))))
}
checkpoints.eventCoverage = {
  configuredCodes: scale.eventCodes.map((item) => typeof item === "string" ? item : item.code),
  supplementalCodes: scaleCode === "VTL_20" ? supplementalEventCodes : [],
  handledEvents,
  resolvedCodes: runtime.events.filter((event) => event.status === "RESOLVED").map((event) => event.code),
  reorganizations: runtime.reorganizations.map((record) => ({ action: record.action, sourceAircraftId: record.sourceAircraftId, targetAircraftId: record.targetAircraftId, previousTaskOrder: record.previousTaskOrder, nextTaskOrder: record.nextTaskOrder, checkPassed: record.checkPassed }))
}
stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_EMERGENCY_HANDLING", stages)
runtime = await request(`/v3/vtl-projects/${projectId}/emergency/complete`, {
  method: "POST",
  cookie: studentCookie,
  body: { expectedRevision: runtime.session.revision }
})
stages = await request(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
await startStage("VTL_REVIEW", stages)
const review = await request(`/v3/vtl-projects/${projectId}/review`, { cookie: studentCookie })
if (stopAt === "REVIEW_READY" && !publishReview) await returnResult({ stage: "VTL_REVIEW", planning, runtime, review, checkpoints })
if (publishReview) {
  const submitted = await request(`/v3/vtl-projects/${projectId}/review/summary/submit`, {
    method: "POST",
    cookie: studentCookie,
    body: {
      expectedRevision: review.evaluationRevision,
      summary: "本次训练完成任务对象分配、八阶段航线检查和运行事件处置，能够根据告警调整集群组织并在复盘中说明改进方向。"
    }
  })
  const teacherReview = await request(`/v3/vtl-projects/${projectId}/review`, { cookie: teacherCookie })
  const teacherScores = teacherReview.teacherScores.map((item) => ({
    ...item,
    score: item.maxScore,
    comment: `${item.label}达到教学要求`
  }))
  const reviewed = await request(`/v3/vtl-projects/${projectId}/review/evaluation`, {
    method: "PUT",
    cookie: teacherCookie,
    body: {
      expectedRevision: teacherReview.evaluationRevision,
      teacherScores,
      summary: "学生完成垂起巡检规划、检查、运行处置和复盘，方案与运行记录能够相互对应。"
    }
  })
  const published = await request(`/v3/vtl-projects/${projectId}/review/evaluation/publish`, {
    method: "POST",
    cookie: teacherCookie,
    body: { expectedRevision: reviewed.evaluationRevision }
  })
  const pdfReport = await waitForReport("PDF")
  const pdfDownload = await downloadReport("PDF", teacherCookie)
  const requestedDocx = await request(`/v3/vtl-projects/${projectId}/review/report/generate`, {
    method: "POST",
    cookie: teacherCookie,
    body: { format: "DOCX" }
  })
  if (!requestedDocx.reportJob) throw new Error("DOCX 报告请求未创建后台作业")
  const docxReport = await waitForReport("DOCX")
  const docxDownload = await downloadReport("DOCX", teacherCookie)
  checkpoints.report = {
    pdf: { jobStatus: pdfReport.reportJob?.status, filename: pdfReport.report?.filename, bytes: pdfDownload.byteLength, signature: pdfDownload.subarray(0, 5).toString("ascii") },
    docx: { jobStatus: docxReport.reportJob?.status, filename: docxReport.report?.filename, bytes: docxDownload.byteLength, signature: docxDownload.subarray(0, 2).toString("ascii") }
  }
  await returnResult({ stage: "VTL_REVIEW", planning, runtime, review: docxReport, submittedReview: submitted, publishedReview: true, checkpoints })
}

throw new Error(`未知的 VTL 夹具流程终点：${stopAt}`)

async function startStage(code, currentStages) {
  const stage = currentStages.stages.find((item) => item.stageCode === code)
  if (!stage) throw new Error(`缺少阶段：${code}`)
  if (["AVAILABLE", "RETURNED"].includes(stage.status)) {
    await request(`/v3/projects/${projectId}/stages/${code}/start`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: stage.revision }
    })
  } else if (stage.status !== "IN_PROGRESS") {
    throw new Error(`阶段 ${code} 当前不可开始：${stage.status}`)
  }
}

async function waitForProject() {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const projects = await request("/v3/my-projects?includeInternalData=true", { cookie: studentCookie })
    const project = projects.find((item) => item.title === title && item.sceneType === "VTOL_INSPECTION")
    if (project) return project
    await delay(150)
  }
  throw new Error("发布后未找到 VTL 学生项目")
}

async function waitForRuntime(predicate) {
  const deadline = Date.now() + 20_000
  let workspace = await request(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
  while (!predicate(workspace) && Date.now() < deadline) {
    await delay(100)
    workspace = await request(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
  }
  if (!predicate(workspace)) throw new Error(`等待 VTL 运行状态超时：${JSON.stringify(workspace.session)}`)
  return workspace
}

async function waitForReport(format) {
  const deadline = Date.now() + 30_000
  let review = await request(`/v3/vtl-projects/${projectId}/review`, { cookie: teacherCookie })
  while (Date.now() < deadline) {
    if (review.reportJob?.status === "DEAD_LETTER") throw new Error(`VTL ${format} 报告作业失败：${review.reportJob.error ?? "未知错误"}`)
    if (review.reportJob?.status === "SUCCEEDED" && review.report?.format === format) return review
    await delay(150)
    review = await request(`/v3/vtl-projects/${projectId}/review`, { cookie: teacherCookie })
  }
  throw new Error(`等待 VTL ${format} 报告超时`)
}

async function downloadReport(format, cookie) {
  const response = await fetch(`${apiBase}/v3/vtl-projects/${projectId}/review/report/download`, { headers: { Origin: origin, Cookie: cookie } })
  if (!response.ok) throw new Error(`下载 VTL ${format} 报告失败：${response.status} ${await response.text()}`)
  const content = Buffer.from(await response.arrayBuffer())
  const valid = format === "PDF" ? content.subarray(0, 5).toString("ascii") === "%PDF-" : content.subarray(0, 2).toString("ascii") === "PK"
  if (!valid) throw new Error(`VTL ${format} 报告文件签名无效`)
  return content
}

async function handleRuntimeEvent(runtimeWorkspace, event, planWorkspace) {
  let current = runtimeWorkspace
  if (event.status !== "HANDLING") {
    current = await request(`/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: current.session.revision,
        requestId: randomUUID(),
        actionCode: "ACKNOWLEDGE",
        eventId: event.id,
        reasoning: { observation: "发现巡检事件", rationale: "按事件态势确认告警", expectedOutcome: "进入安全处置流程" }
      }
    })
  }
  const refreshedEvent = current.events.find((item) => item.id === event.id) ?? event
  const actionBody = eventActionRequest(current, refreshedEvent, planWorkspace)
  if (!actionBody) return { runtime: current, record: { code: event.code, eventId: event.id, actionCode: "ACKNOWLEDGE", targetId: null } }
  current = await request(`/v3/vtl-projects/${projectId}/runtime/actions`, {
    method: "POST",
    cookie: studentCookie,
    body: {
      expectedRevision: current.session.revision,
      requestId: randomUUID(),
      eventId: event.id,
      ...actionBody,
      reasoning: { observation: `识别${event.title}`, rationale: "核对阶段、能量、任务归属和可用落点后选择安全动作", expectedOutcome: "控制事件并保存任务重组结果" }
    }
  })
  return { runtime: current, record: { code: event.code, eventId: event.id, actionCode: actionBody.actionCode, targetId: actionBody.targetId } }
}

function eventActionRequest(runtimeWorkspace, event, planWorkspace) {
  let actionCode = eventActionByCode[event.code] ?? "HOLD"
  if (!event.availableActions.includes(actionCode)) throw new Error(`${event.code} 未开放预期处置动作 ${actionCode}`)
  const preferredAction = runtimeWorkspace.availableActions.find((item) => item.code === actionCode && item.enabled && item.eligibleTargetIds.length > 0)
  const action = preferredAction ?? runtimeWorkspace.availableActions.find((item) => item.enabled && item.eligibleTargetIds.length > 0)
  if (!action) return null
  actionCode = action.code
  const targetId = event.affectedAircraftIds.find((aircraftIdValue) => action.eligibleTargetIds.includes(aircraftIdValue))
    ?? action.eligibleTargetIds[0]
  if (!targetId) throw new Error(`${event.code} 没有可用目标航空器`)
  if (actionCode === "TRANSFER_TASK") {
    const assignment = planWorkspace.plan.allocation.assignments.find((item) => item.aircraftId === targetId)
    const sourceAircraft = runtimeWorkspace.aircraft.find((item) => item.aircraftId === targetId)
    const taskObjectId = assignment?.taskObjectIds.find((taskId) => !sourceAircraft?.completedTaskObjectIds.includes(taskId))
    const preferredDestinationId = aircraftId(16)
    const targetAircraftId = action.eligibleTargetIds.includes(preferredDestinationId) && preferredDestinationId !== targetId
      ? preferredDestinationId
      : action.eligibleTargetIds.find((aircraftIdValue) => aircraftIdValue !== targetId)
    if (!taskObjectId || !targetAircraftId) throw new Error(`${event.code} 缺少可转移任务或目标航空器`)
    return { actionCode, targetId, targetAircraftId, taskObjectId }
  }
  if (actionCode === "ADJUST_GROUP") {
    const aircraft = runtimeWorkspace.aircraft.find((item) => item.aircraftId === targetId)
    const targetGroupId = runtimeWorkspace.groups.find((group) => group.groupId !== aircraft?.groupId)?.groupId
    if (!targetGroupId) throw new Error(`${event.code} 缺少不同于当前分组的目标分组`)
    return { actionCode, targetId, targetGroupId }
  }
  return { actionCode, targetId }
}

function selectResources(allResources, regionPackageId) {
  const active = allResources.filter((resource) => resource.status === "ACTIVE")
  const selected = [
    active.find((resource) => resource.packageType === "RULE"),
    active.find((resource) => resource.packageType === "REGION" && resource.id === regionPackageId),
    active.find((resource) => resource.packageType === "SCALE_TEMPLATE" && resource.manifest?.sceneType === "VTOL_INSPECTION"),
    active.find((resource) => resource.packageType === "AIRCRAFT"),
    active.find((resource) => resource.packageType === "EVENT" && resource.manifest?.sceneType === "VTOL_INSPECTION"),
    active.find((resource) => resource.packageType === "REPORT" && resource.manifest?.rubrics?.some((rubric) => rubric?.sceneType === "VTOL_INSPECTION"))
  ]
  const missing = ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"].filter((_, index) => !selected[index])
  if (missing.length) throw new Error(`缺少 VTL 资源包：${missing.join(", ")}`)
  return selected
}

function createMultiTaskWaypoints(mainPosition, tasks, index, invalidFirstTask, speedMps) {
  const offset = index * 0.0001
  const start = { longitude: mainPosition.longitude + offset, latitude: mainPosition.latitude + offset, altitudeMeters: 10 }
  const climb = { longitude: mainPosition.longitude + offset, latitude: mainPosition.latitude + offset, altitudeMeters: 80 }
  const transition = { longitude: mainPosition.longitude + 0.001 + offset, latitude: mainPosition.latitude + offset, altitudeMeters: 90 }
  const cruise = { longitude: (transition.longitude + tasks[0].positions[0].longitude) / 2, latitude: (transition.latitude + tasks[0].positions[0].latitude) / 2, altitudeMeters: 120 }
  const taskWaypoints = tasks.map((task, taskIndex) => ({
    phase: "TASK_EXECUTION",
    position: { ...task.positions[0], altitudeMeters: invalidFirstTask && taskIndex === 0 ? 10 : 120 + taskIndex * 2 },
    taskObjectId: task.id
  }))
  const returnPoint = { longitude: mainPosition.longitude + 0.001 + offset, latitude: mainPosition.latitude + offset, altitudeMeters: 120 }
  return [
    { phase: "VERTICAL_TAKEOFF", position: start, taskObjectId: null },
    { phase: "CLIMB", position: climb, taskObjectId: null },
    { phase: "FORWARD_TRANSITION", position: transition, taskObjectId: null },
    { phase: "FIXED_WING_CRUISE", position: cruise, taskObjectId: null },
    ...taskWaypoints,
    { phase: "RETURN", position: returnPoint, taskObjectId: null },
    { phase: "BACK_TRANSITION", position: transition, taskObjectId: null },
    { phase: "VERTICAL_LANDING", position: start, taskObjectId: null }
  ].map((waypoint, sequence) => ({
    id: `VTL-BROWSER-WP-${index}-${sequence}`,
    sequence,
    phase: waypoint.phase,
    position: waypoint.position,
    altitudeMeters: waypoint.position.altitudeMeters,
    speedMps,
    taskObjectId: waypoint.taskObjectId
  }))
}

function aircraftId(index) { return `VTL-AIRCRAFT-${String(index).padStart(2, "0")}` }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }

async function login(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`登录失败 ${email}：${response.status} ${JSON.stringify(body)}`)
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
  if (!cookie) throw new Error(`登录没有返回会话 Cookie：${email}`)
  return cookie
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method: options.method ?? "GET",
    headers: { Origin: origin, ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`)
  return body
}

async function parseBody(response) {
  const text = await response.text()
  try { return JSON.parse(text) } catch { return text }
}

async function returnResult(result) {
  const output = {
    format: "wurenji-vtl-browser-fixture",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    apiBase,
    scaleCode,
    stopAt,
    mode: fixtureMode,
    assessmentDurationMinutes: fixtureMode === "ASSESSMENT" ? assessmentDurationMinutes : null,
    title,
    projectId: result.projectId ?? currentProjectId,
    ...result
  }
  if (outputPath) {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname, resolve } = await import("node:path")
    const resolved = resolve(outputPath)
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, `${JSON.stringify(output, null, 2)}\n`, "utf8")
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  process.exit(0)
}
