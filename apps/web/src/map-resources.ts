import type { V3RegionCatalogItem } from "@wurenji/shared"

export function regionMapResourceKey(region: V3RegionCatalogItem | null | undefined): string {
  if (!region) return "UNAVAILABLE"
  return JSON.stringify({
    packageId: region.packageId,
    packageVersion: region.packageVersion,
    checksum: region.checksum,
    regionCode: region.regionCode,
    boundary: region.boundary.map((point) => [point.longitude, point.latitude, point.altitudeMeters ?? null]),
    terrain: region.terrain ? {
      provider: region.terrain.provider,
      url: region.terrain.url,
      version: region.terrain.version,
      sha256: region.terrain.sha256,
      verticalDatum: region.terrain.verticalDatum,
      extent: region.terrain.extent,
      elevationSampleUrl: region.terrain.elevationSampleUrl ?? null,
      elevationSampleSha256: region.terrain.elevationSampleSha256 ?? null
    } : null,
    imagery: region.imagery ? {
      provider: region.imagery.provider,
      url: region.imagery.url,
      version: region.imagery.version,
      sha256: region.imagery.sha256,
      extent: region.imagery.extent
    } : null,
    layerDataUrls: (region.layers ?? [])
      .filter((layer) => Boolean(layer.dataUrl))
      .map((layer) => [layer.code, layer.dataUrl])
  })
}

export function hasConfiguredImagery(region: V3RegionCatalogItem | null | undefined): boolean {
  return Boolean(region?.imagery?.url?.trim()
    || ((import.meta.env.VITE_MAP_TILE_URL as string | undefined) ?? "").trim())
}

export function imageryTemplateForRegion(region: V3RegionCatalogItem | null | undefined): string {
  const configured = region?.imagery?.url?.trim()
    || ((import.meta.env.VITE_MAP_TILE_URL as string | undefined) ?? "").trim()
  if (!configured) return ""
  if (region?.imagery?.provider === "SINGLE_TILE") return configured
  if (/\{(?:z|x|y|reverseX|reverseY|s)\}/i.test(configured)) return configured
  return `${configured.replace(/\/$/, "")}/{z}/{x}/{y}.png`
}

export function imageryUrlForRegion(region: V3RegionCatalogItem | null | undefined): string {
  const configured = imageryTemplateForRegion(region) || "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
  const baseUrl = configured.replace(/\{z\}\/\{x\}\/\{y\}\.png\/?$/, "")
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

export function imageryRectangleForRegion(region: V3RegionCatalogItem | null | undefined): [number, number, number, number] | null {
  const extent = region?.imagery?.extent
  return extent && extent.every(Number.isFinite) ? extent : null
}
