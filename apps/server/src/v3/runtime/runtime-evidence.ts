import type { RuntimeEvidence, RuntimeJsonObject } from "@wurenji/shared"
import type { RuntimeEventEntity, StudentRuntimeActionEntity } from "./runtime.entities.js"

export interface RuntimeEvidenceSources {
  events: readonly RuntimeEventEntity[]
  actions: readonly StudentRuntimeActionEntity[]
}

export function adaptRuntimeEventEvidence(event: RuntimeEventEntity, sequence: number): RuntimeEvidence {
  return {
    id: event.id,
    sessionId: event.sessionId,
    sequence,
    kind: "EVENT",
    code: event.code,
    simulationTimeMs: event.triggeredSimulationTimeMs === null
      ? Number(event.scheduledSimulationTimeMs ?? 0)
      : Number(event.triggeredSimulationTimeMs),
    actorId: null,
    eventId: event.id,
    actionId: null,
    data: jsonObject({
      category: event.category,
      status: event.status,
      severity: event.severity,
      scheduledSimulationTimeMs: event.scheduledSimulationTimeMs,
      triggeredSimulationTimeMs: event.triggeredSimulationTimeMs,
      resolvedSimulationTimeMs: event.resolvedSimulationTimeMs,
      payload: event.payload
    }),
    createdAt: event.createdAt.toISOString()
  }
}

export function adaptRuntimeActionEvidence(action: StudentRuntimeActionEntity, sequence: number): RuntimeEvidence {
  return {
    id: action.id,
    sessionId: action.sessionId,
    sequence,
    kind: "ACTION",
    code: action.actionCode,
    simulationTimeMs: Number(action.simulationTimeMs),
    actorId: action.actorId,
    eventId: action.eventId,
    actionId: action.id,
    data: jsonObject({
      status: action.status,
      targetType: action.targetType,
      targetId: action.targetId,
      payload: action.payload,
      result: action.result,
      correlationId: action.correlationId
    }),
    createdAt: action.createdAt.toISOString()
  }
}

export function buildRuntimeEvidence(sources: RuntimeEvidenceSources): RuntimeEvidence[] {
  const entries = [
    ...sources.events.map((event) => ({ kind: "EVENT" as const, simulationTimeMs: event.triggeredSimulationTimeMs === null ? Number(event.scheduledSimulationTimeMs ?? 0) : Number(event.triggeredSimulationTimeMs), createdAt: event.createdAt.getTime(), source: event })),
    ...sources.actions.map((action) => ({ kind: "ACTION" as const, simulationTimeMs: Number(action.simulationTimeMs), createdAt: action.createdAt.getTime(), source: action }))
  ].sort((left, right) => left.simulationTimeMs - right.simulationTimeMs || left.createdAt - right.createdAt || left.kind.localeCompare(right.kind) || left.source.id.localeCompare(right.source.id))

  return entries.map((entry, index) => entry.kind === "EVENT"
    ? adaptRuntimeEventEvidence(entry.source, index + 1)
    : adaptRuntimeActionEvidence(entry.source, index + 1))
}

function jsonObject(value: Record<string, unknown>): RuntimeJsonObject {
  return JSON.parse(JSON.stringify(value)) as RuntimeJsonObject
}
