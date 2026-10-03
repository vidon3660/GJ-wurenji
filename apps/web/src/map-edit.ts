import type { GeoPoint, MissionPlan, PracticeScene } from "@wurenji/shared"

export function isPointInsidePolygon(point: GeoPoint, polygon: GeoPoint[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const a = polygon[current]!
    const b = polygon[previous]!
    const crossesLatitude = (a.latitude > point.latitude) !== (b.latitude > point.latitude)
    const edgeLongitude = ((b.longitude - a.longitude) * (point.latitude - a.latitude))
      / (b.latitude - a.latitude || Number.EPSILON) + a.longitude
    if (crossesLatitude && point.longitude < edgeLongitude) inside = !inside
  }
  return inside
}

function moveHorizontal(target: GeoPoint, point: GeoPoint) {
  target.longitude = point.longitude
  target.latitude = point.latitude
  if (point.groundHeightMeters !== undefined) target.groundHeightMeters = point.groundHeightMeters
  if (point.heightSource !== undefined) target.heightSource = point.heightSource
}

export function moveMapObject(
  scene: PracticeScene | null,
  plan: MissionPlan | null,
  objectId: string,
  point: GeoPoint
): boolean {
  if (scene) {
    if (objectId === "takeoff:main") {
      moveHorizontal(scene.takeoffPoint, point)
      return true
    }

    if (objectId === "landing:main") {
      moveHorizontal(scene.landingPoint, point)
      return true
    }

    if (objectId.startsWith("task:")) {
      const task = scene.taskPoints.find((item) => item.id === objectId.slice("task:".length))
      if (!task) return false
      moveHorizontal(task.position, point)
      return true
    }

    if (objectId.startsWith("obstacle:")) {
      const obstacle = scene.obstacles.find((item) => item.id === objectId.slice("obstacle:".length))
      if (!obstacle) return false
      moveHorizontal(obstacle.center, point)
      return true
    }

    const vertexParts = objectId.split(":")
    if (vertexParts[0] === "vertex" && vertexParts.length === 4) {
      const [, kind, ownerId, indexText] = vertexParts
      const index = Number(indexText)
      if (!Number.isInteger(index) || index < 0) return false
      if (kind === "boundary" && ownerId === scene.boundary.id && scene.boundary.positions[index]) {
        moveHorizontal(scene.boundary.positions[index]!, point)
        return true
      }
      if (kind === "noFly") {
        const zone = scene.noFlyZones.find((item) => item.id === ownerId)
        if (!zone?.positions[index]) return false
        moveHorizontal(zone.positions[index]!, point)
        return true
      }
    }
  }

  if (plan && objectId.startsWith("waypoint:")) {
    const [, droneId, waypointId] = objectId.split(":")
    const waypoint = plan.dronePlans
      .find((drone) => drone.droneId === droneId)
      ?.waypoints.find((item) => item.id === waypointId)
    if (!waypoint) return false
    moveHorizontal(waypoint.position, point)
    return true
  }

  return false
}

export function selectionIdForMapEntity(entityId: string): string {
  const parts = entityId.split(":")
  if (parts[0] !== "vertex" || parts.length !== 4) return entityId
  if (parts[1] === "boundary") return `boundary:${parts[2]}`
  if (parts[1] === "noFly") return `noFly:${parts[2]}`
  return entityId
}
