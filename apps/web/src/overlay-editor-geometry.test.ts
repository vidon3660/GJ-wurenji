import { describe, expect, it } from "vitest"
import type { V3ScenarioOverlayObject } from "@wurenji/shared"
import { moveOverlayObjectVertex } from "./overlay-editor-geometry"

const point = (id = "p"): V3ScenarioOverlayObject => ({ id, code: id, name: id, type: "TASK_POINT", geometryType: "POINT", geometry: { type: "Point", coordinates: [1, 2, 10] }, properties: {} })

describe("overlay editor geometry", () => {
  it("moves point objects and retains altitude", () => {
    const moved = moveOverlayObjectVertex(point(), { longitude: 3, latitude: 4, altitudeMeters: 25 }, null)
    expect(moved?.geometry).toEqual({ type: "Point", coordinates: [3, 4, 25] })
    expect(moved?.position?.altitudeMeters).toBe(25)
  })

  it("moves line vertices", () => {
    const line = { ...point("line"), geometryType: "LINESTRING", geometry: { type: "LineString", coordinates: [[1, 2], [3, 4]] } } as V3ScenarioOverlayObject
    const moved = moveOverlayObjectVertex(line, { longitude: 5, latitude: 6, altitudeMeters: 8 }, 1)
    expect(moved?.geometry).toEqual({ type: "LineString", coordinates: [[1, 2], [5, 6, 8]] })
  })

  it("keeps polygon rings closed when moving the first vertex", () => {
    const polygon = { ...point("poly"), geometryType: "POLYGON", geometry: { type: "Polygon", coordinates: [[[1, 2], [4, 2], [4, 5], [1, 2]]] } } as V3ScenarioOverlayObject
    const moved = moveOverlayObjectVertex(polygon, { longitude: 2, latitude: 3 }, 0)
    expect(moved?.geometry).toEqual({ type: "Polygon", coordinates: [[[2, 3], [4, 2], [4, 5], [2, 3]]] })
  })
})
