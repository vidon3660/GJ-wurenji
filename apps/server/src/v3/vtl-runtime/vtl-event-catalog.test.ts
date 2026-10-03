import { describe, expect, it } from "vitest"
import { configuredVtlEvents, vtlActionDeadlineSeconds, vtlEventDefinitions } from "./vtl-event-catalog.js"

describe("VTL event catalog", () => {
  it("provides all eight teaching event categories", () => {
    const definitions = vtlEventDefinitions()
    expect(definitions).toHaveLength(8)
    expect(new Set(definitions.map((item) => item.category))).toEqual(new Set([
      "WEATHER",
      "POSITIONING",
      "COMMUNICATION",
      "ENERGY_POWER",
      "DEVICE",
      "MODE_TRANSITION",
      "ROUTE_AREA",
      "TASK_CONDITION"
    ]))
    expect(definitions.every((item) => item.recommendedActions.length > 0 && item.detectionDelayMs >= 0 && item.escalationDelayMs > 0)).toBe(true)
  })

  it("deduplicates configured events and applies trigger and severity overrides", () => {
    const configured = configuredVtlEvents([
      { code: "VTL_WEATHER", triggerTimeSeconds: 12, detectionDelaySeconds: 3, escalationDelaySeconds: 15, severity: "CRITICAL" },
      "VTL_WEATHER",
      { code: "VTL_DEVICE", triggerTimeSeconds: 20, targetIds: ["aircraft-1"] }
    ])
    expect(configured).toHaveLength(2)
    expect(configured[0]).toMatchObject({ code: "VTL_WEATHER", severity: "CRITICAL", scenarioConfig: { triggerTimeSeconds: 12, detectionDelaySeconds: 3, escalationDelaySeconds: 15 } })
    expect(configured[1]?.code).toBe("VTL_DEVICE")
  })

  it("uses the event escalation window as the default action deadline", () => {
    const energyEvent = vtlEventDefinitions().find((item) => item.code === "VTL_ENERGY_POWER")!
    expect(vtlActionDeadlineSeconds(energyEvent, null)).toBe(20)
    expect(vtlActionDeadlineSeconds(energyEvent, 12)).toBe(12)
  })
})
