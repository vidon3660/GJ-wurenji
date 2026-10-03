import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { DataSource, EntityManager, Repository } from "typeorm"
import { randomUUID } from "node:crypto"
import { buildVtlRoutePlan, projectVtlRuntime } from "@wurenji/simulation"
import type {
  AuthUser,
  V3AlertSeverity,
  V3Coordinate,
  V3RuntimeAlertView,
  V3RuntimeActionReasoning,
  V3RuntimeEventView,
  V3RuntimeSessionView,
  V3StudentRuntimeActionView,
  VtlAircraftAssignmentView,
  VtlFlightPhase,
  VtlProjectPlanView,
  VtlRuntimeActionCode,
  VtlRuntimeAircraftView,
  VtlRuntimeEventView,
  VtlRuntimeGroupView,
  VtlRoutePlanView,
  VtlRuntimeWorkspaceView,
  VtlTaskObjectView
} from "@wurenji/shared"
import { freezeRuntimeResourceVersions } from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { ProjectActivityCounterEntity, StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import {
  RuntimeAlertEntity,
  RuntimeEventEntity,
  RuntimeSessionEntity,
  StudentRuntimeActionEntity
} from "../runtime/runtime.entities.js"
import { VtlProjectPlanEntity } from "../vtl-inspection/vtl-inspection.entities.js"
import { completeVtlStage, configuredMainLandingSiteId, openVtlStageCodes } from "../vtl-inspection/vtl-stage-flow.js"
import { assessmentTimingForProject } from "../assessment/assessment-window.service.js"
import { normalizeRuntimeActionReasoning } from "../runtime/runtime-action-reasoning.js"
import { mergeRuntimeAlertPayload } from "../runtime/runtime-alert-payload.js"
import { adaptRuntimeClock } from "../runtime/runtime-adapters.js"
import { fixedTickSimulationTime } from "../runtime/runtime-clock.js"
import { persistRejectedRuntimeAction } from "../runtime/runtime-action-failure.js"
import { vtlActionBusinessOutcome, vtlActionWithinDeadline } from "./vtl-action-outcome.js"
import { configuredVtlEvents, vtlActionDeadlineSeconds, vtlEventDefinition } from "./vtl-event-catalog.js"
import { VtlReorganizationEntity, VtlRuntimeSnapshotEntity } from "./vtl-runtime.entities.js"
import { vtlTaskTransferDecision } from "./vtl-task-transfer.js"

interface VtlAircraftOverride {
  status?: VtlRuntimeAircraftView["status"]
  groupId?: string
  taskObjectIds?: string[]
  taskSequence?: string[]
  completedTaskObjectIds?: string[]
  position?: V3Coordinate
  remainingEnergyWh?: number
  returnOrDivertResult?: string | null
  actionSimulationTimeMs?: number
  actionOriginPosition?: V3Coordinate
  landingSiteId?: string | null
  transitionDurationMs?: number
  routeOverride?: VtlRoutePlanView
  routeOverrideStartSimulationTimeMs?: number
}

interface VtlPendingTaskTransfer {
  sourceAircraftId: string
  destinationAircraftId: string
  taskObjectId: string
  eventId: string | null
  sourceGroupId: string
  destinationGroupId: string
  requestedAtSimulationTimeMs: number
  reorganizationId?: string
}

interface VtlRuntimeCheckpoint {
  schemaVersion: 1
  clockRate: number
  clockAnchorRealTime: string
  clockAnchorSimulationTimeMs: number
  durationMs: number
  autoPausedForEvent: boolean
  lastSnapshotSequence: number
  lastSnapshotSimulationTimeMs: number
  aircraftOverrides: Record<string, VtlAircraftOverride>
  taskStatusOverrides: Record<string, VtlTaskObjectView["status"]>
  pendingTaskTransfers: VtlPendingTaskTransfer[]
}

interface RuntimeActionInput {
  expectedRevision?: unknown
  requestId?: unknown
  actionCode?: unknown
  eventId?: unknown
  alertId?: unknown
  targetId?: unknown
  targetAircraftId?: unknown
  targetGroupId?: unknown
  taskObjectId?: unknown
  reasoning?: unknown
}

const VTL_HOLD_DURATION_MS = 15_000
const VTL_DIVERSION_MIN_DURATION_MS = 10_000
const VTL_DIVERSION_MAX_DURATION_MS = 30_000
const VTL_TAKEOFF_INTERVAL_MS = 5_000

const systemActor: AuthUser = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "vtl-runtime@system.local",
  displayName: "垂起巡检运行引擎",
  role: "admin"
}

@Injectable()
export class VtlRuntimeService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ProjectActivityCounterEntity) private readonly counters: Repository<ProjectActivityCounterEntity>,
    @InjectRepository(RuntimeSessionEntity) private readonly sessions: Repository<RuntimeSessionEntity>,
    @InjectRepository(RuntimeEventEntity) private readonly events: Repository<RuntimeEventEntity>,
    @InjectRepository(RuntimeAlertEntity) private readonly alerts: Repository<RuntimeAlertEntity>,
    @InjectRepository(StudentRuntimeActionEntity) private readonly actions: Repository<StudentRuntimeActionEntity>,
    @InjectRepository(VtlProjectPlanEntity) private readonly plans: Repository<VtlProjectPlanEntity>,
    @InjectRepository(VtlRuntimeSnapshotEntity) private readonly snapshots: Repository<VtlRuntimeSnapshotEntity>,
    @InjectRepository(VtlReorganizationEntity) private readonly reorganizations: Repository<VtlReorganizationEntity>,
    private readonly activityLog: ActivityLogService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser, requestedSessionId?: string): Promise<VtlRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireProjectAccess(projectId, user, manager)
      const session = requestedSessionId
        ? await manager.findOne(RuntimeSessionEntity, { where: { id: requestedSessionId, projectId } })
        : await this.ensureSession(manager, project, user)
      if (!session) throw new NotFoundException("巡检运行批次不存在")
      if (requestedSessionId) return session.id
      const locked = await manager.findOneOrFail(RuntimeSessionEntity, {
        where: { id: session.id },
        lock: { mode: "pessimistic_write" }
      })
      await this.syncSession(manager, project, locked)
      return locked.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, Boolean(requestedSessionId))
  }

  async start(projectId: string, user: AuthUser, expectedRevision: number): Promise<VtlRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以启动巡检仿真")
      const stage = await this.lockStage(manager, projectId, "VTL_RUNTIME")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("巡检运行阶段不在可启动状态")
      const plan = await this.requirePlan(manager, projectId)
      if (!plan.executionPlan || plan.executionPlan.status !== "SUBMITTED") throw new ConflictException("执行计划尚未提交")
      const session = await this.ensureSession(manager, project, user)
      const locked = await manager.findOneOrFail(RuntimeSessionEntity, { where: { id: session.id }, lock: { mode: "pessimistic_write" } })
      assertRevision(expectedRevision, locked.revision)
      if (locked.status !== "READY") throw new ConflictException("巡检仿真已经启动或已结束")
      const counter = await this.lockCounter(manager, projectId)
      if (counter.runtimeCount >= project.snapshot.config.allowedRuntimeAttempts) throw new ConflictException("运行次数已达到任务限制")
      const checkpoint = parseCheckpoint(locked.checkpoint)
      const now = new Date()
      checkpoint.clockAnchorRealTime = now.toISOString()
      checkpoint.clockAnchorSimulationTimeMs = Number(locked.simulationTimeMs)
      locked.status = "RUNNING"
      locked.startedAt = now
      locked.endedAt = null
      locked.checkpoint = checkpoint as unknown as Record<string, unknown>
      locked.revision += 1
      await manager.save(locked)
      counter.runtimeCount += 1
      await manager.save(counter)
      await this.scheduleEvents(manager, project, locked, plan)
      await this.saveSnapshot(manager, locked, plan, checkpoint, "START")
      project.status = "IN_PROGRESS"
      project.lastActivityAt = now
      await manager.save(project)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "VTL_RUNTIME",
        actor: user,
        eventType: "RUNTIME_STARTED",
        objectType: "RUNTIME_SESSION",
        objectId: locked.id,
        afterRevision: locked.revision,
        result: { attemptNo: locked.attemptNo, totalAircraft: plan.allocation.assignments.length }
      })
      return locked.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, false)
  }

  async setClockRate(projectId: string, user: AuthUser, expectedRevision: number, rate: number, status?: "RUNNING" | "PAUSED"): Promise<VtlRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以控制巡检时钟")
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许调整仿真时钟")
      const session = await this.lockCurrentSession(manager, projectId)
      assertRevision(expectedRevision, session.revision)
      if (!Number.isFinite(rate) || rate < 0.25 || rate > 3_600) throw new BadRequestException("仿真倍率必须在 0.25 到 3600 之间")
      const checkpoint = parseCheckpoint(session.checkpoint)
      const currentTime = currentSimulationTime(session, checkpoint)
      const beforeRate = checkpoint.clockRate
      const beforeStatus = session.status
      const now = new Date()
      checkpoint.clockAnchorSimulationTimeMs = currentTime
      checkpoint.clockAnchorRealTime = now.toISOString()
      checkpoint.clockRate = rate
      if (status === "PAUSED") {
        if (!["RUNNING", "PAUSED"].includes(session.status)) throw new ConflictException("当前运行状态不能暂停")
        if (session.status === "RUNNING") checkpoint.autoPausedForEvent = false
        session.status = "PAUSED"
      }
      if (status === "RUNNING") {
        if (!["RUNNING", "PAUSED"].includes(session.status)) throw new ConflictException("当前运行状态不能恢复")
        const activeEventCount = await manager.count(RuntimeEventEntity, { where: { projectId, sessionId: session.id, status: "ACTIVE" } })
        if (activeEventCount > 0) throw new ConflictException("请先完成当前巡检事件处置，再继续运行")
        session.status = "RUNNING"
        checkpoint.autoPausedForEvent = false
      }
      session.simulationTimeMs = currentTime
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      const beforeRevision = session.revision
      session.revision += 1
      await manager.save(session)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "VTL_RUNTIME",
        actor: user,
        eventType: "RUNTIME_CLOCK_CHANGED",
        objectType: "SIMULATION_CLOCK",
        objectId: session.id,
        simulationTimeMs: currentTime,
        beforeRevision,
        afterRevision: session.revision,
        payload: { beforeRate, afterRate: checkpoint.clockRate, beforeStatus, afterStatus: session.status },
        result: { trainingMode: project.snapshot.mode === "TRAINING" }
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, false)
  }

  async triggerEvent(projectId: string, code: string, user: AuthUser, expectedRevision: number, requestIdValue?: unknown): Promise<VtlRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以手动触发巡检事件")
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许教师临时触发巡检事件")
      const session = await this.lockCurrentSession(manager, projectId)
      const requestId = normalizeRequestId(requestIdValue)
      const requestDefinition = vtlEventDefinition(code)
      if (!requestDefinition) throw new BadRequestException("巡检事件编码无效")
      const previous = requestId ? await this.findManualTriggerByRequestId(manager, projectId, session.id, requestId) : null
      if (previous) {
        if (previous.code !== requestDefinition.code) throw new ConflictException("请求标识已对应其他巡检事件")
        return session.id
      }
      assertRevision(expectedRevision, session.revision)
      if (!["RUNNING", "PAUSED"].includes(session.status)) throw new ConflictException("当前运行状态不能触发事件")
      const plan = await this.requirePlan(manager, projectId)
      const definition = vtlEventDefinition(code)
      if (!definition) throw new BadRequestException("巡检事件编码无效")
      const checkpoint = parseCheckpoint(session.checkpoint)
      const simulationTimeMs = currentSimulationTime(session, checkpoint)
      const now = new Date()
      session.simulationTimeMs = simulationTimeMs
      checkpoint.clockAnchorSimulationTimeMs = simulationTimeMs
      checkpoint.clockAnchorRealTime = now.toISOString()
      if (simulationTimeMs >= checkpoint.durationMs) throw new ConflictException("仿真已结束，不能触发事件")
      const active = await manager.findOne(RuntimeEventEntity, {
        where: { projectId, sessionId: session.id, code: definition.code, status: "ACTIVE" },
        order: { triggeredAt: "DESC" },
        lock: { mode: "pessimistic_write" }
      })
      if (active) return session.id
      if (session.status === "PAUSED") {
        const activeEventCount = await manager.count(RuntimeEventEntity, { where: { projectId, sessionId: session.id, status: "ACTIVE" } })
        if (activeEventCount === 0) {
          session.status = "RUNNING"
          session.endedAt = null
          checkpoint.autoPausedForEvent = false
        }
      }
      const scheduled = await manager.findOne(RuntimeEventEntity, {
        where: { projectId, sessionId: session.id, code: definition.code, status: "SCHEDULED" },
        order: { scheduledSimulationTimeMs: "ASC" },
        lock: { mode: "pessimistic_write" }
      })
      const event = scheduled
        ? await manager.save(Object.assign(scheduled, {
            scheduledSimulationTimeMs: simulationTimeMs,
            triggeredAt: null,
            resolvedAt: null,
            payload: {
              ...scheduled.payload,
              lifecycleStatus: "PENDING",
              actionDeadlineSeconds: vtlActionDeadlineSeconds(definition, scheduled.payload.actionDeadlineSeconds),
              actionDeadlineAtSimulationTimeMs: null,
              detectionAtSimulationTimeMs: simulationTimeMs + definition.detectionDelayMs,
              detectedSimulationTimeMs: null,
              controlledSimulationTimeMs: null,
              escalationAtSimulationTimeMs: simulationTimeMs + definition.detectionDelayMs + definition.escalationDelayMs,
              ...(requestId ? { _manualTriggerRequestId: requestId } : {})
            }
          }))
        : await this.createEvent(manager, project, session, plan, definition.code, simulationTimeMs, requestId ? { _manualTriggerRequestId: requestId } : null)
      await this.advanceEventLifecycle(manager, project, session, plan, simulationTimeMs)
      session.revision += 1
      await manager.save(session)
      await this.saveSnapshot(manager, session, plan, checkpoint, "EVENT")
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "VTL_RUNTIME",
        actor: user,
        eventType: "TEACHER_RUNTIME_INTERVENTION",
        objectType: "RUNTIME_EVENT",
        objectId: event.id,
        simulationTimeMs,
        afterRevision: session.revision,
        payload: { action: "TRIGGER_EVENT", code: definition.code },
        correlationId: event.correlationId
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, false)
  }

  async applyAction(projectId: string, user: AuthUser, input: RuntimeActionInput): Promise<VtlRuntimeWorkspaceView> {
    try {
      const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以执行巡检处置")
      const session = await this.lockCurrentSession(manager, projectId)
      const requestId = normalizeRequestId(input.requestId)
      const requestActionCode = normalizeAction(input.actionCode)
      const previous = requestId ? await this.findActionByRequestId(manager, session.id, user.id, requestId) : null
      if (previous) {
        assertSameActionRequest(previous, input, requestActionCode)
        return session.id
      }
      assertRevision(numberOrUndefined(input.expectedRevision), session.revision)
      if (!["RUNNING", "PAUSED"].includes(session.status)) throw new ConflictException("当前运行状态不能执行处置")
      const actionCode = normalizeAction(input.actionCode)
      const reasoning = normalizeRuntimeActionReasoning(input.reasoning)
      const plan = await this.requirePlan(manager, projectId)
      const checkpoint = parseCheckpoint(session.checkpoint)
      const simulationTimeMs = currentSimulationTime(session, checkpoint)
      session.simulationTimeMs = simulationTimeMs
      const event = await this.findEvent(manager, projectId, session.id, input.eventId)
      const targetId = optionalText(input.targetId)
      const targetAircraft = plan.allocation.assignments.find((item) => item.aircraftId === targetId)
      if (actionCode !== "ACKNOWLEDGE" && !targetAircraft && actionCode !== "TRANSFER_TASK" && actionCode !== "ADJUST_GROUP") {
        throw new BadRequestException("处置目标航空器不存在")
      }
      let appliedAction: StudentRuntimeActionEntity
      if (actionCode === "ACKNOWLEDGE") {
        if (!event) throw new BadRequestException("确认告警必须关联事件")
        const lifecycle = String(event.payload.lifecycleStatus ?? (event.status === "SCHEDULED" ? "PENDING" : event.status === "RESOLVED" ? "RESOLVED" : "ACTIVE"))
        if (!["OCCURRED_UNDETECTED", "ACTIVE", "ESCALATED"].includes(lifecycle)) throw new ConflictException("当前事件尚未进入可确认状态")
        appliedAction = await this.acknowledgeEvent(manager, project, event, session.id, user.id, simulationTimeMs, reasoning, requestId)
      } else {
        if (event && String(event.payload.lifecycleStatus ?? "ACTIVE") === "RESOLVED") throw new ConflictException("当前事件已经处置完成")
        appliedAction = await this.applyAircraftAction(manager, project, session, plan, checkpoint, event, actionCode, input, targetId, simulationTimeMs, reasoning, requestId)
      }
      const eventPauseTransition = await this.finishEventPauseIfReady(manager, project, session, checkpoint)
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      const beforeRevision = session.revision
      session.revision += 1
      await manager.save(session)
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: "VTL_RUNTIME",
        actor: user,
        eventType: "RUNTIME_ACTION_APPLIED",
        objectType: "RUNTIME_ACTION",
        objectId: appliedAction.id,
        simulationTimeMs,
        beforeRevision,
        afterRevision: session.revision,
        payload: {
          actionCode: appliedAction.actionCode,
          targetId: appliedAction.targetId,
          eventId: appliedAction.eventId,
          alertId: appliedAction.alertId,
          reasoning,
          rationale: reasoning.rationale
        },
        result: appliedAction.result,
        correlationId: appliedAction.correlationId
      })
      await this.saveSnapshot(manager, session, plan, checkpoint, eventPauseTransition === "COMPLETED" ? "COMPLETE" : "ACTION")
      if (eventPauseTransition === "COMPLETED") await this.openEmergencyStage(manager, project)
      return session.id
      })
      return this.serializeWorkspace(projectId, sessionId, user, false)
    } catch (error) {
      await persistRejectedRuntimeAction(this.actions, this.sessions, {
        projectId,
        actorId: user.id,
        actionCode: input.actionCode,
        requestId: input.requestId,
        targetId: input.targetId,
        error
      }).catch(() => undefined)
      throw error
    }
  }

  async completeEmergency(projectId: string, user: AuthUser, expectedRevision: number): Promise<VtlRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以提交事件处置")
      const session = await this.lockCurrentSession(manager, projectId)
      assertRevision(expectedRevision, session.revision)
      if (!["COMPLETED", "ABORTED"].includes(session.status)) throw new ConflictException("仿真尚未结束")
      const emergency = await this.lockStage(manager, projectId, "VTL_EMERGENCY_HANDLING")
      if (emergency.status !== "IN_PROGRESS") throw new ConflictException("事件处置阶段尚未开始")
      const activeEvents = await manager.count(RuntimeEventEntity, { where: { projectId, sessionId: session.id, status: "ACTIVE" } })
      if (activeEvents > 0) throw new ConflictException("仍有未完成的巡检事件")
      const review = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "VTL_REVIEW" } })
      if (!review && openVtlStageCodes(project).includes("VTL_REVIEW")) throw new NotFoundException("巡检复盘阶段不存在")
      await completeVtlStage(manager, project, "VTL_EMERGENCY_HANDLING", review ? "EVALUATING" : "SUBMITTED")
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "VTL_EMERGENCY_HANDLING",
        actor: user,
        eventType: "RUNTIME_EMERGENCY_SUBMITTED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        afterRevision: session.revision
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, false)
  }

  async listEvents(projectId: string, user: AuthUser) {
    await this.requireProjectAccess(projectId, user)
    return (await this.events.find({ where: { projectId }, order: { scheduledSimulationTimeMs: "ASC" } })).map(serializeEvent)
  }

  private async serializeWorkspace(projectId: string, sessionId: string, user: AuthUser, historical: boolean): Promise<VtlRuntimeWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const plan = await this.requirePlan(this.dataSource.manager, projectId)
    const session = await this.sessions.findOneByOrFail({ id: sessionId, projectId })
    const checkpoint = parseCheckpoint(session.checkpoint)
    const [events, alerts, actions, reorganizations, attempts] = await Promise.all([
      this.events.find({ where: { projectId, sessionId }, order: { scheduledSimulationTimeMs: "ASC" } }),
      this.alerts.find({ where: { projectId, sessionId }, order: { openedAt: "DESC" } }),
      this.actions.find({ where: { projectId, sessionId }, order: { requestedAt: "ASC" } }),
      this.reorganizations.find({ where: { projectId, sessionId }, order: { executedAtMs: "ASC" } }),
      this.sessions.find({ where: { projectId }, order: { attemptNo: "DESC" } })
    ])
    const projection = projectProjection(plan, checkpoint, Number(session.simulationTimeMs), events)
    const runtimeEvents = events.map(serializeVtlEvent)
    const runtimeAlerts = alerts.map(serializeAlert)
    const availableActions = availableActionsFor(actor, session, runtimeEvents, projection.aircraft, plan, checkpoint)
    const assessmentWritable = assessmentTimingForProject(project).canWrite
    return {
      projectId,
      actor,
      mode: project.snapshot.mode,
      scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
      situationLevel: "OVERALL",
      session: serializeSession(session),
      clock: adaptRuntimeClock(session, {
        rate: checkpoint.clockRate,
        deadlineAt: assessmentTimingForProject(project).deadlineAt,
        canPause: actor === "STUDENT" && assessmentWritable && project.snapshot.mode === "TRAINING" && ["RUNNING", "PAUSED"].includes(session.status),
        canReset: actor === "STUDENT" && assessmentWritable && project.snapshot.mode === "TRAINING" && session.status !== "READY"
      }),
      attempts: attempts.map(serializeSession),
      canStart: actor === "STUDENT" && assessmentWritable && session.status === "READY",
      canControl: assessmentWritable && canStudentControlVtlRuntime(actor, session.status),
      canTeacherIntervene: actor === "TEACHER" && project.snapshot.mode === "TRAINING" && assessmentWritable && ["RUNNING", "PAUSED"].includes(session.status),
      clockRate: checkpoint.clockRate,
      durationMs: checkpoint.durationMs,
      remainingMs: Math.max(0, checkpoint.durationMs - Number(session.simulationTimeMs)),
      summary: projection.summary,
      groups: projection.groups,
      aircraft: projection.aircraft,
      taskObjects: projection.taskObjects,
      events: runtimeEvents,
      alerts: runtimeAlerts,
      actions: actions.map(serializeAction),
      availableActions,
      reorganizations: reorganizations.map(serializeReorganization),
      ...(historical ? {} : {})
    }
  }

  private async syncSession(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity): Promise<void> {
    if (session.status !== "RUNNING") return
    const plan = await this.requirePlan(manager, project.id)
    const checkpoint = parseCheckpoint(session.checkpoint)
    const previousTime = Number(session.simulationTimeMs)
    const requestedTime = Math.min(checkpoint.durationMs, currentSimulationTime(session, checkpoint))
    const eventPauseTime = await this.nextEventPauseTime(manager, project.id, session.id, previousTime, requestedTime)
    const nextTime = eventPauseTime === null ? requestedTime : Math.min(requestedTime, Math.max(previousTime, eventPauseTime))
    if (nextTime <= previousTime && eventPauseTime === null && previousTime < checkpoint.durationMs) return
    session.simulationTimeMs = nextTime
    const triggered = await this.advanceEventLifecycle(manager, project, session, plan, nextTime)
    const transferSettled = await this.settlePendingTaskTransfers(manager, project, session, plan, checkpoint, nextTime)
    const reachedEnd = nextTime >= checkpoint.durationMs
    const activeEventCount = reachedEnd
      ? await manager.count(RuntimeEventEntity, { where: { projectId: project.id, sessionId: session.id, status: "ACTIVE" } })
      : 0
    const pausedForEvent = eventPauseTime !== null || reachedEnd && activeEventCount > 0
    const completed = reachedEnd && !pausedForEvent
    if (pausedForEvent) {
      const now = new Date()
      session.status = "PAUSED"
      session.endedAt = null
      checkpoint.autoPausedForEvent = true
      checkpoint.clockAnchorSimulationTimeMs = nextTime
      checkpoint.clockAnchorRealTime = now.toISOString()
    } else if (completed) {
      session.status = "COMPLETED"
      session.endedAt = new Date()
      checkpoint.autoPausedForEvent = false
      checkpoint.clockAnchorSimulationTimeMs = nextTime
      checkpoint.clockAnchorRealTime = new Date().toISOString()
    }
    session.checkpoint = checkpoint as unknown as Record<string, unknown>
    session.revision += 1
    await manager.save(session)
    if (completed) {
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: "VTL_RUNTIME",
        actor: systemActor,
        eventType: "RUNTIME_COMPLETED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        simulationTimeMs: nextTime,
        afterRevision: session.revision,
        result: { durationMs: checkpoint.durationMs, completedTaskObjects: projectProjection(plan, checkpoint, nextTime, []).summary.completedTaskObjects },
        correlationId: session.id
      })
    }
    if (triggered || transferSettled || pausedForEvent || completed || nextTime - checkpoint.lastSnapshotSimulationTimeMs >= 5_000) {
      await this.saveSnapshot(manager, session, plan, checkpoint, completed ? "COMPLETE" : pausedForEvent || triggered ? "EVENT" : "TICK")
    }
    if (completed) await this.openEmergencyStage(manager, project)
  }

  private async nextEventPauseTime(
    manager: EntityManager,
    projectId: string,
    sessionId: string,
    fromSimulationTimeMs: number,
    toSimulationTimeMs: number
  ): Promise<number | null> {
    const events = await manager.find(RuntimeEventEntity, { where: { projectId, sessionId } })
    let nextPauseTime: number | null = null
    for (const event of events) {
      if (event.status === "RESOLVED") continue
      const lifecycle = String(event.payload.lifecycleStatus ?? (event.status === "SCHEDULED" ? "PENDING" : "ACTIVE"))
      if (event.status === "ACTIVE" && ["ACTIVE", "HANDLING", "ESCALATED"].includes(lifecycle)) {
        return fromSimulationTimeMs
      }
      if (event.status !== "SCHEDULED" && lifecycle !== "OCCURRED_UNDETECTED" && lifecycle !== "PENDING") continue
      const scheduledAt = Math.max(0, Number(event.scheduledSimulationTimeMs ?? 0))
      const detectionAt = Math.max(scheduledAt, finiteNumber(event.payload.detectionAtSimulationTimeMs, scheduledAt))
      if (detectionAt > toSimulationTimeMs) continue
      const candidate = Math.max(fromSimulationTimeMs, detectionAt)
      nextPauseTime = nextPauseTime === null ? candidate : Math.min(nextPauseTime, candidate)
    }
    return nextPauseTime
  }

  private async advanceEventLifecycle(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, plan: VtlProjectPlanEntity, simulationTimeMs: number): Promise<boolean> {
    const scheduled = await manager.find(RuntimeEventEntity, { where: { projectId: project.id, sessionId: session.id, status: "SCHEDULED" } })
    let changed = false
    for (const event of scheduled) {
      if (event.scheduledSimulationTimeMs === null || Number(event.scheduledSimulationTimeMs) > simulationTimeMs) continue
      event.status = "ACTIVE"
      event.triggeredSimulationTimeMs = simulationTimeMs
      event.triggeredAt = new Date()
      const payload = event.payload
      payload.lifecycleStatus = "OCCURRED_UNDETECTED"
      payload.detectedSimulationTimeMs = null
      event.payload = payload
      await manager.save(event)
      await this.recordRuntimeEventActivity(manager, project, event, "RUNTIME_EVENT_TRIGGERED", event.id, simulationTimeMs, {
        code: event.code,
        category: event.category,
        title: payload.title,
        detail: payload.detail,
        severity: event.severity,
        affectedAircraftIds: payload.affectedAircraftIds
      })
      changed = true
    }
    const active = await manager.find(RuntimeEventEntity, { where: { projectId: project.id, sessionId: session.id, status: "ACTIVE" } })
    for (const event of active) {
      const payload = event.payload
      const lifecycle = String(payload.lifecycleStatus ?? "OCCURRED_UNDETECTED")
      const detectionAt = Number(payload.detectionAtSimulationTimeMs ?? event.scheduledSimulationTimeMs ?? 0)
      if (lifecycle === "OCCURRED_UNDETECTED" && simulationTimeMs >= detectionAt) {
        payload.lifecycleStatus = "ACTIVE"
        payload.detectedSimulationTimeMs = simulationTimeMs
        payload.actionDeadlineAtSimulationTimeMs = payload.actionDeadlineSeconds === null || payload.actionDeadlineSeconds === undefined
          ? null
          : simulationTimeMs + Math.max(0, Number(payload.actionDeadlineSeconds)) * 1_000
        event.payload = payload
        await manager.save(event)
        const existingAlert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id, sessionId: session.id } })
        const alert = existingAlert ?? await this.openEventAlert(manager, project, session, event, simulationTimeMs)
        await this.recordRuntimeEventActivity(manager, project, event, "RUNTIME_EVENT_DISCOVERED", alert.id, simulationTimeMs, {
          title: alert.title,
          detail: alert.detail,
          affectedAircraftIds: payload.affectedAircraftIds
        }, { eventId: event.id, severity: event.severity })
        changed = true
      }
      const escalationAt = Number(payload.escalationAtSimulationTimeMs ?? Number.POSITIVE_INFINITY)
      if (["ACTIVE", "HANDLING"].includes(String(payload.lifecycleStatus)) && simulationTimeMs >= escalationAt) {
        payload.lifecycleStatus = "ESCALATED"
        payload.escalatedSimulationTimeMs = simulationTimeMs
        event.payload = payload
        event.severity = "CRITICAL"
        await manager.save(event)
        const alert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id, sessionId: session.id } })
        if (alert) {
          alert.severity = "CRITICAL"
          alert.status = "OPEN"
          alert.detail = `${alert.detail}；处置超时，事件已升级`
          alert.payload = mergeRuntimeAlertPayload(payload, alert.payload)
          await manager.save(alert)
        } else {
          await this.openEventAlert(manager, project, session, event, simulationTimeMs)
        }
        await this.recordRuntimeEventActivity(manager, project, event, "RUNTIME_EVENT_ESCALATED", event.id, simulationTimeMs, {
          code: event.code,
          severity: event.severity,
          affectedAircraftIds: payload.affectedAircraftIds
        })
        changed = true
      }
    }
    return changed
  }

  private async openEventAlert(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, event: RuntimeEventEntity, simulationTimeMs: number): Promise<RuntimeAlertEntity> {
      const payload = event.payload
      const affectedAircraftIds = arrayOfStrings(payload.affectedAircraftIds)
      return manager.save(manager.create(RuntimeAlertEntity, {
        projectId: project.id,
        sessionId: session.id,
        eventId: event.id,
        stageCode: "VTL_RUNTIME",
        code: event.code,
        title: String(payload.title ?? event.code),
        detail: String(payload.detail ?? "巡检事件需要处置"),
        severity: event.severity,
        status: "OPEN",
        simulationTimeMs,
        openedAt: new Date(),
        acknowledgedAt: null,
        resolvedAt: null,
        payload: mergeRuntimeAlertPayload(payload, { affectedAircraftIds }),
        correlationId: event.correlationId
      }))
  }

  private async scheduleEvents(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, plan: VtlProjectPlanEntity): Promise<void> {
    const configs = configuredVtlEvents(project.snapshot.config.scenario.eventConfigs ?? project.snapshot.config.scenario.eventCodes)
    const durationMs = parseCheckpoint(session.checkpoint).durationMs
    for (const [index, configured] of configs.entries()) {
      const config = configured.scenarioConfig
      const configuredTime = config?.triggerTimeSeconds === null || config?.triggerTimeSeconds === undefined
        ? Math.round(durationMs * ((index + 1) / (configs.length + 1)))
        : Math.max(0, Math.round(config.triggerTimeSeconds * 1_000))
      await this.createEvent(manager, project, session, plan, configured.code, configuredTime, config ? { ...config } : null)
    }
  }

  private async createEvent(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, plan: VtlProjectPlanEntity, code: string, scheduledTimeMs: number, config: Record<string, unknown> | null): Promise<RuntimeEventEntity> {
    const definition = vtlEventDefinition(code)
    if (!definition) throw new BadRequestException("巡检事件编码无效")
    const affectedAircraftIds = resolveAffectedAircraft(plan, config)
    const event = manager.create(RuntimeEventEntity, {
      projectId: project.id,
      sessionId: session.id,
      stageCode: "VTL_RUNTIME",
      code: definition.code,
      category: definition.category,
      status: "SCHEDULED",
      severity: (config && typeof config.severity === "string" ? config.severity : definition.severity) as V3AlertSeverity,
      scheduledSimulationTimeMs: scheduledTimeMs,
      triggeredAt: null,
      resolvedAt: null,
      payload: {
        title: definition.title,
        detail: definition.detail,
        lifecycleStatus: "PENDING",
        affectedAircraftIds,
        recommendedActions: definition.recommendedActions,
        actionDeadlineSeconds: vtlActionDeadlineSeconds(definition, config?.actionDeadlineSeconds),
        actionDeadlineAtSimulationTimeMs: null,
        detectionAtSimulationTimeMs: scheduledTimeMs + definition.detectionDelayMs,
        detectedSimulationTimeMs: null,
        controlledSimulationTimeMs: null,
        escalationAtSimulationTimeMs: scheduledTimeMs + definition.detectionDelayMs + definition.escalationDelayMs,
        ...(typeof config?._manualTriggerRequestId === "string" ? { _manualTriggerRequestId: config._manualTriggerRequestId } : {})
      },
      correlationId: randomUUID()
    })
    return manager.save(event)
  }

  private async applyAircraftAction(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, plan: VtlProjectPlanEntity, checkpoint: VtlRuntimeCheckpoint, event: RuntimeEventEntity | null, action: VtlRuntimeActionCode, input: RuntimeActionInput, targetAircraftId: string | null, simulationTimeMs: number, reasoning: V3RuntimeActionReasoning, requestId: string | null): Promise<StudentRuntimeActionEntity> {
    const targetId = targetAircraftId ?? (event ? arrayOfStrings(event.payload.affectedAircraftIds)[0] ?? null : null)
    const target = targetId ? plan.allocation.assignments.find((item) => item.aircraftId === targetId) : null
    if (!target && !["TRANSFER_TASK", "ADJUST_GROUP"].includes(action)) throw new BadRequestException("处置目标航空器不存在")
    const currentProjection = projectProjection(plan, checkpoint, simulationTimeMs, [])
    const currentAircraft = targetId ? currentProjection.aircraft.find((item) => item.aircraftId === targetId) ?? null : null
    const before = target ? effectiveAssignment(plan, checkpoint, target) : null
    let landingSiteTitle: string | null = null
    let reorganizationMessage: string | null = null
    if (action === "TRANSFER_TASK") {
      const sourceId = targetId
      const destinationId = optionalText(input.targetAircraftId) ?? optionalText(input.targetId)
      const taskId = optionalText(input.taskObjectId)
      if (!sourceId || !destinationId || !taskId || sourceId === destinationId) throw new BadRequestException("任务转移需要源航空器、目标航空器和任务对象")
      const source = plan.allocation.assignments.find((item) => item.aircraftId === sourceId)
      const destination = plan.allocation.assignments.find((item) => item.aircraftId === destinationId)
      if (!source || !destination) throw new BadRequestException("任务转移航空器不存在")
      const sourceView = effectiveAssignment(plan, checkpoint, source)
      const destinationView = effectiveAssignment(plan, checkpoint, destination)
      const sourceAircraft = currentProjection.aircraft.find((item) => item.aircraftId === sourceId)
      const destinationAircraft = currentProjection.aircraft.find((item) => item.aircraftId === destinationId)
      const task = plan.taskObjects.find((item) => item.id === taskId)
      if (!task) throw new BadRequestException("任务转移对象不存在")
      if (!sourceView.taskObjectIds.includes(taskId)) throw new ConflictException("源航空器未持有该未完成任务")
      if (!sourceAircraft || !["WAITING", "ACTIVE", "HOLDING"].includes(sourceAircraft.status)) throw new ConflictException("源航空器当前不能转移任务")
      if (!destinationAircraft || !["WAITING", "ACTIVE"].includes(destinationAircraft.status)) throw new ConflictException("目标航空器当前不能接收任务")
      if (destinationView.taskObjectIds.includes(taskId)) throw new ConflictException("目标航空器已经持有该任务")
      const completedTaskIds = new Set(currentProjection.aircraft.flatMap((item) => item.completedTaskObjectIds))
      if (completedTaskIds.has(taskId) || checkpoint.taskStatusOverrides[taskId] === "COMPLETED") throw new ConflictException("已完成巡检任务不能转移")
      const landingSite = findLandingSite(plan, sourceId, false)
      if (!landingSite) throw new ConflictException("源航空器没有可用主起降点，不能安全退出")
      const transitionDurationMs = diversionDurationMs(sourceAircraft.position, landingSite.position, plan.aircraftParameters.cruiseSpeedMps)
      setAssignmentOverride(checkpoint, sourceId, {
        status: "RETURNING",
        position: { ...sourceAircraft.position },
        remainingEnergyWh: sourceAircraft.remainingEnergyWh,
        completedTaskObjectIds: sourceAircraft.completedTaskObjectIds,
        actionSimulationTimeMs: simulationTimeMs,
        actionOriginPosition: { ...sourceAircraft.position },
        landingSiteId: landingSite.id,
        transitionDurationMs,
        returnOrDivertResult: "返航"
      })
      checkpoint.pendingTaskTransfers = checkpoint.pendingTaskTransfers.filter((item) => item.taskObjectId !== taskId)
      checkpoint.pendingTaskTransfers.push({
        sourceAircraftId: sourceId,
        destinationAircraftId: destinationId,
        taskObjectId: taskId,
        eventId: event?.id ?? null,
        sourceGroupId: sourceView.groupId,
        destinationGroupId: destinationView.groupId,
        requestedAtSimulationTimeMs: simulationTimeMs
      })
      landingSiteTitle = landingSite.title
      reorganizationMessage = "已安排源航空器安全返场，落地后由接替航空器接管任务"
      const pendingReorganization = await this.saveReorganization(
        manager,
        project.id,
        session.id,
        event?.id ?? null,
        action,
        sourceId,
        destinationId,
        sourceView.groupId,
        destinationView.groupId,
        [],
        sourceView.taskSequence,
        [],
        true,
        reorganizationMessage,
        simulationTimeMs
      )
      checkpoint.pendingTaskTransfers.at(-1)!.reorganizationId = pendingReorganization.id
    } else if (action === "ADJUST_GROUP") {
      if (!targetId) throw new BadRequestException("分组调整需要航空器")
      const targetGroupId = optionalText(input.targetGroupId)
      const group = plan.allocation.groups.find((item) => item.id === targetGroupId)
      if (!group) throw new BadRequestException("目标分组不存在")
      if (!currentAircraft || ["LANDED", "CANCELLED"].includes(currentAircraft.status)) throw new ConflictException("当前航空器不能调整分组")
      const previousGroupId = effectiveAssignment(plan, checkpoint, plan.allocation.assignments.find((item) => item.aircraftId === targetId)!).groupId
      setAssignmentOverride(checkpoint, targetId, { groupId: group.id })
      reorganizationMessage = "已完成航空器动态分组调整"
      await this.saveReorganization(manager, project.id, session.id, event?.id ?? null, action, targetId, null, previousGroupId, group.id, [], [], [], true, reorganizationMessage, simulationTimeMs)
    } else {
      if (!targetId) throw new BadRequestException("处置目标航空器不存在")
      if (!currentAircraft) throw new BadRequestException("处置目标航空器不存在")
      const override = checkpoint.aircraftOverrides[targetId] ?? {}
      const nextStatus: VtlRuntimeAircraftView["status"] = action === "HOLD"
        ? "HOLDING"
        : action === "RETURN_AIRCRAFT"
          ? "RETURNING"
          : action === "DIVERT_AIRCRAFT"
            ? "DIVERTING"
            : action === "CANCEL_NOT_STARTED"
            ? "CANCELLED"
              : override.status ?? "ACTIVE"
      if (action === "HOLD" && !["WAITING", "ACTIVE"].includes(currentAircraft.status)) throw new ConflictException("当前航空器不能进入等待")
      if (["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"].includes(action) && ["LANDED", "CANCELLED", "RETURNING", "DIVERTING"].includes(currentAircraft.status)) throw new ConflictException("当前航空器不能再次返航或备降")
      if (action === "CANCEL_NOT_STARTED" && currentAircraft.status !== "WAITING") throw new ConflictException("只有尚未起飞的航空器可以取消")
      const landingSite = action === "RETURN_AIRCRAFT" || action === "DIVERT_AIRCRAFT"
        ? findLandingSite(plan, targetId, action === "DIVERT_AIRCRAFT")
        : null
      landingSiteTitle = landingSite?.title ?? null
      const actionPosition = { ...currentAircraft.position }
      const transitionDurationMs = landingSite
        ? diversionDurationMs(actionPosition, landingSite.position, plan.aircraftParameters.cruiseSpeedMps)
        : undefined
      checkpoint.aircraftOverrides[targetId] = {
        ...override,
        status: nextStatus,
        position: actionPosition,
        remainingEnergyWh: currentAircraft.remainingEnergyWh,
        completedTaskObjectIds: currentAircraft.completedTaskObjectIds,
        actionSimulationTimeMs: simulationTimeMs,
        actionOriginPosition: actionPosition,
        ...(landingSite ? { landingSiteId: landingSite.id, transitionDurationMs: transitionDurationMs! } : {}),
        ...(action === "DIVERT_AIRCRAFT" ? { returnOrDivertResult: "备降" } : action === "RETURN_AIRCRAFT" ? { returnOrDivertResult: "返航" } : {})
      }
      if (action === "CANCEL_NOT_STARTED") {
        for (const taskId of before?.taskObjectIds ?? []) {
          if (!currentAircraft.completedTaskObjectIds.includes(taskId)) checkpoint.taskStatusOverrides[taskId] = "INCOMPLETE"
        }
      }
      await this.saveReorganization(manager, project.id, session.id, event?.id ?? null, action, targetId, null, before?.groupId ?? null, before?.groupId ?? null, (before?.taskObjectIds ?? []).filter((taskId) => !currentAircraft.completedTaskObjectIds.includes(taskId)), before?.taskSequence ?? [], before?.taskSequence ?? [], true, actionLabel(action), simulationTimeMs)
    }
    if (event) await this.resolveEvent(manager, project, event, simulationTimeMs, action)
    const alert = event ? await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id, sessionId: session.id } }) : null
    if (alert) {
      alert.status = "RESOLVED"
      alert.resolvedAt = new Date()
      await manager.save(alert)
    }
    const afterProjection = projectProjection(plan, checkpoint, simulationTimeMs, [])
    const afterAircraft = targetId ? afterProjection.aircraft.find((item) => item.aircraftId === targetId) ?? null : null
    const afterAssignment = targetId
      ? plan.allocation.assignments.find((item) => item.aircraftId === targetId)
      : null
    const outcome = vtlActionBusinessOutcome({
      actionCode: action,
      beforeAircraft: currentAircraft,
      afterAircraft,
      taskObjects: afterProjection.taskObjects,
      assignedTaskObjectIds: afterAssignment ? effectiveAssignment(plan, checkpoint, afterAssignment).taskObjectIds : [],
      landingSiteTitle,
      reorganizationMessage
    })
    const detectedSimulationTimeMs = nullableFiniteNumber(event?.payload.detectedSimulationTimeMs)
    const actionDeadlineAtSimulationTimeMs = nullableFiniteNumber(event?.payload.actionDeadlineAtSimulationTimeMs)
    const responseTimeMs = detectedSimulationTimeMs === null ? null : Math.max(0, simulationTimeMs - detectedSimulationTimeMs)
    const actionEntity = manager.create(StudentRuntimeActionEntity, {
      projectId: project.id,
      sessionId: session.id,
      eventId: event?.id ?? null,
      alertId: alert?.id ?? null,
      actorId: project.student.id,
      actionCode: action,
      targetType: action === "ADJUST_GROUP" ? "GROUP" : "AIRCRAFT",
      targetId,
      status: "APPLIED",
      simulationTimeMs,
      payload: {
        reasoning,
        rationale: reasoning.rationale,
        taskObjectId: optionalText(input.taskObjectId),
        targetAircraftId: optionalText(input.targetAircraftId),
        targetGroupId: optionalText(input.targetGroupId),
        ...(requestId ? { _requestId: requestId } : {})
      },
      result: {
        message: action === "TRANSFER_TASK" && reorganizationMessage ? reorganizationMessage : actionLabel(action),
        checkPassed: true,
        ...outcome,
        responseTimeMs,
        withinDeadline: vtlActionWithinDeadline(actionDeadlineAtSimulationTimeMs, simulationTimeMs),
        eventControlled: event ? true : null,
        actionDeadlineSeconds: event?.payload.actionDeadlineSeconds ?? null
      },
      correlationId: event?.correlationId ?? randomUUID(),
      requestedAt: new Date(),
      appliedAt: new Date()
    })
    await manager.save(actionEntity)
    return actionEntity
  }

  private async acknowledgeEvent(manager: EntityManager, project: StudentProjectEntity, event: RuntimeEventEntity, sessionId: string, actorId: string, simulationTimeMs: number, reasoning: V3RuntimeActionReasoning, requestId: string | null): Promise<StudentRuntimeActionEntity> {
    const payload = event.payload
    payload.lifecycleStatus = "HANDLING"
    payload.detectedSimulationTimeMs = simulationTimeMs
    event.payload = payload
    await manager.save(event)
    let alert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id, sessionId } })
    let discoveredByStudent = false
    if (!alert) {
      const eventPayload = event.payload
      alert = await manager.save(manager.create(RuntimeAlertEntity, {
        projectId: project.id,
        sessionId,
        eventId: event.id,
        stageCode: "VTL_RUNTIME",
        code: event.code,
        title: String(eventPayload.title ?? event.code),
        detail: String(eventPayload.detail ?? "巡检事件需要处置"),
        severity: event.severity,
        status: "OPEN",
        simulationTimeMs,
        openedAt: new Date(),
        acknowledgedAt: null,
        resolvedAt: null,
        payload: mergeRuntimeAlertPayload(eventPayload, { affectedAircraftIds: arrayOfStrings(eventPayload.affectedAircraftIds) }),
        correlationId: event.correlationId
      }))
      discoveredByStudent = true
    }
    if (discoveredByStudent) {
      await this.recordRuntimeEventActivity(manager, project, event, "RUNTIME_EVENT_DISCOVERED", alert.id, simulationTimeMs, {
        title: alert.title,
        detail: alert.detail,
        affectedAircraftIds: event.payload.affectedAircraftIds
      }, { eventId: event.id, discovery: "STUDENT_ACKNOWLEDGEMENT", severity: event.severity })
    }
    alert.status = "ACKNOWLEDGED"
    alert.acknowledgedAt = new Date()
    await manager.save(alert)
    return manager.save(manager.create(StudentRuntimeActionEntity, {
      projectId: project.id,
      sessionId,
      eventId: event.id,
      alertId: alert?.id ?? null,
      actorId,
      actionCode: "ACKNOWLEDGE",
      targetType: "EVENT",
      targetId: event.id,
      status: "APPLIED",
      simulationTimeMs,
      payload: { reasoning, rationale: reasoning.rationale, ...(requestId ? { _requestId: requestId } : {}) },
      result: { message: "已确认巡检告警" },
      correlationId: event.correlationId,
      requestedAt: new Date(),
      appliedAt: new Date()
    }))
  }

  private async resolveEvent(manager: EntityManager, project: StudentProjectEntity, event: RuntimeEventEntity, simulationTimeMs: number, action: VtlRuntimeActionCode): Promise<void> {
    const payload = event.payload
    payload.lifecycleStatus = "RESOLVED"
    payload.detectedSimulationTimeMs ??= simulationTimeMs
    payload.controlledSimulationTimeMs = simulationTimeMs
    payload.resolutionAction = action
    event.payload = payload
    event.status = "RESOLVED"
    event.resolvedSimulationTimeMs = simulationTimeMs
    event.resolvedAt = new Date()
    await manager.save(event)
    await this.recordRuntimeEventActivity(manager, project, event, "RUNTIME_EVENT_RESOLVED", event.id, simulationTimeMs, {
      code: event.code,
      resolutionAction: action
    }, { lifecycleStatus: "RESOLVED" })
  }

  private async recordRuntimeEventActivity(
    manager: EntityManager,
    project: StudentProjectEntity,
    event: RuntimeEventEntity,
    eventType: "RUNTIME_EVENT_TRIGGERED" | "RUNTIME_EVENT_DISCOVERED" | "RUNTIME_EVENT_ESCALATED" | "RUNTIME_EVENT_RESOLVED",
    objectId: string,
    simulationTimeMs: number,
    payload: Record<string, unknown>,
    result?: Record<string, unknown>
  ): Promise<void> {
    await this.activityLog.record(manager, {
      assignmentId: project.snapshot.draft.id,
      projectId: project.id,
      stageCode: "VTL_RUNTIME",
      actor: systemActor,
      eventType,
      objectType: eventType === "RUNTIME_EVENT_DISCOVERED" ? "RUNTIME_ALERT" : "RUNTIME_EVENT",
      objectId,
      simulationTimeMs,
      payload,
      ...(result ? { result } : {}),
      correlationId: event.correlationId
    })
  }

  private async finishEventPauseIfReady(
    manager: EntityManager,
    project: StudentProjectEntity,
    session: RuntimeSessionEntity,
    checkpoint: VtlRuntimeCheckpoint
  ): Promise<"NONE" | "RESUMED" | "COMPLETED"> {
    if (session.status !== "PAUSED" || !checkpoint.autoPausedForEvent) return "NONE"
    const activeEventCount = await manager.count(RuntimeEventEntity, {
      where: { projectId: project.id, sessionId: session.id, status: "ACTIVE" }
    })
    if (activeEventCount > 0) return "NONE"

    checkpoint.autoPausedForEvent = false
    const now = new Date()
    const simulationTimeMs = Number(session.simulationTimeMs)
    checkpoint.clockAnchorSimulationTimeMs = simulationTimeMs
    checkpoint.clockAnchorRealTime = now.toISOString()
    if (simulationTimeMs >= checkpoint.durationMs) {
      session.status = "COMPLETED"
      session.endedAt = now
      await this.activityLog.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: "VTL_RUNTIME",
        actor: systemActor,
        eventType: "RUNTIME_COMPLETED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        simulationTimeMs,
        afterRevision: session.revision + 1,
        result: { durationMs: checkpoint.durationMs },
        correlationId: session.id
      })
      return "COMPLETED"
    }
    if (project.snapshot.mode === "ASSESSMENT") {
      session.status = "RUNNING"
      session.endedAt = null
      return "RESUMED"
    }
    return "NONE"
  }

  private async saveReorganization(manager: EntityManager, projectId: string, sessionId: string, eventId: string | null, action: VtlRuntimeActionCode, sourceAircraftId: string | null, targetAircraftId: string | null, sourceGroupId: string | null, targetGroupId: string | null, taskObjectIds: string[], previousTaskOrder: string[], nextTaskOrder: string[], checkPassed: boolean, message: string, executedAtMs: number): Promise<VtlReorganizationEntity> {
    return manager.save(manager.create(VtlReorganizationEntity, { projectId, sessionId, eventId, action, sourceAircraftId, targetAircraftId, sourceGroupId, targetGroupId, taskObjectIds, previousTaskOrder, nextTaskOrder, checkPassed, message, executedAtMs }))
  }

  private async settleReorganization(
    manager: EntityManager,
    projectId: string,
    sessionId: string,
    pending: VtlPendingTaskTransfer,
    taskObjectIds: string[],
    previousTaskOrder: string[],
    nextTaskOrder: string[],
    checkPassed: boolean,
    message: string,
    executedAtMs: number
  ): Promise<void> {
    const existing = pending.reorganizationId
      ? await manager.findOne(VtlReorganizationEntity, { where: { id: pending.reorganizationId, projectId, sessionId } })
      : null
    if (existing) {
      existing.taskObjectIds = taskObjectIds
      existing.previousTaskOrder = previousTaskOrder
      existing.nextTaskOrder = nextTaskOrder
      existing.checkPassed = checkPassed
      existing.message = message
      existing.executedAtMs = executedAtMs
      await manager.save(existing)
      return
    }
    await this.saveReorganization(manager, projectId, sessionId, pending.eventId, "TRANSFER_TASK", pending.sourceAircraftId, pending.destinationAircraftId, pending.sourceGroupId, pending.destinationGroupId, taskObjectIds, previousTaskOrder, nextTaskOrder, checkPassed, message, executedAtMs)
  }

  private async settlePendingTaskTransfers(
    manager: EntityManager,
    project: StudentProjectEntity,
    session: RuntimeSessionEntity,
    plan: VtlProjectPlanEntity,
    checkpoint: VtlRuntimeCheckpoint,
    simulationTimeMs: number
  ): Promise<boolean> {
    if (checkpoint.pendingTaskTransfers.length === 0) return false
    const projection = projectProjection(plan, checkpoint, simulationTimeMs, [])
    const remaining: VtlPendingTaskTransfer[] = []
    let changed = false
    for (const pending of checkpoint.pendingTaskTransfers) {
      const sourceAircraft = projection.aircraft.find((item) => item.aircraftId === pending.sourceAircraftId)
      const destinationAircraft = projection.aircraft.find((item) => item.aircraftId === pending.destinationAircraftId)
      const transferDecision = vtlTaskTransferDecision(sourceAircraft?.status ?? null, destinationAircraft?.status ?? null)
      if (transferDecision === "WAITING_FOR_SOURCE_EXIT") {
        remaining.push(pending)
        continue
      }
      const destination = plan.allocation.assignments.find((item) => item.aircraftId === pending.destinationAircraftId)
      const source = plan.allocation.assignments.find((item) => item.aircraftId === pending.sourceAircraftId)
      const task = plan.taskObjects.find((item) => item.id === pending.taskObjectId)
      if (!destination || !destinationAircraft || !source || !task) {
        checkpoint.taskStatusOverrides[pending.taskObjectId] = "INCOMPLETE"
        await this.settleReorganization(manager, project.id, session.id, pending, [pending.taskObjectId], [], [], false, "源航空器已安全退出，但接替任务所需对象不存在", simulationTimeMs)
        changed = true
        continue
      }
      const destinationView = effectiveAssignment(plan, checkpoint, destination)
      const sourceView = effectiveAssignment(plan, checkpoint, source)
      const previousTaskOrder = [...sourceView.taskSequence]
      if (transferDecision === "DESTINATION_UNAVAILABLE") {
        checkpoint.taskStatusOverrides[pending.taskObjectId] = "INCOMPLETE"
        await this.settleReorganization(manager, project.id, session.id, pending, [pending.taskObjectId], previousTaskOrder, [], false, "源航空器已安全退出，但接替航空器已无法接收任务", simulationTimeMs)
        changed = true
        continue
      }
      const sourceTaskObjectIds = sourceView.taskObjectIds.filter((id) => id !== pending.taskObjectId)
      const sourceTaskSequence = sourceView.taskSequence.filter((id) => id !== pending.taskObjectId)
      const destinationCompletedTaskIds = new Set(destinationAircraft.completedTaskObjectIds)
      const destinationTaskSequence = uniqueStrings([
        ...destinationView.taskSequence,
        ...destinationView.taskObjectIds
      ].filter((id) => !destinationCompletedTaskIds.has(id)))
      const nextDestinationTaskSequence = uniqueStrings([...destinationTaskSequence, pending.taskObjectId])
      const dynamicRoute = buildTransferredVtlRoute(plan, destination, destinationAircraft, nextDestinationTaskSequence)
      setAssignmentOverride(checkpoint, pending.sourceAircraftId, { taskObjectIds: sourceTaskObjectIds, taskSequence: sourceTaskSequence })
      setAssignmentOverride(checkpoint, pending.destinationAircraftId, {
        taskObjectIds: uniqueStrings([...destinationView.taskObjectIds, pending.taskObjectId]),
        taskSequence: nextDestinationTaskSequence,
        routeOverride: dynamicRoute,
        routeOverrideStartSimulationTimeMs: simulationTimeMs
      })
      checkpoint.taskStatusOverrides[pending.taskObjectId] = "ASSIGNED"
      await this.settleReorganization(manager, project.id, session.id, pending, [pending.taskObjectId], previousTaskOrder, nextDestinationTaskSequence, true, "源航空器已安全退出，接替航空器已接管未完成巡检任务", simulationTimeMs)
      changed = true
    }
    checkpoint.pendingTaskTransfers = remaining
    return changed
  }

  private async saveSnapshot(manager: EntityManager, session: RuntimeSessionEntity, plan: VtlProjectPlanEntity, checkpoint: VtlRuntimeCheckpoint, reason: VtlRuntimeSnapshotEntity["reason"]): Promise<void> {
    const events = await manager.find(RuntimeEventEntity, { where: { projectId: session.projectId, sessionId: session.id } })
    const projection = projectProjection(plan, checkpoint, Number(session.simulationTimeMs), events)
    const rows = await manager.query<{ maxSequence: string | number | null }[]>(
      'SELECT COALESCE(MAX("sequence"), 0) AS "maxSequence" FROM "vtl_runtime_snapshots" WHERE "sessionId" = $1',
      [session.id]
    )
    const nextSequence = nextVtlSnapshotSequence(checkpoint.lastSnapshotSequence, rows[0]?.maxSequence)
    await manager.save(manager.create(VtlRuntimeSnapshotEntity, {
      projectId: session.projectId,
      sessionId: session.id,
      sequence: nextSequence,
      simulationTimeMs: Number(session.simulationTimeMs),
      reason,
      summary: projection.summary,
      aircraft: projection.aircraft,
      groups: projection.groups,
      taskObjects: projection.taskObjects
    }))
    checkpoint.lastSnapshotSequence = nextSequence
    checkpoint.lastSnapshotSimulationTimeMs = Number(session.simulationTimeMs)
    session.checkpoint = checkpoint as unknown as Record<string, unknown>
    await manager.save(session)
  }

  private async openEmergencyStage(manager: EntityManager, project: StudentProjectEntity): Promise<void> {
    const runtime = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: project.id }, stageCode: "VTL_RUNTIME" } })
    const emergency = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: project.id }, stageCode: "VTL_EMERGENCY_HANDLING" } })
    if (!runtime || runtime.status !== "IN_PROGRESS") return
    if (!openVtlStageCodes(project).includes("VTL_EMERGENCY_HANDLING")) {
      await completeVtlStage(manager, project, "VTL_RUNTIME")
      return
    }
    if (!emergency) throw new NotFoundException("垂起巡检事件处置阶段不存在")
    await completeVtlStage(manager, project, "VTL_RUNTIME")
  }

  private async ensureSession(manager: EntityManager, project: StudentProjectEntity, actor: AuthUser): Promise<RuntimeSessionEntity> {
    const existing = await manager.findOne(RuntimeSessionEntity, { where: { projectId: project.id }, order: { attemptNo: "DESC" } })
    if (existing) return existing
    const plan = await this.requirePlan(manager, project.id)
    if (!plan.executionPlan) throw new ConflictException("执行计划尚未提交")
    const routeEndTimesMs = plan.routes.map((route) => {
      const takeoffIndex = plan.executionPlan!.takeoffOrder.indexOf(route.aircraftId)
      const takeoffOffset = takeoffIndex < 0 ? 0 : takeoffIndex * VTL_TAKEOFF_INTERVAL_MS
      return takeoffOffset + Math.ceil(route.totalDurationSeconds * 1_000)
    })
    const durationMs = Math.max(60_000, Math.max(...routeEndTimesMs, 60_000) + 30_000)
    const checkpoint: VtlRuntimeCheckpoint = {
      schemaVersion: 1,
      clockRate: 1,
      clockAnchorRealTime: new Date().toISOString(),
      clockAnchorSimulationTimeMs: 0,
      durationMs,
      autoPausedForEvent: false,
      lastSnapshotSequence: 0,
      lastSnapshotSimulationTimeMs: 0,
      aircraftOverrides: {},
      taskStatusOverrides: {},
      pendingTaskTransfers: []
    }
    const resourceVersions = freezeRuntimeResourceVersions(project.snapshot.resourceRefs, `execution-plan:${plan.id}@${plan.executionPlan.version}`)
    const session = await manager.save(manager.create(RuntimeSessionEntity, {
      projectId: project.id,
      status: "READY",
      mode: project.snapshot.mode,
      scenarioSeed: `${project.snapshot.checksum}:vtl`,
      ...resourceVersions,
      attemptNo: 1,
      sourceSessionId: null,
      restartNodeCode: null,
      restartSimulationTimeMs: null,
      simulationTimeMs: 0,
      revision: 1,
      checkpoint: checkpoint as unknown as Record<string, unknown>,
      startedAt: null,
      endedAt: null
    }))
    await this.activityLog.record(manager, {
      assignmentId: project.snapshot.draft.id,
      projectId: project.id,
      stageCode: "VTL_RUNTIME",
      actor,
      eventType: "RUNTIME_SESSION_CREATED",
      objectType: "RUNTIME_SESSION",
      objectId: session.id,
      afterRevision: session.revision,
      result: {
        attemptNo: session.attemptNo,
        durationMs,
        totalAircraft: plan.allocation.assignments.length,
        mapResourceVersion: session.mapResourceVersion,
        sceneResourceVersion: session.sceneResourceVersion,
        planVersion: session.planVersion
      }
    })
    return session
  }

  private async requirePlan(manager: EntityManager, projectId: string): Promise<VtlProjectPlanEntity> {
    const plan = await manager.findOne(VtlProjectPlanEntity, { where: { project: { id: projectId } } })
    if (!plan) throw new ConflictException("垂起巡检方案尚未初始化")
    return plan
  }

  private async lockCurrentSession(manager: EntityManager, projectId: string): Promise<RuntimeSessionEntity> {
    const session = await manager.findOne(RuntimeSessionEntity, { where: { projectId }, order: { attemptNo: "DESC" }, lock: { mode: "pessimistic_write" } })
    if (!session) throw new NotFoundException("巡检运行批次不存在")
    return session
  }

  private async lockCounter(manager: EntityManager, projectId: string): Promise<ProjectActivityCounterEntity> {
    const counter = await manager.findOne(ProjectActivityCounterEntity, { where: { project: { id: projectId } }, lock: { mode: "pessimistic_write" } })
    if (!counter) throw new NotFoundException("项目活动计数器不存在")
    return counter
  }

  private async lockStage(manager: EntityManager, projectId: string, code: "VTL_RUNTIME" | "VTL_EMERGENCY_HANDLING"): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: code }, lock: { mode: "pessimistic_write" } })
    if (!stage) throw new NotFoundException("垂起巡检阶段不存在")
    return stage
  }

  private async findEvent(manager: EntityManager, projectId: string, sessionId: string, value: unknown): Promise<RuntimeEventEntity | null> {
    const id = optionalText(value)
    if (!id) return null
    const event = await manager.findOne(RuntimeEventEntity, { where: { id, projectId, sessionId }, lock: { mode: "pessimistic_write" } })
    if (!event) throw new NotFoundException("巡检事件不存在")
    return event
  }

  private async findManualTriggerByRequestId(manager: EntityManager, projectId: string, sessionId: string, requestId: string): Promise<RuntimeEventEntity | null> {
    return manager.createQueryBuilder(RuntimeEventEntity, "event")
      .where("event.projectId = :projectId", { projectId })
      .andWhere("event.sessionId = :sessionId", { sessionId })
      .andWhere("event.payload ->> '_manualTriggerRequestId' = :requestId", { requestId })
      .setLock("pessimistic_write")
      .getOne()
  }

  private async findActionByRequestId(manager: EntityManager, sessionId: string, actorId: string, requestId: string): Promise<StudentRuntimeActionEntity | null> {
    return manager.createQueryBuilder(StudentRuntimeActionEntity, "action")
      .where("action.sessionId = :sessionId", { sessionId })
      .andWhere("action.actorId = :actorId", { actorId })
      .andWhere("action.payload ->> '_requestId' = :requestId", { requestId })
      .setLock("pessimistic_write")
      .getOne()
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.dataSource.manager): Promise<{ project: StudentProjectEntity; actor: "STUDENT" | "TEACHER" }> {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (project.snapshot.sceneType !== "VTOL_INSPECTION") throw new BadRequestException("当前项目不是垂起广域巡检场景")
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return { project, actor: "STUDENT" }
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" }
    throw new ForbiddenException("无权访问该学生项目")
  }
}

function projectProjection(plan: VtlProjectPlanEntity, checkpoint: VtlRuntimeCheckpoint, simulationTimeMs: number, events: RuntimeEventEntity[]) {
  const assignments = plan.allocation.assignments.map((assignment) => effectiveAssignment(plan, checkpoint, assignment))
  const eventInputs = events.filter((event) => event.status === "ACTIVE").map((event) => ({ id: event.id, aircraftIds: arrayOfStrings(event.payload.affectedAircraftIds) }))
  const aircraft = assignments.map((assignment) => {
    const override = checkpoint.aircraftOverrides[assignment.aircraftId]
    const route = override?.routeOverride ?? plan.routes.find((candidate) => candidate.aircraftId === assignment.aircraftId)
    const takeoffIndex = plan.executionPlan?.takeoffOrder.indexOf(assignment.aircraftId) ?? -1
    const takeoffOffset = takeoffIndex < 0 ? 0 : takeoffIndex * VTL_TAKEOFF_INTERVAL_MS
    const routeStart = override?.routeOverride ? finiteNumber(override.routeOverrideStartSimulationTimeMs, simulationTimeMs) : 0
    const routeClockStart = override?.routeOverride ? routeStart : takeoffOffset
    const holdElapsed = override?.status === "HOLDING"
      && override.actionSimulationTimeMs !== undefined
      && simulationTimeMs >= override.actionSimulationTimeMs + VTL_HOLD_DURATION_MS
    const routeSimulationTimeMs = Math.max(0, simulationTimeMs - routeClockStart - (holdElapsed ? VTL_HOLD_DURATION_MS : 0))
    const base = route
      ? projectVtlRuntime({ simulationTimeMs: routeSimulationTimeMs, routes: [route], assignments: [assignment], groups: [], taskObjects: plan.taskObjects, events: eventInputs }).aircraft[0]
      : undefined
    const item = base ?? fallbackAircraft(assignment)
    const ownedTaskIds = new Set(assignment?.taskObjectIds ?? [])
    const projectedOverride = applyAircraftOverride(item, override, simulationTimeMs, plan, holdElapsed)
    const actionFrozen = ["RETURNING", "DIVERTING", "CANCELLED"].includes(override?.status ?? "") || (override?.status === "HOLDING" && !holdElapsed)
    const frozen = actionFrozen || (projectedOverride.status !== "ACTIVE" && projectedOverride.status !== "WAITING" && projectedOverride.status !== "LANDED")
    const projectedCompleted = actionFrozen ? [] : item.completedTaskObjectIds.filter((taskId) => ownedTaskIds.has(taskId))
    const landedCompleted = !actionFrozen && projectedOverride.status === "LANDED" ? [...ownedTaskIds] : []
    const completed = [...new Set([...projectedCompleted, ...landedCompleted, ...(override?.completedTaskObjectIds ?? [])])]
    return {
      ...projectedOverride,
      ...(override?.groupId ? { groupId: override.groupId } : {}),
      completedTaskObjectIds: completed,
      ...(frozen ? { currentTaskObjectId: null } : {}),
      eventIds: item.eventIds
    }
  })
  const groups = plan.allocation.groups.map((group): VtlRuntimeGroupView => {
    const groupAircraft = aircraft.filter((item) => item.groupId === group.id)
    const completed = new Set(groupAircraft.flatMap((item) => item.completedTaskObjectIds))
    const groupTaskIds = new Set(assignments.filter((assignment) => assignment.groupId === group.id).flatMap((assignment) => assignment.taskObjectIds))
    return {
      groupId: group.id,
      aircraftCount: groupAircraft.length,
      activeAircraftCount: groupAircraft.filter((item) => ["ACTIVE", "HOLDING", "RETURNING", "DIVERTING"].includes(item.status)).length,
      completedTaskCount: completed.size,
      totalTaskCount: groupTaskIds.size,
      progressRatio: groupTaskIds.size ? completed.size / groupTaskIds.size : 0,
      attentionCount: groupAircraft.filter((item) => item.eventIds.length > 0 || ["RETURNING", "DIVERTING", "CANCELLED"].includes(item.status)).length,
      phaseDistribution: groupAircraft.reduce<Partial<Record<VtlFlightPhase, number>>>((result, item) => { result[item.phase] = (result[item.phase] ?? 0) + 1; return result }, {})
    }
  })
  const completedTaskIds = new Set(aircraft.flatMap((item) => item.completedTaskObjectIds))
  const runtimeEnded = simulationTimeMs >= checkpoint.durationMs
  const taskObjects = plan.taskObjects.map((task) => {
    const status = completedTaskIds.has(task.id)
      ? "COMPLETED"
      : checkpoint.taskStatusOverrides[task.id] ?? (runtimeEnded ? "INCOMPLETE" : task.status === "ASSIGNED" ? "ASSIGNED" : task.status)
    return { ...task, status, incompleteReason: status === "INCOMPLETE" ? task.incompleteReason ?? "运行结束前未完成该巡检对象" : null }
  })
  const phaseDistribution = aircraft.reduce<Partial<Record<VtlFlightPhase, number>>>((result, item) => { result[item.phase] = (result[item.phase] ?? 0) + 1; return result }, {})
  const summary = {
    totalAircraft: aircraft.length,
    airborneAircraft: aircraft.filter((item) => ["ACTIVE", "HOLDING", "RETURNING", "DIVERTING"].includes(item.status)).length,
    landedAircraft: aircraft.filter((item) => item.status === "LANDED").length,
    attentionAircraft: aircraft.filter((item) => item.eventIds.length > 0 || ["RETURNING", "DIVERTING", "CANCELLED"].includes(item.status)).length,
    totalTaskObjects: taskObjects.length,
    completedTaskObjects: completedTaskIds.size,
    incompleteTaskObjects: Math.max(0, taskObjects.length - completedTaskIds.size),
    taskCompletionRatio: taskObjects.length ? completedTaskIds.size / taskObjects.length : 0,
    phaseDistribution
  }
  return { aircraft, groups, taskObjects, summary }
}

function fallbackAircraft(assignment: VtlAircraftAssignmentView): VtlRuntimeAircraftView {
  return {
    aircraftId: assignment.aircraftId,
    aircraftCode: assignment.aircraftCode,
    groupId: assignment.groupId,
    phase: "VERTICAL_TAKEOFF",
    position: { longitude: 0, latitude: 0, altitudeMeters: 0 },
    currentTaskObjectId: null,
    completedTaskObjectIds: [],
    remainingEnergyWh: 0,
    remainingEnergyRatio: 0,
    eventIds: [],
    status: "WAITING"
  }
}

function buildTransferredVtlRoute(plan: VtlProjectPlanEntity, destination: VtlAircraftAssignmentView, destinationAircraft: VtlRuntimeAircraftView, taskIds: string[]): VtlRoutePlanView {
  const baseRoute = plan.routes.find((route) => route.aircraftId === destination.aircraftId)
  const main = plan.landingSites.find((site) => site.id === configuredMainLandingSiteId(plan.project) && site.type === "MAIN" && site.status === "AVAILABLE")
  const alternate = plan.landingSites.find((site) => site.id === baseRoute?.alternateLandingSiteId && site.status === "AVAILABLE")
    ?? plan.landingSites.find((site) => site.type === "ALTERNATE" && site.status === "AVAILABLE")
  if (!main || !alternate) throw new ConflictException("任务转移后缺少可用主起降点或备降点")
  const parameters = plan.aircraftParameters
  const start = { ...destinationAircraft.position, altitudeMeters: destinationAircraft.position.altitudeMeters ?? 0 }
  const transitionHeight = Math.max(baseRoute?.transitionHeightMeters ?? parameters.minimumTransitionHeightMeters, parameters.minimumTransitionHeightMeters)
  const taskAltitude = Math.max(90, start.altitudeMeters, ...taskIds.map((taskId) => plan.taskObjects.find((task) => task.id === taskId)?.positions[0]?.altitudeMeters ?? 0))
  const phase = destinationAircraft.phase === "VERTICAL_LANDING" ? "CLIMB" : destinationAircraft.phase
  const mainCruise = { ...main.position, altitudeMeters: taskAltitude }
  const mainTransition = { ...main.position, altitudeMeters: transitionHeight }
  const mainLanding = { ...main.position, altitudeMeters: 10 }
  const waypoints: VtlRoutePlanView["waypoints"] = [
    { id: `${destination.aircraftId}-dynamic-start`, sequence: 0, phase, position: start, altitudeMeters: start.altitudeMeters, speedMps: Math.max(1, parameters.cruiseSpeedMps), taskObjectId: null },
    ...taskIds.map((taskId, index) => {
      const task = plan.taskObjects.find((item) => item.id === taskId)
      const position = task?.positions[0]
      if (!position) throw new ConflictException(`任务对象 ${taskId} 缺少可用位置，不能动态转移`)
      const taskPosition = { ...position, altitudeMeters: Math.max(taskAltitude, position.altitudeMeters ?? 0) }
      return { id: `${destination.aircraftId}-dynamic-task-${index + 1}`, sequence: index + 1, phase: "TASK_EXECUTION" as const, position: taskPosition, altitudeMeters: taskPosition.altitudeMeters, speedMps: Math.max(1, parameters.cruiseSpeedMps), taskObjectId: taskId }
    }),
    { id: `${destination.aircraftId}-dynamic-return`, sequence: taskIds.length + 1, phase: "RETURN", position: mainCruise, altitudeMeters: mainCruise.altitudeMeters, speedMps: Math.max(1, parameters.cruiseSpeedMps), taskObjectId: null },
    { id: `${destination.aircraftId}-dynamic-back-transition`, sequence: taskIds.length + 2, phase: "BACK_TRANSITION", position: mainTransition, altitudeMeters: mainTransition.altitudeMeters, speedMps: Math.max(1, parameters.transitionSpeedMps), taskObjectId: null },
    { id: `${destination.aircraftId}-dynamic-land`, sequence: taskIds.length + 3, phase: "VERTICAL_LANDING", position: mainLanding, altitudeMeters: mainLanding.altitudeMeters, speedMps: Math.max(1, parameters.climbSpeedMps), taskObjectId: null }
  ]
  const computed = buildVtlRoutePlan({
    routeId: `${baseRoute?.id ?? destination.aircraftId}-dynamic-${Date.now()}`,
    projectId: plan.project.id,
    aircraftId: destination.aircraftId,
    parameterVersion: parameters.version,
    transitionHeightMeters: transitionHeight,
    alternateLandingSiteId: alternate.id,
    waypoints,
    parameters
  })
  return computed.route
}

function findLandingSite(plan: VtlProjectPlanEntity, aircraftId: string, alternate: boolean): VtlProjectPlanEntity["landingSites"][number] {
  const route = plan.routes.find((item) => item.aircraftId === aircraftId)
  const site = alternate
    ? plan.landingSites.find((item) => item.id === route?.alternateLandingSiteId && item.type === "ALTERNATE" && item.status === "AVAILABLE")
    : plan.landingSites.find((item) => item.id === configuredMainLandingSiteId(plan.project) && item.type === "MAIN" && item.status === "AVAILABLE")
  if (!site) throw new ConflictException(alternate ? "当前航空器没有可用备降点" : "当前任务没有可用主起降点")
  return site
}

function diversionDurationMs(origin: V3Coordinate, destination: V3Coordinate, cruiseSpeedMps: number): number {
  const travelMs = coordinateDistanceMeters(origin, destination) / Math.max(1, cruiseSpeedMps) * 1_000
  return Math.min(VTL_DIVERSION_MAX_DURATION_MS, Math.max(VTL_DIVERSION_MIN_DURATION_MS, Math.round(travelMs + 5_000)))
}

function coordinateDistanceMeters(left: V3Coordinate, right: V3Coordinate): number {
  const latitude = (left.latitude + right.latitude) / 2 * Math.PI / 180
  const longitudeDelta = (right.longitude - left.longitude) * Math.PI / 180
  const latitudeDelta = (right.latitude - left.latitude) * Math.PI / 180
  const horizontal = Math.sqrt((latitudeDelta * 6_378_137) ** 2 + (longitudeDelta * 6_378_137 * Math.cos(latitude)) ** 2)
  const vertical = (right.altitudeMeters ?? 0) - (left.altitudeMeters ?? 0)
  return Math.sqrt(horizontal ** 2 + vertical ** 2)
}

function interpolateCoordinate(origin: V3Coordinate, destination: V3Coordinate, ratio: number): V3Coordinate {
  return {
    longitude: origin.longitude + (destination.longitude - origin.longitude) * ratio,
    latitude: origin.latitude + (destination.latitude - origin.latitude) * ratio,
    altitudeMeters: (origin.altitudeMeters ?? 0) + ((destination.altitudeMeters ?? 0) - (origin.altitudeMeters ?? 0)) * ratio
  }
}

function applyAircraftOverride(base: VtlRuntimeAircraftView, override: VtlAircraftOverride | undefined, simulationTimeMs: number, plan: VtlProjectPlanEntity, holdElapsed: boolean): VtlRuntimeAircraftView {
  if (!override?.status) return base
  const capturedCompleted = override.completedTaskObjectIds ?? base.completedTaskObjectIds
  if (override.status === "HOLDING") {
    if (holdElapsed) return base
    return {
      ...base,
      status: "HOLDING",
      position: override.position ?? base.position,
      currentTaskObjectId: null,
      completedTaskObjectIds: capturedCompleted,
      remainingEnergyWh: override.remainingEnergyWh ?? base.remainingEnergyWh,
      remainingEnergyRatio: (override.remainingEnergyWh ?? base.remainingEnergyWh) / Math.max(1, plan.aircraftParameters.batteryCapacityWh)
    }
  }
  if (override.status === "RETURNING" || override.status === "DIVERTING") {
    const actionTime = finiteNumber(override.actionSimulationTimeMs, 0)
    const duration = Math.max(VTL_DIVERSION_MIN_DURATION_MS, finiteNumber(override.transitionDurationMs, VTL_DIVERSION_MIN_DURATION_MS))
    const progress = Math.min(1, Math.max(0, (simulationTimeMs - actionTime) / duration))
    const landingSite = plan.landingSites.find((site) => site.id === override.landingSiteId)
    const origin = override.actionOriginPosition ?? override.position ?? base.position
    const destination = landingSite?.position ?? origin
    const originEnergy = override.remainingEnergyWh ?? base.remainingEnergyWh
    const finalEnergy = Math.max(plan.aircraftParameters.batteryCapacityWh * plan.aircraftParameters.reserveEnergyRatio, originEnergy - plan.aircraftParameters.batteryCapacityWh * 0.08)
    if (progress >= 1) {
      return {
        ...base,
        phase: "VERTICAL_LANDING",
        position: { ...destination },
        currentTaskObjectId: null,
        completedTaskObjectIds: capturedCompleted,
        remainingEnergyWh: finalEnergy,
        remainingEnergyRatio: finalEnergy / Math.max(1, plan.aircraftParameters.batteryCapacityWh),
        status: "LANDED"
      }
    }
    const phase: VtlFlightPhase = progress < 0.55 ? "RETURN" : progress < 0.85 ? "BACK_TRANSITION" : "VERTICAL_LANDING"
    const energy = Math.max(plan.aircraftParameters.batteryCapacityWh * plan.aircraftParameters.reserveEnergyRatio, originEnergy - plan.aircraftParameters.batteryCapacityWh * 0.08 * progress)
    return {
      ...base,
      phase,
      position: interpolateCoordinate(origin, destination, progress),
      currentTaskObjectId: null,
      completedTaskObjectIds: capturedCompleted,
      remainingEnergyWh: energy,
      remainingEnergyRatio: energy / Math.max(1, plan.aircraftParameters.batteryCapacityWh),
      status: override.status
    }
  }
  if (override.status === "CANCELLED") {
    return {
      ...base,
      status: "CANCELLED",
      position: override.position ?? base.position,
      currentTaskObjectId: null,
      completedTaskObjectIds: capturedCompleted,
      remainingEnergyWh: override.remainingEnergyWh ?? base.remainingEnergyWh,
      remainingEnergyRatio: (override.remainingEnergyWh ?? base.remainingEnergyWh) / Math.max(1, plan.aircraftParameters.batteryCapacityWh)
    }
  }
  return { ...base, status: override.status, position: override.position ?? base.position, remainingEnergyWh: override.remainingEnergyWh ?? base.remainingEnergyWh }
}

function effectiveAssignment(plan: VtlProjectPlanEntity, checkpoint: VtlRuntimeCheckpoint, assignment: VtlAircraftAssignmentView): VtlAircraftAssignmentView {
  const override = checkpoint.aircraftOverrides[assignment.aircraftId]
  return {
    ...assignment,
    groupId: override?.groupId ?? assignment.groupId,
    taskObjectIds: override?.taskObjectIds ?? assignment.taskObjectIds,
    taskSequence: override?.taskSequence ?? assignment.taskSequence
  }
}

function setAssignmentOverride(checkpoint: VtlRuntimeCheckpoint, aircraftId: string, patch: VtlAircraftOverride): void {
  checkpoint.aircraftOverrides[aircraftId] = { ...checkpoint.aircraftOverrides[aircraftId], ...patch }
}

export function canStudentControlVtlRuntime(actor: "STUDENT" | "TEACHER", status: RuntimeSessionEntity["status"]): boolean {
  return actor === "STUDENT" && ["RUNNING", "PAUSED"].includes(status)
}

function availableActionsFor(actor: "STUDENT" | "TEACHER", session: RuntimeSessionEntity, events: VtlRuntimeEventView[], aircraft: VtlRuntimeAircraftView[], plan: VtlProjectPlanEntity, checkpoint: VtlRuntimeCheckpoint) {
  const runtimeEnabled = canStudentControlVtlRuntime(actor, session.status)
  const all = [
    ["ACKNOWLEDGE", "确认告警", "EVENT", true],
    ["HOLD", "保持等待", "AIRCRAFT", true],
    ["RETURN_AIRCRAFT", "返航", "AIRCRAFT", true],
    ["DIVERT_AIRCRAFT", "备降", "AIRCRAFT", true],
    ["TRANSFER_TASK", "转移任务", "AIRCRAFT", true],
    ["ADJUST_GROUP", "调整分组", "GROUP", true],
    ["CANCEL_NOT_STARTED", "取消未起飞任务", "AIRCRAFT", true]
  ] as const
  return all.map(([code, title, targetType, requiresTarget]) => {
    const actionCode = code as VtlRuntimeActionCode
    const eligibleTargetIds = targetType === "EVENT"
      ? events.filter((event) => ["ACTIVE", "ESCALATED"].includes(event.status)).map((event) => event.id)
      : eligibleAircraftIdsForAction(actionCode, aircraft, plan, checkpoint)
    const enabled = runtimeEnabled && (!requiresTarget || eligibleTargetIds.length > 0)
    return {
      code: actionCode,
      title,
      targetType,
      requiresTarget,
      enabled,
      disabledReason: enabled ? null : actionDisabledReason(actionCode, actor, session.status),
      eligibleTargetIds
    }
  })
}

function eligibleAircraftIdsForAction(action: VtlRuntimeActionCode, aircraft: VtlRuntimeAircraftView[], plan: VtlProjectPlanEntity, checkpoint: VtlRuntimeCheckpoint): string[] {
  const statusEligible = aircraft.filter((item) => eligibleAircraftForAction(action, item.status))
  if (action === "DIVERT_AIRCRAFT") {
    return statusEligible.filter((item) => {
      const route = plan.routes.find((candidate) => candidate.aircraftId === item.aircraftId)
      return plan.landingSites.some((site) => site.id === route?.alternateLandingSiteId && site.type === "ALTERNATE" && site.status === "AVAILABLE")
    }).map((item) => item.aircraftId)
  }
  if (action === "RETURN_AIRCRAFT") {
    const mainAvailable = plan.landingSites.some((site) => site.id === configuredMainLandingSiteId(plan.project) && site.type === "MAIN" && site.status === "AVAILABLE")
    return mainAvailable ? statusEligible.map((item) => item.aircraftId) : []
  }
  if (action === "TRANSFER_TASK") {
    const destinations = aircraft.filter((item) => ["WAITING", "ACTIVE"].includes(item.status))
    const completedTaskIds = new Set(aircraft.flatMap((item) => item.completedTaskObjectIds))
    return statusEligible.filter((item) => {
      const assignment = plan.allocation.assignments.find((candidate) => candidate.aircraftId === item.aircraftId)
      if (!assignment || !destinations.some((candidate) => candidate.aircraftId !== item.aircraftId)) return false
      return effectiveAssignment(plan, checkpoint, assignment).taskObjectIds.some((taskId) => !completedTaskIds.has(taskId) && checkpoint.taskStatusOverrides[taskId] !== "COMPLETED")
    }).map((item) => item.aircraftId)
  }
  if (action === "ADJUST_GROUP") {
    if (plan.allocation.groups.length < 2) return []
    return statusEligible.filter((item) => plan.allocation.groups.some((group) => group.id !== item.groupId)).map((item) => item.aircraftId)
  }
  return statusEligible.map((item) => item.aircraftId)
}

function actionDisabledReason(action: VtlRuntimeActionCode, actor: "STUDENT" | "TEACHER", status: RuntimeSessionEntity["status"]): string {
  if (actor === "TEACHER") return "教师只读查看"
  if (!["RUNNING", "PAUSED"].includes(status)) return "当前运行状态不允许处置"
  const reason = {
    ACKNOWLEDGE: "当前没有待确认的巡检事件",
    HOLD: "当前没有可进入等待的航空器",
    RETURN_AIRCRAFT: "当前没有具备返航条件的航空器",
    DIVERT_AIRCRAFT: "当前没有具备备降条件的航空器",
    TRANSFER_TASK: "当前没有可转移的未完成任务",
    ADJUST_GROUP: "当前没有可调整分组的航空器",
    CANCEL_NOT_STARTED: "当前没有尚未起飞的航空器"
  } satisfies Record<VtlRuntimeActionCode, string>
  return reason[action]
}

function eligibleAircraftForAction(action: VtlRuntimeActionCode, status: VtlRuntimeAircraftView["status"]): boolean {
  if (action === "CANCEL_NOT_STARTED") return status === "WAITING"
  if (action === "HOLD") return status === "WAITING" || status === "ACTIVE"
  if (action === "RETURN_AIRCRAFT" || action === "DIVERT_AIRCRAFT") return status === "WAITING" || status === "ACTIVE" || status === "HOLDING"
  if (action === "TRANSFER_TASK" || action === "ADJUST_GROUP") return status === "WAITING" || status === "ACTIVE" || status === "HOLDING"
  return status !== "LANDED" && status !== "CANCELLED"
}

function parseCheckpoint(value: Record<string, unknown>): VtlRuntimeCheckpoint {
  const record = value && typeof value === "object" ? value : {}
  return {
    schemaVersion: 1,
    clockRate: finiteNumber(record.clockRate, 1),
    clockAnchorRealTime: typeof record.clockAnchorRealTime === "string" ? record.clockAnchorRealTime : new Date().toISOString(),
    clockAnchorSimulationTimeMs: Math.max(0, finiteNumber(record.clockAnchorSimulationTimeMs, 0)),
    durationMs: Math.max(60_000, finiteNumber(record.durationMs, 180_000)),
    autoPausedForEvent: record.autoPausedForEvent === true,
    lastSnapshotSequence: Math.max(0, Math.floor(finiteNumber(record.lastSnapshotSequence, 0))),
    lastSnapshotSimulationTimeMs: Math.max(0, finiteNumber(record.lastSnapshotSimulationTimeMs, 0)),
    aircraftOverrides: isRecord(record.aircraftOverrides) ? record.aircraftOverrides as Record<string, VtlAircraftOverride> : {},
    taskStatusOverrides: isRecord(record.taskStatusOverrides) ? record.taskStatusOverrides as Record<string, VtlTaskObjectView["status"]> : {},
    pendingTaskTransfers: Array.isArray(record.pendingTaskTransfers) ? record.pendingTaskTransfers.filter(isPendingTaskTransfer) : []
  }
}

function isPendingTaskTransfer(value: unknown): value is VtlPendingTaskTransfer {
  if (!isRecord(value)) return false
  return typeof value.sourceAircraftId === "string"
    && typeof value.destinationAircraftId === "string"
    && typeof value.taskObjectId === "string"
    && (value.eventId === null || typeof value.eventId === "string")
    && typeof value.sourceGroupId === "string"
    && typeof value.destinationGroupId === "string"
    && (value.reorganizationId === undefined || typeof value.reorganizationId === "string")
    && Number.isFinite(Number(value.requestedAtSimulationTimeMs))
}

export function nextVtlSnapshotSequence(checkpointSequence: number, databaseSequence: string | number | null | undefined): number {
  const checkpoint = Number.isFinite(checkpointSequence) ? Math.floor(checkpointSequence) : 0
  const database = typeof databaseSequence === "number" ? databaseSequence : Number(databaseSequence)
  const persisted = Number.isFinite(database) ? Math.floor(database) : 0
  return Math.max(0, checkpoint, persisted) + 1
}

function currentSimulationTime(session: RuntimeSessionEntity, checkpoint: VtlRuntimeCheckpoint): number {
  if (session.status !== "RUNNING") return Math.max(0, Number(session.simulationTimeMs))
  return fixedTickSimulationTime({ simulationTimeMs: checkpoint.clockAnchorSimulationTimeMs, realTimeMs: Date.parse(checkpoint.clockAnchorRealTime), rate: checkpoint.clockRate }, Date.now(), checkpoint.durationMs)
}

function serializeSession(session: RuntimeSessionEntity): V3RuntimeSessionView {
  return { id: session.id, projectId: session.projectId, status: session.status, mode: session.mode, scenarioSeed: session.scenarioSeed, mapResourceVersion: session.mapResourceVersion, sceneResourceVersion: session.sceneResourceVersion, planVersion: session.planVersion, attemptNo: session.attemptNo, sourceSessionId: session.sourceSessionId, restartNodeCode: session.restartNodeCode, restartSimulationTimeMs: session.restartSimulationTimeMs === null ? null : Number(session.restartSimulationTimeMs), simulationTimeMs: Number(session.simulationTimeMs), revision: session.revision, checkpoint: session.checkpoint, startedAt: session.startedAt?.toISOString() ?? null, endedAt: session.endedAt?.toISOString() ?? null }
}

function serializeEvent(event: RuntimeEventEntity): V3RuntimeEventView { return { id: event.id, projectId: event.projectId, sessionId: event.sessionId, stageCode: event.stageCode, code: event.code, category: event.category, status: event.status, severity: event.severity, scheduledSimulationTimeMs: event.scheduledSimulationTimeMs === null ? null : Number(event.scheduledSimulationTimeMs), triggeredSimulationTimeMs: event.triggeredSimulationTimeMs === null ? null : Number(event.triggeredSimulationTimeMs), resolvedSimulationTimeMs: event.resolvedSimulationTimeMs === null ? null : Number(event.resolvedSimulationTimeMs), triggeredAt: event.triggeredAt?.toISOString() ?? null, resolvedAt: event.resolvedAt?.toISOString() ?? null, payload: event.payload, correlationId: event.correlationId } }
function serializeVtlEvent(event: RuntimeEventEntity): VtlRuntimeEventView {
  const payload = event.payload
  return { id: event.id, code: event.code, category: event.category as VtlRuntimeEventView["category"], severity: event.severity, title: String(payload.title ?? event.code), detail: String(payload.detail ?? ""), status: (payload.lifecycleStatus ?? (event.status === "SCHEDULED" ? "PENDING" : event.status === "RESOLVED" ? "RESOLVED" : "ACTIVE")) as VtlRuntimeEventView["status"], affectedAircraftIds: arrayOfStrings(payload.affectedAircraftIds), availableActions: Array.isArray(payload.recommendedActions) ? payload.recommendedActions as VtlRuntimeActionCode[] : [], actionDeadlineSeconds: payload.actionDeadlineSeconds === null || payload.actionDeadlineSeconds === undefined ? null : Math.max(0, Number(payload.actionDeadlineSeconds)), actionDeadlineAtSimulationTimeMs: payload.actionDeadlineAtSimulationTimeMs === null || payload.actionDeadlineAtSimulationTimeMs === undefined ? null : Math.max(0, Number(payload.actionDeadlineAtSimulationTimeMs)), triggeredAtMs: event.triggeredSimulationTimeMs === null ? null : Number(event.triggeredSimulationTimeMs), resolvedAtMs: event.resolvedSimulationTimeMs === null ? null : Number(event.resolvedSimulationTimeMs) }
}
function serializeAlert(alert: RuntimeAlertEntity): V3RuntimeAlertView { return { id: alert.id, projectId: alert.projectId, sessionId: alert.sessionId, eventId: alert.eventId, stageCode: alert.stageCode, code: alert.code, title: alert.title, detail: alert.detail, severity: alert.severity, status: alert.status, simulationTimeMs: alert.simulationTimeMs === null ? null : Number(alert.simulationTimeMs), openedAt: alert.openedAt.toISOString(), acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null, resolvedAt: alert.resolvedAt?.toISOString() ?? null, payload: alert.payload, correlationId: alert.correlationId } }
function serializeAction(action: StudentRuntimeActionEntity): V3StudentRuntimeActionView { return { id: action.id, projectId: action.projectId, sessionId: action.sessionId, eventId: action.eventId, alertId: action.alertId, actorId: action.actorId, actionCode: action.actionCode, targetType: action.targetType, targetId: action.targetId, status: action.status, simulationTimeMs: Number(action.simulationTimeMs), payload: action.payload, result: action.result, correlationId: action.correlationId, requestedAt: action.requestedAt.toISOString(), appliedAt: action.appliedAt?.toISOString() ?? null } }
function serializeReorganization(item: VtlReorganizationEntity) { return { id: item.id, eventId: item.eventId ?? "", action: item.action, sourceAircraftId: item.sourceAircraftId, targetAircraftId: item.targetAircraftId, sourceGroupId: item.sourceGroupId, targetGroupId: item.targetGroupId, taskObjectIds: item.taskObjectIds, previousTaskOrder: item.previousTaskOrder, nextTaskOrder: item.nextTaskOrder, checkPassed: item.checkPassed, message: item.message, executedAtMs: Number(item.executedAtMs) } }

function resolveAffectedAircraft(plan: VtlProjectPlanEntity, config: Record<string, unknown> | null): string[] {
  const all = plan.allocation.assignments.filter((item) => item.available).map((item) => item.aircraftId)
  const explicit = arrayOfStrings(config?.targetIds)
  if (explicit.length) return explicit.filter((id) => all.includes(id))
  const scope = String(config?.impactScope ?? "SINGLE")
  if (scope === "WHOLE") return all
  if (scope === "MOST") return all.slice(0, Math.max(1, Math.ceil(all.length * 0.75)))
  if (scope === "GROUP" || scope === "LOCAL_AREA") {
    const group = plan.allocation.groups[0]
    return group ? group.aircraftIds.filter((id) => all.includes(id)) : all.slice(0, 1)
  }
  return all.slice(0, scope === "SMALL_BATCH" ? Math.min(3, all.length) : 1)
}

function normalizeAction(value: unknown): VtlRuntimeActionCode { const valid: VtlRuntimeActionCode[] = ["ACKNOWLEDGE", "HOLD", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "TRANSFER_TASK", "ADJUST_GROUP", "CANCEL_NOT_STARTED"]; if (typeof value !== "string" || !valid.includes(value as VtlRuntimeActionCode)) throw new BadRequestException("巡检处置动作无效"); return value as VtlRuntimeActionCode }
function actionLabel(action: VtlRuntimeActionCode): string { return ({ ACKNOWLEDGE: "已确认告警", HOLD: "已保持等待", RETURN_AIRCRAFT: "已执行返航", DIVERT_AIRCRAFT: "已执行备降", TRANSFER_TASK: "已转移巡检任务", ADJUST_GROUP: "已调整集群分组", CANCEL_NOT_STARTED: "已取消未起飞任务" } as Record<VtlRuntimeActionCode, string>)[action] }
function assertRevision(expected: number | undefined, actual: number): void { if (expected !== undefined && expected !== actual) throw new ConflictException(`运行版本冲突，当前版本为 ${actual}`) }
function numberOrUndefined(value: unknown): number | undefined { if (value === undefined || value === null || value === "") return undefined; const n = Number(value); if (!Number.isInteger(n) || n < 1) throw new BadRequestException("版本号无效"); return n }
function optionalText(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null }
function finiteNumber(value: unknown, fallback: number): number { const n = Number(value); return Number.isFinite(n) ? n : fallback }
function nullableFiniteNumber(value: unknown): number | null { if (value === null || value === undefined || value === "") return null; const number = Number(value); return Number.isFinite(number) ? number : null }
function arrayOfStrings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [] }
function uniqueStrings(values: string[]): string[] { return [...new Set(values)] }
function objectOrEmpty(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {} }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }

function normalizeRequestId(value: unknown): string | null {
  const requestId = optionalText(value)
  if (requestId && requestId.length > 120) throw new BadRequestException("请求号长度不能超过 120 个字符")
  return requestId
}

function assertSameActionRequest(existing: StudentRuntimeActionEntity, input: RuntimeActionInput, action: VtlRuntimeActionCode): void {
  const expectedEventId = optionalText(input.eventId)
  const expectedTargetId = action === "ACKNOWLEDGE" ? expectedEventId : optionalText(input.targetId)
  const payload = objectOrEmpty(existing.payload)
  const same = existing.actionCode === action
    && existing.eventId === expectedEventId
    && existing.targetId === expectedTargetId
    && optionalText(payload.targetAircraftId) === optionalText(input.targetAircraftId)
    && optionalText(payload.targetGroupId) === optionalText(input.targetGroupId)
    && optionalText(payload.taskObjectId) === optionalText(input.taskObjectId)
  if (!same) throw new ConflictException("同一请求号不能提交不同的巡检处置命令")
}
