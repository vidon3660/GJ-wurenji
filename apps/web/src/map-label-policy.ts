/**
 * 地图标签显示规则（MAP-A04）与缩放层级表达（MAP-B04）。
 *
 * 优先级：教学区域 > 起降点/配送点/巡检点 > 禁飞区/障碍物 > 建筑 > 辅助信息。
 * - 每个优先级带最大可视距离（DistanceDisplayCondition），缩放时自然增减密度。
 * - 单次渲染按优先级裁剪数量，避免密集区域标签爆炸。
 * - 标签文本完整显示，缩放时仅通过距离和数量控制密度。
 */
import { Cartesian2, Color, DistanceDisplayCondition, LabelStyle, VerticalOrigin } from "cesium"

export type MapLabelPriority = "REGION" | "TASK_POINT" | "RESTRICTION" | "BUILDING" | "AUX"

export interface MapLabelRule {
  /** 相机超过该距离（米）后隐藏标签 */
  maximumViewMeters: number
  /** 单帧渲染内该级别最多创建的标签数 */
  maximumLabelsPerRender: number
  /** 仅供显式紧凑模式使用的建议字符数 */
  maximumCharacters: number
}

export const mapLabelRules: Record<MapLabelPriority, MapLabelRule> = {
  REGION: { maximumViewMeters: 250_000, maximumLabelsPerRender: 8, maximumCharacters: 14 },
  TASK_POINT: { maximumViewMeters: 80_000, maximumLabelsPerRender: 120, maximumCharacters: 14 },
  RESTRICTION: { maximumViewMeters: 50_000, maximumLabelsPerRender: 80, maximumCharacters: 14 },
  BUILDING: { maximumViewMeters: 12_000, maximumLabelsPerRender: 60, maximumCharacters: 10 },
  AUX: { maximumViewMeters: 6_000, maximumLabelsPerRender: 40, maximumCharacters: 10 }
}

export const MAP_LABEL_FONT = "16px system-ui"
export const MAP_LABEL_FONT_SMALL = "15px system-ui"

export function mapLabelDistanceCondition(priority: MapLabelPriority): DistanceDisplayCondition {
  return new DistanceDisplayCondition(0, mapLabelRules[priority].maximumViewMeters)
}

export function truncateMapLabel(text: string, priority: MapLabelPriority): string {
  const limit = mapLabelRules[priority].maximumCharacters
  const single = text.replace(/\s*\n\s*/g, " ")
  return single.length > limit ? `${single.slice(0, Math.max(1, limit - 1))}…` : single
}

/** 渲染批次内的标签预算（按优先级裁剪） */
export function createMapLabelBudget(): (priority: MapLabelPriority) => boolean {
  const used = new Map<MapLabelPriority, number>()
  return (priority) => {
    const next = (used.get(priority) ?? 0) + 1
    if (next > mapLabelRules[priority].maximumLabelsPerRender) return false
    used.set(priority, next)
    return true
  }
}

export interface MapLabelAppearanceOptions {
  text: string
  color: Color | string
  priority: MapLabelPriority
  /** 仅显式传 true 时截断；地图默认完整显示文本 */
  truncate?: boolean
  font?: string
  offset?: Cartesian2
  outlineWidth?: number
  disableDepthTest?: boolean
  showBackground?: boolean
}

/** 统一标签外观：描边文字 + 优先级距离条件 */
export function createMapLabelAppearance(options: MapLabelAppearanceOptions) {
  const color = typeof options.color === "string" ? Color.fromCssColorString(options.color) : options.color
  const text = options.truncate === true ? truncateMapLabel(options.text, options.priority) : options.text.replace(/\s*\n\s*/g, " ")
  return {
    text,
    font: options.font ?? MAP_LABEL_FONT,
    fillColor: color,
    outlineColor: Color.WHITE,
    outlineWidth: options.outlineWidth ?? 5,
    // Map labels sit directly on the cartography by default. Callers may
    // explicitly opt into a background for exceptional dense overlays.
    showBackground: options.showBackground ?? false,
    backgroundColor: Color.BLACK.withAlpha(0.62),
    backgroundPadding: new Cartesian2(6, 4),
    style: LabelStyle.FILL_AND_OUTLINE,
    pixelOffset: options.offset ?? new Cartesian2(0, -24),
    verticalOrigin: VerticalOrigin.BOTTOM,
    disableDepthTestDistance: options.disableDepthTest === false ? 0 : Number.POSITIVE_INFINITY,
    distanceDisplayCondition: mapLabelDistanceCondition(options.priority)
  }
}

/** 缩放层级：相机高度带（米），供“远/中/近”差异化渲染使用 */
export const mapDetailLevels = {
  /** 远距离：区域边界、主要地标 */
  far: 25_000,
  /** 中距离：建筑块面、教学 POI、主要禁飞区 */
  medium: 8_000,
  /** 近距离：名称、障碍物细节、巡检点 */
  near: 3_000
} as const

export type MapDetailLevel = "far" | "medium" | "near"

export function mapDetailLevelForCameraHeight(cameraHeightMeters: number): MapDetailLevel {
  if (cameraHeightMeters > mapDetailLevels.far) return "far"
  if (cameraHeightMeters > mapDetailLevels.medium) return "medium"
  return "near"
}

/** 细粒度建筑仅在非远距离层级创建 */
export function shouldRenderBuildingDetail(level: MapDetailLevel): boolean {
  return level !== "far"
}
