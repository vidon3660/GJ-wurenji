import { ConflictException } from "@nestjs/common"
import type { LogisticsRuntimeActionCode, LogisticsRuntimeActionTargetType, V3RuntimeActionReasoning } from "@wurenji/shared"
import type { StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"

export interface LogisticsActionRequestIdentity {
  actionCode: LogisticsRuntimeActionCode
  eventId: string | null
  alertId: string | null
  targetType: LogisticsRuntimeActionTargetType
  targetId: string | null
  reasoning: V3RuntimeActionReasoning
  payload: Record<string, unknown>
}

type PersistedLogisticsAction = Pick<StudentRuntimeActionEntity, "actionCode" | "eventId" | "alertId" | "targetType" | "targetId" | "payload">

export function sameLogisticsActionRequest(existing: PersistedLogisticsAction, request: LogisticsActionRequestIdentity): boolean {
  const payload = recordValue(existing.payload)
  const reasoning = recordValue(payload.reasoning)
  return existing.actionCode === request.actionCode
    && existing.eventId === request.eventId
    && existing.alertId === request.alertId
    && existing.targetType === request.targetType
    && existing.targetId === request.targetId
    && reasoning.observation === request.reasoning.observation
    && reasoning.rationale === request.reasoning.rationale
    && reasoning.expectedOutcome === request.reasoning.expectedOutcome
    && canonicalPayload(logisticsActionPayload(payload)) === canonicalPayload(request.payload)
}

export function assertSameLogisticsActionRequest(existing: PersistedLogisticsAction, request: LogisticsActionRequestIdentity): void {
  if (!sameLogisticsActionRequest(existing, request)) {
    throw new ConflictException("同一请求号不能提交不同的物流处置命令")
  }
}

export function logisticsActionTargetType(code: LogisticsRuntimeActionCode): LogisticsRuntimeActionTargetType {
  if (code === "ACKNOWLEDGE_ALERT") return "ALERT"
  if (["REDUCE_SPEED", "MAINTAIN_ROUTE", "HOLD_POSITION", "PROCEED_TO_WAITING_POINT", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "EMERGENCY_LAND_AIRCRAFT"].includes(code)) return "AIRCRAFT"
  if (["ABORT_TASK", "SWITCH_VERIFIED_ROUTE", "REPLACE_AIRCRAFT", "REASSIGN_ORDER", "CHANGE_PRIORITY", "DELAY_TASK", "CANCEL_TASK"].includes(code)) return "ORDER"
  if (["PAUSE_ROUTE_ENTRY", "PAUSE_ROUTE", "RESUME_ROUTE"].includes(code)) return "ROUTE"
  if (code === "BATCH_REASSIGN") return "BATCH"
  return "GLOBAL"
}

export function logisticsActionPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  const { reasoning: _reasoning, rationale: _rationale, _requestId: _requestId, ...payload } = value
  return payload
}

function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalPayload(item)).join(",")}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalPayload(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
