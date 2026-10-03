import type {
  LogisticsRouteDirection,
  LogisticsRouteInput,
  LogisticsWaypointInput,
  V3LogisticsNode
} from "@wurenji/shared"

interface PrimaryRouteSkeletonOptions {
  id: string
  direction: LogisticsRouteDirection
  destination: V3LogisticsNode
  takeoff: V3LogisticsNode
  landing: V3LogisticsNode
  groupCode: string
  cruiseSpeedMps: number
}

export function createPrimaryRouteSkeleton(options: PrimaryRouteSkeletonOptions): LogisticsRouteInput {
  const { id, direction, destination, takeoff, landing, groupCode, cruiseSpeedMps } = options
  const departure = direction === "OUTBOUND" ? takeoff : destination
  const arrival = direction === "OUTBOUND" ? destination : landing
  if (!destination.position || !departure.position || !arrival.position) {
    throw new Error("航线端点缺少有效坐标")
  }

  return {
    id,
    name: `${destination.name} · ${direction === "OUTBOUND" ? "去程" : "返程"}`,
    destinationNodeId: destination.id,
    direction,
    role: "PRIMARY",
    groupCode,
    departureNodeId: departure.id,
    arrivalNodeId: arrival.id,
    protectionRadiusMeters: 30,
    waitingNodeIds: [],
    alternateLandingNodeIds: [],
    emergencyAreaNodeIds: [],
    entryDirectionDegrees: 0,
    exitDirectionDegrees: 0,
    waypoints: [
      endpointWaypoint(`${id}-start`, departure, cruiseSpeedMps),
      endpointWaypoint(`${id}-end`, arrival, cruiseSpeedMps)
    ]
  }
}

export function hasPrimaryRoute(
  routes: readonly LogisticsRouteInput[],
  destinationNodeId: string,
  direction: LogisticsRouteDirection
): boolean {
  return routes.some((route) =>
    route.destinationNodeId === destinationNodeId
    && route.direction === direction
    && route.role === "PRIMARY"
  )
}

function endpointWaypoint(id: string, node: V3LogisticsNode, cruiseSpeedMps: number): LogisticsWaypointInput {
  return {
    id,
    name: node.name,
    position: { ...node.position! },
    altitudeMeters: 0,
    segmentAltitudeMeters: 40,
    speedMps: cruiseSpeedMps,
    nodeId: node.id,
    locked: true
  }
}
