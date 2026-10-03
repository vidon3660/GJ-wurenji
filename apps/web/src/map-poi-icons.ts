/**
 * 教学 POI 图标与名称（MAP-B02）。
 *
 * 用纯字符串拼接生成 SVG data-URL 图钉图标：
 * - 不依赖外部地图 POI 服务，也不依赖 canvas（保持 SSR/测试环境无 DOM 可用）。
 * - 图标锚点固定在尾尖（verticalOrigin=BOTTOM），2D/3D 位置一致。
 * - 普通/悬停/选中/告警/禁用共用同一分类色，只切换描边环与尺寸层级（MAP-B05）。
 */
import { HeightReference, VerticalOrigin } from "cesium"
import type { V3LogisticsNodeType } from "@wurenji/shared"
import { mapColor, mapInteractionColors, mapObstacleColors, mapPoiColors } from "./map-visual-theme"

export type V3PoiState = "normal" | "hover" | "selected" | "alert" | "disabled"

export type V3PoiCategory =
  | "takeoff"
  | "landing"
  | "airport"
  | "delivery"
  | "inspection"
  | "waiting"
  | "alternate"
  | "emergency"
  | "communication"
  | "obstacle"
  | "building"
  | "generic"

/** 分类主色（图钉填充色），与统一视觉变量保持同源。 */
const poiCategoryColor: Record<V3PoiCategory, string> = {
  takeoff: mapPoiColors.takeoffPoint,
  landing: mapPoiColors.landingPoint,
  airport: mapPoiColors.centerAirport,
  delivery: mapPoiColors.deliveryPoint,
  inspection: mapPoiColors.inspectionPoint,
  waiting: mapPoiColors.waitingPoint,
  alternate: mapPoiColors.alternateLanding,
  emergency: mapPoiColors.emergencyArea,
  communication: "#7558a6",
  obstacle: mapObstacleColors.fill,
  building: mapPoiColors.teachingBuilding,
  generic: mapPoiColors.nodeDefault
}

/** 状态环色：普通/悬停用白，选中金、告警红、禁用灰。 */
const poiStateRing: Record<V3PoiState, string> = {
  normal: "#ffffff",
  hover: "#ffffff",
  selected: mapInteractionColors.selected,
  alert: mapInteractionColors.alert,
  disabled: mapInteractionColors.disabled
}

/** 状态尺寸系数：hover/selected 略放大形成层级，disabled 略缩小。 */
const poiStateScale: Record<V3PoiState, number> = {
  normal: 1,
  hover: 1.14,
  selected: 1.22,
  alert: 1.16,
  disabled: 0.9
}

function logisticsCategory(type: V3LogisticsNodeType): V3PoiCategory {
  switch (type) {
    case "TAKEOFF_POINT": return "takeoff"
    case "LANDING_POINT": return "landing"
    case "CENTER_AIRPORT": return "airport"
    case "DELIVERY_POINT": return "delivery"
    case "WAITING_POINT": return "waiting"
    case "ALTERNATE_LANDING_POINT": return "alternate"
    case "EMERGENCY_AREA": return "emergency"
    case "PARKING_POINT": return "generic"
    default: return "generic"
  }
}

export function poiCategoryForLogisticsNode(type: V3LogisticsNodeType): V3PoiCategory {
  return logisticsCategory(type)
}

/** 区域图层点要素分类：障碍/通信点单独成型，其余按通用点。 */
export function poiCategoryForRegionFeature(layerCode: string, options: { obstacle?: boolean; name?: string } = {}): V3PoiCategory {
  if (options.obstacle) return "obstacle"
  if (layerCode === "COMMUNICATION") return "communication"
  if (layerCode === "BUILDINGS") return "building"
  return "generic"
}

/** 每个分类内部图形（viewBox 坐标系，圆心 13,13、半径约 7 的范围内）。 */
function glyphMarkup(category: V3PoiCategory): string {
  const stroke = '#ffffff'
  const common = `fill="none" stroke="${stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`
  switch (category) {
    case "takeoff":
      return `<path d="M13 8 L17 16 L13 14 L9 16 Z" fill="${stroke}" stroke="none"/>`
    case "landing":
      return `<path d="M13 17 L9 9 L13 11 L17 9 Z" fill="${stroke}" stroke="none"/>`
    case "airport":
      return `<rect x="9.4" y="9.4" width="7.2" height="7.2" rx="1.6" ${common}/>`
    case "delivery":
      return `<path d="M13 8.4 L17.4 13 L13 17.6 L8.6 13 Z" ${common}/>`
    case "inspection":
      return `<circle cx="13" cy="13" r="4.4" ${common}/><circle cx="13" cy="13" r="1.4" fill="${stroke}" stroke="none"/>`
    case "waiting":
      return `<circle cx="13" cy="9.4" r="1.3" fill="${stroke}"/><circle cx="13" cy="13" r="1.3" fill="${stroke}"/><circle cx="13" cy="16.6" r="1.3" fill="${stroke}"/>`
    case "alternate":
      return `<path d="M13 8.2 L17.4 11.3 L15.7 16.4 L10.3 16.4 L8.6 11.3 Z" ${common}/>`
    case "emergency":
      return `<path d="M13 8.4 L13 13.6" ${common}/><circle cx="13" cy="16.4" r="1.2" fill="${stroke}"/>`
    case "communication":
      return `<circle cx="13" cy="13" r="1.6" fill="${stroke}"/><path d="M9.6 16.4 A4.8 4.8 0 0 1 9.6 9.6 M16.4 9.6 A4.8 4.8 0 0 1 16.4 16.4" ${common}/>`
    case "obstacle":
      return `<path d="M10 10 L16 16 M16 10 L10 16" ${common}/>`
    case "building":
      return `<path d="M9.4 16.6 L9.4 11.4 L13 8.8 L16.6 11.4 L16.6 16.6 Z" ${common}/>`
    default:
      return `<circle cx="13" cy="13" r="3.4" fill="${stroke}"/>`
  }
}

function buildSvgDataUrl(category: V3PoiCategory, state: V3PoiState): string {
  const fill = state === "disabled" ? mapInteractionColors.disabled : poiCategoryColor[category]
  const ring = poiStateRing[state]
  const ringWidth = state === "normal" ? 2 : state === "disabled" ? 1.6 : 3
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="34" viewBox="0 0 26 34">` +
    `<path d="M13 24 L8.6 25 L13 33 L17.4 25 Z" fill="${ring}" stroke="none"/>` +
    `<path d="M13 24 L8.6 25 L13 33 L17.4 25 Z" fill="${fill}" stroke="none" opacity="0.9"/>` +
    `<circle cx="13" cy="13" r="11.6" fill="${ring}" />` +
    `<circle cx="13" cy="13" r="${11.6 - ringWidth}" fill="${fill}" />` +
    glyphMarkup(category) +
    `</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const iconCache = new Map<string, string>()

/** 取指定分类与状态的 SVG data-URL（带缓存，避免重复拼接与 URI 编码）。 */
export function poiIconDataUrl(category: V3PoiCategory, state: V3PoiState = "normal"): string {
  const key = `${category}:${state}`
  let url = iconCache.get(key)
  if (!url) {
    url = buildSvgDataUrl(category, state)
    iconCache.set(key, url)
  }
  return url
}

export interface PoiBillboardOptions {
  state?: V3PoiState
  /** 是否贴地（3D 相对地形）。默认贴地。 */
  clampToGround?: boolean
  /** 覆盖默认尺寸基数（宽）。 */
  width?: number
}

/** 生成 Cesium billboard 图形参数：尾尖锚定点位，2D/3D 位置一致。 */
export function createPoiBillboard(category: V3PoiCategory, options: PoiBillboardOptions = {}) {
  const state = options.state ?? "normal"
  const scale = poiStateScale[state]
  const baseWidth = options.width ?? 22
  const baseHeight = baseWidth * (34 / 26)
  const heightReference = options.clampToGround === false ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND
  return {
    image: poiIconDataUrl(category, state),
    width: baseWidth * scale,
    height: baseHeight * scale,
    verticalOrigin: VerticalOrigin.BOTTOM,
    heightReference,
    disableDepthTestDistance: Number.POSITIVE_INFINITY
  }
}

/** 选中态图钉的强调色，供标签/属性面板复用同一语义。 */
export function poiStateAccent(state: V3PoiState): string {
  if (state === "disabled") return mapInteractionColors.disabled
  if (state === "selected") return mapInteractionColors.selected
  if (state === "alert") return mapInteractionColors.alert
  return poiCategoryColor.generic
}

/** 状态环的实际渲染色（供选中描边一致性判断）。 */
export function poiStateRingColor(state: V3PoiState): ReturnType<typeof mapColor> {
  return mapColor(poiStateRing[state])
}
