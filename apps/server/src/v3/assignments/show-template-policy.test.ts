import { describe, expect, it } from "vitest"
import { parseScaleTemplatePackage, showMaximumEventImpactCount, showTemplatePolicy } from "@wurenji/shared"

describe("show template policy", () => {
  it.each([
    ["SHOW_100", 1, 1, 1],
    ["SHOW_500", 1, 2, 1],
    ["SHOW_1000", 2, 3, 2],
    ["SHOW_3000", 3, 4, 3],
    ["SHOW_5000", 4, 6, 3]
  ])("maps %s to the requirement event gradient", (code, minimum, maximum, concurrent) => {
    expect(showTemplatePolicy(code)).toMatchObject({
      eventCountRange: { minimum, maximum },
      maximumConcurrentEvents: concurrent
    })
  })

  it("opens random triggers and event links progressively", () => {
    expect(showTemplatePolicy("SHOW_100").allowedTriggerModes).not.toContain("TIME_RANGE")
    expect(showTemplatePolicy("SHOW_500").allowedTriggerModes).toContain("TIME_RANGE")
    expect(showTemplatePolicy("SHOW_500").eventLinksEnabled).toBe(false)
    expect(showTemplatePolicy("SHOW_1000").eventLinksEnabled).toBe(true)
    expect(showTemplatePolicy("SHOW_5000").partialVisibilityEnabled).toBe(true)
  })

  it("caps explicit affected counts by scope", () => {
    expect(showMaximumEventImpactCount(100, "SINGLE")).toBe(1)
    expect(showMaximumEventImpactCount(500, "SMALL_BATCH")).toBe(25)
    expect(showMaximumEventImpactCount(1000, "GROUP")).toBe(100)
    expect(showMaximumEventImpactCount(3000, "MOST")).toBe(1950)
  })

  it("hides legacy 5000-aircraft templates from the V1.0 catalog", () => {
    const [template] = parseScaleTemplatePackage({
      id: "scale-package",
      version: "1.0.0",
      manifest: {
        sceneType: "CITY_SHOW",
        templates: [{
          code: "SHOW_5000",
          title: "Legacy 5000",
          totalAircraft: 5000,
          defaultGroupCount: 1,
          eventCountRange: { minimum: 1, maximum: 99 },
          maximumConcurrentEvents: 99,
          allowedActions: ["PAUSE_PROGRAM"],
          aggregationLevel: "GROUP"
        }]
      }
    })

    expect(template).toBeUndefined()
  })
})
