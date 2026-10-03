import type {
  LogisticsRouteInput,
  LogisticsRuntimeAircraftView,
  LogisticsRuntimeEventView,
  LogisticsRuntimeRouteView,
  V3Coordinate,
  V3LogisticsNodeType
} from "@wurenji/shared"

export function logisticsFocusCoordinates(
  routes: readonly LogisticsRouteInput[],
  selectedRouteId: string,
  selectedWaypointId: string
): V3Coordinate[] {
  const route = routes.find((item) => item.id === selectedRouteId)
  if (!route) return []
  const waypoint = route.waypoints.find((item) => item.id === selectedWaypointId)
  if (waypoint) return [{ ...waypoint.position }]
  return route.waypoints.map((item) => ({ ...item.position }))
}

export function logisticsNodeTypeVisible(
  type: V3LogisticsNodeType,
  visibleNodeTypes: readonly V3LogisticsNodeType[]
): boolean {
  return visibleNodeTypes.includes(type)
}


/** Returns true when a picked Cesium route entity belongs to the route being edited.
 * Route entities have IDs such as `log-route:<routeId>:center:<segment>`.
 * Keeping this predicate outside the component makes add-waypoint hit testing
 * deterministic and prevents a route line click from being treated as a route
 * selection while insertion mode is active.
 */
export function isSelectedLogisticsRouteEntity(entityId: string, selectedRouteId: string): boolean {
  if (!entityId || !selectedRouteId) return false
  return entityId.startsWith(`log-route:${selectedRouteId}:`)
}

export function logisticsRuntimeFocusCoordinates(
  routes: readonly LogisticsRuntimeRouteView[],
  aircraft: readonly LogisticsRuntimeAircraftView[],
  events: readonly LogisticsRuntimeEventView[],
  selectedRouteId: string,
  selectedAircraftId: string,
  selectedEventId: string
): V3Coordinate[] {
  const event = events.find((item) => item.id === selectedEventId)
  if (event) {
    const affectedAircraft = aircraft.find((item) => event.affectedAircraftIds.includes(item.id) && validCoordinate(item.position))
    if (affectedAircraft) return [{ ...affectedAircraft.position }]
    const affectedRoute = routes.find((item) => event.affectedRouteIds.includes(item.id) && item.waypoints.length > 0)
    if (affectedRoute) return [{ ...affectedRoute.waypoints[Math.floor((affectedRoute.waypoints.length - 1) / 2)]!.position }]
  }
  const selectedAircraft = aircraft.find((item) => item.id === selectedAircraftId && validCoordinate(item.position))
  if (selectedAircraft) return [{ ...selectedAircraft.position }]
  const selectedRoute = routes.find((item) => item.id === selectedRouteId)
  return selectedRoute?.waypoints.map((item) => ({ ...item.position })) ?? []
}

function validCoordinate(value: V3Coordinate): boolean {
  return Number.isFinite(value.longitude)
    && Number.isFinite(value.latitude)
    && Math.abs(value.longitude) <= 180
    && Math.abs(value.latitude) <= 90
    && (value.longitude !== 0 || value.latitude !== 0)
}
