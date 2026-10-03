import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { DataSource } from "typeorm"
import type {
  LogisticsAircraftCapabilityView,
  LogisticsRuntimeReadinessWorkspaceView,
  LogisticsRuntimeWorkspaceView,
  LogisticsRouteInput,
  LogisticsRouteWorkspaceView,
  LogisticsSchedulingWorkspaceView,
  ShowReviewWorkspaceView,
  V3Coordinate,
  V3LogisticsNode,
  V3RegionCatalogItem
} from "@wurenji/shared"
import { checkLogisticsRoutePlan } from "@wurenji/simulation"
import { integrationServerEntry } from "../integration-server-entry.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("V3 R4 logistics route integration", () => {
  let serverProcess: ChildProcess
  let serverOutput = ""
  let baseUrl = ""
  let database: DataSource
  let teacherCookie = ""
  let studentCookie = ""
  let assignmentId = ""
  let projectId = ""
  let upgradedReportPackageId = ""
  let upgradedReportPreviousPackageId = ""

  beforeAll(async () => {
    const port = await availablePort()
    baseUrl = `http://127.0.0.1:${port}/api`
    const server = integrationServerEntry()
    serverProcess = spawn(process.execPath, [server.entry], {
      cwd: server.cwd,
      env: {
        ...process.env,
        DATABASE_URL: process.env.V3_INTEGRATION_DATABASE_URL,
        PORT: String(port),
        WEB_ORIGIN: "http://localhost:5173",
        TYPEORM_SYNCHRONIZE: "false",
        SEED_DEMO_DATA: "true",
        V3_FILE_STORAGE_PROVIDER: "LOCAL"
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    serverProcess.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    serverProcess.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    await waitForServer()
    database = new DataSource({ type: "postgres", url: process.env.V3_INTEGRATION_DATABASE_URL! })
    await database.initialize()
    teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
    studentCookie = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
  }, 30_000)

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) serverProcess.kill()
    if (database?.isInitialized) {
      if (assignmentId) {
        const projectRows = await database.query(`SELECT "id" FROM "student_projects" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [assignmentId]) as Array<{ id: string }>
        await database.query(`DELETE FROM "student_projects" WHERE "id" = ANY($1::uuid[])`, [projectRows.map((row) => row.id)])
        await database.query(`DELETE FROM "assignment_snapshots" WHERE "draftId" = $1`, [assignmentId])
        await database.query(`DELETE FROM "assignment_drafts" WHERE "id" = $1`, [assignmentId])
      }
      if (upgradedReportPackageId) await database.query(`DELETE FROM "resource_packages" WHERE "id" = $1`, [upgradedReportPackageId])
      if (upgradedReportPreviousPackageId) await database.query(`UPDATE "resource_packages" SET "status" = 'ACTIVE', "retiredAt" = NULL, "activatedAt" = COALESCE("activatedAt", NOW()) WHERE "id" = $1`, [upgradedReportPreviousPackageId])
      await database.destroy()
    }
  })

  it("completes region confirmation, student-authored routes, round-trip validation and formal submission", async () => {
    const resources = await jsonRequest<Array<{ id: string; packageType: string; version: string; status: string; source: string; manifest: Record<string, unknown> }>>("/v3/resource-packages", { cookie: teacherCookie })
    const regions = await jsonRequest<V3RegionCatalogItem[]>("/v3/resource-packages/regions/catalog?sceneType=CITY_LOGISTICS", { cookie: teacherCookie })
    const region = regions[0]!
    expect(region.logisticsNodes?.filter((node) => node.type === "CENTER_AIRPORT")).toHaveLength(1)
    expect(region.logisticsNodes?.filter((node) => node.type === "DELIVERY_POINT")).toHaveLength(12)
    const { delivery, routes } = findPassingRoutes(region)
    const outsideCandidate = region.logisticsNodes!.find((node) => node.type === "DELIVERY_POINT" && node.id !== delivery.id)!
    const reportPackageId = resources
      .filter((resource) => resource.status === "ACTIVE" && resource.source === "BUILT_IN" && resource.packageType === "REPORT" && reportSupportsScene(resource.manifest, "CITY_LOGISTICS"))
      .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))[0]?.id
    expect(reportPackageId).toBeDefined()
    const selectedResources = resources.filter((resource) => {
      if (resource.status !== "ACTIVE" || resource.manifest.testOnly === true) return false
      if (resource.source !== "BUILT_IN") return false
      if (resource.packageType === "REGION") return resource.id === region.packageId
      if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") return resource.manifest.sceneType === "CITY_LOGISTICS"
      if (resource.packageType === "DOCUMENT_TEMPLATE") return false
      if (resource.packageType === "REPORT") return resource.id === reportPackageId
      return true
    })
    expect(new Set(selectedResources.map((resource) => resource.packageType))).toEqual(new Set(["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"]))

    const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
    const classroomWithStudents = await findClassroomWithStudents(classes)
    const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
      method: "POST",
      cookie: teacherCookie,
      body: {
        title: `R4 物流航线黄金用例 ${randomUUID()}`,
        sceneType: "CITY_LOGISTICS",
        mode: "TRAINING",
        isAcceptanceData: true,
        config: {
          taskBrief: "完成物流区域分析、自主航线规划和完整往返验证",
          scaleTemplateCode: "LOGISTICS_3",
          regionPackageId: region.packageId,
          availableAt: new Date(Date.now() - 60_000).toISOString(),
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          allowResubmission: true,
          allowedValidationAttempts: 3,
          allowedRuntimeAttempts: 2,
          resultVisibility: "FULL_REVIEW",
          scenario: {
            orderCount: 3,
            orderReleaseMode: "BATCH",
            priorityProfile: "STANDARD_HEAVY",
            deliveryDistributionMode: "FOCUSED",
            candidateDeliveryPointIds: [delivery.id],
            timeWindowMinutes: 30,
            orderSeed: "r4-frozen-order-preview"
          }
        }
      }
    })
    assignmentId = draft.id
    const targets = [{ type: "CLASS", targetId: classroomWithStudents.id }]
    const resourcePackageIds = selectedResources.map((resource) => resource.id)
    const preview = await jsonRequest<{ configHash: string; logisticsOrderPreview: { candidateDeliveryPointIds: string[]; samples: Array<{ destinationNodeId: string }>; checksum: string } }>(`/v3/assignments/drafts/${draft.id}/preview`, { method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds } })
    expect(preview.logisticsOrderPreview).toMatchObject({ candidateDeliveryPointIds: [delivery.id] })
    expect(preview.logisticsOrderPreview.samples.every((order) => order.destinationNodeId === delivery.id)).toBe(true)
    expect(preview.logisticsOrderPreview.checksum).toHaveLength(64)
    const preflight = await jsonRequest<{ checkedAt: string; checks: Array<{ code: string; level: string }> }>(`/v3/assignments/drafts/${draft.id}/preflight`, { method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds } })
    await jsonRequest(`/v3/assignments/drafts/${draft.id}/publish`, { method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds, preflightConfirmation: { checkedAt: preflight.checkedAt, checkCodes: preflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code) } } })

    const projects = await jsonRequest<Array<{ id: string; assignmentSnapshotId: string; title: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>>("/v3/my-projects?includeInternalData=true", { cookie: studentCookie })
    const project = projects.find((item) => item.title.startsWith("R4 物流航线黄金用例"))!
    projectId = project.id

    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_REGION_ANALYSIS/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: 1 } })
    let workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: studentCookie })
    expect(workspace).toMatchObject({ canEditRegion: true, candidateDeliveryPointIds: [delivery.id], requiredDeliveryPointRange: { minimum: 1, maximum: 1 } })
    await errorRequest(`/v3/logistics-projects/${projectId}/region-analysis`, {
      method: "PUT",
      cookie: studentCookie,
      body: { expectedRevision: workspace.regionAnalysis.revision, selectedDeliveryPointIds: [outsideCandidate.id], notes: "尝试选择教师候选范围外配送点。" }
    }, 400)
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/region-analysis`, {
      method: "PUT",
      cookie: studentCookie,
      body: { expectedRevision: workspace.regionAnalysis.revision, selectedDeliveryPointIds: [delivery.id], notes: "已核查建筑、限制区、通信覆盖、等待点和备降点。" }
    })
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/region-analysis/confirm`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: workspace.regionAnalysis.revision, expectedStageRevision: 2 }
    })
    expect(workspace.regionAnalysis.status).toBe("CONFIRMED")

    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_ROUTE_PLANNING/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: 2 } })
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: studentCookie })
    const mapAnnotations = [{ id: "logistics-map-note-1", label: "等待区入口", position: region.center, heightMeters: 18.4 }]
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/draft`, { method: "PUT", cookie: studentCookie, body: { expectedRevision: workspace.draft.revision, routes, annotations: mapAnnotations } })
    expect(workspace.draft).toMatchObject({ revision: 2, annotations: mapAnnotations })
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/check`, { method: "POST", cookie: studentCookie })
    expect(workspace.draft.lastCheckResult?.passed, JSON.stringify(workspace.draft.lastCheckResult?.evidence)).toBe(true)
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/snapshot`, { method: "POST", cookie: studentCookie })
    expect(workspace.versions[0]).toMatchObject({ versionNo: 1, status: "SNAPSHOT", sourceDraftRevision: 2, annotations: mapAnnotations })
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/complete`, { method: "POST", cookie: studentCookie, body: { expectedDraftRevision: 2, expectedStageRevision: 3 } })
    expect(workspace.versions[0]).toMatchObject({ versionNo: 2, status: "SNAPSHOT" })

    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_ROUTE_VALIDATION/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: 2 } })
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/validate`, { method: "POST", cookie: studentCookie })
    expect(workspace.validationRuns[0]?.status).toMatch(/PASSED|WITH_RISK/)
    expect(workspace.validationRuns[0]?.result.completedRoundTripCount).toBe(1)
    expect(workspace.validationRuns[0]?.result.routeMetrics).toHaveLength(4)
    expect(workspace.validationRuns[0]?.result).toMatchObject({ aircraftModelCode: aircraft.modelCode, aircraftRuleVersion: aircraft.ruleVersion })
    expect(workspace.validationRuns[0]?.result.roundTripMetrics[0]?.milestones?.map((item) => item.code)).toEqual([
      "AIRPORT_TAKEOFF",
      "OUTBOUND_FLIGHT",
      "ARRIVAL_CONFIRMATION",
      "RETURN_FLIGHT",
      "AIRPORT_LANDING"
    ])
    const validatedVersion = workspace.versions.find((version) => version.status === "VALIDATED")!
    expect(validatedVersion).toBeDefined()
    const firstValidationRun = workspace.validationRuns[0]!

    const modifiedRoutes = routes.map((route, routeIndex) => ({
      ...route,
      waypoints: route.waypoints.map((waypoint, waypointIndex) => routeIndex === 0 && waypointIndex === 1
        ? { ...waypoint, speedMps: waypoint.speedMps - 1 }
        : { ...waypoint })
    }))
    const modifiedRouteId = routes[0]!.id
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/draft`, {
      method: "PUT",
      cookie: studentCookie,
      body: { expectedRevision: workspace.draft.revision, routes: modifiedRoutes, annotations: [{ ...mapAnnotations[0], label: "已调整等待区入口" }] }
    })
    expect(workspace.draft.routes.find((route) => route.id === modifiedRouteId)?.waypoints[1]?.speedMps).toBe(11)
    expect(workspace.draft.annotations[0]?.label).toBe("已调整等待区入口")
    await errorRequest(`/v3/logistics-projects/${projectId}/route-plan/versions/${validatedVersion.id}/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: 3 }
    }, 409)
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/validate`, { method: "POST", cookie: studentCookie })
    expect(workspace.validationRuns).toHaveLength(2)
    expect(workspace.validationRuns.map((run) => run.attemptNo)).toEqual([2, 1])
    expect(workspace.validationRuns[1]).toMatchObject({ id: firstValidationRun.id, versionId: validatedVersion.id })
    const modifiedValidatedVersion = workspace.versions.find((version) => version.id === workspace.validationRuns[0]!.versionId)!
    expect(modifiedValidatedVersion.routes.find((route) => route.id === modifiedRouteId)?.waypoints[1]?.speedMps).toBe(11)
    expect(validatedVersion.routes.find((route) => route.id === modifiedRouteId)?.waypoints[1]?.speedMps).toBe(12)

    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/versions/${validatedVersion.id}/restore`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: workspace.draft.revision }
    })
    expect(workspace.draft.routes.find((route) => route.id === modifiedRouteId)?.waypoints[1]?.speedMps).toBe(12)
    expect(workspace.draft.annotations).toEqual(mapAnnotations)
    expect(workspace.canSubmit).toBe(false)
    expect(workspace.versions.some((version) => version.id === modifiedValidatedVersion.id)).toBe(true)
    expect(workspace.validationRuns).toHaveLength(2)

    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/validate`, { method: "POST", cookie: studentCookie })
    expect(workspace.validationRuns).toHaveLength(3)
    expect(workspace.validationRuns.map((run) => run.attemptNo)).toEqual([3, 2, 1])
    const restoredValidatedVersion = workspace.versions.find((version) => version.id === workspace.validationRuns[0]!.versionId)!
    expect(restoredValidatedVersion.routes.find((route) => route.id === modifiedRouteId)?.waypoints[1]?.speedMps).toBe(12)
    const cleanValidationResult = restoredValidatedVersion.validationResult!
    const blockedValidationResult = {
      ...cleanValidationResult,
      evidence: [
        ...cleanValidationResult.evidence,
        {
          code: "FORMAL_ROUTE_BLOCKING_TEST",
          category: "SPATIAL",
          severity: "CONFLICT",
          blocking: true,
          message: "一条正式运行航线仍存在硬性冲突",
          routeIds: [restoredValidatedVersion.routes.find((route) => route.role === "PRIMARY")!.id],
          waypointIds: [],
          segmentIndexes: [],
          position: null,
          data: {}
        }
      ]
    }
    await database.query(`UPDATE "logistics_route_plan_versions" SET "validationResult" = $2::jsonb WHERE "id" = $1`, [restoredValidatedVersion.id, JSON.stringify(blockedValidationResult)])
    await errorRequest(`/v3/logistics-projects/${projectId}/route-plan/versions/${restoredValidatedVersion.id}/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: 3 }
    }, 409)
    await database.query(`UPDATE "logistics_route_plan_versions" SET "validationResult" = $2::jsonb WHERE "id" = $1`, [restoredValidatedVersion.id, JSON.stringify(cleanValidationResult)])
    workspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-plan/versions/${restoredValidatedVersion.id}/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: workspace.draft.revision, expectedStageRevision: 3 }
    })
    expect(workspace.versions.find((version) => version.id === restoredValidatedVersion.id)?.status).toBe("SUBMITTED")
    expect(workspace.versions.find((version) => version.id === validatedVersion.id)?.status).toBe("VALIDATED")
    expect(workspace.versions.find((version) => version.id === modifiedValidatedVersion.id)?.status).toBe("VALIDATED")

    const projectAfterSubmit = await jsonRequest<{ currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(projectAfterSubmit.currentStageCode).toBe("LOGISTICS_ORDER_SCHEDULING")
    expect(projectAfterSubmit.stages.find((stage) => stage.stageCode === "LOGISTICS_ROUTE_VALIDATION")).toMatchObject({ status: "ACCEPTED", revision: 4 })
    expect(projectAfterSubmit.stages.find((stage) => stage.stageCode === "LOGISTICS_ORDER_SCHEDULING")).toMatchObject({ status: "AVAILABLE", revision: 2 })

    const teacherWorkspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: teacherCookie })
    expect(teacherWorkspace).toMatchObject({ actor: "TEACHER", canEditRoutes: false })
    expect(teacherWorkspace.validationRuns[0]?.result.routeMetrics).toHaveLength(4)

    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_ORDER_SCHEDULING/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: 2 } })
    let scheduling = await jsonRequest<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${projectId}/scheduling-workspace`, { cookie: studentCookie })
    expect(scheduling).toMatchObject({ actor: "STUDENT", strictSerialOperation: true, batchSchedulingMode: "NONE", canEdit: true })
    expect(scheduling.orders).toHaveLength(3)
    expect(scheduling.orders.every((order) => (
      typeof order.code === "string"
      && typeof order.destinationNodeId === "string"
      && ["NORMAL", "PRIORITY", "URGENT"].includes(order.priority)
      && Number.isFinite(order.releaseTimeMs)
      && Number.isFinite(order.earliestStartTimeMs)
      && Number.isFinite(order.latestArrivalTimeMs)
      && ["UNRELEASED", "UNASSIGNED", "SCHEDULED"].includes(order.status)
    ))).toBe(true)
    expect(scheduling.aircraft).toHaveLength(3)
    expect(scheduling.aircraft.every((aircraftItem) => (
      aircraftItem.currentLocation.type === "CENTER_AIRPORT"
      && aircraftItem.currentLocation.label === "中心机场"
      && aircraftItem.taskQueue.length === 0
      && aircraftItem.estimatedReturnTimeMs === null
      && aircraftItem.nextAvailableTimeMs === aircraftItem.availableAtMs
    ))).toBe(true)
    expect(scheduling.routes).toHaveLength(4)
    expect(scheduling.orderBatch.checksum).toHaveLength(64)
    await errorRequest(`/v3/logistics-projects/${projectId}/schedule-plan/batch-adjust`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: scheduling.draft.revision,
        orderIds: scheduling.orders.slice(0, 2).map((order) => order.id),
        group: { type: "DELIVERY_POINT", value: scheduling.orders[0]!.destinationNodeId },
        adjustment: { takeoffShiftMs: 60_000 }
      }
    }, 409)
    const outbound = scheduling.routes.find((route) => route.route.direction === "OUTBOUND" && route.route.role === "PRIMARY")!
    const inbound = scheduling.routes.find((route) => route.route.direction === "RETURN" && route.route.role === "PRIMARY")!
    const missionSpacingMs = outbound.flightTimeMs + inbound.flightTimeMs + 5 * 60_000
    const scheduleItems = scheduling.orders.map((order, index) => ({
      id: `dispatch-${index + 1}`,
      orderId: order.id,
      aircraftId: scheduling.aircraft[index]!.id,
      outboundRouteId: outbound.id,
      returnRouteId: inbound.id,
      plannedTakeoffTimeMs: Math.max(order.earliestStartTimeMs, index * missionSpacingMs)
    }))
    scheduling = await jsonRequest<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${projectId}/schedule-plan/draft`, { method: "PUT", cookie: studentCookie, body: { expectedRevision: scheduling.draft.revision, items: scheduleItems } })
    expect(scheduling.draft.items).toEqual(scheduleItems)
    expect(scheduling.draft.items.every((item) => item.aircraftId && item.outboundRouteId === outbound.id && item.returnRouteId === inbound.id)).toBe(true)
    expect(new Set(scheduling.draft.items.map((item) => item.orderId)).size).toBe(scheduling.draft.items.length)
    scheduling = await jsonRequest<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${projectId}/schedule-plan/check`, { method: "POST", cookie: studentCookie })
    expect(scheduling.draft.lastCheckResult?.status, JSON.stringify(scheduling.draft.lastCheckResult?.evidence)).toMatch(/PASSED|WITH_RISK/)
    expect(scheduling.draft.lastCheckResult?.submittable).toBe(true)
    expect(scheduling.aircraft.every((aircraftItem) => (
      aircraftItem.taskQueue.length === 1
      && aircraftItem.estimatedReturnTimeMs === aircraftItem.taskQueue[0]?.landingTimeMs
      && aircraftItem.nextAvailableTimeMs === aircraftItem.taskQueue[0]?.nextAvailableTimeMs
    ))).toBe(true)
    scheduling = await jsonRequest<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${projectId}/schedule-plan/snapshot`, { method: "POST", cookie: studentCookie })
    const scheduleVersion = scheduling.versions.find((version) => version.sourceDraftRevision === scheduling.draft.revision)!
    expect(scheduleVersion).toMatchObject({ versionNo: 1, status: "SNAPSHOT" })
    scheduling = await jsonRequest<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${projectId}/schedule-plan/versions/${scheduleVersion.id}/submit`, { method: "POST", cookie: studentCookie, body: { expectedDraftRevision: scheduling.draft.revision, expectedStageRevision: 3 } })
    expect(scheduling.versions.find((version) => version.id === scheduleVersion.id)?.status).toBe("SUBMITTED")
    const projectAfterScheduling = await jsonRequest<{ currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(projectAfterScheduling.currentStageCode).toBe("LOGISTICS_RUNTIME_PREPARATION")
    expect(projectAfterScheduling.stages.find((stage) => stage.stageCode === "LOGISTICS_ORDER_SCHEDULING")).toMatchObject({ status: "ACCEPTED", revision: 4 })
    expect(projectAfterScheduling.stages.find((stage) => stage.stageCode === "LOGISTICS_RUNTIME_PREPARATION")).toMatchObject({ status: "AVAILABLE", revision: 2 })
    const teacherScheduling = await jsonRequest<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${projectId}/scheduling-workspace`, { cookie: teacherCookie })
    expect(teacherScheduling).toMatchObject({ actor: "TEACHER", canEdit: false })
    expect(teacherScheduling.orders.every((order) => order.status === "SCHEDULED")).toBe(true)

    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_RUNTIME_PREPARATION/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: 2 } })
    let readiness = await jsonRequest<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-readiness`, { cookie: studentCookie })
    expect(readiness).toMatchObject({ actor: "STUDENT", canEdit: true, readiness: { status: "DRAFT", revision: 1 } })
    expect(readiness.canConfirm).toBe(false)
    expect(readiness.readiness.checks.map((item) => [item.code, item.category, item.blocking])).toEqual([
      ["SCHEDULE_SUBMITTED", "SCHEDULE", true],
      ["ORDER_ASSIGNMENT_COMPLETE", "ORDER", true],
      ["AIRCRAFT_AVAILABLE", "AIRCRAFT", true],
      ["AIRCRAFT_BATTERY", "AIRCRAFT", false],
      ["ROUTES_VERIFIED", "ROUTE", true],
      ["SCHEDULE_CONFLICTS", "SCHEDULE", true],
      ["ENVIRONMENT_READY", "ENVIRONMENT", true],
      ["NODES_AVAILABLE", "NODE", true]
    ])
    expect(readiness.readiness.checks.every((item) => item.status !== "FAIL"), JSON.stringify(readiness.readiness.checks)).toBe(true)
    readiness = await jsonRequest<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-readiness`, {
      method: "PUT",
      cookie: studentCookie,
      body: { expectedRevision: readiness.readiness.revision, decision: "PROCEED", decisionBasis: "已复核运行资源、环境状态和正式初始调度。" }
    })
    readiness = await jsonRequest<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-readiness/check`, { method: "POST", cookie: studentCookie, body: { expectedRevision: readiness.readiness.revision } })
    expect(readiness.canConfirm).toBe(true)
    readiness = await jsonRequest<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-readiness/confirm`, { method: "POST", cookie: studentCookie, body: { expectedRevision: readiness.readiness.revision } })
    expect(readiness.readiness).toMatchObject({ status: "CONFIRMED", decision: "PROCEED" })

    let runtimeStages = await jsonRequest<{ currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(runtimeStages.currentStageCode).toBe("LOGISTICS_DELIVERY_RUNTIME")
    const deliveryStage = runtimeStages.stages.find((stage) => stage.stageCode === "LOGISTICS_DELIVERY_RUNTIME")!
    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_DELIVERY_RUNTIME/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: deliveryStage.revision } })
    let runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(runtime).toMatchObject({ canStart: true, session: { status: "READY" }, summary: { totalAircraft: 3, totalOrders: 3 } })
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'ASSESSMENT' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = now() - interval '2 hours', "assessmentDeadlineAt" = now() - interval '1 minute' WHERE "id" = $1`, [projectId])
    const expiredReadyRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(expiredReadyRuntime).toMatchObject({ session: { status: "READY" }, canStart: false, canControl: false })
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'TRAINING' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = NULL, "assessmentDeadlineAt" = NULL WHERE "id" = $1`, [projectId])
    expect(runtime.aircraft.every((item) => Number.isFinite(item.position.longitude) && Number.isFinite(item.position.latitude) && Number.isFinite(item.batteryPercent))).toBe(true)
    expect(runtime.tasks.every((item) => item.orderId && item.status && Number.isFinite(item.batteryPercent))).toBe(true)
    expect(runtime.scheduleItems.every((item) => runtime.routes.some((route) => route.id === item.outboundRouteId) && runtime.routes.some((route) => route.id === item.returnRouteId))).toBe(true)
    expect(runtime.orders.every((item) => item.code && item.status)).toBe(true)
    expect(runtime.environment).toEqual(expect.objectContaining({
      windDirection: expect.any(String),
      windState: expect.any(String),
      gustState: expect.any(String),
      rainState: expect.any(String),
      positioningQuality: expect.any(String),
      communicationQuality: expect.any(String),
      equipmentState: expect.any(String),
      operationState: expect.any(String)
    }))
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision } })
    expect(runtime.session.status).toBe("RUNNING")
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'ASSESSMENT' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = now() - interval '2 hours', "assessmentDeadlineAt" = now() - interval '1 minute' WHERE "id" = $1`, [projectId])
    const expiredRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(expiredRuntime).toMatchObject({ canStart: false, canControl: false })
    expect(Date.parse(expiredRuntime.clock!.deadlineAt!)).toBeLessThan(Date.now())
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'TRAINING' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = NULL, "assessmentDeadlineAt" = NULL WHERE "id" = $1`, [projectId])
    expect(runtime.events).toHaveLength(0)
    const lockedRouteWorkspace = await jsonRequest<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${projectId}/route-workspace`, { cookie: studentCookie })
    expect(lockedRouteWorkspace.canEditRoutes).toBe(false)
    await errorRequest(`/v3/logistics-projects/${projectId}/route-plan/draft`, {
      method: "PUT",
      cookie: studentCookie,
      body: {
        expectedRevision: lockedRouteWorkspace.draft.revision,
        routes: [...lockedRouteWorkspace.draft.routes, { ...lockedRouteWorkspace.draft.routes[0], id: "runtime-new-route", name: "运行中新建航线" }]
      }
    }, 409)
    let teacherRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: teacherCookie })
    expect(teacherRuntime.canTeacherIntervene).toBe(true)
    const teacherTriggerRevision = teacherRuntime.session.revision
    const scheduledWeatherEventId = randomUUID()
    await database.query(`
      INSERT INTO "runtime_events" (
        "id", "projectId", "sessionId", "stageCode", "code", "category", "status", "severity",
        "scheduledSimulationTimeMs", "triggeredAt", "resolvedAt", "payload", "correlationId"
      ) VALUES ($1, $2, $3, 'LOGISTICS_DELIVERY_RUNTIME', 'WEATHER_CHANGE', 'WEATHER_ENVIRONMENT', 'SCHEDULED', 'WARNING', $4, NULL, NULL, $5::jsonb, $6)
    `, [scheduledWeatherEventId, projectId, teacherRuntime.session.id, teacherRuntime.session.simulationTimeMs + 60_000, JSON.stringify({
      title: "局部气象条件恶化",
      detail: "局部航线风力和阵风接近运行限制。",
      lifecycleStatus: "SCHEDULED",
      affectedAircraftIds: [],
      affectedOrderIds: [],
      affectedRouteIds: [],
      recommendedActions: ["REDUCE_SPEED", "HOLD_POSITION", "PAUSE_ROUTE"],
      detectionAtSimulationTimeMs: teacherRuntime.session.simulationTimeMs + 60_000,
      detectedSimulationTimeMs: null,
      escalationAtSimulationTimeMs: null,
      controlledSimulationTimeMs: null,
      scenarioConfig: null
    }), randomUUID()])
    const scheduledWeatherEvents = await database.query<Array<{ id: string }>>(
      `SELECT "id" FROM "runtime_events" WHERE "projectId" = $1 AND "sessionId" = $2 AND "code" = 'WEATHER_CHANGE' AND "status" = 'SCHEDULED' ORDER BY "createdAt" LIMIT 1`,
      [projectId, teacherRuntime.session.id]
    )
    expect(scheduledWeatherEvents).toHaveLength(1)
    const teacherTriggerRequestId = "logistics-event-trigger-retry-001"
    const weatherEventId = scheduledWeatherEvents[0]!.id
    const triggeredTeacherRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/events/${weatherEventId}/trigger`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherTriggerRevision, requestId: teacherTriggerRequestId }
    })
    const triggeredWeatherEvent = triggeredTeacherRuntime.events.find((event) => event.code === "WEATHER_CHANGE")!
    expect(triggeredWeatherEvent).toBeTruthy()
    const retriedTeacherRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/events/${weatherEventId}/trigger`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherTriggerRevision, requestId: teacherTriggerRequestId }
    })
    expect(retriedTeacherRuntime.session.revision).toBe(triggeredTeacherRuntime.session.revision)
    expect(retriedTeacherRuntime.events.filter((event) => event.code === "WEATHER_CHANGE")).toHaveLength(1)
    expect(retriedTeacherRuntime.events.filter((event) => event.id === triggeredWeatherEvent.id)).toHaveLength(1)
    teacherRuntime = retriedTeacherRuntime
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/hints`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, message: "学生不能发送教师提示" } }, 403)
    teacherRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/hints`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherRuntime.session.revision, message: "请优先核对订单时间窗口与后续无人机可用时间。" }
    })
    expect(teacherRuntime.alerts[0]).toMatchObject({ code: "TEACHER_HINT", title: "教师训练提示", severity: "INFO", status: "OPEN" })
    expect(teacherRuntime.alerts[0]?.detail).toContain("订单时间窗口")
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(runtime.alerts.some((alert) => alert.code === "TEACHER_HINT")).toBe(true)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/clock`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, status: "RUNNING", rate: 60 } })
    runtime = await waitForSimulationWindow(scheduleItems[0]!.plannedTakeoffTimeMs, scheduleItems[2]!.plannedTakeoffTimeMs)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/clock`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, status: "PAUSED", rate: 1 } })
    expect(runtime.session.status).toBe("PAUSED")
    expect(runtime.session.simulationTimeMs).toBeGreaterThan(scheduleItems[0]!.plannedTakeoffTimeMs)
    expect(runtime.session.simulationTimeMs).toBeLessThan(scheduleItems[2]!.plannedTakeoffTimeMs)
    const pausedRevision = runtime.session.revision
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(runtime.session.revision).toBe(pausedRevision)
    const firstStreamSnapshot = await readSseSnapshot()
    expect(firstStreamSnapshot.workspace.session.revision).toBe(firstStreamSnapshot.revision)
    const pausedStreamUpdate = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/clock`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: firstStreamSnapshot.revision, status: "PAUSED", rate: 1 }
    })
    const reconnectedStreamSnapshot = await readSseSnapshot(firstStreamSnapshot.revision)
    expect(reconnectedStreamSnapshot.resumedFromRevision).toBe(firstStreamSnapshot.revision)
    expect(reconnectedStreamSnapshot.workspace.session.revision).toBe(reconnectedStreamSnapshot.revision)
    expect(reconnectedStreamSnapshot.revision).toBeGreaterThanOrEqual(pausedStreamUpdate.session.revision)
    expect(reconnectedStreamSnapshot.revision).toBeGreaterThan(firstStreamSnapshot.revision)
    runtime = pausedStreamUpdate
    const reduceSpeed = runtime.availableActions.find((action) => action.code === "REDUCE_SPEED")!
    expect(reduceSpeed.eligibleTargetIds.length).toBeGreaterThan(0)
    expect(reduceSpeed.eligibleTargetIds.every((id) => runtime.aircraft.find((aircraft) => aircraft.id === id)?.currentTaskId)).toBe(true)
    const ineligibleAircraft = runtime.aircraft.find((aircraft) => !reduceSpeed.eligibleTargetIds.includes(aircraft.id))!
    expect(ineligibleAircraft).toBeDefined()
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "REDUCE_SPEED",
        targetId: ineligibleAircraft.id,
        reasoning: { observation: "选中尚未进入飞行任务的无人机", rationale: "待机对象不应接受飞行减速", expectedOutcome: "系统拒绝不适用的处置目标" },
        payload: { speedFactor: 1.5 }
      }
    }, 409)

    const affectedTask = runtime.tasks.find((task) => runtime.routes.find((route) => route.id === (task.activeRouteId ?? task.outboundRouteId))?.role === "PRIMARY")!
    const affectedRoute = runtime.routes.find((route) => route.id === (affectedTask.activeRouteId ?? affectedTask.outboundRouteId))!
    const replacementAlternate = runtime.routes.find((route) => route.role === "ALTERNATE" && route.destinationNodeId === affectedRoute.destinationNodeId && route.direction === affectedRoute.direction)!
    const unrelatedRoute = runtime.routes.find((route) => route.role === "PRIMARY" && route.id !== affectedRoute.id)!
    const affectedOrder = runtime.orders.find((order) => order.id === affectedTask.orderId)!
    expect(affectedTask).toBeDefined()
    expect(affectedRoute).toBeDefined()
    expect(replacementAlternate).toBeDefined()
    expect(unrelatedRoute).toBeDefined()
    expect(affectedOrder).toBeDefined()
    const pauseEventId = await insertRouteRuntimeEvent(database, {
      projectId,
      sessionId: runtime.session.id,
      simulationTimeMs: runtime.session.simulationTimeMs,
      affectedRouteIds: [affectedRoute.id],
      affectedOrderIds: [affectedOrder.id],
      recommendedActions: ["PAUSE_ROUTE", "SWITCH_VERIFIED_ROUTE"],
      code: "TEST_ROUTE_PAUSE"
    })
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(runtime.routes.find((route) => route.id === affectedRoute.id)).toMatchObject({ role: "PRIMARY", sourceVersionNo: restoredValidatedVersion.versionNo, validationStatus: cleanValidationResult.status, status: "RISK" })
    expect(runtime.routes.find((route) => route.id === replacementAlternate.id)).toMatchObject({ role: "ALTERNATE", sourceVersionNo: restoredValidatedVersion.versionNo, validationStatus: cleanValidationResult.status })
    expect(runtime.availableActions.find((action) => action.code === "SWITCH_VERIFIED_ROUTE")?.eligibleRouteIdsByTargetId[affectedOrder.id]).toEqual([replacementAlternate.id])
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "PAUSE_ROUTE",
        targetId: unrelatedRoute.id,
        eventId: pauseEventId,
        reasoning: { observation: "发现去程航线受限", rationale: "返程航线不在本次事件影响范围", expectedOutcome: "系统拒绝暂停无关航线" },
        payload: {}
      }
    }, 409)
    const pauseRevision = runtime.session.revision
    const pauseRequestId = "logistics-action-retry-001"
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "PAUSE_ROUTE",
        targetId: affectedRoute.id,
        eventId: pauseEventId,
        requestId: pauseRequestId,
        reasoning: { observation: "发现去程航线运行条件恶化", rationale: "事件明确影响当前去程主航线", expectedOutcome: "暂停航线并阻止风险继续扩大" },
        payload: {}
      }
    })
    const pauseAfterFirstRevision = runtime.session.revision
    const retriedPauseRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: pauseRevision,
        actionCode: "PAUSE_ROUTE",
        targetId: affectedRoute.id,
        eventId: pauseEventId,
        requestId: pauseRequestId,
        reasoning: { observation: "发现去程航线运行条件恶化", rationale: "事件明确影响当前去程主航线", expectedOutcome: "暂停航线并阻止风险继续扩大" },
        payload: {}
      }
    })
    expect(retriedPauseRuntime.session.revision).toBe(pauseAfterFirstRevision)
    expect(runtime.routes.find((route) => route.id === affectedRoute.id)?.status).toBe("PAUSED")
    expect(runtime.events.find((event) => event.id === pauseEventId)?.lifecycleStatus).toBe("CONTROLLED")
    expect(runtime.actions[0]).toMatchObject({ targetId: affectedRoute.id, result: { applied: true, eventControlled: true, previousRouteStatus: "RISK", routeStatus: "PAUSED" } })
    expect(runtime.actions[0]?.payload).toMatchObject({ reasoning: { observation: "发现去程航线运行条件恶化", rationale: "事件明确影响当前去程主航线", expectedOutcome: "暂停航线并阻止风险继续扩大" } })

    const recoveryBlockingEventId = await insertRouteRuntimeEvent(database, {
      projectId,
      sessionId: runtime.session.id,
      simulationTimeMs: runtime.session.simulationTimeMs,
      affectedRouteIds: [affectedRoute.id],
      affectedOrderIds: [affectedOrder.id],
      recommendedActions: ["CONTINUE_MONITORING"],
      code: "TEST_ROUTE_RECOVERY_BLOCK"
    })
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(runtime.availableActions.find((action) => action.code === "RESUME_ROUTE")?.eligibleTargetIds).not.toContain(affectedRoute.id)
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "RESUME_ROUTE",
        targetId: affectedRoute.id,
        reasoning: { observation: "航线仍有关联活动事件", rationale: "恢复条件尚未满足", expectedOutcome: "系统拒绝提前恢复航线" },
        payload: {}
      }
    }, 409)
    await resolveRuntimeEvent(database, recoveryBlockingEventId)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    expect(runtime.availableActions.find((action) => action.code === "RESUME_ROUTE")?.eligibleTargetIds).toContain(affectedRoute.id)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "RESUME_ROUTE",
        targetId: affectedRoute.id,
        reasoning: { observation: "关联航线事件已经解除", rationale: "航线不再存在活动影响事件", expectedOutcome: "撤销人工暂停并恢复航线投影" },
        payload: {}
      }
    })
    expect(runtime.routes.find((route) => route.id === affectedRoute.id)?.status).toBe("AVAILABLE")
    expect(runtime.actions[0]?.result).toMatchObject({ previousRouteStatus: "PAUSED", routeStatus: "AVAILABLE" })

    const switchEventId = await insertRouteRuntimeEvent(database, {
      projectId,
      sessionId: runtime.session.id,
      simulationTimeMs: runtime.session.simulationTimeMs,
      affectedRouteIds: [affectedRoute.id],
      affectedOrderIds: [affectedOrder.id],
      recommendedActions: ["SWITCH_VERIFIED_ROUTE"],
      code: "TEST_ROUTE_SWITCH"
    })
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    const switchAction = runtime.availableActions.find((action) => action.code === "SWITCH_VERIFIED_ROUTE")!
    const switchOrderId = switchAction.eligibleTargetIds.find((orderId) => {
      const task = runtime.tasks.find((item) => item.orderId === orderId)
      return (task?.activeRouteId ?? task?.outboundRouteId) === affectedRoute.id
    })!
    const authorizedAlternateId = switchAction.eligibleRouteIdsByTargetId[switchOrderId]?.[0]
    expect(switchOrderId).toBeDefined()
    expect(authorizedAlternateId).toBe(replacementAlternate.id)
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "SWITCH_VERIFIED_ROUTE",
        targetId: switchOrderId,
        eventId: switchEventId,
        reasoning: { observation: "当前主航线受事件影响", rationale: "尝试把主航线误作备用方案", expectedOutcome: "系统拒绝不符合角色的航线" },
        payload: { routeId: affectedRoute.id }
      }
    }, 409)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "SWITCH_VERIFIED_ROUTE",
        targetId: switchOrderId,
        eventId: switchEventId,
        reasoning: { observation: "当前主航线受事件影响", rationale: "备用方案来自本人当前已提交验证版本且方向一致", expectedOutcome: "订单平稳切换到可用备用方案" },
        payload: { routeId: authorizedAlternateId }
      }
    })
    expect(runtime.tasks.find((task) => task.orderId === switchOrderId)?.activeRouteId).toBe(replacementAlternate.id)
    expect(runtime.events.find((event) => event.id === switchEventId)?.lifecycleStatus).toBe("CONTROLLED")
    expect(runtime.actions[0]).toMatchObject({
      targetId: switchOrderId,
      result: {
        applied: true,
        eventControlled: true,
        previousRouteId: affectedRoute.id,
        replacementRouteId: replacementAlternate.id,
        replacementRouteRole: "ALTERNATE",
        sourceVersionNo: restoredValidatedVersion.versionNo
      }
    })

    const firstAttemptId = runtime.session.id
    const anomalyEventId = randomUUID()
    const anomalyCorrelationId = randomUUID()
    const anomalyTime = runtime.session.simulationTimeMs
    await database.query(`
      INSERT INTO "runtime_events" (
        "id", "projectId", "sessionId", "stageCode", "code", "category", "status", "severity",
        "scheduledSimulationTimeMs", "triggeredAt", "resolvedAt", "payload", "correlationId"
      ) VALUES ($1, $2, $3, 'LOGISTICS_EMERGENCY_HANDLING', 'TEST_ROUTE_BLOCKED', 'ROUTE_OPERATION', 'ACTIVE', 'WARNING', $4, NOW(), NULL, $5::jsonb, $6)
    `, [anomalyEventId, projectId, firstAttemptId, anomalyTime, JSON.stringify({
      title: "测试航路临时受限",
      detail: "用于验证指定异常节点重新训练",
      lifecycleStatus: "DISCOVERED",
      affectedAircraftIds: [],
      affectedOrderIds: [],
      affectedRouteIds: [outbound.id],
      recommendedActions: ["HOLD_ROUTE"],
      detectionAtSimulationTimeMs: anomalyTime,
      detectedSimulationTimeMs: anomalyTime,
      escalationAtSimulationTimeMs: anomalyTime + 60_000,
      autoRecoveryAtSimulationTimeMs: null,
      recoveryMode: "STUDENT",
      scenarioConfig: null,
      visibilityMode: "DIRECT",
      actionDeadlineSeconds: 60,
      actionDeadlineAtSimulationTimeMs: anomalyTime + 60_000,
      followUpEventCode: null,
      recoveryCondition: null,
      controlledSimulationTimeMs: null,
      escalationCount: 0
    }), anomalyCorrelationId])
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    const anomalyNode = runtime.restartNodes.find((node) => node.code === `EVENT:${anomalyEventId}`)!
    const sourceSession = runtime.session
    expect(runtime.canRestart).toBe(true)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/restart`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: runtime.session.revision, nodeCode: anomalyNode.code }
    })
    expect(runtime.session).toMatchObject({ status: "READY", attemptNo: 2, sourceSessionId: firstAttemptId, restartNodeCode: anomalyNode.code, simulationTimeMs: anomalyTime, mode: sourceSession.mode, mapResourceVersion: sourceSession.mapResourceVersion, sceneResourceVersion: sourceSession.sceneResourceVersion, planVersion: sourceSession.planVersion })
    const historicalRuntime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/attempts/${firstAttemptId}`, { cookie: studentCookie })
    expect(historicalRuntime.session).toMatchObject({ id: firstAttemptId, attemptNo: 1, status: "PAUSED" })
    expect(historicalRuntime).toMatchObject({ canStart: false, canRestart: false })
    expect(historicalRuntime.events.some((event) => event.id === anomalyEventId)).toBe(true)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision } })
    expect(runtime.session).toMatchObject({ status: "RUNNING", attemptNo: 2, simulationTimeMs: anomalyTime })
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/clock`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, status: "PAUSED", rate: 1 } })
    expect(runtime.events.some((event) => event.code === "TEST_ROUTE_BLOCKED" && event.lifecycleStatus === "DISCOVERED")).toBe(true)
    expect(runtime.alerts.every((alert) => alert.sessionId === runtime.session.id)).toBe(true)

    const invalidItems = scheduleItems.map((item, index) => index === 2 ? { ...item, outboundRouteId: randomUUID() } : item)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/dynamic-schedules`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, mode: "SINGLE", reason: "验证运行中禁止未验证航线", items: invalidItems } })
    const invalidVersion = runtime.dynamicScheduleVersions[0]!
    expect(invalidVersion).toMatchObject({ mode: "SINGLE", affectedOrderIds: [scheduleItems[2]!.orderId], submittedBy: null })
    expect(invalidVersion.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(invalidVersion.checkResult.submittable).toBe(false)
    await database.query(`UPDATE "logistics_dynamic_schedule_versions" SET "checkResult" = $2::jsonb WHERE "id" = $1`, [invalidVersion.id, JSON.stringify({ ...invalidVersion.checkResult, status: "PASSED", submittable: true, conflictCount: 0, evidence: [] })])
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/dynamic-schedules/${invalidVersion.id}/submit`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision } }, 409)

    const historicalMutation = scheduleItems.map((item, index) => index === 0 ? { ...item, plannedTakeoffTimeMs: item.plannedTakeoffTimeMs + 10_000 } : item)
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/dynamic-schedules`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, mode: "SINGLE", reason: "尝试修改已经开始的任务", items: historicalMutation } }, 409)

    const validItems = scheduleItems.map((item, index) => index === 2 ? { ...item, plannedTakeoffTimeMs: item.plannedTakeoffTimeMs + 60_000 } : item)
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/dynamic-schedules`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, mode: "SINGLE", reason: "推迟尚未开始的第三个配送任务", items: validItems } })
    const validVersion = runtime.dynamicScheduleVersions[0]!
    expect(validVersion).toMatchObject({ mode: "SINGLE", affectedOrderIds: [scheduleItems[2]!.orderId], submittedBy: null })
    expect(validVersion.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(validVersion.checkResult.submittable).toBe(true)
    await database.query(`UPDATE "logistics_dynamic_schedule_versions" SET "contentHash" = $2 WHERE "id" = $1`, [validVersion.id, "0".repeat(64)])
    await errorRequest(`/v3/logistics-projects/${projectId}/runtime/dynamic-schedules/${validVersion.id}/submit`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision } }, 409)
    await database.query(`UPDATE "logistics_dynamic_schedule_versions" SET "contentHash" = $2 WHERE "id" = $1`, [validVersion.id, validVersion.contentHash])
    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/dynamic-schedules/${validVersion.id}/submit`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision } })
    expect(runtime.dynamicScheduleVersions.find((version) => version.id === validVersion.id)).toMatchObject({ status: "SUBMITTED", submittedBy: "张同学", contentHash: validVersion.contentHash })

    runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/clock`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, status: "RUNNING", rate: 3600 } })
    for (let attempt = 0; attempt < 40 && runtime.session.status !== "COMPLETED"; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
    }
    expect(runtime.session.status).toBe("COMPLETED")
    expect(runtime.summary.completedOrders + runtime.summary.delayedOrders).toBe(3)
    runtimeStages = await jsonRequest<{ currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(runtimeStages.currentStageCode).toBe("LOGISTICS_EMERGENCY_HANDLING")
    const emergencyStage = runtimeStages.stages.find((stage) => stage.stageCode === "LOGISTICS_EMERGENCY_HANDLING")!
    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_EMERGENCY_HANDLING/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: emergencyStage.revision } })
    await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime/emergency-handling/complete`, { method: "POST", cookie: studentCookie })
    runtimeStages = await jsonRequest<{ currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(runtimeStages.currentStageCode).toBe("LOGISTICS_REVIEW")

    const reviewStage = runtimeStages.stages.find((stage) => stage.stageCode === "LOGISTICS_REVIEW")!
    await jsonRequest(`/v3/projects/${projectId}/stages/LOGISTICS_REVIEW/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: reviewStage.revision } })
    const frozenSnapshot = await jsonRequest<{
      mapResourceVersion: string
      sceneResourceVersion: string
      planVersion: string
      config: { scenarioOverlayVersionId?: string | null }
    }>(`/v3/assignments/${project.assignmentSnapshotId}/snapshot`, { cookie: studentCookie })
    let review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review`, { cookie: studentCookie })
    const frozenReviewFields = {
      mapResourceVersion: frozenSnapshot.mapResourceVersion,
      sceneResourceVersion: frozenSnapshot.sceneResourceVersion,
      planVersion: frozenSnapshot.planVersion,
      scenarioOverlayVersionId: frozenSnapshot.config.scenarioOverlayVersionId ?? null
    }
    expect(review).toMatchObject(frozenReviewFields)
    expect(Object.keys(review)).toEqual(expect.arrayContaining(Object.keys(frozenReviewFields)))
    expect(review.evaluation.objectiveMetrics.map((item) => item.code)).toEqual(expect.arrayContaining(["ROUTE_VALIDATION", "SCHEDULE_QUALITY", "ORDER_COMPLETION", "EVENT_CONTROL", "DYNAMIC_RESCHEDULE"]))
    expect(review.logisticsAnalysis).toMatchObject({
      routeValidation: { code: "ROUTE_VALIDATION" },
      onTimeDelivery: { code: "ON_TIME_DELIVERY" },
      runtimeConflicts: { code: "RUNTIME_CONFLICTS" },
      aircraftUtilization: { code: "AIRCRAFT_UTILIZATION" },
      abnormalResponse: { code: "ABNORMAL_RESPONSE" },
      rescheduleOutcome: { code: "RESCHEDULE_OUTCOME", state: "PASS" }
    })
    expect(review.logisticsAnalysis?.rescheduleOutcome.metrics.find((item) => item.code === "SUBMITTED_VERSIONS")?.value).toBe(1)
    expect(review.replay).toMatchObject({ sceneType: "CITY_LOGISTICS" })
    expect(review.replay?.frames.length).toBeGreaterThan(0)
    expect(review.timeline.map((item) => item.payload.milestone)).toEqual(expect.arrayContaining(["ORDER_RELEASED", "TASK_ASSIGNED", "TAKEOFF", "ARRIVAL", "RETURN", "LANDING"]))
    expect(review.cohortAnalytics).toBeNull()
    await database.query(`UPDATE "assignment_drafts" SET "title" = "title" || ' · draft mutation' WHERE "id" = $1`, [assignmentId])
    const frozenRubricVersion = review.evaluation.rubricVersion
    const frozenTeacherScores = structuredClone(review.evaluation.teacherScores)
    const reportResource = selectedResources.find((resource) => resource.packageType === "REPORT")!
    await upgradeReportResource(reportResource.id)
    review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review`, { cookie: studentCookie })
    expect(review).toMatchObject(frozenReviewFields)
    expect(review.evaluation.rubricVersion).toBe(frozenRubricVersion)
    expect(review.evaluation.teacherScores).toEqual(frozenTeacherScores)
    review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review/summary/submit`, { method: "POST", cookie: studentCookie, body: { expectedRevision: review.evaluation.revision, summary: "", structuredSummary: { originalPlanProblems: "原方案对异常后的订单时序预留不足。", responseLessons: "能够识别航线异常并保持在航任务安全，但重排时机仍可提前。", routeAdjustmentSuggestions: "为受影响配送点预留同方向且已验证的备用航线。", schedulingOptimization: "按订单优先级和无人机下一可用时间滚动调整未执行任务。", improvements: "提前设置延误阈值，并在提交重调度前复核航线和硬冲突证据。" } } })
    expect(review.evaluation.studentSubmittedAt).not.toBeNull()
    expect(review.evaluation.logisticsStudentSummaryStructured).toMatchObject({ originalPlanProblems: expect.stringContaining("时序预留不足"), schedulingOptimization: expect.stringContaining("下一可用时间") })
    const logisticsProgress = await jsonRequest<Array<{
      projectId: string
      milestones: Array<{ code: string; state: string; detail: string }>
    }>>("/v3/teaching/progress?sceneType=CITY_LOGISTICS&includeInternalData=true", { cookie: teacherCookie })
    expect(logisticsProgress.find((item) => item.projectId === projectId)?.milestones).toEqual([
      expect.objectContaining({ code: "LOGISTICS_ROUTE_SUBMISSION", state: "SUBMITTED" }),
      expect.objectContaining({ code: "LOGISTICS_ROUTE_VALIDATION", state: expect.stringMatching(/PASSED|WITH_RISK/) }),
      expect.objectContaining({ code: "LOGISTICS_SCHEDULE", state: "SUBMITTED" }),
      expect.objectContaining({ code: "LOGISTICS_RUNTIME", state: "COMPLETED" }),
      expect.objectContaining({ code: "LOGISTICS_REVIEW", state: "SUBMITTED" })
    ])
    await errorRequest("/v3/teaching/progress?sceneType=CITY_LOGISTICS", { cookie: studentCookie }, 403)
    review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review`, { cookie: teacherCookie })
    expect(review.cohortAnalytics).toMatchObject({ assignmentId, projectCount: 2, publishedCount: 0 })
    await errorRequest(`/v3/logistics-projects/${projectId}/review/evaluation`, { method: "PUT", cookie: studentCookie, body: { expectedRevision: review.evaluation.revision, teacherScores: review.evaluation.teacherScores, summary: "学生不能填写教师综合评价内容" } }, 403)
    await errorRequest(`/v3/logistics-projects/${projectId}/review/evaluation/publish`, { method: "POST", cookie: studentCookie, body: { expectedRevision: review.evaluation.revision } }, 403)
    const reviewedScores = review.evaluation.teacherScores.map((item) => ({ ...item, score: item.maxScore, comment: "已结合运行数据完成核定" }))
    review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review/evaluation`, { method: "PUT", cookie: teacherCookie, body: { expectedRevision: review.evaluation.revision, teacherScores: reviewedScores, summary: "航线与调度方案满足教学约束，能够根据运行事件完成复盘，建议继续强化延误订单的提前识别。" } })
    expect(review.evaluation.totalScore).toBe(100)
    review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review/evaluation/publish`, { method: "POST", cookie: teacherCookie, body: { expectedRevision: review.evaluation.revision } })
    expect(review.evaluation.status).toBe("PUBLISHED")
    expect(review.cohortAnalytics).toMatchObject({ assignmentId, projectCount: 2, completedCount: 1, publishedCount: 1, averageScore: 100 })
    const routeEventType = review.cohortAnalytics?.eventTypes.find((item) => item.code === "ROUTE_OPERATION")
    expect(routeEventType?.count).toBeGreaterThanOrEqual(2)
    review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review/report/generate`, { method: "POST", cookie: teacherCookie, body: { format: "PDF" } })
    expect(review.report).toMatchObject({ status: "FINAL", format: "PDF" })
    const pdfReportResponse = await fetch(`${baseUrl}/v3/logistics-projects/${projectId}/review/report/download`, { headers: { Cookie: teacherCookie } })
    expect(pdfReportResponse.status).toBe(200)
    expect(pdfReportResponse.headers.get("content-type")).toContain("application/pdf")
    expect(Buffer.from(await pdfReportResponse.arrayBuffer()).subarray(0, 5).toString("ascii")).toBe("%PDF-")
    review = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review/report/generate`, { method: "POST", cookie: teacherCookie, body: { format: "DOCX" } })
    expect(review.report).toMatchObject({ status: "FINAL", format: "DOCX" })
    const docxReportResponse = await fetch(`${baseUrl}/v3/logistics-projects/${projectId}/review/report/download`, { headers: { Cookie: teacherCookie } })
    expect(docxReportResponse.status).toBe(200)
    expect(docxReportResponse.headers.get("content-type")).toContain("wordprocessingml")
    expect(Buffer.from(await docxReportResponse.arrayBuffer()).subarray(0, 2).toString("ascii")).toBe("PK")

    await database.query(`
      UPDATE "assignment_snapshots"
      SET "mode" = 'ASSESSMENT',
          "config" = jsonb_set("config", '{resultVisibility}', '"TOTAL_ONLY"'::jsonb)
      WHERE "draftId" = $1
    `, [assignmentId])
    await database.query(`
      UPDATE "student_projects"
      SET "assessmentStartedAt" = now() - interval '2 hours',
          "assessmentDeadlineAt" = now() - interval '1 minute',
          "assessmentEndedAt" = NULL
      WHERE "id" = $1
    `, [projectId])
    const expiredRouteWrite = await fetch(`${baseUrl}/v3/logistics-projects/${projectId}/route-plan/check`, {
      method: "POST",
      headers: { Cookie: studentCookie }
    })
    expect(expiredRouteWrite.status).toBe(409)
    expect(await expiredRouteWrite.json()).toMatchObject({ message: expect.stringContaining("考核时间已结束") })
    const studentRestrictedReview = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review`, { cookie: studentCookie })
    expect(studentRestrictedReview).toMatchObject({
      actor: "STUDENT",
      resultVisibility: "TOTAL_ONLY",
      canAccessReport: false,
      timeline: [],
      replay: null,
      logisticsAnalysis: null,
      annotations: [],
      report: null
    })
    expect(studentRestrictedReview.evaluation).toMatchObject({ totalScore: 100, objectiveMetrics: [], teacherScores: [], summary: "" })
    const totalOnlyReportResponse = await fetch(`${baseUrl}/v3/logistics-projects/${projectId}/review/report/download`, { headers: { Cookie: studentCookie } })
    expect(totalOnlyReportResponse.status).toBe(403)
    const teacherFullReview = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review`, { cookie: teacherCookie })
    expect(teacherFullReview).toMatchObject({ actor: "TEACHER", resultVisibility: "TOTAL_ONLY", canAccessReport: true })
    expect(teacherFullReview.replay?.frames.length).toBeGreaterThan(0)
    expect(teacherFullReview.logisticsAnalysis?.runtimeConflicts.code).toBe("RUNTIME_CONFLICTS")

    await database.query(`
      UPDATE "assignment_snapshots"
      SET "config" = jsonb_set("config", '{resultVisibility}', '"DIMENSIONS"'::jsonb)
      WHERE "draftId" = $1
    `, [assignmentId])
    const studentDimensionReview = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review`, { cookie: studentCookie })
    expect(studentDimensionReview).toMatchObject({ actor: "STUDENT", resultVisibility: "DIMENSIONS", canAccessReport: false, timeline: [], replay: null, logisticsAnalysis: null, annotations: [], report: null })
    expect(studentDimensionReview.evaluation).toMatchObject({ totalScore: 100, objectiveMetrics: [], summary: "" })
    expect(studentDimensionReview.evaluation.teacherScores).toHaveLength(reviewedScores.length)
    expect(studentDimensionReview.evaluation.teacherScores.every((item) => item.score !== null && item.comment === "")).toBe(true)
    const dimensionReportResponse = await fetch(`${baseUrl}/v3/logistics-projects/${projectId}/review/report/download`, { headers: { Cookie: studentCookie } })
    expect(dimensionReportResponse.status).toBe(403)

    await database.query(`
      UPDATE "assignment_snapshots"
      SET "config" = jsonb_set("config", '{resultVisibility}', '"FULL_REVIEW"'::jsonb)
      WHERE "draftId" = $1
    `, [assignmentId])
    const studentFullReview = await jsonRequest<ShowReviewWorkspaceView>(`/v3/logistics-projects/${projectId}/review`, { cookie: studentCookie })
    expect(studentFullReview).toMatchObject({ actor: "STUDENT", resultVisibility: "FULL_REVIEW", canAccessReport: true })
    expect(studentFullReview.evaluation).toMatchObject({ totalScore: 100, summary: expect.stringContaining("延误订单"), logisticsStudentSummaryStructured: expect.objectContaining({ originalPlanProblems: expect.stringContaining("时序预留不足") }) })
    expect(studentFullReview.evaluation.teacherScores).toEqual(reviewedScores)
    expect(studentFullReview.timeline.length).toBeGreaterThan(0)
    expect(studentFullReview.replay?.frames.length).toBeGreaterThan(0)
    expect(studentFullReview.logisticsAnalysis?.runtimeConflicts.code).toBe("RUNTIME_CONFLICTS")
    expect(studentFullReview.report).toMatchObject({ status: "FINAL", format: "DOCX" })
    const fullReviewReportResponse = await fetch(`${baseUrl}/v3/logistics-projects/${projectId}/review/report/download`, { headers: { Cookie: studentCookie } })
    expect(fullReviewReportResponse.status).toBe(200)
    expect(fullReviewReportResponse.headers.get("content-type")).toContain("wordprocessingml")

    const rows = await database.query(`SELECT (SELECT count(*)::int FROM "logistics_routes" route WHERE route."versionId" = $1) AS routes, (SELECT count(*)::int FROM "logistics_waypoints" waypoint JOIN "logistics_routes" route ON route."id" = waypoint."routeId" WHERE route."versionId" = $1) AS waypoints`, [validatedVersion.id]) as Array<{ routes: number; waypoints: number }>
    expect(rows[0]).toEqual({ routes: 4, waypoints: 16 })
    const scheduleRows = await database.query(`SELECT (SELECT count(*)::int FROM "logistics_orders" orders JOIN "logistics_order_batches" batch ON batch."id" = orders."batchId" WHERE batch."projectId" = $1) AS orders, (SELECT count(*)::int FROM "logistics_aircraft_instances" aircraft WHERE aircraft."projectId" = $1) AS aircraft, (SELECT count(*)::int FROM "logistics_dispatch_items" item WHERE item."versionId" = $2) AS dispatches`, [projectId, scheduleVersion.id]) as Array<{ orders: number; aircraft: number; dispatches: number }>
    expect(scheduleRows[0]).toEqual({ orders: 3, aircraft: 3, dispatches: 3 })
    const runtimeRows = await database.query(`SELECT (SELECT count(*)::int FROM "logistics_runtime_readiness" WHERE "projectId" = $1) AS readiness, (SELECT count(*)::int FROM "logistics_runtime_snapshots" WHERE "projectId" = $1) AS snapshots, (SELECT count(*)::int FROM "logistics_dynamic_schedule_versions" WHERE "projectId" = $1) AS versions`, [projectId]) as Array<{ readiness: number; snapshots: number; versions: number }>
    expect(runtimeRows[0]!.readiness).toBe(1)
    expect(runtimeRows[0]!.snapshots).toBeGreaterThanOrEqual(4)
    expect(runtimeRows[0]!.versions).toBe(2)
    const activities = await jsonRequest<Array<{ eventType: string }>>(`/v3/projects/${projectId}/activities`, { cookie: teacherCookie })
    expect(activities.map((event) => event.eventType)).toEqual(expect.arrayContaining(["LOGISTICS_REGION_CONFIRMED", "LOGISTICS_ROUTE_DRAFT_SAVED", "LOGISTICS_ROUTE_CHECKED", "LOGISTICS_ROUTE_VERSION_CREATED", "LOGISTICS_ROUTE_VALIDATED", "LOGISTICS_ROUTE_PLAN_SUBMITTED", "LOGISTICS_ORDER_BATCH_GENERATED", "LOGISTICS_SCHEDULE_DRAFT_SAVED", "LOGISTICS_SCHEDULE_CHECKED", "LOGISTICS_SCHEDULE_VERSION_CREATED", "LOGISTICS_INITIAL_SCHEDULE_SUBMITTED", "LOGISTICS_READINESS_CONFIRMED", "LOGISTICS_RUNTIME_SESSION_CREATED", "LOGISTICS_RUNTIME_STARTED", "TEACHER_RUNTIME_INTERVENTION", "LOGISTICS_DYNAMIC_SCHEDULE_CREATED", "LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED", "LOGISTICS_RUNTIME_COMPLETED", "LOGISTICS_REVIEW_SUMMARY_SUBMITTED", "LOGISTICS_EVALUATION_SAVED", "LOGISTICS_EVALUATION_PUBLISHED", "LOGISTICS_REPORT_GENERATED"]))
  }, 60_000)

  async function upgradeReportResource(previousPackageId: string): Promise<void> {
    upgradedReportPreviousPackageId = previousPackageId
    upgradedReportPackageId = randomUUID()
    const upgradedVersion = `2.0.${Date.now()}`
    await database.query(`UPDATE "resource_packages" SET "status" = 'RETIRED', "retiredAt" = NOW() WHERE "id" = $1`, [previousPackageId])
    await database.query(`
      INSERT INTO "resource_packages" (
        "id", "packageType", "name", "version", "schemaVersion", "minimumPlatformVersion", "sha256",
        "status", "source", "manifest", "archiveManifest", "archiveAssetId", "signatureKeyId",
        "validationChecks", "validatedAt", "rejectionReason", "createdById", "activatedAt", "retiredAt"
      )
      SELECT $2, "packageType", "name", $3, "schemaVersion", "minimumPlatformVersion", $4,
        'ACTIVE', 'BUILT_IN', $5::jsonb, NULL, NULL, NULL, '[]'::jsonb, NOW(), NULL, "createdById", NOW(), NULL
      FROM "resource_packages" WHERE "id" = $1
    `, [previousPackageId, upgradedReportPackageId, upgradedVersion, "b".repeat(64), JSON.stringify({
      outputs: ["SINGLE_PDF"],
      rubrics: [{
        sceneType: "CITY_LOGISTICS",
        version: upgradedVersion,
        title: "升级后的物流评价量表",
        sourceReferences: ["升级验证"],
        items: [
          { code: "UPGRADED_PLANNING", label: "升级规划项", maxScore: 50, sourceReferences: ["升级验证"] },
          { code: "UPGRADED_OPERATION", label: "升级运行项", maxScore: 50, sourceReferences: ["升级验证"] }
        ]
      }]
    })])
  }

  async function waitForSimulationWindow(minimumTimeMs: number, maximumTimeMs: number): Promise<LogisticsRuntimeWorkspaceView> {
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25))
      const runtime = await jsonRequest<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${projectId}/runtime-workspace`, { cookie: studentCookie })
      if (runtime.session.simulationTimeMs >= maximumTimeMs) throw new Error("仿真时钟越过动态调度验证窗口")
      if (runtime.session.simulationTimeMs > minimumTimeMs) return runtime
    }
    throw new Error("仿真时钟未进入动态调度验证窗口")
  }

  async function login(email: string, password: string): Promise<string> {
    const response = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
    expect(response.status, await response.clone().text()).toBe(201)
    return response.headers.get("set-cookie")!.split(";", 1)[0]!
  }

  async function readSseSnapshot(lastEventId?: number): Promise<{
    revision: number
    resumedFromRevision: number | null
    workspace: { session: { revision: number } }
  }> {
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/v3/logistics-projects/${projectId}/runtime/stream`, {
      headers: { Cookie: studentCookie, ...(lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) }) },
      signal: controller.signal
    })
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("物流运行流没有响应体")
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        let timeout: NodeJS.Timeout | null = null
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("等待物流运行流首帧超时")), 5_000)
          })
        ])
        if (timeout) clearTimeout(timeout)
        if (result.done) throw new Error("物流运行流在首帧前关闭")
        buffer += decoder.decode(result.value, { stream: true })
        const frameEnd = buffer.indexOf("\n\n")
        if (frameEnd < 0) continue
        const frame = buffer.slice(0, frameEnd)
        const eventName = frame.split("\n").find((line) => line.startsWith("event: "))?.slice(7)
        if (eventName !== "snapshot") continue
        const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6)
        if (!data) throw new Error("物流运行流快照缺少 data")
        return JSON.parse(data) as {
          revision: number
          resumedFromRevision: number | null
          workspace: { session: { revision: number } }
        }
      }
    } finally {
      controller.abort()
      await reader.cancel().catch(() => undefined)
    }
  }

  async function findClassroomWithStudents(classes: Array<{ id: string }>) {
    for (const classroom of classes) {
      const students = await jsonRequest<unknown[]>(`/v1/education/classes/${classroom.id}/students`, { cookie: teacherCookie })
      if (students.length > 0) return classroom
    }
    throw new Error("集成测试没有找到包含学生的班级")
  }

  async function jsonRequest<T>(path: string, options: { method?: string; cookie: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers: { Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
    const body = await response.json() as unknown
    expect(response.status, `${JSON.stringify(body)}\n${serverOutput}`).toBeLessThan(400)
    return body as T
  }

  async function errorRequest(path: string, options: { method?: string; cookie: string; body?: unknown }, expectedStatus: number): Promise<void> {
    const response = await fetch(`${baseUrl}${path}`, { method: options.method ?? "GET", headers: { Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) })
    expect(response.status, `${await response.clone().text()}\n${serverOutput}`).toBe(expectedStatus)
  }

  async function waitForServer(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) throw new Error(`R4 集成服务提前退出：${serverProcess.exitCode}\n${serverOutput}`)
      try {
        const response = await fetch(`${baseUrl}/auth/me`)
        if (response.status === 401) return
      } catch {
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error(`等待 R4 集成服务启动超时\n${serverOutput}`)
  }
})

function findPassingRoutes(region: V3RegionCatalogItem): { delivery: V3LogisticsNode; routes: LogisticsRouteInput[] } {
  const deliveries = (region.logisticsNodes ?? []).filter((node) => node.type === "DELIVERY_POINT" && node.position).sort((left, right) => distance(left.position!, region.center) - distance(right.position!, region.center))
  const longitudeSpan = Math.max(...region.boundary.map((point) => point.longitude)) - Math.min(...region.boundary.map((point) => point.longitude))
  const latitudeSpan = Math.max(...region.boundary.map((point) => point.latitude)) - Math.min(...region.boundary.map((point) => point.latitude))
  for (const delivery of deliveries) {
    for (const lane of [-0.18, 0.18, -0.3, 0.3]) {
      const routes = fixtureRoutes(region, delivery, longitudeSpan, latitudeSpan, lane)
      const result = checkLogisticsRoutePlan(routes, { region, selectedDeliveryPointIds: [delivery.id], aircraft })
      if (result.passed) return { delivery, routes }
    }
  }
  throw new Error("测试区域中未找到可通过规则检查的自主往返航线")
}

function reportSupportsScene(manifest: Record<string, unknown>, sceneType: string): boolean {
  return Array.isArray(manifest.rubrics) && manifest.rubrics.some((rubric) => {
    return typeof rubric === "object" && rubric !== null && (rubric as Record<string, unknown>).sceneType === sceneType
  })
}

function fixtureRoutes(region: V3RegionCatalogItem, delivery: V3LogisticsNode, longitudeSpan: number, latitudeSpan: number, lane: number): LogisticsRouteInput[] {
  const takeoff = node(region, "TAKEOFF_POINT")
  const landing = node(region, "LANDING_POINT")
  const waiting = node(region, "WAITING_POINT")
  const alternate = node(region, "ALTERNATE_LANDING_POINT")
  const emergency = node(region, "EMERGENCY_AREA")
  const laneLatitude = region.center.latitude + latitudeSpan * lane
  const outboundId = `outbound-${delivery.id}`
  const returnId = `return-${delivery.id}`
  const alternateOutboundId = `alternate-outbound-${delivery.id}`
  const alternateReturnId = `alternate-return-${delivery.id}`
  const outbound = route(outboundId, delivery, "OUTBOUND", takeoff.id, delivery.id, [
    waypoint(`${outboundId}-1`, takeoff.position!, 0, true, takeoff.id),
    waypoint(`${outboundId}-2`, { longitude: region.center.longitude - longitudeSpan * 0.08, latitude: laneLatitude }, 45),
    waypoint(`${outboundId}-3`, { longitude: delivery.position!.longitude - longitudeSpan * 0.05, latitude: laneLatitude }, 50),
    waypoint(`${outboundId}-4`, delivery.position!, 0, true, delivery.id)
  ], waiting.id, alternate.id, emergency.id)
  const inbound = route(returnId, delivery, "RETURN", delivery.id, landing.id, [
    waypoint(`${returnId}-1`, delivery.position!, 0, true, delivery.id),
    waypoint(`${returnId}-2`, { longitude: delivery.position!.longitude + longitudeSpan * 0.05, latitude: laneLatitude + latitudeSpan * 0.035 }, 50),
    waypoint(`${returnId}-3`, { longitude: region.center.longitude + longitudeSpan * 0.08, latitude: laneLatitude + latitudeSpan * 0.035 }, 45),
    waypoint(`${returnId}-4`, landing.position!, 0, true, landing.id)
  ], waiting.id, alternate.id, emergency.id)
  const alternateLaneLatitude = laneLatitude + latitudeSpan * 0.08
  const alternateOutbound = route(alternateOutboundId, delivery, "OUTBOUND", takeoff.id, delivery.id, [
    waypoint(`${alternateOutboundId}-1`, takeoff.position!, 0, true, takeoff.id),
    waypoint(`${alternateOutboundId}-2`, { longitude: region.center.longitude - longitudeSpan * 0.04, latitude: alternateLaneLatitude }, 42),
    waypoint(`${alternateOutboundId}-3`, { longitude: delivery.position!.longitude - longitudeSpan * 0.03, latitude: alternateLaneLatitude }, 48),
    waypoint(`${alternateOutboundId}-4`, delivery.position!, 0, true, delivery.id)
  ], waiting.id, alternate.id, emergency.id, "ALTERNATE")
  const alternateInbound = route(alternateReturnId, delivery, "RETURN", delivery.id, landing.id, [
    waypoint(`${alternateReturnId}-1`, delivery.position!, 0, true, delivery.id),
    waypoint(`${alternateReturnId}-2`, { longitude: delivery.position!.longitude + longitudeSpan * 0.03, latitude: alternateLaneLatitude + latitudeSpan * 0.025 }, 48),
    waypoint(`${alternateReturnId}-3`, { longitude: region.center.longitude + longitudeSpan * 0.04, latitude: alternateLaneLatitude + latitudeSpan * 0.025 }, 42),
    waypoint(`${alternateReturnId}-4`, landing.position!, 0, true, landing.id)
  ], waiting.id, alternate.id, emergency.id, "ALTERNATE")
  return [outbound, inbound, alternateOutbound, alternateInbound]
}

function route(id: string, delivery: V3LogisticsNode, direction: "OUTBOUND" | "RETURN", departureNodeId: string, arrivalNodeId: string, waypoints: LogisticsRouteInput["waypoints"], waitingNodeId: string, alternateNodeId: string, emergencyNodeId: string, role: LogisticsRouteInput["role"] = "PRIMARY"): LogisticsRouteInput {
  return { id, name: `${delivery.name}-${role === "ALTERNATE" ? "备用" : "主"}-${direction}`, destinationNodeId: delivery.id, direction, role, groupCode: "G-01", departureNodeId, arrivalNodeId, protectionRadiusMeters: 30, waitingNodeIds: [waitingNodeId], alternateLandingNodeIds: [alternateNodeId], emergencyAreaNodeIds: [emergencyNodeId], entryDirectionDegrees: 90, exitDirectionDegrees: 270, waypoints }
}

async function insertRouteRuntimeEvent(database: DataSource, input: {
  projectId: string
  sessionId: string
  simulationTimeMs: number
  affectedRouteIds: string[]
  affectedOrderIds: string[]
  recommendedActions: string[]
  code: string
}): Promise<string> {
  const eventId = randomUUID()
  await database.query(`
    INSERT INTO "runtime_events" (
      "id", "projectId", "sessionId", "stageCode", "code", "category", "status", "severity",
      "scheduledSimulationTimeMs", "triggeredAt", "resolvedAt", "payload", "correlationId"
    ) VALUES ($1, $2, $3, 'LOGISTICS_EMERGENCY_HANDLING', $4, 'ROUTE_OPERATION', 'ACTIVE', 'WARNING', $5, NOW(), NULL, $6::jsonb, $7)
  `, [eventId, input.projectId, input.sessionId, input.code, input.simulationTimeMs, JSON.stringify({
    title: input.code,
    detail: "STU-025 航线处置集成验证事件",
    lifecycleStatus: "DISCOVERED",
    affectedAircraftIds: [],
    affectedOrderIds: input.affectedOrderIds,
    affectedRouteIds: input.affectedRouteIds,
    recommendedActions: input.recommendedActions,
    detectionAtSimulationTimeMs: input.simulationTimeMs,
    detectedSimulationTimeMs: input.simulationTimeMs,
    escalationAtSimulationTimeMs: input.simulationTimeMs + 60_000,
    autoRecoveryAtSimulationTimeMs: null,
    recoveryMode: "STUDENT",
    scenarioConfig: null,
    visibilityMode: "DIRECT",
    actionDeadlineSeconds: 60,
    actionDeadlineAtSimulationTimeMs: input.simulationTimeMs + 60_000,
    followUpEventCode: null,
    recoveryCondition: null,
    controlledSimulationTimeMs: null,
    escalationCount: 0
  }), randomUUID()])
  return eventId
}

async function resolveRuntimeEvent(database: DataSource, eventId: string): Promise<void> {
  await database.query(`UPDATE "runtime_events" SET "status" = 'RESOLVED', "resolvedAt" = NOW(), "payload" = "payload" || '{"lifecycleStatus":"CONTROLLED"}'::jsonb WHERE "id" = $1`, [eventId])
}

function waypoint(id: string, position: V3Coordinate, altitudeMeters: number, locked = false, nodeId: string | null = null) {
  return { id, name: id, position: { ...position }, altitudeMeters, segmentAltitudeMeters: 45, speedMps: 12, nodeId, locked }
}

function node(region: V3RegionCatalogItem, type: V3LogisticsNode["type"]): V3LogisticsNode {
  return region.logisticsNodes!.find((item) => item.type === type && item.enabled)!
}

function distance(left: V3Coordinate, right: V3Coordinate): number {
  return Math.hypot((left.longitude - right.longitude) * 102_000, (left.latitude - right.latitude) * 111_000)
}

const aircraft: LogisticsAircraftCapabilityView = {
  modelCode: "TEACHING-UAV-01",
  cruiseSpeedMps: 12,
  maximumSpeedMps: 18,
  maximumHeightMeters: 120,
  maximumRoundTripMeters: 12_000,
  minimumReserveBatteryPercent: 20,
  climbRateMps: 3,
  ruleVersion: "LOGISTICS-ROUTE-1.0.0"
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("无法分配集成测试端口"))
        return
      }
      server.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}
