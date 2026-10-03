import { describe, expect, it } from "vitest"
import type { LogisticsRouteInput, V3LogisticsNode } from "@wurenji/shared"
import { createPrimaryRouteSkeleton, hasPrimaryRoute } from "./logistics-route-creation"

const takeoff = node("airport-takeoff", "机场起飞点", 113.91, 22.51, "TAKEOFF_POINT")
const landing = node("airport-landing", "机场降落点", 113.92, 22.52, "LANDING_POINT")
const destination = node("delivery-01", "配送点 01", 114.01, 22.61, "DELIVERY_POINT")

describe("STU-007 logistics route creation", () => {
  it("creates an outbound primary skeleton from takeoff to destination", () => {
    const route = createPrimaryRouteSkeleton({
      id: "outbound-01",
      direction: "OUTBOUND",
      destination,
      takeoff,
      landing,
      groupCode: "G-01",
      cruiseSpeedMps: 12
    })

    expect(route.destinationNodeId).toBe(destination.id)
    expect(route.direction).toBe("OUTBOUND")
    expect(route.role).toBe("PRIMARY")
    expect(route.departureNodeId).toBe(takeoff.id)
    expect(route.arrivalNodeId).toBe(destination.id)
    expect(route.waypoints.map((waypoint) => waypoint.nodeId)).toEqual([takeoff.id, destination.id])
  })

  it("creates a return primary skeleton from destination to landing", () => {
    const route = createPrimaryRouteSkeleton({
      id: "return-01",
      direction: "RETURN",
      destination,
      takeoff,
      landing,
      groupCode: "G-01",
      cruiseSpeedMps: 12
    })

    expect(route.destinationNodeId).toBe(destination.id)
    expect(route.direction).toBe("RETURN")
    expect(route.role).toBe("PRIMARY")
    expect(route.departureNodeId).toBe(destination.id)
    expect(route.arrivalNodeId).toBe(landing.id)
    expect(route.waypoints.map((waypoint) => waypoint.nodeId)).toEqual([destination.id, landing.id])
  })

  it("detects an existing formal direction without counting alternates", () => {
    const primary = createPrimaryRouteSkeleton({
      id: "outbound-primary",
      direction: "OUTBOUND",
      destination,
      takeoff,
      landing,
      groupCode: "G-01",
      cruiseSpeedMps: 12
    })
    const alternate: LogisticsRouteInput = { ...primary, id: "outbound-alternate", role: "ALTERNATE" }

    expect(hasPrimaryRoute([alternate], destination.id, "OUTBOUND")).toBe(false)
    expect(hasPrimaryRoute([alternate, primary], destination.id, "OUTBOUND")).toBe(true)
    expect(hasPrimaryRoute([alternate, primary], destination.id, "RETURN")).toBe(false)
  })
})

function node(
  id: string,
  name: string,
  longitude: number,
  latitude: number,
  type: V3LogisticsNode["type"]
): V3LogisticsNode {
  return {
    id,
    code: id.toUpperCase(),
    type,
    name,
    geometryType: "POINT",
    position: { longitude, latitude },
    enabled: true,
    properties: {}
  }
}
