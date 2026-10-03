import { describe, expect, it } from "vitest"
import type { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { buildPreflightItems, normalizePreflightCategories } from "./show-readiness.service.js"

describe("show initial conditions in preflight", () => {
  it("maps frozen weather, signal and device conditions to the required checks", () => {
    const items = buildPreflightItems(project("SHOW_3000", {
      showInitialConditions: {
        windDirection: "NW",
        windForceState: "OVER_LIMIT",
        gustState: "CONTINUOUS",
        rainState: "OVER_LIMIT",
        positioningElectromagneticState: "CONTINUOUS_INTERFERENCE",
        communicationControlState: "GROUP_ABNORMAL",
        deviceState: "FLIGHT_CONTROL_SENSOR_ABNORMAL",
        deviceImpactScope: "GROUP"
      }
    }))

    expect(item(items, "WIND_FORCE")).toMatchObject({ sourceStatus: "ABNORMAL", resolved: false })
    expect(item(items, "GUST")).toMatchObject({ sourceStatus: "ABNORMAL", resolved: false })
    expect(item(items, "RAIN")).toMatchObject({ sourceStatus: "ABNORMAL", resolved: false })
    expect(item(items, "POSITION_QUALITY")).toMatchObject({ sourceStatus: "ABNORMAL", resolved: false })
    expect(item(items, "EM_ENVIRONMENT")).toMatchObject({ sourceStatus: "ABNORMAL", resolved: false })
    expect(item(items, "CONTROL_LINK")).toMatchObject({ sourceStatus: "ABNORMAL", resolved: false })
    expect(item(items, "FLIGHT_CONTROL")).toMatchObject({ sourceStatus: "ABNORMAL", affectedCount: 100, resolved: false })
    expect(item(items, "SENSOR")).toMatchObject({ sourceStatus: "ABNORMAL", affectedCount: 100, resolved: false })
  })

  it("keeps legacy show snapshots deterministic", () => {
    const items = buildPreflightItems(project("SHOW_100", { windProfile: "GUST" }))
    expect(item(items, "GUST")).toMatchObject({ sourceStatus: "WARNING", resolved: false })
    expect(item(items, "WIND_FORCE")).toMatchObject({ sourceStatus: "NORMAL", resolved: true })
    expect(item(items, "CONTROL_LINK")).toMatchObject({ sourceStatus: "NORMAL", resolved: true })
  })

  it("projects new and legacy checks into the eight required categories", () => {
    const items = buildPreflightItems(project("SHOW_100", {}))
    expect(new Set(items.map((value) => value.category))).toEqual(new Set([
      "AIRCRAFT",
      "GROUND_SYSTEM",
      "POSITIONING",
      "COMMUNICATION",
      "WEATHER",
      "SITE_AREA",
      "PERSONNEL",
      "APPLICATION_SUPPORT"
    ]))

    const legacy = items.map((value) => ({
      ...value,
      category: ["POSITION_QUALITY", "RTK_BASE", "CONTROL_LINK", "DATA_LINK", "EM_ENVIRONMENT"].includes(value.code)
        ? "POSITIONING_COMMUNICATION"
        : ["SECURITY", "FIRE", "MEDICAL"].includes(value.code)
          ? "APPLICATION_SUPPORT"
          : value.category
    })) as unknown as typeof items
    const normalized = normalizePreflightCategories(legacy)
    expect(item(normalized, "POSITION_QUALITY")?.category).toBe("POSITIONING")
    expect(item(normalized, "CONTROL_LINK")?.category).toBe("COMMUNICATION")
    expect(item(normalized, "SECURITY")?.category).toBe("PERSONNEL")
  })
})

function item(items: ReturnType<typeof buildPreflightItems>, code: string) {
  return items.find((value) => value.code === code)
}

function project(scaleTemplateCode: string, scenario: Record<string, unknown>): StudentProjectEntity {
  return {
    snapshot: { config: { scaleTemplateCode, scenario } }
  } as unknown as StudentProjectEntity
}
