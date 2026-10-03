import type { LogisticsRuntimeAircraftStatus, LogisticsRuntimeAircraftView, LogisticsRuntimeRouteView, V3Coordinate } from "@wurenji/shared"

const airborneStatuses = new Set<LogisticsRuntimeAircraftStatus>([
  "TAKING_OFF",
  "OUTBOUND",
  "ARRIVED",
  "RETURNING",
  "LANDING",
  "HOLDING",
  "DIVERTING",
  "EMERGENCY_LANDING"
])

export function isLogisticsAircraftAirborne(status: LogisticsRuntimeAircraftStatus): boolean {
  return airborneStatuses.has(status)
}

export function appendLogisticsAircraftTrail(
  trail: readonly V3Coordinate[],
  position: V3Coordinate,
  maximumPoints = 72
): V3Coordinate[] {
  if (!validCoordinate(position)) return [...trail]
  const normalized = {
    longitude: position.longitude,
    latitude: position.latitude,
    altitudeMeters: Number.isFinite(position.altitudeMeters) ? Number(position.altitudeMeters) : 0
  }
  const previous = trail.at(-1)
  if (previous && coordinateDistanceMeters(previous, normalized) < 1 && Math.abs((previous.altitudeMeters ?? 0) - (normalized.altitudeMeters ?? 0)) < 0.5) {
    return [...trail]
  }
  return [...trail, normalized].slice(-Math.max(2, maximumPoints))
}

export function logisticsAircraftHeadingRadians(
  aircraft: Pick<LogisticsRuntimeAircraftView, "position" | "status">,
  routes: readonly LogisticsRuntimeRouteView[]
): number {
  if (!isLogisticsAircraftAirborne(aircraft.status)) return 0
  let best: { distance: number; start: V3Coordinate; end: V3Coordinate } | null = null
  for (const route of routes.filter((item) => item.activeTaskCount > 0)) {
    for (let index = 1; index < route.waypoints.length; index += 1) {
      const start = route.waypoints[index - 1]!.position
      const end = route.waypoints[index]!.position
      const distance = pointToSegmentDistanceMeters(aircraft.position, start, end)
      if (!best || distance < best.distance) best = { distance, start, end }
    }
  }
  return best ? bearingRadians(best.start, best.end) : 0
}

function bearingRadians(start: V3Coordinate, end: V3Coordinate): number {
  const startLatitude = radians(start.latitude)
  const endLatitude = radians(end.latitude)
  const longitudeDelta = radians(end.longitude - start.longitude)
  return Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(endLatitude),
    Math.cos(startLatitude) * Math.sin(endLatitude) - Math.sin(startLatitude) * Math.cos(endLatitude) * Math.cos(longitudeDelta)
  )
}

function pointToSegmentDistanceMeters(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): number {
  const latitudeScale = 111_000
  const longitudeScale = Math.cos(radians(point.latitude)) * 111_000
  const x = (point.longitude - start.longitude) * longitudeScale
  const y = (point.latitude - start.latitude) * latitudeScale
  const dx = (end.longitude - start.longitude) * longitudeScale
  const dy = (end.latitude - start.latitude) * latitudeScale
  const denominator = dx * dx + dy * dy
  const ratio = denominator > 0 ? Math.max(0, Math.min(1, (x * dx + y * dy) / denominator)) : 0
  return Math.hypot(x - dx * ratio, y - dy * ratio)
}

function coordinateDistanceMeters(left: V3Coordinate, right: V3Coordinate): number {
  const latitudeScale = 111_000
  const longitudeScale = Math.cos(radians((left.latitude + right.latitude) / 2)) * 111_000
  return Math.hypot((right.longitude - left.longitude) * longitudeScale, (right.latitude - left.latitude) * latitudeScale)
}

function validCoordinate(value: V3Coordinate): boolean {
  return Number.isFinite(value.longitude) && Number.isFinite(value.latitude)
    && Math.abs(value.longitude) <= 180 && Math.abs(value.latitude) <= 90
    && (value.longitude !== 0 || value.latitude !== 0)
}

function radians(value: number): number {
  return value * Math.PI / 180
}
