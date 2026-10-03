import { describe, expect, it } from "vitest"
import type { V3ScenarioOverlayObject } from "@wurenji/shared"
import { validateScenarioOverlayDraft } from "./scenario-overlay-validation"

const boundary = [{ longitude: 0, latitude: 0 }, { longitude: 10, latitude: 0 }, { longitude: 10, latitude: 10 }, { longitude: 0, latitude: 10 }]
const point = (id: string, longitude = 1, latitude = 1): V3ScenarioOverlayObject => ({ id, code: id, name: id, type: "TASK_POINT", geometryType: "POINT", geometry: { type: "Point", coordinates: [longitude, latitude] }, properties: {} })

describe("scenario overlay draft validation", () => {
  it("accepts typed points inside the base boundary", () => expect(validateScenarioOverlayDraft("demo", [point("p1")], boundary).valid).toBe(true))
  it("rejects invalid coordinate ranges and outside points", () => {
    expect(validateScenarioOverlayDraft("demo", [point("p1", 11)], boundary)).toMatchObject({ valid: false })
    expect(validateScenarioOverlayDraft("demo", [point("p2", 200)], boundary).errors[0]).toContain("无效坐标")
  })
  it("requires closed, non self-intersecting polygons", () => {
    const polygon = (coordinates: [number, number][]): V3ScenarioOverlayObject => ({ id: "poly", code: "poly", name: "poly", type: "EVENT_AREA", geometryType: "POLYGON", geometry: { type: "Polygon", coordinates: [coordinates] }, properties: {} })
    expect(validateScenarioOverlayDraft("demo", [polygon([[1, 1], [4, 1], [4, 4], [1, 1]])], boundary).valid).toBe(true)
    expect(validateScenarioOverlayDraft("demo", [polygon([[1, 1], [4, 4], [1, 4], [4, 1], [1, 1]])], boundary).errors.join(" ")).toContain("自相交")
  })
})
