import type { ShowAreaDistanceMeasurement, ShowAreaMeasuredPoint } from "@wurenji/shared"

const EARTH_MEAN_RADIUS_METERS = 6_371_008.8

export function createDistanceMeasurement(
  start: ShowAreaMeasuredPoint,
  end: ShowAreaMeasuredPoint
): ShowAreaDistanceMeasurement {
  const startLatitude = radians(start.latitude)
  const endLatitude = radians(end.latitude)
  const latitudeDelta = endLatitude - startLatitude
  const longitudeDelta = radians(end.longitude - start.longitude)
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(startLatitude) * Math.cos(endLatitude) * Math.sin(longitudeDelta / 2) ** 2
  const distanceMeters = 2 * EARTH_MEAN_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)))
  const bearingDegrees = Math.atan2(
    Math.sin(longitudeDelta) * Math.cos(endLatitude),
    Math.cos(startLatitude) * Math.sin(endLatitude)
      - Math.sin(startLatitude) * Math.cos(endLatitude) * Math.cos(longitudeDelta)
  ) * 180 / Math.PI

  return {
    start: { ...start },
    end: { ...end },
    distanceMeters: Number(distanceMeters.toFixed(1)),
    bearingDegrees: Number(((bearingDegrees + 360) % 360).toFixed(1))
  }
}

function radians(degrees: number): number {
  return degrees * Math.PI / 180
}
