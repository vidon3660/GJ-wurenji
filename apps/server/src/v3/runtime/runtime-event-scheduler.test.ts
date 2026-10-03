import { describe, expect, it } from "vitest"
import {
  activateDueRuntimeEvents,
  buildRuntimeEventSchedule,
  resolveRuntimeEvent,
  RuntimeEventSchedulerError,
  triggerRuntimeEventManually
} from "./runtime-event-scheduler.js"

describe("runtime event scheduler", () => {
  const definitions = [
    { id: "fixed", code: "FIXED_EVENT", source: "FIXED" as const, fixedTimeMs: 10_000 },
    { id: "random", code: "WINDOW_EVENT", source: "WINDOW" as const, windowMs: [20_000, 40_000] as [number, number] },
    { id: "manual", code: "MANUAL_EVENT", source: "MANUAL" as const, payload: { manualAllowedModes: ["TRAINING"], manualWindowStartMs: 5_000, manualWindowEndMs: 15_000 } }
  ]

  it("schedules fixed and seeded window events reproducibly", () => {
    const first = buildRuntimeEventSchedule(definitions, "seed-a", 60_000)
    const second = buildRuntimeEventSchedule(definitions, "seed-a", 60_000)
    expect(first.map((event) => event.scheduledSimulationTimeMs)).toEqual(second.map((event) => event.scheduledSimulationTimeMs))
    expect(first[0].scheduledSimulationTimeMs).toBe(10_000)
    expect(first[2].scheduledSimulationTimeMs).toBeNull()
  })

  it("activates due events once and preserves future events", () => {
    const schedule = buildRuntimeEventSchedule(definitions, "seed-a", 60_000)
    const active = activateDueRuntimeEvents(schedule, 10_000)
    expect(active.find((event) => event.id === "fixed")?.status).toBe("ACTIVE")
    expect(active.find((event) => event.id === "random")?.status).toBe("SCHEDULED")
    expect(activateDueRuntimeEvents(active, 10_000).filter((event) => event.status === "ACTIVE")).toHaveLength(1)
  })

  it("enforces training-only manual windows and duplicate protection", () => {
    const schedule = buildRuntimeEventSchedule(definitions, "seed-a", 60_000)
    expect(() => triggerRuntimeEventManually(schedule, "manual", "ASSESSMENT", 8_000)).toThrowError(RuntimeEventSchedulerError)
    const active = triggerRuntimeEventManually(schedule, "manual", "TRAINING", 8_000)
    expect(active.find((event) => event.id === "manual")).toMatchObject({ status: "ACTIVE", source: "MANUAL", scheduledSimulationTimeMs: 8_000 })
    expect(() => triggerRuntimeEventManually(active, "manual", "TRAINING", 9_000)).toThrowError("事件已经触发")
    expect(() => triggerRuntimeEventManually(schedule, "manual", "TRAINING", 20_000)).toThrowError("不在事件允许窗口内")
  })

  it("records resolution time without changing other events", () => {
    const schedule = activateDueRuntimeEvents(buildRuntimeEventSchedule(definitions, "seed-a", 60_000), 10_000)
    const resolved = resolveRuntimeEvent(schedule, "fixed", 12_000)
    expect(resolved.find((event) => event.id === "fixed")).toMatchObject({ status: "RESOLVED", resolvedSimulationTimeMs: 12_000 })
    expect(resolved.find((event) => event.id === "random")?.status).toBe("SCHEDULED")
  })
})
