import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { DataSource, EntityManager, In, Repository } from "typeorm"
import type { FindOptionsWhere } from "typeorm"
import { randomUUID } from "node:crypto"
import {
  allowedStageActions,
  decideStageTransition,
  displayTeachingAssignmentTitle,
  isV3StageCode,
  defaultLogisticsEventSubtype,
  isLogisticsEventSubtypeAllowed,
  learningModes,
  logisticsTemplatePolicy,
  vtlTemplatePolicy,
  showMaximumEventImpactCount,
  isSupportedShowScaleTemplateCode,
  resourceVersionIdentity,
  showTemplatePolicy,
  resourcePackageTypes,
  stageDefinitionsFor,
  vtlStageCodes,
  type AssignmentDraftConfig,
  type AssignmentDraftDetailView,
  type AssignmentDraftView,
  type AssignmentPreflightCheckView,
  type AssignmentPreflightView,
  type AssignmentSnapshotView,
  type AssignmentTargetInput,
  type AssignmentUpgradePreviewView,
  type AssignmentUpgradeResultView,
  type AuthUser,
  type LearningMode,
  type LogisticsScenarioEventSubtype,
  type LogisticsOrderPreviewView,
  type ResourcePackageType,
  type SceneType,
  type StudentProjectView,
  type V3ProgressAlertState,
  type V3ProgressEvaluationState,
  type V3ProgressSubmissionState,
  type V3RegionMapReadinessView,
  type V3ResourceReference,
  type V3ScenarioEventCondition,
  type V3ScenarioEventConfig,
  type V3StageCode,
  type V3TeacherProgressMilestone,
  type V3TeacherProgressItem,
  type V3TeacherProgressPage,
  type V3TeachingOverview,
  type V3RuntimeAlertView
  ,type V3TeacherAlertFollowUpStatus
} from "@wurenji/shared"
import { generateLogisticsOrders, logisticsOrderGeneratorVersion } from "@wurenji/simulation"
import { UserEntity } from "../../entities.js"
import {
  ClassMemberEntity,
  ClassroomEntity,
  ExerciseVersionEntity
} from "../../education/education.entities.js"
import { sha256Canonical } from "../common/canonical-json.js"
import { formalMapResourcesRequired, ResourcePackageService } from "../resources/resource-package.service.js"
import { ScenarioOverlayService } from "../resources/scenario-overlay.service.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import {
  AssignmentDraftEntity,
  AssignmentSnapshotEntity,
  AssignmentSnapshotResourceRevisionEntity,
  AssignmentTargetEntity,
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "./assignment.entities.js"
import { decideAssignmentLifecycle } from "./assignment-lifecycle.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeSessionEntity } from "../runtime/runtime.entities.js"
import { ShowProjectDocumentEntity } from "../documents/show-document.entities.js"
import { ShowSimulationClockEntity } from "../show-readiness/show-readiness.entities.js"
import { ShowOperationalReportEntity } from "../show-runtime/show-runtime.entities.js"
import {
  LogisticsRoutePlanDraftEntity,
  LogisticsRoutePlanVersionEntity,
  LogisticsRouteValidationRunEntity
} from "../logistics-route/logistics-route.entities.js"
import {
  LogisticsScheduleDraftEntity,
  LogisticsScheduleVersionEntity
} from "../logistics-scheduling/logistics-scheduling.entities.js"
import { logisticsOrderConfig } from "../logistics-scheduling/logistics-scheduling.validation.js"
import { logisticsEventDefinition } from "../logistics-runtime/logistics-event-catalog.js"
import { vtlEventDefinition } from "../vtl-runtime/vtl-event-catalog.js"
import { showEventDefinition } from "../show-runtime/show-event-catalog.js"
import { normalizeShowAssignmentParameters } from "./show-assignment-parameters.js"
import { normalizeLogisticsAssignmentParameters } from "./logistics-assignment-parameters.js"
import { normalizeShowInitialConditions } from "./show-initial-conditions.js"
import { buildTeacherProgressMilestones } from "./teacher-progress.js"
import { normalizeVtlAssignmentParameters } from "./vtl-assignment-parameters.js"
import { isSimplePolygon, pointsStayInsidePolygon, polygonStaysInsidePolygon } from "../vtl-inspection/vtl-allocation-validation.js"
import { AssessmentWindowService } from "../assessment/assessment-window.service.js"
import { buildTeachingAssignmentQueue } from "./assignment-queue.js"
import { collectTargetClassroomsByDraftId } from "./assignment-targets.js"
import { filterVisibleStudentProjects } from "./student-project-visibility.js"
import { QuestionBankVersionEntity } from "../../education/question-bank.entities.js"
import { normalizeQuestionDefinitions } from "../../education/question-bank.validation.js"
import { TeacherAlertFollowUpEntity } from "./teacher-alert-follow-up.entity.js"

interface CreateAssignmentDraftInput {
  title?: string
  sceneType?: SceneType
  mode?: LearningMode
  sourceExerciseVersionId?: string
  isDemo?: boolean
  isAcceptanceData?: boolean
  config?: Partial<AssignmentDraftConfig>
}

interface UpdateAssignmentDraftInput {
  expectedRevision?: number
  title?: string
  isDemo?: boolean
  isAcceptanceData?: boolean
  config?: Partial<AssignmentDraftConfig>
}

interface PreviewAssignmentInput {
  expectedRevision?: number
  targets?: AssignmentTargetInput[]
  resourcePackageIds?: string[]
}

interface PublishAssignmentInput extends PreviewAssignmentInput {
  configHash?: string
  preflightConfirmation?: {
    checkedAt?: string
    checkCodes?: string[]
  }
}

interface AssignmentLifecycleInput {
  reason?: string
}

interface CreateAssessmentRetakeInput {
  reason?: string
  availableAt?: string
  dueAt?: string
}

interface ApplyAssignmentResourceUpgradeInput {
  expectedRevision?: number
  snapshotChecksum?: string
}

interface ResolvedTarget {
  type: "CLASS" | "STUDENT"
  targetId: string
  classroom: ClassroomEntity | null
  student: UserEntity | null
}

interface TeacherProgressFilter {
  sceneType?: string | undefined
  stageCode?: string | undefined
  submissionState?: string | undefined
  alertState?: string | undefined
  alertSeverity?: string | undefined
  followUpStatus?: string | undefined
  stalledOnly?: boolean | undefined
  evaluationState?: string | undefined
  focusState?: string | undefined
  classroomId?: string | undefined
  keyword?: string | undefined
  projectPage?: { page: number; pageSize: number } | undefined
  includeInternalData?: boolean | undefined
}

interface TeacherProgressData {
  items: V3TeacherProgressItem[]
  total: number
}

@Injectable()
export class V3AssignmentService {
  constructor(
    @InjectRepository(AssignmentDraftEntity) private readonly drafts: Repository<AssignmentDraftEntity>,
    @InjectRepository(AssignmentSnapshotEntity) private readonly snapshots: Repository<AssignmentSnapshotEntity>,
    @InjectRepository(AssignmentSnapshotResourceRevisionEntity) private readonly snapshotResourceRevisions: Repository<AssignmentSnapshotResourceRevisionEntity>,
    @InjectRepository(AssignmentTargetEntity) private readonly assignmentTargets: Repository<AssignmentTargetEntity>,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(RuntimeAlertEntity) private readonly runtimeAlerts: Repository<RuntimeAlertEntity>,
    @InjectRepository(RuntimeSessionEntity) private readonly runtimeSessions: Repository<RuntimeSessionEntity>,
    @InjectRepository(ProjectEvaluationEntity) private readonly evaluations: Repository<ProjectEvaluationEntity>,
    @InjectRepository(ShowProjectDocumentEntity) private readonly showDocuments: Repository<ShowProjectDocumentEntity>,
    @InjectRepository(ShowSimulationClockEntity) private readonly showClocks: Repository<ShowSimulationClockEntity>,
    @InjectRepository(ShowOperationalReportEntity) private readonly showOperationalReports: Repository<ShowOperationalReportEntity>,
    @InjectRepository(LogisticsRoutePlanDraftEntity) private readonly logisticsRouteDrafts: Repository<LogisticsRoutePlanDraftEntity>,
    @InjectRepository(LogisticsRoutePlanVersionEntity) private readonly logisticsRouteVersions: Repository<LogisticsRoutePlanVersionEntity>,
    @InjectRepository(LogisticsRouteValidationRunEntity) private readonly logisticsRouteValidations: Repository<LogisticsRouteValidationRunEntity>,
    @InjectRepository(LogisticsScheduleDraftEntity) private readonly logisticsScheduleDrafts: Repository<LogisticsScheduleDraftEntity>,
    @InjectRepository(LogisticsScheduleVersionEntity) private readonly logisticsScheduleVersions: Repository<LogisticsScheduleVersionEntity>,
    @InjectRepository(QuestionBankVersionEntity) private readonly questionBankVersions: Repository<QuestionBankVersionEntity>,
    @InjectRepository(TeacherAlertFollowUpEntity) private readonly teacherAlertFollowUps: Repository<TeacherAlertFollowUpEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(ExerciseVersionEntity) private readonly exerciseVersions: Repository<ExerciseVersionEntity>,
    private readonly resources: ResourcePackageService,
    private readonly scenarioOverlays: ScenarioOverlayService,
    private readonly activities: ActivityLogService,
    private readonly assessmentWindows: AssessmentWindowService,
    private readonly dataSource: DataSource
  ) {}

  async listDrafts(user: AuthUser, includeInternalData = false): Promise<AssignmentDraftView[]> {
    this.requireTeacher(user)
    const where: FindOptionsWhere<AssignmentDraftEntity> = user.role === "admin"
      ? {}
      : { createdBy: { id: user.id } }
    if (!includeInternalData) {
      where.isDemo = false
      where.isAcceptanceData = false
    }
    const drafts = await this.drafts.find({ where, order: { updatedAt: "DESC" } })
    return drafts.map((draft) => this.serializeDraft(draft))
  }

  async getDraft(id: string, user: AuthUser): Promise<AssignmentDraftView> {
    this.requireTeacher(user)
    return this.serializeDraft(await this.findOwnedDraft(id, user))
  }

  async getAssignmentDetail(id: string, user: AuthUser): Promise<AssignmentDraftDetailView> {
    this.requireTeacher(user)
    const draft = await this.findOwnedDraft(id, user)
    const snapshot = await this.snapshots.findOne({ where: { draft: { id: draft.id } } })
    if (!snapshot) {
      return { assignment: this.serializeDraft(draft), snapshot: null, targets: [], projectCount: 0, startedProjectCount: 0 }
    }
    const [targets, projects] = await Promise.all([
      this.assignmentTargets.find({ where: { snapshot: { id: snapshot.id } }, order: { targetType: "ASC", createdAt: "ASC" } }),
      this.projects.find({ where: { snapshot: { id: snapshot.id } } })
    ])
    return {
      assignment: this.serializeDraft(draft),
      snapshot: this.serializeSnapshot(snapshot),
      targets: targets.map((target) => target.targetType === "CLASS"
        ? {
            type: target.targetType,
            targetId: target.classroom!.id,
            name: target.classroom!.name,
            detail: `${target.classroom!.code} · ${target.classroom!.course.name}`
          }
        : {
            type: target.targetType,
            targetId: target.student!.id,
            name: target.student!.displayName,
            detail: target.student!.email
          }),
      projectCount: projects.length,
      startedProjectCount: projects.filter((project) => project.status !== "NOT_STARTED").length
    }
  }

  async copyDraft(id: string, user: AuthUser): Promise<AssignmentDraftView> {
    this.requireTeacher(user)
    return this.dataSource.transaction(async (manager) => {
      const source = await manager.findOne(AssignmentDraftEntity, { where: { id } })
      if (!source) throw new NotFoundException("任务不存在")
      this.requireDraftOwner(source, user)
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const copy = await manager.save(AssignmentDraftEntity, manager.create(AssignmentDraftEntity, {
        title: copiedTitle(source.title),
        sceneType: source.sceneType,
        mode: source.mode,
        status: "DRAFT",
        isDemo: source.isDemo,
        isAcceptanceData: source.isAcceptanceData,
        config: structuredClone(source.config),
        revision: 1,
        configHash: null,
        endedAt: null,
        archivedAt: null,
        lifecycleReason: null,
        sourceExerciseVersion: source.sourceExerciseVersion,
        createdBy: owner
      }))
      await this.activities.record(manager, {
        assignmentId: copy.id,
        actor: user,
        eventType: "ASSIGNMENT_COPIED",
        objectType: "ASSIGNMENT",
        objectId: copy.id,
        afterRevision: copy.revision,
        payload: { sourceAssignmentId: source.id, sourceStatus: source.status }
      })
      return this.serializeDraft(copy)
    })
  }

  async deleteDraft(id: string, user: AuthUser): Promise<{ id: string; deleted: true }> {
    this.requireTeacher(user)
    return this.dataSource.transaction(async (manager) => {
      const draft = await this.lockOwnedDraft(manager, id, user)
      if (draft.status !== "DRAFT") throw new ConflictException("只有未发布草稿可以删除")
      await this.activities.record(manager, {
        assignmentId: draft.id,
        actor: user,
        eventType: "ASSIGNMENT_DELETED",
        objectType: "ASSIGNMENT",
        objectId: draft.id,
        beforeRevision: draft.revision,
        payload: { title: draft.title, sceneType: draft.sceneType, mode: draft.mode }
      })
      await manager.remove(draft)
      return { id, deleted: true as const }
    })
  }

  async createDraft(user: AuthUser, input: CreateAssignmentDraftInput): Promise<AssignmentDraftView> {
    this.requireTeacher(user)
    const title = normalizeTitle(input.title)
    const sceneType = normalizeSceneType(input.sceneType)
    const mode = normalizeMode(input.mode)
    const dataClassification = normalizeAssignmentDataClassification(input)
    assertFormalAssignmentTitle(title, dataClassification)
    const config = normalizeConfig(input.config, sceneType)
    const owner = await this.users.findOneByOrFail({ id: user.id })
    let sourceExerciseVersion: ExerciseVersionEntity | null = null
    if (input.sourceExerciseVersionId) {
      sourceExerciseVersion = await this.exerciseVersions.findOne({ where: { id: input.sourceExerciseVersionId } })
      if (!sourceExerciseVersion) throw new NotFoundException("来源任务模板版本不存在")
      if (sourceExerciseVersion.template.type !== sceneType) throw new BadRequestException("来源模板场景与任务场景不一致")
    }
    const draft = await this.drafts.save(this.drafts.create({
      title,
      sceneType,
      mode,
      status: "DRAFT",
      isDemo: dataClassification.isDemo,
      isAcceptanceData: dataClassification.isAcceptanceData,
      config,
      revision: 1,
      configHash: null,
      endedAt: null,
      archivedAt: null,
      lifecycleReason: null,
      sourceExerciseVersion,
      createdBy: owner
    }))
    await this.activities.record(this.drafts.manager, {
      assignmentId: draft.id,
      actor: user,
      eventType: "ASSIGNMENT_CREATED",
      objectType: "ASSIGNMENT",
      objectId: draft.id,
      afterRevision: draft.revision,
      payload: { sceneType: draft.sceneType, mode: draft.mode }
    })
    return this.serializeDraft(draft)
  }

  async updateDraft(id: string, user: AuthUser, input: UpdateAssignmentDraftInput): Promise<AssignmentDraftView> {
    this.requireTeacher(user)
    const draft = await this.findOwnedDraft(id, user)
    if (draft.status !== "DRAFT") throw new ConflictException("已发布任务不能修改")
    const expectedRevision = normalizePositiveInteger(input.expectedRevision, "expectedRevision")
    if (draft.revision !== expectedRevision) throw new ConflictException(`任务草稿版本冲突，当前版本为 ${draft.revision}`)
    const dataClassification = normalizeAssignmentDataClassification(input, draft)
    if (input.title !== undefined) {
      const nextTitle = normalizeTitle(input.title)
      assertFormalAssignmentTitle(nextTitle, dataClassification)
      draft.title = nextTitle
    } else {
      assertFormalAssignmentTitle(draft.title, dataClassification)
    }
    draft.isDemo = dataClassification.isDemo
    draft.isAcceptanceData = dataClassification.isAcceptanceData
    if (input.config !== undefined) draft.config = normalizeConfig({ ...draft.config, ...input.config }, draft.sceneType)
    draft.revision += 1
    draft.configHash = null
    return this.serializeDraft(await this.drafts.save(draft))
  }

  async preflight(id: string, user: AuthUser, input: PreviewAssignmentInput): Promise<AssignmentPreflightView> {
    this.requireTeacher(user)
    const draft = await this.findOwnedDraft(id, user)
    if (draft.status !== "DRAFT") throw new ConflictException("已发布任务不能重新检查")
    const expectedRevision = normalizePositiveInteger(input.expectedRevision, "expectedRevision")
    if (draft.revision !== expectedRevision) throw new ConflictException(`任务草稿版本冲突，当前版本为 ${draft.revision}`)

    const checks: AssignmentPreflightCheckView[] = []
    const addCheck = (
      code: string,
      category: AssignmentPreflightCheckView["category"],
      level: AssignmentPreflightCheckView["level"],
      title: string,
      message: string,
      step: AssignmentPreflightCheckView["step"],
      action?: string,
      focusTarget?: AssignmentPreflightCheckView["focusTarget"]
    ) => checks.push({
      code,
      category,
      level,
      title,
      message,
      action: action ?? (level === "PASSED" ? "无需处理" : preflightFocusAction(focusTarget, step)),
      step,
      ...(focusTarget ? { focusTarget } : {})
    })
    const runBlockingCheck = async (
      code: string,
      category: AssignmentPreflightCheckView["category"],
      title: string,
      step: AssignmentPreflightCheckView["step"],
      task: () => void | Promise<void>
    ) => {
      try {
        await task()
        const location = assignmentPreflightLocation(code, draft.sceneType, "", step)
        addCheck(code, category, "PASSED", title, "检查通过", location.step, undefined, location.focusTarget)
        return true
      } catch (error) {
        const message = preflightErrorMessage(error)
        const location = assignmentPreflightLocation(code, draft.sceneType, message, step)
        addCheck(code, category, "BLOCKING", title, message, location.step, undefined, location.focusTarget)
        return false
      }
    }

    await runBlockingCheck("CONFIGURATION", "CONFIGURATION", "任务基础配置", 0, () => {
      const normalized = normalizeConfig(draft.config, draft.sceneType)
      if (Date.parse(normalized.availableAt) <= Date.now()) throw new BadRequestException("开放时间必须晚于当前时间")
    })

    await runBlockingCheck("QUESTION_BANK", "CONFIGURATION", "题库版本", 1, async () => {
      if (!draft.config.questionBankVersionId) return
      await assertQuestionBankVersionReady(this.drafts.manager, draft.config.questionBankVersionId, draft.sceneType, user)
    })

    let resourceRefs: V3ResourceReference[] | null = null
    await runBlockingCheck("RESOURCE_AVAILABILITY", "RESOURCE", "发布资源可用性", 1, async () => {
      resourceRefs = await this.resources.resolveActiveReferences(normalizeIds(input.resourcePackageIds, "resourcePackageIds"))
    })
    if (resourceRefs) {
      await runBlockingCheck("RESOURCE_COVERAGE", "RESOURCE", "发布资源完整性", 1, () => {
        validateRequiredResourceTypes(draft.sceneType, draft.config, resourceRefs!)
      })
      await runBlockingCheck("SCALE_TEMPLATE", "RESOURCE", "固定规模模板", 1, async () => {
        await this.resources.assertScaleTemplateAvailable(draft.sceneType, draft.config.scaleTemplateCode, resourceRefs!)
      })
      await runBlockingCheck("EVALUATION_RUBRIC", "RESOURCE", "评价量表", 1, async () => {
        await this.resources.resolveEvaluationRubric(draft.sceneType, resourceRefs!)
      })
      await runBlockingCheck("SHOW_PROGRAM", "RESOURCE", "舞步程序", 1, async () => {
        await this.resources.assertShowProgramAvailable(draft.sceneType, draft.config, resourceRefs!)
      })
    }

    let regionReady = false
    let regionMapReadiness: V3RegionMapReadinessView | null = null
    await runBlockingCheck("REGION_SCOPE", "MAP", "教学区域", 1, async () => {
      await this.resources.assertAssignmentRegionReady(draft.sceneType, draft.config.regionPackageId, this.drafts.manager, false)
      if (draft.config.scenarioOverlayVersionId) await this.scenarioOverlays.assertPublished(draft.config.scenarioOverlayVersionId, draft.sceneType, draft.config.regionPackageId, this.drafts.manager)
      regionReady = true
    })

    const formalMapRequired = formalMapResourcesRequired()
    if (regionReady) {
      try {
        const readiness = await this.resources.mapReadiness(draft.config.regionPackageId)
        regionMapReadiness = readiness
        const issues = readiness.checks
          .filter((check) => check.required && check.status !== "READY")
          .map((check) => `${preflightMapResourceLabel(check.kind)}：${check.message}`)
        if (readiness.formalReady) {
          addCheck("MAP_RESOURCE", "MAP", "PASSED", "地图资源", "正式地图、DEM 和高程快照已通过检查", 1, undefined, "map-resource")
        } else {
          addCheck(
            "MAP_RESOURCE",
            "MAP",
            "WARNING",
            "地图资源（建议确认）",
            issues.join("；") || "地图资源尚未达到正式就绪状态",
            1,
            "返回第 2 步确认教学地图回退或查看正式资源诊断；当前不阻塞任务发布",
            "map-resource"
          )
        }
      } catch (error) {
        addCheck("MAP_RESOURCE", "MAP", "WARNING", "地图资源（检查暂不可用）", preflightErrorMessage(error), 1, "当前不阻塞任务发布，可稍后重新检查", "map-resource")
      }
    }

    await runBlockingCheck("SCENARIO_RULES", "SCENARIO", "场景规则与仿真条件", 2, async () => {
      if (draft.sceneType === "CITY_LOGISTICS") await this.resolveLogisticsOrderPreview(draft.sceneType, draft.config)
      if (draft.sceneType === "VTOL_INSPECTION") await this.canonicalizeVtlConfig(draft.config, this.drafts.manager, false)
    })

    await runBlockingCheck("PUBLISH_SCOPE", "SCOPE", "发布对象", 3, async () => {
      const targets = await this.resolveTargets(this.drafts.manager, user, normalizeTargets(input.targets))
      const students = await this.resolveTargetStudents(this.drafts.manager, targets)
      if (students.length === 0) throw new BadRequestException("发布目标中没有学生")
    })

    const summary = summarizeAssignmentPreflight(checks)
    return {
      draftId: draft.id,
      draftRevision: draft.revision,
      checkedAt: new Date().toISOString(),
      formalMapRequired,
      regionMapReadiness,
      summary,
      checks
    }
  }

  async preview(id: string, user: AuthUser, input: PreviewAssignmentInput) {
    this.requireTeacher(user)
    const draft = await this.findOwnedDraft(id, user)
    if (draft.status !== "DRAFT") throw new ConflictException("已发布任务不能重新预览")
    const expectedRevision = normalizePositiveInteger(input.expectedRevision, "expectedRevision")
    if (draft.revision !== expectedRevision) throw new ConflictException(`任务草稿版本冲突，当前版本为 ${draft.revision}`)
    const resourceRefs = await this.resources.resolveActiveReferences(normalizeIds(input.resourcePackageIds, "resourcePackageIds"))
    validateRequiredResourceTypes(draft.sceneType, draft.config, resourceRefs)
    await this.resources.resolveEvaluationRubric(draft.sceneType, resourceRefs)
    await this.resources.assertScaleTemplateAvailable(draft.sceneType, draft.config.scaleTemplateCode, resourceRefs)
    await this.resources.assertShowProgramAvailable(draft.sceneType, draft.config, resourceRefs)
    await this.resources.assertAssignmentRegionReady(draft.sceneType, draft.config.regionPackageId, this.drafts.manager, false)
    if (draft.config.scenarioOverlayVersionId) await this.scenarioOverlays.assertPublished(draft.config.scenarioOverlayVersionId, draft.sceneType, draft.config.regionPackageId, this.drafts.manager)
    if (draft.config.questionBankVersionId) await assertQuestionBankVersionReady(this.drafts.manager, draft.config.questionBankVersionId, draft.sceneType, user)
    draft.config = await this.canonicalizeVtlConfig(draft.config, this.drafts.manager, false)
    let regionMapReadiness: V3RegionMapReadinessView | null = null
    try {
      regionMapReadiness = await this.resources.mapReadiness(draft.config.regionPackageId)
    } catch {
      regionMapReadiness = null
    }
    const logisticsOrderPreview = await this.resolveLogisticsOrderPreview(draft.sceneType, draft.config)
    const resolvedTargets = await this.resolveTargets(this.drafts.manager, user, normalizeTargets(input.targets))
    const configHash = assignmentConfigHash(draft, resourceRefs, resolvedTargets)
    draft.configHash = configHash
    await this.drafts.save(draft)
    return {
      draft: this.serializeDraft(draft),
      configHash,
      resourceRefs,
      targets: resolvedTargets.map(({ type, targetId }) => ({ type, targetId })),
      studentCount: await this.countTargetStudents(this.drafts.manager, resolvedTargets),
      stageDefinitions: stageDefinitionsForConfig(draft.sceneType, draft.config),
      logisticsOrderPreview,
      regionMapReadiness,
      formalMapRequired: formalMapResourcesRequired()
    }
  }

  async publish(id: string, user: AuthUser, input: PublishAssignmentInput) {
    this.requireTeacher(user)
    return this.dataSource.transaction(async (manager) => {
      let draft = await manager.findOne(AssignmentDraftEntity, {
        where: { id },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      if (!draft) throw new NotFoundException("任务草稿不存在")
      draft = await manager.findOneByOrFail(AssignmentDraftEntity, { id })
      this.requireDraftOwner(draft, user)
      if (draft.status !== "DRAFT") {
        const existing = await manager.findOne(AssignmentSnapshotEntity, { where: { draft: { id: draft.id } } })
        if (!existing) throw new ConflictException("任务已发布但快照缺失，请联系管理员")
        return { snapshot: this.serializeSnapshot(existing), projectCount: await manager.count(StudentProjectEntity, { where: { snapshot: { id: existing.id } } }) }
      }
      const expectedRevision = normalizePositiveInteger(input.expectedRevision, "expectedRevision")
      if (draft.revision !== expectedRevision) throw new ConflictException(`任务草稿版本冲突，当前版本为 ${draft.revision}`)
      const resourceRefs = await this.resources.resolveActiveReferences(normalizeIds(input.resourcePackageIds, "resourcePackageIds"), manager)
      validateRequiredResourceTypes(draft.sceneType, draft.config, resourceRefs)
      await this.resources.resolveEvaluationRubric(draft.sceneType, resourceRefs, manager)
      await this.resources.assertScaleTemplateAvailable(draft.sceneType, draft.config.scaleTemplateCode, resourceRefs, manager)
      await this.resources.assertShowProgramAvailable(draft.sceneType, draft.config, resourceRefs, manager)
      await this.resources.assertAssignmentRegionReady(draft.sceneType, draft.config.regionPackageId, manager, false)
      const publishedOverlay = draft.config.scenarioOverlayVersionId
        ? await this.scenarioOverlays.assertPublished(draft.config.scenarioOverlayVersionId, draft.sceneType, draft.config.regionPackageId, manager)
        : null
      if (draft.config.questionBankVersionId) await assertQuestionBankVersionReady(manager, draft.config.questionBankVersionId, draft.sceneType, user)
      draft.config = await this.canonicalizeVtlConfig(draft.config, manager, false)
      await this.resolveLogisticsOrderPreview(draft.sceneType, draft.config)
      const preflightConfirmation = Array.isArray(input.preflightConfirmation?.checkCodes) && input.preflightConfirmation.checkCodes.some((code) => code !== "MAP_RESOURCE")
        ? normalizePreflightConfirmation(input.preflightConfirmation, [])
        : null
      const resolvedTargets = await this.resolveTargets(manager, user, normalizeTargets(input.targets))
      const configHash = assignmentConfigHash(draft, resourceRefs, resolvedTargets)
      if (!input.configHash || input.configHash !== configHash || draft.configHash !== configHash) {
        throw new ConflictException("发布配置已变化，请重新预览")
      }
      const students = await this.resolveTargetStudents(manager, resolvedTargets)
      if (students.length === 0) throw new BadRequestException("发布目标中没有学生")
      const publisher = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const frozenVersions = freezeAssignmentResourceVersions(resourceRefs, publishedOverlay, `assignment:${draft.id}@${draft.revision}#${configHash}`)
      const snapshot = await manager.save(AssignmentSnapshotEntity, manager.create(AssignmentSnapshotEntity, {
        draft,
        schemaVersion: 3,
        title: draft.title,
        sceneType: draft.sceneType,
        mode: draft.mode,
        isDemo: draft.isDemo,
        isAcceptanceData: draft.isAcceptanceData,
        config: draft.config,
        resourceRefs,
        resourceRevision: 1,
        ...frozenVersions,
        checksum: assignmentSnapshotChecksum(draft, draft.config, resourceRefs, frozenVersions),
        publishedBy: publisher
      }))
      await manager.save(AssignmentSnapshotResourceRevisionEntity, manager.create(AssignmentSnapshotResourceRevisionEntity, {
        snapshot,
        revision: 1,
        config: structuredClone(snapshot.config),
        resourceRefs: structuredClone(snapshot.resourceRefs),
        checksum: snapshot.checksum,
        reason: "初始发布版本",
        changedBy: publisher
      }))
      await manager.save(AssignmentTargetEntity, resolvedTargets.map((target) => manager.create(AssignmentTargetEntity, {
        snapshot,
        targetType: target.type,
        classroom: target.classroom,
        student: target.student
      })))
      const definitions = stageDefinitionsForConfig(draft.sceneType, draft.config)
      const firstStage = definitions[0]
      if (!firstStage) throw new ConflictException("场景阶段定义为空")
      const projectIds: string[] = []
      for (const student of students) {
        const project = await manager.save(StudentProjectEntity, manager.create(StudentProjectEntity, {
          snapshot,
          student,
          attemptNumber: 1,
          retakeOfProjectId: null,
          retakeReason: null,
          retakeCreatedById: null,
          retakeCreatedAt: null,
          status: "NOT_STARTED",
          currentStageCode: firstStage.code,
          assessmentStartedAt: null,
          assessmentDeadlineAt: null,
          assessmentSubmittedAt: null,
          assessmentEndedAt: null,
          assessmentAvailableAtOverride: null,
          assessmentDueAtOverride: null,
          lastActivityAt: new Date()
        }))
        projectIds.push(project.id)
        await manager.save(StudentProjectStageEntity, definitions.map((definition, index) => manager.create(StudentProjectStageEntity, {
          project,
          stageCode: definition.code,
          sequence: definition.sequence,
          status: index === 0 ? "AVAILABLE" : "LOCKED",
          revision: 1,
          submittedAt: null,
          acceptedAt: null,
          returnedAt: null
        })))
        await manager.save(ProjectActivityCounterEntity, manager.create(ProjectActivityCounterEntity, { project }))
        await this.activities.record(manager, {
          assignmentId: draft.id,
          projectId: project.id,
          actor: user,
          eventType: "PROJECT_ASSIGNED",
          objectType: "PROJECT",
          objectId: project.id,
          result: { studentId: student.id, studentName: student.displayName }
        })
      }
      draft.status = "PUBLISHED"
      draft.configHash = configHash
      draft.lifecycleReason = null
      await manager.save(draft)
      await this.activities.record(manager, {
        assignmentId: draft.id,
        actor: user,
        eventType: "ASSIGNMENT_PUBLISHED",
        objectType: "ASSIGNMENT",
        objectId: draft.id,
        beforeRevision: draft.revision,
        afterRevision: draft.revision,
        ...(preflightConfirmation ? { payload: { preflightConfirmation } } : {}),
        result: { snapshotId: snapshot.id, projectCount: projectIds.length }
      })
      return { snapshot: this.serializeSnapshot(snapshot), projectCount: students.length }
    })
  }

  async withdraw(id: string, user: AuthUser, input: AssignmentLifecycleInput): Promise<AssignmentDraftView> {
    this.requireTeacher(user)
    const reason = normalizeLifecycleReason(input.reason, true)
    return this.dataSource.transaction(async (manager) => {
      const draft = await this.lockOwnedDraft(manager, id, user)
      const snapshot = await manager.findOne(AssignmentSnapshotEntity, { where: { draft: { id: draft.id } } })
      if (!snapshot) throw new ConflictException("任务发布快照不存在，无法撤回")
      const projects = await manager.find(StudentProjectEntity, { where: { snapshot: { id: snapshot.id } } })
      const decision = decideAssignmentLifecycle(draft.status, "WITHDRAW", projects.every((project) => project.status === "NOT_STARTED"))
      if (!decision.allowed) {
        if (decision.code === "PROJECT_ALREADY_STARTED") throw new ConflictException("已有学生开始任务，不能撤回；可改为结束任务")
        throw new ConflictException("当前任务状态不能撤回")
      }
      for (const project of projects) {
        await this.activities.record(manager, {
          assignmentId: draft.id,
          projectId: project.id,
          actor: user,
          eventType: "ASSIGNMENT_WITHDRAWN",
          objectType: "ASSIGNMENT",
          objectId: draft.id,
          payload: { reason }
        })
      }
      await manager.createQueryBuilder().delete().from(StudentProjectEntity).where('"snapshotId" = :snapshotId', { snapshotId: snapshot.id }).execute()
      await manager.delete(AssignmentSnapshotEntity, snapshot.id)
      const beforeRevision = draft.revision
      draft.status = "DRAFT"
      draft.configHash = null
      draft.revision += 1
      draft.lifecycleReason = reason
      draft.endedAt = null
      draft.archivedAt = null
      await manager.save(draft)
      await this.activities.record(manager, {
        assignmentId: draft.id,
        actor: user,
        eventType: "ASSIGNMENT_WITHDRAWN",
        objectType: "ASSIGNMENT",
        objectId: draft.id,
        beforeRevision,
        afterRevision: draft.revision,
        payload: { reason },
        result: { removedProjectCount: projects.length }
      })
      return this.serializeDraft(draft)
    })
  }

  async end(id: string, user: AuthUser, input: AssignmentLifecycleInput): Promise<AssignmentDraftView> {
    return this.changeLifecycleStatus(id, user, "END", normalizeLifecycleReason(input.reason, true))
  }

  async archive(id: string, user: AuthUser, input: AssignmentLifecycleInput): Promise<AssignmentDraftView> {
    return this.changeLifecycleStatus(id, user, "ARCHIVE", normalizeLifecycleReason(input.reason, false))
  }

  async previewResourceUpgrade(id: string, user: AuthUser): Promise<AssignmentUpgradePreviewView> {
    this.requireTeacher(user)
    const draft = await this.findOwnedDraft(id, user)
    const snapshot = await this.snapshots.findOne({ where: { draft: { id: draft.id } } })
    if (!snapshot) throw new ConflictException("任务发布快照不存在，无法检查资源更新")
    const projects = await this.projects.find({ where: { snapshot: { id: snapshot.id } } })
    const startedProjectCount = projects.filter((project) => project.status !== "NOT_STARTED").length
    if (draft.status !== "PUBLISHED" || startedProjectCount > 0) {
      return ineligibleUpgradePreview(
        draft,
        snapshot,
        projects.length,
        startedProjectCount,
        startedProjectCount > 0 ? "已有学生开始任务，必须继续使用原资源版本" : "只有已发布且尚未开始的任务可以切换资源版本"
      )
    }
    const candidate = await this.resolveUpgradeCandidate(draft, snapshot, this.drafts.manager)
    return {
      assignmentId: draft.id,
      eligible: true,
      reason: null,
      expectedRevision: draft.revision,
      snapshotId: snapshot.id,
      snapshotChecksum: snapshot.checksum,
      projectCount: projects.length,
      startedProjectCount,
      currentResourceRefs: candidate.currentResourceRefs,
      candidateResourceRefs: candidate.candidateResourceRefs,
      candidateConfig: candidate.config,
      candidateSnapshotChecksum: candidate.checksum,
      changes: candidate.changes
    }
  }

  async applyResourceUpgrade(
    id: string,
    user: AuthUser,
    input: ApplyAssignmentResourceUpgradeInput
  ): Promise<AssignmentUpgradeResultView> {
    this.requireTeacher(user)
    return this.dataSource.transaction(async (manager) => {
      const draft = await this.lockOwnedDraft(manager, id, user)
      if (draft.status !== "PUBLISHED") throw new ConflictException("只有已发布且尚未开始的任务可以切换资源版本")
      const expectedRevision = normalizePositiveInteger(input.expectedRevision, "expectedRevision")
      if (draft.revision !== expectedRevision) throw new ConflictException(`任务版本冲突，当前版本为 ${draft.revision}`)
      let snapshot = await manager.findOne(AssignmentSnapshotEntity, {
        where: { draft: { id: draft.id } },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      if (!snapshot) throw new ConflictException("任务发布快照不存在，无法切换资源版本")
      snapshot.draft = draft
      if (!input.snapshotChecksum || input.snapshotChecksum !== snapshot.checksum) {
        throw new ConflictException("任务资源版本已变化，请重新检查更新")
      }
      const projects = await manager.createQueryBuilder(StudentProjectEntity, "project")
        .setLock("pessimistic_write")
        .where('project."snapshotId" = :snapshotId', { snapshotId: snapshot.id })
        .orderBy("project.id", "ASC")
        .getMany()
      if (projects.some((project) => project.status !== "NOT_STARTED")) {
        throw new ConflictException("已有学生开始任务，必须继续使用原资源版本")
      }
      const candidate = await this.resolveUpgradeCandidate(draft, snapshot, manager)
      if (candidate.changes.length === 0) throw new ConflictException("当前任务已使用最新资源版本")
      const actor = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const beforeResourceRevision = snapshot.resourceRevision
      snapshot.config = candidate.config
      snapshot.resourceRefs = candidate.candidateResourceRefs
      snapshot.mapResourceVersion = candidate.frozenVersions.mapResourceVersion
      snapshot.sceneResourceVersion = candidate.frozenVersions.sceneResourceVersion
      snapshot.planVersion = candidate.frozenVersions.planVersion
      snapshot.checksum = candidate.checksum
      snapshot.resourceRevision += 1
      snapshot = await manager.save(snapshot)
      await manager.save(AssignmentSnapshotResourceRevisionEntity, manager.create(AssignmentSnapshotResourceRevisionEntity, {
        snapshot,
        revision: snapshot.resourceRevision,
        config: structuredClone(snapshot.config),
        resourceRefs: structuredClone(snapshot.resourceRefs),
        checksum: snapshot.checksum,
        reason: "教师确认切换到最新资源版本",
        changedBy: actor
      }))
      const targets = await manager.find(AssignmentTargetEntity, { where: { snapshot: { id: snapshot.id } } })
      draft.config = candidate.config
      draft.revision += 1
      draft.configHash = assignmentConfigHash(draft, candidate.candidateResourceRefs, targets.map((target) => ({
        type: target.targetType,
        targetId: target.targetType === "CLASS" ? target.classroom!.id : target.student!.id,
        classroom: target.classroom,
        student: target.student
      })))
      await manager.save(draft)
      const activityPayload = {
        changes: candidate.changes.map((change) => ({
          packageType: change.packageType,
          from: { packageId: change.current.packageId, name: change.current.name, version: change.current.version },
          to: { packageId: change.replacement.packageId, name: change.replacement.name, version: change.replacement.version }
        }))
      }
      const activityResult = {
        resourceRevision: snapshot.resourceRevision,
        snapshotChecksum: snapshot.checksum,
        changedCount: candidate.changes.length
      }
      for (const project of projects) {
        await this.activities.record(manager, {
          assignmentId: draft.id,
          projectId: project.id,
          actor: user,
          eventType: "ASSIGNMENT_RESOURCES_UPDATED",
          objectType: "ASSIGNMENT",
          objectId: draft.id,
          beforeRevision: beforeResourceRevision,
          afterRevision: snapshot.resourceRevision,
          payload: activityPayload,
          result: activityResult
        })
      }
      await this.activities.record(manager, {
        assignmentId: draft.id,
        actor: user,
        eventType: "ASSIGNMENT_RESOURCES_UPDATED",
        objectType: "ASSIGNMENT",
        objectId: draft.id,
        beforeRevision: beforeResourceRevision,
        afterRevision: snapshot.resourceRevision,
        payload: activityPayload,
        result: { ...activityResult, projectCount: projects.length }
      })
      return {
        assignment: this.serializeDraft(draft),
        snapshot: this.serializeSnapshot(snapshot),
        changes: candidate.changes
      }
    })
  }

  async getSnapshot(id: string, user: AuthUser): Promise<AssignmentSnapshotView> {
    const snapshot = await this.snapshots.findOne({ where: { id } })
    if (!snapshot) throw new NotFoundException("任务发布快照不存在")
    if (user.role === "student") {
      const project = await this.projects.findOne({ where: { snapshot: { id }, student: { id: user.id } } })
      if (!project) throw new ForbiddenException("无权查看该任务快照")
    } else if (user.role !== "admin" && snapshot.draft.createdBy.id !== user.id) {
      throw new ForbiddenException("无权查看该任务快照")
    }
    return this.serializeSnapshot(snapshot)
  }

  async myProjects(user: AuthUser, includeInternalData = false): Promise<StudentProjectView[]> {
    if (user.role !== "student") throw new ForbiddenException("仅学生可以查看我的 V3 项目")
    const projects = await this.projects.find({ where: { student: { id: user.id } }, order: { lastActivityAt: "DESC" } })
    const visibleProjects = filterVisibleStudentProjects(projects, includeInternalData)
    await this.assessmentWindows.synchronize(visibleProjects)
    return Promise.all(visibleProjects.map((project) => this.serializeProject(project, "STUDENT")))
  }

  async teachingOverview(user: AuthUser, includeInternalData = false): Promise<V3TeachingOverview> {
    this.requireTeacher(user)
    const [drafts, progress] = await Promise.all([
      this.listDrafts(user, includeInternalData),
      this.teacherProgress(user, { includeInternalData })
    ])
    const draftIds = drafts.map((draft) => draft.id)
    const targets = draftIds.length
      ? await this.assignmentTargets.find({
          where: { snapshot: { draft: { id: In(draftIds) } } },
          relations: { snapshot: { draft: true }, classroom: { course: true } }
        })
      : []
    const classroomsByDraftId = collectTargetClassroomsByDraftId(targets)
    const assignments = buildTeachingAssignmentQueue(drafts, progress).map((assignment) => ({
      ...assignment,
      targetClassrooms: classroomsByDraftId.get(assignment.id) ?? []
    }))
    const activeDrafts = assignments.filter((draft) => draft.status === "DRAFT")
    return {
      metrics: [
        { key: "DRAFTS", label: "待发布草稿", value: activeDrafts.length, detail: "需要预览或发布" },
        { key: "NOT_STARTED", label: "尚未开始", value: progress.filter((item) => item.submissionState === "NOT_STARTED").length, detail: "已分配学生项目" },
        { key: "IN_PROGRESS", label: "正在进行", value: progress.filter((item) => item.submissionState === "IN_PROGRESS").length, detail: "按当前阶段统计" },
        { key: "SUBMITTED", label: "已提交", value: progress.filter((item) => item.submissionState === "SUBMITTED").length, detail: "等待审核或已完成" },
        { key: "ALERTS", label: "开放告警", value: progress.reduce((total, item) => total + item.alerts.length, 0), detail: "需教学关注" },
        { key: "EVALUATION", label: "待评价", value: progress.filter((item) => item.evaluationState === "PENDING").length, detail: "已提交未发布结果" }
      ],
      assignments,
      drafts: activeDrafts,
      recentProgress: progress.slice(0, 12)
    }
  }

  async teacherProgress(user: AuthUser, input: TeacherProgressFilter): Promise<V3TeacherProgressItem[]> {
    return (await this.buildTeacherProgress(user, input)).items
  }

  async teacherProgressPage(user: AuthUser, input: TeacherProgressFilter, page: number, pageSize: number): Promise<V3TeacherProgressPage> {
    const canUseDatabasePage = !input.stageCode && !input.submissionState && !input.alertState && !input.alertSeverity && !input.followUpStatus && !input.stalledOnly && !input.evaluationState && !input.focusState
    const data = await this.buildTeacherProgress(user, {
      ...input,
      projectPage: canUseDatabasePage ? { page, pageSize } : undefined
    })
    if (canUseDatabasePage) {
      return { items: data.items, page, pageSize, total: data.total, hasNext: page * pageSize < data.total }
    }
    const offset = (page - 1) * pageSize
    return { items: data.items.slice(offset, offset + pageSize), page, pageSize, total: data.total, hasNext: offset + pageSize < data.total }
  }

  private async buildTeacherProgress(user: AuthUser, input: TeacherProgressFilter): Promise<TeacherProgressData> {
    this.requireTeacher(user)
    const sceneType = normalizeOptionalSceneType(input.sceneType)
    const stageCode = normalizeOptionalStageCode(input.stageCode)
    const submissionState = normalizeOptionalFilter(input.submissionState, ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED"] as const, "提交状态")
    const alertState = normalizeOptionalFilter(input.alertState, ["NONE", "OPEN"] as const, "告警状态")
    const alertSeverity = normalizeOptionalFilter(input.alertSeverity, ["INFO", "WARNING", "ERROR", "CRITICAL"] as const, "告警等级")
    const followUpStatus = normalizeOptionalFilter(input.followUpStatus, ["WATCHING", "CLOSED"] as const, "教师跟踪状态")
    const stalledOnly = input.stalledOnly === true
    const evaluationState = normalizeOptionalFilter(input.evaluationState, ["NOT_STARTED", "PENDING", "PUBLISHED"] as const, "评价状态")
    const focusState = normalizeOptionalFilter(input.focusState, ["NOT_STARTED", "PLANNING", "CHECK_FAILED", "RUNNING", "SEVERE_ALERT", "PENDING_EVALUATION"] as const, "教学状态")
    const classroomId = input.classroomId?.trim() || undefined
    const keyword = input.keyword?.trim().toLocaleLowerCase("zh-CN") || undefined
    const includeInternalData = input.includeInternalData === true
    const classroomSnapshotIds = classroomId
      ? new Set((await this.assignmentTargets.find({
          where: { targetType: "CLASS", classroom: { id: classroomId } },
          relations: { snapshot: true }
        })).map((target) => target.snapshot.id))
      : null
    const snapshotWhere: FindOptionsWhere<AssignmentSnapshotEntity> = {
      ...(sceneType ? { sceneType } : {}),
      ...(classroomSnapshotIds ? { id: In([...classroomSnapshotIds]) } : {}),
      ...(!includeInternalData ? { isDemo: false, isAcceptanceData: false } : {}),
      ...(user.role === "admin" ? {} : { draft: { createdBy: { id: user.id } } })
    }
    let projects: StudentProjectEntity[]
    let projectTotal: number | undefined
    if (classroomSnapshotIds && classroomSnapshotIds.size === 0) {
      projects = []
      projectTotal = 0
    } else if (keyword) {
      const query = this.projects.createQueryBuilder("project")
        .innerJoinAndSelect("project.snapshot", "snapshot")
        .innerJoinAndSelect("snapshot.draft", "draft")
        .innerJoinAndSelect("project.student", "student")
        .where("1 = 1")
        .andWhere("LOWER(snapshot.\"title\") LIKE :keyword OR LOWER(draft.\"title\") LIKE :keyword OR LOWER(student.\"displayName\") LIKE :keyword OR LOWER(student.\"email\") LIKE :keyword", { keyword: `%${keyword}%` })
      if (sceneType) query.andWhere("snapshot.sceneType = :sceneType", { sceneType })
      if (!includeInternalData) query.andWhere("snapshot.isDemo = :isDemo AND snapshot.isAcceptanceData = :isAcceptanceData", { isDemo: false, isAcceptanceData: false })
      if (classroomSnapshotIds) query.andWhere("snapshot.id IN (:...classroomSnapshotIds)", { classroomSnapshotIds: [...classroomSnapshotIds] })
      if (user.role !== "admin") query.andWhere("draft.createdBy = :teacherId", { teacherId: user.id })
      query.orderBy("project.lastActivityAt", "DESC").addOrderBy("project.id", "DESC")
      const matchingRows = await query.select("project.id", "id").getRawMany<{ id: string }>()
      const matchingIds = matchingRows.map((row) => row.id)
      const matchingProjects = matchingIds.length > 0
        ? await this.projects.find({ where: { id: In(matchingIds), snapshot: snapshotWhere }, order: { lastActivityAt: "DESC", id: "DESC" } })
        : []
      projectTotal = matchingProjects.length
      projects = input.projectPage
        ? matchingProjects.slice((input.projectPage.page - 1) * input.projectPage.pageSize, input.projectPage.page * input.projectPage.pageSize)
        : matchingProjects
    } else if (input.projectPage) {
      const result = await this.projects.findAndCount({
        where: { snapshot: snapshotWhere },
        skip: (input.projectPage.page - 1) * input.projectPage.pageSize,
        take: input.projectPage.pageSize,
        order: { lastActivityAt: "DESC", id: "DESC" }
      })
      projects = result[0]
      projectTotal = result[1]
    } else {
      projects = await this.projects.find({ where: { snapshot: snapshotWhere }, order: { lastActivityAt: "DESC", id: "DESC" } })
    }
    const visibleProjects = includeInternalData
      ? projects
      : projects.filter((project) => !project.snapshot.isDemo && !project.snapshot.isAcceptanceData)
    const classroomFilteredProjects = visibleProjects
    await this.assessmentWindows.synchronize(classroomFilteredProjects)
    const projectIds = classroomFilteredProjects.map((project) => project.id)
    const showProjectIds = classroomFilteredProjects.filter((project) => project.snapshot.sceneType === "CITY_SHOW").map((project) => project.id)
    const logisticsProjectIds = classroomFilteredProjects.filter((project) => project.snapshot.sceneType === "CITY_LOGISTICS").map((project) => project.id)
    const vtlProjectIds = classroomFilteredProjects.filter((project) => project.snapshot.sceneType === "VTOL_INSPECTION").map((project) => project.id)
    const [openAlerts, evaluations, runtimeSessions, showDocuments, showClocks, showOperationalReports, routeDrafts, routeVersions, routeValidations, scheduleDrafts, scheduleVersions, vtlStages, followUps] = projectIds.length > 0
      ? await Promise.all([
          this.runtimeAlerts.find({ where: { projectId: In(projectIds), status: In(["OPEN", "ACKNOWLEDGED"]) }, order: { openedAt: "DESC" } }),
          this.evaluations.find({ where: { projectId: In(projectIds) } }),
          this.runtimeSessions.find({ where: { projectId: In(projectIds) }, order: { attemptNo: "DESC" } }),
          showProjectIds.length > 0 ? this.showDocuments.find({ where: { project: { id: In(showProjectIds) } } }) : Promise.resolve([]),
          showProjectIds.length > 0 ? this.showClocks.find({ where: { project: { id: In(showProjectIds) } } }) : Promise.resolve([]),
          showProjectIds.length > 0 ? this.showOperationalReports.find({ where: { project: { id: In(showProjectIds) }, reportType: "FLIGHT_END" } }) : Promise.resolve([]),
          logisticsProjectIds.length > 0 ? this.logisticsRouteDrafts.find({ where: { project: { id: In(logisticsProjectIds) } } }) : Promise.resolve([]),
          logisticsProjectIds.length > 0 ? this.logisticsRouteVersions.find({ where: { project: { id: In(logisticsProjectIds) } }, order: { versionNo: "DESC" } }) : Promise.resolve([]),
          logisticsProjectIds.length > 0 ? this.logisticsRouteValidations.find({ where: { project: { id: In(logisticsProjectIds) } }, order: { attemptNo: "DESC" } }) : Promise.resolve([]),
          logisticsProjectIds.length > 0 ? this.logisticsScheduleDrafts.find({ where: { project: { id: In(logisticsProjectIds) } } }) : Promise.resolve([]),
          logisticsProjectIds.length > 0 ? this.logisticsScheduleVersions.find({ where: { project: { id: In(logisticsProjectIds) } }, order: { versionNo: "DESC" } }) : Promise.resolve([]),
          vtlProjectIds.length > 0 ? this.stages.find({
            where: { project: { id: In(vtlProjectIds) } },
            relations: { project: true },
            select: { id: true, stageCode: true, status: true, sequence: true, project: { id: true } },
            order: { sequence: "ASC" }
          }) : Promise.resolve([]),
          this.teacherAlertFollowUps.find({ where: { teacherId: user.id, projectId: In(projectIds) } })
        ])
      : [[], [], [], [], [], [], [], [], [], [], [], [], []]
    const alertProjectIds = new Set(openAlerts.map((alert) => alert.projectId))
    const alertsByProjectId = groupRuntimeAlertsByProject(openAlerts)
    const followUpByAlertId = new Map(followUps.map((item) => [item.alertId, item]))
    const evaluationByProjectId = new Map(evaluations.map((evaluation) => [evaluation.projectId, evaluation.status]))
    const milestonesByProjectId = buildProgressMilestonesByProject({
      projects: classroomFilteredProjects,
      evaluations,
      runtimeSessions,
      showDocuments,
      showClocks,
      showOperationalReports,
      routeDrafts,
      routeVersions,
      routeValidations,
      scheduleDrafts,
      scheduleVersions,
      vtlStages
    })
    const items = classroomFilteredProjects
      .map((project) => this.serializeTeacherProgress(
        project,
        alertProjectIds.has(project.id) ? "OPEN" : "NONE",
        evaluationByProjectId.get(project.id) === "PUBLISHED"
          ? "PUBLISHED"
          : evaluationByProjectId.has(project.id) ? "PENDING" : "NOT_STARTED",
        milestonesByProjectId.get(project.id) ?? [],
        alertsByProjectId.get(project.id) ?? [],
        followUpByAlertId
      ))
      .filter((item) => !sceneType || item.sceneType === sceneType)
      .filter((item) => !stageCode || item.currentStageCode === stageCode)
      .filter((item) => !submissionState || item.submissionState === submissionState)
      .filter((item) => !alertState || item.alertState === alertState)
      .map((item) => ({
        ...item,
        alerts: item.alerts.filter((alert) => (
          (!alertSeverity || alert.severity === alertSeverity)
          && (!followUpStatus || alert.teacherFollowUp?.status === followUpStatus)
        ))
      }))
      .filter((item) => (!alertSeverity && !followUpStatus) || item.alerts.length > 0)
      .filter((item) => !stalledOnly || (item.submissionState === "IN_PROGRESS" && Date.now() - Date.parse(item.lastActivityAt) >= 30 * 60 * 1_000))
      .filter((item) => !evaluationState || item.evaluationState === evaluationState)
      .filter((item) => !focusState || matchesTeacherProgressFocus(item, focusState))
    return { items, total: projectTotal ?? items.length }
  }

  async updateTeacherAlertFollowUps(user: AuthUser, alertIds: string[], status: V3TeacherAlertFollowUpStatus, note = ""): Promise<V3TeacherProgressItem[]> {
    this.requireTeacher(user)
    const normalizedIds = [...new Set(alertIds.map((id) => id.trim()).filter(Boolean))]
    if (normalizedIds.length === 0 || normalizedIds.length > 100) throw new BadRequestException("请选择 1 到 100 条告警")
    if (!["WATCHING", "CLOSED"].includes(status)) throw new BadRequestException("教师告警跟踪状态无效")
    const normalizedNote = note.trim()
    if (normalizedNote.length > 1_000) throw new BadRequestException("跟踪备注不能超过 1000 个字符")
    const alerts = await this.runtimeAlerts.find({ where: { id: In(normalizedIds) } })
    const projects = await this.projects.find({ where: { id: In(alerts.map((item) => item.projectId)) } })
    const visibleProjectIds = new Set(projects
      .filter((project) => user.role === "admin" || project.snapshot.draft.createdBy.id === user.id)
      .map((project) => project.id))
    const visibleAlerts = alerts.filter((alert) => visibleProjectIds.has(alert.projectId))
    if (visibleAlerts.length !== normalizedIds.length) throw new ForbiddenException("包含无权跟踪的告警")
    await this.dataSource.transaction(async (manager) => {
      for (const alert of visibleAlerts) {
        let followUp = await manager.findOne(TeacherAlertFollowUpEntity, { where: { teacherId: user.id, alertId: alert.id } })
        if (!followUp) followUp = manager.create(TeacherAlertFollowUpEntity, { teacherId: user.id, alertId: alert.id, projectId: alert.projectId, status, note: normalizedNote })
        else { followUp.status = status; followUp.note = normalizedNote }
        await manager.save(followUp)
        await this.activities.record(manager, { actor: user, projectId: alert.projectId, objectType: "TEACHER_ALERT_FOLLOW_UP", objectId: alert.id, eventType: "TEACHER_ALERT_FOLLOW_UP_UPDATED", payload: { status, note: normalizedNote, alertId: alert.id }, result: { status } })
      }
    })
    const updatedProgress = await this.teacherProgress(user, {
      alertState: "OPEN",
      includeInternalData: true
    })
    return updatedProgress.filter((item) => visibleProjectIds.has(item.projectId))
  }

  async projectStages(projectId: string, user: AuthUser): Promise<StudentProjectView> {
    const project = await this.projects.findOne({ where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    const actor = this.requireProjectAccess(project, user)
    await this.assessmentWindows.synchronize([project])
    return this.serializeProject(project, actor)
  }

  async projectActivities(projectId: string, user: AuthUser) {
    const project = await this.projects.findOne({ where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    this.requireProjectAccess(project, user)
    return this.activities.listProject(projectId)
  }

  async createAssessmentRetake(projectId: string, user: AuthUser, input: CreateAssessmentRetakeInput): Promise<StudentProjectView> {
    this.requireTeacher(user)
    const reason = normalizeLifecycleReason(input.reason, true)!
    return this.dataSource.transaction(async (manager) => {
      const source = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
      if (!source) throw new NotFoundException("学生项目不存在")
      this.requireProjectAccess(source, user)
      if (source.snapshot.mode !== "ASSESSMENT") throw new ConflictException("训练项目不能创建补考实例")
      if (source.snapshot.draft.status === "ARCHIVED") throw new ConflictException("已归档任务不能创建补考实例")

      const originalProjectId = source.retakeOfProjectId ?? source.id
      await manager.findOneOrFail(StudentProjectEntity, {
        where: { id: originalProjectId },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      const original = await manager.findOneByOrFail(StudentProjectEntity, { id: originalProjectId })
      if (original.snapshot.id !== source.snapshot.id || original.student.id !== source.student.id) {
        throw new ConflictException("补考项目来源关系无效")
      }

      const latestAttempt = await manager.findOne(StudentProjectEntity, {
        where: { snapshot: { id: source.snapshot.id }, student: { id: source.student.id } },
        order: { attemptNumber: "DESC" }
      })
      const attemptNumber = (latestAttempt?.attemptNumber ?? 0) + 1
      const createdAt = new Date()
      const schedule = normalizeAssessmentRetakeSchedule(input, source.snapshot.config, createdAt)
      const definitions = stageDefinitionsForConfig(source.snapshot.sceneType, source.snapshot.config)
      const firstStage = definitions[0]
      if (!firstStage) throw new ConflictException("场景阶段定义为空")

      const retake = await manager.save(StudentProjectEntity, manager.create(StudentProjectEntity, {
        snapshot: source.snapshot,
        student: source.student,
        attemptNumber,
        retakeOfProjectId: original.id,
        retakeReason: reason,
        retakeCreatedById: user.id,
        retakeCreatedAt: createdAt,
        status: "NOT_STARTED",
        currentStageCode: firstStage.code,
        assessmentStartedAt: null,
        assessmentDeadlineAt: null,
        assessmentSubmittedAt: null,
        assessmentEndedAt: null,
        assessmentAvailableAtOverride: schedule.availableAt,
        assessmentDueAtOverride: schedule.dueAt,
        lastActivityAt: createdAt
      }))
      await manager.save(StudentProjectStageEntity, definitions.map((definition, index) => manager.create(StudentProjectStageEntity, {
        project: retake,
        stageCode: definition.code,
        sequence: definition.sequence,
        status: index === 0 ? "AVAILABLE" : "LOCKED",
        revision: 1,
        submittedAt: null,
        acceptedAt: null,
        returnedAt: null
      })))
      await manager.save(ProjectActivityCounterEntity, manager.create(ProjectActivityCounterEntity, { project: retake }))

      const payload = {
        reason,
        sourceProjectId: source.id,
        originalProjectId: original.id,
        availableAt: schedule.availableAt.toISOString(),
        dueAt: schedule.dueAt.toISOString()
      }
      const result = { retakeProjectId: retake.id, attemptNumber, studentId: source.student.id, studentName: source.student.displayName }
      await this.activities.record(manager, {
        assignmentId: source.snapshot.draft.id,
        projectId: original.id,
        actor: user,
        eventType: "ASSESSMENT_RETAKE_CREATED",
        objectType: "PROJECT",
        objectId: retake.id,
        payload,
        result
      })
      await this.activities.record(manager, {
        assignmentId: source.snapshot.draft.id,
        projectId: retake.id,
        actor: user,
        eventType: "ASSESSMENT_RETAKE_CREATED",
        objectType: "PROJECT",
        objectId: retake.id,
        payload,
        result
      })
      return this.serializeProjectWithManager(manager, retake, "TEACHER")
    })
  }

  async startStage(projectId: string, stageCode: string, user: AuthUser, expectedRevision: number): Promise<StudentProjectView> {
    if (user.role !== "student") throw new ForbiddenException("仅学生可以开始阶段")
    return this.dataSource.transaction(async (manager) => {
      const projectLookup = await manager.findOneBy(StudentProjectEntity, { id: projectId })
      if (!projectLookup) throw new NotFoundException("学生项目不存在")
      const assignment = await manager.findOne(AssignmentDraftEntity, {
        where: { id: projectLookup.snapshot.draft.id },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      if (!assignment) throw new ConflictException("项目所属任务不存在")
      let project = await manager.findOne(StudentProjectEntity, {
        where: { id: projectId },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      if (!project) throw new NotFoundException("学生项目不存在")
      project = await manager.findOneByOrFail(StudentProjectEntity, { id: projectId })
      if (project.student.id !== user.id) throw new ForbiddenException("无权操作该学生项目")
      if (!stageDefinitionsForConfig(project.snapshot.sceneType, project.snapshot.config).some((definition) => definition.code === stageCode)) {
        throw new NotFoundException("项目阶段不存在")
      }
      const assignmentDecision = decideAssignmentLifecycle(assignment.status, "START")
      const endedAssignmentRetake = assignment.status === "ENDED" && project.attemptNumber > 1
      if (!assignmentDecision.allowed && !endedAssignmentRetake) throw new ConflictException("任务已结束、归档或撤回，不能继续操作")
      const stage = await manager.findOne(StudentProjectStageEntity, {
        where: { project: { id: projectId }, stageCode: stageCode as V3StageCode },
        lock: { mode: "pessimistic_write" }
      })
      if (!stage) throw new NotFoundException("项目阶段不存在")
      if (stage.revision !== normalizePositiveInteger(expectedRevision, "expectedRevision")) {
        throw new ConflictException(`阶段版本冲突，当前版本为 ${stage.revision}`)
      }
      const decision = decideStageTransition(stage.status, "IN_PROGRESS", {
        actor: "STUDENT",
        mode: project.snapshot.mode,
        allowResubmission: project.snapshot.config.allowResubmission,
        prerequisitesSatisfied: true,
        submissionGatePassed: true
      })
      if (!decision.allowed) throw new ConflictException(`当前阶段不能开始：${decision.code}`)
      const now = new Date()
      this.assessmentWindows.start(project, now)
      const beforeRevision = stage.revision
      stage.status = "IN_PROGRESS"
      stage.revision += 1
      await manager.save(stage)
      project.status = "IN_PROGRESS"
      project.currentStageCode = stage.stageCode
      project.lastActivityAt = now
      await manager.save(project)
      if (assignment.status === "PUBLISHED") {
        assignment.status = "IN_PROGRESS"
        assignment.lifecycleReason = null
        await manager.save(assignment)
      }
      project.snapshot.draft.status = assignment.status
      await this.activities.record(manager, {
        assignmentId: assignment.id,
        projectId: project.id,
        stageCode: stage.stageCode,
        actor: user,
        eventType: "STAGE_STARTED",
        objectType: "STAGE",
        objectId: stage.id,
        beforeRevision,
        afterRevision: stage.revision,
        result: { assignmentStatus: assignment.status, assessmentDeadlineAt: project.assessmentDeadlineAt?.toISOString() ?? null }
      })
      return this.serializeProjectWithManager(manager, project, "STUDENT")
    })
  }

  private async serializeProject(project: StudentProjectEntity, actor: "TEACHER" | "STUDENT"): Promise<StudentProjectView> {
    return this.serializeProjectWithManager(this.projects.manager, project, actor)
  }

  private async serializeProjectWithManager(manager: EntityManager, project: StudentProjectEntity, actor: "TEACHER" | "STUDENT"): Promise<StudentProjectView> {
    const stages = await manager.find(StudentProjectStageEntity, { where: { project: { id: project.id } }, order: { sequence: "ASC" } })
    const definitions = stageDefinitionsForConfig(project.snapshot.sceneType, project.snapshot.config)
    const definitionByCode = new Map(definitions.map((definition) => [definition.code, definition]))
    const assessmentTiming = this.assessmentWindows.timing(project)
    const assignmentLocksProject = project.snapshot.draft.status === "ARCHIVED"
      || project.snapshot.draft.status === "ENDED" && project.attemptNumber === 1
    return {
      id: project.id,
      assignmentSnapshotId: project.snapshot.id,
      title: project.snapshot.title,
      displayTitle: displayTeachingAssignmentTitle({ id: project.snapshot.draft.id, title: project.snapshot.title, sceneType: project.snapshot.sceneType }),
      sceneType: project.snapshot.sceneType,
      mode: project.snapshot.mode,
      assignmentStatus: project.snapshot.draft.status,
      isDemo: project.snapshot.isDemo,
      isAcceptanceData: project.snapshot.isAcceptanceData,
      status: project.status,
      currentStageCode: project.currentStageCode,
      stages: stages.filter((stage) => definitionByCode.has(stage.stageCode)).map((stage) => ({
        stageCode: stage.stageCode,
        sequence: stage.sequence,
        title: definitionByCode.get(stage.stageCode)?.title ?? stage.stageCode,
        description: definitionByCode.get(stage.stageCode)?.description ?? "",
        openCondition: stageOpenCondition(stage.stageCode, definitions),
        status: stage.status,
        revision: stage.revision,
        allowedActions: assignmentLocksProject || actor === "STUDENT" && !assessmentTiming.canStart
          ? []
          : allowedStageActions(
              stage.status,
              project.snapshot.mode,
              project.snapshot.config.allowResubmission,
              actor
            )
      })),
      assessmentAttempt: serializeAssessmentAttempt(project),
      assessmentTiming,
      lastActivityAt: project.lastActivityAt.toISOString()
    }
  }

  private serializeTeacherProgress(
    project: StudentProjectEntity,
    alertState: V3ProgressAlertState,
    evaluationState: V3ProgressEvaluationState,
    milestones: V3TeacherProgressMilestone[],
    alerts: RuntimeAlertEntity[],
    followUpByAlertId: Map<string, TeacherAlertFollowUpEntity> = new Map()
  ): V3TeacherProgressItem {
    const definition = stageDefinitionsForConfig(project.snapshot.sceneType, project.snapshot.config).find((stage) => stage.code === project.currentStageCode)
    const submissionState: V3ProgressSubmissionState = project.status === "NOT_STARTED"
      ? "NOT_STARTED"
      : project.status === "SUBMITTED" || project.status === "EVALUATING" || project.status === "GRADED"
        ? "SUBMITTED"
        : "IN_PROGRESS"
    return {
      projectId: project.id,
      studentId: project.student.id,
      studentName: project.student.displayName,
      assignmentId: project.snapshot.draft.id,
      assignmentSnapshotId: project.snapshot.id,
      assignmentTitle: project.snapshot.title,
      assignmentDisplayTitle: displayTeachingAssignmentTitle({ id: project.snapshot.draft.id, title: project.snapshot.title, sceneType: project.snapshot.sceneType }),
      sceneType: project.snapshot.sceneType,
      mode: project.snapshot.mode,
      isDemo: project.snapshot.isDemo,
      isAcceptanceData: project.snapshot.isAcceptanceData,
      projectStatus: project.status,
      currentStageCode: project.currentStageCode,
      currentStageTitle: definition?.title ?? project.currentStageCode,
      submissionState,
      alertState,
      alerts: alerts.map((alert) => serializeTeacherAlert(alert, followUpByAlertId.get(alert.id) ?? null)),
      evaluationState,
      milestones,
      assessmentAttempt: serializeAssessmentAttempt(project),
      assessmentTiming: this.assessmentWindows.timing(project),
      canCreateAssessmentRetake: project.snapshot.mode === "ASSESSMENT"
        && project.snapshot.draft.status !== "ARCHIVED",
      lastActivityAt: project.lastActivityAt.toISOString()
    }
  }

  private async findOwnedDraft(id: string, user: AuthUser) {
    const draft = await this.drafts.findOne({ where: { id } })
    if (!draft) throw new NotFoundException("任务草稿不存在")
    this.requireDraftOwner(draft, user)
    return draft
  }

  private async lockOwnedDraft(manager: EntityManager, id: string, user: AuthUser) {
    const locked = await manager.findOne(AssignmentDraftEntity, {
      where: { id },
      loadEagerRelations: false,
      lock: { mode: "pessimistic_write" }
    })
    if (!locked) throw new NotFoundException("任务不存在")
    const draft = await manager.findOneByOrFail(AssignmentDraftEntity, { id })
    this.requireDraftOwner(draft, user)
    return draft
  }

  private async changeLifecycleStatus(
    id: string,
    user: AuthUser,
    action: "END" | "ARCHIVE",
    reason: string | null
  ): Promise<AssignmentDraftView> {
    this.requireTeacher(user)
    return this.dataSource.transaction(async (manager) => {
      const draft = await this.lockOwnedDraft(manager, id, user)
      const decision = decideAssignmentLifecycle(draft.status, action)
      if (!decision.allowed || !decision.targetStatus) throw new ConflictException(action === "END" ? "当前任务状态不能结束" : "只有已结束任务可以归档")
      const previousStatus = draft.status
      draft.status = decision.targetStatus
      draft.lifecycleReason = reason
      const changedAt = new Date()
      if (action === "END") draft.endedAt = changedAt
      else draft.archivedAt = changedAt
      await manager.save(draft)
      const snapshot = await manager.findOne(AssignmentSnapshotEntity, { where: { draft: { id: draft.id } } })
      const projects = snapshot ? await manager.find(StudentProjectEntity, { where: { snapshot: { id: snapshot.id } } }) : []
      if (action === "END") {
        projects.forEach((project) => this.assessmentWindows.end(project, changedAt))
        if (projects.length > 0) await manager.save(projects)
      }
      const eventType = action === "END" ? "ASSIGNMENT_ENDED" : "ASSIGNMENT_ARCHIVED"
      for (const project of projects) {
        await this.activities.record(manager, {
          assignmentId: draft.id,
          projectId: project.id,
          actor: user,
          eventType,
          objectType: "ASSIGNMENT",
          objectId: draft.id,
          payload: { reason, previousStatus },
          result: { status: draft.status }
        })
      }
      await this.activities.record(manager, {
        assignmentId: draft.id,
        actor: user,
        eventType,
        objectType: "ASSIGNMENT",
        objectId: draft.id,
        payload: { reason, previousStatus },
        result: { status: draft.status, affectedProjectCount: projects.length }
      })
      return this.serializeDraft(draft)
    })
  }

  private requireDraftOwner(draft: AssignmentDraftEntity, user: AuthUser) {
    if (user.role !== "admin" && draft.createdBy.id !== user.id) throw new ForbiddenException("无权管理该任务草稿")
  }

  private async resolveTargets(manager: EntityManager, user: AuthUser, inputs: AssignmentTargetInput[]): Promise<ResolvedTarget[]> {
    const targets: ResolvedTarget[] = []
    const seen = new Set<string>()
    for (const input of inputs) {
      const key = `${input.type}:${input.targetId}`
      if (seen.has(key)) continue
      seen.add(key)
      if (input.type === "CLASS") {
        const classroom = await manager.findOne(ClassroomEntity, { where: { id: input.targetId } })
        if (!classroom) throw new NotFoundException("发布班级不存在")
        if (user.role !== "admin" && classroom.createdBy.id !== user.id) throw new ForbiddenException("无权向该班级发布任务")
        targets.push({ type: "CLASS", targetId: classroom.id, classroom, student: null })
      } else {
        const student = await manager.findOne(UserEntity, { where: { id: input.targetId } })
        if (!student || student.role !== "student") throw new NotFoundException("发布学生不存在")
        if (user.role !== "admin") {
          const membership = await manager.findOne(ClassMemberEntity, {
            where: { student: { id: student.id }, classroom: { createdBy: { id: user.id } } }
          })
          if (!membership) throw new ForbiddenException("只能向本人班级中的学生发布任务")
        }
        targets.push({ type: "STUDENT", targetId: student.id, classroom: null, student })
      }
    }
    if (targets.length === 0) throw new BadRequestException("请至少选择一个发布目标")
    return targets.sort((left, right) => left.type.localeCompare(right.type) || left.targetId.localeCompare(right.targetId))
  }

  private async resolveTargetStudents(manager: EntityManager, targets: ResolvedTarget[]): Promise<UserEntity[]> {
    const students = new Map<string, UserEntity>()
    const classIds = targets.filter((target) => target.classroom).map((target) => target.classroom!.id)
    if (classIds.length > 0) {
      const members = await manager.find(ClassMemberEntity, { where: { classroom: { id: In(classIds) } } })
      members.forEach((member) => students.set(member.student.id, member.student))
    }
    targets.filter((target) => target.student).forEach((target) => students.set(target.student!.id, target.student!))
    return [...students.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  private async resolveLogisticsOrderPreview(sceneType: SceneType, config: AssignmentDraftConfig): Promise<LogisticsOrderPreviewView | null> {
    if (sceneType !== "CITY_LOGISTICS") return null
    const region = await this.resources.findRegion(config.regionPackageId)
    if (region.sceneType !== "CITY_LOGISTICS") throw new BadRequestException("物流任务必须选择物流区域包")
    const regionDeliveryPointIds = (region.logisticsNodes ?? [])
      .filter((node) => node.type === "DELIVERY_POINT" && node.enabled)
      .map((node) => node.id)
    const configuredIds = normalizeCandidateDeliveryPointIds(config.scenario.candidateDeliveryPointIds)
    const candidateDeliveryPointIds = configuredIds.length > 0 ? configuredIds : regionDeliveryPointIds
    const policy = logisticsTemplatePolicy(config.scaleTemplateCode)
    if (configuredIds.length > 0 && (candidateDeliveryPointIds.length < policy.deliveryPointRange.minimum || candidateDeliveryPointIds.length > policy.deliveryPointRange.maximum)) {
      throw new BadRequestException(`当前模板候选配送点须在 ${policy.deliveryPointRange.minimum} 到 ${policy.deliveryPointRange.maximum} 个之间`)
    }
    const availableIds = new Set(regionDeliveryPointIds)
    if (candidateDeliveryPointIds.some((id) => !availableIds.has(id))) throw new BadRequestException("候选配送点不属于当前物流区域")
    const orderConfig = logisticsOrderConfig(config.scaleTemplateCode, config.scenario, `ORDER-${randomUUID()}`)
    const orders = generateLogisticsOrders(orderConfig, candidateDeliveryPointIds)
    const releaseBatchCounts = countPreviewValues(orders.map((order) => String(Math.floor(order.releaseTimeMs / 60_000))))
    const peak = releaseBatchCounts.reduce((current, item) => item.count > current.orderCount
      ? { minuteOffset: Number(item.key), orderCount: item.count }
      : current, { minuteOffset: 0, orderCount: 0 })
    return {
      generatorVersion: logisticsOrderGeneratorVersion,
      checksum: sha256Canonical({ generatorVersion: logisticsOrderGeneratorVersion, config: orderConfig, orders }),
      config: orderConfig,
      candidateDeliveryPointIds,
      destinationCounts: countPreviewValues(orders.map((order) => order.destinationNodeId)),
      priorityCounts: countPreviewValues(orders.map((order) => order.priority)),
      releaseBatchCounts,
      peak,
      samples: orders.slice(0, 8)
    }
  }

  private async canonicalizeVtlConfig(
    config: AssignmentDraftConfig,
    manager: EntityManager = this.drafts.manager,
    requireFormalMapResources = formalMapResourcesRequired()
  ): Promise<AssignmentDraftConfig> {
    if (!config.vtlParameters) return config
    const region = await this.resources.assertAssignmentRegionReady("VTOL_INSPECTION", config.regionPackageId, manager, requireFormalMapResources)
    if (!region.vtlTaskObjects?.length || !region.vtlLandingSites?.length || !region.vtlAircraftParameters) {
      throw new ConflictException("垂起区域资源缺少任务对象、起降点或机型参数")
    }
    const policy = vtlTemplatePolicy(config.scaleTemplateCode)
    const availableTaskObjectIds = new Set(region.vtlTaskObjects.map((item) => item.id))
    const requestedTaskObjectIds = config.vtlParameters.taskObjectIds?.length
      ? [...config.vtlParameters.taskObjectIds]
      : region.vtlTaskObjects.slice(0, policy.defaultTaskObjectCount).map((item) => item.id)
    if (requestedTaskObjectIds.length < policy.taskObjectRange.minimum || requestedTaskObjectIds.length > policy.taskObjectRange.maximum) {
      throw new BadRequestException(`当前垂起模板任务对象数量须在 ${policy.taskObjectRange.minimum} 到 ${policy.taskObjectRange.maximum} 个之间`)
    }
    if (new Set(requestedTaskObjectIds).size !== requestedTaskObjectIds.length || requestedTaskObjectIds.some((id) => !availableTaskObjectIds.has(id))) {
      throw new BadRequestException("任务对象必须来自当前垂起区域资源且不能重复")
    }
    const mainLandingSite = region.vtlLandingSites.find((site) => site.id === config.vtlParameters!.mainLandingSiteId)
    if (!mainLandingSite || mainLandingSite.type !== "MAIN" || mainLandingSite.status !== "AVAILABLE") {
      throw new BadRequestException("主起降点必须来自当前区域的可用主起降点")
    }
    if (config.vtlParameters.aircraftModelCode !== region.vtlAircraftParameters.modelCode || config.vtlParameters.aircraftParameterVersion !== region.vtlAircraftParameters.version) {
      throw new BadRequestException("机型参数必须使用当前区域资源提供的版本")
    }
    const openStageCodes = config.vtlParameters.openStageCodes?.length ? [...config.vtlParameters.openStageCodes] : [...vtlStageCodes]
    if (openStageCodes.some((code, index) => code !== vtlStageCodes[index])) {
      throw new BadRequestException("垂起巡检开放步骤必须按教学顺序连续开放")
    }
    const taskAreaBoundary = config.vtlParameters.taskAreaBoundary?.length
      ? config.vtlParameters.taskAreaBoundary.map((point) => ({ ...point }))
      : region.boundary.map((point) => ({ ...point }))
    if (!isSimplePolygon(taskAreaBoundary)) throw new BadRequestException("垂起巡检任务区域必须是非自交且面积有效的多边形")
    if (!polygonStaysInsidePolygon(taskAreaBoundary, region.boundary)) throw new BadRequestException("垂起巡检任务区域必须完全位于当前区域资源范围内")
    const selectedTaskObjects = region.vtlTaskObjects.filter((item) => requestedTaskObjectIds.includes(item.id))
    const outsideTaskObject = selectedTaskObjects.find((item) => !pointsStayInsidePolygon(item.positions, taskAreaBoundary))
    if (outsideTaskObject) throw new BadRequestException(`任务对象 ${outsideTaskObject.code} 未完全位于本次巡检任务区域内`)
    return normalizeConfig({
      ...config,
      vtlParameters: {
        ...config.vtlParameters,
        taskObjectIds: requestedTaskObjectIds,
        taskAreaBoundary,
        openStageCodes
      }
    }, "VTOL_INSPECTION")
  }

  private async countTargetStudents(manager: EntityManager, targets: ResolvedTarget[]): Promise<number> {
    return (await this.resolveTargetStudents(manager, targets)).length
  }

  private async resolveUpgradeCandidate(
    draft: AssignmentDraftEntity,
    snapshot: AssignmentSnapshotEntity,
    manager: EntityManager
  ) {
    const plan = await this.resources.planActiveReferenceUpgrade(snapshot.sceneType, snapshot.resourceRefs, manager)
    const config = structuredClone(snapshot.config)
    const regionChange = plan.changes.find((change) => change.packageType === "REGION")
    if (regionChange && snapshot.config.scenarioOverlayVersionId) {
      throw new ConflictException("绑定场景覆盖层的任务不能单独切换区域资源，请先创建匹配区域的新覆盖层版本")
    }
    if (regionChange) config.regionPackageId = regionChange.replacement.packageId
    validateRequiredResourceTypes(snapshot.sceneType, config, plan.candidateResourceRefs)
    await this.resources.resolveEvaluationRubric(snapshot.sceneType, plan.candidateResourceRefs, manager)
    await this.resources.assertScaleTemplateAvailable(snapshot.sceneType, config.scaleTemplateCode, plan.candidateResourceRefs, manager)
    await this.resources.assertShowProgramAvailable(snapshot.sceneType, config, plan.candidateResourceRefs, manager)
    const canonicalConfig = await this.canonicalizeVtlConfig(config, manager)
    const frozenVersions = {
      mapResourceVersion: resourceVersionIdentity(plan.candidateResourceRefs.find((reference) => reference.packageType === "REGION")),
      sceneResourceVersion: snapshot.sceneResourceVersion,
      planVersion: snapshot.planVersion
    }
    return {
      ...plan,
      config: canonicalConfig,
      frozenVersions,
      checksum: assignmentSnapshotChecksum(draft, canonicalConfig, plan.candidateResourceRefs, frozenVersions)
    }
  }

  private requireProjectAccess(project: StudentProjectEntity, user: AuthUser): "TEACHER" | "STUDENT" {
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权查看该学生项目")
      return "STUDENT"
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return "TEACHER"
    throw new ForbiddenException("无权查看该学生项目")
  }

  private requireTeacher(user: AuthUser) {
    if (user.role !== "teacher" && user.role !== "admin") throw new ForbiddenException("仅教师可以管理 V3 任务")
  }

  private serializeDraft(draft: AssignmentDraftEntity): AssignmentDraftView {
    return {
      id: draft.id,
      title: draft.title,
      displayTitle: displayTeachingAssignmentTitle({ id: draft.id, title: draft.title, sceneType: draft.sceneType }),
      sceneType: draft.sceneType,
      mode: draft.mode,
      status: draft.status,
      isDemo: draft.isDemo,
      isAcceptanceData: draft.isAcceptanceData,
      config: draft.config,
      revision: draft.revision,
      configHash: draft.configHash,
      endedAt: draft.endedAt?.toISOString() ?? null,
      archivedAt: draft.archivedAt?.toISOString() ?? null,
      lifecycleReason: draft.lifecycleReason,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString()
    }
  }

  private serializeSnapshot(snapshot: AssignmentSnapshotEntity): AssignmentSnapshotView {
    return {
      id: snapshot.id,
      draftId: snapshot.draft.id,
      schemaVersion: 3,
      title: snapshot.title,
      displayTitle: displayTeachingAssignmentTitle({ id: snapshot.draft.id, title: snapshot.title, sceneType: snapshot.sceneType }),
      sceneType: snapshot.sceneType,
      mode: snapshot.mode,
      isDemo: snapshot.isDemo,
      isAcceptanceData: snapshot.isAcceptanceData,
      config: snapshot.config,
      resourceRefs: snapshot.resourceRefs,
      resourceRevision: snapshot.resourceRevision,
      mapResourceVersion: snapshot.mapResourceVersion,
      sceneResourceVersion: snapshot.sceneResourceVersion,
      planVersion: snapshot.planVersion,
      checksum: snapshot.checksum,
      publishedAt: snapshot.publishedAt.toISOString()
    }
  }
}

interface TeacherProgressEntities {
  projects: StudentProjectEntity[]
  evaluations: ProjectEvaluationEntity[]
  runtimeSessions: RuntimeSessionEntity[]
  showDocuments: ShowProjectDocumentEntity[]
  showClocks: ShowSimulationClockEntity[]
  showOperationalReports: ShowOperationalReportEntity[]
  routeDrafts: LogisticsRoutePlanDraftEntity[]
  routeVersions: LogisticsRoutePlanVersionEntity[]
  routeValidations: LogisticsRouteValidationRunEntity[]
  scheduleDrafts: LogisticsScheduleDraftEntity[]
  scheduleVersions: LogisticsScheduleVersionEntity[]
  vtlStages: StudentProjectStageEntity[]
}

function buildProgressMilestonesByProject(entities: TeacherProgressEntities): Map<string, V3TeacherProgressMilestone[]> {
  const documentsByProject = groupByProject(entities.showDocuments)
  const clockByProject = firstByProject(entities.showClocks)
  const runtimeByProject = firstByProjectId(entities.runtimeSessions)
  const routeDraftByProject = firstByProject(entities.routeDrafts)
  const routeVersionsByProject = groupByProject(entities.routeVersions)
  const validationByProject = firstByProject(entities.routeValidations)
  const scheduleDraftByProject = firstByProject(entities.scheduleDrafts)
  const scheduleVersionsByProject = groupByProject(entities.scheduleVersions)
  const vtlStagesByProject = groupByProject(entities.vtlStages)
  const evaluationByProject = new Map(entities.evaluations.map((evaluation) => [evaluation.projectId, evaluation]))
  return new Map(entities.projects.map((project) => {
    if (project.snapshot.sceneType === "CITY_SHOW") {
      return [project.id, buildTeacherProgressMilestones("CITY_SHOW", {
        documentStatuses: (documentsByProject.get(project.id) ?? []).map((document) => document.status),
        t60Submitted: clockByProject.get(project.id)?.submittedAt != null,
        runtimeStatus: runtimeByProject.get(project.id)?.status ?? null,
        flightEndStatus: entities.showOperationalReports.find((report) => (
          report.project.id === project.id && report.sessionId === runtimeByProject.get(project.id)?.id
        ))?.status ?? null
      })]
    }
    if (project.snapshot.sceneType === "CITY_LOGISTICS") return [project.id, buildTeacherProgressMilestones("CITY_LOGISTICS", {
      routeDraftExists: routeDraftByProject.has(project.id),
      routeSubmitted: (routeVersionsByProject.get(project.id) ?? []).some((version) => version.status === "SUBMITTED"),
      validationStatus: validationByProject.get(project.id)?.status ?? null,
      scheduleDraftExists: scheduleDraftByProject.has(project.id),
      scheduleSubmitted: (scheduleVersionsByProject.get(project.id) ?? []).some((version) => version.status === "SUBMITTED"),
      runtimeStatus: runtimeByProject.get(project.id)?.status ?? null,
      reviewSubmitted: evaluationByProject.get(project.id)?.studentSubmittedAt != null
    })]
    const vtlStageByCode = new Map((vtlStagesByProject.get(project.id) ?? []).map((stage) => [stage.stageCode, stage.status]))
    return [project.id, buildTeacherProgressMilestones("VTOL_INSPECTION", {
      allocationStatus: vtlStageByCode.get("VTL_TASK_ALLOCATION") ?? null,
      routeStatus: vtlStageByCode.get("VTL_ROUTE_PLANNING") ?? null,
      validationStatus: vtlStageByCode.get("VTL_PLAN_VALIDATION") ?? null,
      executionPlanStatus: vtlStageByCode.get("VTL_EXECUTION_PLAN") ?? null,
      runtimeStatus: runtimeByProject.get(project.id)?.status ?? null,
      reviewSubmitted: evaluationByProject.get(project.id)?.studentSubmittedAt != null
    })]
  }))
}

function matchesTeacherProgressFocus(
  item: V3TeacherProgressItem,
  focusState: "NOT_STARTED" | "PLANNING" | "CHECK_FAILED" | "RUNNING" | "SEVERE_ALERT" | "PENDING_EVALUATION"
): boolean {
  if (focusState === "NOT_STARTED") return item.submissionState === "NOT_STARTED"
  if (focusState === "PENDING_EVALUATION") return item.evaluationState === "PENDING"
  if (focusState === "SEVERE_ALERT") return item.alerts.some((alert) => alert.severity === "CRITICAL")
  if (focusState === "RUNNING") return item.milestones.some((milestone) => milestone.code.endsWith("RUNTIME") && milestone.state === "IN_PROGRESS")
  if (focusState === "CHECK_FAILED") return item.milestones.some((milestone) => milestone.code.includes("VALIDATION") && milestone.state === "ATTENTION")
  return item.milestones.some((milestone) => !milestone.code.endsWith("RUNTIME") && milestone.state === "IN_PROGRESS")
}

function groupByProject<T extends { project: { id: string } }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) grouped.set(item.project.id, [...(grouped.get(item.project.id) ?? []), item])
  return grouped
}

function firstByProject<T extends { project: { id: string } }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) if (!result.has(item.project.id)) result.set(item.project.id, item)
  return result
}

function groupRuntimeAlertsByProject(items: RuntimeAlertEntity[]): Map<string, RuntimeAlertEntity[]> {
  const grouped = new Map<string, RuntimeAlertEntity[]>()
  for (const item of items) grouped.set(item.projectId, [...(grouped.get(item.projectId) ?? []), item])
  return grouped
}

function serializeTeacherAlert(alert: RuntimeAlertEntity, followUp: TeacherAlertFollowUpEntity | null = null): V3RuntimeAlertView {
  return {
    id: alert.id,
    projectId: alert.projectId,
    sessionId: alert.sessionId,
    eventId: alert.eventId,
    stageCode: alert.stageCode,
    code: alert.code,
    title: alert.title,
    detail: alert.detail,
    severity: alert.severity,
    status: alert.status,
    simulationTimeMs: alert.simulationTimeMs === null ? null : Number(alert.simulationTimeMs),
    openedAt: alert.openedAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    payload: alert.payload,
    correlationId: alert.correlationId,
    teacherFollowUp: followUp
      ? {
          status: followUp.status,
          note: followUp.note,
          updatedAt: followUp.updatedAt.toISOString()
        }
      : null
  }
}

function firstByProjectId<T extends { projectId: string }>(items: T[]): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) if (!result.has(item.projectId)) result.set(item.projectId, item)
  return result
}

function normalizeTitle(value: string | undefined): string {
  const title = value?.trim()
  if (!title || title.length > 160) throw new BadRequestException("任务名称不能为空且不能超过 160 个字符")
  return title
}

function copiedTitle(value: string): string {
  const suffix = "（副本）"
  return `${value.slice(0, 160 - suffix.length)}${suffix}`
}

function normalizeLifecycleReason(value: string | undefined, required: boolean): string | null {
  const reason = value?.trim() ?? ""
  if (required && !reason) throw new BadRequestException("请填写操作原因")
  if (reason.length > 500) throw new BadRequestException("操作原因不能超过 500 个字符")
  return reason || null
}

function normalizeAssessmentRetakeSchedule(input: CreateAssessmentRetakeInput, config: AssignmentDraftConfig, now: Date): { availableAt: Date; dueAt: Date } {
  const availableAt = new Date(input.availableAt ? normalizeDate(input.availableAt, "补考开放时间") : now.toISOString())
  const defaultWindowMinutes = Math.max(config.assessmentDurationMinutes, 24 * 60)
  const configuredDueAt = input.dueAt ? new Date(normalizeDate(input.dueAt, "补考截止时间")) : null
  const originalDueAt = new Date(config.dueAt)
  const minimumDefaultDueAt = new Date(availableAt.getTime() + defaultWindowMinutes * 60_000)
  const dueAt = configuredDueAt ?? (originalDueAt.getTime() > minimumDefaultDueAt.getTime() ? originalDueAt : minimumDefaultDueAt)
  if (dueAt.getTime() <= availableAt.getTime()) throw new BadRequestException("补考截止时间必须晚于开放时间")
  if (dueAt.getTime() <= now.getTime()) throw new BadRequestException("补考截止时间必须晚于当前时间")
  return { availableAt, dueAt }
}

function serializeAssessmentAttempt(project: StudentProjectEntity) {
  return {
    attemptNumber: project.attemptNumber,
    isRetake: project.attemptNumber > 1,
    retakeOfProjectId: project.retakeOfProjectId,
    retakeReason: project.retakeReason,
    retakeCreatedAt: project.retakeCreatedAt?.toISOString() ?? null
  }
}

function normalizeSceneType(value: SceneType | undefined): SceneType {
  if (value !== "CITY_SHOW" && value !== "CITY_LOGISTICS" && value !== "VTOL_INSPECTION") throw new BadRequestException("任务场景无效")
  return value
}

function normalizeOptionalSceneType(value: string | undefined): SceneType | undefined {
  if (!value) return undefined
  return normalizeSceneType(value as SceneType)
}

function normalizeOptionalStageCode(value: string | undefined): V3StageCode | undefined {
  if (!value) return undefined
  if (!isV3StageCode(value)) throw new BadRequestException("阶段筛选无效")
  return value
}

function normalizeOptionalFilter<const T extends readonly string[]>(value: string | undefined, values: T, label: string): T[number] | undefined {
  if (!value) return undefined
  if (!values.includes(value)) throw new BadRequestException(`${label}筛选无效`)
  return value as T[number]
}

function normalizeMode(value: LearningMode | undefined): LearningMode {
  if (!value || !learningModes.includes(value)) throw new BadRequestException("新建任务必须选择训练模式或考核模式")
  return value
}

export function normalizeConfig(input: Partial<AssignmentDraftConfig> | undefined, sceneType: SceneType): AssignmentDraftConfig {
  const scaleTemplateCode = typeof input?.scaleTemplateCode === "string" ? input.scaleTemplateCode.trim() : ""
  const showProgramPackageId = typeof input?.showProgramPackageId === "string" && input.showProgramPackageId.trim() ? input.showProgramPackageId.trim() : null
  const questionBankVersionId = typeof input?.questionBankVersionId === "string" && input.questionBankVersionId.trim() ? input.questionBankVersionId.trim() : null
  const scenarioOverlayVersionId = typeof input?.scenarioOverlayVersionId === "string" && input.scenarioOverlayVersionId.trim() ? input.scenarioOverlayVersionId.trim() : null
  const regionPackageId = typeof input?.regionPackageId === "string" ? input.regionPackageId.trim() : ""
  const availableAt = normalizeDate(input?.availableAt, "开放时间")
  const dueAt = normalizeDate(input?.dueAt, "截止时间")
  if (!scaleTemplateCode || scaleTemplateCode.length > 80) throw new BadRequestException("固定规模模板代码无效")
  if (sceneType === "CITY_SHOW" && !isSupportedShowScaleTemplateCode(scaleTemplateCode)) throw new BadRequestException("V1.0 编队表演仅支持 100、500、1000、3000 架模板")
  if (!regionPackageId) throw new BadRequestException("必须选择预设区域包")
  if (Date.parse(availableAt) >= Date.parse(dueAt)) throw new BadRequestException("截止时间必须晚于开放时间")
  const taskBrief = normalizeTaskBrief(input?.taskBrief, true)
  const assessmentDurationMinutes = normalizeAssessmentDuration(input?.assessmentDurationMinutes)
  const allowedValidationAttempts = normalizeAttempt(input?.allowedValidationAttempts, "允许检查次数")
  const allowedRuntimeAttempts = normalizeAttempt(input?.allowedRuntimeAttempts, "允许运行次数")
  const resultVisibility = input?.resultVisibility
  if (resultVisibility !== "TOTAL_ONLY" && resultVisibility !== "DIMENSIONS" && resultVisibility !== "FULL_REVIEW") {
    throw new BadRequestException("结果可见范围无效")
  }
  if (input?.scenario !== undefined && !isPlainObject(input.scenario)) throw new BadRequestException("场景配置必须为 JSON 对象")
  const scenario = { ...(input?.scenario ?? {}) }
  const eventConfigs = normalizeScenarioEventConfigs(sceneType, scenario, scaleTemplateCode)
  Object.assign(scenario, {
    eventCodes: eventConfigs.map((item) => item.code),
    eventConfigs
  })
  if (sceneType === "CITY_SHOW") {
    scenario.showInitialConditions = normalizeShowInitialConditions(scenario, scaleTemplateCode)
  }
  if (sceneType === "CITY_LOGISTICS") {
    const normalized = logisticsOrderConfig(scaleTemplateCode, scenario, `ORDER-${randomUUID()}`)
    Object.assign(scenario, {
      orderCount: normalized.orderCount,
      orderReleaseMode: normalized.releaseMode,
      orderReleasePhase: normalized.releasePhase,
      priorityProfile: normalized.priorityProfile,
      deliveryDistributionMode: normalized.deliveryDistributionMode,
      timeWindowProfile: normalized.timeWindowProfile,
      timeWindowMinutes: normalized.timeWindowMinutes,
      orderSeed: normalized.seed,
      initialUnavailableAircraftCount: normalized.initialUnavailableAircraftCount,
      initialLowBatteryAircraftCount: normalized.initialLowBatteryAircraftCount,
      initialStandbyAircraftCount: normalized.initialFleet.standbyAircraftCount,
      initialPreflightAbnormalAircraftCount: normalized.initialFleet.preflightAbnormalAircraftCount,
      initialWindDirection: normalized.initialEnvironment.windDirection,
      initialWindForceState: normalized.initialEnvironment.windForceState,
      initialGustState: normalized.initialEnvironment.gustState,
      initialRainState: normalized.initialEnvironment.rainState,
      initialPositioningState: normalized.initialEnvironment.positioningState,
      initialCommunicationState: normalized.initialEnvironment.communicationState
    })
    const candidateDeliveryPointIds = normalizeCandidateDeliveryPointIds(scenario.candidateDeliveryPointIds)
    if (candidateDeliveryPointIds.length > 0) {
      const policy = logisticsTemplatePolicy(scaleTemplateCode)
      if (candidateDeliveryPointIds.length < policy.deliveryPointRange.minimum || candidateDeliveryPointIds.length > policy.deliveryPointRange.maximum) {
        throw new BadRequestException(`当前模板候选配送点须在 ${policy.deliveryPointRange.minimum} 到 ${policy.deliveryPointRange.maximum} 个之间`)
      }
      scenario.candidateDeliveryPointIds = candidateDeliveryPointIds
    } else {
      delete scenario.candidateDeliveryPointIds
    }
  }
  if (sceneType === "VTOL_INSPECTION") {
    Object.assign(scenario, normalizeVtlAssignmentParameters(input?.vtlParameters, { taskBrief, availableAt, dueAt }))
  }
  return {
    taskBrief,
    ...(sceneType === "CITY_SHOW" ? { showParameters: normalizeShowAssignmentParameters(input?.showParameters) } : {}),
    ...(sceneType === "CITY_LOGISTICS" ? {
      logisticsParameters: normalizeLogisticsAssignmentParameters(input?.logisticsParameters, { taskBrief, availableAt, dueAt })
    } : {}),
    ...(sceneType === "VTOL_INSPECTION" ? { vtlParameters: normalizeVtlAssignmentParameters(input?.vtlParameters, { taskBrief, availableAt, dueAt }) } : {}),
    scaleTemplateCode,
    ...(sceneType === "CITY_SHOW" ? { showProgramPackageId } : {}),
    ...(questionBankVersionId ? { questionBankVersionId } : {}),
    regionPackageId,
    ...(scenarioOverlayVersionId ? { scenarioOverlayVersionId } : {}),
    availableAt,
    dueAt,
    assessmentDurationMinutes,
    allowResubmission: input?.allowResubmission === true,
    allowedValidationAttempts,
    allowedRuntimeAttempts,
    resultVisibility,
    scenario
  }
}

function normalizeCandidateDeliveryPointIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new BadRequestException("候选配送点必须为数组")
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "")
  if (ids.some((id) => !id || id.length > 120)) throw new BadRequestException("候选配送点标识无效")
  if (new Set(ids).size !== ids.length) throw new BadRequestException("候选配送点不能重复")
  return ids
}

function countPreviewValues(values: readonly string[]): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>()
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1))
  return [...counts].map(([key, count]) => ({ key, count })).sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
}

function normalizeScenarioEventConfigs(sceneType: SceneType, scenario: Record<string, unknown>, scaleTemplateCode: string): V3ScenarioEventConfig[] {
  const validDefinition = sceneType === "CITY_SHOW"
    ? showEventDefinition
    : sceneType === "CITY_LOGISTICS"
      ? logisticsEventDefinition
      : vtlEventDefinition
  const showPolicy = sceneType === "CITY_SHOW" ? showTemplatePolicy(scaleTemplateCode) : null
  const logisticsPolicy = sceneType === "CITY_LOGISTICS" ? logisticsTemplatePolicy(scaleTemplateCode) : null
  const vtlPolicy = sceneType === "VTOL_INSPECTION" ? vtlTemplatePolicy(scaleTemplateCode) : null
  const source = Array.isArray(scenario.eventConfigs)
    ? scenario.eventConfigs
    : Array.isArray(scenario.eventCodes)
      ? scenario.eventCodes.map((code) => ({ code }))
      : []
  const seen = new Set<string>()
  const normalized = source.flatMap((value) => {
    const input = typeof value === "string" ? { code: value } : isPlainObject(value) ? value : null
    const code = typeof input?.code === "string" ? input.code.trim() : ""
    if (!code || seen.has(code) || !validDefinition(code)) return []
    seen.add(code)
    const defaultPhase = sceneType === "CITY_SHOW" ? "PERFORMANCE" : sceneType === "CITY_LOGISTICS" ? "OUTBOUND" : "VERTICAL_TAKEOFF"
    const triggerMode = input?.triggerMode === "SIMULATION_TIME" || input?.triggerMode === "PHASE" || input?.triggerMode === "TIME_RANGE" || input?.triggerMode === "CONDITION" || input?.triggerMode === "AFTER_EVENT" || input?.triggerMode === "AUTO"
      ? input.triggerMode as V3ScenarioEventConfig["triggerMode"]
      : sceneType === "CITY_SHOW" ? "PHASE" : "AUTO"
    const severity = input?.severity === null || input?.severity === undefined
      ? null
      : ["INFO", "WARNING", "ERROR", "CRITICAL"].includes(String(input.severity))
        ? input.severity as V3ScenarioEventConfig["severity"]
        : null
    const recoveryMode = input?.recoveryMode === "AUTO" || input?.recoveryMode === "CONDITION" || input?.recoveryMode === "UNTIL_END"
      ? input.recoveryMode as V3ScenarioEventConfig["recoveryMode"]
      : "STUDENT"
    const triggerWindowSeconds = normalizeScenarioWindow(input?.triggerWindowSeconds)
    const triggerCondition = normalizeScenarioCondition(input?.triggerCondition, "事件触发条件")
    const recoveryCondition = normalizeScenarioCondition(input?.recoveryCondition, "事件恢复条件")
    const impactScope = input && ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP", "MULTI_GROUP", "LOCAL_AREA", "MOST", "WHOLE", "SINGLE_ROUTE", "MULTI_ROUTE", "OVERALL"].includes(String(input.impactScope))
      ? input.impactScope as NonNullable<V3ScenarioEventConfig["impactScope"]>
      : "DEFAULT"
    const targetIds = Array.isArray(input?.targetIds)
      ? input.targetIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 500)
      : []
    const impactCount = optionalScenarioInteger(input?.impactCount, "事件影响数量", 1, 100_000)
    const visibilityMode = input?.visibilityMode === "DIRECT" || input?.visibilityMode === "PARTIAL_DELAY" || input?.visibilityMode === "AFTER_STATE_CHANGE"
      ? input.visibilityMode as NonNullable<V3ScenarioEventConfig["visibilityMode"]>
      : "AFTER_STATE_CHANGE"
    const triggerAfterEventCode = optionalScenarioCode(input?.triggerAfterEventCode)
    const followUpEventCode = optionalScenarioCode(input?.followUpEventCode)
    const eventSubtype = normalizeLogisticsEventSubtype(sceneType, code, input?.eventSubtype)
    return [{
      code,
      eventSubtype,
      triggerMode,
      triggerTimeSeconds: optionalScenarioSeconds(input?.triggerTimeSeconds, "事件触发时间", 0, 86_400),
      triggerPhase: typeof input?.triggerPhase === "string" && input.triggerPhase.trim() ? input.triggerPhase.trim() : defaultPhase,
      triggerOffsetSeconds: scenarioSeconds(input?.triggerOffsetSeconds, "事件阶段偏移", 0, 3_600),
      severity,
      detectionDelaySeconds: optionalScenarioSeconds(input?.detectionDelaySeconds, "事件发现延迟", 0, 3_600),
      escalationDelaySeconds: optionalScenarioSeconds(input?.escalationDelaySeconds, "事件升级延迟", 0, 86_400),
      durationSeconds: optionalScenarioSeconds(input?.durationSeconds, "事件持续时间", 1, 86_400),
      recoveryMode,
      triggerWindowSeconds,
      triggerCondition,
      triggerAfterEventCode,
      impactScope,
      impactCount,
      targetIds,
      visibilityMode,
      escalationEnabled: input?.escalationEnabled === undefined ? showPolicy?.escalationEnabled ?? logisticsPolicy?.escalationEnabled ?? vtlPolicy?.escalationEnabled ?? true : input.escalationEnabled !== false,
      followUpEventCode,
      recoveryCondition,
      actionDeadlineSeconds: optionalScenarioSeconds(input?.actionDeadlineSeconds, "事件处置时限", 1, 86_400)
    }]
  })
  canonicalizeScenarioEventLinks(normalized)
  const selectedCodes = new Set(normalized.map((item) => item.code))
  for (const config of normalized) {
    if (config.triggerMode === "TIME_RANGE" && !config.triggerWindowSeconds) throw new BadRequestException(`事件 ${config.code} 必须配置随机时间范围`)
    if (config.triggerMode === "CONDITION" && !config.triggerCondition) throw new BadRequestException(`事件 ${config.code} 必须配置触发条件`)
    if (config.triggerMode === "AFTER_EVENT" && (!config.triggerAfterEventCode || config.triggerAfterEventCode === config.code)) throw new BadRequestException(`事件 ${config.code} 必须引用其他前置事件`)
    if (config.triggerAfterEventCode && !selectedCodes.has(config.triggerAfterEventCode)) throw new BadRequestException(`事件 ${config.code} 的前置事件未启用`)
    if (config.followUpEventCode && !selectedCodes.has(config.followUpEventCode)) throw new BadRequestException(`事件 ${config.code} 的后续事件未启用`)
    if (config.recoveryMode === "CONDITION" && !config.recoveryCondition) throw new BadRequestException(`事件 ${config.code} 必须配置恢复条件`)
  }
  assertNoScenarioEventCycles(normalized)
  if (sceneType === "CITY_SHOW") assertShowEventTemplatePolicy(scaleTemplateCode, normalized)
  if (sceneType === "CITY_LOGISTICS") assertLogisticsEventTemplatePolicy(scaleTemplateCode, normalized)
  if (sceneType === "VTOL_INSPECTION") assertVtlEventTemplatePolicy(scaleTemplateCode, normalized)
  return normalized
}

function canonicalizeScenarioEventLinks(configs: V3ScenarioEventConfig[]): void {
  const byCode = new Map(configs.map((config) => [config.code, config]))
  for (const config of configs) {
    if (!config.followUpEventCode) continue
    const target = byCode.get(config.followUpEventCode)
    if (!target) continue
    if (target.triggerAfterEventCode && target.triggerAfterEventCode !== config.code) throw new BadRequestException(`事件 ${target.code} 不能关联多个前置事件`)
    target.triggerMode = "AFTER_EVENT"
    target.triggerAfterEventCode = config.code
  }
}

function assertShowEventTemplatePolicy(scaleTemplateCode: string, configs: V3ScenarioEventConfig[]): void {
  const policy = showTemplatePolicy(scaleTemplateCode)
  if (configs.length < policy.eventCountRange.minimum || configs.length > policy.eventCountRange.maximum) {
    throw new BadRequestException(`当前表演模板须配置 ${policy.eventCountRange.minimum} 到 ${policy.eventCountRange.maximum} 个事件`)
  }
  for (const config of configs) {
    const definition = showEventDefinition(config.code)
    if (!policy.allowedTriggerModes.includes(config.triggerMode)) throw new BadRequestException(`当前表演模板未开放事件 ${config.code} 的触发方式`)
    const scope = config.impactScope ?? "DEFAULT"
    const wholeWeather = scope === "WHOLE" && definition?.category === "WEATHER"
    if (!wholeWeather && !policy.allowedImpactScopes.includes(scope)) throw new BadRequestException(`当前表演模板未开放事件 ${config.code} 的影响范围`)
    if (config.impactCount !== null && config.impactCount !== undefined) {
      const maximumImpactCount = showMaximumEventImpactCount(policy.totalAircraft, scope)
      if (config.impactCount > maximumImpactCount) throw new BadRequestException(`事件 ${config.code} 的影响数量不能超过 ${maximumImpactCount}`)
    }
    if (!policy.escalationEnabled && config.escalationEnabled !== false) throw new BadRequestException(`当前表演模板未开放事件 ${config.code} 升级`)
    if (!policy.eventLinksEnabled && (config.triggerAfterEventCode || config.followUpEventCode)) throw new BadRequestException(`当前表演模板未开放事件关联`)
    if (!policy.partialVisibilityEnabled && config.visibilityMode === "PARTIAL_DELAY") throw new BadRequestException("当前表演模板未开放部分信息延迟")
  }
  assertMaximumShowEventChainDepth(configs, policy.maximumEventChainDepth)
}

function assertLogisticsEventTemplatePolicy(scaleTemplateCode: string, configs: V3ScenarioEventConfig[]): void {
  const policy = logisticsTemplatePolicy(scaleTemplateCode)
  if (configs.length < policy.eventCountRange.minimum || configs.length > policy.eventCountRange.maximum) {
    throw new BadRequestException(`当前物流模板须配置 ${policy.eventCountRange.minimum} 到 ${policy.eventCountRange.maximum} 个事件`)
  }
  for (const config of configs) {
    if (!policy.allowedEventCodes.includes(config.code)) throw new BadRequestException(`当前物流模板未开放事件 ${config.code}`)
    if (config.eventSubtype && !policy.allowedEventSubtypes.includes(config.eventSubtype)) throw new BadRequestException(`当前物流模板未开放事件子类型 ${config.eventSubtype}`)
    if (!policy.allowedTriggerModes.includes(config.triggerMode)) throw new BadRequestException(`当前物流模板未开放事件 ${config.code} 的触发方式`)
    const scope = config.impactScope ?? "DEFAULT"
    if (!policy.allowedImpactScopes.includes(scope)) throw new BadRequestException(`当前物流模板未开放事件 ${config.code} 的影响范围`)
    if (config.impactCount !== null && config.impactCount !== undefined) {
      const maximumImpactCount = logisticsMaximumEventImpactCount(policy.totalAircraft, scope)
      if (config.impactCount > maximumImpactCount) throw new BadRequestException(`事件 ${config.code} 的影响数量不能超过 ${maximumImpactCount}`)
    }
    if (!policy.escalationEnabled && config.escalationEnabled !== false) throw new BadRequestException(`当前物流模板未开放事件 ${config.code} 升级`)
    if (!policy.eventLinksEnabled && (config.triggerAfterEventCode || config.followUpEventCode)) throw new BadRequestException("当前物流模板未开放事件关联")
    if (!policy.partialVisibilityEnabled && config.visibilityMode === "PARTIAL_DELAY") throw new BadRequestException("当前物流模板未开放部分信息延迟")
  }
}

function assertVtlEventTemplatePolicy(scaleTemplateCode: string, configs: V3ScenarioEventConfig[]): void {
  const policy = vtlTemplatePolicy(scaleTemplateCode)
  if (configs.length < policy.eventCountRange.minimum || configs.length > policy.eventCountRange.maximum) {
    throw new BadRequestException(`当前垂起巡检模板须配置 ${policy.eventCountRange.minimum} 到 ${policy.eventCountRange.maximum} 个事件`)
  }
  for (const config of configs) {
    if (!policy.allowedEventCodes.includes(config.code as never)) throw new BadRequestException(`当前垂起巡检模板未开放事件 ${config.code}`)
    if (!policy.allowedTriggerModes.includes(config.triggerMode)) throw new BadRequestException(`当前垂起巡检模板未开放事件 ${config.code} 的触发方式`)
    const scope = config.impactScope ?? "DEFAULT"
    if (!policy.allowedImpactScopes.includes(scope)) throw new BadRequestException(`当前垂起巡检模板未开放事件 ${config.code} 的影响范围`)
    if (!policy.escalationEnabled && config.escalationEnabled !== false) throw new BadRequestException(`当前垂起巡检模板未开放事件 ${config.code} 升级`)
    if (!policy.eventLinksEnabled && (config.triggerAfterEventCode || config.followUpEventCode)) throw new BadRequestException("当前垂起巡检模板未开放事件关联")
    if (!policy.partialVisibilityEnabled && config.visibilityMode === "PARTIAL_DELAY") throw new BadRequestException("当前垂起巡检模板未开放部分信息延迟")
  }
}

function normalizeLogisticsEventSubtype(sceneType: SceneType, eventCode: string, value: unknown): LogisticsScenarioEventSubtype | null {
  if (sceneType !== "CITY_LOGISTICS") return null
  const fallback = defaultLogisticsEventSubtype(eventCode)
  if (value === undefined || value === null || value === "") return fallback
  if (!isLogisticsEventSubtypeAllowed(eventCode, value)) throw new BadRequestException(`事件 ${eventCode} 的细分类型无效`)
  return value
}

function logisticsMaximumEventImpactCount(totalAircraft: number, scope: NonNullable<V3ScenarioEventConfig["impactScope"]>): number {
  if (scope === "SINGLE" || scope === "SINGLE_ROUTE") return 1
  if (scope === "SMALL_BATCH") return Math.min(5, Math.max(2, Math.ceil(totalAircraft * 0.2)))
  if (scope === "GROUP") return Math.max(2, Math.ceil(totalAircraft * 0.25))
  if (scope === "MULTI_ROUTE") return 3
  if (scope === "OVERALL") return totalAircraft
  return Math.max(1, Math.ceil(totalAircraft * 0.4))
}

function assertMaximumShowEventChainDepth(configs: V3ScenarioEventConfig[], maximumDepth: number): void {
  const links = new Map<string, string>()
  for (const config of configs) {
    if (config.followUpEventCode) links.set(config.code, config.followUpEventCode)
    if (config.triggerAfterEventCode) links.set(config.triggerAfterEventCode, config.code)
  }
  for (const code of links.keys()) {
    let depth = 0
    let cursor: string | undefined = code
    const visited = new Set<string>()
    while (cursor && links.has(cursor)) {
      if (visited.has(cursor)) throw new BadRequestException("事件关联关系不能形成循环")
      visited.add(cursor)
      cursor = links.get(cursor)
      depth += 1
    }
    if (depth > maximumDepth) throw new BadRequestException(`当前表演模板最多支持 ${maximumDepth} 级事件关联`)
  }
}

function scenarioSeconds(value: unknown, label: string, minimum: number, maximum: number): number {
  const number = Number(value ?? 0)
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new BadRequestException(`${label}必须在 ${minimum} 到 ${maximum} 秒之间`)
  return number
}

function optionalScenarioSeconds(value: unknown, label: string, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === "") return null
  return scenarioSeconds(value, label, minimum, maximum)
}

function normalizeScenarioWindow(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const start = scenarioSeconds(value[0], "事件随机窗口起点", 0, 86_400)
  const end = scenarioSeconds(value[1], "事件随机窗口终点", 0, 86_400)
  if (start > end) throw new BadRequestException("事件随机时间范围的起点不能晚于终点")
  return [start, end]
}

function normalizeScenarioCondition(value: unknown, label: string): V3ScenarioEventCondition | null {
  if (value === null || value === undefined || value === "") return null
  if (!isPlainObject(value)) throw new BadRequestException(`${label}必须为对象`)
  const type = ["PHASE", "SIMULATION_TIME", "MIN_AIRBORNE_AIRCRAFT", "MIN_ACTIVE_ORDERS", "ROUTE_STATUS", "EVENT_STATUS"].includes(String(value.type))
    ? value.type as V3ScenarioEventCondition["type"]
    : null
  const operator = ["EQ", "GTE", "LTE"].includes(String(value.operator))
    ? value.operator as V3ScenarioEventCondition["operator"]
    : "EQ"
  if (!type) throw new BadRequestException(`${label}类型无效`)
  const rawValue = value.value
  const conditionValue = type === "PHASE" || type === "ROUTE_STATUS" || type === "EVENT_STATUS"
    ? typeof rawValue === "string" && rawValue.trim() ? rawValue.trim() : null
    : optionalScenarioInteger(rawValue, label, 0, 100_000)
  if (conditionValue === null) throw new BadRequestException(`${label}值无效`)
  const targetId = typeof value.targetId === "string" && value.targetId.trim() ? value.targetId.trim() : null
  return { type, operator, value: conditionValue, targetId }
}

function optionalScenarioInteger(value: unknown, label: string, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined || value === "") return null
  return scenarioSeconds(value, label, minimum, maximum)
}

function optionalScenarioCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function assertNoScenarioEventCycles(configs: V3ScenarioEventConfig[]): void {
  const dependencies = new Map(configs.map((config) => [config.code, config.triggerAfterEventCode]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (code: string): void => {
    if (visiting.has(code)) throw new BadRequestException("事件前置触发关系不能形成循环")
    if (visited.has(code)) return
    visiting.add(code)
    const dependency = dependencies.get(code)
    if (dependency) visit(dependency)
    visiting.delete(code)
    visited.add(code)
  }
  for (const config of configs) visit(config.code)
}

function normalizeTaskBrief(value: string | undefined, required = false): string {
  const taskBrief = value?.trim() ?? ""
  if (required && !taskBrief) throw new BadRequestException("表演任务说明不能为空")
  if (taskBrief.length > 2000) throw new BadRequestException("任务说明不能超过 2000 个字符")
  return taskBrief
}

function normalizeDate(value: string | undefined, label: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new BadRequestException(`${label}无效`)
  return new Date(value).toISOString()
}

function normalizeAttempt(value: number | undefined, label: string): number {
  const attempt = Number(value)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) throw new BadRequestException(`${label}必须在 1 到 100 之间`)
  return attempt
}

function normalizeAssessmentDuration(value: number | undefined): number {
  const minutes = value === undefined ? 120 : Number(value)
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) throw new BadRequestException("考核时长必须在 1 到 1440 分钟之间")
  return minutes
}

function normalizePositiveInteger(value: number | undefined, label: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new BadRequestException(`${label} 必须为正整数`)
  return number
}

function normalizeIds(value: string[] | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) throw new BadRequestException(`${label} 必须包含 1 到 30 个 ID`)
  const ids = value.map((id) => id?.trim()).filter(Boolean)
  if (ids.length !== value.length) throw new BadRequestException(`${label} 包含空 ID`)
  return ids
}

export function summarizeAssignmentPreflight(checks: readonly AssignmentPreflightCheckView[]) {
  return checks.reduce((result, check) => {
    if (check.level === "BLOCKING") result.blocking += 1
    else if (check.level === "WARNING") result.warning += 1
    else result.passed += 1
    return result
  }, { blocking: 0, warning: 0, passed: 0 })
}

export async function assertQuestionBankVersionReady(
  manager: EntityManager,
  versionId: string,
  sceneType: SceneType,
  user?: AuthUser
): Promise<QuestionBankVersionEntity> {
  const version = await manager.findOne(QuestionBankVersionEntity, { where: { id: versionId } })
  if (!version) throw new NotFoundException("题库版本不存在")
  if (user && user.role !== "admin" && version.bank.createdBy.id !== user.id) throw new ForbiddenException("无权使用该题库版本")
  if (version.status !== "PUBLISHED") throw new BadRequestException("只能绑定已发布的题库版本")
  if (version.bank.sceneType && version.bank.sceneType !== sceneType) throw new BadRequestException("题库场景与任务场景不一致")
  normalizeQuestionDefinitions(version.questions, true)
  return version
}

function normalizeTargets(value: AssignmentTargetInput[] | undefined): AssignmentTargetInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new BadRequestException("发布目标必须包含 1 到 100 项")
  return value.map((target) => {
    if ((target.type !== "CLASS" && target.type !== "STUDENT") || !target.targetId?.trim()) throw new BadRequestException("发布目标无效")
    return { type: target.type, targetId: target.targetId.trim() }
  })
}

export function validateRequiredResourceTypes(sceneType: SceneType, config: AssignmentDraftConfig, refs: V3ResourceReference[]) {
  const required: ResourcePackageType[] = sceneType === "CITY_SHOW"
    ? ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "DOCUMENT_TEMPLATE", "REPORT"]
    : ["RULE", "REGION", "SCALE_TEMPLATE", "AIRCRAFT", "EVENT", "REPORT"]
  const types = new Set(refs.map((ref) => ref.packageType))
  const missing = required.filter((type) => !types.has(type))
  if (missing.length > 0) throw new BadRequestException(`缺少必需资源包：${missing.join("、")}`)
  if (sceneType === "CITY_SHOW" && refs.filter((ref) => ref.packageType === "DOCUMENT_TEMPLATE").length !== 1) {
    throw new BadRequestException("City show assignments must reference exactly one formal application document package")
  }
  if (refs.filter((ref) => ref.packageType === "REPORT").length !== 1) {
    throw new BadRequestException("任务必须且只能引用一个评价报告资源包")
  }
  const showProgramRefs = refs.filter((ref) => ref.packageType === "SHOW_PROGRAM")
  if (sceneType === "CITY_SHOW" && config.showProgramPackageId && (showProgramRefs.length !== 1 || showProgramRefs[0]!.packageId !== config.showProgramPackageId)) {
    throw new BadRequestException("任务选择的舞步程序未包含在发布资源中")
  }
  if ((!config.showProgramPackageId || sceneType !== "CITY_SHOW") && showProgramRefs.length > 0) {
    throw new BadRequestException("当前任务不能引用舞步程序资源")
  }
  const region = refs.find((ref) => ref.packageType === "REGION" && ref.packageId === config.regionPackageId)
  if (!region) throw new BadRequestException("任务配置的区域包未包含在发布资源中")
  if (refs.some((ref) => !resourcePackageTypes.includes(ref.packageType))) throw new BadRequestException("资源包类型无效")
}

export function normalizeAssignmentDataClassification(
  input: { isDemo?: unknown; isAcceptanceData?: unknown },
  current: Pick<AssignmentDraftEntity, "isDemo" | "isAcceptanceData"> = { isDemo: false, isAcceptanceData: false }
): { isDemo: boolean; isAcceptanceData: boolean } {
  const isDemo = normalizeOptionalBoolean(input.isDemo, "isDemo") ?? current.isDemo ?? false
  const isAcceptanceData = normalizeOptionalBoolean(input.isAcceptanceData, "isAcceptanceData") ?? current.isAcceptanceData ?? false
  if (isDemo && isAcceptanceData) throw new BadRequestException("任务不能同时标记为演示数据和验收数据")
  return { isDemo, isAcceptanceData }
}

export function assertFormalAssignmentTitle(
  title: string,
  classification: Pick<AssignmentDraftEntity, "isDemo" | "isAcceptanceData">
): void {
  if (classification.isDemo || classification.isAcceptanceData) return
  if (!/(?:^|[^A-Z0-9])(P[0-9]+|R[0-9]+|STU-[0-9]+|TEA-[0-9]+|APP-[0-9]+|ROU-[0-9]+|ORD-[0-9]+|RPT-[0-9]+|SCN-[0-9]+)(?:[^A-Z0-9]|$)/i.test(title)) return
  throw new BadRequestException("正式任务标题不能包含内部测试编号，请标记为验收数据后再保存")
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new BadRequestException(`${field}必须是布尔值`)
  return value
}

function assignmentConfigHash(draft: AssignmentDraftEntity, refs: V3ResourceReference[], targets: ResolvedTarget[]): string {
  return sha256Canonical({
    schemaVersion: 3,
    draftId: draft.id,
    revision: draft.revision,
    title: draft.title,
    sceneType: draft.sceneType,
    mode: draft.mode,
    isDemo: draft.isDemo,
    isAcceptanceData: draft.isAcceptanceData,
    config: draft.config,
    resourceRefs: refs,
    targets: targets.map(({ type, targetId }) => ({ type, targetId }))
  })
}

function assignmentSnapshotChecksum(
  draft: Pick<AssignmentDraftEntity, "id" | "title" | "sceneType" | "mode" | "isDemo" | "isAcceptanceData">,
  config: AssignmentDraftConfig,
  resourceRefs: V3ResourceReference[],
  frozenVersions?: Pick<AssignmentSnapshotEntity, "mapResourceVersion" | "sceneResourceVersion" | "planVersion">
): string {
  return sha256Canonical({
    schemaVersion: 3,
    draftId: draft.id,
    title: draft.title,
    sceneType: draft.sceneType,
    mode: draft.mode,
    isDemo: draft.isDemo,
    isAcceptanceData: draft.isAcceptanceData,
    config,
    resourceRefs,
    ...(frozenVersions ? { frozenVersions } : {})
  })
}

type PublishedOverlayIdentity = { id: string; versionNo: number; checksum: string } | null

export function freezeAssignmentResourceVersions(
  resourceRefs: readonly V3ResourceReference[],
  overlay: PublishedOverlayIdentity,
  planVersion: string
): Pick<AssignmentSnapshotEntity, "mapResourceVersion" | "sceneResourceVersion" | "planVersion"> {
  const region = resourceRefs.find((reference) => reference.packageType === "REGION")
  return {
    mapResourceVersion: resourceVersionIdentity(region),
    sceneResourceVersion: overlay ? `SCENARIO_OVERLAY:${overlay.id}@${overlay.versionNo}#${overlay.checksum}` : "UNRESOLVED",
    planVersion: planVersion.trim() || "UNRESOLVED"
  }
}

function ineligibleUpgradePreview(
  draft: AssignmentDraftEntity,
  snapshot: AssignmentSnapshotEntity,
  projectCount: number,
  startedProjectCount: number,
  reason: string
): AssignmentUpgradePreviewView {
  return {
    assignmentId: draft.id,
    eligible: false,
    reason,
    expectedRevision: draft.revision,
    snapshotId: snapshot.id,
    snapshotChecksum: snapshot.checksum,
    projectCount,
    startedProjectCount,
    currentResourceRefs: snapshot.resourceRefs,
    candidateResourceRefs: null,
    candidateConfig: null,
    candidateSnapshotChecksum: null,
    changes: []
  }
}

function stageOpenCondition(stageCode: V3StageCode, definitions: ReturnType<typeof stageDefinitionsFor>): string {
  const definition = definitions.find((item) => item.code === stageCode)
  if (!definition || definition.prerequisiteCodes.length === 0) return "任务发布后开放"
  const prerequisiteTitles = definition.prerequisiteCodes.map((code) => definitions.find((item) => item.code === code)?.title ?? code)
  return `完成并通过${prerequisiteTitles.join("、")}后开放`
}

function stageDefinitionsForConfig(sceneType: SceneType, config: AssignmentDraftConfig) {
  return stageDefinitionsFor(sceneType, sceneType === "VTOL_INSPECTION" ? config.vtlParameters?.openStageCodes : undefined)
}

function preflightStepAction(step: AssignmentPreflightCheckView["step"]): string {
  return `返回第 ${step + 1} 步处理`
}

type AssignmentPreflightLocation = {
  step: AssignmentPreflightCheckView["step"]
  focusTarget: NonNullable<AssignmentPreflightCheckView["focusTarget"]>
}

export function assignmentPreflightLocation(
  code: string,
  sceneType: SceneType,
  message: string,
  fallbackStep: AssignmentPreflightCheckView["step"]
): AssignmentPreflightLocation {
  if (code === "CONFIGURATION" && /开放时间|截止时间/.test(message)) {
    return { step: 3, focusTarget: "publish-schedule" }
  }
  const fixed = ({
    CONFIGURATION: { step: 0, focusTarget: "task-title" },
    QUESTION_BANK: { step: 1, focusTarget: "question-bank" },
    RESOURCE_AVAILABILITY: { step: 1, focusTarget: "resource-dependencies" },
    RESOURCE_COVERAGE: { step: 1, focusTarget: "resource-dependencies" },
    SCALE_TEMPLATE: { step: 1, focusTarget: "scale-template" },
    EVALUATION_RUBRIC: { step: 1, focusTarget: "resource-dependencies" },
    SHOW_PROGRAM: { step: 1, focusTarget: "show-program" },
    REGION_SCOPE: { step: 1, focusTarget: "region" },
    MAP_RESOURCE: { step: 1, focusTarget: "map-resource" },
    PUBLISH_SCOPE: { step: 3, focusTarget: "publish-classroom" }
  } as const)[code]
  if (fixed) return fixed

  if (code !== "SCENARIO_RULES") return { step: fallbackStep, focusTarget: "scenario-events" }
  if (sceneType === "CITY_LOGISTICS") {
    if (/候选配送点|配送点不属于/.test(message)) return { step: 1, focusTarget: "logistics-candidate-points" }
    if (/计划运行|开始时间|结束时间/.test(message)) return { step: 2, focusTarget: "logistics-runtime-schedule" }
    if (/订单|机队|航空器/.test(message)) return { step: 2, focusTarget: "logistics-order-config" }
  }
  if (sceneType === "VTOL_INSPECTION") {
    if (/任务对象/.test(message)) return { step: 2, focusTarget: "vtl-task-objects" }
    if (/任务区域|未完全位于/.test(message)) return { step: 2, focusTarget: "vtl-task-area" }
    if (/主起降点/.test(message)) return { step: 2, focusTarget: "vtl-main-landing-site" }
    if (/开放步骤/.test(message)) return { step: 2, focusTarget: "vtl-open-stages" }
    if (/评价项目/.test(message)) return { step: 2, focusTarget: "vtl-evaluation-items" }
    if (/计划.*时间|开始时间|结束时间/.test(message)) return { step: 2, focusTarget: "vtl-runtime-schedule" }
  }
  if (sceneType === "CITY_SHOW" && /计划表演|开始时间|结束时间/.test(message)) {
    return { step: 2, focusTarget: "show-schedule" }
  }
  return { step: fallbackStep, focusTarget: "scenario-events" }
}

function preflightFocusAction(
  focusTarget: AssignmentPreflightCheckView["focusTarget"],
  step: AssignmentPreflightCheckView["step"]
): string {
  const label = focusTarget ? ({
    "task-title": "任务名称",
    "question-bank": "作答题库",
    "scale-template": "固定规模模板",
    region: "预设区域",
    "show-program": "表演程序",
    "resource-dependencies": "发布资源依赖",
    "map-resource": "地图资源诊断",
    "show-schedule": "表演计划时段",
    "logistics-candidate-points": "候选配送点",
    "logistics-runtime-schedule": "物流运行时段",
    "logistics-order-config": "订单与机队条件",
    "vtl-runtime-schedule": "巡检运行时段",
    "vtl-main-landing-site": "主起降点",
    "vtl-task-objects": "巡检任务对象",
    "vtl-task-area": "巡检任务区域",
    "vtl-open-stages": "开放步骤",
    "vtl-evaluation-items": "评价项目与分值",
    "scenario-events": "事件配置",
    "publish-classroom": "发布班级",
    "publish-schedule": "开放与截止时间"
  } as const)[focusTarget] : undefined
  return label ? `返回第 ${step + 1} 步定位“${label}”` : preflightStepAction(step)
}

function preflightMapResourceLabel(kind: V3ResourceReference["packageType"] | "TERRAIN" | "IMAGERY" | "ELEVATION_SNAPSHOT"): string {
  return ({ TERRAIN: "DEM", IMAGERY: "影像", ELEVATION_SNAPSHOT: "高程快照" } as Record<string, string>)[kind] ?? String(kind)
}

function preflightErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return "检查未完成，请重试或联系管理员"
}

function normalizePreflightConfirmation(
  value: PublishAssignmentInput["preflightConfirmation"],
  requiredCodes: string[]
): { checkedAt: string; checkCodes: string[] } {
  const checkedAtMs = typeof value?.checkedAt === "string" ? Date.parse(value.checkedAt) : Number.NaN
  const now = Date.now()
  if (!Number.isFinite(checkedAtMs) || checkedAtMs > now + 60_000 || now - checkedAtMs > 10 * 60_000) {
    throw new ConflictException("发布前检查已过期，请重新生成预览")
  }
  const checkCodes = Array.isArray(value?.checkCodes)
    ? [...new Set(value.checkCodes.filter((code): code is string => typeof code === "string" && code.trim().length > 0).map((code) => code.trim()))]
    : []
  if (requiredCodes.some((code) => !checkCodes.includes(code))) throw new ConflictException("请确认发布前检查中的建议项")
  return { checkedAt: new Date(checkedAtMs).toISOString(), checkCodes }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
