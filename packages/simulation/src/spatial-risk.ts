import type { BoxObstacle, GeoPoint, MissionPlan, PracticeScene } from "@wurenji/shared"

export type SpatialRiskCode = "BUILDING_COLLISION" | "AIR_CONFLICT" | "GROUND_CLEARANCE" | "GROUND_CLEARANCE_UNAVAILABLE" | "NO_FLY_INTRUSION"

export interface SpatialRiskFinding {
  code: SpatialRiskCode
  droneIds: string[]
  objectIds: string[]
  timeSeconds: number
  durationSeconds: number
  position: GeoPoint
  measuredValue: number | null
  thresholdValue: number | null
  message: string
}

interface LocalPoint { east: number; north: number; up: number }
interface TimedSegment { start: LocalPoint; end: LocalPoint; startTime: number; endTime: number; startGeo: GeoPoint; endGeo: GeoPoint }

const EARTH_RADIUS_METERS = 6_378_137

/**
 * Performs continuous spatial checks on a student route. The route is split
 * at every waypoint and all checks operate on the complete segment, so a
 * building or another aircraft cannot be skipped by coarse playback samples.
 * The public codes use the same terms as the teaching indicators:
 * BUILDING_COLLISION, GROUND_CLEARANCE and AIR_CONFLICT.
 */
export function evaluateSpatialRisk(scene: PracticeScene, plan: MissionPlan): SpatialRiskFinding[] {
  const findings: SpatialRiskFinding[] = []
  const routeMap = new Map(plan.dronePlans.map((drone) => [drone.droneId, routeSegments(scene, drone)]))
  for (const drone of plan.dronePlans) {
    const segments = routeMap.get(drone.droneId) ?? []
    checkRouteFeatures(scene, drone.droneId, segments, findings)
  }
  checkAirSeparation(scene, routeMap, findings)
  return findings.sort((left, right) => left.timeSeconds - right.timeSeconds)
}

function routeSegments(scene: PracticeScene, drone: MissionPlan["dronePlans"][number]): TimedSegment[] {
  const segments: TimedSegment[] = []
  let time = Math.max(0, drone.takeoffDelaySeconds)
  for (let index = 0; index < drone.waypoints.length - 1; index += 1) {
    const from = drone.waypoints[index]!
    const to = drone.waypoints[index + 1]!
    const start = toLocal(scene.origin, from.position)
    const end = toLocal(scene.origin, to.position)
    const distance = distance3d(start, end)
    const speed = Math.max(0.5, Math.min(to.speedMps, scene.aircraft.maxSpeedMps))
    const duration = distance / speed
    const endTime = time + duration
    segments.push({ start, end, startTime: time, endTime, startGeo: from.position, endGeo: to.position })
    time = endTime
    const waitSeconds = Math.max(0, to.waitSeconds)
    if (waitSeconds > 0) {
      // A wait at an airborne waypoint is an occupied, stationary interval;
      // retaining it in the timeline prevents a second aircraft from being
      // compared against a route that has already advanced to its next leg.
      segments.push({ start: end, end, startTime: time, endTime: time + waitSeconds, startGeo: to.position, endGeo: to.position })
      time += waitSeconds
    }
  }
  return segments
}

function checkRouteFeatures(scene: PracticeScene, droneId: string, segments: TimedSegment[], findings: SpatialRiskFinding[]): void {
  for (const segment of segments) {
    for (const obstacle of scene.obstacles) {
      if (!segmentIntersectsObstacle(scene, segment, obstacle)) continue
      const ratios = segmentBoxIntersectionRatios(scene, segment, obstacle)
      const ratio = ratios.entry
      const point = interpolate(segment.start, segment.end, ratio)
      findings.push({
        code: "BUILDING_COLLISION",
        droneIds: [droneId],
        objectIds: [obstacle.id],
        timeSeconds: segment.startTime + (segment.endTime - segment.startTime) * ratio,
        durationSeconds: (segment.endTime - segment.startTime) * (ratios.exit - ratios.entry),
        position: toGeo(scene.origin, point),
        measuredValue: point.up,
        thresholdValue: obstacle.heightMeters,
        message: `${droneId} 的航段穿过 ${obstacle.name} 碰撞体`
      })
    }
    for (const zone of scene.noFlyZones) {
      const polygon = zone.positions.map((point) => toLocal(scene.origin, point))
      const altitudeLow = Math.min(segment.start.up, segment.end.up)
      const altitudeHigh = Math.max(segment.start.up, segment.end.up)
      if (altitudeHigh < zone.minimumAltitudeMeters || altitudeLow > zone.maximumAltitudeMeters) continue
      if (!segmentIntersectsPolygon(segment.start, segment.end, polygon)) continue
      const ratio = polygonEntryRatio(segment.start, segment.end, polygon)
      const point = interpolate(segment.start, segment.end, ratio)
      findings.push({
        code: "NO_FLY_INTRUSION",
        droneIds: [droneId],
        objectIds: [zone.id],
        timeSeconds: segment.startTime + (segment.endTime - segment.startTime) * ratio,
        durationSeconds: segment.endTime - segment.startTime,
        position: toGeo(scene.origin, point),
        measuredValue: point.up,
        thresholdValue: zone.maximumAltitudeMeters,
        message: `${droneId} 的航段进入 ${zone.name}`
      })
    }
    const clearanceLimit = scene.rules.minimumTerrainClearanceMeters
    const groundStart = segment.startGeo.groundHeightMeters
    const groundEnd = segment.endGeo.groundHeightMeters
    if (clearanceLimit !== undefined && (!Number.isFinite(groundStart) || !Number.isFinite(groundEnd))) {
      findings.push({
        code: "GROUND_CLEARANCE_UNAVAILABLE",
        droneIds: [droneId],
        objectIds: [scene.id],
        timeSeconds: segment.startTime,
        durationSeconds: segment.endTime - segment.startTime,
        position: toGeo(scene.origin, segment.start),
        measuredValue: null,
        thresholdValue: clearanceLimit,
        message: `${droneId} 的航段缺少完整地面高程，无法判定地面净空`
      })
    } else if (clearanceLimit !== undefined && Number.isFinite(groundStart) && Number.isFinite(groundEnd)) {
      const startClearance = segment.startGeo.altitude - groundStart!
      const endClearance = segment.endGeo.altitude - groundEnd!
      const clearance = Math.min(startClearance, endClearance)
      if (clearance < clearanceLimit) {
        const ratio = startClearance <= endClearance ? 0 : 1
        const point = interpolate(segment.start, segment.end, ratio)
        findings.push({
          code: "GROUND_CLEARANCE",
          droneIds: [droneId],
          objectIds: [scene.id],
          timeSeconds: segment.startTime + (segment.endTime - segment.startTime) * ratio,
          durationSeconds: 0,
          position: toGeo(scene.origin, point),
          measuredValue: clearance,
          thresholdValue: clearanceLimit,
          message: `${droneId} 的地形净空 ${clearance.toFixed(1)} m，小于 ${clearanceLimit.toFixed(1)} m`
        })
      }
    }
  }
}

function checkAirSeparation(scene: PracticeScene, routeMap: Map<string, TimedSegment[]>, findings: SpatialRiskFinding[]): void {
  const routes = [...routeMap.entries()]
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const [leftId, leftSegments] = routes[leftIndex]!
      const [rightId, rightSegments] = routes[rightIndex]!
      const times = [...new Set([...leftSegments, ...rightSegments].flatMap((segment) => [segment.startTime, segment.endTime]))].sort((a, b) => a - b)
      for (let index = 0; index < times.length - 1; index += 1) {
        const startTime = times[index]!
        const endTime = times[index + 1]!
        if (endTime <= startTime) continue
        const leftActive = activeAt(leftSegments, (startTime + endTime) / 2)
        const rightActive = activeAt(rightSegments, (startTime + endTime) / 2)
        if (!leftActive || !rightActive) continue
        const leftStart = positionAt(leftSegments, startTime)
        const leftEnd = positionAt(leftSegments, endTime)
        const rightStart = positionAt(rightSegments, startTime)
        const rightEnd = positionAt(rightSegments, endTime)
        if (!leftStart || !leftEnd || !rightStart || !rightEnd) continue
        const closest = closestSynchronous(
          leftStart,
          leftEnd,
          rightStart,
          rightEnd,
          scene.rules.horizontalSeparationMeters,
          scene.rules.verticalSeparationMeters
        )
        if (closest.ratioStart > closest.ratioEnd) continue
        const ratio = Math.max(closest.ratioStart, Math.min(closest.ratioEnd, closest.ratio))
        const left = interpolate(leftStart, leftEnd, ratio)
        const right = interpolate(rightStart, rightEnd, ratio)
        const horizontal = Math.hypot(left.east - right.east, left.north - right.north)
        const vertical = Math.abs(left.up - right.up)
        if (horizontal >= scene.rules.horizontalSeparationMeters || vertical >= scene.rules.verticalSeparationMeters) continue
        const position = left
        findings.push({
          code: "AIR_CONFLICT",
          droneIds: [leftId, rightId],
          objectIds: [leftId, rightId],
          timeSeconds: startTime + (endTime - startTime) * ratio,
          durationSeconds: (endTime - startTime) * Math.max(0, closest.ratioEnd - closest.ratioStart),
          position: toGeo(scene.origin, position),
          measuredValue: horizontal,
          thresholdValue: scene.rules.horizontalSeparationMeters,
          message: `${leftId} 与 ${rightId} 的空中间隔 ${horizontal.toFixed(1)} m，小于 ${scene.rules.horizontalSeparationMeters.toFixed(1)} m`
        })
      }
    }
  }
}

function segmentIntersectsObstacle(scene: PracticeScene, segment: TimedSegment, obstacle: BoxObstacle): boolean {
  const center = toLocal(scene.origin, obstacle.center)
  const heading = (obstacle.headingDegrees ?? 0) * Math.PI / 180
  const rotate = (point: LocalPoint): LocalPoint => {
    const east = point.east - center.east
    const north = point.north - center.north
    return { east: east * Math.cos(heading) + north * Math.sin(heading), north: -east * Math.sin(heading) + north * Math.cos(heading), up: point.up - center.up }
  }
  return segmentIntersectsBox(rotate(segment.start), rotate(segment.end), { east: 0, north: 0, up: 0 }, obstacle.widthMeters, obstacle.lengthMeters, obstacle.heightMeters)
}

function segmentBoxIntersectionRatios(scene: PracticeScene, segment: TimedSegment, obstacle: BoxObstacle): { entry: number; exit: number } {
  const center = toLocal(scene.origin, obstacle.center)
  const heading = (obstacle.headingDegrees ?? 0) * Math.PI / 180
  const rotate = (point: LocalPoint): LocalPoint => {
    const east = point.east - center.east
    const north = point.north - center.north
    return { east: east * Math.cos(heading) + north * Math.sin(heading), north: -east * Math.sin(heading) + north * Math.cos(heading), up: point.up - center.up }
  }
  const start = rotate(segment.start)
  const end = rotate(segment.end)
  let near = 0
  let far = 1
  const min = { east: -obstacle.widthMeters / 2, north: -obstacle.lengthMeters / 2, up: 0 }
  const max = { east: obstacle.widthMeters / 2, north: obstacle.lengthMeters / 2, up: obstacle.heightMeters }
  for (const axis of ["east", "north", "up"] as const) {
    const delta = end[axis] - start[axis]
    if (Math.abs(delta) < Number.EPSILON) continue
    near = Math.max(near, Math.min((min[axis] - start[axis]) / delta, (max[axis] - start[axis]) / delta))
    far = Math.min(far, Math.max((min[axis] - start[axis]) / delta, (max[axis] - start[axis]) / delta))
  }
  return { entry: Math.max(0, Math.min(1, near <= far ? near : 0)), exit: Math.max(0, Math.min(1, far)) }
}

function positionAt(segments: TimedSegment[], time: number): LocalPoint | null {
  if (segments.length === 0) return null
  if (time <= segments[0]!.startTime) return segments[0]!.start
  for (const segment of segments) {
    if (time <= segment.endTime) {
      const ratio = segment.endTime <= segment.startTime ? 1 : (time - segment.startTime) / (segment.endTime - segment.startTime)
      return interpolate(segment.start, segment.end, Math.max(0, Math.min(1, ratio)))
    }
  }
  return segments.at(-1)!.end
}

function activeAt(segments: TimedSegment[], time: number): boolean {
  return segments.some((segment) => time >= segment.startTime && time <= segment.endTime)
}

function closestSynchronous(
  leftStart: LocalPoint,
  leftEnd: LocalPoint,
  rightStart: LocalPoint,
  rightEnd: LocalPoint,
  horizontalLimit: number,
  verticalLimit: number
): { horizontal: number; vertical: number; ratio: number; ratioStart: number; ratioEnd: number } {
  const dx = (leftEnd.east - leftStart.east) - (rightEnd.east - rightStart.east)
  const dy = (leftEnd.north - leftStart.north) - (rightEnd.north - rightStart.north)
  const denominator = dx * dx + dy * dy
  const ratio = denominator < Number.EPSILON ? 0 : Math.max(0, Math.min(1, -((leftStart.east - rightStart.east) * dx + (leftStart.north - rightStart.north) * dy) / denominator))
  const left = interpolate(leftStart, leftEnd, ratio)
  const right = interpolate(rightStart, rightEnd, ratio)
  const horizontalInterval = quadraticInterval(
    leftStart.east - rightStart.east,
    leftStart.north - rightStart.north,
    dx,
    dy,
    horizontalLimit
  )
  const verticalInterval = linearAbsoluteInterval(leftStart.up - rightStart.up, (leftEnd.up - leftStart.up) - (rightEnd.up - rightStart.up), verticalLimit)
  const ratioStart = Math.max(horizontalInterval[0], verticalInterval[0])
  const ratioEnd = Math.min(horizontalInterval[1], verticalInterval[1])
  return { horizontal: Math.hypot(left.east - right.east, left.north - right.north), vertical: Math.abs(left.up - right.up), ratio, ratioStart, ratioEnd }
}

function quadraticInterval(x0: number, y0: number, vx: number, vy: number, limit: number): [number, number] {
  const a = vx * vx + vy * vy
  const b = 2 * (x0 * vx + y0 * vy)
  const c = x0 * x0 + y0 * y0 - limit * limit
  if (a < Number.EPSILON) return c <= 0 ? [0, 1] : [1, 0]
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0) return c <= 0 ? [0, 1] : [1, 0]
  return [Math.max(0, Math.min(1, (-b - Math.sqrt(discriminant)) / (2 * a))), Math.min(1, Math.max(0, (-b + Math.sqrt(discriminant)) / (2 * a)))]
}

function linearAbsoluteInterval(start: number, velocity: number, limit: number): [number, number] {
  if (Math.abs(velocity) < Number.EPSILON) return Math.abs(start) <= limit ? [0, 1] : [1, 0]
  const first = (-limit - start) / velocity
  const second = (limit - start) / velocity
  return [Math.max(0, Math.min(1, Math.min(first, second))), Math.min(1, Math.max(0, Math.max(first, second)))]
}

function segmentIntersectsBox(start: LocalPoint, end: LocalPoint, center: LocalPoint, width: number, length: number, height: number): boolean {
  const min = { east: center.east - width / 2, north: center.north - length / 2, up: center.up }
  const max = { east: center.east + width / 2, north: center.north + length / 2, up: center.up + height }
  let near = 0
  let far = 1
  for (const axis of ["east", "north", "up"] as const) {
    const delta = end[axis] - start[axis]
    if (Math.abs(delta) < Number.EPSILON) {
      if (start[axis] < min[axis] || start[axis] > max[axis]) return false
      continue
    }
    near = Math.max(near, Math.min((min[axis] - start[axis]) / delta, (max[axis] - start[axis]) / delta))
    far = Math.min(far, Math.max((min[axis] - start[axis]) / delta, (max[axis] - start[axis]) / delta))
    if (near > far) return false
  }
  return far >= 0 && near <= 1
}

function segmentIntersectsPolygon(start: LocalPoint, end: LocalPoint, polygon: LocalPoint[]): boolean {
  if (polygon.length < 3) return false
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return true
  for (let index = 0; index < polygon.length; index += 1) {
    if (segmentsIntersect(start, end, polygon[index]!, polygon[(index + 1) % polygon.length]!)) return true
  }
  return false
}

function polygonEntryRatio(start: LocalPoint, end: LocalPoint, polygon: LocalPoint[]): number {
  if (pointInPolygon(start, polygon)) return 0
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index]!
    const edgeEnd = polygon[(index + 1) % polygon.length]!
    const denominator = (end.east - start.east) * (edgeEnd.north - edgeStart.north) - (end.north - start.north) * (edgeEnd.east - edgeStart.east)
    if (Math.abs(denominator) < Number.EPSILON) continue
    const t = ((edgeStart.east - start.east) * (edgeEnd.north - edgeStart.north) - (edgeStart.north - start.north) * (edgeEnd.east - edgeStart.east)) / denominator
    if (t >= 0 && t <= 1) return t
  }
  return 0
}

function segmentsIntersect(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): boolean {
  const cross = (p: LocalPoint, q: LocalPoint, r: LocalPoint) => (q.east - p.east) * (r.north - p.north) - (q.north - p.north) * (r.east - p.east)
  const on = (p: LocalPoint, q: LocalPoint, r: LocalPoint) => q.east >= Math.min(p.east, r.east) - 1e-9 && q.east <= Math.max(p.east, r.east) + 1e-9 && q.north >= Math.min(p.north, r.north) - 1e-9 && q.north <= Math.max(p.north, r.north) + 1e-9
  const abC = cross(a, b, c); const abD = cross(a, b, d); const cdA = cross(c, d, a); const cdB = cross(c, d, b)
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
    || Math.abs(abC) < 1e-9 && on(a, c, b) || Math.abs(abD) < 1e-9 && on(a, d, b) || Math.abs(cdA) < 1e-9 && on(c, a, d) || Math.abs(cdB) < 1e-9 && on(c, b, d)
}

function pointInPolygon(point: LocalPoint, polygon: LocalPoint[]): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const current = polygon[index]!; const prior = polygon[previous]!
    if ((current.north > point.north) !== (prior.north > point.north) && point.east < (prior.east - current.east) * (point.north - current.north) / ((prior.north - current.north) || Number.EPSILON) + current.east) inside = !inside
  }
  return inside
}

function toLocal(origin: GeoPoint, point: GeoPoint): LocalPoint {
  const latitude = origin.latitude * Math.PI / 180
  return { east: (point.longitude - origin.longitude) * Math.PI / 180 * EARTH_RADIUS_METERS * Math.cos(latitude), north: (point.latitude - origin.latitude) * Math.PI / 180 * EARTH_RADIUS_METERS, up: point.altitude - origin.altitude }
}

function toGeo(origin: GeoPoint, point: LocalPoint): GeoPoint {
  const latitude = origin.latitude * Math.PI / 180
  return { longitude: origin.longitude + point.east / (EARTH_RADIUS_METERS * Math.cos(latitude)) * 180 / Math.PI, latitude: origin.latitude + point.north / EARTH_RADIUS_METERS * 180 / Math.PI, altitude: origin.altitude + point.up }
}

function interpolate(start: LocalPoint, end: LocalPoint, ratio: number): LocalPoint {
  return { east: start.east + (end.east - start.east) * ratio, north: start.north + (end.north - start.north) * ratio, up: start.up + (end.up - start.up) * ratio }
}

function distance3d(start: LocalPoint, end: LocalPoint): number {
  return Math.hypot(end.east - start.east, end.north - start.north, end.up - start.up)
}
