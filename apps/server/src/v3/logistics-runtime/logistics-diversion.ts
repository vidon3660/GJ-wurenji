import type { V3Coordinate, V3LogisticsNode } from "@wurenji/shared"

export interface LogisticsDiversionPoint {
  node: V3LogisticsNode
  distanceMeters: number
}

export function selectNearestAlternateLandingPoint(
  position: V3Coordinate,
  nodes: V3LogisticsNode[],
  preferredNodeIds: string[]
): LogisticsDiversionPoint | null {
  const preferredIds = new Set(preferredNodeIds)
  const candidates = nodes.filter((node) => (
    node.type === "ALTERNATE_LANDING_POINT"
    && node.enabled
    && node.position
    && alternateLandingPointAvailable(node)
  ))
  const scoped = preferredIds.size > 0 ? candidates.filter((node) => preferredIds.has(node.id)) : candidates
  return scoped.reduce<LogisticsDiversionPoint | null>((nearest, node) => {
    const distanceMeters = coordinateDistanceMeters(position, node.position!)
    if (!nearest || distanceMeters < nearest.distanceMeters) return { node, distanceMeters }
    if (distanceMeters === nearest.distanceMeters && node.id.localeCompare(nearest.node.id) < 0) return { node, distanceMeters }
    return nearest
  }, null)
}

function alternateLandingPointAvailable(node: V3LogisticsNode): boolean {
  if (node.properties.available === false) return false
  const status = typeof node.properties.status === "string" ? node.properties.status.toUpperCase() : ""
  return !["CLOSED", "DISABLED", "UNAVAILABLE"].includes(status)
}

function coordinateDistanceMeters(left: V3Coordinate, right: V3Coordinate): number {
  const radians = Math.PI / 180
  const latitudeDelta = (right.latitude - left.latitude) * radians
  const longitudeDelta = (right.longitude - left.longitude) * radians
  const leftLatitude = left.latitude * radians
  const rightLatitude = right.latitude * radians
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}
