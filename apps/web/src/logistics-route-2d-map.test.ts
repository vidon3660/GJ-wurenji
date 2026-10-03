import { describe, expect, it } from "vitest"
import type { LogisticsRouteInput, V3RegionCatalogItem } from "@wurenji/shared"
import { buildLogisticsRoute2DFeatures, measureWgs84Bearing, measureWgs84Distance } from "./logistics-route-2d-map"

const region = {
  boundary: [{ longitude: 114, latitude: 22 }, { longitude: 114.1, latitude: 22 }, { longitude: 114.1, latitude: 22.1 }, { longitude: 114, latitude: 22.1 }],
  logisticsNodes: [
    { id: "center", code: "C", type: "CENTER_AIRPORT", name: "机场", geometryType: "POINT", position: { longitude: 114.01, latitude: 22.01 }, enabled: true, properties: {} },
    { id: "delivery", code: "D", type: "DELIVERY_POINT", name: "配送点", geometryType: "POINT", position: { longitude: 114.05, latitude: 22.05 }, enabled: true, properties: {} }
  ]
} as unknown as V3RegionCatalogItem
const route = { id: "route-1", waypoints: [{ id: "start", position: { longitude: 114.01, latitude: 22.01 } }, { id: "end", position: { longitude: 114.05, latitude: 22.05 } }] } as unknown as LogisticsRouteInput

describe("logistics 2D map model", () => {
  it("projects only visible nodes and route evidence into stable feature ids", () => {
    const features = buildLogisticsRoute2DFeatures({ region, visibleNodeTypes: ["DELIVERY_POINT"], selectedDeliveryPointIds: ["delivery"], routes: [route], selectedRouteId: "route-1", selectedWaypointId: "end", evidence: [{ code: "BOUNDARY", category: "SPATIAL", severity: "CONFLICT", blocking: true, message: "越界", routeIds: ["route-1"], waypointIds: [], segmentIndexes: [], position: { longitude: 114.06, latitude: 22.06 }, data: {} }] })
    expect(features.map((item) => item.id)).toEqual(["route-2d:boundary", "route-2d:node:delivery", "route-2d:route:route-1", "route-2d:waypoint:route-1:start", "route-2d:waypoint:route-1:end", "route-2d:evidence:0"])
    expect(features.at(-1)?.kind).toBe("alert")
  })

  it("calculates a stable WGS84 distance and bearing", () => {
    expect(measureWgs84Distance({ longitude: 114, latitude: 22 }, { longitude: 114.01, latitude: 22 })).toBeGreaterThan(1_000)
    expect(measureWgs84Bearing({ longitude: 114, latitude: 22 }, { longitude: 114, latitude: 22.01 })).toBeCloseTo(0)
  })
})
