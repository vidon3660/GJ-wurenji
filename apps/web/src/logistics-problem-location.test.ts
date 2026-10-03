import { describe, expect, it } from "vitest"
import type { LogisticsRouteCheckEvidence, LogisticsRouteInput, LogisticsRouteMetricView } from "@wurenji/shared"
import { logisticsProblemLocation } from "./logistics-problem-location"

describe("logistics validation problem location", () => {
  it("projects problem type, segment, simulated time and runtime data", () => {
    const result = logisticsProblemLocation(evidence(), [route()], [metric()])

    expect(result).toMatchObject({
      problemType: "空间与障碍 · BUILDING_CLEARANCE_CONFLICT",
      routeLabel: "北区去程 · 去程",
      segmentLabel: "第 2 航段 · 中间点 -> 配送点",
      simulatedAtLabel: "T+01:36",
      positionLabel: "114.074000, 22.692000"
    })
    expect(result.runtimeData).toEqual(expect.arrayContaining([
      { key: "segmentAltitudeMeters", label: "航段高度", value: "45.0 m" },
      { key: "speedMps", label: "规划速度", value: "12.0 m/s" },
      { key: "routeDistanceMeters", label: "航线航程", value: "1350.0 m" }
    ]))
  })

  it("does not invent a route or optimized waypoint for project-level evidence", () => {
    const result = logisticsProblemLocation({ ...evidence(), routeIds: [], segmentIndexes: [], waypointIds: [], position: null, simulatedAtSeconds: null, data: {} }, [route()])

    expect(result.routeLabel).toBe("项目级检查")
    expect(result.segmentLabel).toBe("整条航线 / 运行节点")
    expect(result.simulatedAtLabel).toBe("检查时刻")
    expect(result.runtimeData).toEqual([])
    expect(JSON.stringify(result)).not.toContain("suggested")
  })
})

function evidence(): LogisticsRouteCheckEvidence {
  return {
    code: "BUILDING_CLEARANCE_CONFLICT",
    category: "SPATIAL",
    severity: "CONFLICT",
    blocking: true,
    message: "第二航段净空不足",
    routeIds: ["route-1"],
    waypointIds: ["mid", "end"],
    segmentIndexes: [1],
    position: { longitude: 114.074, latitude: 22.692 },
    simulatedAtSeconds: 96,
    data: { segmentAltitudeMeters: 45, speedMps: 12, clearanceMeters: -3 }
  }
}

function route(): LogisticsRouteInput {
  return {
    id: "route-1",
    name: "北区去程",
    destinationNodeId: "delivery-1",
    direction: "OUTBOUND",
    role: "PRIMARY",
    groupCode: "G1",
    departureNodeId: "takeoff",
    arrivalNodeId: "delivery-1",
    protectionRadiusMeters: 30,
    waitingNodeIds: [],
    alternateLandingNodeIds: [],
    emergencyAreaNodeIds: [],
    entryDirectionDegrees: 90,
    exitDirectionDegrees: 270,
    waypoints: [
      waypoint("start", "起飞点", 114.07),
      waypoint("mid", "中间点", 114.073),
      waypoint("end", "配送点", 114.076)
    ]
  }
}

function waypoint(id: string, name: string, longitude: number) {
  return { id, name, position: { longitude, latitude: 22.69 }, altitudeMeters: 45, segmentAltitudeMeters: 45, speedMps: 12, nodeId: null, locked: false }
}

function metric(): LogisticsRouteMetricView {
  return { routeId: "route-1", routeName: "北区去程", destinationNodeId: "delivery-1", direction: "OUTBOUND", role: "PRIMARY", distanceMeters: 1350, flightTimeSeconds: 125, batteryConsumptionPercent: 8, remainingBatteryPercent: 92, maximumAltitudeMeters: 45, minimumCoveragePercent: 100, maximumTrackDeviationMeters: 2 }
}
