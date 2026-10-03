import { BadRequestException, ConflictException } from "@nestjs/common"
import {
  logisticsTemplatePolicy,
  logisticsRouteDirections,
  logisticsRouteModes,
  logisticsRouteRoles,
  type LogisticsAircraftCapabilityView,
  type LogisticsMapAnnotationInput,
  type LogisticsRouteInput,
  type LogisticsWaypointInput,
  type V3Coordinate
} from "@wurenji/shared"

export const logisticsAircraftCapability: LogisticsAircraftCapabilityView = {
  modelCode: "TEACHING-UAV-01",
  cruiseSpeedMps: 12,
  maximumSpeedMps: 18,
  maximumHeightMeters: 120,
  maximumRoundTripMeters: 12_000,
  minimumReserveBatteryPercent: 20,
  climbRateMps: 3,
  ruleVersion: "LOGISTICS-ROUTE-1.0.0"
}

export function normalizeSelectedDeliveryPointIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new BadRequestException("启用配送点必须包含 1 到 12 项")
  const normalized = value.map((item, index) => normalizeText(item, 120, `第 ${index + 1} 个配送点 ID`))
  if (new Set(normalized).size !== normalized.length) throw new BadRequestException("启用配送点不能重复")
  return normalized
}

export function normalizeRegionNotes(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string" || value.length > 2_000) throw new BadRequestException("区域分析说明不能超过 2000 个字符")
  return value.trim()
}

export function normalizeLogisticsRoutes(value: unknown): LogisticsRouteInput[] {
  if (!Array.isArray(value) || value.length > 60) throw new BadRequestException("航线草稿必须为不超过 60 条的数组")
  const routeIds = new Set<string>()
  return value.map((item, index) => {
    const record = asRecord(item, `第 ${index + 1} 条航线`)
    const id = normalizeText(record.id, 80, `第 ${index + 1} 条航线 ID`)
    if (routeIds.has(id)) throw new BadRequestException(`航线 ID 重复：${id}`)
    routeIds.add(id)
    const direction = record.direction
    if (typeof direction !== "string" || !(logisticsRouteDirections as readonly string[]).includes(direction)) throw new BadRequestException(`第 ${index + 1} 条航线方向无效`)
    const role = record.role
    if (typeof role !== "string" || !(logisticsRouteRoles as readonly string[]).includes(role)) throw new BadRequestException(`第 ${index + 1} 条航线角色无效`)
    const mode = record.mode ?? "FIXED_ROUND_TRIP"
    if (typeof mode !== "string" || !(logisticsRouteModes as readonly string[]).includes(mode)) throw new BadRequestException(`第 ${index + 1} 条航线模式无效`)
    const waypoints = normalizeWaypoints(record.waypoints, index)
    return {
      id,
      name: normalizeText(record.name, 120, `第 ${index + 1} 条航线名称`),
      mode: mode as "FIXED_ROUND_TRIP" | "NETWORK_SEGMENT",
      destinationNodeId: normalizeText(record.destinationNodeId, 120, `第 ${index + 1} 条航线配送点`),
      direction: direction as LogisticsRouteInput["direction"],
      role: role as LogisticsRouteInput["role"],
      groupCode: normalizeText(record.groupCode ?? "DEFAULT", 60, `第 ${index + 1} 条航线分组`),
      departureNodeId: normalizeText(record.departureNodeId, 120, `第 ${index + 1} 条航线起点`),
      arrivalNodeId: normalizeText(record.arrivalNodeId, 120, `第 ${index + 1} 条航线终点`),
      protectionRadiusMeters: normalizeNumber(record.protectionRadiusMeters, 10, 200, `第 ${index + 1} 条航线保护范围`),
      waitingNodeIds: normalizeNodeIds(record.waitingNodeIds, 6, `第 ${index + 1} 条航线等待点`),
      alternateLandingNodeIds: normalizeNodeIds(record.alternateLandingNodeIds, 6, `第 ${index + 1} 条航线备降点`),
      emergencyAreaNodeIds: normalizeNodeIds(record.emergencyAreaNodeIds, 6, `第 ${index + 1} 条航线应急区域`),
      entryDirectionDegrees: normalizeNumber(record.entryDirectionDegrees ?? 0, 0, 360, `第 ${index + 1} 条航线进场方向`),
      exitDirectionDegrees: normalizeNumber(record.exitDirectionDegrees ?? 0, 0, 360, `第 ${index + 1} 条航线离场方向`),
      waypoints
    }
  })
}

export function normalizeLogisticsMapAnnotations(value: unknown): LogisticsMapAnnotationInput[] {
  if (!Array.isArray(value) || value.length > 30) throw new BadRequestException("地图文字标注必须为不超过 30 项的数组")
  const ids = new Set<string>()
  return value.map((item, index) => {
    const record = asRecord(item, `第 ${index + 1} 个地图文字标注`)
    const id = normalizeText(record.id, 80, `第 ${index + 1} 个地图文字标注 ID`)
    if (ids.has(id)) throw new BadRequestException(`地图文字标注 ID 重复：${id}`)
    ids.add(id)
    const position = asRecord(record.position, `第 ${index + 1} 个地图文字标注坐标`)
    const longitude = normalizeNumber(position.longitude, -180, 180, `第 ${index + 1} 个地图文字标注经度`)
    const latitude = normalizeNumber(position.latitude, -90, 90, `第 ${index + 1} 个地图文字标注纬度`)
    const heightMeters = record.heightMeters === null || record.heightMeters === undefined
      ? null
      : normalizeNumber(record.heightMeters, -500, 20_000, `第 ${index + 1} 个地图文字标注地形高程`)
    return {
      id,
      label: normalizeText(record.label, 120, `第 ${index + 1} 个地图文字标注名称`),
      position: { longitude, latitude },
      heightMeters
    }
  })
}

export function requiredDeliveryPointRange(scaleTemplateCode: string): { minimum: number; maximum: number } {
  return logisticsTemplatePolicy(scaleTemplateCode).deliveryPointRange
}

export function assertExpectedRevision(value: unknown, current: number, label: string): void {
  const expected = Number(value)
  if (!Number.isInteger(expected) || expected < 1) throw new BadRequestException(`${label}必须为正整数`)
  if (expected !== current) throw new ConflictException(`${label}冲突，当前版本为 ${current}`)
}

function normalizeWaypoints(value: unknown, routeIndex: number): LogisticsWaypointInput[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 50) throw new BadRequestException(`第 ${routeIndex + 1} 条航线必须包含 2 到 50 个航点`)
  const ids = new Set<string>()
  return value.map((item, waypointIndex) => {
    const record = asRecord(item, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航点`)
    const id = normalizeText(record.id, 80, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航点 ID`)
    if (ids.has(id)) throw new BadRequestException(`第 ${routeIndex + 1} 条航线航点 ID 重复：${id}`)
    ids.add(id)
    const position = normalizeCoordinate(record.position, routeIndex, waypointIndex)
    return {
      id,
      name: normalizeText(record.name, 120, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航点名称`),
      position,
      altitudeMeters: normalizeNumber(record.altitudeMeters, 0, 500, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航点高度`),
      segmentAltitudeMeters: normalizeNumber(record.segmentAltitudeMeters, 0, 500, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航段高度`),
      speedMps: normalizeNumber(record.speedMps, 0.1, 50, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航点速度`),
      nodeId: record.nodeId === null || record.nodeId === undefined ? null : normalizeText(record.nodeId, 120, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个关联节点`),
      locked: record.locked === true
    }
  })
}

function normalizeCoordinate(value: unknown, routeIndex: number, waypointIndex: number): V3Coordinate {
  const record = asRecord(value, `第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航点坐标`)
  const longitude = Number(record.longitude)
  const latitude = Number(record.latitude)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new BadRequestException(`第 ${routeIndex + 1} 条航线第 ${waypointIndex + 1} 个航点坐标超出 WGS84 范围`)
  }
  return { longitude, latitude }
}

function normalizeNodeIds(value: unknown, maximum: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new BadRequestException(`${label}必须为不超过 ${maximum} 项的数组`)
  const result = value.map((item, index) => normalizeText(item, 120, `${label}第 ${index + 1} 项`))
  if (new Set(result).size !== result.length) throw new BadRequestException(`${label}不能重复`)
  return result
}

function normalizeNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum || number > maximum) throw new BadRequestException(`${label}必须在 ${minimum} 到 ${maximum} 之间`)
  return number
}

function normalizeText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maximumLength} 个字符`)
  return value.trim()
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequestException(`${label}格式无效`)
  return value as Record<string, unknown>
}
