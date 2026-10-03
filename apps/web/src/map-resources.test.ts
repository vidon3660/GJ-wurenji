import { describe, expect, it } from "vitest"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { hasConfiguredImagery, imageryRectangleForRegion, imageryTemplateForRegion, imageryUrlForRegion, regionMapResourceKey } from "./map-resources"

describe("map resource resolution", () => {
  it("prefers a versioned region imagery service", () => {
    const region = { imagery: { provider: "XYZ", url: "/map/regions/demo/imagery/{z}/{x}/{y}.png" } } as V3RegionCatalogItem

    expect(imageryUrlForRegion(region)).toBe("/map/regions/demo/imagery/")
    expect(hasConfiguredImagery(region)).toBe(true)
  })

  it("does not treat the implicit public fallback as an offline-ready imagery source", () => {
    const explicitlyConfigured = Boolean(((import.meta.env.VITE_MAP_TILE_URL as string | undefined) ?? "").trim())
    expect(hasConfiguredImagery(null)).toBe(explicitlyConfigured)
  })

  it("normalizes a configured tile template to Cesium's base URL", () => {
    const configured = (((import.meta.env.VITE_MAP_TILE_URL as string | undefined) ?? "https://tile.openstreetmap.org/").trim()).replace(/\{z\}\/\{x\}\/\{y\}\.png\/?$/, "")
    expect(imageryUrlForRegion(null)).toBe(configured.endsWith("/") ? configured : `${configured}/`)
  })

  it("keeps a full XYZ template intact for UrlTemplateImageryProvider", () => {
    const region = { imagery: { provider: "XYZ", url: "https://tiles.example/{z}/{x}/{y}.webp", extent: [113, 22, 114, 23] } } as V3RegionCatalogItem

    expect(imageryTemplateForRegion(region)).toBe("https://tiles.example/{z}/{x}/{y}.webp")
    expect(imageryRectangleForRegion(region)).toEqual([113, 22, 114, 23])
  })

  it("adds a tile template when a provider only gives a base URL", () => {
    const region = { imagery: { provider: "XYZ", url: "/map/regions/demo/imagery", extent: [113, 22, 114, 23] } } as V3RegionCatalogItem

    expect(imageryTemplateForRegion(region)).toBe("/map/regions/demo/imagery/{z}/{x}/{y}.png")
  })

  it("keeps the resource key stable when only business layers change", () => {
    const region = {
      packageId: "region-package",
      packageVersion: "1.0.0",
      checksum: "checksum-a",
      regionCode: "DEMO",
      boundary: [{ longitude: 113, latitude: 22 }, { longitude: 114, latitude: 22 }, { longitude: 114, latitude: 23 }],
      layers: []
    } as unknown as V3RegionCatalogItem

    const next = { ...region, layers: [{ code: "BUILDINGS", title: "建筑", state: "READY", source: "test", version: "2", features: [] }] } as unknown as V3RegionCatalogItem

    expect(regionMapResourceKey(next)).toBe(regionMapResourceKey(region))
  })

  it("changes the resource key when the region package changes", () => {
    const region = {
      packageId: "region-package",
      packageVersion: "1.0.0",
      checksum: "checksum-a",
      regionCode: "DEMO",
      boundary: [{ longitude: 113, latitude: 22 }, { longitude: 114, latitude: 22 }, { longitude: 114, latitude: 23 }]
    } as unknown as V3RegionCatalogItem

    expect(regionMapResourceKey({ ...region, packageVersion: "1.1.0" })).not.toBe(regionMapResourceKey(region))
  })
})
