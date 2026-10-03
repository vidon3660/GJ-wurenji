import type { V3RegionFeature } from "@wurenji/shared"

export function featureHeightMeters(feature: V3RegionFeature): number {
  return typeof feature.heightMeters === "number" && Number.isFinite(feature.heightMeters)
    ? Math.max(0, feature.heightMeters)
    : 0
}

export function isObstacleFeature(feature: V3RegionFeature): boolean {
  return String(feature.properties.category ?? "").toUpperCase() === "OBSTACLE"
}

export function obstacleRadiusMeters(feature: V3RegionFeature): number {
  const radius = Number(feature.properties.radiusMeters ?? 5)
  return Number.isFinite(radius) ? Math.max(1, radius) : 5
}
