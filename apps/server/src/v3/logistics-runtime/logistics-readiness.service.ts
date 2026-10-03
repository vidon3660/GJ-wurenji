import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import type {
  AuthUser,
  LogisticsReadinessCheckItemView,
  LogisticsRuntimeReadinessView,
  LogisticsRuntimeReadinessWorkspaceView
} from "@wurenji/shared"
import { resolveLogisticsInitialEnvironment } from "@wurenji/shared"
import { DataSource, EntityManager, Repository } from "typeorm"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { LogisticsRuntimeReadinessEntity } from "./logistics-runtime.entities.js"
import { LogisticsRuntimeDataService, type LogisticsRuntimeScheduleRecords } from "./logistics-runtime.data.js"
import { LogisticsRuntimeService } from "./logistics-runtime.service.js"
import { normalizedBasis, readinessDecision, runtimeRevision } from "./logistics-runtime.validation.js"

@Injectable()
export class LogisticsReadinessService {
  constructor(
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(LogisticsRuntimeReadinessEntity) private readonly readiness: Repository<LogisticsRuntimeReadinessEntity>,
    private readonly data: LogisticsRuntimeDataService,
    private readonly runtime: LogisticsRuntimeService,
    private readonly activities: ActivityLogService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<LogisticsRuntimeReadinessWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const [stage, record, schedule] = await Promise.all([
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "LOGISTICS_RUNTIME_PREPARATION" } }),
      this.ensureRecord(project),
      this.data.loadSubmittedSchedule(this.dataSource.manager, projectId)
    ])
    const editable = actor === "STUDENT" && stage?.status === "IN_PROGRESS" && record.status === "DRAFT" && this.assignmentActive(project)
    return {
      projectId,
      actor,
      mode: project.snapshot.mode,
      scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
      canEdit: editable,
      canCheck: editable,
      canConfirm: editable && canConfirm(record),
      submittedSchedule: this.data.serializeScheduleVersion(schedule.version),
      readiness: serializeReadiness(record)
    }
  }

  async save(projectId: string, user: AuthUser, input: { expectedRevision?: number; decision?: unknown; decisionBasis?: unknown }): Promise<LogisticsRuntimeReadinessWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以填写物流运行准备")
      this.ensureAssignmentActive(project)
      await this.requireEditableStage(manager, projectId)
      const record = await this.lockRecord(manager, projectId)
      if (record.status !== "DRAFT") throw new ConflictException("运行准备已经确认")
      runtimeRevision(input.expectedRevision, record.revision)
      const schedule = await this.data.loadSubmittedSchedule(manager, projectId)
      const beforeRevision = record.revision
      record.decision = readinessDecision(input.decision)
      record.decisionBasis = normalizedBasis(input.decisionBasis)
      record.checks = buildReadinessChecks(project, schedule)
      record.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      record.revision += 1
      await manager.save(record)
      project.lastActivityAt = new Date()
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_RUNTIME_PREPARATION",
        actor: user,
        eventType: "LOGISTICS_READINESS_SAVED",
        objectType: "LOGISTICS_READINESS",
        objectId: record.id,
        beforeRevision,
        afterRevision: record.revision,
        result: readinessSummary(record)
      })
    })
    return this.workspace(projectId, user)
  }

  async check(projectId: string, user: AuthUser, expectedRevision: unknown): Promise<LogisticsRuntimeReadinessWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以执行运行准备检查")
      this.ensureAssignmentActive(project)
      await this.requireEditableStage(manager, projectId)
      const record = await this.lockRecord(manager, projectId)
      runtimeRevision(expectedRevision, record.revision)
      const schedule = await this.data.loadSubmittedSchedule(manager, projectId)
      const beforeRevision = record.revision
      record.checks = buildReadinessChecks(project, schedule)
      record.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      record.revision += 1
      await manager.save(record)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_RUNTIME_PREPARATION",
        actor: user,
        eventType: "LOGISTICS_READINESS_SAVED",
        objectType: "LOGISTICS_READINESS",
        objectId: record.id,
        beforeRevision,
        afterRevision: record.revision,
        result: readinessSummary(record)
      })
    })
    return this.workspace(projectId, user)
  }

  async confirm(projectId: string, user: AuthUser, expectedRevision: unknown): Promise<LogisticsRuntimeReadinessWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以确认物流运行准备")
      this.ensureAssignmentActive(project)
      const stage = await this.requireEditableStage(manager, projectId)
      const record = await this.lockRecord(manager, projectId)
      runtimeRevision(expectedRevision, record.revision)
      if (record.status !== "DRAFT") return
      const schedule = await this.data.loadSubmittedSchedule(manager, projectId)
      record.checks = buildReadinessChecks(project, schedule)
      if (!record.decision || record.decision === "DELAY" || record.decision === "CANCEL") throw new ConflictException("当前运行决定不能确认放飞")
      record.decisionBasis = normalizedBasis(record.decisionBasis, true)
      const blocking = record.checks.filter((item) => item.blocking && item.status === "FAIL")
      if (blocking.length > 0) throw new ConflictException(`仍有 ${blocking.length} 项阻断问题未处理`)
      const now = new Date()
      const beforeRevision = record.revision
      record.status = "CONFIRMED"
      record.confirmedAt = now
      record.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      record.revision += 1
      await manager.save(record)
      stage.status = "ACCEPTED"
      stage.submittedAt = now
      stage.acceptedAt = now
      stage.revision += 1
      await manager.save(stage)
      const next = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "LOGISTICS_DELIVERY_RUNTIME" }, lock: { mode: "pessimistic_write" } })
      if (!next) throw new ConflictException("配送运行阶段不存在")
      if (next.status === "LOCKED") {
        next.status = "AVAILABLE"
        next.revision += 1
        await manager.save(next)
      }
      project.currentStageCode = "LOGISTICS_DELIVERY_RUNTIME"
      project.lastActivityAt = now
      await manager.save(project)
      const session = await this.runtime.ensureReadySession(manager, project, user)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_RUNTIME_PREPARATION",
        actor: user,
        eventType: "LOGISTICS_READINESS_CONFIRMED",
        objectType: "LOGISTICS_READINESS",
        objectId: record.id,
        beforeRevision,
        afterRevision: record.revision,
        result: { ...readinessSummary(record), sessionId: session.id }
      })
    })
    return this.workspace(projectId, user)
  }

  private async ensureRecord(project: StudentProjectEntity): Promise<LogisticsRuntimeReadinessEntity> {
    const existing = await this.readiness.findOne({ where: { project: { id: project.id } } })
    if (existing) return existing
    const schedule = await this.data.loadSubmittedSchedule(this.dataSource.manager, project.id)
    const student = await this.dataSource.manager.findOneByOrFail(UserEntity, { id: project.student.id })
    try {
      return await this.readiness.save(this.readiness.create({
        project,
        scheduleVersion: schedule.version,
        status: "DRAFT",
        revision: 1,
        decision: null,
        decisionBasis: "",
        checks: buildReadinessChecks(project, schedule),
        updatedBy: student,
        confirmedAt: null
      }))
    } catch {
      const concurrent = await this.readiness.findOne({ where: { project: { id: project.id } } })
      if (!concurrent) throw new ConflictException("运行准备记录初始化失败")
      return concurrent
    }
  }

  private async lockRecord(manager: EntityManager, projectId: string): Promise<LogisticsRuntimeReadinessEntity> {
    await manager.query('SELECT "id" FROM "logistics_runtime_readiness" WHERE "projectId" = $1 FOR UPDATE', [projectId])
    const record = await manager.findOne(LogisticsRuntimeReadinessEntity, { where: { project: { id: projectId } } })
    if (!record) throw new ConflictException("运行准备记录尚未初始化，请重新打开工作台")
    return record
  }

  private async requireEditableStage(manager: EntityManager, projectId: string): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "LOGISTICS_RUNTIME_PREPARATION" }, lock: { mode: "pessimistic_write" } })
    if (!stage) throw new NotFoundException("运行准备阶段不存在")
    if (stage.status !== "IN_PROGRESS") throw new ConflictException("请先开始运行准备阶段")
    return stage
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

  private assignmentActive(project: StudentProjectEntity): boolean {
    return project.snapshot.draft.status !== "ENDED" && project.snapshot.draft.status !== "ARCHIVED"
  }

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    if (!this.assignmentActive(project)) throw new ConflictException("任务已结束或归档，不能继续修改")
  }
}

function buildReadinessChecks(project: StudentProjectEntity, records: LogisticsRuntimeScheduleRecords): LogisticsReadinessCheckItemView[] {
  const checks: LogisticsReadinessCheckItemView[] = []
  const scheduledOrderIds = new Set(records.scheduleItems.map((item) => item.orderId))
  const referencedAircraftIds = new Set(records.scheduleItems.map((item) => item.aircraftId))
  const unavailableAircraft = records.aircraft.filter((item) => referencedAircraftIds.has(item.id) && item.status === "UNAVAILABLE")
  const lowBatteryAircraft = records.aircraft.filter((item) => referencedAircraftIds.has(item.id) && item.status === "LOW_BATTERY")
  const unavailableNodeIds = new Set(Array.isArray(project.snapshot.config.scenario.initialUnavailableNodeIds) ? project.snapshot.config.scenario.initialUnavailableNodeIds.filter((item): item is string => typeof item === "string") : [])
  const blockedOrders = records.orders.filter((order) => unavailableNodeIds.has(order.destinationNodeId) && scheduledOrderIds.has(order.id))
  checks.push(check("SCHEDULE_SUBMITTED", "SCHEDULE", records.version.status === "SUBMITTED" ? "PASS" : "FAIL", true, "正式初始调度", records.version.status === "SUBMITTED" ? `已锁定 V${records.version.versionNo}` : "初始调度尚未正式提交", [records.version.id]))
  checks.push(check("ORDER_ASSIGNMENT_COMPLETE", "ORDER", scheduledOrderIds.size === records.orders.length ? "PASS" : "FAIL", true, "订单分配完整性", scheduledOrderIds.size === records.orders.length ? `全部 ${records.orders.length} 单已分配` : `仍有 ${records.orders.length - scheduledOrderIds.size} 单未分配`, records.orders.filter((order) => !scheduledOrderIds.has(order.id)).map((order) => order.id)))
  checks.push(check("AIRCRAFT_AVAILABLE", "AIRCRAFT", unavailableAircraft.length === 0 ? "PASS" : "FAIL", true, "无人机可用状态", unavailableAircraft.length === 0 ? "已分配无人机均可执行" : `${unavailableAircraft.length} 架已分配无人机不可用`, unavailableAircraft.map((item) => item.id)))
  checks.push(check("AIRCRAFT_BATTERY", "AIRCRAFT", lowBatteryAircraft.length === 0 ? "PASS" : "WARNING", false, "无人机初始电量", lowBatteryAircraft.length === 0 ? "已分配无人机电量满足初始计划" : `${lowBatteryAircraft.length} 架无人机处于低电量状态`, lowBatteryAircraft.map((item) => item.id)))
  checks.push(check("ROUTES_VERIFIED", "ROUTE", records.routeVersion.status === "SUBMITTED" && records.routeVersion.validationResult?.status !== "HARD_CONFLICT" ? "PASS" : "FAIL", true, "正式航线与验证", records.routeVersion.status === "SUBMITTED" ? `正式航线 V${records.routeVersion.versionNo} 可用` : "正式航线不可用", records.routeViews.map((route) => route.id)))
  checks.push(check("SCHEDULE_CONFLICTS", "SCHEDULE", records.version.checkResult.submittable ? "PASS" : "FAIL", true, "调度冲突复核", records.version.checkResult.submittable ? "初始调度不存在阻断冲突" : `仍有 ${records.version.checkResult.conflictCount} 项硬冲突`, records.version.checkResult.evidence.flatMap((item) => item.scheduleItemIds)))
  const environment = resolveLogisticsInitialEnvironment(project.snapshot.config.scenario)
  const environmentIssues = [
    environment.windForceState === "OVER_LIMIT" ? "风力超限" : null,
    environment.gustState === "CONTINUOUS" ? "持续阵风" : null,
    environment.rainState === "OVER_LIMIT" ? "降雨超限" : null,
    environment.positioningState === "CONTINUOUS_ABNORMAL" ? "定位持续异常" : null,
    environment.communicationState === "CONTINUOUS_ABNORMAL" ? "通信持续异常" : null
  ].filter((item): item is string => Boolean(item))
  const legacyUnsafe = project.snapshot.config.scenario.initialEnvironmentState === "UNSAFE"
  checks.push(check("ENVIRONMENT_READY", "ENVIRONMENT", legacyUnsafe || environmentIssues.length > 0 ? "FAIL" : "PASS", true, "气象、定位与通信环境", legacyUnsafe ? "教师配置的初始环境不允许运行" : environmentIssues.length > 0 ? `初始环境存在阻断条件：${environmentIssues.join("、")}` : "初始环境满足教学运行条件", []))
  checks.push(check("NODES_AVAILABLE", "NODE", blockedOrders.length === 0 ? "PASS" : "FAIL", true, "机场与配送节点", blockedOrders.length === 0 ? "中心机场和任务配送点可用" : `${blockedOrders.length} 个订单配送点不可用`, blockedOrders.map((order) => order.destinationNodeId)))
  return checks
}

function check(code: string, category: LogisticsReadinessCheckItemView["category"], status: LogisticsReadinessCheckItemView["status"], blocking: boolean, title: string, detail: string, entityIds: string[]): LogisticsReadinessCheckItemView {
  return { code, category, status, blocking, title, detail, entityIds: [...new Set(entityIds)] }
}

function serializeReadiness(record: LogisticsRuntimeReadinessEntity): LogisticsRuntimeReadinessView {
  return {
    id: record.id,
    projectId: record.project.id,
    scheduleVersionId: record.scheduleVersion.id,
    scheduleVersionNo: record.scheduleVersion.versionNo,
    status: record.status,
    revision: record.revision,
    decision: record.decision,
    decisionBasis: record.decisionBasis,
    checks: record.checks,
    confirmedAt: record.confirmedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString()
  }
}

function canConfirm(record: LogisticsRuntimeReadinessEntity): boolean {
  return record.status === "DRAFT"
    && (record.decision === "PROCEED" || record.decision === "PROCEED_AFTER_ADJUSTMENT")
    && record.decisionBasis.trim().length >= 4
    && !record.checks.some((item) => item.blocking && item.status === "FAIL")
}

function readinessSummary(record: LogisticsRuntimeReadinessEntity) {
  return {
    status: record.status,
    decision: record.decision,
    passCount: record.checks.filter((item) => item.status === "PASS").length,
    warningCount: record.checks.filter((item) => item.status === "WARNING").length,
    failCount: record.checks.filter((item) => item.status === "FAIL").length
  }
}
