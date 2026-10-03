import type { LogisticsRouteInput, LogisticsRouteVersionView } from "@wurenji/shared"

export interface LogisticsRouteVersionSummary {
  routeCount: number
  waypointCount: number
  conflictCount: number
  riskCount: number
  infoCount: number
  completedRoundTripCount: number
  requiredRoundTripCount: number
  totalDistanceMeters: number
  totalFlightTimeSeconds: number
  minimumRemainingBatteryPercent: number | null
}

export interface LogisticsRouteVersionComparison {
  baseline: LogisticsRouteVersionSummary
  target: LogisticsRouteVersionSummary
  addedRouteIds: string[]
  removedRouteIds: string[]
  changedRouteIds: string[]
  deltas: {
    routeCount: number
    waypointCount: number
    conflictCount: number
    riskCount: number
    infoCount: number
    completedRoundTripCount: number
    totalDistanceMeters: number
    totalFlightTimeSeconds: number
    minimumRemainingBatteryPercent: number | null
  }
}

export function summarizeLogisticsRouteVersion(version: LogisticsRouteVersionView): LogisticsRouteVersionSummary {
  const roundTrips = version.validationResult?.roundTripMetrics ?? []
  const remainingBattery = roundTrips.map((metric) => metric.remainingBatteryPercent)
  return {
    routeCount: version.routes.length,
    waypointCount: version.routes.reduce((total, route) => total + route.waypoints.length, 0),
    conflictCount: version.checkResult.conflictCount,
    riskCount: version.checkResult.riskCount,
    infoCount: version.checkResult.infoCount,
    completedRoundTripCount: version.validationResult?.completedRoundTripCount ?? 0,
    requiredRoundTripCount: version.validationResult?.requiredRoundTripCount ?? 0,
    totalDistanceMeters: roundTrips.reduce((total, metric) => total + metric.distanceMeters, 0),
    totalFlightTimeSeconds: roundTrips.reduce((total, metric) => total + metric.flightTimeSeconds, 0),
    minimumRemainingBatteryPercent: remainingBattery.length ? Math.min(...remainingBattery) : null
  }
}

export function compareLogisticsRouteVersions(
  baselineVersion: LogisticsRouteVersionView,
  targetVersion: LogisticsRouteVersionView
): LogisticsRouteVersionComparison {
  const baseline = summarizeLogisticsRouteVersion(baselineVersion)
  const target = summarizeLogisticsRouteVersion(targetVersion)
  const baselineRoutes = new Map(baselineVersion.routes.map((route) => [route.id, route]))
  const targetRoutes = new Map(targetVersion.routes.map((route) => [route.id, route]))
  const addedRouteIds = [...targetRoutes.keys()].filter((routeId) => !baselineRoutes.has(routeId)).sort()
  const removedRouteIds = [...baselineRoutes.keys()].filter((routeId) => !targetRoutes.has(routeId)).sort()
  const changedRouteIds = [...targetRoutes.entries()]
    .filter(([routeId, route]) => baselineRoutes.has(routeId) && routeFingerprint(route) !== routeFingerprint(baselineRoutes.get(routeId)!))
    .map(([routeId]) => routeId)
    .sort()

  return {
    baseline,
    target,
    addedRouteIds,
    removedRouteIds,
    changedRouteIds,
    deltas: {
      routeCount: target.routeCount - baseline.routeCount,
      waypointCount: target.waypointCount - baseline.waypointCount,
      conflictCount: target.conflictCount - baseline.conflictCount,
      riskCount: target.riskCount - baseline.riskCount,
      infoCount: target.infoCount - baseline.infoCount,
      completedRoundTripCount: target.completedRoundTripCount - baseline.completedRoundTripCount,
      totalDistanceMeters: target.totalDistanceMeters - baseline.totalDistanceMeters,
      totalFlightTimeSeconds: target.totalFlightTimeSeconds - baseline.totalFlightTimeSeconds,
      minimumRemainingBatteryPercent: baseline.minimumRemainingBatteryPercent === null || target.minimumRemainingBatteryPercent === null
        ? null
        : target.minimumRemainingBatteryPercent - baseline.minimumRemainingBatteryPercent
    }
  }
}

function routeFingerprint(route: LogisticsRouteInput): string {
  return JSON.stringify({
    name: route.name,
    destinationNodeId: route.destinationNodeId,
    direction: route.direction,
    role: route.role,
    groupCode: route.groupCode,
    departureNodeId: route.departureNodeId,
    arrivalNodeId: route.arrivalNodeId,
    protectionRadiusMeters: route.protectionRadiusMeters,
    waitingNodeIds: route.waitingNodeIds,
    alternateLandingNodeIds: route.alternateLandingNodeIds,
    emergencyAreaNodeIds: route.emergencyAreaNodeIds,
    entryDirectionDegrees: route.entryDirectionDegrees,
    exitDirectionDegrees: route.exitDirectionDegrees,
    waypoints: route.waypoints
  })
}
