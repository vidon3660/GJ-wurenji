import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { createHash, randomUUID } from "node:crypto"
import { DataSource, EntityManager, In, Repository } from "typeorm"
import type {
  AuthUser,
  ShowObjectiveMetricView,
  ShowProjectReportView,
  ShowReplayTimelineItemKind,
  ShowReplayTimelineItemView,
  ShowReviewCohortAnalyticsView,
  ShowReviewWorkspaceView,
  ShowTeacherScoreView,
  V3LogisticsReviewAnalysisView,
  V3LogisticsStudentReviewSummaryView,
  V3LogisticsReviewReplayFrameView,
  V3ReviewReplayView,
  LogisticsRuntimeEventView,
  V3RuntimeAlertView,
  V3AlertSeverity,
  V3ProjectEvaluationView,
  V3RuntimeActionReasoning
} from "@wurenji/shared"
import { logisticsEventSubtypeLabel } from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { canonicalJson } from "../common/canonical-json.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { V3FileStorageService } from "../files/file-storage.service.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { LogisticsRouteValidationRunEntity, LogisticsRoutePlanVersionEntity } from "../logistics-route/logistics-route.entities.js"
import { LogisticsDynamicScheduleVersionEntity, LogisticsRuntimeSnapshotEntity } from "../logistics-runtime/logistics-runtime.entities.js"
import { LogisticsRuntimeDataService } from "../logistics-runtime/logistics-runtime.data.js"
import { LogisticsScheduleVersionEntity } from "../logistics-scheduling/logistics-scheduling.entities.js"
import {
  normalizeFrozenTeacherScores as normalizeTeacherScores,
  teacherEvaluationContentBlockedReason,
  totalFrozenTeacherScore as totalTeacherScore
} from "../resources/evaluation-rubric.js"
import { ResourcePackageService } from "../resources/resource-package.service.js"
import { createShowReportDocx, createShowReportPdf, type ShowReportRenderData } from "../show-review/show-report.renderer.js"
import { ShowProjectReportEntity, ShowReviewAnnotationEntity } from "../show-review/show-review.entities.js"
import { applyReviewVisibility, canAccessFullReviewReport } from "../show-review/review-visibility.js"
import { runtimeActionReasoningFromPayload } from "../runtime/runtime-action-reasoning.js"
import { buildRuntimeEvidence } from "../runtime/runtime-evidence.js"
import { computeLogisticsReviewAnalysis, isOnTimeArrival, logisticsOnTimeRate } from "./logistics-review-analysis.js"
import { logisticsStudentSummaryText, normalizeLogisticsStudentSummary, parseLogisticsStudentSummary } from "./logistics-review-summary.js"
import { serializeLogisticsReviewSnapshotFields } from "./logistics-review-contract.js"
import { assessmentTimingForProject } from "../assessment/assessment-window.service.js"

const reportDeclaration = "本文件及系统生成的物流区域、航线方案、订单调度、运行记录和项目报告均为城市低空物流教学仿真材料，不作为真实空域运行许可、物流运营批准、飞行安全结论或无人机执行指令。"

interface LogisticsReviewSources {
  project: StudentProjectEntity
  session: RuntimeSessionEntity | null
  events: RuntimeEventEntity[]
  alerts: RuntimeAlertEntity[]
  actions: StudentRuntimeActionEntity[]
  snapshots: LogisticsRuntimeSnapshotEntity[]
  activities: ProjectActivityEventEntity[]
  routeVersion: LogisticsRoutePlanVersionEntity | null
  validation: LogisticsRouteValidationRunEntity | null
  schedule: LogisticsScheduleVersionEntity | null
  scheduleItems: ReturnType<LogisticsRuntimeDataService["computedItems"]>
  dynamicScheduleVersions: LogisticsDynamicScheduleVersionEntity[]
}

@Injectable()
export class LogisticsReviewService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ProjectEvaluationEntity) private readonly evaluations: Repository<ProjectEvaluationEntity>,
    @InjectRepository(RuntimeSessionEntity) private readonly sessions: Repository<RuntimeSessionEntity>,
    @InjectRepository(RuntimeEventEntity) private readonly events: Repository<RuntimeEventEntity>,
    @InjectRepository(RuntimeAlertEntity) private readonly alerts: Repository<RuntimeAlertEntity>,
    @InjectRepository(StudentRuntimeActionEntity) private readonly actions: Repository<StudentRuntimeActionEntity>,
    @InjectRepository(LogisticsRuntimeSnapshotEntity) private readonly snapshots: Repository<LogisticsRuntimeSnapshotEntity>,
    @InjectRepository(LogisticsDynamicScheduleVersionEntity) private readonly dynamicScheduleVersions: Repository<LogisticsDynamicScheduleVersionEntity>,
    @InjectRepository(ProjectActivityEventEntity) private readonly activityEvents: Repository<ProjectActivityEventEntity>,
    @InjectRepository(LogisticsRoutePlanVersionEntity) private readonly routeVersions: Repository<LogisticsRoutePlanVersionEntity>,
    @InjectRepository(LogisticsRouteValidationRunEntity) private readonly validations: Repository<LogisticsRouteValidationRunEntity>,
    @InjectRepository(LogisticsScheduleVersionEntity) private readonly schedules: Repository<LogisticsScheduleVersionEntity>,
    @InjectRepository(ShowReviewAnnotationEntity) private readonly annotations: Repository<ShowReviewAnnotationEntity>,
    @InjectRepository(ShowProjectReportEntity) private readonly reports: Repository<ShowProjectReportEntity>,
    @InjectRepository(FileAssetEntity) private readonly assets: Repository<FileAssetEntity>,
    private readonly storage: V3FileStorageService,
    private readonly activityLog: ActivityLogService,
    private readonly runtimeData: LogisticsRuntimeDataService,
    private readonly resourcePackages: ResourcePackageService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<ShowReviewWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const sources = await this.loadSources(projectId)
    const evaluation = await this.ensureEvaluation(project, computeObjectiveMetrics(sources))
    const [report, stage, annotations, cohortAnalytics] = await Promise.all([
      this.reports.findOne({ where: { project: { id: projectId } } }),
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "LOGISTICS_REVIEW" } }),
      this.annotations.find({ where: { project: { id: projectId } }, order: { createdAt: "ASC" } }),
      actor === "TEACHER" ? this.cohortAnalytics(project.snapshot.draft.id) : Promise.resolve(null)
    ])
    const canReview = actor === "TEACHER" && Boolean(stage && stage.status === "SUBMITTED" && evaluation.status !== "PUBLISHED")
    const assessmentWritable = assessmentTimingForProject(project).canWrite
    const publishBlockedReason = logisticsReviewPublishBlockedReason(actor, stage?.status ?? null, evaluation.status, evaluation.teacherScores as unknown as ShowTeacherScoreView[], evaluation.summary)
    const timeline = buildTimeline(sources)
    const replay = buildLogisticsReplay(sources)
    const logisticsAnalysis = computeLogisticsReviewAnalysis(sources)
    const annotationViews = annotations.map(serializeAnnotation)
    const visible = applyReviewVisibility({
      actor,
      mode: project.snapshot.mode,
      configuredVisibility: project.snapshot.config.resultVisibility,
      evaluation: serializeEvaluation(evaluation),
      timeline,
      annotations: annotationViews,
      report: report ? serializeReport(report, projectId) : null
    })
    return {
      projectId,
      ...serializeLogisticsReviewSnapshotFields(project.snapshot),
      actor,
      resultVisibility: visible.resultVisibility,
      canAccessReport: visible.canAccessReport,
      canEditSummary: actor === "STUDENT" && assessmentWritable && stage?.status === "IN_PROGRESS" && evaluation.status !== "PUBLISHED" && !evaluation.studentSubmittedAt,
      canSubmitSummary: actor === "STUDENT" && assessmentWritable && stage?.status === "IN_PROGRESS" && evaluation.status !== "PUBLISHED" && !evaluation.studentSubmittedAt,
      canReview,
      canPublish: publishBlockedReason === null,
      publishBlockedReason,
      timeline: visible.timeline,
      replay: visible.canAccessReport ? replay : null,
      logisticsAnalysis: visible.canAccessReport ? logisticsAnalysis : null,
      annotations: visible.annotations,
      evaluation: visible.evaluation,
      report: visible.report,
      cohortAnalytics
    }
  }

  async saveStudentSummary(projectId: string, user: AuthUser, expectedRevision: number, summary: string, structuredSummary: Partial<V3LogisticsStudentReviewSummaryView> | undefined, submit: boolean): Promise<ShowReviewWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireProjectAccess(projectId, user, manager)
      const stage = await this.lockStage(manager, projectId)
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("物流复盘阶段不在可编辑状态")
      const sources = await this.loadSources(projectId, manager)
      const evaluation = await this.ensureEvaluation(project, computeObjectiveMetrics(sources), manager)
      if (evaluation.studentSubmittedAt || evaluation.status === "PUBLISHED") throw new ConflictException("物流复盘总结已经锁定")
      assertRevision(evaluation.revision, expectedRevision)
      const normalized = normalizeLogisticsStudentSummary(summary, structuredSummary, submit)
      const beforeRevision = evaluation.revision
      evaluation.studentSummary = normalized.stored
      evaluation.objectiveMetrics = computeObjectiveMetrics(sources)
      evaluation.revision += 1
      if (submit) {
        const now = new Date()
        evaluation.studentSubmittedAt = now
        stage.status = "SUBMITTED"
        stage.submittedAt = now
        stage.revision += 1
        project.status = "EVALUATING"
        project.currentStageCode = "LOGISTICS_REVIEW"
        project.lastActivityAt = now
        await manager.save([stage, project])
      }
      await manager.save(evaluation)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_REVIEW",
        actor: user,
        eventType: submit ? "LOGISTICS_REVIEW_SUMMARY_SUBMITTED" : "LOGISTICS_REVIEW_SUMMARY_SAVED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        beforeRevision,
        afterRevision: evaluation.revision,
        result: { summaryLength: normalized.text.length, structured: normalized.structured !== null }
      })
    })
    return this.workspace(projectId, user)
  }

  async saveTeacherEvaluation(projectId: string, user: AuthUser, expectedRevision: number, scores: ShowTeacherScoreView[] | undefined, summary: string | undefined): Promise<ShowReviewWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以填写综合评价")
      const stage = await this.lockStage(manager, projectId)
      if (stage.status !== "SUBMITTED") throw new ConflictException("学生尚未提交物流复盘总结")
      const evaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId }, lock: { mode: "pessimistic_write" } })
      if (!evaluation || evaluation.status === "PUBLISHED") throw new ConflictException("评价已经发布或不存在")
      assertRevision(evaluation.revision, expectedRevision)
      const normalizedScores = normalizeTeacherScores(scores, evaluation.teacherScores as unknown as ShowTeacherScoreView[])
      const beforeRevision = evaluation.revision
      evaluation.teacherScores = normalizedScores as never
      evaluation.summary = normalizeText(summary ?? evaluation.summary, 5_000, "综合讲评")
      evaluation.totalScore = totalTeacherScore(normalizedScores)
      evaluation.status = teacherEvaluationContentBlockedReason(normalizedScores, evaluation.summary) === null ? "REVIEWED" : "PENDING"
      evaluation.reviewedById = user.id
      evaluation.reviewedAt = new Date()
      evaluation.revision += 1
      await manager.save(evaluation)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_REVIEW",
        actor: user,
        eventType: "LOGISTICS_EVALUATION_SAVED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        beforeRevision,
        afterRevision: evaluation.revision,
        result: { totalScore: evaluation.totalScore }
      })
    })
    return this.workspace(projectId, user)
  }

  async publishTeacherEvaluation(projectId: string, user: AuthUser, expectedRevision: number): Promise<ShowReviewWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以发布综合评价")
      const stage = await this.lockStage(manager, projectId)
      if (stage.status !== "SUBMITTED") throw new ConflictException("当前阶段不能发布评价")
      const evaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId }, lock: { mode: "pessimistic_write" } })
      if (!evaluation || !evaluation.studentSubmittedAt) throw new ConflictException("学生复盘总结尚未提交")
      if (evaluation.status === "PUBLISHED") throw new ConflictException("评价已发布，不能重复发布")
      assertRevision(evaluation.revision, expectedRevision)
      const scores = evaluation.teacherScores as unknown as ShowTeacherScoreView[]
      const blockedReason = teacherEvaluationContentBlockedReason(scores, evaluation.summary)
      if (blockedReason) throw new ConflictException(blockedReason)
      const now = new Date()
      evaluation.status = "PUBLISHED"
      evaluation.totalScore = totalTeacherScore(scores)
      evaluation.publishedAt = now
      evaluation.reviewedAt = evaluation.reviewedAt ?? now
      evaluation.revision += 1
      stage.status = "ACCEPTED"
      stage.acceptedAt = now
      stage.revision += 1
      project.status = "GRADED"
      project.currentStageCode = "LOGISTICS_REVIEW"
      project.lastActivityAt = now
      await manager.save([evaluation, stage, project])
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_REVIEW",
        actor: user,
        eventType: "LOGISTICS_EVALUATION_PUBLISHED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        afterRevision: evaluation.revision,
        result: { totalScore: evaluation.totalScore }
      })
    })
    return this.workspace(projectId, user)
  }

  async addAnnotation(projectId: string, user: AuthUser, input: { timelineItemId?: string; simulationTimeMs?: number | null; comment?: string }): Promise<ShowReviewWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireProjectAccess(projectId, user, manager)
      if (user.role !== "teacher" && user.role !== "admin") throw new ForbiddenException("仅教师可以添加复盘讲评")
      const evaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId } })
      if (!evaluation) throw new ConflictException("评价记录尚未创建")
      const timeline = buildTimeline(await this.loadSources(projectId, manager))
      const timelineItemId = normalizeText(input.timelineItemId ?? "", 160, "时间轴节点", 1)
      const target = timeline.find((item) => item.id === timelineItemId)
      if (!target) throw new BadRequestException("时间轴节点不存在")
      const comment = normalizeText(input.comment ?? "", 1_000, "讲评内容", 2)
      const dbUser = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const annotation = await manager.save(ShowReviewAnnotationEntity, manager.create(ShowReviewAnnotationEntity, {
        project,
        evaluation,
        timelineItemId,
        simulationTimeMs: input.simulationTimeMs === undefined ? target.simulationTimeMs : normalizeSimulationTime(input.simulationTimeMs),
        comment,
        createdBy: dbUser
      }))
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_REVIEW",
        actor: user,
        eventType: "REVIEW_ANNOTATION_ADDED",
        objectType: "REVIEW_ANNOTATION",
        objectId: annotation.id,
        simulationTimeMs: annotation.simulationTimeMs,
        result: { commentLength: comment.length }
      })
    })
    return this.workspace(projectId, user)
  }

  async generateReport(projectId: string, user: AuthUser, formatValue: string): Promise<ShowReviewWorkspaceView> {
    const format = normalizeReportFormat(formatValue)
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const evaluation = await this.evaluations.findOne({ where: { projectId } })
    if (!evaluation || evaluation.status !== "PUBLISHED") throw new ConflictException("教师发布评价后才能生成最终报告")
    if (!canAccessFullReviewReport(actor, project.snapshot.mode, project.snapshot.config.resultVisibility, evaluation.status)) throw new ForbiddenException("当前结果展示策略不允许访问完整项目报告")
    const snapshot = await this.reportSnapshot(project, evaluation)
    const contentHash = hashSnapshot(snapshot)
    const current = await this.reports.findOne({ where: { project: { id: projectId } } })
    if (current?.asset && current.format === format && current.contentHash === contentHash) return this.workspace(projectId, user)
    const renderData = logisticsReportRenderData(snapshot)
    const content = format === "PDF" ? await createShowReportPdf(renderData) : await createShowReportDocx(renderData)
    const extension = format.toLowerCase()
    const filename = `${safeFilename(project.snapshot.title)}-${safeFilename(project.student.displayName)}-物流项目报告.${extension}`
    const objectKey = `projects/${projectId}/reports/${randomUUID()}.${extension}`
    const stored = await this.storage.write(objectKey, content, format === "PDF" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    try {
      await this.dataSource.transaction(async (manager) => {
        const lockedEvaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId }, lock: { mode: "pessimistic_write" } })
        if (!lockedEvaluation || lockedEvaluation.status !== "PUBLISHED") throw new ConflictException("评价状态已变化，请刷新后重试")
        await manager.query(`SELECT "id" FROM "show_project_reports" WHERE "projectId" = $1 FOR UPDATE`, [projectId])
        let report = await manager.findOne(ShowProjectReportEntity, { where: { project: { id: projectId } } })
        if (!report) report = await manager.save(ShowProjectReportEntity, manager.create(ShowProjectReportEntity, { project, evaluation: lockedEvaluation, status: "DRAFT", revision: 1, format: null, asset: null, snapshot: {}, contentHash: null, generatedAt: null }))
        const dbUser = await manager.findOneByOrFail(UserEntity, { id: user.id })
        const asset = await manager.save(FileAssetEntity, manager.create(FileAssetEntity, {
          category: "FINAL_REPORT",
          storageProvider: stored.storageProvider,
          objectKey: stored.objectKey,
          originalName: filename,
          mimeType: format === "PDF" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          status: "AVAILABLE",
          ownerType: "PROJECT",
          ownerId: projectId,
          createdBy: dbUser
        }))
        if (report.asset) {
          const previous = await manager.findOneBy(FileAssetEntity, { id: report.asset.id })
          if (previous) {
            previous.status = "ARCHIVED"
            await manager.save(previous)
          }
          report.revision += 1
        }
        report.status = "FINAL"
        report.format = format
        report.asset = asset
        report.snapshot = snapshot
        report.contentHash = contentHash
        report.generatedAt = new Date()
        await manager.save(report)
        await this.activityLog.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId,
          stageCode: "LOGISTICS_REVIEW",
          actor: user,
          eventType: "LOGISTICS_REPORT_GENERATED",
          objectType: "FINAL_REPORT",
          objectId: report.id,
          afterRevision: report.revision,
          result: { format, filename, sizeBytes: stored.sizeBytes, sha256: stored.sha256 }
        })
      })
    } catch (error) {
      await this.storage.delete(stored.objectKey, stored.storageProvider).catch(() => undefined)
      throw error
    }
    return this.workspace(projectId, user)
  }

  async downloadReport(projectId: string, user: AuthUser) {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const evaluation = await this.evaluations.findOne({ where: { projectId } })
    if (!evaluation || !canAccessFullReviewReport(actor, project.snapshot.mode, project.snapshot.config.resultVisibility, evaluation.status)) throw new ForbiddenException("当前结果展示策略不允许访问完整项目报告")
    const report = await this.reports.findOne({ where: { project: { id: projectId } } })
    if (!report?.asset || report.status !== "FINAL") throw new NotFoundException("物流项目报告尚未生成")
    return { asset: report.asset, content: await this.storage.read(report.asset.objectKey, report.asset.storageProvider) }
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.dataSource.manager): Promise<{ project: StudentProjectEntity; actor: "STUDENT" | "TEACHER" }> {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (project.snapshot.sceneType !== "CITY_LOGISTICS") throw new ConflictException("当前项目不是城市低空物流场景")
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return { project, actor: "STUDENT" }
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" }
    throw new ForbiddenException("无权访问该学生项目")
  }

  private async lockStage(manager: EntityManager, projectId: string): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "LOGISTICS_REVIEW" }, lock: { mode: "pessimistic_write" } })
    if (!stage) throw new NotFoundException("物流复盘阶段不存在")
    return stage
  }

  private async loadSources(projectId: string, manager: EntityManager = this.projects.manager): Promise<LogisticsReviewSources> {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    const session = await manager.findOne(RuntimeSessionEntity, { where: { projectId }, order: { attemptNo: "DESC" } })
    const sessionId = session?.id
    const records = await this.runtimeData.loadSubmittedSchedule(manager, projectId)
    const [events, alerts, actions, snapshots, activities, routeVersion, validation, schedule, dynamicScheduleVersions] = await Promise.all([
      sessionId ? manager.find(RuntimeEventEntity, { where: { projectId, sessionId }, order: { scheduledSimulationTimeMs: "ASC" } }) : [],
      sessionId ? manager.find(RuntimeAlertEntity, { where: { projectId, sessionId }, order: { openedAt: "ASC" } }) : [],
      sessionId ? manager.find(StudentRuntimeActionEntity, { where: { projectId, sessionId }, order: { requestedAt: "ASC" } }) : [],
      sessionId ? manager.find(LogisticsRuntimeSnapshotEntity, { where: { projectId, sessionId }, order: { sequence: "ASC" } }) : [],
      manager.find(ProjectActivityEventEntity, { where: { projectId }, order: { realTime: "ASC" } }),
      manager.findOne(LogisticsRoutePlanVersionEntity, { where: { project: { id: projectId }, status: "SUBMITTED" }, relations: { routes: { waypoints: true } }, order: { versionNo: "DESC" } }),
      manager.findOne(LogisticsRouteValidationRunEntity, { where: { project: { id: projectId } }, order: { attemptNo: "DESC" } }),
      manager.findOne(LogisticsScheduleVersionEntity, { where: { project: { id: projectId }, status: "SUBMITTED" }, relations: { items: true }, order: { versionNo: "DESC" } }),
      manager.find(LogisticsDynamicScheduleVersionEntity, { where: { project: { id: projectId }, status: "SUBMITTED" }, order: { versionNo: "ASC" } })
    ])
    const currentActivityObjectIds = new Set(currentAttemptActivities({ session, activities }).map((item) => item.objectId))
    return { project, session, events, alerts, actions, snapshots, activities, routeVersion, validation, schedule, scheduleItems: records.scheduleItems, dynamicScheduleVersions: dynamicScheduleVersions.filter((item) => currentActivityObjectIds.has(item.id)) }
  }

  private async ensureEvaluation(project: StudentProjectEntity, metrics: ShowObjectiveMetricView[], manager: EntityManager = this.dataSource.manager): Promise<ProjectEvaluationEntity> {
    const existing = await manager.findOne(ProjectEvaluationEntity, { where: { projectId: project.id } })
    if (existing) {
      if (existing.status !== "PUBLISHED") {
        existing.objectiveMetrics = metrics
        await manager.save(existing)
      }
      return existing
    }
    const rubric = await this.resourcePackages.resolveEvaluationRubric("CITY_LOGISTICS", project.snapshot.resourceRefs, manager)
    return manager.save(ProjectEvaluationEntity, manager.create(ProjectEvaluationEntity, {
      projectId: project.id,
      status: "PENDING",
      rubricVersion: rubric.rubricVersion,
      objectiveMetrics: metrics,
      teacherScores: rubric.teacherScores,
      studentSummary: "",
      studentSubmittedAt: null,
      summary: "",
      totalScore: null,
      reviewedById: null,
      revision: 1,
      reviewedAt: null,
      publishedAt: null
    }))
  }

  private async reportSnapshot(project: StudentProjectEntity, evaluation: ProjectEvaluationEntity): Promise<Record<string, unknown>> {
    const sources = await this.loadSources(project.id)
    return {
      schemaVersion: 1,
      generatedFromEvaluationRevision: evaluation.revision,
      project: { id: project.id, title: project.snapshot.title, studentName: project.student.displayName, studentEmail: project.student.email, mode: project.snapshot.mode, scaleTemplateCode: project.snapshot.config.scaleTemplateCode, regionPackageId: project.snapshot.config.regionPackageId, taskBrief: project.snapshot.config.taskBrief, publishedAt: project.snapshot.publishedAt.toISOString(), checksum: project.snapshot.checksum, resourceRefs: project.snapshot.resourceRefs },
      route: { versionNo: sources.routeVersion?.versionNo ?? null, routeCount: sources.routeVersion?.routes?.length ?? 0, checkResult: sources.routeVersion?.checkResult ?? null, validation: sources.validation?.result ?? null },
      schedule: { versionNo: sources.schedule?.versionNo ?? null, checkResult: sources.schedule?.checkResult ?? null, itemCount: sources.scheduleItems.length },
      runtime: sources.session ? { status: sources.session.status, simulationTimeMs: Number(sources.session.simulationTimeMs), revision: sources.session.revision, snapshotCount: sources.snapshots.length } : null,
      events: sources.events.map((item) => ({ code: item.code, category: item.category, status: item.status, severity: item.severity, scheduledSimulationTimeMs: nullableNumber(item.scheduledSimulationTimeMs), triggeredAt: item.triggeredAt?.toISOString() ?? null, resolvedAt: item.resolvedAt?.toISOString() ?? null, payload: item.payload })),
      alerts: sources.alerts.map((item) => ({ code: item.code, title: item.title, severity: item.severity, status: item.status, simulationTimeMs: nullableNumber(item.simulationTimeMs) })),
      actions: sources.actions.map((item) => ({ actionCode: item.actionCode, targetType: item.targetType, targetId: item.targetId, status: item.status, simulationTimeMs: Number(item.simulationTimeMs), result: item.result, payload: item.payload })),
      dynamicReschedules: currentAttemptActivities(sources).filter((item) => item.eventType === "LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED").map((item) => ({ realTime: item.realTime.toISOString(), simulationTimeMs: nullableNumber(item.simulationTimeMs), result: item.result })),
      objectiveMetrics: evaluation.objectiveMetrics,
      teacherScores: evaluation.teacherScores,
      studentSummary: evaluation.studentSummary,
      studentSummaryStructured: null,
      logisticsStudentSummaryStructured: parseLogisticsStudentSummary(evaluation.studentSummary),
      teacherSummary: evaluation.summary,
      totalScore: evaluation.totalScore,
      declaration: reportDeclaration
    }
  }

  private async cohortAnalytics(assignmentId: string): Promise<ShowReviewCohortAnalyticsView> {
    const projects = await this.projects.find({ where: { snapshot: { draft: { id: assignmentId } } } })
    const projectIds = projects.map((item) => item.id)
    const [evaluations, events] = projectIds.length
      ? await Promise.all([
          this.evaluations.find({ where: { projectId: In(projectIds) } }),
          this.events.find({ where: { projectId: In(projectIds) } })
        ])
      : [[], []]
    return computeLogisticsCohortAnalytics(assignmentId, projects, evaluations, events)
  }
}

function logisticsReviewPublishBlockedReason(
  actor: "STUDENT" | "TEACHER",
  stageStatus: StudentProjectStageEntity["status"] | null,
  evaluationStatus: ProjectEvaluationEntity["status"],
  scores: ShowTeacherScoreView[],
  summary: string
): string | null {
  if (actor !== "TEACHER") return "仅教师可以发布综合评价"
  if (evaluationStatus === "PUBLISHED") return "评价已发布，评分与报告已锁定"
  if (stageStatus !== "SUBMITTED") return "学生提交复盘总结后才能发布评价"
  return teacherEvaluationContentBlockedReason(scores, summary)
}

export function computeLogisticsCohortAnalytics(
  assignmentId: string,
  projects: Array<Pick<StudentProjectEntity, "id" | "status">>,
  evaluations: Array<Pick<ProjectEvaluationEntity, "status" | "totalScore" | "objectiveMetrics">>,
  events: Array<Pick<RuntimeEventEntity, "category" | "triggeredAt" | "payload">>
): ShowReviewCohortAnalyticsView {
  const published = evaluations.filter((item) => item.status === "PUBLISHED" && item.totalScore !== null)
  const riskCounts = new Map<string, { label: string; count: number }>()
  const responseSeconds: number[] = []
  for (const evaluation of evaluations) {
    for (const metric of evaluation.objectiveMetrics as unknown as ShowObjectiveMetricView[]) {
      if (metric.code === "AVG_RESPONSE_SECONDS" && typeof metric.value === "number") responseSeconds.push(metric.value)
      if (metric.state !== "RISK") continue
      const current = riskCounts.get(metric.code) ?? { label: metric.label, count: 0 }
      current.count += 1
      riskCounts.set(metric.code, current)
    }
  }
  const triggeredEvents = events.filter((item) => item.triggeredAt)
  const eventCounts = new Map<string, number>()
  for (const event of triggeredEvents) {
    const eventSubtype = typeof event.payload.eventSubtype === "string" ? event.payload.eventSubtype : event.category
    eventCounts.set(eventSubtype, (eventCounts.get(eventSubtype) ?? 0) + 1)
  }
  const completedCount = projects.filter((item) => item.status === "GRADED").length
  return {
    assignmentId,
    projectCount: projects.length,
    completedCount,
    completionRate: ratio(completedCount, projects.length),
    publishedCount: published.length,
    averageScore: published.length ? round(published.reduce((sum, item) => sum + Number(item.totalScore), 0) / published.length, 1) : null,
    averageResponseSeconds: responseSeconds.length ? round(responseSeconds.reduce((sum, item) => sum + item, 0) / responseSeconds.length, 1) : null,
    commonOmissions: [],
    errorTypes: [],
    commonRisks: [...riskCounts.entries()]
      .map(([code, value]) => ({ code, label: value.label, count: value.count, ratio: ratio(value.count, evaluations.length) }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
      .slice(0, 6),
    eventTypes: [...eventCounts.entries()]
      .map(([code, count]) => ({ code, label: logisticsEventSubtypeLabel(code) ?? logisticsEventCategoryLabel(code), count, ratio: ratio(count, triggeredEvents.length) }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
  }
}

function computeObjectiveMetrics(sources: LogisticsReviewSources): ShowObjectiveMetricView[] {
  const orders = sources.scheduleItems
  const completedOrders = sources.snapshots.at(-1)?.projection.summary.completedOrders ?? 0
  const delayedOrders = sources.snapshots.at(-1)?.projection.summary.delayedOrders ?? 0
  const failedOrders = sources.snapshots.at(-1)?.projection.summary.failedOrders ?? 0
  const triggered = sources.events.filter((item) => item.triggeredAt)
  const discovered = triggered.filter((item) => Number(item.payload.detectedSimulationTimeMs) >= 0 && item.payload.detectedSimulationTimeMs !== null)
  const controlled = triggered.filter((item) => item.status === "RESOLVED" || item.payload.lifecycleStatus === "CONTROLLED" || item.payload.lifecycleStatus === "ENDED")
  const responseSeconds = sources.actions.map((action) => {
    const event = action.eventId ? sources.events.find((item) => item.id === action.eventId) : undefined
    const detected = Number(event?.payload.detectedSimulationTimeMs)
    return event && Number.isFinite(detected) ? Math.max(0, Number(action.simulationTimeMs) - detected) / 1_000 : null
  }).filter((value): value is number => value !== null)
  const averageResponse = responseSeconds.length ? round(responseSeconds.reduce((sum, value) => sum + value, 0) / responseSeconds.length, 1) : 0
  const deadlineResults = sources.actions.map((action) => action.result?.withinDeadline).filter((value): value is boolean => typeof value === "boolean")
  const deadlinePassRate = ratio(deadlineResults.filter(Boolean).length, deadlineResults.length) * 100
  const onTime = sources.snapshots.at(-1)?.projection.orders.filter((item) => item.status === "COMPLETED" && isOnTimeArrival(item.expectedArrivalTimeMs, item.latestArrivalTimeMs)).length ?? 0
  const routePassed = sources.validation?.status === "PASSED" || sources.validation?.status === "WITH_RISK"
  const schedulePassed = Boolean(sources.schedule?.checkResult.submittable)
  const dynamicCount = currentAttemptActivities(sources).filter((item) => item.eventType === "LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED").length
  const strictMetrics = computeLogisticsSimulationMetrics(sources)
  return [
    metric("ROUTE_VALIDATION", "航线验证", routePassed ? "通过" : "待复核", null, routePassed ? "PASS" : "RISK", sources.validation ? `第 ${sources.validation.attemptNo} 次验证，${sources.validation.status}` : "尚未找到验证记录"),
    metric("SCHEDULE_QUALITY", "调度方案质量", schedulePassed ? "可执行" : "存在冲突", null, schedulePassed ? "PASS" : "RISK", sources.schedule ? `V${sources.schedule.versionNo}，${sources.schedule.checkResult.conflictCount} 个硬冲突` : "尚未提交正式调度"),
    strictMetrics.flightTime,
    strictMetrics.buildingCollision,
    strictMetrics.spaceConflict,
    strictMetrics.airConflict,
    strictMetrics.performanceLimit,
    strictMetrics.energyReserve,
    strictMetrics.energyConsumption,
    metric("ORDER_COMPLETION", "订单完成率", ratio(completedOrders, orders.length) * 100, "%", completedOrders === orders.length && orders.length > 0 ? "PASS" : "RISK", `${completedOrders}/${orders.length} 单完成，${failedOrders} 单失败`),
    metric("ON_TIME_DELIVERY", "准时到达率", logisticsOnTimeRate(onTime, completedOrders, delayedOrders) * 100, "%", onTime === completedOrders + delayedOrders && completedOrders + delayedOrders > 0 ? "PASS" : "RISK", `${onTime}/${completedOrders + delayedOrders} 个已完成或延误订单在时间窗内`),
    metric("RISK_IDENTIFICATION", "告警发现率", ratio(discovered.length, triggered.length) * 100, "%", triggered.length === 0 || discovered.length === triggered.length ? "PASS" : "RISK", `${discovered.length}/${triggered.length} 个运行事件已发现`),
    metric("AVG_RESPONSE_SECONDS", "平均处置时效", averageResponse, "秒", triggered.length === 0 || averageResponse <= 60 ? "PASS" : "RISK", responseSeconds.length ? `按 ${responseSeconds.length} 次关联处置统计` : "没有可匹配处置动作"),
    metric("ACTION_DEADLINE", "处置时限达标率", deadlinePassRate, "%", deadlineResults.length === 0 || deadlinePassRate === 100 ? "PASS" : "RISK", deadlineResults.length ? `${deadlineResults.filter(Boolean).length}/${deadlineResults.length} 次关联处置在教师设定时限内` : "教师未设置处置时限"),
    metric("EVENT_CONTROL", "事件控制率", ratio(controlled.length, triggered.length) * 100, "%", triggered.length === 0 || controlled.length === triggered.length ? "PASS" : "RISK", `${controlled.length}/${triggered.length} 个运行事件已控制或结束`),
    metric("DYNAMIC_RESCHEDULE", "动态重调度", dynamicCount, "次", dynamicCount > 0 || triggered.length === 0 ? "PASS" : "INFO", dynamicCount ? `已提交 ${dynamicCount} 个动态调度版本` : delayedOrders ? "存在延误订单但未提交动态重调度" : "运行中未触发重调度场景")
  ]
}

/**
 * Derive review metrics from persisted route validation, schedule checks and
 * runtime snapshots. These values intentionally remain unavailable until the
 * corresponding simulation record exists; a zero would imply a successful
 * check that has not actually been run.
 */
function computeLogisticsSimulationMetrics(sources: LogisticsReviewSources): {
  flightTime: ShowObjectiveMetricView
  buildingCollision: ShowObjectiveMetricView
  spaceConflict: ShowObjectiveMetricView
  airConflict: ShowObjectiveMetricView
  performanceLimit: ShowObjectiveMetricView
  energyReserve: ShowObjectiveMetricView
  energyConsumption: ShowObjectiveMetricView
} {
  const validation = sources.validation?.result ?? null
  const validationEvidence = validation?.evidence ?? []
  const scheduleCheck = sources.schedule?.checkResult ?? null
  const scheduleEvidence = scheduleCheck?.evidence ?? []
  const latestProjection = sources.snapshots.at(-1)?.projection

  const missionDurations = sources.scheduleItems
    .map((item) => (Number.isFinite(item.arrivalTimeMs) && Number.isFinite(item.plannedTakeoffTimeMs) && Number.isFinite(item.landingTimeMs) && Number.isFinite(item.returnStartTimeMs)
      ? ((item.arrivalTimeMs - item.plannedTakeoffTimeMs) + (item.landingTimeMs - item.returnStartTimeMs)) / 1_000
      : null))
    .filter((value): value is number => value !== null && value >= 0)
  const runtimeDurations = (latestProjection?.tasks ?? [])
    .map((task) => (Number.isFinite(task.arrivalTimeMs) && Number.isFinite(task.plannedTakeoffTimeMs) && Number.isFinite(task.landingTimeMs) && Number.isFinite(task.returnStartTimeMs)
      ? ((task.arrivalTimeMs - task.plannedTakeoffTimeMs) + (task.landingTimeMs - task.returnStartTimeMs)) / 1_000
      : null))
    .filter((value): value is number => value !== null && value >= 0)
  const validatedDurations = (validation?.roundTripMetrics ?? [])
    .map((item) => Number(item.flightTimeSeconds))
    .filter((value) => Number.isFinite(value) && value >= 0)
  const durations = runtimeDurations.length > 0 ? runtimeDurations : missionDurations.length > 0 ? missionDurations : validatedDurations
  const maxFlightTime = durations.length > 0 ? Math.max(...durations) : null

  const buildingEvidence = validationEvidence.filter((item) => /^(BUILDING|OBSTACLE)_/.test(item.code) || item.code === "RESTRICTED_AREA_CROSSING")
  const spatialEvidence = validationEvidence.filter((item) => item.category === "SPATIAL" || item.code === "MULTI_ROUTE_CROSSING")
  const airConflictEvidence = scheduleEvidence.filter((item) => ["STRICT_SERIAL_VIOLATION", "SHARED_ROUTE_CONFLICT", "CROSSING_ROUTE_RISK"].includes(item.code))
  const performanceEvidence = [
    ...validationEvidence.filter((item) => item.category === "AIRCRAFT"),
    ...scheduleEvidence.filter((item) => item.category === "AIRCRAFT")
  ]
  const energyReserveValues = sources.scheduleItems
    .map((item) => Number(item.batteryAfterMissionPercent))
    .filter((value) => Number.isFinite(value))
  const validatedReserveValues = (validation?.roundTripMetrics ?? [])
    .map((item) => Number(item.remainingBatteryPercent))
    .filter((value) => Number.isFinite(value))
  const runtimeCompletedTasks = (latestProjection?.tasks ?? []).filter((task) => ["AVAILABLE_AGAIN", "FAILED", "CANCELLED"].includes(task.status))
  const runtimeReserveValues = runtimeCompletedTasks
    .map((task) => Number(task.batteryPercent))
    .filter((value) => Number.isFinite(value))
  const reserveValues = runtimeReserveValues.length > 0 ? runtimeReserveValues : energyReserveValues.length > 0 ? energyReserveValues : validatedReserveValues
  const minimumReserve = reserveValues.length > 0 ? Math.min(...reserveValues) : null
  const validatedConsumptionValues = (validation?.roundTripMetrics ?? [])
    .map((item) => Number(item.batteryConsumptionPercent))
    .filter((value) => Number.isFinite(value) && value >= 0)
  const scheduleConsumptionValues = (sources.schedule?.items ?? [])
    .map((item) => {
      const initial = Number(item.aircraft?.initialBatteryPercent)
      const remaining = Number(item.batteryAfterMissionPercent)
      return Number.isFinite(initial) && Number.isFinite(remaining) ? Math.max(0, initial - remaining) : null
    })
    .filter((value): value is number => value !== null)
  const runtimeConsumptionValues = runtimeCompletedTasks
    .map((task) => {
      const scheduleItem = sources.schedule?.items?.find((item) => item.itemKey === task.scheduleItemId)
      const initial = Number(scheduleItem?.aircraft?.initialBatteryPercent)
      const remaining = Number(task.batteryPercent)
      return Number.isFinite(initial) && Number.isFinite(remaining) ? Math.max(0, initial - remaining) : null
    })
    .filter((value): value is number => value !== null)
  const consumptionValues = runtimeConsumptionValues.length > 0
    ? runtimeConsumptionValues
    : validatedConsumptionValues.length > 0
      ? validatedConsumptionValues
      : scheduleConsumptionValues
  const averageConsumption = consumptionValues.length > 0
    ? consumptionValues.reduce((sum, value) => sum + value, 0) / consumptionValues.length
    : null

  const noRun = (code: string, label = code): ShowObjectiveMetricView => metric(code, label, "—", null, "INFO", "尚未完成对应仿真计算")
  const countMetric = (
    code: string,
    label: string,
    count: number,
    sourceExists: boolean,
    detail: string,
    riskCount = 0
  ): ShowObjectiveMetricView => metric(code, label, sourceExists ? count : "—", sourceExists ? "项" : null, sourceExists ? (count === 0 && riskCount === 0 ? "PASS" : "RISK") : "INFO", sourceExists ? detail : "尚未完成对应仿真计算")

  return {
    flightTime: maxFlightTime === null
      ? noRun("FLIGHT_TIME", "最大往返飞行时间")
      : metric("FLIGHT_TIME", "最大往返飞行时间", maxFlightTime, "秒", "INFO", `根据 ${durations.length} 个已计算任务的计划航段时长`),
    buildingCollision: countMetric("BUILDING_COLLISION", "建筑物与禁限飞冲突", buildingEvidence.filter((item) => item.severity === "CONFLICT").length, Boolean(validation), `${buildingEvidence.length} 项建筑物、障碍物或禁限飞区空间检查记录`),
    spaceConflict: countMetric("SPACE_CONFLICT", "航线空间冲突", spatialEvidence.filter((item) => item.severity === "CONFLICT").length, Boolean(validation), `${spatialEvidence.length} 项航线空间关系检查记录`),
    airConflict: countMetric("AIR_CONFLICT", "空中交通冲突", airConflictEvidence.filter((item) => item.severity === "CONFLICT").length, Boolean(scheduleCheck), `${airConflictEvidence.length} 项调度时段与航线关系检查记录`, airConflictEvidence.filter((item) => item.severity === "RISK").length),
    performanceLimit: countMetric("PERFORMANCE_LIMIT", "机型性能限制", performanceEvidence.filter((item) => item.severity === "CONFLICT").length, Boolean(validation || scheduleCheck), `${performanceEvidence.length} 项高度、速度、航程或可用性检查记录`),
    energyReserve: minimumReserve === null
      ? noRun("ENERGY_RESERVE", "任务结束最低剩余电量")
      : metric("ENERGY_RESERVE", "任务结束最低剩余电量", minimumReserve, "%", minimumReserve >= 20 ? "PASS" : "RISK", `根据 ${reserveValues.length} 个任务的电量结果，安全余量阈值 20%`),
    energyConsumption: averageConsumption === null
      ? noRun("ENERGY_CONSUMPTION", "平均任务电量消耗")
      : metric("ENERGY_CONSUMPTION", "平均任务电量消耗", averageConsumption, "%", "INFO", `根据 ${consumptionValues.length} 个任务的往返能耗结果计算`)
  }
}

function buildTimeline(sources: LogisticsReviewSources): ShowReplayTimelineItemView[] {
  const runtimeEvidence = buildRuntimeEvidence({ events: sources.events, actions: sources.actions })
  const evidenceBySourceId = new Map(runtimeEvidence.map((evidence) => [evidence.id, evidence]))
  const items: ShowReplayTimelineItemView[] = currentAttemptActivities(sources).filter((item) => item.stageCode?.startsWith("LOGISTICS_")).map((item) => ({
    id: `ACTIVITY:${item.id}`,
    sourceId: item.id,
    kind: activityKind(item.eventType),
    simulationTimeMs: nullableNumber(item.simulationTimeMs),
    realTime: item.realTime.toISOString(),
    title: activityTitle(item.eventType),
    detail: `${item.actorName}${item.result && Object.keys(item.result).length ? ` · ${JSON.stringify(item.result)}` : ""}`,
    status: "RECORDED",
    severity: null,
    correlationId: item.correlationId,
    payload: { ...item.payload, ...item.result }
  }))
  for (const snapshot of sources.snapshots) items.push({ id: `SNAPSHOT:${snapshot.id}`, sourceId: snapshot.id, kind: "STATE", simulationTimeMs: Number(snapshot.simulationTimeMs), realTime: snapshot.createdAt.toISOString(), title: `运行快照 · ${snapshot.reason}`, detail: `完成 ${snapshot.projection.summary.completedOrders} 单，配送中 ${snapshot.projection.summary.deliveringOrders} 单，延误 ${snapshot.projection.summary.delayedOrders} 单`, status: snapshot.reason, severity: snapshot.projection.summary.failedOrders > 0 ? "WARNING" : null, correlationId: null, payload: snapshot.projection as unknown as Record<string, unknown> })
  for (const event of sources.events.filter((item) => item.triggeredAt)) {
    const evidence = evidenceBySourceId.get(event.id)
    items.push({ id: `EVENT:${event.id}`, sourceId: event.id, kind: "EVENT", simulationTimeMs: evidence?.simulationTimeMs ?? nullableNumber(event.scheduledSimulationTimeMs), realTime: event.triggeredAt!.toISOString(), title: String(event.payload.title ?? event.code), detail: String(event.payload.detail ?? event.category), status: String(event.payload.lifecycleStatus ?? event.status), severity: event.severity, correlationId: event.correlationId, payload: { ...event.payload, runtimeEvidenceSequence: evidence?.sequence ?? null } })
  }
  for (const alert of sources.alerts) items.push({ id: `ALERT:${alert.id}`, sourceId: alert.id, kind: "ALERT", simulationTimeMs: nullableNumber(alert.simulationTimeMs), realTime: alert.openedAt.toISOString(), title: alert.title, detail: alert.detail, status: alert.status, severity: alert.severity, correlationId: alert.correlationId, payload: alert.payload })
  for (const action of sources.actions) {
    const evidence = evidenceBySourceId.get(action.id)
    items.push({ id: `ACTION:${action.id}`, sourceId: action.id, kind: "ACTION", simulationTimeMs: evidence?.simulationTimeMs ?? Number(action.simulationTimeMs), realTime: action.requestedAt.toISOString(), title: actionLabel(action.actionCode), detail: actionTimelineDetail(action.targetType, action.targetId, runtimeActionReasoningFromPayload(action.payload), action.result), status: action.status, severity: action.status === "FAILED" || action.status === "REJECTED" ? "ERROR" : null, correlationId: action.correlationId, payload: { ...action.payload, result: action.result, runtimeEvidenceSequence: evidence?.sequence ?? null } })
  }
  addScheduleMilestones(items, sources)
  return items.sort((left, right) => Date.parse(left.realTime) - Date.parse(right.realTime) || (left.simulationTimeMs ?? 0) - (right.simulationTimeMs ?? 0) || left.id.localeCompare(right.id))
}

function addScheduleMilestones(items: ShowReplayTimelineItemView[], sources: LogisticsReviewSources): void {
  const lastProjection = sources.snapshots.at(-1)?.projection
  const orderById = new Map((lastProjection?.orders ?? []).map((order) => [order.id, order]))
  const durationMs = Math.max(
    Number(sources.session?.simulationTimeMs ?? 0),
    ...sources.snapshots.map((snapshot) => Number(snapshot.simulationTimeMs)),
    ...sources.scheduleItems.map((item) => item.nextAvailableTimeMs),
    0
  )
  for (const item of sources.scheduleItems) {
    const order = orderById.get(item.orderId)
    const milestones: Array<{ code: string; time: number; title: string; detail: string }> = [
      { code: "ORDER_RELEASED", time: order?.releaseTimeMs ?? item.plannedTakeoffTimeMs, title: `订单释放 · ${item.orderCode}`, detail: `订单 ${item.orderCode} 进入可调度队列，配送点 ${item.destinationNodeId}` },
      { code: "TASK_ASSIGNED", time: item.plannedTakeoffTimeMs, title: `任务分配 · ${item.aircraftCode}`, detail: `订单 ${item.orderCode} 分配至 ${item.aircraftCode}，计划起飞 ${formatSimulationTime(item.plannedTakeoffTimeMs)}` },
      { code: "TAKEOFF", time: item.plannedTakeoffTimeMs, title: `起飞 · ${item.aircraftCode}`, detail: `订单 ${item.orderCode} 执行去程航线` },
      { code: "ARRIVAL", time: item.arrivalTimeMs, title: `到达 · ${item.orderCode}`, detail: `无人机 ${item.aircraftCode} 到达配送点并完成交付确认` },
      { code: "RETURN", time: item.returnStartTimeMs, title: `返航 · ${item.aircraftCode}`, detail: `订单 ${item.orderCode} 进入返航航段` },
      { code: "LANDING", time: item.landingTimeMs, title: `降落 · ${item.aircraftCode}`, detail: `无人机 ${item.aircraftCode} 完成返航并恢复可用` }
    ]
    for (const milestone of milestones) {
      if (milestone.time < 0 || milestone.time > durationMs) continue
      items.push({
        id: `MILESTONE:${item.id}:${milestone.code}`,
        sourceId: item.id,
        kind: "STATE",
        simulationTimeMs: milestone.time,
        realTime: replayRealTime(sources.session, milestone.time),
        title: milestone.title,
        detail: milestone.detail,
        status: "RECORDED",
        severity: null,
        correlationId: null,
        payload: { milestone: milestone.code, scheduleItemId: item.id, orderId: item.orderId, aircraftId: item.aircraftId, routeId: item.outboundRouteId }
      })
    }
  }
}

function buildLogisticsReplay(sources: LogisticsReviewSources): V3ReviewReplayView {
  const durationMs = Math.max(
    Number(object(sources.session?.checkpoint).durationMs ?? 0),
    Number(sources.session?.simulationTimeMs ?? 0),
    ...sources.snapshots.map((snapshot) => Number(snapshot.simulationTimeMs)),
    ...sources.scheduleItems.map((item) => item.nextAvailableTimeMs),
    0
  )
  const frames: V3LogisticsReviewReplayFrameView[] = sources.snapshots.map((snapshot) => {
    const simulationTimeMs = Number(snapshot.simulationTimeMs)
    return {
      simulationTimeMs,
      realTime: snapshot.createdAt.toISOString(),
      tasks: snapshot.projection.tasks,
      aircraft: snapshot.projection.aircraft,
      orders: snapshot.projection.orders,
      routes: snapshot.projection.routes,
      summary: snapshot.projection.summary,
      events: sources.events.filter((event) => eventOccurredAt(event, simulationTimeMs)).map(serializeReplayEvent),
      alerts: sources.alerts.filter((alert) => nullableNumber(alert.simulationTimeMs) !== null && Number(alert.simulationTimeMs) <= simulationTimeMs).map(serializeReplayAlert)
    }
  })
  return { sceneType: "CITY_LOGISTICS", durationMs, frames: frames.sort((left, right) => left.simulationTimeMs - right.simulationTimeMs) }
}

function eventOccurredAt(event: RuntimeEventEntity, simulationTimeMs: number): boolean {
  const scheduled = nullableNumber(event.scheduledSimulationTimeMs)
  if (scheduled !== null) return Boolean(event.triggeredAt) && scheduled <= simulationTimeMs
  const triggered = nullableNumber(event.payload.detectedSimulationTimeMs)
  return Boolean(event.triggeredAt) && (triggered === null || triggered <= simulationTimeMs)
}

function serializeReplayEvent(event: RuntimeEventEntity): LogisticsRuntimeEventView {
  const payload = object(event.payload)
  return {
    id: event.id,
    projectId: event.projectId,
    sessionId: event.sessionId,
    stageCode: event.stageCode,
    code: event.code,
    category: event.category as LogisticsRuntimeEventView["category"],
    status: event.status,
    severity: event.severity,
    scheduledSimulationTimeMs: nullableNumber(event.scheduledSimulationTimeMs),
    triggeredSimulationTimeMs: nullableNumber(event.triggeredSimulationTimeMs),
    resolvedSimulationTimeMs: nullableNumber(event.resolvedSimulationTimeMs),
    triggeredAt: event.triggeredAt?.toISOString() ?? null,
    resolvedAt: event.resolvedAt?.toISOString() ?? null,
    payload: event.payload,
    correlationId: event.correlationId,
    lifecycleStatus: String(payload.lifecycleStatus ?? (event.status === "RESOLVED" ? "ENDED" : "SCHEDULED")) as LogisticsRuntimeEventView["lifecycleStatus"],
    title: String(payload.title ?? event.code),
    detail: String(payload.detail ?? event.category),
    affectedAircraftIds: Array.isArray(payload.affectedAircraftIds) ? payload.affectedAircraftIds.filter((value): value is string => typeof value === "string") : [],
    affectedOrderIds: Array.isArray(payload.affectedOrderIds) ? payload.affectedOrderIds.filter((value): value is string => typeof value === "string") : [],
    affectedRouteIds: Array.isArray(payload.affectedRouteIds) ? payload.affectedRouteIds.filter((value): value is string => typeof value === "string") : [],
    recommendedActions: Array.isArray(payload.recommendedActions) ? payload.recommendedActions as LogisticsRuntimeEventView["recommendedActions"] : [],
    detectedSimulationTimeMs: nullableNumber(payload.detectedSimulationTimeMs),
    controlledSimulationTimeMs: nullableNumber(payload.controlledSimulationTimeMs)
  }
}

function serializeReplayAlert(alert: RuntimeAlertEntity): V3RuntimeAlertView {
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
    simulationTimeMs: nullableNumber(alert.simulationTimeMs),
    openedAt: alert.openedAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    payload: alert.payload,
    correlationId: alert.correlationId
  }
}

function replayRealTime(session: RuntimeSessionEntity | null, simulationTimeMs: number): string {
  const anchor = session?.startedAt ?? session?.createdAt ?? new Date(0)
  return new Date(anchor.getTime() + Math.max(0, simulationTimeMs)).toISOString()
}

function currentAttemptActivities(sources: Pick<LogisticsReviewSources, "session" | "activities">): ProjectActivityEventEntity[] {
  if (!sources.session) return []
  return sources.activities.filter((item) => item.realTime >= sources.session!.createdAt)
}

function logisticsReportRenderData(snapshot: Record<string, unknown>): ShowReportRenderData {
  const project = object(snapshot.project)
  const route = object(snapshot.route)
  const schedule = object(snapshot.schedule)
  const runtime = object(snapshot.runtime)
  const metrics = array<ShowObjectiveMetricView>(snapshot.objectiveMetrics)
  const scores = array<ShowTeacherScoreView>(snapshot.teacherScores)
  const events = array<Record<string, unknown>>(snapshot.events)
  const actions = array<Record<string, unknown>>(snapshot.actions)
  return {
    title: "城市低空物流仿真实训项目报告",
    subtitle: `${string(project.title)} · ${string(project.studentName)}`,
    metadata: [
      { label: "学生", value: `${string(project.studentName)}（${string(project.studentEmail)}）` },
      { label: "任务模式", value: string(project.mode) === "ASSESSMENT" ? "考核模式" : "训练模式" },
      { label: "机群模板", value: string(project.scaleTemplateCode) },
      { label: "任务快照", value: string(project.checksum) },
      { label: "最终成绩", value: `${number(snapshot.totalScore).toFixed(1)} / 100` }
    ],
    sections: [
      { title: "物流方案", rows: [{ label: "任务说明", value: string(project.taskBrief) }, { label: "区域包", value: string(project.regionPackageId) }, { label: "航线方案", value: `V${number(route.versionNo)} · ${number(route.routeCount)} 条路线` }, { label: "航线验证", value: JSON.stringify(route.validation ?? {}) }] },
      { title: "订单与调度", rows: [{ label: "初始调度", value: `V${number(schedule.versionNo)} · ${number(schedule.itemCount)} 个任务` }, { label: "检查结果", value: JSON.stringify(schedule.checkResult ?? {}) }] },
      { title: "运行结果", rows: [{ label: "运行状态", value: string(runtime.status) }, { label: "仿真时长", value: formatDuration(number(runtime.simulationTimeMs)) }, { label: "运行快照", value: String(number(runtime.snapshotCount)) }] },
      { title: "告警与应急", paragraphs: [...events.map((item) => `${string(item.category)} / ${string(item.severity)}：${string(object(item.payload).title) || string(item.code)}，状态 ${string(object(item.payload).lifecycleStatus) || string(item.status)}`), ...actions.map(actionReportParagraph)] },
      { title: "自动采集指标", rows: metrics.map((item) => ({ label: item.label, value: `${item.displayValue} · ${item.state === "PASS" ? "达标" : item.state === "RISK" ? "需改进" : "记录"} · ${item.detail}` })) },
      { title: "教师评价", rows: [...scores.map((item) => ({ label: item.label, value: `${item.score ?? "-"} / ${item.maxScore} · ${item.comment || "无分项意见"}` })), { label: "学生复盘总结", value: logisticsStudentSummaryText(string(snapshot.studentSummary)) }, { label: "教师综合讲评", value: string(snapshot.teacherSummary) }] }
    ],
    declaration: reportDeclaration
  }
}

function serializeEvaluation(evaluation: ProjectEvaluationEntity): V3ProjectEvaluationView {
  return { id: evaluation.id, projectId: evaluation.projectId, status: evaluation.status, rubricVersion: evaluation.rubricVersion, objectiveMetrics: evaluation.objectiveMetrics as unknown as ShowObjectiveMetricView[], teacherScores: evaluation.teacherScores as unknown as ShowTeacherScoreView[], studentSummary: evaluation.studentSummary, studentSummaryStructured: null, logisticsStudentSummaryStructured: parseLogisticsStudentSummary(evaluation.studentSummary), studentSubmittedAt: evaluation.studentSubmittedAt?.toISOString() ?? null, summary: evaluation.summary, totalScore: evaluation.totalScore, revision: evaluation.revision, reviewedAt: evaluation.reviewedAt?.toISOString() ?? null, publishedAt: evaluation.publishedAt?.toISOString() ?? null }
}

function serializeReport(report: ShowProjectReportEntity, projectId: string): ShowProjectReportView {
  return { id: report.id, status: report.status, revision: report.revision, format: report.format, filename: report.asset?.originalName ?? null, sizeBytes: report.asset?.sizeBytes ?? null, sha256: report.asset?.sha256 ?? null, generatedAt: report.generatedAt?.toISOString() ?? null, downloadPath: report.asset ? `/v3/logistics-projects/${projectId}/review/report/download` : null }
}

function serializeAnnotation(item: ShowReviewAnnotationEntity) {
  return { id: item.id, timelineItemId: item.timelineItemId, simulationTimeMs: nullableNumber(item.simulationTimeMs), comment: item.comment, createdBy: item.createdBy.displayName, createdAt: item.createdAt.toISOString() }
}

function computeResponseSeconds(sources: LogisticsReviewSources): number[] {
  return sources.actions.map((action) => {
    const event = action.eventId ? sources.events.find((item) => item.id === action.eventId) : undefined
    const detected = Number(event?.payload.detectedSimulationTimeMs)
    return event && Number.isFinite(detected) ? Math.max(0, Number(action.simulationTimeMs) - detected) / 1_000 : null
  }).filter((value): value is number => value !== null)
}

function metric(code: string, label: string, value: number | string, unit: string | null, state: ShowObjectiveMetricView["state"], detail: string): ShowObjectiveMetricView { return { code, label, value: typeof value === "number" ? round(value, 1) : value, displayValue: `${typeof value === "number" ? round(value, 1) : value}${unit ?? ""}`, unit, state, detail } }
function activityKind(code: string): ShowReplayTimelineItemKind { return code.includes("EVENT") ? "EVENT" : code.includes("ACTION") ? "ACTION" : code.includes("REPORT") || code.includes("SUBMITTED") ? "REPORT" : "STAGE" }
function activityTitle(code: string): string { return ({ LOGISTICS_REGION_CONFIRMED: "物流区域已确认", LOGISTICS_ROUTE_VALIDATED: "航线验证完成", LOGISTICS_ROUTE_PLAN_SUBMITTED: "正式航线已提交", LOGISTICS_ORDER_BATCH_GENERATED: "订单批次已生成", LOGISTICS_INITIAL_SCHEDULE_SUBMITTED: "初始调度已提交", LOGISTICS_READINESS_CONFIRMED: "运行准备已确认", LOGISTICS_RUNTIME_STARTED: "配送运行已启动", LOGISTICS_RUNTIME_COMPLETED: "配送运行已完成", LOGISTICS_RUNTIME_EVENT_TRIGGERED: "运行事件已触发", LOGISTICS_RUNTIME_EVENT_DISCOVERED: "运行事件已发现", LOGISTICS_RUNTIME_EVENT_ESCALATED: "运行事件已升级", LOGISTICS_RUNTIME_EVENT_RESOLVED: "运行事件已控制", LOGISTICS_RUNTIME_ACTION_APPLIED: "学生处置已执行", LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED: "动态调度已生效", LOGISTICS_REVIEW_SUMMARY_SUBMITTED: "物流复盘总结已提交" } as Record<string, string>)[code] ?? code }
function actionLabel(code: string): string { return ({ ACKNOWLEDGE_ALERT: "确认告警", REDUCE_SPEED: "降低速度", MAINTAIN_ROUTE: "保持航线", HOLD_POSITION: "悬停等待", PROCEED_TO_WAITING_POINT: "前往等待点", RETURN_AIRCRAFT: "返航", DIVERT_AIRCRAFT: "备降", EMERGENCY_LAND_AIRCRAFT: "应急迫降", ABORT_TASK: "中止任务", PAUSE_ROUTE_ENTRY: "暂停新任务进入", PAUSE_ROUTE: "暂停航线", RESUME_ROUTE: "恢复航线", SWITCH_VERIFIED_ROUTE: "切换验证航线", REPLACE_AIRCRAFT: "更换无人机", REASSIGN_ORDER: "重新分配订单", CHANGE_PRIORITY: "调整优先级", DELAY_TASK: "推迟任务", CANCEL_TASK: "取消任务", BATCH_REASSIGN: "批量调整", GLOBAL_RESCHEDULE: "全局重调度" } as Record<string, string>)[code] ?? code }
function actionTimelineDetail(targetType: string, targetId: string | null, reasoning: V3RuntimeActionReasoning | null, result: unknown): string { const target = `${targetType}${targetId ? ` · ${targetId}` : ""}`; const detail = reasoning ? `${target}；异常发现：${reasoning.observation}；判断依据：${reasoning.rationale}；预期结果：${reasoning.expectedOutcome}` : target; return `${detail}；结果确认：${actionResultSummary(result)}` }
function actionReportParagraph(item: Record<string, unknown>): string { const reasoning = runtimeActionReasoningFromPayload(item.payload); const target = `${string(item.targetType)}${item.targetId ? `/${string(item.targetId)}` : ""}`; const reasoningText = reasoning ? `；异常发现：${reasoning.observation}；判断依据：${reasoning.rationale}；预期结果：${reasoning.expectedOutcome}` : string(object(item.payload).rationale) ? `；判断依据：${string(object(item.payload).rationale)}` : ""; return `${formatSimulationTime(number(item.simulationTimeMs))} ${actionLabel(string(item.actionCode))}，对象 ${target}${reasoningText}；结果确认：${actionResultSummary(item.result)}` }
function actionResultSummary(value: unknown): string { const result = object(value); const parts: string[] = []; if (result.applied === true) parts.push("动作已执行"); const consequences = Array.isArray(result.businessConsequences) ? result.businessConsequences.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []; if (consequences.length > 0) parts.push(`业务后果：${consequences.join("；")}`); else if (typeof result.outcome === "string" && result.outcome.trim()) parts.push(`业务后果：${result.outcome.trim()}`); if (result.eventControlled === true) parts.push("事件已控制"); if (result.withinDeadline === true) parts.push("时限内完成"); if (result.withinDeadline === false) parts.push("超过处置时限"); const responseTimeMs = nullableNumber(result.responseTimeMs); if (responseTimeMs !== null) parts.push(`响应 ${round(responseTimeMs / 1_000, 1)} 秒`); return parts.join("，") || "系统已留存动作结果" }
function logisticsEventCategoryLabel(code: string): string { return ({ WEATHER_ENVIRONMENT: "气象与环境", POSITIONING_NAVIGATION: "定位与导航", COMMUNICATION_LINK: "通信链路", AIRCRAFT_DEVICE: "无人机设备", ROUTE_OPERATION: "航线运行", ORDER_TASK_CHANGE: "订单变化" } as Record<string, string>)[code] ?? code }
function assertRevision(current: number, expected: number): void { if (!Number.isInteger(Number(expected)) || Number(expected) < 1) throw new BadRequestException("expectedRevision 必须为正整数"); if (current !== Number(expected)) throw new ConflictException(`评价版本冲突，当前版本为 ${current}`) }
function normalizeText(value: string, maximumLength: number, label: string, minimumLength = 0): string { const text = value.trim(); if (text.length < minimumLength) throw new BadRequestException(`${label}不能少于 ${minimumLength} 个字符`); if (text.length > maximumLength) throw new BadRequestException(`${label}不能超过 ${maximumLength} 个字符`); return text }
function normalizeReportFormat(value: string): "DOCX" | "PDF" { const normalized = value.trim().toUpperCase(); if (normalized !== "DOCX" && normalized !== "PDF") throw new BadRequestException("报告格式必须为 DOCX 或 PDF"); return normalized }
function normalizeSimulationTime(value: number | null): number | null { if (value === null) return null; const parsed = Number(value); if (!Number.isFinite(parsed) || parsed < 0) throw new BadRequestException("仿真时间无效"); return Math.round(parsed) }
function hashSnapshot(snapshot: Record<string, unknown>): string { return createHash("sha256").update(canonicalJson(snapshot)).digest("hex") }
function ratio(numerator: number, denominator: number): number { return denominator > 0 ? numerator / denominator : 1 }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor }
function nullableNumber(value: unknown): number | null { if (value === null || value === undefined) return null; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null }
function safeFilename(value: string): string { return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "项目" }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function array<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : [] }
function string(value: unknown): string { return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value) }
function number(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0 }
function formatDuration(milliseconds: number): string { const seconds = Math.max(0, Math.floor(milliseconds / 1_000)); return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` }
function formatSimulationTime(milliseconds: number): string { const seconds = Math.max(0, Math.floor(milliseconds / 1_000)); return `T+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` }
