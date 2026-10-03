import { createHash, randomUUID } from "node:crypto"
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import type {
  AuthUser,
  LogisticsDynamicScheduleMode,
  LogisticsDynamicScheduleVersionView,
  LogisticsRuntimeActionCode,
  LogisticsRuntimeEventLifecycleStatus,
  LogisticsRuntimeEventView,
  LogisticsRuntimeWorkspaceView,
  LogisticsScheduleItemInput,
  LogisticsScheduleItemView,
  LogisticsSchedulingOrderPriority,
  V3RuntimeAlertView,
  V3RuntimeActionReasoning,
  V3RuntimeRestartNodeView,
  V3ScenarioEventRecoveryMode,
  V3ScenarioEventConfig,
  V3RuntimeSessionView,
  V3StudentRuntimeActionView
} from "@wurenji/shared"
import { freezeRuntimeResourceVersions, logisticsTemplatePolicy } from "@wurenji/shared"
import { resolveLogisticsInitialEnvironment } from "@wurenji/shared"
import {
  checkLogisticsSchedule,
  computeLogisticsRuntimeProjection,
  logisticsRuntimeEligibleRouteIdsByTargetId,
  logisticsRuntimeEligibleTargetIds,
  logisticsRuntimeTaskStatusAt,
  type LogisticsRuntimeControlState,
  type LogisticsRuntimeEventImpact,
  type LogisticsRuntimeProjection
} from "@wurenji/simulation"
import { DataSource, EntityManager, Repository } from "typeorm"
import { UserEntity } from "../../entities.js"
import { ResourcePackageEntity } from "../resources/resource-package.entity.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import {
  canActivateScenarioEvent,
  recoverySatisfied,
  scenarioEventActiveCountAfterTransition,
  triggerSatisfied,
  manualTriggerWindowOpen,
  visibilityDelayMs,
  escalationDelayMs
} from "../runtime/scenario-event-rules.js"
import { scheduleRuntimeWindowTime } from "../runtime/runtime-event-scheduler.js"
import { ProjectActivityCounterEntity, StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { normalizeScheduleItems } from "../logistics-scheduling/logistics-scheduling.validation.js"
import { sha256Canonical } from "../common/canonical-json.js"
import {
  RuntimeAlertEntity,
  RuntimeEventEntity,
  RuntimeSessionEntity,
  StudentRuntimeActionEntity
} from "../runtime/runtime.entities.js"
import { configuredLogisticsEvents, logisticsEventDefinition, type ConfiguredLogisticsEvent } from "./logistics-event-catalog.js"
import { LogisticsRuntimeDataService, type LogisticsRuntimeScheduleRecords } from "./logistics-runtime.data.js"
import {
  LogisticsDynamicScheduleVersionEntity,
  LogisticsRuntimeReadinessEntity,
  LogisticsRuntimeSnapshotEntity
} from "./logistics-runtime.entities.js"
import {
  clockRate,
  dynamicMode,
  dynamicReason,
  optionalId,
  optionalUuid,
  positiveDelay,
  requiredUuid,
  runtimeActionCode,
  runtimeRevision
} from "./logistics-runtime.validation.js"
import { normalizeRuntimeActionReasoning } from "../runtime/runtime-action-reasoning.js"
import { mergeRuntimeAlertPayload } from "../runtime/runtime-alert-payload.js"
import { adaptRuntimeClock } from "../runtime/runtime-adapters.js"
import { assessmentTimingForProject } from "../assessment/assessment-window.service.js"
import { fixedTickSimulationTime } from "../runtime/runtime-clock.js"
import { persistRejectedRuntimeAction } from "../runtime/runtime-action-failure.js"
import { logisticsActionBusinessOutcome, logisticsActionWithinDeadline } from "./logistics-action-outcome.js"
import { assertLogisticsActionContextPending } from "./logistics-action-context.js"
import { assertSameLogisticsActionRequest, logisticsActionPayload, logisticsActionTargetType, type LogisticsActionRequestIdentity } from "./logistics-action-idempotency.js"
import { selectNearestAlternateLandingPoint } from "./logistics-diversion.js"

export interface LogisticsRuntimeCheckpoint {
  schemaVersion: 1
  scheduleVersionId: string
  scheduleVersionNo: number
  clockRate: number
  clockAnchorRealTime: string
  clockAnchorSimulationTimeMs: number
  durationMs: number
  totalAircraft?: number
  maximumConcurrentEvents?: number
  lastSnapshotSequence: number
  activeDynamicScheduleVersionId: string | null
  control: LogisticsRuntimeControlState
}

interface LogisticsEventPayload {
  title: string
  detail: string
  eventSubtype: V3ScenarioEventConfig["eventSubtype"]
  lifecycleStatus: LogisticsRuntimeEventLifecycleStatus
  affectedAircraftIds: string[]
  affectedOrderIds: string[]
  affectedRouteIds: string[]
  recommendedActions: LogisticsRuntimeActionCode[]
  detectionAtSimulationTimeMs: number
  detectedSimulationTimeMs: number | null
  escalationAtSimulationTimeMs: number | null
  autoRecoveryAtSimulationTimeMs: number | null
  recoveryMode: V3ScenarioEventRecoveryMode
  scenarioConfig: V3ScenarioEventConfig | null
  visibilityMode: "DIRECT" | "AFTER_STATE_CHANGE" | "PARTIAL_DELAY"
  actionDeadlineSeconds: number | null
  actionDeadlineAtSimulationTimeMs: number | null
  followUpEventCode: string | null
  recoveryCondition: V3ScenarioEventConfig["recoveryCondition"]
  controlledSimulationTimeMs: number | null
  escalationCount: number
}

interface ActionInput {
  expectedRevision?: unknown
  actionCode?: unknown
  targetId?: unknown
  eventId?: unknown
  alertId?: unknown
  requestId?: unknown
  reasoning?: V3RuntimeActionReasoning
  payload?: unknown
}

interface DynamicScheduleInput {
  expectedRevision?: unknown
  mode?: unknown
  reason?: unknown
  items?: unknown
  eventId?: unknown
}

export interface DynamicScheduleChanges {
  orderIds: string[]
  aircraftIds: string[]
  routeIds: string[]
}

const systemActor: AuthUser = { id: "00000000-0000-0000-0000-000000000001", email: "runtime@system.local", displayName: "运行引擎", role: "admin" }

@Injectable()
export class LogisticsRuntimeService {
  constructor(
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ProjectActivityCounterEntity) private readonly counters: Repository<ProjectActivityCounterEntity>,
    @InjectRepository(RuntimeSessionEntity) private readonly sessions: Repository<RuntimeSessionEntity>,
    @InjectRepository(RuntimeEventEntity) private readonly events: Repository<RuntimeEventEntity>,
    @InjectRepository(RuntimeAlertEntity) private readonly alerts: Repository<RuntimeAlertEntity>,
    @InjectRepository(StudentRuntimeActionEntity) private readonly actions: Repository<StudentRuntimeActionEntity>,
    @InjectRepository(LogisticsRuntimeReadinessEntity) private readonly readiness: Repository<LogisticsRuntimeReadinessEntity>,
    @InjectRepository(LogisticsRuntimeSnapshotEntity) private readonly snapshots: Repository<LogisticsRuntimeSnapshotEntity>,
    @InjectRepository(LogisticsDynamicScheduleVersionEntity) private readonly dynamicVersions: Repository<LogisticsDynamicScheduleVersionEntity>,
    private readonly data: LogisticsRuntimeDataService,
    private readonly activities: ActivityLogService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser, requestedSessionId?: string): Promise<LogisticsRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireProjectAccess(projectId, user, manager)
      const readiness = await manager.findOne(LogisticsRuntimeReadinessEntity, { where: { project: { id: projectId } } })
      if (!readiness || readiness.status !== "CONFIRMED") throw new ConflictException("请先确认运行准备")
      const session = requestedSessionId
        ? await manager.findOne(RuntimeSessionEntity, { where: { id: requestedSessionId, projectId } })
        : await this.ensureReadySession(manager, project, user)
      if (!session) throw new NotFoundException("运行批次不存在")
      await manager.query('SELECT "id" FROM "runtime_sessions" WHERE "id" = $1 FOR UPDATE', [session.id])
      const locked = await manager.findOneByOrFail(RuntimeSessionEntity, { id: session.id })
      if (!requestedSessionId) await this.syncSession(manager, project, locked)
      return locked.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, !requestedSessionId)
  }

  async restart(projectId: string, user: AuthUser, expectedRevision: unknown, nodeCodeValue: unknown): Promise<LogisticsRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以发起重新训练")
      this.ensureAssignmentActive(project)
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许回退或重新训练")
      const source = await this.lockCurrentSession(manager, projectId)
      runtimeRevision(expectedRevision, source.revision)
      if (source.status === "RUNNING") throw new ConflictException("请先暂停当前运行再重新训练")
      if (!["PAUSED", "COMPLETED", "ABORTED"].includes(source.status)) throw new ConflictException("当前运行状态不能重新训练")
      const counter = await this.lockCounter(manager, projectId)
      if (counter.runtimeCount >= project.snapshot.config.allowedRuntimeAttempts) throw new ConflictException("运行次数已达到任务限制")
      const events = await manager.find(RuntimeEventEntity, { where: { projectId, sessionId: source.id }, order: { scheduledSimulationTimeMs: "ASC" } })
      const nodes = logisticsRestartNodes(source, events)
      const nodeCode = typeof nodeCodeValue === "string" ? nodeCodeValue.trim() : ""
      const node = nodes.find((item) => item.code === nodeCode)
      if (!node) throw new BadRequestException("异常重训节点无效或尚未发现")
      await this.reopenRuntimeStages(manager, project)
      const sourceCheckpoint = parseCheckpoint(source.checkpoint)
      const sourceSnapshot = await manager.createQueryBuilder(LogisticsRuntimeSnapshotEntity, "snapshot")
        .where('snapshot."sessionId" = :sessionId', { sessionId: source.id })
        .andWhere('snapshot."simulationTimeMs" <= :simulationTimeMs', { simulationTimeMs: node.simulationTimeMs })
        .orderBy('snapshot."simulationTimeMs"', "DESC")
        .addOrderBy('snapshot."sequence"', "DESC")
        .getOne()
      const checkpoint = snapshotCheckpoint(sourceSnapshot?.checkpoint, sourceCheckpoint)
      checkpoint.clockAnchorSimulationTimeMs = node.simulationTimeMs
      checkpoint.clockAnchorRealTime = new Date().toISOString()
      checkpoint.lastSnapshotSequence = 0
      const session = await manager.save(RuntimeSessionEntity, manager.create(RuntimeSessionEntity, {
        projectId,
        status: "READY",
        mode: source.mode,
        scenarioSeed: source.scenarioSeed,
        mapResourceVersion: source.mapResourceVersion,
        sceneResourceVersion: source.sceneResourceVersion,
        planVersion: source.planVersion,
        attemptNo: source.attemptNo + 1,
        sourceSessionId: source.id,
        restartNodeCode: node.code,
        restartSimulationTimeMs: node.simulationTimeMs,
        simulationTimeMs: node.simulationTimeMs,
        revision: 1,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
        startedAt: null,
        endedAt: null
      }))
      await this.saveSnapshot(manager, project, session, checkpoint, "READY")
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        actor: user,
        eventType: "LOGISTICS_RUNTIME_RESTARTED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        simulationTimeMs: node.simulationTimeMs,
        result: { attemptNo: session.attemptNo, sourceSessionId: source.id, nodeCode: node.code, nodeLabel: node.label }
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, true)
  }

  async start(projectId: string, user: AuthUser, expectedRevision: unknown): Promise<LogisticsRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以启动配送运行")
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "LOGISTICS_DELIVERY_RUNTIME")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("请先开始配送运行阶段")
      const readiness = await manager.findOne(LogisticsRuntimeReadinessEntity, { where: { project: { id: projectId }, status: "CONFIRMED" } })
      if (!readiness) throw new ConflictException("运行准备尚未确认")
      const session = await this.ensureReadySession(manager, project, user)
      await manager.query('SELECT "id" FROM "runtime_sessions" WHERE "id" = $1 FOR UPDATE', [session.id])
      const locked = await manager.findOneByOrFail(RuntimeSessionEntity, { id: session.id })
      runtimeRevision(expectedRevision, locked.revision)
      if (locked.status !== "READY") throw new ConflictException("配送运行已经启动")
      const counter = await this.lockCounter(manager, projectId)
      if (counter.runtimeCount >= project.snapshot.config.allowedRuntimeAttempts) throw new ConflictException("运行次数已达到任务限制")
      const checkpoint = parseCheckpoint(locked.checkpoint)
      const now = new Date()
      checkpoint.clockAnchorRealTime = now.toISOString()
      const initialSimulationTimeMs = locked.restartSimulationTimeMs === null ? 0 : Number(locked.restartSimulationTimeMs)
      checkpoint.clockAnchorSimulationTimeMs = initialSimulationTimeMs
      locked.status = "RUNNING"
      locked.simulationTimeMs = initialSimulationTimeMs
      locked.startedAt = now
      locked.endedAt = null
      locked.checkpoint = checkpoint as unknown as Record<string, unknown>
      locked.revision += 1
      await manager.save(locked)
      counter.runtimeCount += 1
      await manager.save(counter)
      await this.createScheduledEvents(manager, project, locked, checkpoint)
      project.lastActivityAt = now
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        actor: user,
        eventType: "LOGISTICS_RUNTIME_STARTED",
        objectType: "RUNTIME_SESSION",
        objectId: locked.id,
        simulationTimeMs: initialSimulationTimeMs,
        afterRevision: locked.revision,
        result: { scheduleVersionNo: checkpoint.scheduleVersionNo, durationMs: checkpoint.durationMs, clockRate: checkpoint.clockRate, attemptNo: locked.attemptNo, restartNodeCode: locked.restartNodeCode }
      })
      await this.saveSnapshot(manager, project, locked, checkpoint, "START")
      return locked.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async changeClock(projectId: string, user: AuthUser, input: { expectedRevision?: unknown; status?: unknown; rate?: unknown }): Promise<LogisticsRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许调整运行时钟")
      if (actor !== "STUDENT" && actor !== "TEACHER") throw new ForbiddenException("无权调整运行时钟")
      const session = await this.lockCurrentSession(manager, projectId)
      runtimeRevision(input.expectedRevision, session.revision)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能调整时钟")
      const checkpoint = parseCheckpoint(session.checkpoint)
      const targetStatus = input.status === undefined ? session.status : input.status
      if (targetStatus !== "RUNNING" && targetStatus !== "PAUSED") throw new BadRequestException("时钟状态无效")
      const beforeRevision = session.revision
      const now = new Date()
      checkpoint.clockRate = clockRate(input.rate, checkpoint.clockRate)
      checkpoint.clockAnchorRealTime = now.toISOString()
      checkpoint.clockAnchorSimulationTimeMs = Number(session.simulationTimeMs)
      session.status = targetStatus
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      session.revision += 1
      await manager.save(session)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        actor: user,
        eventType: "LOGISTICS_RUNTIME_CLOCK_CHANGED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        beforeRevision,
        afterRevision: session.revision,
        result: { status: session.status, clockRate: checkpoint.clockRate }
      })
      await this.saveSnapshot(manager, project, session, checkpoint, "CLOCK")
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async triggerEvent(projectId: string, eventId: string, user: AuthUser, expectedRevision: unknown, requestIdValue?: unknown): Promise<LogisticsRuntimeWorkspaceView> {
    eventId = requiredUuid(eventId, "运行事件")
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER" || project.snapshot.mode !== "TRAINING") throw new ForbiddenException("仅训练模式教师可以手动触发事件")
      const session = await this.lockCurrentSession(manager, projectId)
      const requestId = normalizeRequestId(requestIdValue)
      const previous = requestId ? await this.findEventByRequestId(manager, projectId, session.id, requestId) : null
      if (previous) {
        if (previous.id !== eventId) throw new ConflictException("请求标识已对应其他物流事件")
        return session.id
      }
      runtimeRevision(expectedRevision, session.revision)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前没有可触发事件的运行会话")
      const event = await manager.findOne(RuntimeEventEntity, { where: { id: eventId, projectId, sessionId: session.id } })
      if (!event) throw new NotFoundException("运行事件不存在")
      if (event.status !== "SCHEDULED") throw new ConflictException("事件已经触发或结束")
      const beforeRevision = session.revision
      const payload = eventPayload(event)
      const scheduledSimulationTimeMs = Number(session.simulationTimeMs)
      if (!manualTriggerWindowOpen(payload.scenarioConfig, scheduledSimulationTimeMs)) throw new ConflictException("当前不在该事件允许的手动触发时间窗内")
      const escalationDelay = escalationDelayMs(payload.scenarioConfig, 0)
      payload.detectionAtSimulationTimeMs = scheduledSimulationTimeMs + visibilityDelayMs(payload.scenarioConfig, 0)
      payload.escalationAtSimulationTimeMs = escalationDelay === null ? null : scheduledSimulationTimeMs + escalationDelay
      payload.autoRecoveryAtSimulationTimeMs = payload.scenarioConfig?.recoveryMode === "AUTO" && payload.scenarioConfig.durationSeconds !== null
        ? scheduledSimulationTimeMs + payload.scenarioConfig.durationSeconds * 1_000
        : null
      event.scheduledSimulationTimeMs = scheduledSimulationTimeMs
      event.payload = { ...payload, ...(requestId ? { _manualTriggerRequestId: requestId } : {}) }
      await manager.save(event)
      const checkpoint = parseCheckpoint(session.checkpoint)
      await this.syncEvents(manager, project, session, checkpoint)
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      session.revision += 1
      await manager.save(session)
      project.lastActivityAt = new Date()
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        actor: user,
        eventType: "TEACHER_RUNTIME_INTERVENTION",
        objectType: "RUNTIME_EVENT",
        objectId: event.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        beforeRevision,
        afterRevision: session.revision,
        payload: { action: "TRIGGER_EVENT", code: event.code },
        correlationId: event.correlationId
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async sendTeacherHint(projectId: string, user: AuthUser, expectedRevision: unknown, message: unknown): Promise<LogisticsRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER" || project.snapshot.mode !== "TRAINING") throw new ForbiddenException("仅训练模式教师可以发送训练提示")
      const session = await this.lockCurrentSession(manager, projectId)
      runtimeRevision(expectedRevision, session.revision)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前没有可发送提示的运行会话")
      const hint = requiredText(message, "训练提示不能为空", 500)
      const beforeRevision = session.revision
      const alert = manager.create(RuntimeAlertEntity, {
        projectId,
        sessionId: session.id,
        eventId: null,
        stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        code: "TEACHER_HINT",
        title: "教师训练提示",
        detail: hint,
        severity: "INFO",
        status: "OPEN",
        simulationTimeMs: Number(session.simulationTimeMs),
        openedAt: new Date(),
        acknowledgedAt: null,
        resolvedAt: null,
        payload: { source: "TEACHER" },
        correlationId: randomUUID()
      })
      await manager.save(alert)
      session.revision += 1
      await manager.save(session)
      project.lastActivityAt = new Date()
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        actor: user,
        eventType: "TEACHER_RUNTIME_INTERVENTION",
        objectType: "RUNTIME_ALERT",
        objectId: alert.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        beforeRevision,
        afterRevision: session.revision,
        payload: { action: "SEND_HINT", message: hint },
        correlationId: alert.correlationId
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async applyAction(projectId: string, user: AuthUser, input: ActionInput): Promise<LogisticsRuntimeWorkspaceView> {
    try {
      const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以执行物流运行处置")
      this.ensureAssignmentActive(project)
      const session = await this.lockCurrentSession(manager, projectId)
      const requestId = normalizeRequestId(input.requestId)
      const code = runtimeActionCode(input.actionCode)
      const targetId = optionalId(input.targetId, "处置目标")
      const eventId = optionalUuid(input.eventId, "关联事件")
      const alertId = optionalUuid(input.alertId, "关联告警")
      const reasoning = normalizeRuntimeActionReasoning(input.reasoning)
      const actionPayload = logisticsActionPayload(input.payload)
      const requestIdentity: LogisticsActionRequestIdentity = {
        actionCode: code,
        eventId,
        alertId,
        targetType: logisticsActionTargetType(code),
        targetId,
        reasoning,
        payload: actionPayload
      }
      if (requestId) {
        const previous = await this.findActionByRequestId(manager, session.id, user.id, requestId)
        if (previous) {
          assertSameLogisticsActionRequest(previous, requestIdentity)
          return session.id
        }
      }
      runtimeRevision(input.expectedRevision, session.revision)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能执行处置")
      const checkpoint = parseCheckpoint(session.checkpoint)
      const records = await this.runtimeRecords(manager, project, checkpoint)
      const impacts = await this.activeEventImpacts(manager, session.id)
      const projection = this.project(records, session, checkpoint, impacts)
      const definition = runtimeActionsForProjection(projection).find((item) => item.code === code)
      if (!definition?.enabled) throw new ConflictException(definition?.disabledReason ?? "当前处置不可执行")
      if (definition.requiresTarget && !targetId) throw new BadRequestException("当前处置必须选择目标")
      const event = eventId ? await manager.findOne(RuntimeEventEntity, { where: { id: eventId, projectId, sessionId: session.id } }) : null
      const alert = alertId ? await manager.findOne(RuntimeAlertEntity, { where: { id: alertId, projectId, sessionId: session.id } }) : null
      if (eventId && !event) throw new NotFoundException("关联运行事件不存在")
      if (alertId && !alert) throw new NotFoundException("关联告警不存在")
      if (code === "ACKNOWLEDGE_ALERT" && !alert) throw new BadRequestException("确认告警必须关联告警记录")
      assertLogisticsActionContextPending(event, alert, code)
      this.validateActionTarget(code, targetId, projection)
      this.validateActionEventTarget(code, targetId, event, projection)
      const correlationId = event?.correlationId ?? alert?.correlationId ?? randomUUID()
      const action = manager.create(StudentRuntimeActionEntity, {
        projectId,
        sessionId: session.id,
        eventId: event?.id ?? null,
        alertId: alert?.id ?? null,
        actorId: user.id,
        actionCode: code,
        targetType: definition.targetType,
        targetId,
        status: "APPLIED",
        simulationTimeMs: Number(session.simulationTimeMs),
        payload: { ...actionPayload, reasoning, rationale: reasoning.rationale, ...(requestId ? { _requestId: requestId } : {}) },
        result: {},
        correlationId,
        requestedAt: new Date(),
        appliedAt: new Date()
      })
      const result = this.applyControlEffect(checkpoint, projection, records, code, targetId, action.payload, Number(session.simulationTimeMs))
      if (alert && code === "ACKNOWLEDGE_ALERT") {
        alert.status = "ACKNOWLEDGED"
        alert.acknowledgedAt = new Date()
        await manager.save(alert)
      }
      if (event && code !== "ACKNOWLEDGE_ALERT") await this.controlEvent(manager, project, session, event, alert, code)
      if (event && event.status === "RESOLVED") {
        const payload = eventPayload(event)
        const responseTimeMs = payload.detectedSimulationTimeMs === null ? null : Math.max(0, Number(session.simulationTimeMs) - payload.detectedSimulationTimeMs)
        Object.assign(result, {
          ...result,
          eventControlled: true,
          responseTimeMs,
          actionDeadlineSeconds: payload.actionDeadlineSeconds,
          withinDeadline: logisticsActionWithinDeadline(payload.actionDeadlineAtSimulationTimeMs, Number(session.simulationTimeMs))
        })
      }
      const updatedProjection = this.project(records, session, checkpoint, impacts)
      const businessOutcome = logisticsActionBusinessOutcome(projection, updatedProjection, code, targetId)
      action.result = {
        ...result,
        ...businessOutcome,
        ...(typeof result.outcome === "string" && result.outcome.trim() ? { outcome: result.outcome } : {})
      }
      await manager.save(action)
      checkpoint.durationMs = Math.max(checkpoint.durationMs, updatedProjection.durationMs)
      const beforeRevision = session.revision
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      session.revision += 1
      await manager.save(session)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_EMERGENCY_HANDLING",
        actor: user,
        eventType: "LOGISTICS_RUNTIME_ACTION_APPLIED",
        objectType: "RUNTIME_ACTION",
        objectId: action.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        beforeRevision,
        afterRevision: session.revision,
        payload: { actionCode: code, targetId, eventId, alertId, reasoning, rationale: reasoning.rationale },
        result: action.result,
        correlationId
      })
      await this.saveSnapshot(manager, project, session, checkpoint, "ACTION")
      return session.id
      })
      return this.serializeWorkspace(projectId, sessionId, user)
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

  async createDynamicSchedule(projectId: string, user: AuthUser, input: DynamicScheduleInput): Promise<LogisticsRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以创建动态调度版本")
      const session = await this.lockCurrentSession(manager, projectId)
      runtimeRevision(input.expectedRevision, session.revision)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能重调度")
      const mode = dynamicMode(input.mode)
      const policy = logisticsTemplatePolicy(project.snapshot.config.scaleTemplateCode)
      if (mode === "BATCH" && !policy.batchReschedulingEnabled) throw new ConflictException("当前模板未开放批量重调度")
      if (mode === "GLOBAL" && !policy.globalReschedulingEnabled) throw new ConflictException("当前模板未开放全局重调度")
      const reason = dynamicReason(input.reason)
      const eventId = optionalUuid(input.eventId, "关联事件")
      const event = eventId
        ? await manager.findOne(RuntimeEventEntity, { where: { id: eventId, projectId, sessionId: session.id } })
        : null
      if (eventId && !event) throw new NotFoundException("关联事件不存在或不属于当前运行批次")
      if (eventId && event?.status !== "ACTIVE") throw new ConflictException("动态重调度只能关联当前活动事件")
      const items = normalizeScheduleItems(input.items)
      const checkpoint = parseCheckpoint(session.checkpoint)
      const records = await this.runtimeRecords(manager, project, checkpoint)
      const changes = dynamicScheduleChanges(records.scheduleItems, items)
      assertDynamicScheduleMode(mode, policy.totalAircraft, policy.batchReschedulingEnabled, policy.globalReschedulingEnabled, changes)
      this.assertHistoricalTasksUnchanged(records.scheduleItems, items, Number(session.simulationTimeMs))
      const checkResult = checkLogisticsSchedule(items, {
        orders: records.base.orderViews,
        aircraft: records.base.aircraftViews,
        routes: records.base.routeViews,
        strictSerialOperation: policy.strictSerialOperation
      })
      const raw = await manager.createQueryBuilder(LogisticsDynamicScheduleVersionEntity, "version").select("COALESCE(MAX(version.versionNo), 0)", "maximum").where("version.projectId = :projectId", { projectId }).getRawOne<{ maximum: string | number }>()
      const version = await manager.save(LogisticsDynamicScheduleVersionEntity, manager.create(LogisticsDynamicScheduleVersionEntity, {
        project,
        parentVersionId: checkpoint.activeDynamicScheduleVersionId,
        versionNo: Number(raw?.maximum ?? 0) + 1,
        status: "DRAFT",
        mode,
        reason,
        eventId,
        affectedOrderIds: changes.orderIds,
        affectedAircraftIds: changes.aircraftIds,
        affectedRouteIds: changes.routeIds,
        effectiveSimulationTimeMs: Number(session.simulationTimeMs),
        items,
        checkResult,
        contentHash: dynamicScheduleContentHash({ mode, reason, eventId, parentVersionId: checkpoint.activeDynamicScheduleVersionId, items }),
        createdBy: await manager.findOneByOrFail(UserEntity, { id: user.id }),
        submittedBy: null,
        correlationId: eventId,
        submittedAt: null
      }))
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_EMERGENCY_HANDLING",
        actor: user,
        eventType: "LOGISTICS_DYNAMIC_SCHEDULE_CREATED",
        objectType: "LOGISTICS_DYNAMIC_SCHEDULE_VERSION",
        objectId: version.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        result: { versionNo: version.versionNo, mode, status: checkResult.status, itemCount: items.length, eventId, affectedOrderIds: changes.orderIds, affectedAircraftIds: changes.aircraftIds, affectedRouteIds: changes.routeIds, contentHash: version.contentHash }
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async submitDynamicSchedule(projectId: string, versionId: string, user: AuthUser, expectedRevision: unknown): Promise<LogisticsRuntimeWorkspaceView> {
    versionId = requiredUuid(versionId, "动态调度版本")
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以提交动态调度版本")
      const session = await this.lockCurrentSession(manager, projectId)
      runtimeRevision(expectedRevision, session.revision)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能提交重调度")
      const version = await manager.findOne(LogisticsDynamicScheduleVersionEntity, {
        where: { id: versionId, project: { id: projectId } },
        loadEagerRelations: false,
        lock: { mode: "pessimistic_write" }
      })
      if (!version) throw new NotFoundException("动态调度版本不存在")
      if (version.status !== "DRAFT") throw new ConflictException("动态调度版本已经提交")
      const expectedContentHash = dynamicScheduleContentHash({
        mode: version.mode,
        reason: version.reason,
        eventId: version.eventId,
        parentVersionId: version.parentVersionId,
        items: version.items
      })
      if (version.contentHash !== expectedContentHash) throw new ConflictException("动态调度内容摘要校验失败，请重新创建版本")
      const checkpoint = parseCheckpoint(session.checkpoint)
      if (version.parentVersionId !== checkpoint.activeDynamicScheduleVersionId) throw new ConflictException("动态调度基于过期版本，请重新调整")
      const records = await this.runtimeRecords(manager, project, checkpoint)
      const changes = dynamicScheduleChanges(records.scheduleItems, version.items)
      const policy = logisticsTemplatePolicy(project.snapshot.config.scaleTemplateCode)
      assertDynamicScheduleMode(version.mode, policy.totalAircraft, policy.batchReschedulingEnabled, policy.globalReschedulingEnabled, changes)
      this.assertHistoricalTasksUnchanged(records.scheduleItems, version.items, Number(session.simulationTimeMs))
      const checkResult = checkLogisticsSchedule(version.items, {
        orders: records.base.orderViews,
        aircraft: records.base.aircraftViews,
        routes: records.base.routeViews,
        strictSerialOperation: policy.strictSerialOperation
      })
      if (!checkResult.submittable) throw new ConflictException("动态调度引用了未提交验证航线或仍有硬冲突，不能提交")
      if (version.eventId) {
        const event = await manager.findOne(RuntimeEventEntity, { where: { id: version.eventId, projectId, sessionId: session.id } })
        if (!event) throw new ConflictException("动态调度关联事件已不存在")
        if (event.status !== "ACTIVE") throw new ConflictException("动态调度关联事件已结束，请重新创建版本")
      }
      version.status = "SUBMITTED"
      version.affectedOrderIds = changes.orderIds
      version.affectedAircraftIds = changes.aircraftIds
      version.affectedRouteIds = changes.routeIds
      version.checkResult = checkResult
      version.effectiveSimulationTimeMs = Number(session.simulationTimeMs)
      version.submittedAt = new Date()
      version.submittedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(version)
      const beforeRevision = session.revision
      checkpoint.activeDynamicScheduleVersionId = version.id
      checkpoint.durationMs = Math.max(checkpoint.durationMs, ...checkResult.items.map((item) => item.nextAvailableTimeMs))
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      session.revision += 1
      await manager.save(session)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_EMERGENCY_HANDLING",
        actor: user,
        eventType: "LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED",
        objectType: "LOGISTICS_DYNAMIC_SCHEDULE_VERSION",
        objectId: version.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        beforeRevision,
        afterRevision: session.revision,
        result: { versionNo: version.versionNo, mode: version.mode, status: version.checkResult.status, itemCount: version.items.length, eventId: version.eventId, affectedOrderIds: version.affectedOrderIds, affectedAircraftIds: version.affectedAircraftIds, affectedRouteIds: version.affectedRouteIds, contentHash: version.contentHash }
      })
      await this.saveSnapshot(manager, project, session, checkpoint, "RESCHEDULE")
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async completeEmergencyHandling(projectId: string, user: AuthUser): Promise<LogisticsRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以完成应急处置阶段")
      const session = await this.lockCurrentSession(manager, projectId)
      await this.syncSession(manager, project, session)
      if (session.status !== "COMPLETED" && session.status !== "ABORTED") throw new ConflictException("配送运行尚未结束")
      const activeEvents = await manager.count(RuntimeEventEntity, { where: { projectId, sessionId: session.id, status: "ACTIVE" } })
      if (activeEvents > 0) throw new ConflictException("仍有运行事件未结束")
      const stage = await this.lockStage(manager, projectId, "LOGISTICS_EMERGENCY_HANDLING")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("请先开始应急处置阶段")
      const now = new Date()
      stage.status = "ACCEPTED"
      stage.submittedAt = now
      stage.acceptedAt = now
      stage.revision += 1
      await manager.save(stage)
      const review = await this.lockStage(manager, projectId, "LOGISTICS_REVIEW")
      if (review.status === "LOCKED") {
        review.status = "AVAILABLE"
        review.revision += 1
        await manager.save(review)
      }
      project.currentStageCode = "LOGISTICS_REVIEW"
      project.lastActivityAt = now
      await manager.save(project)
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async ensureReadySession(manager: EntityManager, project: StudentProjectEntity, actor: AuthUser): Promise<RuntimeSessionEntity> {
    const existing = await manager.findOne(RuntimeSessionEntity, { where: { projectId: project.id }, order: { attemptNo: "DESC" } })
    if (existing) return existing
    const records = await this.data.loadSubmittedSchedule(manager, project.id)
    const durationMs = Math.max(1_000, ...records.scheduleItems.map((item) => item.nextAvailableTimeMs))
    const policy = logisticsTemplatePolicy(project.snapshot.config.scaleTemplateCode)
    const checkpoint: LogisticsRuntimeCheckpoint = {
      schemaVersion: 1,
      scheduleVersionId: records.version.id,
      scheduleVersionNo: records.version.versionNo,
      clockRate: numberScenario(project.snapshot.config.scenario, "logisticsRuntimeClockRate", 60, 0.25, 3_600),
      clockAnchorRealTime: new Date().toISOString(),
      clockAnchorSimulationTimeMs: 0,
      durationMs,
      totalAircraft: policy.totalAircraft,
      maximumConcurrentEvents: policy.maximumConcurrentEvents,
      lastSnapshotSequence: 0,
      activeDynamicScheduleVersionId: null,
      control: emptyControl()
    }
    const resourceVersions = freezeRuntimeResourceVersions(project.snapshot.resourceRefs, `schedule:${records.version.id}@${records.version.versionNo}`)
    const session = await manager.save(RuntimeSessionEntity, manager.create(RuntimeSessionEntity, {
      projectId: project.id,
      status: "READY",
      mode: project.snapshot.mode,
      scenarioSeed: project.snapshot.checksum,
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
    await this.activities.record(manager, {
      assignmentId: project.snapshot.draft.id,
      projectId: project.id,
      stageCode: "LOGISTICS_RUNTIME_PREPARATION",
      actor,
      eventType: "LOGISTICS_RUNTIME_SESSION_CREATED",
      objectType: "RUNTIME_SESSION",
      objectId: session.id,
      afterRevision: session.revision,
      result: { scheduleVersionNo: records.version.versionNo, durationMs, taskCount: records.scheduleItems.length }
    })
    await this.saveSnapshot(manager, project, session, checkpoint, "READY")
    return session
  }

  private async serializeWorkspace(projectId: string, sessionId: string, user: AuthUser, current = true): Promise<LogisticsRuntimeWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const session = await this.sessions.findOneBy({ id: sessionId, projectId })
    if (!session) throw new NotFoundException("运行会话不存在")
    const checkpoint = parseCheckpoint(session.checkpoint)
    const records = await this.runtimeRecords(this.dataSource.manager, project, checkpoint)
    const [attempts, events, alerts, actions, dynamicVersions, stage] = await Promise.all([
      this.sessions.find({ where: { projectId }, order: { attemptNo: "DESC" } }),
      this.events.find({ where: { projectId, sessionId }, order: { scheduledSimulationTimeMs: "ASC" } }),
      this.alerts.find({ where: { projectId, sessionId }, order: { openedAt: "DESC" } }),
      this.actions.find({ where: { projectId, sessionId }, order: { requestedAt: "DESC" } }),
      this.dynamicVersions.find({ where: { project: { id: projectId } }, order: { versionNo: "DESC" } }),
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "LOGISTICS_DELIVERY_RUNTIME" } })
    ])
    const projection = this.project(records, session, checkpoint, eventImpacts(events))
    const active = session.status === "RUNNING" || session.status === "PAUSED"
    const assessmentTiming = assessmentTimingForProject(project)
    const attemptsRemaining = Math.max(0, project.snapshot.config.allowedRuntimeAttempts - attempts.filter((item) => item.startedAt !== null).length)
    const restartNodes = current && project.snapshot.mode === "TRAINING" ? logisticsRestartNodes(session, events) : []
    const availableActions = runtimeActionsForProjection(projection).map((action) => {
      if (action.code === "ACKNOWLEDGE_ALERT" && !alerts.some((alert) => alert.status === "OPEN")) return { ...action, enabled: false, disabledReason: "当前没有待确认告警" }
      return action
    })
    return {
      projectId,
      actor,
      mode: project.snapshot.mode,
      scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
      session: serializeSession(session),
      clock: adaptRuntimeClock(session, {
        rate: checkpoint.clockRate,
        deadlineAt: assessmentTiming.deadlineAt,
        canPause: current && project.snapshot.mode === "TRAINING" && active,
        canReset: current && project.snapshot.mode === "TRAINING" && session.status !== "READY"
      }),
      attempts: attempts.map(serializeSession),
      restartNodes,
      attemptsRemaining,
      canRestart: current && actor === "STUDENT" && project.snapshot.mode === "TRAINING" && attemptsRemaining > 0 && restartNodes.length > 0 && ["PAUSED", "COMPLETED", "ABORTED"].includes(session.status),
      canStart: current && actor === "STUDENT" && assessmentTiming.canWrite && stage?.status === "IN_PROGRESS" && session.status === "READY",
      canControl: current && actor === "STUDENT" && assessmentTiming.canWrite && active,
      canTeacherIntervene: current && actor === "TEACHER" && project.snapshot.mode === "TRAINING" && active,
      clockRate: checkpoint.clockRate,
      durationMs: checkpoint.durationMs,
      remainingMs: Math.max(0, checkpoint.durationMs - Number(session.simulationTimeMs)),
      summary: projection.summary,
      environment: projection.environment,
      scheduleItems: records.scheduleItems,
      tasks: projection.tasks,
      aircraft: projection.aircraft,
      orders: projection.orders,
      routes: projection.routes,
      events: events.map(serializeEvent),
      alerts: alerts.map(serializeAlert),
      actions: actions.map(serializeAction),
      availableActions,
      dynamicScheduleVersions: dynamicVersions.map(serializeDynamicVersion)
    }
  }

  private async runtimeRecords(manager: EntityManager, project: StudentProjectEntity, checkpoint: LogisticsRuntimeCheckpoint) {
    const base = await this.data.loadSubmittedSchedule(manager, project.id)
    if (!checkpoint.activeDynamicScheduleVersionId) return { base, scheduleItems: base.scheduleItems }
    const version = await manager.findOne(LogisticsDynamicScheduleVersionEntity, { where: { id: checkpoint.activeDynamicScheduleVersionId, project: { id: project.id }, status: "SUBMITTED" } })
    if (!version) throw new ConflictException("当前动态调度版本不存在")
    return { base, scheduleItems: version.checkResult.items }
  }

  private project(records: { base: LogisticsRuntimeScheduleRecords; scheduleItems: LogisticsScheduleItemView[] }, session: RuntimeSessionEntity, checkpoint: LogisticsRuntimeCheckpoint, impacts: LogisticsRuntimeEventImpact[]): LogisticsRuntimeProjection {
    return computeLogisticsRuntimeProjection({
      simulationTimeMs: Number(session.simulationTimeMs),
      sessionStatus: session.status,
      totalAircraft: logisticsTemplatePolicy(records.base.version.project.snapshot.config.scaleTemplateCode).totalAircraft,
      orders: records.base.orderViews,
      aircraft: records.base.aircraftViews,
      routes: records.base.routeViews,
      scheduleItems: records.scheduleItems,
      initialEnvironment: resolveLogisticsInitialEnvironment(records.base.version.project.snapshot.config.scenario),
      control: { ...checkpoint.control, eventImpacts: impacts }
    })
  }

  private async syncSession(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity): Promise<void> {
    if (session.status === "READY" || session.status === "COMPLETED" || session.status === "ABORTED" || session.status === "FAILED") return
    const checkpoint = parseCheckpoint(session.checkpoint)
    const previousStatus = session.status
    const previousSimulationTimeMs = Number(session.simulationTimeMs)
    const previousSnapshotSequence = checkpoint.lastSnapshotSequence
    if (session.status === "RUNNING") {
      session.simulationTimeMs = fixedTickSimulationTime({ simulationTimeMs: checkpoint.clockAnchorSimulationTimeMs, realTimeMs: Date.parse(checkpoint.clockAnchorRealTime), rate: checkpoint.clockRate }, Date.now(), checkpoint.durationMs)
    }
    await this.syncEvents(manager, project, session, checkpoint)
    if (shouldSaveLogisticsTickSnapshot(previousSimulationTimeMs, Number(session.simulationTimeMs), previousSnapshotSequence, checkpoint.lastSnapshotSequence)) {
      await this.saveSnapshot(manager, project, session, checkpoint, "TICK")
    }
    if (Number(session.simulationTimeMs) >= checkpoint.durationMs) {
      session.status = "COMPLETED"
      session.simulationTimeMs = checkpoint.durationMs
      session.endedAt = new Date()
      await this.finishEvents(manager, project, session)
      await this.advanceAfterRuntime(manager, project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: "LOGISTICS_DELIVERY_RUNTIME",
        actor: systemActor,
        eventType: "LOGISTICS_RUNTIME_COMPLETED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        simulationTimeMs: checkpoint.durationMs,
        result: { durationMs: checkpoint.durationMs }
      })
      await this.saveSnapshot(manager, project, session, checkpoint, "COMPLETE")
    }
    const changed = previousStatus !== session.status
      || previousSimulationTimeMs !== Number(session.simulationTimeMs)
      || previousSnapshotSequence !== checkpoint.lastSnapshotSequence
    if (!changed) return
    session.checkpoint = checkpoint as unknown as Record<string, unknown>
    session.revision += 1
    await manager.save(session)
  }

  private async createScheduledEvents(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, checkpoint: LogisticsRuntimeCheckpoint): Promise<void> {
    const policy = logisticsTemplatePolicy(project.snapshot.config.scaleTemplateCode)
    const restartSourceEventId = session.restartNodeCode?.startsWith("EVENT:") ? session.restartNodeCode.slice("EVENT:".length) : null
    const restartSourceEvent = restartSourceEventId && session.sourceSessionId
      ? await manager.findOne(RuntimeEventEntity, { where: { id: restartSourceEventId, projectId: project.id, sessionId: session.sourceSessionId } })
      : null
    if (restartSourceEvent) await manager.save(replayLogisticsEvent(manager, project, session, restartSourceEvent))
    if (policy.eventLevel === "NONE" || policy.eventLevel === "PREFLIGHT_ONLY") return
    const records = await this.runtimeRecords(manager, project, checkpoint)
    const eventInputs = await eventResourceInputs(manager, project)
    const configured = configuredLogisticsEvents(eventInputs.selected)
    const configuredDefinitions = configured.filter((definition) => policy.allowedEventCodes.includes(definition.code))
    const definitions = configuredDefinitions.length > 0
      ? configuredDefinitions
      : eventInputs.legacyDefaultEnabled ? defaultEvents(policy.eventLevel) : []
    const maximum = Math.min(policy.eventCountRange.maximum, definitions.length)
    for (const [index, definition] of definitions.slice(0, maximum).entries()) {
      if (definition.code === restartSourceEvent?.code) continue
      const detectionDelay = visibilityDelayMs(definition.scenarioConfig, definition.detectionDelayMs)
      const ratio = (index + 1) / (maximum + 1)
      const scheduled = logisticsEventScheduleTime(session.scenarioSeed, checkpoint.durationMs, definition.scenarioConfig, index, maximum, ratio)
      if (scheduled !== null && scheduled < Number(session.restartSimulationTimeMs ?? 0)) continue
      const targets = eventTargets(definition, records.base, index, policy.totalAircraft)
      const escalationDelay = escalationDelayMs(definition.scenarioConfig, definition.escalationDelayMs)
      const payload: LogisticsEventPayload = {
        title: definition.title,
        detail: definition.detail,
        eventSubtype: definition.scenarioConfig?.eventSubtype ?? null,
        lifecycleStatus: "SCHEDULED",
        ...targets,
        recommendedActions: definition.recommendedActions,
        detectionAtSimulationTimeMs: scheduled === null ? 0 : scheduled + detectionDelay,
        detectedSimulationTimeMs: null,
        escalationAtSimulationTimeMs: scheduled === null || escalationDelay === null ? null : scheduled + escalationDelay,
        autoRecoveryAtSimulationTimeMs: definition.scenarioConfig?.recoveryMode === "AUTO" && definition.scenarioConfig.durationSeconds !== null
          ? scheduled === null ? null : scheduled + definition.scenarioConfig.durationSeconds * 1_000
          : null,
        recoveryMode: definition.scenarioConfig?.recoveryMode ?? "STUDENT",
        recoveryCondition: definition.scenarioConfig?.recoveryCondition ?? null,
        scenarioConfig: definition.scenarioConfig,
        visibilityMode: definition.scenarioConfig?.visibilityMode ?? "AFTER_STATE_CHANGE",
        actionDeadlineSeconds: definition.scenarioConfig?.actionDeadlineSeconds ?? null,
        actionDeadlineAtSimulationTimeMs: null,
        followUpEventCode: definition.scenarioConfig?.followUpEventCode ?? null,
        controlledSimulationTimeMs: null,
        escalationCount: 0
      }
      await manager.save(RuntimeEventEntity, manager.create(RuntimeEventEntity, {
        projectId: project.id,
        sessionId: session.id,
        stageCode: "LOGISTICS_EMERGENCY_HANDLING",
        code: definition.code,
        category: definition.category,
        status: "SCHEDULED",
        severity: definition.severity,
        scheduledSimulationTimeMs: scheduled,
        triggeredAt: null,
        resolvedAt: null,
        payload: payload as unknown as Record<string, unknown>,
        correlationId: randomUUID()
      }))
    }
  }

  private async syncEvents(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, checkpoint: LogisticsRuntimeCheckpoint): Promise<void> {
    const current = Number(session.simulationTimeMs)
    const events = await manager.find(RuntimeEventEntity, { where: { projectId: project.id, sessionId: session.id }, order: { scheduledSimulationTimeMs: "ASC" } })
    const records = await this.runtimeRecords(manager, project, checkpoint)
    const projection = this.project(records, session, checkpoint, [])
    const eventStatuses = Object.fromEntries(events.map((item) => [item.code, item.status]))
    const conditionContext = {
      currentSimulationTimeMs: current,
      phase: projection.tasks.some((item) => item.status === "OUTBOUND") ? "OUTBOUND" : projection.tasks.some((item) => item.status === "RETURNING") ? "RETURNING" : "WAITING_EXECUTION",
      eventStatuses,
      values: {
        airborneAircraft: projection.aircraft.filter((item) => ["TAKING_OFF", "OUTBOUND", "ARRIVED", "RETURNING", "LANDING", "HOLDING", "DIVERTING", "EMERGENCY_LANDING"].includes(item.status)).length,
        activeOrders: projection.orders.filter((item) => !["DELIVERED", "CANCELLED", "FAILED"].includes(item.status)).length
      }
    }
    let changed = false
    let activeEventCount = events.filter((event) => event.status === "ACTIVE").length
    const concurrentLimit = logisticsMaximumConcurrentEvents(checkpoint, project.snapshot.config.scaleTemplateCode)
    for (const event of events) {
      const payload = eventPayload(event)
      if (event.status === "SCHEDULED" && event.scheduledSimulationTimeMs === null && payload.scenarioConfig && triggerSatisfied(payload.scenarioConfig, conditionContext)) {
        const scheduled = current
        event.scheduledSimulationTimeMs = scheduled
        payload.detectionAtSimulationTimeMs = scheduled + visibilityDelayMs(payload.scenarioConfig, 0)
        const escalationDelay = escalationDelayMs(payload.scenarioConfig, 0)
        payload.escalationAtSimulationTimeMs = escalationDelay === null ? null : scheduled + escalationDelay
        payload.autoRecoveryAtSimulationTimeMs = payload.scenarioConfig.recoveryMode === "AUTO" && payload.scenarioConfig.durationSeconds !== null
          ? scheduled + payload.scenarioConfig.durationSeconds * 1_000
          : null
        event.payload = { ...event.payload, ...payload } as unknown as Record<string, unknown>
        await manager.save(event)
        changed = true
      }
      if (event.status === "SCHEDULED" && event.scheduledSimulationTimeMs !== null && Number(event.scheduledSimulationTimeMs) <= current && canActivateScenarioEvent(activeEventCount, concurrentLimit)) {
        event.status = "ACTIVE"
        event.triggeredSimulationTimeMs = current
        event.triggeredAt = new Date()
        payload.lifecycleStatus = "OCCURRED_UNDETECTED"
        event.payload = { ...event.payload, ...payload } as unknown as Record<string, unknown>
        await manager.save(event)
        activeEventCount = scenarioEventActiveCountAfterTransition(activeEventCount, "SCHEDULED", "ACTIVE")
        changed = true
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId: project.id,
          stageCode: "LOGISTICS_EMERGENCY_HANDLING",
          actor: systemActor,
          eventType: "LOGISTICS_RUNTIME_EVENT_TRIGGERED",
          objectType: "RUNTIME_EVENT",
          objectId: event.id,
          simulationTimeMs: Number(event.scheduledSimulationTimeMs),
          payload: { code: event.code, category: event.category, eventSubtype: payload.eventSubtype },
          correlationId: event.correlationId
        })
      }
      if (event.status === "ACTIVE" && payload.detectedSimulationTimeMs === null && current >= payload.detectionAtSimulationTimeMs) {
        payload.lifecycleStatus = "DISCOVERED"
        payload.detectedSimulationTimeMs = current
        payload.actionDeadlineAtSimulationTimeMs = payload.actionDeadlineSeconds === null
          ? null
          : current + payload.actionDeadlineSeconds * 1_000
        event.payload = { ...event.payload, ...payload } as unknown as Record<string, unknown>
        await manager.save(event)
        const existingAlert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id } })
        if (!existingAlert) {
          const alert = await manager.save(RuntimeAlertEntity, manager.create(RuntimeAlertEntity, {
            projectId: project.id,
            sessionId: session.id,
            eventId: event.id,
            stageCode: "LOGISTICS_EMERGENCY_HANDLING",
            code: event.code,
            title: payload.title,
            detail: payload.detail,
            severity: event.severity,
            status: "OPEN",
            simulationTimeMs: current,
            openedAt: new Date(),
            acknowledgedAt: null,
            resolvedAt: null,
            payload: mergeRuntimeAlertPayload(payload as unknown as Record<string, unknown>, { eventSubtype: payload.eventSubtype, affectedAircraftIds: payload.affectedAircraftIds, affectedOrderIds: payload.affectedOrderIds, affectedRouteIds: payload.affectedRouteIds }),
            correlationId: event.correlationId
          }))
          await this.activities.record(manager, {
            assignmentId: project.snapshot.draft.id,
            projectId: project.id,
            stageCode: "LOGISTICS_EMERGENCY_HANDLING",
            actor: systemActor,
            eventType: "LOGISTICS_RUNTIME_EVENT_DISCOVERED",
            objectType: "RUNTIME_ALERT",
            objectId: alert.id,
            simulationTimeMs: current,
            result: { eventId: event.id, severity: event.severity, eventSubtype: payload.eventSubtype },
            correlationId: event.correlationId
          })
        }
        changed = true
      }
      if (event.status === "ACTIVE" && payload.escalationCount === 0 && payload.escalationAtSimulationTimeMs !== null && current >= payload.escalationAtSimulationTimeMs) {
        payload.lifecycleStatus = "ESCALATED"
        payload.escalationCount = 1
        event.severity = escalate(event.severity)
        event.payload = { ...event.payload, ...payload } as unknown as Record<string, unknown>
        await manager.save(event)
        const alert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id } })
        if (alert && alert.status !== "RESOLVED") {
          alert.severity = event.severity
          alert.detail = `${payload.detail} 事件持续未控制，影响范围正在扩大。`
          alert.payload = mergeRuntimeAlertPayload(payload as unknown as Record<string, unknown>, alert.payload)
          await manager.save(alert)
        }
        changed = true
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId: project.id,
          stageCode: "LOGISTICS_EMERGENCY_HANDLING",
          actor: systemActor,
          eventType: "LOGISTICS_RUNTIME_EVENT_ESCALATED",
          objectType: "RUNTIME_EVENT",
          objectId: event.id,
          simulationTimeMs: current,
          result: { severity: event.severity, eventSubtype: payload.eventSubtype },
          correlationId: event.correlationId
        })
      }
      if (event.status === "ACTIVE" && ((payload.autoRecoveryAtSimulationTimeMs !== null && current >= payload.autoRecoveryAtSimulationTimeMs) || recoverySatisfied(payload.scenarioConfig, conditionContext))) {
        payload.lifecycleStatus = "CONTROLLED"
        payload.controlledSimulationTimeMs = current
        event.status = "RESOLVED"
        event.resolvedSimulationTimeMs = current
        event.resolvedAt = new Date()
        event.payload = { ...event.payload, ...payload } as unknown as Record<string, unknown>
        await manager.save(event)
        activeEventCount = scenarioEventActiveCountAfterTransition(activeEventCount, "ACTIVE", "RESOLVED")
        const alert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id } })
        if (alert && alert.status !== "RESOLVED") {
          alert.status = "RESOLVED"
          alert.resolvedAt = new Date()
          await manager.save(alert)
        }
        changed = true
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId: project.id,
          stageCode: "LOGISTICS_EMERGENCY_HANDLING",
          actor: systemActor,
          eventType: "LOGISTICS_RUNTIME_EVENT_RESOLVED",
          objectType: "RUNTIME_EVENT",
          objectId: event.id,
          simulationTimeMs: current,
          result: { recoveryMode: "AUTO", eventSubtype: payload.eventSubtype },
          correlationId: event.correlationId
        })
      }
    }
    if (changed) await this.saveSnapshot(manager, project, session, checkpoint, "EVENT")
  }

  private async controlEvent(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, event: RuntimeEventEntity, alert: RuntimeAlertEntity | null, actionCode: LogisticsRuntimeActionCode): Promise<void> {
    const payload = eventPayload(event)
    if (!payload.recommendedActions.includes(actionCode)) return
    payload.lifecycleStatus = "CONTROLLED"
    payload.controlledSimulationTimeMs = Number(session.simulationTimeMs)
    event.status = "RESOLVED"
    event.resolvedSimulationTimeMs = Number(session.simulationTimeMs)
    event.resolvedAt = new Date()
    event.payload = { ...event.payload, ...payload } as unknown as Record<string, unknown>
    await manager.save(event)
    if (alert) {
      alert.status = "RESOLVED"
      alert.resolvedAt = new Date()
      await manager.save(alert)
    }
    await this.activities.record(manager, {
      assignmentId: project.snapshot.draft.id,
      projectId: project.id,
      stageCode: "LOGISTICS_EMERGENCY_HANDLING",
      actor: systemActor,
      eventType: "LOGISTICS_RUNTIME_EVENT_RESOLVED",
      objectType: "RUNTIME_EVENT",
      objectId: event.id,
      simulationTimeMs: Number(session.simulationTimeMs),
      result: { actionCode, eventSubtype: payload.eventSubtype },
      correlationId: event.correlationId
    })
  }

  private applyControlEffect(
    checkpoint: LogisticsRuntimeCheckpoint,
    projection: LogisticsRuntimeProjection,
    records: { base: LogisticsRuntimeScheduleRecords; scheduleItems: LogisticsScheduleItemView[] },
    code: LogisticsRuntimeActionCode,
    targetId: string | null,
    payload: Record<string, unknown>,
    simulationTimeMs: number
  ): Record<string, unknown> {
    const control = checkpoint.control
    const aircraft = targetId ? projection.aircraft.find((item) => item.id === targetId) : null
    const order = targetId ? projection.orders.find((item) => item.id === targetId) : null
    const route = targetId ? projection.routes.find((item) => item.id === targetId) : null
    const task = aircraft ? projection.tasks.find((item) => item.scheduleItemId === aircraft.currentTaskId) : order ? projection.tasks.find((item) => item.orderId === order.id) : null
    let outcome: Record<string, unknown> = {}
    if (code === "HOLD_POSITION" && aircraft) {
      control.aircraftStatusOverrides[aircraft.id] = "HOLDING"
      control.aircraftPositionOverrides[aircraft.id] = aircraft.position
      delete control.resumePlans[aircraft.id]
      if (task) control.holdStartedAtMs[task.scheduleItemId] = simulationTimeMs
    } else if (code === "PROCEED_TO_WAITING_POINT" && aircraft) {
      control.aircraftStatusOverrides[aircraft.id] = "HOLDING"
      const currentRoute = records.base.routeViews.find((item) => item.id === task?.activeRouteId)
      const waitingPoint = currentRoute?.route.waypoints.find((waypoint) => waypoint.nodeId && currentRoute.route.waitingNodeIds.includes(waypoint.nodeId))
      control.aircraftPositionOverrides[aircraft.id] = waitingPoint
        ? { ...waitingPoint.position, altitudeMeters: waitingPoint.altitudeMeters }
        : aircraft.position
      delete control.resumePlans[aircraft.id]
      if (task) control.holdStartedAtMs[task.scheduleItemId] = simulationTimeMs
    } else if (code === "REDUCE_SPEED" && aircraft && task) {
      const factor = Number(payload.speedFactor ?? 1.5)
      if (!Number.isFinite(factor) || factor < 1.05 || factor > 3) throw new BadRequestException("减速系数必须在 1.05 至 3 之间")
      control.taskSpeedFactorOverrides[task.scheduleItemId] = Math.max(control.taskSpeedFactorOverrides[task.scheduleItemId] ?? 1, factor)
    } else if (code === "MAINTAIN_ROUTE" && aircraft) {
      if (task) {
        const holdStartedAtMs = control.holdStartedAtMs[task.scheduleItemId]
        if (holdStartedAtMs !== undefined) {
          control.delayOffsetsMs[task.scheduleItemId] = (control.delayOffsetsMs[task.scheduleItemId] ?? 0) + Math.max(0, simulationTimeMs - holdStartedAtMs)
          const currentRoute = records.base.routeViews.find((item) => item.id === task.activeRouteId)
          const routeEnd = currentRoute?.route.waypoints.at(-1)
          const resumeDurationMs = Math.max(0, task.returnStartTimeMs - simulationTimeMs)
          if (routeEnd && resumeDurationMs > 0) {
            control.resumePlans[aircraft.id] = {
              aircraftId: aircraft.id,
              taskId: task.scheduleItemId,
              startSimulationTimeMs: simulationTimeMs,
              endSimulationTimeMs: simulationTimeMs + resumeDurationMs,
              routePoints: [aircraft.position, { ...routeEnd.position, altitudeMeters: routeEnd.altitudeMeters }]
            }
          }
          delete control.holdStartedAtMs[task.scheduleItemId]
        }
      }
      delete control.aircraftStatusOverrides[aircraft.id]
      delete control.aircraftPositionOverrides[aircraft.id]
    } else if (code === "RETURN_AIRCRAFT" && aircraft && task) {
      delete control.holdStartedAtMs[task.scheduleItemId]
      delete control.resumePlans[aircraft.id]
      const returnRouteId = records.scheduleItems.find((item) => item.id === task.scheduleItemId)?.returnRouteId ?? task.activeRouteId
      if (!returnRouteId) throw new ConflictException("当前任务没有可用的返程航线")
      const returnRoute = records.base.routeViews.find((item) => item.id === returnRouteId)
      const returnDurationMs = Math.max(10_000, task.landingTimeMs - task.returnStartTimeMs)
      control.returnPlans ??= {}
      control.aircraftStatusOverrides[aircraft.id] = "RETURNING"
      control.taskStatusOverrides[task.scheduleItemId] = "RETURNING"
      control.activeRouteOverrides[task.scheduleItemId] = returnRouteId
      control.returnPlans[aircraft.id] = {
        aircraftId: aircraft.id,
        taskId: task.scheduleItemId,
        startSimulationTimeMs: simulationTimeMs,
        endSimulationTimeMs: simulationTimeMs + returnDurationMs,
        routePoints: [
          aircraft.position,
          ...(returnRoute?.route.waypoints.map((waypoint) => ({ ...waypoint.position, altitudeMeters: waypoint.altitudeMeters })) ?? [])
        ]
      }
      control.orderStatusOverrides[task.orderId] = "DELAYED"
    } else if (code === "DIVERT_AIRCRAFT" && aircraft && task) {
      control.aircraftStatusOverrides[aircraft.id] = "DIVERTING"
      control.orderStatusOverrides[task.orderId] = "DELAYED"
      const currentRoute = records.base.routeViews.find((item) => item.id === task.activeRouteId)
      const requestedRouteId = typeof payload.routeId === "string" ? payload.routeId : null
      const alternate = records.base.routeViews.find((item) => item.id === requestedRouteId
        && item.route.destinationNodeId === task.destinationNodeId
        && item.route.direction === currentRoute?.route.direction
        && item.route.role === "ALTERNATE")
        ?? records.base.routeViews.find((item) => item.route.destinationNodeId === task.destinationNodeId
          && item.route.direction === currentRoute?.route.direction
          && item.route.role === "ALTERNATE")
      if (requestedRouteId && !alternate) throw new ConflictException("备降只能切换到目的地一致且已提交的备用航线")
      if (alternate) {
        const alternateState = projection.routes.find((item) => item.id === alternate.id)
        if (alternateState?.status === "ABNORMAL" || alternateState?.status === "CLOSED" || alternateState?.status === "PAUSED") throw new ConflictException("当前备用航线不可用")
        control.activeRouteOverrides[task.scheduleItemId] = alternate.id
      } else {
        const landingPoint = selectNearestAlternateLandingPoint(
          aircraft.position,
          records.base.logisticsNodes,
          currentRoute?.route.alternateLandingNodeIds ?? []
        )
        if (!landingPoint?.node.position) throw new ConflictException("当前航线没有可用备降点，请先配置并启用备降点")
        const diversionDurationMs = Math.max(10_000, Math.round((landingPoint.distanceMeters / 12) * 1_000))
        control.diversionPlans[aircraft.id] = {
          aircraftId: aircraft.id,
          taskId: task.scheduleItemId,
          startSimulationTimeMs: simulationTimeMs,
          endSimulationTimeMs: simulationTimeMs + diversionDurationMs,
          startPosition: aircraft.position,
          landingPosition: landingPoint.node.position,
          landingNodeId: landingPoint.node.id
        }
        delete control.aircraftPositionOverrides[aircraft.id]
        outcome = {
          outcome: `无人机 ${aircraft.code} 已转入备降点 ${landingPoint.node.name}`,
          alternateLandingNodeId: landingPoint.node.id,
          alternateLandingNodeName: landingPoint.node.name,
          diversionDistanceMeters: Math.round(landingPoint.distanceMeters),
          estimatedArrivalSimulationTimeMs: simulationTimeMs + diversionDurationMs
        }
      }
    } else if (code === "EMERGENCY_LAND_AIRCRAFT" && aircraft && task) {
      delete control.holdStartedAtMs[task.scheduleItemId]
      delete control.resumePlans[aircraft.id]
      control.aircraftStatusOverrides[aircraft.id] = "EMERGENCY_LANDING"
      control.taskStatusOverrides[task.scheduleItemId] = "FAILED"
      control.orderStatusOverrides[task.orderId] = "FAILED"
      control.aircraftPositionOverrides[aircraft.id] = aircraft.position
    } else if ((code === "ABORT_TASK" || code === "CANCEL_TASK") && order) {
      control.orderStatusOverrides[order.id] = "CANCELLED"
      if (task) {
        delete control.holdStartedAtMs[task.scheduleItemId]
        control.taskStatusOverrides[task.scheduleItemId] = "CANCELLED"
        const taskAircraft = projection.aircraft.find((item) => item.id === task.aircraftId)
        if (taskAircraft && task.status !== "WAITING_EXECUTION") control.aircraftPositionOverrides[taskAircraft.id] = taskAircraft.position
      }
    } else if ((code === "PAUSE_ROUTE" || code === "PAUSE_ROUTE_ENTRY") && route) {
      control.routeStatusOverrides[route.id] = "PAUSED"
      outcome = { outcome: `已暂停航线 ${route.name}`, previousRouteStatus: route.status, routeStatus: "PAUSED" }
    } else if (code === "RESUME_ROUTE" && route) {
      delete control.routeStatusOverrides[route.id]
      outcome = { outcome: `已恢复航线 ${route.name}`, previousRouteStatus: route.status, routeStatus: "AVAILABLE" }
    } else if (code === "SWITCH_VERIFIED_ROUTE" && order && task) {
      const replacementRouteId = optionalId(payload.routeId, "备用航线")
      const currentRouteId = task.activeRouteId ?? task.outboundRouteId
      const currentRoute = records.base.routeViews.find((item) => item.id === currentRouteId)
      const eligibleRouteIds = logisticsRuntimeEligibleRouteIdsByTargetId(projection)[order.id] ?? []
      const replacement = records.base.routeViews.find((item) => item.id === replacementRouteId && eligibleRouteIds.includes(item.id))
      if (!replacement || replacement.route.role !== "ALTERNATE" || replacement.versionId !== currentRoute?.versionId) {
        throw new ConflictException("只能切换到当前已提交验证版本中目的地和方向一致的备用航线")
      }
      control.activeRouteOverrides[task.scheduleItemId] = replacement.id
      outcome = {
        outcome: `已切换至备用方案 ${replacement.route.name}`,
        previousRouteId: currentRoute?.id ?? null,
        replacementRouteId: replacement.id,
        replacementRouteName: replacement.route.name,
        replacementRouteRole: replacement.route.role,
        sourceVersionNo: replacement.versionNo
      }
    } else if ((code === "REPLACE_AIRCRAFT" || code === "REASSIGN_ORDER") && order && task) {
      const replacementAircraftId = optionalId(payload.aircraftId, "替代无人机")
      const replacement = projection.aircraft.find((item) => item.id === replacementAircraftId)
      if (!replacement || replacement.id === task.aircraftId || replacement.status !== "AVAILABLE") {
        throw new ConflictException("替代无人机必须是当前可用且未被占用的无人机")
      }
      if (task.status !== "WAITING_EXECUTION") throw new ConflictException("只有尚未起飞的任务可以更换或重新分配无人机")
      control.taskAircraftOverrides[task.scheduleItemId] = replacement.id
      if (code === "REPLACE_AIRCRAFT") control.aircraftStatusOverrides[task.aircraftId] = "DISABLED"
    } else if (code === "CHANGE_PRIORITY" && order) {
      const priority = String(payload.priority ?? "") as LogisticsSchedulingOrderPriority
      const priorities: LogisticsSchedulingOrderPriority[] = ["NORMAL", "PRIORITY", "URGENT"]
      if (!priorities.includes(priority)) {
        throw new BadRequestException("订单优先级必须为 NORMAL、PRIORITY 或 URGENT")
      }
      control.orderPriorityOverrides[order.id] = priority
    } else if (code === "DELAY_TASK" && order && task) {
      const delay = positiveDelay(payload.delayMs)
      control.delayOffsetsMs[task.scheduleItemId] = (control.delayOffsetsMs[task.scheduleItemId] ?? 0) + delay
      control.orderStatusOverrides[order.id] = "EXPECTED_DELAY"
    }
    checkpoint.control = control
    return { actionCode: code, targetId, applied: true, ...outcome }
  }

  private validateActionTarget(code: LogisticsRuntimeActionCode, targetId: string | null, projection: LogisticsRuntimeProjection): void {
    const aircraftActions: LogisticsRuntimeActionCode[] = ["REDUCE_SPEED", "MAINTAIN_ROUTE", "HOLD_POSITION", "PROCEED_TO_WAITING_POINT", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "EMERGENCY_LAND_AIRCRAFT"]
    const orderActions: LogisticsRuntimeActionCode[] = ["ABORT_TASK", "SWITCH_VERIFIED_ROUTE", "REPLACE_AIRCRAFT", "REASSIGN_ORDER", "CHANGE_PRIORITY", "DELAY_TASK", "CANCEL_TASK"]
    const routeActions: LogisticsRuntimeActionCode[] = ["PAUSE_ROUTE_ENTRY", "PAUSE_ROUTE", "RESUME_ROUTE"]
    const eligibleTargetIds = logisticsRuntimeEligibleTargetIds(code, projection)
    if (targetId && aircraftActions.includes(code) && !eligibleTargetIds.includes(targetId)) throw new ConflictException("所选无人机当前不具备该处置条件")
    if (targetId && orderActions.includes(code) && !eligibleTargetIds.includes(targetId)) throw new ConflictException("所选订单当前不具备该处置条件")
    if (targetId && routeActions.includes(code) && !eligibleTargetIds.includes(targetId)) throw new ConflictException("所选航线当前不具备该处置条件")
  }

  private validateActionEventTarget(code: LogisticsRuntimeActionCode, targetId: string | null, event: RuntimeEventEntity | null, projection: LogisticsRuntimeProjection): void {
    if (!event || !targetId) return
    const payload = eventPayload(event)
    if ((code === "PAUSE_ROUTE" || code === "PAUSE_ROUTE_ENTRY") && payload.affectedRouteIds.length > 0 && !payload.affectedRouteIds.includes(targetId)) {
      throw new ConflictException("所选航线不在关联事件的影响范围内")
    }
    if (code === "SWITCH_VERIFIED_ROUTE" && payload.affectedRouteIds.length > 0) {
      const task = projection.tasks.find((item) => item.orderId === targetId)
      const currentRouteId = task?.activeRouteId ?? task?.outboundRouteId
      if (!currentRouteId || !payload.affectedRouteIds.includes(currentRouteId)) throw new ConflictException("所选订单的当前航线不在关联事件的影响范围内")
    }
  }

  private assertHistoricalTasksUnchanged(current: LogisticsScheduleItemView[], next: LogisticsScheduleItemInput[], simulationTimeMs: number): void {
    const nextMap = new Map(next.map((item) => [item.id, item]))
    for (const item of current) {
      if (logisticsRuntimeTaskStatusAt(item, simulationTimeMs) === "WAITING_EXECUTION") continue
      const candidate = nextMap.get(item.id)
      if (!candidate || !sameScheduleInput(item, candidate)) throw new ConflictException(`已开始任务 ${item.orderCode} 的运行事实不能修改`)
    }
  }

  private async activeEventImpacts(manager: EntityManager, sessionId: string): Promise<LogisticsRuntimeEventImpact[]> {
    const events = await manager.find(RuntimeEventEntity, { where: { sessionId, status: "ACTIVE" } })
    return eventImpacts(events)
  }

  private async saveSnapshot(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, checkpoint: LogisticsRuntimeCheckpoint, reason: LogisticsRuntimeSnapshotEntity["reason"]): Promise<void> {
    const records = await this.runtimeRecords(manager, project, checkpoint)
    const projection = this.project(records, session, checkpoint, await this.activeEventImpacts(manager, session.id))
    const rows = await manager.query<{ maxSequence: string | number | null }[]>(
      'SELECT COALESCE(MAX("sequence"), 0) AS "maxSequence" FROM "logistics_runtime_snapshots" WHERE "sessionId" = $1',
      [session.id]
    )
    checkpoint.lastSnapshotSequence = nextLogisticsSnapshotSequence(checkpoint.lastSnapshotSequence, rows[0]?.maxSequence)
    const contentHash = createHash("sha256").update(JSON.stringify({ simulationTimeMs: Number(session.simulationTimeMs), projection })).digest("hex")
    await manager.save(LogisticsRuntimeSnapshotEntity, manager.create(LogisticsRuntimeSnapshotEntity, {
      projectId: project.id,
      sessionId: session.id,
      sequence: checkpoint.lastSnapshotSequence,
      simulationTimeMs: Number(session.simulationTimeMs),
      reason,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      projection,
      contentHash
    }))
    session.checkpoint = checkpoint as unknown as Record<string, unknown>
    await manager.save(session)
  }

  private async finishEvents(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity): Promise<void> {
    const events = await manager.find(RuntimeEventEntity, { where: { projectId: project.id, sessionId: session.id } })
    for (const event of events) {
      if (event.status === "RESOLVED" || event.status === "CANCELLED") continue
      const payload = eventPayload(event)
      payload.lifecycleStatus = "ENDED"
      event.status = event.status === "SCHEDULED" ? "CANCELLED" : "RESOLVED"
      if (event.status === "RESOLVED") event.resolvedSimulationTimeMs = Number(session.simulationTimeMs)
      event.resolvedAt = new Date()
      event.payload = { ...event.payload, ...payload } as unknown as Record<string, unknown>
      await manager.save(event)
    }
    const alerts = await manager.find(RuntimeAlertEntity, { where: { projectId: project.id, sessionId: session.id, status: "OPEN" } })
    for (const alert of alerts) {
      alert.status = "RESOLVED"
      alert.resolvedAt = new Date()
      await manager.save(alert)
    }
  }

  private async advanceAfterRuntime(manager: EntityManager, project: StudentProjectEntity): Promise<void> {
    const runtime = await this.lockStage(manager, project.id, "LOGISTICS_DELIVERY_RUNTIME")
    const emergency = await this.lockStage(manager, project.id, "LOGISTICS_EMERGENCY_HANDLING")
    const now = new Date()
    if (runtime.status === "IN_PROGRESS") {
      runtime.status = "ACCEPTED"
      runtime.submittedAt = now
      runtime.acceptedAt = now
      runtime.revision += 1
      await manager.save(runtime)
    }
    if (emergency.status === "LOCKED") {
      emergency.status = "AVAILABLE"
      emergency.revision += 1
      await manager.save(emergency)
    }
    project.currentStageCode = "LOGISTICS_EMERGENCY_HANDLING"
    project.lastActivityAt = now
    await manager.save(project)
  }

  private async lockCurrentSession(manager: EntityManager, projectId: string): Promise<RuntimeSessionEntity> {
    const current = await manager.findOne(RuntimeSessionEntity, { where: { projectId }, order: { attemptNo: "DESC" } })
    if (!current) throw new ConflictException("运行会话尚未初始化")
    await manager.query('SELECT "id" FROM "runtime_sessions" WHERE "id" = $1 FOR UPDATE', [current.id])
    return manager.findOneOrFail(RuntimeSessionEntity, { where: { id: current.id }, lock: { mode: "pessimistic_write" } })
  }

  private async findActionByRequestId(manager: EntityManager, sessionId: string, actorId: string, requestId: string): Promise<StudentRuntimeActionEntity | null> {
    const actions = await manager.createQueryBuilder(StudentRuntimeActionEntity, "action")
      .where("action.sessionId = :sessionId", { sessionId })
      .andWhere("action.actorId = :actorId", { actorId })
      .orderBy("action.requestedAt", "DESC")
      .setLock("pessimistic_write")
      .getMany()
    return actions.find((action) => typeof action.payload?._requestId === "string" && action.payload._requestId === requestId) ?? null
  }

  private async findEventByRequestId(manager: EntityManager, projectId: string, sessionId: string, requestId: string): Promise<RuntimeEventEntity | null> {
    return manager.createQueryBuilder(RuntimeEventEntity, "event")
      .where("event.projectId = :projectId", { projectId })
      .andWhere("event.sessionId = :sessionId", { sessionId })
      .andWhere("event.payload ->> '_manualTriggerRequestId' = :requestId", { requestId })
      .setLock("pessimistic_write")
      .getOne()
  }

  private async lockStage(manager: EntityManager, projectId: string, stageCode: "LOGISTICS_DELIVERY_RUNTIME" | "LOGISTICS_EMERGENCY_HANDLING" | "LOGISTICS_REVIEW"): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode }, lock: { mode: "pessimistic_write" } })
    if (!stage) throw new NotFoundException("项目阶段不存在")
    return stage
  }

  private async reopenRuntimeStages(manager: EntityManager, project: StudentProjectEntity): Promise<void> {
    const runtime = await this.lockStage(manager, project.id, "LOGISTICS_DELIVERY_RUNTIME")
    const emergency = await this.lockStage(manager, project.id, "LOGISTICS_EMERGENCY_HANDLING")
    const review = await this.lockStage(manager, project.id, "LOGISTICS_REVIEW")
    if (emergency.status === "SUBMITTED" || emergency.status === "ACCEPTED" || review.status !== "LOCKED") {
      throw new ConflictException("应急处置或复盘已提交，不能重新训练")
    }
    runtime.status = "IN_PROGRESS"
    runtime.submittedAt = null
    runtime.acceptedAt = null
    runtime.returnedAt = null
    runtime.revision += 1
    emergency.status = "LOCKED"
    emergency.submittedAt = null
    emergency.acceptedAt = null
    emergency.returnedAt = null
    emergency.revision += 1
    project.currentStageCode = "LOGISTICS_DELIVERY_RUNTIME"
    project.lastActivityAt = new Date()
    await manager.save([runtime, emergency, project])
  }

  private async lockCounter(manager: EntityManager, projectId: string): Promise<ProjectActivityCounterEntity> {
    const counter = await manager.findOne(ProjectActivityCounterEntity, { where: { project: { id: projectId } }, lock: { mode: "pessimistic_write" } })
    if (!counter) throw new ConflictException("项目活动计数器不存在")
    return counter
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

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    if (project.snapshot.draft.status === "ENDED" || project.snapshot.draft.status === "ARCHIVED") throw new ConflictException("任务已结束或归档，不能继续修改")
  }
}

function parseCheckpoint(value: Record<string, unknown>): LogisticsRuntimeCheckpoint {
  const control = isRecord(value.control) ? value.control : {}
  const totalAircraft = optionalPositiveInteger(value.totalAircraft)
  const maximumConcurrentEvents = optionalPositiveInteger(value.maximumConcurrentEvents)
  return {
    schemaVersion: 1,
    scheduleVersionId: String(value.scheduleVersionId ?? ""),
    scheduleVersionNo: Math.max(1, Number(value.scheduleVersionNo ?? 1)),
    clockRate: Number(value.clockRate ?? 60),
    clockAnchorRealTime: String(value.clockAnchorRealTime ?? new Date().toISOString()),
    clockAnchorSimulationTimeMs: Math.max(0, Number(value.clockAnchorSimulationTimeMs ?? 0)),
    durationMs: Math.max(1_000, Number(value.durationMs ?? 1_000)),
    ...(totalAircraft === undefined ? {} : { totalAircraft }),
    ...(maximumConcurrentEvents === undefined ? {} : { maximumConcurrentEvents }),
    lastSnapshotSequence: Math.max(0, Number(value.lastSnapshotSequence ?? 0)),
    activeDynamicScheduleVersionId: typeof value.activeDynamicScheduleVersionId === "string" ? value.activeDynamicScheduleVersionId : null,
    control: {
      aircraftStatusOverrides: isRecord(control.aircraftStatusOverrides) ? control.aircraftStatusOverrides as LogisticsRuntimeControlState["aircraftStatusOverrides"] : {},
      aircraftPositionOverrides: isRecord(control.aircraftPositionOverrides) ? control.aircraftPositionOverrides as LogisticsRuntimeControlState["aircraftPositionOverrides"] : {},
      diversionPlans: isRecord(control.diversionPlans) ? control.diversionPlans as LogisticsRuntimeControlState["diversionPlans"] : {},
      returnPlans: isRecord(control.returnPlans) ? control.returnPlans as LogisticsRuntimeControlState["returnPlans"] : {},
      resumePlans: isRecord(control.resumePlans) ? control.resumePlans as LogisticsRuntimeControlState["resumePlans"] : {},
      holdStartedAtMs: isRecord(control.holdStartedAtMs) ? control.holdStartedAtMs as Record<string, number> : {},
      orderStatusOverrides: isRecord(control.orderStatusOverrides) ? control.orderStatusOverrides as LogisticsRuntimeControlState["orderStatusOverrides"] : {},
      routeStatusOverrides: isRecord(control.routeStatusOverrides) ? control.routeStatusOverrides as LogisticsRuntimeControlState["routeStatusOverrides"] : {},
      taskStatusOverrides: isRecord(control.taskStatusOverrides) ? control.taskStatusOverrides as LogisticsRuntimeControlState["taskStatusOverrides"] : {},
      taskAircraftOverrides: isRecord(control.taskAircraftOverrides) ? control.taskAircraftOverrides as Record<string, string> : {},
      orderPriorityOverrides: isRecord(control.orderPriorityOverrides) ? control.orderPriorityOverrides as LogisticsRuntimeControlState["orderPriorityOverrides"] : {},
      taskSpeedFactorOverrides: isRecord(control.taskSpeedFactorOverrides) ? control.taskSpeedFactorOverrides as Record<string, number> : {},
      activeRouteOverrides: isRecord(control.activeRouteOverrides) ? control.activeRouteOverrides as Record<string, string> : {},
      delayOffsetsMs: isRecord(control.delayOffsetsMs) ? control.delayOffsetsMs as Record<string, number> : {},
      eventImpacts: []
    }
  }
}

export function nextLogisticsSnapshotSequence(checkpointSequence: number, databaseSequence: string | number | null | undefined): number {
  const checkpoint = Number.isFinite(checkpointSequence) ? Math.floor(checkpointSequence) : 0
  const database = typeof databaseSequence === "number" ? databaseSequence : Number(databaseSequence)
  const persisted = Number.isFinite(database) ? Math.floor(database) : 0
  return Math.max(0, checkpoint, persisted) + 1
}

export function shouldSaveLogisticsTickSnapshot(
  previousSimulationTimeMs: number,
  currentSimulationTimeMs: number,
  previousSnapshotSequence: number,
  currentSnapshotSequence: number
): boolean {
  return Number.isFinite(currentSimulationTimeMs)
    && Number.isFinite(previousSimulationTimeMs)
    && currentSimulationTimeMs > previousSimulationTimeMs
    && currentSnapshotSequence === previousSnapshotSequence
}

export function logisticsMaximumConcurrentEvents(checkpoint: LogisticsRuntimeCheckpoint, scaleTemplateCode?: string): number {
  const configured = Number(checkpoint.maximumConcurrentEvents)
  if (Number.isInteger(configured) && configured >= 1) return configured
  const totalAircraft = Number(checkpoint.totalAircraft)
  if (Number.isInteger(totalAircraft) && totalAircraft >= 1) return logisticsTemplatePolicy(`LOGISTICS_${totalAircraft}`).maximumConcurrentEvents
  return logisticsTemplatePolicy(scaleTemplateCode ?? "LOGISTICS_3").maximumConcurrentEvents
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined
}

export function snapshotCheckpoint(value: Record<string, unknown> | undefined, fallback: LogisticsRuntimeCheckpoint): LogisticsRuntimeCheckpoint {
  if (value && value.schemaVersion === 1) return parseCheckpoint(structuredClone(value))
  return parseCheckpoint(structuredClone(fallback as unknown as Record<string, unknown>))
}

export function logisticsRestartNodes(session: RuntimeSessionEntity, events: RuntimeEventEntity[]): V3RuntimeRestartNodeView[] {
  if (session.status === "READY") return []
  const nodes = events.flatMap((event) => {
    const payload = eventPayload(event)
    if (payload.detectedSimulationTimeMs === null) return []
    return [{
      code: `EVENT:${event.id}`,
      label: payload.title,
      kind: "EVENT" as const,
      sourceSessionId: session.id,
      simulationTimeMs: payload.detectedSimulationTimeMs,
      detail: `从 T+${formatRuntimeTime(payload.detectedSimulationTimeMs)} 的“${payload.title}”节点重新训练`
    }]
  })
  const unique = new Map<string, V3RuntimeRestartNodeView>()
  for (const node of nodes) unique.set(node.code, node)
  return [...unique.values()].sort((left, right) => left.simulationTimeMs - right.simulationTimeMs || left.label.localeCompare(right.label))
}

function formatRuntimeTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function requiredText(value: unknown, emptyMessage: string, maximumLength: number): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) throw new BadRequestException(emptyMessage)
  if (text.length > maximumLength) throw new BadRequestException(`内容不能超过 ${maximumLength} 个字符`)
  return text
}

function emptyControl(): LogisticsRuntimeControlState {
  return {
    aircraftStatusOverrides: {},
    aircraftPositionOverrides: {},
    diversionPlans: {},
    returnPlans: {},
    resumePlans: {},
    holdStartedAtMs: {},
    orderStatusOverrides: {},
    routeStatusOverrides: {},
    taskStatusOverrides: {},
    taskAircraftOverrides: {},
    orderPriorityOverrides: {},
    taskSpeedFactorOverrides: {},
    activeRouteOverrides: {},
    delayOffsetsMs: {},
    eventImpacts: []
  }
}

function eventPayload(event: RuntimeEventEntity): LogisticsEventPayload {
  const value = event.payload
  return {
    title: String(value.title ?? event.code),
    detail: String(value.detail ?? ""),
    eventSubtype: typeof value.eventSubtype === "string" ? value.eventSubtype as V3ScenarioEventConfig["eventSubtype"] : null,
    lifecycleStatus: String(value.lifecycleStatus ?? "SCHEDULED") as LogisticsRuntimeEventLifecycleStatus,
    affectedAircraftIds: stringArray(value.affectedAircraftIds),
    affectedOrderIds: stringArray(value.affectedOrderIds),
    affectedRouteIds: stringArray(value.affectedRouteIds),
    recommendedActions: stringArray(value.recommendedActions) as LogisticsRuntimeActionCode[],
    detectionAtSimulationTimeMs: Number(value.detectionAtSimulationTimeMs ?? event.scheduledSimulationTimeMs ?? 0),
    detectedSimulationTimeMs: value.detectedSimulationTimeMs === null || value.detectedSimulationTimeMs === undefined ? null : Number(value.detectedSimulationTimeMs),
    escalationAtSimulationTimeMs: value.escalationAtSimulationTimeMs === null || value.escalationAtSimulationTimeMs === undefined ? null : Math.max(0, Number(value.escalationAtSimulationTimeMs)),
    autoRecoveryAtSimulationTimeMs: value.autoRecoveryAtSimulationTimeMs === null || value.autoRecoveryAtSimulationTimeMs === undefined ? null : Math.max(0, Number(value.autoRecoveryAtSimulationTimeMs)),
    recoveryMode: value.recoveryMode === "AUTO" || value.recoveryMode === "CONDITION" || value.recoveryMode === "UNTIL_END" ? value.recoveryMode : "STUDENT",
    scenarioConfig: isRecord(value.scenarioConfig) ? value.scenarioConfig as unknown as V3ScenarioEventConfig : null,
    visibilityMode: value.visibilityMode === "DIRECT" || value.visibilityMode === "PARTIAL_DELAY" ? value.visibilityMode : "AFTER_STATE_CHANGE",
    actionDeadlineSeconds: value.actionDeadlineSeconds === null || value.actionDeadlineSeconds === undefined ? null : Math.max(0, Number(value.actionDeadlineSeconds)),
    actionDeadlineAtSimulationTimeMs: value.actionDeadlineAtSimulationTimeMs === null || value.actionDeadlineAtSimulationTimeMs === undefined ? null : Math.max(0, Number(value.actionDeadlineAtSimulationTimeMs)),
    followUpEventCode: typeof value.followUpEventCode === "string" ? value.followUpEventCode : null,
    recoveryCondition: isRecord(value.recoveryCondition) ? value.recoveryCondition as unknown as V3ScenarioEventConfig["recoveryCondition"] : null,
    controlledSimulationTimeMs: value.controlledSimulationTimeMs === null || value.controlledSimulationTimeMs === undefined ? null : Number(value.controlledSimulationTimeMs),
    escalationCount: Number(value.escalationCount ?? 0)
  }
}

function replayLogisticsEvent(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, source: RuntimeEventEntity): RuntimeEventEntity {
  const sourcePayload = eventPayload(source)
  const simulationTimeMs = Number(session.restartSimulationTimeMs ?? session.simulationTimeMs)
  const detectedAt = sourcePayload.detectedSimulationTimeMs ?? sourcePayload.detectionAtSimulationTimeMs
  const escalationDelay = sourcePayload.escalationAtSimulationTimeMs === null ? null : Math.max(0, sourcePayload.escalationAtSimulationTimeMs - detectedAt)
  const recoveryDelay = sourcePayload.autoRecoveryAtSimulationTimeMs === null ? null : Math.max(0, sourcePayload.autoRecoveryAtSimulationTimeMs - detectedAt)
  const payload: LogisticsEventPayload = {
    ...structuredClone(sourcePayload),
    lifecycleStatus: "SCHEDULED",
    detectionAtSimulationTimeMs: simulationTimeMs,
    detectedSimulationTimeMs: null,
    escalationAtSimulationTimeMs: escalationDelay === null ? null : simulationTimeMs + escalationDelay,
    autoRecoveryAtSimulationTimeMs: recoveryDelay === null ? null : simulationTimeMs + recoveryDelay,
    actionDeadlineAtSimulationTimeMs: null,
    controlledSimulationTimeMs: null,
    escalationCount: 0
  }
  return manager.create(RuntimeEventEntity, {
    projectId: project.id,
    sessionId: session.id,
    stageCode: source.stageCode,
    code: source.code,
    category: source.category,
    status: "SCHEDULED",
    severity: source.severity,
    scheduledSimulationTimeMs: simulationTimeMs,
    triggeredAt: null,
    resolvedAt: null,
    payload: payload as unknown as Record<string, unknown>,
    correlationId: randomUUID()
  })
}

function logisticsEventScheduleTime(
  seed: string,
  durationMs: number,
  config: V3ScenarioEventConfig | null,
  index: number,
  total: number,
  fallbackRatio: number
): number | null {
  const fallback = durationMs * (0.25 + fallbackRatio * 0.5)
  if (config?.triggerMode === "TIME_RANGE" && config.triggerWindowSeconds) return scheduleRuntimeWindowTime(seed, config.code, index, durationMs, config.triggerWindowSeconds)
  if (!config || config.triggerMode === "AUTO") return Math.max(1_000, Math.min(durationMs, Math.round(fallback)))
  if (config.triggerMode === "SIMULATION_TIME") return Math.max(0, Math.min(durationMs, Math.round((config.triggerTimeSeconds ?? 0) * 1_000)))
  if (config.triggerMode === "CONDITION" || config.triggerMode === "AFTER_EVENT") return null
  const phaseRatios: Record<string, number> = {
    TAKEOFF: 0.1,
    OUTBOUND: 0.28,
    ARRIVAL_CONFIRMATION: 0.48,
    RETURNING: 0.66,
    LANDING: 0.84,
    AVAILABLE_AGAIN: 0.98
  }
  const phaseRatio = phaseRatios[config.triggerPhase ?? ""] ?? (0.25 + ((index + 1) / (total + 1)) * 0.5)
  return Math.max(1_000, Math.min(durationMs, Math.round(durationMs * phaseRatio + config.triggerOffsetSeconds * 1_000)))
}

function eventImpacts(events: RuntimeEventEntity[]): LogisticsRuntimeEventImpact[] {
  return events.filter((event) => event.status === "ACTIVE").map((event) => {
    const payload = eventPayload(event)
    return {
      eventId: event.id,
      category: event.category as LogisticsRuntimeEventImpact["category"],
      severity: event.severity,
      affectedAircraftIds: payload.affectedAircraftIds,
      affectedOrderIds: payload.affectedOrderIds,
      affectedRouteIds: payload.affectedRouteIds
    }
  })
}

function eventTargets(definition: ConfiguredLogisticsEvent, records: LogisticsRuntimeScheduleRecords, index: number, totalAircraft: number) {
  const config = definition.scenarioConfig
  const scope = config?.impactScope ?? "DEFAULT"
  const defaultAircraftCount = totalAircraft >= 50 ? Math.min(5, records.aircraft.length) : 1
  const aircraftCount = config?.impactCount ?? (scope === "SINGLE" ? 1 : scope === "SMALL_BATCH" ? Math.max(2, Math.ceil(totalAircraft * 0.05)) : scope === "WHOLE" || scope === "OVERALL" ? records.aircraft.length : defaultAircraftCount)
  const orderCount = config?.impactCount ?? (scope === "SINGLE" ? 1 : scope === "WHOLE" || scope === "OVERALL" ? records.orders.length : totalAircraft >= 20 ? Math.min(5, records.orders.length) : 1)
  const routeCount = config?.impactCount ?? (scope === "SINGLE_ROUTE" ? 1 : scope === "MULTI_ROUTE" ? Math.min(3, records.routeViews.length) : scope === "WHOLE" || scope === "OVERALL" ? records.routeViews.length : totalAircraft >= 50 ? Math.min(3, records.routeViews.length) : 1)
  const configuredAircraft = config?.targetIds?.filter((id) => records.aircraftViews.some((item) => item.id === id)) ?? []
  const configuredOrders = config?.targetIds?.filter((id) => records.orderViews.some((item) => item.id === id)) ?? []
  const configuredRoutes = config?.targetIds?.filter((id) => records.routeViews.some((item) => item.id === id)) ?? []
  const aircraftIds = (configuredAircraft.length > 0 ? configuredAircraft : rotate(records.aircraftViews.map((item) => item.id), index)).slice(0, Math.min(records.aircraft.length, Math.max(1, aircraftCount)))
  const orderIds = (configuredOrders.length > 0 ? configuredOrders : rotate(records.orderViews.map((item) => item.id), index)).slice(0, Math.min(records.orders.length, Math.max(1, orderCount)))
  const routeIds = (configuredRoutes.length > 0 ? configuredRoutes : rotate(records.routeViews.map((item) => item.id), index)).slice(0, Math.min(records.routeViews.length, Math.max(1, routeCount)))
  if (definition.category === "ORDER_TASK_CHANGE") return { affectedAircraftIds: [], affectedOrderIds: orderIds, affectedRouteIds: [] }
  if (definition.category === "ROUTE_OPERATION" || definition.category === "WEATHER_ENVIRONMENT") return { affectedAircraftIds: aircraftIds, affectedOrderIds: orderIds, affectedRouteIds: routeIds }
  return { affectedAircraftIds: aircraftIds, affectedOrderIds: orderIds, affectedRouteIds: [] }
}

function defaultEvents(level: ReturnType<typeof logisticsTemplatePolicy>["eventLevel"]) {
  const codes = level === "LIGHTWEIGHT" ? ["DYNAMIC_ORDER"] : level === "SINGLE_TECHNICAL" ? ["COMMUNICATION_LOSS"] : ["WEATHER_CHANGE", "AIRCRAFT_FAULT", "ROUTE_SUSPENDED"]
  return codes.flatMap((code) => {
    const definition = logisticsEventDefinition(code)
    return definition ? [{ ...definition, recommendedActions: [...definition.recommendedActions], scenarioConfig: null }] : []
  })
}

function serializeSession(session: RuntimeSessionEntity): V3RuntimeSessionView {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    mode: session.mode,
    scenarioSeed: session.scenarioSeed,
    mapResourceVersion: session.mapResourceVersion,
    sceneResourceVersion: session.sceneResourceVersion,
    planVersion: session.planVersion,
    attemptNo: session.attemptNo,
    sourceSessionId: session.sourceSessionId,
    restartNodeCode: session.restartNodeCode,
    restartSimulationTimeMs: session.restartSimulationTimeMs === null ? null : Number(session.restartSimulationTimeMs),
    simulationTimeMs: Number(session.simulationTimeMs),
    revision: session.revision,
    checkpoint: session.checkpoint,
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null
  }
}

function serializeEvent(event: RuntimeEventEntity): LogisticsRuntimeEventView {
  const payload = eventPayload(event)
  return {
    id: event.id,
    projectId: event.projectId,
    sessionId: event.sessionId,
    stageCode: event.stageCode,
    code: event.code,
    category: event.category as LogisticsRuntimeEventView["category"],
    status: event.status,
    severity: event.severity,
    scheduledSimulationTimeMs: event.scheduledSimulationTimeMs === null ? null : Number(event.scheduledSimulationTimeMs),
    triggeredAt: event.triggeredAt?.toISOString() ?? null,
    resolvedAt: event.resolvedAt?.toISOString() ?? null,
    triggeredSimulationTimeMs: event.triggeredSimulationTimeMs === null ? null : Number(event.triggeredSimulationTimeMs),
    resolvedSimulationTimeMs: event.resolvedSimulationTimeMs === null ? null : Number(event.resolvedSimulationTimeMs),
    payload: event.payload,
    correlationId: event.correlationId,
    lifecycleStatus: payload.lifecycleStatus,
    title: payload.title,
    detail: payload.detail,
    affectedAircraftIds: payload.affectedAircraftIds,
    affectedOrderIds: payload.affectedOrderIds,
    affectedRouteIds: payload.affectedRouteIds,
    recommendedActions: payload.recommendedActions,
    detectedSimulationTimeMs: payload.detectedSimulationTimeMs,
    controlledSimulationTimeMs: payload.controlledSimulationTimeMs
  }
}

function serializeAlert(alert: RuntimeAlertEntity): V3RuntimeAlertView {
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
    correlationId: alert.correlationId
  }
}

function serializeAction(action: StudentRuntimeActionEntity): V3StudentRuntimeActionView {
  return {
    id: action.id,
    projectId: action.projectId,
    sessionId: action.sessionId,
    eventId: action.eventId,
    alertId: action.alertId,
    actorId: action.actorId,
    actionCode: action.actionCode,
    targetType: action.targetType,
    targetId: action.targetId,
    status: action.status,
    simulationTimeMs: Number(action.simulationTimeMs),
    payload: action.payload,
    result: action.result,
    correlationId: action.correlationId,
    requestedAt: action.requestedAt.toISOString(),
    appliedAt: action.appliedAt?.toISOString() ?? null
  }
}

function serializeDynamicVersion(version: LogisticsDynamicScheduleVersionEntity): LogisticsDynamicScheduleVersionView {
  return {
    id: version.id,
    versionNo: version.versionNo,
    parentVersionId: version.parentVersionId,
    status: version.status,
    mode: version.mode,
    reason: version.reason,
    eventId: version.eventId,
    affectedOrderIds: version.affectedOrderIds ?? [],
    affectedAircraftIds: version.affectedAircraftIds ?? [],
    affectedRouteIds: version.affectedRouteIds ?? [],
    effectiveSimulationTimeMs: Number(version.effectiveSimulationTimeMs),
    items: version.items,
    checkResult: version.checkResult,
    contentHash: version.contentHash ?? "",
    createdBy: version.createdBy.displayName,
    submittedBy: version.submittedBy?.displayName ?? null,
    createdAt: version.createdAt.toISOString(),
    submittedAt: version.submittedAt?.toISOString() ?? null
  }
}

function sameScheduleInput(current: LogisticsScheduleItemView, next: LogisticsScheduleItemInput): boolean {
  return current.id === next.id && current.orderId === next.orderId && current.aircraftId === next.aircraftId && current.outboundRouteId === next.outboundRouteId && current.returnRouteId === next.returnRouteId && current.plannedTakeoffTimeMs === next.plannedTakeoffTimeMs
}

export function dynamicScheduleChanges(current: LogisticsScheduleItemView[], next: LogisticsScheduleItemInput[]): DynamicScheduleChanges {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const nextById = new Map(next.map((item) => [item.id, item]))
  const orderIds = new Set<string>()
  const aircraftIds = new Set<string>()
  const routeIds = new Set<string>()
  for (const itemId of new Set([...currentById.keys(), ...nextById.keys()])) {
    const before = currentById.get(itemId)
    const after = nextById.get(itemId)
    if (before && after && sameScheduleInput(before, after)) continue
    for (const item of [before, after]) {
      if (!item) continue
      orderIds.add(item.orderId)
      aircraftIds.add(item.aircraftId)
      routeIds.add(item.outboundRouteId)
      routeIds.add(item.returnRouteId)
    }
  }
  return {
    orderIds: [...orderIds].sort(),
    aircraftIds: [...aircraftIds].sort(),
    routeIds: [...routeIds].sort()
  }
}

export function assertDynamicScheduleMode(
  mode: LogisticsDynamicScheduleMode,
  totalAircraft: number,
  batchEnabled: boolean,
  globalEnabled: boolean,
  changes: DynamicScheduleChanges
): void {
  if (changes.orderIds.length === 0) throw new ConflictException("动态重调度没有检测到任何变更")
  if (mode === "SINGLE" && changes.orderIds.length > 1) throw new ConflictException("单任务重调度只能影响一个订单")
  if (mode === "BATCH") {
    if (!batchEnabled) throw new ConflictException("当前模板未开放批量重调度")
    if (changes.orderIds.length < 2) throw new ConflictException("批量重调度至少需要影响两个订单")
  }
  if (mode === "GLOBAL") {
    if (!globalEnabled || totalAircraft < 50) throw new ConflictException("全局重调度仅对 50 架模板开放")
  }
}

export function dynamicScheduleContentHash(input: {
  mode: LogisticsDynamicScheduleMode
  reason: string
  eventId: string | null
  parentVersionId: string | null
  items: LogisticsScheduleItemInput[]
}): string {
  const items = [...input.items].sort((left, right) => left.id.localeCompare(right.id))
  return sha256Canonical({ ...input, items })
}

function runtimeActionsForProjection(projection: LogisticsRuntimeProjection): LogisticsRuntimeWorkspaceView["availableActions"] {
  const eligibleRouteIdsByTargetId = logisticsRuntimeEligibleRouteIdsByTargetId(projection)
  return projection.availableActions.map((action) => {
    const eligibleTargetIds = logisticsRuntimeEligibleTargetIds(action.code, projection)
    const targetEligibilityRequired = action.requiresTarget && (action.targetType === "AIRCRAFT" || action.targetType === "ORDER" || action.targetType === "ROUTE")
    if (action.enabled && targetEligibilityRequired && eligibleTargetIds.length === 0) {
      return { ...action, enabled: false, disabledReason: "当前没有符合条件的处置目标", eligibleTargetIds, eligibleRouteIdsByTargetId: action.code === "SWITCH_VERIFIED_ROUTE" ? eligibleRouteIdsByTargetId : {} }
    }
    return { ...action, eligibleTargetIds, eligibleRouteIdsByTargetId: action.code === "SWITCH_VERIFIED_ROUTE" ? eligibleRouteIdsByTargetId : {} }
  })
}

function numberScenario(scenario: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(scenario[key])
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback
}

function rotate<T>(items: T[], index: number): T[] {
  if (items.length === 0) return []
  const offset = index % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

function escalate(value: RuntimeEventEntity["severity"]): RuntimeEventEntity["severity"] {
  if (value === "INFO") return "WARNING"
  if (value === "WARNING") return "ERROR"
  return "CRITICAL"
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function normalizeRequestId(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length > 120) throw new BadRequestException("请求号长度不能超过 120 个字符")
  return text || null
}

async function eventResourceInputs(manager: EntityManager, project: StudentProjectEntity): Promise<{ selected: unknown[]; legacyDefaultEnabled: boolean }> {
  const scenario = project.snapshot.config.scenario
  const selection = logisticsEventSelection(scenario)
  if (selection.selected.length === 0) return selection
  const reference = project.snapshot.resourceRefs.find((item) => item.packageType === "EVENT")
  const resource = reference ? await manager.findOne(ResourcePackageEntity, { where: { id: reference.packageId } }) : null
  const content = resource?.archiveManifest?.content ?? resource?.manifest
  const resourceEvents = isRecord(content) && Array.isArray(content.events) ? content.events.filter(isRecord) : []
  const configs = new Map(selection.selected.flatMap((value) => {
    if (typeof value === "string") return [[value.trim(), { code: value.trim() }] as const]
    return isRecord(value) && typeof value.code === "string" ? [[value.code.trim(), value] as const] : []
  }))
  return { ...selection, selected: [...configs.entries()].map(([code, config]) => {
    const definition = resourceEvents.find((value) => value.code === code)
    return definition ? { ...definition, ...config } : config
  }) }
}

export function logisticsEventSelection(scenario: Record<string, unknown>): { selected: unknown[]; legacyDefaultEnabled: boolean } {
  if (Array.isArray(scenario.eventConfigs)) return { selected: scenario.eventConfigs, legacyDefaultEnabled: false }
  if (Array.isArray(scenario.eventCodes)) return { selected: scenario.eventCodes, legacyDefaultEnabled: false }
  return { selected: [], legacyDefaultEnabled: true }
}
