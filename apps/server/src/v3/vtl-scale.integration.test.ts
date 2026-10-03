import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DataSource } from "typeorm"
import { integrationServerEntry } from "../integration-server-entry.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("VTL scale templates integration", () => {
  let serverProcess: ChildProcess
  let baseUrl = ""
  let serverOutput = ""
  let storageDirectory = ""
  let database: DataSource
  let teacherCookie = ""
  let studentCookie = ""
  const draftIds: string[] = []
  const projectIds: string[] = []

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), "wurenji-vtl-scale-"))
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
        ONLYOFFICE_JWT_SECRET: "vtl-scale-onlyoffice-secret",
        V3_INTERNAL_API_URL: baseUrl
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
      for (const draftId of draftIds) {
        const rows = await database.query<{ id: string }>(`SELECT "id" FROM "student_projects" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        const ids = [...new Set([...projectIds, ...rows.map((row) => row.id)])]
        for (const projectId of ids) {
          await database.query(`DELETE FROM "jobs" WHERE "sourceOutboxEventId" IN (SELECT "id" FROM "outbox_events" WHERE "aggregateType" = 'VTOL_PROJECT' AND "aggregateId" = $1)`, [projectId])
          await database.query(`DELETE FROM "outbox_events" WHERE "aggregateType" = 'VTOL_PROJECT' AND "aggregateId" = $1`, [projectId])
        }
        await database.query(`DELETE FROM "student_projects" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_targets" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_snapshot_resource_revisions" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_snapshots" WHERE "draftId" = $1`, [draftId])
        await database.query(`DELETE FROM "assignment_drafts" WHERE "id" = $1`, [draftId])
      }
      await database.destroy()
    }
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true })
  })

  it("validates VTL_1, VTL_5 and VTL_20 planning scales", async () => {
    const resources = await jsonRequest<Array<{ id: string; packageType: string; status: string; source: string; manifest: Record<string, unknown> }>>("/v3/resource-packages", { cookie: teacherCookie })
    const regions = await jsonRequest<Array<{
      packageId: string
      center: Coordinate
      boundary: Coordinate[]
      vtlTaskObjects: TaskObject[]
      vtlLandingSites: LandingSite[]
    }>>("/v3/resource-packages/regions/catalog?sceneType=VTOL_INSPECTION", { cookie: teacherCookie })
    const region = regions[0]
    expect(region).toBeTruthy()
    expect(region!.vtlTaskObjects.length).toBeGreaterThanOrEqual(20)
    const mainSites = region!.vtlLandingSites.filter((site) => site.type === "MAIN")
    expect(mainSites.length).toBeGreaterThanOrEqual(2)
    const main = mainSites[1]!
    const alternate = region!.vtlLandingSites.find((site) => site.type === "ALTERNATE")!
    const selectedResources = resources.filter((resource) => {
      if (resource.status !== "ACTIVE" || resource.source !== "BUILT_IN") return false
      if (["RULE", "AIRCRAFT", "REPORT"].includes(resource.packageType)) return true
      if (resource.packageType === "REGION") return resource.id === region!.packageId
      if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") return resource.manifest.sceneType === "VTOL_INSPECTION"
      return false
    })
    const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
    expect(classes.length).toBeGreaterThan(0)

    for (const scale of scaleCases) {
      const title = `VTL 规模验证 ${scale.code} ${randomUUID()}`
      const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
        method: "POST",
        cookie: teacherCookie,
        body: {
          title,
          sceneType: "VTOL_INSPECTION",
          mode: "TRAINING",
          config: {
            taskBrief: `${scale.code} 垂起巡检规模验证`,
            scaleTemplateCode: scale.code,
            regionPackageId: region!.packageId,
            availableAt: new Date(Date.now() - 60_000).toISOString(),
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
            allowResubmission: true,
            allowedValidationAttempts: 3,
            allowedRuntimeAttempts: 3,
            resultVisibility: "FULL_REVIEW",
            vtlParameters: {
              projectBackground: "垂起巡检规模模板验证",
              completionRequirements: "完成任务分配、八阶段航线、检查和运行启动",
              mainLandingSiteId: main.id,
              aircraftModelCode: "VTOL-TEACHING-01",
              aircraftParameterVersion: "1.0.0"
            },
            scenario: {
              simulationClockRate: 3_600,
              vtlRuntimeClockRate: 3_600,
              eventCodes: scale.eventCodes
            }
          }
        }
      })
      draftIds.push(draft.id)
      const targets = [{ type: "CLASS", targetId: classes[0]!.id }]
      const resourcePackageIds = selectedResources.map((resource) => resource.id)
      const preview = await jsonRequest<{ configHash: string }>(`/v3/assignments/drafts/${draft.id}/preview`, {
        method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds }
      })
      const published = await jsonRequest<{ projectCount: number }>(`/v3/assignments/drafts/${draft.id}/publish`, {
        method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds }
      })
      expect(published.projectCount).toBeGreaterThan(0)

      const projects = await jsonRequest<Array<{ id: string; title: string }>>("/v3/my-projects", { cookie: studentCookie })
      const project = projects.find((item) => item.title === title)
      expect(project).toBeTruthy()
      projectIds.push(project!.id)
      await validatePlanning(project!.id, scale, region!, main, alternate)

      let stages = await jsonRequest<StagesView>(`/v3/projects/${project!.id}/stages`, { cookie: studentCookie })
      await startStage(project!.id, stages, "VTL_RUNTIME")
      let runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime`, { cookie: studentCookie })
      expect(runtime.summary.totalAircraft).toBe(scale.aircraftCount)
      expect(runtime.groups).toHaveLength(scale.groupCount)
      expect(runtime.groups.map((group) => group.aircraftCount)).toEqual(scale.groupSizes)
      expect(runtime.aircraft).toHaveLength(scale.aircraftCount)
      runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime/start`, {
        method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision }
      })
      expect(runtime.session.status).toBe("RUNNING")
      if (scale.code === "VTL_20") {
        const cancelTarget = runtime.aircraft.find((item) => item.status === "WAITING" && !["VTL-AIRCRAFT-01", "VTL-AIRCRAFT-02", "VTL-AIRCRAFT-03"].includes(item.aircraftId))
        expect(cancelTarget).toBeTruthy()
        runtime = await applyRuntimeAction(project!.id, runtime, { actionCode: "CANCEL_NOT_STARTED", targetId: cancelTarget!.aircraftId })
        expect(runtime.aircraft.find((item) => item.aircraftId === cancelTarget!.aircraftId)?.status).toBe("CANCELLED")
        const transferredTaskId = region!.vtlTaskObjects[4]!.id
        let teacherRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime`, { cookie: teacherCookie })
        let triggered = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime/events/VTL_WEATHER/trigger`, {
          method: "POST", cookie: teacherCookie, body: { expectedRevision: teacherRuntime.session.revision }
        })
        const event = triggered.events.find((item) => item.code === "VTL_WEATHER")!
        expect(event).toBeTruthy()
        runtime = await waitForRuntime(project!.id, (workspace) => workspace.session.status === "PAUSED" && workspace.events.some((item) => item.id === event.id && ["ACTIVE", "ESCALATED", "HANDLING"].includes(item.status)))
        expect(runtime.session.status).toBe("PAUSED")
        await expectRuntimeResumeRejected(project!.id, runtime)
        runtime = await applyRuntimeAction(project!.id, runtime, { actionCode: "ACKNOWLEDGE", eventId: event.id })
        expect(runtime.events.find((item) => item.id === event.id)?.status).toBe("HANDLING")
        runtime = await applyRuntimeAction(project!.id, runtime, { actionCode: "RETURN_AIRCRAFT", eventId: event.id, targetId: "VTL-AIRCRAFT-01" })
        expect(runtime.events.find((item) => item.id === event.id)?.status).toBe("RESOLVED")
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-01")?.status).toBe("RETURNING")
        runtime = await applyRuntimeAction(project!.id, runtime, { actionCode: "DIVERT_AIRCRAFT", targetId: "VTL-AIRCRAFT-02" })
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-02")?.status).toBe("DIVERTING")
        runtime = await applyRuntimeAction(project!.id, runtime, { actionCode: "HOLD", targetId: "VTL-AIRCRAFT-03" })
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-03")?.status).toBe("HOLDING")
        runtime = await applyRuntimeAction(project!.id, runtime, {
          actionCode: "TRANSFER_TASK",
          targetId: "VTL-AIRCRAFT-05",
          targetAircraftId: "VTL-AIRCRAFT-06",
          taskObjectId: transferredTaskId
        })
        runtime = await applyRuntimeAction(project!.id, runtime, { actionCode: "ADJUST_GROUP", targetId: "VTL-AIRCRAFT-06", targetGroupId: "VTL-GROUP-1" })
        expect(runtime.actions.map((item) => item.actionCode)).toEqual(expect.arrayContaining([
          "ACKNOWLEDGE", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "HOLD", "CANCEL_NOT_STARTED", "TRANSFER_TASK", "ADJUST_GROUP"
        ]))
        expect(runtime.reorganizations.map((item) => item.action)).toEqual(expect.arrayContaining([
          "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "HOLD", "CANCEL_NOT_STARTED", "TRANSFER_TASK", "ADJUST_GROUP"
        ]))
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-06")?.groupId).toBe("VTL-GROUP-1")
        runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime/clock-rate`, {
          method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, rate: 1_000, status: "RUNNING" }
        })
        runtime = await waitForRuntime(project!.id, (workspace) => workspace.session.status === "RUNNING" && workspace.session.simulationTimeMs >= 15_000 && workspace.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-03")?.status !== "HOLDING")
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-03")?.status).not.toBe("HOLDING")
        runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime/clock-rate`, {
          method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, rate: 3_600, status: "RUNNING" }
        })
        const communicationEvent = await waitForRuntime(project!.id, (workspace) => workspace.session.status === "PAUSED" && workspace.events.some((item) => item.code === "VTL_COMMUNICATION" && ["ACTIVE", "ESCALATED", "HANDLING"].includes(item.status)))
        const communicationEventId = communicationEvent.events.find((item) => item.code === "VTL_COMMUNICATION")!.id
        const communicationTarget = communicationEvent.aircraft.find((item) => ["WAITING", "ACTIVE"].includes(item.status))
        expect(communicationTarget).toBeTruthy()
        await expectRuntimeResumeRejected(project!.id, communicationEvent)
        runtime = await applyRuntimeAction(project!.id, communicationEvent, { actionCode: "ACKNOWLEDGE", eventId: communicationEventId })
        runtime = await applyRuntimeAction(project!.id, runtime, {
          actionCode: "ADJUST_GROUP",
          eventId: communicationEventId,
          targetId: communicationTarget!.aircraftId,
          targetGroupId: "VTL-GROUP-1"
        })
        expect(runtime.events.find((item) => item.id === communicationEventId)?.status).toBe("RESOLVED")
        runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime/clock-rate`, {
          method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, rate: 3_600, status: "RUNNING" }
        })
        runtime = await waitForRuntime(project!.id, (workspace) => workspace.session.status === "COMPLETED")
        expect(runtime.aircraft.find((item) => item.aircraftId === cancelTarget!.aircraftId)?.status).toBe("CANCELLED")
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-01")?.status).toBe("LANDED")
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-02")?.status).toBe("LANDED")
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-03")?.status).toBe("LANDED")
        expect(runtime.aircraft.find((item) => item.aircraftId === "VTL-AIRCRAFT-06")?.completedTaskObjectIds).toContain(transferredTaskId)
        expect(runtime.summary.landedAircraft).toBe(scale.aircraftCount - 1)
        expect(runtime.summary.completedTaskObjects).toBe(scale.taskObjectCount - 3)
        const completedAircraft = runtime.aircraft.find((item) => item.status === "LANDED" && item.completedTaskObjectIds.length > 0)
        expect(completedAircraft).toBeTruthy()
        await expectRuntimeActionRejected(project!.id, runtime, {
          actionCode: "TRANSFER_TASK",
          targetId: completedAircraft!.aircraftId,
          targetAircraftId: "VTL-AIRCRAFT-07",
          taskObjectId: completedAircraft!.completedTaskObjectIds[0]
        })
      }
      if (scale.code === "VTL_1") {
        runtime = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${project!.id}/runtime/clock-rate`, {
          method: "POST", cookie: studentCookie, body: { expectedRevision: runtime.session.revision, rate: 3_600, status: "RUNNING" }
        })
        runtime = await waitForRuntime(project!.id, (workspace) => workspace.session.status === "COMPLETED")
        expect(runtime.summary.landedAircraft).toBe(1)
        expect(runtime.summary.completedTaskObjects).toBe(3)
      }
    }
  }, 180_000)

  it("creates only continuously opened stages and submits after the final opened stage", async () => {
    const resources = await jsonRequest<Array<{ id: string; packageType: string; status: string; source: string; manifest: Record<string, unknown> }>>("/v3/resource-packages", { cookie: teacherCookie })
    const regions = await jsonRequest<Array<{
      packageId: string
      boundary: Coordinate[]
      vtlTaskObjects: TaskObject[]
      vtlLandingSites: LandingSite[]
    }>>("/v3/resource-packages/regions/catalog?sceneType=VTOL_INSPECTION", { cookie: teacherCookie })
    const region = regions[0]
    expect(region).toBeTruthy()
    const main = region!.vtlLandingSites.find((site) => site.type === "MAIN")!
    const selectedResources = resources.filter((resource) => {
      if (resource.status !== "ACTIVE" || resource.source !== "BUILT_IN") return false
      if (["RULE", "AIRCRAFT", "REPORT"].includes(resource.packageType)) return true
      if (resource.packageType === "REGION") return resource.id === region!.packageId
      if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") return resource.manifest.sceneType === "VTOL_INSPECTION"
      return false
    })
    const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
    expect(classes.length).toBeGreaterThan(0)
    const title = `VTL 部分开放验证 ${randomUUID()}`
    const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
      method: "POST",
      cookie: teacherCookie,
      body: {
        title,
        sceneType: "VTOL_INSPECTION",
        mode: "TRAINING",
        config: {
          taskBrief: "验证垂起巡检连续开放阶段",
          scaleTemplateCode: "VTL_1",
          regionPackageId: region!.packageId,
          availableAt: new Date(Date.now() - 60_000).toISOString(),
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          allowResubmission: true,
          allowedValidationAttempts: 3,
          allowedRuntimeAttempts: 3,
          resultVisibility: "FULL_REVIEW",
          vtlParameters: {
            projectBackground: "垂起巡检部分开放阶段验证",
            completionRequirements: "完成区域与对象、任务分配后提交",
            mainLandingSiteId: main.id,
            aircraftModelCode: "VTOL-TEACHING-01",
            aircraftParameterVersion: "1.0.0",
            openStageCodes: ["VTL_AREA_OBJECTS", "VTL_TASK_ALLOCATION"]
          },
          scenario: { simulationClockRate: 3_600, vtlRuntimeClockRate: 3_600, eventCodes: [] }
        }
      }
    })
    draftIds.push(draft.id)
    const targets = [{ type: "CLASS", targetId: classes[0]!.id }]
    const resourcePackageIds = selectedResources.map((resource) => resource.id)
    const preview = await jsonRequest<{ configHash: string }>(`/v3/assignments/drafts/${draft.id}/preview`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })
    const published = await jsonRequest<{ projectCount: number }>(`/v3/assignments/drafts/${draft.id}/publish`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds }
    })
    expect(published.projectCount).toBeGreaterThan(0)

    const projects = await jsonRequest<Array<{ id: string; title: string }>>("/v3/my-projects", { cookie: studentCookie })
    const project = projects.find((item) => item.title === title)
    expect(project).toBeTruthy()
    projectIds.push(project!.id)
    let stages = await jsonRequest<{ status: string; currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${project!.id}/stages`, { cookie: studentCookie })
    expect(stages.stages.map((stage) => stage.stageCode)).toEqual(["VTL_AREA_OBJECTS", "VTL_TASK_ALLOCATION"])
    expect(stages.currentStageCode).toBe("VTL_AREA_OBJECTS")
    await startStage(project!.id, stages, "VTL_AREA_OBJECTS")

    let planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${project!.id}/planning-workspace`, { cookie: studentCookie })
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${project!.id}/area/confirm`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })
    stages = await jsonRequest<StagesView & { status: string }>(`/v3/projects/${project!.id}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("VTL_TASK_ALLOCATION")
    await startStage(project!.id, stages, "VTL_TASK_ALLOCATION")
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${project!.id}/planning-workspace`, { cookie: studentCookie })
    const group = { id: "VTL-GROUP-1", code: "G-01", title: "部分开放验证组", aircraftIds: ["VTL-AIRCRAFT-01"] }
    const taskObjectIds = planning.plan.taskObjects.map((task) => task.id)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${project!.id}/allocation`, {
      method: "PUT",
      cookie: studentCookie,
      body: {
        expectedRevision: planning.plan.revision,
        groups: [group],
        assignments: [{ aircraftId: "VTL-AIRCRAFT-01", groupId: group.id, available: true, taskObjectIds, taskSequence: taskObjectIds }],
        taskZones: [{ id: "VTL-GROUP-1-ZONE", title: "部分开放验证分区", boundary: region!.boundary, groupId: group.id, taskObjectIds }]
      }
    })
    expect(planning.plan.allocation.valid).toBe(true)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${project!.id}/allocation/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })
    expect(planning.plan.allocation.valid).toBe(true)
    stages = await jsonRequest<StagesView & { status: string }>(`/v3/projects/${project!.id}/stages`, { cookie: studentCookie })
    expect(stages.status).toBe("SUBMITTED")
    expect(stages.currentStageCode).toBe("VTL_TASK_ALLOCATION")
    expect(stages.stages.every((stage) => stage.status === "ACCEPTED")).toBe(true)
  }, 60_000)

  async function validatePlanning(projectId: string, scale: ScaleCase, region: Region, main: LandingSite, alternate: LandingSite): Promise<void> {
    let stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("VTL_AREA_OBJECTS")
    await startStage(projectId, stages, "VTL_AREA_OBJECTS")
    let planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: studentCookie })
    expect(planning.plan.taskObjects).toHaveLength(scale.taskObjectCount)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/area/confirm`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(projectId, stages, "VTL_TASK_ALLOCATION")
    const groups = scale.groupSizes.map((size, groupIndex) => ({
      id: `VTL-GROUP-${groupIndex + 1}`,
      code: `G-${String(groupIndex + 1).padStart(2, "0")}`,
      title: `规模验证 ${groupIndex + 1} 组`,
      aircraftIds: Array.from({ length: size }, (_, index) => `VTL-AIRCRAFT-${String(scale.groupOffsets[groupIndex]! + index + 1).padStart(2, "0")}`)
    }))
    const assignments = Array.from({ length: scale.aircraftCount }, (_, index) => {
      const taskObjectIds = scale.aircraftCount === 1
        ? planning.plan.taskObjects.map((task) => task.id)
        : [planning.plan.taskObjects[index]!.id]
      const group = groups.find((item) => item.aircraftIds.includes(`VTL-AIRCRAFT-${String(index + 1).padStart(2, "0")}`))!
      return {
        aircraftId: `VTL-AIRCRAFT-${String(index + 1).padStart(2, "0")}`,
        groupId: group.id,
        available: true,
        taskObjectIds,
        taskSequence: taskObjectIds
      }
    })
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/allocation`, {
      method: "PUT", cookie: studentCookie, body: {
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
    expect(planning.plan.allocation.valid).toBe(true)
    expect(planning.plan.allocation.groups).toHaveLength(scale.groupCount)
    expect(new Set(planning.plan.allocation.assignments.flatMap((item) => item.taskObjectIds)).size).toBe(scale.taskObjectCount)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/allocation/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(projectId, stages, "VTL_ROUTE_PLANNING")
    for (const [index, assignment] of planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).entries()) {
      const tasks = assignment.taskObjectIds.map((id) => planning.plan.taskObjects.find((task) => task.id === id)!)
      planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/routes/${assignment.aircraftId}`, {
        method: "PUT",
        cookie: studentCookie,
        body: {
          expectedRevision: planning.plan.revision,
          waypoints: createMultiTaskWaypoints(main.position, tasks, index),
          transitionHeightMeters: 90,
          alternateLandingSiteId: alternate.id
        }
      })
    }
    expect(planning.plan.routes).toHaveLength(scale.aircraftCount)
    expect(planning.plan.landingSites.find((site) => site.id === main.id)?.position).toMatchObject({ longitude: main.position.longitude, latitude: main.position.latitude })
    expect(planning.plan.routes[0]?.waypoints[0]?.position).toMatchObject({ longitude: main.position.longitude, latitude: main.position.latitude })
    expect(planning.plan.routes.every((route) => route.waypoints.filter((waypoint) => waypoint.phase === "TASK_EXECUTION").length > 0)).toBe(true)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/routes/complete`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(projectId, stages, "VTL_PLAN_VALIDATION")
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/validate`, { method: "POST", cookie: studentCookie })
    expect(planning.plan.checkResult?.passed, JSON.stringify(planning.plan.checkResult)).toBe(true)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/validation/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision }
    })

    stages = await jsonRequest<StagesView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    await startStage(projectId, stages, "VTL_EXECUTION_PLAN")
    const activeAircraftIds = planning.plan.allocation.assignments.filter((item) => item.taskObjectIds.length > 0).map((item) => item.aircraftId)
    planning = await jsonRequest<PlanningWorkspace>(`/v3/vtl-projects/${projectId}/execution-plan/submit`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: planning.plan.revision, takeoffOrder: activeAircraftIds, landingOrder: [...activeAircraftIds].reverse() }
    })
    expect(planning.plan.executionPlan?.status).toBe("SUBMITTED")
  }

  async function startStage(projectId: string, stages: StagesView, code: string): Promise<void> {
    const stage = stages.stages.find((item) => item.stageCode === code)
    expect(stage, `缺少阶段 ${code}`).toBeTruthy()
    expect(["AVAILABLE", "IN_PROGRESS"]).toContain(stage!.status)
    if (stage!.status === "AVAILABLE") {
      await jsonRequest(`/v3/projects/${projectId}/stages/${code}/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: stage!.revision } })
    }
  }

  async function waitForRuntime(projectId: string, predicate: (workspace: RuntimeWorkspace) => boolean): Promise<RuntimeWorkspace> {
    const deadline = Date.now() + 10_000
    let workspace = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
    while (!predicate(workspace) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
      workspace = await jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime`, { cookie: studentCookie })
    }
    expect(predicate(workspace), `等待 VTL 运行状态超时：${JSON.stringify(workspace.session)}`).toBe(true)
    return workspace
  }

  async function applyRuntimeAction(projectId: string, runtime: RuntimeWorkspace, body: Record<string, unknown>): Promise<RuntimeWorkspace> {
    return jsonRequest<RuntimeWorkspace>(`/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: runtime.session.revision, ...body, reasoning: { observation: "识别运行态势变化", rationale: "按当前事件和任务状态执行教学处置", expectedOutcome: "保持任务安全和记录可追溯" } }
    })
  }

  async function expectRuntimeActionRejected(projectId: string, runtime: RuntimeWorkspace, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${baseUrl}/v3/vtl-projects/${projectId}/runtime/actions`, {
      method: "POST",
      headers: { Cookie: studentCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: runtime.session.revision, ...body, reasoning: { observation: "检查已完成任务的转移边界", rationale: "已落地航空器不应再次接收运行任务", expectedOutcome: "服务端拒绝非法处置" } })
    })
    const responseBody = await response.text()
    expect(response.status, responseBody).toBeGreaterThanOrEqual(400)
  }

  async function expectRuntimeResumeRejected(projectId: string, runtime: RuntimeWorkspace): Promise<void> {
    const response = await fetch(`${baseUrl}/v3/vtl-projects/${projectId}/runtime/clock-rate`, {
      method: "POST",
      headers: { Cookie: studentCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: runtime.session.revision, rate: 3_600, status: "RUNNING" })
    })
    const responseBody = await response.text()
    expect(response.status, responseBody).toBeGreaterThanOrEqual(400)
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
      if (serverProcess.exitCode !== null) throw new Error(`VTL 规模集成服务提前退出：${serverProcess.exitCode}\n${serverOutput}`)
      try {
        const response = await fetch(`${baseUrl}/auth/me`)
        if (response.status === 401) return
      } catch {
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error(`等待 VTL 规模集成服务启动超时\n${serverOutput}`)
  }
})

interface Coordinate { longitude: number; latitude: number; altitudeMeters?: number }
interface TaskObject { id: string; positions: Coordinate[] }
interface LandingSite { id: string; type: "MAIN" | "ALTERNATE"; position: Coordinate }
interface Region { center: Coordinate; boundary: Coordinate[] }
interface StagesView { currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }
interface PlanningWorkspace {
  plan: {
    revision: number
    taskObjects: Array<{ id: string; positions: Coordinate[] }>
    landingSites: LandingSite[]
    allocation: { valid: boolean; groups: Array<{ id: string }>; assignments: Array<{ aircraftId: string; taskObjectIds: string[] }> }
    routes: Array<{ aircraftId: string; waypoints: Array<{ phase: string; position: Coordinate }> }>
    checkResult: { passed: boolean } | null
    executionPlan: { status: string } | null
  }
}
interface RuntimeWorkspace {
  session: { id: string; revision: number; status: string }
  summary: { totalAircraft: number; landedAircraft: number; completedTaskObjects: number }
  groups: Array<{ aircraftCount: number }>
  aircraft: Array<{ aircraftId: string; groupId: string; status: string; completedTaskObjectIds: string[] }>
  events: Array<{ id: string; code: string; status: string }>
  actions: Array<{ actionCode: string }>
  reorganizations: Array<{ action: string }>
}
interface ScaleCase {
  code: "VTL_1" | "VTL_5" | "VTL_20"
  aircraftCount: number
  taskObjectCount: number
  groupCount: number
  groupSizes: number[]
  groupOffsets: number[]
  eventCodes: string[]
}

const scaleCases: ScaleCase[] = [
  { code: "VTL_1", aircraftCount: 1, taskObjectCount: 3, groupCount: 1, groupSizes: [1], groupOffsets: [0], eventCodes: [] },
  { code: "VTL_5", aircraftCount: 5, taskObjectCount: 5, groupCount: 1, groupSizes: [5], groupOffsets: [0], eventCodes: ["VTL_WEATHER"] },
  { code: "VTL_20", aircraftCount: 20, taskObjectCount: 20, groupCount: 4, groupSizes: [5, 5, 5, 5], groupOffsets: [0, 5, 10, 15], eventCodes: ["VTL_WEATHER", "VTL_COMMUNICATION"] }
]

function createMultiTaskWaypoints(main: Coordinate, tasks: Array<{ id: string; positions: Coordinate[] }>, index: number) {
  const offset = index * 0.0001
  const start = { longitude: main.longitude + offset, latitude: main.latitude + offset, altitudeMeters: 10 }
  const climb = { longitude: main.longitude + offset, latitude: main.latitude + offset, altitudeMeters: 80 }
  const transition = { longitude: main.longitude + 0.001 + offset, latitude: main.latitude + offset, altitudeMeters: 90 }
  const cruise = { longitude: (transition.longitude + tasks[0]!.positions[0]!.longitude) / 2, latitude: (transition.latitude + tasks[0]!.positions[0]!.latitude) / 2, altitudeMeters: 120 }
  const taskWaypoints = tasks.map((task, taskIndex) => ({
    phase: "TASK_EXECUTION",
    position: { ...task.positions[0]!, altitudeMeters: 120 + taskIndex * 2 },
    taskObjectId: task.id
  }))
  const lastTask = taskWaypoints.at(-1)!.position
  const returnPoint = { longitude: main.longitude + 0.001 + offset, latitude: main.latitude + offset, altitudeMeters: 120 }
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
    id: `VTL-SCALE-WP-${index}-${sequence}`,
    sequence,
    phase: waypoint.phase,
    position: waypoint.position,
    altitudeMeters: waypoint.position.altitudeMeters,
    speedMps: 20,
    taskObjectId: waypoint.taskObjectId
  }))
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
