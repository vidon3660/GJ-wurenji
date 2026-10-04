import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { DataSource, EntityManager, In, Repository } from "typeorm"
import type {
  AuthUser,
  LogisticsRegionAnalysisView,
  LogisticsRouteCheckResult,
  LogisticsRouteDraftView,
  LogisticsRouteInput,
  LogisticsRouteValidationResult,
  LogisticsRouteValidationRunView,
  LogisticsRouteVersionView,
  LogisticsRouteWorkspaceView,
  V3RegionCatalogItem
} from "@wurenji/shared"
import { decideStageTransition } from "@wurenji/shared"
import { checkLogisticsRoutePlan, simulateLogisticsRoundTrips } from "@wurenji/simulation"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import {
  AssignmentDraftEntity,
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import { ResourcePackageService } from "../resources/resource-package.service.js"
import {
  LogisticsRegionAnalysisEntity,
  LogisticsRouteEntity,
  LogisticsRoutePlanDraftEntity,
  LogisticsRoutePlanVersionEntity,
  LogisticsRouteValidationRunEntity,
  LogisticsWaypointEntity
} from "./logistics-route.entities.js"
import {
  assertExpectedRevision,
  logisticsAircraftCapability,
  normalizeLogisticsMapAnnotations,
  normalizeLogisticsRoutes,
  normalizeRegionNotes,
  normalizeSelectedDeliveryPointIds,
  requiredDeliveryPointRange
} from "./logistics-route.validation.js"

interface LogisticsWorkspaceRecords {
  project: StudentProjectEntity
  analysis: LogisticsRegionAnalysisEntity
  draft: LogisticsRoutePlanDraftEntity
  region: V3RegionCatalogItem
}

@Injectable()
export class LogisticsRouteService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly resources: ResourcePackageService,
    private readonly activities: ActivityLogService,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(LogisticsRegionAnalysisEntity) private readonly analyses: Repository<LogisticsRegionAnalysisEntity>,
    @InjectRepository(LogisticsRoutePlanDraftEntity) private readonly drafts: Repository<LogisticsRoutePlanDraftEntity>,
    @InjectRepository(LogisticsRoutePlanVersionEntity) private readonly versions: Repository<LogisticsRoutePlanVersionEntity>,
    @InjectRepository(LogisticsRouteValidationRunEntity) private readonly validationRuns: Repository<LogisticsRouteValidationRunEntity>
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<LogisticsRouteWorkspaceView> {
    await this.ensureWorkspaceRecords(projectId, user)
    return this.buildWorkspace(projectId, user)
  }

  async saveRegionAnalysis(
    projectId: string,
    user: AuthUser,
    input: { expectedRevision?: number; selectedDeliveryPointIds?: unknown; notes?: unknown }
  ): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      await this.requireStage(manager, projectId, "LOGISTICS_REGION_ANALYSIS", "IN_PROGRESS")
      assertExpectedRevision(input.expectedRevision, records.analysis.revision, "区域分析版本")
      const selectedDeliveryPointIds = normalizeSelectedDeliveryPointIds(input.selectedDeliveryPointIds)
      this.assertDeliverySelection(records.project, records.region, selectedDeliveryPointIds)
      records.analysis.selectedDeliveryPointIds = selectedDeliveryPointIds
      records.analysis.notes = normalizeRegionNotes(input.notes)
      records.analysis.revision += 1
      records.analysis.status = "DRAFT"
      records.analysis.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.analysis)
      await manager.update(StudentProjectEntity, { id: projectId }, { lastActivityAt: new Date(), status: "IN_PROGRESS" })
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_REGION_ANALYSIS",
        actor: user,
        eventType: "LOGISTICS_REGION_SAVED",
        objectType: "LOGISTICS_REGION_ANALYSIS",
        objectId: records.analysis.id,
        beforeRevision: records.analysis.revision - 1,
        afterRevision: records.analysis.revision,
        result: { selectedDeliveryPointCount: selectedDeliveryPointIds.length }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async confirmRegionAnalysis(
    projectId: string,
    user: AuthUser,
    input: { expectedRevision?: number; expectedStageRevision?: number }
  ): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      assertExpectedRevision(input.expectedRevision, records.analysis.revision, "区域分析版本")
      this.assertDeliverySelection(records.project, records.region, records.analysis.selectedDeliveryPointIds)
      const stage = await this.requireStage(manager, projectId, "LOGISTICS_REGION_ANALYSIS", "IN_PROGRESS", true)
      assertExpectedRevision(input.expectedStageRevision, stage.revision, "阶段版本")
      this.assertSubmissionTransition(records.project, stage)
      const now = new Date()
      records.analysis.status = "CONFIRMED"
      records.analysis.revision += 1
      records.analysis.submittedAt = now
      records.analysis.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.analysis)
      await this.acceptStageAndUnlockNext(manager, records.project, stage, now)
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "submissionCount", 1)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_REGION_ANALYSIS",
        actor: user,
        eventType: "LOGISTICS_REGION_CONFIRMED",
        objectType: "LOGISTICS_REGION_ANALYSIS",
        objectId: records.analysis.id,
        beforeRevision: records.analysis.revision - 1,
        afterRevision: records.analysis.revision,
        result: { selectedDeliveryPointCount: records.analysis.selectedDeliveryPointIds.length, nextStageCode: "LOGISTICS_ROUTE_PLANNING" }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async saveDraft(
    projectId: string,
    user: AuthUser,
    input: { expectedRevision?: number; routes?: unknown; annotations?: unknown }
  ): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      await this.assertRouteEditingOpen(manager, records.project)
      assertExpectedRevision(input.expectedRevision, records.draft.revision, "航线草稿版本")
      records.draft.routes = normalizeLogisticsRoutes(input.routes)
      if (input.annotations !== undefined) records.draft.annotations = normalizeLogisticsMapAnnotations(input.annotations)
      records.draft.lastCheckResult = null
      records.draft.revision += 1
      records.draft.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.draft)
      await manager.update(StudentProjectEntity, { id: projectId }, { lastActivityAt: new Date(), status: "IN_PROGRESS" })
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: records.project.currentStageCode === "LOGISTICS_ROUTE_VALIDATION" ? "LOGISTICS_ROUTE_VALIDATION" : "LOGISTICS_ROUTE_PLANNING",
        actor: user,
        eventType: "LOGISTICS_ROUTE_DRAFT_SAVED",
        objectType: "LOGISTICS_ROUTE_DRAFT",
        objectId: records.draft.id,
        beforeRevision: records.draft.revision - 1,
        afterRevision: records.draft.revision,
        result: { routeCount: records.draft.routes.length, annotationCount: records.draft.annotations.length }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async checkDraft(projectId: string, user: AuthUser): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      await this.assertRouteEditingOpen(manager, records.project)
      const result = this.check(records)
      records.draft.lastCheckResult = result
      records.draft.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.draft)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: records.project.currentStageCode === "LOGISTICS_ROUTE_VALIDATION" ? "LOGISTICS_ROUTE_VALIDATION" : "LOGISTICS_ROUTE_PLANNING",
        actor: user,
        eventType: "LOGISTICS_ROUTE_CHECKED",
        objectType: "LOGISTICS_ROUTE_DRAFT",
        objectId: records.draft.id,
        beforeRevision: records.draft.revision,
        afterRevision: records.draft.revision,
        result: { passed: result.passed, conflictCount: result.conflictCount, riskCount: result.riskCount, infoCount: result.infoCount }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async createSnapshot(projectId: string, user: AuthUser): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      await this.assertRouteEditingOpen(manager, records.project)
      const checkResult = this.check(records)
      records.draft.lastCheckResult = checkResult
      await manager.save(records.draft)
      await this.createVersion(manager, records, user, "SNAPSHOT", checkResult, null)
    })
    return this.buildWorkspace(projectId, user)
  }

  async completePlanning(
    projectId: string,
    user: AuthUser,
    input: { expectedDraftRevision?: number; expectedStageRevision?: number }
  ): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      assertExpectedRevision(input.expectedDraftRevision, records.draft.revision, "航线草稿版本")
      const stage = await this.requireStage(manager, projectId, "LOGISTICS_ROUTE_PLANNING", "IN_PROGRESS", true)
      assertExpectedRevision(input.expectedStageRevision, stage.revision, "阶段版本")
      const checkResult = this.check(records)
      if (!checkResult.passed) throw new ConflictException(`仍有 ${checkResult.conflictCount} 项硬性冲突，不能进入航线验证`)
      this.assertSubmissionTransition(records.project, stage)
      records.draft.lastCheckResult = checkResult
      await manager.save(records.draft)
      const version = await this.createVersion(manager, records, user, "SNAPSHOT", checkResult, null, false)
      const now = new Date()
      await this.acceptStageAndUnlockNext(manager, records.project, stage, now)
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "submissionCount", 1)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ROUTE_PLANNING",
        actor: user,
        eventType: "LOGISTICS_ROUTE_VERSION_CREATED",
        objectType: "LOGISTICS_ROUTE_VERSION",
        objectId: version.id,
        result: { versionNo: version.versionNo, routeCount: records.draft.routes.length, nextStageCode: "LOGISTICS_ROUTE_VALIDATION" }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async validateDraft(projectId: string, user: AuthUser): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      await this.requireStage(manager, projectId, "LOGISTICS_ROUTE_VALIDATION", "IN_PROGRESS")
      const attemptNo = await manager.count(LogisticsRouteValidationRunEntity, { where: { project: { id: projectId } } }) + 1
      if (attemptNo > records.project.snapshot.config.allowedValidationAttempts) throw new ConflictException("已达到教师设置的航线验证次数上限")
      const seed = `logistics-route:${projectId}:${attemptNo}:${records.draft.revision}`
      const result = simulateLogisticsRoundTrips(records.draft.routes, this.ruleContext(records), seed)
      const checkResult = this.check(records)
      records.draft.lastCheckResult = checkResult
      await manager.save(records.draft)
      const version = await this.createVersion(manager, records, user, "VALIDATED", checkResult, result)
      const creator = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const run = await manager.save(LogisticsRouteValidationRunEntity, manager.create(LogisticsRouteValidationRunEntity, {
        project: records.project,
        version,
        attemptNo,
        status: result.status,
        seed,
        result,
        createdBy: creator
      }))
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "validationCount", 1)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ROUTE_VALIDATION",
        actor: user,
        eventType: "LOGISTICS_ROUTE_VALIDATED",
        objectType: "LOGISTICS_ROUTE_VALIDATION",
        objectId: run.id,
        result: {
          attemptNo,
          versionNo: version.versionNo,
          status: result.status,
          completedRoundTripCount: result.completedRoundTripCount,
          requiredRoundTripCount: result.requiredRoundTripCount
        }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async restoreVersion(
    projectId: string,
    versionId: string,
    user: AuthUser,
    input: { expectedDraftRevision?: number }
  ): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      await this.assertRouteEditingOpen(manager, records.project)
      assertExpectedRevision(input.expectedDraftRevision, records.draft.revision, "航线草稿版本")
      const version = await this.loadVersion(manager, projectId, versionId)
      records.draft.routes = this.routesFromVersion(version)
      records.draft.annotations = version.annotations
      records.draft.lastCheckResult = null
      records.draft.revision += 1
      records.draft.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.draft)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: records.project.currentStageCode === "LOGISTICS_ROUTE_VALIDATION" ? "LOGISTICS_ROUTE_VALIDATION" : "LOGISTICS_ROUTE_PLANNING",
        actor: user,
        eventType: "LOGISTICS_ROUTE_DRAFT_SAVED",
        objectType: "LOGISTICS_ROUTE_DRAFT",
        objectId: records.draft.id,
        beforeRevision: records.draft.revision - 1,
        afterRevision: records.draft.revision,
        payload: { restoredVersionId: version.id },
        result: { restoredVersionNo: version.versionNo, routeCount: records.draft.routes.length, annotationCount: records.draft.annotations.length }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async submitValidatedPlan(
    projectId: string,
    versionId: string,
    user: AuthUser,
    input: { expectedDraftRevision?: number; expectedStageRevision?: number }
  ): Promise<LogisticsRouteWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockWorkspaceRecords(manager, projectId, user)
      this.ensureAssignmentActive(records.project)
      assertExpectedRevision(input.expectedDraftRevision, records.draft.revision, "航线草稿版本")
      const stage = await this.requireStage(manager, projectId, "LOGISTICS_ROUTE_VALIDATION", "IN_PROGRESS", true)
      assertExpectedRevision(input.expectedStageRevision, stage.revision, "阶段版本")
      const version = await this.loadVersion(manager, projectId, versionId, true)
      if (version.sourceDraftRevision !== records.draft.revision) throw new ConflictException("验证版本不是当前航线草稿，请重新验证")
      if (!version.validationResult || (version.validationResult.status !== "PASSED" && version.validationResult.status !== "WITH_RISK")) throw new ConflictException("只有完成全部往返且无硬性冲突的验证版本可以提交")
      if (version.validationResult.evidence.some((item) => item.blocking)) throw new ConflictException("验证版本仍包含硬性冲突")
      const formalRoutes = this.routesFromVersion(version).filter((route) => route.role === "PRIMARY")
      const expectedFormalRouteCount = records.analysis.selectedDeliveryPointIds.length * 2
      const formalDestinationCount = new Set(formalRoutes.map((route) => route.destinationNodeId)).size
      if (formalRoutes.length !== expectedFormalRouteCount || formalDestinationCount !== records.analysis.selectedDeliveryPointIds.length) {
        throw new ConflictException("固定物流航线方案包必须包含全部配送点的正式去程和返程航线")
      }
      if (version.validationResult.completedRoundTripCount !== version.validationResult.requiredRoundTripCount
        || version.validationResult.requiredRoundTripCount !== records.analysis.selectedDeliveryPointIds.length) {
        throw new ConflictException("固定物流航线方案包中的正式航线尚未全部完成往返验证")
      }
      this.assertSubmissionTransition(records.project, stage)
      const now = new Date()
      version.status = "SUBMITTED"
      version.submittedAt = now
      await manager.save(version)
      await this.acceptStageAndUnlockNext(manager, records.project, stage, now)
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "submissionCount", 1)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ROUTE_VALIDATION",
        actor: user,
        eventType: "LOGISTICS_ROUTE_PLAN_SUBMITTED",
        objectType: "LOGISTICS_ROUTE_VERSION",
        objectId: version.id,
        result: {
          packageName: "固定物流航线方案包",
          versionNo: version.versionNo,
          validationStatus: version.validationResult.status,
          formalRouteCount: formalRoutes.length,
          destinationCount: formalDestinationCount,
          nextStageCode: "LOGISTICS_ORDER_SCHEDULING"
        }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  private async ensureWorkspaceRecords(projectId: string, user: AuthUser): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const project = await this.loadProject(manager, projectId, user)
      const actor = await manager.findOneByOrFail(UserEntity, { id: project.student.id })
      let analysis = await manager.findOne(LogisticsRegionAnalysisEntity, { where: { project: { id: projectId } } })
      if (!analysis) analysis = await manager.save(LogisticsRegionAnalysisEntity, manager.create(LogisticsRegionAnalysisEntity, { project, revision: 1, status: "DRAFT", selectedDeliveryPointIds: [], notes: "", submittedAt: null, updatedBy: actor }))
      let draft = await manager.findOne(LogisticsRoutePlanDraftEntity, { where: { project: { id: projectId } } })
      if (!draft) draft = await manager.save(LogisticsRoutePlanDraftEntity, manager.create(LogisticsRoutePlanDraftEntity, { project, revision: 1, routes: [], annotations: [], lastCheckResult: null, updatedBy: actor }))
    })
  }

  private async buildWorkspace(projectId: string, user: AuthUser): Promise<LogisticsRouteWorkspaceView> {
    const project = await this.projects.findOne({ where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    const actor = this.requireProjectAccess(project, user)
    this.ensureLogisticsProject(project)
    const [analysis, draft, stages, versions, runs, region] = await Promise.all([
      this.analyses.findOneByOrFail({ project: { id: projectId } }),
      this.drafts.findOneByOrFail({ project: { id: projectId } }),
      this.dataSource.manager.find(StudentProjectStageEntity, { where: { project: { id: projectId } }, order: { sequence: "ASC" } }),
      this.loadVersions(projectId),
      this.validationRuns.find({ where: { project: { id: projectId } }, order: { attemptNo: "DESC" } }),
      this.resources.findRegion(project.snapshot.config.regionPackageId)
    ])
    const regionStage = stages.find((stage) => stage.stageCode === "LOGISTICS_REGION_ANALYSIS")
    const planningStage = stages.find((stage) => stage.stageCode === "LOGISTICS_ROUTE_PLANNING")
    const validationStage = stages.find((stage) => stage.stageCode === "LOGISTICS_ROUTE_VALIDATION")
    const studentCanMutate = actor === "STUDENT" && project.snapshot.draft.status !== "ENDED" && project.snapshot.draft.status !== "ARCHIVED"
    const routeEditingOpen = planningStage?.status === "IN_PROGRESS" || validationStage?.status === "IN_PROGRESS"
    const latestValidVersion = versions.find((version) => version.sourceDraftRevision === draft.revision && version.validationResult && (version.validationResult.status === "PASSED" || version.validationResult.status === "WITH_RISK"))
    const assessmentRedaction = actor === "STUDENT" && project.snapshot.mode === "ASSESSMENT"
    return {
      projectId,
      actor,
      mode: project.snapshot.mode,
      scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
      candidateDeliveryPointIds: this.candidateDeliveryPointIds(project, region),
      requiredDeliveryPointRange: requiredDeliveryPointRange(project.snapshot.config.scaleTemplateCode),
      allowedValidationAttempts: project.snapshot.config.allowedValidationAttempts,
      validationAttemptCount: runs.length,
      canEditRegion: studentCanMutate && regionStage?.status === "IN_PROGRESS",
      canConfirmRegion: studentCanMutate && regionStage?.status === "IN_PROGRESS" && analysis.selectedDeliveryPointIds.length > 0,
      canEditRoutes: studentCanMutate && routeEditingOpen,
      canCompletePlanning: studentCanMutate && planningStage?.status === "IN_PROGRESS" && draft.lastCheckResult?.passed === true,
      canValidate: studentCanMutate && validationStage?.status === "IN_PROGRESS" && runs.length < project.snapshot.config.allowedValidationAttempts && draft.routes.length > 0,
      canSubmit: studentCanMutate && validationStage?.status === "IN_PROGRESS" && Boolean(latestValidVersion),
      regionAnalysis: this.serializeAnalysis(analysis),
      draft: this.serializeDraft(draft, assessmentRedaction),
      versions: versions.map((version) => this.serializeVersion(version, assessmentRedaction)),
      validationRuns: runs.map((run) => this.serializeRun(run, assessmentRedaction)),
      aircraft: logisticsAircraftCapability
    }
  }

  private async lockWorkspaceRecords(manager: EntityManager, projectId: string, user: AuthUser): Promise<LogisticsWorkspaceRecords> {
    await manager.findOne(StudentProjectEntity, { where: { id: projectId }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
    const project = await this.loadProject(manager, projectId, user)
    const analysis = await manager.findOne(LogisticsRegionAnalysisEntity, { where: { project: { id: projectId } }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
    const draft = await manager.findOne(LogisticsRoutePlanDraftEntity, { where: { project: { id: projectId } }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
    if (!analysis || !draft) throw new ConflictException("物流工作区尚未初始化，请重新打开项目")
    const region = await this.resources.findRegion(project.snapshot.config.regionPackageId)
    return { project, analysis, draft, region }
  }

  private async loadProject(manager: EntityManager, projectId: string, user: AuthUser): Promise<StudentProjectEntity> {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    this.requireProjectAccess(project, user)
    this.ensureLogisticsProject(project)
    return project
  }

  private requireProjectAccess(project: StudentProjectEntity, user: AuthUser): "STUDENT" | "TEACHER" {
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return "STUDENT"
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return "TEACHER"
    throw new ForbiddenException("无权访问该学生项目")
  }

  private ensureLogisticsProject(project: StudentProjectEntity): void {
    if (project.snapshot.sceneType !== "CITY_LOGISTICS") throw new BadRequestException("当前项目不是城市低空物流场景")
  }

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    const status = project.snapshot.draft.status
    if (status === "ENDED" || status === "ARCHIVED") throw new ConflictException("任务已结束或归档，不能继续修改")
  }

  private requireStudent(user: AuthUser): void {
    if (user.role !== "student") throw new ForbiddenException("仅学生可以修改物流航线方案")
  }

  private async requireStage(
    manager: EntityManager,
    projectId: string,
    stageCode: "LOGISTICS_REGION_ANALYSIS" | "LOGISTICS_ROUTE_PLANNING" | "LOGISTICS_ROUTE_VALIDATION",
    expectedStatus: "IN_PROGRESS",
    lock = false
  ): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, {
      where: { project: { id: projectId }, stageCode },
      ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {})
    })
    if (!stage) throw new NotFoundException("物流项目阶段不存在")
    if (stage.status !== expectedStatus) throw new ConflictException("请先开始当前物流阶段")
    return stage
  }

  private async assertRouteEditingOpen(manager: EntityManager, project: StudentProjectEntity): Promise<void> {
    const stages = await manager.find(StudentProjectStageEntity, { where: { project: { id: project.id } } })
    const planning = stages.find((stage) => stage.stageCode === "LOGISTICS_ROUTE_PLANNING")
    const validation = stages.find((stage) => stage.stageCode === "LOGISTICS_ROUTE_VALIDATION")
    if (planning?.status !== "IN_PROGRESS" && validation?.status !== "IN_PROGRESS") throw new ConflictException("请先开始航线规划或航线验证阶段")
  }

  private assertDeliverySelection(project: StudentProjectEntity, region: V3RegionCatalogItem, selectedIds: string[]): void {
    const range = requiredDeliveryPointRange(project.snapshot.config.scaleTemplateCode)
    if (selectedIds.length < range.minimum || selectedIds.length > range.maximum) throw new BadRequestException(`当前模板须启用 ${range.minimum} 到 ${range.maximum} 个配送点`)
    const availableIds = new Set(this.candidateDeliveryPointIds(project, region))
    if (selectedIds.some((id) => !availableIds.has(id))) throw new BadRequestException("启用配送点不属于教师发布的候选范围")
  }

  private candidateDeliveryPointIds(project: StudentProjectEntity, region: V3RegionCatalogItem): string[] {
    const configured = project.snapshot.config.scenario.candidateDeliveryPointIds
    if (Array.isArray(configured)) {
      const ids = configured.filter((value): value is string => typeof value === "string" && value.length > 0)
      if (ids.length > 0) return ids
    }
    return (region.logisticsNodes ?? []).filter((node) => node.type === "DELIVERY_POINT" && node.enabled).map((node) => node.id)
  }

  private check(records: LogisticsWorkspaceRecords): LogisticsRouteCheckResult {
    this.assertDeliverySelection(records.project, records.region, records.analysis.selectedDeliveryPointIds)
    return checkLogisticsRoutePlan(records.draft.routes, this.ruleContext(records))
  }

  private ruleContext(records: LogisticsWorkspaceRecords) {
    return { region: records.region, selectedDeliveryPointIds: records.analysis.selectedDeliveryPointIds, aircraft: logisticsAircraftCapability }
  }

  private assertSubmissionTransition(project: StudentProjectEntity, stage: StudentProjectStageEntity): void {
    const decision = decideStageTransition(stage.status, "SUBMITTED", {
      actor: "STUDENT",
      mode: project.snapshot.mode,
      allowResubmission: project.snapshot.config.allowResubmission,
      prerequisitesSatisfied: true,
      submissionGatePassed: true
    })
    if (!decision.allowed) throw new ConflictException("当前阶段不能提交")
  }

  private async acceptStageAndUnlockNext(manager: EntityManager, project: StudentProjectEntity, stage: StudentProjectStageEntity, now: Date): Promise<void> {
    stage.status = "ACCEPTED"
    stage.revision += 1
    stage.submittedAt = now
    stage.acceptedAt = now
    await manager.save(stage)
    const next = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: project.id }, sequence: stage.sequence + 1 }, lock: { mode: "pessimistic_write" } })
    if (next?.status === "LOCKED") {
      next.status = "AVAILABLE"
      next.revision += 1
      await manager.save(next)
      project.currentStageCode = next.stageCode
    }
    project.status = "IN_PROGRESS"
    project.lastActivityAt = now
    await manager.save(project)
  }

  private async createVersion(
    manager: EntityManager,
    records: LogisticsWorkspaceRecords,
    user: AuthUser,
    status: "SNAPSHOT" | "VALIDATED",
    checkResult: LogisticsRouteCheckResult,
    validationResult: LogisticsRouteValidationResult | null,
    recordSnapshotActivity = true
  ): Promise<LogisticsRoutePlanVersionEntity> {
    const raw = await manager.createQueryBuilder(LogisticsRoutePlanVersionEntity, "version").select("COALESCE(MAX(version.versionNo), 0)", "maximum").where("version.projectId = :projectId", { projectId: records.project.id }).getRawOne<{ maximum: string | number }>()
    const versionNo = Number(raw?.maximum ?? 0) + 1
    const creator = await manager.findOneByOrFail(UserEntity, { id: user.id })
    const version = await manager.save(LogisticsRoutePlanVersionEntity, manager.create(LogisticsRoutePlanVersionEntity, {
      project: records.project,
      versionNo,
      sourceDraftRevision: records.draft.revision,
      status,
      checkResult,
      validationResult,
      annotations: records.draft.annotations,
      createdBy: creator,
      validatedAt: validationResult ? new Date(validationResult.checkedAt) : null,
      submittedAt: null
    }))
    for (const input of records.draft.routes) {
      const route = await manager.save(LogisticsRouteEntity, manager.create(LogisticsRouteEntity, {
        version,
        routeKey: input.id,
        name: input.name,
        mode: input.mode ?? "FIXED_ROUND_TRIP",
        destinationNodeId: input.destinationNodeId,
        direction: input.direction,
        role: input.role,
        groupCode: input.groupCode,
        departureNodeId: input.departureNodeId,
        arrivalNodeId: input.arrivalNodeId,
        protectionRadiusMeters: input.protectionRadiusMeters,
        waitingNodeIds: input.waitingNodeIds,
        alternateLandingNodeIds: input.alternateLandingNodeIds,
        emergencyAreaNodeIds: input.emergencyAreaNodeIds,
        entryDirectionDegrees: input.entryDirectionDegrees,
        exitDirectionDegrees: input.exitDirectionDegrees
      }))
      await manager.save(LogisticsWaypointEntity, input.waypoints.map((waypoint, sequence) => manager.create(LogisticsWaypointEntity, {
        route,
        sequence,
        waypointKey: waypoint.id,
        name: waypoint.name,
        longitude: waypoint.position.longitude,
        latitude: waypoint.position.latitude,
        altitudeMeters: waypoint.altitudeMeters,
        segmentAltitudeMeters: waypoint.segmentAltitudeMeters,
        speedMps: waypoint.speedMps,
        nodeId: waypoint.nodeId,
        locked: waypoint.locked
      })))
    }
    await manager.increment(ProjectActivityCounterEntity, { project: { id: records.project.id } }, "savedVersionCount", 1)
    if (status === "SNAPSHOT" && recordSnapshotActivity) {
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId: records.project.id,
        stageCode: records.project.currentStageCode === "LOGISTICS_ROUTE_VALIDATION" ? "LOGISTICS_ROUTE_VALIDATION" : "LOGISTICS_ROUTE_PLANNING",
        actor: user,
        eventType: "LOGISTICS_ROUTE_VERSION_CREATED",
        objectType: "LOGISTICS_ROUTE_VERSION",
        objectId: version.id,
        result: { versionNo, routeCount: records.draft.routes.length }
      })
    }
    return version
  }

  private async loadVersion(manager: EntityManager, projectId: string, versionId: string, lock = false): Promise<LogisticsRoutePlanVersionEntity> {
    if (lock) {
      const locked = await manager.findOne(LogisticsRoutePlanVersionEntity, { where: { id: versionId, project: { id: projectId } }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
      if (!locked) throw new NotFoundException("航线版本不存在")
    }
    const version = await manager.findOne(LogisticsRoutePlanVersionEntity, { where: { id: versionId, project: { id: projectId } } })
    if (!version) throw new NotFoundException("航线版本不存在")
    const routes = await manager.find(LogisticsRouteEntity, { where: { version: { id: version.id } }, order: { routeKey: "ASC" } })
    const waypoints = routes.length === 0
      ? []
      : await manager.find(LogisticsWaypointEntity, { where: { route: { id: In(routes.map((route) => route.id)) } }, relations: { route: true }, order: { sequence: "ASC" } })
    const waypointsByRoute = new Map<string, LogisticsWaypointEntity[]>()
    for (const waypoint of waypoints) {
      const list = waypointsByRoute.get(waypoint.route.id) ?? []
      list.push(waypoint)
      waypointsByRoute.set(waypoint.route.id, list)
    }
    for (const route of routes) route.waypoints = waypointsByRoute.get(route.id) ?? []
    version.routes = routes
    return version
  }

  private async loadVersions(projectId: string): Promise<LogisticsRoutePlanVersionEntity[]> {
    const versions = await this.versions.find({ where: { project: { id: projectId } }, order: { versionNo: "DESC" } })
    return Promise.all(versions.map((version) => this.loadVersion(this.dataSource.manager, projectId, version.id)))
  }

  private routesFromVersion(version: LogisticsRoutePlanVersionEntity): LogisticsRouteInput[] {
    return [...(version.routes ?? [])].sort((left, right) => left.routeKey.localeCompare(right.routeKey)).map((route) => ({
      id: route.routeKey,
      name: route.name,
      mode: route.mode ?? "FIXED_ROUND_TRIP",
      destinationNodeId: route.destinationNodeId,
      direction: route.direction,
      role: route.role,
      groupCode: route.groupCode,
      departureNodeId: route.departureNodeId,
      arrivalNodeId: route.arrivalNodeId,
      protectionRadiusMeters: route.protectionRadiusMeters,
      waitingNodeIds: route.waitingNodeIds,
      alternateLandingNodeIds: route.alternateLandingNodeIds,
      emergencyAreaNodeIds: route.emergencyAreaNodeIds,
      entryDirectionDegrees: route.entryDirectionDegrees,
      exitDirectionDegrees: route.exitDirectionDegrees,
      waypoints: [...(route.waypoints ?? [])].sort((left, right) => left.sequence - right.sequence).map((waypoint) => ({
        id: waypoint.waypointKey,
        name: waypoint.name,
        position: { longitude: waypoint.longitude, latitude: waypoint.latitude },
        altitudeMeters: waypoint.altitudeMeters,
        segmentAltitudeMeters: waypoint.segmentAltitudeMeters,
        speedMps: waypoint.speedMps,
        nodeId: waypoint.nodeId,
        locked: waypoint.locked
      }))
    }))
  }

  private serializeAnalysis(entity: LogisticsRegionAnalysisEntity): LogisticsRegionAnalysisView {
    return { id: entity.id, revision: entity.revision, status: entity.status, selectedDeliveryPointIds: entity.selectedDeliveryPointIds, notes: entity.notes, submittedAt: entity.submittedAt?.toISOString() ?? null, updatedAt: entity.updatedAt.toISOString() }
  }

  private serializeDraft(entity: LogisticsRoutePlanDraftEntity, redact: boolean): LogisticsRouteDraftView {
    return { id: entity.id, revision: entity.revision, routes: entity.routes, annotations: entity.annotations, lastCheckResult: entity.lastCheckResult ? this.maybeRedactCheck(entity.lastCheckResult, redact) : null, updatedAt: entity.updatedAt.toISOString() }
  }

  private serializeVersion(entity: LogisticsRoutePlanVersionEntity, redact: boolean): LogisticsRouteVersionView {
    return {
      id: entity.id,
      versionNo: entity.versionNo,
      sourceDraftRevision: entity.sourceDraftRevision,
      status: entity.status,
      routes: this.routesFromVersion(entity),
      annotations: entity.annotations,
      checkResult: this.maybeRedactCheck(entity.checkResult, redact),
      validationResult: entity.validationResult ? this.maybeRedactValidation(entity.validationResult, redact) : null,
      createdBy: entity.createdBy.displayName,
      createdAt: entity.createdAt.toISOString(),
      validatedAt: entity.validatedAt?.toISOString() ?? null,
      submittedAt: entity.submittedAt?.toISOString() ?? null
    }
  }

  private serializeRun(entity: LogisticsRouteValidationRunEntity, redact: boolean): LogisticsRouteValidationRunView {
    return { id: entity.id, versionId: entity.version.id, attemptNo: entity.attemptNo, status: entity.status, result: this.maybeRedactValidation(entity.result, redact), createdAt: entity.createdAt.toISOString() }
  }

  private maybeRedactCheck(result: LogisticsRouteCheckResult, redact: boolean): LogisticsRouteCheckResult {
    if (!redact) return result
    return { ...result, evidence: this.redactEvidence(result.evidence) }
  }

  private maybeRedactValidation(result: LogisticsRouteValidationResult, redact: boolean): LogisticsRouteValidationResult {
    if (!redact) return result
    return { ...result, evidence: this.redactEvidence(result.evidence) }
  }

  private redactEvidence(evidence: LogisticsRouteCheckResult["evidence"]): LogisticsRouteCheckResult["evidence"] {
    const severities = [...new Set(evidence.map((item) => item.severity))]
    return severities.map((severity) => ({
      code: `${severity}_PRESENT`,
      category: severity === "CONFLICT" ? "SPATIAL" : "EFFICIENCY",
      severity,
      blocking: severity === "CONFLICT",
      message: severity === "CONFLICT" ? "当前方案存在硬性冲突" : severity === "RISK" ? "当前方案存在运行风险" : "当前方案存在效率提示",
      routeIds: [],
      waypointIds: [],
      segmentIndexes: [],
      position: null,
      data: {}
    }))
  }
}
