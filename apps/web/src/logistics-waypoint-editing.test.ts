import { describe, expect, it } from "vitest"
import type { LogisticsRouteInput } from "@wurenji/shared"
import {
  deleteIntermediateWaypoint,
  hasFollowingSegment,
  insertIntermediateWaypoint,
  moveIntermediateWaypoint
} from "./logistics-waypoint-editing"

describe("STU-008 logistics waypoint editing", () => {
  it("inserts a student waypoint before the fixed arrival endpoint", () => {
    const route = routeFixture()
    const waypoint = insertIntermediateWaypoint(route, {
      id: "middle-1",
      position: { longitude: 114.05, latitude: 22.55 },
      cruiseSpeedMps: 12
    })

    expect(route.waypoints.map((item) => item.id)).toEqual(["start", "middle-1", "end"])
    expect(waypoint).toMatchObject({
      altitudeMeters: 40,
      segmentAltitudeMeters: 40,
      speedMps: 12,
      nodeId: null,
      locked: false
    })
  })

  it("moves and deletes only unlocked intermediate waypoints", () => {
    const route = routeFixture()
    insertIntermediateWaypoint(route, {
      id: "middle-1",
      position: { longitude: 114.05, latitude: 22.55 },
      cruiseSpeedMps: 12
    })

    expect(moveIntermediateWaypoint(route, "start", { longitude: 120, latitude: 30 })).toBe(false)
    expect(moveIntermediateWaypoint(route, "middle-1", { longitude: 114.06, latitude: 22.56 })).toBe(true)
    expect(route.waypoints[1]?.position).toEqual({ longitude: 114.06, latitude: 22.56 })
    expect(deleteIntermediateWaypoint(route, "end")).toBe(false)
    expect(deleteIntermediateWaypoint(route, "middle-1")).toBe(true)
    expect(route.waypoints.map((item) => item.id)).toEqual(["start", "end"])
  })

  it("exposes segment height only when a following segment exists", () => {
    const route = routeFixture()

    expect(hasFollowingSegment(route, "start")).toBe(true)
    expect(hasFollowingSegment(route, "end")).toBe(false)
    expect(hasFollowingSegment(route, "missing")).toBe(false)
  })
})

function routeFixture(): LogisticsRouteInput {
  return {
    id: "route-1",
    name: "测试航线",
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
      waypoint("start", "takeoff", 114, 22, true),
      waypoint("end", "delivery-1", 114.1, 22.1, true)
    ]
  }
}

function waypoint(id: string, nodeId: string, longitude: number, latitude: number, locked: boolean) {
  return {
    id,
    name: id,
    position: { longitude, latitude },
    altitudeMeters: 0,
    segmentAltitudeMeters: 40,
    speedMps: 12,
    nodeId,
    locked
  }
}
