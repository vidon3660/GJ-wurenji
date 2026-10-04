import type { GeoPoint, LocalPoint } from "@wurenji/shared"

const EARTH_RADIUS_METERS = 6_378_137

export function toLocal(origin: GeoPoint, point: GeoPoint): LocalPoint {
  const latitudeRadians = (origin.latitude * Math.PI) / 180
  return {
    east: ((point.longitude - origin.longitude) * Math.PI / 180) * EARTH_RADIUS_METERS * Math.cos(latitudeRadians),
    north: ((point.latitude - origin.latitude) * Math.PI / 180) * EARTH_RADIUS_METERS,
    up: point.altitude - origin.altitude
  }
}

export function toGeo(origin: GeoPoint, point: LocalPoint): GeoPoint {
  const latitudeRadians = (origin.latitude * Math.PI) / 180
  return {
    longitude: origin.longitude + (point.east / (EARTH_RADIUS_METERS * Math.cos(latitudeRadians))) * 180 / Math.PI,
    latitude: origin.latitude + (point.north / EARTH_RADIUS_METERS) * 180 / Math.PI,
    altitude: origin.altitude + point.up
  }
}

export function distance3d(left: LocalPoint, right: LocalPoint): number {
  return Math.hypot(left.east - right.east, left.north - right.north, left.up - right.up)
}

export function horizontalDistance(left: LocalPoint, right: LocalPoint): number {
  return Math.hypot(left.east - right.east, left.north - right.north)
}

export function pointInPolygon(point: LocalPoint, polygon: LocalPoint[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const currentPoint = polygon[current]!
    const previousPoint = polygon[previous]!
    const intersects = currentPoint.north > point.north !== previousPoint.north > point.north
      && point.east < (previousPoint.east - currentPoint.east) * (point.north - currentPoint.north)
        / ((previousPoint.north - currentPoint.north) || Number.EPSILON) + currentPoint.east
    if (intersects) inside = !inside
  }
  return inside
}

export function interpolate(left: LocalPoint, right: LocalPoint, ratio: number): LocalPoint {
  return {
    east: left.east + (right.east - left.east) * ratio,
    north: left.north + (right.north - left.north) * ratio,
    up: left.up + (right.up - left.up) * ratio
  }
}

/**
 * Continuous segment/AABB intersection. Sampling a route at one second
 * intervals can jump over a narrow building; this slab test checks the full
 * segment in local ENU coordinates instead.
 */
export function segmentIntersectsBox(
  start: LocalPoint,
  end: LocalPoint,
  center: LocalPoint,
  widthMeters: number,
  lengthMeters: number,
  heightMeters: number,
  paddingMeters = 0
): boolean {
  const min = {
    east: center.east - widthMeters / 2 - paddingMeters,
    north: center.north - lengthMeters / 2 - paddingMeters,
    up: center.up - paddingMeters
  }
  const max = {
    east: center.east + widthMeters / 2 + paddingMeters,
    north: center.north + lengthMeters / 2 + paddingMeters,
    up: center.up + heightMeters + paddingMeters
  }
  let tMin = 0
  let tMax = 1
  for (const axis of ["east", "north", "up"] as const) {
    const delta = end[axis] - start[axis]
    if (Math.abs(delta) < Number.EPSILON) {
      if (start[axis] < min[axis] || start[axis] > max[axis]) return false
      continue
    }
    const near = (min[axis] - start[axis]) / delta
    const far = (max[axis] - start[axis]) / delta
    const entry = Math.min(near, far)
    const exit = Math.max(near, far)
    tMin = Math.max(tMin, entry)
    tMax = Math.min(tMax, exit)
    if (tMin > tMax) return false
  }
  return tMax >= 0 && tMin <= 1
}

/** Minimum distance between two synchronously moving horizontal tracks. */
export function minimumDistanceDuringInterval(
  leftStart: LocalPoint,
  leftEnd: LocalPoint,
  rightStart: LocalPoint,
  rightEnd: LocalPoint
): { horizontal: number; vertical: number; ratio: number } {
  const relativeStart = {
    east: leftStart.east - rightStart.east,
    north: leftStart.north - rightStart.north
  }
  const relativeVelocity = {
    east: (leftEnd.east - leftStart.east) - (rightEnd.east - rightStart.east),
    north: (leftEnd.north - leftStart.north) - (rightEnd.north - rightStart.north)
  }
  const denominator = relativeVelocity.east ** 2 + relativeVelocity.north ** 2
  const ratio = denominator < Number.EPSILON
    ? 0
    : Math.max(0, Math.min(1, -(relativeStart.east * relativeVelocity.east + relativeStart.north * relativeVelocity.north) / denominator))
  const leftAt = interpolate(leftStart, leftEnd, ratio)
  const rightAt = interpolate(rightStart, rightEnd, ratio)
  return { horizontal: horizontalDistance(leftAt, rightAt), vertical: Math.abs(leftAt.up - rightAt.up), ratio }
}

/** Returns true when a 2D segment enters a polygon, including edge crossings. */
export function segmentIntersectsPolygon(start: LocalPoint, end: LocalPoint, polygon: LocalPoint[]): boolean {
  if (polygon.length < 3) return false
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return true
  const orientation = (a: LocalPoint, b: LocalPoint, c: LocalPoint): number =>
    (b.east - a.east) * (c.north - a.north) - (b.north - a.north) * (c.east - a.east)
  const onSegment = (a: LocalPoint, b: LocalPoint, c: LocalPoint): boolean =>
    Math.min(a.east, b.east) - 1e-9 <= c.east && c.east <= Math.max(a.east, b.east) + 1e-9
      && Math.min(a.north, b.north) - 1e-9 <= c.north && c.north <= Math.max(a.north, b.north) + 1e-9
  const intersects = (a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): boolean => {
    const o1 = orientation(a, b, c)
    const o2 = orientation(a, b, d)
    const o3 = orientation(c, d, a)
    const o4 = orientation(c, d, b)
    if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) return true
    return (Math.abs(o1) < 1e-9 && onSegment(a, b, c)) || (Math.abs(o2) < 1e-9 && onSegment(a, b, d))
      || (Math.abs(o3) < 1e-9 && onSegment(c, d, a)) || (Math.abs(o4) < 1e-9 && onSegment(c, d, b))
  }
  for (let index = 0; index < polygon.length; index += 1) {
    const next = polygon[(index + 1) % polygon.length]!
    if (intersects(start, end, polygon[index]!, next)) return true
  }
  return false
}
