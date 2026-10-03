import type {
  RuntimeAction,
  RuntimeError,
  RuntimeEvent,
  RuntimeJsonObject,
  RuntimeClock,
  RuntimeMode,
  RuntimeResourceVersions,
  RuntimeSession,
  V3RuntimeEventView,
  V3RuntimeSessionView,
  V3StudentRuntimeActionView
} from "@wurenji/shared"
import { runtimeActionErrorCodes, type RuntimeActionErrorCode } from "@wurenji/shared"

export interface RuntimeSessionAdapterOptions extends RuntimeResourceVersions {
  mode: RuntimeMode
}

export interface RuntimeClockAdapterOptions {
  rate: number
  deadlineAt?: string | null
  canPause: boolean
  canReset: boolean
}

export function adaptRuntimeClock(
  source: { simulationTimeMs: number; startedAt: Date | null },
  options: RuntimeClockAdapterOptions
): RuntimeClock {
  const simulationTimeMs = Math.max(0, Math.floor(Number(source.simulationTimeMs)))
  const rate = Number.isFinite(options.rate) && options.rate > 0 ? options.rate : 1
  return {
    simulationTimeMs,
    tick: Math.floor(simulationTimeMs / 1_000),
    tickIntervalMs: 1_000,
    rate,
    wallClockStartedAt: source.startedAt?.toISOString() ?? null,
    deadlineAt: options.deadlineAt ?? null,
    canPause: options.canPause,
    canReset: options.canReset
  }
}

export function adaptRuntimeSession(source: V3RuntimeSessionView, options: RuntimeSessionAdapterOptions): RuntimeSession {
  return {
    id: source.id,
    projectId: source.projectId,
    mode: source.mode ?? options.mode,
    status: source.status,
    scenarioSeed: source.scenarioSeed,
    attemptNo: source.attemptNo,
    revision: source.revision,
    mapResourceVersion: source.mapResourceVersion ?? options.mapResourceVersion,
    sceneResourceVersion: source.sceneResourceVersion ?? options.sceneResourceVersion,
    planVersion: source.planVersion ?? options.planVersion,
    createdAt: source.startedAt ?? source.endedAt ?? "",
    startedAt: source.startedAt,
    endedAt: source.endedAt
  }
}

export function adaptRuntimeEvent(source: V3RuntimeEventView): RuntimeEvent {
  return {
    id: source.id,
    sessionId: source.sessionId,
    code: source.code,
    status: source.status,
    scheduledSimulationTimeMs: source.scheduledSimulationTimeMs,
    triggeredSimulationTimeMs: source.triggeredSimulationTimeMs !== undefined
      ? source.triggeredSimulationTimeMs
      : source.triggeredAt ? source.scheduledSimulationTimeMs : null,
    resolvedSimulationTimeMs: source.resolvedSimulationTimeMs !== undefined
      ? source.resolvedSimulationTimeMs
      : source.resolvedAt ? source.scheduledSimulationTimeMs : null,
    payload: runtimeJsonObject(source.payload),
    correlationId: source.correlationId
  }
}

export function adaptRuntimeAction(source: V3StudentRuntimeActionView): RuntimeAction {
  const result = runtimeJsonObject(source.result)
  return {
    id: source.id,
    requestId: source.correlationId,
    sessionId: source.sessionId,
    actorId: source.actorId,
    code: source.actionCode,
    targetType: source.targetType,
    targetId: source.targetId,
    status: source.status,
    requestedAtSimulationTimeMs: source.simulationTimeMs,
    appliedAtSimulationTimeMs: source.appliedAt ? source.simulationTimeMs : null,
    payload: runtimeJsonObject(source.payload),
    result,
    errorCode: runtimeActionErrorCode(result.errorCode),
    correlationId: source.correlationId
  }
}

function runtimeActionErrorCode(value: unknown): RuntimeActionErrorCode | null {
  return typeof value === "string" && runtimeActionErrorCodes.includes(value as RuntimeActionErrorCode)
    ? value as RuntimeActionErrorCode
    : null
}

export function runtimeError(
  code: RuntimeError["code"],
  message: string,
  context: Partial<Pick<RuntimeError, "requestId" | "sessionId" | "revision" | "details">> = {}
): RuntimeError {
  return {
    code,
    message,
    requestId: context.requestId ?? null,
    sessionId: context.sessionId ?? null,
    revision: context.revision ?? null,
    details: context.details ?? {}
  }
}

const messageCodeMap: ReadonlyArray<readonly [string, RuntimeError["code"]]> = [
  ["运行版本冲突", "STALE_SESSION_REVISION"],
  ["同一请求号不能", "DUPLICATE_REQUEST"],
  ["请求标识已对应其他", "DUPLICATE_REQUEST"],
  ["事件已经处置完成", "EVENT_NOT_ACTIVE"],
  ["事件已经触发", "EVENT_NOT_ACTIVE"],
  ["事件尚未进入可确认状态", "EVENT_NOT_ACTIVE"],
  ["事件不存在", "TARGET_NOT_FOUND"],
  ["目标航空器不存在", "TARGET_NOT_FOUND"],
  ["目标分组不存在", "TARGET_NOT_FOUND"],
  ["目标状态", "TARGET_STATE_INVALID"],
  ["当前航空器不能", "TARGET_STATE_INVALID"],
  ["不能再次返航", "TARGET_STATE_INVALID"],
  ["源航空器不能", "TARGET_STATE_INVALID"],
  ["目标航空器已经", "TARGET_STATE_INVALID"],
  ["当前运行状态不能", "SESSION_NOT_RUNNING"],
  ["当前没有可", "SESSION_NOT_RUNNING"],
  ["仿真尚未结束", "SESSION_NOT_RUNNING"],
  ["处置不可执行", "ACTION_NOT_ALLOWED"],
  ["尚未提交", "ACTION_NOT_ALLOWED"],
  ["必须关联", "INVALID_PAYLOAD"],
  ["动作无效", "INVALID_PAYLOAD"],
  ["考核模式", "ASSESSMENT_LOCKED"],
  ["运行会话", "SESSION_NOT_FOUND"]
]

export function runtimeErrorCodeFromMessage(message: string): RuntimeError["code"] {
  return messageCodeMap.find(([fragment]) => message.includes(fragment))?.[1] ?? "INVALID_PAYLOAD"
}

export function runtimeErrorFromMessage(message: string, context: Partial<Pick<RuntimeError, "requestId" | "sessionId" | "revision" | "details">> = {}): RuntimeError {
  return runtimeError(runtimeErrorCodeFromMessage(message), message, context)
}

export function runtimeJsonObject(value: Record<string, unknown>): RuntimeJsonObject {
  return JSON.parse(JSON.stringify(value)) as RuntimeJsonObject
}
