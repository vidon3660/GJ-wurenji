import { ConflictException } from "@nestjs/common"
import type { ShowRuntimeActionCode, ShowRuntimeAvailableActionView, V3RuntimeActionReasoning } from "@wurenji/shared"
import type { StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"

export interface ShowActionRequestIdentity {
  actionCode: ShowRuntimeActionCode
  eventId: string | null
  alertId: string | null
  targetType: ShowRuntimeAvailableActionView["targetType"]
  targetId: string | null
  reasoning: V3RuntimeActionReasoning
}

type PersistedShowAction = Pick<StudentRuntimeActionEntity, "actionCode" | "eventId" | "alertId" | "targetType" | "targetId" | "payload">

export function sameShowActionRequest(existing: PersistedShowAction, request: ShowActionRequestIdentity): boolean {
  const reasoning = recordValue(recordValue(existing.payload).reasoning)
  return existing.actionCode === request.actionCode
    && existing.eventId === request.eventId
    && existing.alertId === request.alertId
    && existing.targetType === request.targetType
    && existing.targetId === request.targetId
    && reasoning.observation === request.reasoning.observation
    && reasoning.rationale === request.reasoning.rationale
    && reasoning.expectedOutcome === request.reasoning.expectedOutcome
}

export function assertSameShowActionRequest(existing: PersistedShowAction, request: ShowActionRequestIdentity): void {
  if (!sameShowActionRequest(existing, request)) {
    throw new ConflictException("同一请求号不能提交不同的城市表演处置命令")
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
