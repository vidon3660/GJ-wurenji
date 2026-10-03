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
