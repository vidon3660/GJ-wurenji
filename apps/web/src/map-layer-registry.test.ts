import { describe, expect, it } from "vitest"
import {
  editableMapLayersForScene,
  getMapLayerDefinition,
  isRegisteredRegionLayer,
  mapLayerDefinitions,
  mapLayersForScene
} from "./map-layer-registry"

describe("map layer registry", () => {
  it("uses one shared definition for base layers across all scenes", () => {
    const baseCodes = mapLayersForScene("CITY_SHOW", "BASE").map((layer) => layer.code)
    expect(mapLayersForScene("CITY_LOGISTICS", "BASE").map((layer) => layer.code)).toEqual(baseCodes)
    expect(mapLayersForScene("VTOL_INSPECTION", "BASE").map((layer) => layer.code)).toEqual(baseCodes)
    expect(baseCodes).toEqual(expect.arrayContaining(["BUILDINGS", "WATER", "GREENLAND"]))
  })

  it("limits editable overlays to the scene that owns them", () => {
    expect(editableMapLayersForScene("CITY_SHOW").map((layer) => layer.code)).toEqual([
      "RESTRICTIONS", "ROUTES", "WAYPOINTS", "SHOW_ZONES"
    ])
    expect(editableMapLayersForScene("CITY_LOGISTICS").map((layer) => layer.code)).toContain("OBSTACLES")
    expect(editableMapLayersForScene("CITY_LOGISTICS").map((layer) => layer.code)).not.toContain("SHOW_ZONES")
  })

  it("keeps legacy region layers discoverable without exposing runtime config layers", () => {
    expect(getMapLayerDefinition("BUILDINGS")?.kind).toBe("BASE")
    expect(getMapLayerDefinition("WATER")?.geometryTypes).toContain("LINESTRING")
    expect(isRegisteredRegionLayer("GREENLAND")).toBe(true)
    expect(isRegisteredRegionLayer("POSITIONING")).toBe(false)
    expect(mapLayerDefinitions.map((layer) => layer.order)).toEqual([...mapLayerDefinitions].sort((a, b) => a.order - b.order).map((layer) => layer.order))
  })
})

