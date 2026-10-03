import { describe, expect, it } from "vitest"
import type { RuntimeEventEntity, StudentRuntimeActionEntity } from "./runtime.entities.js"
import { adaptRuntimeActionEvidence, adaptRuntimeEventEvidence, buildRuntimeEvidence } from "./runtime-evidence.js"

function event(overrides: Partial<RuntimeEventEntity> = {}): RuntimeEventEntity {
  return {
    id: "event-1",
    sessionId: "session-1",
    code: "WEATHER_CHANGE",
    category: "WEATHER_ENVIRONMENT",
    status: "RESOLVED",
    severity: "WARNING",
    scheduledSimulationTimeMs: 10_000,
    triggeredSimulationTimeMs: 12_000,
    resolvedSimulationTimeMs: 18_000,
    createdAt: new Date("2026-09-27T00:00:00.000Z"),
    payload: { affectedAircraftIds: ["aircraft-1"] },
    ...overrides
  } as RuntimeEventEntity
}

function action(overrides: Partial<StudentRuntimeActionEntity> = {}): StudentRuntimeActionEntity {
  return {
    id: "action-1",
    sessionId: "session-1",
    actorId: "student-1",
    actionCode: "RETURN_AIRCRAFT",
    targetType: "AIRCRAFT",
    targetId: "aircraft-1",
    status: "APPLIED",
    simulationTimeMs: 15_000,
    payload: { reason: "risk" },
    result: { applied: true },
    correlationId: "request-1",
    createdAt: new Date("2026-09-27T00:00:01.000Z"),
    ...overrides
  } as StudentRuntimeActionEntity
}

describe("runtime evidence adapters", () => {
  it("preserves event transition times and action identity", () => {
    expect(adaptRuntimeEventEvidence(event(), 1)).toMatchObject({
      kind: "EVENT",
      simulationTimeMs: 12_000,
      eventId: "event-1",
      data: { resolvedSimulationTimeMs: 18_000 }
    })
    expect(adaptRuntimeActionEvidence(action(), 2)).toMatchObject({
      kind: "ACTION",
      simulationTimeMs: 15_000,
      actorId: "student-1",
      actionId: "action-1"
    })
  })

  it("orders mixed event and action evidence deterministically", () => {
    const result = buildRuntimeEvidence({
      events: [event({ id: "event-late", triggeredSimulationTimeMs: 30_000, createdAt: new Date("2026-09-27T00:00:02.000Z") })],
      actions: [action({ id: "action-early", simulationTimeMs: 20_000 }), action({ id: "action-late", simulationTimeMs: 30_000 })]
    })

    expect(result.map((item) => [item.sequence, item.kind, item.id])).toEqual([
      [1, "ACTION", "action-early"],
      [2, "ACTION", "action-late"],
      [3, "EVENT", "event-late"]
    ])
  })
})
