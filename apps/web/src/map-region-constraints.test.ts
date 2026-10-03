import type { V3RegionCatalogItem } from "@wurenji/shared"
import { Math as CesiumMath } from "cesium"
import { describe, expect, it } from "vitest"
import { clampV3CameraRange, isCoordinateInsideRegion, normalizeHeadingRadians, regionBounds, regionCenter, regionMaskHierarchy, regionMaximumZoomDistance, regionMinimumZoomDistance, regionRectangle, regionSpanMeters } from "./map-region-constraints"

const region = {
  boundary: [
    { longitude: 113.90, latitude: 22.50 },
    { longitude: 113.96, latitude: 22.50 },
    { longitude: 113.96, latitude: 22.55 },
    { longitude: 113.90, latitude: 22.55 }
  ]
} as V3RegionCatalogItem

describe("teaching region map constraints", () => {
  it("normalizes headings without losing the 0/2π equivalence", () => {
    expect(normalizeHeadingRadians(0)).toBe(0)
    expect(normalizeHeadingRadians(CesiumMath.TWO_PI)).toBe(0)
    expect(normalizeHeadingRadians(-Math.PI / 2)).toBeCloseTo(Math.PI * 1.5)
    expect(normalizeHeadingRadians(Math.PI * 5)).toBeCloseTo(Math.PI)
  })

  it("derives a stable rectangle and center from the preset boundary", () => {
    expect(regionBounds(region)).toEqual({ west: 113.9, south: 22.5, east: 113.96, north: 22.55 })
    expect(regionCenter(region)).toEqual({ longitude: 113.93, latitude: 22.525 })
    const rectangle = regionRectangle(region)
    expect(rectangle).toBeDefined()
    expect(rectangle && CesiumMath.toDegrees(rectangle.west)).toBeCloseTo(113.9)
    expect(rectangle && CesiumMath.toDegrees(rectangle.south)).toBeCloseTo(22.5)
    expect(rectangle && CesiumMath.toDegrees(rectangle.east)).toBeCloseTo(113.96)
    expect(rectangle && CesiumMath.toDegrees(rectangle.north)).toBeCloseTo(22.55)
  })

  it("applies padding only to the camera rectangle", () => {
    const rectangle = regionRectangle(region, 0.1)
    expect(rectangle && CesiumMath.toDegrees(rectangle.west)).toBeCloseTo(113.894)
    expect(rectangle && CesiumMath.toDegrees(rectangle.south)).toBeCloseTo(22.495)
    expect(rectangle && CesiumMath.toDegrees(rectangle.east)).toBeCloseTo(113.966)
    expect(rectangle && CesiumMath.toDegrees(rectangle.north)).toBeCloseTo(22.555)
  })

  it("reports a useful physical span for zoom limits", () => {
    expect(regionSpanMeters(region)).toBeGreaterThan(6_000)
    expect(regionSpanMeters(region)).toBeLessThan(10_000)
    expect(regionMaximumZoomDistance(region)).toBeGreaterThan(10_000)
    expect(regionMaximumZoomDistance(region)).toBeLessThan(18_000)
    expect(regionMinimumZoomDistance(region)).toBeGreaterThan(10)
    expect(regionMinimumZoomDistance(region)).toBeLessThan(100)
  })

  it("keeps camera presets within a useful teaching-region range", () => {
    const span = regionSpanMeters(region)

    expect(clampV3CameraRange(region, 1)).toBeCloseTo(Math.max(12, span * 0.008))
    expect(clampV3CameraRange(region, 1_000_000)).toBeCloseTo(Math.max(800, span * 1.15))
    expect(clampV3CameraRange(region, Number.NaN)).toBeCloseTo(Math.max(800, span * 1.15))
    expect(clampV3CameraRange(region, span * 0.5)).toBeCloseTo(span * 0.5)
  })

  it("builds an outside mask with the teaching boundary as a hole", () => {
    const mask = regionMaskHierarchy(region)
    expect(mask).toBeDefined()
    expect(mask?.positions).toHaveLength(4)
    expect(mask?.holes).toHaveLength(1)
    expect(mask?.holes[0]?.positions).toHaveLength(4)
  })

  it("accepts points inside or on the teaching boundary and rejects outside points", () => {
    expect(isCoordinateInsideRegion(region, { longitude: 113.93, latitude: 22.525 })).toBe(true)
    expect(isCoordinateInsideRegion(region, { longitude: 113.90, latitude: 22.525 })).toBe(true)
    expect(isCoordinateInsideRegion(region, { longitude: 113.89, latitude: 22.525 })).toBe(false)
    expect(isCoordinateInsideRegion(region, { longitude: 113.93, latitude: 22.56 })).toBe(false)
  })
})
