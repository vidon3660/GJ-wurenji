import { describe, expect, it } from "vitest"
import type { V3RegionFeature } from "@wurenji/shared"
import { featureHeightMeters, isObstacleFeature, obstacleRadiusMeters } from "./map-3d-feature"

function feature(overrides: Partial<V3RegionFeature> = {}): V3RegionFeature {
  return {
    id: "feature-1",
    name: "测试对象",
    geometryType: "POINT",
    position: { longitude: 114, latitude: 22 },
    properties: {},
    ...overrides
  }
}

describe("3D map feature helpers", () => {
  it("normalizes missing, invalid, and negative heights", () => {
    expect(featureHeightMeters(feature())).toBe(0)
    expect(featureHeightMeters(feature({ heightMeters: -4 }))).toBe(0)
    expect(featureHeightMeters(feature({ heightMeters: 42 }))).toBe(42)
    expect(featureHeightMeters(feature({ heightMeters: Number.NaN }))).toBe(0)
  })

  it("detects obstacle categories without changing other feature types", () => {
    expect(isObstacleFeature(feature({ properties: { category: "OBSTACLE" } }))).toBe(true)
    expect(isObstacleFeature(feature({ properties: { category: "obstacle" } }))).toBe(true)
    expect(isObstacleFeature(feature({ properties: { category: "BUILDING" } }))).toBe(false)
  })

  it("keeps obstacle radius positive and finite", () => {
    expect(obstacleRadiusMeters(feature({ properties: { radiusMeters: 8 } }))).toBe(8)
    expect(obstacleRadiusMeters(feature({ properties: { radiusMeters: 0 } }))).toBe(1)
    expect(obstacleRadiusMeters(feature({ properties: { radiusMeters: "bad" } }))).toBe(5)
  })
})
