import { describe, expect, it } from "vitest"
import { logisticsTemplatePolicy, parseScaleTemplatePackage } from "@wurenji/shared"

describe("logistics template policy", () => {
  it.each([
    ["LOGISTICS_3", 0, 0, 0],
    ["LOGISTICS_5", 0, 0, 0],
    ["LOGISTICS_10", 0, 1, 1],
    ["LOGISTICS_20", 0, 1, 1],
    ["LOGISTICS_50", 2, 4, 3]
  ])("maps %s to the requirement event gradient", (code, minimum, maximum, concurrent) => {
    expect(logisticsTemplatePolicy(code)).toMatchObject({
      eventCountRange: { minimum, maximum },
      maximumConcurrentEvents: concurrent
    })
  })

  it("opens release modes, priorities and event capabilities progressively", () => {
    expect(logisticsTemplatePolicy("LOGISTICS_3").allowedPriorityProfiles).toEqual(["STANDARD_HEAVY"])
    expect(logisticsTemplatePolicy("LOGISTICS_5").allowedReleaseModes).toContain("AT_PHASE")
    expect(logisticsTemplatePolicy("LOGISTICS_10").allowedReleaseModes).toContain("DYNAMIC")
    expect(logisticsTemplatePolicy("LOGISTICS_20").allowedEventCodes).toContain("ROUTE_SUSPENDED")
    expect(logisticsTemplatePolicy("LOGISTICS_20").allowedEventSubtypes).toContain("RETURN_OR_LANDING_UNAVAILABLE")
    expect(logisticsTemplatePolicy("LOGISTICS_20").allowedEventSubtypes).not.toContain("WAITING_POINT_STATE_CHANGE")
    expect(logisticsTemplatePolicy("LOGISTICS_50").allowedEventSubtypes).toContain("ALTERNATE_LANDING_POINT_STATE_CHANGE")
    expect(logisticsTemplatePolicy("LOGISTICS_50")).toMatchObject({ eventLinksEnabled: true, partialVisibilityEnabled: true, globalReschedulingEnabled: true })
  })

  it.each([
    ["LOGISTICS_3", "NONE"],
    ["LOGISTICS_5", "NONE"],
    ["LOGISTICS_10", "LIMITED"],
    ["LOGISTICS_20", "FULL"],
    ["LOGISTICS_50", "FULL"]
  ] as const)("opens the required initial batch-scheduling level for %s", (code, batchSchedulingMode) => {
    expect(logisticsTemplatePolicy(code).batchSchedulingMode).toBe(batchSchedulingMode)
  })

  it("overrides legacy detailed-template event gradients with the authoritative policy", () => {
    const [template] = parseScaleTemplatePackage({
      id: "scale-package",
      version: "1.0.0",
      manifest: {
        sceneType: "CITY_LOGISTICS",
        templates: [{
          code: "LOGISTICS_3",
          title: "Legacy logistics 3",
          totalAircraft: 3,
          defaultGroupCount: 3,
          eventCountRange: { minimum: 1, maximum: 99 },
          maximumConcurrentEvents: 99,
          allowedActions: ["GLOBAL_RESCHEDULE"],
          aggregationLevel: "UNIT"
        }]
      }
    })

    expect(template).toMatchObject({
      eventCountRange: { minimum: 0, maximum: 0 },
      maximumConcurrentEvents: 0
    })
  })
})
