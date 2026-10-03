import type { V3Coordinate, V3ScenarioOverlayObject } from "@wurenji/shared"

function tuple(point: V3Coordinate): [number, number] | [number, number, number] {
  return typeof point.altitudeMeters === "number"
    ? [point.longitude, point.latitude, point.altitudeMeters]
    : [point.longitude, point.latitude]
}

function coordinate(value: readonly number[]): V3Coordinate {
  return { longitude: value[0] ?? 0, latitude: value[1] ?? 0, ...(typeof value[2] === "number" ? { altitudeMeters: value[2] } : {}) }
}

/** Return a new overlay object with one editable point moved. */
export function moveOverlayObjectVertex(object: V3ScenarioOverlayObject, point: V3Coordinate, vertexIndex: number | null): V3ScenarioOverlayObject | null {
  const next = JSON.parse(JSON.stringify(object)) as V3ScenarioOverlayObject
  const value = tuple(point)
  if (object.geometry.type === "Point") {
    next.geometry = { type: "Point", coordinates: value }
    next.position = point
    return next
  }
  if (vertexIndex === null) return null
  const coordinates = object.geometry.type === "LineString"
    ? [...object.geometry.coordinates]
    : [...(object.geometry.coordinates[0] ?? [])]
  if (vertexIndex < 0 || vertexIndex >= coordinates.length) return null
  coordinates[vertexIndex] = value
  if (object.geometry.type === "LineString") next.geometry = { type: "LineString", coordinates }
  else {
    if (vertexIndex === 0 && coordinates.length > 1) coordinates[coordinates.length - 1] = value
    if (vertexIndex === coordinates.length - 1 && coordinates.length > 1) coordinates[0] = value
    next.geometry = { type: "Polygon", coordinates: [coordinates] }
  }
  next.positions = coordinates.map(coordinate)
  return next
}
