import { BadRequestException } from "@nestjs/common"
import {
  showAreaFeatureTypes,
  type ShowAreaAnnotationInput,
  type ShowAreaCheckEvidence,
  type ShowAreaCheckResult,
  type ShowAreaFeatureInput,
  type ShowAreaFeatureMeasurement,
  type ShowAreaFeatureType,
  type ShowAreaFeatureView,
  type ShowAreaHeightRange,
  type ShowAreaSpatialRelationView,
  type V3Coordinate,
  type V3RegionCatalogItem
} from "@wurenji/shared"
import type { PolygonGeometry } from "./show-project.entities.js"

const earthRadiusMeters = 6_371_008.8

export const showAreaFeatureCatalog: Record<ShowAreaFeatureType, { title: string; color: string }> = {
  TAKEOFF_LANDING: { title: "起降区", color: "#1d6f52" },
  FLIGHT: { title: "飞行区", color: "#3182bd" },
  PERFORMANCE: { title: "表演区", color: "#7258a6" },
  BUFFER: { title: "缓冲区", color: "#d49b31" },
  GROUND_ISOLATION: { title: "地面隔离区", color: "#9b6554" },
  AUDIENCE: { title: "观众区", color: "#d45f6e" },
  OPERATION: { title: "操作区", color: "#52766f" },
  EMERGENCY_LANDING: { title: "应急降落区", color: "#cf7041" },
  GEOFENCE: { title: "电子围栏", color: "#ae3c4b" }
}

export function normalizeAreaFeatures(value: unknown): ShowAreaFeatureInput[] {
  if (!Array.isArray(value) || value.length > 50) throw new BadRequestException("区域要素必须为不超过 50 项的数组")
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!isRecord(item)) throw new BadRequestException(`第 ${index + 1} 个区域要素格式无效`)
    const id = normalizeText(item.id, 80, `第 ${index + 1} 个区域要素 ID`)
    if (ids.has(id)) throw new BadRequestException(`区域要素 ID 重复：${id}`)
    ids.add(id)
    const type = item.type
    if (typeof type !== "string" || !(showAreaFeatureTypes as readonly string[]).includes(type)) {
      throw new BadRequestException(`第 ${index + 1} 个区域类型无效`)
    }
    const positions = normalizePositions(item.positions, index)
    const properties = normalizeProperties(item.properties, index)
    const heightRange = normalizeHeightRange(item.heightRange, index)
    return {
      id,
      type: type as ShowAreaFeatureType,
      label: normalizeText(item.label, 120, `第 ${index + 1} 个区域名称`),
      positions,
      ...(heightRange ? { heightRange } : {}),
      properties
    }
  })
}

export function normalizeAreaAnnotations(value: unknown): ShowAreaAnnotationInput[] {
  if (!Array.isArray(value) || value.length > 30) throw new BadRequestException("文字标注必须为不超过 30 项的数组")
  const ids = new Set<string>()
  return value.map((item, index) => {
    if (!isRecord(item)) throw new BadRequestException(`第 ${index + 1} 个文字标注格式无效`)
    const id = normalizeText(item.id, 80, `第 ${index + 1} 个文字标注 ID`)
    if (ids.has(id)) throw new BadRequestException(`文字标注 ID 重复：${id}`)
    ids.add(id)
    if (!isRecord(item.position)) throw new BadRequestException(`第 ${index + 1} 个文字标注坐标无效`)
    const longitude = Number(item.position.longitude)
    const latitude = Number(item.position.latitude)
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new BadRequestException(`第 ${index + 1} 个文字标注坐标超出 WGS84 范围`)
    }
    const heightMeters = item.heightMeters === null || item.heightMeters === undefined ? null : Number(item.heightMeters)
    if (heightMeters !== null && (!Number.isFinite(heightMeters) || heightMeters < -500 || heightMeters > 20_000)) {
      throw new BadRequestException(`第 ${index + 1} 个文字标注高度无效`)
    }
    return {
      id,
      label: normalizeText(item.label, 120, `第 ${index + 1} 个文字标注名称`),
      position: { longitude, latitude },
      heightMeters
    }
  })
}

export function checkAreaPlan(
  features: readonly ShowAreaFeatureInput[],
  region: V3RegionCatalogItem,
  checkedAt = new Date(),
  maximumHeightMeters?: number
): ShowAreaCheckResult {
  const evidence: ShowAreaCheckEvidence[] = []
  const spatialRelations = computeAreaSpatialRelations(features)
  const presentTypes = new Set(features.map((feature) => feature.type))
  const missingTypes = showAreaFeatureTypes.filter((type) => !presentTypes.has(type))
  if (missingTypes.length > 0) {
    evidence.push({
      code: "REQUIRED_AREA_MISSING",
      severity: "CONFLICT",
      blocking: true,
      message: `缺少必需功能区：${missingTypes.map((type) => showAreaFeatureCatalog[type].title).join("、")}`,
      featureIds: []
    })
  }

  for (const feature of features) {
    if (hasSelfIntersection(feature.positions)) {
      evidence.push({ code: "SELF_INTERSECTION", severity: "CONFLICT", blocking: true, message: `${feature.label}存在自相交`, featureIds: [feature.id] })
    }
    if (!feature.positions.every((point) => pointInPolygon(point, region.boundary))) {
      evidence.push({ code: "OUTSIDE_TASK_REGION", severity: "CONFLICT", blocking: true, message: `${feature.label}超出任务区域边界`, featureIds: [feature.id] })
    }
    const propertyIssue = requiredPropertyIssue(feature)
    if (propertyIssue) {
      evidence.push({ code: "REQUIRED_PROPERTY_MISSING", severity: "CONFLICT", blocking: true, message: propertyIssue, featureIds: [feature.id] })
    }
    if (maximumHeightMeters !== undefined && feature.heightRange && feature.heightRange.maximumMeters > maximumHeightMeters) {
      evidence.push({
        code: "TASK_HEIGHT_LIMIT_EXCEEDED",
        severity: "CONFLICT",
        blocking: true,
        message: `${feature.label}最大高度 ${feature.heightRange.maximumMeters} m 超过任务上限 ${maximumHeightMeters} m`,
        featureIds: [feature.id]
      })
    }
    const measurement = measurePolygon(feature.positions)
    if (measurement.areaSquareMeters < 4) {
      evidence.push({ code: "AREA_TOO_SMALL", severity: "CONFLICT", blocking: true, message: `${feature.label}面积过小，无法作为正式功能区`, featureIds: [feature.id] })
    }
  }

  for (let leftIndex = 0; leftIndex < features.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < features.length; rightIndex += 1) {
      const left = features[leftIndex]!
      const right = features[rightIndex]!
      const relation = spatialRelations.find((item) => item.leftFeatureId === left.id && item.rightFeatureId === right.id)!
      if (relation.relation !== "DISJOINT") evidence.push(overlapEvidence(left, right, relation))
    }
  }

  const restrictions = region.layers
    .filter((layer) => layer.code === "RESTRICTIONS")
    .flatMap((layer) => layer.features)
    .filter((feature) => feature.geometryType === "POLYGON" && feature.positions && feature.positions.length >= 3)
  for (const area of features) {
    for (const restriction of restrictions) {
      if (!restriction.positions || !polygonsOverlap(area.positions, restriction.positions)) continue
      evidence.push({
        code: "RESTRICTION_OVERLAP",
        severity: "RISK",
        blocking: false,
        message: `${area.label}与“${restriction.name}”存在重叠，请结合教学规则核查`,
        featureIds: [area.id]
      })
    }
  }

  if (presentTypes.has("EMERGENCY_LANDING")) {
    evidence.push({
      code: "EMERGENCY_ACCESS_REVIEW",
      severity: "INFO",
      blocking: false,
      message: "已设置应急降落区，请在申报阶段说明可达条件和启用顺序",
      featureIds: features.filter((feature) => feature.type === "EMERGENCY_LANDING").map((feature) => feature.id)
    })
  }

  return {
    passed: !evidence.some((item) => item.blocking),
    checkedAt: checkedAt.toISOString(),
    featureCount: features.length,
    completeTypeCount: presentTypes.size,
    requiredTypeCount: showAreaFeatureTypes.length,
    evidence,
    spatialRelations
  }
}

export function areaFeatureView(feature: ShowAreaFeatureInput): ShowAreaFeatureView {
  return { ...feature, measurement: measurePolygon(feature.positions) }
}

export function computeAreaSpatialRelations(features: readonly ShowAreaFeatureInput[]): ShowAreaSpatialRelationView[] {
  const relations: ShowAreaSpatialRelationView[] = []
  for (let leftIndex = 0; leftIndex < features.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < features.length; rightIndex += 1) {
      relations.push(spatialRelation(features[leftIndex]!, features[rightIndex]!))
    }
  }
  return relations
}

export function toPolygonGeometry(feature: ShowAreaFeatureInput): PolygonGeometry {
  const first = feature.positions[0]!
  return {
    type: "Polygon",
    coordinates: [[...feature.positions.map((point) => [point.longitude, point.latitude]), [first.longitude, first.latitude]]]
  }
}

export function positionsFromGeometry(geometry: PolygonGeometry): V3Coordinate[] {
  const ring = geometry.coordinates[0] ?? []
  const open = ring.length > 1 && sameCoordinate(ring[0]!, ring[ring.length - 1]!) ? ring.slice(0, -1) : ring
  return open.map(([longitude, latitude]) => ({ longitude: Number(longitude), latitude: Number(latitude) }))
}

export function measurePolygon(points: readonly V3Coordinate[]): ShowAreaFeatureMeasurement {
  const originLatitude = points.reduce((sum, point) => sum + point.latitude, 0) / Math.max(points.length, 1)
  const projected = points.map((point) => project(point, originLatitude))
  let twiceArea = 0
  let centroidX = 0
  let centroidY = 0
  let perimeterMeters = 0
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index]!
    const next = projected[(index + 1) % projected.length]!
    const cross = current.x * next.y - next.x * current.y
    twiceArea += cross
    centroidX += (current.x + next.x) * cross
    centroidY += (current.y + next.y) * cross
    perimeterMeters += Math.hypot(next.x - current.x, next.y - current.y)
  }
  const signedArea = twiceArea / 2
  const fallback = points.reduce((result, point) => ({ longitude: result.longitude + point.longitude / points.length, latitude: result.latitude + point.latitude / points.length }), { longitude: 0, latitude: 0 })
  const centroid = Math.abs(signedArea) < 0.001
    ? fallback
    : unproject({ x: centroidX / (6 * signedArea), y: centroidY / (6 * signedArea) }, originLatitude)
  return {
    areaSquareMeters: round(Math.abs(signedArea), 1),
    perimeterMeters: round(perimeterMeters, 1),
    centroid: { longitude: round(centroid.longitude, 7), latitude: round(centroid.latitude, 7) }
  }
}

function normalizePositions(value: unknown, featureIndex: number): V3Coordinate[] {
  if (!Array.isArray(value) || value.length < 3 || value.length > 200) {
    throw new BadRequestException(`第 ${featureIndex + 1} 个区域必须包含 3 到 200 个顶点`)
  }
  const points = value.map((item, pointIndex) => {
    if (!isRecord(item)) throw new BadRequestException(`第 ${featureIndex + 1} 个区域第 ${pointIndex + 1} 个坐标无效`)
    const longitude = Number(item.longitude)
    const latitude = Number(item.latitude)
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new BadRequestException(`第 ${featureIndex + 1} 个区域第 ${pointIndex + 1} 个坐标超出 WGS84 范围`)
    }
    return { longitude, latitude }
  })
  if (points.length > 3 && samePoint(points[0]!, points[points.length - 1]!)) points.pop()
  if (points.length < 3) throw new BadRequestException(`第 ${featureIndex + 1} 个区域有效顶点不足`)
  for (let index = 0; index < points.length; index += 1) {
    if (samePoint(points[index]!, points[(index + 1) % points.length]!)) {
      throw new BadRequestException(`第 ${featureIndex + 1} 个区域包含相邻重复顶点`)
    }
  }
  return points
}

function normalizeProperties(value: unknown, featureIndex: number): Record<string, string | number | boolean> {
  if (!isRecord(value)) throw new BadRequestException(`第 ${featureIndex + 1} 个区域属性必须为对象`)
  const entries = Object.entries(value)
  if (entries.length > 30) throw new BadRequestException(`第 ${featureIndex + 1} 个区域属性过多`)
  return Object.fromEntries(entries.map(([key, item]) => {
    if (!key.trim() || key.length > 60 || (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean")) {
      throw new BadRequestException(`第 ${featureIndex + 1} 个区域属性 ${key || "(空)"} 无效`)
    }
    if (typeof item === "string" && item.length > 500) throw new BadRequestException(`第 ${featureIndex + 1} 个区域属性 ${key} 过长`)
    if (typeof item === "number" && !Number.isFinite(item)) throw new BadRequestException(`第 ${featureIndex + 1} 个区域属性 ${key} 必须为有限数值`)
    return [key, typeof item === "string" ? item.trim() : item]
  }))
}

function normalizeHeightRange(value: unknown, featureIndex: number): ShowAreaHeightRange | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value) || (value.datum !== "AGL" && value.datum !== "AMSL")) throw new BadRequestException(`第 ${featureIndex + 1} 个区域高度基准无效`)
  const minimumMeters = Number(value.minimumMeters)
  const maximumMeters = Number(value.maximumMeters)
  if (!Number.isFinite(minimumMeters) || !Number.isFinite(maximumMeters) || minimumMeters < -500 || maximumMeters > 20_000 || minimumMeters >= maximumMeters) {
    throw new BadRequestException(`第 ${featureIndex + 1} 个区域高度范围无效`)
  }
  return { datum: value.datum as ShowAreaHeightRange["datum"], minimumMeters, maximumMeters }
}

function requiredPropertyIssue(feature: ShowAreaFeatureInput): string | null {
  const properties = feature.properties
  const numberMissing = (key: string) => typeof properties[key] !== "number" || !Number.isFinite(properties[key] as number)
  const textMissing = (key: string) => typeof properties[key] !== "string" || !(properties[key] as string).trim()
  if (feature.type === "TAKEOFF_LANDING" && (numberMissing("capacity") || numberMissing("orientationDegrees"))) return `${feature.label}必须填写容量和朝向`
  if ((feature.type === "FLIGHT" || feature.type === "PERFORMANCE" || feature.type === "GEOFENCE") && !feature.heightRange) return `${feature.label}必须填写高度范围`
  if (feature.type === "PERFORMANCE" && numberMissing("orientationDegrees")) return `${feature.label}必须填写表演朝向`
  if (feature.type === "BUFFER" && numberMissing("referenceWidthMeters")) return `${feature.label}必须填写参考宽度`
  if ((feature.type === "GROUND_ISOLATION" || feature.type === "OPERATION") && textMissing("purpose")) return `${feature.label}必须填写用途`
  if (feature.type === "AUDIENCE" && (numberMissing("orientationDegrees") || textMissing("capacityLevel"))) return `${feature.label}必须填写朝向和人数等级`
  if (feature.type === "EMERGENCY_LANDING" && (textMissing("availability") || textMissing("capacityLevel"))) return `${feature.label}必须填写可用条件和容量等级`
  if (feature.type === "GEOFENCE" && textMissing("policy")) return `${feature.label}必须填写围栏策略`
  return null
}

function overlapEvidence(left: ShowAreaFeatureInput, right: ShowAreaFeatureInput, relation: ShowAreaSpatialRelationView): ShowAreaCheckEvidence {
  const pair = new Set([left.type, right.type])
  const expected = pair.has("BUFFER") || pair.has("GEOFENCE") || (pair.has("FLIGHT") && pair.has("PERFORMANCE"))
  const risky = (pair.has("AUDIENCE") && (pair.has("FLIGHT") || pair.has("PERFORMANCE") || pair.has("TAKEOFF_LANDING")))
    || (pair.has("GROUND_ISOLATION") && pair.has("TAKEOFF_LANDING"))
  return {
    code: risky ? "SENSITIVE_AREA_OVERLAP" : expected ? "EXPECTED_AREA_RELATION" : "AREA_OVERLAP",
    severity: risky ? "RISK" : "INFO",
    blocking: false,
    message: risky
      ? `${left.label}与${right.label}存在敏感重叠，请调整或补充处置说明`
      : `${relation.message}，请确认该位置关系符合规划意图`,
    featureIds: [left.id, right.id]
  }
}

function spatialRelation(left: ShowAreaFeatureInput, right: ShowAreaFeatureInput): ShowAreaSpatialRelationView {
  const leftContainsRight = right.positions.every((point) => pointInPolygon(point, left.positions))
  const rightContainsLeft = left.positions.every((point) => pointInPolygon(point, right.positions))
  const relation = leftContainsRight ? "CONTAINS" : rightContainsLeft ? "WITHIN" : polygonsOverlap(left.positions, right.positions) ? "OVERLAP" : "DISJOINT"
  const distance = coordinateDistance(measurePolygon(left.positions).centroid, measurePolygon(right.positions).centroid)
  const relationText = relation === "CONTAINS"
    ? `${left.label}包含${right.label}`
    : relation === "WITHIN"
      ? `${left.label}位于${right.label}内部`
      : relation === "OVERLAP"
        ? `${left.label}与${right.label}存在空间重叠`
        : `${left.label}与${right.label}相离`
  return {
    leftFeatureId: left.id,
    rightFeatureId: right.id,
    relation,
    centroidDistanceMeters: round(distance, 1),
    message: `${relationText}，中心距 ${formatDistance(distance)}`
  }
}

function coordinateDistance(left: V3Coordinate, right: V3Coordinate): number {
  const latitude = (left.latitude + right.latitude) / 2 * Math.PI / 180
  const longitudeMeters = (right.longitude - left.longitude) * Math.PI / 180 * earthRadiusMeters * Math.cos(latitude)
  const latitudeMeters = (right.latitude - left.latitude) * Math.PI / 180 * earthRadiusMeters
  return Math.hypot(longitudeMeters, latitudeMeters)
}

function formatDistance(distance: number): string {
  return distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${distance.toFixed(1)} m`
}

function polygonsOverlap(left: readonly V3Coordinate[], right: readonly V3Coordinate[]): boolean {
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex]!
    const leftEnd = left[(leftIndex + 1) % left.length]!
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      if (segmentsIntersect(leftStart, leftEnd, right[rightIndex]!, right[(rightIndex + 1) % right.length]!)) return true
    }
  }
  return pointInPolygon(left[0]!, right) || pointInPolygon(right[0]!, left)
}

function hasSelfIntersection(points: readonly V3Coordinate[]): boolean {
  for (let firstIndex = 0; firstIndex < points.length; firstIndex += 1) {
    const firstEnd = (firstIndex + 1) % points.length
    for (let secondIndex = firstIndex + 1; secondIndex < points.length; secondIndex += 1) {
      const secondEnd = (secondIndex + 1) % points.length
      if (firstIndex === secondIndex || firstEnd === secondIndex || secondEnd === firstIndex) continue
      if (segmentsIntersect(points[firstIndex]!, points[firstEnd]!, points[secondIndex]!, points[secondEnd]!)) return true
    }
  }
  return false
}

function pointInPolygon(point: V3Coordinate, polygon: readonly V3Coordinate[]): boolean {
  let inside = false
  for (let currentIndex = 0, previousIndex = polygon.length - 1; currentIndex < polygon.length; previousIndex = currentIndex, currentIndex += 1) {
    const current = polygon[currentIndex]!
    const previous = polygon[previousIndex]!
    if (pointOnSegment(point, previous, current)) return true
    const crosses = (current.latitude > point.latitude) !== (previous.latitude > point.latitude)
      && point.longitude < ((previous.longitude - current.longitude) * (point.latitude - current.latitude)) / (previous.latitude - current.latitude) + current.longitude
    if (crosses) inside = !inside
  }
  return inside
}

function segmentsIntersect(a: V3Coordinate, b: V3Coordinate, c: V3Coordinate, d: V3Coordinate): boolean {
  const abC = orientation(a, b, c)
  const abD = orientation(a, b, d)
  const cdA = orientation(c, d, a)
  const cdB = orientation(c, d, b)
  if (abC * abD < 0 && cdA * cdB < 0) return true
  return (Math.abs(abC) < 1e-12 && pointOnSegment(c, a, b))
    || (Math.abs(abD) < 1e-12 && pointOnSegment(d, a, b))
    || (Math.abs(cdA) < 1e-12 && pointOnSegment(a, c, d))
    || (Math.abs(cdB) < 1e-12 && pointOnSegment(b, c, d))
}

function orientation(a: V3Coordinate, b: V3Coordinate, c: V3Coordinate): number {
  return (b.longitude - a.longitude) * (c.latitude - a.latitude) - (b.latitude - a.latitude) * (c.longitude - a.longitude)
}

function pointOnSegment(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): boolean {
  if (Math.abs(orientation(start, end, point)) > 1e-10) return false
  return point.longitude >= Math.min(start.longitude, end.longitude) - 1e-10
    && point.longitude <= Math.max(start.longitude, end.longitude) + 1e-10
    && point.latitude >= Math.min(start.latitude, end.latitude) - 1e-10
    && point.latitude <= Math.max(start.latitude, end.latitude) + 1e-10
}

function project(point: V3Coordinate, originLatitude: number) {
  return {
    x: radians(point.longitude) * Math.cos(radians(originLatitude)) * earthRadiusMeters,
    y: radians(point.latitude) * earthRadiusMeters
  }
}

function unproject(point: { x: number; y: number }, originLatitude: number) {
  return {
    longitude: degrees(point.x / (Math.cos(radians(originLatitude)) * earthRadiusMeters)),
    latitude: degrees(point.y / earthRadiusMeters)
  }
}

function normalizeText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maximumLength} 个字符`)
  return value.trim()
}

function samePoint(left: V3Coordinate, right: V3Coordinate): boolean {
  return Math.abs(left.longitude - right.longitude) < 1e-10 && Math.abs(left.latitude - right.latitude) < 1e-10
}

function sameCoordinate(left: number[], right: number[]): boolean {
  return Math.abs(Number(left[0]) - Number(right[0])) < 1e-10 && Math.abs(Number(left[1]) - Number(right[1])) < 1e-10
}

function radians(value: number): number {
  return value * Math.PI / 180
}

function degrees(value: number): number {
  return value * 180 / Math.PI
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
