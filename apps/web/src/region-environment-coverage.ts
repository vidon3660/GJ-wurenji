import type { SceneType, V3RegionCatalogItem, V3RegionLayerCode, V3RegionLayerState } from "@wurenji/shared"

export type EnvironmentCoverageSource = "LAYER" | "BASEMAP" | "BOUNDARY" | "NODE" | "TASK" | "PLAN"

export interface EnvironmentCoverageItem {
  code: string
  label: string
  source: EnvironmentCoverageSource
  layerCode: V3RegionLayerCode | null
  state: V3RegionLayerState
  detail: string
}

export interface EnvironmentCoverageOptions {
  details?: Record<string, string | undefined> | undefined
  plannedShowAreaTypes?: readonly string[] | undefined
}

export function regionEnvironmentCoverage(
  region: V3RegionCatalogItem,
  sceneType: SceneType,
  options: EnvironmentCoverageOptions = {}
): EnvironmentCoverageItem[] {
  return sceneType === "CITY_SHOW"
    ? showCoverage(region, options)
    : logisticsCoverage(region, options)
}

function showCoverage(region: V3RegionCatalogItem, options: EnvironmentCoverageOptions): EnvironmentCoverageItem[] {
  const audiencePlanned = options.plannedShowAreaTypes?.includes("AUDIENCE") ?? false
  return [
    layerCoverage(region, "SHOW_BUILDINGS", "建筑与高度", "BUILDINGS"),
    basemapCoverage(region, "SHOW_ROADS", "道路", "在线/离线影像底图参考"),
    basemapCoverage(region, "SHOW_WATER", "水域", "在线/离线影像底图参考"),
    basemapCoverage(region, "SHOW_GREEN", "绿地", "在线/离线影像底图参考"),
    layerCoverage(region, "SHOW_UNAVAILABLE", "不可用区域", "RESTRICTIONS"),
    {
      code: "SHOW_AIRSPACE_BOUNDARY",
      label: "空域边界",
      source: "BOUNDARY",
      layerCode: null,
      state: region.boundary.length >= 3 ? "AVAILABLE" : "UNAVAILABLE",
      detail: `区域包边界 · ${region.boundary.length} 个 WGS84 点`
    },
    layerCoverage(region, "SHOW_POSITIONING", "定位质量", "POSITIONING", options.details?.POSITIONING),
    layerCoverage(region, "SHOW_ELECTROMAGNETIC", "电磁环境", "POSITIONING", options.details?.ELECTROMAGNETIC),
    layerCoverage(region, "SHOW_WIND", "风向与气象", "ENVIRONMENT", options.details?.WEATHER),
    {
      code: "SHOW_AUDIENCE",
      label: "观众条件",
      source: audiencePlanned ? "PLAN" : "TASK",
      layerCode: null,
      state: options.details?.AUDIENCE ? "AVAILABLE" : "DEGRADED",
      detail: audiencePlanned
        ? `${options.details?.AUDIENCE ?? "任务观众条件"} · 已规划观众区`
        : `${options.details?.AUDIENCE ?? "任务观众条件未命名"} · 观众区待规划`
    }
  ]
}

function logisticsCoverage(region: V3RegionCatalogItem, options: EnvironmentCoverageOptions): EnvironmentCoverageItem[] {
  return [
    nodeCoverage(region, "LOG_CENTER_AIRPORT", "中心机场", "CENTER_AIRPORT"),
    nodeCoverage(region, "LOG_DELIVERY_POINTS", "候选配送点", "DELIVERY_POINT"),
    featureCategoryCoverage(region, "LOG_BUILDINGS", "建筑与高度", "BUILDINGS", "BUILDING"),
    featureCategoryCoverage(region, "LOG_OBSTACLES", "障碍", "BUILDINGS", "OBSTACLE"),
    layerCoverage(region, "LOG_RESTRICTIONS", "禁限区域", "RESTRICTIONS"),
    layerCoverage(region, "LOG_WEATHER", "气象", "ENVIRONMENT", options.details?.WEATHER),
    layerCoverage(region, "LOG_POSITIONING", "定位", "POSITIONING", options.details?.POSITIONING),
    layerCoverage(region, "LOG_COMMUNICATION", "通信", "COMMUNICATION", options.details?.COMMUNICATION),
    nodeCoverage(region, "LOG_WAITING_POINTS", "候选等待区域", "WAITING_POINT"),
    nodeCoverage(region, "LOG_ALTERNATE_POINTS", "候选备降区域", "ALTERNATE_LANDING_POINT")
  ]
}

function featureCategoryCoverage(
  region: V3RegionCatalogItem,
  code: string,
  label: string,
  layerCode: V3RegionLayerCode,
  category: "BUILDING" | "OBSTACLE"
): EnvironmentCoverageItem {
  const layer = region.layers.find((item) => item.code === layerCode)
  const features = layer?.features.filter((feature) => {
    const featureCategory = String(feature.properties.category ?? "").toUpperCase()
    return category === "OBSTACLE" ? featureCategory === "OBSTACLE" : featureCategory !== "OBSTACLE"
  }) ?? []
  return {
    code,
    label,
    source: "LAYER",
    layerCode,
    state: layer && features.length > 0 ? layer.state : "UNAVAILABLE",
    detail: layer && features.length > 0 ? `${layer.title} · ${features.length} 项 · ${layer.source}` : `区域包未提供${label}要素`
  }
}

function layerCoverage(
  region: V3RegionCatalogItem,
  code: string,
  label: string,
  layerCode: V3RegionLayerCode,
  taskDetail?: string
): EnvironmentCoverageItem {
  const layer = region.layers.find((item) => item.code === layerCode)
  return {
    code,
    label,
    source: taskDetail ? "TASK" : "LAYER",
    layerCode,
    state: layer?.state ?? "UNAVAILABLE",
    detail: taskDetail || (layer ? `${layer.title} · ${layer.features.length} 项 · ${layer.source}` : "区域包未提供该图层")
  }
}

function basemapCoverage(region: V3RegionCatalogItem, code: string, label: string, detail: string): EnvironmentCoverageItem {
  const hasFormalImagery = Boolean(region.imagery?.url?.trim())
  const unavailable = region.imageryState === "UNAVAILABLE"
  return {
    code,
    label,
    source: "BASEMAP",
    layerCode: null,
    state: unavailable ? "UNAVAILABLE" : hasFormalImagery ? region.imageryState : "DEGRADED",
    detail: unavailable ? "区域包未提供正式影像 · 当前使用教学底图" : hasFormalImagery ? detail : "区域未配置正式影像 · 当前使用教学底图"
  }
}

function nodeCoverage(
  region: V3RegionCatalogItem,
  code: string,
  label: string,
  type: NonNullable<V3RegionCatalogItem["logisticsNodes"]>[number]["type"]
): EnvironmentCoverageItem {
  const nodes = (region.logisticsNodes ?? []).filter((node) => node.type === type && node.enabled)
  return {
    code,
    label,
    source: "NODE",
    layerCode: null,
    state: nodes.length > 0 ? "AVAILABLE" : "UNAVAILABLE",
    detail: nodes.length > 0 ? `区域节点 · ${nodes.length} 项` : "区域包未提供该类节点"
  }
}
