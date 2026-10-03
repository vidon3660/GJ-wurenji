import { describe, expect, it } from "vitest"
import { v3RegionLayerCodes } from "@wurenji/shared"
import { parseRegionCatalogItem } from "./region-catalog.js"
import { ResourcePackageEntity } from "./resource-package.entity.js"

describe("V3 region catalog", () => {
  it("ignores region packages without the typed catalog version", () => {
    expect(parseRegionCatalogItem(regionEntity({ legacy: true }))).toBeNull()
  })

  it("parses a WGS84 region with exactly five thematic layers", () => {
    const item = parseRegionCatalogItem(regionEntity(validManifest()))

    expect(item).toMatchObject({
      packageId: "region-package-id",
      packageVersion: "1.2.0",
      sceneType: "CITY_SHOW",
      regionCode: "SHOW-TEST-01",
      heightDatum: "AGL",
      terrainResourceVersion: "dem-test-v1"
    })
    expect(item?.layers.map((layer) => layer.code)).toEqual(v3RegionLayerCodes)
    expect(item?.layers[0]?.features[0]?.properties).toEqual({ level: 3, enabled: true })
  })

  it("rejects incomplete or duplicated thematic layers", () => {
    const missingLayerManifest = validManifest()
    missingLayerManifest.layers = missingLayerManifest.layers.slice(0, 4)
    expect(() => parseRegionCatalogItem(regionEntity(missingLayerManifest))).toThrow("必须且只能包含五类专题图层")

    const duplicatedLayerManifest = validManifest()
    duplicatedLayerManifest.layers = [
      ...duplicatedLayerManifest.layers.slice(0, 4),
      duplicatedLayerManifest.layers[0]
    ]
    expect(() => parseRegionCatalogItem(regionEntity(duplicatedLayerManifest))).toThrow("必须且只能包含五类专题图层")
  })

  it("rejects invalid boundaries and out-of-range coordinates", () => {
    const shortBoundaryManifest = validManifest()
    shortBoundaryManifest.boundary = shortBoundaryManifest.boundary.slice(0, 2)
    expect(() => parseRegionCatalogItem(regionEntity(shortBoundaryManifest))).toThrow("boundary 至少需要 3 个坐标点")

    const invalidCenterManifest = validManifest()
    invalidCenterManifest.center = { longitude: 181, latitude: 31.2 }
    expect(() => parseRegionCatalogItem(regionEntity(invalidCenterManifest))).toThrow("center.longitude")
  })

  it("requires a checksum when an elevation snapshot is declared", () => {
    const manifest = validManifest()
    manifest.terrain = {
      provider: "CESIUM_QUANTIZED_MESH",
      url: "/map/terrain/show-test/1.0.0/layer.json",
      version: "1.0.0",
      sha256: "b".repeat(64),
      verticalDatum: "AMSL",
      extent: [121.47, 31.21, 121.49, 31.23],
      elevationSampleUrl: "/map/regions/SHOW-TEST-01/elevation-samples.json"
    }
    expect(() => parseRegionCatalogItem(regionEntity(manifest))).toThrow("terrain.elevationSampleSha256")
  })

  it("parses and validates region-level versioned terrain metadata", () => {
    const manifest = validManifest()
    manifest.terrain = {
      provider: "CESIUM_QUANTIZED_MESH",
      url: "/map/terrain/show-test/1.0.0/layer.json",
      version: "1.0.0",
      sha256: "b".repeat(64),
      verticalDatum: "AMSL",
      extent: [121.47, 31.21, 121.49, 31.23]
    }
    expect(parseRegionCatalogItem(regionEntity(manifest))?.terrain).toEqual(manifest.terrain)

    const invalid = validManifest()
    invalid.terrain = { ...manifest.terrain, sha256: "invalid" }
    expect(() => parseRegionCatalogItem(regionEntity(invalid))).toThrow("terrain.sha256")

    const uncovered = validManifest()
    uncovered.terrain = { ...manifest.terrain, extent: [121.48, 31.22, 121.481, 31.221] }
    expect(() => parseRegionCatalogItem(regionEntity(uncovered))).toThrow("terrain.extent 覆盖范围不足")
  })

  it("parses and validates VTOL task resources inside the region boundary", () => {
    const manifest = validManifest()
    manifest.sceneType = "VTOL_INSPECTION"
    manifest.vtlTaskObjects = [{
      id: "task-1",
      code: "T-01",
      title: "巡检对象",
      type: "POINT",
      positions: [{ longitude: 121.48, latitude: 31.22 }],
      requirement: "完成检查",
      completionRule: "到达并观察",
      required: true,
      estimatedWorkSeconds: 60
    }]
    manifest.vtlLandingSites = [
      { id: "main-1", code: "MAIN-01", title: "主起降点", type: "MAIN", position: { longitude: 121.48, latitude: 31.22 }, elevationMeters: 10, status: "AVAILABLE", relatedAlternateSiteIds: ["alternate-1"] },
      { id: "alternate-1", code: "ALT-01", title: "备降点", type: "ALTERNATE", position: { longitude: 121.482, latitude: 31.222 }, elevationMeters: 12, status: "AVAILABLE", relatedAlternateSiteIds: [] }
    ]
    manifest.vtlAircraftParameters = vtlAircraftParameters()

    const item = parseRegionCatalogItem(regionEntity(manifest))

    expect(item?.sceneType).toBe("VTOL_INSPECTION")
    expect(item?.vtlTaskObjects).toHaveLength(1)
    expect(item?.vtlLandingSites?.find((site) => site.type === "MAIN")?.relatedAlternateSiteIds).toEqual(["alternate-1"])
  })

  it("rejects a VTOL region without an alternate landing site or with an out-of-bound task", () => {
    const missingAlternate = validManifest()
    missingAlternate.sceneType = "VTOL_INSPECTION"
    missingAlternate.vtlTaskObjects = [{ id: "task-1", code: "T-01", title: "任务", type: "POINT", positions: [{ longitude: 121.48, latitude: 31.22 }], requirement: "检查", completionRule: "完成", estimatedWorkSeconds: 60 }]
    missingAlternate.vtlLandingSites = [{ id: "main-1", code: "MAIN-01", title: "主点", type: "MAIN", position: { longitude: 121.48, latitude: 31.22 }, elevationMeters: 10, status: "AVAILABLE", relatedAlternateSiteIds: [] }]
    missingAlternate.vtlAircraftParameters = vtlAircraftParameters()
    expect(() => parseRegionCatalogItem(regionEntity(missingAlternate))).toThrow("缺少 ALTERNATE")

    const outside = { ...missingAlternate, vtlLandingSites: [
      { id: "main-1", code: "MAIN-01", title: "主点", type: "MAIN", position: { longitude: 121.48, latitude: 31.22 }, elevationMeters: 10, status: "AVAILABLE", relatedAlternateSiteIds: ["alternate-1"] },
      { id: "alternate-1", code: "ALT-01", title: "备降点", type: "ALTERNATE", position: { longitude: 121.482, latitude: 31.222 }, elevationMeters: 12, status: "AVAILABLE", relatedAlternateSiteIds: [] }
    ], vtlTaskObjects: [{ ...missingAlternate.vtlTaskObjects[0], positions: [{ longitude: 130, latitude: 40 }] }] }
    expect(() => parseRegionCatalogItem(regionEntity(outside))).toThrow("超出 boundary")
  })

  it("provides the fixed logistics airport and candidate nodes for legacy built-in regions", () => {
    const manifest = validLogisticsManifest()
    manifest.sceneType = "CITY_LOGISTICS"
    manifest.regionCode = "LOG-HUB-NORTH-01"

    const item = parseRegionCatalogItem(regionEntity(manifest))

    expect(item?.logisticsNodes?.filter((node) => node.type === "CENTER_AIRPORT")).toHaveLength(1)
    expect(item?.logisticsNodes?.filter((node) => node.type === "DELIVERY_POINT")).toHaveLength(12)
    expect(item?.logisticsNodes?.some((node) => node.type === "WAITING_POINT")).toBe(true)
    expect(item?.logisticsNodes?.some((node) => node.type === "ALTERNATE_LANDING_POINT")).toBe(true)
    expect(item?.logisticsNodes?.some((node) => node.type === "EMERGENCY_AREA")).toBe(true)
  })

  it("allows teacher-managed obstacles to be absent from logistics base resources", () => {
    const withoutObstacle = validLogisticsManifest()
    const buildingLayer = withoutObstacle.layers.find((layer: Record<string, unknown>) => layer.code === "BUILDINGS")
    buildingLayer.features = buildingLayer.features.filter((feature: Record<string, any>) => feature.properties.category !== "OBSTACLE")
    expect(parseRegionCatalogItem(regionEntity(withoutObstacle))).toBeTruthy()

    const missingHeight = validLogisticsManifest()
    const building = missingHeight.layers.find((layer: Record<string, unknown>) => layer.code === "BUILDINGS").features.find((feature: Record<string, any>) => feature.properties.category !== "OBSTACLE")
    delete building.heightMeters
    expect(() => parseRegionCatalogItem(regionEntity(missingHeight))).toThrow("缺少有效 heightMeters")
  })
})

function regionEntity(manifest: Record<string, unknown>): ResourcePackageEntity {
  return Object.assign(new ResourcePackageEntity(), {
    id: "region-package-id",
    packageType: "REGION",
    name: "测试表演区域",
    version: "1.2.0",
    sha256: "a".repeat(64),
    manifest
  })
}

function validManifest(): Record<string, any> {
  return {
    catalogVersion: 1,
    sceneType: "CITY_SHOW",
    regionCode: "SHOW-TEST-01",
    title: "测试表演区域",
    summary: "用于区域目录解析测试",
    center: { longitude: 121.48, latitude: 31.22 },
    boundary: [
      { longitude: 121.47, latitude: 31.21 },
      { longitude: 121.49, latitude: 31.21 },
      { longitude: 121.49, latitude: 31.23 },
      { longitude: 121.47, latitude: 31.23 }
    ],
    heightDatum: "AGL",
    terrainResourceVersion: "dem-test-v1",
    imageryState: "AVAILABLE",
    layers: v3RegionLayerCodes.map((code, index) => ({
      code,
      title: `图层 ${index + 1}`,
      state: "AVAILABLE",
      source: "unit-test",
      version: "1.0.0",
      features: index === 0
        ? [{
            id: "building-1",
            name: "测试建筑",
            geometryType: "POLYGON",
            positions: [
              { longitude: 121.48, latitude: 31.22 },
              { longitude: 121.481, latitude: 31.22 },
              { longitude: 121.481, latitude: 31.221 }
            ],
            properties: { level: 3, enabled: true, ignored: null }
          }]
        : []
    }))
  }
}

function validLogisticsManifest(): Record<string, any> {
  const manifest = validManifest()
  manifest.sceneType = "CITY_LOGISTICS"
  const buildingLayer = manifest.layers.find((layer: Record<string, unknown>) => layer.code === "BUILDINGS")
  buildingLayer.features[0].heightMeters = 42
  buildingLayer.features[0].properties.category = "BUILDING"
  buildingLayer.features.push({
    id: "obstacle-1",
    name: "测试高杆障碍",
    geometryType: "POINT",
    position: { longitude: 121.482, latitude: 31.222 },
    heightMeters: 35,
    properties: { category: "OBSTACLE", radiusMeters: 5 }
  })
  return manifest
}

function vtlAircraftParameters() {
  return {
    modelCode: "VTOL-TEST-01",
    version: "1.0.0",
    batteryCapacityWh: 1200,
    reserveEnergyRatio: 0.2,
    verticalPowerWatts: 2400,
    hoverPowerWatts: 1800,
    cruisePowerWatts: 900,
    taskPowerWatts: 1050,
    climbSpeedMps: 4,
    cruiseSpeedMps: 22,
    transitionSpeedMps: 12,
    minimumTransitionHeightMeters: 60,
    maximumOperatingAltitudeMeters: 300
  }
}
