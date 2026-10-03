import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { DataSource } from "typeorm"
import { integrationServerEntry } from "../integration-server-entry.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("VTL assessment timing integration", () => {
  let serverProcess: ChildProcess
  let serverOutput = ""
  let baseUrl = ""
  let database: DataSource
  let teacherCookie = ""
  let studentCookie = ""
  let draftId = ""
  let projectId = ""

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
        TYPEORM_SYNCHRONIZE: "false",
        SEED_DEMO_DATA: "true"
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
    if (database?.isInitialized) {
      if (draftId) {
        await database.query(`UPDATE "student_projects" SET "retakeOfProjectId" = NULL WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "student_projects" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_targets" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_snapshot_resource_revisions" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [draftId])
        await database.query(`DELETE FROM "assignment_snapshots" WHERE "draftId" = $1`, [draftId])
        await database.query(`DELETE FROM "assignment_drafts" WHERE "id" = $1`, [draftId])
      }
      await database.destroy()
    }
    if (serverProcess && !serverProcess.killed) serverProcess.kill()
  })

  it("keeps one authoritative deadline and freezes every VTL student write after timeout", async () => {
    const resources = await jsonRequest<Array<{ id: string; packageType: string; status: string; name: string; source: string; manifest: Record<string, unknown> }>>("/v3/resource-packages", { cookie: teacherCookie })
    const regions = await jsonRequest<Array<{ packageId: string; vtlLandingSites: Array<{ id: string; type: string }> }>>("/v3/resource-packages/regions/catalog?sceneType=VTOL_INSPECTION", { cookie: teacherCookie })
    const region = regions[0]!
    const active = resources.filter((resource) => resource.status === "ACTIVE" && resource.source === "BUILT_IN")
    const selectedResources = [
      active.find((resource) => resource.packageType === "RULE"),
      active.find((resource) => resource.packageType === "REGION" && resource.id === region.packageId),
      active.find((resource) => resource.packageType === "SCALE_TEMPLATE" && resource.manifest.sceneType === "VTOL_INSPECTION"),
      active.find((resource) => resource.packageType === "AIRCRAFT"),
      active.find((resource) => resource.packageType === "EVENT" && resource.manifest.sceneType === "VTOL_INSPECTION"),
      active.find((resource) => resource.packageType === "REPORT" && resource.source === "BUILT_IN" && resource.name === "V3 统一评价报告")
    ].filter((resource): resource is NonNullable<typeof resource> => Boolean(resource))
    expect(new Set(selectedResources.map((resource) => resource.packageType))).toEqual(new Set(["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"]))

    const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
    const title = `VTL 考核时钟 ${randomUUID()}`
    const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
      method: "POST",
      cookie: teacherCookie,
      body: {
        title,
        sceneType: "VTOL_INSPECTION",
        mode: "ASSESSMENT",
        config: {
          taskBrief: "在限定时间内完成垂起巡检规划与运行。",
          scaleTemplateCode: "VTL_1",
          regionPackageId: region.packageId,
          availableAt: new Date(Date.now() - 60_000).toISOString(),
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          assessmentDurationMinutes: 60,
          allowResubmission: false,
          allowedValidationAttempts: 1,
          allowedRuntimeAttempts: 1,
          resultVisibility: "TOTAL_ONLY",
          vtlParameters: {
            projectBackground: "考核时钟集成验证",
            completionRequirements: "完成正式方案并提交复盘",
            mainLandingSiteId: region.vtlLandingSites.find((site) => site.type === "MAIN")!.id,
            aircraftModelCode: "VTOL-TEACHING-01",
            aircraftParameterVersion: "1.0.0"
          },
          scenario: { eventCodes: [] }
        }
      }
    })
    draftId = draft.id
    const targets = [{ type: "CLASS", targetId: classes[0]!.id }]
    const resourcePackageIds = selectedResources.map((resource) => resource.id)
    const preview = await jsonRequest<{ configHash: string }>(`/v3/assignments/drafts/${draft.id}/preview`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })
    const preflight = await jsonRequest<{ checkedAt: string; checks: Array<{ code: string; level: string }> }>(`/v3/assignments/drafts/${draft.id}/preflight`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })
    await jsonRequest(`/v3/assignments/drafts/${draft.id}/publish`, {
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

    const projects = await jsonRequest<Array<{ id: string; title: string }>>("/v3/my-projects", { cookie: studentCookie })
    projectId = projects.find((project) => project.title === title)!.id
    let project = await jsonRequest<ProjectTimingView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(project.assessmentTiming).toMatchObject({ state: "NOT_STARTED", startedAt: null, deadlineAt: null, canWrite: false })

    await expectStatus(`/v3/vtl-projects/${projectId}/area/confirm`, 409, studentCookie, { expectedRevision: 1 })
    const firstStage = project.stages.find((stage) => stage.stageCode === "VTL_AREA_OBJECTS")!
    project = await jsonRequest<ProjectTimingView>(`/v3/projects/${projectId}/stages/VTL_AREA_OBJECTS/start`, {
      method: "POST", cookie: studentCookie, body: { expectedRevision: firstStage.revision }
    })
    expect(project.assessmentTiming).toMatchObject({ state: "ACTIVE", canWrite: true, durationMinutes: 60 })
    const authoritativeDeadline = project.assessmentTiming.deadlineAt
    expect(authoritativeDeadline).toBeTruthy()

    const refreshed = await jsonRequest<ProjectTimingView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(refreshed.assessmentTiming.deadlineAt).toBe(authoritativeDeadline)
    expect(refreshed.assessmentTiming.remainingMs).toBeLessThanOrEqual(project.assessmentTiming.remainingMs!)
    const progress = await jsonRequest<Array<{ projectId: string; assessmentTiming: ProjectTimingView["assessmentTiming"] }>>("/v3/teaching/progress?sceneType=VTOL_INSPECTION", { cookie: teacherCookie })
    expect(progress.find((item) => item.projectId === projectId)?.assessmentTiming.deadlineAt).toBe(authoritativeDeadline)

    const expiredAt = new Date(Date.now() - 1_000)
    await database.query(`UPDATE "student_projects" SET "assessmentDeadlineAt" = $2, "assessmentEndedAt" = NULL WHERE "id" = $1`, [projectId, expiredAt])
    const expired = await jsonRequest<ProjectTimingView>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(expired.assessmentTiming).toMatchObject({ state: "EXPIRED", remainingMs: 0, canStart: false, canWrite: false })

    await expectStatus(`/v3/vtl-projects/${projectId}/area/confirm`, 409, studentCookie, { expectedRevision: 1 })
    await expectStatus(`/v3/vtl-projects/${projectId}/runtime/start`, 409, studentCookie, { expectedRevision: 1 })
    await expectStatus(`/v3/vtl-projects/${projectId}/review/summary/submit`, 409, studentCookie, { expectedRevision: 1, summary: "超时后不应允许提交复盘。" })
    await jsonRequest(`/v3/vtl-projects/${projectId}/planning-workspace`, { cookie: teacherCookie })

    const rows = await database.query<Array<{ assessmentStartedAt: Date; assessmentDeadlineAt: Date; assessmentEndedAt: Date }>>(
      `SELECT "assessmentStartedAt", "assessmentDeadlineAt", "assessmentEndedAt" FROM "student_projects" WHERE "id" = $1`,
      [projectId]
    )
    expect(rows[0]!.assessmentStartedAt).toBeTruthy()
    expect(new Date(rows[0]!.assessmentDeadlineAt).toISOString()).toBe(expiredAt.toISOString())
    expect(new Date(rows[0]!.assessmentEndedAt).toISOString()).toBe(expiredAt.toISOString())

    await expectStatus(`/v3/projects/${projectId}/assessment-retakes`, 403, studentCookie, { reason: "学生不能自行创建补考" })
    await expectStatus(`/v3/projects/${projectId}/assessment-retakes`, 400, teacherCookie, { reason: "   " })
    const retakeAvailableAt = new Date(Date.now() - 1_000)
    const retakeDueAt = new Date(Date.now() + 2 * 60 * 60_000)
    const retake = await jsonRequest<ProjectTimingView>(`/v3/projects/${projectId}/assessment-retakes`, {
      method: "POST",
      cookie: teacherCookie,
      body: {
        reason: "原考核期间网络中断，经教师核实后安排补考",
        availableAt: retakeAvailableAt.toISOString(),
        dueAt: retakeDueAt.toISOString()
      }
    })
    expect(retake.id).not.toBe(projectId)
    expect(retake).toMatchObject({
      status: "NOT_STARTED",
      currentStageCode: "VTL_AREA_OBJECTS",
      assessmentAttempt: {
        attemptNumber: 2,
        isRetake: true,
        retakeOfProjectId: projectId,
        retakeReason: "原考核期间网络中断，经教师核实后安排补考"
      },
      assessmentTiming: { state: "NOT_STARTED", startedAt: null, deadlineAt: null, canStart: true, canWrite: false }
    })
    expect(retake.stages).toHaveLength(8)
    expect(retake.stages[0]).toMatchObject({ stageCode: "VTL_AREA_OBJECTS", status: "AVAILABLE", revision: 1 })
    expect(retake.stages.slice(1).every((stage) => stage.status === "LOCKED" && stage.revision === 1)).toBe(true)

    const studentAttempts = (await jsonRequest<ProjectTimingView[]>("/v3/my-projects", { cookie: studentCookie }))
      .filter((item) => item.title === title)
      .sort((left, right) => left.assessmentAttempt.attemptNumber - right.assessmentAttempt.attemptNumber)
    expect(studentAttempts.map((item) => [item.id, item.assessmentAttempt.attemptNumber])).toEqual([
      [projectId, 1],
      [retake.id, 2]
    ])

    const persistedAttempts = await database.query<Array<{
      id: string
      attemptNumber: number
      retakeOfProjectId: string | null
      assessmentStartedAt: Date | null
      assessmentDeadlineAt: Date | null
      assessmentEndedAt: Date | null
    }>>(`
      SELECT "id", "attemptNumber", "retakeOfProjectId", "assessmentStartedAt", "assessmentDeadlineAt", "assessmentEndedAt"
      FROM "student_projects"
      WHERE "snapshotId" = (SELECT "snapshotId" FROM "student_projects" WHERE "id" = $1)
        AND "studentId" = (SELECT "studentId" FROM "student_projects" WHERE "id" = $1)
      ORDER BY "attemptNumber"
    `, [projectId])
    expect(persistedAttempts[0]).toMatchObject({ id: projectId, attemptNumber: 1, retakeOfProjectId: null })
    expect(new Date(persistedAttempts[0]!.assessmentDeadlineAt!).toISOString()).toBe(expiredAt.toISOString())
    expect(new Date(persistedAttempts[0]!.assessmentEndedAt!).toISOString()).toBe(expiredAt.toISOString())
    expect(persistedAttempts[1]).toMatchObject({ id: retake.id, attemptNumber: 2, retakeOfProjectId: projectId, assessmentStartedAt: null, assessmentDeadlineAt: null, assessmentEndedAt: null })

    const retakeStage = retake.stages.find((stage) => stage.stageCode === "VTL_AREA_OBJECTS")!
    const startedRetake = await jsonRequest<ProjectTimingView>(`/v3/projects/${retake.id}/stages/VTL_AREA_OBJECTS/start`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: retakeStage.revision }
    })
    expect(startedRetake.assessmentTiming).toMatchObject({ state: "ACTIVE", canWrite: true })
    expect(Date.parse(startedRetake.assessmentTiming.deadlineAt!)).toBeLessThanOrEqual(retakeDueAt.getTime())

    const concurrentRetakes = await Promise.all([
      jsonRequest<ProjectTimingView>(`/v3/projects/${retake.id}/assessment-retakes`, {
        method: "POST",
        cookie: teacherCookie,
        body: { reason: "并发补考编号验证 A", availableAt: retakeAvailableAt.toISOString(), dueAt: retakeDueAt.toISOString() }
      }),
      jsonRequest<ProjectTimingView>(`/v3/projects/${projectId}/assessment-retakes`, {
        method: "POST",
        cookie: teacherCookie,
        body: { reason: "并发补考编号验证 B", availableAt: retakeAvailableAt.toISOString(), dueAt: retakeDueAt.toISOString() }
      })
    ])
    expect(concurrentRetakes.map((item) => item.assessmentAttempt.attemptNumber).sort((left, right) => left - right)).toEqual([3, 4])
    expect(new Set(concurrentRetakes.map((item) => item.id)).size).toBe(2)

    const retakeAudit = await database.query<Array<{ projectId: string; actorId: string; payload: Record<string, unknown>; result: Record<string, unknown> }>>(`
      SELECT "projectId", "actorId", "payload", "result"
      FROM "project_activity_events"
      WHERE "eventType" = 'ASSESSMENT_RETAKE_CREATED'
        AND ("projectId" = $1 OR "projectId" = $2)
      ORDER BY "createdAt"
    `, [projectId, retake.id])
    expect(retakeAudit.some((item) => item.projectId === projectId && item.result.attemptNumber === 2)).toBe(true)
    expect(retakeAudit.some((item) => item.projectId === retake.id && item.payload.reason === "原考核期间网络中断，经教师核实后安排补考")).toBe(true)
    const initializedCounters = await database.query<Array<{ count: string }>>(`
      SELECT COUNT(*)::text AS "count" FROM "project_activity_counters"
      WHERE "projectId" = ANY($1::uuid[])
    `, [[retake.id, ...concurrentRetakes.map((item) => item.id)]])
    expect(Number(initializedCounters[0]!.count)).toBe(3)
  }, 30_000)

  async function login(email: string, password: string): Promise<string> {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    })
    if (!response.ok) throw new Error(`Login failed: ${response.status} ${await response.text()}`)
    return response.headers.get("set-cookie")?.split(";", 1)[0] ?? ""
  }

  async function jsonRequest<T = unknown>(path: string, options: RequestOptions): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { ...(options.body ? { "content-type": "application/json" } : {}), cookie: options.cookie },
      body: options.body ? JSON.stringify(options.body) : undefined
    })
    if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}\n${serverOutput}`)
    return response.json() as Promise<T>
  }

  async function expectStatus(path: string, status: number, cookie: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body)
    })
    expect(response.status, await response.text()).toBe(status)
  }

  async function waitForServer(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/healthz`)
        if (response.ok) return
      } catch {}
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    }
    throw new Error(`Server did not start\n${serverOutput}`)
  }
})

interface RequestOptions {
  method?: string
  cookie: string
  body?: unknown
}

interface ProjectTimingView {
  id: string
  title: string
  status: string
  currentStageCode: string
  assessmentAttempt: {
    attemptNumber: number
    isRetake: boolean
    retakeOfProjectId: string | null
    retakeReason: string | null
  }
  assessmentTiming: {
    state: string
    durationMinutes: number | null
    startedAt: string | null
    deadlineAt: string | null
    remainingMs: number | null
    canStart: boolean
    canWrite: boolean
  }
  stages: Array<{ stageCode: string; status: string; revision: number }>
}

function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Unable to allocate port"))
      server.close(() => resolvePort(address.port))
    })
  })
}
