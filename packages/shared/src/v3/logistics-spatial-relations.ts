import type { LogisticsRouteInput, V3Coordinate, V3RegionCatalogItem, V3RegionFeature, V3RegionLayerCode } from "./types.js"

const earthRadiusMeters = 6_371_008.8

export type LogisticsSpatialFeatureKind = "BUILDING" | "OBSTACLE" | "RESTRICTION"
export type LogisticsSpatialRelationStatus = "CONFLICT" | "RISK" | "CLEAR"
export type LogisticsHorizontalRelation = "CENTERLINE_CROSSING" | "PROTECTION_OVERLAP"

export interface LogisticsRouteSpatialRelation {
  id: string
  routeId: string
  routeName: string
  segmentIndex: number
  waypointIds: [string, string]
  position: V3Coordinate
  segmentAltitudeMeters: number
  protectionRadiusMeters: number
  featureId: string
  featureName: string
  featureKind: LogisticsSpatialFeatureKind
  featureHeightMeters: number | null
  horizontalRelation: LogisticsHorizontalRelation
  horizontalDistanceMeters: number
  verticalClearanceMeters: number | null
  status: LogisticsSpatialRelationStatus
  message: string
}

export function inspectLogisticsRouteSpatialRelations(
  route: LogisticsRouteInput,
  region: V3RegionCatalogItem
): LogisticsRouteSpatialRelation[] {
  const features = region.layers.flatMap((layer) => layer.code === "BUILDINGS" || layer.code === "RESTRICTIONS"
    ? layer.features.map((feature) => ({ layerCode: layer.code, feature }))
    : [])
  const relations: LogisticsRouteSpatialRelation[] = []
  for (let segmentIndex = 0; segmentIndex < route.waypoints.length - 1; segmentIndex += 1) {
    const start = route.waypoints[segmentIndex]!
    const end = route.waypoints[segmentIndex + 1]!
    for (const { layerCode, feature } of features) {
      const horizontal = featureSegmentDistanceMeters(feature, start.position, end.position)
      const featureRadius = feature.geometryType === "POINT" ? numericProperty(feature, "radiusMeters", 5) : 0
      const centerlineThreshold = feature.geometryType === "POINT" ? featureRadius : 0.01
      if (horizontal > route.protectionRadiusMeters + featureRadius) continue
      const featureKind = logisticsSpatialFeatureKind(layerCode, feature)
      const featureHeightMeters = finiteHeight(feature.heightMeters)
      const verticalClearanceMeters = featureKind === "RESTRICTION" || featureHeightMeters === null
        ? null
        : round(start.segmentAltitudeMeters - featureHeightMeters, 1)
      const horizontalRelation: LogisticsHorizontalRelation = horizontal <= centerlineThreshold
        ? "CENTERLINE_CROSSING"
        : "PROTECTION_OVERLAP"
      const status = relationStatus(featureKind, verticalClearanceMeters)
      relations.push({
        id: `${route.id}:${segmentIndex}:${feature.id}`,
        routeId: route.id,
        routeName: route.name,
        segmentIndex,
        waypointIds: [start.id, end.id],
        position: midpoint(start.position, end.position),
        segmentAltitudeMeters: start.segmentAltitudeMeters,
        protectionRadiusMeters: route.protectionRadiusMeters,
        featureId: feature.id,
        featureName: feature.name,
        featureKind,
        featureHeightMeters,
        horizontalRelation,
        horizontalDistanceMeters: round(horizontal, 1),
        verticalClearanceMeters,
        status,
        message: relationMessage(feature.name, featureKind, horizontalRelation, verticalClearanceMeters, start.segmentAltitudeMeters)
      })
    }
  }
  return relations
}

export function logisticsSpatialFeatureKind(layerCode: V3RegionLayerCode, feature: V3RegionFeature): LogisticsSpatialFeatureKind {
  if (layerCode === "RESTRICTIONS") return "RESTRICTION"
  return String(feature.properties.category ?? "").toUpperCase() === "OBSTACLE" ? "OBSTACLE" : "BUILDING"
}

function relationStatus(kind: LogisticsSpatialFeatureKind, clearanceMeters: number | null): LogisticsSpatialRelationStatus {
  if (kind === "RESTRICTION") return "CONFLICT"
  if (clearanceMeters === null || clearanceMeters < 25) return clearanceMeters !== null && clearanceMeters >= 10 ? "RISK" : clearanceMeters === null ? "RISK" : "CONFLICT"
  return "CLEAR"
}

function relationMessage(
  featureName: string,
  kind: LogisticsSpatialFeatureKind,
  horizontalRelation: LogisticsHorizontalRelation,
  clearanceMeters: number | null,
  segmentAltitudeMeters: number
): string {
  const horizontal = horizontalRelation === "CENTERLINE_CROSSING" ? "中心线穿越" : "保护区重叠"
  if (kind === "RESTRICTION") return `${horizontal}禁限区域“${featureName}”`
  const label = kind === "OBSTACLE" ? "障碍物" : "建筑"
  if (clearanceMeters === null) return `${horizontal}${label}“${featureName}”，要素高度缺失`
  return `${horizontal}${label}“${featureName}”，航段 ${segmentAltitudeMeters.toFixed(0)} m，垂直净空 ${clearanceMeters.toFixed(1)} m`
}

function featureSegmentDistanceMeters(feature: V3RegionFeature, start: V3Coordinate, end: V3Coordinate): number {
  if (feature.geometryType === "POINT" && feature.position) return pointToSegmentDistanceMeters(feature.position, start, end)
  if (feature.geometryType === "POLYGON" && feature.positions && feature.positions.length >= 3) {
    return segmentToPolygonDistanceMeters(start, end, feature.positions)
  }
  return Number.POSITIVE_INFINITY
}

function segmentToPolygonDistanceMeters(start: V3Coordinate, end: V3Coordinate, polygon: readonly V3Coordinate[]): number {
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return 0
  let minimum = Number.POSITIVE_INFINITY
  for (let index = 0; index < polygon.length; index += 1) {
    const edgeStart = polygon[index]!
    const edgeEnd = polygon[(index + 1) % polygon.length]!
    if (segmentsIntersect(start, end, edgeStart, edgeEnd)) return 0
    minimum = Math.min(
      minimum,
      pointToSegmentDistanceMeters(start, edgeStart, edgeEnd),
      pointToSegmentDistanceMeters(end, edgeStart, edgeEnd),
      pointToSegmentDistanceMeters(edgeStart, start, end),
      pointToSegmentDistanceMeters(edgeEnd, start, end)
    )
  }
  return minimum
}

function pointToSegmentDistanceMeters(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): number {
  const latitudeRadians = ((point.latitude + start.latitude + end.latitude) / 3) * Math.PI / 180
  const metersPerLongitudeDegree = Math.PI / 180 * earthRadiusMeters * Math.cos(latitudeRadians)
  const metersPerLatitudeDegree = Math.PI / 180 * earthRadiusMeters
  const endX = (end.longitude - start.longitude) * metersPerLongitudeDegree
  const endY = (end.latitude - start.latitude) * metersPerLatitudeDegree
  const pointX = (point.longitude - start.longitude) * metersPerLongitudeDegree
  const pointY = (point.latitude - start.latitude) * metersPerLatitudeDegree
  const lengthSquared = endX * endX + endY * endY
  if (lengthSquared <= 0) return Math.hypot(pointX, pointY)
  const projection = Math.min(1, Math.max(0, (pointX * endX + pointY * endY) / lengthSquared))
  return Math.hypot(pointX - projection * endX, pointY - projection * endY)
}

function pointInPolygon(point: V3Coordinate, polygon: readonly V3Coordinate[]): boolean {
  let inside = false
  for (let leftIndex = 0, rightIndex = polygon.length - 1; leftIndex < polygon.length; rightIndex = leftIndex++) {
    const left = polygon[leftIndex]!
    const right = polygon[rightIndex]!
    if ((left.latitude > point.latitude) !== (right.latitude > point.latitude)
      && point.longitude < (right.longitude - left.longitude) * (point.latitude - left.latitude) / (right.latitude - left.latitude) + left.longitude) inside = !inside
  }
  return inside
}

function segmentsIntersect(leftStart: V3Coordinate, leftEnd: V3Coordinate, rightStart: V3Coordinate, rightEnd: V3Coordinate): boolean {
  const first = orientation(leftStart, leftEnd, rightStart)
  const second = orientation(leftStart, leftEnd, rightEnd)
  const third = orientation(rightStart, rightEnd, leftStart)
  const fourth = orientation(rightStart, rightEnd, leftEnd)
  if (first !== second && third !== fourth) return true
  return (first === 0 && onSegment(leftStart, rightStart, leftEnd))
    || (second === 0 && onSegment(leftStart, rightEnd, leftEnd))
    || (third === 0 && onSegment(rightStart, leftStart, rightEnd))
    || (fourth === 0 && onSegment(rightStart, leftEnd, rightEnd))
}

function orientation(first: V3Coordinate, second: V3Coordinate, third: V3Coordinate): -1 | 0 | 1 {
  const value = (second.latitude - first.latitude) * (third.longitude - second.longitude)
    - (second.longitude - first.longitude) * (third.latitude - second.latitude)
  if (Math.abs(value) < 1e-12) return 0
  return value > 0 ? 1 : -1
}

function onSegment(first: V3Coordinate, middle: V3Coordinate, last: V3Coordinate): boolean {
  return middle.longitude <= Math.max(first.longitude, last.longitude) + 1e-12
    && middle.longitude >= Math.min(first.longitude, last.longitude) - 1e-12
    && middle.latitude <= Math.max(first.latitude, last.latitude) + 1e-12
    && middle.latitude >= Math.min(first.latitude, last.latitude) - 1e-12
}

function numericProperty(feature: V3RegionFeature, key: string, fallback: number): number {
  const value = feature.properties[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function finiteHeight(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function midpoint(start: V3Coordinate, end: V3Coordinate): V3Coordinate {
  return { longitude: (start.longitude + end.longitude) / 2, latitude: (start.latitude + end.latitude) / 2 }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
