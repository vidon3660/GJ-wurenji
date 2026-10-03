import { describe, expect, it } from "vitest"
import { adaptRuntimeSession } from "./runtime-adapters.js"
import { buildRuntimeEventSchedule, activateDueRuntimeEvents } from "./runtime-event-scheduler.js"
import { createRuntimeTeachingFixture } from "./runtime-teaching-fixtures.js"

describe("runtime local integration smoke", () => {
  it("connects teaching fixture, deterministic events and frozen runtime contract", () => {
    const fixture = createRuntimeTeachingFixture({ mode: "ASSESSMENT", aircraftCount: 3 })
    const schedule = buildRuntimeEventSchedule(fixture.events.map((event) => ({
      id: event.id,
      code: event.code,
      source: "FIXED" as const,
      fixedTimeMs: event.scheduledSimulationTimeMs ?? 0,
      payload: { eventId: event.id }
    })), fixture.session.scenarioSeed, 180_000)
    const due = activateDueRuntimeEvents(schedule, 60_000)
    const contractSession = adaptRuntimeSession({
      id: fixture.session.id,
      projectId: fixture.session.projectId,
      status: fixture.session.status,
      scenarioSeed: fixture.session.scenarioSeed,
      attemptNo: fixture.session.attemptNo,
      sourceSessionId: null,
      restartNodeCode: null,
      restartSimulationTimeMs: null,
      simulationTimeMs: fixture.clock.simulationTimeMs,
      revision: fixture.session.revision,
      checkpoint: {},
      startedAt: fixture.session.startedAt,
      endedAt: fixture.session.endedAt
    }, fixture.session)

    expect(contractSession.mode).toBe("ASSESSMENT")
    expect(contractSession.mapResourceVersion).toBe("teaching-guangzhou-map-1")
    expect(due.filter((event) => event.status === "ACTIVE").map((event) => event.code)).toEqual([
      "POSITIONING_DEGRADED",
      "COMMUNICATION_LOSS"
    ])
    expect(Array.isArray(fixture.state.entities.aircraft) ? fixture.state.entities.aircraft : []).toHaveLength(3)
  })
})
