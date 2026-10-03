import type {
  LogisticsMapAnnotationInput,
  LogisticsRouteCheckEvidence,
  LogisticsRouteInput,
  V3Coordinate,
  V3LogisticsNodeType,
  V3RegionCatalogItem
} from "@wurenji/shared"
type MapFeature =
  | { id: string; kind: "boundary" | "area"; geometry: V3Coordinate[]; properties?: Record<string, unknown> }
  | { id: string; kind: "route"; geometry: V3Coordinate[]; properties?: Record<string, unknown> }
  | { id: string; kind: "point" | "aircraft" | "alert"; geometry: V3Coordinate; properties?: Record<string, unknown> }

export function buildLogisticsRoute2DFeatures(options: {
  region: V3RegionCatalogItem
  visibleNodeTypes?: readonly V3LogisticsNodeType[]
  selectedDeliveryPointIds: readonly string[]
  routes: readonly LogisticsRouteInput[]
  annotations?: readonly LogisticsMapAnnotationInput[]
  selectedRouteId: string
  selectedWaypointId: string
  evidence?: readonly LogisticsRouteCheckEvidence[]
}): MapFeature[] {
  const { region, routes, annotations = [], evidence = [] } = options
  const result: MapFeature[] = [{ id: "route-2d:boundary", kind: "boundary", geometry: region.boundary }]
  const visibleTypes = new Set(options.visibleNodeTypes ?? [])
  const selectedDelivery = new Set(options.selectedDeliveryPointIds)
  for (const node of region.logisticsNodes ?? []) {
    if (!node.position || !node.enabled || (visibleTypes.size && !visibleTypes.has(node.type))) continue
    result.push({ id: `route-2d:node:${node.id}`, kind: "point", geometry: node.position, properties: { nodeId: node.id, selected: selectedDelivery.has(node.id), nodeType: node.type } })
  }
  for (const route of routes) {
    if (route.waypoints.length >= 2) result.push({ id: `route-2d:route:${route.id}`, kind: "route", geometry: route.waypoints.map((waypoint) => waypoint.position), properties: { routeId: route.id, selected: route.id === options.selectedRouteId } })
    for (const waypoint of route.waypoints) result.push({ id: `route-2d:waypoint:${route.id}:${waypoint.id}`, kind: "point", geometry: waypoint.position, properties: { routeId: route.id, waypointId: waypoint.id, selected: waypoint.id === options.selectedWaypointId } })
  }
  for (const annotation of annotations) result.push({ id: `route-2d:annotation:${annotation.id}`, kind: "point", geometry: annotation.position, properties: { annotationId: annotation.id } })
  for (const [index, item] of evidence.entries()) if (item.position) result.push({ id: `route-2d:evidence:${index}`, kind: "alert", geometry: item.position, properties: { code: item.code, severity: item.severity } })
  return result
}

export function measureWgs84Distance(start: V3Coordinate, end: V3Coordinate): number {
  const latitude = (start.latitude + end.latitude) / 2 * Math.PI / 180
  const east = (end.longitude - start.longitude) * 111_320 * Math.cos(latitude)
  const north = (end.latitude - start.latitude) * 110_540
  return Math.sqrt(east * east + north * north)
}

export function measureWgs84Bearing(start: V3Coordinate, end: V3Coordinate): number {
  const latitude = (start.latitude + end.latitude) / 2 * Math.PI / 180
  return (Math.atan2((end.longitude - start.longitude) * Math.cos(latitude), end.latitude - start.latitude) * 180 / Math.PI + 360) % 360
}
