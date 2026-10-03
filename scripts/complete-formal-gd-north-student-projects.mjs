import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { checkLogisticsRoutePlan } from "@wurenji/simulation"

const apiBase = (process.env.APP_BASE_URL ?? "http://localhost:3000/api").replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || apiBase.replace(/\/api$/, "")
const outputPath = resolve("artifacts/formal-gd-north/student-submissions.json")
const projectIds = {
  show: "33f955ad-5ac1-4ba8-afaf-9711dd9e70a8",
  logistics: "859a6c43-4ae3-45c1-af1b-dd3f45668113",
  vtl: "0272fb9f-6925-428b-93e9-654a90cccfd5"
}

const student = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
const teacher = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const admin = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
const catalogs = {
  show: await region("CITY_SHOW", "GD-NORTH-SHOW-01"),
  logistics: await region("CITY_LOGISTICS", "GD-NORTH-LOGISTICS-01"),
  vtl: await region("VTOL_INSPECTION", "GD-NORTH-VTOL-01")
}

const checkpoints = {
  show: await completeShow(),
  logistics: await completeLogistics(),
  vtl: await completeVtl()
}
const projects = await request("/v3/my-projects?includeInternalData=true", { cookie: student })
const result = {
  format: "wurenji-formal-gd-north-student-submissions",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  student: "student@demo.local",
  projects: Object.entries(projectIds).map(([scene, projectId]) => {
    const project = projects.find((item) => item.id === projectId)
    if (!project) throw new Error(`最终查询缺少项目 ${projectId}`)
    return {
      scene,
      projectId,
      title: project.title,
      status: project.status,
      assignmentStatus: project.assignmentStatus,
      currentStageCode: project.currentStageCode,
      currentStageStatus: project.stages.find((item) => item.stageCode === project.currentStageCode)?.status,
      isAcceptanceData: project.isAcceptanceData,
      checkpoint: checkpoints[scene]
    }
  })
}
for (const project of result.projects) {
  if (project.status !== "EVALUATING" || project.currentStageStatus !== "SUBMITTED") {
    throw new Error(`项目没有进入学生已提交状态：${JSON.stringify(project)}`)
  }
}
await mkdir(resolve("artifacts/formal-gd-north"), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function completeShow() {
  const projectId = projectIds.show
  await startStage(projectId, "SHOW_AREA_PLANNING")
  let stages = await stageWorkspace(projectId)
  let areaStage = stage(stages, "SHOW_AREA_PLANNING")
  if (areaStage.status === "IN_PROGRESS") {
    let area = await request(`/v3/show-projects/${projectId}/area-plan`, { cookie: student })
    area = await request(`/v3/show-projects/${projectId}/area-plan/draft`, {
      method: "PUT",
      cookie: student,
      body: {
        expectedRevision: area.draft.revision,
        features: completeAreaFeatures(catalogs.show.boundary, "gd-north-formal-show"),
        annotations: [{ id: "gd-north-emergency-entry", label: "应急通道入口", position: catalogs.show.center, heightMeters: 18 }]
      }
    })
    const check = await request(`/v3/show-projects/${projectId}/area-plan/check`, { method: "POST", cookie: student })
    if (!check.passed) throw new Error(`表演区域检查未通过：${JSON.stringify(check.evidence)}`)
    stages = await stageWorkspace(projectId)
    areaStage = stage(stages, "SHOW_AREA_PLANNING")
    area = await request(`/v3/show-projects/${projectId}/area-plan/submit`, {
      method: "POST",
      cookie: student,
      body: { expectedDraftRevision: area.workspace?.draft?.revision ?? area.draft.revision, expectedStageRevision: areaStage.revision }
    })
  }
  stages = await stageWorkspace(projectId)
  areaStage = stage(stages, "SHOW_AREA_PLANNING")
  if (areaStage.status === "SUBMITTED") {
    const area = await request(`/v3/show-projects/${projectId}/area-plan`, { cookie: teacher })
    const submitted = area.versions.find((item) => item.status === "SUBMITTED")
    if (!submitted) throw new Error("表演区域待审核版本不存在")
    await request(`/v3/show-projects/${projectId}/area-plan/versions/${submitted.id}/accept`, {
      method: "POST",
      cookie: teacher,
      body: { comment: "区域边界、隔离区、应急区和净空关系满足教学任务要求。", score: 100 }
    })
  }

  if (await startStage(projectId, "SHOW_FLIGHT_APPLICATION")) {
    let documents = await request(`/v3/show-projects/${projectId}/documents`, { cookie: student })
    for (const document of documents.documents.filter((item) => item.status !== "SUBMITTED")) {
      const current = documents.documents.find((item) => item.id === document.id)
      documents = await request(`/v3/show-projects/${projectId}/documents/${document.id}/submit`, {
        method: "POST",
        cookie: student,
        body: { expectedRevision: current.revision }
      })
    }
    if (!documents.allRequiredSubmitted) throw new Error("表演飞行申报材料未全部提交")
  }

  if (await startStage(projectId, "SHOW_PREFLIGHT")) {
    let preflight = await request(`/v3/show-projects/${projectId}/preflight`, { cookie: student })
    preflight = await request(`/v3/show-projects/${projectId}/preflight`, {
      method: "PUT",
      cookie: student,
      body: {
        expectedRevision: preflight.revision,
        responses: preflight.items.map((item) => ({ code: item.code, confirmed: true, resolution: "CONFIRMED", resolved: true, note: "已按教学检查单核验" })),
        decision: "ALLOW",
        rationale: "设备、场地、通信、人员和气象条件均满足放飞要求。"
      }
    })
    await request(`/v3/show-projects/${projectId}/preflight/complete`, { method: "POST", cookie: student, body: { expectedRevision: preflight.revision } })
  }

  if (await startStage(projectId, "SHOW_T_MINUS_60")) {
    const t60 = await waitFor(() => request(`/v3/show-projects/${projectId}/t60-report`, { cookie: student }), (value) => value.status === "READY", "表演 T-60 报备")
    await request(`/v3/show-projects/${projectId}/t60-report/submit`, { method: "POST", cookie: student, body: { expectedRevision: t60.revision } })
  }

  if (await startStage(projectId, "SHOW_RUNTIME")) {
    let runtime = await request(`/v3/show-projects/${projectId}/runtime`, { cookie: student })
    if (runtime.session.status === "READY") runtime = await request(`/v3/show-projects/${projectId}/runtime/start`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision } })
    runtime = await finishShowRuntime(projectId, runtime)
    if (runtime.session.status !== "COMPLETED") throw new Error("表演仿真未完整运行")
  }

  if (await startStage(projectId, "SHOW_FLIGHT_END_REPORT")) {
    const report = await request(`/v3/show-projects/${projectId}/flight-end-report`, { cookie: student })
    await request(`/v3/show-projects/${projectId}/flight-end-report/submit`, {
      method: "POST",
      cookie: student,
      body: {
        expectedRevision: report.revision,
        completionStatus: report.suggestedAbnormalCount > 0 ? "ABNORMAL" : "NORMAL",
        normalLandedCount: report.suggestedNormalLandedCount,
        abnormalCount: report.suggestedAbnormalCount,
        abnormalDescription: report.suggestedAbnormalCount > 0 ? "异常航空器已按运行处置记录安全退出。" : ""
      }
    })
  }

  if (await startStage(projectId, "SHOW_REVIEW")) {
    const review = await request(`/v3/show-projects/${projectId}/review`, { cookie: student })
    await request(`/v3/show-projects/${projectId}/review/summary/submit`, {
      method: "POST",
      cookie: student,
      body: {
        expectedRevision: review.evaluation.revision,
        summary: "",
        structuredSummary: {
          completion: "完成区域规划、飞行申报、飞前检查、T-60 报备、编队运行、异常处置和结束报备。",
          problems: "运行中需要持续关注环境、定位、通信和单机设备状态变化。",
          decisions: "依据事件影响范围选择告警确认、暂停或单机安全退出，并在风险受控后恢复运行。",
          improvements: "进一步缩短告警判断时间，完善分组级处置依据和恢复条件记录。"
        }
      }
    })
  }
  const review = await request(`/v3/show-projects/${projectId}/review`, { cookie: student })
  return { submittedAt: review.evaluation.studentSubmittedAt, runtimeActions: review.timeline.filter((item) => item.kind === "ACTION").length }
}

async function finishShowRuntime(projectId, initial) {
  let runtime = initial
  for (let attempt = 0; attempt < 160 && runtime.session.status !== "COMPLETED"; attempt += 1) {
    for (const alert of runtime.alerts.filter((item) => item.status === "OPEN")) {
      const acknowledge = runtime.availableActions.find((item) => item.code === "ACKNOWLEDGE_ALERT" && item.enabled && item.eligibleTargetIds.includes(alert.id))
      if (!acknowledge) continue
      runtime = await request(`/v3/show-projects/${projectId}/runtime/actions`, {
        method: "POST",
        cookie: student,
        body: { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: "ACKNOWLEDGE_ALERT", eventId: alert.eventId, alertId: alert.id, targetId: alert.id, reasoning: reasoning("发现编队运行告警", "先确认告警并核对影响对象", "告警进入已确认状态") }
      })
    }
    const event = runtime.events.find((item) => ["DISCOVERED", "ESCALATED", "HANDLING"].includes(item.lifecycleStatus))
    if (event) {
      const action = event.recommendedActions.map((code) => runtime.availableActions.find((item) => item.code === code && item.enabled)).find(Boolean)
        ?? runtime.availableActions.find((item) => item.enabled && item.code !== "ACKNOWLEDGE_ALERT" && !item.code.startsWith("RESUME"))
      if (action) {
        runtime = await request(`/v3/show-projects/${projectId}/runtime/actions`, {
          method: "POST",
          cookie: student,
          body: { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: action.code, eventId: event.id, targetId: action.requiresTarget ? action.eligibleTargetIds[0] : null, reasoning: reasoning(`识别${event.title}`, "依据影响范围、空中数量和当前表演阶段选择安全动作", "控制事件并保存处置证据") }
        })
      }
    }
    if (runtime.session.status === "PAUSED" && !runtime.events.some((item) => ["DISCOVERED", "ESCALATED", "HANDLING"].includes(item.lifecycleStatus))) {
      const resume = runtime.availableActions.find((item) => item.code === "RESUME_PROGRAM" && item.enabled)
      runtime = resume
        ? await request(`/v3/show-projects/${projectId}/runtime/actions`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: "RESUME_PROGRAM", targetId: null, reasoning: reasoning("异常影响已受控", "环境和编队状态允许恢复", "继续执行固定表演程序") } })
        : await request(`/v3/show-projects/${projectId}/runtime/clock-rate`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, rate: 3600, status: "RUNNING" } })
    } else if (runtime.session.status === "RUNNING" && runtime.clockRate !== 3600) {
      runtime = await request(`/v3/show-projects/${projectId}/runtime/clock-rate`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, rate: 3600, status: "RUNNING" } })
    }
    await delay(100)
    runtime = await request(`/v3/show-projects/${projectId}/runtime`, { cookie: student })
  }
  return runtime
}

async function completeLogistics() {
  const projectId = projectIds.logistics
  const { deliveryNodes, routes } = findPassingRoutes(catalogs.logistics)
  if (await startStage(projectId, "LOGISTICS_REGION_ANALYSIS")) {
    let workspace = await request(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: student })
    workspace = await request(`/v3/logistics-projects/${projectId}/region-analysis`, {
      method: "PUT",
      cookie: student,
      body: { expectedRevision: workspace.regionAnalysis.revision, selectedDeliveryPointIds: deliveryNodes.map((item) => item.id), notes: "已核查核心区域限制区、建筑、通信覆盖、起降点、等待点、备降点和应急区域。" }
    })
    const currentStage = stage(await stageWorkspace(projectId), "LOGISTICS_REGION_ANALYSIS")
    await request(`/v3/logistics-projects/${projectId}/region-analysis/confirm`, { method: "POST", cookie: student, body: { expectedRevision: workspace.regionAnalysis.revision, expectedStageRevision: currentStage.revision } })
  }

  if (await startStage(projectId, "LOGISTICS_ROUTE_PLANNING")) {
    let workspace = await request(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: student })
    workspace = await request(`/v3/logistics-projects/${projectId}/route-plan/draft`, { method: "PUT", cookie: student, body: { expectedRevision: workspace.draft.revision, routes } })
    workspace = await request(`/v3/logistics-projects/${projectId}/route-plan/check`, { method: "POST", cookie: student })
    if (!workspace.draft.lastCheckResult?.passed) throw new Error(`物流航线检查未通过：${JSON.stringify(workspace.draft.lastCheckResult?.evidence)}`)
    await request(`/v3/logistics-projects/${projectId}/route-plan/snapshot`, { method: "POST", cookie: student })
    const currentStage = stage(await stageWorkspace(projectId), "LOGISTICS_ROUTE_PLANNING")
    await request(`/v3/logistics-projects/${projectId}/route-plan/complete`, { method: "POST", cookie: student, body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: currentStage.revision } })
  }

  if (await startStage(projectId, "LOGISTICS_ROUTE_VALIDATION")) {
    let workspace = await request(`/v3/logistics-projects/${projectId}/route-plan/validate`, { method: "POST", cookie: student })
    const version = workspace.versions.find((item) => item.status === "VALIDATED")
    if (!version || workspace.validationRuns[0]?.result.completedRoundTripCount !== deliveryNodes.length) throw new Error("物流往返航线验证未通过")
    const currentStage = stage(await stageWorkspace(projectId), "LOGISTICS_ROUTE_VALIDATION")
    await request(`/v3/logistics-projects/${projectId}/route-plan/versions/${version.id}/submit`, { method: "POST", cookie: student, body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: currentStage.revision } })
  }

  if (await startStage(projectId, "LOGISTICS_ORDER_SCHEDULING")) {
    let scheduling = await request(`/v3/logistics-projects/${projectId}/scheduling-workspace`, { cookie: student })
    scheduling = await request(`/v3/logistics-projects/${projectId}/schedule-plan/draft`, { method: "PUT", cookie: student, body: { expectedRevision: scheduling.draft.revision, items: buildScheduleItems(scheduling) } })
    scheduling = await request(`/v3/logistics-projects/${projectId}/schedule-plan/check`, { method: "POST", cookie: student })
    if (!scheduling.draft.lastCheckResult?.submittable) throw new Error(`物流调度检查未通过：${JSON.stringify(scheduling.draft.lastCheckResult?.evidence)}`)
    await request(`/v3/logistics-projects/${projectId}/schedule-plan/snapshot`, { method: "POST", cookie: student })
    scheduling = await request(`/v3/logistics-projects/${projectId}/scheduling-workspace`, { cookie: student })
    const version = scheduling.versions.find((item) => item.sourceDraftRevision === scheduling.draft.revision && item.status === "SNAPSHOT")
    if (!version) throw new Error("物流调度快照不存在")
    const currentStage = stage(await stageWorkspace(projectId), "LOGISTICS_ORDER_SCHEDULING")
    await request(`/v3/logistics-projects/${projectId}/schedule-plan/versions/${version.id}/submit`, { method: "POST", cookie: student, body: { expectedDraftRevision: scheduling.draft.revision, expectedStageRevision: currentStage.revision } })
  }

  if (await startStage(projectId, "LOGISTICS_RUNTIME_PREPARATION")) {
    let readiness = await request(`/v3/logistics-projects/${projectId}/runtime-readiness`, { cookie: student })
    readiness = await request(`/v3/logistics-projects/${projectId}/runtime-readiness`, { method: "PUT", cookie: student, body: { expectedRevision: readiness.readiness.revision, decision: "PROCEED", decisionBasis: "已复核离线地图资源、双向航线、订单调度、机队状态和运行环境。" } })
    readiness = await request(`/v3/logistics-projects/${projectId}/runtime-readiness/check`, { method: "POST", cookie: student, body: { expectedRevision: readiness.readiness.revision } })
    if (!readiness.canConfirm) throw new Error(`物流运行准备检查未通过：${JSON.stringify(readiness.readiness.checks)}`)
    await request(`/v3/logistics-projects/${projectId}/runtime-readiness/confirm`, { method: "POST", cookie: student, body: { expectedRevision: readiness.readiness.revision } })
  }

  if (await startStage(projectId, "LOGISTICS_DELIVERY_RUNTIME")) {
    let runtime = await request(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: student })
    if (runtime.session.status === "READY") runtime = await request(`/v3/logistics-projects/${projectId}/runtime/start`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision } })
    runtime = await finishLogisticsRuntime(projectId, runtime)
    if (runtime.session.status !== "COMPLETED") throw new Error("物流仿真未完整运行")
  }

  if (await startStage(projectId, "LOGISTICS_EMERGENCY_HANDLING")) {
    await request(`/v3/logistics-projects/${projectId}/runtime/emergency-handling/complete`, { method: "POST", cookie: student })
  }
  if (await startStage(projectId, "LOGISTICS_REVIEW")) {
    const review = await request(`/v3/logistics-projects/${projectId}/review`, { cookie: student })
    await request(`/v3/logistics-projects/${projectId}/review/summary/submit`, {
      method: "POST",
      cookie: student,
      body: {
        expectedRevision: review.evaluation.revision,
        summary: "",
        structuredSummary: {
          originalPlanProblems: "原调度对突发事件后的时序余量预留不足。",
          responseLessons: "应先确认影响航线与在航任务，再执行飞行处置和后续订单调整。",
          routeAdjustmentSuggestions: "为重点配送点保留已验证的双向备用航线和安全退出节点。",
          schedulingOptimization: "根据优先级、时间窗和无人机下一可用时间滚动重排未执行订单。",
          improvements: "提前设置延误阈值，并在提交调整前复核航线、运力和硬冲突证据。"
        }
      }
    })
  }
  const review = await request(`/v3/logistics-projects/${projectId}/review`, { cookie: student })
  return { submittedAt: review.evaluation.studentSubmittedAt, completedOrders: review.logisticsAnalysis?.completedOrders ?? null, runtimeActions: review.timeline.filter((item) => item.kind === "ACTION").length }
}

async function finishLogisticsRuntime(projectId, initial) {
  let runtime = initial
  for (let attempt = 0; attempt < 200 && runtime.session.status !== "COMPLETED"; attempt += 1) {
    for (const alert of runtime.alerts.filter((item) => item.status === "OPEN")) {
      const action = runtime.availableActions.find((item) => item.code === "ACKNOWLEDGE_ALERT" && item.enabled && item.eligibleTargetIds.includes(alert.id))
      if (!action) continue
      runtime = await request(`/v3/logistics-projects/${projectId}/runtime/actions`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: "ACKNOWLEDGE_ALERT", eventId: alert.eventId, alertId: alert.id, targetId: alert.id, reasoning: reasoning("发现物流运行告警", "确认告警并核对受影响订单、航空器和航线", "进入事件处置流程") } })
    }
    const event = runtime.events.find((item) => ["DISCOVERED", "ESCALATED", "HANDLING"].includes(item.lifecycleStatus))
    if (event) {
      const action = event.recommendedActions
        .filter((code) => !["SWITCH_VERIFIED_ROUTE", "REASSIGN_ORDER"].includes(code))
        .map((code) => runtime.availableActions.find((item) => item.code === code && item.enabled))
        .find(Boolean)
      if (action) {
        const affectedTargetIds = action.targetType === "AIRCRAFT"
          ? event.affectedAircraftIds
          : action.targetType === "ORDER"
            ? event.affectedOrderIds
            : action.targetType === "ROUTE"
              ? event.affectedRouteIds
              : []
        const targetId = action.requiresTarget
          ? affectedTargetIds.find((item) => action.eligibleTargetIds.includes(item)) ?? action.eligibleTargetIds[0]
          : null
        runtime = await request(`/v3/logistics-projects/${projectId}/runtime/actions`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: action.code, eventId: event.id, targetId, reasoning: reasoning(`识别${event.title}`, "结合航线状态、订单时窗和航空器状态选择处置", "控制事件并维持安全配送") } })
      }
    }
    if (runtime.session.status !== "COMPLETED" && (runtime.session.status !== "RUNNING" || runtime.clockRate !== 3600)) {
      runtime = await request(`/v3/logistics-projects/${projectId}/runtime/clock`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, status: "RUNNING", rate: 3600 } })
    }
    await delay(100)
    runtime = await request(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: student })
  }
  return runtime
}

async function completeVtl() {
  const projectId = projectIds.vtl
  if (await startStage(projectId, "VTL_AREA_OBJECTS")) {
    let planning = await request(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: student })
    await request(`/v3/vtl-projects/${projectId}/area/confirm`, { method: "POST", cookie: student, body: { expectedRevision: planning.plan.revision } })
  }
  let planning = await request(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: student })
  const main = planning.plan.landingSites.find((item) => item.type === "MAIN")
  const alternate = planning.plan.landingSites.find((item) => item.type === "ALTERNATE")
  if (!main || !alternate) throw new Error("垂起区域缺少主起降点或备降点")
  if (await startStage(projectId, "VTL_TASK_ALLOCATION")) {
    planning = await request(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: student })
    const aircraftIds = Array.from({ length: 5 }, (_, index) => aircraftId(index + 1))
    const group = { id: "VTL-GROUP-1", code: "G-01", title: "广东北部巡检组", aircraftIds }
    const assignments = aircraftIds.map((aircraftIdValue, index) => ({ aircraftId: aircraftIdValue, groupId: group.id, available: true, taskObjectIds: [planning.plan.taskObjects[index].id], taskSequence: [planning.plan.taskObjects[index].id] }))
    planning = await request(`/v3/vtl-projects/${projectId}/allocation`, { method: "PUT", cookie: student, body: { expectedRevision: planning.plan.revision, groups: [group], assignments, taskZones: [{ id: "GD-NORTH-VTL-ZONE", title: "广东北部核心巡检区", boundary: catalogs.vtl.boundary, groupId: group.id, taskObjectIds: planning.plan.taskObjects.map((item) => item.id) }] } })
    await request(`/v3/vtl-projects/${projectId}/allocation/submit`, { method: "POST", cookie: student, body: { expectedRevision: planning.plan.revision } })
  }
  if (await startStage(projectId, "VTL_ROUTE_PLANNING")) {
    planning = await request(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: student })
    for (const [index, assignment] of planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).entries()) {
      const tasks = assignment.taskObjectIds.map((id) => planning.plan.taskObjects.find((item) => item.id === id))
      planning = await request(`/v3/vtl-projects/${projectId}/routes/${assignment.aircraftId}`, { method: "PUT", cookie: student, body: { expectedRevision: planning.plan.revision, waypoints: createVtlWaypoints(main.position, tasks, index), transitionHeightMeters: 90, alternateLandingSiteId: alternate.id } })
    }
    await request(`/v3/vtl-projects/${projectId}/routes/complete`, { method: "POST", cookie: student, body: { expectedRevision: planning.plan.revision } })
  }
  if (await startStage(projectId, "VTL_PLAN_VALIDATION")) {
    planning = await request(`/v3/vtl-projects/${projectId}/validate`, { method: "POST", cookie: student })
    if (!planning.plan.checkResult?.passed) throw new Error(`垂起航线检查未通过：${JSON.stringify(planning.plan.checkResult)}`)
    await request(`/v3/vtl-projects/${projectId}/validation/submit`, { method: "POST", cookie: student, body: { expectedRevision: planning.plan.revision } })
  }
  if (await startStage(projectId, "VTL_EXECUTION_PLAN")) {
    planning = await request(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: student })
    const active = planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).map((item) => item.aircraftId)
    await request(`/v3/vtl-projects/${projectId}/execution-plan/submit`, { method: "POST", cookie: student, body: { expectedRevision: planning.plan.revision, takeoffOrder: active, landingOrder: [...active].reverse() } })
  }
  if (await startStage(projectId, "VTL_RUNTIME")) {
    let runtime = await request(`/v3/vtl-projects/${projectId}/runtime`, { cookie: student })
    if (runtime.session.status === "READY") runtime = await request(`/v3/vtl-projects/${projectId}/runtime/start`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, requestId: randomUUID() } })
    planning = await request(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: student })
    runtime = await finishVtlRuntime(projectId, runtime, planning)
    if (runtime.session.status !== "COMPLETED") throw new Error("垂起巡检仿真未完整运行")
  }
  if (await startStage(projectId, "VTL_EMERGENCY_HANDLING")) {
    const runtime = await request(`/v3/vtl-projects/${projectId}/runtime`, { cookie: student })
    await request(`/v3/vtl-projects/${projectId}/emergency/complete`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision } })
  }
  if (await startStage(projectId, "VTL_REVIEW")) {
    const review = await request(`/v3/vtl-projects/${projectId}/review`, { cookie: student })
    await request(`/v3/vtl-projects/${projectId}/review/summary/submit`, { method: "POST", cookie: student, body: { expectedRevision: review.evaluationRevision, summary: "本次训练完成区域对象确认、五机任务分配、八阶段航线规划、方案验证、执行计划、动态运行和天气事件处置，并依据任务覆盖、能量余量和备降条件复盘改进。" } })
  }
  const review = await request(`/v3/vtl-projects/${projectId}/review`, { cookie: student })
  return { submitted: !review.canSubmitSummary, taskCoverageRatio: review.taskCoverageRatio, runtimeActions: review.timeline.filter((item) => item.kind === "ACTION").length }
}

async function finishVtlRuntime(projectId, initial, planning) {
  let runtime = initial
  for (let attempt = 0; attempt < 200 && runtime.session.status !== "COMPLETED"; attempt += 1) {
    const event = runtime.events.find((item) => ["ACTIVE", "ESCALATED", "HANDLING"].includes(item.status))
    if (event) runtime = await handleVtlEvent(projectId, runtime, event, planning)
    if (runtime.session.status !== "COMPLETED" && (runtime.session.status !== "RUNNING" || runtime.clockRate !== 3600)) {
      runtime = await request(`/v3/vtl-projects/${projectId}/runtime/clock-rate`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, rate: 3600, status: "RUNNING" } })
    }
    await delay(100)
    runtime = await request(`/v3/vtl-projects/${projectId}/runtime`, { cookie: student })
  }
  return runtime
}

async function handleVtlEvent(projectId, workspace, event, planning) {
  let runtime = workspace
  if (event.status !== "HANDLING") {
    runtime = await request(`/v3/vtl-projects/${projectId}/runtime/actions`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: "ACKNOWLEDGE", eventId: event.id, reasoning: reasoning("发现垂起巡检事件", "确认事件并核对影响航空器", "进入安全处置流程") } })
  }
  const currentEvent = runtime.events.find((item) => item.id === event.id) ?? event
  const preferred = { VTL_WEATHER: "HOLD", VTL_TRANSITION: "HOLD", VTL_POSITIONING: "RETURN_AIRCRAFT", VTL_ENERGY_POWER: "DIVERT_AIRCRAFT", VTL_DEVICE: "TRANSFER_TASK" }[event.code] ?? "HOLD"
  const action = runtime.availableActions.find((item) => item.code === preferred && item.enabled && item.eligibleTargetIds.length > 0)
    ?? runtime.availableActions.find((item) => item.enabled && item.eligibleTargetIds.length > 0)
  if (!action || !currentEvent.availableActions.includes(action.code)) return runtime
  const targetId = currentEvent.affectedAircraftIds.find((item) => action.eligibleTargetIds.includes(item)) ?? action.eligibleTargetIds[0]
  const body = { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: action.code, eventId: event.id, targetId, reasoning: reasoning(`识别${event.title}`, "结合任务阶段、能量、任务归属和备降点选择处置", "控制事件并保持任务安全") }
  if (action.code === "TRANSFER_TASK") {
    const assignment = planning.plan.allocation.assignments.find((item) => item.aircraftId === targetId)
    const source = runtime.aircraft.find((item) => item.aircraftId === targetId)
    body.taskObjectId = assignment?.taskObjectIds.find((item) => !source?.completedTaskObjectIds.includes(item))
    body.targetAircraftId = action.eligibleTargetIds.find((item) => item !== targetId)
  }
  return request(`/v3/vtl-projects/${projectId}/runtime/actions`, { method: "POST", cookie: student, body })
}

async function startStage(projectId, code) {
  const workspace = await stageWorkspace(projectId)
  const item = stage(workspace, code)
  if (["ACCEPTED", "SUBMITTED"].includes(item.status)) return false
  if (["AVAILABLE", "RETURNED"].includes(item.status)) {
    await request(`/v3/projects/${projectId}/stages/${code}/start`, { method: "POST", cookie: student, body: { expectedRevision: item.revision } })
    return true
  }
  if (item.status === "IN_PROGRESS") return true
  throw new Error(`阶段 ${code} 当前不可推进：${item.status}`)
}

async function stageWorkspace(projectId) {
  return request(`/v3/projects/${projectId}/stages`, { cookie: student })
}

function stage(workspace, code) {
  const value = workspace.stages.find((item) => item.stageCode === code)
  if (!value) throw new Error(`缺少项目阶段：${code}`)
  return value
}

async function region(sceneType, regionCode) {
  const regions = await request(`/v3/resource-packages/regions/catalog?sceneType=${sceneType}`, { cookie: admin })
  const value = regions.find((item) => item.regionCode === regionCode)
  if (!value) throw new Error(`缺少区域：${regionCode}`)
  return value
}

function completeAreaFeatures(boundary, prefix) {
  const types = ["TAKEOFF_LANDING", "FLIGHT", "PERFORMANCE", "BUFFER", "GROUND_ISOLATION", "AUDIENCE", "OPERATION", "EMERGENCY_LANDING", "GEOFENCE"]
  const west = Math.min(...boundary.map((item) => item.longitude))
  const east = Math.max(...boundary.map((item) => item.longitude))
  const south = Math.min(...boundary.map((item) => item.latitude))
  const north = Math.max(...boundary.map((item) => item.latitude))
  const width = east - west
  const height = north - south
  return types.map((type, index) => {
    const longitude = west + width * (0.16 + (index % 3) * 0.3)
    const latitude = south + height * (0.16 + Math.floor(index / 3) * 0.3)
    return {
      id: `${prefix}-${index + 1}`,
      type,
      label: type,
      positions: rectangle(longitude, latitude, width * 0.08, height * 0.08),
      ...(["FLIGHT", "PERFORMANCE", "GEOFENCE"].includes(type) ? { heightRange: { datum: "AGL", minimumMeters: 20, maximumMeters: 120 } } : {}),
      properties: type === "TAKEOFF_LANDING" ? { capacity: 3000, orientationDegrees: 0 } : type === "PERFORMANCE" ? { orientationDegrees: 0 } : type === "BUFFER" ? { referenceWidthMeters: 30 } : type === "AUDIENCE" ? { orientationDegrees: 0, capacityLevel: "大型" } : type === "EMERGENCY_LANDING" ? { availability: "全程可用", capacityLevel: "多组" } : type === "GEOFENCE" ? { policy: "越界告警" } : { purpose: "正式教学任务" }
    }
  })
}

function findPassingRoutes(regionValue) {
  const candidates = regionValue.logisticsNodes.filter((item) => item.type === "DELIVERY_POINT" && item.enabled && item.position).sort((left, right) => distance(left.position, regionValue.center) - distance(right.position, regionValue.center))
  const width = Math.max(...regionValue.boundary.map((item) => item.longitude)) - Math.min(...regionValue.boundary.map((item) => item.longitude))
  const height = Math.max(...regionValue.boundary.map((item) => item.latitude)) - Math.min(...regionValue.boundary.map((item) => item.latitude))
  const aircraft = { modelCode: "TEACHING-UAV-01", cruiseSpeedMps: 12, maximumSpeedMps: 18, maximumHeightMeters: 120, maximumRoundTripMeters: 12_000, minimumReserveBatteryPercent: 20, climbRateMps: 3, ruleVersion: "LOGISTICS-ROUTE-1.0.0" }
  const deliveryNodes = []
  const routePairs = []
  for (const delivery of candidates) {
    if (deliveryNodes.length >= 8) break
    for (const lane of [-0.45, 0.45, -0.35, 0.35, -0.25, 0.25, -0.15, 0.15, 0]) {
      const pair = logisticsRoutes(regionValue, delivery, width, height, lane)
      const trial = [...routePairs.flat(), ...pair]
      if (checkLogisticsRoutePlan(trial, { region: regionValue, selectedDeliveryPointIds: [...deliveryNodes, delivery].map((item) => item.id), aircraft }).passed) {
        deliveryNodes.push(delivery)
        routePairs.push(pair)
        break
      }
    }
  }
  if (deliveryNodes.length < 8) throw new Error(`物流区域只能生成 ${deliveryNodes.length} 个合格配送点航线`)
  return { deliveryNodes, routes: routePairs.flat() }
}

function logisticsRoutes(regionValue, delivery, width, height, lane) {
  const takeoff = logisticsNode(regionValue, "TAKEOFF_POINT")
  const landing = logisticsNode(regionValue, "LANDING_POINT")
  const waiting = logisticsNode(regionValue, "WAITING_POINT")
  const alternate = logisticsNode(regionValue, "ALTERNATE_LANDING_POINT")
  const emergency = logisticsNode(regionValue, "EMERGENCY_AREA")
  const latitude = regionValue.center.latitude + height * lane
  const outbound = `formal-outbound-${delivery.id}`
  const inbound = `formal-return-${delivery.id}`
  return [
    route(outbound, delivery, "OUTBOUND", takeoff.id, delivery.id, [waypoint(`${outbound}-1`, takeoff.position, 0, true, takeoff.id), waypoint(`${outbound}-2`, { longitude: regionValue.center.longitude - width * 0.08, latitude }, 100), waypoint(`${outbound}-3`, { longitude: delivery.position.longitude - width * 0.05, latitude }, 100), waypoint(`${outbound}-4`, delivery.position, 0, true, delivery.id)], waiting.id, alternate.id, emergency.id),
    route(inbound, delivery, "RETURN", delivery.id, landing.id, [waypoint(`${inbound}-1`, delivery.position, 0, true, delivery.id), waypoint(`${inbound}-2`, { longitude: delivery.position.longitude + width * 0.05, latitude: latitude + height * 0.035 }, 100), waypoint(`${inbound}-3`, { longitude: regionValue.center.longitude + width * 0.08, latitude: latitude + height * 0.035 }, 100), waypoint(`${inbound}-4`, landing.position, 0, true, landing.id)], waiting.id, alternate.id, emergency.id)
  ]
}

function route(id, delivery, direction, departureNodeId, arrivalNodeId, waypoints, waitingNodeId, alternateNodeId, emergencyNodeId) {
  return { id, name: `${delivery.name}-${direction}`, destinationNodeId: delivery.id, direction, role: "PRIMARY", groupCode: "GD-NORTH-FORMAL", departureNodeId, arrivalNodeId, protectionRadiusMeters: 30, waitingNodeIds: [waitingNodeId], alternateLandingNodeIds: [alternateNodeId], emergencyAreaNodeIds: [emergencyNodeId], entryDirectionDegrees: 90, exitDirectionDegrees: 270, waypoints }
}

function waypoint(id, position, altitudeMeters, locked = false, nodeId = null) {
  return { id, name: id, position: { ...position }, altitudeMeters, segmentAltitudeMeters: altitudeMeters === 0 ? 100 : altitudeMeters, speedMps: 12, nodeId, locked }
}

function buildScheduleItems(workspace) {
  const pairs = new Map()
  for (const item of workspace.routes) {
    const entry = pairs.get(item.route.destinationNodeId) ?? {}
    entry[item.route.direction === "OUTBOUND" ? "outbound" : "inbound"] = item
    pairs.set(item.route.destinationNodeId, entry)
  }
  let nextAvailable = 0
  return workspace.orders.map((order, index) => {
    const aircraft = workspace.aircraft[index % workspace.aircraft.length]
    const pair = pairs.get(order.destinationNodeId)
    if (!aircraft || !pair?.outbound || !pair.inbound) throw new Error(`订单 ${order.code} 缺少无人机或往返航线`)
    const plannedTakeoffTimeMs = Math.max(order.earliestStartTimeMs, nextAvailable)
    nextAvailable = plannedTakeoffTimeMs + pair.outbound.flightTimeMs + pair.inbound.flightTimeMs + 180_000
    return { id: `formal-dispatch-${String(index + 1).padStart(3, "0")}`, orderId: order.id, aircraftId: aircraft.id, outboundRouteId: pair.outbound.id, returnRouteId: pair.inbound.id, plannedTakeoffTimeMs }
  })
}

function logisticsNode(regionValue, type) {
  const value = regionValue.logisticsNodes.find((item) => item.type === type && item.enabled)
  if (!value) throw new Error(`物流区域缺少节点：${type}`)
  return value
}

function createVtlWaypoints(main, tasks, index) {
  const offset = index * 0.0001
  const start = { longitude: main.longitude + offset, latitude: main.latitude + offset, altitudeMeters: 10 }
  const climb = { longitude: main.longitude + offset, latitude: main.latitude + offset, altitudeMeters: 80 }
  const transition = { longitude: main.longitude + 0.001 + offset, latitude: main.latitude + offset, altitudeMeters: 90 }
  const cruise = { longitude: (transition.longitude + tasks[0].positions[0].longitude) / 2, latitude: (transition.latitude + tasks[0].positions[0].latitude) / 2, altitudeMeters: 120 }
  const points = [
    { phase: "VERTICAL_TAKEOFF", position: start, taskObjectId: null },
    { phase: "CLIMB", position: climb, taskObjectId: null },
    { phase: "FORWARD_TRANSITION", position: transition, taskObjectId: null },
    { phase: "FIXED_WING_CRUISE", position: cruise, taskObjectId: null },
    ...tasks.map((task, taskIndex) => ({ phase: "TASK_EXECUTION", position: { ...task.positions[0], altitudeMeters: 120 + taskIndex * 2 }, taskObjectId: task.id })),
    { phase: "RETURN", position: { longitude: main.longitude + 0.001 + offset, latitude: main.latitude + offset, altitudeMeters: 120 }, taskObjectId: null },
    { phase: "BACK_TRANSITION", position: transition, taskObjectId: null },
    { phase: "VERTICAL_LANDING", position: start, taskObjectId: null }
  ]
  return points.map((item, sequence) => ({ id: `GD-NORTH-VTL-WP-${index}-${sequence}`, sequence, phase: item.phase, position: item.position, altitudeMeters: item.position.altitudeMeters, speedMps: 20, taskObjectId: item.taskObjectId }))
}

function rectangle(longitude, latitude, width, height) {
  return [{ longitude, latitude }, { longitude: longitude + width, latitude }, { longitude: longitude + width, latitude: latitude + height }, { longitude, latitude: latitude + height }]
}

function distance(left, right) {
  return Math.hypot((left.longitude - right.longitude) * 102_000, (left.latitude - right.latitude) * 111_000)
}

function aircraftId(index) {
  return `VTL-AIRCRAFT-${String(index).padStart(2, "0")}`
}

function reasoning(observation, rationale, expectedOutcome) {
  return { observation, rationale, expectedOutcome }
}

async function waitFor(loader, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let value = await loader()
  while (!predicate(value) && Date.now() < deadline) {
    await delay(100)
    value = await loader()
  }
  if (!predicate(value)) throw new Error(`等待${label}超时`)
  return value
}

async function login(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
  const body = await parseBody(response)
  if (!response.ok) throw new Error(`登录失败 ${email}: ${response.status} ${JSON.stringify(body)}`)
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
