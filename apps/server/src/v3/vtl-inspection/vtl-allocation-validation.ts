import type {
  V3Coordinate,
  VtlAircraftAssignmentView,
  VtlAllocationIssueView,
  VtlGroupView,
  VtlTaskObjectView,
  VtlTaskZoneView
} from "@wurenji/shared"

export interface VtlAllocationGeometryInput {
  taskObjects: readonly VtlTaskObjectView[]
  taskZones: readonly VtlTaskZoneView[]
  assignments: readonly VtlAircraftAssignmentView[]
  groups: readonly VtlGroupView[]
  regionBoundary: readonly V3Coordinate[]
}

export function validateVtlAllocationGeometry(input: VtlAllocationGeometryInput): VtlAllocationIssueView[] {
  const issues: VtlAllocationIssueView[] = []
  const zonesByTask = new Map<string, VtlTaskZoneView[]>()
  for (const zone of input.taskZones) {
    for (const taskObjectId of zone.taskObjectIds) {
      zonesByTask.set(taskObjectId, [...(zonesByTask.get(taskObjectId) ?? []), zone])
    }
    if (!isSimplePolygon(zone.boundary) || !pointsStayInsidePolygon(zone.boundary, input.regionBoundary)) {
      issues.push(geometryIssue(null, null, `任务分区“${zone.title}”边界无效或超出巡检区域。`))
    }
  }

  for (const taskObject of input.taskObjects) {
    const zones = zonesByTask.get(taskObject.id) ?? []
    if (zones.length === 0) {
      if (taskObject.required) issues.push(geometryIssue(taskObject.id, null, `必做任务对象 ${taskObject.code} 尚未纳入任务分区。`))
      continue
    }
    if (zones.length > 1) {
      issues.push({
        code: "DUPLICATE",
        taskObjectId: taskObject.id,
        aircraftId: null,
        message: `任务对象 ${taskObject.code} 同时属于多个任务分区。`,
        blocking: true
      })
      continue
    }
    const zone = zones[0]!
    if (!pointsStayInsidePolygon(taskObject.positions, zone.boundary)) {
      issues.push(geometryIssue(taskObject.id, null, `任务对象 ${taskObject.code} 未完全位于所属分区内。`))
    }

    const owners = input.assignments.filter((assignment) => assignment.taskObjectIds.includes(taskObject.id))
    const ownerGroups = [...new Set(owners.map((assignment) => assignment.groupId))]
    if (ownerGroups.length > 1 || (zone.groupId !== null && ownerGroups.some((groupId) => groupId !== zone.groupId))) {
      issues.push({
        code: "ORDER_INVALID",
        taskObjectId: taskObject.id,
        aircraftId: owners[0]?.aircraftId ?? null,
        message: `任务对象 ${taskObject.code} 的分区机组与航空器分组不一致。`,
        blocking: true
      })
    }
    if (zone.groupId === null && ownerGroups.length === 1) {
      const group = input.groups.find((item) => item.id === ownerGroups[0])
      if (group && !group.taskObjectIds.includes(taskObject.id)) {
        issues.push(geometryIssue(taskObject.id, owners[0]?.aircraftId ?? null, `任务对象 ${taskObject.code} 未同步到所属机组的任务清单。`))
      }
    }
  }
  return issues
}

function geometryIssue(taskObjectId: string | null, aircraftId: string | null, message: string): VtlAllocationIssueView {
  return { code: "OUTSIDE_AREA", taskObjectId, aircraftId, message, blocking: true }
}

export function pointsStayInsidePolygon(points: readonly V3Coordinate[], polygon: readonly V3Coordinate[]): boolean {
  if (polygon.length < 3 || points.length === 0) return false
  if (points.some((point) => !pointInPolygon(point, polygon))) return false
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!
    const end = points[index]!
    if (polygonEdges(polygon).some(([edgeStart, edgeEnd]) => segmentsProperlyIntersect(start, end, edgeStart, edgeEnd))) return false
    for (const ratio of [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]) {
      const sample = {
        longitude: start.longitude + (end.longitude - start.longitude) * ratio,
        latitude: start.latitude + (end.latitude - start.latitude) * ratio
      }
      if (!pointInPolygon(sample, polygon)) return false
    }
  }
  return true
}

export function polygonStaysInsidePolygon(polygon: readonly V3Coordinate[], container: readonly V3Coordinate[]): boolean {
  return isSimplePolygon(polygon)
    && isSimplePolygon(container)
    && pointsStayInsidePolygon([...polygon, polygon[0]!], container)
}

export function pointInPolygon(point: V3Coordinate, polygon: readonly V3Coordinate[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const currentPoint = polygon[index]!
    const previousPoint = polygon[previous]!
    if (pointOnSegment(point, previousPoint, currentPoint)) return true
    const intersects = currentPoint.latitude > point.latitude !== previousPoint.latitude > point.latitude
      && point.longitude < (previousPoint.longitude - currentPoint.longitude) * (point.latitude - currentPoint.latitude) / (previousPoint.latitude - currentPoint.latitude) + currentPoint.longitude
    if (intersects) inside = !inside
  }
  return inside
}

function pointOnSegment(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): boolean {
  const cross = (point.latitude - start.latitude) * (end.longitude - start.longitude) - (point.longitude - start.longitude) * (end.latitude - start.latitude)
  if (Math.abs(cross) > 1e-10) return false
  return point.longitude >= Math.min(start.longitude, end.longitude) - 1e-10
    && point.longitude <= Math.max(start.longitude, end.longitude) + 1e-10
    && point.latitude >= Math.min(start.latitude, end.latitude) - 1e-10
    && point.latitude <= Math.max(start.latitude, end.latitude) + 1e-10
}

export function isSimplePolygon(polygon: readonly V3Coordinate[]): boolean {
  if (polygon.length < 3 || Math.abs(signedArea(polygon)) < 1e-12) return false
  const vertices = polygon.map((point) => `${point.longitude}:${point.latitude}`)
  if (new Set(vertices).size !== vertices.length) return false
  for (let first = 0; first < polygon.length; first += 1) {
    const firstEnd = (first + 1) % polygon.length
    if (samePosition(polygon[first]!, polygon[firstEnd]!)) return false
    for (let second = first + 1; second < polygon.length; second += 1) {
      const secondEnd = (second + 1) % polygon.length
      if (first === second || firstEnd === second || secondEnd === first) continue
      if (segmentsIntersect(polygon[first]!, polygon[firstEnd]!, polygon[second]!, polygon[secondEnd]!)) return false
    }
  }
  return true
}

function signedArea(polygon: readonly V3Coordinate[]): number {
  return polygon.reduce((area, point, index) => {
    const next = polygon[(index + 1) % polygon.length]!
    return area + point.longitude * next.latitude - next.longitude * point.latitude
  }, 0) / 2
}

function segmentsIntersect(firstStart: V3Coordinate, firstEnd: V3Coordinate, secondStart: V3Coordinate, secondEnd: V3Coordinate): boolean {
  const firstOrientation = orientation(firstStart, firstEnd, secondStart)
  const secondOrientation = orientation(firstStart, firstEnd, secondEnd)
  const thirdOrientation = orientation(secondStart, secondEnd, firstStart)
  const fourthOrientation = orientation(secondStart, secondEnd, firstEnd)
  if (oppositeSigns(firstOrientation, secondOrientation) && oppositeSigns(thirdOrientation, fourthOrientation)) return true
  return nearZero(firstOrientation) && pointOnSegment(secondStart, firstStart, firstEnd)
    || nearZero(secondOrientation) && pointOnSegment(secondEnd, firstStart, firstEnd)
    || nearZero(thirdOrientation) && pointOnSegment(firstStart, secondStart, secondEnd)
    || nearZero(fourthOrientation) && pointOnSegment(firstEnd, secondStart, secondEnd)
}

function segmentsProperlyIntersect(firstStart: V3Coordinate, firstEnd: V3Coordinate, secondStart: V3Coordinate, secondEnd: V3Coordinate): boolean {
  return oppositeSigns(orientation(firstStart, firstEnd, secondStart), orientation(firstStart, firstEnd, secondEnd))
    && oppositeSigns(orientation(secondStart, secondEnd, firstStart), orientation(secondStart, secondEnd, firstEnd))
}

function polygonEdges(polygon: readonly V3Coordinate[]): Array<[V3Coordinate, V3Coordinate]> {
  return polygon.map((point, index) => [point, polygon[(index + 1) % polygon.length]!])
}

function samePosition(left: V3Coordinate, right: V3Coordinate): boolean {
  return nearZero(left.longitude - right.longitude) && nearZero(left.latitude - right.latitude)
}

function oppositeSigns(left: number, right: number): boolean {
  return left > 1e-12 && right < -1e-12 || left < -1e-12 && right > 1e-12
}

function nearZero(value: number): boolean {
  return Math.abs(value) <= 1e-12
}

function orientation(first: V3Coordinate, second: V3Coordinate, third: V3Coordinate): number {
  return (second.longitude - first.longitude) * (third.latitude - first.latitude) - (second.latitude - first.latitude) * (third.longitude - first.longitude)
}
