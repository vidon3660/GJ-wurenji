import { describe, expect, it } from "vitest"
import type { V3ScenarioEventConfig } from "@wurenji/shared"
import {
  canActivateScenarioEvent,
  deterministicWindowTime,
  manualTriggerWindowOpen,
  recoverySatisfied,
  scenarioEventActiveCountAfterTransition,
  triggerSatisfied,
  visibilityDelayMs
} from "./scenario-event-rules.js"

describe("scenario event rules", () => {
  it("keeps random windows deterministic for one assignment snapshot", () => {
    const first = deterministicWindowTime("snapshot-a", "WEATHER_CHANGE", 0, 600_000, [20, 80])
    const second = deterministicWindowTime("snapshot-a", "WEATHER_CHANGE", 0, 600_000, [20, 80])

    expect(first).toBe(second)
    expect(first).toBeGreaterThanOrEqual(20_000)
    expect(first).toBeLessThanOrEqual(80_000)
  })

  it("supports previous-event and metric conditions", () => {
    const previousEvent: V3ScenarioEventConfig = {
      code: "POSITIONING_DEGRADED",
      triggerMode: "AFTER_EVENT",
      triggerTimeSeconds: null,
      triggerPhase: "OUTBOUND",
      triggerOffsetSeconds: 0,
      severity: null,
      detectionDelaySeconds: null,
      escalationDelaySeconds: null,
      durationSeconds: null,
      recoveryMode: "STUDENT",
      triggerAfterEventCode: "WEATHER_CHANGE"
    }
    const metricCondition: V3ScenarioEventConfig = {
      ...previousEvent,
      code: "AIRCRAFT_FAULT",
      triggerMode: "CONDITION",
      triggerAfterEventCode: null,
      triggerCondition: { type: "MIN_AIRBORNE_AIRCRAFT", operator: "GTE", value: 3 }
    }

    expect(triggerSatisfied(previousEvent, { currentSimulationTimeMs: 100, eventStatuses: { WEATHER_CHANGE: "ACTIVE" } })).toBe(true)
    expect(triggerSatisfied(previousEvent, { currentSimulationTimeMs: 100, eventStatuses: { WEATHER_CHANGE: "RESOLVED" } })).toBe(false)
    expect(triggerSatisfied(metricCondition, { currentSimulationTimeMs: 100, values: { airborneAircraft: 3 } })).toBe(true)
    expect(triggerSatisfied(metricCondition, { currentSimulationTimeMs: 100, values: { airborneAircraft: 2 } })).toBe(false)
  })

  it("calculates visibility and condition recovery", () => {
    const config: V3ScenarioEventConfig = {
      code: "NODE_UNAVAILABLE",
      triggerMode: "AUTO",
      triggerTimeSeconds: null,
      triggerPhase: "OUTBOUND",
      triggerOffsetSeconds: 0,
      severity: null,
      detectionDelaySeconds: 8,
      escalationDelaySeconds: null,
      durationSeconds: null,
      recoveryMode: "CONDITION",
      visibilityMode: "DIRECT",
      recoveryCondition: { type: "MIN_ACTIVE_ORDERS", operator: "LTE", value: 1 }
    }

    expect(visibilityDelayMs(config, 5_000)).toBe(0)
    expect(recoverySatisfied(config, { currentSimulationTimeMs: 1, values: { activeOrders: 1 } })).toBe(true)
  })

  it("enforces configured manual trigger windows in simulation time", () => {
    const config: V3ScenarioEventConfig = {
      code: "WEATHER_CHANGE",
      triggerMode: "TIME_RANGE",
      triggerTimeSeconds: null,
      triggerPhase: "OUTBOUND",
      triggerOffsetSeconds: 0,
      triggerWindowSeconds: [10, 20],
      severity: null,
      detectionDelaySeconds: null,
      escalationDelaySeconds: null,
      durationSeconds: null,
      recoveryMode: "STUDENT"
    }

    expect(manualTriggerWindowOpen(config, 9_999)).toBe(false)
    expect(manualTriggerWindowOpen(config, 10_000)).toBe(true)
    expect(manualTriggerWindowOpen(config, 20_000)).toBe(true)
    expect(manualTriggerWindowOpen(config, 20_001)).toBe(false)
    expect(manualTriggerWindowOpen(null, 999_999)).toBe(true)
  })

  it("queues due events until an active-event slot is released", () => {
    expect(canActivateScenarioEvent(2, 2)).toBe(false)
    expect(scenarioEventActiveCountAfterTransition(2, "ACTIVE", "ACTIVE")).toBe(2)
    const afterRecovery = scenarioEventActiveCountAfterTransition(2, "ACTIVE", "RESOLVED")
    expect(afterRecovery).toBe(1)
    expect(canActivateScenarioEvent(afterRecovery, 2)).toBe(true)
    expect(canActivateScenarioEvent(0, 0)).toBe(true)
  })
})
