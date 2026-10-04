import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { createHash, randomUUID } from "node:crypto"
import { DataSource, EntityManager, In, Repository } from "typeorm"
import type {
  AuthUser,
  ShowDocumentTemplateCode,
  ShowObjectiveMetricView,
  ShowProjectReportView,
  ShowReplayTimelineItemView,
  ShowReviewCohortAnalyticsView,
  ShowReviewWorkspaceView,
  ShowTeacherScoreView,
  V3StudentReviewSummaryView,
  StageStatus,
  V3AlertSeverity,
  V3ProjectEvaluationView,
  V3RuntimeActionReasoning,
  V3StageCode,
  V3ResourceValidationCheck
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { canonicalJson } from "../common/canonical-json.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { V3FileStorageService } from "../files/file-storage.service.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { ShowProjectDocumentEntity } from "../documents/show-document.entities.js"
import { ShowPreflightRecordEntity, ShowSimulationClockEntity } from "../show-readiness/show-readiness.entities.js"
import { ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { ShowOperationalReportEntity, ShowRuntimeGroupSnapshotEntity } from "../show-runtime/show-runtime.entities.js"
import {
  normalizeFrozenTeacherScores as normalizeTeacherScores,
  teacherEvaluationContentBlockedReason,
  totalFrozenTeacherScore as totalTeacherScore
} from "../resources/evaluation-rubric.js"
import { ResourcePackageService } from "../resources/resource-package.service.js"
import { createShowReportDocx, createShowReportPdf, type ShowReportRenderData } from "./show-report.renderer.js"
import { ShowProjectReportEntity, ShowReviewAnnotationEntity } from "./show-review.entities.js"
import { applyReviewVisibility, canAccessFullReviewReport } from "./review-visibility.js"
import { TransactionalOutboxService } from "../jobs/transactional-outbox.service.js"
import { SHOW_REPORT_GENERATE_JOB } from "../jobs/job-types.js"
import { runtimeActionReasoningFromPayload } from "../runtime/runtime-action-reasoning.js"
import { buildRuntimeEvidence } from "../runtime/runtime-evidence.js"
import { assessmentTimingForProject } from "../assessment/assessment-window.service.js"

const reportDeclaration = "本文件及系统生成的区域规划、飞行申报材料、动态报备记录和项目报告均为无人驾驶航空器编队表演教学仿真材料，不作为实际行政申报、审批、公安报备、空军/飞行管制申请或飞行活动执行依据。"

interface ReviewSources {
  session: RuntimeSessionEntity | null
  events: RuntimeEventEntity[]
  alerts: RuntimeAlertEntity[]
  actions: StudentRuntimeActionEntity[]
  snapshots: ShowRuntimeGroupSnapshotEntity[]
  reports: ShowOperationalReportEntity[]
  activities: ProjectActivityEventEntity[]
}

@Injectable()
export class ShowReviewService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ProjectEvaluationEntity) private readonly evaluations: Repository<ProjectEvaluationEntity>,
    @InjectRepository(RuntimeSessionEntity) private readonly sessions: Repository<RuntimeSessionEntity>,
    @InjectRepository(RuntimeEventEntity) private readonly events: Repository<RuntimeEventEntity>,
    @InjectRepository(RuntimeAlertEntity) private readonly alerts: Repository<RuntimeAlertEntity>,
    @InjectRepository(StudentRuntimeActionEntity) private readonly actions: Repository<StudentRuntimeActionEntity>,
    @InjectRepository(ShowRuntimeGroupSnapshotEntity) private readonly snapshots: Repository<ShowRuntimeGroupSnapshotEntity>,
    @InjectRepository(ShowOperationalReportEntity) private readonly operationalReports: Repository<ShowOperationalReportEntity>,
    @InjectRepository(ProjectActivityEventEntity) private readonly activityEvents: Repository<ProjectActivityEventEntity>,
    @InjectRepository(ShowAreaPlanVersionEntity) private readonly areaVersions: Repository<ShowAreaPlanVersionEntity>,
    @InjectRepository(ShowProjectDocumentEntity) private readonly documents: Repository<ShowProjectDocumentEntity>,
    @InjectRepository(ShowPreflightRecordEntity) private readonly preflight: Repository<ShowPreflightRecordEntity>,
    @InjectRepository(ShowSimulationClockEntity) private readonly clocks: Repository<ShowSimulationClockEntity>,
    @InjectRepository(ShowReviewAnnotationEntity) private readonly annotations: Repository<ShowReviewAnnotationEntity>,
    @InjectRepository(ShowProjectReportEntity) private readonly reports: Repository<ShowProjectReportEntity>,
    @InjectRepository(FileAssetEntity) private readonly assets: Repository<FileAssetEntity>,
    private readonly storage: V3FileStorageService,
    private readonly activityLog: ActivityLogService,
    private readonly resourcePackages: ResourcePackageService,
    private readonly outbox: TransactionalOutboxService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<ShowReviewWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    this.requireShowProject(project)
    const stage = await this.requireReviewStage(projectId)
    if (actor === "STUDENT" && ["LOCKED", "AVAILABLE", "RETURNED"].includes(stage.status)) throw new ConflictException("请先开始运行结果评价阶段")
    const sources = await this.loadSources(projectId)
    const showProgramRef = project.snapshot.resourceRefs.find((item) => item.packageType === "SHOW_PROGRAM")
    const programChecks = await this.resourcePackages.showProgramValidationChecks(showProgramRef?.packageId)
    const metrics = computeShowObjectiveMetrics(sources, programChecks)
    const evaluation = await this.ensureEvaluation(project, metrics)
    if (evaluation.status !== "PUBLISHED" && canonicalJson(evaluation.objectiveMetrics) !== canonicalJson(metrics)) {
      evaluation.objectiveMetrics = metrics
      await this.evaluations.save(evaluation)
    }
    const [annotations, report, cohortAnalytics] = await Promise.all([
      this.annotations.find({ where: { project: { id: projectId } }, order: { simulationTimeMs: "ASC", createdAt: "ASC" } }),
      this.reports.findOne({ where: { project: { id: projectId } } }),
      actor === "TEACHER" ? this.cohortAnalytics(project.snapshot.draft.id) : Promise.resolve(null)
    ])
    const canReview = actor === "TEACHER" && stage.status === "SUBMITTED" && evaluation.status !== "PUBLISHED"
    const assessmentWritable = assessmentTimingForProject(project).canWrite
    const publishBlockedReason = reviewPublishBlockedReason(actor, stage.status, evaluation.status, evaluation.teacherScores as unknown as ShowTeacherScoreView[], evaluation.summary)
    const timeline = buildShowReplayTimeline(sources)
    const annotationViews = annotations.map((item) => ({
      id: item.id,
      timelineItemId: item.timelineItemId,
      simulationTimeMs: item.simulationTimeMs === null ? null : Number(item.simulationTimeMs),
      comment: item.comment,
      createdBy: item.createdBy.displayName,
      createdAt: item.createdAt.toISOString()
    }))
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
      mapResourceVersion: project.snapshot.mapResourceVersion,
      sceneResourceVersion: project.snapshot.sceneResourceVersion,
      planVersion: project.snapshot.planVersion,
      scenarioOverlayVersionId: project.snapshot.config.scenarioOverlayVersionId ?? null,
      actor,
      resultVisibility: visible.resultVisibility,
      canAccessReport: visible.canAccessReport,
      canEditSummary: actor === "STUDENT" && assessmentWritable && stage.status === "IN_PROGRESS" && !evaluation.studentSubmittedAt,
      canSubmitSummary: actor === "STUDENT" && assessmentWritable && stage.status === "IN_PROGRESS" && !evaluation.studentSubmittedAt,
      canReview,
      canPublish: publishBlockedReason === null,
      publishBlockedReason,
      timeline: visible.timeline,
      annotations: visible.annotations,
      evaluation: visible.evaluation,
      report: visible.report,
      cohortAnalytics
    }
  }

  async saveStudentSummary(projectId: string, user: AuthUser, expectedRevision: number, summary: string, structuredSummary?: Partial<V3StudentReviewSummaryView>): Promise<ShowReviewWorkspaceView> {
    await this.writeStudentSummary(projectId, user, expectedRevision, summary, structuredSummary, false)
    return this.workspace(projectId, user)
  }

  async submitStudentSummary(projectId: string, user: AuthUser, expectedRevision: number, summary: string, structuredSummary?: Partial<V3StudentReviewSummaryView>): Promise<ShowReviewWorkspaceView> {
    await this.writeStudentSummary(projectId, user, expectedRevision, summary, structuredSummary, true)
    return this.workspace(projectId, user)
  }

  async saveTeacherEvaluation(
    projectId: string,
    user: AuthUser,
    input: { expectedRevision?: number; teacherScores?: ShowTeacherScoreView[]; summary?: string }
  ): Promise<ShowReviewWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以填写综合评价")
      const stage = await this.lockReviewStage(manager, projectId)
      if (stage.status !== "SUBMITTED") throw new ConflictException("学生尚未提交飞后总结")
      const evaluation = await this.lockEvaluation(manager, projectId)
      if (evaluation.status === "PUBLISHED") throw new ConflictException("评价已发布，不能继续修改")
      assertRevision(evaluation.revision, input.expectedRevision)
      const beforeRevision = evaluation.revision
      evaluation.teacherScores = normalizeTeacherScores(input.teacherScores, evaluation.teacherScores)
      evaluation.summary = normalizeText(input.summary ?? evaluation.summary, 5_000, "教师讲评")
      evaluation.totalScore = totalTeacherScore(evaluation.teacherScores as unknown as ShowTeacherScoreView[])
      evaluation.status = teacherEvaluationContentBlockedReason(evaluation.teacherScores as unknown as ShowTeacherScoreView[], evaluation.summary) === null ? "REVIEWED" : "PENDING"
      evaluation.reviewedById = user.id
      evaluation.reviewedAt = new Date()
      evaluation.revision += 1
      await manager.save(evaluation)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_REVIEW",
        actor: user,
        eventType: "EVALUATION_SAVED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        beforeRevision,
        afterRevision: evaluation.revision,
        result: { status: evaluation.status, totalScore: evaluation.totalScore }
      })
    })
    return this.workspace(projectId, user)
  }

  async publishTeacherEvaluation(projectId: string, user: AuthUser, expectedRevision: number): Promise<ShowReviewWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以发布综合评价")
      const stage = await this.lockReviewStage(manager, projectId)
      if (stage.status !== "SUBMITTED") throw new ConflictException("运行结果评价阶段不在待发布状态")
      const evaluation = await this.lockEvaluation(manager, projectId)
      assertRevision(evaluation.revision, expectedRevision)
      const scores = evaluation.teacherScores as unknown as ShowTeacherScoreView[]
      const blockedReason = teacherEvaluationContentBlockedReason(scores, evaluation.summary)
      if (blockedReason) throw new ConflictException(blockedReason)
      const now = new Date()
      const beforeRevision = evaluation.revision
      evaluation.status = "PUBLISHED"
      evaluation.totalScore = totalTeacherScore(scores)
      evaluation.reviewedById = user.id
      evaluation.reviewedAt ??= now
      evaluation.publishedAt = now
      evaluation.revision += 1
      stage.status = "ACCEPTED"
      stage.acceptedAt = now
      stage.revision += 1
      project.status = "GRADED"
      project.currentStageCode = "SHOW_REVIEW"
      project.lastActivityAt = now
      await manager.save([evaluation, stage, project])
      const report = await this.ensureReport(manager, project, evaluation)
      report.status = "FINAL"
      report.snapshot = await this.reportSnapshot(project, evaluation, manager)
      report.contentHash = hashSnapshot(report.snapshot)
      await manager.save(report)
      await this.outbox.append({
        eventType: "SHOW_EVALUATION_PUBLISHED",
        jobType: SHOW_REPORT_GENERATE_JOB,
        aggregateType: "SHOW_PROJECT",
        aggregateId: projectId,
        payload: { projectId, actorId: user.id, format: "PDF", contentHash: report.contentHash },
        priority: 10
      }, manager)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_REVIEW",
        actor: user,
        eventType: "EVALUATION_PUBLISHED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        beforeRevision,
        afterRevision: evaluation.revision,
        result: { totalScore: evaluation.totalScore, projectStatus: project.status }
      })
    })
    return this.workspace(projectId, user)
  }

  async addAnnotation(
    projectId: string,
    user: AuthUser,
    input: { timelineItemId?: string; simulationTimeMs?: number | null; comment?: string }
  ): Promise<ShowReviewWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以添加时间轴讲评")
      const stage = await this.lockReviewStage(manager, projectId)
      if (stage.status !== "SUBMITTED") throw new ConflictException("学生提交总结后才能添加讲评")
      const evaluation = await this.lockEvaluation(manager, projectId)
      if (evaluation.status === "PUBLISHED") throw new ConflictException("评价已发布，不能继续添加讲评")
      const timelineItemId = normalizeIdentifier(input.timelineItemId, 160, "请选择时间轴节点")
      const timeline = buildShowReplayTimeline(await this.loadSources(projectId, manager))
      const timelineItem = timeline.find((item) => item.id === timelineItemId)
      if (!timelineItem) throw new BadRequestException("时间轴节点不存在")
      const comment = normalizeText(input.comment ?? "", 1_000, "讲评批注")
      const dbUser = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const annotation = await manager.save(ShowReviewAnnotationEntity, manager.create(ShowReviewAnnotationEntity, {
        project,
        evaluation,
        timelineItemId,
        simulationTimeMs: input.simulationTimeMs === undefined ? timelineItem.simulationTimeMs : normalizeSimulationTime(input.simulationTimeMs),
        comment,
        createdBy: dbUser
      }))
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_REVIEW",
        actor: user,
        eventType: "REVIEW_ANNOTATION_ADDED",
        objectType: "REVIEW_ANNOTATION",
        objectId: annotation.id,
        simulationTimeMs: annotation.simulationTimeMs,
        payload: { timelineItemId },
        result: { commentLength: comment.length }
      })
    })
    return this.workspace(projectId, user)
  }

  async generateReport(projectId: string, user: AuthUser, formatValue: string, preserveExistingFormat = false): Promise<ShowReviewWorkspaceView> {
    const format = normalizeReportFormat(formatValue)
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    this.requireShowProject(project)
    const evaluation = await this.evaluations.findOne({ where: { projectId } })
    if (!evaluation || evaluation.status !== "PUBLISHED") throw new ConflictException("教师发布评价后才能生成最终报告")
    if (!canAccessFullReviewReport(actor, project.snapshot.mode, project.snapshot.config.resultVisibility, evaluation.status)) throw new ForbiddenException("当前结果展示策略不允许访问完整项目报告")
    const snapshot = await this.reportSnapshot(project, evaluation)
    const contentHash = hashSnapshot(snapshot)
    const current = await this.reports.findOne({ where: { project: { id: projectId } } })
    if (current?.asset && current.contentHash === contentHash && (preserveExistingFormat || current.format === format)) return this.workspace(projectId, user)
    const planningMap = await this.readPlanningMap(projectId)
    const renderData = reportRenderData(snapshot)
    renderData.planningMap = planningMap
    const content = format === "PDF" ? await createShowReportPdf(renderData) : await createShowReportDocx(renderData)
    const extension = format.toLowerCase()
    const filename = `${safeFilename(project.snapshot.title)}-${safeFilename(project.student.displayName)}-项目报告.${extension}`
    const objectKey = `projects/${projectId}/reports/${randomUUID()}.${extension}`
    const stored = await this.storage.write(objectKey, content, format === "PDF" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    try {
      await this.dataSource.transaction(async (manager) => {
        const lockedEvaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId }, lock: { mode: "pessimistic_write" } })
        if (!lockedEvaluation || lockedEvaluation.status !== "PUBLISHED") throw new ConflictException("评价状态已变化，请刷新后重试")
        await manager.query(
          `SELECT "id" FROM "show_project_reports" WHERE "projectId" = $1 FOR UPDATE`,
          [projectId]
        )
        let report = await manager.findOne(ShowProjectReportEntity, { where: { project: { id: projectId } } })
        if (!report) report = await this.ensureReport(manager, project, lockedEvaluation)
        if (report.asset && report.contentHash === contentHash && (preserveExistingFormat || report.format === format)) {
          await this.storage.delete(stored.objectKey, stored.storageProvider).catch(() => undefined)
          return
        }
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
          stageCode: "SHOW_REVIEW",
          actor: user,
          eventType: "REPORT_GENERATED",
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

  async generateReportFromJob(projectId: string, actorId: string, format: "DOCX" | "PDF"): Promise<Record<string, unknown>> {
    const actor = await this.users.findOneBy({ id: actorId })
    if (!actor) throw new NotFoundException("报告生成操作人不存在")
    const workspace = await this.generateReport(projectId, {
      id: actor.id,
      email: actor.email,
      displayName: actor.displayName,
      role: actor.role
    }, format, true)
    if (!workspace.report?.filename) throw new Error("报告作业执行后未生成文件资产")
    return {
      projectId,
      reportId: workspace.report.id,
      format: workspace.report.format,
      filename: workspace.report.filename,
      sizeBytes: workspace.report.sizeBytes,
      sha256: workspace.report.sha256
    }
  }

  async downloadReport(projectId: string, user: AuthUser) {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const evaluation = await this.evaluations.findOne({ where: { projectId } })
    if (!evaluation || !canAccessFullReviewReport(actor, project.snapshot.mode, project.snapshot.config.resultVisibility, evaluation.status)) throw new ForbiddenException("当前结果展示策略不允许访问完整项目报告")
    const report = await this.reports.findOne({ where: { project: { id: projectId } } })
    if (!report?.asset || report.status !== "FINAL") throw new NotFoundException("最终项目报告尚未生成")
    return { report, asset: report.asset, content: await this.storage.read(report.asset.objectKey, report.asset.storageProvider) }
  }

  private async writeStudentSummary(projectId: string, user: AuthUser, expectedRevision: number, summaryValue: string, structuredSummary: Partial<V3StudentReviewSummaryView> | undefined, submit: boolean): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以填写飞后总结")
      const stage = await this.lockReviewStage(manager, projectId)
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("运行结果评价阶段不在可编辑状态")
      const sources = await this.loadSources(projectId, manager)
      const showProgramRef = project.snapshot.resourceRefs.find((item) => item.packageType === "SHOW_PROGRAM")
      const programChecks = await this.resourcePackages.showProgramValidationChecks(showProgramRef?.packageId, manager)
      const metrics = computeShowObjectiveMetrics(sources, programChecks)
      const evaluation = await this.ensureEvaluation(project, metrics, manager)
      if (evaluation.studentSubmittedAt) throw new ConflictException("飞后总结已提交")
      assertRevision(evaluation.revision, expectedRevision)
      const normalizedSummary = normalizeShowStudentSummary(summaryValue, structuredSummary, submit)
      const beforeRevision = evaluation.revision
      evaluation.studentSummary = normalizedSummary.stored
      evaluation.objectiveMetrics = metrics
      evaluation.revision += 1
      if (submit) {
        const now = new Date()
        evaluation.studentSubmittedAt = now
        stage.status = "SUBMITTED"
        stage.submittedAt = now
        stage.revision += 1
        project.status = "EVALUATING"
        project.currentStageCode = "SHOW_REVIEW"
        project.lastActivityAt = now
        await manager.save([stage, project])
      }
      await manager.save(evaluation)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_REVIEW",
        actor: user,
        eventType: submit ? "REVIEW_SUMMARY_SUBMITTED" : "REVIEW_SUMMARY_SAVED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        beforeRevision,
        afterRevision: evaluation.revision,
        result: { summaryLength: normalizedSummary.text.length, structured: normalizedSummary.structured !== null }
      })
    })
  }

  private async ensureEvaluation(
    project: StudentProjectEntity,
    metrics: ShowObjectiveMetricView[],
    manager: EntityManager = this.evaluations.manager
  ): Promise<ProjectEvaluationEntity> {
    const existing = await manager.findOne(ProjectEvaluationEntity, { where: { projectId: project.id } })
    if (existing) return existing
    const rubric = await this.resourcePackages.resolveEvaluationRubric("CITY_SHOW", project.snapshot.resourceRefs, manager)
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

  private async ensureReport(manager: EntityManager, project: StudentProjectEntity, evaluation: ProjectEvaluationEntity): Promise<ShowProjectReportEntity> {
    const existing = await manager.findOne(ShowProjectReportEntity, { where: { project: { id: project.id } } })
    if (existing) return existing
    return manager.save(ShowProjectReportEntity, manager.create(ShowProjectReportEntity, {
      project,
      evaluation,
      status: "DRAFT",
      revision: 1,
      format: null,
      asset: null,
      snapshot: {},
      contentHash: null,
      generatedAt: null
    }))
  }

  private async reportSnapshot(
    project: StudentProjectEntity,
    evaluation: ProjectEvaluationEntity,
    manager: EntityManager = this.projects.manager
  ): Promise<Record<string, unknown>> {
    const session = await manager.findOne(RuntimeSessionEntity, { where: { projectId: project.id }, order: { attemptNo: "DESC" } })
    const sessionId = session?.id
    const [area, documents, preflight, clock, operationalReports, events, alerts, actions, snapshots, annotations] = await Promise.all([
      manager.findOne(ShowAreaPlanVersionEntity, { where: { project: { id: project.id }, status: "ACCEPTED" }, order: { versionNo: "DESC" } }),
      manager.find(ShowProjectDocumentEntity, { where: { project: { id: project.id } }, order: { templateCode: "ASC" } }),
      manager.findOne(ShowPreflightRecordEntity, { where: { project: { id: project.id } } }),
      manager.findOne(ShowSimulationClockEntity, { where: { project: { id: project.id } } }),
      sessionId ? manager.find(ShowOperationalReportEntity, { where: { project: { id: project.id }, sessionId }, order: { reportType: "ASC" } }) : [],
      sessionId ? manager.find(RuntimeEventEntity, { where: { projectId: project.id, sessionId }, order: { scheduledSimulationTimeMs: "ASC" } }) : [],
      sessionId ? manager.find(RuntimeAlertEntity, { where: { projectId: project.id, sessionId }, order: { openedAt: "ASC" } }) : [],
      sessionId ? manager.find(StudentRuntimeActionEntity, { where: { projectId: project.id, sessionId }, order: { requestedAt: "ASC" } }) : [],
      sessionId ? manager.find(ShowRuntimeGroupSnapshotEntity, { where: { projectId: project.id, sessionId }, order: { sequence: "ASC" } }) : [],
      manager.find(ShowReviewAnnotationEntity, { where: { project: { id: project.id } }, order: { createdAt: "ASC" } })
    ])
    return {
      schemaVersion: 1,
      generatedFromEvaluationRevision: evaluation.revision,
      project: {
        id: project.id,
        title: project.snapshot.title,
        studentName: project.student.displayName,
        studentEmail: project.student.email,
        mode: project.snapshot.mode,
        scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
        regionPackageId: project.snapshot.config.regionPackageId,
        taskBrief: project.snapshot.config.taskBrief,
        publishedAt: project.snapshot.publishedAt.toISOString(),
        checksum: project.snapshot.checksum,
        resourceRefs: project.snapshot.resourceRefs
      },
      area: area ? {
        versionNo: area.versionNo,
        status: area.status,
        reviewScore: area.reviewScore,
        reviewComment: area.reviewComment,
        planningMap: area.planningMapAsset ? { name: area.planningMapAsset.originalName, sha256: area.planningMapAsset.sha256 } : null,
        checkResult: area.checkResult
      } : null,
      documents: documents.map((item) => ({
        title: item.title,
        filename: item.filename,
        status: item.status,
        versionNo: item.currentVersionNo,
        submittedVersionNo: item.submittedVersionNo,
        submittedAt: item.submittedAt?.toISOString() ?? null,
        reviewScore: item.reviewScore,
        reviewComment: item.reviewComment,
        sha256: item.currentAsset?.sha256 ?? null
      })),
      preflight: preflight ? {
        status: preflight.status,
        decision: preflight.decision,
        rationale: preflight.rationale,
        completedAt: preflight.completedAt?.toISOString() ?? null,
        completedItems: preflight.items.filter((item) => item.confirmed).length,
        totalItems: preflight.items.length
      } : null,
      dynamicReporting: {
        t60SubmittedAt: clock?.submittedAt?.toISOString() ?? null,
        reports: operationalReports.map((item) => ({ reportType: item.reportType, status: item.status, revision: item.revision, submittedAt: item.submittedAt?.toISOString() ?? null, snapshot: item.snapshot }))
      },
      runtime: session ? {
        status: session.status,
        scenarioSeed: session.scenarioSeed,
        simulationTimeMs: Number(session.simulationTimeMs),
        revision: session.revision,
        startedAt: session.startedAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
        checkpoint: session.checkpoint,
        snapshotCount: snapshots.length
      } : null,
      events: events.map((item) => ({ code: item.code, category: item.category, status: item.status, severity: item.severity, scheduledSimulationTimeMs: nullableNumber(item.scheduledSimulationTimeMs), triggeredAt: item.triggeredAt?.toISOString() ?? null, resolvedAt: item.resolvedAt?.toISOString() ?? null, payload: item.payload })),
      alerts: alerts.map((item) => ({ code: item.code, title: item.title, severity: item.severity, status: item.status, simulationTimeMs: nullableNumber(item.simulationTimeMs), openedAt: item.openedAt.toISOString(), acknowledgedAt: item.acknowledgedAt?.toISOString() ?? null, resolvedAt: item.resolvedAt?.toISOString() ?? null })),
      actions: actions.map((item) => ({ actionCode: item.actionCode, targetType: item.targetType, targetId: item.targetId, status: item.status, simulationTimeMs: Number(item.simulationTimeMs), rationale: item.payload.rationale ?? null, payload: item.payload, result: item.result, requestedAt: item.requestedAt.toISOString() })),
      annotations: annotations.map((item) => ({ timelineItemId: item.timelineItemId, simulationTimeMs: nullableNumber(item.simulationTimeMs), comment: item.comment, createdBy: item.createdBy.displayName, createdAt: item.createdAt.toISOString() })),
      evaluation: serializeEvaluation(evaluation),
      declaration: reportDeclaration
    }
  }

  private async readPlanningMap(projectId: string): Promise<Buffer | null> {
    const area = await this.areaVersions.findOne({ where: { project: { id: projectId }, status: "ACCEPTED" }, order: { versionNo: "DESC" } })
    if (!area?.planningMapAsset) return null
    return this.storage.read(area.planningMapAsset.objectKey, area.planningMapAsset.storageProvider)
  }

  private async loadSources(projectId: string, manager: EntityManager = this.projects.manager): Promise<ReviewSources> {
    const session = await manager.findOne(RuntimeSessionEntity, { where: { projectId }, order: { attemptNo: "DESC" } })
    const sessionId = session?.id
    const [events, alerts, actions, snapshots, reports, allActivities] = await Promise.all([
      sessionId ? manager.find(RuntimeEventEntity, { where: { projectId, sessionId }, order: { scheduledSimulationTimeMs: "ASC" } }) : [],
      sessionId ? manager.find(RuntimeAlertEntity, { where: { projectId, sessionId }, order: { openedAt: "ASC" } }) : [],
      sessionId ? manager.find(StudentRuntimeActionEntity, { where: { projectId, sessionId }, order: { requestedAt: "ASC" } }) : [],
      sessionId ? manager.find(ShowRuntimeGroupSnapshotEntity, { where: { projectId, sessionId }, order: { sequence: "ASC" } }) : [],
      sessionId ? manager.find(ShowOperationalReportEntity, { where: { project: { id: projectId }, sessionId }, order: { submittedAt: "ASC" } }) : [],
      manager.find(ProjectActivityEventEntity, { where: { projectId }, order: { realTime: "ASC" } })
    ])
    const activities = currentAttemptActivities(session, allActivities)
    return { session, events, alerts, actions, snapshots, reports, activities }
  }

  private async cohortAnalytics(assignmentId: string): Promise<ShowReviewCohortAnalyticsView> {
    const projects = await this.projects.find({ where: { snapshot: { draft: { id: assignmentId } } } })
    const projectIds = projects.map((item) => item.id)
    if (projectIds.length === 0) return computeShowCohortAnalytics(assignmentId, [], [], [], [], [], [], [], [])
    const [evaluations, events, stages, documents, preflight, clocks, reports] = await Promise.all([
      this.evaluations.find({ where: { projectId: In(projectIds) } }),
      this.events.find({ where: { projectId: In(projectIds) } }),
      this.stages.find({ where: { project: { id: In(projectIds) } }, relations: { project: true } }),
      this.documents.find({ where: { project: { id: In(projectIds) } } }),
      this.preflight.find({ where: { project: { id: In(projectIds) } } }),
      this.clocks.find({ where: { project: { id: In(projectIds) } } }),
      this.operationalReports.find({ where: { project: { id: In(projectIds) } } })
    ])
    return computeShowCohortAnalytics(
      assignmentId,
      projects,
      evaluations,
      events,
      stages.map((item) => ({ projectId: item.project.id, stageCode: item.stageCode, status: item.status })),
      documents.map((item) => ({ projectId: item.project.id, templateCode: item.templateCode, status: item.status })),
      preflight.map((item) => ({ projectId: item.project.id, status: item.status })),
      clocks.map((item) => ({ projectId: item.project.id, submittedAt: item.submittedAt })),
      reports.map((item) => ({ projectId: item.project.id, reportType: item.reportType, status: item.status }))
    )
  }

  private async requireReviewStage(projectId: string): Promise<StudentProjectStageEntity> {
    const stage = await this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_REVIEW" } })
    if (!stage) throw new NotFoundException("运行结果评价阶段不存在")
    return stage
  }

  private async lockReviewStage(manager: EntityManager, projectId: string): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "SHOW_REVIEW" }, lock: { mode: "pessimistic_write" } })
    if (!stage) throw new NotFoundException("运行结果评价阶段不存在")
    return stage
  }

  private async lockEvaluation(manager: EntityManager, projectId: string): Promise<ProjectEvaluationEntity> {
    const evaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId }, lock: { mode: "pessimistic_write" } })
    if (!evaluation) throw new NotFoundException("项目评价不存在")
    return evaluation
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager) {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return { project, actor: "STUDENT" as const }
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" as const }
    throw new ForbiddenException("无权访问该学生项目")
  }

  private requireShowProject(project: StudentProjectEntity): void {
    if (project.snapshot.sceneType !== "CITY_SHOW") throw new BadRequestException("该接口仅用于编队表演项目")
  }
}

function reviewPublishBlockedReason(
  actor: "STUDENT" | "TEACHER",
  stageStatus: StudentProjectStageEntity["status"],
  evaluationStatus: ProjectEvaluationEntity["status"],
  scores: ShowTeacherScoreView[],
  summary: string
): string | null {
  if (actor !== "TEACHER") return "仅教师可以发布综合评价"
  if (evaluationStatus === "PUBLISHED") return "评价已发布，评分与报告已锁定"
  if (stageStatus !== "SUBMITTED") return "学生提交飞后总结后才能发布评价"
  return teacherEvaluationContentBlockedReason(scores, summary)
}

interface ShowCohortStageEvidence {
  projectId: string
  stageCode: V3StageCode
  status: StageStatus
}

interface ShowCohortDocumentEvidence {
  projectId: string
  templateCode: ShowDocumentTemplateCode
  status: string
}

interface ShowCohortPreflightEvidence {
  projectId: string
  status: string
}

interface ShowCohortClockEvidence {
  projectId: string
  submittedAt: Date | null
}

interface ShowCohortReportEvidence {
  projectId: string
  reportType: string
  status: string
}

export function computeShowCohortAnalytics(
  assignmentId: string,
  projects: Array<Pick<StudentProjectEntity, "id" | "status">>,
  evaluations: Array<Pick<ProjectEvaluationEntity, "projectId" | "status" | "totalScore" | "objectiveMetrics" | "teacherScores" | "studentSubmittedAt">>,
  events: Array<Pick<RuntimeEventEntity, "category" | "triggeredAt">>,
  stages: ShowCohortStageEvidence[],
  documents: ShowCohortDocumentEvidence[],
  preflight: ShowCohortPreflightEvidence[],
  clocks: ShowCohortClockEvidence[],
  reports: ShowCohortReportEvidence[]
): ShowReviewCohortAnalyticsView {
  const published = evaluations.filter((item) => item.status === "PUBLISHED" && item.totalScore !== null)
  const riskCounts = new Map<string, { label: string; count: number }>()
  const errorCounts = new Map<string, { label: string; count: number }>()
  const omissionCounts = new Map<string, { label: string; count: number }>()
  const responseSeconds: number[] = []
  for (const evaluation of evaluations) {
    for (const metric of evaluation.objectiveMetrics as unknown as ShowObjectiveMetricView[]) {
      if (metric.code === "AVG_RESPONSE_SECONDS" && typeof metric.value === "number") responseSeconds.push(metric.value)
      if (metric.state !== "RISK") continue
      incrementCohortMetric(riskCounts, metric.code, metric.label)
      incrementCohortMetric(errorCounts, `OBJECTIVE:${metric.code}`, metric.label)
    }
    if (evaluation.status !== "PUBLISHED") continue
    for (const score of evaluation.teacherScores as unknown as ShowTeacherScoreView[]) {
      if (score.score === null || score.maxScore <= 0 || score.score / score.maxScore >= 0.6) continue
      incrementCohortMetric(errorCounts, `TEACHER:${score.code}`, `${score.label}（教师低分）`)
    }
  }

  const stageKeys = new Set(stages.filter((item) => ["SUBMITTED", "ACCEPTED"].includes(item.status)).map((item) => `${item.projectId}:${item.stageCode}`))
  const submittedDocumentKeys = new Set(documents.filter((item) => ["SUBMITTED", "VIEWED", "RESUBMITTED"].includes(item.status)).map((item) => `${item.projectId}:${item.templateCode}`))
  const completedPreflight = new Set(preflight.filter((item) => item.status === "COMPLETED").map((item) => item.projectId))
  const submittedT60 = new Set(clocks.filter((item) => item.submittedAt !== null).map((item) => item.projectId))
  const submittedEndReports = new Set(reports.filter((item) => item.reportType === "FLIGHT_END" && item.status === "SUBMITTED").map((item) => item.projectId))
  const submittedSummaries = new Set(evaluations.filter((item) => item.studentSubmittedAt !== null).map((item) => item.projectId))
  for (const project of projects) {
    if (project.status === "NOT_STARTED") {
      incrementCohortMetric(omissionCounts, "TASK_NOT_STARTED", "任务尚未开始")
      continue
    }
    if (!stageKeys.has(`${project.id}:SHOW_AREA_PLANNING`)) incrementCohortMetric(omissionCounts, "AREA_PLAN", "区域规划未提交")
    for (const [templateCode, label] of showDocumentOmissionLabels) {
      if (!submittedDocumentKeys.has(`${project.id}:${templateCode}`)) incrementCohortMetric(omissionCounts, `DOCUMENT:${templateCode}`, `${label}未提交`)
    }
    if (!completedPreflight.has(project.id)) incrementCohortMetric(omissionCounts, "PREFLIGHT", "飞前检查未完成")
    if (!submittedT60.has(project.id)) incrementCohortMetric(omissionCounts, "T60_REPORT", "起飞前一小时申请未提交")
    if (!submittedEndReports.has(project.id)) incrementCohortMetric(omissionCounts, "FLIGHT_END_REPORT", "飞行结束报备未提交")
    if (!submittedSummaries.has(project.id)) incrementCohortMetric(omissionCounts, "REVIEW_SUMMARY", "飞后总结未提交")
  }

  const triggeredEvents = events.filter((item) => item.triggeredAt)
  const eventCounts = new Map<string, number>()
  for (const event of triggeredEvents) eventCounts.set(event.category, (eventCounts.get(event.category) ?? 0) + 1)
  const completedCount = projects.filter((item) => item.status === "GRADED").length
  return {
    assignmentId,
    projectCount: projects.length,
    completedCount,
    completionRate: ratio(completedCount, projects.length),
    publishedCount: published.length,
    averageScore: published.length ? round(published.reduce((sum, item) => sum + Number(item.totalScore), 0) / published.length, 1) : null,
    averageResponseSeconds: responseSeconds.length ? round(responseSeconds.reduce((sum, item) => sum + item, 0) / responseSeconds.length, 1) : null,
    commonOmissions: cohortMetrics(omissionCounts, projects.length, 8),
    errorTypes: cohortMetrics(errorCounts, evaluations.length, 8),
    commonRisks: cohortMetrics(riskCounts, evaluations.length, 6),
    eventTypes: [...eventCounts.entries()]
      .map(([code, count]) => ({ code, label: eventCategoryLabel(code), count, ratio: ratio(count, triggeredEvents.length) }))
      .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
  }
}

const showDocumentOmissionLabels: ReadonlyArray<readonly [ShowDocumentTemplateCode, string]> = [
  ["AIRSPACE_APPLICATION_FORM", "临时飞行空域申请表"],
  ["AIRSPACE_APPLICATION_LETTER", "临时飞行空域申请函"],
  ["SAFETY_EMERGENCY_PLAN", "安全应急预案"]
]

function incrementCohortMetric(target: Map<string, { label: string; count: number }>, code: string, label: string): void {
  const current = target.get(code) ?? { label, count: 0 }
  current.count += 1
  target.set(code, current)
}

function cohortMetrics(target: Map<string, { label: string; count: number }>, denominator: number, limit: number) {
  return [...target.entries()]
    .map(([code, value]) => ({ code, label: value.label, count: value.count, ratio: ratio(value.count, denominator) }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, limit)
}

export function computeShowObjectiveMetrics(
  sources: Pick<ReviewSources, "session" | "events" | "alerts" | "actions" | "reports">,
  programChecks: readonly V3ResourceValidationCheck[] = []
): ShowObjectiveMetricView[] {
  const triggered = sources.events.filter((item) => item.triggeredAt)
  const detected = triggered.filter((item) => eventNumber(item, "detectedSimulationTimeMs") !== null)
  const controlled = triggered.filter((item) => eventNumber(item, "controlledSimulationTimeMs") !== null || item.status === "RESOLVED")
  const escalated = triggered.filter((item) => (eventNumber(item, "escalationCount") ?? 0) > 0)
  const responseSeconds = triggered.flatMap((event) => {
    const detectedAt = eventNumber(event, "detectedSimulationTimeMs")
    if (detectedAt === null) return []
    const first = sources.actions.filter((action) => action.eventId === event.id && Number(action.simulationTimeMs) >= detectedAt).sort((left, right) => Number(left.simulationTimeMs) - Number(right.simulationTimeMs))[0]
    return first ? [Math.max(0, Number(first.simulationTimeMs) - detectedAt) / 1_000] : []
  })
  const endReport = sources.reports.find((item) => item.reportType === "FLIGHT_END")
  const actualTakeoffCount = Number(endReport?.snapshot.actualTakeoffCount ?? 0)
  const normalLandedCount = Number(endReport?.snapshot.normalLandedCount ?? 0)
  const abnormalCount = Number(endReport?.snapshot.abnormalCount ?? 0)
  const authoritativeNormalLandedCount = Number(endReport?.snapshot.authoritativeNormalLandedCount ?? endReport?.snapshot.suggestedNormalLandedCount ?? 0)
  const authoritativeAbnormalCount = Number(endReport?.snapshot.authoritativeAbnormalCount ?? endReport?.snapshot.suggestedAbnormalCount ?? 0)
  const reportedStatus = String(endReport?.snapshot.completionStatus ?? "")
  const expectedStatus = String(endReport?.snapshot.runtimeStatus ?? "") === "ABORTED" ? "ABORTED" : authoritativeAbnormalCount > 0 ? "ABNORMAL" : "NORMAL"
  const landingAnswerCorrect = endReport?.status === "SUBMITTED"
    && normalLandedCount === authoritativeNormalLandedCount
    && abnormalCount === authoritativeAbnormalCount
    && reportedStatus === expectedStatus
  const acknowledged = sources.alerts.filter((item) => item.status === "ACKNOWLEDGED" || item.status === "RESOLVED").length
  const averageResponseSeconds = responseSeconds.length ? round(responseSeconds.reduce((sum, value) => sum + value, 0) / responseSeconds.length, 1) : 0
  const deadlineResults = sources.actions.map((action) => action.result?.withinDeadline).filter((value): value is boolean => typeof value === "boolean")
  const deadlinePassRate = ratio(deadlineResults.filter(Boolean).length, deadlineResults.length) * 100
  const flightTimeSeconds = sources.session ? Math.max(0, Number(sources.session.simulationTimeMs) / 1_000) : null
  const failedProgramChecks = programChecks.filter((check) => !check.passed)
  const programCheckDetail = programChecks.length === 0
    ? "未引用导入表演轨迹或资源未提供校验结果"
    : failedProgramChecks.length === 0
      ? `${programChecks.length} 项轨迹校验通过`
      : `${failedProgramChecks.length} 项轨迹校验未通过：${failedProgramChecks.map((check) => check.message).join("；")}`
  return [
    metric("PROCESS_COMPLETION", "流程完成度", endReport?.status === "SUBMITTED" ? 100 : 0, "%", endReport?.status === "SUBMITTED" ? "PASS" : "RISK", endReport?.status === "SUBMITTED" ? "飞行结束报备已提交" : "飞行结束报备未提交"),
    metric("FLIGHT_TIME", "表演运行时长", flightTimeSeconds === null ? "未生成" : flightTimeSeconds, flightTimeSeconds === null ? null : "秒", flightTimeSeconds === null ? "INFO" : "INFO", flightTimeSeconds === null ? "运行尚未开始" : "按统一仿真时钟计算"),
    metric("RISK_IDENTIFICATION", "风险识别率", ratio(detected.length, triggered.length) * 100, "%", triggered.length === 0 || detected.length === triggered.length ? "PASS" : "RISK", `${detected.length}/${triggered.length} 个运行事件已发现`),
    metric("AVG_RESPONSE_SECONDS", "平均首次处置时效", averageResponseSeconds, "秒", averageResponseSeconds <= 60 ? "PASS" : "RISK", responseSeconds.length ? `按 ${responseSeconds.length} 个可匹配事件统计` : "无可匹配处置事件"),
    metric("ACTION_DEADLINE", "处置时限达标率", deadlinePassRate, "%", deadlineResults.length === 0 || deadlinePassRate === 100 ? "PASS" : "RISK", deadlineResults.length ? `${deadlineResults.filter(Boolean).length}/${deadlineResults.length} 次关联处置在教师设定时限内` : "教师未设置处置时限"),
    metric("EVENT_CONTROL", "事件控制率", ratio(controlled.length, triggered.length) * 100, "%", triggered.length === 0 || controlled.length === triggered.length ? "PASS" : "RISK", `${controlled.length}/${triggered.length} 个运行事件已控制或结束`),
    metric("EVENT_ESCALATION", "事件升级数量", escalated.length, "个", escalated.length === 0 ? "PASS" : "RISK", escalated.length ? "存在未及时控制并升级的事件" : "未发生事件升级"),
    metric("ALERT_ACKNOWLEDGEMENT", "告警确认率", ratio(acknowledged, sources.alerts.length) * 100, "%", sources.alerts.length === 0 || acknowledged === sources.alerts.length ? "PASS" : "RISK", `${acknowledged}/${sources.alerts.length} 条告警已确认或解决`),
    metric("LANDING_ACCOUNTING", "降落清点一致性", normalLandedCount + abnormalCount === actualTakeoffCount ? "一致" : "不一致", null, normalLandedCount + abnormalCount === actualTakeoffCount ? "PASS" : "RISK", `实际起飞 ${actualTakeoffCount} 架，正常 ${normalLandedCount} 架，异常 ${abnormalCount} 架`),
    metric("LANDING_ACCURACY", "降落判定正确性", landingAnswerCorrect ? "正确" : "待核对", null, endReport?.status !== "SUBMITTED" ? "INFO" : landingAnswerCorrect ? "PASS" : "RISK", `系统计算结果：正常 ${authoritativeNormalLandedCount} 架，异常 ${authoritativeAbnormalCount} 架，状态 ${expectedStatus}`),
    metric("MISSION_RESULT", "固定程序结果", sources.session?.status ?? "未运行", null, sources.session?.status === "COMPLETED" ? "PASS" : sources.session?.status === "ABORTED" ? "RISK" : "INFO", sources.session?.status === "COMPLETED" ? "固定表演程序正常完成" : `运行状态：${sources.session?.status ?? "无"}`),
    metric("PROGRAM_SPATIAL_CHECK", "表演轨迹空间检查", failedProgramChecks.length === 0 ? "通过" : "不通过", null, programChecks.length === 0 ? "INFO" : failedProgramChecks.length === 0 ? "PASS" : "RISK", programCheckDetail)
  ]
}

export function buildShowReplayTimeline(sources: ReviewSources): ShowReplayTimelineItemView[] {
  const items: ShowReplayTimelineItemView[] = []
  const activities = currentAttemptActivities(sources.session, sources.activities)
  const runtimeEvidence = buildRuntimeEvidence({ events: sources.events, actions: sources.actions })
  const evidenceBySourceId = new Map(runtimeEvidence.map((evidence) => [evidence.id, evidence]))
  const eventById = new Map(sources.events.map((event) => [event.id, event]))
  const alertById = new Map(sources.alerts.map((alert) => [alert.id, alert]))
  const runtimeCorrelations = new Set([
    ...sources.events.map((event) => event.correlationId),
    ...sources.alerts.map((alert) => alert.correlationId),
    ...sources.actions.map((action) => action.correlationId)
  ].filter((value): value is string => Boolean(value)))
  const runtimeActivities = activities.filter((activity) => {
    if (!activity.eventType.startsWith("RUNTIME_EVENT_")) return false
    if (activity.objectId && (eventById.has(activity.objectId) || alertById.has(activity.objectId))) return true
    return Boolean(activity.correlationId && runtimeCorrelations.has(activity.correlationId))
  })
  for (const activity of activities.filter((item) => ["STAGE_STARTED", "T60_REPORT_SUBMITTED", "TAKEOFF_REPORTED", "FLIGHT_END_REPORT_SUBMITTED"].includes(item.eventType))) {
    items.push({
      id: `STAGE:${activity.id}`,
      sourceId: activity.id,
      kind: activity.eventType === "FLIGHT_END_REPORT_SUBMITTED" ? "REPORT" : "STAGE",
      simulationTimeMs: nullableNumber(activity.simulationTimeMs),
      realTime: activity.realTime.toISOString(),
      title: activityTitle(activity.eventType),
      detail: activity.actorName,
      status: "RECORDED",
      severity: null,
      correlationId: activity.correlationId,
      payload: { stageCode: activity.stageCode, ...activity.result }
    })
  }
  for (const snapshot of sources.snapshots) {
    items.push({
      id: `STATE:${snapshot.id}`,
      sourceId: snapshot.id,
      kind: "STATE",
      simulationTimeMs: Number(snapshot.simulationTimeMs),
      realTime: snapshot.createdAt.toISOString(),
      title: phaseLabel(snapshot.phase),
      detail: `在航 ${snapshot.totals.airborneCount} 架，已降落 ${snapshot.totals.landedCount} 架，异常 ${snapshot.totals.abnormalCount} 架`,
      status: snapshot.phase,
      severity: snapshot.totals.abnormalCount > 0 ? "WARNING" : null,
      correlationId: null,
      payload: { reason: snapshot.reason, totals: snapshot.totals, groups: snapshot.groups }
    })
  }
  for (const event of sources.events.filter((item) => item.triggeredAt)) {
    const eventActivities = runtimeActivities.filter((activity) => activity.objectId === event.id || activity.correlationId === event.correlationId)
    const triggered = eventActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_TRIGGERED")
    const escalated = eventActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_ESCALATED")
    const resolved = eventActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_RESOLVED")
    if (triggered.length === 0) {
      items.push({
        id: `EVENT:${event.id}`,
        sourceId: event.id,
        kind: "EVENT",
        simulationTimeMs: evidenceBySourceId.get(event.id)?.simulationTimeMs ?? nullableNumber(event.scheduledSimulationTimeMs),
        realTime: event.triggeredAt!.toISOString(),
        title: String(event.payload.title ?? event.code),
        detail: String(event.payload.detail ?? event.category),
        status: String(event.payload.lifecycleStatus ?? event.status),
        severity: event.severity,
        correlationId: event.correlationId,
        payload: { ...event.payload, runtimeEvidenceSequence: evidenceBySourceId.get(event.id)?.sequence ?? null }
      })
    } else {
      for (const activity of triggered) items.push(eventTransitionItem(event, activity, "TRIGGERED", evidenceBySourceId.get(event.id)?.sequence ?? null))
      for (const activity of escalated) items.push(eventTransitionItem(event, activity, "ESCALATED", evidenceBySourceId.get(event.id)?.sequence ?? null))
      for (const activity of resolved) items.push(eventTransitionItem(event, activity, "RESOLVED", evidenceBySourceId.get(event.id)?.sequence ?? null))
      for (const action of sources.actions.filter((item) => item.eventId === event.id && object(item.result).eventControlled === true)) {
        items.push({
          id: `EVENT_CONTROLLED:${action.id}`,
          sourceId: action.id,
          kind: "EVENT",
          simulationTimeMs: Number(action.simulationTimeMs),
          realTime: (action.appliedAt ?? action.requestedAt).toISOString(),
          title: `${String(event.payload.title ?? event.code)}已控制`,
          detail: `${actionLabel(action.actionCode)}执行后，${actionResultSummary(action.result)}`,
          status: "CONTROLLED",
          severity: event.severity,
          correlationId: event.correlationId,
          payload: { actionId: action.id, actionCode: action.actionCode, result: action.result, runtimeEvidenceSequence: evidenceBySourceId.get(action.id)?.sequence ?? null }
        })
      }
    }
  }
  for (const alert of sources.alerts) {
    const alertActivities = runtimeActivities.filter((activity) => activity.objectId === alert.id || activity.correlationId === alert.correlationId)
    const discovered = alertActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_DISCOVERED")
    const escalated = alertActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_ESCALATED")
    const resolved = alertActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_RESOLVED")
    if (discovered.length === 0) items.push(alertTransitionItem(alert, null, "OPEN"))
    else for (const activity of discovered) items.push(alertTransitionItem(alert, activity, "OPEN"))
    for (const activity of escalated) items.push(alertTransitionItem(alert, activity, "ESCALATED"))

    const acknowledgements = sources.actions.filter((action) => action.alertId === alert.id && action.actionCode === "ACKNOWLEDGE_ALERT")
    if (acknowledgements.length === 0 && alert.acknowledgedAt) items.push(alertTransitionItem(alert, null, "ACKNOWLEDGED", alert.acknowledgedAt))
    for (const action of acknowledgements) {
      items.push({
        id: `ALERT_ACKNOWLEDGED:${action.id}`,
        sourceId: action.id,
        kind: "ALERT",
        simulationTimeMs: Number(action.simulationTimeMs),
        realTime: (action.appliedAt ?? action.requestedAt).toISOString(),
        title: `${alert.title}已确认`,
        detail: `${actionLabel(action.actionCode)}，告警已由学生确认`,
        status: "ACKNOWLEDGED",
        severity: alert.severity,
        correlationId: alert.correlationId,
        payload: { actionId: action.id, actionCode: action.actionCode, result: action.result, runtimeEvidenceSequence: evidenceBySourceId.get(action.id)?.sequence ?? null }
      })
    }

    if (resolved.length === 0 && alert.resolvedAt) items.push(alertTransitionItem(alert, null, "RESOLVED", alert.resolvedAt))
    else for (const activity of resolved) items.push(alertTransitionItem(alert, activity, "RESOLVED"))
  }
  for (const action of sources.actions) {
    const reasoning = runtimeActionReasoningFromPayload(action.payload)
    items.push({
      id: `ACTION:${action.id}`,
      sourceId: action.id,
      kind: "ACTION",
      simulationTimeMs: Number(action.simulationTimeMs),
      realTime: action.requestedAt.toISOString(),
      title: actionLabel(action.actionCode),
      detail: actionTimelineDetail(action.targetType, action.targetId, reasoning, action.result),
      status: action.status,
      severity: action.status === "FAILED" || action.status === "REJECTED" ? "ERROR" : null,
      correlationId: action.correlationId,
      payload: { ...action.payload, result: action.result, runtimeEvidenceSequence: evidenceBySourceId.get(action.id)?.sequence ?? null }
    })
  }
  return items.sort((left, right) => Date.parse(left.realTime) - Date.parse(right.realTime) || (left.simulationTimeMs ?? 0) - (right.simulationTimeMs ?? 0) || left.id.localeCompare(right.id))
}

function eventTransitionItem(event: RuntimeEventEntity, activity: ProjectActivityEventEntity, status: "TRIGGERED" | "ESCALATED" | "RESOLVED", runtimeEvidenceSequence: number | null): ShowReplayTimelineItemView {
  const severity = activitySeverity(activity, event.severity)
  const affectedCount = nullableNumber(activity.result.affectedCount ?? activity.payload.affectedCount)
  const title = String(activity.payload.title ?? event.payload.title ?? event.code)
  const detail = status === "ESCALATED"
    ? `事件升级为${alertSeverityLabel(severity)}${affectedCount === null ? "" : `，影响 ${affectedCount} 架无人机`}`
    : status === "RESOLVED"
      ? "事件已控制或恢复，运行状态变化已固化"
      : String(activity.payload.detail ?? event.payload.detail ?? event.category)
  return {
    id: `EVENT_${status}:${activity.id}`,
    sourceId: activity.id,
    kind: "EVENT",
    simulationTimeMs: nullableNumber(activity.simulationTimeMs),
    realTime: activity.realTime.toISOString(),
    title: status === "ESCALATED" ? `${title}升级` : status === "RESOLVED" ? `${title}已解除` : title,
    detail,
    status,
    severity,
    correlationId: activity.correlationId ?? event.correlationId,
    payload: { transition: status, ...activity.payload, ...activity.result, runtimeEvidenceSequence }
  }
}

function alertTransitionItem(
  alert: RuntimeAlertEntity,
  activity: ProjectActivityEventEntity | null,
  status: "OPEN" | "ESCALATED" | "ACKNOWLEDGED" | "RESOLVED",
  occurredAt?: Date
): ShowReplayTimelineItemView {
  const severity = activity ? activitySeverity(activity, alert.severity) : alert.severity
  const affectedCount = activity ? nullableNumber(activity.result.affectedCount ?? activity.payload.affectedCount) : nullableNumber(alert.payload.affectedCount)
  const baseTitle = String(activity?.payload.title ?? alert.title)
  const detail = status === "ESCALATED"
    ? `告警升级为${alertSeverityLabel(severity)}${affectedCount === null ? "" : `，影响 ${affectedCount} 架无人机`}`
    : status === "ACKNOWLEDGED"
      ? "告警已由学生确认"
      : status === "RESOLVED"
        ? "告警已解除，关联状态变化已记录"
        : String(activity?.payload.detail ?? alert.detail)
  return {
    id: `ALERT_${status}:${activity?.id ?? `${alert.id}:${occurredAt?.toISOString() ?? alert.openedAt.toISOString()}`}`,
    sourceId: activity?.id ?? alert.id,
    kind: "ALERT",
    simulationTimeMs: activity ? nullableNumber(activity.simulationTimeMs) : nullableNumber(alert.simulationTimeMs),
    realTime: (activity?.realTime ?? occurredAt ?? alert.openedAt).toISOString(),
    title: status === "ESCALATED" ? `${baseTitle}升级` : status === "ACKNOWLEDGED" ? `${baseTitle}已确认` : status === "RESOLVED" ? `${baseTitle}已解除` : baseTitle,
    detail,
    status,
    severity,
    correlationId: activity?.correlationId ?? alert.correlationId,
    payload: activity ? { transition: status, ...activity.payload, ...activity.result } : { transition: status, ...alert.payload }
  }
}

function activitySeverity(activity: ProjectActivityEventEntity, fallback: V3AlertSeverity): V3AlertSeverity {
  const value = String(activity.result.severity ?? activity.payload.severity ?? fallback)
  return (["INFO", "WARNING", "ERROR", "CRITICAL"] as const).includes(value as V3AlertSeverity) ? value as V3AlertSeverity : fallback
}

function currentAttemptActivities(session: RuntimeSessionEntity | null, activities: ProjectActivityEventEntity[]): ProjectActivityEventEntity[] {
  if (!session?.createdAt) return activities
  return activities.filter((activity) => activity.realTime >= session.createdAt)
}

function alertSeverityLabel(severity: V3AlertSeverity): string {
  return ({ INFO: "提示", WARNING: "一般", ERROR: "重要", CRITICAL: "紧急" } as const)[severity]
}

export function reportRenderData(snapshot: Record<string, unknown>): ShowReportRenderData {
  const project = object(snapshot.project)
  const area = object(snapshot.area)
  const preflight = object(snapshot.preflight)
  const dynamicReporting = object(snapshot.dynamicReporting)
  const runtime = object(snapshot.runtime)
  const evaluation = object(snapshot.evaluation)
  const metrics = array<ShowObjectiveMetricView>(evaluation.objectiveMetrics)
  const scores = array<ShowTeacherScoreView>(evaluation.teacherScores)
  const documents = array<Record<string, unknown>>(snapshot.documents)
  const events = array<Record<string, unknown>>(snapshot.events)
  const actions = array<Record<string, unknown>>(snapshot.actions)
  const annotations = array<Record<string, unknown>>(snapshot.annotations)
  return {
    title: "城市无人机编队表演仿真实训项目报告",
    subtitle: `${string(project.title)} · ${string(project.studentName)}`,
    metadata: [
      { label: "学生", value: `${string(project.studentName)}（${string(project.studentEmail)}）` },
      { label: "任务模式", value: string(project.mode) === "ASSESSMENT" ? "考核模式" : "训练模式" },
      { label: "规模模板", value: string(project.scaleTemplateCode) },
      { label: "任务快照", value: string(project.checksum) },
      { label: "评价版本", value: `R${number(evaluation.revision)}` },
      { label: "最终成绩", value: `${number(evaluation.totalScore).toFixed(1)} / 100` }
    ],
    sections: [
      {
        title: "项目基本信息",
        rows: [
          { label: "任务简述", value: string(project.taskBrief) },
          { label: "区域包", value: string(project.regionPackageId) },
          { label: "发布时间", value: formatDate(string(project.publishedAt)) },
          { label: "资源版本", value: array<Record<string, unknown>>(project.resourceRefs).map((item) => `${string(item.packageType)} ${string(item.name)}@${string(item.version)}`).join("；") }
        ]
      },
      {
        title: "区域规划",
        rows: [
          { label: "方案版本", value: area.versionNo ? `V${number(area.versionNo)}` : "-" },
          { label: "规则检查", value: object(area.checkResult).passed === true ? "通过" : "存在提示或风险" },
          { label: "教师评分", value: area.reviewScore === null || area.reviewScore === undefined ? "未单独评分" : `${number(area.reviewScore)} 分` },
          { label: "教师意见", value: string(area.reviewComment) || "无" },
          { label: "规划图摘要", value: `${string(object(area.planningMap).name)} ${string(object(area.planningMap).sha256)}`.trim() || "未生成" }
        ]
      },
      {
        title: "飞行申报",
        rows: documents.map((item) => ({ label: string(item.title), value: `${string(item.status)} · V${number(item.versionNo)} · ${string(item.reviewComment) || "无审核意见"}` }))
      },
      {
        title: "飞前准备",
        rows: [
          { label: "检查完成", value: `${number(preflight.completedItems)} / ${number(preflight.totalItems)}` },
          { label: "起飞决策", value: string(preflight.decision) || "-" },
          { label: "判断依据", value: string(preflight.rationale) || "-" },
          { label: "完成时间", value: formatDate(string(preflight.completedAt)) }
        ]
      },
      {
        title: "动态报备",
        rows: [
          { label: "T-60 提交", value: formatDate(string(dynamicReporting.t60SubmittedAt)) },
          ...array<Record<string, unknown>>(dynamicReporting.reports).map((item) => ({ label: string(item.reportType), value: `${string(item.status)} · ${formatDate(string(item.submittedAt))}` }))
        ]
      },
      {
        title: "运行数据",
        rows: [
          { label: "运行结果", value: string(runtime.status) || "-" },
          { label: "仿真时长", value: formatDuration(number(runtime.simulationTimeMs)) },
          { label: "检查点数量", value: String(number(runtime.snapshotCount)) },
          { label: "事件/处置", value: `${events.length} 个事件 / ${actions.length} 次处置` }
        ]
      },
      {
        title: "事件处置",
        paragraphs: [
          ...events.map((item) => `${formatSimulationTime(number(item.scheduledSimulationTimeMs))} ${string(item.category)} / ${string(item.severity)}：${string(object(item.payload).title) || string(item.code)}，状态 ${string(object(item.payload).lifecycleStatus) || string(item.status)}`),
          ...actions.map(actionReportParagraph),
          ...annotations.map((item) => `教师讲评 ${formatSimulationTime(number(item.simulationTimeMs))}：${string(item.comment)}`)
        ]
      },
      {
        title: "评价结果",
        rows: [
          ...metrics.map((item) => ({ label: item.label, value: `${item.displayValue} · ${item.state === "PASS" ? "达标" : item.state === "RISK" ? "需改进" : "记录"} · ${item.detail}` })),
          ...scores.map((item) => ({ label: item.label, value: `${item.score ?? "-"} / ${item.maxScore} · ${item.comment || "无分项意见"}` })),
          { label: "学生飞后总结", value: showStudentSummaryText(string(evaluation.studentSummary)) },
          { label: "教师综合讲评", value: string(evaluation.summary) }
        ]
      }
    ],
    declaration: string(snapshot.declaration) || reportDeclaration
  }
}

function serializeEvaluation(evaluation: ProjectEvaluationEntity): V3ProjectEvaluationView {
  return {
    id: evaluation.id,
    projectId: evaluation.projectId,
    status: evaluation.status,
    rubricVersion: evaluation.rubricVersion,
    objectiveMetrics: evaluation.objectiveMetrics as unknown as ShowObjectiveMetricView[],
    teacherScores: evaluation.teacherScores as unknown as ShowTeacherScoreView[],
    studentSummary: evaluation.studentSummary,
    studentSummaryStructured: parseShowStudentSummary(evaluation.studentSummary),
    studentSubmittedAt: evaluation.studentSubmittedAt?.toISOString() ?? null,
    summary: evaluation.summary,
    totalScore: evaluation.totalScore,
    revision: evaluation.revision,
    reviewedAt: evaluation.reviewedAt?.toISOString() ?? null,
    publishedAt: evaluation.publishedAt?.toISOString() ?? null
  }
}

function serializeReport(report: ShowProjectReportEntity, projectId: string): ShowProjectReportView {
  return {
    id: report.id,
    status: report.status,
    revision: report.revision,
    format: report.format,
    filename: report.asset?.originalName ?? null,
    sizeBytes: report.asset?.sizeBytes ?? null,
    sha256: report.asset?.sha256 ?? null,
    generatedAt: report.generatedAt?.toISOString() ?? null,
    downloadPath: report.asset ? `/v3/show-projects/${projectId}/review/report/download` : null
  }
}

function metric(code: string, label: string, value: number | string, unit: string | null, state: ShowObjectiveMetricView["state"], detail: string): ShowObjectiveMetricView {
  return { code, label, value: typeof value === "number" ? round(value, 1) : value, displayValue: `${typeof value === "number" ? round(value, 1) : value}${unit ?? ""}`, unit, state, detail }
}

function eventNumber(event: RuntimeEventEntity, key: string): number | null {
  const value = event.payload[key]
  const numberValue = Number(value)
  return value === null || value === undefined || !Number.isFinite(numberValue) ? null : numberValue
}

function actionLabel(code: string): string {
  return ({
    ACKNOWLEDGE_ALERT: "确认告警", CONTINUE_MONITORING: "继续监控", PAUSE_NEXT_TAKEOFF: "暂停后续起飞", RESUME_NEXT_TAKEOFF: "恢复后续起飞",
    PAUSE_PROGRAM: "暂停表演", RESUME_PROGRAM: "恢复表演", ABORT_PROGRAM: "中止表演", SINGLE_LAND: "单架降落", BATCH_LAND: "批量降落",
    REMOVE_FROM_MISSION: "移出任务", GROUP_RETURN: "分组返航", GROUP_LAND: "分组降落", SWITCH_EMERGENCY_ZONE: "切换应急降落区",
    MULTI_GROUP_RETURN: "多分组返航", ZONE_LAND: "分区降落", RETURN_ALL: "整体返航", EMERGENCY_LAND_ALL: "整体应急降落"
  } as Record<string, string>)[code] ?? code
}

function actionTimelineDetail(targetType: string, targetId: string | null, reasoning: V3RuntimeActionReasoning | null, result: unknown): string {
  const target = `${targetType}${targetId ? ` · ${targetId}` : ""}`
  const detail = reasoning
    ? `${target}；异常发现：${reasoning.observation}；判断依据：${reasoning.rationale}；预期结果：${reasoning.expectedOutcome}`
    : target
  return `${detail}；结果确认：${actionResultSummary(result)}`
}

function actionReportParagraph(item: Record<string, unknown>): string {
  const reasoning = runtimeActionReasoningFromPayload(item.payload)
  const target = `${string(item.targetType)}${item.targetId ? `/${string(item.targetId)}` : ""}`
  const reasoningText = reasoning
    ? `；异常发现：${reasoning.observation}；判断依据：${reasoning.rationale}；预期结果：${reasoning.expectedOutcome}`
    : string(object(item.payload).rationale) ? `；判断依据：${string(object(item.payload).rationale)}` : ""
  return `${formatSimulationTime(number(item.simulationTimeMs))} ${actionLabel(string(item.actionCode))}，对象 ${target}${reasoningText}；结果确认：${actionResultSummary(item.result)}`
}

function actionResultSummary(value: unknown): string {
  const result = object(value)
  const parts: string[] = []
  if (result.applied === true) parts.push("动作已执行")
  const consequences = Array.isArray(result.businessConsequences)
    ? result.businessConsequences.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  if (consequences.length > 0) parts.push(consequences.join("；"))
  else if (typeof result.outcome === "string" && result.outcome.trim()) parts.push(result.outcome.trim())
  if (result.eventControlled === true) parts.push("事件已控制")
  if (result.withinDeadline === true) parts.push("时限内完成")
  if (result.withinDeadline === false) parts.push("超过处置时限")
  const responseTimeMs = nullableNumber(result.responseTimeMs)
  if (responseTimeMs !== null) parts.push(`响应 ${round(responseTimeMs / 1_000, 1)} 秒`)
  return parts.join("，") || "系统已留存动作结果"
}

function phaseLabel(code: string): string {
  return ({ READY: "运行准备", TAKEOFF_PREPARATION: "起飞准备", BATCH_TAKEOFF: "分批起飞", TRANSIT_TO_SHOW: "转场进入表演区", PERFORMANCE: "固定程序表演", RETURN_TO_LAUNCH: "返航", BATCH_LANDING: "分批降落", COMPLETED: "运行完成", ABORTED: "运行中止" } as Record<string, string>)[code] ?? code
}

function activityTitle(code: string): string {
  return ({ STAGE_STARTED: "项目阶段开始", T60_REPORT_SUBMITTED: "T-60 申请已提交", TAKEOFF_REPORTED: "实际起飞动态已记录", FLIGHT_END_REPORT_SUBMITTED: "飞行结束报备已提交" } as Record<string, string>)[code] ?? code
}

function eventCategoryLabel(code: string): string {
  return ({ WEATHER_ENVIRONMENT: "气象与环境", POSITIONING_NAVIGATION: "定位与导航", COMMUNICATION_LINK: "通信链路", AIRCRAFT_TECHNICAL: "无人机技术" } as Record<string, string>)[code] ?? code
}

function normalizeReportFormat(value: string): "DOCX" | "PDF" {
  const normalized = value.trim().toUpperCase()
  if (normalized !== "DOCX" && normalized !== "PDF") throw new BadRequestException("报告格式必须为 DOCX 或 PDF")
  return normalized
}

function normalizeShowStudentSummary(summaryValue: string, input: Partial<V3StudentReviewSummaryView> | undefined, submit: boolean): { stored: string; text: string; structured: V3StudentReviewSummaryView | null } {
  const structured = input && Object.values(input).some((value) => typeof value === "string" && value.trim().length > 0)
    ? {
        completion: normalizeText(String(input.completion ?? ""), 2_000, "任务完成情况", submit ? 2 : 0),
        problems: normalizeText(String(input.problems ?? ""), 2_000, "主要问题", submit ? 2 : 0),
        decisions: normalizeText(String(input.decisions ?? ""), 2_000, "处置得失", submit ? 2 : 0),
        improvements: normalizeText(String(input.improvements ?? ""), 2_000, "改进措施", submit ? 2 : 0)
      }
    : null
  const text = structured
    ? [structured.completion, structured.problems, structured.decisions, structured.improvements].filter(Boolean).join("\n")
    : summaryValue
  const normalizedText = normalizeText(text, 8_000, "飞后总结", submit ? 20 : 0)
  return { stored: structured ? JSON.stringify({ schemaVersion: 1, ...structured }) : normalizedText, text: normalizedText, structured }
}

export function parseShowStudentSummary(value: string): V3StudentReviewSummaryView | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== 1) return null
    return {
      completion: typeof parsed.completion === "string" ? parsed.completion : "",
      problems: typeof parsed.problems === "string" ? parsed.problems : "",
      decisions: typeof parsed.decisions === "string" ? parsed.decisions : "",
      improvements: typeof parsed.improvements === "string" ? parsed.improvements : ""
    }
  } catch {
    return null
  }
}

function showStudentSummaryText(value: string): string {
  const summary = parseShowStudentSummary(value)
  if (!summary) return value
  return [
    `任务完成情况：${summary.completion}`,
    `主要问题：${summary.problems}`,
    `处置得失：${summary.decisions}`,
    `改进措施：${summary.improvements}`
  ].join("\n")
}

function normalizeText(value: string, maximumLength: number, label: string, minimumLength = 0): string {
  const text = value.trim()
  if (text.length < minimumLength) throw new BadRequestException(`${label}不能少于 ${minimumLength} 个字符`)
  if (text.length > maximumLength) throw new BadRequestException(`${label}不能超过 ${maximumLength} 个字符`)
  return text
}

function normalizeIdentifier(value: string | undefined, maximumLength: number, message: string): string {
  const text = value?.trim() ?? ""
  if (!text) throw new BadRequestException(message)
  if (text.length > maximumLength) throw new BadRequestException("节点标识过长")
  return text
}

function normalizeSimulationTime(value: number | null): number | null {
  if (value === null) return null
  const numberValue = Number(value)
  if (!Number.isFinite(numberValue) || numberValue < 0) throw new BadRequestException("仿真时间无效")
  return Math.round(numberValue)
}

function assertRevision(current: number, input: number | undefined): void {
  const expected = Number(input)
  if (!Number.isInteger(expected) || expected < 1) throw new BadRequestException("expectedRevision 必须为正整数")
  if (current !== expected) throw new ConflictException(`评价版本冲突，当前版本为 ${current}`)
}

function hashSnapshot(snapshot: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex")
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator, 4) : 1
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "项目"
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function array<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

function string(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value)
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date) : "-"
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
}

function formatSimulationTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `T+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}
