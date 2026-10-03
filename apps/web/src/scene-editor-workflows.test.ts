import { describe, expect, it } from "vitest"
import { sceneEditorWorkflowFor } from "./scene-editor-workflows"

describe("scene editor workflows", () => {
  it("provides a distinct guided workflow for every scene", () => {
    const logistics = sceneEditorWorkflowFor("CITY_LOGISTICS")
    const show = sceneEditorWorkflowFor("CITY_SHOW")
    const vtol = sceneEditorWorkflowFor("VTOL_INSPECTION")

    expect(logistics.map((step) => step.id)).toEqual(["base", "network", "tasks", "limits", "routes", "publish"])
    expect(show.map((step) => step.id)).toEqual(["base", "areas", "points", "routes", "publish"])
    expect(vtol.map((step) => step.id)).toEqual(["base", "objects", "airfields", "limits", "routes", "publish"])
    expect(new Set(logistics.flatMap((step) => step.types))).toContain("DELIVERY_POINT")
    expect(new Set(show.flatMap((step) => step.types))).toContain("FLIGHT_CORRIDOR")
    expect(new Set(vtol.flatMap((step) => step.types))).toContain("ALTERNATE_LANDING_POINT")
  })

  it("keeps configuration-only concerns out of map object steps", () => {
    for (const sceneType of ["CITY_LOGISTICS", "CITY_SHOW", "VTOL_INSPECTION"] as const) {
      const types = sceneEditorWorkflowFor(sceneType).flatMap((step) => step.types) as readonly string[]
      expect(types).not.toContain("POSITIONING")
      expect(types).not.toContain("COMMUNICATION")
      expect(types).not.toContain("ENVIRONMENT")
    }
  })
})
