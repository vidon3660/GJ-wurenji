import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DataSource } from "typeorm"
import type { V3TeacherProgressItem } from "@wurenji/shared"
import { integrationServerEntry, integrationWorkerEntry } from "../integration-server-entry.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("VTL R12 vertical inspection end-to-end integration", () => {
  let serverProcess: ChildProcess
  let workerProcess: ChildProcess
  let baseUrl = ""
  let serverOutput = ""
  let workerOutput = ""
  let storageDirectory = ""
  let database: DataSource
  let teacherCookie = ""
  let studentCookie = ""
  let draftId = ""
  let projectId = ""

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), "wurenji-vtl-r12-"))
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
        V3_FILE_STORAGE_PROVIDER: "LOCAL",
        V3_FILE_STORAGE_DIR: storageDirectory,
        ONLYOFFICE_PUBLIC_URL: "http://localhost:58080",
        ONLYOFFICE_INTERNAL_URL: "http://localhost:58080",
        ONLYOFFICE_JWT_SECRET: "vtl-r12-onlyoffice-secret",
        V3_INTERNAL_API_URL: baseUrl
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    serverProcess.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    serverProcess.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    await waitForServer()
    database = new DataSource({ type: "postgres", url: process.env.V3_INTEGRATION_DATABASE_URL! })
    await database.initialize()
    workerProcess = spawn(process.execPath, [integrationWorkerEntry(server.cwd)], {
      cwd: server.cwd,
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABASE_URL: process.env.V3_INTEGRATION_DATABASE_URL,
        TYPEORM_SYNCHRONIZE: "false",
        V3_FILE_STORAGE_PROVIDER: "LOCAL",
        V3_FILE_STORAGE_DIR: storageDirectory,
        WORKER_POLL_INTERVAL_MS: "100",
        WORKER_ERROR_DELAY_MS: "100"
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    workerProcess.stdout?.on("data", (chunk: Buffer) => { workerOutput += chunk.toString("utf8") })
    workerProcess.stderr?.on("data", (chunk: Buffer) => { workerOutput += chunk.toString("utf8") })
    await waitForWorker()
    teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
    studentCookie = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
  }, 30_000)

  afterAll(async () => {
    if (workerProcess && !workerProcess.killed) workerProcess.kill()
    if (serverProcess && !serverProcess.killed) serverProcess.kill()
    if (database?.isInitialized) {
      if (draftId) {
        const projectRows = await database.query<{ id: string }>(`SELECT "id" FROM "student_projects" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        const projectIds = [...new Set([projectId, ...projectRows.map((row) => row.id)].filter(Boolean))]
        for (const currentProjectId of projectIds) {
          await database.query(`DELETE FROM "jobs" WHERE "sourceOutboxEventId" IN (SELECT "id" FROM "outbox_events" WHERE "aggregateType" = 'VTOL_PROJECT' AND "aggregateId" = $1)`, [currentProjectId])
          await database.query(`DELETE FROM "outbox_events" WHERE "aggregateType" = 'VTOL_PROJECT' AND "aggregateId" = $1`, [currentProjectId])
        }
        await database.query(`DELETE FROM "student_projects" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_targets" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_snapshot_resource_revisions" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_snapshots" WHERE "draftId" = $1`, [draftId])
        await database.query(`DELETE FROM "assignment_drafts" WHERE "id" = $1`, [draftId])
      } else if (projectId) {
        await database.query(`DELETE FROM "jobs" WHERE "sourceOutboxEventId" IN (SELECT "id" FROM "outbox_events" WHERE "aggregateType" = 'VTOL_PROJECT' AND "aggregateId" = $1)`, [projectId])
        await database.query(`DELETE FROM "outbox_events" WHERE "aggregateType" = 'VTOL_PROJECT' AND "aggregateId" = $1`, [projectId])
        await database.query(`DELETE FROM "student_projects" WHERE "id" = $1`, [projectId])
      }
      await database.destroy()
    }
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true })
  })

  it("completes VTL-001 through VTL-008 and preserves replay/report evidence", async () => {
    const resources = await jsonRequest<Array<{ id: string; packageType: string; status: string; name: string; source: string; manifest: Record<string, unknown> }>>("/v3/resource-packages", { cookie: teacherCookie })
    const regions = await jsonRequest<Array<{
      packageId: string
      center: Coordinate
      boundary: Coordinate[]
      vtlTaskObjects: TaskObject[]
      vtlLandingSites: LandingSite[]
    }>>("/v3/resource-packages/regions/catalog?sceneType=VTOL_INSPECTION", { cookie: teacherCookie })
    const region = regions[0]
    expect(region).toBeTruthy()
    expect(region!.vtlTaskObjects.length).toBeGreaterThanOrEqual(5)
    expect(region!.vtlLandingSites.some((site) => site.type === "MAIN")).toBe(true)

    const activeResources = resources.filter((resource) => resource.status === "ACTIVE" && resource.source === "BUILT_IN")
    const selectedResources = [
      activeResources.find((resource) => resource.packageType === "RULE"),
      activeResources.find((resource) => resource.packageType === "REGION" && resource.id === region!.packageId),
      activeResources.find((resource) => resource.packageType === "SCALE_TEMPLATE" && resource.manifest.sceneType === "VTOL_INSPECTION"),
      activeResources.find((resource) => resource.packageType === "AIRCRAFT"),
      activeResources.find((resource) => resource.packageType === "EVENT" && resource.manifest.sceneType === "VTOL_INSPECTION"),
      activeResources.find((resource) => resource.packageType === "REPORT" && resource.source === "BUILT_IN" && resource.name === "V3 统一评价报告")
    ].filter((resource): resource is NonNullable<typeof resource> => Boolean(resource))
    expect(new Set(selectedResources.map((resource) => resource.packageType))).toEqual(new Set(["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"]))

    const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
    const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
      method: "POST",
      cookie: teacherCookie,
      body: {
        title: `R12 垂起巡检全流程 ${randomUUID()}`,
        sceneType: "VTOL_INSPECTION",
        mode: "TRAINING",
        isAcceptanceData: true,
        config: {
          taskBrief: "完成广域巡检任务分区、八阶段航线、运行处置和复盘评价。",
          scaleTemplateCode: "VTL_5",
          regionPackageId: region!.packageId,
          availableAt: new Date(Date.now() - 60_000).toISOString(),
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          allowResubmission: true,
          allowedValidationAttempts: 3,
          allowedRuntimeAttempts: 3,
          resultVisibility: "FULL_REVIEW",
          vtlParameters: {
            projectBackground: "丘陵线性目标与点状目标综合巡检教学",
            completionRequirements: "完成五架航空器任务分配、航线规划、检查、运行和事件处置",
            mainLandingSiteId: region!.vtlLandingSites.find((site) => site.type === "MAIN")!.id,
            aircraftModelCode: "VTOL-TEACHING-01",
            aircraftParameterVersion: "1.0.0"
          },
          scenario: {
            simulationClockRate: 3_600,
            vtlRuntimeClockRate: 3_600,
            eventCodes: ["VTL_WEATHER"]
          }
        }
      }
    })
    draftId = draft.id
    const targets = [{ type: "CLASS", targetId: classes[0]!.id }]
    const resourcePackageIds = selectedResources.map((resource) => resource.id)
    const preview = await jsonRequest<{ configHash: string; studentCount: number }>(`/v3/assignments/drafts/${draft.id}/preview`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })
    expect(preview.studentCount).toBeGreaterThanOrEqual(1)
    const preflight = await jsonRequest<{ checkedAt: string; checks: Array<{ code: string; level: string }> }>(`/v3/assignments/drafts/${draft.id}/preflight`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })
    const published = await jsonRequest<{ projectCount: number }>(`/v3/assignments/drafts/${draft.id}/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: {
        expectedRevision: draft.revision,
        configHash: preview.configHash,
        targets,
        resourcePackageIds,
        preflightConfirmation: {
          checkedAt: preflight.checkedAt,
          checkCodes: preflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code)
        }
      }
    })
    expect(published.projectCount).toBeGreaterThanOrEqual(1)

    const projects = await jsonRequest<Array<{ id: string; title: string }>>("/v3/my-projects?includeInternalData=true", { cookie: studentCookie })
    projectId = projects.find((project) => project.title.startsWith("R12 垂起巡检全流程"))!.id
    expect(projectId).toBeTruthy()

    let stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("VTL_AREA_OBJECTS")
    await startStage(stages, "VTL_AREA_OBJECTS")
    let planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: studentCookie })
    expect(planning.plan.taskObjects).toHaveLength(5)
    expect(planning.canConfirmArea).toBe(true)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/area/confirm`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })
    expect(planning.plan.areaConfirmedAt).toBeTruthy()

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(stages, "VTL_TASK_ALLOCATION")
    const taskObjects = planning.plan.taskObjects
    const mainGroup = "VTL-GROUP-1"
    const secondGroup = "VTL-GROUP-2"
    const groups = [
      { id: mainGroup, code: "G-01", title: "北侧巡检组", aircraftIds: ["VTL-AIRCRAFT-01", "VTL-AIRCRAFT-02" ] },
      { id: secondGroup, code: "G-02", title: "南侧巡检组", aircraftIds: ["VTL-AIRCRAFT-03", "VTL-AIRCRAFT-04", "VTL-AIRCRAFT-05"] }
    ]
    const assignments = taskObjects.map((task, index) => ({
      aircraftId: `VTL-AIRCRAFT-${String(index + 1).padStart(2, "0")}`,
      groupId: index < 2 ? mainGroup : secondGroup,
      available: true,
      taskObjectIds: [task.id],
      taskSequence: [task.id]
    }))
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/allocation`, {
      method: "PUT", cookie: studentCookie, body: {
        expectedRevision: planning.plan.revision,
        groups,
        assignments,
        taskZones: [
          { id: "zone-1", title: "北侧任务区", boundary: region!.boundary, groupId: mainGroup, taskObjectIds: taskObjects.slice(0, 2).map((task) => task.id) },
          { id: "zone-2", title: "南侧任务区", boundary: region!.boundary, groupId: secondGroup, taskObjectIds: taskObjects.slice(2).map((task) => task.id) }
        ]
      }
    })
    expect(planning.plan.allocation.valid).toBe(true)
    expect(planning.plan.allocation.groups).toHaveLength(2)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/allocation/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(stages, "VTL_ROUTE_PLANNING")
    const main = planning.plan.landingSites.find((site) => site.type === "MAIN")!
    const alternate = planning.plan.landingSites.find((site) => site.type === "ALTERNATE")!
    for (const [index, assignment] of planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).entries()) {
      const task = planning.plan.taskObjects.find((item) => item.id === assignment.taskObjectIds[0])!
      const taskPosition = task.positions[0]!
      const waypoints = createWaypoints(main.position, taskPosition, task.id, index)
      if (index === 0) {
        waypoints[4]!.altitudeMeters = 10
        waypoints[4]!.position.altitudeMeters = 10
      }
      planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/routes/${assignment.aircraftId}`, {
        method: "PUT", cookie: studentCookie, body: { expectedRevision: planning.plan.revision, waypoints, transitionHeightMeters: 90, alternateLandingSiteId: alternate.id }
      })
    }
    expect(planning.plan.routes).toHaveLength(5)
    expect(planning.plan.routes.every((route) => route.alternateComparison?.landingSiteId === alternate.id)).toBe(true)
    expect(planning.plan.routes.every((route) => route.alternateComparison?.feasible === true)).toBe(true)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/routes/complete`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(stages, "VTL_PLAN_VALIDATION")
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/validate`, { method: "POST", cookie: studentCookie })
    expect(planning.plan.checkResult?.passed).toBe(false)
    expect(planning.plan.checkResult?.blockingIssueCount).toBeGreaterThan(0)
    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("VTL_ROUTE_PLANNING")
    expect(stages.stages.find((stage) => stage.stageCode === "VTL_ROUTE_PLANNING")?.status).toBe("RETURNED")
    expect(stages.stages.find((stage) => stage.stageCode === "VTL_PLAN_VALIDATION")?.status).toBe("LOCKED")
    const blockedProgress = await teacherProgress()
    expect(blockedProgress.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "VTL_ALLOCATION", state: "SUBMITTED" }),
      expect.objectContaining({ code: "VTL_ROUTE", state: "ATTENTION" }),
      expect.objectContaining({ code: "VTL_VALIDATION", state: "ATTENTION" })
    ]))
    await startStage(stages, "VTL_ROUTE_PLANNING")
    const firstAssignment = planning.plan.allocation.assignments.find((item) => item.taskObjectIds.length > 0)!
    const firstTask = planning.plan.taskObjects.find((item) => item.id === firstAssignment.taskObjectIds[0])!
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/routes/${firstAssignment.aircraftId}`, {
      method: "PUT", cookie: studentCookie, body: { expectedRevision: planning.plan.revision, waypoints: createWaypoints(main.position, firstTask.positions[0]!, firstTask.id, 0), transitionHeightMeters: 90, alternateLandingSiteId: alternate.id }
    })
    expect(planning.plan.checkResult).toBeNull()
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/routes/complete`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })
    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(stages, "VTL_PLAN_VALIDATION")
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/validate`, { method: "POST", cookie: studentCookie })
    expect(planning.plan.checkResult?.passed, JSON.stringify(planning.plan.checkResult)).toBe(true)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/validation/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(stages, "VTL_EXECUTION_PLAN")
    const activeAircraftIds = planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).map((item) => item.aircraftId)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/execution-plan/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision, takeoffOrder: activeAircraftIds, landingOrder: [...activeAircraftIds].reverse() }
    })
    expect(planning.plan.executionPlan?.status).toBe("SUBMITTED")
    const plannedProgress = await teacherProgress()
    expect(plannedProgress.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "VTL_ALLOCATION", state: "SUBMITTED" }),
      expect.objectContaining({ code: "VTL_ROUTE", state: "SUBMITTED" }),
      expect.objectContaining({ code: "VTL_VALIDATION", state: "SUBMITTED", detail: "计划已提交" })
    ]))

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(stages, "VTL_RUNTIME")
    let runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
    const sessionCreatedActivities = await database.query<{ eventType: string }[]>(
      `SELECT "eventType" FROM "project_activity_events" WHERE "objectType" = 'RUNTIME_SESSION' AND "objectId" = $1 AND "eventType" = 'RUNTIME_SESSION_CREATED'`,
      [runtime.session.id]
    )
    expect(sessionCreatedActivities).toHaveLength(1)
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/start`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision }
    })
    expect(runtime.session.status).toBe("RUNNING")
    expect(runtime.availableActions.find((action) => action.code === "ACKNOWLEDGE")).toMatchObject({
      enabled: false,
      disabledReason: "当前没有待确认的巡检事件",
      eligibleTargetIds: []
    })
    const holdAction = runtime.availableActions.find((action) => action.code === "HOLD")!
    expect(holdAction.enabled).toBe(true)
    const revisionBeforeRejectedAction = runtime.session.revision
    const actionsBeforeRejectedAction = await database.query<{ count: string }>(`SELECT COUNT(*)::text AS "count" FROM "student_runtime_actions" WHERE "sessionId" = $1 AND "status" = 'APPLIED'`, [runtime.session.id])
    const rejectedAction = await fetch(`${baseUrl}/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST",
      headers: { Cookie: studentCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: revisionBeforeRejectedAction, requestId: randomUUID(), actionCode: "HOLD", targetId: holdAction.eligibleTargetIds[0] })
    })
    expect(rejectedAction.status, await rejectedAction.clone().text()).toBe(400)
    await rejectedAction.text()
    const sessionAfterRejectedAction = await database.query<{ revision: number }>(`SELECT "revision" FROM "runtime_sessions" WHERE "id" = $1`, [runtime.session.id])
    const actionsAfterRejectedAction = await database.query<{ count: string }>(`SELECT COUNT(*)::text AS "count" FROM "student_runtime_actions" WHERE "sessionId" = $1 AND "status" = 'APPLIED'`, [runtime.session.id])
    expect(sessionAfterRejectedAction[0]!.revision).toBe(revisionBeforeRejectedAction)
    expect(actionsAfterRejectedAction[0]!.count).toBe(actionsBeforeRejectedAction[0]!.count)
    const teacherRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime`, { cookie: teacherCookie })
    const teacherTriggerRequestId = randomUUID()
    const scheduledEvents = await database.query<Array<{ id: string }>>(
      `SELECT "id" FROM "runtime_events" WHERE "projectId" = $1 AND "sessionId" = $2 AND "code" = 'VTL_WEATHER' AND "status" = 'SCHEDULED' ORDER BY "createdAt" LIMIT 1`,
      [projectId, teacherRuntime.session.id]
    )
    expect(scheduledEvents).toHaveLength(1)
    const weatherEventId = scheduledEvents[0]!.id
    const triggered = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/events/VTL_WEATHER/trigger`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: teacherRuntime.session.revision, requestId: teacherTriggerRequestId }
    })
    const event = triggered.events.find((item) => item.code === "VTL_WEATHER")!
    expect(event).toBeTruthy()
    expect(event.triggeredAtMs).toEqual(expect.any(Number))
    const manualActivities = await database.query<Array<{ eventType: string }>>(
      `SELECT "eventType" FROM "project_activity_events" WHERE "objectId" = $1 AND "eventType" = 'TEACHER_RUNTIME_INTERVENTION'`,
      [event.id]
    )
    expect(manualActivities).toHaveLength(1)
    const repeatedTrigger = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/events/VTL_WEATHER/trigger`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: teacherRuntime.session.revision, requestId: teacherTriggerRequestId }
    })
    expect(repeatedTrigger.session.revision).toBe(triggered.session.revision)
    expect(repeatedTrigger.events.find((item) => item.code === "VTL_WEATHER")?.id).toBe(event.id)
    runtime = await waitForRuntime((workspace) => workspace.session.status === "PAUSED" && workspace.events.some((item) => item.id === event.id && ["ACTIVE", "ESCALATED", "HANDLING"].includes(item.status)))
    const duplicateActiveTrigger = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/events/VTL_WEATHER/trigger`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: runtime.session.revision, requestId: randomUUID() }
    })
    expect(duplicateActiveTrigger.session.revision).toBe(runtime.session.revision)
    expect(duplicateActiveTrigger.events.filter((item) => item.code === "VTL_WEATHER")).toHaveLength(1)
    expect(duplicateActiveTrigger.events.find((item) => item.code === "VTL_WEATHER")?.id).toBe(event.id)
    const ackRequestId = randomUUID()
    const ackRevision = runtime.session.revision
    const beforeAckCounts = await database.query<{ actions: string; reorganizations: string }>(`SELECT
      (SELECT COUNT(*)::text FROM "student_runtime_actions" WHERE "sessionId" = $1) AS "actions",
      (SELECT COUNT(*)::text FROM "vtl_reorganization_records" WHERE "sessionId" = $1) AS "reorganizations"`, [runtime.session.id])
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: ackRevision, requestId: ackRequestId, actionCode: "ACKNOWLEDGE", eventId: event.id, reasoning: { observation: "发现气象告警", rationale: "告警影响当前巡检区域", expectedOutcome: "确认后执行处置" } }
    })
    expect(runtime.actions.find((action) => action.actionCode === "ACKNOWLEDGE")?.payload.reasoning).toEqual({
      observation: "发现气象告警",
      rationale: "告警影响当前巡检区域",
      expectedOutcome: "确认后执行处置"
    })
    const firstAckRevision = runtime.session.revision
    const afterFirstAckCounts = await database.query<{ actions: string; reorganizations: string }>(`SELECT
      (SELECT COUNT(*)::text FROM "student_runtime_actions" WHERE "sessionId" = $1) AS "actions",
      (SELECT COUNT(*)::text FROM "vtl_reorganization_records" WHERE "sessionId" = $1) AS "reorganizations"`, [runtime.session.id])
    const repeatedAck = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: ackRevision, requestId: ackRequestId, actionCode: "ACKNOWLEDGE", eventId: event.id, reasoning: { observation: "发现气象告警", rationale: "告警影响当前巡检区域", expectedOutcome: "确认后执行处置" } }
    })
    const afterRepeatedAckCounts = await database.query<{ actions: string; reorganizations: string }>(`SELECT
      (SELECT COUNT(*)::text FROM "student_runtime_actions" WHERE "sessionId" = $1) AS "actions",
      (SELECT COUNT(*)::text FROM "vtl_reorganization_records" WHERE "sessionId" = $1) AS "reorganizations"`, [runtime.session.id])
    expect(Number(afterFirstAckCounts[0]!.actions)).toBe(Number(beforeAckCounts[0]!.actions) + 1)
    expect(Number(afterRepeatedAckCounts[0]!.actions)).toBe(Number(afterFirstAckCounts[0]!.actions))
    expect(Number(afterRepeatedAckCounts[0]!.reorganizations)).toBe(Number(afterFirstAckCounts[0]!.reorganizations))
    expect(repeatedAck.session.revision).toBe(firstAckRevision)
    const conflictingAction = await fetch(`${baseUrl}/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST",
      headers: { Cookie: studentCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: ackRevision, requestId: ackRequestId, actionCode: "ADJUST_GROUP", eventId: event.id, targetId: "VTL-AIRCRAFT-01", targetGroupId: secondGroup })
    })
    expect(conflictingAction.status).toBe(409)
    await conflictingAction.text()
    const adjustableAircraft = runtime.aircraft.find((aircraft) => aircraft.aircraftId === "VTL-AIRCRAFT-01")!
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, requestId: randomUUID(), actionCode: "ADJUST_GROUP", eventId: event.id, targetId: adjustableAircraft.aircraftId, targetGroupId: secondGroup, reasoning: { observation: "组间任务需要重新组织", rationale: "气象变化要求调整编组", expectedOutcome: "保持集群运行连续性" } }
    })
    expect(runtime.reorganizations.some((item) => item.action === "ADJUST_GROUP")).toBe(true)
    expect(runtime.events.find((item) => item.id === event.id)?.status).toBe("RESOLVED")
    const lifecycleActivities = await database.query<{ eventType: string; objectType: string; objectId: string; simulationTimeMs: number | null }[]>(
      `SELECT "eventType", "objectType", "objectId", "simulationTimeMs"
         FROM "project_activity_events"
        WHERE "projectId" = $1 AND "correlationId" = (SELECT "correlationId" FROM "runtime_events" WHERE "id" = $2)
          AND "eventType" IN ('RUNTIME_EVENT_TRIGGERED', 'RUNTIME_EVENT_DISCOVERED', 'RUNTIME_EVENT_ESCALATED', 'RUNTIME_EVENT_RESOLVED')
        ORDER BY "createdAt"`,
      [projectId, event.id]
    )
    expect(lifecycleActivities.map((activity) => activity.eventType)).toEqual(expect.arrayContaining([
      "RUNTIME_EVENT_TRIGGERED",
      "RUNTIME_EVENT_DISCOVERED",
      "RUNTIME_EVENT_RESOLVED"
    ]))
    expect(lifecycleActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_TRIGGERED")).toHaveLength(1)
    expect(lifecycleActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_DISCOVERED")).toHaveLength(1)
    expect(lifecycleActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_RESOLVED")).toHaveLength(1)
    const actionActivities = await database.query<{ eventType: string; objectType: string; objectId: string }[]>(
      `SELECT "eventType", "objectType", "objectId"
         FROM "project_activity_events"
        WHERE "projectId" = $1 AND "correlationId" = (SELECT "correlationId" FROM "runtime_events" WHERE "id" = $2)
          AND "eventType" = 'RUNTIME_ACTION_APPLIED'
        ORDER BY "createdAt"`,
      [projectId, event.id]
    )
    expect(actionActivities).toHaveLength(2)
    expect(actionActivities.every((activity) => activity.objectType === "RUNTIME_ACTION")).toBe(true)
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/clock-rate`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, rate: 3_600, status: "RUNNING" }
    })
    const clockActivities = await database.query<{ eventType: string }[]>(
      `SELECT "eventType" FROM "project_activity_events" WHERE "objectType" = 'SIMULATION_CLOCK' AND "objectId" = $1 AND "eventType" = 'RUNTIME_CLOCK_CHANGED'`,
      [runtime.session.id]
    )
    expect(clockActivities).toHaveLength(1)
    runtime = await waitForRuntime((workspace) => workspace.session.status === "COMPLETED")
    expect(runtime.summary.landedAircraft).toBe(5)
    expect(runtime.summary.completedTaskObjects).toBe(5)
    expect(runtime.alerts.some((alert) => alert.status === "ACKNOWLEDGED" || alert.status === "RESOLVED"), JSON.stringify({ events: runtime.events, alerts: runtime.alerts })).toBe(true)
    const completionActivities = await database.query<{ eventType: string }[]>(
      `SELECT "eventType" FROM "project_activity_events" WHERE "objectType" = 'RUNTIME_SESSION' AND "objectId" = $1 AND "eventType" = 'RUNTIME_COMPLETED'`,
      [runtime.session.id]
    )
    expect(completionActivities).toHaveLength(1)

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("VTL_EMERGENCY_HANDLING")
    await startStage(stages, "VTL_EMERGENCY_HANDLING")
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/emergency/complete`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision }
    })
    expect(runtime.session.status).toBe("COMPLETED")

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(stages, "VTL_REVIEW")
    let review = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review`, { cookie: studentCookie })
    expect(review.replayFrames.length).toBeGreaterThanOrEqual(3)
    expect(review.timeline.some((item) => item.kind === "EVENT")).toBe(true)
    expect(review.reorganizations.some((item) => item.action === "ADJUST_GROUP")).toBe(true)
    expect(review.taskCoverageRatio).toBe(1)
    expect(review.aircraftResults).toHaveLength(5)
    review = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review/summary/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: review.evaluationRevision, summary: "本次巡检完成任务对象覆盖，能够识别气象事件并完成告警确认和分组调整，后续继续优化事件处置时机。" }
    })
    expect(review.evaluationStatus).toBe("PENDING")
    const completedProgress = await teacherProgress()
    expect(completedProgress.milestones).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "VTL_RUNTIME", state: "COMPLETED" }),
      expect.objectContaining({ code: "VTL_REVIEW", state: "SUBMITTED" })
    ]))
    review = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review`, { cookie: teacherCookie })
    const teacherScores = review.teacherScores.map((item) => ({ ...item, score: item.maxScore - 1, comment: `${item.label}达到教学要求` }))
    review = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review/evaluation`, {
      method: "PUT", cookie: teacherCookie, body: { expectedRevision: review.evaluationRevision, teacherScores, summary: "学生完成了从任务分配、航线检查到运行处置和复盘的完整巡检训练。" }
    })
    expect(review.evaluationStatus).toBe("REVIEWED")
    review = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review/evaluation/publish`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: review.evaluationRevision }
    })
    expect(review.evaluationStatus).toBe("PUBLISHED")
    expect(["PENDING", "RUNNING", "SUCCEEDED"]).toContain(review.reportJob?.status)
    review = await waitForReport("PDF")
    expect(review.report).toMatchObject({ status: "FINAL", format: "PDF" })
    const reportSnapshots = await database.query(`SELECT "snapshot" FROM "show_project_reports" WHERE "projectId" = $1`, [projectId]) as Array<{ snapshot: Record<string, unknown> }>
    expect(reportSnapshots).toHaveLength(1)
    expect(reportSnapshots[0]!.snapshot).toMatchObject({
      scaleTemplateCode: "VTL_5",
      plan: {
        taskZones: expect.arrayContaining([expect.objectContaining({ taskObjectIds: expect.any(Array) })]),
        assignments: expect.arrayContaining([expect.objectContaining({ taskSequence: expect.any(Array) })]),
        routes: expect.arrayContaining([expect.objectContaining({ terrainSampleCount: expect.any(Number), alternateComparison: expect.objectContaining({ landingSiteId: alternate.id, feasible: true }) })]),
        checkResult: expect.objectContaining({ passed: true }),
        executionPlan: expect.objectContaining({ status: "SUBMITTED" })
      },
      events: expect.any(Array),
      actions: expect.arrayContaining([
        expect.objectContaining({
          actionCode: "ACKNOWLEDGE",
          reasoning: {
            observation: "发现气象告警",
            rationale: "告警影响当前巡检区域",
            expectedOutcome: "确认后执行处置"
          }
        })
      ]),
      studentSummary: expect.stringContaining("巡检"),
      teacherScores: expect.any(Array),
      teacherSummary: expect.stringContaining("完整巡检训练")
    })
    review = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review/report/generate`, {
      method: "POST", cookie: teacherCookie, body: { format: "DOCX" }
    })
    expect(["PENDING", "RUNNING"]).toContain(review.reportJob?.status)
    review = await waitForReport("DOCX")
    expect(review.report).toMatchObject({ status: "FINAL", format: "DOCX" })
    const docxDownload = await fetch(`${baseUrl}/v3/vtl-projects/${projectId}/review/report/download`, { headers: { Cookie: teacherCookie } })
    expect(docxDownload.status).toBe(200)
    expect(Buffer.from(await docxDownload.arrayBuffer()).subarray(0, 2).toString("ascii")).toBe("PK")
    review = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review/report/generate`, {
      method: "POST", cookie: teacherCookie, body: { format: "PDF" }
    })
    expect(["PENDING", "RUNNING"]).toContain(review.reportJob?.status)
    review = await waitForReport("PDF")
    expect(review.report).toMatchObject({ status: "FINAL", format: "PDF" })
    const pdfDownload = await fetch(`${baseUrl}/v3/vtl-projects/${projectId}/review/report/download`, { headers: { Cookie: teacherCookie } })
    expect(pdfDownload.status).toBe(200)
    expect(Buffer.from(await pdfDownload.arrayBuffer()).subarray(0, 5).toString("ascii")).toBe("%PDF-")
    const reportAssets = await database.query(`SELECT "status", "mimeType" FROM "file_assets" WHERE "ownerType" = 'PROJECT' AND "ownerId" = $1 AND "category" = 'FINAL_REPORT' ORDER BY "createdAt"`, [projectId]) as Array<{ status: string; mimeType: string }>
    expect(reportAssets).toHaveLength(3)
    expect(reportAssets.filter((asset) => asset.status === "AVAILABLE")).toHaveLength(1)
    expect(reportAssets.find((asset) => asset.status === "AVAILABLE")?.mimeType).toBe("application/pdf")
  }, 120_000)

  async function startStage(stages: StagesView, code: string): Promise<void> {
    const stage = stages.stages.find((item) => item.stageCode === code)
    expect(stage, `缺少阶段 ${code}`).toBeTruthy()
    expect(["AVAILABLE", "RETURNED", "IN_PROGRESS"]).toContain(stage!.status)
    if (stage!.status === "AVAILABLE" || stage!.status === "RETURNED") {
      await jsonRequest(`/v3/projects/${projectId}/stages/${code}/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: stage!.revision } })
    }
  }

  async function teacherProgress(): Promise<V3TeacherProgressItem> {
    const progress = await jsonRequest<V3TeacherProgressItem[]>("/v3/teaching/progress?sceneType=VTOL_INSPECTION&includeInternalData=true", { cookie: teacherCookie })
    const item = progress.find((entry) => entry.projectId === projectId)
    expect(item, `教师进度中缺少 VTL 项目 ${projectId}`).toBeTruthy()
    return item!
  }

  async function waitForRuntime(predicate: (workspace: RuntimeWorkspace) => boolean): Promise<RuntimeWorkspace> {
    const deadline = Date.now() + 10_000
    let workspace = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
    while (!predicate(workspace) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
      workspace = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
    }
    expect(predicate(workspace), `等待 VTL 运行状态超时：${JSON.stringify(workspace.session)}`).toBe(true)
    return workspace
  }

  async function waitForReport(format: "DOCX" | "PDF"): Promise<ReviewWorkspace> {
    const deadline = Date.now() + 15_000
    let workspace = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review`, { cookie: teacherCookie })
    while (Date.now() < deadline) {
      if (workspace.reportJob?.status === "DEAD_LETTER") throw new Error(`VTL 报告作业失败：${workspace.reportJob.error ?? "未知错误"}\n${workerOutput}`)
      if (workspace.reportJob?.status === "SUCCEEDED" && workspace.report?.format === format) return workspace
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
      workspace = await jsonRequest<ReviewWorkspace>(`/v3/vtl-projects/${projectId}/review`, { cookie: teacherCookie })
    }
    throw new Error(`等待 VTL ${format} 报告超时\n${workerOutput}`)
  }

  async function login(email: string, password: string): Promise<string> {
    const response = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })
    expect(response.status, await response.clone().text()).toBe(201)
    return response.headers.get("set-cookie")!.split(";", 1)[0]!
  }

  async function jsonRequest<T = unknown>(path: string, options: { method?: string; cookie: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
    const body = await response.json() as unknown
    expect(response.status, `${JSON.stringify(body)}\n${serverOutput}`).toBeLessThan(400)
    return body as T
  }

  async function waitForServer(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) throw new Error(`VTL 集成服务提前退出：${serverProcess.exitCode}\n${serverOutput}`)
      try {
        const response = await fetch(`${baseUrl}/auth/me`)
        if (response.status === 401) return
      } catch {
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error(`等待 VTL 集成服务启动超时\n${serverOutput}`)
  }

  async function waitForWorker(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (workerProcess.exitCode !== null) throw new Error(`VTL 集成 Worker 提前退出：${workerProcess.exitCode}\n${workerOutput}`)
      if (workerOutput.includes("VTL_REPORT_GENERATE")) return
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    }
    throw new Error(`等待 VTL 集成 Worker 启动超时\n${workerOutput}`)
  }
})

interface Coordinate { longitude: number; latitude: number; altitudeMeters?: number }
interface TaskObject { id: string; positions: Coordinate[] }
interface LandingSite { id: string; type: "MAIN" | "ALTERNATE"; position: Coordinate }
interface StagesView { currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }
interface PlanningWorkspace {
  plan: {
    revision: number
    areaConfirmedAt: string | null
    taskObjects: Array<{ id: string; positions: Coordinate[] }>
    landingSites: LandingSite[]
    allocation: { valid: boolean; groups: Array<{ id: string }>; assignments: Array<{ aircraftId: string; taskObjectIds: string[] }> }
    routes: Array<{ aircraftId: string }>
    checkResult: { passed: boolean } | null
    executionPlan: { status: string } | null
  }
}
interface RuntimeWorkspace {
  session: { id: string; revision: number; status: string; simulationTimeMs: number }
  summary: { landedAircraft: number; completedTaskObjects: number }
  aircraft: Array<{ aircraftId: string; status: string; completedTaskObjectIds: string[] }>
  events: Array<{ id: string; code: string; status: string }>
  alerts: Array<{ status: string }>
  actions: Array<{ actionCode: string; payload: { reasoning?: { observation: string; rationale: string; expectedOutcome: string } } }>
  availableActions: Array<{ code: string; enabled: boolean; disabledReason: string | null; eligibleTargetIds: string[] }>
  reorganizations: Array<{ action: string }>
}
interface ReviewWorkspace {
  evaluationRevision: number
  evaluationStatus: string
  replayFrames: Array<{ sequence: number; simulationTimeMs: number }>
  timeline: Array<{ kind: string }>
  taskCoverageRatio: number
  aircraftResults: Array<unknown>
  teacherScores: Array<{ code: string; label: string; maxScore: number; score: number | null; comment: string }>
  reorganizations: Array<{ action: string }>
  report: { status: string; format: string } | null
  reportJob: { status: "PENDING" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "DEAD_LETTER"; error: string | null } | null
}

function createWaypoints(main: Coordinate, task: Coordinate, taskObjectId: string, index: number) {
  const offset = index * 0.0001
  const start = { longitude: main.longitude + offset, latitude: main.latitude + offset, altitudeMeters: 10 }
  const climb = { longitude: main.longitude + offset, latitude: main.latitude + offset, altitudeMeters: 80 }
  const transition = { longitude: main.longitude + 0.001 + offset, latitude: main.latitude + offset, altitudeMeters: 90 }
  const cruise = { longitude: (transition.longitude + task.longitude) / 2, latitude: (transition.latitude + task.latitude) / 2, altitudeMeters: 120 }
  const taskPosition = { longitude: task.longitude, latitude: task.latitude, altitudeMeters: 120 }
  const returnPoint = { longitude: main.longitude + 0.001 + offset, latitude: main.latitude + offset, altitudeMeters: 120 }
  return [
    ["VERTICAL_TAKEOFF", start], ["CLIMB", climb], ["FORWARD_TRANSITION", transition], ["FIXED_WING_CRUISE", cruise],
    ["TASK_EXECUTION", taskPosition], ["RETURN", returnPoint], ["BACK_TRANSITION", transition], ["VERTICAL_LANDING", start]
  ].map(([phase, position], sequence) => ({ id: `R12-WP-${index}-${sequence}`, sequence, phase, position, altitudeMeters: (position as Coordinate).altitudeMeters, speedMps: 20, taskObjectId: phase === "TASK_EXECUTION" ? taskObjectId : null }))
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return void server.close(() => reject(new Error("无法分配集成测试端口")))
      server.close((error) => error ? reject(error) : resolvePort(address.port))
    })
  })
}
