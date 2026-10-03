import { describe, expect, it } from "vitest"
import { inspectLogisticsRouteSpatialRelations, type LogisticsRouteInput, type V3RegionCatalogItem } from "@wurenji/shared"

describe("SCN-001/002 logistics spatial relations", () => {
  it("distinguishes centerline crossings from protection-area overlap", () => {
    const route = routeFixture()
    const region = regionFixture()

    const relations = inspectLogisticsRouteSpatialRelations(route, region)

    expect(relations.find((item) => item.featureId === "building")).toMatchObject({
      featureKind: "BUILDING",
      horizontalRelation: "CENTERLINE_CROSSING",
      segmentAltitudeMeters: 65,
      featureHeightMeters: 42,
      verticalClearanceMeters: 23,
      status: "RISK"
    })
    expect(relations.find((item) => item.featureId === "tower")).toMatchObject({
      featureKind: "OBSTACLE",
      horizontalRelation: "PROTECTION_OVERLAP",
      featureHeightMeters: 70,
      verticalClearanceMeters: -5,
      status: "CONFLICT"
    })
  })

  it("treats restricted-area protection overlap as a blocking relation", () => {
    const relations = inspectLogisticsRouteSpatialRelations(routeFixture(), regionFixture())

    expect(relations.find((item) => item.featureId === "restriction")).toMatchObject({
      featureKind: "RESTRICTION",
      horizontalRelation: "PROTECTION_OVERLAP",
      status: "CONFLICT"
    })
  })
})

function routeFixture(): LogisticsRouteInput {
  return {
    id: "route-1",
    name: "测试航线",
    destinationNodeId: "delivery",
    direction: "OUTBOUND",
    role: "PRIMARY",
    groupCode: "G1",
    departureNodeId: "takeoff",
    arrivalNodeId: "delivery",
    protectionRadiusMeters: 35,
    waitingNodeIds: [],
    alternateLandingNodeIds: [],
    emergencyAreaNodeIds: [],
    entryDirectionDegrees: 90,
    exitDirectionDegrees: 270,
    waypoints: [
      waypoint("start", 114, 22, 0, 65),
      waypoint("end", 114.01, 22, 0, 65)
    ]
  }
}

function waypoint(id: string, longitude: number, latitude: number, altitudeMeters: number, segmentAltitudeMeters: number) {
  return { id, name: id, position: { longitude, latitude }, altitudeMeters, segmentAltitudeMeters, speedMps: 12, nodeId: null, locked: false }
}

function regionFixture(): V3RegionCatalogItem {
  const emptyLayer = (code: V3RegionCatalogItem["layers"][number]["code"]) => ({ code, title: code, state: "AVAILABLE" as const, source: "test", version: "1", features: [] })
  return {
    packageId: "region",
    packageVersion: "1",
    checksum: "a".repeat(64),
    sceneType: "CITY_LOGISTICS",
    regionCode: "TEST",
    title: "测试区域",
    summary: "测试",
    center: { longitude: 114.005, latitude: 22 },
    boundary: [{ longitude: 113.99, latitude: 21.99 }, { longitude: 114.02, latitude: 21.99 }, { longitude: 114.02, latitude: 22.01 }],
    heightDatum: "AGL",
    terrainResourceVersion: "test",
    imageryState: "AVAILABLE",
    layers: [
      { ...emptyLayer("BUILDINGS"), features: [
        { id: "building", name: "教学楼", geometryType: "POLYGON", positions: rectangle(114.005, 22, 0.0002), heightMeters: 42, properties: { category: "BUILDING" } },
        { id: "tower", name: "塔杆", geometryType: "POINT", position: { longitude: 114.004, latitude: 22.00028 }, heightMeters: 70, properties: { category: "OBSTACLE", radiusMeters: 4 } }
      ] },
      { ...emptyLayer("RESTRICTIONS"), features: [
        { id: "restriction", name: "限飞区", geometryType: "POLYGON", positions: rectangle(114.007, 22.00025, 0.0001), properties: { category: "RESTRICTED" } }
      ] },
      emptyLayer("POSITIONING"),
      emptyLayer("COMMUNICATION"),
      emptyLayer("ENVIRONMENT")
    ]
  }
}

function rectangle(longitude: number, latitude: number, radius: number) {
  return [
    { longitude: longitude - radius, latitude: latitude - radius },
    { longitude: longitude + radius, latitude: latitude - radius },
    { longitude: longitude + radius, latitude: latitude + radius },
    { longitude: longitude - radius, latitude: latitude + radius }
  ]
}
