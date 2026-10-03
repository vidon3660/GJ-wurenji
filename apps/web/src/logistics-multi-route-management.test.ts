import { describe, expect, it } from "vitest"
import type { LogisticsRouteInput } from "@wurenji/shared"
import { applyBatchRouteHeight, parseBatchRouteHeight } from "./logistics-multi-route-management"

describe("STU-010 logistics multi-route management", () => {
  it("validates batch height against the frozen aircraft capability", () => {
    expect(parseBatchRouteHeight("20", 80)).toBe(20)
    expect(parseBatchRouteHeight("80", 80)).toBe(80)
    expect(parseBatchRouteHeight("81", 80)).toBeNull()
    expect(parseBatchRouteHeight("40.5", 80)).toBeNull()
  })

  it("updates all segments and only unlocked waypoint altitudes", () => {
    const routes = [routeFixture("route-1"), routeFixture("route-2")]

    applyBatchRouteHeight(routes, 65)

    expect(routes.flatMap((route) => route.waypoints.map((waypoint) => waypoint.altitudeMeters))).toEqual([0, 65, 0, 0, 65, 0])
    expect(routes.flatMap((route) => route.waypoints.map((waypoint) => waypoint.segmentAltitudeMeters))).toEqual([65, 65, 40, 65, 65, 40])
  })
})

function routeFixture(id: string): LogisticsRouteInput {
  return {
    id,
    name: id,
    destinationNodeId: "delivery-1",
    direction: "OUTBOUND",
    role: "PRIMARY",
    groupCode: "G-01",
    departureNodeId: "takeoff",
    arrivalNodeId: "delivery-1",
    protectionRadiusMeters: 30,
    waitingNodeIds: [],
    alternateLandingNodeIds: [],
    emergencyAreaNodeIds: [],
    entryDirectionDegrees: 0,
    exitDirectionDegrees: 0,
    waypoints: [
      waypoint(`${id}-start`, true),
      waypoint(`${id}-middle`, false),
      waypoint(`${id}-end`, true)
    ]
  }
}

function waypoint(id: string, locked: boolean) {
  return {
    id,
    name: id,
    position: { longitude: 114, latitude: 22 },
    altitudeMeters: 0,
    segmentAltitudeMeters: 40,
    speedMps: 12,
    nodeId: locked ? id : null,
    locked
  }
}
