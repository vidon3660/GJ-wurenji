import { performance } from "node:perf_hooks"
import { describe, expect, it } from "vitest"
import { buildRuntimeEventSchedule, activateDueRuntimeEvents } from "./runtime-event-scheduler.js"
import { cloneRuntimeTeachingFixture, createRuntimeTeachingFixture } from "./runtime-teaching-fixtures.js"

describe("I2 database-free concurrent runtime regression", () => {
  it("keeps ten concurrent teaching sessions isolated and deterministic", async () => {
    const startedAt = performance.now()
    const results = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
      const projectId = `i2-project-${index + 1}`
      const sessionId = `i2-session-${index + 1}`
      const fixture = createRuntimeTeachingFixture({
        mode: index % 2 === 0 ? "TRAINING" : "ASSESSMENT",
        aircraftCount: 3,
        projectId,
        sessionId,
        scenarioSeed: `i2-seed-${index + 1}`
      })
      const copy = cloneRuntimeTeachingFixture(fixture)
      copy.state.session.status = "RUNNING"
      copy.state.session.revision += 1
      const schedule = buildRuntimeEventSchedule(copy.events.map((event) => ({
        id: event.id,
        code: event.code,
        source: "FIXED" as const,
        fixedTimeMs: event.scheduledSimulationTimeMs ?? 0,
        payload: { eventId: event.id }
      })), copy.session.scenarioSeed, 180_000)
      const active = activateDueRuntimeEvents(schedule, 60_000)
      return {
        projectId: copy.session.projectId,
        sessionId: copy.session.id,
        revision: copy.state.session.revision,
        activeCodes: active.filter((event) => event.status === "ACTIVE").map((event) => event.code),
        mapVersion: copy.session.mapResourceVersion,
        aircraftCount: Array.isArray(copy.state.entities.aircraft) ? copy.state.entities.aircraft.length : 0
      }
    }))
    const elapsedMs = performance.now() - startedAt

    expect(new Set(results.map((item) => item.projectId)).size).toBe(10)
    expect(new Set(results.map((item) => item.sessionId)).size).toBe(10)
    expect(results.every((item) => item.revision === 2 && item.aircraftCount === 3)).toBe(true)
    expect(results.every((item) => item.mapVersion === "teaching-guangzhou-map-1")).toBe(true)
    expect(results.every((item) => item.activeCodes.length === 2)).toBe(true)
    expect(Number.isFinite(elapsedMs)).toBe(true)
  })
})
