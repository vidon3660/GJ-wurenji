import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import {
  computeShowRuntimeProjection,
  showRuntimeActionsFor,
  showRuntimeTimeline,
  type ShowRuntimeEngineConfig,
  type ShowRuntimeEngineControl,
  type ShowRuntimeEventImpact,
  type ShowRuntimeProjection
} from "@wurenji/simulation"
import {
  resolveShowInitialConditions,
  showTemplatePolicyForAircraftCount,
  type ShowInitialConditionsConfig,
  type AuthUser,
  ShowFlightEndReportView,
  ShowRuntimeActionCode,
  ShowRuntimeAvailableActionView,
  ShowRuntimeEventCategory,
  ShowRuntimeEventLifecycleStatus,
  ShowRuntimeEventView,
  ShowRuntimeGroupView,
  ShowRuntimePhase,
  ShowRuntimeWorkspaceView,
  V3AlertSeverity,
  V3Coordinate,
  V3RuntimeAlertView,
  V3RuntimeEventView,
  V3RuntimeRestartNodeView,
  V3RuntimeSessionView,
  V3RuntimeActionReasoning,
  V3ScenarioEventRecoveryMode,
  V3ScenarioEventConfig,
  V3StudentRuntimeActionView,
  type ShowProgramManifest
} from "@wurenji/shared"
import { freezeRuntimeResourceVersions } from "@wurenji/shared"
import { resolveShowAssignmentParameters } from "../assignments/show-assignment-parameters.js"
import { randomUUID } from "node:crypto"
import { DataSource, EntityManager, Repository } from "typeorm"
import { UserEntity } from "../../entities.js"
import { ResourcePackageEntity } from "../resources/resource-package.entity.js"
import { isShowProgramManifest } from "../resources/show-program-import.js"
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
import {
  AssignmentDraftEntity,
  ProjectActivityCounterEntity,
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import {
  RuntimeAlertEntity,
  RuntimeEventEntity,
  RuntimeSessionEntity,
  StudentRuntimeActionEntity
} from "../runtime/runtime.entities.js"
import { ShowPreflightRecordEntity, ShowSimulationClockEntity } from "../show-readiness/show-readiness.entities.js"
import { ShowAreaFeatureEntity, ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { areaFeatureView, positionsFromGeometry } from "../show-project/area-plan-validation.js"
import { configuredShowEvents, escalateSeverity, showActionDeadlineSeconds, showEventDefinition, type ConfiguredShowEvent } from "./show-event-catalog.js"
import { showActionBusinessOutcome, showActionWithinDeadline } from "./show-action-outcome.js"
import { assertSameShowActionRequest, type ShowActionRequestIdentity } from "./show-action-idempotency.js"
import { ShowOperationalReportEntity, ShowRuntimeGroupSnapshotEntity } from "./show-runtime.entities.js"
import { normalizeRuntimeActionReasoning } from "../runtime/runtime-action-reasoning.js"
import { mergeRuntimeAlertPayload } from "../runtime/runtime-alert-payload.js"
import { adaptRuntimeClock } from "../runtime/runtime-adapters.js"
import { assessmentTimingForProject } from "../assessment/assessment-window.service.js"
import { fixedTickSimulationTime } from "../runtime/runtime-clock.js"
import { persistRejectedRuntimeAction } from "../runtime/runtime-action-failure.js"

interface RuntimeCheckpoint {
  schemaVersion: 1
  clockRate: number
  clockAnchorRealTime: string
  clockAnchorSimulationTimeMs: number
  durationMs: number
  totalAircraft: number
  groupCount: number
  maximumHeightMeters: number
  performanceCenter: V3Coordinate
  performanceRadiusMeters: number
  initialEnvironment?: ShowInitialConditionsConfig
  maximumConcurrentEvents?: number
  takeoffLimitCount: number | null
  earlyLandedCount: number
  groupRecoveryCounts?: Record<string, number>
  groupStatusOverrides?: Record<string, ShowRuntimeGroupView["status"]>
  recoveredAircraftIds?: string[]
  programTracks?: ShowProgramManifest["groupTracks"]
  lastSnapshotSequence: number
  lastSnapshotPhase: ShowRuntimePhase
}

interface RuntimeActionInput {
  expectedRevision?: number
  actionCode?: ShowRuntimeActionCode
  eventId?: string | null
  alertId?: string | null
  targetType?: string
  targetId?: string | null
  requestId?: string
  reasoning?: V3RuntimeActionReasoning
}

interface EndReportInput {
  expectedRevision?: number
  completionStatus?: "NORMAL" | "ABNORMAL" | "ABORTED" | null
  normalLandedCount?: number | null
  abnormalCount?: number | null
  abnormalDescription?: string
}

const systemActor: AuthUser = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "runtime@system.local",
  displayName: "系统运行引擎",
  role: "admin"
}

@Injectable()
export class ShowRuntimeService {
  constructor(
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ProjectActivityCounterEntity) private readonly counters: Repository<ProjectActivityCounterEntity>,
    @InjectRepository(RuntimeSessionEntity) private readonly sessions: Repository<RuntimeSessionEntity>,
    @InjectRepository(RuntimeEventEntity) private readonly events: Repository<RuntimeEventEntity>,
    @InjectRepository(RuntimeAlertEntity) private readonly alerts: Repository<RuntimeAlertEntity>,
    @InjectRepository(StudentRuntimeActionEntity) private readonly actions: Repository<StudentRuntimeActionEntity>,
    @InjectRepository(ShowRuntimeGroupSnapshotEntity) private readonly snapshots: Repository<ShowRuntimeGroupSnapshotEntity>,
    @InjectRepository(ShowOperationalReportEntity) private readonly reports: Repository<ShowOperationalReportEntity>,
    @InjectRepository(ShowPreflightRecordEntity) private readonly preflights: Repository<ShowPreflightRecordEntity>,
    @InjectRepository(ShowSimulationClockEntity) private readonly readinessClocks: Repository<ShowSimulationClockEntity>,
    @InjectRepository(ShowAreaPlanVersionEntity) private readonly areaVersions: Repository<ShowAreaPlanVersionEntity>,
    @InjectRepository(ShowAreaFeatureEntity) private readonly areaFeatures: Repository<ShowAreaFeatureEntity>,
    @InjectRepository(ResourcePackageEntity) private readonly packages: Repository<ResourcePackageEntity>,
    private readonly activities: ActivityLogService,
    private readonly dataSource: DataSource
  ) {}

  async workspace(projectId: string, user: AuthUser, requestedSessionId?: string): Promise<ShowRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireProjectAccess(projectId, user, manager)
      this.requireShowProject(project)
      const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "SHOW_RUNTIME" } })
      if (!stage || stage.status === "LOCKED" || stage.status === "AVAILABLE" || stage.status === "RETURNED") {
        throw new ConflictException("请先开始表演运行阶段")
      }
      const session = requestedSessionId
        ? await manager.findOne(RuntimeSessionEntity, { where: { id: requestedSessionId, projectId } })
        : await this.ensureSession(manager, project, user)
      if (!session) throw new NotFoundException("运行批次不存在")
      if (!requestedSessionId) {
        const lockedSession = await this.lockCurrentSession(manager, projectId)
        await this.syncSession(manager, project, lockedSession)
        return lockedSession.id
      }
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, !requestedSessionId)
  }

  async restart(projectId: string, user: AuthUser, expectedRevision: number, nodeCode: string): Promise<ShowRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以发起重新训练")
      this.ensureAssignmentActive(project)
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许回退或重新训练")
      const source = await this.lockCurrentSession(manager, projectId)
      if (source.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`运行版本冲突，当前版本为 ${source.revision}`)
      if (source.status === "RUNNING") throw new ConflictException("请先暂停当前运行再重新训练")
      if (!["PAUSED", "COMPLETED", "ABORTED"].includes(source.status)) throw new ConflictException("当前运行状态不能重新训练")
      const counter = await this.lockCounter(manager, projectId)
      if (counter.runtimeCount >= project.snapshot.config.allowedRuntimeAttempts) throw new ConflictException("运行次数已达到任务限制")
      const nodes = showRestartNodes(source)
      const node = nodes.find((item) => item.code === nodeCode)
      if (!node) throw new BadRequestException("重新训练节点无效或尚未到达")
      await this.reopenRuntimeStages(manager, project)
      const checkpoint = await this.buildCheckpoint(manager, project)
      checkpoint.clockAnchorSimulationTimeMs = node.simulationTimeMs
      checkpoint.lastSnapshotPhase = phaseAt(checkpoint.durationMs, node.simulationTimeMs)
      const session = await manager.save(RuntimeSessionEntity, manager.create(RuntimeSessionEntity, {
        projectId,
        status: "READY",
        mode: source.mode,
        scenarioSeed: `${project.snapshot.checksum}:attempt:${source.attemptNo + 1}`,
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
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_RUNTIME",
        actor: user,
        eventType: "RUNTIME_RESTARTED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        simulationTimeMs: node.simulationTimeMs,
        result: { attemptNo: session.attemptNo, sourceSessionId: source.id, nodeCode: node.code, nodeLabel: node.label }
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user, true)
  }

  async start(projectId: string, user: AuthUser, expectedRevision: number): Promise<ShowRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以确认开始起飞")
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "SHOW_RUNTIME")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("表演运行阶段不在可启动状态")
      const preflight = await manager.findOne(ShowPreflightRecordEntity, { where: { project: { id: projectId } } })
      if (!preflight || preflight.status !== "COMPLETED" || (preflight.decision !== "ALLOW" && preflight.decision !== "ALLOW_AFTER_RECTIFICATION")) {
        throw new ConflictException("飞前决策不是允许起飞，不能启动表演")
      }
      const readinessClock = await manager.findOne(ShowSimulationClockEntity, { where: { project: { id: projectId } } })
      if (!readinessClock?.submittedAt) throw new ConflictException("起飞前一小时申请尚未提交")
      const session = await this.ensureSession(manager, project, user)
      await manager.query('SELECT "id" FROM "runtime_sessions" WHERE "id" = $1 FOR UPDATE', [session.id])
      const locked = await manager.findOneByOrFail(RuntimeSessionEntity, { id: session.id })
      if (locked.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`运行版本冲突，当前版本为 ${locked.revision}`)
      if (locked.status !== "READY") throw new ConflictException("固定表演程序已经启动")
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
      const submitter = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const parameters = resolveShowAssignmentParameters(project.snapshot.config)
      const takeoffProjection = this.project(checkpoint, locked, [])
      const takeoffReport = manager.create(ShowOperationalReportEntity, {
        project,
        sessionId: locked.id,
        reportType: "TAKEOFF",
        status: "SUBMITTED",
        revision: 1,
        snapshot: {
          actualTakeoffAt: now.toISOString(),
          actualTakeoffCount: checkpoint.totalAircraft,
          aircraftModel: parameters.aircraftModel,
          environment: takeoffProjection.environment,
          simulationTimeMs: initialSimulationTimeMs
        },
        submittedBy: submitter,
        submittedAt: now
      })
      await manager.save(takeoffReport)
      project.lastActivityAt = now
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_RUNTIME",
        actor: user,
        eventType: "TAKEOFF_REPORTED",
        objectType: "REPORTING",
        objectId: takeoffReport.id,
        simulationTimeMs: initialSimulationTimeMs,
        result: { actualTakeoffCount: checkpoint.totalAircraft, actualTakeoffAt: now.toISOString() }
      })
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_RUNTIME",
        actor: user,
        eventType: "RUNTIME_STARTED",
        objectType: "RUNTIME_SESSION",
        objectId: locked.id,
        simulationTimeMs: initialSimulationTimeMs,
        afterRevision: locked.revision,
        result: { totalAircraft: checkpoint.totalAircraft, groupCount: checkpoint.groupCount, clockRate: checkpoint.clockRate, attemptNo: locked.attemptNo, restartNodeCode: locked.restartNodeCode }
      })
      await this.saveSnapshot(manager, locked, checkpoint, "START")
      return locked.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async applyAction(projectId: string, user: AuthUser, input: RuntimeActionInput): Promise<ShowRuntimeWorkspaceView> {
    try {
      const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以执行飞行处置")
      this.ensureAssignmentActive(project)
      const session = await this.lockCurrentSession(manager, projectId)
      const requestId = normalizeRequestId(input.requestId)
      const actionCode = normalizeActionCode(input.actionCode)
      const requestIdentity = showActionRequestIdentity(input, actionCode)
      if (requestId) {
        const previous = await this.findActionByRequestId(manager, session.id, user.id, requestId)
        if (previous) {
          assertSameShowActionRequest(previous, requestIdentity)
          return session.id
        }
      }
      if (session.revision !== normalizeRevision(input.expectedRevision)) throw new ConflictException(`运行版本冲突，当前版本为 ${session.revision}`)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能执行处置")
      const checkpoint = parseCheckpoint(session.checkpoint)
      const projectionBefore = this.project(checkpoint, session, await this.activeEventImpacts(manager, session.id))
      const actionDefinition = runtimeActions(checkpoint, session.status, projectionBefore, null).find((item) => item.code === actionCode)
      if (!actionDefinition?.enabled) throw new ConflictException(actionDefinition?.disabledReason ?? "当前规模未开放该处置")
      const targetId = requestIdentity.targetId
      if (actionDefinition.requiresTarget && !targetId) throw new BadRequestException("当前处置必须选择目标")
      if (actionDefinition.requiresTarget && actionDefinition.targetType !== "ALERT" && targetId && !actionDefinition.eligibleTargetIds.includes(targetId)) throw new ConflictException("所选目标当前不具备该处置条件")
      const reasoning = requestIdentity.reasoning
      const event = requestIdentity.eventId ? await manager.findOne(RuntimeEventEntity, { where: { id: requestIdentity.eventId, projectId, sessionId: session.id } }) : null
      const alert = requestIdentity.alertId ? await manager.findOne(RuntimeAlertEntity, { where: { id: requestIdentity.alertId, projectId, sessionId: session.id } }) : null
      if (requestIdentity.eventId && !event) throw new NotFoundException("关联运行事件不存在")
      if (requestIdentity.alertId && !alert) throw new NotFoundException("关联告警不存在")
      if (actionCode === "ACKNOWLEDGE_ALERT" && !alert) throw new BadRequestException("确认告警必须关联告警记录")
      assertShowActionContextPending(event, alert, actionCode)
      const actorEntity = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const correlationId = event?.correlationId ?? alert?.correlationId ?? randomUUID()
      const action = manager.create(StudentRuntimeActionEntity, {
        projectId,
        sessionId: session.id,
        eventId: event?.id ?? null,
        alertId: alert?.id ?? null,
        actorId: actorEntity.id,
        actionCode,
        targetType: actionDefinition.targetType,
        targetId,
        status: "APPLIED",
        simulationTimeMs: Number(session.simulationTimeMs),
        payload: { reasoning, rationale: reasoning.rationale, ...(requestId ? { _requestId: requestId } : {}) },
        result: {},
        correlationId,
        requestedAt: new Date(),
        appliedAt: new Date()
      })
      const effect = this.applyControlEffect(session, checkpoint, actionCode, targetId, projectionBefore)
      let eventControlled = false
      let responseTimeMs: number | null = null
      let actionDeadlineSeconds: number | null = null
      let withinDeadline: boolean | null = null
      if (alert && actionCode === "ACKNOWLEDGE_ALERT") {
        alert.status = "ACKNOWLEDGED"
        alert.acknowledgedAt = new Date()
        await manager.save(alert)
      }
      if (event && actionCode !== "ACKNOWLEDGE_ALERT") {
        const payload = eventPayload(event)
        payload.lifecycleStatus = "HANDLING"
        responseTimeMs = payload.detectedSimulationTimeMs === null ? null : Math.max(0, Number(session.simulationTimeMs) - payload.detectedSimulationTimeMs)
        actionDeadlineSeconds = payload.actionDeadlineSeconds
        withinDeadline = showActionWithinDeadline(payload.actionDeadlineAtSimulationTimeMs, Number(session.simulationTimeMs))
        if (payload.recommendedActions.includes(actionCode)) {
          eventControlled = true
          payload.lifecycleStatus = "CONTROLLED"
          payload.controlledSimulationTimeMs = Number(session.simulationTimeMs)
          event.status = "RESOLVED"
          event.resolvedSimulationTimeMs = Number(session.simulationTimeMs)
          event.resolvedAt = new Date()
          if (alert) {
            alert.status = "RESOLVED"
            alert.resolvedAt = new Date()
            await manager.save(alert)
          }
        }
        event.payload = mergeShowEventPayload(event, payload)
        await manager.save(event)
      }
      const projectionAfter = this.project(checkpoint, session, await this.activeEventImpacts(manager, session.id))
      const businessOutcome = showActionBusinessOutcome({ actionCode, targetId, before: projectionBefore, after: projectionAfter })
      action.result = {
        applied: true,
        eventControlled,
        effect,
        responseTimeMs,
        actionDeadlineSeconds,
        withinDeadline,
        ...businessOutcome
      }
      await manager.save(action)
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      session.revision += 1
      await manager.save(session)
      const counter = await this.lockCounter(manager, projectId)
      counter.actionCount += 1
      await manager.save(counter)
      project.lastActivityAt = new Date()
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_RUNTIME",
        actor: user,
        eventType: "RUNTIME_ACTION_APPLIED",
        objectType: "RUNTIME_ACTION",
        objectId: action.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        afterRevision: session.revision,
        payload: { actionCode, targetId, reasoning, rationale: reasoning.rationale, eventId: event?.id ?? null, alertId: alert?.id ?? null },
        result: action.result,
        correlationId
      })
      if (effect === "PROGRAM_ABORTED") await this.finishRuntime(manager, project, session, checkpoint, "ABORT")
      else if (effect === "ALL_AIRCRAFT_RECOVERED") await this.finishRuntime(manager, project, session, checkpoint, "COMPLETE")
      else await this.saveSnapshot(manager, session, checkpoint, "ACTION")
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

  async setClockRate(projectId: string, user: AuthUser, expectedRevision: number, rate: number, status?: "RUNNING" | "PAUSED"): Promise<ShowRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许调整运行速度")
      if (actor !== "STUDENT" && actor !== "TEACHER") throw new ForbiddenException("无权调整运行速度")
      const session = await this.lockCurrentSession(manager, projectId)
      if (session.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`运行版本冲突，当前版本为 ${session.revision}`)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能调整速度")
      const normalizedRate = normalizeRate(rate)
      const targetStatus = status ?? session.status
      if (targetStatus !== "RUNNING" && targetStatus !== "PAUSED") throw new BadRequestException("运行状态无效")
      const beforeRevision = session.revision
      const checkpoint = parseCheckpoint(session.checkpoint)
      checkpoint.clockAnchorSimulationTimeMs = Number(session.simulationTimeMs)
      checkpoint.clockAnchorRealTime = new Date().toISOString()
      checkpoint.clockRate = normalizedRate
      session.status = targetStatus
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      session.revision += 1
      await manager.save(session)
      project.lastActivityAt = new Date()
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_RUNTIME",
        actor: user,
        eventType: actor === "TEACHER" ? "TEACHER_RUNTIME_INTERVENTION" : "RUNTIME_CLOCK_CHANGED",
        objectType: "RUNTIME_SESSION",
        objectId: session.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        beforeRevision,
        afterRevision: session.revision,
        payload: actor === "TEACHER" ? { action: targetStatus === "PAUSED" ? "PAUSE_RUNTIME" : "RESUME_RUNTIME" } : {},
        result: { status: targetStatus, clockRate: normalizedRate }
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async triggerEvent(projectId: string, code: string, user: AuthUser, expectedRevision: number, requestIdValue?: string): Promise<ShowRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以手动触发训练事件")
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许教师临时触发事件")
      const definition = showEventDefinition(code)
      if (!definition) throw new BadRequestException("表演事件代码无效")
      const session = await this.lockCurrentSession(manager, projectId)
      const requestId = normalizeRequestId(requestIdValue)
      const previous = requestId ? await this.findEventByRequestId(manager, projectId, session.id, requestId) : null
      if (previous) {
        if (previous.code !== code) throw new ConflictException("请求标识已对应其他表演事件")
        return session.id
      }
      if (session.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`运行版本冲突，当前版本为 ${session.revision}`)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能触发事件")
      let event = await manager.findOne(RuntimeEventEntity, { where: { projectId, sessionId: session.id, code, status: "SCHEDULED" } })
      if (!event) event = this.createRuntimeEvent(manager, project, session, parseCheckpoint(session.checkpoint), { ...definition, scenarioConfig: null }, Number(session.simulationTimeMs), 0)
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
      session.revision += 1
      await manager.save(session)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_RUNTIME",
        actor: user,
        eventType: "TEACHER_RUNTIME_INTERVENTION",
        objectType: "RUNTIME_EVENT",
        objectId: event.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        afterRevision: session.revision,
        payload: { action: "TRIGGER_EVENT", code },
        correlationId: event.correlationId
      })
      await this.syncSession(manager, project, session)
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async sendTeacherHint(projectId: string, user: AuthUser, expectedRevision: number, message: string): Promise<ShowRuntimeWorkspaceView> {
    const sessionId = await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以发送训练提示")
      if (project.snapshot.mode !== "TRAINING") throw new ForbiddenException("考核模式不允许发送训练提示")
      const session = await this.lockCurrentSession(manager, projectId)
      if (session.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`运行版本冲突，当前版本为 ${session.revision}`)
      await this.syncSession(manager, project, session)
      if (session.status !== "RUNNING" && session.status !== "PAUSED") throw new ConflictException("当前运行状态不能发送训练提示")
      const hint = normalizeRequiredText(message, "训练提示不能为空", 500)
      const alert = manager.create(RuntimeAlertEntity, {
        projectId,
        sessionId: session.id,
        eventId: null,
        stageCode: "SHOW_RUNTIME",
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
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_RUNTIME",
        actor: user,
        eventType: "TEACHER_RUNTIME_INTERVENTION",
        objectType: "RUNTIME_ALERT",
        objectId: alert.id,
        simulationTimeMs: Number(session.simulationTimeMs),
        afterRevision: session.revision,
        payload: { action: "SEND_HINT", message: hint },
        correlationId: alert.correlationId
      })
      return session.id
    })
    return this.serializeWorkspace(projectId, sessionId, user)
  }

  async endReport(projectId: string, user: AuthUser): Promise<ShowFlightEndReportView> {
    const reportId = await this.dataSource.transaction(async (manager) => {
      const { project } = await this.requireProjectAccess(projectId, user, manager)
      const session = await this.currentSession(manager, projectId)
      if (!session || (session.status !== "COMPLETED" && session.status !== "ABORTED")) throw new ConflictException("固定表演程序尚未结束")
      const report = await this.ensureEndReport(manager, project, session)
      return report.id
    })
    const report = await this.reports.findOneByOrFail({ id: reportId })
    const stage = await this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_FLIGHT_END_REPORT" } })
    const actor = (await this.requireProjectAccess(projectId, user)).actor
    return serializeEndReport(report, actor === "STUDENT" && stage?.status === "IN_PROGRESS")
  }

  async saveEndReport(projectId: string, user: AuthUser, input: EndReportInput): Promise<ShowFlightEndReportView> {
    await this.writeEndReport(projectId, user, input, false)
    return this.endReport(projectId, user)
  }

  async submitEndReport(projectId: string, user: AuthUser, input: EndReportInput): Promise<ShowFlightEndReportView> {
    await this.writeEndReport(projectId, user, input, true)
    return this.endReport(projectId, user)
  }

  private async writeEndReport(projectId: string, user: AuthUser, input: EndReportInput, submit: boolean): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以填写飞行结束报备")
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "SHOW_FLIGHT_END_REPORT")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("结束报备阶段不在可编辑状态")
      const session = await this.currentSession(manager, projectId)
      if (!session || (session.status !== "COMPLETED" && session.status !== "ABORTED")) throw new ConflictException("固定表演程序尚未结束")
      const report = await this.ensureEndReport(manager, project, session)
      await manager.query('SELECT "id" FROM "show_operational_reports" WHERE "id" = $1 FOR UPDATE', [report.id])
      const locked = await manager.findOneByOrFail(ShowOperationalReportEntity, { id: report.id })
      if (locked.revision !== normalizeRevision(input.expectedRevision)) throw new ConflictException(`结束报备版本冲突，当前版本为 ${locked.revision}`)
      if (locked.status === "SUBMITTED") throw new ConflictException("飞行结束报备已经提交")
      const snapshot = normalizeEndReportSnapshot(locked.snapshot, input, session.status)
      if (submit) assertEndReportComplete(snapshot)
      const beforeRevision = locked.revision
      locked.snapshot = snapshot
      locked.revision += 1
      if (submit) {
        const now = new Date()
        locked.status = "SUBMITTED"
        locked.submittedAt = now
        locked.submittedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
        stage.status = "ACCEPTED"
        stage.submittedAt = now
        stage.acceptedAt = now
        stage.revision += 1
        await manager.save(stage)
        const next = await this.lockStage(manager, projectId, "SHOW_REVIEW")
        if (next.status === "LOCKED") {
          next.status = "AVAILABLE"
          next.revision += 1
          await manager.save(next)
        }
        project.currentStageCode = "SHOW_REVIEW"
        project.lastActivityAt = now
        await manager.save(project)
      }
      await manager.save(locked)
      if (submit) {
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId,
          stageCode: "SHOW_FLIGHT_END_REPORT",
          actor: user,
          eventType: "FLIGHT_END_REPORT_SUBMITTED",
          objectType: "REPORTING",
          objectId: locked.id,
          simulationTimeMs: Number(session.simulationTimeMs),
          beforeRevision,
          afterRevision: locked.revision,
          result: snapshot
        })
      }
    })
  }

  private async serializeWorkspace(projectId: string, sessionId: string, user: AuthUser, current = true): Promise<ShowRuntimeWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const [session, attempts, events, alerts, actions, takeoffReport, stage, programPackage] = await Promise.all([
      this.sessions.findOneByOrFail({ id: sessionId }),
      this.sessions.find({ where: { projectId }, order: { attemptNo: "DESC" } }),
      this.events.find({ where: { projectId, sessionId }, order: { scheduledSimulationTimeMs: "ASC", createdAt: "ASC" } }),
      this.alerts.find({ where: { projectId, sessionId }, order: { openedAt: "DESC" } }),
      this.actions.find({ where: { projectId, sessionId }, order: { requestedAt: "DESC" } }),
      this.reports.findOne({ where: { project: { id: projectId }, sessionId, reportType: "TAKEOFF" } }),
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_RUNTIME" } }),
      project.snapshot.config.showProgramPackageId
        ? this.packages.findOne({ where: { id: project.snapshot.config.showProgramPackageId, packageType: "SHOW_PROGRAM" } })
        : Promise.resolve(null)
    ])
    const checkpoint = parseCheckpoint(session.checkpoint)
    const impacts = eventImpacts(events)
    const projection = session.status === "READY" && session.restartSimulationTimeMs === null
      ? this.readyProjection(checkpoint)
      : this.project(checkpoint, session, impacts)
    const active = session.status === "RUNNING" || session.status === "PAUSED"
    const assessmentTiming = assessmentTimingForProject(project)
    const attemptsRemaining = Math.max(0, project.snapshot.config.allowedRuntimeAttempts - attempts.filter((item) => item.startedAt !== null).length)
    const restartNodes = current && project.snapshot.mode === "TRAINING" ? showRestartNodes(session) : []
    const availableActions = runtimeActions(checkpoint, session.status, projection, alerts).map((action) => {
      if (action.code === "ACKNOWLEDGE_ALERT" && !alerts.some((alert) => alert.status === "OPEN")) return { ...action, enabled: false, disabledReason: "当前没有待确认告警" }
      if (action.code === "PAUSE_NEXT_TAKEOFF" && projection.phase !== "BATCH_TAKEOFF") return { ...action, enabled: false, disabledReason: "仅分批起飞阶段可执行" }
      if (action.code === "RESUME_NEXT_TAKEOFF" && checkpoint.takeoffLimitCount === null) return { ...action, enabled: false, disabledReason: "后续起飞未暂停" }
      return action
    })
    return {
      projectId,
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
      phase: projection.phase,
      phaseTitle: projection.phaseTitle,
      canStart: current && actor === "STUDENT" && assessmentTiming.canWrite && stage?.status === "IN_PROGRESS" && session.status === "READY",
      canControl: current && actor === "STUDENT" && assessmentTiming.canWrite && active,
      canTeacherIntervene: current && actor === "TEACHER" && project.snapshot.mode === "TRAINING" && active,
      clockRate: checkpoint.clockRate,
      durationMs: checkpoint.durationMs,
      program: {
        packageId: project.snapshot.config.showProgramPackageId ?? null,
        name: programPackage?.name ?? "固定表演程序",
        version: programPackage?.version ?? null,
        sourceSoftware: showProgramSourceSoftware(programPackage?.manifest),
        imported: Boolean(checkpoint.programTracks?.length),
        // Keep the normalized group keyframes in the workspace contract so
        // browser replay follows the imported program instead of falling back
        // to a synthetic orbit between server snapshots.
        groupTracks: checkpoint.programTracks ?? []
      },
      remainingMs: Math.max(0, checkpoint.durationMs - Number(session.simulationTimeMs)),
      actualTakeoffAt: takeoffReport?.submittedAt?.toISOString() ?? null,
      takeoffRecord: serializeTakeoffRecord(takeoffReport),
      maximumHeightMeters: checkpoint.maximumHeightMeters,
      performanceCenter: checkpoint.performanceCenter,
      performanceRadiusMeters: checkpoint.performanceRadiusMeters,
      totals: projection.totals,
      groups: projection.groups,
      environment: projection.environment,
      events: events.map(serializeShowEvent),
      alerts: alerts.map(serializeAlert),
      actions: actions.map(serializeAction),
      availableActions
    }
  }

  private readyProjection(checkpoint: RuntimeCheckpoint) {
    return computeShowRuntimeProjection(runtimeConfig(checkpoint), 0, runtimeControl(checkpoint, []))
  }

  private project(checkpoint: RuntimeCheckpoint, session: RuntimeSessionEntity, impacts: ShowRuntimeEventImpact[]) {
    return computeShowRuntimeProjection(runtimeConfig(checkpoint), Number(session.simulationTimeMs), runtimeControl(checkpoint, impacts, session.status === "ABORTED"))
  }

  private async ensureSession(manager: EntityManager, project: StudentProjectEntity, actor: AuthUser): Promise<RuntimeSessionEntity> {
    const existing = await manager.findOne(RuntimeSessionEntity, { where: { projectId: project.id }, order: { createdAt: "DESC" } })
    if (existing) return existing
    const checkpoint = await this.buildCheckpoint(manager, project)
    const areaVersion = await manager.findOne(ShowAreaPlanVersionEntity, { where: { project: { id: project.id }, status: "ACCEPTED" }, order: { versionNo: "DESC" } })
    if (!areaVersion) throw new ConflictException("区域规划尚未通过")
    const resourceVersions = freezeRuntimeResourceVersions(project.snapshot.resourceRefs, `area:${areaVersion.id}@${areaVersion.versionNo}`)
    const session = manager.create(RuntimeSessionEntity, {
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
    })
    await manager.save(session)
    await this.activities.record(manager, {
      assignmentId: project.snapshot.draft.id,
      projectId: project.id,
      stageCode: "SHOW_RUNTIME",
      actor,
      eventType: "RUNTIME_SESSION_CREATED",
      objectType: "RUNTIME_SESSION",
      objectId: session.id,
      afterRevision: session.revision,
      result: { totalAircraft: checkpoint.totalAircraft, groupCount: checkpoint.groupCount, durationMs: checkpoint.durationMs }
    })
    return session
  }

  private async buildCheckpoint(manager: EntityManager, project: StudentProjectEntity): Promise<RuntimeCheckpoint> {
    const scaleCode = project.snapshot.config.scaleTemplateCode
    const totalAircraft = parseAircraftCount(scaleCode)
    const groupCount = Math.max(1, Math.ceil(totalAircraft / 100))
    const scenario = project.snapshot.config.scenario
    const areaVersion = await manager.findOne(ShowAreaPlanVersionEntity, { where: { project: { id: project.id }, status: "ACCEPTED" }, order: { versionNo: "DESC" } })
    if (!areaVersion) throw new ConflictException("区域规划尚未通过")
    const feature = await manager.findOne(ShowAreaFeatureEntity, { where: { version: { id: areaVersion.id }, type: "PERFORMANCE" } })
    if (!feature) throw new ConflictException("表演区数据不存在")
    const view = areaFeatureView({
      id: feature.featureKey,
      type: feature.type,
      label: feature.label,
      positions: positionsFromGeometry(feature.geometry),
      ...(feature.heightDatum && feature.minimumHeightMeters !== null && feature.maximumHeightMeters !== null
        ? { heightRange: { datum: feature.heightDatum, minimumMeters: feature.minimumHeightMeters, maximumMeters: feature.maximumHeightMeters } }
        : {}),
      properties: feature.properties
    })
    const program = await showProgramForProject(manager, project)
    const durationMs = program?.durationMs ?? runtimeDurationMs(scenario)
    const parameters = resolveShowAssignmentParameters(project.snapshot.config)
    const maximumHeightMeters = Math.min(parameters.maximumHeightMeters, view.heightRange?.maximumMeters ?? parameters.maximumHeightMeters)
    const performanceRadiusMeters = Math.max(30, Math.sqrt(view.measurement.areaSquareMeters / Math.PI))
    if (program && program.aircraftCount !== totalAircraft) throw new ConflictException("舞步程序机群规模与任务固定模板不一致")
    if (program && program.maximumAltitudeMeters > maximumHeightMeters) throw new ConflictException("舞步程序高度包络超过任务或表演区高度限制")
    if (program && program.horizontalRadiusMeters > performanceRadiusMeters) throw new ConflictException("表演区半径不足以容纳导入舞步轨迹，请调整区域规划")
    if (program && program.groupTracks.length !== groupCount) throw new ConflictException("舞步程序分组轨迹与任务机群分组不一致")
    return {
      schemaVersion: 1,
      clockRate: normalizeRate(numberScenario(scenario, "showRuntimeClockRate", numberScenario(scenario, "simulationClockRate", 60, 0.25, 3_600), 0.25, 3_600)),
      clockAnchorRealTime: new Date().toISOString(),
      clockAnchorSimulationTimeMs: 0,
      durationMs,
      totalAircraft,
      groupCount,
      maximumHeightMeters,
      performanceCenter: view.measurement.centroid,
      performanceRadiusMeters,
      initialEnvironment: resolveShowInitialConditions(scenario, totalAircraft),
      ...(program ? { programTracks: program.groupTracks } : {}),
      maximumConcurrentEvents: showTemplatePolicyForAircraftCount(totalAircraft).maximumConcurrentEvents,
      takeoffLimitCount: null,
      earlyLandedCount: 0,
      groupRecoveryCounts: {},
      groupStatusOverrides: {},
      recoveredAircraftIds: [],
      lastSnapshotSequence: 0,
      lastSnapshotPhase: "READY"
    }
  }

  private async createScheduledEvents(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity, checkpoint: RuntimeCheckpoint): Promise<void> {
    const definitions = configuredShowEvents(await eventResourceInputs(manager, project))
    if (definitions.length === 0) return
    const performance = showRuntimeTimeline(checkpoint.durationMs).find((item) => item.phase === "PERFORMANCE")!
    for (const [index, definition] of definitions.entries()) {
      const scheduled = showEventScheduleTime(session.scenarioSeed, checkpoint.durationMs, performance, definition.scenarioConfig, index, definitions.length)
      if (scheduled !== null && scheduled < Number(session.restartSimulationTimeMs ?? 0)) continue
      await manager.save(this.createRuntimeEvent(manager, project, session, checkpoint, definition, scheduled, index))
    }
  }

  private createRuntimeEvent(
    manager: EntityManager,
    project: StudentProjectEntity,
    session: RuntimeSessionEntity,
    checkpoint: RuntimeCheckpoint,
    definition: ConfiguredShowEvent,
    scheduledSimulationTimeMs: number | null,
    index: number
  ): RuntimeEventEntity {
    const impact = showEventImpact(checkpoint, definition, index)
    const detectionDelay = visibilityDelayMs(definition.scenarioConfig, definition.visibilityDelayMs)
    const escalationDelay = escalationDelayMs(definition.scenarioConfig, definition.escalationDelayMs)
    const actionDeadlineSeconds = showActionDeadlineSeconds(definition, definition.scenarioConfig?.actionDeadlineSeconds)
    return manager.create(RuntimeEventEntity, {
      projectId: project.id,
      sessionId: session.id,
      stageCode: "SHOW_RUNTIME",
      code: definition.code,
      category: definition.category,
      status: "SCHEDULED",
      severity: definition.severity,
      scheduledSimulationTimeMs,
      triggeredAt: null,
      resolvedAt: null,
      payload: {
        title: definition.title,
        detail: definition.detail,
        lifecycleStatus: "SCHEDULED",
        affectedCount: impact.affectedCount,
        affectedGroupIds: impact.affectedGroupIds,
        recommendedActions: definition.recommendedActions,
        detectionAtSimulationTimeMs: scheduledSimulationTimeMs === null ? 0 : scheduledSimulationTimeMs + detectionDelay,
        detectedSimulationTimeMs: null,
        escalationAtSimulationTimeMs: scheduledSimulationTimeMs === null || escalationDelay === null ? null : scheduledSimulationTimeMs + escalationDelay,
        autoRecoveryAtSimulationTimeMs: definition.scenarioConfig?.recoveryMode === "AUTO" && definition.scenarioConfig.durationSeconds !== null
          ? scheduledSimulationTimeMs === null ? null : scheduledSimulationTimeMs + definition.scenarioConfig.durationSeconds * 1_000
          : null,
        recoveryMode: definition.scenarioConfig?.recoveryMode ?? "STUDENT",
        recoveryCondition: definition.scenarioConfig?.recoveryCondition ?? null,
        scenarioConfig: definition.scenarioConfig,
        visibilityMode: definition.scenarioConfig?.visibilityMode ?? "AFTER_STATE_CHANGE",
        actionDeadlineSeconds,
        actionDeadlineAtSimulationTimeMs: null,
        followUpEventCode: definition.scenarioConfig?.followUpEventCode ?? null,
        controlledSimulationTimeMs: null,
        escalationCount: 0
      },
      correlationId: randomUUID()
    })
  }

  private async syncSession(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity): Promise<void> {
    if (session.status === "READY" || session.status === "COMPLETED" || session.status === "ABORTED" || session.status === "FAILED") return
    const checkpoint = parseCheckpoint(session.checkpoint)
    const beforeTime = Number(session.simulationTimeMs)
    if (session.status === "RUNNING") {
      session.simulationTimeMs = fixedTickSimulationTime({ simulationTimeMs: checkpoint.clockAnchorSimulationTimeMs, realTimeMs: Date.parse(checkpoint.clockAnchorRealTime), rate: checkpoint.clockRate }, Date.now(), checkpoint.durationMs)
    }
    const currentTime = Number(session.simulationTimeMs)
    let semanticChange = false
    const events = await manager.find(RuntimeEventEntity, { where: { projectId: project.id, sessionId: session.id }, order: { scheduledSimulationTimeMs: "ASC" } })
    let activeEventCount = events.filter((event) => event.status === "ACTIVE").length
    for (const event of events) {
      const payload = eventPayload(event)
      if (event.status === "SCHEDULED" && event.scheduledSimulationTimeMs === null && payload.scenarioConfig && triggerSatisfied(payload.scenarioConfig, {
        currentSimulationTimeMs: currentTime,
        phase: showRuntimeTimeline(checkpoint.durationMs).filter((item) => item.startMs <= currentTime).at(-1)?.phase,
        phaseOrder: showRuntimeTimeline(checkpoint.durationMs).map((item) => item.phase),
        eventStatuses: Object.fromEntries(events.map((item) => [item.code, item.status])),
        values: { airborneAircraft: Math.max(0, checkpoint.totalAircraft - checkpoint.earlyLandedCount) }
      })) {
        const scheduled = currentTime
        event.scheduledSimulationTimeMs = scheduled
        payload.detectionAtSimulationTimeMs = scheduled + visibilityDelayMs(payload.scenarioConfig, 0)
        const escalationDelay = escalationDelayMs(payload.scenarioConfig, 0)
        payload.escalationAtSimulationTimeMs = escalationDelay === null ? null : scheduled + escalationDelay
        payload.autoRecoveryAtSimulationTimeMs = payload.scenarioConfig.recoveryMode === "AUTO" && payload.scenarioConfig.durationSeconds !== null
          ? scheduled + payload.scenarioConfig.durationSeconds * 1_000
          : null
        event.payload = mergeShowEventPayload(event, payload)
        await manager.save(event)
        semanticChange = true
      }
      if (event.status === "SCHEDULED" && event.scheduledSimulationTimeMs !== null && Number(event.scheduledSimulationTimeMs) <= currentTime && canActivateScenarioEvent(activeEventCount, maximumConcurrentEvents(checkpoint))) {
        event.status = "ACTIVE"
        event.triggeredSimulationTimeMs = currentTime
        event.triggeredAt = new Date()
        payload.lifecycleStatus = "OCCURRED_UNDETECTED"
        event.payload = mergeShowEventPayload(event, payload)
        await manager.save(event)
        activeEventCount = scenarioEventActiveCountAfterTransition(activeEventCount, "SCHEDULED", "ACTIVE")
        semanticChange = true
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId: project.id,
          stageCode: "SHOW_RUNTIME",
          actor: systemActor,
          eventType: "RUNTIME_EVENT_TRIGGERED",
          objectType: "RUNTIME_EVENT",
          objectId: event.id,
          simulationTimeMs: Number(event.scheduledSimulationTimeMs),
          payload: {
            code: event.code,
            category: event.category,
            title: payload.title,
            detail: payload.detail,
            severity: event.severity,
            affectedCount: payload.affectedCount,
            affectedGroupIds: payload.affectedGroupIds
          },
          correlationId: event.correlationId
        })
      }
      if (event.status === "ACTIVE" && payload.detectedSimulationTimeMs === null && currentTime >= payload.detectionAtSimulationTimeMs) {
        payload.lifecycleStatus = "DISCOVERED"
        payload.detectedSimulationTimeMs = currentTime
        payload.actionDeadlineAtSimulationTimeMs = payload.actionDeadlineSeconds === null
          ? null
          : currentTime + payload.actionDeadlineSeconds * 1_000
        event.payload = mergeShowEventPayload(event, payload)
        await manager.save(event)
        const existingAlert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id } })
        if (!existingAlert) {
          const alert = manager.create(RuntimeAlertEntity, {
            projectId: project.id,
            sessionId: session.id,
            eventId: event.id,
            stageCode: "SHOW_RUNTIME",
            code: event.code,
            title: payload.title,
            detail: payload.detail,
            severity: event.severity,
            status: "OPEN",
            simulationTimeMs: currentTime,
            openedAt: new Date(),
            acknowledgedAt: null,
            resolvedAt: null,
            payload: mergeRuntimeAlertPayload(payload as unknown as Record<string, unknown>, { affectedCount: payload.affectedCount, affectedGroupIds: payload.affectedGroupIds }),
            correlationId: event.correlationId
          })
          await manager.save(alert)
          await this.activities.record(manager, {
            assignmentId: project.snapshot.draft.id,
            projectId: project.id,
            stageCode: "SHOW_RUNTIME",
            actor: systemActor,
            eventType: "RUNTIME_EVENT_DISCOVERED",
            objectType: "RUNTIME_ALERT",
            objectId: alert.id,
            simulationTimeMs: currentTime,
            payload: { title: alert.title, detail: alert.detail, affectedCount: payload.affectedCount, affectedGroupIds: payload.affectedGroupIds },
            result: { eventId: event.id, severity: event.severity },
            correlationId: event.correlationId
          })
        }
        semanticChange = true
      }
      if (event.status === "ACTIVE" && payload.escalationCount === 0 && payload.escalationAtSimulationTimeMs !== null && currentTime >= payload.escalationAtSimulationTimeMs) {
        event.severity = escalateSeverity(event.severity)
        payload.lifecycleStatus = "ESCALATED"
        payload.escalationCount = 1
        payload.affectedCount = Math.min(checkpoint.totalAircraft, Math.max(payload.affectedCount + 1, payload.affectedCount * 2))
        event.payload = mergeShowEventPayload(event, payload)
        await manager.save(event)
        const alert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id } })
        if (alert && alert.status !== "RESOLVED") {
          alert.severity = event.severity
          alert.detail = `${payload.detail} 事件持续未控制，影响范围正在扩大。`
          alert.payload = mergeRuntimeAlertPayload(payload as unknown as Record<string, unknown>, { ...alert.payload, affectedCount: payload.affectedCount, escalated: true })
          await manager.save(alert)
        }
        semanticChange = true
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId: project.id,
          stageCode: "SHOW_RUNTIME",
          actor: systemActor,
          eventType: "RUNTIME_EVENT_ESCALATED",
          objectType: "RUNTIME_EVENT",
          objectId: event.id,
          simulationTimeMs: currentTime,
          result: { severity: event.severity, affectedCount: payload.affectedCount },
          correlationId: event.correlationId
        })
      }
      const recoveryContext = {
        currentSimulationTimeMs: currentTime,
        phase: showRuntimeTimeline(checkpoint.durationMs).filter((item) => item.startMs <= currentTime).at(-1)?.phase,
        phaseOrder: showRuntimeTimeline(checkpoint.durationMs).map((item) => item.phase),
        eventStatuses: Object.fromEntries(events.map((item) => [item.code, item.status])),
        values: { airborneAircraft: Math.max(0, checkpoint.totalAircraft - checkpoint.earlyLandedCount) }
      }
      if (event.status === "ACTIVE" && ((payload.autoRecoveryAtSimulationTimeMs !== null && currentTime >= payload.autoRecoveryAtSimulationTimeMs) || recoverySatisfied(payload.scenarioConfig, recoveryContext))) {
        payload.lifecycleStatus = "CONTROLLED"
        payload.controlledSimulationTimeMs = currentTime
        event.status = "RESOLVED"
        event.resolvedSimulationTimeMs = currentTime
        event.resolvedAt = new Date()
        event.payload = mergeShowEventPayload(event, payload)
        await manager.save(event)
        activeEventCount = scenarioEventActiveCountAfterTransition(activeEventCount, "ACTIVE", "RESOLVED")
        const alert = await manager.findOne(RuntimeAlertEntity, { where: { eventId: event.id } })
        if (alert && alert.status !== "RESOLVED") {
          alert.status = "RESOLVED"
          alert.resolvedAt = new Date()
          await manager.save(alert)
        }
        semanticChange = true
        await this.activities.record(manager, {
          assignmentId: project.snapshot.draft.id,
          projectId: project.id,
          stageCode: "SHOW_RUNTIME",
          actor: systemActor,
          eventType: "RUNTIME_EVENT_RESOLVED",
          objectType: "RUNTIME_EVENT",
          objectId: event.id,
          simulationTimeMs: currentTime,
          result: { recoveryMode: "AUTO" },
          correlationId: event.correlationId
        })
      }
    }
    const impacts = await this.activeEventImpacts(manager, session.id)
    const projection = this.project(checkpoint, session, impacts)
    if (projection.phase !== checkpoint.lastSnapshotPhase) {
      checkpoint.lastSnapshotPhase = projection.phase
      session.checkpoint = checkpoint as unknown as Record<string, unknown>
      semanticChange = true
      await this.saveSnapshot(manager, session, checkpoint, "PHASE", projection.groups)
    }
    if (currentTime >= checkpoint.durationMs) {
      await this.finishRuntime(manager, project, session, checkpoint, "COMPLETE")
      return
    }
    if (semanticChange) session.revision += 1
    if (currentTime !== beforeTime || semanticChange) await manager.save(session)
  }

  private applyControlEffect(
    session: RuntimeSessionEntity,
    checkpoint: RuntimeCheckpoint,
    actionCode: ShowRuntimeActionCode,
    targetId: string | null,
    projection: ShowRuntimeProjection
  ): string {
    if (actionCode === "PAUSE_PROGRAM") {
      checkpoint.clockAnchorSimulationTimeMs = Number(session.simulationTimeMs)
      checkpoint.clockAnchorRealTime = new Date().toISOString()
      session.status = "PAUSED"
      return "PROGRAM_PAUSED"
    }
    if (actionCode === "RESUME_PROGRAM") {
      checkpoint.clockAnchorSimulationTimeMs = Number(session.simulationTimeMs)
      checkpoint.clockAnchorRealTime = new Date().toISOString()
      session.status = "RUNNING"
      return "PROGRAM_RESUMED"
    }
    if (actionCode === "PAUSE_NEXT_TAKEOFF") {
      checkpoint.takeoffLimitCount = projection.totals.takeoffCount
      return "NEXT_TAKEOFF_PAUSED"
    }
    if (actionCode === "RESUME_NEXT_TAKEOFF") {
      checkpoint.takeoffLimitCount = null
      return "NEXT_TAKEOFF_RESUMED"
    }
    if (actionCode === "ABORT_PROGRAM") {
      session.status = "ABORTED"
      session.endedAt = new Date()
      checkpoint.clockAnchorSimulationTimeMs = Number(session.simulationTimeMs)
      checkpoint.clockAnchorRealTime = new Date().toISOString()
      return "PROGRAM_ABORTED"
    }
    const recoveryCounts = checkpoint.groupRecoveryCounts ?? {}
    const statusOverrides = checkpoint.groupStatusOverrides ?? {}
    const recoveredAircraftIds = new Set(checkpoint.recoveredAircraftIds ?? [])
    const group = targetId ? projection.groups.find((item) => item.groupId === targetGroupId(targetId)) : null
    let landedDelta = 0
    if ((actionCode === "SINGLE_LAND" || actionCode === "REMOVE_FROM_MISSION") && targetId && group) {
      if (recoveredAircraftIds.has(targetId)) throw new ConflictException("所选无人机已退出当前表演任务")
      recoveredAircraftIds.add(targetId)
      landedDelta = Math.min(1, group.airborneCount)
      recoveryCounts[group.groupId] = Math.min(group.plannedCount, (recoveryCounts[group.groupId] ?? group.landedCount) + landedDelta)
    } else if (actionCode === "BATCH_LAND" && group) {
      landedDelta = Math.min(group.airborneCount, Math.max(2, Math.ceil(checkpoint.totalAircraft * 0.02)))
      recoveryCounts[group.groupId] = Math.min(group.plannedCount, (recoveryCounts[group.groupId] ?? group.landedCount) + landedDelta)
      statusOverrides[group.groupId] = recoveryCounts[group.groupId]! >= group.plannedCount ? "LANDED" : "LANDING"
    } else if ((actionCode === "GROUP_RETURN" || actionCode === "SWITCH_EMERGENCY_ZONE") && group) {
      statusOverrides[group.groupId] = actionCode === "GROUP_RETURN" ? "RETURNING" : "LANDING"
      checkpoint.takeoffLimitCount = projection.totals.takeoffCount
    } else if (actionCode === "GROUP_LAND" && group) {
      landedDelta = group.airborneCount
      recoveryCounts[group.groupId] = group.landedCount + group.airborneCount
      statusOverrides[group.groupId] = "LANDED"
    } else if (actionCode === "MULTI_GROUP_RETURN" || actionCode === "ZONE_LAND") {
      for (const groupId of targetGroupIds(targetId)) {
        const targetGroup = projection.groups.find((item) => item.groupId === groupId)
        if (!targetGroup) continue
        if (actionCode === "MULTI_GROUP_RETURN") {
          statusOverrides[groupId] = "RETURNING"
        } else {
          landedDelta += targetGroup.airborneCount
          recoveryCounts[groupId] = targetGroup.landedCount + targetGroup.airborneCount
          statusOverrides[groupId] = "LANDED"
        }
      }
      checkpoint.takeoffLimitCount = projection.totals.takeoffCount
    } else if (actionCode === "RETURN_ALL") {
      for (const targetGroup of projection.groups.filter((item) => item.airborneCount > 0)) statusOverrides[targetGroup.groupId] = "RETURNING"
      checkpoint.takeoffLimitCount = projection.totals.takeoffCount
    } else if (actionCode === "EMERGENCY_LAND_ALL") {
      for (const targetGroup of projection.groups) {
        landedDelta += targetGroup.airborneCount
        recoveryCounts[targetGroup.groupId] = targetGroup.landedCount + targetGroup.airborneCount
        statusOverrides[targetGroup.groupId] = "LANDED"
      }
      checkpoint.takeoffLimitCount = projection.totals.takeoffCount
    }
    checkpoint.groupRecoveryCounts = recoveryCounts
    checkpoint.groupStatusOverrides = statusOverrides
    checkpoint.recoveredAircraftIds = [...recoveredAircraftIds]
    checkpoint.earlyLandedCount = Math.max(checkpoint.earlyLandedCount, Object.values(recoveryCounts).reduce((sum, value) => sum + value, 0))
    if (actionCode === "RETURN_ALL") return "ALL_AIRCRAFT_RETURNING"
    if (actionCode === "EMERGENCY_LAND_ALL") return "ALL_AIRCRAFT_RECOVERED"
    if (actionCode === "GROUP_RETURN" || actionCode === "MULTI_GROUP_RETURN") return `RETURNING_${targetId ?? "ALL"}`
    return landedDelta > 0 ? `RECOVERED_${landedDelta}${targetId ? `_${targetId}` : ""}` : "MONITORING_CONTINUED"
  }

  private async finishRuntime(
    manager: EntityManager,
    project: StudentProjectEntity,
    session: RuntimeSessionEntity,
    checkpoint: RuntimeCheckpoint,
    reason: "COMPLETE" | "ABORT"
  ): Promise<void> {
    const now = new Date()
    if (reason === "COMPLETE") {
      session.status = "COMPLETED"
      session.simulationTimeMs = Math.min(checkpoint.durationMs, Math.max(Number(session.simulationTimeMs), checkpoint.durationMs))
    } else {
      session.status = "ABORTED"
    }
    session.endedAt = now
    checkpoint.clockAnchorSimulationTimeMs = Number(session.simulationTimeMs)
    checkpoint.clockAnchorRealTime = now.toISOString()
    session.checkpoint = checkpoint as unknown as Record<string, unknown>
    session.revision += 1
    await manager.save(session)
    const activeEvents = await manager.find(RuntimeEventEntity, { where: { projectId: project.id, sessionId: session.id, status: "ACTIVE" } })
    for (const event of activeEvents) {
      const payload = eventPayload(event)
      payload.lifecycleStatus = "ENDED"
      event.status = "RESOLVED"
      event.resolvedSimulationTimeMs = Number(session.simulationTimeMs)
      event.resolvedAt = now
      event.payload = mergeShowEventPayload(event, payload)
      await manager.save(event)
    }
    const activeAlerts = await manager.find(RuntimeAlertEntity, { where: { projectId: project.id, sessionId: session.id } })
    for (const alert of activeAlerts.filter((item) => item.status !== "RESOLVED")) {
      alert.status = "RESOLVED"
      alert.resolvedAt = now
      await manager.save(alert)
    }
    const runtimeStage = await this.lockStage(manager, project.id, "SHOW_RUNTIME")
    if (runtimeStage.status === "IN_PROGRESS") {
      runtimeStage.status = "ACCEPTED"
      runtimeStage.submittedAt = now
      runtimeStage.acceptedAt = now
      runtimeStage.revision += 1
      await manager.save(runtimeStage)
    }
    const next = await this.lockStage(manager, project.id, "SHOW_FLIGHT_END_REPORT")
    if (next.status === "LOCKED") {
      next.status = "AVAILABLE"
      next.revision += 1
      await manager.save(next)
    }
    project.currentStageCode = "SHOW_FLIGHT_END_REPORT"
    project.lastActivityAt = now
    await manager.save(project)
    await this.saveSnapshot(manager, session, checkpoint, reason === "ABORT" ? "ABORT" : "COMPLETE")
    await this.ensureEndReport(manager, project, session)
    await this.activities.record(manager, {
      assignmentId: project.snapshot.draft.id,
      projectId: project.id,
      stageCode: "SHOW_RUNTIME",
      actor: systemActor,
      eventType: reason === "ABORT" ? "RUNTIME_ABORTED" : "RUNTIME_COMPLETED",
      objectType: "RUNTIME_SESSION",
      objectId: session.id,
      simulationTimeMs: Number(session.simulationTimeMs),
      afterRevision: session.revision,
      result: { status: session.status, endedAt: now.toISOString() }
    })
  }

  private async saveSnapshot(
    manager: EntityManager,
    session: RuntimeSessionEntity,
    checkpoint: RuntimeCheckpoint,
    reason: ShowRuntimeGroupSnapshotEntity["reason"],
    knownGroups?: ShowRuntimeGroupView[]
  ): Promise<void> {
    const impacts = await this.activeEventImpacts(manager, session.id)
    const projection = this.project(checkpoint, session, impacts)
    const rows = await manager.query<{ maxSequence: string | number | null }[]>(
      'SELECT COALESCE(MAX("sequence"), 0) AS "maxSequence" FROM "show_runtime_group_snapshots" WHERE "sessionId" = $1',
      [session.id]
    )
    checkpoint.lastSnapshotSequence = nextShowSnapshotSequence(checkpoint.lastSnapshotSequence, rows[0]?.maxSequence)
    checkpoint.lastSnapshotPhase = projection.phase
    session.checkpoint = checkpoint as unknown as Record<string, unknown>
    await manager.save(session)
    await manager.save(ShowRuntimeGroupSnapshotEntity, manager.create(ShowRuntimeGroupSnapshotEntity, {
      projectId: session.projectId,
      sessionId: session.id,
      sequence: checkpoint.lastSnapshotSequence,
      simulationTimeMs: Number(session.simulationTimeMs),
      phase: projection.phase,
      reason,
      checkpoint: structuredClone(checkpoint) as unknown as Record<string, unknown>,
      totals: projection.totals,
      groups: knownGroups ?? projection.groups
    }))
  }

  private async activeEventImpacts(manager: EntityManager, sessionId: string): Promise<ShowRuntimeEventImpact[]> {
    const active = await manager.find(RuntimeEventEntity, { where: { sessionId, status: "ACTIVE" } })
    return eventImpacts(active)
  }

  private async ensureEndReport(manager: EntityManager, project: StudentProjectEntity, session: RuntimeSessionEntity): Promise<ShowOperationalReportEntity> {
    const existing = await manager.findOne(ShowOperationalReportEntity, { where: { project: { id: project.id }, sessionId: session.id, reportType: "FLIGHT_END" } })
    if (existing) return existing
    const checkpoint = parseCheckpoint(session.checkpoint)
    const projection = this.project(checkpoint, session, await this.activeEventImpacts(manager, session.id))
    const takeoff = await manager.findOne(ShowOperationalReportEntity, { where: { project: { id: project.id }, sessionId: session.id, reportType: "TAKEOFF" } })
    const suggestedAbnormalCount = projection.totals.abnormalCount + projection.totals.lostCount
    const authoritativeNormalLandedCount = Math.max(0, projection.totals.takeoffCount - suggestedAbnormalCount)
    const report = manager.create(ShowOperationalReportEntity, {
      project,
      sessionId: session.id,
      reportType: "FLIGHT_END",
      status: "DRAFT",
      revision: 1,
      snapshot: {
        actualTakeoffAt: takeoff?.submittedAt?.toISOString() ?? session.startedAt?.toISOString() ?? null,
        landingCompletedAt: session.endedAt?.toISOString() ?? null,
        plannedCount: checkpoint.totalAircraft,
        actualTakeoffCount: projection.totals.takeoffCount,
        suggestedNormalLandedCount: authoritativeNormalLandedCount,
        suggestedAbnormalCount,
        authoritativeNormalLandedCount,
        authoritativeAbnormalCount: suggestedAbnormalCount,
        completionStatus: null,
        normalLandedCount: null,
        abnormalCount: null,
        abnormalDescription: "",
        runtimeStatus: session.status
      },
      submittedBy: null,
      submittedAt: null
    })
    return manager.save(report)
  }

  private async lockCounter(manager: EntityManager, projectId: string): Promise<ProjectActivityCounterEntity> {
    await manager.query('SELECT "id" FROM "project_activity_counters" WHERE "projectId" = $1 FOR UPDATE', [projectId])
    const counter = await manager.findOne(ProjectActivityCounterEntity, { where: { project: { id: projectId } } })
    if (!counter) throw new ConflictException("项目计数器不存在")
    return counter
  }

  private async lockCurrentSession(manager: EntityManager, projectId: string): Promise<RuntimeSessionEntity> {
    const latest = await manager.findOne(RuntimeSessionEntity, { where: { projectId }, order: { attemptNo: "DESC" } })
    if (!latest) throw new ConflictException("表演运行会话尚未初始化")
    await manager.query('SELECT "id" FROM "runtime_sessions" WHERE "id" = $1 FOR UPDATE', [latest.id])
    return manager.findOneByOrFail(RuntimeSessionEntity, { id: latest.id })
  }

  private async findActionByRequestId(manager: EntityManager, sessionId: string, actorId: string, requestId: string): Promise<StudentRuntimeActionEntity | null> {
    return manager.createQueryBuilder(StudentRuntimeActionEntity, "action")
      .where("action.sessionId = :sessionId", { sessionId })
      .andWhere("action.actorId = :actorId", { actorId })
      .andWhere("action.payload ->> '_requestId' = :requestId", { requestId })
      .setLock("pessimistic_write")
      .getOne()
  }

  private async findEventByRequestId(manager: EntityManager, projectId: string, sessionId: string, requestId: string): Promise<RuntimeEventEntity | null> {
    return manager.createQueryBuilder(RuntimeEventEntity, "event")
      .where("event.projectId = :projectId", { projectId })
      .andWhere("event.sessionId = :sessionId", { sessionId })
      .andWhere("event.payload ->> '_manualTriggerRequestId' = :requestId", { requestId })
      .setLock("pessimistic_write")
      .getOne()
  }

  private currentSession(manager: EntityManager, projectId: string): Promise<RuntimeSessionEntity | null> {
    return manager.findOne(RuntimeSessionEntity, { where: { projectId }, order: { attemptNo: "DESC" } })
  }

  private async reopenRuntimeStages(manager: EntityManager, project: StudentProjectEntity): Promise<void> {
    const runtime = await this.lockStage(manager, project.id, "SHOW_RUNTIME")
    const endReport = await this.lockStage(manager, project.id, "SHOW_FLIGHT_END_REPORT")
    const review = await this.lockStage(manager, project.id, "SHOW_REVIEW")
    if (endReport.status === "SUBMITTED" || endReport.status === "ACCEPTED" || review.status !== "LOCKED") {
      throw new ConflictException("结束报备或复盘已提交，不能重新训练")
    }
    runtime.status = "IN_PROGRESS"
    runtime.submittedAt = null
    runtime.acceptedAt = null
    runtime.returnedAt = null
    runtime.revision += 1
    endReport.status = "LOCKED"
    endReport.submittedAt = null
    endReport.acceptedAt = null
    endReport.returnedAt = null
    endReport.revision += 1
    project.currentStageCode = "SHOW_RUNTIME"
    project.lastActivityAt = new Date()
    await manager.save([runtime, endReport, project])
  }

  private async lockStage(manager: EntityManager, projectId: string, stageCode: "SHOW_RUNTIME" | "SHOW_FLIGHT_END_REPORT" | "SHOW_REVIEW") {
    await manager.query('SELECT "id" FROM "student_project_stages" WHERE "projectId" = $1 AND "stageCode" = $2 FOR UPDATE', [projectId, stageCode])
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode } })
    if (!stage) throw new NotFoundException("项目阶段不存在")
    return stage
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager) {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权查看该学生项目")
      return { project, actor: "STUDENT" as const }
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" as const }
    throw new ForbiddenException("无权查看该学生项目")
  }

  private requireShowProject(project: StudentProjectEntity): void {
    if (project.snapshot.sceneType !== "CITY_SHOW") throw new BadRequestException("当前项目不是编队表演场景")
  }

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    if (project.snapshot.draft.status === "ENDED" || project.snapshot.draft.status === "ARCHIVED") throw new ConflictException("任务已结束或归档")
  }
}

export function nextShowSnapshotSequence(checkpointSequence: number, databaseSequence: string | number | null | undefined): number {
  const checkpointValue = Number.isFinite(Number(checkpointSequence)) ? Math.max(0, Number(checkpointSequence)) : 0
  const databaseValue = Number.isFinite(Number(databaseSequence)) ? Math.max(0, Number(databaseSequence)) : 0
  return Math.max(checkpointValue, databaseValue) + 1
}

function serializeTakeoffRecord(report: ShowOperationalReportEntity | null) {
  if (!report?.submittedAt) return null
  const snapshot = report.snapshot ?? {}
  return {
    id: report.id,
    confirmedBy: report.submittedBy ? { id: report.submittedBy.id, displayName: report.submittedBy.displayName } : null,
    confirmedAt: report.submittedAt.toISOString(),
    simulationTimeMs: Math.max(0, Number(snapshot.simulationTimeMs ?? 0)),
    actualTakeoffCount: Math.max(0, Number(snapshot.actualTakeoffCount ?? 0)),
    aircraftModel: String(snapshot.aircraftModel ?? ""),
    environment: isShowRuntimeEnvironment(snapshot.environment) ? snapshot.environment : null
  }
}

async function showProgramForProject(manager: EntityManager, project: StudentProjectEntity): Promise<ShowProgramManifest | null> {
  const packageId = project.snapshot.config.showProgramPackageId?.trim()
  if (!packageId) return null
  const resource = await manager.findOne(ResourcePackageEntity, { where: { id: packageId, packageType: "SHOW_PROGRAM" } })
  const reference = project.snapshot.resourceRefs.find((item) => item.packageType === "SHOW_PROGRAM" && item.packageId === packageId)
  if (!resource || !reference || resource.sha256 !== reference.sha256 || resource.version !== reference.version || !isShowProgramManifest(resource.manifest)) {
    throw new ConflictException("任务冻结的舞步程序不可读取或完整性校验失败")
  }
  return resource.manifest
}

function showProgramSourceSoftware(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const source = (value as Record<string, unknown>).sourceSoftware
  return typeof source === "string" && source.trim() ? source : null
}

function isShowRuntimeEnvironment(value: unknown): value is ShowRuntimeWorkspaceView["environment"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return ["windDirection", "windState", "gustState", "rainState", "positioningQuality", "electromagneticState", "communicationQuality", "equipmentState", "geofenceState"]
    .every((key) => typeof record[key] === "string")
}

function runtimeConfig(checkpoint: RuntimeCheckpoint): ShowRuntimeEngineConfig {
  return {
    totalAircraft: checkpoint.totalAircraft,
    groupCount: checkpoint.groupCount,
    durationMs: checkpoint.durationMs,
    maximumHeightMeters: checkpoint.maximumHeightMeters,
    performanceCenter: checkpoint.performanceCenter,
    performanceRadiusMeters: checkpoint.performanceRadiusMeters,
    ...(checkpoint.programTracks ? { programTracks: checkpoint.programTracks } : {}),
    ...(checkpoint.initialEnvironment ? { initialEnvironment: checkpoint.initialEnvironment } : {})
  }
}

function runtimeControl(checkpoint: RuntimeCheckpoint, eventImpactsValue: ShowRuntimeEventImpact[], aborted = false): ShowRuntimeEngineControl {
  return {
    aborted,
    earlyLandedCount: checkpoint.earlyLandedCount,
    takeoffLimitCount: checkpoint.takeoffLimitCount,
    eventImpacts: eventImpactsValue,
    groupRecoveryCounts: checkpoint.groupRecoveryCounts ?? {},
    groupStatusOverrides: checkpoint.groupStatusOverrides ?? {}
  }
}

function runtimeActions(
  checkpoint: RuntimeCheckpoint,
  sessionStatus: string,
  projection: ShowRuntimeProjection,
  alerts: RuntimeAlertEntity[] | null
): ShowRuntimeAvailableActionView[] {
  const openAlertIds = alerts?.filter((alert) => alert.status === "OPEN").map((alert) => alert.id) ?? []
  return showRuntimeActionsFor(checkpoint.totalAircraft, sessionStatus).map((action) => {
    const eligibleTargetIds = showActionTargetIds(action, projection, checkpoint, openAlertIds)
    let enabled = action.enabled
    let disabledReason = action.disabledReason
    if (action.code === "ACKNOWLEDGE_ALERT" && alerts && eligibleTargetIds.length === 0) {
      enabled = false
      disabledReason = "当前没有待确认告警"
    } else if (action.code === "PAUSE_NEXT_TAKEOFF" && projection.phase !== "BATCH_TAKEOFF") {
      enabled = false
      disabledReason = "仅分批起飞阶段可执行"
    } else if (action.code === "PAUSE_NEXT_TAKEOFF" && checkpoint.takeoffLimitCount !== null) {
      enabled = false
      disabledReason = "后续起飞已暂停"
    } else if (action.code === "RESUME_NEXT_TAKEOFF" && checkpoint.takeoffLimitCount === null) {
      enabled = false
      disabledReason = "后续起飞未暂停"
    } else if (["SINGLE_LAND", "REMOVE_FROM_MISSION", "BATCH_LAND", "GROUP_RETURN", "GROUP_LAND", "SWITCH_EMERGENCY_ZONE", "MULTI_GROUP_RETURN", "ZONE_LAND", "RETURN_ALL", "EMERGENCY_LAND_ALL"].includes(action.code) && projection.totals.airborneCount === 0) {
      enabled = false
      disabledReason = "当前没有可处置的空中无人机"
    } else if (action.requiresTarget && action.targetType !== "ALERT" && eligibleTargetIds.length === 0) {
      enabled = false
      disabledReason = "当前没有符合条件的处置目标"
    }
    return { ...action, enabled, disabledReason, eligibleTargetIds }
  })
}

function showActionTargetIds(
  action: ShowRuntimeAvailableActionView,
  projection: ShowRuntimeProjection,
  checkpoint: RuntimeCheckpoint,
  openAlertIds: string[]
): string[] {
  if (action.targetType === "ALERT") return openAlertIds
  const activeGroups = projection.groups.filter((group) => group.airborneCount > 0 && group.status !== "LANDING" && group.status !== "LANDED")
  if (action.targetType === "AIRCRAFT") {
    const recovered = new Set(checkpoint.recoveredAircraftIds ?? [])
    return activeGroups.flatMap((group) => {
      const candidates: string[] = []
      for (let ordinal = 1; ordinal <= group.plannedCount && candidates.length < Math.min(10, group.airborneCount); ordinal += 1) {
        const id = `${group.groupId}-A${String(ordinal).padStart(3, "0")}`
        if (!recovered.has(id)) candidates.push(id)
      }
      return candidates
    })
  }
  if (action.targetType === "BATCH") return activeGroups.filter((group) => group.airborneCount >= 2).map((group) => `BATCH-${group.groupId}`)
  if (action.targetType === "GROUP") return activeGroups.map((group) => group.groupId)
  if (action.targetType === "MULTI_GROUP") {
    return activeGroups.slice(0, -1).map((group, index) => `${group.groupId}+${activeGroups[index + 1]!.groupId}`)
  }
  return []
}

function targetGroupId(targetId: string): string | null {
  return targetId.match(/G\d{2,3}/)?.[0] ?? null
}

function targetGroupIds(targetId: string | null): string[] {
  return targetId?.match(/G\d{2,3}/g) ?? []
}

function eventImpacts(events: RuntimeEventEntity[]): ShowRuntimeEventImpact[] {
  return events.filter((event) => event.status === "ACTIVE").map((event) => {
    const payload = eventPayload(event)
    return {
      category: event.category as ShowRuntimeEventCategory,
      severity: event.severity,
      affectedCount: payload.affectedCount,
      affectedGroupIds: payload.affectedGroupIds
    }
  })
}

interface NormalizedEventPayload {
  title: string
  detail: string
  lifecycleStatus: ShowRuntimeEventLifecycleStatus
  affectedCount: number
  affectedGroupIds: string[]
  recommendedActions: ShowRuntimeActionCode[]
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

function eventPayload(event: RuntimeEventEntity): NormalizedEventPayload {
  const payload = event.payload
  return {
    title: typeof payload.title === "string" ? payload.title : event.code,
    detail: typeof payload.detail === "string" ? payload.detail : "运行状态发生变化",
    lifecycleStatus: isEventLifecycleStatus(payload.lifecycleStatus) ? payload.lifecycleStatus : event.status === "SCHEDULED" ? "SCHEDULED" : "DISCOVERED",
    affectedCount: Math.max(0, Number(payload.affectedCount ?? 0)),
    affectedGroupIds: Array.isArray(payload.affectedGroupIds) ? payload.affectedGroupIds.filter((item): item is string => typeof item === "string") : [],
    recommendedActions: Array.isArray(payload.recommendedActions) ? payload.recommendedActions.filter(isShowActionCode) : [],
    detectionAtSimulationTimeMs: Math.max(0, Number(payload.detectionAtSimulationTimeMs ?? event.scheduledSimulationTimeMs ?? 0)),
    detectedSimulationTimeMs: payload.detectedSimulationTimeMs === null || payload.detectedSimulationTimeMs === undefined ? null : Number(payload.detectedSimulationTimeMs),
    escalationAtSimulationTimeMs: payload.escalationAtSimulationTimeMs === null || payload.escalationAtSimulationTimeMs === undefined ? null : Math.max(0, Number(payload.escalationAtSimulationTimeMs)),
    autoRecoveryAtSimulationTimeMs: payload.autoRecoveryAtSimulationTimeMs === null || payload.autoRecoveryAtSimulationTimeMs === undefined ? null : Math.max(0, Number(payload.autoRecoveryAtSimulationTimeMs)),
    recoveryMode: payload.recoveryMode === "AUTO" || payload.recoveryMode === "CONDITION" || payload.recoveryMode === "UNTIL_END" ? payload.recoveryMode : "STUDENT",
    scenarioConfig: isRecord(payload.scenarioConfig) ? payload.scenarioConfig as unknown as V3ScenarioEventConfig : null,
    visibilityMode: payload.visibilityMode === "DIRECT" || payload.visibilityMode === "PARTIAL_DELAY" ? payload.visibilityMode : "AFTER_STATE_CHANGE",
    actionDeadlineSeconds: payload.actionDeadlineSeconds === null || payload.actionDeadlineSeconds === undefined ? null : Math.max(0, Number(payload.actionDeadlineSeconds)),
    actionDeadlineAtSimulationTimeMs: payload.actionDeadlineAtSimulationTimeMs === null || payload.actionDeadlineAtSimulationTimeMs === undefined ? null : Math.max(0, Number(payload.actionDeadlineAtSimulationTimeMs)),
    followUpEventCode: typeof payload.followUpEventCode === "string" ? payload.followUpEventCode : null,
    recoveryCondition: isRecord(payload.recoveryCondition) ? payload.recoveryCondition as unknown as V3ScenarioEventConfig["recoveryCondition"] : null,
    controlledSimulationTimeMs: payload.controlledSimulationTimeMs === null || payload.controlledSimulationTimeMs === undefined ? null : Number(payload.controlledSimulationTimeMs),
    escalationCount: Math.max(0, Number(payload.escalationCount ?? 0))
  }
}

function mergeShowEventPayload(event: RuntimeEventEntity, payload: NormalizedEventPayload): Record<string, unknown> {
  return { ...event.payload, ...payload }
}

function serializeShowEvent(event: RuntimeEventEntity): ShowRuntimeEventView {
  const payload = eventPayload(event)
  return {
    ...serializeEvent(event),
    category: event.category as ShowRuntimeEventCategory,
    lifecycleStatus: payload.lifecycleStatus,
    title: payload.title,
    detail: payload.detail,
    affectedCount: payload.affectedCount,
    affectedGroupIds: payload.affectedGroupIds,
    recommendedActions: payload.recommendedActions,
    detectedSimulationTimeMs: payload.detectedSimulationTimeMs,
    controlledSimulationTimeMs: payload.controlledSimulationTimeMs
  }
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

function showRestartNodes(session: RuntimeSessionEntity): V3RuntimeRestartNodeView[] {
  if (session.status === "READY") return []
  const checkpoint = parseCheckpoint(session.checkpoint)
  const reachedTime = Number(session.simulationTimeMs)
  const titles: Record<string, string> = {
    TAKEOFF_PREPARATION: "起飞准备",
    BATCH_TAKEOFF: "分批起飞",
    TRANSIT_TO_SHOW: "前往表演区",
    PERFORMANCE: "表演运行",
    RETURN_TO_LAUNCH: "返回起降区",
    BATCH_LANDING: "分批降落"
  }
  return showRuntimeTimeline(checkpoint.durationMs)
    .filter((item) => item.startMs <= reachedTime)
    .map((item) => ({
      code: `PHASE:${item.phase}`,
      label: titles[item.phase] ?? item.phase,
      kind: "PHASE" as const,
      sourceSessionId: session.id,
      simulationTimeMs: item.startMs,
      detail: `从 ${formatRuntimeTime(item.startMs)} 的${titles[item.phase] ?? item.phase}节点重新训练`
    }))
}

function phaseAt(durationMs: number, simulationTimeMs: number): ShowRuntimePhase {
  return showRuntimeTimeline(durationMs).filter((item) => item.startMs <= simulationTimeMs).at(-1)?.phase ?? "TAKEOFF_PREPARATION"
}

function formatRuntimeTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `T+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function serializeEvent(event: RuntimeEventEntity): V3RuntimeEventView {
  return {
    id: event.id,
    projectId: event.projectId,
    sessionId: event.sessionId,
    stageCode: event.stageCode,
    code: event.code,
    category: event.category,
    status: event.status,
    severity: event.severity,
    scheduledSimulationTimeMs: event.scheduledSimulationTimeMs === null ? null : Number(event.scheduledSimulationTimeMs),
    triggeredSimulationTimeMs: event.triggeredSimulationTimeMs === null ? null : Number(event.triggeredSimulationTimeMs),
    resolvedSimulationTimeMs: event.resolvedSimulationTimeMs === null ? null : Number(event.resolvedSimulationTimeMs),
    triggeredAt: event.triggeredAt?.toISOString() ?? null,
    resolvedAt: event.resolvedAt?.toISOString() ?? null,
    payload: event.payload,
    correlationId: event.correlationId
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

function serializeEndReport(report: ShowOperationalReportEntity, canSubmit: boolean): ShowFlightEndReportView {
  const value = report.snapshot
  const authoritativeNormalLandedCount = Number(value.authoritativeNormalLandedCount ?? value.suggestedNormalLandedCount ?? 0)
  const authoritativeAbnormalCount = Number(value.authoritativeAbnormalCount ?? value.suggestedAbnormalCount ?? 0)
  const completionStatus = value.completionStatus === "NORMAL" || value.completionStatus === "ABNORMAL" || value.completionStatus === "ABORTED" ? value.completionStatus : null
  const normalLandedCount = value.normalLandedCount === null || value.normalLandedCount === undefined ? null : Number(value.normalLandedCount)
  const abnormalCount = value.abnormalCount === null || value.abnormalCount === undefined ? null : Number(value.abnormalCount)
  const expectedStatus = String(value.runtimeStatus ?? "") === "ABORTED" ? "ABORTED" : authoritativeAbnormalCount > 0 ? "ABNORMAL" : "NORMAL"
  const answerCorrect = completionStatus === null || normalLandedCount === null || abnormalCount === null
    ? null
    : normalLandedCount === authoritativeNormalLandedCount && abnormalCount === authoritativeAbnormalCount && completionStatus === expectedStatus
  return {
    projectId: report.project.id,
    revision: report.revision,
    status: report.status,
    canSubmit: canSubmit && report.status === "DRAFT",
    actualTakeoffAt: nullableString(value.actualTakeoffAt),
    landingCompletedAt: nullableString(value.landingCompletedAt),
    plannedCount: Number(value.plannedCount ?? 0),
    actualTakeoffCount: Number(value.actualTakeoffCount ?? 0),
    suggestedNormalLandedCount: Number(value.suggestedNormalLandedCount ?? 0),
    suggestedAbnormalCount: Number(value.suggestedAbnormalCount ?? 0),
    authoritativeNormalLandedCount,
    authoritativeAbnormalCount,
    completionStatus,
    normalLandedCount,
    abnormalCount,
    abnormalDescription: typeof value.abnormalDescription === "string" ? value.abnormalDescription : "",
    completedAsPlanned: answerCorrect,
    answerCorrect,
    submittedBy: report.submittedBy?.displayName ?? null,
    submittedAt: report.submittedAt?.toISOString() ?? null
  }
}

function normalizeEndReportSnapshot(current: Record<string, unknown>, input: EndReportInput, runtimeStatus: string): Record<string, unknown> {
  const actualTakeoffCount = Math.max(0, Number(current.actualTakeoffCount ?? 0))
  const completionStatus = input.completionStatus ?? (current.completionStatus === "NORMAL" || current.completionStatus === "ABNORMAL" || current.completionStatus === "ABORTED" ? current.completionStatus : null)
  if (completionStatus && !["NORMAL", "ABNORMAL", "ABORTED"].includes(completionStatus)) throw new BadRequestException("完成状态无效")
  const normalLandedCount = normalizeNullableCount(input.normalLandedCount, current.normalLandedCount, actualTakeoffCount, "正常降落数量")
  const abnormalCount = normalizeNullableCount(input.abnormalCount, current.abnormalCount, actualTakeoffCount, "异常数量")
  const abnormalDescription = input.abnormalDescription === undefined
    ? typeof current.abnormalDescription === "string" ? current.abnormalDescription : ""
    : input.abnormalDescription.trim()
  if (abnormalDescription.length > 2_000) throw new BadRequestException("异常说明不能超过 2000 个字符")
  return {
    ...current,
    completionStatus: runtimeStatus === "ABORTED" ? "ABORTED" : completionStatus,
    normalLandedCount,
    abnormalCount,
    abnormalDescription
  }
}

function assertEndReportComplete(snapshot: Record<string, unknown>): void {
  const status = snapshot.completionStatus
  const takeoffCount = Number(snapshot.actualTakeoffCount ?? 0)
  const normalCount = Number(snapshot.normalLandedCount)
  const abnormalCount = Number(snapshot.abnormalCount)
  if (status !== "NORMAL" && status !== "ABNORMAL" && status !== "ABORTED") throw new ConflictException("请选择项目完成状态")
  if (!Number.isInteger(normalCount) || !Number.isInteger(abnormalCount)) throw new ConflictException("请填写正常降落和异常数量")
  if (normalCount + abnormalCount !== takeoffCount) throw new ConflictException("正常降落数量与异常数量之和必须等于实际起飞数量")
  if (status === "NORMAL" && abnormalCount !== 0) throw new ConflictException("正常完成时异常数量必须为 0")
  if ((status === "ABNORMAL" || status === "ABORTED" || abnormalCount > 0) && String(snapshot.abnormalDescription ?? "").trim().length < 5) {
    throw new ConflictException("存在异常或中止时必须填写不少于 5 个字的异常说明")
  }
}

function parseCheckpoint(value: Record<string, unknown>): RuntimeCheckpoint {
  if (value.schemaVersion !== 1) throw new ConflictException("表演运行检查点版本不兼容")
  const center = value.performanceCenter
  if (!center || typeof center !== "object") throw new ConflictException("表演运行检查点缺少区域中心")
  return value as unknown as RuntimeCheckpoint
}

function maximumConcurrentEvents(checkpoint: RuntimeCheckpoint): number {
  const configured = Number(checkpoint.maximumConcurrentEvents)
  return Number.isInteger(configured) && configured >= 1
    ? configured
    : showTemplatePolicyForAircraftCount(checkpoint.totalAircraft).maximumConcurrentEvents
}

function showEventScheduleTime(
  seed: string,
  durationMs: number,
  performance: { startMs: number; endMs: number },
  config: V3ScenarioEventConfig | null,
  index: number,
  total: number
): number | null {
  const ratio = (index + 1) / (total + 1)
  const fallback = performance.startMs + (performance.endMs - performance.startMs) * ratio
  if (config?.triggerMode === "TIME_RANGE" && config.triggerWindowSeconds) return scheduleRuntimeWindowTime(seed, config.code, index, durationMs, config.triggerWindowSeconds)
  if (!config || config.triggerMode === "AUTO") return Math.round(fallback)
  if (config.triggerMode === "CONDITION" || config.triggerMode === "AFTER_EVENT") return null
  if (config.triggerMode === "SIMULATION_TIME") return Math.min(durationMs, Math.max(0, Math.round((config.triggerTimeSeconds ?? 0) * 1_000)))
  const phase = showRuntimeTimeline(durationMs).find((item) => item.phase === config.triggerPhase) ?? performance
  return Math.min(durationMs, Math.max(0, Math.round(phase.startMs + config.triggerOffsetSeconds * 1_000)))
}

function showEventImpact(
  checkpoint: RuntimeCheckpoint,
  definition: ConfiguredShowEvent,
  index: number
): { affectedCount: number; affectedGroupIds: string[] } {
  const scope = definition.scenarioConfig?.impactScope ?? "DEFAULT"
  const defaultGroupCount = checkpoint.totalAircraft >= 3_000 && definition.severity !== "WARNING" ? 2 : 1
  const groupCount = scope === "SINGLE" || scope === "GROUP" || scope === "LOCAL_AREA" ? 1
    : scope === "MULTI_GROUP" ? Math.min(2, checkpoint.groupCount)
      : scope === "MOST" ? Math.max(1, Math.ceil(checkpoint.groupCount * 0.6))
        : scope === "WHOLE" ? checkpoint.groupCount
          : defaultGroupCount
  const configuredGroups = definition.scenarioConfig?.targetIds?.filter((id) => /^G\d+$/i.test(id) && Number(id.replace(/\D/g, "")) <= checkpoint.groupCount) ?? []
  const affectedGroupIds = configuredGroups.length > 0
    ? configuredGroups.slice(0, groupCount)
    : Array.from({ length: groupCount }, (_, offset) => `G${String((index + offset) % checkpoint.groupCount + 1).padStart(2, "0")}`)
  const defaultCount = Math.max(1, Math.min(checkpoint.totalAircraft, Math.ceil(checkpoint.totalAircraft * definition.affectedRatio)))
  const affectedCount = definition.scenarioConfig?.impactCount ?? (
    scope === "SINGLE" ? 1
      : scope === "SMALL_BATCH" ? Math.max(2, Math.ceil(checkpoint.totalAircraft * 0.05))
        : scope === "GROUP" ? Math.ceil(checkpoint.totalAircraft / checkpoint.groupCount)
          : scope === "MULTI_GROUP" ? Math.ceil(checkpoint.totalAircraft * Math.min(1, groupCount / checkpoint.groupCount))
            : scope === "LOCAL_AREA" ? Math.ceil(checkpoint.totalAircraft * 0.2)
              : scope === "MOST" ? Math.ceil(checkpoint.totalAircraft * 0.65)
                : scope === "WHOLE" ? checkpoint.totalAircraft
                  : defaultCount
  )
  return { affectedCount: Math.max(1, Math.min(checkpoint.totalAircraft, affectedCount)), affectedGroupIds }
}

function runtimeDurationMs(scenario: Record<string, unknown>): number {
  const explicitSeconds = Number(scenario.showRuntimeDurationSeconds)
  if (Number.isFinite(explicitSeconds) && explicitSeconds >= 5 && explicitSeconds <= 7_200) return Math.round(explicitSeconds * 1_000)
  const start = Date.parse(stringScenario(scenario, "plannedFlightStartAt", ""))
  const end = Date.parse(stringScenario(scenario, "plannedFlightEndAt", ""))
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.min(7_200_000, Math.max(300_000, end - start))
  return 1_800_000
}

function parseAircraftCount(code: string): number {
  const value = Number(code.match(/(\d+)/)?.[1] ?? 0)
  if (![100, 500, 1000, 3000, 5000].includes(value)) throw new ConflictException("表演规模模板无效")
  return value
}

function normalizeRevision(value: number | undefined): number {
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision < 1) throw new BadRequestException("expectedRevision 必须为正整数")
  return revision
}

function normalizeRate(value: number): number {
  const rate = Number(value)
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 3_600) throw new BadRequestException("运行速度必须在 0.25x 至 3600x 之间")
  return rate
}

function normalizeActionCode(value: ShowRuntimeActionCode | undefined): ShowRuntimeActionCode {
  if (!value || !isShowActionCode(value)) throw new BadRequestException("飞行处置代码无效")
  return value
}

function isShowActionCode(value: unknown): value is ShowRuntimeActionCode {
  return typeof value === "string" && [
    "ACKNOWLEDGE_ALERT", "CONTINUE_MONITORING", "PAUSE_NEXT_TAKEOFF", "RESUME_NEXT_TAKEOFF", "PAUSE_PROGRAM", "RESUME_PROGRAM", "ABORT_PROGRAM",
    "SINGLE_LAND", "BATCH_LAND", "REMOVE_FROM_MISSION", "GROUP_RETURN", "GROUP_LAND", "SWITCH_EMERGENCY_ZONE", "MULTI_GROUP_RETURN", "ZONE_LAND",
    "RETURN_ALL", "EMERGENCY_LAND_ALL"
  ].includes(value)
}

function showActionRequestIdentity(input: RuntimeActionInput, actionCode: ShowRuntimeActionCode): ShowActionRequestIdentity {
  const actionDefinition = showRuntimeActionsFor(5_000, "RUNNING").find((item) => item.code === actionCode)
  if (!actionDefinition) throw new BadRequestException("飞行处置代码无效")
  const eventId = normalizeOptionalText(input.eventId, 120)
  const alertId = normalizeOptionalText(input.alertId, 120)
  return {
    actionCode,
    eventId,
    alertId,
    targetType: actionDefinition.targetType,
    targetId: actionDefinition.targetType === "ALERT" ? alertId : normalizeOptionalText(input.targetId, 120),
    reasoning: normalizeRuntimeActionReasoning(input.reasoning)
  }
}

export function assertShowActionContextPending(event: RuntimeEventEntity | null, alert: RuntimeAlertEntity | null, actionCode: ShowRuntimeActionCode): void {
  if (actionCode === "ACKNOWLEDGE_ALERT") {
    if (alert?.status === "RESOLVED") throw new ConflictException("当前告警已经处置完成")
    if (alert?.status === "ACKNOWLEDGED") throw new ConflictException("当前告警已经确认")
    return
  }
  const lifecycleStatus = String(event?.payload.lifecycleStatus ?? "")
  if (event && (event.status === "RESOLVED" || ["CONTROLLED", "ENDED", "RESOLVED"].includes(lifecycleStatus))) {
    throw new ConflictException("当前事件已经处置完成")
  }
  if (alert?.status === "RESOLVED") throw new ConflictException("当前告警已经处置完成")
}

function isEventLifecycleStatus(value: unknown): value is ShowRuntimeEventLifecycleStatus {
  return typeof value === "string" && ["SCHEDULED", "OCCURRED_UNDETECTED", "DISCOVERED", "HANDLING", "CONTROLLED", "ESCALATED", "ENDED"].includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function eventResourceInputs(manager: EntityManager, project: StudentProjectEntity): Promise<unknown[]> {
  const scenario = project.snapshot.config.scenario
  const selected = Array.isArray(scenario.eventConfigs)
    ? scenario.eventConfigs
    : Array.isArray(scenario.eventCodes) ? scenario.eventCodes : []
  if (selected.length === 0) return []
  const reference = project.snapshot.resourceRefs.find((item) => item.packageType === "EVENT")
  const resource = reference ? await manager.findOne(ResourcePackageEntity, { where: { id: reference.packageId } }) : null
  const content = resource?.archiveManifest?.content ?? resource?.manifest
  const resourceEvents = isRecord(content) && Array.isArray(content.events) ? content.events.filter(isRecord) : []
  const configs = new Map(selected.flatMap((value) => {
    if (typeof value === "string") return [[value.trim(), { code: value.trim() }] as const]
    return isRecord(value) && typeof value.code === "string" ? [[value.code.trim(), value] as const] : []
  }))
  return [...configs.entries()].map(([code, config]) => {
    const definition = resourceEvents.find((value) => value.code === code)
    return definition ? { ...definition, ...config } : config
  })
}

function validGroupId(value: string, groupCount: number): boolean {
  const number = Number(value.match(/^G(\d{2,3})$/)?.[1] ?? 0)
  return number >= 1 && number <= groupCount
}

function normalizeRequiredText(value: string | undefined, emptyMessage: string, maximumLength: number): string {
  const text = value?.trim() ?? ""
  if (!text) throw new BadRequestException(emptyMessage)
  if (text.length > maximumLength) throw new BadRequestException(`内容不能超过 ${maximumLength} 个字符`)
  return text
}

function normalizeOptionalText(value: string | null | undefined, maximumLength: number): string | null {
  const text = value?.trim() ?? ""
  if (text.length > maximumLength) throw new BadRequestException(`目标标识不能超过 ${maximumLength} 个字符`)
  return text || null
}

function normalizeRequestId(value: string | null | undefined): string | null {
  const text = value?.trim() ?? ""
  if (text.length > 120) throw new BadRequestException("请求号长度不能超过 120 个字符")
  return text || null
}

function normalizeNullableCount(value: number | null | undefined, current: unknown, maximum: number, label: string): number | null {
  const candidate = value === undefined ? current : value
  if (candidate === null || candidate === undefined || candidate === "") return null
  const number = Number(candidate)
  if (!Number.isInteger(number) || number < 0 || number > maximum) throw new BadRequestException(`${label}必须是 0 至 ${maximum} 的整数`)
  return number
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null
}

function numberScenario(scenario: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(scenario[key] ?? fallback)
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback
}

function stringScenario(scenario: Record<string, unknown>, key: string, fallback: string): string {
  const value = scenario[key]
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}
