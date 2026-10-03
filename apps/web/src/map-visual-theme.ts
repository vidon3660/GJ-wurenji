/**
 * 高德风格浅色 3D 教学地图 —— 统一视觉变量（MAP-A01）。
 *
 * 规则：
 * 1. 地图组件内不得再散落硬编码颜色，一律从本文件取语义色。
 * 2. 2D / 3D 使用同一语义颜色，模式差异只体现在明度、透明度和高度表达上。
 * 3. 颜色命名按教学语义（禁飞区、障碍物、起降点……），不按组件命名。
 */
import type {
  LogisticsRuntimeAircraftView,
  LogisticsRuntimeRouteView,
  ShowAreaFeatureType,
  ShowRuntimeGroupView,
  V3RegionLayerCode
} from "@wurenji/shared"
import { Color } from "cesium"

/** 浅色矢量底图（画布教学底图与未来道路/绿地/水系图层共用） */
export const mapBasemapColors = {
  /** 陆地底色 */
  land: "#e4e9e5",
  /** Viewer 未加载瓦片时的空画布底色 */
  emptyCanvas: "#dce3de",
  greenAreaLight: "#cbdccf",
  greenAreaSoft: "#d7e2cc",
  waterEdge: "#9dc8d2",
  waterCore: "#c8e0e4",
  roadMinor: "#ffffff",
  roadMajorCasing: "#f2d28c",
  roadMajor: "#fff8e5",
  buildingFootprint: "#c7ceca",
  buildingFootprintAlt: "#b8c1bd",
  buildingFootprintEdge: "#aeb7b3",
  tileSeam: "rgba(71, 91, 82, 0.08)",
  gridFallbackStroke: "#70867a",
  gridFallbackGlow: "#edf2ef"
} as const

/** 教学区域与区域外遮罩 */
export const mapRegionColors = {
  boundary: "#267052",
  boundaryFillAlpha: 0.08,
  mask: "#77837d",
  maskAlpha: 0.2,
  centerPoint: "#1d5d47",
  titleLabel: "#153f32"
} as const

/** 区域图层语义色（V3RegionLayerCode） */
export const mapLayerColors: Record<V3RegionLayerCode, string> = {
  BUILDINGS: "#9fb0a8",
  RESTRICTIONS: "#c55245",
  WATER: "#5d9fb2",
  GREENLAND: "#78a56f",
  POSITIONING: "#2876a8",
  COMMUNICATION: "#7558a6",
  ENVIRONMENT: "#b8862f"
}

/** 2.5D 建筑：低饱和浅灰，按高度产生轻微层次（MAP-A03） */
export const mapBuildingColors = {
  /** 高度带：左闭右开，超过最后一段取最后一档 */
  heightBands: [
    { maximumMeters: 15, color: "#d7dcda" },
    { maximumMeters: 40, color: "#c9d1cd" },
    { maximumMeters: Number.POSITIVE_INFINITY, color: "#bcc6c0" }
  ],
  /** 3D 拉伸体不透明度（顶面与侧面共用） */
  extrudedAlpha: 0.95,
  /** 3D 建筑边界弱化 */
  outline3d: "#adb7b2",
  /** 2D 建筑轮廓 */
  outline2d: "#98a49e",
  /** 2D 建筑面透明度 */
  flatAlpha: 0.55,
  /** 缺少高度数据时的回退高度（教学演示用途，必须与正式高程区分） */
  fallbackHeightMeters: 12
} as const

/** 障碍物（橙红/紫红系，与禁飞区红色区分） */
export const mapObstacleColors = {
  fill: "#a83b56",
  box: "#68766e",
  cylinderAlpha: 0.72,
  pointAlpha: 1,
  label: "#8c2f47"
} as const

/** 禁飞区 / 限制区：边界增强（MAP-A03） */
export const mapRestrictionColors = {
  fill: "#c55245",
  flatAlpha: 0.22,
  extrudedAlpha: 0.3,
  outlineWidth2d: 2.5,
  outlineWidth3d: 3
} as const

/** 教学 POI 语义色（MAP-B02） */
export const mapPoiColors = {
  takeoffLanding: "#1d6f52",
  takeoffLabel: "#0d6044",
  landingSiteSecondary: "#8a6a24",
  landingPointLabel: "#1e5e94",
  deliveryPoint: "#2f6fa9",
  deliveryNode: "#637d73",
  deliveryNodeInactive: "#7f9089",
  deliveryNodeSelected: "#1c7654",
  inspectionPoint: "#b9700c",
  teachingBuilding: "#55706a",
  waitingPoint: "#2f78a5",
  alternateLanding: "#bd7b2c",
  emergencyArea: "#a94d42",
  centerAirport: "#244d3e",
  takeoffPoint: "#1f7654",
  landingPoint: "#375f91",
  nodeDefault: "#263f36"
} as const

/** 航线语义色 */
export const mapRouteColors = {
  outbound: "#247457",
  return: "#2f6e9c",
  alternate: "#bd7f27",
  vtlInspection: "#2667a6",
  /** 多机练习航线调色板（按索引轮换） */
  multiDronePalette: ["#147b58", "#2f6fa9", "#b9700c", "#7a61a8", "#bb4f49", "#267d88"]
} as const

export const logisticsRuntimeRouteStatusColors: Record<LogisticsRuntimeRouteView["status"], string> = {
  AVAILABLE: "#2c7357",
  RISK: "#b57d25",
  PAUSED: "#8d6b28",
  ABNORMAL: "#b3463f",
  RECOVERING: "#397798",
  CLOSED: "#6b3438"
}

export const logisticsRuntimeAircraftStatusColors: Record<LogisticsRuntimeAircraftView["status"], string> = {
  STANDBY: "#8a8173",
  AVAILABLE: "#587168",
  ASSIGNED: "#2e6f91",
  TAKING_OFF: "#347a9a",
  OUTBOUND: "#247354",
  ARRIVED: "#6b7331",
  RETURNING: "#2f7098",
  LANDING: "#78662d",
  HOLDING: "#bd8429",
  DIVERTING: "#b65b34",
  EMERGENCY_LANDING: "#b4443d",
  DISABLED: "#6f3035"
}

/** 城市表演运行分组状态色 */
export const showRuntimeGroupStatusColors: Record<ShowRuntimeGroupView["status"], string> = {
  GROUND: "#5f756c",
  TAKING_OFF: "#2c79a0",
  AIRBORNE: "#247354",
  RETURNING: "#2c79a0",
  LANDING: "#756332",
  LANDED: "#5f756c",
  WARNING: "#c08a2f",
  ABNORMAL: "#b84c43",
  LOST: "#782e37"
}

export const showRuntimeColors = {
  performanceArea: "#247354"
} as const

/** 运行事件与密集点聚合 */
export const mapRuntimeEventColors = {
  critical: "#b4443d",
  warning: "#c18628",
  pointOverlayAlpha: 0.22,
  clusterFill: "#f5fbf8",
  clusterFillAlpha: 0.92,
  clusterOutline: "#21694f",
  clusterLabel: "#1d5e46"
} as const

/** 垂起巡检（VTL）教学专题色 */
export const vtlColors = {
  zonePalette: ["#2876a8", "#7558a6", "#b96d2d", "#2f8067", "#ae4f45"],
  taskCompleted: "#287457",
  taskIncomplete: "#b84e43",
  taskInProgress: "#2f76a7",
  taskPending: "#b96d2d",
  aircraftNormal: "#246f9b",
  aircraftAlert: "#c55345"
} as const

/** 垂起航线飞行阶段色 */
export const vtlPhaseColors: Record<string, string> = {
  VERTICAL_TAKEOFF: "#2876a8",
  CLIMB: "#3182bd",
  FORWARD_TRANSITION: "#7058a6",
  FIXED_WING_CRUISE: "#2667a6",
  TASK_EXECUTION: "#b96d2d",
  RETURN: "#a44e43",
  BACK_TRANSITION: "#8a6a24",
  VERTICAL_LANDING: "#1d6f52"
}

/** 场地规划（城市表演）要素类型色 */
export const showAreaFeatureColors: Record<ShowAreaFeatureType, string> = {
  TAKEOFF_LANDING: "#1d6f52",
  FLIGHT: "#3182bd",
  PERFORMANCE: "#7258a6",
  BUFFER: "#d49b31",
  GROUND_ISOLATION: "#9b6554",
  AUDIENCE: "#d45f6e",
  OPERATION: "#52766f",
  EMERGENCY_LANDING: "#cf7041",
  GEOFENCE: "#ae3c4b"
}

/** 交互状态色：悬停 / 选中 / 告警 / 禁用（MAP-B05） */
export const mapInteractionColors = {
  selected: "#f2a900",
  selectedSoft: "#e4a92f",
  selectedOutline: "#f2b53f",
  hover: "#ffffff",
  alert: "#c55245",
  disabled: "#9aa39d",
  drawing: "#b96d2d",
  measurement: "#173e32",
  lockedWaypoint: "#263c34",
  annotationInk: "#173e32",
  labelInk: "#27322c",
  droneLabelInk: "#17201c"
} as const

const colorCache = new Map<string, Color>()

/** 由 CSS 颜色串取缓存的 Cesium Color */
export function mapColor(cssColor: string): Color {
  let color = colorCache.get(cssColor)
  if (!color) {
    color = Color.fromCssColorString(cssColor)
    colorCache.set(cssColor, color)
  }
  return color
}

/** 带透明度的缓存色（返回新实例，允许调用方再加工） */
export function mapColorAlpha(cssColor: string, alpha: number): Color {
  return mapColor(cssColor).withAlpha(alpha)
}

export const regionLayerCesiumColors: Record<V3RegionLayerCode, Color> = {
  BUILDINGS: mapColor(mapLayerColors.BUILDINGS),
  RESTRICTIONS: mapColor(mapLayerColors.RESTRICTIONS),
  WATER: mapColor(mapLayerColors.WATER),
  GREENLAND: mapColor(mapLayerColors.GREENLAND),
  POSITIONING: mapColor(mapLayerColors.POSITIONING),
  COMMUNICATION: mapColor(mapLayerColors.COMMUNICATION),
  ENVIRONMENT: mapColor(mapLayerColors.ENVIRONMENT)
}

/** 建筑高度 → 高度带颜色（浅灰三级层次） */
export function buildingColorForHeight(heightMeters: number): Color {
  const band = mapBuildingColors.heightBands.find((item) => heightMeters < item.maximumMeters)
    ?? mapBuildingColors.heightBands[mapBuildingColors.heightBands.length - 1]!
  return mapColor(band.color)
}
