import { Cartographic, Math as CesiumMath } from "cesium"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { describe, expect, it } from "vitest"
import {
  createTeachingImageryProvider,
  createTeachingTerrainProvider,
  teachingMapLimits,
  teachingTerrainHeightMeters
} from "./teaching-map"

describe("teaching map fallback", () => {
  it("keeps generated relief bounded, deterministic and locally varied", () => {
    const points = [
      teachingTerrainHeightMeters(113.92, 22.51),
      teachingTerrainHeightMeters(113.94, 22.52),
      teachingTerrainHeightMeters(113.96, 22.53)
    ]

    expect(points).toEqual([
      teachingTerrainHeightMeters(113.92, 22.51),
      teachingTerrainHeightMeters(113.94, 22.52),
      teachingTerrainHeightMeters(113.96, 22.53)
    ])
    expect(new Set(points).size).toBeGreaterThan(1)
    expect(points.every((height) => height >= 3 && height <= 68)).toBe(true)
  })

  it("caps imagery and terrain detail for viewport-driven loading", () => {
    const imagery = createTeachingImageryProvider(null)
    const terrain = createTeachingTerrainProvider()
    const position = Cartographic.fromDegrees(113.94, 22.52)

    expect(imagery.maximumLevel).toBe(teachingMapLimits.maximumImageryLevel)
    expect(terrain.availability?.computeMaximumLevelAtPosition(position)).toBe(teachingMapLimits.maximumTerrainLevel)
    expect(terrain.getTileDataAvailable(0, 0, teachingMapLimits.maximumTerrainLevel + 1)).toBe(false)
  })

  it("returns a heightmap tile without requesting network data", async () => {
    const terrain = createTeachingTerrainProvider()
    const tile = terrain.tilingScheme.positionToTileXY(Cartographic.fromDegrees(113.94, 22.52), 10)
    const data = tile ? await terrain.requestTileGeometry(tile.x, tile.y, 10) : undefined
    const rectangle = tile ? terrain.tilingScheme.tileXYToRectangle(tile.x, tile.y, 10) : undefined

    expect(data).toBeDefined()
    expect(rectangle).toBeDefined()
    expect(data && rectangle
      ? data.interpolateHeight(rectangle, CesiumMath.toRadians(113.94), CesiumMath.toRadians(22.52))
      : undefined).toBeTypeOf("number")
  })

  it("limits generated terrain availability to a preset teaching region", async () => {
    const region = {
      boundary: [
        { longitude: 113.90, latitude: 22.50 },
        { longitude: 113.96, latitude: 22.50 },
        { longitude: 113.96, latitude: 22.55 },
        { longitude: 113.90, latitude: 22.55 }
      ]
    } as V3RegionCatalogItem
    const terrain = createTeachingTerrainProvider(region)
    const inside = terrain.tilingScheme.positionToTileXY(Cartographic.fromDegrees(113.93, 22.525), 10)
    const visibleMargin = terrain.tilingScheme.positionToTileXY(Cartographic.fromDegrees(113.975, 22.56), 10)
    const outside = terrain.tilingScheme.positionToTileXY(Cartographic.fromDegrees(114.20, 22.80), 10)

    expect(inside).toBeDefined()
    expect(visibleMargin).toBeDefined()
    expect(outside).toBeDefined()
    expect(inside && terrain.getTileDataAvailable(inside.x, inside.y, 10)).toBe(true)
    expect(visibleMargin && terrain.getTileDataAvailable(visibleMargin.x, visibleMargin.y, 10)).toBe(true)
    expect(outside && terrain.getTileDataAvailable(outside.x, outside.y, 10)).toBe(false)
    expect(outside && await terrain.requestTileGeometry(outside.x, outside.y, 10)).toBeUndefined()
  })
})
