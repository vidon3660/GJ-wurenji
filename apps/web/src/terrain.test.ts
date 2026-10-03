import { describe, expect, it, vi } from "vitest"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { EllipsoidTerrainProvider } from "cesium"
import { loadTerrainForRegion, regionTerrainNoticeVisible, regionTerrainStateDetail, regionTerrainStateLabel, terrainUrlForRegion } from "./terrain"

describe("region terrain resolution", () => {
  it("keeps loading distinct from an ellipsoid fallback", () => {
    expect(regionTerrainStateLabel("LOADING")).toBe("高程加载中")
    expect(regionTerrainStateDetail("LOADING")).toBe("正在读取区域高程资源，请稍候")
    expect(regionTerrainStateLabel("ELLIPSOID")).toBe("椭球面")
    expect(regionTerrainStateLabel("WORLD_TERRAIN")).toBe("在线地形")
  })

  it("explains when a requested terrain source has fallen back to teaching terrain", () => {
    expect(regionTerrainStateLabel("DEGRADED")).toBe("高程已降级")
    expect(regionTerrainStateDetail("DEGRADED")).toContain("正式/在线高程加载失败")
    expect(regionTerrainStateDetail("DEGRADED")).toContain("教学起伏地形")
  })

  it("shows an explicit notice whenever formal DEM is not active", () => {
    expect(regionTerrainNoticeVisible("CUSTOM_DEM")).toBe(false)
    expect(regionTerrainNoticeVisible("LOADING")).toBe(false)
    expect(regionTerrainNoticeVisible("WORLD_TERRAIN")).toBe(false)
    expect(regionTerrainNoticeVisible("TEACHING")).toBe(true)
    expect(regionTerrainNoticeVisible("ELLIPSOID")).toBe(true)
    expect(regionTerrainNoticeVisible("DEGRADED")).toBe(true)
    expect(regionTerrainNoticeVisible("FAILED")).toBe(true)
  })

  it("prefers the versioned region terrain service over the global fallback", () => {
    const region = { terrain: { url: "/map/terrain/region/layer.json" } } as V3RegionCatalogItem

    expect(terrainUrlForRegion(region)).toBe("/map/terrain/region/layer.json")
  })

  it("returns the configured global fallback when a region has no terrain service", () => {
    expect(terrainUrlForRegion(null)).toBe(((import.meta.env.VITE_DEM_TERRAIN_URL as string | undefined) ?? "").trim())
  })

  it("keeps the versioned elevation snapshot address available for authoritative checks", async () => {
    const { terrainSampleUrlForRegion } = await import("./terrain")
    const region = { terrain: { elevationSampleUrl: "/map/regions/demo/elevation-samples.json" } } as V3RegionCatalogItem

    expect(terrainSampleUrlForRegion(region)).toBe("/map/regions/demo/elevation-samples.json")
  })

  it("uses viewport-driven teaching terrain when no formal DEM is configured", async () => {
    const viewer = { terrainProvider: null } as unknown as Parameters<typeof loadTerrainForRegion>[0]
    let state = ""

    await loadTerrainForRegion(viewer, {
      boundary: [
        { longitude: 113.9, latitude: 22.5 },
        { longitude: 113.96, latitude: 22.5 },
        { longitude: 113.93, latitude: 22.55 }
      ]
    } as V3RegionCatalogItem, (value) => { state = value }, { allowWorldTerrain: false })

    expect(state).toBe("TEACHING")
    expect(viewer.terrainProvider).toBeDefined()
  })

  it("does not apply a terrain fallback after the region request becomes stale", async () => {
    const originalTerrainProvider = { kind: "original" }
    const viewer = { terrainProvider: originalTerrainProvider } as unknown as Parameters<typeof loadTerrainForRegion>[0]
    let state = "ELLIPSOID"

    await loadTerrainForRegion(viewer, null, (value) => { state = value }, {
      allowWorldTerrain: false,
      isCurrent: () => false
    })

    expect(state).toBe("ELLIPSOID")
    expect(viewer.terrainProvider).toBe(originalTerrainProvider)
  })

  it("uses the ellipsoid and avoids teaching terrain when the region is unavailable", async () => {
    const viewer = { terrainProvider: null, isDestroyed: () => false } as unknown as Parameters<typeof loadTerrainForRegion>[0]
    const onState = vi.fn()

    await loadTerrainForRegion(viewer, null, onState)

    expect(viewer.terrainProvider).toBeInstanceOf(EllipsoidTerrainProvider)
    expect(onState).toHaveBeenCalledWith("ELLIPSOID")
  })
})
