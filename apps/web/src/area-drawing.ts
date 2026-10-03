import type { V3Coordinate } from "@wurenji/shared"

export function rectangleFromDiagonal(start: V3Coordinate, end: V3Coordinate): V3Coordinate[] {
  return [
    { longitude: Math.min(start.longitude, end.longitude), latitude: Math.min(start.latitude, end.latitude) },
    { longitude: Math.max(start.longitude, end.longitude), latitude: Math.min(start.latitude, end.latitude) },
    { longitude: Math.max(start.longitude, end.longitude), latitude: Math.max(start.latitude, end.latitude) },
    { longitude: Math.min(start.longitude, end.longitude), latitude: Math.max(start.latitude, end.latitude) }
  ]
}
