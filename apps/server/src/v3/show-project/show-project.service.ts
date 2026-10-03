import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException
} from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { randomUUID } from "node:crypto"
import { DataSource, EntityManager, Repository } from "typeorm"
import {
  decideStageTransition,
  showAreaFeatureTypes,
  type AuthUser,
  type ShowAreaCheckResult,
  type ShowAreaFeatureInput,
  type ShowAreaFeatureView,
  type ShowAreaPlanMutationResult,
  type ShowAreaPlanVersionView,
  type ShowAreaPlanWorkspaceView,
  type V3FileAssetView
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import {
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import { V3AssignmentService } from "../assignments/assignment.service.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { ResourcePackageService } from "../resources/resource-package.service.js"
import {
  areaFeatureView,
  checkAreaPlan,
  computeAreaSpatialRelations,
  normalizeAreaAnnotations,
  normalizeAreaFeatures,
  positionsFromGeometry,
  toPolygonGeometry
} from "./area-plan-validation.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { V3FileStorageService } from "../files/file-storage.service.js"
import { ShowProjectDocumentVersionEntity } from "../documents/show-document.entities.js"
import { PlanningMapRenderer } from "./planning-map.renderer.js"
import { resolveShowAssignmentParameters } from "../assignments/show-assignment-parameters.js"
import {
  ShowAreaFeatureEntity,
  ShowAreaPlanDraftEntity,
  ShowAreaPlanVersionEntity
} from "./show-project.entities.js"

interface AreaDraftInput {
  expectedRevision?: number
  features?: unknown
  annotations?: unknown
}

interface AreaReviewInput {
  comment?: string
  score?: number | null
}

@Injectable()
export class V3ShowProjectService {
  constructor(
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ShowAreaPlanDraftEntity) private readonly drafts: Repository<ShowAreaPlanDraftEntity>,
    @InjectRepository(ShowAreaPlanVersionEntity) private readonly versions: Repository<ShowAreaPlanVersionEntity>,
    @InjectRepository(ShowAreaFeatureEntity) private readonly features: Repository<ShowAreaFeatureEntity>,
    @InjectRepository(FileAssetEntity) private readonly assets: Repository<FileAssetEntity>,
    @InjectRepository(ShowProjectDocumentVersionEntity) private readonly documentVersions: Repository<ShowProjectDocumentVersionEntity>,
    private readonly assignments: V3AssignmentService,
    private readonly activities: ActivityLogService,
    private readonly resources: ResourcePackageService,
    private readonly renderer: PlanningMapRenderer,
    private readonly storage: V3FileStorageService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<ShowAreaPlanWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const [draft, versions, stage] = await Promise.all([
      this.drafts.findOne({ where: { project: { id: projectId } } }),
      this.versions.find({ where: { project: { id: projectId } }, order: { versionNo: "DESC" } }),
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_AREA_PLANNING" } })
    ])
    const versionViews = await Promise.all(versions.map((version) => this.serializeVersion(version)))
    return {
      projectId: project.id,
      canEdit: actor === "STUDENT" && stage?.status === "IN_PROGRESS" && this.isAssignmentActive(project),
      requiredTypes: [...showAreaFeatureTypes],
      draft: {
        revision: draft?.revision ?? 0,
        features: (draft?.features ?? []).map(areaFeatureView),
        annotations: draft?.annotations ?? [],
        updatedAt: draft?.updatedAt.toISOString() ?? null
      },
      versions: versionViews
    }
  }

  async saveDraft(projectId: string, user: AuthUser, input: AreaDraftInput): Promise<ShowAreaPlanWorkspaceView> {
    const normalized = normalizeAreaFeatures(input.features)
    const normalizedAnnotations = input.annotations === undefined ? null : normalizeAreaAnnotations(input.annotations)
    const expectedRevision = normalizeRevision(input.expectedRevision, true)
    await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireStudentProject(projectId, user, manager)
      await this.requireEditableStage(projectId, manager)
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      let draft = await manager.findOne(ShowAreaPlanDraftEntity, {
        where: { project: { id: projectId } },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      const beforeRevision = draft?.revision ?? null
      if (!draft) {
        if (expectedRevision !== 0) throw new ConflictException("区域草稿尚未创建，请刷新后重试")
        draft = manager.create(ShowAreaPlanDraftEntity, { project, revision: 1, features: normalized, annotations: normalizedAnnotations ?? [], updatedBy: owner })
      } else {
        if (draft.revision !== expectedRevision) throw new ConflictException(`区域草稿版本冲突，当前版本为 ${draft.revision}`)
        draft.features = normalized
        if (normalizedAnnotations) draft.annotations = normalizedAnnotations
        draft.revision += 1
        draft.updatedBy = owner
      }
      await manager.save(draft)
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "savedVersionCount", 1)
      project.lastActivityAt = new Date()
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_AREA_PLANNING",
        actor: user,
        eventType: "AREA_DRAFT_SAVED",
        objectType: "AREA_PLAN",
        objectId: draft.id,
        beforeRevision,
        afterRevision: draft.revision,
        result: { featureCount: normalized.length, annotationCount: draft.annotations.length }
      })
    })
    return this.workspace(projectId, user)
  }

  async checkDraft(projectId: string, user: AuthUser): Promise<ShowAreaCheckResult> {
    const { project } = await this.requireProjectAccess(projectId, user)
    if (user.role === "student") this.ensureAssignmentActive(project)
    const draft = await this.drafts.findOne({ where: { project: { id: projectId } } })
    if (!draft) throw new BadRequestException("请先保存区域草稿")
    const region = await this.resources.findRegion(project.snapshot.config.regionPackageId)
    const result = checkAreaPlan(draft.features, region, new Date(), resolveShowAssignmentParameters(project.snapshot.config).maximumHeightMeters)
    await this.dataSource.transaction(async (manager) => {
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "validationCount", 1)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_AREA_PLANNING",
        actor: user,
        eventType: "AREA_DRAFT_CHECKED",
        objectType: "AREA_PLAN",
        objectId: draft.id,
        beforeRevision: draft.revision,
        afterRevision: draft.revision,
        result: { passed: result.passed, evidenceCount: result.evidence.length, featureCount: result.featureCount }
      })
    })
    return result
  }

  async snapshot(projectId: string, user: AuthUser, expectedDraftRevision?: number): Promise<ShowAreaPlanWorkspaceView> {
    const expectedRevision = normalizeRevision(expectedDraftRevision)
    const initial = await this.requireStudentProject(projectId, user)
    const region = await this.resources.findRegion(initial.project.snapshot.config.regionPackageId)
    await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireStudentProject(projectId, user, manager)
      await this.requireEditableStage(projectId, manager)
      const draft = await this.lockDraft(projectId, expectedRevision, manager)
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const version = await manager.save(ShowAreaPlanVersionEntity, manager.create(ShowAreaPlanVersionEntity, {
        project,
        versionNo: await this.nextVersionNo(projectId, manager),
        sourceDraftRevision: draft.revision,
        status: "SNAPSHOT",
        terrainSnapshot: terrainSnapshot(region),
        checkResult: checkAreaPlan(draft.features, region, new Date(), resolveShowAssignmentParameters(project.snapshot.config).maximumHeightMeters),
        annotations: draft.annotations,
        planningMapAsset: null,
        reviewComment: null,
        reviewScore: null,
        reviewedBy: null,
        reviewedAt: null,
        createdBy: owner,
        submittedAt: null
      }))
      await this.saveVersionFeatures(version, draft.features, draft.revision, owner, manager)
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "savedVersionCount", 1)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_AREA_PLANNING",
        actor: user,
        eventType: "AREA_SNAPSHOT_CREATED",
        objectType: "AREA_VERSION",
        objectId: version.id,
        beforeRevision: draft.revision,
        afterRevision: draft.revision,
        result: { versionNo: version.versionNo, passed: version.checkResult.passed }
      })
    })
    return this.workspace(projectId, user)
  }

  async submit(
    projectId: string,
    user: AuthUser,
    expectedDraftRevision?: number,
    expectedStageRevision?: number
  ): Promise<ShowAreaPlanMutationResult> {
    const draftRevision = normalizeRevision(expectedDraftRevision)
    const stageRevision = normalizeRevision(expectedStageRevision)
    const initial = await this.requireStudentProject(projectId, user)
    const region = await this.resources.findRegion(initial.project.snapshot.config.regionPackageId)
    const submittedAt = new Date()
    const prepared = await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireStudentProject(projectId, user, manager)
      const stage = await this.requireEditableStage(projectId, manager, stageRevision)
      const draft = await this.lockDraft(projectId, draftRevision, manager)
      const checkResult = checkAreaPlan(draft.features, region, submittedAt, resolveShowAssignmentParameters(project.snapshot.config).maximumHeightMeters)
      if (!checkResult.passed) throw new BadRequestException("区域规划存在阻断问题，请完成检查后再提交")
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const version = await manager.save(ShowAreaPlanVersionEntity, manager.create(ShowAreaPlanVersionEntity, {
        project,
        versionNo: await this.nextVersionNo(projectId, manager),
        sourceDraftRevision: draft.revision,
        status: "GENERATING",
        terrainSnapshot: terrainSnapshot(region),
        checkResult,
        annotations: draft.annotations,
        planningMapAsset: null,
        reviewComment: null,
        reviewScore: null,
        reviewedBy: null,
        reviewedAt: null,
        createdBy: owner,
        submittedAt: null
      }))
      await this.saveVersionFeatures(version, draft.features, draft.revision, owner, manager)
      return {
        versionId: version.id,
        versionNo: version.versionNo,
        features: draft.features,
        annotations: draft.annotations,
        stageId: stage.id,
        projectTitle: project.snapshot.title,
        studentName: project.student.displayName,
        scaleTemplateCode: project.snapshot.config.scaleTemplateCode
      }
    })

    const assetId = randomUUID()
    const objectKey = `planning-maps/${projectId}/${assetId}.png`
    let fileWritten = false
    try {
      const content = await this.renderer.render({
        taskTitle: prepared.projectTitle,
        studentName: prepared.studentName,
        versionNo: prepared.versionNo,
        submittedAt,
        scaleTemplateCode: prepared.scaleTemplateCode,
        region,
        features: prepared.features,
        annotations: prepared.annotations
      })
      const stored = await this.storage.write(objectKey, content, "image/png")
      fileWritten = true
      await this.dataSource.transaction(async (manager) => {
        const { project } = await this.requireStudentProject(projectId, user, manager)
        const version = await manager.findOne(ShowAreaPlanVersionEntity, {
          where: { id: prepared.versionId },
          loadEagerRelations: false,
          lock: { mode: "pessimistic_write" }
        })
        if (!version || version.status !== "GENERATING") throw new ConflictException("区域提交版本状态已变化")
        const stage = await manager.findOne(StudentProjectStageEntity, { where: { id: prepared.stageId }, lock: { mode: "pessimistic_write" } })
        if (!stage || stage.status !== "IN_PROGRESS" || stage.revision !== stageRevision) throw new ConflictException("区域规划阶段状态已变化")
        const decision = decideStageTransition(stage.status, "SUBMITTED", {
          actor: "STUDENT",
          mode: initial.project.snapshot.mode,
          allowResubmission: initial.project.snapshot.config.allowResubmission,
          prerequisitesSatisfied: true,
          submissionGatePassed: true
        })
        if (!decision.allowed) throw new ConflictException(`区域规划阶段不能提交：${decision.code}`)
        const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
        const asset = await manager.save(FileAssetEntity, manager.create(FileAssetEntity, {
          id: assetId,
          category: "PLANNING_MAP",
          storageProvider: stored.storageProvider,
          objectKey: stored.objectKey,
          originalName: `${prepared.projectTitle}-区域规划图-V${prepared.versionNo}.png`,
          mimeType: "image/png",
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          status: "AVAILABLE",
          ownerType: "PROJECT",
          ownerId: projectId,
          createdBy: owner
        }))
        version.planningMapAsset = asset
        version.status = "SUBMITTED"
        version.submittedAt = submittedAt
        await manager.save(version)
        stage.status = "SUBMITTED"
        stage.revision += 1
        stage.submittedAt = submittedAt
        await manager.save(stage)
        await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "submissionCount", 1)
        await manager.update(StudentProjectEntity, { id: projectId }, { lastActivityAt: submittedAt })
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId,
          stageCode: "SHOW_AREA_PLANNING",
          actor: user,
          eventType: "AREA_PLAN_SUBMITTED",
          objectType: "AREA_VERSION",
          objectId: version.id,
          beforeRevision: stageRevision,
          afterRevision: stage.revision,
          result: { versionNo: version.versionNo, planningMapAssetId: asset.id }
        })
      })
    } catch (error) {
      if (fileWritten) await this.storage.delete(objectKey, this.storage.provider).catch(() => undefined)
      await this.versions.update({ id: prepared.versionId, status: "GENERATING" }, { status: "GENERATION_FAILED" }).catch(() => undefined)
      if (error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException || error instanceof NotFoundException) throw error
      throw new InternalServerErrorException("规划图生成失败，请稍后重试")
    }
    return this.mutationResult(projectId, user)
  }

  async accept(projectId: string, versionId: string, user: AuthUser, input: AreaReviewInput): Promise<ShowAreaPlanMutationResult> {
    return this.review(projectId, versionId, user, input, "ACCEPTED")
  }

  async returnForRevision(projectId: string, versionId: string, user: AuthUser, input: AreaReviewInput): Promise<ShowAreaPlanMutationResult> {
    return this.review(projectId, versionId, user, input, "RETURNED")
  }

  async download(assetId: string, user: AuthUser): Promise<{ asset: V3FileAssetView; content: Buffer }> {
    const asset = await this.assets.findOne({ where: { id: assetId, status: "AVAILABLE" } })
    if (!asset) throw new NotFoundException("文件资产不存在")
    if (asset.ownerType !== "PROJECT") throw new ForbiddenException("文件归属类型无效")
    const { actor } = await this.requireProjectAccess(asset.ownerId, user)
    if (asset.category === "DOCUMENT" && actor === "TEACHER") {
      const submittedVersion = await this.documentVersions.exists({
        where: {
          asset: { id: asset.id },
          document: { project: { id: asset.ownerId } },
          kind: "SUBMISSION"
        }
      })
      if (!submittedVersion) throw new ForbiddenException("教师只能下载学生已提交的申报材料")
    }
    return { asset: this.serializeAsset(asset), content: await this.storage.read(asset.objectKey, asset.storageProvider) }
  }

  private async review(
    projectId: string,
    versionId: string,
    user: AuthUser,
    input: AreaReviewInput,
    target: "ACCEPTED" | "RETURNED"
  ): Promise<ShowAreaPlanMutationResult> {
    const comment = normalizeReviewComment(input.comment)
    const score = normalizeReviewScore(input.score)
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以审核区域规划")
      this.ensureAssignmentActive(project)
      const version = await manager.findOne(ShowAreaPlanVersionEntity, {
        where: { id: versionId, project: { id: projectId } },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      if (!version) throw new NotFoundException("区域规划版本不存在")
      if (version.status !== "SUBMITTED") throw new ConflictException("只有已提交版本可以审核")
      const stage = await manager.findOne(StudentProjectStageEntity, {
        where: { project: { id: projectId }, stageCode: "SHOW_AREA_PLANNING" },
        lock: { mode: "pessimistic_write" }
      })
      if (!stage || stage.status !== "SUBMITTED") throw new ConflictException("区域规划阶段不在待审核状态")
      const decision = decideStageTransition(stage.status, target, {
        actor: "TEACHER",
        mode: project.snapshot.mode,
        allowResubmission: project.snapshot.config.allowResubmission,
        prerequisitesSatisfied: true,
        submissionGatePassed: true
      })
      if (!decision.allowed) throw new ConflictException(`当前模式不允许此审核操作：${decision.code}`)
      const reviewer = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const reviewedAt = new Date()
      version.status = target
      version.reviewComment = comment
      version.reviewScore = score
      version.reviewedBy = reviewer
      version.reviewedAt = reviewedAt
      await manager.save(version)
      stage.status = target
      stage.revision += 1
      if (target === "ACCEPTED") stage.acceptedAt = reviewedAt
      else stage.returnedAt = reviewedAt
      await manager.save(stage)
      if (target === "ACCEPTED") {
        const nextStage = await manager.findOne(StudentProjectStageEntity, {
          where: { project: { id: projectId }, sequence: stage.sequence + 1 },
          lock: { mode: "pessimistic_write" }
        })
        if (nextStage?.status === "LOCKED") {
          nextStage.status = "AVAILABLE"
          nextStage.revision += 1
          await manager.save(nextStage)
          project.currentStageCode = nextStage.stageCode
        }
      } else {
        project.currentStageCode = stage.stageCode
      }
      project.lastActivityAt = reviewedAt
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_AREA_PLANNING",
        actor: user,
        eventType: target === "ACCEPTED" ? "AREA_PLAN_ACCEPTED" : "AREA_PLAN_RETURNED",
        objectType: "AREA_VERSION",
        objectId: version.id,
        beforeRevision: stage.revision - 1,
        afterRevision: stage.revision,
        payload: { comment, score },
        result: { status: target }
      })
    })
    return this.mutationResult(projectId, user)
  }

  private async mutationResult(projectId: string, user: AuthUser): Promise<ShowAreaPlanMutationResult> {
    const [workspace, project] = await Promise.all([
      this.workspace(projectId, user),
      this.assignments.projectStages(projectId, user)
    ])
    return { workspace, project }
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager) {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (project.snapshot.sceneType !== "CITY_SHOW") throw new BadRequestException("当前项目不是城市编队表演场景")
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return { project, actor: "STUDENT" as const }
    }
    if (user.role !== "admin" && project.snapshot.draft.createdBy.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
    return { project, actor: "TEACHER" as const }
  }

  private async requireStudentProject(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager) {
    if (user.role !== "student") throw new ForbiddenException("仅学生可以修改区域规划")
    const access = await this.requireProjectAccess(projectId, user, manager)
    this.ensureAssignmentActive(access.project)
    return access
  }

  private isAssignmentActive(project: StudentProjectEntity): boolean {
    return project.snapshot.draft.status === "PUBLISHED" || project.snapshot.draft.status === "IN_PROGRESS"
  }

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    if (!this.isAssignmentActive(project)) throw new ConflictException("任务已结束、归档或撤回，不能继续操作")
  }

  private async requireEditableStage(projectId: string, manager: EntityManager, expectedRevision?: number) {
    const stage = await manager.findOne(StudentProjectStageEntity, {
      where: { project: { id: projectId }, stageCode: "SHOW_AREA_PLANNING" },
      lock: { mode: "pessimistic_write" }
    })
    if (!stage) throw new NotFoundException("区域规划阶段不存在")
    if (expectedRevision !== undefined && stage.revision !== expectedRevision) throw new ConflictException(`阶段版本冲突，当前版本为 ${stage.revision}`)
    if (stage.status !== "IN_PROGRESS") throw new ConflictException("区域规划阶段必须处于进行中")
    return stage
  }

  private async lockDraft(projectId: string, expectedRevision: number, manager: EntityManager) {
    const draft = await manager.findOne(ShowAreaPlanDraftEntity, {
      where: { project: { id: projectId } },
      loadEagerRelations: false,
      lock: { mode: "pessimistic_write" }
    })
    if (!draft) throw new BadRequestException("请先保存区域草稿")
    if (draft.revision !== expectedRevision) throw new ConflictException(`区域草稿版本冲突，当前版本为 ${draft.revision}`)
    return draft
  }

  private async nextVersionNo(projectId: string, manager: EntityManager): Promise<number> {
    const result = await manager.createQueryBuilder(ShowAreaPlanVersionEntity, "version")
      .select("COALESCE(MAX(version.\"versionNo\"), 0)", "maximum")
      .where("version.\"projectId\" = :projectId", { projectId })
      .getRawOne<{ maximum: string }>()
    return Number(result?.maximum ?? 0) + 1
  }

  private async saveVersionFeatures(
    version: ShowAreaPlanVersionEntity,
    features: ShowAreaFeatureInput[],
    sourceRevision: number,
    user: UserEntity,
    manager: EntityManager
  ) {
    await manager.save(ShowAreaFeatureEntity, features.map((feature) => manager.create(ShowAreaFeatureEntity, {
      version,
      featureKey: feature.id,
      type: feature.type,
      label: feature.label,
      geometry: toPolygonGeometry(feature),
      heightDatum: feature.heightRange?.datum ?? null,
      minimumHeightMeters: feature.heightRange?.minimumMeters ?? null,
      maximumHeightMeters: feature.heightRange?.maximumMeters ?? null,
      properties: feature.properties,
      sourceRevision,
      updatedBy: user
    })))
  }

  private async serializeVersion(version: ShowAreaPlanVersionEntity): Promise<ShowAreaPlanVersionView> {
    const entities = await this.features.find({ where: { version: { id: version.id } }, order: { type: "ASC", featureKey: "ASC" } })
    const featureViews = entities.map((feature) => this.serializeFeature(feature))
    const currentCheckResult = version.checkResult
    const checkResult = currentCheckResult.spatialRelations
      ? currentCheckResult
      : { ...currentCheckResult, spatialRelations: computeAreaSpatialRelations(featureViews) }
    return {
      id: version.id,
      versionNo: version.versionNo,
      sourceDraftRevision: version.sourceDraftRevision,
      status: version.status,
      features: featureViews,
      annotations: version.annotations,
      checkResult,
      planningMapAsset: version.planningMapAsset ? this.serializeAsset(version.planningMapAsset) : null,
      review: version.reviewedBy && version.reviewedAt && version.reviewComment
        ? { comment: version.reviewComment, score: version.reviewScore, reviewedBy: version.reviewedBy.displayName, reviewedAt: version.reviewedAt.toISOString() }
        : null,
      createdAt: version.createdAt.toISOString(),
      submittedAt: version.submittedAt?.toISOString() ?? null
    }
  }

  private serializeFeature(feature: ShowAreaFeatureEntity): ShowAreaFeatureView {
    const input: ShowAreaFeatureInput = {
      id: feature.featureKey,
      type: feature.type,
      label: feature.label,
      positions: positionsFromGeometry(feature.geometry),
      ...(feature.heightDatum && feature.minimumHeightMeters !== null && feature.maximumHeightMeters !== null
        ? { heightRange: { datum: feature.heightDatum, minimumMeters: feature.minimumHeightMeters, maximumMeters: feature.maximumHeightMeters } }
        : {}),
      properties: feature.properties
    }
    return areaFeatureView(input)
  }

  private serializeAsset(asset: FileAssetEntity): V3FileAssetView {
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
}

function terrainSnapshot(region: Awaited<ReturnType<ResourcePackageService["findRegion"]>>) {
  return {
    regionPackageId: region.packageId,
    regionPackageVersion: region.packageVersion,
    checksum: region.checksum,
    terrainResourceVersion: region.terrainResourceVersion,
    terrain: region.terrain ?? null,
    heightDatum: region.heightDatum
  }
}

function normalizeRevision(value: number | undefined, allowZero = false): number {
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision < (allowZero ? 0 : 1)) throw new BadRequestException("版本号无效")
  return revision
}

function normalizeReviewComment(value: string | undefined): string {
  const comment = value?.trim()
  if (!comment || comment.length < 2 || comment.length > 2000) throw new BadRequestException("审核批注必须为 2 到 2000 个字符")
  return comment
}

function normalizeReviewScore(value: number | null | undefined): number | null {
  if (value === undefined || value === null) return null
  const score = Number(value)
  if (!Number.isInteger(score) || score < 0 || score > 100) throw new BadRequestException("审核分数必须为 0 到 100 的整数")
  return score
}
