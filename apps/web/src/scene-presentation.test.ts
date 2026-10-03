import { describe, expect, it } from "vitest"
import { v3SceneClass, v3SceneLabel, v3ScenePresentation, v3SceneShortLabel, v3SceneTypes } from "./scene-presentation"

describe("v3 scene presentation", () => {
  it("exposes all three teaching scenes in a stable order", () => {
    expect(v3SceneTypes).toEqual(["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"])
    expect(v3ScenePresentation.VTOL_INSPECTION).toMatchObject({
      code: "VTOL",
      label: "垂起广域巡检",
      shortLabel: "巡检",
      className: "vtl"
    })
  })

  it("keeps VTL labels and style classes consistent", () => {
    expect(v3SceneLabel("VTOL_INSPECTION")).toBe("垂起广域巡检")
    expect(v3SceneShortLabel("VTOL_INSPECTION")).toBe("巡检")
    expect(v3SceneClass("VTOL_INSPECTION")).toBe("vtl")
  })
})
