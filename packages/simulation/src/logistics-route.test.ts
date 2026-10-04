import { describe, expect, it } from "vitest"
import type { LogisticsAircraftCapabilityView, LogisticsRouteInput, V3RegionCatalogItem } from "@wurenji/shared"
import { checkLogisticsRoutePlan, simulateLogisticsRoundTrips } from "./logistics-route.js"
import { inspectLogisticsRouteSpatialRelations } from "@wurenji/shared"

describe("logistics route rules and round-trip simulation", () => {
  it("accepts a complete student-authored round trip and produces deterministic metrics", () => {
    const region = fixtureRegion()
    const routes = fixtureRoutes(region)
    const context = { region, selectedDeliveryPointIds: ["delivery-1"], aircraft }

    const check = checkLogisticsRoutePlan(routes, context, new Date("2026-08-12T00:00:00Z"))
    const first = simulateLogisticsRoundTrips(routes, context, "fixed-seed", new Date("2026-08-12T00:00:00Z"))
    const second = simulateLogisticsRoundTrips(routes, context, "fixed-seed", new Date("2026-08-12T00:00:00Z"))

    expect(check.passed).toBe(true)
    expect(first.status).toBe("PASSED")
    expect(first.completedRoundTripCount).toBe(1)
    expect(first.routeMetrics).toEqual(second.routeMetrics)
    expect(first.aircraftModelCode).toBe(aircraft.modelCode)
    expect(first.aircraftRuleVersion).toBe(aircraft.ruleVersion)
    expect(first.roundTripMetrics[0]?.milestones?.map((item) => item.code)).toEqual([
      "AIRPORT_TAKEOFF",
      "OUTBOUND_FLIGHT",
      "ARRIVAL_CONFIRMATION",
      "RETURN_FLIGHT",
      "AIRPORT_LANDING"
    ])
    expect(first.roundTripMetrics[0]?.milestones?.map((item) => item.simulatedAtSeconds)).toEqual(
      [...first.roundTripMetrics[0]!.milestones!.map((item) => item.simulatedAtSeconds)].sort((left, right) => left - right)
    )
    expect(first.roundTripMetrics[0]?.milestones?.map((item) => item.remainingBatteryPercent)).toEqual(
      [...first.roundTripMetrics[0]!.milestones!.map((item) => item.remainingBatteryPercent)].sort((left, right) => right - left)
    )
    expect(first.roundTripMetrics[0]?.milestones?.at(-1)).toMatchObject({
      remainingBatteryPercent: first.roundTripMetrics[0]?.remainingBatteryPercent,
      position: region.logisticsNodes?.find((node) => node.id === "landing")?.position
    })
    expect(first.evidence.every((item) => item.routeIds.length === 0 || typeof item.simulatedAtSeconds === "number")).toBe(true)
  })

  it("blocks missing return routes and restricted-area crossings without generating an alternative", () => {
    const region = fixtureRegion()
    const routes = fixtureRoutes(region).slice(0, 1)
    routes[0]!.waypoints.splice(1, 0, waypoint("danger", 114.004, 22, 35))

    const result = checkLogisticsRoutePlan(routes, { region, selectedDeliveryPointIds: ["delivery-1"], aircraft })

    expect(result.passed).toBe(false)
    expect(result.evidence.map((item) => item.code)).toEqual(expect.arrayContaining(["ROUND_TRIP_PAIR_INCOMPLETE", "RESTRICTED_AREA_CROSSING"]))
    expect(result.evidence.every((item) => !("suggestedWaypoints" in item.data))).toBe(true)

    const validation = simulateLogisticsRoundTrips(routes, { region, selectedDeliveryPointIds: ["delivery-1"], aircraft }, "problem-location")
    expect(validation.evidence.find((item) => item.code === "RESTRICTED_AREA_CROSSING")).toMatchObject({
      routeIds: ["outbound"],
      segmentIndexes: [0],
      simulatedAtSeconds: expect.any(Number),
      data: {
        routeDirection: "OUTBOUND",
        segmentNumber: 1,
        segmentAltitudeMeters: 45,
        speedMps: 12,
        routeDistanceMeters: expect.any(Number),
        routeFlightTimeSeconds: expect.any(Number)
      }
    })
    expect(validation.evidence.every((item) => !("suggestedWaypoints" in item.data))).toBe(true)
  })

  it("rejects running nodes assigned to the wrong operational role", () => {
    const region = fixtureRegion()
    const routes = fixtureRoutes(region)
    routes[0]!.waitingNodeIds = ["delivery-1"]
    routes[0]!.alternateLandingNodeIds = ["waiting"]
    routes[0]!.emergencyAreaNodeIds = ["alternate"]

    const result = checkLogisticsRoutePlan(routes, { region, selectedDeliveryPointIds: ["delivery-1"], aircraft })
    const invalidTypes = result.evidence.filter((item) => item.code.endsWith("_TYPE_INVALID"))

    expect(result.passed).toBe(false)
    expect(invalidTypes).toHaveLength(3)
    expect(invalidTypes.map((item) => item.code)).toEqual(expect.arrayContaining([
      "WAITING_NODE_TYPE_INVALID",
      "ALTERNATE_NODE_TYPE_INVALID",
      "EMERGENCY_AREA_TYPE_INVALID"
    ]))
    expect(invalidTypes.map((item) => item.data.expectedType)).toEqual(expect.arrayContaining([
      "WAITING_POINT",
      "ALTERNATE_LANDING_POINT",
      "EMERGENCY_AREA"
    ]))
  })

  it("locates a non-blocking segment near the aircraft height limit", () => {
    const region = fixtureRegion()
    const routes = fixtureRoutes(region)
    routes[0]!.waypoints[1]!.segmentAltitudeMeters = 115

    const result = simulateLogisticsRoundTrips(routes, { region, selectedDeliveryPointIds: ["delivery-1"], aircraft }, "height-margin")
    const issue = result.evidence.find((item) => item.code === "SEGMENT_HEIGHT_MARGIN_LOW")

    expect(result.status).toBe("WITH_RISK")
    expect(issue).toMatchObject({
      severity: "RISK",
      blocking: false,
      routeIds: ["outbound"],
      segmentIndexes: [1],
      simulatedAtSeconds: expect.any(Number),
      data: {
        segmentNumber: 2,
        segmentAltitudeMeters: 115,
        maximumHeightMeters: 120,
        heightMarginMeters: 5,
        speedMps: 12
      }
    })
    expect(issue?.data).not.toHaveProperty("suggestedWaypoints")
  })

  it("records every STU-011 check category even when a category has no evidence", () => {
    const region = fixtureRegion()
    const result = checkLogisticsRoutePlan(fixtureRoutes(region), { region, selectedDeliveryPointIds: ["delivery-1"], aircraft })

    expect(result.categorySummaries?.map((item) => item.category)).toEqual([
      "SPATIAL",
      "AIRCRAFT",
      "COVERAGE",
      "NODES",
      "ROUTE_RELATION",
      "EFFICIENCY"
    ])
    expect(result.categorySummaries?.find((item) => item.category === "COVERAGE")).toMatchObject({ checked: true, passed: true, evidenceCount: 0 })
    expect(result.categorySummaries?.find((item) => item.category === "NODES")).toMatchObject({ checked: true, passed: true, evidenceCount: 0 })
  })

  it("checks point obstacles against the route protection area and segment altitude", () => {
    const region = fixtureRegion()
    region.layers.find((layer) => layer.code === "BUILDINGS")!.features.push({
      id: "tower",
      name: "通信塔杆",
      geometryType: "POINT",
      position: { longitude: 114.001, latitude: 22.00322 },
      heightMeters: 60,
      properties: { category: "OBSTACLE", radiusMeters: 4 }
    })
    const routes = fixtureRoutes(region)

    const result = checkLogisticsRoutePlan(routes, { region, selectedDeliveryPointIds: ["delivery-1"], aircraft })
    const obstacle = result.evidence.find((item) => item.code === "OBSTACLE_CLEARANCE_CONFLICT")

    expect(obstacle).toMatchObject({
      category: "SPATIAL",
      severity: "CONFLICT",
      routeIds: ["outbound"],
      segmentIndexes: [0],
      data: {
        featureKind: "OBSTACLE",
        horizontalRelation: "PROTECTION_OVERLAP",
        featureHeightMeters: 60,
        segmentAltitudeMeters: 45,
        clearanceMeters: -15,
        protectionRadiusMeters: 30
      }
    })
  })

  it("uses the lowest endpoint altitude when a segment descends across a building", () => {
    const region = fixtureRegion()
    region.layers.find((layer) => layer.code === "BUILDINGS")!.features.push({
      id: "tower-descending",
      name: "下降航段障碍物",
      geometryType: "POINT",
      position: { longitude: 114.001, latitude: 22.00322 },
      heightMeters: 60,
      properties: { category: "OBSTACLE", radiusMeters: 4 }
    })
    const route = fixtureRoutes(region)[0]!
    route.waypoints[0]!.segmentAltitudeMeters = 100
    route.waypoints[1]!.segmentAltitudeMeters = 20
    const relation = inspectLogisticsRouteSpatialRelations(route, region).find((item) => item.featureId === "tower-descending")
    expect(relation).toMatchObject({ verticalClearanceMeters: -40, endSegmentAltitudeMeters: 20, status: "CONFLICT" })
  })
})

const aircraft: LogisticsAircraftCapabilityView = {
  modelCode: "TEACHING-UAV-01",
  cruiseSpeedMps: 12,
  maximumSpeedMps: 18,
  maximumHeightMeters: 120,
  maximumRoundTripMeters: 12_000,
  minimumReserveBatteryPercent: 20,
  climbRateMps: 3,
  ruleVersion: "LOGISTICS-ROUTE-1.0.0"
}

function fixtureRegion(): V3RegionCatalogItem {
  const emptyLayer = (code: V3RegionCatalogItem["layers"][number]["code"]) => ({ code, title: code, state: "AVAILABLE" as const, source: "test", version: "1", features: [] })
  return {
    packageId: "region",
    packageVersion: "1",
    checksum: "a".repeat(64),
    sceneType: "CITY_LOGISTICS",
    regionCode: "LOG-TEST",
    title: "测试区域",
    summary: "测试",
    center: { longitude: 114, latitude: 22 },
    boundary: [{ longitude: 113.98, latitude: 21.98 }, { longitude: 114.02, latitude: 21.98 }, { longitude: 114.02, latitude: 22.02 }, { longitude: 113.98, latitude: 22.02 }],
    heightDatum: "AGL",
    terrainResourceVersion: "dem",
    imageryState: "AVAILABLE",
    layers: [
      emptyLayer("BUILDINGS"),
      { ...emptyLayer("RESTRICTIONS"), features: [{ id: "restriction", name: "限制区", geometryType: "POLYGON", positions: [{ longitude: 114.0035, latitude: 21.9995 }, { longitude: 114.0045, latitude: 21.9995 }, { longitude: 114.0045, latitude: 22.0005 }, { longitude: 114.0035, latitude: 22.0005 }], properties: {} }] },
      emptyLayer("POSITIONING"),
      emptyLayer("COMMUNICATION"),
      emptyLayer("ENVIRONMENT")
    ],
    logisticsNodes: [
      { id: "airport", code: "APT", type: "CENTER_AIRPORT", name: "机场", geometryType: "POLYGON", positions: [{ longitude: 113.999, latitude: 21.999 }, { longitude: 114.001, latitude: 21.999 }, { longitude: 114.001, latitude: 22.001 }], enabled: true, properties: {} },
      { id: "takeoff", code: "TO", type: "TAKEOFF_POINT", name: "起飞", geometryType: "POINT", position: { longitude: 114, latitude: 22 }, enabled: true, properties: {} },
      { id: "landing", code: "LD", type: "LANDING_POINT", name: "降落", geometryType: "POINT", position: { longitude: 114, latitude: 22 }, enabled: true, properties: {} },
      { id: "parking", code: "PK", type: "PARKING_POINT", name: "停放", geometryType: "POINT", position: { longitude: 114, latitude: 22 }, enabled: true, properties: {} },
      { id: "delivery-1", code: "DP1", type: "DELIVERY_POINT", name: "配送点", geometryType: "POINT", position: { longitude: 114.01, latitude: 22.005 }, enabled: true, properties: {} },
      { id: "waiting", code: "W1", type: "WAITING_POINT", name: "等待点", geometryType: "POINT", position: { longitude: 114.002, latitude: 22.003 }, enabled: true, properties: {} },
      { id: "alternate", code: "A1", type: "ALTERNATE_LANDING_POINT", name: "备降点", geometryType: "POINT", position: { longitude: 114.003, latitude: 22.004 }, enabled: true, properties: {} },
      { id: "emergency", code: "E1", type: "EMERGENCY_AREA", name: "应急区", geometryType: "POLYGON", positions: [{ longitude: 114.001, latitude: 22.002 }, { longitude: 114.002, latitude: 22.002 }, { longitude: 114.002, latitude: 22.003 }], enabled: true, properties: {} }
    ]
  }
}

function fixtureRoutes(region: V3RegionCatalogItem): LogisticsRouteInput[] {
  const takeoff = region.logisticsNodes!.find((node) => node.id === "takeoff")!.position!
  const landing = region.logisticsNodes!.find((node) => node.id === "landing")!.position!
  const delivery = region.logisticsNodes!.find((node) => node.id === "delivery-1")!.position!
  return [
    route("outbound", "OUTBOUND", "takeoff", "delivery-1", [waypoint("out-start", takeoff.longitude, takeoff.latitude, 0), waypoint("out-mid", 114.002, 22.006, 45), waypoint("out-end", delivery.longitude, delivery.latitude, 0)]),
    route("return", "RETURN", "delivery-1", "landing", [waypoint("return-start", delivery.longitude, delivery.latitude, 0), waypoint("return-mid", 114.008, 22.009, 50), waypoint("return-end", landing.longitude, landing.latitude, 0)])
  ]
}

function route(id: string, direction: "OUTBOUND" | "RETURN", departureNodeId: string, arrivalNodeId: string, waypoints: LogisticsRouteInput["waypoints"]): LogisticsRouteInput {
  return { id, name: id, destinationNodeId: "delivery-1", direction, role: "PRIMARY", groupCode: "G1", departureNodeId, arrivalNodeId, protectionRadiusMeters: 30, waitingNodeIds: ["waiting"], alternateLandingNodeIds: ["alternate"], emergencyAreaNodeIds: ["emergency"], entryDirectionDegrees: 90, exitDirectionDegrees: 270, waypoints }
}

function waypoint(id: string, longitude: number, latitude: number, altitudeMeters: number) {
  return { id, name: id, position: { longitude, latitude }, altitudeMeters, segmentAltitudeMeters: 45, speedMps: 12, nodeId: null, locked: false }
}
