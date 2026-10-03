import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { createHash, randomUUID } from "node:crypto"
import { DataSource, EntityManager, Repository } from "typeorm"
import type {
  AuthUser,
  ShowObjectiveMetricView,
  ShowReplayTimelineItemView,
  ShowTeacherScoreView,
  VtlAircraftReviewView,
  VtlReplayFrameView,
  VtlReviewView
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { canonicalJson } from "../common/canonical-json.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { V3FileStorageService } from "../files/file-storage.service.js"
import { ProjectEvaluationEntity, RuntimeAlertEntity, RuntimeEventEntity, RuntimeSessionEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { frozenTeacherScoresComplete, normalizeFrozenTeacherScores, teacherEvaluationContentBlockedReason, totalFrozenTeacherScore } from "../resources/evaluation-rubric.js"
import { ResourcePackageService } from "../resources/resource-package.service.js"
import { VtlProjectPlanEntity } from "../vtl-inspection/vtl-inspection.entities.js"
import { VtlReorganizationEntity, VtlRuntimeSnapshotEntity } from "../vtl-runtime/vtl-runtime.entities.js"
import { ShowProjectReportEntity } from "../show-review/show-review.entities.js"
import { createVtlReportDocx, createVtlReportPdf } from "./vtl-report.renderer.js"
import { TransactionalOutboxService } from "../jobs/transactional-outbox.service.js"
import { VTL_REPORT_GENERATE_JOB } from "../jobs/job-types.js"
import { JobEntity, OutboxEventEntity, type V3JobStatus } from "../jobs/job.entities.js"
import { assessmentTimingForProject } from "../assessment/assessment-window.service.js"
import { runtimeActionReasoningFromPayload } from "../runtime/runtime-action-reasoning.js"
import { buildRuntimeEvidence } from "../runtime/runtime-evidence.js"
import { canAccessFullReviewReport, normalizeReviewResultVisibility } from "../show-review/review-visibility.js"

interface VtlEvidence {
  plan: VtlProjectPlanEntity
  session: RuntimeSessionEntity
  events: RuntimeEventEntity[]
  alerts: RuntimeAlertEntity[]
  actions: StudentRuntimeActionEntity[]
  snapshots: VtlRuntimeSnapshotEntity[]
  reorganizations: VtlReorganizationEntity[]
  taskObjects: VtlProjectPlanEntity["taskObjects"]
  completedTaskObjectIds: string[]
  incompleteTaskObjects: Array<{ taskObjectId: string; reason: string }>
  aircraftResults: VtlAircraftReviewView[]
  eventResolutionRate: number
  metrics: ShowObjectiveMetricView[]
  timeline: ShowReplayTimelineItemView[]
}

@Injectable()
export class VtlReviewService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ProjectEvaluationEntity) private readonly evaluations: Repository<ProjectEvaluationEntity>,
    @InjectRepository(RuntimeSessionEntity) private readonly sessions: Repository<RuntimeSessionEntity>,
    @InjectRepository(RuntimeEventEntity) private readonly events: Repository<RuntimeEventEntity>,
    @InjectRepository(RuntimeAlertEntity) private readonly alerts: Repository<RuntimeAlertEntity>,
    @InjectRepository(StudentRuntimeActionEntity) private readonly actions: Repository<StudentRuntimeActionEntity>,
    @InjectRepository(VtlProjectPlanEntity) private readonly plans: Repository<VtlProjectPlanEntity>,
    @InjectRepository(VtlRuntimeSnapshotEntity) private readonly snapshots: Repository<VtlRuntimeSnapshotEntity>,
    @InjectRepository(VtlReorganizationEntity) private readonly reorganizations: Repository<VtlReorganizationEntity>,
    @InjectRepository(ShowProjectReportEntity) private readonly reports: Repository<ShowProjectReportEntity>,
    @InjectRepository(FileAssetEntity) private readonly assets: Repository<FileAssetEntity>,
    @InjectRepository(JobEntity) private readonly jobs: Repository<JobEntity>,
    @InjectRepository(OutboxEventEntity) private readonly outboxEvents: Repository<OutboxEventEntity>,
    @InjectRepository(ProjectActivityEventEntity) private readonly activityEvents: Repository<ProjectActivityEventEntity>,
    private readonly storage: V3FileStorageService,
    private readonly activityLog: ActivityLogService,
    private readonly dataSource: DataSource,
    private readonly outbox: TransactionalOutboxService,
    private readonly resourcePackages: ResourcePackageService
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<VtlReviewView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const stage = await this.requireReviewStage(projectId)
    if (actor === "STUDENT" && ["LOCKED", "AVAILABLE", "RETURNED"].includes(stage.status)) throw new ConflictException("请先开始巡检复盘评价阶段")
    const evidence = await this.loadEvidence(projectId)
    const evaluation = await this.ensureEvaluation(project, evidence.metrics)
    if (evaluation.status !== "PUBLISHED" && canonicalJson(evaluation.objectiveMetrics) !== canonicalJson(evidence.metrics)) {
      evaluation.objectiveMetrics = evidence.metrics
      await this.evaluations.save(evaluation)
    }
    const report = await this.reports.findOne({ where: { project: { id: projectId } } })
    const reportJob = await this.findReportJob(projectId)
    const publishBlockedReason = reviewPublishBlockedReason(actor, stage.status, evaluation.status, evaluation.teacherScores as unknown as ShowTeacherScoreView[], evaluation.summary)
    const assessmentWritable = assessmentTimingForProject(project).canWrite
    const visibility = vtlReviewVisibility(actor, project.snapshot.mode, project.snapshot.config.resultVisibility, evaluation.status)
    return {
      projectId,
      actor,
      evaluationStatus: evaluation.status,
      evaluationRevision: evaluation.revision,
      totalScore: evaluation.status === "PUBLISHED" || actor === "TEACHER" || project.snapshot.mode === "TRAINING" ? evaluation.totalScore : null,
      canEditSummary: actor === "STUDENT" && assessmentWritable && stage.status === "IN_PROGRESS" && !evaluation.studentSubmittedAt,
      canSubmitSummary: actor === "STUDENT" && assessmentWritable && stage.status === "IN_PROGRESS" && !evaluation.studentSubmittedAt,
      canReview: actor === "TEACHER" && stage.status === "SUBMITTED" && evaluation.status !== "PUBLISHED",
      canPublish: publishBlockedReason === null,
      publishBlockedReason,
      objectiveMetrics: visibility.full ? evidence.metrics : [],
      timeline: visibility.full ? evidence.timeline : [],
      replayFrames: visibility.full ? evidence.snapshots.map(serializeReplayFrame) : [],
      taskCoverageRatio: visibility.full ? evidence.completedTaskObjectIds.length / Math.max(1, evidence.taskObjects.length) : 0,
      completedTaskObjectIds: visibility.full ? evidence.completedTaskObjectIds : [],
      incompleteTaskObjects: visibility.full ? evidence.incompleteTaskObjects : [],
      aircraftResults: visibility.full ? evidence.aircraftResults : [],
      eventResolutionRate: visibility.full ? evidence.eventResolutionRate : 0,
      reorganizations: visibility.full ? evidence.reorganizations.map(serializeReorganization) : [],
      studentSummary: evaluation.studentSummary,
      teacherScores: visibility.full ? evaluation.teacherScores as unknown as ShowTeacherScoreView[] : visibility.dimensions ? (evaluation.teacherScores as unknown as ShowTeacherScoreView[]).map((score) => ({ ...score, comment: "" })) : [],
      teacherSummary: visibility.full ? evaluation.summary : "",
      reportAssetId: visibility.full ? report?.asset?.id ?? null : null,
      report: visibility.full && report ? { id: report.id, status: report.status, format: report.format, filename: report.asset?.originalName ?? null } : null,
      reportJob: visibility.full ? reportJob : null
    }
  }

  private async findReportJob(projectId: string): Promise<VtlReviewView["reportJob"]> {
    const outboxEvent = await this.outboxEvents.findOne({
      where: { aggregateType: "VTL_PROJECT", aggregateId: projectId, jobType: VTL_REPORT_GENERATE_JOB },
      order: { createdAt: "DESC" }
    })
    if (!outboxEvent) return null

    const format = normalizeReportFormat(String(outboxEvent.payload.format ?? "PDF"))
    const job = outboxEvent.status === "PUBLISHED" && outboxEvent.id
      ? await this.jobs.findOne({ where: { sourceOutboxEventId: outboxEvent.id }, order: { createdAt: "DESC" } })
      : null
    if (!job) {
      return {
        id: outboxEvent.id,
        status: outboxEvent.status === "FAILED" && outboxEvent.attempts >= outboxEvent.maxAttempts ? "DEAD_LETTER" : "PENDING",
        format,
        error: outboxEvent.lastError,
        requestedAt: outboxEvent.createdAt.toISOString(),
        finishedAt: null
      }
    }
    return {
      id: job.id,
      status: mapReportJobStatus(job.status),
      format: normalizeReportFormat(String(job.payload.format ?? outboxEvent.payload.format ?? "PDF")),
      error: job.lastError,
      requestedAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null
    }
  }

  async saveStudentSummary(projectId: string, user: AuthUser, expectedRevision: number, summary: string, submit: boolean): Promise<VtlReviewView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以填写巡检复盘")
      const stage = await this.lockReviewStage(manager, projectId)
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("巡检复盘阶段不在编辑状态")
      const evaluation = await this.lockEvaluation(manager, project, manager)
      if (evaluation.status === "PUBLISHED") throw new ConflictException("评价已发布，不能继续修改")
      assertRevision(expectedRevision, evaluation.revision)
      const normalized = normalizeText(summary, 5_000, "巡检复盘")
      if (submit && normalized.length < 10) throw new ConflictException("巡检复盘至少需要 10 个字符")
      const beforeRevision = evaluation.revision
      evaluation.studentSummary = normalized
      if (submit) {
        const submittedAt = new Date()
        evaluation.studentSubmittedAt = submittedAt
        stage.status = "SUBMITTED"
        stage.submittedAt = submittedAt
        stage.revision += 1
        project.status = "EVALUATING"
        if (project.snapshot.mode === "ASSESSMENT") {
          project.assessmentSubmittedAt ??= submittedAt
          project.assessmentEndedAt ??= submittedAt
        }
        project.lastActivityAt = submittedAt
      }
      evaluation.revision += 1
      await manager.save([evaluation, stage, project])
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "VTL_REVIEW",
        actor: user,
        eventType: submit ? "REVIEW_SUMMARY_SUBMITTED" : "REVIEW_SUMMARY_SAVED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        beforeRevision,
        afterRevision: evaluation.revision,
        result: { submitted: submit }
      })
    })
    return this.workspace(projectId, user)
  }

  async saveTeacherEvaluation(projectId: string, user: AuthUser, input: { expectedRevision?: number; teacherScores?: ShowTeacherScoreView[]; summary?: string }): Promise<VtlReviewView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以填写巡检评价")
      const stage = await this.lockReviewStage(manager, projectId)
      if (stage.status !== "SUBMITTED") throw new ConflictException("学生尚未提交巡检复盘")
      const evaluation = await this.lockEvaluation(manager, project, manager)
      if (evaluation.status === "PUBLISHED") throw new ConflictException("评价已发布，不能继续修改")
      assertRevision(input.expectedRevision, evaluation.revision)
      const beforeRevision = evaluation.revision
      evaluation.teacherScores = normalizeFrozenTeacherScores(input.teacherScores, evaluation.teacherScores as unknown as ShowTeacherScoreView[])
      evaluation.summary = normalizeText(input.summary ?? evaluation.summary, 5_000, "教师讲评")
      evaluation.totalScore = totalFrozenTeacherScore(evaluation.teacherScores as unknown as ShowTeacherScoreView[])
      evaluation.status = teacherEvaluationContentBlockedReason(evaluation.teacherScores as unknown as ShowTeacherScoreView[], evaluation.summary) === null ? "REVIEWED" : "PENDING"
      evaluation.reviewedById = user.id
      evaluation.reviewedAt = new Date()
      evaluation.revision += 1
      await manager.save(evaluation)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "VTL_REVIEW",
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

  async publishTeacherEvaluation(projectId: string, user: AuthUser, expectedRevision: number): Promise<VtlReviewView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以发布巡检评价")
      const stage = await this.lockReviewStage(manager, projectId)
      if (stage.status !== "SUBMITTED") throw new ConflictException("巡检复盘评价阶段不在待发布状态")
      const evaluation = await this.lockEvaluation(manager, project, manager)
      assertRevision(expectedRevision, evaluation.revision)
      const scores = evaluation.teacherScores as unknown as ShowTeacherScoreView[]
      const blockedReason = teacherEvaluationContentBlockedReason(scores, evaluation.summary)
      if (blockedReason) throw new ConflictException(blockedReason)
      const now = new Date()
      const beforeRevision = evaluation.revision
      evaluation.status = "PUBLISHED"
      evaluation.totalScore = totalFrozenTeacherScore(scores)
      evaluation.reviewedById = user.id
      evaluation.reviewedAt ??= now
      evaluation.publishedAt = now
      evaluation.revision += 1
      stage.status = "ACCEPTED"
      stage.acceptedAt = now
      stage.revision += 1
      project.status = "GRADED"
      project.currentStageCode = "VTL_REVIEW"
      project.lastActivityAt = now
      await manager.save([evaluation, stage, project])
      await this.outbox.append({
        eventType: "VTL_EVALUATION_PUBLISHED",
        jobType: VTL_REPORT_GENERATE_JOB,
        aggregateType: "VTL_PROJECT",
        aggregateId: projectId,
        payload: { projectId, actorId: user.id, format: "PDF" },
        priority: 10
      }, manager)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "VTL_REVIEW",
        actor: user,
        eventType: "EVALUATION_PUBLISHED",
        objectType: "EVALUATION",
        objectId: evaluation.id,
        beforeRevision,
        afterRevision: evaluation.revision,
        result: { totalScore: evaluation.totalScore }
      })
    })
    return this.workspace(projectId, user)
  }

  async generateReportFromJob(projectId: string, actorId: string, format: "DOCX" | "PDF"): Promise<Record<string, unknown>> {
    const actor = await this.users.findOneBy({ id: actorId })
    if (!actor) throw new NotFoundException("报告生成操作人不存在")
    const workspace = await this.renderReport(projectId, {
      id: actor.id,
      email: actor.email,
      displayName: actor.displayName,
      role: actor.role
    }, format)
    if (!workspace.report?.filename) throw new Error("巡检报告作业执行后未生成文件资产")
    return {
      projectId,
      reportId: workspace.report.id,
      format: workspace.report.format,
      filename: workspace.report.filename
    }
  }

  async requestReportGeneration(projectId: string, user: AuthUser, formatValue = "PDF"): Promise<VtlReviewView> {
    const format = normalizeReportFormat(formatValue)
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const evaluation = await this.evaluations.findOne({ where: { projectId } })
    if (!evaluation || evaluation.status !== "PUBLISHED") throw new ConflictException("教师发布评价后才能生成巡检报告")
    if (actor === "STUDENT" && project.snapshot.mode === "ASSESSMENT") throw new ForbiddenException("当前结果展示策略不允许生成报告")
    const existing = await this.reports.findOne({ where: { project: { id: projectId } } })
    if (existing?.asset && existing.format === format && existing.status === "FINAL") return this.workspace(projectId, user)

    await this.dataSource.transaction(async (manager) => {
      const lockedEvaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId }, lock: { mode: "pessimistic_write" } })
      if (!lockedEvaluation || lockedEvaluation.status !== "PUBLISHED") throw new ConflictException("评价状态已变化，请刷新后重试")
      const pending = await manager.query(`
        SELECT event."id"
        FROM "outbox_events" event
        LEFT JOIN "jobs" job ON job."sourceOutboxEventId" = event."id"
        WHERE event."aggregateType" = 'VTL_PROJECT'
          AND event."aggregateId" = $1
          AND event."jobType" = $2
          AND event."payload"->>'format' = $3
          AND (
            event."status" IN ('PENDING', 'PROCESSING')
            OR job."status" IN ('PENDING', 'RUNNING', 'RETRY_WAIT')
          )
        ORDER BY event."createdAt" DESC
        LIMIT 1
      `, [projectId, VTL_REPORT_GENERATE_JOB, format]) as Array<{ id: string }>
      if (pending.length > 0) return
      await this.outbox.append({
        eventType: "VTL_REPORT_REQUESTED",
        jobType: VTL_REPORT_GENERATE_JOB,
        aggregateType: "VTL_PROJECT",
        aggregateId: projectId,
        payload: { projectId, actorId: user.id, format },
        priority: 0
      }, manager)
    })
    return this.workspace(projectId, user)
  }

  private async renderReport(projectId: string, user: AuthUser, formatValue = "PDF"): Promise<VtlReviewView> {
    const format = normalizeReportFormat(formatValue)
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const evaluation = await this.evaluations.findOne({ where: { projectId } })
    if (!evaluation || evaluation.status !== "PUBLISHED") throw new ConflictException("教师发布评价后才能生成巡检报告")
    if (actor === "STUDENT" && project.snapshot.mode === "ASSESSMENT") throw new ForbiddenException("当前结果展示策略不允许生成报告")
    const evidence = await this.loadEvidence(projectId)
    const snapshot = reportSnapshot(project, evaluation, evidence)
    const contentHash = createHash("sha256").update(canonicalJson({ format, snapshot })).digest("hex")
    const existing = await this.reports.findOne({ where: { project: { id: projectId } } })
    if (existing?.asset && existing.contentHash === contentHash && existing.format === format) return this.workspace(projectId, user)
    const content = format === "PDF"
      ? await createVtlReportPdf(buildReportData(project, evaluation, evidence))
      : await createVtlReportDocx(buildReportData(project, evaluation, evidence))
    const extension = format.toLowerCase()
    const mimeType = format === "PDF" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    const stored = await this.storage.write(`reports/vtl/${projectId}/${contentHash}-${randomUUID()}.${extension}`, content, mimeType)
    const createdBy = await this.users.findOneByOrFail({ id: user.id })
    try {
      await this.dataSource.transaction(async (manager) => {
        const report = existing ?? manager.create(ShowProjectReportEntity, {
          project,
          evaluation,
          status: "DRAFT",
          revision: 1,
          format: null,
          asset: null,
          snapshot: {},
          contentHash: null,
          generatedAt: null
        })
        const asset = manager.create(FileAssetEntity, {
          category: "FINAL_REPORT",
          storageProvider: stored.storageProvider,
          objectKey: stored.objectKey,
          originalName: `垂起广域巡检报告-${project.snapshot.title}${project.attemptNumber > 1 ? `-第${project.attemptNumber}次考核` : ""}.${extension}`,
          mimeType,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          status: "AVAILABLE",
          ownerType: "PROJECT",
          ownerId: projectId,
          createdBy
        })
        await manager.save(asset)
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
          stageCode: "VTL_REVIEW",
          actor: user,
          eventType: "REPORT_GENERATED",
          objectType: "FINAL_REPORT",
          objectId: report.id,
          afterRevision: report.revision,
          result: { format, filename: asset.originalName, sizeBytes: stored.sizeBytes, sha256: stored.sha256 }
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
    if (!report?.asset || report.status !== "FINAL") throw new NotFoundException("巡检报告尚未生成")
    return { asset: report.asset, content: await this.storage.read(report.asset.objectKey, report.asset.storageProvider) }
  }

  private async loadEvidence(projectId: string): Promise<VtlEvidence> {
    const plan = await this.plans.findOne({ where: { project: { id: projectId } } })
    if (!plan) throw new NotFoundException("巡检方案不存在")
    const sessions = await this.sessions.find({ where: { projectId }, order: { attemptNo: "DESC" } })
    const session = sessions[0]
    if (!session) throw new ConflictException("巡检尚未运行，不能进入复盘")
    const [events, alerts, actions, snapshots, reorganizations, allActivities] = await Promise.all([
      this.events.find({ where: { projectId, sessionId: session.id }, order: { scheduledSimulationTimeMs: "ASC" } }),
      this.alerts.find({ where: { projectId, sessionId: session.id }, order: { openedAt: "ASC" } }),
      this.actions.find({ where: { projectId, sessionId: session.id }, order: { requestedAt: "ASC" } }),
      this.snapshots.find({ where: { projectId, sessionId: session.id }, order: { sequence: "ASC" } }),
      this.reorganizations.find({ where: { projectId, sessionId: session.id }, order: { executedAtMs: "ASC" } }),
      this.activityEvents.find({ where: { projectId }, order: { realTime: "ASC", createdAt: "ASC" } })
    ])
    const activities = currentAttemptActivities(session, allActivities)
    const finalSnapshot = snapshots.at(-1)
    const taskObjects = finalSnapshot?.taskObjects?.length ? finalSnapshot.taskObjects : plan.taskObjects
    const completedTaskObjectIds = taskObjects.filter((task) => task.status === "COMPLETED").map((task) => task.id)
    const incompleteTaskObjects = taskObjects.filter((task) => task.status !== "COMPLETED").map((task) => ({ taskObjectId: task.id, reason: task.incompleteReason ?? "运行结束前未完成该巡检对象" }))
    const finalAircraft = finalSnapshot?.aircraft ?? []
    const aircraftResults = plan.allocation.assignments.map((assignment) => {
      const aircraft = finalAircraft.find((item) => item.aircraftId === assignment.aircraftId)
      const route = plan.routes.find((item) => item.aircraftId === assignment.aircraftId)
      const completed = aircraft?.completedTaskObjectIds ?? []
      const returnRecord = [...reorganizations].reverse().find((record) => record.sourceAircraftId === assignment.aircraftId && ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"].includes(record.action))
      return {
        aircraftId: assignment.aircraftId,
        groupId: aircraft?.groupId ?? assignment.groupId,
        completedTaskObjectIds: completed,
        incompleteTaskObjectIds: assignment.taskObjectIds.filter((taskId) => !completed.includes(taskId)),
        phaseDurationMs: phaseDurations(assignment.aircraftId, snapshots),
        plannedEnergyWh: route?.totalEnergyWh ?? 0,
        actualEnergyWh: Math.max(0, plan.aircraftParameters.batteryCapacityWh - (aircraft?.remainingEnergyWh ?? plan.aircraftParameters.batteryCapacityWh)),
        finalEnergyRatio: aircraft?.remainingEnergyRatio ?? 0,
        returnOrDivertResult: returnRecord ? returnRecord.action === "DIVERT_AIRCRAFT" ? "备降" : "返航" : null
      }
    })
    const eventResolutionRate = events.length === 0 ? 1 : events.filter((event) => event.status === "RESOLVED").length / events.length
    const planCheck = plan.checkResult
    const coverage = completedTaskObjectIds.length / Math.max(1, taskObjects.length)
    const averageEnergy = aircraftResults.length ? aircraftResults.reduce((sum, item) => sum + item.finalEnergyRatio, 0) / aircraftResults.length : 0
    const metrics = [
      metric("TASK_COVERAGE", "任务对象覆盖", coverage * 100, "%", coverage >= 1 ? "PASS" : "RISK", `${completedTaskObjectIds.length}/${taskObjects.length} 个任务对象完成`),
      metric("PLAN_VALIDATION", "方案检查", planCheck?.passed ? "通过" : "未通过", null, planCheck?.passed ? "PASS" : "RISK", `${planCheck?.blockingIssueCount ?? 0} 项必须修改`),
      metric("ENERGY_RESERVE", "平均剩余能量", averageEnergy * 100, "%", averageEnergy >= 0.2 ? "PASS" : "RISK", "依据最终运行快照计算"),
      metric("EVENT_RESPONSE", "事件处置率", eventResolutionRate * 100, "%", eventResolutionRate >= 1 ? "PASS" : "RISK", `${events.filter((event) => event.status === "RESOLVED").length}/${events.length} 个事件已解除`),
      metric("RUNTIME_STATUS", "运行结果", session.status, null, session.status === "COMPLETED" ? "PASS" : "RISK", `第 ${session.attemptNo} 次运行`),
      metric("REORGANIZATION", "动态重组", reorganizations.length, " 次", "INFO", "记录学生执行的任务转移和分组调整")
    ]
    return {
      plan,
      session,
      events,
      alerts,
      actions,
      snapshots,
      reorganizations,
      taskObjects,
      completedTaskObjectIds,
      incompleteTaskObjects,
      aircraftResults,
      eventResolutionRate,
      metrics,
      timeline: buildTimeline(snapshots, events, alerts, actions, reorganizations, activities)
    }
  }

  private async ensureEvaluation(project: StudentProjectEntity, metrics: ShowObjectiveMetricView[], manager: EntityManager = this.evaluations.manager): Promise<ProjectEvaluationEntity> {
    const existing = await manager.findOne(ProjectEvaluationEntity, { where: { projectId: project.id } })
    if (existing) return existing
    const taskItems = project.snapshot.config.vtlParameters?.evaluationItems
    const rubric = taskItems?.length
      ? {
          rubricVersion: `VTL-TASK@${project.snapshot.checksum.slice(0, 12)}`,
          teacherScores: taskItems.map((item) => ({ code: item.code, label: item.label, maxScore: item.maxScore, score: null, comment: "" }))
        }
      : await this.resourcePackages.resolveEvaluationRubric("VTOL_INSPECTION", project.snapshot.resourceRefs, manager)
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

  private async lockEvaluation(manager: EntityManager, project: StudentProjectEntity, sourceManager: EntityManager): Promise<ProjectEvaluationEntity> {
    const existing = await manager.findOne(ProjectEvaluationEntity, { where: { projectId: project.id }, lock: { mode: "pessimistic_write" } })
    if (existing) return existing
    return this.ensureEvaluation(project, [], sourceManager)
  }

  private async requireReviewStage(projectId: string): Promise<StudentProjectStageEntity> {
    const stage = await this.stages.findOne({ where: { project: { id: projectId }, stageCode: "VTL_REVIEW" } })
    if (!stage) throw new NotFoundException("巡检复盘阶段不存在")
    return stage
  }

  private async lockReviewStage(manager: EntityManager, projectId: string): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "VTL_REVIEW" }, lock: { mode: "pessimistic_write" } })
    if (!stage) throw new NotFoundException("巡检复盘阶段不存在")
    return stage
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager) {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (project.snapshot.sceneType !== "VTOL_INSPECTION") throw new ConflictException("该接口仅用于垂起广域巡检项目")
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return { project, actor: "STUDENT" as const }
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" as const }
    throw new ForbiddenException("无权访问该学生项目")
  }
}

function reviewPublishBlockedReason(actor: "STUDENT" | "TEACHER", stageStatus: StudentProjectStageEntity["status"], evaluationStatus: ProjectEvaluationEntity["status"], scores: ShowTeacherScoreView[], summary: string): string | null {
  if (actor !== "TEACHER") return "仅教师可以发布综合评价"
  if (evaluationStatus === "PUBLISHED") return "评价已发布，评分与报告已锁定"
  if (stageStatus !== "SUBMITTED") return "学生提交巡检复盘后才能发布评价"
  return teacherEvaluationContentBlockedReason(scores, summary)
}

function metric(code: string, label: string, value: number | string, unit: string | null, state: ShowObjectiveMetricView["state"], detail: string): ShowObjectiveMetricView {
  const normalized = typeof value === "number" ? round(value, 1) : value
  return { code, label, value: normalized, displayValue: `${normalized}${unit ?? ""}`, unit, state, detail }
}

function phaseDurations(aircraftId: string, snapshots: VtlRuntimeSnapshotEntity[]): Partial<Record<string, number>> {
  const result: Record<string, number> = {}
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1]!
    const current = snapshots[index]!
    const aircraft = previous.aircraft.find((item) => item.aircraftId === aircraftId)
    if (!aircraft) continue
    const delta = Math.max(0, Number(current.simulationTimeMs) - Number(previous.simulationTimeMs))
    result[aircraft.phase] = (result[aircraft.phase] ?? 0) + delta
  }
  return result
}

export function buildTimeline(snapshots: VtlRuntimeSnapshotEntity[], events: RuntimeEventEntity[], alerts: RuntimeAlertEntity[], actions: StudentRuntimeActionEntity[], reorganizations: VtlReorganizationEntity[], activities: ProjectActivityEventEntity[] = []): ShowReplayTimelineItemView[] {
  const runtimeEvidence = buildRuntimeEvidence({ events, actions })
  const evidenceBySourceId = new Map(runtimeEvidence.map((evidence) => [evidence.id, evidence]))
  const eventIds = new Set(events.map((event) => event.id))
  const alertIds = new Set(alerts.map((alert) => alert.id))
  const actionIds = new Set(actions.map((action) => action.id))
  const runtimeCorrelations = new Set([...events, ...alerts, ...actions].map((item) => item.correlationId).filter(Boolean))
  const runtimeActivities = activities.filter((activity) => {
    if (!activity.eventType.startsWith("RUNTIME_")) return false
    if (activity.objectId && (eventIds.has(activity.objectId) || alertIds.has(activity.objectId) || actionIds.has(activity.objectId))) return true
    return Boolean(activity.correlationId && runtimeCorrelations.has(activity.correlationId))
  })
  const items: ShowReplayTimelineItemView[] = []
  for (const snapshot of snapshots) items.push({ id: `snapshot:${snapshot.id}`, sourceId: snapshot.id, kind: "STATE", simulationTimeMs: Number(snapshot.simulationTimeMs), realTime: snapshot.createdAt.toISOString(), title: "运行状态快照", detail: `快照原因：${snapshot.reason}`, status: snapshot.reason, severity: null, correlationId: null, payload: snapshot.summary })
  for (const event of events) {
    const evidence = evidenceBySourceId.get(event.id)
    const transitions = runtimeActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_TRIGGERED" || activity.eventType === "RUNTIME_EVENT_ESCALATED" || activity.eventType === "RUNTIME_EVENT_RESOLVED")
      .filter((activity) => activity.objectId === event.id || activity.correlationId === event.correlationId)
    if (transitions.length === 0) {
      items.push({ id: `event:${event.id}`, sourceId: event.id, kind: "EVENT", simulationTimeMs: evidence?.simulationTimeMs ?? (event.scheduledSimulationTimeMs === null ? null : Number(event.scheduledSimulationTimeMs)), realTime: event.triggeredAt?.toISOString() ?? event.createdAt.toISOString(), title: String(event.payload.title ?? event.code), detail: String(event.payload.detail ?? ""), status: String(event.payload.lifecycleStatus ?? event.status), severity: event.severity, correlationId: event.correlationId, payload: { ...event.payload, runtimeEvidenceSequence: evidence?.sequence ?? null } })
    } else {
      for (const activity of transitions) items.push(vtlEventTransitionItem(event, activity, evidence?.sequence ?? null))
    }
  }
  for (const alert of alerts) {
    const transitions = runtimeActivities.filter((activity) => activity.eventType === "RUNTIME_EVENT_DISCOVERED" || activity.eventType === "RUNTIME_EVENT_ESCALATED" || activity.eventType === "RUNTIME_EVENT_RESOLVED")
      .filter((activity) => activity.objectId === alert.id || activity.correlationId === alert.correlationId)
    if (transitions.length === 0) items.push({ id: `alert:${alert.id}`, sourceId: alert.id, kind: "ALERT", simulationTimeMs: alert.simulationTimeMs === null ? null : Number(alert.simulationTimeMs), realTime: alert.openedAt.toISOString(), title: alert.title, detail: alert.detail, status: alert.status, severity: alert.severity, correlationId: alert.correlationId, payload: alert.payload })
    else for (const activity of transitions) items.push(vtlAlertTransitionItem(alert, activity))
  }
  for (const action of actions) {
    const evidence = evidenceBySourceId.get(action.id)
    items.push({ id: `action:${action.id}`, sourceId: action.id, kind: "ACTION", simulationTimeMs: Number(action.simulationTimeMs), realTime: action.requestedAt.toISOString(), title: String(action.actionCode), detail: actionOutcomeText(action.result), status: action.status, severity: null, correlationId: action.correlationId, payload: { ...action.payload, result: action.result, runtimeEvidenceSequence: evidence?.sequence ?? null } })
  }
  for (const record of reorganizations) items.push({ id: `reorg:${record.id}`, sourceId: record.id, kind: "ACTION", simulationTimeMs: Number(record.executedAtMs), realTime: record.createdAt.toISOString(), title: String(record.action), detail: record.message, status: record.checkPassed ? "APPLIED" : "FAILED", severity: null, correlationId: record.eventId, payload: { taskObjectIds: record.taskObjectIds, sourceAircraftId: record.sourceAircraftId, targetAircraftId: record.targetAircraftId } })
  return items.sort((left, right) => (left.simulationTimeMs ?? Number.MAX_SAFE_INTEGER) - (right.simulationTimeMs ?? Number.MAX_SAFE_INTEGER) || left.realTime.localeCompare(right.realTime))
}

function currentAttemptActivities(session: RuntimeSessionEntity, activities: ProjectActivityEventEntity[]): ProjectActivityEventEntity[] {
  return activities.filter((activity) => activity.realTime >= session.createdAt)
}

function vtlEventTransitionItem(event: RuntimeEventEntity, activity: ProjectActivityEventEntity, runtimeEvidenceSequence: number | null): ShowReplayTimelineItemView {
  const status = activity.eventType === "RUNTIME_EVENT_ESCALATED" ? "ESCALATED" : activity.eventType === "RUNTIME_EVENT_RESOLVED" ? "RESOLVED" : "TRIGGERED"
  return {
    id: `event:${status}:${activity.id}`,
    sourceId: event.id,
    kind: "EVENT",
    simulationTimeMs: activity.simulationTimeMs === null ? null : Number(activity.simulationTimeMs),
    realTime: activity.realTime.toISOString(),
    title: String(activity.payload.title ?? event.payload.title ?? event.code),
    detail: status === "ESCALATED" ? "事件已升级" : status === "RESOLVED" ? "事件已控制或恢复" : String(activity.payload.detail ?? event.payload.detail ?? event.category),
    status,
    severity: event.severity,
    correlationId: event.correlationId,
    payload: { ...event.payload, ...activity.result, runtimeEvidenceSequence }
  }
}

function vtlAlertTransitionItem(alert: RuntimeAlertEntity, activity: ProjectActivityEventEntity): ShowReplayTimelineItemView {
  const status = activity.eventType === "RUNTIME_EVENT_ESCALATED" ? "ESCALATED" : activity.eventType === "RUNTIME_EVENT_RESOLVED" ? "RESOLVED" : "OPEN"
  return {
    id: `alert:${status}:${activity.id}`,
    sourceId: alert.id,
    kind: "ALERT",
    simulationTimeMs: activity.simulationTimeMs === null ? alert.simulationTimeMs === null ? null : Number(alert.simulationTimeMs) : Number(activity.simulationTimeMs),
    realTime: activity.realTime.toISOString(),
    title: alert.title,
    detail: status === "ESCALATED" ? "告警已升级" : status === "RESOLVED" ? "告警已解除" : alert.detail,
    status,
    severity: alert.severity,
    correlationId: alert.correlationId,
    payload: { ...alert.payload, ...activity.result }
  }
}

function serializeReorganization(record: VtlReorganizationEntity) {
  return { id: record.id, eventId: record.eventId ?? "", action: record.action, sourceAircraftId: record.sourceAircraftId, targetAircraftId: record.targetAircraftId, sourceGroupId: record.sourceGroupId, targetGroupId: record.targetGroupId, taskObjectIds: record.taskObjectIds, previousTaskOrder: record.previousTaskOrder, nextTaskOrder: record.nextTaskOrder, checkPassed: record.checkPassed, message: record.message, executedAtMs: Number(record.executedAtMs) }
}

function serializeReplayFrame(snapshot: VtlRuntimeSnapshotEntity): VtlReplayFrameView {
  return {
    id: snapshot.id,
    sequence: snapshot.sequence,
    simulationTimeMs: Number(snapshot.simulationTimeMs),
    reason: snapshot.reason,
    summary: snapshot.summary as unknown as VtlReplayFrameView["summary"],
    aircraft: snapshot.aircraft,
    groups: snapshot.groups,
    taskObjects: snapshot.taskObjects
  }
}

function reportSnapshot(project: StudentProjectEntity, evaluation: ProjectEvaluationEntity, evidence: VtlEvidence): Record<string, unknown> {
  return {
    projectId: project.id,
    projectTitle: project.snapshot.title,
    assessmentAttemptNumber: project.attemptNumber,
    retakeOfProjectId: project.retakeOfProjectId,
    sceneType: project.snapshot.sceneType,
    scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
    evaluationRevision: evaluation.revision,
    evaluationStatus: evaluation.status,
    plan: {
      taskZones: evidence.plan.allocation.taskZones.map((zone) => ({ id: zone.id, title: zone.title, groupId: zone.groupId, taskObjectIds: zone.taskObjectIds })),
      assignments: evidence.plan.allocation.assignments.map((assignment) => ({ aircraftId: assignment.aircraftId, groupId: assignment.groupId, taskObjectIds: assignment.taskObjectIds, taskSequence: assignment.taskSequence })),
      routes: evidence.plan.routes.map((route) => ({ aircraftId: route.aircraftId, totalDistanceMeters: route.totalDistanceMeters, totalDurationSeconds: route.totalDurationSeconds, totalEnergyWh: route.totalEnergyWh, minimumTerrainClearanceMeters: route.minimumTerrainClearanceMeters, alternateLandingSiteId: route.alternateLandingSiteId, alternateComparison: route.alternateComparison ?? null, terrainSampleCount: route.terrainProfile.length })),
      checkResult: evidence.plan.checkResult,
      executionPlan: evidence.plan.executionPlan
    },
    objectiveMetrics: evidence.metrics,
    completedTaskObjectIds: evidence.completedTaskObjectIds,
    incompleteTaskObjects: evidence.incompleteTaskObjects,
    aircraftResults: evidence.aircraftResults,
    events: evidence.events.map((event) => ({ id: event.id, code: event.code, status: event.status, affectedAircraftIds: event.payload.affectedAircraftIds })),
    actions: evidence.actions.map((action) => ({
      eventId: action.eventId,
      actionCode: action.actionCode,
      targetId: action.targetId,
      status: action.status,
      reasoning: runtimeActionReasoningFromPayload(action.payload),
      result: action.result
    })),
    eventResolutionRate: evidence.eventResolutionRate,
    reorganizations: evidence.reorganizations.map(serializeReorganization),
    studentSummary: evaluation.studentSummary,
    teacherScores: evaluation.teacherScores,
    teacherSummary: evaluation.summary,
    totalScore: evaluation.totalScore
  }
}

function buildReportData(project: StudentProjectEntity, evaluation: ProjectEvaluationEntity, evidence: VtlEvidence) {
  const plan = evidence.plan
  const landingSiteById = new Map(plan.landingSites.map((site) => [site.id, site]))
  const taskById = new Map(plan.taskObjects.map((task) => [task.id, task]))
  const groupById = new Map(plan.allocation.groups.map((group) => [group.id, group]))
  const scoreRows = (evaluation.teacherScores as unknown as ShowTeacherScoreView[]).map((score) => ({
    label: score.label,
    value: `${score.score ?? 0}/${score.maxScore} 分${score.comment ? `；${score.comment}` : ""}`
  }))
  return {
    title: "垂起广域巡检教学仿真报告",
    subtitle: "任务方案、运行证据、事件处置与教师评价",
    metadata: [
      { label: "项目", value: project.snapshot.title },
      { label: "学生", value: project.student.displayName },
      { label: "考核批次", value: project.snapshot.mode === "ASSESSMENT" ? `第 ${project.attemptNumber} 次考核` : "训练项目" },
      { label: "机群档位", value: project.snapshot.config.scaleTemplateCode },
      { label: "运行批次", value: `第 ${evidence.session.attemptNo} 次 · ${evidence.session.status}` },
      { label: "报告生成", value: new Date().toLocaleString("zh-CN") },
      { label: "评价总分", value: evaluation.totalScore === null ? "未发布" : `${evaluation.totalScore} 分` }
    ],
    sections: [
      {
        title: "任务分区与分配",
        rows: [
          ...plan.allocation.taskZones.map((zone) => ({ label: zone.title, value: `${groupById.get(zone.groupId ?? "")?.title ?? "未指定分组"}；${zone.taskObjectIds.map((taskId) => taskById.get(taskId)?.title ?? taskId).join("、") || "无任务对象"}` })),
          ...plan.allocation.assignments.map((assignment) => ({ label: assignment.aircraftCode, value: `${groupById.get(assignment.groupId)?.title ?? assignment.groupId}；任务顺序 ${assignment.taskSequence.map((taskId) => taskById.get(taskId)?.code ?? taskId).join(" -> ") || "无"}` }))
        ]
      },
      {
        title: "航线与地形剖面",
        rows: plan.routes.map((route) => {
          const comparison = route.alternateComparison
          const alternateDetail = comparison
            ? `；备降尾段 ${(comparison.alternateDistanceMeters / 1_000).toFixed(2)} 千米/${Math.round(comparison.alternateDurationSeconds)} 秒/${comparison.alternateEnergyWh.toFixed(1)} Wh；预计到达 ${comparison.alternateArrivalEnergyWh.toFixed(1)} Wh；余度 ${comparison.reserveMarginWh.toFixed(1)} Wh（${comparison.feasible ? "满足" : "不足"}）`
            : ""
          return {
            label: route.aircraftId,
            value: `${(route.totalDistanceMeters / 1_000).toFixed(2)} 千米；${Math.round(route.totalDurationSeconds)} 秒；最低离地 ${Math.round(route.minimumTerrainClearanceMeters)} 米；计划能量 ${route.totalEnergyWh.toFixed(1)} Wh；备降点 ${landingSiteById.get(route.alternateLandingSiteId)?.title ?? route.alternateLandingSiteId}${alternateDetail}；剖面 ${route.terrainProfile.length} 个采样点`
          }
        })
      },
      {
        title: "方案检查与执行计划",
        rows: [
          { label: "方案检查", value: `${plan.checkResult?.passed ? "通过" : "未通过"}；必须修改 ${plan.checkResult?.blockingIssueCount ?? 0} 项；风险提示 ${plan.checkResult?.warningCount ?? 0} 项` },
          { label: "起飞顺序", value: plan.executionPlan?.takeoffOrder.join(" -> ") || "未提交" },
          { label: "降落顺序", value: plan.executionPlan?.landingOrder.join(" -> ") || "未提交" },
          { label: "执行计划状态", value: plan.executionPlan ? `${plan.executionPlan.status} · V${plan.executionPlan.version}` : "未提交" }
        ]
      },
      { title: "任务完成情况", rows: [{ label: "任务对象覆盖", value: `${evidence.completedTaskObjectIds.length}/${evidence.taskObjects.length}` }, { label: "未完成对象", value: evidence.incompleteTaskObjects.map((item) => `${taskById.get(item.taskObjectId)?.title ?? item.taskObjectId}：${item.reason}`).join("；") || "无" }] },
      {
        title: "阶段统计",
        rows: evidence.aircraftResults.map((item) => ({
          label: item.aircraftId,
          value: Object.entries(item.phaseDurationMs).map(([phase, milliseconds]) => `${phase} ${formatReportDuration(milliseconds ?? 0)}`).join("；") || "无阶段统计"
        }))
      },
      { title: "运行与能量", rows: evidence.metrics.map((item) => ({ label: item.label, value: `${item.displayValue} · ${item.detail}` })) },
      { title: "航空器结果", rows: evidence.aircraftResults.map((item) => ({ label: item.aircraftId, value: `完成 ${item.completedTaskObjectIds.length} 项；剩余能量 ${Math.round(item.finalEnergyRatio * 100)}%；${item.returnOrDivertResult ?? "正常结束"}` })) },
      {
        title: "事件处置与动态重组",
        rows: [
          { label: "事件处置率", value: `${Math.round(evidence.eventResolutionRate * 100)}%（${evidence.events.filter((event) => event.status === "RESOLVED").length}/${evidence.events.length}）` },
          ...evidence.events.map((event) => ({ label: event.code, value: `${event.status}；影响 ${arrayOfStringsForReport(event.payload.affectedAircraftIds).join("、") || "全局"}；动作 ${evidence.actions.filter((action) => action.eventId === event.id && action.actionCode !== "ACKNOWLEDGE").map((action) => action.actionCode).join("、") || "未处置"}` })),
          ...evidence.actions.map((action) => ({ label: `处置 ${action.actionCode}`, value: actionDecisionReportText(action) })),
          ...evidence.reorganizations.map((record) => ({ label: record.action, value: `${record.message}；对象 ${record.sourceAircraftId ?? "-"}${record.targetAircraftId ? ` -> ${record.targetAircraftId}` : ""}；任务顺序 ${record.previousTaskOrder.join(" -> ") || "-"} => ${record.nextTaskOrder.join(" -> ") || "-"}；检查 ${record.checkPassed ? "通过" : "未通过"}` }))
        ]
      },
      { title: "学生复盘与教师评价", rows: [{ label: "学生复盘", value: evaluation.studentSummary || "未填写" }, ...scoreRows, { label: "教师讲评", value: evaluation.summary || "未填写" }] }
    ]
  }
}

function actionDecisionReportText(action: StudentRuntimeActionEntity): string {
  const reasoning = runtimeActionReasoningFromPayload(action.payload)
  return [
    `目标 ${action.targetId ?? "事件"}`,
    actionOutcomeText(action.result),
    actionEvidenceReportText(action.result),
    reasoning ? `异常发现：${reasoning.observation}` : null,
    reasoning ? `判断依据：${reasoning.rationale}` : null,
    reasoning ? `预期结果：${reasoning.expectedOutcome}` : null
  ].filter((item): item is string => Boolean(item)).join("；")
}

function actionOutcomeText(result: Record<string, unknown>): string {
  if (typeof result.outcome === "string" && result.outcome.trim()) return result.outcome
  const consequences = Array.isArray(result.businessConsequences)
    ? result.businessConsequences.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  if (consequences.length > 0) return consequences.join("；")
  return typeof result.message === "string" && result.message.trim() ? result.message : "处置已记录"
}

function actionEvidenceReportText(result: Record<string, unknown>): string | null {
  const evidence = [
    Number.isFinite(Number(result.responseTimeMs)) ? `响应 ${Math.max(0, Number(result.responseTimeMs)) / 1_000} 秒` : null,
    result.withinDeadline === true ? "时限内完成" : result.withinDeadline === false ? "已超出处置时限" : null,
    result.eventControlled === true ? "事件已控制" : result.eventControlled === false ? "事件未控制" : null
  ].filter((item): item is string => Boolean(item))
  return evidence.length > 0 ? `评分证据：${evidence.join("、")}` : null
}

function arrayOfStringsForReport(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function formatReportDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`
}

function normalizeText(value: string, maximum: number, label: string): string {
  const result = value.trim()
  if (result.length > maximum) throw new ConflictException(`${label}不能超过 ${maximum} 个字符`)
  return result
}

export function vtlReviewVisibility(
  actor: "STUDENT" | "TEACHER",
  mode: "TRAINING" | "ASSESSMENT",
  configuredVisibility: unknown,
  evaluationStatus: "PENDING" | "REVIEWED" | "PUBLISHED"
): { full: boolean; dimensions: boolean } {
  const visibility = normalizeReviewResultVisibility(configuredVisibility, mode)
  if (actor === "TEACHER" || mode === "TRAINING") return { full: true, dimensions: true }
  const published = evaluationStatus === "PUBLISHED"
  return {
    full: published && visibility === "FULL_REVIEW",
    dimensions: published && visibility === "DIMENSIONS"
  }
}

function assertRevision(expected: number | undefined, current: number): void {
  if (expected !== undefined && (!Number.isInteger(expected) || expected !== current)) throw new ConflictException(`版本已变化，请刷新后重试（当前版本 R${current}）`)
}

function normalizeReportFormat(value: string): "DOCX" | "PDF" {
  const normalized = value.trim().toUpperCase()
  if (normalized !== "DOCX" && normalized !== "PDF") throw new ConflictException("报告格式必须为 DOCX 或 PDF")
  return normalized
}

function mapReportJobStatus(status: V3JobStatus): NonNullable<VtlReviewView["reportJob"]>["status"] {
  return status === "CANCELLED" ? "DEAD_LETTER" : status
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
