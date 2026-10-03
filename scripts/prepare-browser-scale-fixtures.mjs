import { randomUUID } from "node:crypto"
import { checkLogisticsRoutePlan } from "@wurenji/simulation"

const apiBase = (process.env.APP_BASE_URL ?? "http://localhost:3000/api").replace(/\/$/, "")
const origin = process.env.WEB_ORIGIN?.split(",")[0]?.trim() || apiBase.replace(/\/api$/, "")
const fixturePrefix = process.env.RUNTIME_FIXTURE_PREFIX ?? "R7-BROWSER-SCALE"
const isAcceptanceData = process.env.RUNTIME_FIXTURE_IS_ACCEPTANCE_DATA !== "false"
const publishOnly = process.env.RUNTIME_FIXTURE_PUBLISH_ONLY === "true"
const fixtureClockRate = positiveNumber(process.env.RUNTIME_FIXTURE_CLOCK_RATE)
const fixtureDurationSeconds = positiveNumber(process.env.RUNTIME_FIXTURE_DURATION_SECONDS, 600)
const cleanupExisting = process.env.CLEANUP_EXISTING === "true"
const logisticsStopAtScheduling = process.env.RUNTIME_FIXTURE_LOGISTICS_STOP_AT_SCHEDULING === "true"
const skipShow = process.env.RUNTIME_FIXTURE_SKIP_SHOW === "true"
const skipLogistics = process.env.RUNTIME_FIXTURE_SKIP_LOGISTICS === "true"
const showStopAtRuntime = process.env.RUNTIME_FIXTURE_SHOW_STOP_AT === "RUNTIME_ACTIVE"
const showTitle = process.env.RUNTIME_FIXTURE_SHOW_TITLE?.trim() || `${fixturePrefix}-CITY-SHOW-${timestamp()}`
const logisticsTitle = process.env.RUNTIME_FIXTURE_LOGISTICS_TITLE?.trim() || `${fixturePrefix}-CITY-LOGISTICS-${timestamp()}`

const admin = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
const teacher = await login(process.env.RUNTIME_TEACHER_EMAIL ?? "teacher@demo.local", process.env.RUNTIME_TEACHER_PASSWORD ?? process.env.DEMO_TEACHER_PASSWORD ?? "")
const student = await login(process.env.RUNTIME_STUDENT_EMAIL ?? "student@demo.local", process.env.RUNTIME_STUDENT_PASSWORD ?? process.env.DEMO_STUDENT_PASSWORD ?? "")

if (cleanupExisting) await archiveExistingFixtures(teacher)

const resources = await request("/v3/resource-packages", { cookie: admin })
const questionBanks = await request("/v1/education/question-banks", { cookie: teacher })
const classes = await request("/v1/education/classes", { cookie: teacher })
const classroom = classes[0]
if (!classroom?.id) throw new Error("没有找到可发布的教学班级")

const showRegions = await request("/v3/resource-packages/regions/catalog?sceneType=CITY_SHOW", { cookie: admin })
const logisticsRegions = await request("/v3/resource-packages/regions/catalog?sceneType=CITY_LOGISTICS", { cookie: admin })
const showRegion = showRegions.find((candidate) => !process.env.RUNTIME_FIXTURE_SHOW_REGION_CODE || candidate.regionCode === process.env.RUNTIME_FIXTURE_SHOW_REGION_CODE.trim()) ?? showRegions[0]
const logisticsRegion = logisticsRegions.find((candidate) => !process.env.RUNTIME_FIXTURE_LOGISTICS_REGION_CODE || candidate.regionCode === process.env.RUNTIME_FIXTURE_LOGISTICS_REGION_CODE.trim()) ?? logisticsRegions[0]
if (!showRegion?.packageId || !logisticsRegion?.packageId) throw new Error("没有找到表演或物流预设区域")

const showQuestionBank = questionBanks.find((bank) => bank.sceneType === "CITY_SHOW" && bank.publishedVersionId)
if (!skipShow && !showQuestionBank?.publishedVersionId) throw new Error("没有找到已发布城市表演题库")
const showProject = skipShow ? null : await prepareShow({ resources, classroom, region: showRegion, questionBankVersionId: showQuestionBank.publishedVersionId })
const logisticsProject = skipLogistics ? null : await prepareLogistics({ resources, classroom, region: logisticsRegion })

const result = {
  format: "wurenji-browser-scale-fixtures",
  formatVersion: 1,
  generatedAt: new Date().toISOString(),
  apiBase,
  cleanupExisting,
  logisticsStopAtScheduling,
  skipShow,
  skipLogistics,
  projects: {
    CITY_SHOW: showProject,
    CITY_LOGISTICS: logisticsProject
  },
  commands: {
    show: showProject ? `RUNTIME_SCENE=CITY_SHOW RUNTIME_PROJECT_ID=${showProject.projectId} npm.cmd run performance:browser-runtime` : null,
    logistics: logisticsProject ? `RUNTIME_SCENE=CITY_LOGISTICS RUNTIME_PROJECT_ID=${logisticsProject.projectId} npm.cmd run performance:browser-runtime` : null,
    all: `RUNTIME_PROJECT_ID= npm.cmd run performance:browser-runtime`
  },
  cleanup: `CLEANUP_EXISTING=true npm.cmd run performance:browser:fixtures`
}
if (process.env.RUNTIME_LOGISTICS_FIXTURE_OUTPUT?.trim() && logisticsProject) {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const { dirname, resolve } = await import("node:path")
  const outputPath = resolve(process.env.RUNTIME_LOGISTICS_FIXTURE_OUTPUT)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(logisticsProject, null, 2)}\n`, "utf8")
}
if (process.env.RUNTIME_FIXTURE_OUTPUT?.trim()) {
  const { mkdir, writeFile } = await import("node:fs/promises")
  const { dirname, resolve } = await import("node:path")
  const outputPath = resolve(process.env.RUNTIME_FIXTURE_OUTPUT)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8")
}
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

async function prepareShow({ resources: allResources, classroom: targetClass, region, questionBankVersionId }) {
  const selectedResources = selectResources(allResources, "CITY_SHOW", region.packageId, true)
  const draft = await request("/v3/assignments/drafts", {
    method: "POST",
    cookie: teacher,
    body: {
      title: showTitle,
      sceneType: "CITY_SHOW",
      mode: "TRAINING",
      isAcceptanceData,
      config: {
        questionBankVersionId,
        taskBrief: "V1.0 浏览器正式规模验收：完成表演运行前置流程并进入 3000 架运行阶段",
        showParameters: {
          projectBackground: "R7 浏览器正式规模表演验收",
          completionRequirements: "完成区域规划、三份申报材料、飞前检查、T-60 报备并进入运行",
          plannedStartAt: new Date(Date.now() + 3_600_000).toISOString(),
          plannedEndAt: new Date(Date.now() + 5_400_000).toISOString(),
          plannedAudienceCount: 3000,
          maximumHeightMeters: 120,
          contactName: "R7 验收联系人",
          contactPhone: "13800000000",
          aircraftModel: "R7-SCALE-TEST"
        },
        scaleTemplateCode: "SHOW_3000",
        regionPackageId: region.packageId,
        availableAt: new Date(Date.now() - 60_000).toISOString(),
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        allowResubmission: true,
        allowedValidationAttempts: 3,
        allowedRuntimeAttempts: 2,
        resultVisibility: "FULL_REVIEW",
        scenario: {
          simulationClockRate: 600,
          simulationStartLeadMinutes: 61,
          showRuntimeClockRate: fixtureClockRate ?? 1000,
          showRuntimeDurationSeconds: fixtureDurationSeconds,
          eventCodes: ["BATTERY_ANOMALY", "POSITIONING_DRIFT", "COMMUNICATION_LOSS"]
        }
      }
    }
  })
  const resourcePackageIds = selectedResources.map((item) => item.id)
  const targets = [{ type: "CLASS", targetId: targetClass.id }]
  const preview = await request(`/v3/assignments/drafts/${draft.id}/preview`, {
    method: "POST",
    cookie: teacher,
    body: { expectedRevision: draft.revision, targets, resourcePackageIds }
  })
  const assignmentPreflight = await request(`/v3/assignments/drafts/${draft.id}/preflight`, {
    method: "POST",
    cookie: teacher,
    body: { expectedRevision: draft.revision, targets, resourcePackageIds }
  })
  const preflightWarnings = assignmentPreflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code)
  await request(`/v3/assignments/drafts/${draft.id}/publish`, {
    method: "POST",
    cookie: teacher,
    body: {
      expectedRevision: draft.revision,
      configHash: preview.configHash,
      targets,
      resourcePackageIds,
      ...(preflightWarnings.length > 0 ? {
        preflightConfirmation: { checkedAt: assignmentPreflight.checkedAt, checkCodes: preflightWarnings }
      } : {})
    }
  })
  if (publishOnly) return { assignmentId: draft.id, title: showTitle, regionCode: region.regionCode, isAcceptanceData, stage: "PUBLISHED" }
  const project = await findProject(showTitle, "CITY_SHOW")
  const projectId = project.id
  await request(`/v3/projects/${projectId}/stages/SHOW_AREA_PLANNING/start`, { method: "POST", cookie: student, body: { expectedRevision: 1 } })
  const features = completeAreaFeatures(region.boundary, "show-scale")
  await request(`/v3/show-projects/${projectId}/area-plan/draft`, {
    method: "PUT",
    cookie: student,
    body: { expectedRevision: 0, features, annotations: [{ id: "scale-annotation", label: "应急通道入口", position: region.center, heightMeters: 18.4 }] }
  })
  const areaCheck = await request(`/v3/show-projects/${projectId}/area-plan/check`, { method: "POST", cookie: student })
  if (!areaCheck.passed) throw new Error(`表演区域检查未通过：${JSON.stringify(areaCheck.evidence)}`)
  const areaSubmission = await request(`/v3/show-projects/${projectId}/area-plan/submit`, {
    method: "POST",
    cookie: student,
    body: { expectedDraftRevision: 1, expectedStageRevision: 2 }
  })
  const submittedArea = areaSubmission.workspace.versions.find((item) => item.status === "SUBMITTED")
  if (!submittedArea) throw new Error("表演区域没有生成待审核版本")
  await request(`/v3/show-projects/${projectId}/area-plan/versions/${submittedArea.id}/accept`, {
    method: "POST",
    cookie: teacher,
    body: { comment: "R7 正式规模浏览器验收区域通过", score: 100 }
  })
  let stages = await request(`/v3/projects/${projectId}/stages`, { cookie: student })
  let applicationStage = stage(stages, "SHOW_FLIGHT_APPLICATION")
  await request(`/v3/projects/${projectId}/stages/SHOW_FLIGHT_APPLICATION/start`, { method: "POST", cookie: student, body: { expectedRevision: applicationStage.revision } })
  let documents = await request(`/v3/show-projects/${projectId}/documents`, { cookie: student })
  for (const document of documents.documents) {
    documents = await request(`/v3/show-projects/${projectId}/documents/${document.id}/submit`, {
      method: "POST",
      cookie: student,
      body: { expectedRevision: documents.documents.find((item) => item.id === document.id).revision }
    })
  }
  if (!documents.allRequiredSubmitted) throw new Error("表演三份申报材料未全部提交")
  stages = await request(`/v3/projects/${projectId}/stages`, { cookie: student })
  const preflightStage = stage(stages, "SHOW_PREFLIGHT")
  await request(`/v3/projects/${projectId}/stages/SHOW_PREFLIGHT/start`, { method: "POST", cookie: student, body: { expectedRevision: preflightStage.revision } })
  let preflight = await request(`/v3/show-projects/${projectId}/preflight`, { cookie: student })
  preflight = await request(`/v3/show-projects/${projectId}/preflight`, {
    method: "PUT",
    cookie: student,
    body: {
      expectedRevision: preflight.revision,
      responses: preflight.items.map((item) => ({ code: item.code, confirmed: true, resolution: "CONFIRMED", resolved: true, note: "R7 规模验收已确认" })),
      decision: "ALLOW",
      rationale: "R7 浏览器正式规模验收前置检查全部通过"
    }
  })
  await request(`/v3/show-projects/${projectId}/preflight/complete`, { method: "POST", cookie: student, body: { expectedRevision: preflight.revision } })
  stages = await request(`/v3/projects/${projectId}/stages`, { cookie: student })
  const t60Stage = stage(stages, "SHOW_T_MINUS_60")
  await request(`/v3/projects/${projectId}/stages/SHOW_T_MINUS_60/start`, { method: "POST", cookie: student, body: { expectedRevision: t60Stage.revision } })
  const t60 = await waitForJson(`/v3/show-projects/${projectId}/t60-report`, (value) => value.status === "READY", 4_000)
  await request(`/v3/show-projects/${projectId}/t60-report/submit`, { method: "POST", cookie: student, body: { expectedRevision: t60.revision } })
  stages = await request(`/v3/projects/${projectId}/stages`, { cookie: student })
  const runtimeStage = stage(stages, "SHOW_RUNTIME")
  await request(`/v3/projects/${projectId}/stages/SHOW_RUNTIME/start`, { method: "POST", cookie: student, body: { expectedRevision: runtimeStage.revision } })
  let runtime = await request(`/v3/show-projects/${projectId}/runtime`, { cookie: student })
  runtime = await request(`/v3/show-projects/${projectId}/runtime/start`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision } })
  if (runtime.session.status !== "RUNNING" || runtime.totals.plannedCount !== 3000) throw new Error(`表演正式规模运行未启动：${JSON.stringify(runtime.session)}`)
  if (showStopAtRuntime) {
    runtime = await request(`/v3/show-projects/${projectId}/runtime/clock-rate`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision, rate: fixtureClockRate ?? 1, status: "PAUSED" } })
    return { assignmentId: draft.id, projectId, title: showTitle, isAcceptanceData, stage: "SHOW_RUNTIME", runtimeStatus: runtime.session.status, eventCodes: runtime.events.map((event) => event.code), scale: runtime.totals.plannedCount, groups: runtime.groups.length, documents: documents.documents.length }
  }
  return { assignmentId: draft.id, projectId, title: showTitle, scale: runtime.totals.plannedCount, groups: runtime.groups.length, documents: documents.documents.length }
}

async function prepareLogistics({ resources: allResources, classroom: targetClass, region }) {
  const selectedResources = selectResources(allResources, "CITY_LOGISTICS", region.packageId, false)
  const deliveryCandidates = (region.logisticsNodes ?? [])
    .filter((item) => item.type === "DELIVERY_POINT" && item.enabled && item.position)
    .sort((left, right) => distance(left.position, region.center) - distance(right.position, region.center))
  const { deliveryNodes, routes } = findPassingRoutes(region, deliveryCandidates)
  const draft = await request("/v3/assignments/drafts", {
    method: "POST",
    cookie: teacher,
    body: {
      title: logisticsTitle,
      sceneType: "CITY_LOGISTICS",
      mode: "TRAINING",
      isAcceptanceData,
      config: {
        taskBrief: "R7 浏览器正式规模验收：完成物流区域、航线、订单调度和运行准备",
        scaleTemplateCode: "LOGISTICS_50",
        regionPackageId: region.packageId,
        availableAt: new Date(Date.now() - 60_000).toISOString(),
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        allowResubmission: true,
        allowedValidationAttempts: 3,
        allowedRuntimeAttempts: 2,
        resultVisibility: "FULL_REVIEW",
        scenario: {
          orderCount: 100,
          orderReleaseMode: "BATCH",
          priorityProfile: "BALANCED",
          timeWindowMinutes: 120,
          logisticsRuntimeClockRate: fixtureClockRate ?? 60,
          eventCodes: ["WEATHER_CHANGE", "ROUTE_SUSPENDED"]
        }
      }
    }
  })
  const resourcePackageIds = selectedResources.map((item) => item.id)
  const targets = [{ type: "CLASS", targetId: targetClass.id }]
  const preview = await request(`/v3/assignments/drafts/${draft.id}/preview`, { method: "POST", cookie: teacher, body: { expectedRevision: draft.revision, targets, resourcePackageIds } })
  const preflight = await request(`/v3/assignments/drafts/${draft.id}/preflight`, { method: "POST", cookie: teacher, body: { expectedRevision: draft.revision, targets, resourcePackageIds } })
  const preflightWarnings = preflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code)
  await request(`/v3/assignments/drafts/${draft.id}/publish`, {
    method: "POST",
    cookie: teacher,
    body: {
      expectedRevision: draft.revision,
      configHash: preview.configHash,
      targets,
      resourcePackageIds,
      ...(preflightWarnings.length > 0 ? {
        preflightConfirmation: { checkedAt: preflight.checkedAt, checkCodes: preflightWarnings }
      } : {})
    }
  })
  if (publishOnly) return { assignmentId: draft.id, title: logisticsTitle, regionCode: region.regionCode, isAcceptanceData, stage: "PUBLISHED" }
  const project = await findProject(logisticsTitle, "CITY_LOGISTICS")
  const projectId = project.id
  await request(`/v3/projects/${projectId}/stages/LOGISTICS_REGION_ANALYSIS/start`, { method: "POST", cookie: student, body: { expectedRevision: 1 } })
  let workspace = await request(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: student })
  workspace = await request(`/v3/logistics-projects/${projectId}/region-analysis`, { method: "PUT", cookie: student, body: { expectedRevision: workspace.regionAnalysis.revision, selectedDeliveryPointIds: deliveryNodes.map((item) => item.id), notes: "R7 正式规模验收选择 8 个配送点，已核查限制区、建筑、通信覆盖、等待点、备降点和应急区域。" } })
  workspace = await request(`/v3/logistics-projects/${projectId}/region-analysis/confirm`, { method: "POST", cookie: student, body: { expectedRevision: workspace.regionAnalysis.revision, expectedStageRevision: 2 } })
  await request(`/v3/projects/${projectId}/stages/LOGISTICS_ROUTE_PLANNING/start`, { method: "POST", cookie: student, body: { expectedRevision: 2 } })
  workspace = await request(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: student })
  workspace = await request(`/v3/logistics-projects/${projectId}/route-plan/draft`, { method: "PUT", cookie: student, body: { expectedRevision: workspace.draft.revision, routes } })
  workspace = await request(`/v3/logistics-projects/${projectId}/route-plan/check`, { method: "POST", cookie: student })
  if (!workspace.draft.lastCheckResult?.passed) throw new Error(`物流正式规模航线检查未通过：${JSON.stringify(workspace.draft.lastCheckResult?.evidence)}`)
  await request(`/v3/logistics-projects/${projectId}/route-plan/snapshot`, { method: "POST", cookie: student })
  await request(`/v3/logistics-projects/${projectId}/route-plan/complete`, { method: "POST", cookie: student, body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: 3 } })
  await request(`/v3/projects/${projectId}/stages/LOGISTICS_ROUTE_VALIDATION/start`, { method: "POST", cookie: student, body: { expectedRevision: 2 } })
  workspace = await request(`/v3/logistics-projects/${projectId}/route-plan/validate`, { method: "POST", cookie: student })
  const validatedVersion = workspace.versions.find((item) => item.status === "VALIDATED")
  if (!validatedVersion || workspace.validationRuns[0]?.result.completedRoundTripCount !== deliveryNodes.length) throw new Error(`物流完整往返验证未通过：${JSON.stringify(workspace.validationRuns[0])}`)
  workspace = await request(`/v3/logistics-projects/${projectId}/route-plan/versions/${validatedVersion.id}/submit`, { method: "POST", cookie: student, body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: 3 } })
  await request(`/v3/projects/${projectId}/stages/LOGISTICS_ORDER_SCHEDULING/start`, { method: "POST", cookie: student, body: { expectedRevision: 2 } })
  let scheduling = await request(`/v3/logistics-projects/${projectId}/scheduling-workspace`, { cookie: student })
  const scheduleItems = buildScheduleItems(scheduling)
  scheduling = await request(`/v3/logistics-projects/${projectId}/schedule-plan/draft`, { method: "PUT", cookie: student, body: { expectedRevision: scheduling.draft.revision, items: scheduleItems } })
  scheduling = await request(`/v3/logistics-projects/${projectId}/schedule-plan/check`, { method: "POST", cookie: student })
  if (!scheduling.draft.lastCheckResult?.submittable) throw new Error(`物流正式规模调度未通过：${JSON.stringify(scheduling.draft.lastCheckResult?.evidence)}`)
  if (logisticsStopAtScheduling) {
    return {
      assignmentId: draft.id,
      projectId,
      stageCode: "LOGISTICS_ORDER_SCHEDULING",
      scale: scheduling.aircraft.length,
      orders: scheduling.orders.length,
      routes: routes.length,
      deliveryPoints: deliveryNodes.length
    }
  }
  await request(`/v3/logistics-projects/${projectId}/schedule-plan/snapshot`, { method: "POST", cookie: student })
  scheduling = await request(`/v3/logistics-projects/${projectId}/scheduling-workspace`, { cookie: student })
  const scheduleVersion = scheduling.versions.find((item) => item.sourceDraftRevision === scheduling.draft.revision && item.status === "SNAPSHOT")
  if (!scheduleVersion) throw new Error("物流正式规模调度没有生成快照")
  await request(`/v3/logistics-projects/${projectId}/schedule-plan/versions/${scheduleVersion.id}/submit`, { method: "POST", cookie: student, body: { expectedDraftRevision: scheduling.draft.revision, expectedStageRevision: 3 } })
  await request(`/v3/projects/${projectId}/stages/LOGISTICS_RUNTIME_PREPARATION/start`, { method: "POST", cookie: student, body: { expectedRevision: 2 } })
  let readiness = await request(`/v3/logistics-projects/${projectId}/runtime-readiness`, { cookie: student })
  readiness = await request(`/v3/logistics-projects/${projectId}/runtime-readiness`, { method: "PUT", cookie: student, body: { expectedRevision: readiness.readiness.revision, decision: "PROCEED", decisionBasis: "R7 正式规模验收已复核运行资源、环境状态、50 架无人机和 100 单初始调度。" } })
  readiness = await request(`/v3/logistics-projects/${projectId}/runtime-readiness/check`, { method: "POST", cookie: student, body: { expectedRevision: readiness.readiness.revision } })
  if (!readiness.canConfirm) throw new Error(`物流运行准备检查未通过：${JSON.stringify(readiness.readiness.checks)}`)
  readiness = await request(`/v3/logistics-projects/${projectId}/runtime-readiness/confirm`, { method: "POST", cookie: student, body: { expectedRevision: readiness.readiness.revision } })
  const stages = await request(`/v3/projects/${projectId}/stages`, { cookie: student })
  const runtimeStage = stage(stages, "LOGISTICS_DELIVERY_RUNTIME")
  await request(`/v3/projects/${projectId}/stages/LOGISTICS_DELIVERY_RUNTIME/start`, { method: "POST", cookie: student, body: { expectedRevision: runtimeStage.revision } })
  let runtime = await request(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: student })
  runtime = await request(`/v3/logistics-projects/${projectId}/runtime/start`, { method: "POST", cookie: student, body: { expectedRevision: runtime.session.revision } })
  if (runtime.session.status !== "RUNNING" || runtime.summary.totalAircraft !== 50 || runtime.summary.totalOrders !== 100) throw new Error(`物流正式规模运行未启动：${JSON.stringify(runtime.summary)}`)
  return {
    assignmentId: draft.id,
    projectId,
    title: logisticsTitle,
    isAcceptanceData,
    stage: "LOGISTICS_RUNTIME",
    runtimeStatus: runtime.session.status,
    eventCodes: runtime.events.map((event) => event.code),
    scale: runtime.summary.totalAircraft,
    orders: runtime.summary.totalOrders,
    routes: routes.length,
    deliveryPoints: deliveryNodes.length
  }
}

function selectResources(allResources, sceneType, regionPackageId, includeDocuments) {
  const selected = allResources.filter((resource) => {
    if (resource.status !== "ACTIVE" || resource.manifest?.testOnly === true) return false
    if (resource.packageType === "REGION") return resource.id === regionPackageId
    if (resource.packageType === "DOCUMENT_TEMPLATE") return includeDocuments && resource.manifest?.sceneType === sceneType
    if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") return resource.manifest?.sceneType === sceneType
    return true
  })
  const expected = includeDocuments ? ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "DOCUMENT_TEMPLATE", "REPORT"] : ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"]
  const byType = new Map(selected.map((resource) => [resource.packageType, resource]))
  const missing = expected.filter((type) => !byType.has(type))
  if (missing.length > 0) throw new Error(`缺少正式规模所需资源：${missing.join(",")}`)
  return expected.map((type) => byType.get(type))
}

function completeAreaFeatures(boundary, prefix) {
  const types = ["TAKEOFF_LANDING", "FLIGHT", "PERFORMANCE", "BUFFER", "GROUND_ISOLATION", "AUDIENCE", "OPERATION", "EMERGENCY_LANDING", "GEOFENCE"]
  const longitudes = boundary.map((point) => point.longitude)
  const latitudes = boundary.map((point) => point.latitude)
  const minimumLongitude = Math.min(...longitudes)
  const maximumLongitude = Math.max(...longitudes)
  const minimumLatitude = Math.min(...latitudes)
  const maximumLatitude = Math.max(...latitudes)
  const longitudeSpan = maximumLongitude - minimumLongitude
  const latitudeSpan = maximumLatitude - minimumLatitude
  const longitudeSize = longitudeSpan * 0.08
  const latitudeSize = latitudeSpan * 0.08
  return types.map((type, index) => {
    const longitude = minimumLongitude + longitudeSpan * (0.16 + (index % 3) * 0.3)
    const latitude = minimumLatitude + latitudeSpan * (0.16 + Math.floor(index / 3) * 0.3)
    return {
      id: `${prefix}-feature-${index}`,
      type,
      label: type,
      positions: rectangle(longitude, latitude, longitudeSize, latitudeSize),
      ...(["FLIGHT", "PERFORMANCE", "GEOFENCE"].includes(type) ? { heightRange: { datum: "AGL", minimumMeters: 20, maximumMeters: 120 } } : {}),
      properties: areaProperties(type)
    }
  })
}

function areaProperties(type) {
  if (type === "TAKEOFF_LANDING") return { capacity: 3000, orientationDegrees: 0 }
  if (type === "PERFORMANCE") return { orientationDegrees: 0 }
  if (type === "BUFFER") return { referenceWidthMeters: 30 }
  if (type === "GROUND_ISOLATION" || type === "OPERATION") return { purpose: "R7-scale" }
  if (type === "AUDIENCE") return { orientationDegrees: 0, capacityLevel: "大型" }
  if (type === "EMERGENCY_LANDING") return { availability: "全程可用", capacityLevel: "多组" }
  if (type === "GEOFENCE") return { policy: "越界告警" }
  return {}
}

function findPassingRoutes(region, deliveries) {
  const longitudeSpan = Math.max(...region.boundary.map((point) => point.longitude)) - Math.min(...region.boundary.map((point) => point.longitude))
  const latitudeSpan = Math.max(...region.boundary.map((point) => point.latitude)) - Math.min(...region.boundary.map((point) => point.latitude))
  const aircraft = { modelCode: "TEACHING-UAV-01", cruiseSpeedMps: 12, maximumSpeedMps: 18, maximumHeightMeters: 120, maximumRoundTripMeters: 12_000, minimumReserveBatteryPercent: 20, climbRateMps: 3, ruleVersion: "LOGISTICS-ROUTE-1.0.0" }
  const selectedDeliveries = []
  const chosen = []
  const failures = []
  for (const delivery of deliveries) {
    if (selectedDeliveries.length >= 8) break
    let selected = null
    for (const lane of [-0.45, 0.45, -0.35, 0.35, -0.25, 0.25, -0.15, 0.15, 0]) {
      const candidate = fixtureRoutes(region, delivery, longitudeSpan, latitudeSpan, lane)
      const trial = [...chosen.flat(), ...candidate]
      const check = checkLogisticsRoutePlan(trial, { region, selectedDeliveryPointIds: [...selectedDeliveries, delivery].map((item) => item.id), aircraft })
      if (check.passed) {
        selected = { delivery, routes: candidate }
        break
      }
      failures.push({ delivery: delivery.name, lane, evidence: check.evidence.map((item) => item.code) })
    }
    if (!selected) continue
    selectedDeliveries.push(selected.delivery)
    chosen.push(selected.routes)
  }
  if (selectedDeliveries.length < 8) throw new Error(`只能找到 ${selectedDeliveries.length} 个可用配送点，无法满足 LOGISTICS_50 的 8 个配送点要求：${JSON.stringify(failures)}`)
  const routes = chosen.flat()
  const result = checkLogisticsRoutePlan(routes, { region, selectedDeliveryPointIds: selectedDeliveries.map((item) => item.id), aircraft })
  if (!result.passed) throw new Error(`正式规模组合航线检查失败：${JSON.stringify(result.evidence)}`)
  return { deliveryNodes: selectedDeliveries, routes }
}

function fixtureRoutes(region, delivery, longitudeSpan, latitudeSpan, lane) {
  const takeoff = node(region, "TAKEOFF_POINT")
  const landing = node(region, "LANDING_POINT")
  const waiting = node(region, "WAITING_POINT")
  const alternate = node(region, "ALTERNATE_LANDING_POINT")
  const emergency = node(region, "EMERGENCY_AREA")
  const laneLatitude = region.center.latitude + latitudeSpan * lane
  const outboundId = `outbound-${delivery.id}`
  const returnId = `return-${delivery.id}`
  return [
    route(outboundId, delivery, "OUTBOUND", takeoff.id, delivery.id, [
      waypoint(`${outboundId}-1`, takeoff.position, 0, true, takeoff.id),
      waypoint(`${outboundId}-2`, { longitude: region.center.longitude - longitudeSpan * 0.08, latitude: laneLatitude }, 100),
      waypoint(`${outboundId}-3`, { longitude: delivery.position.longitude - longitudeSpan * 0.05, latitude: laneLatitude }, 100),
      waypoint(`${outboundId}-4`, delivery.position, 0, true, delivery.id)
    ], waiting.id, alternate.id, emergency.id),
    route(returnId, delivery, "RETURN", delivery.id, landing.id, [
      waypoint(`${returnId}-1`, delivery.position, 0, true, delivery.id),
      waypoint(`${returnId}-2`, { longitude: delivery.position.longitude + longitudeSpan * 0.05, latitude: laneLatitude + latitudeSpan * 0.035 }, 100),
      waypoint(`${returnId}-3`, { longitude: region.center.longitude + longitudeSpan * 0.08, latitude: laneLatitude + latitudeSpan * 0.035 }, 100),
      waypoint(`${returnId}-4`, landing.position, 0, true, landing.id)
    ], waiting.id, alternate.id, emergency.id)
  ]
}

function route(id, delivery, direction, departureNodeId, arrivalNodeId, waypoints, waitingNodeId, alternateNodeId, emergencyNodeId) {
  return { id, name: `${delivery.name}-${direction}`, destinationNodeId: delivery.id, direction, role: "PRIMARY", groupCode: "R7-SCALE", departureNodeId, arrivalNodeId, protectionRadiusMeters: 30, waitingNodeIds: [waitingNodeId], alternateLandingNodeIds: [alternateNodeId], emergencyAreaNodeIds: [emergencyNodeId], entryDirectionDegrees: 90, exitDirectionDegrees: 270, waypoints }
}

function waypoint(id, position, altitudeMeters, locked = false, nodeId = null) {
  return { id, name: id, position: { ...position }, altitudeMeters, segmentAltitudeMeters: altitudeMeters === 0 ? 100 : altitudeMeters, speedMps: 12, nodeId, locked }
}

function buildScheduleItems(workspace) {
  const routeByDestination = new Map()
  for (const route of workspace.routes) {
    const destination = route.route.destinationNodeId
    const entry = routeByDestination.get(destination) ?? {}
    entry[route.route.direction === "OUTBOUND" ? "outbound" : "inbound"] = route
    routeByDestination.set(destination, entry)
  }
  let globalNextAvailable = 0
  return workspace.orders.map((order, index) => {
    const aircraft = workspace.aircraft[index % workspace.aircraft.length]
    const pair = routeByDestination.get(order.destinationNodeId)
    if (!aircraft || !pair?.outbound || !pair.inbound) throw new Error(`订单 ${order.code} 缺少匹配的无人机或往返航线`)
    const plannedTakeoffTimeMs = Math.max(order.earliestStartTimeMs, globalNextAvailable)
    const durationMs = pair.outbound.flightTimeMs + pair.inbound.flightTimeMs + 180_000
    globalNextAvailable = plannedTakeoffTimeMs + durationMs
    return { id: `dispatch-${String(index + 1).padStart(3, "0")}`, orderId: order.id, aircraftId: aircraft.id, outboundRouteId: pair.outbound.id, returnRouteId: pair.inbound.id, plannedTakeoffTimeMs }
  })
}

function node(region, type) {
  const value = region.logisticsNodes?.find((item) => item.type === type && item.enabled)
  if (!value || (["TAKEOFF_POINT", "LANDING_POINT"].includes(type) && !value.position)) throw new Error(`区域缺少可用节点：${type}`)
  return value
}

function distance(left, right) {
  return Math.hypot((left.longitude - right.longitude) * 102_000, (left.latitude - right.latitude) * 111_000)
}

function positiveNumber(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error("验收夹具数值必须为正数")
  return number
}

function rectangle(longitude, latitude, longitudeSize, latitudeSize) {
  return [{ longitude, latitude }, { longitude: longitude + longitudeSize, latitude }, { longitude: longitude + longitudeSize, latitude: latitude + latitudeSize }, { longitude, latitude: latitude + latitudeSize }]
}

async function findProject(title, sceneType) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const projects = await request("/v3/my-projects?includeInternalData=true", { cookie: student })
    const project = projects.find((item) => item.title === title && item.sceneType === sceneType)
    if (project) return project
    await delay(150)
  }
  throw new Error(`没有找到已发布的 ${sceneType} 项目：${title}`)
}

async function waitForJson(path, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await request(path, { cookie: student })
    if (predicate(value)) return value
    await delay(100)
  }
  throw new Error(`等待接口达到目标状态超时：${path}`)
}

async function archiveExistingFixtures(cookie) {
  const drafts = await request("/v3/assignments/drafts", { cookie })
  for (const draft of drafts.filter((item) => item.title.startsWith(fixturePrefix) && ["PUBLISHED", "IN_PROGRESS"].includes(item.status))) {
    await request(`/v3/assignments/${draft.id}/end`, { method: "POST", cookie, body: { reason: "清理 R7 浏览器规模验收夹具" } })
    await request(`/v3/assignments/${draft.id}/archive`, { method: "POST", cookie, body: { reason: "清理 R7 浏览器规模验收夹具" } })
  }
}

async function login(email, password) {
  const response = await fetch(`${apiBase}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ email, password }) })
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

function stage(workspace, code) {
  const value = workspace.stages?.find((item) => item.stageCode === code)
  if (!value) throw new Error(`缺少项目阶段：${code}`)
  return value
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function timestamp() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") }
