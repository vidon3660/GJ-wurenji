import type { V3RegionCatalogItem } from "@wurenji/shared"

/** Offline teaching buildings shipped with the web app. */
export const DEFAULT_LOGISTICS_BUILDINGS_URL = "/map/logistics/gd-north-core-buildings.geojson"

/**
 * Return the building GeoJSON URL that is safe for this region.  The bundled
 * Guangzhou teaching package is intentionally scoped by its geographic extent
 * so it cannot accidentally be drawn on top of another imported region.
 */
export function resolveBuildingDataUrl(
  region: V3RegionCatalogItem | null | undefined,
  configuredUrl?: string | null
): string {
  const configured = configuredUrl?.trim()
  if (configured) return configured
  const packageUrl = region?.layers.find((layer) => layer.code === "BUILDINGS")?.dataUrl?.trim()
  if (packageUrl) return packageUrl
  return isBundledLogisticsRegion(region) ? DEFAULT_LOGISTICS_BUILDINGS_URL : ""
}

export function isBundledLogisticsRegion(region: V3RegionCatalogItem | null | undefined): boolean {
  const center = region?.center
  return Boolean(center
    && center.longitude >= 113.10 && center.longitude <= 113.50
    && center.latitude >= 22.95 && center.latitude <= 23.20)
}

/** Read common GeoJSON height fields and provide a deterministic fallback. */
export function buildingHeightMeters(raw: unknown, id: string): number {
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return 8 + (stableBuildingSeed(id) % 35)
}

export function stableBuildingSeed(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  }
  return Math.abs(hash >>> 0)
}
