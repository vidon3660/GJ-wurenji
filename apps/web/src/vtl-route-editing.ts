import type { V3Coordinate, VtlRouteWaypointInput } from "@wurenji/shared"

export function updateVtlWaypointPosition(
  waypoints: readonly VtlRouteWaypointInput[],
  waypointId: string,
  position: Pick<V3Coordinate, "longitude" | "latitude">,
): VtlRouteWaypointInput[] {
  return waypoints.map((waypoint) => waypoint.id === waypointId
    ? {
        ...waypoint,
        position: {
          ...waypoint.position,
          longitude: position.longitude,
          latitude: position.latitude,
        },
      }
    : { ...waypoint, position: { ...waypoint.position } })
}
