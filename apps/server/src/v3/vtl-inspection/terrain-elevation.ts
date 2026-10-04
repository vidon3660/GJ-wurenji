import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { V3TerrainResource, VtlRouteWaypointInput, VtlTerrainProfileSample } from "@wurenji/shared"
import { resolveMapDataPath } from "../../config/runtime-paths.js"

export interface VtlElevationSample {
  longitude: number
  latitude: number
  heightMeters: number
}

export async function loadVtlElevationSamples(resource: V3TerrainResource | null | undefined, mapRoot = resolveMapDataPath()): Promise<VtlElevationSample[]> {
  const path = localMapPath(resource?.elevationSampleUrl, mapRoot)
  if (!path) return []
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown
    const values = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.samples : null
    if (!Array.isArray(values)) return []
    return values.flatMap((value) => {
      if (!isRecord(value)) return []
      const longitude = Number(value.longitude)
      const latitude = Number(value.latitude)
      const heightMeters = Number(value.heightMeters ?? value.elevationMeters)
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(heightMeters)) return []
      return [{ longitude, latitude, heightMeters }]
    })
  } catch {
    return []
  }
}

export function buildVtlTerrainProfile(waypoints: VtlRouteWaypointInput[], samples: readonly VtlElevationSample[]): VtlTerrainProfileSample[] | null {
  if (samples.length === 0) return null
  let distanceMeters = 0
  return waypoints.map((waypoint, index) => {
    if (index > 0) distanceMeters += coordinateDistanceMeters(waypoints[index - 1]!.position, waypoint.position)
    const terrainElevationMeters = sampleElevation(waypoint.position.longitude, waypoint.position.latitude, samples)
    return {
      distanceMeters,
      terrainElevationMeters,
      plannedAltitudeMeters: waypoint.altitudeMeters,
      clearanceMeters: waypoint.altitudeMeters - terrainElevationMeters,
      longitude: waypoint.position.longitude,
      latitude: waypoint.position.latitude
    }
  })
}

function sampleElevation(longitude: number, latitude: number, samples: readonly VtlElevationSample[]): number {
  const nearest = samples
    .map((sample) => ({ sample, distance: planarDistanceSquared(longitude, latitude, sample.longitude, sample.latitude) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 4)
  if (nearest[0]!.distance <= 1e-14) return nearest[0]!.sample.heightMeters
  const weighted = nearest.reduce((result, item) => {
    const weight = 1 / Math.max(item.distance, 1e-14)
    return { value: result.value + item.sample.heightMeters * weight, weight: result.weight + weight }
  }, { value: 0, weight: 0 })
  return weighted.weight > 0 ? weighted.value / weighted.weight : 0
}

function planarDistanceSquared(leftLongitude: number, leftLatitude: number, rightLongitude: number, rightLatitude: number): number {
  const latitudeScale = Math.cos(((leftLatitude + rightLatitude) / 2) * Math.PI / 180)
  const longitudeDelta = (leftLongitude - rightLongitude) * latitudeScale
  const latitudeDelta = leftLatitude - rightLatitude
  return longitudeDelta * longitudeDelta + latitudeDelta * latitudeDelta
}

function coordinateDistanceMeters(left: { longitude: number; latitude: number }, right: { longitude: number; latitude: number }): number {
  const earthRadius = 6_378_137
  const latitude1 = left.latitude * Math.PI / 180
  const latitude2 = right.latitude * Math.PI / 180
  const deltaLatitude = (right.latitude - left.latitude) * Math.PI / 180
  const deltaLongitude = (right.longitude - left.longitude) * Math.PI / 180
  const sine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2
  return 2 * earthRadius * Math.atan2(Math.sqrt(sine), Math.sqrt(Math.max(0, 1 - sine)))
}

function localMapPath(url: string | undefined, mapRoot: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url, "http://local.map")
    if (parsed.origin !== "http://local.map" || !parsed.pathname.startsWith("/map/")) return null
    const relativePath = decodeURIComponent(parsed.pathname.slice("/map/".length))
    if (!relativePath || relativePath.includes("\\") || relativePath.split("/").includes("..")) return null
    const root = resolve(mapRoot)
    const path = resolve(root, relativePath)
    const relativePathToRoot = relative(root, path)
    return relativePathToRoot === "" || (!relativePathToRoot.startsWith("..") && !isAbsolute(relativePathToRoot)) ? path : null
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
