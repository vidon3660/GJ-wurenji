import { checkLogisticsRoutePlan } from "@wurenji/simulation"

const apiBase = (process.env.APP_BASE_URL ?? "http://localhost:3000/api").replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || apiBase.replace(/\/api$/, "")
const scaleTemplateCode = process.env.STU012_FIXTURE_SCALE?.trim() || "LOGISTICS_3"
const title = process.env.STU012_FIXTURE_TITLE ?? `STU-012 物流完整往返仿真 ${timestamp()}`
const outputPath = process.env.STU012_FIXTURE_OUTPUT?.trim() || "artifacts/stu012-browser-fixture-latest.json"
const stopAt = process.env.STU012_FIXTURE_STOP_AT?.trim() || ""
const segmentRiskAltitude = Number(process.env.STU012_SEGMENT_RISK_ALTITUDE ?? 0)
const requestedRegionCode = process.env.STU012_FIXTURE_REGION_CODE?.trim() || ""
const isAcceptanceData = process.env.STU012_FIXTURE_IS_ACCEPTANCE_DATA !== "false"
const publishOnly = process.env.STU012_FIXTURE_PUBLISH_ONLY === "true"
const takeoffSpacingSeconds = Number(process.env.STU012_FIXTURE_TAKEOFF_SPACING_SECONDS ?? (Number(scaleTemplateCode.match(/(\d+)$/)?.[1] ?? 3) >= 20 ? 90 : 300))
const aircraft = {
  modelCode: "TEACHING-UAV-01",
  cruiseSpeedMps: 12,
  maximumSpeedMps: 18,
  maximumHeightMeters: 120,
  maximumRoundTripMeters: 12_000,
  minimumReserveBatteryPercent: 20,
  climbRateMps: 3,
  ruleVersion: "LOGISTICS-ROUTE-1.0.0"
}

const admin = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
const teacher = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
const student = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")

const resources = await request("/v3/resource-packages", { cookie: admin })
const classes = await request("/v1/education/classes", { cookie: teacher })
const regions = await request("/v3/resource-packages/regions/catalog?sceneType=CITY_LOGISTICS", { cookie: admin })
const questionBanks = await request("/v1/education/question-banks?sceneType=CITY_LOGISTICS", { cookie: teacher })
const questionBank = questionBanks.find((item) => item.sceneType === "CITY_LOGISTICS" && item.publishedVersionId)
if (!questionBank?.publishedVersionId) throw new Error("缺少已发布物流题库")
let classroom = null
let classroomStudents = []
for (const candidate of classes) {
  const students = await request(`/v1/education/classes/${candidate.id}/students`, { cookie: teacher })
  if (students.some((item) => item.email === "student@demo.local")) {
    classroom = candidate
    classroomStudents = students
    break
  }
}
const targetStudent = classroomStudents.find((item) => item.email === "student@demo.local")
if (!targetStudent?.id) throw new Error("验收教学班中缺少 student@demo.local")

const regionAttempts = []
const selectedRegion = regions.filter((candidate) => !requestedRegionCode || candidate.regionCode === requestedRegionCode).find((candidate) => {
  try {
    const routeSelection = findPassingRoutes(candidate)
    regionAttempts.push({ packageId: candidate.packageId, selectedDeliveryCount: routeSelection.deliveryIds.length })
    candidate.__fixtureRouteSelection = routeSelection
    return true
  } catch (error) {
    regionAttempts.push({ packageId: candidate.packageId, reason: error instanceof Error ? error.message : String(error) })
    return false
  }
})
if (!selectedRegion) throw new Error(`物流区域中未找到满足当前规模模板的完整往返航线：${JSON.stringify(regionAttempts)}`)
const region = selectedRegion
const { delivery, routes, deliveryIds: candidateDeliveryPointIds } = selectedRegion.__fixtureRouteSelection
const resourcePackageIds = selectResources(resources, region.packageId).map((resource) => resource.id)
const replayEventCode = process.env.STU012_FIXTURE_REPLAY_EVENT?.trim()
const scaleNumber = Number(scaleTemplateCode.match(/(\d+)$/)?.[1] ?? 3)
const eventConfigs = replayEventCode === "ORDER_PRIORITY_CHANGED"
  ? [
      { code: "ORDER_PRIORITY_CHANGED", visibilityMode: "DIRECT", triggerMode: "AUTO", recoveryMode: "STUDENT" },
      ...(scaleNumber >= 50
        ? [{ code: "WEATHER_CHANGE", visibilityMode: "DIRECT", triggerMode: "AUTO", recoveryMode: "STUDENT" }]
        : [])
    ]
  : scaleNumber >= 20
    ? [
        { code: "WEATHER_CHANGE", visibilityMode: "DIRECT", triggerMode: "AUTO", recoveryMode: "STUDENT" },
        ...(scaleNumber >= 50
          ? [{ code: "ROUTE_SUSPENDED", visibilityMode: "DIRECT", triggerMode: "AUTO", recoveryMode: "STUDENT" }]
          : [])
      ]
    : undefined
const draft = await request("/v3/assignments/drafts", {
  method: "POST",
  cookie: teacher,
  body: {
    title,
    sceneType: "CITY_LOGISTICS",
    mode: "TRAINING",
    isAcceptanceData,
    config: {
      taskBrief: "STU-012 浏览器验收：使用统一机型完成机场起飞、去程、到达确认、返航和机场降落。",
    scaleTemplateCode,
      regionPackageId: region.packageId,
      questionBankVersionId: questionBank.publishedVersionId,
      availableAt: new Date(Date.now() - 60_000).toISOString(),
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      allowResubmission: true,
      allowedValidationAttempts: 3,
      allowedRuntimeAttempts: 2,
      resultVisibility: "FULL_REVIEW",
      scenario: {
      orderCount: Number(scaleTemplateCode.match(/(\d+)$/)?.[1] ?? 20),
      ...(eventConfigs ? { eventConfigs } : {}),
        orderReleaseMode: "BATCH",
        priorityProfile: "STANDARD_HEAVY",
        deliveryDistributionMode: Number(scaleTemplateCode.match(/(\d+)$/)?.[1] ?? 3) >= 20 ? "UNIFORM" : "FOCUSED",
      candidateDeliveryPointIds,
        timeWindowMinutes: 30,
        orderSeed: "stu-012-round-trip-acceptance"
      }
    }
  }
})
const targets = [{ type: "CLASS", targetId: classroom.id }]
const preview = await request(`/v3/assignments/drafts/${draft.id}/preview`, {
  method: "POST",
  cookie: teacher,
  body: { expectedRevision: draft.revision, targets, resourcePackageIds }
})
const preflight = await request(`/v3/assignments/drafts/${draft.id}/preflight`, {
  method: "POST",
  cookie: teacher,
  body: { expectedRevision: draft.revision, targets, resourcePackageIds }
})
const mapCheck = preflight.checks.find((check) => check.code === "MAP_RESOURCE")
if (!mapCheck || mapCheck.level === "BLOCKING") throw new Error(`STU-012 发布前检查未通过：${JSON.stringify(preflight)}`)
await request(`/v3/assignments/drafts/${draft.id}/publish`, {
  method: "POST",
  cookie: teacher,
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
const studentQuestionnaire = await request(`/v3/projects/${project.id}/questionnaire`, { cookie: student })
if (!studentQuestionnaire.available || studentQuestionnaire.actor !== "STUDENT" || !studentQuestionnaire.canSubmit) throw new Error(`STU-012 题库未开放：${JSON.stringify(studentQuestionnaire)}`)
if (studentQuestionnaire.questions.some((question) => Object.prototype.hasOwnProperty.call(question, "correctAnswer") || Object.prototype.hasOwnProperty.call(question, "explanation") || Object.prototype.hasOwnProperty.call(question, "gradingRule"))) {
  throw new Error("STU-012 学生题库响应泄露答案或评分规则")
}
const questionnaireResponses = studentQuestionnaire.questions
  .filter((question) => question.type !== "SIMULATION_EVIDENCE")
  .map((question) => ({ questionCode: question.code, answer: answerForAcceptanceQuestion(question) }))
const submittedQuestionnaire = await request(`/v3/projects/${project.id}/questionnaire/submit`, {
  method: "POST",
  cookie: student,
  body: { expectedRevision: studentQuestionnaire.attempt?.revision ?? 1, responses: questionnaireResponses }
})
if (submittedQuestionnaire.attempt?.status !== "SUBMITTED") throw new Error(`STU-012 题库提交状态异常：${JSON.stringify(submittedQuestionnaire.attempt)}`)
const studentQuestionnaireAfterSubmit = await request(`/v3/projects/${project.id}/questionnaire`, { cookie: student })
if (studentQuestionnaireAfterSubmit.canEdit || studentQuestionnaireAfterSubmit.canSubmit || studentQuestionnaireAfterSubmit.attempt?.status !== "SUBMITTED") throw new Error("STU-012 学生提交后未进入只读状态")
await request(`/v3/projects/${project.id}/stages/LOGISTICS_REGION_ANALYSIS/start`, { method: "POST", cookie: student, body: { expectedRevision: 1 } })
let workspace = await request(`/v3/logistics-projects/${project.id}/route-workspace`, { cookie: student })
workspace = await request(`/v3/logistics-projects/${project.id}/region-analysis`, {
  method: "PUT",
  cookie: student,
  body: { expectedRevision: workspace.regionAnalysis.revision, selectedDeliveryPointIds: candidateDeliveryPointIds, notes: "STU-013 验收：已确认模板要求的配送点与运行节点。" }
})
workspace = await request(`/v3/logistics-projects/${project.id}/region-analysis/confirm`, {
  method: "POST",
  cookie: student,
  body: { expectedRevision: workspace.regionAnalysis.revision, expectedStageRevision: 2 }
})
await request(`/v3/projects/${project.id}/stages/LOGISTICS_ROUTE_PLANNING/start`, { method: "POST", cookie: student, body: { expectedRevision: 2 } })
workspace = await request(`/v3/logistics-projects/${project.id}/route-workspace`, { cookie: student })
workspace = await request(`/v3/logistics-projects/${project.id}/route-plan/draft`, { method: "PUT", cookie: student, body: { expectedRevision: workspace.draft.revision, routes } })
workspace = await request(`/v3/logistics-projects/${project.id}/route-plan/check`, { method: "POST", cookie: student })
if (!workspace.draft.lastCheckResult?.passed) throw new Error(`STU-012 航线检查未通过：${JSON.stringify(workspace.draft.lastCheckResult?.evidence)}`)
await request(`/v3/logistics-projects/${project.id}/route-plan/snapshot`, { method: "POST", cookie: student })
await request(`/v3/logistics-projects/${project.id}/route-plan/complete`, {
  method: "POST",
  cookie: student,
  body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: 3 }
})
await request(`/v3/projects/${project.id}/stages/LOGISTICS_ROUTE_VALIDATION/start`, { method: "POST", cookie: student, body: { expectedRevision: 2 } })
workspace = await request(`/v3/logistics-projects/${project.id}/route-plan/validate`, { method: "POST", cookie: student })

const run = workspace.validationRuns?.[0]
const metric = run?.result?.roundTripMetrics?.[0]
const expectedMilestones = ["AIRPORT_TAKEOFF", "OUTBOUND_FLIGHT", "ARRIVAL_CONFIRMATION", "RETURN_FLIGHT", "AIRPORT_LANDING"]
if (!run || run.result.aircraftModelCode !== workspace.aircraft.modelCode || run.result.aircraftRuleVersion !== workspace.aircraft.ruleVersion) throw new Error("STU-012 未冻结统一机型或规则版本")
if (JSON.stringify(metric?.milestones?.map((item) => item.code)) !== JSON.stringify(expectedMilestones)) throw new Error(`STU-012 五节点不完整：${JSON.stringify(metric?.milestones)}`)
let logisticsStages
const validatedVersion = workspace.versions.find((item) => item.status === "VALIDATED")
if (!validatedVersion) throw new Error("STU-012 未生成可提交的航线验证版本")
logisticsStages = await request(`/v3/projects/${project.id}/stages`, { cookie: student })
const validationStage = logisticsStages.stages.find((item) => item.stageCode === "LOGISTICS_ROUTE_VALIDATION")
if (!validationStage) throw new Error("STU-012 缺少航线验证阶段")
await request(`/v3/logistics-projects/${project.id}/route-plan/versions/${validatedVersion.id}/submit`, {
  method: "POST",
  cookie: student,
  body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: validationStage.revision }
})

logisticsStages = await request(`/v3/projects/${project.id}/stages`, { cookie: student })
const schedulingStage = logisticsStages.stages.find((item) => item.stageCode === "LOGISTICS_ORDER_SCHEDULING")
if (!schedulingStage) throw new Error("STU-012 缺少订单调度阶段")
await request(`/v3/projects/${project.id}/stages/LOGISTICS_ORDER_SCHEDULING/start`, { method: "POST", cookie: student, body: { expectedRevision: schedulingStage.revision } })
let scheduling = await request(`/v3/logistics-projects/${project.id}/scheduling-workspace`, { cookie: student })
const scheduleItems = scheduling.orders.map((order, index) => ({
  id: `stu012-dispatch-${index + 1}`,
  orderId: order.id,
  aircraftId: scheduling.aircraft[index % scheduling.aircraft.length]?.id,
  outboundRouteId: scheduling.routes.find((item) => item.route.direction === "OUTBOUND" && item.route.role === "PRIMARY" && item.route.destinationNodeId === order.destinationNodeId)?.id,
  returnRouteId: scheduling.routes.find((item) => item.route.direction === "RETURN" && item.route.role === "PRIMARY" && item.route.destinationNodeId === order.destinationNodeId)?.id,
  plannedTakeoffTimeMs: Math.max(order.earliestStartTimeMs, index * Math.max(1, takeoffSpacingSeconds) * 1_000)
})).map((item) => ({ ...item, outboundRouteId: item.outboundRouteId, returnRouteId: item.returnRouteId }))
if (scheduleItems.some((item) => !item.outboundRouteId || !item.returnRouteId)) throw new Error("STU-012 缺少订单目的地对应的主航线")
if (scheduleItems.some((item) => !item.aircraftId)) throw new Error("STU-012 缺少可调度无人机")
scheduling = await request(`/v3/logistics-projects/${project.id}/schedule-plan/draft`, { method: "PUT", cookie: student, body: { expectedRevision: scheduling.draft.revision, items: scheduleItems } })
scheduling = await request(`/v3/logistics-projects/${project.id}/schedule-plan/check`, { method: "POST", cookie: student })
if (!scheduling.draft.lastCheckResult?.submittable) throw new Error(`STU-012 调度检查未通过：${JSON.stringify(scheduling.draft.lastCheckResult)}`)
scheduling = await request(`/v3/logistics-projects/${project.id}/schedule-plan/snapshot`, { method: "POST", cookie: student })
const scheduleVersion = scheduling.versions.find((item) => item.sourceDraftRevision === scheduling.draft.revision)
if (!scheduleVersion) throw new Error("STU-012 调度方案快照未生成")
await request(`/v3/logistics-projects/${project.id}/schedule-plan/versions/${scheduleVersion.id}/submit`, {
  method: "POST",
  cookie: student,
  body: { expectedDraftRevision: scheduling.draft.revision, expectedStageRevision: 3 }
})

logisticsStages = await request(`/v3/projects/${project.id}/stages`, { cookie: student })
const readinessStage = logisticsStages.stages.find((item) => item.stageCode === "LOGISTICS_RUNTIME_PREPARATION")
if (!readinessStage) throw new Error("STU-012 缺少运行准备阶段")
await request(`/v3/projects/${project.id}/stages/LOGISTICS_RUNTIME_PREPARATION/start`, { method: "POST", cookie: student, body: { expectedRevision: readinessStage.revision } })
let readiness = await request(`/v3/logistics-projects/${project.id}/runtime-readiness`, { cookie: student })
readiness = await request(`/v3/logistics-projects/${project.id}/runtime-readiness`, {
  method: "PUT",
  cookie: student,
  body: { expectedRevision: readiness.readiness.revision, decision: "PROCEED", decisionBasis: "STU-012 验收：已复核调度、航线、机型和运行环境。" }
})
readiness = await request(`/v3/logistics-projects/${project.id}/runtime-readiness/check`, { method: "POST", cookie: student, body: { expectedRevision: readiness.readiness.revision } })
if (!readiness.canConfirm) throw new Error(`STU-012 运行准备检查未通过：${JSON.stringify(readiness.readiness.checks)}`)
await request(`/v3/logistics-projects/${project.id}/runtime-readiness/confirm`, { method: "POST", cookie: student, body: { expectedRevision: readiness.readiness.revision } })

const runtimeStages = await request(`/v3/projects/${project.id}/stages`, { cookie: student })
const deliveryStage = runtimeStages.stages.find((item) => item.stageCode === "LOGISTICS_DELIVERY_RUNTIME")
if (!deliveryStage) throw new Error("STU-012 缺少物流运行阶段")
await request(`/v3/projects/${project.id}/stages/LOGISTICS_DELIVERY_RUNTIME/start`, { method: "POST", cookie: student, body: { expectedRevision: deliveryStage.revision } })
let runtime = await request(`/v3/logistics-projects/${project.id}/runtime-workspace`, { cookie: student })
runtime = await request(`/v3/logistics-projects/${project.id}/runtime/start`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision } })
if (runtime.session.status !== "RUNNING") {
  runtime = await request(`/v3/logistics-projects/${project.id}/runtime/clock`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, status: "RUNNING", rate: 3_600 } })
}
if (stopAt === "RUNTIME_ACTIVE") {
  runtime = await request(`/v3/logistics-projects/${project.id}/runtime/clock`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, status: "PAUSED", rate: 1 } })
  const result = {
    assignmentId: draft.id,
    projectId: project.id,
    title,
    isAcceptanceData,
    stage: "LOGISTICS_RUNTIME",
    runtimeStatus: runtime.session.status,
    questionBank: { id: questionBank.id, versionId: questionBank.publishedVersionId },
    eventCodes: runtime.events.map((event) => event.code),
    activeAlertCount: runtime.alerts.filter((alert) => alert.status !== "RESOLVED").length
  }
  if (outputPath) {
    const { mkdir, writeFile } = await import("node:fs/promises")
    const { dirname, resolve } = await import("node:path")
    const resolved = resolve(outputPath)
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8")
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(0)
}
for (let attempt = 0; attempt < 80 && runtime.session.status !== "COMPLETED"; attempt += 1) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  runtime = await request(`/v3/logistics-projects/${project.id}/runtime-workspace`, { cookie: student })
}
if (runtime.session.status !== "COMPLETED") throw new Error(`STU-012 仿真未完成：${JSON.stringify(runtime.session)}`)

const afterRuntimeStages = await request(`/v3/projects/${project.id}/stages`, { cookie: student })
const emergencyStage = afterRuntimeStages.stages.find((item) => item.stageCode === "LOGISTICS_EMERGENCY_HANDLING")
if (!emergencyStage) throw new Error("STU-012 缺少应急处置阶段")
await request(`/v3/projects/${project.id}/stages/LOGISTICS_EMERGENCY_HANDLING/start`, { method: "POST", cookie: student, body: { expectedRevision: emergencyStage.revision } })
await request(`/v3/logistics-projects/${project.id}/runtime/emergency-handling/complete`, { method: "POST", cookie: student })
const reviewStages = await request(`/v3/projects/${project.id}/stages`, { cookie: student })
const reviewStage = reviewStages.stages.find((item) => item.stageCode === "LOGISTICS_REVIEW")
if (!reviewStage) throw new Error("STU-012 缺少物流复盘阶段")
await request(`/v3/projects/${project.id}/stages/LOGISTICS_REVIEW/start`, { method: "POST", cookie: student, body: { expectedRevision: reviewStage.revision } })

const teacherQuestionnaire = await request(`/v3/projects/${project.id}/questionnaire`, { cookie: teacher })
if (teacherQuestionnaire.actor !== "TEACHER" || !teacherQuestionnaire.canRegrade || teacherQuestionnaire.questions.some((question) => !Object.prototype.hasOwnProperty.call(question, "correctAnswer"))) {
  throw new Error("STU-012 教师题库复核入口或标准答案缺失")
}
const reviewWorkspace = await request(`/v3/logistics-projects/${project.id}/review`, { cookie: student })
if (!reviewWorkspace.evaluation.objectiveMetrics.some((item) => item.code === "ON_TIME_DELIVERY")) throw new Error(`STU-012 服务端未生成准时率指标：${JSON.stringify(reviewWorkspace.evaluation.objectiveMetrics)}`)
const regradedQuestionnaire = await request(`/v3/projects/${project.id}/questionnaire/regrade`, {
  method: "POST",
  cookie: teacher,
  body: { expectedRevision: teacherQuestionnaire.attempt.revision }
})
if (regradedQuestionnaire.attempt?.status !== "GRADED" || regradedQuestionnaire.responses.some((response) => response.judgment === "PENDING")) throw new Error(`STU-012 仿真证据重判未完成：${JSON.stringify(regradedQuestionnaire)}`)
const reviewedQuestionnaire = await request(`/v3/projects/${project.id}/questionnaire/review`, {
  method: "PUT",
  cookie: teacher,
  body: {
    expectedRevision: regradedQuestionnaire.attempt.revision,
    reviewComment: "STU-012 验收：题库、仿真证据和教师复核闭环通过。",
    responses: regradedQuestionnaire.responses.map((response) => ({ questionCode: response.questionCode, teacherScore: response.autoScore, teacherComment: "验收复核" }))
  }
})
if (reviewedQuestionnaire.attempt?.status !== "REVIEWED") throw new Error("STU-012 教师复核未完成")
const studentQuestionnaireAfterReview = await request(`/v3/projects/${project.id}/questionnaire`, { cookie: student })
if (studentQuestionnaireAfterReview.attempt?.status !== "REVIEWED" || studentQuestionnaireAfterReview.questions.some((question) => Object.prototype.hasOwnProperty.call(question, "correctAnswer"))) throw new Error("STU-012 复核后学生状态或答案脱敏异常")

let review = await request(`/v3/logistics-projects/${project.id}/review`, { cookie: student })
review = await request(`/v3/logistics-projects/${project.id}/review/summary/submit`, {
  method: "POST",
  cookie: student,
  body: {
    expectedRevision: review.evaluation.revision,
    summary: "本次复盘完成配送计划、动态调度和异常处置总结。",
    structuredSummary: {
      originalPlanProblems: "原方案对异常后的订单时序预留不足。",
      responseLessons: "能够识别航线异常并保持在航任务安全，但重排时机仍可提前。",
      routeAdjustmentSuggestions: "为受影响配送点预留同方向且已验证的备用航线。",
      schedulingOptimization: "按订单优先级和无人机下一可用时间滚动调整未执行任务。",
      improvements: "提前设置延误阈值，并在提交重调度前复核航线和硬冲突证据。"
    }
  }
})
if (!review.evaluation.studentSubmittedAt || review.evaluation.status === "PUBLISHED") throw new Error("STU-012 学生复盘总结未提交")

review = await request(`/v3/logistics-projects/${project.id}/review`, { cookie: teacher })
const reviewedScores = review.evaluation.teacherScores.map((item) => ({
  ...item,
  score: item.maxScore,
  comment: "已结合运行数据完成核定"
}))
review = await request(`/v3/logistics-projects/${project.id}/review/evaluation`, {
  method: "PUT",
  cookie: teacher,
  body: {
    expectedRevision: review.evaluation.revision,
    teacherScores: reviewedScores,
    summary: "航线与调度方案满足教学约束，能够根据运行事件完成复盘，建议继续强化延误订单的提前识别。"
  }
})
if (review.evaluation.status !== "REVIEWED" || review.evaluation.totalScore !== 100) throw new Error(`STU-012 教师评价保存异常：${JSON.stringify(review.evaluation)}`)
review = await request(`/v3/logistics-projects/${project.id}/review/evaluation/publish`, {
  method: "POST",
  cookie: teacher,
  body: { expectedRevision: review.evaluation.revision }
})
if (review.evaluation.status !== "PUBLISHED") throw new Error("STU-012 教师评价发布未完成")
review = await request(`/v3/logistics-projects/${project.id}/review/report/generate`, {
  method: "POST",
  cookie: teacher,
  body: { format: "PDF" }
})
if (review.report?.status !== "FINAL" || review.report.format !== "PDF" || !review.report.downloadPath) throw new Error(`STU-012 最终成果文件未生成：${JSON.stringify(review.report)}`)

const result = {
    assignmentId: draft.id,
    projectId: project.id,
    title,
    isAcceptanceData,
    questionBank: { id: questionBank.id, versionId: questionBank.publishedVersionId, submitted: true, regraded: true, reviewed: true },
  review: {
    studentSubmitted: Boolean(review.evaluation.studentSubmittedAt),
    evaluationStatus: review.evaluation.status,
    totalScore: review.evaluation.totalScore,
    report: review.report ? { status: review.report.status, format: review.report.format, filename: review.report.filename, downloadPath: review.report.downloadPath } : null
  },
  deliveryPoint: { id: delivery.id, name: delivery.name },
  stageCode: "LOGISTICS_ROUTE_VALIDATION",
  validation: {
    status: run.status,
    aircraftModelCode: run.result.aircraftModelCode,
    aircraftRuleVersion: run.result.aircraftRuleVersion,
    completedRoundTripCount: run.result.completedRoundTripCount,
    requiredRoundTripCount: run.result.requiredRoundTripCount,
    milestones: metric.milestones,
    evidence: run.result.evidence
  }
}
if (outputPath) {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const { dirname, resolve } = await import("node:path")
  const resolved = resolve(outputPath)
  await mkdir(dirname(resolved), { recursive: true })
  await writeFile(resolved, `${JSON.stringify(result, null, 2)}\n`, "utf8")
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

function findPassingRoutes(regionValue) {
  const deliveries = (regionValue.logisticsNodes ?? []).filter((node) => node.type === "DELIVERY_POINT" && node.enabled && node.position).sort((left, right) => distance(left.position, regionValue.center) - distance(right.position, regionValue.center))
  const longitudeSpan = Math.max(...regionValue.boundary.map((point) => point.longitude)) - Math.min(...regionValue.boundary.map((point) => point.longitude))
  const latitudeSpan = Math.max(...regionValue.boundary.map((point) => point.latitude)) - Math.min(...regionValue.boundary.map((point) => point.latitude))
  const scale = Number(scaleTemplateCode.match(/(\d+)$/)?.[1] ?? 3)
  const requiredDeliveryCount = scale >= 50 ? 8 : scale >= 20 ? 6 : 1
  const selectedDeliveries = []
  const routePairs = []
  for (const delivery of deliveries) {
    if (selectedDeliveries.length >= requiredDeliveryCount) break
    let found = false
    for (const lane of [-0.18, 0.18, -0.3, 0.3]) {
      const routes = fixtureRoutes(regionValue, delivery, longitudeSpan, latitudeSpan, lane)
      if (checkLogisticsRoutePlan(routes, { region: regionValue, selectedDeliveryPointIds: [delivery.id], aircraft }).passed) {
        selectedDeliveries.push(delivery)
        routePairs.push(routes)
        found = true
        break
      }
    }
    if (!found) continue
  }
  if (routePairs.length < requiredDeliveryCount) throw new Error("物流区域中未找到满足模板数量的完整往返航线")
  return { delivery: selectedDeliveries[0], routes: routePairs.flat(), deliveryIds: selectedDeliveries.map((item) => item.id) }
}

function fixtureRoutes(regionValue, delivery, longitudeSpan, latitudeSpan, lane) {
  const takeoff = node(regionValue, "TAKEOFF_POINT")
  const landing = node(regionValue, "LANDING_POINT")
  const waiting = node(regionValue, "WAITING_POINT")
  const alternate = node(regionValue, "ALTERNATE_LANDING_POINT")
  const emergency = node(regionValue, "EMERGENCY_AREA")
  const laneLatitude = regionValue.center.latitude + latitudeSpan * lane
  const outboundId = `stu012-outbound-${delivery.id}`
  const returnId = `stu012-return-${delivery.id}`
  const outboundAltitude = Number.isFinite(segmentRiskAltitude) && segmentRiskAltitude > 0 ? segmentRiskAltitude : 45
  return [
    route(outboundId, delivery, "OUTBOUND", takeoff.id, delivery.id, [
      waypoint(`${outboundId}-1`, takeoff.position, 0, true, takeoff.id),
      waypoint(`${outboundId}-2`, { longitude: regionValue.center.longitude - longitudeSpan * 0.08, latitude: laneLatitude }, outboundAltitude),
      waypoint(`${outboundId}-3`, { longitude: delivery.position.longitude - longitudeSpan * 0.05, latitude: laneLatitude }, 50),
      waypoint(`${outboundId}-4`, delivery.position, 0, true, delivery.id)
    ], waiting.id, alternate.id, emergency.id),
    route(returnId, delivery, "RETURN", delivery.id, landing.id, [
      waypoint(`${returnId}-1`, delivery.position, 0, true, delivery.id),
      waypoint(`${returnId}-2`, { longitude: delivery.position.longitude + longitudeSpan * 0.05, latitude: laneLatitude + latitudeSpan * 0.035 }, 50),
      waypoint(`${returnId}-3`, { longitude: regionValue.center.longitude + longitudeSpan * 0.08, latitude: laneLatitude + latitudeSpan * 0.035 }, 45),
      waypoint(`${returnId}-4`, landing.position, 0, true, landing.id)
    ], waiting.id, alternate.id, emergency.id)
  ]
}

function route(id, delivery, direction, departureNodeId, arrivalNodeId, waypoints, waitingNodeId, alternateNodeId, emergencyNodeId) {
  return { id, name: `${delivery.name}-${direction}`, destinationNodeId: delivery.id, direction, role: "PRIMARY", groupCode: "STU-012", departureNodeId, arrivalNodeId, protectionRadiusMeters: 30, waitingNodeIds: [waitingNodeId], alternateLandingNodeIds: [alternateNodeId], emergencyAreaNodeIds: [emergencyNodeId], entryDirectionDegrees: 90, exitDirectionDegrees: 270, waypoints }
}

function waypoint(id, position, altitudeMeters, locked = false, nodeId = null) {
  return { id, name: id, position: { ...position }, altitudeMeters, segmentAltitudeMeters: altitudeMeters === 0 ? 45 : altitudeMeters, speedMps: 12, nodeId, locked }
}

function node(regionValue, type) {
  const value = regionValue.logisticsNodes?.find((item) => item.type === type && item.enabled)
  if (!value || (["TAKEOFF_POINT", "LANDING_POINT"].includes(type) && !value.position)) throw new Error(`区域缺少可用节点：${type}`)
  return value
}

function selectResources(allResources, regionPackageId) {
  const candidates = allResources.filter((resource) => {
    if (resource.status !== "ACTIVE" || resource.manifest?.testOnly === true) return false
    if (resource.packageType === "REGION") return resource.id === regionPackageId
    if (resource.packageType === "DOCUMENT_TEMPLATE") return false
    if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") return resource.manifest?.sceneType === "CITY_LOGISTICS"
    if (resource.packageType === "REPORT") return resource.manifest?.rubrics?.some((rubric) => rubric?.sceneType === "CITY_LOGISTICS")
    return true
  }).sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))
  const expectedTypes = ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"]
  const selected = expectedTypes.map((type) => candidates.find((resource) => resource.packageType === type))
  const missing = expectedTypes.filter((_, index) => !selected[index])
  if (missing.length > 0) throw new Error(`缺少 STU-012 夹具资源：${missing.join(",")}`)
  return selected
}

async function waitForProject() {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const progress = await request("/v3/teaching/progress?sceneType=CITY_LOGISTICS&includeInternalData=true", { cookie: teacher })
    const project = progress.find((item) => item.assignmentTitle === title && item.sceneType === "CITY_LOGISTICS" && item.isAcceptanceData === isAcceptanceData && item.studentId === targetStudent.id)
    if (project?.projectId) return { id: project.projectId, title: project.assignmentTitle, sceneType: project.sceneType }
    await delay(150)
  }
  throw new Error("发布后未找到 STU-012 学生物流项目")
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

function distance(left, right) { return Math.hypot((left.longitude - right.longitude) * 102_000, (left.latitude - right.latitude) * 111_000) }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }

function answerForAcceptanceQuestion(question) {
  if (question.type === "SINGLE_CHOICE" || question.type === "TRUE_FALSE") return question.options?.[0]?.key ?? true
  if (question.type === "MULTIPLE_CHOICE") return question.options?.[0]?.key ? [question.options[0].key] : []
  const fields = question.answerFields ?? []
  return Object.fromEntries(fields.map((field) => [field, `STU-012 验收 ${field}`]))
}
