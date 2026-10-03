import { describe, expect, it } from "vitest"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { regionEnvironmentCoverage } from "./region-environment-coverage"

describe("region environment coverage", () => {
  it("covers every show STU-005 environment item", () => {
    const items = regionEnvironmentCoverage(region("CITY_SHOW"), "CITY_SHOW", {
      details: { WEATHER: "东北风", POSITIONING: "正常", ELECTROMAGNETIC: "局部较弱", AUDIENCE: "1200 人" },
      plannedShowAreaTypes: ["AUDIENCE"]
    })

    expect(items.map((item) => item.label)).toEqual([
      "建筑与高度", "道路", "水域", "绿地", "不可用区域", "空域边界", "定位质量", "电磁环境", "风向与气象", "观众条件"
    ])
    expect(items.find((item) => item.label === "观众条件")).toMatchObject({ source: "PLAN", state: "AVAILABLE" })
    expect(items.find((item) => item.label === "道路")).toMatchObject({ source: "BASEMAP", state: "DEGRADED", detail: "区域未配置正式影像 · 当前使用教学底图" })
    expect(items.find((item) => item.label === "风向与气象")).toMatchObject({ source: "TASK", detail: "东北风" })
  })

  it("covers every logistics STU-005 environment item", () => {
    const items = regionEnvironmentCoverage(region("CITY_LOGISTICS"), "CITY_LOGISTICS", {
      details: { WEATHER: "正常", POSITIONING: "局部较弱", COMMUNICATION: "正常" }
    })

    expect(items.map((item) => item.label)).toEqual([
      "中心机场", "候选配送点", "建筑与高度", "障碍", "禁限区域", "气象", "定位", "通信", "候选等待区域", "候选备降区域"
    ])
    expect(items.find((item) => item.label === "候选配送点")?.detail).toContain("1 项")
    expect(items.find((item) => item.label === "建筑与高度")?.detail).toContain("1 项")
    expect(items.find((item) => item.label === "障碍")?.detail).toContain("1 项")
    expect(items.find((item) => item.label === "通信")).toMatchObject({ source: "TASK", detail: "正常" })
  })

  it("does not report obstacle coverage when the building layer has no obstacle feature", () => {
    const value = region("CITY_LOGISTICS")
    const buildingLayer = value.layers.find((layer) => layer.code === "BUILDINGS")!
    buildingLayer.features = buildingLayer.features.filter((feature) => feature.properties.category !== "OBSTACLE")

    const items = regionEnvironmentCoverage(value, "CITY_LOGISTICS")

    expect(items.find((item) => item.label === "建筑与高度")?.state).toBe("AVAILABLE")
    expect(items.find((item) => item.label === "障碍")).toMatchObject({ state: "UNAVAILABLE", detail: "区域包未提供障碍要素" })
  })

  it("reports unavailable resources instead of inventing coverage", () => {
    const value = region("CITY_SHOW")
    value.imageryState = "UNAVAILABLE"
    value.layers = value.layers.filter((layer) => layer.code !== "RESTRICTIONS")

    const items = regionEnvironmentCoverage(value, "CITY_SHOW")
    expect(items.find((item) => item.label === "道路")?.state).toBe("UNAVAILABLE")
    expect(items.find((item) => item.label === "不可用区域")).toMatchObject({ state: "UNAVAILABLE", detail: "区域包未提供该图层" })
  })
})

function region(sceneType: V3RegionCatalogItem["sceneType"]): V3RegionCatalogItem {
  return {
    packageId: "region-1",
    packageVersion: "1.0.0",
    checksum: "a".repeat(64),
    sceneType,
    regionCode: "TEST-REGION",
    title: "测试区域",
    summary: "测试",
    center: { longitude: 114, latitude: 22 },
    boundary: [{ longitude: 113.9, latitude: 21.9 }, { longitude: 114.1, latitude: 21.9 }, { longitude: 114.1, latitude: 22.1 }],
    heightDatum: "AGL",
    terrainResourceVersion: "TEST-DEM",
    imageryState: "AVAILABLE",
    layers: ["BUILDINGS", "RESTRICTIONS", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"].map((code) => ({
      code: code as V3RegionCatalogItem["layers"][number]["code"],
      title: code,
      state: "AVAILABLE",
      source: "教学数据",
      version: "1",
      features: code === "BUILDINGS"
        ? [
            { id: "building", name: "建筑", geometryType: "POLYGON" as const, positions: [{ longitude: 113.999, latitude: 21.999 }, { longitude: 114.001, latitude: 21.999 }, { longitude: 114.001, latitude: 22.001 }], heightMeters: 40, properties: { category: "BUILDING" } },
            { id: "obstacle", name: "障碍", geometryType: "POINT" as const, position: { longitude: 114.002, latitude: 22 }, heightMeters: 30, properties: { category: "OBSTACLE" } }
          ]
        : [{ id: code, name: code, geometryType: "POINT" as const, position: { longitude: 114, latitude: 22 }, properties: {} }]
    })),
    logisticsNodes: [
      { id: "airport", code: "AP", type: "CENTER_AIRPORT", name: "中心机场", geometryType: "POINT", position: { longitude: 114, latitude: 22 }, enabled: true, properties: {} },
      { id: "delivery", code: "DP", type: "DELIVERY_POINT", name: "配送点", geometryType: "POINT", position: { longitude: 114.01, latitude: 22 }, enabled: true, properties: {} },
      { id: "waiting", code: "WP", type: "WAITING_POINT", name: "等待点", geometryType: "POINT", position: { longitude: 114.02, latitude: 22 }, enabled: true, properties: {} },
      { id: "alternate", code: "AL", type: "ALTERNATE_LANDING_POINT", name: "备降点", geometryType: "POINT", position: { longitude: 114.03, latitude: 22 }, enabled: true, properties: {} }
    ]
  }
}
