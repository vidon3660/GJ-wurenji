import type { LogisticsRouteInput, LogisticsWaypointInput, V3Coordinate } from "@wurenji/shared"

interface IntermediateWaypointOptions {
  id: string
  position: V3Coordinate
  cruiseSpeedMps: number
  defaultHeightMeters?: number
}

export function insertIntermediateWaypoint(
  route: LogisticsRouteInput,
  options: IntermediateWaypointOptions
): LogisticsWaypointInput {
  const index = Math.max(1, route.waypoints.length - 1)
  const defaultHeightMeters = options.defaultHeightMeters ?? 40
  const waypoint: LogisticsWaypointInput = {
    id: options.id,
    name: `航点 ${index}`,
    position: { ...options.position },
    altitudeMeters: defaultHeightMeters,
    segmentAltitudeMeters: defaultHeightMeters,
    speedMps: options.cruiseSpeedMps,
    nodeId: null,
    locked: false
  }
  route.waypoints.splice(index, 0, waypoint)
  return waypoint
}

export function moveIntermediateWaypoint(
  route: LogisticsRouteInput,
  waypointId: string,
  position: V3Coordinate
): boolean {
  const waypoint = route.waypoints.find((item) => item.id === waypointId)
  if (!waypoint || waypoint.locked) return false
  waypoint.position = { ...position }
  return true
}

export function deleteIntermediateWaypoint(route: LogisticsRouteInput, waypointId: string): boolean {
  const waypoint = route.waypoints.find((item) => item.id === waypointId)
  if (!waypoint || waypoint.locked) return false
  route.waypoints = route.waypoints.filter((item) => item.id !== waypointId)
  return true
}

export function hasFollowingSegment(route: LogisticsRouteInput, waypointId: string): boolean {
  const index = route.waypoints.findIndex((item) => item.id === waypointId)
  return index >= 0 && index < route.waypoints.length - 1
}
