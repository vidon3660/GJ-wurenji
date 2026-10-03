import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DataSource } from "typeorm"
import type { ShowAreaFeatureInput, ShowAreaPlanWorkspaceView, V3ActivityEventView } from "@wurenji/shared"
import { createSignedResourceArchive } from "./resources/resource-archive.fixtures.js"
import { integrationServerEntry } from "../integration-server-entry.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("V3 R1 show application, preflight and T-60 integration", () => {
  let serverProcess: ChildProcess
  let baseUrl = ""
  let serverOutput = ""
  let storageDirectory = ""
  let database: DataSource
  let adminCookie = ""
  let teacherCookie = ""
  let studentCookie = ""
  let otherStudentCookie = ""
  let packageId = ""
  let assignmentId = ""
  let projectId = ""
  const keyId = `r1-${randomUUID()}`
  const keyPair = generateKeyPairSync("ed25519")

  beforeAll(async () => {
    storageDirectory = await mkdtemp(join(tmpdir(), "wurenji-r1-integration-"))
    const port = await availablePort()
    baseUrl = `http://127.0.0.1:${port}/api`
    const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString()
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
        RESOURCE_PACKAGE_TRUSTED_KEYS_JSON: JSON.stringify({ [keyId]: publicKey }),
        ONLYOFFICE_PUBLIC_URL: "http://localhost:58080",
        ONLYOFFICE_INTERNAL_URL: "http://localhost:58080",
        ONLYOFFICE_JWT_SECRET: "r1-integration-onlyoffice-secret",
        V3_INTERNAL_API_URL: baseUrl
      },
      stdio: ["ignore", "pipe", "pipe"]
    })
    serverProcess.stdout?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    serverProcess.stderr?.on("data", (chunk: Buffer) => { serverOutput += chunk.toString("utf8") })
    await waitForServer()
    database = new DataSource({ type: "postgres", url: process.env.V3_INTEGRATION_DATABASE_URL! })
    await database.initialize()
    adminCookie = await login("admin@demo.local", process.env.DEMO_ADMIN_PASSWORD ?? "")
    teacherCookie = await login("teacher@demo.local", process.env.DEMO_TEACHER_PASSWORD ?? "")
    studentCookie = await login("student@demo.local", process.env.DEMO_STUDENT_PASSWORD ?? "")
    otherStudentCookie = await login("student2@demo.local", process.env.DEMO_STUDENT2_PASSWORD ?? "")
  }, 30_000)

  afterAll(async () => {
    if (serverProcess && !serverProcess.killed) serverProcess.kill()
    if (database?.isInitialized) {
      if (assignmentId) {
        const projectRows = await database.query(`SELECT "id" FROM "student_projects" WHERE "snapshotId" IN (SELECT "id" FROM "assignment_snapshots" WHERE "draftId" = $1)`, [assignmentId]) as Array<{ id: string }>
        const projectIds = projectRows.map((row) => row.id)
        if (projectIds.length > 0) {
          await database.query(`DELETE FROM "jobs" WHERE "sourceOutboxEventId" IN (SELECT "id" FROM "outbox_events" WHERE "aggregateType" = 'SHOW_PROJECT' AND "aggregateId" = ANY($1::text[]))`, [projectIds])
          await database.query(`DELETE FROM "outbox_events" WHERE "aggregateType" = 'SHOW_PROJECT' AND "aggregateId" = ANY($1::text[])`, [projectIds])
        }
        await database.query(`DELETE FROM "student_projects" WHERE "id" = ANY($1::uuid[])`, [projectIds])
        await database.query(`DELETE FROM "assignment_snapshots" WHERE "draftId" = $1`, [assignmentId])
        await database.query(`DELETE FROM "assignment_drafts" WHERE "id" = $1`, [assignmentId])
        if (projectIds.length > 0) await database.query(`DELETE FROM "file_assets" WHERE "ownerType" = 'PROJECT' AND "ownerId" = ANY($1::uuid[])`, [projectIds])
      }
      if (packageId) {
        await database.query(`DELETE FROM "resource_packages" WHERE "id" = $1`, [packageId])
        await database.query(`DELETE FROM "file_assets" WHERE "ownerType" = 'RESOURCE_PACKAGE' AND "ownerId" = $1`, [packageId])
      }
      await database.destroy()
    }
    if (storageDirectory) await rm(storageDirectory, { recursive: true, force: true })
  })

  it("completes the R1 golden path with immutable Word versions and authoritative gates", async () => {
    packageId = await uploadAndActivateDocumentPackage()
    const resources = await jsonRequest<Array<{ id: string; packageType: string; status: string; source: string; manifest: Record<string, unknown> }>>("/v3/resource-packages", { cookie: adminCookie })
    const regions = await jsonRequest<Array<{
      packageId: string
      sceneType: string
      center: { longitude: number; latitude: number }
      boundary: Array<{ longitude: number; latitude: number }>
    }>>("/v3/resource-packages/regions/catalog?sceneType=CITY_SHOW", { cookie: adminCookie })
    const region = regions[0]!
    const selectedResources = resources.filter((resource) => {
      if (resource.status !== "ACTIVE" || resource.manifest.testOnly === true) return false
      if (resource.packageType === "DOCUMENT_TEMPLATE") return resource.id === packageId
      if (resource.source !== "BUILT_IN") return false
      if (resource.packageType === "REGION") return resource.id === region.packageId
      if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") return resource.manifest.sceneType === "CITY_SHOW"
      return true
    })
    expect(new Set(selectedResources.map((resource) => resource.packageType))).toEqual(new Set(["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "DOCUMENT_TEMPLATE", "REPORT"]))

    const classes = await jsonRequest<Array<{ id: string }>>("/v1/education/classes", { cookie: teacherCookie })
    const draft = await jsonRequest<{ id: string; revision: number }>("/v3/assignments/drafts", {
      method: "POST",
      cookie: teacherCookie,
      body: {
        title: `城市编队表演黄金用例 ${randomUUID()}`,
        sceneType: "CITY_SHOW",
        mode: "TRAINING",
        config: {
          taskBrief: "完成区域、三份申报材料、飞前检查和T-60报备",
          showParameters: {
            projectBackground: "城市节庆编队表演综合教学项目",
            completionRequirements: "完成区域规划、三份申报材料、飞前检查、运行处置和复盘",
            plannedStartAt: new Date(Date.now() + 3_600_000).toISOString(),
            plannedEndAt: new Date(Date.now() + 5_400_000).toISOString(),
            plannedAudienceCount: 2500,
            maximumHeightMeters: 120,
            contactName: "教学联系人",
            contactPhone: "13800000000",
            aircraftModel: "R1-TEST"
          },
          scaleTemplateCode: "SHOW_100",
          regionPackageId: region.packageId,
          availableAt: new Date(Date.now() - 60_000).toISOString(),
          dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          allowResubmission: true,
          allowedValidationAttempts: 3,
          allowedRuntimeAttempts: 3,
          resultVisibility: "FULL_REVIEW",
          scenario: {
            simulationClockRate: 600,
            simulationStartLeadMinutes: 61,
            showRuntimeClockRate: 1000,
            showRuntimeDurationSeconds: 6000,
            eventCodes: ["COMMUNICATION_LOSS"]
          }
        }
      }
    })
    assignmentId = draft.id
    const targets = [{ type: "CLASS", targetId: classes[0]!.id }]
    const resourcePackageIds = selectedResources.map((resource) => resource.id)
    const preview = await jsonRequest<{ configHash: string }>(`/v3/assignments/drafts/${draft.id}/preview`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: draft.revision, targets, resourcePackageIds }
    })
    await jsonRequest(`/v3/assignments/drafts/${draft.id}/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: draft.revision, configHash: preview.configHash, targets, resourcePackageIds }
    })
    const projects = await jsonRequest<Array<{ id: string; title: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>>("/v3/my-projects", { cookie: studentCookie })
    const project = projects.find((item) => item.title.startsWith("城市编队表演黄金用例"))!
    projectId = project.id

    await jsonRequest(`/v3/projects/${projectId}/stages/SHOW_AREA_PLANNING/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: 1 } })
    const features = completeAreaFeatures(region.boundary)
    const annotations = [{
      id: "r1-annotation-1",
      label: "应急通道入口",
      position: region.center,
      heightMeters: 18.4
    }]
    await jsonRequest(`/v3/show-projects/${projectId}/area-plan/draft`, { method: "PUT", cookie: studentCookie, body: { expectedRevision: 0, features, annotations } })
    const areaCheck = await jsonRequest<{ passed: boolean; evidence: Array<{ code: string; message: string; blocking: boolean }> }>(`/v3/show-projects/${projectId}/area-plan/check`, {
      method: "POST",
      cookie: studentCookie
    })
    expect(areaCheck.passed, JSON.stringify(areaCheck.evidence)).toBe(true)
    const areaSubmission = await jsonRequest<{ workspace: ShowAreaPlanWorkspaceView }>(`/v3/show-projects/${projectId}/area-plan/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedDraftRevision: 1, expectedStageRevision: 2 }
    })
    const submittedArea = areaSubmission.workspace.versions.find((version) => version.status === "SUBMITTED")!
    expect(submittedArea.annotations).toEqual([expect.objectContaining({ label: "应急通道入口" })])
    expect(submittedArea.features).toHaveLength(9)
    expect(submittedArea.features.every((feature) => feature.positions.length >= 4 && feature.measurement.areaSquareMeters > 0)).toBe(true)
    expect(submittedArea.checkResult.spatialRelations).toHaveLength(36)
    expect(submittedArea.planningMapAsset).toMatchObject({ mimeType: "image/png" })

    const teacherAreaReview = await jsonRequest<ShowAreaPlanWorkspaceView>(`/v3/show-projects/${projectId}/area-plan`, { cookie: teacherCookie })
    const teacherSubmittedArea = teacherAreaReview.versions.find((version) => version.id === submittedArea.id)!
    expect(teacherAreaReview.canEdit).toBe(false)
    expect(teacherSubmittedArea.features.map((feature) => feature.positions.length)).toEqual(submittedArea.features.map((feature) => feature.positions.length))
    expect(teacherSubmittedArea.checkResult.spatialRelations).toHaveLength(36)
    const previewResponse = await fetch(`${baseUrl}${teacherSubmittedArea.planningMapAsset!.downloadPath.replace(/\/download$/, "/preview")}`, { headers: { Cookie: teacherCookie } })
    expect(previewResponse.status, await previewResponse.clone().text()).toBe(200)
    expect(previewResponse.headers.get("content-type")).toContain("image/png")
    expect(previewResponse.headers.get("content-disposition")).toContain("inline")
    expect(Buffer.from(await previewResponse.arrayBuffer()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    const unauthorizedPreview = await fetch(`${baseUrl}${teacherSubmittedArea.planningMapAsset!.downloadPath.replace(/\/download$/, "/preview")}`, { headers: { Cookie: otherStudentCookie } })
    expect(unauthorizedPreview.status).toBe(403)
    await jsonRequest(`/v3/show-projects/${projectId}/area-plan/versions/${submittedArea.id}/accept`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "区域规划满足教学要求", score: 95 }
    })

    const startedApplication = await jsonRequest<{ stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages/SHOW_FLIGHT_APPLICATION/start`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: 2 }
    })
    expect(startedApplication.stages.find((stage) => stage.stageCode === "SHOW_FLIGHT_APPLICATION")).toMatchObject({ status: "IN_PROGRESS", revision: 3 })
    let documentWorkspace = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: studentCookie })
    expect(documentWorkspace.documents).toHaveLength(3)
    expect(documentWorkspace.reference).toMatchObject({ projectBackground: "城市节庆编队表演综合教学项目", plannedAudienceCount: 2500, maximumHeightMeters: 120, aircraftModel: "R1-TEST", aircraftCount: 100, regionName: expect.any(String) })
    expect(documentWorkspace.documents.every((document) => document.currentVersionNo === 1 && document.currentAsset?.sha256)).toBe(true)
    const templateAssetPaths = documentWorkspace.documents.map((document) => document.currentAsset!.downloadPath)
    const teacherBeforeSubmission = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: teacherCookie })
    expect(teacherBeforeSubmission.allRequiredSubmitted).toBe(false)
    expect(teacherBeforeSubmission.documents.every((document) => document.currentVersionNo === 0 && document.currentAsset === null && document.versions.length === 0)).toBe(true)
    await errorRequest(`/v3/show-projects/${projectId}/documents/${documentWorkspace.documents[0]!.id}/editor-session`, { method: "POST", cookie: teacherCookie }, 409)
    for (const path of templateAssetPaths) {
      const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: teacherCookie } })
      expect(response.status, await response.text()).toBe(403)
    }
    const editor = await jsonRequest<{ publicApiUrl: string; capabilities: { directTemplateEditing: boolean; tools: string[] }; config: { token?: string; documentType?: string; document?: { fileType?: string; url?: string; permissions?: { edit?: boolean } }; editorConfig?: { callbackUrl?: string; mode?: string; customization?: { autosave?: boolean; forcesave?: boolean } } } }>(`/v3/show-projects/${projectId}/documents/${documentWorkspace.documents[0]!.id}/editor-session`, { method: "POST", cookie: studentCookie })
    expect(editor.publicApiUrl).toContain("documents/api.js")
    expect(editor.config.token).toBeTruthy()
    expect(editor.config.documentType).toBe("word")
    expect(editor.config.document?.fileType).toBe("docx")
    expect(editor.config.document?.permissions?.edit).toBe(true)
    expect(editor.config.document?.url).toContain("access_token=")
    expect(editor.config.editorConfig?.mode).toBe("edit")
    expect(editor.config.editorConfig?.callbackUrl).toContain("access_token=")
    expect(editor.config.editorConfig?.customization).toMatchObject({ autosave: true, forcesave: true })
    expect(editor.capabilities).toEqual({
      directTemplateEditing: true,
      tools: ["TEXT_INPUT", "TABLE_CELL_EDIT", "COPY_PASTE", "UNDO_REDO", "BASIC_FORMATTING", "AUTO_SAVE", "MANUAL_SAVE"]
    })

    for (const [index, document] of documentWorkspace.documents.entries()) {
      documentWorkspace = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents/${document.id}/submit`, {
        method: "POST",
        cookie: studentCookie,
        body: { expectedRevision: documentWorkspace.documents.find((item) => item.id === document.id)!.revision }
      })
      const submittedCount = documentWorkspace.documents.filter((item) => ["SUBMITTED", "VIEWED", "RESUBMITTED"].includes(item.status)).length
      expect(submittedCount).toBe(index + 1)
      expect(documentWorkspace.allRequiredSubmitted).toBe(index === 2)
      const submissionStages = await jsonRequest<{ currentStageCode: string; stages: Array<{ stageCode: string; status: string }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
      if (index < 2) {
        expect(submissionStages.currentStageCode).toBe("SHOW_FLIGHT_APPLICATION")
        expect(submissionStages.stages.find((stage) => stage.stageCode === "SHOW_FLIGHT_APPLICATION")?.status).toBe("IN_PROGRESS")
        expect(submissionStages.stages.find((stage) => stage.stageCode === "SHOW_PREFLIGHT")?.status).toBe("LOCKED")
      } else {
        expect(submissionStages.currentStageCode).toBe("SHOW_PREFLIGHT")
        expect(submissionStages.stages.find((stage) => stage.stageCode === "SHOW_FLIGHT_APPLICATION")?.status).toBe("ACCEPTED")
        expect(submissionStages.stages.find((stage) => stage.stageCode === "SHOW_PREFLIGHT")?.status).toBe("AVAILABLE")
      }
    }
    expect(documentWorkspace.allRequiredSubmitted).toBe(true)
    const teacherSubmittedWorkspace = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: teacherCookie })
    expect(teacherSubmittedWorkspace.allRequiredSubmitted).toBe(true)
    expect(teacherSubmittedWorkspace.documents).toHaveLength(3)
    expect(teacherSubmittedWorkspace.documents.every((document) => document.currentVersionNo === 2 && document.currentAsset?.downloadPath && document.versions.length === 1 && document.versions[0]?.kind === "SUBMISSION")).toBe(true)
    expect(teacherSubmittedWorkspace.documents.every((document) => document.canReturn && document.returnBlockedReason === null)).toBe(true)
    for (const document of teacherSubmittedWorkspace.documents) {
      const downloadResponse = await fetch(`${baseUrl}${document.currentAsset!.downloadPath}`, { headers: { Cookie: teacherCookie } })
      expect(downloadResponse.status, await downloadResponse.clone().text()).toBe(200)
      expect(downloadResponse.headers.get("content-type")).toContain("wordprocessingml")
      expect(Buffer.from(await downloadResponse.arrayBuffer()).subarray(0, 2).toString("ascii")).toBe("PK")
      const teacherEditor = await jsonRequest<{ config: { document?: { permissions?: { edit?: boolean; download?: boolean } }; editorConfig?: { mode?: string } } }>(`/v3/show-projects/${projectId}/documents/${document.id}/editor-session`, { method: "POST", cookie: teacherCookie })
      expect(teacherEditor.config.document?.permissions).toMatchObject({ edit: false, download: true })
      expect(teacherEditor.config.editorConfig?.mode).toBe("view")
    }
    await errorRequest(`/v3/show-projects/${projectId}/documents`, { cookie: otherStudentCookie }, 403)
    const unauthorizedDocumentDownload = await fetch(`${baseUrl}${teacherSubmittedWorkspace.documents[0]!.currentAsset!.downloadPath}`, { headers: { Cookie: otherStudentCookie } })
    expect(unauthorizedDocumentDownload.status).toBe(403)
    const returnedDocument = documentWorkspace.documents[0]!
    await errorRequest(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/return`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "", score: 80 }
    }, 400)
    await database.query(`
      UPDATE "assignment_snapshots"
      SET "mode" = 'ASSESSMENT',
          "config" = jsonb_set("config", '{allowResubmission}', 'false'::jsonb)
      WHERE "draftId" = $1
    `, [assignmentId])
    const assessmentDocument = (await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: teacherCookie })).documents.find((document) => document.id === returnedDocument.id)!
    expect(assessmentDocument).toMatchObject({ canReturn: false, returnBlockedReason: "当前考核任务未开放补交" })
    await errorRequest(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/return`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "考核模式不应允许补交" }
    }, 409)
    await database.query(`
      UPDATE "assignment_snapshots"
      SET "mode" = 'TRAINING',
          "config" = jsonb_set("config", '{allowResubmission}', 'true'::jsonb)
      WHERE "draftId" = $1
    `, [assignmentId])
    documentWorkspace = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/viewed`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "已查看材料", score: 88 }
    })
    documentWorkspace = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/return`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "请补充应急联系人", score: 80 }
    })
    const teacherReturnedDocument = documentWorkspace.documents.find((document) => document.id === returnedDocument.id)!
    expect(teacherReturnedDocument).toMatchObject({ status: "RETURNED", canReturn: false, returnBlockedReason: "当前材料尚未提交" })
    expect(teacherReturnedDocument.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "RETURNED", versionNo: 2, comment: "请补充应急联系人", score: 80, reviewedBy: expect.any(String), createdAt: expect.any(String) }),
      expect.objectContaining({ action: "VIEWED", versionNo: 2, comment: "已查看材料", score: 88, reviewedBy: expect.any(String), createdAt: expect.any(String) })
    ]))
    expect(teacherReturnedDocument.reviews.every((review) => Number.isFinite(Date.parse(review.createdAt)))).toBe(true)
    const returnedStages = await jsonRequest<{ stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    const applicationStage = returnedStages.stages.find((stage) => stage.stageCode === "SHOW_FLIGHT_APPLICATION")!
    await jsonRequest(`/v3/projects/${projectId}/stages/SHOW_FLIGHT_APPLICATION/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: applicationStage.revision } })
    const returnedStudentDocument = (await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: studentCookie })).documents.find((document) => document.id === returnedDocument.id)!
    expect(returnedStudentDocument.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "RETURNED", versionNo: 2, comment: "请补充应急联系人" })
    ]))
    const draftForm = new FormData()
    draftForm.append("file", new Blob([new Uint8Array(Buffer.from("PK student draft is intentionally not semantically checked"))], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), "student-draft.docx")
    draftForm.append("expectedRevision", String(returnedStudentDocument.revision))
    draftForm.append("saveMode", "MANUAL_SAVE")
    const draftUploadResponse = await fetch(`${baseUrl}/v3/show-projects/${projectId}/documents/${returnedDocument.id}/content`, { method: "PUT", headers: { Cookie: studentCookie }, body: draftForm })
    expect(draftUploadResponse.status, await draftUploadResponse.clone().text()).toBe(200)
    documentWorkspace = await draftUploadResponse.json() as DocumentWorkspace
    const studentDraft = documentWorkspace.documents.find((document) => document.id === returnedDocument.id)!
    expect(studentDraft.currentVersionNo).toBe(3)
    expect(studentDraft.currentAsset?.sha256).not.toBe(returnedDocument.currentAsset?.sha256)
    const teacherDuringRevision = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: teacherCookie })
    const teacherSubmittedEvidence = teacherDuringRevision.documents.find((document) => document.id === returnedDocument.id)!
    expect(teacherSubmittedEvidence.currentVersionNo).toBe(2)
    expect(teacherSubmittedEvidence.currentAsset?.sha256).toBe(returnedDocument.currentAsset?.sha256)
    expect(teacherSubmittedEvidence.versions.every((version) => version.kind === "SUBMISSION")).toBe(true)
    const hiddenDraftDownload = await fetch(`${baseUrl}${studentDraft.currentAsset!.downloadPath}`, { headers: { Cookie: teacherCookie } })
    expect(hiddenDraftDownload.status, await hiddenDraftDownload.text()).toBe(403)
    const revisionAfterReturn = studentDraft.revision
    documentWorkspace = await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: revisionAfterReturn }
    })
    const resubmittedDocument = documentWorkspace.documents.find((document) => document.id === returnedDocument.id)!
    expect(resubmittedDocument.status).toBe("RESUBMITTED")
    expect(resubmittedDocument.resubmittedAt).toEqual(expect.any(String))
    expect(resubmittedDocument.versions.filter((version) => version.kind === "SUBMISSION").map((version) => version.versionNo)).toEqual([4, 2])
    expect(resubmittedDocument.reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "RETURNED", versionNo: 2, comment: "请补充应急联系人" })
    ]))
    const teacherResubmittedDocument = (await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: teacherCookie })).documents.find((document) => document.id === returnedDocument.id)!
    expect(teacherResubmittedDocument).toMatchObject({ currentVersionNo: 4, canReturn: true, returnBlockedReason: null })
    expect(teacherResubmittedDocument.versions.map((version) => version.versionNo)).toEqual([4, 2])
    const firstSubmissionVersion = teacherResubmittedDocument.versions.find((version) => version.versionNo === 2)!
    const secondSubmissionVersion = teacherResubmittedDocument.versions.find((version) => version.versionNo === 4)!
    const [firstSubmissionEditor, secondSubmissionEditor] = await Promise.all([
      jsonRequest<{ config: { document?: { title?: string; key?: string; url?: string; permissions?: { edit?: boolean } }; editorConfig?: { mode?: string } } }>(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/versions/${firstSubmissionVersion.id}/editor-session`, { method: "POST", cookie: teacherCookie }),
      jsonRequest<{ config: { document?: { title?: string; key?: string; url?: string; permissions?: { edit?: boolean } }; editorConfig?: { mode?: string } } }>(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/versions/${secondSubmissionVersion.id}/editor-session`, { method: "POST", cookie: teacherCookie })
    ])
    expect(firstSubmissionEditor.config.document).toMatchObject({ title: expect.stringContaining("V2"), permissions: { edit: false } })
    expect(secondSubmissionEditor.config.document).toMatchObject({ title: expect.stringContaining("V4"), permissions: { edit: false } })
    expect(firstSubmissionEditor.config.editorConfig?.mode).toBe("view")
    expect(secondSubmissionEditor.config.editorConfig?.mode).toBe("view")
    expect(firstSubmissionEditor.config.document?.key).not.toBe(secondSubmissionEditor.config.document?.key)
    expect(firstSubmissionEditor.config.document?.url).toContain(firstSubmissionVersion.asset.id)
    expect(secondSubmissionEditor.config.document?.url).toContain(secondSubmissionVersion.asset.id)
    const manualDraftVersion = studentDraft.versions.find((version) => version.versionNo === 3)!
    await errorRequest(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/versions/${manualDraftVersion.id}/editor-session`, { method: "POST", cookie: teacherCookie }, 404)
    await errorRequest(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/versions/${firstSubmissionVersion.id}/editor-session`, { method: "POST", cookie: otherStudentCookie }, 403)

    let stages = await jsonRequest<{ currentStageCode: string; stages: Array<{ stageCode: string; status: string; revision: number }> }>(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("SHOW_PREFLIGHT")
    const preflightStage = stages.stages.find((stage) => stage.stageCode === "SHOW_PREFLIGHT")!
    await jsonRequest(`/v3/projects/${projectId}/stages/SHOW_PREFLIGHT/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: preflightStage.revision } })
    const documentAfterPreflightStarted = (await jsonRequest<DocumentWorkspace>(`/v3/show-projects/${projectId}/documents`, { cookie: teacherCookie })).documents.find((document) => document.id === returnedDocument.id)!
    expect(documentAfterPreflightStarted).toMatchObject({ canReturn: false, returnBlockedReason: "飞前准备已经开始，不能再退回申报材料" })
    await errorRequest(`/v3/show-projects/${projectId}/documents/${returnedDocument.id}/return`, {
      method: "POST",
      cookie: teacherCookie,
      body: { comment: "飞前开始后禁止退回" }
    }, 409)
    let preflight = await jsonRequest<PreflightWorkspace>(`/v3/show-projects/${projectId}/preflight`, { cookie: studentCookie })
    expect(preflight.items).toHaveLength(30)
    expect([...new Set(preflight.items.map((item) => item.category))]).toEqual([
      "AIRCRAFT",
      "GROUND_SYSTEM",
      "POSITIONING",
      "COMMUNICATION",
      "WEATHER",
      "SITE_AREA",
      "PERSONNEL",
      "APPLICATION_SUPPORT"
    ])
    preflight = await jsonRequest<PreflightWorkspace>(`/v3/show-projects/${projectId}/preflight`, {
      method: "PUT",
      cookie: studentCookie,
      body: {
        expectedRevision: preflight.revision,
        responses: preflight.items.map((item) => ({ code: item.code, confirmed: true, resolution: "CONFIRMED", resolved: true, note: "已确认" })),
        decision: "ALLOW",
        rationale: ""
      }
    })
    await errorRequest(`/v3/show-projects/${projectId}/preflight/complete`, { method: "POST", cookie: studentCookie, body: { expectedRevision: preflight.revision } }, 409)
    preflight = await jsonRequest<PreflightWorkspace>(`/v3/show-projects/${projectId}/preflight`, {
      method: "PUT",
      cookie: studentCookie,
      body: {
        expectedRevision: preflight.revision,
        responses: preflight.items,
        decision: "ALLOW",
        rationale: "全部检查项正常"
      }
    })
    preflight = await jsonRequest<PreflightWorkspace>(`/v3/show-projects/${projectId}/preflight/complete`, { method: "POST", cookie: studentCookie, body: { expectedRevision: preflight.revision } })
    expect(preflight.status).toBe("COMPLETED")

    stages = await jsonRequest(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    const t60Stage = stages.stages.find((stage) => stage.stageCode === "SHOW_T_MINUS_60")!
    await jsonRequest(`/v3/projects/${projectId}/stages/SHOW_T_MINUS_60/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: t60Stage.revision } })
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 180))
    let t60 = await jsonRequest<T60Workspace>(`/v3/show-projects/${projectId}/t60-report`, { cookie: studentCookie })
    expect(t60.status).toBe("READY")
    expect(t60.submission).toBeNull()
    expect(t60.confirmation).toMatchObject({ aircraftModel: "R1-TEST", aircraftCount: 100, contactName: "教学联系人" })
    t60 = await jsonRequest<T60Workspace>(`/v3/show-projects/${projectId}/t60-report/submit`, { method: "POST", cookie: studentCookie, body: { expectedRevision: t60.revision } })
    expect(t60.status).toBe("SUBMITTED")
    expect(t60.submission).toMatchObject({ submittedBy: { displayName: "张同学" } })
    expect(t60.submission?.reportCode).toMatch(/^T60-[A-F0-9]{8}-\d{2}$/)
    expect(t60.submission?.simulationTimeMs).toBeGreaterThanOrEqual(0)
    const [storedT60] = await database.query(`SELECT "submissionSnapshot" FROM "show_simulation_clocks" WHERE "projectId" = $1`, [projectId]) as Array<{ submissionSnapshot: Record<string, unknown> }>
    expect(storedT60?.submissionSnapshot).toMatchObject({ snapshotVersion: 1, confirmation: { projectName: expect.any(String), aircraftCount: 100 }, submission: { reportCode: t60.submission?.reportCode, submittedBy: { displayName: "张同学" } } })
    stages = await jsonRequest(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("SHOW_RUNTIME")
    expect(stages.stages.find((stage) => stage.stageCode === "SHOW_RUNTIME")?.status).toBe("AVAILABLE")

    const runtimeStage = stages.stages.find((stage) => stage.stageCode === "SHOW_RUNTIME")!
    await jsonRequest(`/v3/projects/${projectId}/stages/SHOW_RUNTIME/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: runtimeStage.revision } })
    let runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime`, { cookie: studentCookie })
    expect(runtime).toMatchObject({ canStart: true, phase: "TAKEOFF_PREPARATION", totals: { plannedCount: 100 } })
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'ASSESSMENT' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = now() - interval '2 hours', "assessmentDeadlineAt" = now() - interval '1 minute' WHERE "id" = $1`, [projectId])
    const expiredReadyRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime`, { cookie: studentCookie })
    expect(expiredReadyRuntime).toMatchObject({ session: { status: "READY" }, canStart: false, canControl: false })
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'TRAINING' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = NULL, "assessmentDeadlineAt" = NULL WHERE "id" = $1`, [projectId])
    const expectedTakeoffEnvironment = runtime.environment
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/start`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: runtime.session.revision }
    })
    expect(runtime.session.status).toBe("RUNNING")
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'ASSESSMENT' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = now() - interval '2 hours', "assessmentDeadlineAt" = now() - interval '1 minute' WHERE "id" = $1`, [projectId])
    const expiredRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime`, { cookie: studentCookie })
    expect(expiredRuntime).toMatchObject({ canStart: false, canControl: false })
    expect(Date.parse(expiredRuntime.clock!.deadlineAt!)).toBeLessThan(Date.now())
    await database.query(`UPDATE "assignment_snapshots" SET "mode" = 'TRAINING' WHERE "draftId" = $1`, [assignmentId])
    await database.query(`UPDATE "student_projects" SET "assessmentStartedAt" = NULL, "assessmentDeadlineAt" = NULL WHERE "id" = $1`, [projectId])
    expect(runtime.takeoffRecord).toMatchObject({
      confirmedBy: { displayName: "张同学" },
      simulationTimeMs: 0,
      actualTakeoffCount: 100,
      aircraftModel: "R1-TEST",
      environment: expectedTakeoffEnvironment
    })
    expect(Date.parse(runtime.takeoffRecord!.confirmedAt)).not.toBeNaN()
    let teacherRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime`, { cookie: teacherCookie })
    expect(teacherRuntime.canTeacherIntervene).toBe(true)
    const teacherTriggerRevision = teacherRuntime.session.revision
    const teacherTriggerRequestId = "show-event-trigger-retry-001"
    const triggeredTeacherRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/events/COMMUNICATION_LOSS/trigger`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherTriggerRevision, requestId: teacherTriggerRequestId }
    })
    const triggeredCommunicationEvent = triggeredTeacherRuntime.events.find((event) => event.code === "COMMUNICATION_LOSS")!
    expect(triggeredCommunicationEvent).toBeTruthy()
    const retriedTeacherRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/events/COMMUNICATION_LOSS/trigger`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherTriggerRevision, requestId: teacherTriggerRequestId }
    })
    expect(retriedTeacherRuntime.session.revision).toBe(triggeredTeacherRuntime.session.revision)
    expect(retriedTeacherRuntime.events.filter((event) => event.code === "COMMUNICATION_LOSS")).toHaveLength(1)
    expect(retriedTeacherRuntime.events.filter((event) => event.id === triggeredCommunicationEvent.id)).toHaveLength(1)
    teacherRuntime = retriedTeacherRuntime
    teacherRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherRuntime.session.revision, rate: teacherRuntime.clockRate, status: "PAUSED" }
    })
    expect(teacherRuntime.session.status).toBe("PAUSED")
    teacherRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/clock-rate`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: teacherRuntime.session.revision, rate: teacherRuntime.clockRate, status: "RUNNING" }
    })
    expect(teacherRuntime.session.status).toBe("RUNNING")
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime`, { cookie: studentCookie })
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/hints`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: runtime.session.revision, message: "关注通信质量和受影响分组" }
    })
    runtime = await waitForRuntime((candidate) => candidate.events.some((event) => event.code === "COMMUNICATION_LOSS" && ["DISCOVERED", "ESCALATED"].includes(event.lifecycleStatus)))
    const communicationEvent = runtime.events.find((event) => event.code === "COMMUNICATION_LOSS")!
    const communicationAlert = runtime.alerts.find((alert) => alert.eventId === communicationEvent.id)!
    expect(["DISCOVERED", "ESCALATED"]).toContain(communicationEvent.lifecycleStatus)
    expect(communicationEvent.affectedCount).toBeGreaterThan(0)
    expect(communicationEvent.affectedGroupIds.length).toBeGreaterThan(0)
    expect(["INFO", "WARNING", "ERROR", "CRITICAL"]).toContain(communicationEvent.severity)
    expect(communicationAlert.severity).toBe(communicationEvent.severity)
    expect(communicationAlert.status).toBe("OPEN")
    const incompleteActionResponse = await fetch(`${baseUrl}/v3/show-projects/${projectId}/runtime/actions`, {
      method: "POST",
      headers: { Cookie: studentCookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedRevision: runtime.session.revision,
        actionCode: "ACKNOWLEDGE_ALERT",
        eventId: communicationEvent.id,
        alertId: communicationAlert.id,
        reasoning: { observation: "发现通信链路异常告警", rationale: "链路质量持续下降需要确认" }
      })
    })
    expect(incompleteActionResponse.status, await incompleteActionResponse.text()).toBe(400)
    const acknowledgeRevision = runtime.session.revision
    const acknowledgeRequestId = "show-action-retry-001"
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "ACKNOWLEDGE_ALERT",
        eventId: communicationEvent.id,
        alertId: communicationAlert.id,
        requestId: acknowledgeRequestId,
        reasoning: { observation: "发现通信链路异常告警", rationale: "链路质量持续下降需要确认", expectedOutcome: "确认告警并进入处置流程" }
      }
    })
    const acknowledgeAfterFirstRevision = runtime.session.revision
    const retriedRuntime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: acknowledgeRevision,
        actionCode: "ACKNOWLEDGE_ALERT",
        eventId: communicationEvent.id,
        alertId: communicationAlert.id,
        requestId: acknowledgeRequestId,
        reasoning: { observation: "发现通信链路异常告警", rationale: "链路质量持续下降需要确认", expectedOutcome: "确认告警并进入处置流程" }
      }
    })
    expect(retriedRuntime.session.revision).toBe(acknowledgeAfterFirstRevision)
    runtime = await waitForRuntime((candidate) => candidate.phase === "BATCH_TAKEOFF" && candidate.totals.airborneCount > 0)
    const singleLand = runtime.availableActions.find((action) => action.code === "SINGLE_LAND")!
    expect(singleLand).toMatchObject({ enabled: true, requiresTarget: true })
    expect(singleLand.eligibleTargetIds.length).toBeGreaterThan(0)
    expect(runtime.availableActions.find((action) => action.code === "GROUP_RETURN")).toMatchObject({ enabled: false, disabledReason: "当前规模未开放该操作" })
    expect(runtime.availableActions.find((action) => action.code === "RETURN_ALL")?.enabled).toBe(true)
    await errorRequest(`/v3/show-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "SINGLE_LAND",
        targetId: "G99-A001",
        reasoning: { observation: "发现单架设备异常", rationale: "无效目标不应被接受", expectedOutcome: "系统拒绝非法处置目标" }
      }
    }, 409)
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "SINGLE_LAND",
        eventId: communicationEvent.id,
        targetId: singleLand.eligibleTargetIds[0],
        reasoning: { observation: "发现单架状态持续异常", rationale: "单架退出可缩小风险范围", expectedOutcome: "目标无人机退出表演并完成降落" }
      }
    })
    expect(runtime.totals.landedCount).toBeGreaterThanOrEqual(1)
    expect(runtime.groups.find((group) => group.groupId === "G01")?.landedCount).toBeGreaterThanOrEqual(1)
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "PAUSE_PROGRAM",
        eventId: communicationEvent.id,
        alertId: communicationAlert.id,
        reasoning: { observation: "通信异常影响范围正在扩大", rationale: "继续表演会增加失联风险", expectedOutcome: "暂停表演并控制异常影响范围" }
      }
    })
    expect(runtime.session.status).toBe("PAUSED")
    expect(runtime.events.find((event) => event.id === communicationEvent.id)?.lifecycleStatus).toBe("CONTROLLED")
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/actions`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: runtime.session.revision,
        actionCode: "RESUME_PROGRAM",
        reasoning: { observation: "链路状态已经恢复稳定", rationale: "监测指标已回到正常范围", expectedOutcome: "安全恢复固定表演程序" }
      }
    })
    expect(runtime.session.status).toBe("RUNNING")
    runtime = await waitForRuntime((candidate) => candidate.session.status === "COMPLETED")
    expect(runtime.session.status).toBe("COMPLETED")
    expect(runtime.totals.landedCount).toBe(100)

    const firstAttemptId = runtime.session.id
    const performanceNode = runtime.restartNodes.find((node) => node.code === "PHASE:PERFORMANCE")!
    const sourceSession = runtime.session
    expect(runtime.canRestart).toBe(true)
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/restart`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: runtime.session.revision, nodeCode: performanceNode.code }
    })
    expect(runtime.session).toMatchObject({ status: "READY", attemptNo: 2, sourceSessionId: firstAttemptId, restartNodeCode: performanceNode.code, mode: sourceSession.mode, mapResourceVersion: sourceSession.mapResourceVersion, sceneResourceVersion: sourceSession.sceneResourceVersion, planVersion: sourceSession.planVersion })
    expect(runtime.phase).toBe("PERFORMANCE")
    expect(runtime.attempts).toHaveLength(2)
    const historical = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/attempts/${firstAttemptId}`, { cookie: studentCookie })
    expect(historical.session).toMatchObject({ id: firstAttemptId, attemptNo: 1, status: "COMPLETED" })
    expect(historical).toMatchObject({ canStart: false, canRestart: false })
    expect(historical.events.some((event) => event.code === "COMMUNICATION_LOSS")).toBe(true)
    expect(historical.actions.length).toBeGreaterThan(0)
    runtime = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime/start`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: runtime.session.revision }
    })
    expect(runtime.session.simulationTimeMs).toBe(performanceNode.simulationTimeMs)
    runtime = await waitForRuntime((candidate) => candidate.session.status === "COMPLETED")
    expect(runtime.session).toMatchObject({ attemptNo: 2, status: "COMPLETED" })
    expect(runtime.alerts.every((alert) => alert.sessionId === runtime.session.id)).toBe(true)

    stages = await jsonRequest(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    const endReportStage = stages.stages.find((stage) => stage.stageCode === "SHOW_FLIGHT_END_REPORT")!
    expect(endReportStage.status).toBe("AVAILABLE")
    await jsonRequest(`/v3/projects/${projectId}/stages/SHOW_FLIGHT_END_REPORT/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: endReportStage.revision } })
    let endReport = await jsonRequest<EndReportWorkspace>(`/v3/show-projects/${projectId}/flight-end-report`, { cookie: studentCookie })
    expect(endReport).toMatchObject({
      status: "DRAFT",
      canSubmit: true,
      completedAsPlanned: null,
      submittedBy: null,
      submittedAt: null
    })
    expect(endReport.plannedCount).toBeGreaterThan(0)
    expect(endReport.suggestedNormalLandedCount + endReport.suggestedAbnormalCount).toBe(endReport.actualTakeoffCount)
    expect(Number.isFinite(Date.parse(endReport.actualTakeoffAt!))).toBe(true)
    expect(Number.isFinite(Date.parse(endReport.landingCompletedAt!))).toBe(true)
    await errorRequest(`/v3/show-projects/${projectId}/flight-end-report/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: endReport.revision,
        completionStatus: "NORMAL",
        normalLandedCount: Math.max(0, endReport.actualTakeoffCount - 1),
        abnormalCount: 0,
        abnormalDescription: ""
      }
    }, 409)
    endReport = await jsonRequest<EndReportWorkspace>(`/v3/show-projects/${projectId}/flight-end-report/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: endReport.revision,
        completionStatus: "NORMAL",
        normalLandedCount: endReport.actualTakeoffCount,
        abnormalCount: 0,
        abnormalDescription: ""
      }
    })
    expect(endReport).toMatchObject({
      status: "SUBMITTED",
      canSubmit: false,
      completionStatus: "NORMAL",
      completedAsPlanned: true,
      answerCorrect: true,
      normalLandedCount: endReport.actualTakeoffCount,
      abnormalCount: 0,
      authoritativeNormalLandedCount: endReport.actualTakeoffCount,
      authoritativeAbnormalCount: 0
    })
    expect(endReport.submittedBy).toBeTruthy()
    expect(Number.isFinite(Date.parse(endReport.submittedAt!))).toBe(true)
    const showProgress = await jsonRequest<Array<{
      projectId: string
      milestones: Array<{ code: string; state: string; detail: string }>
    }>>("/v3/teaching/progress?sceneType=CITY_SHOW", { cookie: teacherCookie })
    expect(showProgress.find((item) => item.projectId === projectId)?.milestones).toEqual([
      expect.objectContaining({ code: "SHOW_DOCUMENTS", state: "SUBMITTED", detail: "3/3 已提交" }),
      expect.objectContaining({ code: "SHOW_T_MINUS_60", state: "SUBMITTED" }),
      expect.objectContaining({ code: "SHOW_RUNTIME", state: "COMPLETED" }),
      expect.objectContaining({ code: "SHOW_FLIGHT_END_REPORT", state: "SUBMITTED" })
    ])
    await errorRequest("/v3/teaching/progress?sceneType=CITY_SHOW", { cookie: studentCookie }, 403)
    await errorRequest(`/v3/show-projects/${projectId}/runtime/restart`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: runtime.session.revision, nodeCode: runtime.restartNodes[0]?.code }
    }, 409)
    stages = await jsonRequest(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.currentStageCode).toBe("SHOW_REVIEW")
    expect(stages.stages.find((stage) => stage.stageCode === "SHOW_REVIEW")?.status).toBe("AVAILABLE")

    const reviewStage = stages.stages.find((stage) => stage.stageCode === "SHOW_REVIEW")!
    await jsonRequest(`/v3/projects/${projectId}/stages/SHOW_REVIEW/start`, { method: "POST", cookie: studentCookie, body: { expectedRevision: reviewStage.revision } })
    let review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review`, { cookie: studentCookie })
    expect(review.timeline.some((item) => item.kind === "EVENT")).toBe(true)
    expect(review.timeline.some((item) => item.kind === "ACTION")).toBe(false)
    expect(review.evaluation.objectiveMetrics.some((item) => item.code === "AVG_RESPONSE_SECONDS")).toBe(true)
    expect(review.evaluation.studentSummaryStructured).toBeNull()
    review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review/summary/submit`, {
      method: "POST",
      cookie: studentCookie,
      body: {
        expectedRevision: review.evaluation.revision,
        summary: "",
        structuredSummary: { completion: "完成编队表演并安全降落。", problems: "出现通信链路异常。", decisions: "确认告警并暂停程序，事件受控后恢复运行。", improvements: "提前核对通信覆盖并缩短首次判断时间。" }
      }
    })
    expect(review.evaluation.studentSubmittedAt).toBeTruthy()
    expect(review.evaluation.studentSummaryStructured).toMatchObject({ completion: expect.stringContaining("完成编队表演") })
    const eventNode = review.timeline.find((item) => item.kind === "EVENT")!
    review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review/annotations`, {
      method: "POST",
      cookie: teacherCookie,
      body: { timelineItemId: eventNode.id, simulationTimeMs: eventNode.simulationTimeMs, comment: "异常识别正确，暂停动作与影响范围匹配。" }
    })
    expect(review.annotations).toHaveLength(1)
    expect(review).toMatchObject({ actor: "TEACHER", canReview: true, canPublish: false })
    expect(review.publishBlockedReason).toContain("请完成全部分项评分")
    await errorRequest(`/v3/show-projects/${projectId}/review/evaluation`, {
      method: "PUT",
      cookie: studentCookie,
      body: { expectedRevision: review.evaluation.revision, teacherScores: review.evaluation.teacherScores, summary: "学生不能填写教师综合评价内容" }
    }, 403)
    await errorRequest(`/v3/show-projects/${projectId}/review/evaluation/publish`, {
      method: "POST",
      cookie: studentCookie,
      body: { expectedRevision: review.evaluation.revision }
    }, 403)
    await errorRequest(`/v3/show-projects/${projectId}/review/evaluation/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision }
    }, 409)
    const invalidScores = review.evaluation.teacherScores.map((item, index) => ({ ...item, score: index === 0 ? item.maxScore + 0.5 : item.maxScore }))
    await errorRequest(`/v3/show-projects/${projectId}/review/evaluation`, {
      method: "PUT",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision, teacherScores: invalidScores, summary: "用于验证冻结量表上限不能被教师评分请求绕过。" }
    }, 400)
    const partialScores = review.evaluation.teacherScores.map((item, index) => ({ ...item, score: index === 0 ? item.maxScore - 1 : null }))
    review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review/evaluation`, {
      method: "PUT",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision, teacherScores: partialScores, summary: "已先完成区域规划评分，其他分项仍需结合回放证据核定。" }
    })
    expect(review.evaluation).toMatchObject({ status: "PENDING", totalScore: null })
    expect(review.canPublish).toBe(false)
    expect(review.publishBlockedReason).toContain("已完成 1/6")
    await errorRequest(`/v3/show-projects/${projectId}/review/evaluation/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision }
    }, 409)
    const teacherScores = review.evaluation.teacherScores.map((item) => ({ ...item, score: item.maxScore - 1, comment: `${item.label}达到教学要求` }))
    review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review/evaluation`, {
      method: "PUT",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision, teacherScores, summary: "学生完整执行了区域规划、申报、飞前检查、动态报备和运行处置流程，能够识别通信异常并采取匹配措施。后续应提升判断依据记录的精确度。" }
    })
    expect(review.evaluation.status).toBe("REVIEWED")
    expect(review.evaluation.totalScore).toBe(teacherScores.reduce((total, item) => total + Number(item.score), 0))
    expect(review.evaluation.totalScore).toBe(94)
    expect(review).toMatchObject({ canPublish: true, publishBlockedReason: null })
    await database.query(`
      UPDATE "project_evaluations"
      SET "objectiveMetrics" = $2::jsonb
      WHERE "projectId" = $1
    `, [projectId, JSON.stringify([{ code: "SYSTEM_REFERENCE_ONLY", label: "系统参考极值", value: 999, displayValue: "999", unit: null, state: "RISK", detail: "验证系统统计不进入最终成绩" }])])
    review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review/evaluation/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision }
    })
    expect(review.evaluation.status).toBe("PUBLISHED")
    expect(review.evaluation.totalScore).toBe(94)
    expect(review.evaluation.objectiveMetrics).toEqual([expect.objectContaining({ code: "SYSTEM_REFERENCE_ONLY", value: 999 })])
    expect(review).toMatchObject({ canReview: false, canPublish: false, publishBlockedReason: "评价已发布，评分与报告已锁定" })
    expect(review.report?.status).toBe("FINAL")
    const reportSnapshotRows = await database.query(`SELECT "snapshot" FROM "show_project_reports" WHERE "projectId" = $1`, [projectId]) as Array<{ snapshot: { evaluation: { totalScore: number; objectiveMetrics: Array<{ code: string; value: number }>; teacherScores: Array<{ score: number }> } } }>
    expect(reportSnapshotRows[0]?.snapshot.evaluation).toMatchObject({ totalScore: 94, objectiveMetrics: [expect.objectContaining({ code: "SYSTEM_REFERENCE_ONLY", value: 999 })] })
    expect(reportSnapshotRows[0]?.snapshot.evaluation.teacherScores.reduce((total, item) => total + item.score, 0)).toBe(94)
    await errorRequest(`/v3/show-projects/${projectId}/review/evaluation`, {
      method: "PUT",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision, teacherScores, summary: "发布后的评分与讲评不能再被直接修改。" }
    }, 409)
    await errorRequest(`/v3/show-projects/${projectId}/review/evaluation/publish`, {
      method: "POST",
      cookie: teacherCookie,
      body: { expectedRevision: review.evaluation.revision }
    }, 409)
    const reportOutbox = await database.query(`SELECT "status", "payload" FROM "outbox_events" WHERE "aggregateType" = 'SHOW_PROJECT' AND "aggregateId" = $1 AND "jobType" = 'SHOW_REPORT_GENERATE'`, [projectId]) as Array<{ status: string; payload: Record<string, unknown> }>
    expect(reportOutbox).toHaveLength(1)
    expect(reportOutbox[0]).toMatchObject({ payload: { projectId, format: "PDF" } })
    expect(["PENDING", "PROCESSING", "PUBLISHED"]).toContain(reportOutbox[0]!.status)
    review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review/report/generate`, {
      method: "POST",
      cookie: teacherCookie,
      body: { format: "DOCX" }
    })
    expect(review.report).toMatchObject({ status: "FINAL", format: "DOCX" })
    const reportResponse = await fetch(`${baseUrl}/v3/show-projects/${projectId}/review/report/download`, { headers: { Cookie: teacherCookie } })
    expect(reportResponse.status).toBe(200)
    expect(reportResponse.headers.get("content-type")).toContain("wordprocessingml")
    expect(Buffer.from(await reportResponse.arrayBuffer()).subarray(0, 2).toString("ascii")).toBe("PK")
    review = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review/report/generate`, {
      method: "POST",
      cookie: teacherCookie,
      body: { format: "PDF" }
    })
    expect(review.report).toMatchObject({ status: "FINAL", format: "PDF" })
    const pdfReportResponse = await fetch(`${baseUrl}/v3/show-projects/${projectId}/review/report/download`, { headers: { Cookie: teacherCookie } })
    expect(pdfReportResponse.status).toBe(200)
    expect(pdfReportResponse.headers.get("content-type")).toContain("application/pdf")
    expect(Buffer.from(await pdfReportResponse.arrayBuffer()).subarray(0, 5).toString("ascii")).toBe("%PDF-")

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
    const expiredDocumentWrite = await fetch(`${baseUrl}/v3/show-projects/${projectId}/documents/${returnedDocument.id}/editor-session`, {
      method: "POST",
      headers: { Cookie: studentCookie }
    })
    expect(expiredDocumentWrite.status).toBe(409)
    expect(await expiredDocumentWrite.json()).toMatchObject({ message: expect.stringContaining("考核时间已结束") })
    const expiredPreflightWrite = await fetch(`${baseUrl}/v3/show-projects/${projectId}/preflight`, {
      method: "PUT",
      headers: { Cookie: studentCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: preflight.revision, responses: preflight.items })
    })
    expect(expiredPreflightWrite.status).toBe(409)
    expect(await expiredPreflightWrite.json()).toMatchObject({ message: expect.stringContaining("考核时间已结束") })
    const studentRestrictedReview = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review`, { cookie: studentCookie })
    expect(studentRestrictedReview).toMatchObject({
      actor: "STUDENT",
      resultVisibility: "TOTAL_ONLY",
      canAccessReport: false,
      timeline: [],
      annotations: [],
      report: null
    })
    expect(studentRestrictedReview.evaluation).toMatchObject({
      totalScore: 94,
      objectiveMetrics: [],
      teacherScores: [],
      summary: ""
    })
    const restrictedReportResponse = await fetch(`${baseUrl}/v3/show-projects/${projectId}/review/report/download`, { headers: { Cookie: studentCookie } })
    expect(restrictedReportResponse.status, await restrictedReportResponse.clone().text()).toBe(403)

    const teacherFullReview = await jsonRequest<ReviewWorkspace>(`/v3/show-projects/${projectId}/review`, { cookie: teacherCookie })
    expect(teacherFullReview).toMatchObject({ actor: "TEACHER", resultVisibility: "TOTAL_ONLY", canAccessReport: true })
    expect(teacherFullReview.evaluation.objectiveMetrics.length).toBeGreaterThan(0)
    expect(teacherFullReview.evaluation.teacherScores.length).toBeGreaterThan(0)
    expect(teacherFullReview.evaluation.summary).not.toBe("")
    expect(teacherFullReview.timeline.length).toBeGreaterThan(0)
    expect(teacherFullReview.annotations).toHaveLength(1)
    expect(teacherFullReview.report).toMatchObject({ status: "FINAL", format: "PDF" })

    stages = await jsonRequest(`/v3/projects/${projectId}/stages`, { cookie: studentCookie })
    expect(stages.stages.find((stage) => stage.stageCode === "SHOW_REVIEW")?.status).toBe("ACCEPTED")
    expect(stages.status).toBe("GRADED")

    const activities = await jsonRequest<V3ActivityEventView[]>(`/v3/projects/${projectId}/activities`, { cookie: teacherCookie })
    expect(activities.map((activity) => activity.eventType)).toEqual(expect.arrayContaining([
      "AREA_DRAFT_SAVED",
      "AREA_DRAFT_CHECKED",
      "AREA_PLAN_SUBMITTED",
      "AREA_PLAN_ACCEPTED",
      "DOCUMENTS_PROVISIONED",
      "DOCUMENT_SUBMITTED",
      "DOCUMENT_VIEWED",
      "DOCUMENT_RETURNED",
      "DOCUMENT_RESUBMITTED",
      "PREFLIGHT_SAVED",
      "PREFLIGHT_COMPLETED",
      "T60_CLOCK_STARTED",
      "T60_REPORT_SUBMITTED",
      "TAKEOFF_REPORTED",
      "RUNTIME_STARTED",
      "TEACHER_RUNTIME_INTERVENTION",
      "RUNTIME_EVENT_TRIGGERED",
      "RUNTIME_EVENT_DISCOVERED",
      "RUNTIME_ACTION_APPLIED",
      "RUNTIME_COMPLETED",
      "FLIGHT_END_REPORT_SUBMITTED",
      "REVIEW_SUMMARY_SUBMITTED",
      "REVIEW_ANNOTATION_ADDED",
      "EVALUATION_SAVED",
      "EVALUATION_PUBLISHED",
      "REPORT_GENERATED"
    ]))
    expect(activities.every((activity) => activity.actorId.length > 0 && activity.actorName.trim().length > 0)).toBe(true)
    expect(activities.every((activity) => Number.isFinite(Date.parse(activity.realTime)))).toBe(true)
  }, 60_000)

  async function uploadAndActivateDocumentPackage(): Promise<string> {
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x52, 0x31])
    const documents = [
      { code: "AIRSPACE_APPLICATION_FORM", title: "无人机临时飞行空域申请表", filename: "申请表.docx", path: "payload/form.docx" },
      { code: "AIRSPACE_APPLICATION_LETTER", title: "关于申请无人机临时飞行空域的函", filename: "申请函.docx", path: "payload/letter.docx" },
      { code: "SAFETY_EMERGENCY_PLAN", title: "安全应急预案", filename: "应急预案.docx", path: "payload/plan.docx" }
    ]
    const archive = await createSignedResourceArchive({
      privateKey: keyPair.privateKey,
      keyId,
      name: `R1文档母版-${randomUUID()}`,
      version: "1.0.0",
      packageType: "DOCUMENT_TEMPLATE",
      content: { sceneType: "CITY_SHOW", documents },
      payloads: documents.map((document) => ({ path: document.path, content: docx, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", role: document.code }))
    })
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(archive)], { type: "application/zip" }), "r1-documents.zip")
    const response = await fetch(`${baseUrl}/v3/resource-packages/upload`, { method: "POST", headers: { Cookie: adminCookie }, body: form })
    const body = await response.json() as { id: string; status: string }
    expect(response.status, JSON.stringify(body)).toBe(201)
    expect(body.status).toBe("STAGED")
    await jsonRequest(`/v3/resource-packages/${body.id}/activate`, { method: "POST", cookie: adminCookie, body: { reason: "R1集成测试" } })
    return body.id
  }

  async function login(email: string, password: string): Promise<string> {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    })
    expect(response.status, await response.clone().text()).toBe(201)
    return response.headers.get("set-cookie")!.split(";", 1)[0]!
  }

  async function jsonRequest<T>(path: string, options: { method?: string; cookie: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
    const body = await response.json() as unknown
    expect(response.status, `${JSON.stringify(body)}\n${serverOutput}`).toBeLessThan(400)
    return body as T
  }

  async function errorRequest(path: string, options: { method?: string; cookie: string; body?: unknown }, expectedStatus: number): Promise<void> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: { Cookie: options.cookie, ...(options.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
    })
    expect(response.status, await response.text()).toBe(expectedStatus)
  }

  async function waitForRuntime(predicate: (workspace: RuntimeWorkspace) => boolean): Promise<RuntimeWorkspace> {
    const deadline = Date.now() + 10_000
    let workspace = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime`, { cookie: studentCookie })
    while (!predicate(workspace) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
      workspace = await jsonRequest<RuntimeWorkspace>(`/v3/show-projects/${projectId}/runtime`, { cookie: studentCookie })
    }
    expect(predicate(workspace), `等待运行状态超时：${JSON.stringify(workspace.session)}`).toBe(true)
    return workspace
  }

  async function waitForServer(): Promise<void> {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (serverProcess.exitCode !== null) throw new Error(`R1 集成服务提前退出：${serverProcess.exitCode}\n${serverOutput}`)
      try {
        const response = await fetch(`${baseUrl}/auth/me`)
        if (response.status === 401) return
      } catch {
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error(`等待 R1 集成服务启动超时\n${serverOutput}`)
  }
})

interface DocumentWorkspace {
  allRequiredSubmitted: boolean
  reference: { projectBackground: string; plannedAudienceCount: number; maximumHeightMeters: number; aircraftModel: string; aircraftCount: number; regionName: string }
  documents: Array<{
    id: string
    status: string
    revision: number
    currentVersionNo: number
    currentAsset: { sha256: string; downloadPath: string } | null
    resubmittedAt: string | null
    canReturn: boolean
    returnBlockedReason: string | null
    versions: Array<{ versionNo: number; kind: string }>
    reviews: Array<{ action: string; versionNo: number; comment: string; score: number | null; reviewedBy: string; createdAt: string }>
  }>
}

interface PreflightWorkspace {
  revision: number
  status: string
  items: Array<{ code: string }>
}

interface T60Workspace {
  revision: number
  status: string
  submission: { reportCode: string | null; submittedAt: string; submittedBy: { id: string; displayName: string } | null; simulationTimeMs: number | null } | null
  confirmation: { aircraftModel: string; aircraftCount: number; contactName: string }
}

interface RuntimeWorkspace {
  canStart: boolean
  canControl: boolean
  canRestart: boolean
  clock: { deadlineAt: string | null }
  phase: string
  session: { id: string; revision: number; status: string; attemptNo: number; sourceSessionId: string | null; restartNodeCode: string | null; simulationTimeMs: number }
  attempts: Array<{ id: string; attemptNo: number; status: string }>
  restartNodes: Array<{ code: string; simulationTimeMs: number }>
  totals: { plannedCount: number; landedCount: number }
  groups: Array<{ groupId: string; landedCount: number; status: string }>
  events: Array<{ id: string; code: string; lifecycleStatus: string; severity: string; affectedCount: number; affectedGroupIds: string[] }>
  alerts: Array<{ id: string; sessionId: string | null; eventId: string | null; status: string; severity: string }>
  actions: Array<{ id: string; sessionId: string; actionCode: string }>
  availableActions: Array<{ code: string; enabled: boolean; requiresTarget: boolean; disabledReason: string | null; eligibleTargetIds: string[] }>
  environment: Record<string, string>
  takeoffRecord: { confirmedBy: { displayName: string } | null; confirmedAt: string; simulationTimeMs: number; actualTakeoffCount: number; aircraftModel: string; environment: Record<string, string> | null } | null
}

interface EndReportWorkspace {
  revision: number
  status: string
  canSubmit: boolean
  actualTakeoffAt: string | null
  landingCompletedAt: string | null
  plannedCount: number
  actualTakeoffCount: number
  suggestedNormalLandedCount: number
  suggestedAbnormalCount: number
  authoritativeNormalLandedCount: number
  authoritativeAbnormalCount: number
  completionStatus: "NORMAL" | "ABNORMAL" | "ABORTED" | null
  normalLandedCount: number | null
  abnormalCount: number | null
  completedAsPlanned: boolean | null
  answerCorrect: boolean | null
  submittedBy: string | null
  submittedAt: string | null
}

interface ReviewWorkspace {
  actor: "STUDENT" | "TEACHER"
  resultVisibility: "TOTAL_ONLY" | "DIMENSIONS" | "FULL_REVIEW"
  canAccessReport: boolean
  canReview: boolean
  canPublish: boolean
  publishBlockedReason: string | null
  evaluation: {
    revision: number
    status: string
    studentSubmittedAt: string | null
    totalScore: number | null
    objectiveMetrics: Array<{ code: string; value: number | string }>
    teacherScores: Array<{ code: string; label: string; maxScore: number; score: number | null; comment: string }>
    summary: string
  }
  timeline: Array<{ id: string; kind: string; simulationTimeMs: number | null }>
  annotations: Array<{ id: string }>
  report: { status: string; format: string | null } | null
}

function completeAreaFeatures(boundary: Array<{ longitude: number; latitude: number }>): ShowAreaFeatureInput[] {
  const types: ShowAreaFeatureInput["type"][] = ["TAKEOFF_LANDING", "FLIGHT", "PERFORMANCE", "BUFFER", "GROUND_ISOLATION", "AUDIENCE", "OPERATION", "EMERGENCY_LANDING", "GEOFENCE"]
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
      id: `r1-feature-${index}`,
      type,
      label: type,
      positions: rectangle(longitude, latitude, longitudeSize, latitudeSize),
      ...((type === "FLIGHT" || type === "PERFORMANCE" || type === "GEOFENCE") ? { heightRange: { datum: "AGL" as const, minimumMeters: 20, maximumMeters: 120 } } : {}),
      properties: completeAreaProperties(type)
    }
  })
}

function completeAreaProperties(type: ShowAreaFeatureInput["type"]): Record<string, string | number | boolean> {
  if (type === "TAKEOFF_LANDING") return { capacity: 100, orientationDegrees: 0 }
  if (type === "PERFORMANCE") return { orientationDegrees: 0 }
  if (type === "BUFFER") return { referenceWidthMeters: 30 }
  if (type === "GROUND_ISOLATION" || type === "OPERATION") return { purpose: "教学" }
  if (type === "AUDIENCE") return { orientationDegrees: 0, capacityLevel: "中型" }
  if (type === "EMERGENCY_LANDING") return { availability: "全程可用", capacityLevel: "单组" }
  if (type === "GEOFENCE") return { policy: "越界告警" }
  return {}
}

function rectangle(longitude: number, latitude: number, longitudeSize: number, latitudeSize: number) {
  return [
    { longitude, latitude },
    { longitude: longitude + longitudeSize, latitude },
    { longitude: longitude + longitudeSize, latitude: latitude + latitudeSize },
    { longitude, latitude: latitude + latitudeSize }
  ]
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
