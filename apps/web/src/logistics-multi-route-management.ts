import type { LogisticsRouteInput } from "@wurenji/shared"

export function parseBatchRouteHeight(value: string, maximumHeightMeters: number): number | null {
  const height = Number(value)
  if (!Number.isInteger(height) || height < 20 || height > maximumHeightMeters) return null
  return height
}

export function applyBatchRouteHeight(routes: LogisticsRouteInput[], heightMeters: number): void {
  routes.forEach((route) => route.waypoints.forEach((waypoint, index) => {
    if (!waypoint.locked) waypoint.altitudeMeters = heightMeters
    if (index < route.waypoints.length - 1) waypoint.segmentAltitudeMeters = heightMeters
  }))
}
