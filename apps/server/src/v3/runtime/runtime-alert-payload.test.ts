import { describe, expect, it } from "vitest"
import { mergeRuntimeAlertPayload } from "./runtime-alert-payload.js"

describe("mergeRuntimeAlertPayload", () => {
  it("copies authoritative action and timing fields from the runtime event", () => {
    expect(mergeRuntimeAlertPayload({
      recommendedActions: ["HOLD", 1, null],
      actionDeadlineSeconds: "30",
      actionDeadlineAtSimulationTimeMs: 45_000,
      detectedSimulationTimeMs: 15_000
    }, { affectedAircraftIds: ["aircraft-1"] })).toEqual({
      affectedAircraftIds: ["aircraft-1"],
      recommendedActions: ["HOLD"],
      actionDeadlineSeconds: 30,
      actionDeadlineAtSimulationTimeMs: 45_000,
      detectedSimulationTimeMs: 15_000
    })
  })

  it("uses explicit nulls when a resource does not define timing data", () => {
    expect(mergeRuntimeAlertPayload({ recommendedActions: [] }, { eventSubtype: "WEATHER_CHANGE" })).toEqual({
      eventSubtype: "WEATHER_CHANGE",
      recommendedActions: [],
      actionDeadlineSeconds: null,
      actionDeadlineAtSimulationTimeMs: null,
      detectedSimulationTimeMs: null
    })
  })
})
