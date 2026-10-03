import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import type {
  AuthUser,
  OnlyOfficeEditorConfigView,
  ProjectDocumentStatus,
  ProjectDocumentVersionKind,
  ShowDocumentWorkspaceView,
  ShowProjectDocumentView,
  StageStatus,
  V3FileAssetView
} from "@wurenji/shared"
import { showDocumentEditorTools, showTemplateAircraftCount } from "@wurenji/shared"
import { DataSource, EntityManager, In, Repository } from "typeorm"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { AssessmentWindowService } from "../assessment/assessment-window.service.js"
import {
  AssignmentDraftEntity,
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { V3FileStorageService } from "../files/file-storage.service.js"
import { ResourcePackageService, type ResolvedShowDocumentTemplate } from "../resources/resource-package.service.js"
import { resolveShowAssignmentParameters } from "../assignments/show-assignment-parameters.js"
import { ShowAreaFeatureEntity, ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { areaFeatureView, positionsFromGeometry } from "../show-project/area-plan-validation.js"
import {
  ShowProjectDocumentEntity,
  ShowProjectDocumentReviewEntity,
  ShowProjectDocumentSessionEntity,
  ShowProjectDocumentVersionEntity
} from "./show-document.entities.js"

interface DocumentReviewInput {
  comment?: string
  score?: number | null
}

interface AccessTokenPayload {
  purpose: "DOCUMENT_READ" | "DOCUMENT_CALLBACK"
  documentId: string
  assetId?: string
  sessionId?: string
  exp: number
}

interface OnlyOfficeCallbackBody {
  status?: number
  key?: string
  url?: string
}

@Injectable()
export class ShowDocumentService {
  constructor(
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ShowProjectDocumentEntity) private readonly documents: Repository<ShowProjectDocumentEntity>,
    @InjectRepository(ShowProjectDocumentVersionEntity) private readonly versions: Repository<ShowProjectDocumentVersionEntity>,
    @InjectRepository(ShowProjectDocumentReviewEntity) private readonly reviews: Repository<ShowProjectDocumentReviewEntity>,
    @InjectRepository(ShowProjectDocumentSessionEntity) private readonly sessions: Repository<ShowProjectDocumentSessionEntity>,
    @InjectRepository(FileAssetEntity) private readonly assets: Repository<FileAssetEntity>,
    @InjectRepository(ShowAreaPlanVersionEntity) private readonly areaVersions: Repository<ShowAreaPlanVersionEntity>,
    @InjectRepository(ShowAreaFeatureEntity) private readonly areaFeatures: Repository<ShowAreaFeatureEntity>,
    private readonly resources: ResourcePackageService,
    private readonly storage: V3FileStorageService,
    private readonly activities: ActivityLogService,
    private readonly assessmentWindows: AssessmentWindowService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<ShowDocumentWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    this.requireShowProject(project)
    await this.ensureDocumentRecords(project, user)
    await this.ensureTemplateCopies(project, user)
    const documents = await this.documents.find({ where: { project: { id: projectId } }, order: { templateCode: "ASC" } })
    const [stage, preflight] = await Promise.all([
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_FLIGHT_APPLICATION" } }),
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_PREFLIGHT" } })
    ])
    return {
      projectId,
      canEdit: actor === "STUDENT" && stage?.status === "IN_PROGRESS" && this.isAssignmentActive(project),
      allRequiredSubmitted: documents.length === 3 && documents.every(isSubmittedDocument),
      editorPublicUrl: normalizeOptionalUrl(process.env.ONLYOFFICE_PUBLIC_URL),
      documents: await Promise.all(documents.map((document) => this.serializeDocument(
        document,
        actor,
        documentReturnDecision(project, document, preflight?.status ?? null, actor)
      ))),
      reference: await this.referencePanel(project)
    }
  }

  async saveUpload(
    projectId: string,
    documentId: string,
    user: AuthUser,
    file: Express.Multer.File | undefined,
    expectedRevision: number,
    kind: "AUTO_SAVE" | "MANUAL_SAVE" = "MANUAL_SAVE"
  ): Promise<ShowDocumentWorkspaceView> {
    if (!file) throw new BadRequestException("请选择 DOCX 文件")
    validateDocx(file)
    const initial = await this.requireStudentDocument(projectId, documentId, user)
    await this.requireEditableStage(projectId)
    if (initial.document.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`文档版本冲突，当前版本为 ${initial.document.revision}`)
    const objectKey = `projects/${projectId}/documents/${documentId}/${randomUUID()}.docx`
    const stored = await this.storage.write(objectKey, file.buffer, docxMimeType)
    try {
      await this.persistDocumentContent(projectId, documentId, user, stored, file.originalname, kind, null, expectedRevision)
    } catch (error) {
      await this.storage.delete(objectKey, stored.storageProvider).catch(() => undefined)
      throw error
    }
    return this.workspace(projectId, user)
  }

  async submit(projectId: string, documentId: string, user: AuthUser, expectedRevision: number): Promise<ShowDocumentWorkspaceView> {
    await this.requireStudentDocument(projectId, documentId, user)
    await this.dataSource.transaction(async (manager) => {
      const { project, document } = await this.lockStudentDocument(manager, projectId, documentId, user)
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "SHOW_FLIGHT_APPLICATION")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("飞行申报阶段不在可提交状态")
      if (document.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`文档版本冲突，当前版本为 ${document.revision}`)
      if (!document.currentAsset || document.currentVersionNo < 1) throw new ConflictException("Word 母版副本尚未就绪")
      if (isSubmittedDocument(document)) return
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const resubmission = Boolean(document.returnedAt && (!document.resubmittedAt || document.returnedAt > document.resubmittedAt))
      const now = new Date()
      const beforeRevision = document.revision
      const versionNo = document.currentVersionNo + 1
      await manager.save(ShowProjectDocumentVersionEntity, manager.create(ShowProjectDocumentVersionEntity, {
        document,
        versionNo,
        kind: "SUBMISSION",
        asset: document.currentAsset,
        createdBy: owner,
        editorSessionId: null
      }))
      document.currentVersionNo = versionNo
      document.submittedVersionNo = versionNo
      document.status = resubmission ? "RESUBMITTED" : "SUBMITTED"
      document.submittedAt = now
      if (resubmission) document.resubmittedAt = now
      document.revision += 1
      await manager.save(document)
      await manager.update(ShowProjectDocumentSessionEntity, { document: { id: document.id }, status: "OPEN" }, { status: "CLOSED", closedAt: now })
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, resubmission ? "resubmissionCount" : "submissionCount", 1)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_FLIGHT_APPLICATION",
        actor: user,
        eventType: resubmission ? "DOCUMENT_RESUBMITTED" : "DOCUMENT_SUBMITTED",
        objectType: "DOCUMENT",
        objectId: document.id,
        beforeRevision,
        afterRevision: document.revision,
        result: { templateCode: document.templateCode, versionNo }
      })
      await this.advanceApplicationStageWhenComplete(manager, project, stage)
    })
    return this.workspace(projectId, user)
  }

  async markViewed(projectId: string, documentId: string, user: AuthUser, input: DocumentReviewInput = {}): Promise<ShowDocumentWorkspaceView> {
    return this.review(projectId, documentId, user, input, "VIEWED")
  }

  async returnForRevision(projectId: string, documentId: string, user: AuthUser, input: DocumentReviewInput): Promise<ShowDocumentWorkspaceView> {
    return this.review(projectId, documentId, user, input, "RETURNED")
  }

  async editorSession(projectId: string, documentId: string, user: AuthUser): Promise<OnlyOfficeEditorConfigView> {
    const workspace = await this.workspace(projectId, user)
    const documentView = workspace.documents.find((item) => item.id === documentId)
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    if (!documentView?.currentAsset) {
      throw new ConflictException(actor === "TEACHER" ? "学生尚未提交该申报材料" : "Word 母版副本尚未就绪")
    }
    const editable = actor === "STUDENT" && workspace.canEdit && !isSubmittedStatus(documentView.status)
    const owner = await this.documents.findOne({ where: { id: documentId, project: { id: projectId } } })
    if (!owner) throw new NotFoundException("项目文档不存在")
    const config = await this.createEditorSession(owner, documentView.currentAsset, documentView.currentVersionNo, user, editable)
    if (actor === "TEACHER" && isSubmittedStatus(owner.status)) await this.recordViewedWithoutWorkspace(project, owner, user)
    return config
  }

  async versionEditorSession(projectId: string, documentId: string, versionId: string, user: AuthUser): Promise<OnlyOfficeEditorConfigView> {
    const { actor } = await this.requireProjectAccess(projectId, user)
    if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以打开申报材料历史提交版本")
    const owner = await this.documents.findOne({ where: { id: documentId, project: { id: projectId } } })
    if (!owner) throw new NotFoundException("项目文档不存在")
    const version = await this.versions.findOne({ where: { id: versionId, document: { id: documentId } } })
    if (!version || version.kind !== "SUBMISSION") throw new NotFoundException("申报材料历史提交版本不存在")
    return this.createEditorSession(owner, serializeAsset(version.asset), version.versionNo, user, false)
  }

  private async createEditorSession(
    owner: ShowProjectDocumentEntity,
    asset: V3FileAssetView,
    versionNo: number,
    user: AuthUser,
    editable: boolean
  ): Promise<OnlyOfficeEditorConfigView> {
    const dbUser = await this.dataSource.manager.findOneByOrFail(UserEntity, { id: user.id })
    const session = await this.sessions.save(this.sessions.create({
      document: owner,
      sessionKey: `${owner.id.replaceAll("-", "")}-v${versionNo}-r${owner.revision}-${randomUUID().slice(0, 8)}`,
      mode: editable ? "EDIT" : "VIEW",
      status: "OPEN",
      actor: dbUser,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      lastCallbackAt: null,
      closedAt: null
    }))
    const internalApiUrl = normalizeRequiredUrl(process.env.V3_INTERNAL_API_URL ?? `http://host.docker.internal:${process.env.PORT ?? 3000}/api`, "V3_INTERNAL_API_URL")
    const contentToken = signAccessToken({
      purpose: "DOCUMENT_READ",
      documentId: owner.id,
      assetId: asset.id,
      exp: unixSeconds(8 * 60 * 60)
    })
    const callbackToken = signAccessToken({
      purpose: "DOCUMENT_CALLBACK",
      documentId: owner.id,
      sessionId: session.id,
      exp: unixSeconds(8 * 60 * 60)
    })
    const config: Record<string, unknown> = {
      document: {
        fileType: "docx",
        key: session.sessionKey,
        title: `${owner.filename} · V${versionNo}`,
        url: `${internalApiUrl}/v3/office/assets/${asset.id}?access_token=${encodeURIComponent(contentToken)}`,
        permissions: { edit: editable, download: true, print: true, review: false }
      },
      documentType: "word",
      editorConfig: {
        callbackUrl: `${internalApiUrl}/v3/office/callbacks/${session.id}?access_token=${encodeURIComponent(callbackToken)}`,
        lang: "zh-CN",
        mode: editable ? "edit" : "view",
        user: { id: user.id, name: user.displayName },
        customization: { autosave: true, forcesave: true, help: false }
      },
      type: "desktop",
      width: "100%",
      height: "100%"
    }
    config.token = signOnlyOfficeConfig(config)
    return {
      publicApiUrl: `${normalizeRequiredUrl(process.env.ONLYOFFICE_PUBLIC_URL, "ONLYOFFICE_PUBLIC_URL")}/web-apps/apps/api/documents/api.js`,
      config,
      capabilities: { directTemplateEditing: true, tools: [...showDocumentEditorTools] }
    }
  }

  async readOfficeAsset(assetId: string, token: string | undefined): Promise<{ asset: FileAssetEntity; content: Buffer }> {
    const payload = verifyAccessToken(token)
    if (payload.purpose !== "DOCUMENT_READ" || payload.assetId !== assetId) throw new UnauthorizedException("文档读取令牌无效")
    const document = await this.documents.findOne({ where: { id: payload.documentId } })
    if (!document) throw new NotFoundException("文档文件不存在")
    const asset = await this.assets.findOne({ where: { id: assetId, ownerType: "PROJECT", ownerId: document.project.id, status: "AVAILABLE" } })
    if (!asset) throw new NotFoundException("文档文件不存在")
    return { asset, content: await this.storage.read(asset.objectKey, asset.storageProvider) }
  }

  async onlyOfficeCallback(sessionId: string, token: string | undefined, body: OnlyOfficeCallbackBody): Promise<{ error: number }> {
    const payload = verifyAccessToken(token)
    if (payload.purpose !== "DOCUMENT_CALLBACK" || payload.sessionId !== sessionId) throw new UnauthorizedException("文档回调令牌无效")
    const session = await this.sessions.findOne({ where: { id: sessionId } })
    if (!session || session.document.id !== payload.documentId || session.expiresAt.getTime() < Date.now()) throw new UnauthorizedException("文档编辑会话已失效")
    if (body.key !== session.sessionKey) throw new BadRequestException("ONLYOFFICE 文档键不匹配")
    const status = Number(body.status)
    if (status === 1 || status === 4) {
      session.lastCallbackAt = new Date()
      if (status === 4) {
        session.status = "CLOSED"
        session.closedAt = new Date()
      }
      await this.sessions.save(session)
      return { error: 0 }
    }
    if (status !== 2 && status !== 6) {
      session.lastCallbackAt = new Date()
      await this.sessions.save(session)
      return { error: 0 }
    }
    if (!body.url) return { error: 1 }
    if (session.mode === "EDIT" && session.actor.role === "student") {
      try {
        await this.assessmentWindows.assertWritable(session.document.project.id, toAuthUser(session.actor), false)
      } catch {
        const now = new Date()
        session.status = "EXPIRED"
        session.lastCallbackAt = now
        session.closedAt = now
        await this.sessions.save(session)
        return { error: 1 }
      }
    }
    try {
      const content = await downloadOnlyOfficeFile(body.url)
      validateDocxBuffer(content)
      const document = await this.documents.findOne({ where: { id: session.document.id } })
      if (!document || isSubmittedDocument(document)) throw new ConflictException("文档已经提交，不能接受迟到的编辑回调")
      if (document.currentAsset?.sha256 === sha256(content)) {
        session.lastCallbackAt = new Date()
        if (status === 2) {
          session.status = "CLOSED"
          session.closedAt = new Date()
        }
        await this.sessions.save(session)
        return { error: 0 }
      }
      const objectKey = `projects/${document.project.id}/documents/${document.id}/${randomUUID()}.docx`
      const stored = await this.storage.write(objectKey, content, docxMimeType)
      try {
        await this.persistDocumentContent(document.project.id, document.id, toAuthUser(session.actor), stored, document.filename, "ONLYOFFICE_CALLBACK", session.id)
      } catch (error) {
        await this.storage.delete(objectKey, stored.storageProvider).catch(() => undefined)
        throw error
      }
      session.lastCallbackAt = new Date()
      if (status === 2) {
        session.status = "CLOSED"
        session.closedAt = new Date()
      }
      await this.sessions.save(session)
      return { error: 0 }
    } catch {
      return { error: 1 }
    }
  }

  private async ensureDocumentRecords(project: StudentProjectEntity, actor: AuthUser): Promise<void> {
    const existingCount = await this.documents.count({ where: { project: { id: project.id } } })
    if (existingCount === 3) return
    const templates = await this.resources.resolveShowDocumentTemplates(project.snapshot.resourceRefs)
    await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT "id" FROM "student_projects" WHERE "id" = $1 FOR UPDATE', [project.id])
      const existing = await manager.find(ShowProjectDocumentEntity, { where: { project: { id: project.id } } })
      const existingCodes = new Set(existing.map((document) => document.templateCode))
      const additions = templates.filter((template) => !existingCodes.has(template.code)).map((template) => this.createDocumentRecord(manager, project, template))
      if (additions.length === 0) return
      await manager.save(ShowProjectDocumentEntity, additions)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: "SHOW_FLIGHT_APPLICATION",
        actor,
        eventType: "DOCUMENTS_PROVISIONED",
        objectType: "PROJECT",
        objectId: project.id,
        result: { documentCount: existing.length + additions.length, packageIds: [...new Set(templates.map((item) => item.packageId))] }
      })
    })
  }

  private createDocumentRecord(manager: EntityManager, project: StudentProjectEntity, template: ResolvedShowDocumentTemplate): ShowProjectDocumentEntity {
    return manager.create(ShowProjectDocumentEntity, {
      project,
      templateCode: template.code,
      title: template.title,
      filename: template.filename,
      templatePackageId: template.packageId,
      templatePackageVersion: template.packageVersion,
      templatePackageSha256: template.packageSha256,
      templatePath: template.path,
      status: "NOT_STARTED",
      revision: 1,
      currentVersionNo: 0,
      currentAsset: null,
      submittedVersionNo: null,
      lastSavedAt: null,
      submittedAt: null,
      viewedAt: null,
      returnedAt: null,
      resubmittedAt: null,
      reviewComment: null,
      reviewScore: null
    })
  }

  private async ensureTemplateCopies(project: StudentProjectEntity, actor: AuthUser): Promise<void> {
    const pending = await this.documents.find({ where: { project: { id: project.id }, currentVersionNo: 0 } })
    for (const document of pending) {
      const content = await this.resources.readArchiveEntry(document.templatePackageId, document.templatePath, document.templatePackageSha256)
      validateDocxBuffer(content)
      const objectKey = `projects/${project.id}/documents/${document.id}/${randomUUID()}.docx`
      const stored = await this.storage.write(objectKey, content, docxMimeType)
      let retained = false
      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.query('SELECT "id" FROM "show_project_documents" WHERE "id" = $1 FOR UPDATE', [document.id])
          const current = await manager.findOneByOrFail(ShowProjectDocumentEntity, { id: document.id })
          if (current.currentVersionNo > 0) return
          const owner = await manager.findOneByOrFail(UserEntity, { id: project.student.id })
          const asset = await manager.save(FileAssetEntity, manager.create(FileAssetEntity, {
            id: randomUUID(),
            category: "DOCUMENT",
            storageProvider: stored.storageProvider,
            objectKey: stored.objectKey,
            originalName: document.filename,
            mimeType: docxMimeType,
            sizeBytes: stored.sizeBytes,
            sha256: stored.sha256,
            status: "AVAILABLE",
            ownerType: "PROJECT",
            ownerId: project.id,
            createdBy: owner
          }))
          await manager.save(ShowProjectDocumentVersionEntity, manager.create(ShowProjectDocumentVersionEntity, {
            document: current,
            versionNo: 1,
            kind: "TEMPLATE_COPY",
            asset,
            createdBy: owner,
            editorSessionId: null
          }))
          current.currentAsset = asset
          current.currentVersionNo = 1
          current.revision += 1
          await manager.save(current)
          retained = true
        })
      } finally {
        if (!retained) await this.storage.delete(objectKey, stored.storageProvider).catch(() => undefined)
      }
    }
  }

  private async persistDocumentContent(
    projectId: string,
    documentId: string,
    user: AuthUser,
    stored: Awaited<ReturnType<V3FileStorageService["write"]>>,
    filename: string,
    kind: ProjectDocumentVersionKind,
    editorSessionId: string | null,
    expectedRevision?: number
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { project, document } = await this.lockStudentDocument(manager, projectId, documentId, user)
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "SHOW_FLIGHT_APPLICATION")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("飞行申报阶段不在可编辑状态")
      if (expectedRevision !== undefined && document.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`文档版本冲突，当前版本为 ${document.revision}`)
      if (isSubmittedDocument(document)) throw new ConflictException("文档已提交，不能继续保存")
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const now = new Date()
      const beforeRevision = document.revision
      const versionNo = document.currentVersionNo + 1
      const asset = await manager.save(FileAssetEntity, manager.create(FileAssetEntity, {
        id: randomUUID(),
        category: "DOCUMENT",
        storageProvider: stored.storageProvider,
        objectKey: stored.objectKey,
        originalName: sanitizeDocxFilename(filename, document.filename),
        mimeType: docxMimeType,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        status: "AVAILABLE",
        ownerType: "PROJECT",
        ownerId: projectId,
        createdBy: owner
      }))
      await manager.save(ShowProjectDocumentVersionEntity, manager.create(ShowProjectDocumentVersionEntity, {
        document,
        versionNo,
        kind,
        asset,
        createdBy: owner,
        editorSessionId
      }))
      document.currentAsset = asset
      document.currentVersionNo = versionNo
      document.status = "EDITING"
      document.lastSavedAt = now
      document.revision += 1
      await manager.save(document)
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "savedVersionCount", 1)
      project.lastActivityAt = now
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_FLIGHT_APPLICATION",
        actor: user,
        eventType: "DOCUMENT_SAVED",
        objectType: "DOCUMENT_VERSION",
        objectId: document.id,
        beforeRevision,
        afterRevision: document.revision,
        result: { templateCode: document.templateCode, versionNo, kind, sha256: asset.sha256 }
      })
    })
  }

  private async review(
    projectId: string,
    documentId: string,
    user: AuthUser,
    input: DocumentReviewInput,
    target: "VIEWED" | "RETURNED"
  ): Promise<ShowDocumentWorkspaceView> {
    const comment = normalizeComment(input.comment, target === "RETURNED")
    const score = normalizeScore(input.score)
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以查看或退回申报材料")
      this.ensureAssignmentActive(project)
      await manager.query('SELECT "id" FROM "show_project_documents" WHERE "id" = $1 FOR UPDATE', [documentId])
      const document = await manager.findOne(ShowProjectDocumentEntity, { where: { id: documentId, project: { id: projectId } } })
      if (!document) throw new NotFoundException("项目文档不存在")
      if (!isSubmittedDocument(document)) throw new ConflictException("只有已提交材料可以执行教师审核")
      const reviewer = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const now = new Date()
      const beforeRevision = document.revision
      if (target === "RETURNED") {
        const preflight = await this.lockStage(manager, projectId, "SHOW_PREFLIGHT")
        const returnDecision = documentReturnDecision(project, document, preflight.status, actor)
        if (!returnDecision.allowed) throw new ConflictException(returnDecision.reason ?? "当前材料不能退回修改")
        document.status = "RETURNED"
        document.returnedAt = now
        const application = await this.lockStage(manager, projectId, "SHOW_FLIGHT_APPLICATION")
        application.status = "RETURNED"
        application.returnedAt = now
        application.acceptedAt = null
        application.revision += 1
        await manager.save(application)
        if (preflight.status === "AVAILABLE") {
          preflight.status = "LOCKED"
          preflight.revision += 1
          await manager.save(preflight)
        }
        project.currentStageCode = "SHOW_FLIGHT_APPLICATION"
        await manager.save(project)
      } else {
        document.status = "VIEWED"
        document.viewedAt = now
      }
      document.reviewComment = comment || document.reviewComment
      document.reviewScore = score
      document.revision += 1
      await manager.save(document)
      await manager.save(ShowProjectDocumentReviewEntity, manager.create(ShowProjectDocumentReviewEntity, {
        document,
        versionNo: document.submittedVersionNo ?? document.currentVersionNo,
        action: target,
        comment,
        score,
        reviewedBy: reviewer
      }))
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_FLIGHT_APPLICATION",
        actor: user,
        eventType: target === "RETURNED" ? "DOCUMENT_RETURNED" : "DOCUMENT_VIEWED",
        objectType: "DOCUMENT",
        objectId: document.id,
        beforeRevision,
        afterRevision: document.revision,
        payload: { comment, score },
        result: { templateCode: document.templateCode, status: document.status }
      })
    })
    return this.workspace(projectId, user)
  }

  private async recordViewedWithoutWorkspace(project: StudentProjectEntity, document: ShowProjectDocumentEntity, user: AuthUser): Promise<void> {
    if (document.status === "VIEWED") return
    await this.review(project.id, document.id, user, {}, "VIEWED")
  }

  private async advanceApplicationStageWhenComplete(manager: EntityManager, project: StudentProjectEntity, stage: StudentProjectStageEntity): Promise<void> {
    const documents = await manager.find(ShowProjectDocumentEntity, { where: { project: { id: project.id } } })
    if (documents.length !== 3 || !documents.every(isSubmittedDocument)) return
    const now = new Date()
    stage.status = "ACCEPTED"
    stage.submittedAt = now
    stage.acceptedAt = now
    stage.returnedAt = null
    stage.revision += 1
    await manager.save(stage)
    const next = await this.lockStage(manager, project.id, "SHOW_PREFLIGHT")
    if (next.status === "LOCKED") {
      next.status = "AVAILABLE"
      next.revision += 1
      await manager.save(next)
    }
    project.currentStageCode = "SHOW_PREFLIGHT"
    project.lastActivityAt = now
    await manager.save(project)
  }

  private async referencePanel(project: StudentProjectEntity): Promise<ShowDocumentWorkspaceView["reference"]> {
    const [area, region] = await Promise.all([
      this.areaVersions.findOne({
        where: { project: { id: project.id }, status: "ACCEPTED" },
        order: { versionNo: "DESC" }
      }),
      this.resources.findRegion(project.snapshot.config.regionPackageId)
    ])
    const features = area ? await this.areaFeatures.find({ where: { version: { id: area.id } } }) : []
    const views = features.map((feature) => areaFeatureView({
      id: feature.featureKey,
      type: feature.type,
      label: feature.label,
      positions: positionsFromGeometry(feature.geometry),
      ...(feature.heightDatum && feature.minimumHeightMeters !== null && feature.maximumHeightMeters !== null
        ? { heightRange: { datum: feature.heightDatum, minimumMeters: feature.minimumHeightMeters, maximumMeters: feature.maximumHeightMeters } }
        : {}),
      properties: feature.properties
    }))
    const takeoffPoints = views.filter((feature) => feature.type === "TAKEOFF_LANDING").map((feature) => feature.measurement.centroid)
    const airspace = views.find((feature) => feature.type === "GEOFENCE") ?? views.find((feature) => feature.type === "FLIGHT")
    const maximumHeights = views.flatMap((feature) => feature.heightRange ? [feature.heightRange.maximumMeters] : [])
    const parameters = resolveShowAssignmentParameters(project.snapshot.config)
    return {
      projectName: project.snapshot.title,
      projectBackground: parameters.projectBackground,
      taskBrief: project.snapshot.config.taskBrief,
      completionRequirements: parameters.completionRequirements,
      scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
      aircraftCount: showTemplateAircraftCount(project.snapshot.config.scaleTemplateCode),
      plannedStartAt: parameters.plannedStartAt,
      plannedEndAt: parameters.plannedEndAt,
      plannedAudienceCount: parameters.plannedAudienceCount,
      aircraftModel: parameters.aircraftModel,
      contactName: parameters.contactName,
      contactPhone: parameters.contactPhone,
      regionName: region.title,
      areaPlanVersion: area?.versionNo ?? null,
      planningMapAsset: area?.planningMapAsset ? serializeAsset(area.planningMapAsset) : null,
      takeoffPoints,
      airspaceBoundary: airspace?.positions ?? [],
      maximumHeightMeters: maximumHeights.length > 0 ? Math.min(parameters.maximumHeightMeters, Math.max(...maximumHeights)) : parameters.maximumHeightMeters
    }
  }

  private async serializeDocument(
    document: ShowProjectDocumentEntity,
    actor: "STUDENT" | "TEACHER",
    returnDecision: DocumentReturnDecision
  ): Promise<ShowProjectDocumentView> {
    const [versions, reviews] = await Promise.all([
      this.versions.find({ where: { document: { id: document.id } }, order: { versionNo: "DESC" } }),
      this.reviews.find({ where: { document: { id: document.id } }, order: { createdAt: "DESC" } })
    ])
    const visibleVersions = actor === "TEACHER" ? versions.filter((version) => version.kind === "SUBMISSION") : versions
    const submittedVersion = actor === "TEACHER" && document.submittedVersionNo !== null
      ? visibleVersions.find((version) => version.versionNo === document.submittedVersionNo) ?? null
      : null
    return {
      id: document.id,
      templateCode: document.templateCode,
      title: document.title,
      filename: document.filename,
      status: document.status,
      revision: document.revision,
      currentVersionNo: actor === "TEACHER" ? submittedVersion?.versionNo ?? 0 : document.currentVersionNo,
      currentAsset: actor === "TEACHER"
        ? submittedVersion ? serializeAsset(submittedVersion.asset) : null
        : document.currentAsset ? serializeAsset(document.currentAsset) : null,
      lastSavedAt: document.lastSavedAt?.toISOString() ?? null,
      submittedAt: document.submittedAt?.toISOString() ?? null,
      viewedAt: document.viewedAt?.toISOString() ?? null,
      returnedAt: document.returnedAt?.toISOString() ?? null,
      resubmittedAt: document.resubmittedAt?.toISOString() ?? null,
      reviewComment: document.reviewComment,
      reviewScore: document.reviewScore,
      canReturn: returnDecision.allowed,
      returnBlockedReason: returnDecision.reason,
      versions: visibleVersions.map((version) => ({
        id: version.id,
        versionNo: version.versionNo,
        kind: version.kind,
        asset: serializeAsset(version.asset),
        createdBy: version.createdBy.displayName,
        createdAt: version.createdAt.toISOString()
      })),
      reviews: reviews.map((review) => ({
        id: review.id,
        versionNo: review.versionNo,
        action: review.action,
        comment: review.comment,
        score: review.score,
        reviewedBy: review.reviewedBy.displayName,
        createdAt: review.createdAt.toISOString()
      }))
    }
  }

  private async requireStudentDocument(projectId: string, documentId: string, user: AuthUser) {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以编辑或提交申报材料")
    const document = await this.documents.findOne({ where: { id: documentId, project: { id: projectId } } })
    if (!document) throw new NotFoundException("项目文档不存在")
    return { project, document }
  }

  private async lockStudentDocument(manager: EntityManager, projectId: string, documentId: string, user: AuthUser) {
    const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
    if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以编辑或提交申报材料")
    await manager.query('SELECT "id" FROM "show_project_documents" WHERE "id" = $1 FOR UPDATE', [documentId])
    const document = await manager.findOne(ShowProjectDocumentEntity, { where: { id: documentId, project: { id: projectId } } })
    if (!document) throw new NotFoundException("项目文档不存在")
    return { project, document }
  }

  private async requireEditableStage(projectId: string): Promise<void> {
    const stage = await this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_FLIGHT_APPLICATION" } })
    if (stage?.status !== "IN_PROGRESS") throw new ConflictException("飞行申报阶段不在可编辑状态")
  }

  private async lockStage(manager: EntityManager, projectId: string, stageCode: "SHOW_FLIGHT_APPLICATION" | "SHOW_PREFLIGHT") {
    await manager.query('SELECT "id" FROM "student_project_stages" WHERE "projectId" = $1 AND "stageCode" = $2 FOR UPDATE', [projectId, stageCode])
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode } })
    if (!stage) throw new ConflictException("项目阶段记录不存在")
    return stage
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager) {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (user.role === "student" && project.student.id === user.id) return { project, actor: "STUDENT" as const }
    if (user.role === "teacher" && project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" as const }
    throw new ForbiddenException("无权访问该学生项目")
  }

  private requireShowProject(project: StudentProjectEntity): void {
    if (project.snapshot.sceneType !== "CITY_SHOW") throw new BadRequestException("该项目不是城市编队表演场景")
  }

  private isAssignmentActive(project: StudentProjectEntity): boolean {
    return project.snapshot.draft.status === "PUBLISHED" || project.snapshot.draft.status === "IN_PROGRESS"
  }

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    if (!this.isAssignmentActive(project)) throw new ConflictException("任务已结束、归档或撤回，不能继续操作")
  }
}

const docxMimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
const maximumDocxBytes = 25 * 1024 * 1024

function isSubmittedStatus(status: ProjectDocumentStatus): boolean {
  return status === "SUBMITTED" || status === "VIEWED" || status === "RESUBMITTED"
}

function isSubmittedDocument(document: Pick<ShowProjectDocumentEntity, "status">): boolean {
  return isSubmittedStatus(document.status)
}

interface DocumentReturnDecision {
  allowed: boolean
  reason: string | null
}

function documentReturnDecision(
  project: StudentProjectEntity,
  document: Pick<ShowProjectDocumentEntity, "status">,
  preflightStatus: StageStatus | null,
  actor: "STUDENT" | "TEACHER"
): DocumentReturnDecision {
  if (actor !== "TEACHER") return { allowed: false, reason: "仅教师可以退回申报材料" }
  if (project.snapshot.draft.status !== "PUBLISHED" && project.snapshot.draft.status !== "IN_PROGRESS") {
    return { allowed: false, reason: "任务已结束、归档或撤回，不能继续操作" }
  }
  if (!isSubmittedDocument(document)) return { allowed: false, reason: "当前材料尚未提交" }
  if (project.snapshot.mode !== "TRAINING" && !project.snapshot.config.allowResubmission) {
    return { allowed: false, reason: "当前考核任务未开放补交" }
  }
  if (preflightStatus === null) return { allowed: false, reason: "飞前准备阶段记录不存在，不能退回申报材料" }
  if (preflightStatus !== "LOCKED" && preflightStatus !== "AVAILABLE") {
    return { allowed: false, reason: "飞前准备已经开始，不能再退回申报材料" }
  }
  return { allowed: true, reason: null }
}

function serializeAsset(asset: FileAssetEntity): V3FileAssetView {
  return {
    id: asset.id,
    category: asset.category,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    createdAt: asset.createdAt.toISOString(),
    downloadPath: `/v3/files/${asset.id}/download`
  }
}

function validateDocx(file: Express.Multer.File): void {
  if (!file.originalname.toLowerCase().endsWith(".docx")) throw new BadRequestException("只允许上传 DOCX 文件")
  validateDocxBuffer(file.buffer)
}

function validateDocxBuffer(content: Buffer): void {
  if (content.byteLength === 0 || content.byteLength > maximumDocxBytes) throw new BadRequestException("DOCX 文件必须大于 0 且不超过 25 MB")
  if (content[0] !== 0x50 || content[1] !== 0x4b) throw new BadRequestException("DOCX 文件不是有效的 Open XML 归档")
}

function sanitizeDocxFilename(value: string, fallback: string): string {
  const filename = value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 235)
  return filename.toLowerCase().endsWith(".docx") ? filename : fallback
}

function normalizeRevision(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new BadRequestException("expectedRevision 必须为正整数")
  return value
}

function normalizeComment(value: string | undefined, required: boolean): string {
  const comment = value?.trim() ?? ""
  if (required && !comment) throw new BadRequestException("退回材料必须填写原因")
  if (comment.length > 2_000) throw new BadRequestException("审核意见不能超过 2000 个字符")
  return comment
}

function normalizeScore(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new BadRequestException("材料评分必须为 0 到 100 的整数")
  return value
}

function stringScenario(scenario: Record<string, unknown>, key: string, fallback: string): string {
  const value = scenario[key]
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function normalizeOptionalUrl(value: string | undefined): string | null {
  return value?.trim().replace(/\/$/, "") || null
}

function normalizeRequiredUrl(value: string | undefined, name: string): string {
  const normalized = normalizeOptionalUrl(value)
  if (!normalized || !/^https?:\/\//.test(normalized)) throw new ConflictException(`${name} 尚未配置`)
  return normalized
}

function unixSeconds(offsetSeconds: number): number {
  return Math.floor(Date.now() / 1000) + offsetSeconds
}

function signAccessToken(payload: AccessTokenPayload): string {
  return signJwt({ ...payload }, officeSecret())
}

function verifyAccessToken(value: string | undefined): AccessTokenPayload {
  const payload = verifyJwt(value, officeSecret())
  if (!payload || (payload.purpose !== "DOCUMENT_READ" && payload.purpose !== "DOCUMENT_CALLBACK") || typeof payload.documentId !== "string" || typeof payload.exp !== "number") {
    throw new UnauthorizedException("文档访问令牌无效")
  }
  return payload as unknown as AccessTokenPayload
}

function signOnlyOfficeConfig(config: Record<string, unknown>): string {
  return signJwt(config, officeSecret())
}

function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = base64Url(JSON.stringify(payload))
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url")
  return `${header}.${body}.${signature}`
}

function verifyJwt(value: string | undefined, secret: string): Record<string, unknown> | null {
  if (!value) return null
  const parts = value.split(".")
  if (parts.length !== 3) return null
  const [header, body, signature] = parts as [string, string, string]
  const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(signature, "base64url")
  } catch {
    return null
  }
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function officeSecret(): string {
  const secret = process.env.ONLYOFFICE_JWT_SECRET?.trim()
  if (!secret || secret.length < 16) throw new ConflictException("ONLYOFFICE_JWT_SECRET 必须配置且不少于 16 个字符")
  return secret
}

interface OnlyOfficeDownloadOptions {
  attempts?: number
  delayMs?: number
  fetcher?: typeof fetch
  sleep?: (delayMs: number) => Promise<void>
  timeoutMs?: number
}

export async function downloadOnlyOfficeFile(value: string, options: OnlyOfficeDownloadOptions = {}): Promise<Buffer> {
  const url = resolveOnlyOfficeDownloadUrl(value, process.env.ONLYOFFICE_INTERNAL_URL, process.env.ONLYOFFICE_PUBLIC_URL)
  const attempts = normalizeDownloadAttempts(options.attempts)
  const delayMs = options.delayMs ?? 400
  const fetcher = options.fetcher ?? fetch
  const sleep = options.sleep ?? ((valueMs) => new Promise((resolve) => setTimeout(resolve, valueMs)))
  const timeoutMs = options.timeoutMs ?? 30_000

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: Response
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) })
    } catch {
      if (attempt === attempts) throw new BadRequestException(`ONLYOFFICE 文件下载失败：连续 ${attempts} 次连接失败`)
      await sleep(delayMs * attempt)
      continue
    }
    if (!response.ok) {
      if (isRetryableOnlyOfficeStatus(response.status) && attempt < attempts) {
        await response.body?.cancel().catch(() => undefined)
        await sleep(delayMs * attempt)
        continue
      }
      throw new BadRequestException(`ONLYOFFICE 文件下载失败：${response.status}`)
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0)
    if (declaredLength > maximumDocxBytes) throw new BadRequestException("ONLYOFFICE 回调文件超过 25 MB")
    const content = Buffer.from(await response.arrayBuffer())
    if (content.byteLength > maximumDocxBytes) throw new BadRequestException("ONLYOFFICE 回调文件超过 25 MB")
    return content
  }
  throw new BadRequestException("ONLYOFFICE 文件下载失败")
}

function normalizeDownloadAttempts(value: number | undefined): number {
  if (value === undefined) return 3
  if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error("ONLYOFFICE 下载尝试次数必须为 1 到 5")
  return value
}

function isRetryableOnlyOfficeStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

export function resolveOnlyOfficeDownloadUrl(value: string, internalValue: string | undefined, publicValue: string | undefined): URL {
  let source: URL
  try {
    source = new URL(value)
  } catch {
    throw new BadRequestException("ONLYOFFICE 回调文件地址无效")
  }

  const internal = parseOnlyOfficeUrl(internalValue)
  const publicUrl = parseOnlyOfficeUrl(publicValue)
  const allowedHosts = [internal, publicUrl].filter((item): item is URL => Boolean(item)).map((item) => item.host)
  if (!allowedHosts.includes(source.host)) throw new BadRequestException("ONLYOFFICE 回调文件地址不在允许列表")

  if (publicUrl && internal && source.host === publicUrl.host && source.host !== internal.host) {
    return new URL(`${source.pathname}${source.search}`, internal)
  }
  return source
}

function parseOnlyOfficeUrl(value: string | undefined): URL | null {
  if (!value?.trim()) return null
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function toAuthUser(user: UserEntity): AuthUser {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role }
}
