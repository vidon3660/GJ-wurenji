import { describe, expect, it } from "vitest"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import {
  DEFAULT_LOGISTICS_BUILDINGS_URL,
  buildingHeightMeters,
  hasRenderableOfflineBuildingFeatures,
  resolveBuildingDataUrl,
  stableBuildingSeed
} from "./map-building-layer"

function region(overrides: Partial<V3RegionCatalogItem> = {}): V3RegionCatalogItem {
  return {
    packageId: "demo",
    packageVersion: "1",
    checksum: "checksum",
    regionCode: "demo",
    name: "demo",
    center: { longitude: 113.25, latitude: 23.05 },
    boundary: [
      { longitude: 113.2, latitude: 23.0 },
      { longitude: 113.3, latitude: 23.0 },
      { longitude: 113.3, latitude: 23.1 }
    ],
    layers: [],
    ...overrides
  } as V3RegionCatalogItem
}

describe("map building layer resolution", () => {
  it("uses the bundled buildings only inside the teaching extent", () => {
    expect(resolveBuildingDataUrl(region())).toBe(DEFAULT_LOGISTICS_BUILDINGS_URL)
    expect(resolveBuildingDataUrl(region({ center: { longitude: 121.4, latitude: 31.2 } }))).toBe("")
  })

  it("prefers an explicit URL and manifest URL", () => {
    expect(resolveBuildingDataUrl(region(), "  /custom.geojson ")).toBe("/custom.geojson")
    expect(resolveBuildingDataUrl(region({ layers: [{ code: "BUILDINGS", state: "READY", dataUrl: "/manifest.geojson", features: [] }] as never }))).toBe("/manifest.geojson")
  })

  it("makes fallback heights deterministic and positive", () => {
    expect(buildingHeightMeters(24, "x")).toBe(24)
    const first = buildingHeightMeters(undefined, "building-a")
    expect(first).toBeGreaterThan(0)
    expect(first).toBe(buildingHeightMeters(undefined, "building-a"))
    expect(stableBuildingSeed("building-a")).toBe(stableBuildingSeed("building-a"))
  })

  it("keeps manifest footprints when an external package is missing or empty", () => {
    expect(hasRenderableOfflineBuildingFeatures(0)).toBe(false)
    expect(hasRenderableOfflineBuildingFeatures(-1)).toBe(false)
    expect(hasRenderableOfflineBuildingFeatures(Number.NaN)).toBe(false)
    expect(hasRenderableOfflineBuildingFeatures(1)).toBe(true)
  })
})
