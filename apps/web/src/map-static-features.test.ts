import { describe, expect, it } from "vitest"
import { CustomDataSource } from "cesium"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { renderRegionStaticFeatures } from "./map-static-features"

function region(): V3RegionCatalogItem {
  return {
    packageId: "runtime-static-test",
    packageVersion: "1.0.0",
    checksum: "a".repeat(64),
    sceneType: "CITY_SHOW",
    regionCode: "TEST-REGION",
    title: "测试区域",
    summary: "测试",
    center: { longitude: 114, latitude: 22 },
    boundary: [
      { longitude: 113.99, latitude: 21.99 },
      { longitude: 114.01, latitude: 21.99 },
      { longitude: 114.01, latitude: 22.01 }
    ],
    heightDatum: "AGL",
    terrainResourceVersion: "TEST-TERRAIN",
    imageryState: "AVAILABLE",
    layers: [
      {
        code: "BUILDINGS",
        title: "建筑与障碍",
        state: "AVAILABLE",
        source: "测试数据",
        version: "1",
        features: [
          {
            id: "building-1",
            name: "测试建筑",
            geometryType: "POLYGON",
            positions: [
              { longitude: 113.999, latitude: 21.999 },
              { longitude: 114.001, latitude: 21.999 },
              { longitude: 114.001, latitude: 22.001 }
            ],
            heightMeters: 40,
            properties: { category: "BUILDING" }
          },
          {
            id: "obstacle-1",
            name: "测试障碍物",
            geometryType: "POINT",
            position: { longitude: 114.002, latitude: 22 },
            heightMeters: 30,
            properties: { category: "OBSTACLE", radiusMeters: 8 }
          }
        ]
      },
      {
        code: "RESTRICTIONS",
        title: "限制区",
        state: "AVAILABLE",
        source: "测试数据",
        version: "1",
        features: [
          {
            id: "restriction-1",
            name: "限制区",
            geometryType: "POLYGON",
            positions: [
              { longitude: 114.003, latitude: 22.003 },
              { longitude: 114.004, latitude: 22.003 },
              { longitude: 114.004, latitude: 22.004 }
            ],
            properties: {}
          }
        ]
      }
    ] as V3RegionCatalogItem["layers"]
  }
}

describe("runtime static map features", () => {
  it("renders building height as an extruded polygon only in 3D", () => {
    const source = new CustomDataSource("test-3d")

    renderRegionStaticFeatures(source, region(), "3d", "show-runtime-static")

    const building = source.entities.getById("show-runtime-static:layer:BUILDINGS:building-1")
    expect(building?.polygon?.extrudedHeight?.getValue()).toBe(40)
    expect(building?.polygon?.extrudedHeightReference?.getValue()).toBeDefined()
    expect(building?.polyline).toBeUndefined()
  })

  it("keeps building geometry flat in 2D", () => {
    const source = new CustomDataSource("test-2d")

    renderRegionStaticFeatures(source, region(), "2d", "show-runtime-static")

    const building = source.entities.getById("show-runtime-static:layer:BUILDINGS:building-1")
    expect(building?.polygon?.extrudedHeight).toBeUndefined()
    expect(building?.polyline).toBeDefined()
  })

  it("renders a 3D obstacle as a cylinder instead of a point", () => {
    const source = new CustomDataSource("test-obstacle")

    renderRegionStaticFeatures(source, region(), "3d", "logistics-runtime-static")

    const obstacle = source.entities.getById("logistics-runtime-static:layer:BUILDINGS:obstacle-1")
    expect(obstacle?.cylinder?.length?.getValue()).toBe(30)
    expect(obstacle?.cylinder?.bottomRadius?.getValue()).toBe(8)
    expect(obstacle?.point).toBeUndefined()
  })

  it("limits 3D static features to a regional display distance", () => {
    const source = new CustomDataSource("test-distance")

    renderRegionStaticFeatures(source, region(), "3d", "show-runtime-static")

    const building = source.entities.getById("show-runtime-static:layer:BUILDINGS:building-1")
    const condition = building?.polygon?.distanceDisplayCondition?.getValue()
    expect(condition?.near).toBe(0)
    expect(condition?.far).toBeGreaterThan(5_000)
  })

  it("does not add 3D distance culling to 2D planning features", () => {
    const source = new CustomDataSource("test-2d-distance")

    renderRegionStaticFeatures(source, region(), "2d", "show-runtime-static")

    const building = source.entities.getById("show-runtime-static:layer:BUILDINGS:building-1")
    expect(building?.polygon?.distanceDisplayCondition).toBeUndefined()
  })

  it("skips unavailable layers", () => {
    const value = region()
    const restrictions = value.layers.find((layer) => layer.code === "RESTRICTIONS")
    if (!restrictions) throw new Error("测试区域缺少限制区图层")
    restrictions.state = "UNAVAILABLE"
    const source = new CustomDataSource("test-unavailable")

    renderRegionStaticFeatures(source, value, "3d", "show-runtime-static")

    expect(source.entities.getById("show-runtime-static:layer:RESTRICTIONS:restriction-1")).toBeUndefined()
  })
})
