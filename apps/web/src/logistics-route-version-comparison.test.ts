import type { LogisticsRouteInput, LogisticsRouteVersionView } from "@wurenji/shared"
import { describe, expect, it } from "vitest"
import { compareLogisticsRouteVersions, summarizeLogisticsRouteVersion } from "./logistics-route-version-comparison"

describe("logistics route version comparison", () => {
  it("summarizes the frozen scheme and its validation result", () => {
    expect(summarizeLogisticsRouteVersion(version(1, [route("outbound", 12), route("return", 12)], {
      conflictCount: 0,
      riskCount: 1,
      infoCount: 2,
      distanceMeters: 1_250,
      flightTimeSeconds: 180,
      remainingBatteryPercent: 82
    }))).toEqual({
      routeCount: 2,
      waypointCount: 4,
      conflictCount: 0,
      riskCount: 1,
      infoCount: 2,
      completedRoundTripCount: 1,
      requiredRoundTripCount: 1,
      totalDistanceMeters: 1_250,
      totalFlightTimeSeconds: 180,
      minimumRemainingBatteryPercent: 82
    })
  })

  it("identifies route edits and validation-result deltas", () => {
    const baseline = version(1, [route("outbound", 12), route("return", 12)], {
      conflictCount: 1,
      riskCount: 2,
      infoCount: 1,
      distanceMeters: 1_300,
      flightTimeSeconds: 210,
      remainingBatteryPercent: 78
    })
    const target = version(2, [route("outbound", 10), route("return", 12), route("alternate", 11)], {
      conflictCount: 0,
      riskCount: 1,
      infoCount: 2,
      distanceMeters: 1_240,
      flightTimeSeconds: 195,
      remainingBatteryPercent: 81
    })

    expect(compareLogisticsRouteVersions(baseline, target)).toMatchObject({
      addedRouteIds: ["alternate"],
      removedRouteIds: [],
      changedRouteIds: ["outbound"],
      deltas: {
        routeCount: 1,
        waypointCount: 2,
        conflictCount: -1,
        riskCount: -1,
        infoCount: 1,
        totalDistanceMeters: -60,
        totalFlightTimeSeconds: -15,
        minimumRemainingBatteryPercent: 3
      }
    })
  })

  it("keeps unvalidated snapshots comparable without inventing runtime metrics", () => {
    const snapshot = version(1, [route("outbound", 12)], null)
    const validated = version(2, [route("outbound", 12), route("return", 12)], {
      conflictCount: 0,
      riskCount: 0,
      infoCount: 0,
      distanceMeters: 900,
      flightTimeSeconds: 120,
      remainingBatteryPercent: 88
    })

    expect(summarizeLogisticsRouteVersion(snapshot).minimumRemainingBatteryPercent).toBeNull()
    expect(compareLogisticsRouteVersions(snapshot, validated).deltas.minimumRemainingBatteryPercent).toBeNull()
  })
})

function version(
  versionNo: number,
  routes: LogisticsRouteInput[],
  metrics: null | {
    conflictCount: number
    riskCount: number
    infoCount: number
    distanceMeters: number
    flightTimeSeconds: number
    remainingBatteryPercent: number
  }
): LogisticsRouteVersionView {
  return {
    id: `version-${versionNo}`,
    versionNo,
    sourceDraftRevision: versionNo,
    status: metrics ? "VALIDATED" : "SNAPSHOT",
    routes,
    annotations: [],
    checkResult: {
      passed: (metrics?.conflictCount ?? 0) === 0,
      checkedAt: "2026-08-14T00:00:00.000Z",
      routeCount: routes.length,
      selectedDeliveryPointCount: 1,
      conflictCount: metrics?.conflictCount ?? 0,
      riskCount: metrics?.riskCount ?? 0,
      infoCount: metrics?.infoCount ?? 0,
      evidence: []
    },
    validationResult: metrics ? {
      status: metrics.conflictCount ? "HARD_CONFLICT" : metrics.riskCount ? "WITH_RISK" : "PASSED",
      seed: `seed-${versionNo}`,
      checkedAt: "2026-08-14T00:00:00.000Z",
      completedRoundTripCount: metrics.conflictCount ? 0 : 1,
      requiredRoundTripCount: 1,
      routeMetrics: [],
      roundTripMetrics: [{
        destinationNodeId: "delivery",
        outboundRouteId: "outbound",
        returnRouteId: "return",
        distanceMeters: metrics.distanceMeters,
        flightTimeSeconds: metrics.flightTimeSeconds,
        batteryConsumptionPercent: 100 - metrics.remainingBatteryPercent,
        remainingBatteryPercent: metrics.remainingBatteryPercent,
        completed: metrics.conflictCount === 0
      }],
      evidence: []
    } : null,
    createdBy: "张同学",
    createdAt: "2026-08-14T00:00:00.000Z",
    validatedAt: metrics ? "2026-08-14T00:00:00.000Z" : null,
    submittedAt: null
  }
}

function route(id: string, speedMps: number): LogisticsRouteInput {
  return {
    id,
    name: id,
    destinationNodeId: "delivery",
    direction: id === "return" ? "RETURN" : "OUTBOUND",
    role: id === "alternate" ? "ALTERNATE" : "PRIMARY",
    groupCode: "G-01",
    departureNodeId: "takeoff",
    arrivalNodeId: "delivery",
    protectionRadiusMeters: 30,
    waitingNodeIds: ["waiting"],
    alternateLandingNodeIds: ["alternate-landing"],
    emergencyAreaNodeIds: ["emergency"],
    entryDirectionDegrees: 90,
    exitDirectionDegrees: 270,
    waypoints: [
      { id: `${id}-1`, name: "起点", position: { longitude: 114, latitude: 22 }, altitudeMeters: 0, segmentAltitudeMeters: 45, speedMps, nodeId: "takeoff", locked: true },
      { id: `${id}-2`, name: "终点", position: { longitude: 114.01, latitude: 22.01 }, altitudeMeters: 0, segmentAltitudeMeters: 0, speedMps, nodeId: "delivery", locked: true }
    ]
  }
}
