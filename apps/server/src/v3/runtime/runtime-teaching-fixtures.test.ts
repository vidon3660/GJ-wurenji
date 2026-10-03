import { describe, expect, it } from "vitest"
import { cloneRuntimeTeachingFixture, createRuntimeTeachingFixture, resetRuntimeTeachingFixture } from "./runtime-teaching-fixtures.js"

describe("runtime teaching fixtures", () => {
  it("creates isolated 1 to 3 aircraft logistics data without map files", () => {
    const one = createRuntimeTeachingFixture({ aircraftCount: 1 })
    const three = createRuntimeTeachingFixture({ aircraftCount: 3 })

    expect(one.namespace).toBe("a2-logistics-teaching")
    expect(Array.isArray(one.state.entities.aircraft) ? one.state.entities.aircraft : []).toHaveLength(1)
    expect(Array.isArray(three.state.entities.aircraft) ? three.state.entities.aircraft : []).toHaveLength(3)
    expect(Array.isArray(three.state.entities.nodes) ? three.state.entities.nodes : []).toHaveLength(4)
    expect(Array.isArray(three.state.entities.orders) ? three.state.entities.orders : []).toHaveLength(2)
    expect(three.events.map((item) => item.code)).toEqual([
      "POSITIONING_DEGRADED",
      "COMMUNICATION_LOSS",
      "WEATHER_LIMIT",
      "EQUIPMENT_FAULT"
    ])
  })

  it("makes training and assessment rules explicit", () => {
    const training = createRuntimeTeachingFixture({ mode: "TRAINING" })
    const assessment = createRuntimeTeachingFixture({ mode: "ASSESSMENT" })

    expect(training.clock.canPause).toBe(true)
    expect(training.clock.canReset).toBe(true)
    expect(assessment.clock.canPause).toBe(false)
    expect(assessment.clock.canReset).toBe(false)
    expect(assessment.clock.deadlineAt).toBe("2026-09-27T00:20:00.000Z")
  })

  it("supports reset and clone without sharing mutable data", () => {
    const original = createRuntimeTeachingFixture()
    const clone = cloneRuntimeTeachingFixture(original)
    clone.clock.rate = 42

    expect(original.clock.rate).toBe(1)
    expect(resetRuntimeTeachingFixture({ sessionId: "fresh" }).session.id).toBe("fresh")
  })
})
