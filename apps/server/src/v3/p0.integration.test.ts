import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DataSource } from "typeorm"
import { createSignedResourceArchive } from "./resources/resource-archive.fixtures.js"
import { integrationServerEntry } from "../integration-server-entry.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("V3 P0 integration", () => {
  let serverProcess: ChildProcess
  let baseUrl: string
  let serverError = ""
  let storageDirectory: string
  let integrationDatabase: DataSource
  let documentPackageId = ""
  let resourceUpgradePackageId = ""
  const documentKeyId = `p0-documents-${randomUUID()}`
  const documentKeyPair = generateKeyPairSync("ed25519")

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), "wurenji-v3-integration-"))
    const port = await availablePort()
    baseUrl = `http://127.0.0.1:${port}/api`
    const documentPublicKey = documentKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
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
        V3_ALLOW_UNSIGNED_RESOURCE_REGISTRATION: "true",
        V3_FILE_STORAGE_DIR: storageDirectory,
        RESOURCE_PACKAGE_TRUSTED_KEYS_JSON: JSON.stringify({ [documentKeyId]: documentPublicKey })
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    serverProcess.stdout?.on("data", (chunk: Buffer) => { serverError += chunk.toString("utf8") })
    serverProcess.stderr?.on("data", (chunk: Buffer) => { serverError += chunk.toString("utf8") })
    await waitForServer()
    integrationDatabase = new DataSource({ type: "postgres", url: process.env.V3_INTEGRATION_DATABASE_URL! })
    await integrationDatabase.initialize()
  }, 30_000)

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) serverProcess.kill()
    if (integrationDatabase?.isInitialized) {
      if (documentPackageId) {
        await integrationDatabase.query(`DELETE FROM "resource_packages" WHERE "id" = $1`, [documentPackageId])
        await integrationDatabase.query(`DELETE FROM "file_assets" WHERE "ownerType" = 'RESOURCE_PACKAGE' AND "ownerId" = $1`, [documentPackageId])
      }
      if (resourceUpgradePackageId) await integrationDatabase.query(`DELETE FROM "resource_packages" WHERE "id" = $1`, [resourceUpgradePackageId])
      await integrationDatabase.destroy()
    }
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true })
  })

  it("publishes an immutable show assignment and provisions student stages", async () => {
    const adminCookie = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
    documentPackageId = await uploadAndActivateDocumentPackage(adminCookie)
    const resources = await jsonRequest<Array<{
      id: string
      packageType: string
      name: string
      version: string
      status: string
      source: string
      manifest: Record<string, unknown>
    }>>("/v3/resource-packages", { cookie: adminCookie })
    const regionCatalog = await jsonRequest<Array<{
      packageId: string
      sceneType: "CITY_SHOW" | "CITY_LOGISTICS"
      center: { longitude: number; latitude: number }
      layers: Array<{ code: string }>
    }>>("/v3/resource-packages/regions/catalog", { cookie: adminCookie })
    expect(regionCatalog.filter((regionItem) => regionItem.sceneType === "CITY_SHOW").length).toBeGreaterThanOrEqual(3)
    expect(regionCatalog.filter((regionItem) => regionItem.sceneType === "CITY_LOGISTICS").length).toBeGreaterThanOrEqual(3)
    expect(regionCatalog.every((regionItem) => new Set(regionItem.layers.map((layer) => layer.code)).size === 5)).toBe(true)
    const selectedShowRegion = regionCatalog.find((regionItem) => regionItem.sceneType === "CITY_SHOW")
    expect(selectedShowRegion).toBeDefined()
    const scaleTemplates = await jsonRequest<Array<{ sceneType: string; code: string; totalAircraft: number }>>("/v3/resource-packages/scale-templates/catalog?sceneType=CITY_SHOW", { cookie: adminCookie })
    expect(scaleTemplates.map((item) => item.totalAircraft)).toEqual([100, 500, 1000, 3000])
    expect(scaleTemplates.every((item) => item.sceneType === "CITY_SHOW" && item.code.startsWith("SHOW_"))).toBe(true)
    const showResources = resources.filter((resource) => {
      if (resource.status !== "ACTIVE" || resource.manifest.testOnly === true) return false
      if (resource.packageType === "DOCUMENT_TEMPLATE") return resource.id === documentPackageId
      if (resource.source !== "BUILT_IN") return false
      if (resource.packageType === "REGION") return resource.id === selectedShowRegion!.packageId
      if (resource.packageType !== "SCALE_TEMPLATE" && resource.packageType !== "EVENT") return true
      return resource.manifest.sceneType === "CITY_SHOW"
    })
    expect(new Set(showResources.map((resource) => resource.packageType))).toEqual(new Set([
      "RULE",
      "REGION",
      "SCALE_TEMPLATE",
      "AIRCRAFT",
      "EVENT",
      "DOCUMENT_TEMPLATE",
      "REPORT"
    ]))

    const teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
    const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
    const classroom = classes[0]
    const region = showResources.find((resource) => resource.packageType === "REGION")
    expect(classroom).toBeDefined()
    expect(region).toBeDefined()

    const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
      method: "POST",
      cookie: teacherCookie,
      body: {
        title: "P0 编队表演发布测试",
        sceneType: "CITY_SHOW",
        mode: "TRAINING",
        isAcceptanceData: true,
        config: {
          taskBrief: "完成区域规划、申报准备与异常处置训练",
          showParameters: showParameters(),
          scaleTemplateCode: "SHOW_100",
          regionPackageId: region!.id,
          availableAt: new Date(Date.now() - 60_000).toISOString(),
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          allowResubmission: true,
          allowedValidationAttempts: 3,
          allowedRuntimeAttempts: 3,
          resultVisibility: "FULL_REVIEW",
          scenario: { eventCodes: ["WEATHER_LIMIT"] }
        }
      }
    })
    const targets = [{ type: "CLASS" as const, targetId: classroom!.id }]
    const resourcePackageIds = showResources.map((resource) => resource.id)
    const preview = await jsonRequest<{ configHash: string; studentCount: number }>(`/v3/assignments/drafts/${draft.id}/preview`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })
    expect(preview.studentCount).toBe(2)
    const preflight = await jsonRequest<{ checkedAt: string; checks: Array<{ code: string; level: string }> }>(`/v3/assignments/drafts/${draft.id}/preflight`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })

    const published = await jsonRequest<{ snapshot: { id: string; checksum: string; config: { showParameters: { plannedAudienceCount: number; maximumHeightMeters: number } } }; projectCount: number }>(`/v3/assignments/drafts/${draft.id}/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds, preflightConfirmation: { checkedAt: preflight.checkedAt, checkCodes: preflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code) } }
    })
    expect(published.projectCount).toBe(2)
    expect(published.snapshot.checksum).toMatch(/^[a-f0-9]{64}$/)
    expect(published.snapshot.config.showParameters).toMatchObject({ plannedAudienceCount: 3000, maximumHeightMeters: 120 })
    const republished = await jsonRequest<{ snapshot: { id: string; checksum: string }; projectCount: number }>(`/v3/assignments/drafts/${draft.id}/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds }
    })
    expect(republished).toEqual(published)

    const copiedDraft = await jsonRequest<{ id: string; status: string; revision: number; title: string }>(`/v3/assignments/drafts/${draft.id}/copy`, {
      method: "POST",
      cookie: teacherCookie
    })
    expect(copiedDraft).toMatchObject({ status: "DRAFT", revision: 1 })
    expect(copiedDraft.title).toContain("副本")
    await jsonRequest(`/v3/assignments/drafts/${copiedDraft.id}`, { method: "DELETE", cookie: teacherCookie })

    const withdrawDraft = await jsonRequest<{ id: string; revision: number }>(`/v3/assignments/drafts/${draft.id}/copy`, {
      method: "POST",
      cookie: teacherCookie
    })
    const withdrawPreview = await jsonRequest<{ configHash: string }>(`/v3/assignments/drafts/${withdrawDraft.id}/preview`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: withdrawDraft.revision, targets, resourcePackageIds }
    })
    const withdrawPreflight = await jsonRequest<{ checkedAt: string; checks: Array<{ code: string; level: string }> }>(`/v3/assignments/drafts/${withdrawDraft.id}/preflight`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: withdrawDraft.revision, targets, resourcePackageIds }
    })
    await jsonRequest(`/v3/assignments/drafts/${withdrawDraft.id}/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: withdrawDraft.revision, configHash: withdrawPreview.configHash, targets, resourcePackageIds, preflightConfirmation: { checkedAt: withdrawPreflight.checkedAt, checkCodes: withdrawPreflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code) } }
    })
    const withdrawn = await jsonRequest<{ status: string; revision: number }>(`/v3/assignments/${withdrawDraft.id}/withdraw`, {
      method: "POST",
      cookie: teacherCookie,
      body: { reason: "发布范围需要调整" }
    })
    expect(withdrawn).toMatchObject({ status: "DRAFT", revision: 2 })

    const classStudents = await jsonRequest<Array<{ id: string; displayName: string }>>(`/v1/education/classes/${classroom!.id}/students`, { cookie: teacherCookie })
    const specifiedDraft = await jsonRequest<{ id: string; revision: number }>(`/v3/assignments/drafts/${draft.id}/copy`, { method: "POST", cookie: teacherCookie })
    const specifiedTargets = [{ type: "STUDENT" as const, targetId: classStudents[0]!.id }]
    const specifiedPreview = await jsonRequest<{ configHash: string; studentCount: number }>(`/v3/assignments/drafts/${specifiedDraft.id}/preview`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: specifiedDraft.revision, targets: specifiedTargets, resourcePackageIds }
    })
    expect(specifiedPreview.studentCount).toBe(1)
    const specifiedPreflight = await jsonRequest<{ checkedAt: string; checks: Array<{ code: string; level: string }> }>(`/v3/assignments/drafts/${specifiedDraft.id}/preflight`, {
      method: "POST", cookie: teacherCookie, body: { expectedRevision: specifiedDraft.revision, targets: specifiedTargets, resourcePackageIds }
    })
    const specifiedPublished = await jsonRequest<{ projectCount: number }>(`/v3/assignments/drafts/${specifiedDraft.id}/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: specifiedDraft.revision, configHash: specifiedPreview.configHash, targets: specifiedTargets, resourcePackageIds, preflightConfirmation: { checkedAt: specifiedPreflight.checkedAt, checkCodes: specifiedPreflight.checks.filter((check) => check.level === "WARNING").map((check) => check.code) } }
    })
    expect(specifiedPublished.projectCount).toBe(1)
    const specifiedDetail = await jsonRequest<{
      assignment: { config: { taskBrief: string } }
      targets: Array<{ type: string; targetId: string }>
      projectCount: number
      startedProjectCount: number
    }>(`/v3/assignments/${specifiedDraft.id}/detail`, { cookie: teacherCookie })
    expect(specifiedDetail.assignment.config.taskBrief).toContain("区域规划")
    expect(specifiedDetail.targets).toEqual([expect.objectContaining({ type: "STUDENT", targetId: classStudents[0]!.id })])
    expect(specifiedDetail).toMatchObject({ projectCount: 1, startedProjectCount: 0 })
    await jsonRequest(`/v3/assignments/${specifiedDraft.id}/withdraw`, {
      method: "POST",
      cookie: teacherCookie,
      body: { reason: "指定学生发布验收完成" }
    })

    const originalReport = showResources.find((resource) => resource.packageType === "REPORT")!
    const upgradeReport = await jsonRequest<{ id: string; status: string }>("/v3/resource-packages", {
      method: "POST",
      cookie: adminCookie,
      body: {
        packageType: "REPORT",
        name: `P0 双场景评价升级 ${randomUUID()}`,
        version: "99.0.0",
        sha256: "d".repeat(64),
        manifest: originalReport.manifest
      }
    })
    resourceUpgradePackageId = upgradeReport.id
    expect(upgradeReport.status).toBe("STAGED")
    await jsonRequest(`/v3/resource-packages/${upgradeReport.id}/activate`, { method: "POST", cookie: adminCookie })
    const beforeUpgradeProjects = await integrationDatabase.query(
      `SELECT "id", "status", "currentStageCode" FROM "student_projects" WHERE "snapshotId" = $1 ORDER BY "id"`,
      [published.snapshot.id]
    ) as Array<{ id: string; status: string; currentStageCode: string }>
    const upgradePreview = await jsonRequest<{
      eligible: boolean
      expectedRevision: number
      snapshotChecksum: string
      startedProjectCount: number
      changes: Array<{ packageType: string; current: { packageId: string }; replacement: { packageId: string } }>
    }>(`/v3/assignments/${draft.id}/resource-upgrade`, { cookie: teacherCookie })
    expect(upgradePreview).toMatchObject({ eligible: true, startedProjectCount: 0 })
    expect(upgradePreview.changes).toContainEqual(expect.objectContaining({
      packageType: "REPORT",
      current: expect.objectContaining({ packageId: originalReport.id }),
      replacement: expect.objectContaining({ packageId: upgradeReport.id })
    }))
    const upgraded = await jsonRequest<{
      assignment: { revision: number }
      snapshot: { id: string; checksum: string; resourceRevision: number; resourceRefs: Array<{ packageId: string }> }
      changes: Array<{ packageType: string }>
    }>(`/v3/assignments/${draft.id}/resource-upgrade`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: upgradePreview.expectedRevision, snapshotChecksum: upgradePreview.snapshotChecksum }
    })
    expect(upgraded.snapshot).toMatchObject({ id: published.snapshot.id, resourceRevision: 2 })
    expect(upgraded.snapshot.resourceRefs).toContainEqual(expect.objectContaining({ packageId: upgradeReport.id }))
    expect(upgraded.changes).toContainEqual(expect.objectContaining({ packageType: "REPORT" }))
    const revisionRows = await integrationDatabase.query(
      `SELECT "revision", "checksum" FROM "assignment_snapshot_resource_revisions" WHERE "snapshotId" = $1 ORDER BY "revision"`,
      [published.snapshot.id]
    ) as Array<{ revision: number; checksum: string }>
    expect(revisionRows).toEqual([
      { revision: 1, checksum: published.snapshot.checksum },
      { revision: 2, checksum: upgraded.snapshot.checksum }
    ])
    const afterUpgradeProjects = await integrationDatabase.query(
      `SELECT "id", "status", "currentStageCode" FROM "student_projects" WHERE "snapshotId" = $1 ORDER BY "id"`,
      [published.snapshot.id]
    ) as Array<{ id: string; status: string; currentStageCode: string }>
    expect(afterUpgradeProjects).toEqual(beforeUpgradeProjects)
    const noUpdatePreview = await jsonRequest<{ eligible: boolean; changes: unknown[] }>(`/v3/assignments/${draft.id}/resource-upgrade`, { cookie: teacherCookie })
    expect(noUpdatePreview).toMatchObject({ eligible: true, changes: [] })
    await expectRequestStatus(`/v3/assignments/${draft.id}/resource-upgrade`, 409, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: upgraded.assignment.revision, snapshotChecksum: upgraded.snapshot.checksum }
    })

    const studentCookie = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
    const projects = await jsonRequest<Array<{
      id: string
      assignmentSnapshotId: string
      status: string
      stages: Array<{ stageCode: string; status: string; revision: number; allowedActions: string[] }>
    }>>("/v3/my-projects?includeInternalData=true", { cookie: studentCookie })
    const project = projects.find((item) => item.assignmentSnapshotId === published.snapshot.id)
    expect(project?.stages[0]).toMatchObject({
      stageCode: "SHOW_AREA_PLANNING",
      status: "AVAILABLE",
      revision: 1,
      allowedActions: ["START"]
    })
    expect(project?.stages.slice(1).every((stage) => stage.status === "LOCKED")).toBe(true)

    const started = await jsonRequest<{ assignmentStatus: string; status: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(
      `/v3/projects/${project!.id}/stages/SHOW_AREA_PLANNING/start`,
      { method: "POST", cookie: studentCookie, body: { expectedRevision: 1 } }
    )
    expect(started.status).toBe("IN_PROGRESS")
    expect(started.assignmentStatus).toBe("IN_PROGRESS")
    expect(started.stages[0]).toMatchObject({ stageCode: "SHOW_AREA_PLANNING", status: "IN_PROGRESS", revision: 2 })
    const teacherReadOnlyReview = await jsonRequest<{ actor: string; canReview: boolean; timeline: unknown[] }>(`/v3/show-projects/${project!.id}/review`, { cookie: teacherCookie })
    expect(teacherReadOnlyReview).toMatchObject({ actor: "TEACHER", canReview: false })
    expect(Array.isArray(teacherReadOnlyReview.timeline)).toBe(true)
    const lockedUpgradePreview = await jsonRequest<{ eligible: boolean; startedProjectCount: number; reason: string }>(`/v3/assignments/${draft.id}/resource-upgrade`, { cookie: teacherCookie })
    expect(lockedUpgradePreview.eligible).toBe(false)
    expect(lockedUpgradePreview.startedProjectCount).toBe(1)
    expect(lockedUpgradePreview.reason).toContain("继续使用原资源版本")
    await expectRequestStatus(`/v3/assignments/${draft.id}/resource-upgrade`, 409, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: upgraded.assignment.revision, snapshotChecksum: upgraded.snapshot.checksum }
    })
    await expectRequestStatus(`/v3/assignments/${draft.id}/withdraw`, 409, {
      method: "POST",
      cookie: teacherCookie,
      body: { reason: "尝试撤回已开始任务" }
    })

    const filteredProgress = await jsonRequest<Array<{
      projectId: string
      currentStageCode: string
      submissionState: string
      alertState: string
      evaluationState: string
    }>>("/v3/teaching/progress?sceneType=CITY_SHOW&stageCode=SHOW_AREA_PLANNING&submissionState=IN_PROGRESS&alertState=NONE&evaluationState=NOT_STARTED&includeInternalData=true", { cookie: teacherCookie })
    expect(filteredProgress.find((item) => item.projectId === project!.id)).toMatchObject({
      currentStageCode: "SHOW_AREA_PLANNING",
      submissionState: "IN_PROGRESS",
      alertState: "NONE",
      evaluationState: "NOT_STARTED"
    })
    const planningFocus = await jsonRequest<Array<{ projectId: string }>>("/v3/teaching/progress?focusState=PLANNING&includeInternalData=true", { cookie: teacherCookie })
    expect(planningFocus).toContainEqual(expect.objectContaining({ projectId: project!.id }))
    const classroomProgress = await jsonRequest<Array<{ projectId: string }>>(
      `/v3/teaching/progress?classroomId=${classroom!.id}&includeInternalData=true`,
      { cookie: teacherCookie }
    )
    expect(classroomProgress).toContainEqual(expect.objectContaining({ projectId: project!.id }))
    const alertId = randomUUID()
    const alertCorrelationId = randomUUID()
    await integrationDatabase.query(`
      INSERT INTO "runtime_alerts" (
        "id", "projectId", "stageCode", "code", "title", "detail", "severity", "status", "payload", "correlationId"
      ) VALUES ($1, $2, 'SHOW_AREA_PLANNING', 'INTEGRATION_WARNING', '集成测试告警', '验证教师进度真实告警来源', 'WARNING', 'OPEN', '{}'::jsonb, $3)
    `, [alertId, project!.id, alertCorrelationId])
    const progressWithAlert = await jsonRequest<Array<{
      projectId: string
      alertState: string
      alerts: Array<{ id: string; title: string; status: string }>
    }>>("/v3/teaching/progress?alertState=OPEN&includeInternalData=true", { cookie: teacherCookie })
    expect(progressWithAlert).toContainEqual(expect.objectContaining({ projectId: project!.id, alertState: "OPEN" }))
    expect(progressWithAlert.find((item) => item.projectId === project!.id)?.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: alertId, title: "集成测试告警", status: "OPEN" })
    ]))
    const severeFocusAlertId = randomUUID()
    await integrationDatabase.query(`
      INSERT INTO "runtime_alerts" (
        "id", "projectId", "stageCode", "code", "title", "detail", "severity", "status", "payload", "correlationId"
      ) VALUES ($1, $2, 'SHOW_AREA_PLANNING', 'INTEGRATION_CRITICAL', '集成测试严重告警', '验证严重告警快捷筛选', 'CRITICAL', 'OPEN', '{}'::jsonb, $3)
    `, [severeFocusAlertId, project!.id, randomUUID()])
    const severeFocus = await jsonRequest<Array<{ projectId: string }>>("/v3/teaching/progress?focusState=SEVERE_ALERT&includeInternalData=true", { cookie: teacherCookie })
    expect(severeFocus).toContainEqual(expect.objectContaining({ projectId: project!.id }))
    const overviewWithAlert = await jsonRequest<{
      metrics: Array<{ key: string; value: number }>
    }>("/v3/teaching/overview", { cookie: teacherCookie })
    expect(overviewWithAlert.metrics.find((metric) => metric.key === "ALERTS")?.value).toBeGreaterThanOrEqual(1)
    const projectAlerts = await jsonRequest<Array<{ id: string; status: string; title: string }>>(`/v3/projects/${project!.id}/alerts?status=OPEN`, { cookie: studentCookie })
    expect(projectAlerts).toContainEqual(expect.objectContaining({ id: alertId, status: "OPEN", title: "集成测试告警" }))
    await integrationDatabase.query(`UPDATE "runtime_alerts" SET "status" = 'RESOLVED', "resolvedAt" = now() WHERE "id" = $1`, [alertId])

    const evaluationId = randomUUID()
    await integrationDatabase.query(`
      INSERT INTO "project_evaluations" ("id", "projectId", "status", "rubricVersion", "objectiveMetrics", "teacherScores", "summary", "revision")
      VALUES ($1, $2, 'PENDING', 'integration-v1', '[]'::jsonb, '[]'::jsonb, '', 1)
    `, [evaluationId, project!.id])
    const progressPendingEvaluation = await jsonRequest<Array<{ projectId: string; evaluationState: string }>>("/v3/teaching/progress?evaluationState=PENDING&includeInternalData=true", { cookie: teacherCookie })
    expect(progressPendingEvaluation).toContainEqual(expect.objectContaining({ projectId: project!.id, evaluationState: "PENDING" }))
    const pendingFocus = await jsonRequest<Array<{ projectId: string }>>("/v3/teaching/progress?focusState=PENDING_EVALUATION&includeInternalData=true", { cookie: teacherCookie })
    expect(pendingFocus).toContainEqual(expect.objectContaining({ projectId: project!.id }))
    const teachingOverview = await jsonRequest<{
      metrics: Array<{ key: string; value: number }>
      assignments: Array<{ id: string; isDemo: boolean; isAcceptanceData: boolean }>
      recentProgress: Array<{ projectId: string }>
    }>("/v3/teaching/overview", { cookie: teacherCookie })
    expect(teachingOverview.metrics.find((metric) => metric.key === "IN_PROGRESS")?.value).toBeGreaterThanOrEqual(1)
    expect(teachingOverview.recentProgress.some((item) => item.projectId === project!.id)).toBe(false)
    expect(teachingOverview.assignments.some((item) => item.id === draft.id)).toBe(false)
    const internalTeachingOverview = await jsonRequest<{
      assignments: Array<{ id: string; isDemo: boolean; isAcceptanceData: boolean }>
      recentProgress: Array<{ projectId: string }>
    }>("/v3/teaching/overview?includeInternalData=true", { cookie: teacherCookie })
    expect(internalTeachingOverview.assignments).toContainEqual(expect.objectContaining({ id: draft.id, isAcceptanceData: true }))
    expect(internalTeachingOverview.recentProgress.some((item) => item.projectId === project!.id)).toBe(true)

    const areaFeatures = completeAreaFeatures(selectedShowRegion!.center)
    const savedArea = await jsonRequest<{
      draft: { revision: number; features: unknown[] }
      versions: unknown[]
    }>(`/v3/show-projects/${project!.id}/area-plan/draft`, {
      method: "PUT",
      cookie: studentCookie,
      body: { expectedRevision: 0, features: areaFeatures }
    })
    expect(savedArea.draft).toMatchObject({ revision: 1 })
    expect(savedArea.draft.features).toHaveLength(9)

    const areaCheck = await jsonRequest<{ passed: boolean; completeTypeCount: number; evidence: Array<{ blocking: boolean }> }>(`/v3/show-projects/${project!.id}/area-plan/check`, {
      method: "POST",
      cookie: studentCookie
    })
    expect(areaCheck).toMatchObject({ passed: true, completeTypeCount: 9 })
    expect(areaCheck.evidence.every((item) => !item.blocking)).toBe(true)

    const areaSnapshot = await jsonRequest<{ versions: Array<{ versionNo: number; status: string }> }>(`/v3/show-projects/${project!.id}/area-plan/snapshot`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: 1 }
    })
    expect(areaSnapshot.versions[0]).toMatchObject({ versionNo: 1, status: "SNAPSHOT" })

    const submittedArea = await jsonRequest<{
      project: { stages: Array<{ stageCode: string; status: string; revision: number }> }
      workspace: { versions: Array<{ id: string; versionNo: number; status: string; planningMapAsset: { id: string; downloadPath: string; sha256: string } | null }> }
    }>(`/v3/show-projects/${project!.id}/area-plan/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: 1, expectedStageRevision: 2 }
    })
    const firstSubmission = submittedArea.workspace.versions.find((version) => version.status === "SUBMITTED")
    expect(firstSubmission).toMatchObject({ versionNo: 2, status: "SUBMITTED" })
    expect(firstSubmission?.planningMapAsset?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(submittedArea.project.stages[0]).toMatchObject({ status: "SUBMITTED", revision: 3 })
    const mapResponse = await fetch(`${baseUrl}${firstSubmission!.planningMapAsset!.downloadPath}`, { headers: { Cookie: studentCookie } })
    expect(mapResponse.status).toBe(200)
    expect(mapResponse.headers.get("content-type")).toContain("image/png")
    expect(Buffer.from(await mapResponse.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))

    const returnedArea = await jsonRequest<{
      project: { stages: Array<{ stageCode: string; status: string; revision: number }> }
      workspace: { versions: Array<{ id: string; status: string; review: { comment: string; score: number } | null }> }
    }>(`/v3/show-projects/${project!.id}/area-plan/versions/${firstSubmission!.id}/return`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "请明确观众区与缓冲区的位置关系", score: 82 }
    })
    expect(returnedArea.project.stages[0]).toMatchObject({ status: "RETURNED", revision: 4 })
    expect(returnedArea.workspace.versions.find((version) => version.id === firstSubmission!.id)).toMatchObject({
      status: "RETURNED",
      review: { score: 82 }
    })

    const resumedArea = await jsonRequest<{ stages: Array<{ stageCode: string; status: string; revision: number }> }>(
      `/v3/projects/${project!.id}/stages/SHOW_AREA_PLANNING/start`,
      { method: "POST", cookie: studentCookie, body: { expectedRevision: 4 } }
    )
    expect(resumedArea.stages[0]).toMatchObject({ status: "IN_PROGRESS", revision: 5 })
    areaFeatures[5]!.label = "观众区（已复核）"
    const revisedDraft = await jsonRequest<{ draft: { revision: number } }>(`/v3/show-projects/${project!.id}/area-plan/draft`, {
      method: "PUT",
      cookie: studentCookie,
      body: { expectedRevision: 1, features: areaFeatures }
    })
    expect(revisedDraft.draft.revision).toBe(2)
    const resubmittedArea = await jsonRequest<{
      project: { stages: Array<{ stageCode: string; status: string; revision: number }> }
      workspace: { versions: Array<{ id: string; versionNo: number; status: string }> }
    }>(`/v3/show-projects/${project!.id}/area-plan/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: 2, expectedStageRevision: 5 }
    })
    const secondSubmission = resubmittedArea.workspace.versions.find((version) => version.status === "SUBMITTED")
    expect(secondSubmission).toMatchObject({ versionNo: 3, status: "SUBMITTED" })
    expect(resubmittedArea.project.stages[0]).toMatchObject({ status: "SUBMITTED", revision: 6 })

    const acceptedArea = await jsonRequest<{
      project: { currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }
    }>(`/v3/show-projects/${project!.id}/area-plan/versions/${secondSubmission!.id}/accept`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "区域划分与位置关系说明满足本次教学任务要求", score: 94 }
    })
    expect(acceptedArea.project.currentStageCode).toBe("SHOW_FLIGHT_APPLICATION")
    expect(acceptedArea.project.stages[0]).toMatchObject({ status: "ACCEPTED", revision: 7 })
    expect(acceptedArea.project.stages[1]).toMatchObject({ stageCode: "SHOW_FLIGHT_APPLICATION", status: "AVAILABLE", revision: 2 })

    const activities = await jsonRequest<Array<{ eventType: string; projectId: string }>>(`/v3/projects/${project!.id}/activities`, { cookie: teacherCookie })
    expect(activities.map((event) => event.eventType)).toEqual(expect.arrayContaining([
      "PROJECT_ASSIGNED",
      "ASSIGNMENT_RESOURCES_UPDATED",
      "STAGE_STARTED",
      "AREA_DRAFT_SAVED",
      "AREA_DRAFT_CHECKED",
      "AREA_SNAPSHOT_CREATED",
      "AREA_PLAN_SUBMITTED",
      "AREA_PLAN_RETURNED",
      "AREA_PLAN_ACCEPTED"
    ]))

    const ended = await jsonRequest<{ status: string; endedAt: string | null }>(`/v3/assignments/${draft.id}/end`, {
      method: "POST",
      cookie: teacherCookie,
      body: { reason: "本轮实训已结束" }
    })
    expect(ended.status).toBe("ENDED")
    expect(ended.endedAt).not.toBeNull()
    await expectRequestStatus(`/v3/projects/${project!.id}/stages/SHOW_FLIGHT_APPLICATION/start`, 409, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: 2 }
    })
    const archived = await jsonRequest<{ status: string; archivedAt: string | null }>(`/v3/assignments/${draft.id}/archive`, {
      method: "POST",
      cookie: teacherCookie,
      body: {}
    })
    expect(archived.status).toBe("ARCHIVED")
    expect(archived.archivedAt).not.toBeNull()
    const archivedProject = await jsonRequest<{ assignmentStatus: string; stages: Array<{ allowedActions: string[] }> }>(`/v3/projects/${project!.id}/stages`, { cookie: studentCookie })
    expect(archivedProject.assignmentStatus).toBe("ARCHIVED")
    expect(archivedProject.stages.every((stage) => stage.allowedActions.length === 0)).toBe(true)

    const resourceName = `P0-resource-lock-${randomUUID()}`
    const firstVersion = await jsonRequest<{ id: string; status: string }>("/v3/resource-packages", {
      method: "POST",
      cookie: adminCookie,
      body: {
        packageType: "REPORT",
        name: resourceName,
        version: "1.0.0",
        sha256: "a".repeat(64),
        manifest: { testOnly: true }
      }
    })
    const secondVersion = await jsonRequest<{ id: string; status: string }>("/v3/resource-packages", {
      method: "POST",
      cookie: adminCookie,
      body: {
        packageType: "REPORT",
        name: resourceName,
        version: "1.1.0",
        sha256: "b".repeat(64),
        manifest: { testOnly: true }
      }
    })
    expect(firstVersion.status).toBe("STAGED")
    expect(secondVersion.status).toBe("STAGED")

    await jsonRequest(`/v3/resource-packages/${firstVersion.id}/activate`, { method: "POST", cookie: adminCookie })
    await jsonRequest(`/v3/resource-packages/${secondVersion.id}/activate`, { method: "POST", cookie: adminCookie })
    const versionedResources = await jsonRequest<Array<{ id: string; status: string }>>("/v3/resource-packages", { cookie: adminCookie })
    const firstAfterSwitch = versionedResources.find((resource) => resource.id === firstVersion.id)
    const secondAfterSwitch = versionedResources.find((resource) => resource.id === secondVersion.id)
    expect(firstAfterSwitch?.status).toBe("RETIRED")
    expect(secondAfterSwitch?.status).toBe("ACTIVE")
    const retiredSecondVersion = await jsonRequest<{ status: string }>(`/v3/resource-packages/${secondVersion.id}/retire`, {
      method: "POST",
      cookie: adminCookie
    })
    expect(retiredSecondVersion.status).toBe("RETIRED")

    const incompatibleVersion = await jsonRequest<{ id: string }>("/v3/resource-packages", {
      method: "POST",
      cookie: adminCookie,
      body: {
        packageType: "REPORT",
        name: `P0-incompatible-${randomUUID()}`,
        version: "1.0.0",
        minimumPlatformVersion: "999.0.0",
        sha256: "c".repeat(64),
        manifest: { testOnly: true }
      }
    })
    const incompatibleResponse = await fetch(`${baseUrl}/v3/resource-packages/${incompatibleVersion.id}/activate`, {
      method: "POST",
      headers: { Cookie: adminCookie }
    })
    expect(incompatibleResponse.status, await incompatibleResponse.text()).toBe(409)
  }, 60_000)

  async function uploadAndActivateDocumentPackage(adminCookie: string): Promise<string> {
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x50, 0x30])
    const documents = [
      { code: "AIRSPACE_APPLICATION_FORM", title: "无人机临时飞行空域申请表", filename: "form.docx", path: "payload/form.docx" },
      { code: "AIRSPACE_APPLICATION_LETTER", title: "关于申请无人机临时飞行空域的函", filename: "letter.docx", path: "payload/letter.docx" },
      { code: "SAFETY_EMERGENCY_PLAN", title: "安全应急预案", filename: "plan.docx", path: "payload/plan.docx" }
    ]
    const archive = await createSignedResourceArchive({
      privateKey: documentKeyPair.privateKey,
      keyId: documentKeyId,
      name: `P0 formal documents ${randomUUID()}`,
      packageType: "DOCUMENT_TEMPLATE",
      content: { sceneType: "CITY_SHOW", documents },
      payloads: documents.map((document) => ({ path: document.path, content: docx, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", role: document.code }))
    })
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(archive)], { type: "application/zip" }), "p0-documents.zip")
    const upload = await fetch(`${baseUrl}/v3/resource-packages/upload`, { method: "POST", headers: { Cookie: adminCookie }, body: form })
    const created = await upload.json() as { id: string; status: string }
    expect(upload.status, JSON.stringify(created)).toBe(201)
    expect(created.status).toBe("STAGED")
    await jsonRequest(`/v3/resource-packages/${created.id}/activate`, { method: "POST", cookie: adminCookie })
    return created.id
  }

  async function login(email: string, password: string) {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    })
    const responseBody = await response.text()
    expect(response.status, responseBody).toBe(201)
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]
    expect(cookie).toContain("wurenji_token=")
    return cookie!
  }

  async function jsonRequest<T>(path: string, options: {
    method?: string
    cookie: string
    body?: unknown
  }): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Cookie: options.cookie,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
    const body = await response.json() as unknown
    expect(response.status, `${JSON.stringify(body)}\n${serverError}`).toBeLessThan(400)
    return body as T
  }

  async function expectRequestStatus(path: string, expectedStatus: number, options: {
    method?: string
    cookie: string
    body?: unknown
  }) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        Cookie: options.cookie,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
    expect(response.status, await response.text()).toBe(expectedStatus)
  }

  async function waitForServer() {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) throw new Error(`V3 集成服务提前退出：${serverProcess.exitCode}\n${serverError}`)
      try {
        const response = await fetch(`${baseUrl}/auth/me`)
        if (response.status === 401) return
      } catch {
        // Server is still starting.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error(`等待 V3 集成服务启动超时\n${serverError}`)
  }
})

function showParameters() {
  return {
    projectBackground: "城市节庆编队表演教学项目",
    completionRequirements: "完成区域规划、飞行申报、运行处置和飞后复盘",
    plannedStartAt: new Date(Date.now() + 3_600_000).toISOString(),
    plannedEndAt: new Date(Date.now() + 5_400_000).toISOString(),
    plannedAudienceCount: 3000,
    maximumHeightMeters: 120,
    contactName: "教学联系人",
    contactPhone: "13800000000",
    aircraftModel: "教学编队无人机"
  }
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

function completeAreaFeatures(center: { longitude: number; latitude: number }) {
  const types = [
    "TAKEOFF_LANDING",
    "FLIGHT",
    "PERFORMANCE",
    "BUFFER",
    "GROUND_ISOLATION",
    "AUDIENCE",
    "OPERATION",
    "EMERGENCY_LANDING",
    "GEOFENCE"
  ] as const
  return types.map((type, index) => {
    const longitude = center.longitude - 0.0045 + (index % 3) * 0.0035
    const latitude = center.latitude - 0.0045 + Math.floor(index / 3) * 0.0035
    return {
      id: randomUUID(),
      type,
      label: `集成测试${type}`,
      positions: [
        { longitude, latitude },
        { longitude: longitude + 0.0015, latitude },
        { longitude: longitude + 0.0015, latitude: latitude + 0.0015 },
        { longitude, latitude: latitude + 0.0015 }
      ],
      ...((type === "FLIGHT" || type === "PERFORMANCE" || type === "GEOFENCE")
        ? { heightRange: { datum: "AGL", minimumMeters: 20, maximumMeters: 120 } }
        : {}),
      properties: areaProperties(type)
    }
  })
}

function areaProperties(type: string): Record<string, string | number | boolean> {
  if (type === "TAKEOFF_LANDING") return { capacity: 100, orientationDegrees: 0 }
  if (type === "PERFORMANCE") return { orientationDegrees: 0 }
  if (type === "BUFFER") return { referenceWidthMeters: 30 }
  if (type === "GROUND_ISOLATION" || type === "OPERATION") return { purpose: "教学测试" }
  if (type === "AUDIENCE") return { orientationDegrees: 0, capacityLevel: "中型" }
  if (type === "EMERGENCY_LANDING") return { availability: "全程可用", capacityLevel: "单组" }
  if (type === "GEOFENCE") return { policy: "越界告警" }
  return {}
}
