import type {
  V3Coordinate,
  V3RegionFeature,
  VtlAircraftParameters,
  VtlAircraftAssignmentView,
  VtlEnergySegmentView,
  VtlFlightPhase,
  VtlGroupView,
  VtlPlanCheckIssueView,
  VtlPlanCheckResultView,
  VtlRoutePlanView,
  VtlRuntimeAircraftView,
  VtlRuntimeGroupView,
  VtlRuntimeSummaryView,
  VtlTaskObjectView,
  VtlTerrainProfileSample
} from "@wurenji/shared"

const EARTH_RADIUS_METERS = 6_378_137
const MAIN_LANDING_SITE_RADIUS_METERS = 300
const PHASE_ORDER: readonly VtlFlightPhase[] = [
  "VERTICAL_TAKEOFF",
  "CLIMB",
  "FORWARD_TRANSITION",
  "FIXED_WING_CRUISE",
  "TASK_EXECUTION",
  "RETURN",
  "BACK_TRANSITION",
  "VERTICAL_LANDING"
]

export interface VtlRouteComputationInput {
  routeId: string
  projectId: string
  aircraftId: string
  parameterVersion: string
  transitionHeightMeters: number
  alternateLandingSiteId: string
  alternateLandingSitePosition?: V3Coordinate
  waypoints: VtlRoutePlanView["waypoints"]
  terrainProfile?: VtlTerrainProfileSample[]
  parameters: VtlAircraftParameters
}

export interface VtlRouteComputationResult {
  route: VtlRoutePlanView
  issues: VtlPlanCheckIssueView[]
}

export interface VtlEnvironmentFeature extends Pick<V3RegionFeature, "id" | "name" | "geometryType" | "position" | "positions" | "heightMeters" | "properties"> {
  kind?: "BUILDING" | "OBSTACLE" | "RESTRICTION"
}

export interface VtlPlanValidationInput {
  projectId: string
  allocationRevision: number
  routes: VtlRoutePlanView[]
  assignments: VtlAircraftAssignmentView[]
  taskObjects: VtlTaskObjectView[]
  parameters: VtlAircraftParameters
  mainLandingSiteId: string
  availableAlternateLandingSiteIds: string[]
  mainLandingSitePosition?: V3Coordinate
  horizontalSeparationMeters?: number
  verticalSeparationMeters?: number
  temporalSeparationSeconds?: number
  /** 已发布区域中的建筑、障碍物和禁飞面；用于检查航段的三维净空。 */
  environmentFeatures?: readonly VtlEnvironmentFeature[]
}

export interface VtlRuntimeInput {
  simulationTimeMs: number
  routes: VtlRoutePlanView[]
  assignments: VtlAircraftAssignmentView[]
  groups: VtlGroupView[]
  taskObjects: VtlTaskObjectView[]
  events?: Array<{ id: string; aircraftIds: string[] }>
  horizontalSeparationMeters?: number
  verticalSeparationMeters?: number
}

export function vtlPhaseDefinitions(): readonly VtlFlightPhase[] {
  return [...PHASE_ORDER]
}

export function buildVtlRoutePlan(input: VtlRouteComputationInput, now = new Date().toISOString()): VtlRouteComputationResult {
  const terrainProfile = input.terrainProfile?.length
    ? input.terrainProfile.map((sample) => ({ ...sample }))
    : buildTerrainProfile(input.waypoints)
  const energySegments = calculateEnergySegments(input.waypoints, terrainProfile, input.parameters)
  const totalDistanceMeters = energySegments.reduce((sum, segment) => sum + segment.distanceMeters, 0)
  const totalDurationSeconds = energySegments.reduce((sum, segment) => sum + segment.durationSeconds, 0)
  const totalEnergyWh = energySegments.reduce((sum, segment) => sum + segment.energyWh, 0)
  const reserveEnergyWh = input.parameters.batteryCapacityWh * input.parameters.reserveEnergyRatio
  const alternateComparison = input.alternateLandingSitePosition
    ? compareAlternateRoute(input.waypoints, energySegments, input.alternateLandingSiteId, input.alternateLandingSitePosition, input.transitionHeightMeters, input.parameters)
    : null
  const enrouteTerrainProfile = terrainProfile.filter((_, index) => {
    const phase = input.waypoints[index]?.phase
    return phase !== "VERTICAL_TAKEOFF" && phase !== "VERTICAL_LANDING"
  })
  const minimumTerrainClearanceMeters = enrouteTerrainProfile.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.min(...enrouteTerrainProfile.map((sample) => sample.clearanceMeters))
  const route: VtlRoutePlanView = {
    id: input.routeId,
    projectId: input.projectId,
    aircraftId: input.aircraftId,
    revision: 1,
    parameterVersion: input.parameterVersion,
    waypoints: input.waypoints.map((waypoint) => ({ ...waypoint, position: { ...waypoint.position } })),
    transitionHeightMeters: input.transitionHeightMeters,
    alternateLandingSiteId: input.alternateLandingSiteId,
    ...(alternateComparison ? { alternateComparison } : {}),
    terrainProfile,
    energySegments,
    totalDistanceMeters,
    totalDurationSeconds,
    totalEnergyWh,
    reserveEnergyWh,
    minimumTerrainClearanceMeters,
    updatedAt: now
  }
  const issues: VtlPlanCheckIssueView[] = []
  if (input.transitionHeightMeters < input.parameters.minimumTransitionHeightMeters) {
    issues.push(issue("TRANSITION_HEIGHT", "TRANSITION", "CONFLICT", [input.aircraftId], [], "转换高度低于机型教学最低转换高度。", "提高转换点高度后重新计算航线。"))
  }
  if (totalEnergyWh > input.parameters.batteryCapacityWh - reserveEnergyWh) {
    issues.push(issue("ENERGY_RESERVE", "ENERGY", "CONFLICT", [input.aircraftId], [], "主航线能量消耗超过可用能量余度。", "缩短任务航段、调整顺序或选择可用备降点。"))
  }
  if (minimumTerrainClearanceMeters < 30) {
    issues.push(issue("TERRAIN_CLEARANCE", "TERRAIN", "CONFLICT", [input.aircraftId], [], "航段与地形的教学净空不足。", "提高航段高度并重新生成地形剖面。"))
  }
  if (alternateComparison && !alternateComparison.feasible) {
    issues.push(issue("ALTERNATE_ENERGY", "ALTERNATE", "CONFLICT", [input.aircraftId], [], "备降方案预计到达能量低于教学余度。", "选择更近的备降点或调整任务顺序和航线。"))
  }
  return { route, issues }
}

export function validateVtlPlan(input: VtlPlanValidationInput, checkedAt = new Date().toISOString()): VtlPlanCheckResultView {
  const singleAircraftIssues = input.routes.flatMap((route) => [
    ...validateRouteStructure(route, input.parameters),
    ...validateRouteEnvironment(route, input.environmentFeatures ?? [])
  ])
  const assignedObjects = new Map<string, string[]>()
  for (const assignment of input.assignments) {
    for (const taskObjectId of assignment.taskObjectIds) {
      assignedObjects.set(taskObjectId, [...(assignedObjects.get(taskObjectId) ?? []), assignment.aircraftId])
    }
  }
  const fleetIssues: VtlPlanCheckIssueView[] = []
  for (const taskObject of input.taskObjects.filter((item) => item.required)) {
    const owners = assignedObjects.get(taskObject.id) ?? []
    if (owners.length === 0) fleetIssues.push(issue("UNASSIGNED", "COVERAGE", "CONFLICT", [], [taskObject.id], `必做任务对象 ${taskObject.code} 尚未分配。`, "将任务对象分配给可用航空器。"))
    if (owners.length > 1) fleetIssues.push(issue("DUPLICATE", "COVERAGE", "CONFLICT", owners, [taskObject.id], `任务对象 ${taskObject.code} 被重复分配。`, "保留一个执行航空器并调整其他任务顺序。"))
  }
  for (const assignment of input.assignments.filter((item) => !item.available)) {
    if (assignment.taskObjectIds.length > 0) fleetIssues.push(issue("AIRCRAFT_UNAVAILABLE", "COVERAGE", "CONFLICT", [assignment.aircraftId], assignment.taskObjectIds, `航空器 ${assignment.aircraftCode} 当前不可用。`, "更换可用航空器或取消其未起飞任务。"))
  }
  const routeByAircraft = new Map(input.routes.map((route) => [route.aircraftId, route]))
  for (const assignment of input.assignments) {
    const route = routeByAircraft.get(assignment.aircraftId)
    if (assignment.taskObjectIds.length > 0 && !route) {
      fleetIssues.push(issue("ROUTE_MISSING", "COVERAGE", "CONFLICT", [assignment.aircraftId], assignment.taskObjectIds, `航空器 ${assignment.aircraftCode} 尚未形成完整航线。`, "为航空器完成八阶段航线规划。"))
    }
    if (!route) continue
    const routeTaskIds = route.waypoints.flatMap((waypoint) => waypoint.taskObjectId ? [waypoint.taskObjectId] : [])
    const missingTaskIds = assignment.taskSequence.filter((taskId) => !routeTaskIds.includes(taskId))
    const unexpectedTaskIds = routeTaskIds.filter((taskId) => !assignment.taskSequence.includes(taskId))
    if (missingTaskIds.length > 0) {
      fleetIssues.push(issue("ROUTE_TASK_MISSING", "COVERAGE", "CONFLICT", [assignment.aircraftId], missingTaskIds, `航空器 ${assignment.aircraftCode} 的航线漏掉了已分配巡检任务。`, "为每个已分配任务增加任务执行航点并重新检查。"))
    }
    if (unexpectedTaskIds.length > 0) {
      fleetIssues.push(issue("ROUTE_TASK_UNASSIGNED", "COVERAGE", "CONFLICT", [assignment.aircraftId], unexpectedTaskIds, `航空器 ${assignment.aircraftCode} 的航线包含未分配巡检任务。`, "删除未分配任务航点或先调整任务分配。"))
    }
    if (missingTaskIds.length === 0 && unexpectedTaskIds.length === 0 && routeTaskIds.join("\u0000") !== assignment.taskSequence.join("\u0000")) {
      fleetIssues.push(issue("ROUTE_TASK_ORDER", "TEMPORAL", "CONFLICT", [assignment.aircraftId], assignment.taskSequence, `航空器 ${assignment.aircraftCode} 的任务执行顺序与任务计划不一致。`, "按任务计划顺序调整任务执行航点。"))
    }
  }
  const orderedAircraft = input.assignments.filter((item) => item.available && item.taskObjectIds.length > 0)
  if (new Set(orderedAircraft.map((item) => item.aircraftId)).size !== orderedAircraft.length) {
    fleetIssues.push(issue("AIRCRAFT_DUPLICATE", "TEMPORAL", "CONFLICT", [], [], "执行计划中存在重复航空器。", "每架航空器只能在一个分组中执行任务。"))
  }
  fleetIssues.push(...validateFleetRelations(input))
  const allIssues = [...singleAircraftIssues, ...fleetIssues]
  return {
    projectId: input.projectId,
    allocationRevision: input.allocationRevision,
    routeRevisions: Object.fromEntries(input.routes.map((route) => [route.aircraftId, route.revision])),
    singleAircraftIssues,
    fleetIssues,
    blockingIssueCount: allIssues.filter((item) => item.severity === "CONFLICT").length,
    warningCount: allIssues.filter((item) => item.severity === "RISK").length,
    passed: allIssues.every((item) => item.severity !== "CONFLICT"),
    checkedAt
  }
}

function validateRouteEnvironment(route: VtlRoutePlanView, features: readonly VtlEnvironmentFeature[]): VtlPlanCheckIssueView[] {
  if (features.length === 0 || route.waypoints.length < 2) return []
  const issues: VtlPlanCheckIssueView[] = []
  for (let segmentIndex = 0; segmentIndex < route.waypoints.length - 1; segmentIndex += 1) {
    const start = route.waypoints[segmentIndex]!
    const end = route.waypoints[segmentIndex + 1]!
    const horizontalSegment = { start: start.position, end: end.position }
    const minimumAltitude = Math.min(start.altitudeMeters, end.altitudeMeters)
    const maximumAltitude = Math.max(start.altitudeMeters, end.altitudeMeters)
    for (const feature of features) {
      const kind = feature.kind ?? (feature.properties.category === "OBSTACLE" ? "OBSTACLE" : "BUILDING")
      const horizontalHit = feature.geometryType === "POLYGON"
        ? segmentIntersectsPolygon(horizontalSegment.start, horizontalSegment.end, feature.positions ?? [])
        : feature.geometryType === "LINESTRING"
          ? lineStringIntersectsSegment(horizontalSegment.start, horizontalSegment.end, feature.positions ?? [])
          : feature.position
            ? distancePointToSegmentMeters(feature.position, horizontalSegment.start, horizontalSegment.end) <= featureRadiusMeters(feature)
            : false
      if (!horizontalHit) continue
      const baseHeight = featureBaseHeightMeters(feature)
      const topHeight = baseHeight + featureHeightMeters(feature)
      const verticalClearance = minimumAltitude - topHeight
      const restricted = kind === "RESTRICTION"
      const collides = restricted || maximumAltitude >= baseHeight && minimumAltitude <= topHeight
      const near = !collides && verticalClearance < 20
      if (!collides && !near) continue
      const code = restricted ? "RESTRICTED_AIRSPACE_CROSSING" : kind === "OBSTACLE" ? "OBSTACLE_COLLISION" : "BUILDING_COLLISION"
      const severity = collides ? "CONFLICT" : "RISK"
      const detail = restricted
        ? `航段 ${segmentIndex + 1} 穿越限制区域 ${feature.name || feature.id}`
        : `${kind === "OBSTACLE" ? "障碍物" : "建筑物"} ${feature.name || feature.id} 与航段 ${segmentIndex + 1} 的三维净空不足`
      issues.push(issue(code, "SPATIAL", severity, [route.aircraftId], [], detail, "调整航线位置或高度后重新执行方案检查。", `${route.id}:${feature.id}:${segmentIndex}`))
    }
  }
  return issues
}

function featureBaseHeightMeters(feature: VtlEnvironmentFeature): number {
  const value = feature.properties.baseHeightMeters ?? feature.properties.elevationMeters ?? feature.properties.elevation
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function featureHeightMeters(feature: VtlEnvironmentFeature): number {
  const value = feature.heightMeters ?? feature.properties.heightMeters ?? feature.properties.height
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : feature.kind === "RESTRICTION" ? Number.POSITIVE_INFINITY : 30
}

function featureRadiusMeters(feature: VtlEnvironmentFeature): number {
  const value = feature.properties.radiusMeters ?? feature.properties.bufferMeters
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, value) : feature.kind === "OBSTACLE" ? 25 : 12
}

function lineStringIntersectsSegment(start: V3Coordinate, end: V3Coordinate, positions: readonly V3Coordinate[]): boolean {
  for (let index = 0; index < positions.length - 1; index += 1) {
    if (segmentsIntersect(start, end, positions[index]!, positions[index + 1]!)) return true
  }
  return false
}

function distancePointToSegmentMeters(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): number {
  const latitudeScale = 111_320
  const longitudeScale = latitudeScale * Math.max(0.1, Math.cos((start.latitude + end.latitude) / 2 * Math.PI / 180))
  const px = point.longitude * longitudeScale
  const py = point.latitude * latitudeScale
  const ax = start.longitude * longitudeScale
  const ay = start.latitude * latitudeScale
  const bx = end.longitude * longitudeScale
  const by = end.latitude * latitudeScale
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const ratio = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + dx * ratio), py - (ay + dy * ratio))
}

function segmentIntersectsPolygon(start: V3Coordinate, end: V3Coordinate, polygon: readonly V3Coordinate[]): boolean {
  if (polygon.length < 3) return false
  if (pointInPolygon(start, polygon) || pointInPolygon(end, polygon)) return true
  for (let index = 0; index < polygon.length; index += 1) {
    if (segmentsIntersect(start, end, polygon[index]!, polygon[(index + 1) % polygon.length]!)) return true
  }
  return false
}

function segmentsIntersect(a: V3Coordinate, b: V3Coordinate, c: V3Coordinate, d: V3Coordinate): boolean {
  const orientation = (left: V3Coordinate, middle: V3Coordinate, right: V3Coordinate) => (middle.latitude - left.latitude) * (right.longitude - middle.longitude) - (middle.longitude - left.longitude) * (right.latitude - middle.latitude)
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)
    || Math.abs(o1) < 1e-12 && pointOnSegment(c, a, b)
    || Math.abs(o2) < 1e-12 && pointOnSegment(d, a, b)
    || Math.abs(o3) < 1e-12 && pointOnSegment(a, c, d)
    || Math.abs(o4) < 1e-12 && pointOnSegment(b, c, d)
}

function pointOnSegment(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): boolean {
  return point.longitude >= Math.min(start.longitude, end.longitude) - 1e-12
    && point.longitude <= Math.max(start.longitude, end.longitude) + 1e-12
    && point.latitude >= Math.min(start.latitude, end.latitude) - 1e-12
    && point.latitude <= Math.max(start.latitude, end.latitude) + 1e-12
}

function pointInPolygon(point: V3Coordinate, polygon: readonly V3Coordinate[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const currentPoint = polygon[current]!
    const previousPoint = polygon[previous]!
    if ((currentPoint.latitude > point.latitude) !== (previousPoint.latitude > point.latitude)) {
      const longitude = (previousPoint.longitude - currentPoint.longitude) * (point.latitude - currentPoint.latitude) / (previousPoint.latitude - currentPoint.latitude || Number.EPSILON) + currentPoint.longitude
      if (point.longitude < longitude) inside = !inside
    }
  }
  return inside
}

function validateFleetRelations(input: VtlPlanValidationInput): VtlPlanCheckIssueView[] {
  const issues: VtlPlanCheckIssueView[] = []
  const horizontalSeparationMeters = input.horizontalSeparationMeters ?? 10
  const verticalSeparationMeters = input.verticalSeparationMeters ?? 30
  const temporalSeparationSeconds = input.temporalSeparationSeconds ?? 20
  const activeRoutes = input.routes.filter((route) => input.assignments.some((assignment) => assignment.aircraftId === route.aircraftId && assignment.available && assignment.taskObjectIds.length > 0))

  for (const route of activeRoutes) {
    if (input.mainLandingSitePosition) {
      const takeoff = route.waypoints[0]?.position
      const landing = route.waypoints.at(-1)?.position
      if (takeoff && distanceBetween(takeoff, input.mainLandingSitePosition) > MAIN_LANDING_SITE_RADIUS_METERS) {
        issues.push(issue("TAKEOFF_SITE", "SPATIAL", "CONFLICT", [route.aircraftId], [], `航空器 ${route.aircraftId} 的起飞点偏离主起降点超过教学允许范围。`, "将首个航点调整到主起降点附近。"))
      }
      if (landing && distanceBetween(landing, input.mainLandingSitePosition) > MAIN_LANDING_SITE_RADIUS_METERS) {
        issues.push(issue("LANDING_SITE", "SPATIAL", "CONFLICT", [route.aircraftId], [], `航空器 ${route.aircraftId} 的降落点偏离主起降点超过教学允许范围。`, "将末个航点调整到主起降点附近。"))
      }
    }
  }

  for (let firstIndex = 0; firstIndex < activeRoutes.length; firstIndex += 1) {
    const firstRoute = activeRoutes[firstIndex]!
    for (let secondIndex = firstIndex + 1; secondIndex < activeRoutes.length; secondIndex += 1) {
      const secondRoute = activeRoutes[secondIndex]!
      const relation = closestTimedRouteRelation(firstRoute, secondRoute, temporalSeparationSeconds)
      if (!relation) continue
      const hardConflict = relation.horizontalMeters < horizontalSeparationMeters && relation.verticalMeters < verticalSeparationMeters
      const nearConflict = relation.horizontalMeters < horizontalSeparationMeters * 1.5 && relation.verticalMeters < verticalSeparationMeters * 1.5
      if (!hardConflict && !nearConflict) continue
      const severity = hardConflict ? "CONFLICT" : "RISK"
      issues.push(issue(
        "FLEET_SEPARATION",
        "SPATIAL",
        severity,
        [firstRoute.aircraftId, secondRoute.aircraftId],
        relation.taskObjectIds,
        `航空器 ${firstRoute.aircraftId} 与 ${secondRoute.aircraftId} 在约 ${Math.round(relation.timeSeconds)} 秒时段的教学间隔不足（水平 ${Math.round(relation.horizontalMeters)} m，垂直 ${Math.round(relation.verticalMeters)} m）。`,
        "调整任务顺序、航段高度或起飞错峰，重新执行多机检查。"
      ))
    }
  }
  return issues
}

function closestTimedRouteRelation(firstRoute: VtlRoutePlanView, secondRoute: VtlRoutePlanView, temporalSeparationSeconds: number): { horizontalMeters: number; verticalMeters: number; timeSeconds: number; taskObjectIds: string[] } | null {
  const firstSegments = timedRouteSegments(firstRoute)
  const secondSegments = timedRouteSegments(secondRoute)
  let closest: { horizontalMeters: number; verticalMeters: number; timeSeconds: number; taskObjectIds: string[] } | null = null
  for (const first of firstSegments) {
    if (!operationalPhase(first.phase)) continue
    for (const second of secondSegments) {
      if (!operationalPhase(second.phase)) continue
      const overlapStart = Math.max(first.startTime, second.startTime)
      const overlapEnd = Math.min(first.endTime, second.endTime)
      const samples = overlapStart <= overlapEnd
        ? sampleTimes(overlapStart, overlapEnd)
        : [first.endTime, second.endTime].sort((left, right) => left - right)
      for (const time of samples) {
        const firstTime = Math.min(first.endTime, Math.max(first.startTime, time))
        const secondTime = Math.min(second.endTime, Math.max(second.startTime, time))
        if (Math.abs(firstTime - secondTime) > temporalSeparationSeconds) continue
        const firstPosition = timedPosition(first, firstTime)
        const secondPosition = timedPosition(second, secondTime)
        const candidate = {
          horizontalMeters: distanceBetween(firstPosition, secondPosition),
          verticalMeters: Math.abs((firstPosition.altitudeMeters ?? 0) - (secondPosition.altitudeMeters ?? 0)),
          timeSeconds: (firstTime + secondTime) / 2,
          taskObjectIds: [first.taskObjectId, second.taskObjectId].filter((taskObjectId): taskObjectId is string => Boolean(taskObjectId))
        }
        if (!closest || candidate.horizontalMeters < closest.horizontalMeters) closest = candidate
      }
    }
  }
  return closest
}

type TimedRouteSegment = {
  phase: VtlFlightPhase
  startTime: number
  endTime: number
  start: V3Coordinate
  end: V3Coordinate
  taskObjectId: string | null
}

function timedRouteSegments(route: VtlRoutePlanView): TimedRouteSegment[] {
  let cursor = 0
  return route.energySegments.map((segment, index) => {
    const startTime = cursor
    cursor += segment.durationSeconds
    return {
      phase: segment.phase,
      startTime,
      endTime: cursor,
      start: route.waypoints[index]?.position ?? route.waypoints[0]?.position ?? { longitude: 0, latitude: 0, altitudeMeters: 0 },
      end: route.waypoints[index + 1]?.position ?? route.waypoints[index]?.position ?? { longitude: 0, latitude: 0, altitudeMeters: 0 },
      taskObjectId: route.waypoints[index]?.taskObjectId ?? null
    }
  })
}

function timedPosition(segment: TimedRouteSegment, time: number): V3Coordinate {
  const ratio = segment.endTime <= segment.startTime ? 1 : (time - segment.startTime) / (segment.endTime - segment.startTime)
  return interpolate(segment.start, segment.end, Math.max(0, Math.min(1, ratio)))
}

function sampleTimes(start: number, end: number): number[] {
  if (end <= start) return [start]
  return Array.from({ length: 9 }, (_, index) => start + (end - start) * index / 8)
}

function operationalPhase(phase: VtlFlightPhase): boolean {
  return phase === "FIXED_WING_CRUISE" || phase === "TASK_EXECUTION" || phase === "RETURN"
}

function routeWaypointTime(route: VtlRoutePlanView, waypointSequence: number): number {
  return route.energySegments.slice(0, Math.max(0, waypointSequence)).reduce((total, segment) => total + segment.durationSeconds, 0)
}

export function projectVtlRuntime(input: VtlRuntimeInput): {
  aircraft: VtlRuntimeAircraftView[]
  groups: VtlRuntimeGroupView[]
  summary: VtlRuntimeSummaryView
} {
  const routeByAircraft = new Map(input.routes.map((route) => [route.aircraftId, route]))
  const taskById = new Map(input.taskObjects.map((task) => [task.id, task]))
  const eventAircraftIds = new Set((input.events ?? []).flatMap((event) => event.aircraftIds))
  const aircraft: VtlRuntimeAircraftView[] = input.assignments.map((assignment): VtlRuntimeAircraftView => {
    const route = routeByAircraft.get(assignment.aircraftId)
    const projection = route ? projectAircraft(route, input.simulationTimeMs) : null
    const completedTaskObjectIds = projection?.completedTaskObjectIds ?? []
    return {
      aircraftId: assignment.aircraftId,
      aircraftCode: assignment.aircraftCode,
      groupId: assignment.groupId,
      phase: projection?.phase ?? "VERTICAL_TAKEOFF",
      position: projection?.position ?? { longitude: 0, latitude: 0, altitudeMeters: 0 },
      currentTaskObjectId: projection?.currentTaskObjectId ?? null,
      completedTaskObjectIds,
      remainingEnergyWh: projection?.remainingEnergyWh ?? 0,
      remainingEnergyRatio: projection?.remainingEnergyRatio ?? 0,
      eventIds: eventAircraftIds.has(assignment.aircraftId) ? (input.events ?? []).filter((event) => event.aircraftIds.includes(assignment.aircraftId)).map((event) => event.id) : [],
      status: projection?.status ?? "WAITING"
    }
  })
  const groups = input.groups.map((group) => {
    const groupAircraft = aircraft.filter((item) => group.aircraftIds.includes(item.aircraftId))
    const completedTaskCount = new Set(groupAircraft.flatMap((item) => item.completedTaskObjectIds)).size
    const phaseDistribution = groupAircraft.reduce<Partial<Record<VtlFlightPhase, number>>>((result, item) => {
      result[item.phase] = (result[item.phase] ?? 0) + 1
      return result
    }, {})
    return {
      groupId: group.id,
      aircraftCount: groupAircraft.length,
      activeAircraftCount: groupAircraft.filter((item) => item.status === "ACTIVE" || item.status === "HOLDING").length,
      completedTaskCount,
      totalTaskCount: group.taskObjectIds.length,
      progressRatio: group.taskObjectIds.length === 0 ? 0 : completedTaskCount / group.taskObjectIds.length,
      attentionCount: groupAircraft.filter((item) => item.eventIds.length > 0).length,
      phaseDistribution
    } satisfies VtlRuntimeGroupView
  })
  const totalTaskObjects = input.taskObjects.length
  const completedTaskObjects = new Set(aircraft.flatMap((item) => item.completedTaskObjectIds)).size
  const routeByAircraftForMetrics = new Map(input.routes.map((route) => [route.aircraftId, route]))
  const minimumRemainingEnergyWh = aircraft.length === 0
    ? 0
    : Math.min(...aircraft.map((item) => item.remainingEnergyWh))
  const energyReserveViolationCount = aircraft.filter((item) => {
    const route = routeByAircraftForMetrics.get(item.aircraftId)
    return route ? item.remainingEnergyWh < route.reserveEnergyWh : false
  }).length
  const horizontalSeparationMeters = input.horizontalSeparationMeters ?? 10
  const verticalSeparationMeters = input.verticalSeparationMeters ?? 30
  let airborneConflictCount = 0
  for (let leftIndex = 0; leftIndex < aircraft.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < aircraft.length; rightIndex += 1) {
      const left = aircraft[leftIndex]!
      const right = aircraft[rightIndex]!
      const leftAirborne = ["ACTIVE", "HOLDING", "RETURNING", "DIVERTING"].includes(left.status)
      const rightAirborne = ["ACTIVE", "HOLDING", "RETURNING", "DIVERTING"].includes(right.status)
      if (!leftAirborne || !rightAirborne) continue
      if (distanceBetween(left.position, right.position) < horizontalSeparationMeters
        && Math.abs((left.position.altitudeMeters ?? 0) - (right.position.altitudeMeters ?? 0)) < verticalSeparationMeters) airborneConflictCount += 1
    }
  }
  const phaseDistribution = aircraft.reduce<Partial<Record<VtlFlightPhase, number>>>((result, item) => {
    result[item.phase] = (result[item.phase] ?? 0) + 1
    return result
  }, {})
  return {
    aircraft,
    groups,
    summary: {
      totalAircraft: aircraft.length,
      airborneAircraft: aircraft.filter((item) => item.status === "ACTIVE" || item.status === "HOLDING" || item.status === "RETURNING" || item.status === "DIVERTING").length,
      landedAircraft: aircraft.filter((item) => item.status === "LANDED").length,
      attentionAircraft: aircraft.filter((item) => item.eventIds.length > 0).length,
      totalTaskObjects,
      completedTaskObjects,
      incompleteTaskObjects: Math.max(0, totalTaskObjects - completedTaskObjects),
      taskCompletionRatio: totalTaskObjects === 0 ? 0 : completedTaskObjects / totalTaskObjects,
      phaseDistribution,
      minimumRemainingEnergyWh,
      energyReserveViolationCount,
      airborneConflictCount,
      executable: energyReserveViolationCount === 0 && airborneConflictCount === 0 && completedTaskObjects === totalTaskObjects
    }
  }
}

export function vtlRuntimeActionsFor(status: VtlRuntimeAircraftView["status"], phase: VtlFlightPhase): Array<{ code: string; label: string }> {
  if (status === "LANDED" || status === "CANCELLED") return []
  const actions: Array<{ code: string; label: string }> = [{ code: "ACKNOWLEDGE", label: "确认告警" }]
  if (phase !== "VERTICAL_LANDING") actions.push({ code: "HOLD", label: "保持等待" })
  if (phase !== "VERTICAL_TAKEOFF" && phase !== "VERTICAL_LANDING") actions.push({ code: "RETURN_AIRCRAFT", label: "返航" })
  return actions
}

function projectAircraft(route: VtlRoutePlanView, simulationTimeMs: number) {
  let remainingMs = Math.max(0, simulationTimeMs)
  const initialEnergyWh = route.energySegments.length > 0
    ? route.energySegments[0]!.remainingEnergyWh + route.energySegments[0]!.energyWh
    : route.reserveEnergyWh
  let remainingEnergyWh = initialEnergyWh
  const completedTaskObjectIds: string[] = []
  if (remainingMs === 0) {
    const initialPosition = route.waypoints[0]?.position ?? { longitude: 0, latitude: 0, altitudeMeters: 0 }
    return {
      phase: "VERTICAL_TAKEOFF" as const,
      position: { ...initialPosition },
      currentTaskObjectId: null,
      completedTaskObjectIds,
      remainingEnergyWh: initialEnergyWh,
      remainingEnergyRatio: initialEnergyWh <= 0 ? 0 : 1,
      status: "WAITING" as const
    }
  }
  for (let index = 0; index < route.energySegments.length; index += 1) {
    const segment = route.energySegments[index]!
    const durationMs = segment.durationSeconds * 1_000
    const start = route.waypoints[index]?.position ?? route.waypoints[0]?.position ?? { longitude: 0, latitude: 0, altitudeMeters: 0 }
    const end = route.waypoints[index + 1]?.position ?? start
    if (remainingMs >= durationMs) {
      remainingMs -= durationMs
      remainingEnergyWh = Math.max(0, segment.remainingEnergyWh)
      const taskObjectId = route.waypoints[index]?.taskObjectId
      if (taskObjectId) completedTaskObjectIds.push(taskObjectId)
      continue
    }
    const ratio = durationMs <= 0 ? 1 : remainingMs / durationMs
    const taskObjectId = route.waypoints[index]?.taskObjectId ?? null
    remainingEnergyWh = Math.max(0, remainingEnergyWh - segment.energyWh * ratio)
    return {
      phase: segment.phase,
      position: interpolate(start, end, ratio),
      currentTaskObjectId: taskObjectId,
      completedTaskObjectIds,
      remainingEnergyWh,
      remainingEnergyRatio: initialEnergyWh <= 0 ? 0 : Math.max(0, remainingEnergyWh / initialEnergyWh),
      status: segment.phase === "RETURN" || segment.phase === "BACK_TRANSITION" ? "RETURNING" : "ACTIVE"
    } as const
  }
  const last = route.waypoints.at(-1)?.position ?? { longitude: 0, latitude: 0, altitudeMeters: 0 }
  return {
    phase: "VERTICAL_LANDING" as const,
    position: { ...last },
    currentTaskObjectId: null,
    completedTaskObjectIds,
    remainingEnergyWh: Math.max(route.reserveEnergyWh, remainingEnergyWh),
    remainingEnergyRatio: initialEnergyWh <= 0 ? 0 : Math.max(0, remainingEnergyWh / initialEnergyWh),
    status: "LANDED" as const
  }
}

function calculateEnergySegments(
  waypoints: VtlRoutePlanView["waypoints"],
  terrainProfile: VtlTerrainProfileSample[],
  parameters: VtlAircraftParameters
): VtlEnergySegmentView[] {
  let remainingEnergyWh = parameters.batteryCapacityWh
  return waypoints.slice(0, -1).map((waypoint, index) => {
    const next = waypoints[index + 1]!
    const distanceMeters = distanceBetween(waypoint.position, next.position)
    const speedMps = Math.max(1, waypoint.speedMps || speedForPhase(waypoint.phase, parameters))
    const durationSeconds = Math.max(1, distanceMeters / speedMps)
    const powerWatts = powerForPhase(waypoint.phase, parameters)
    const energyWh = powerWatts * durationSeconds / 3_600
    remainingEnergyWh = Math.max(0, remainingEnergyWh - energyWh)
    return {
      phase: waypoint.phase,
      distanceMeters,
      durationSeconds,
      energyWh,
      remainingEnergyWh,
      remainingEnergyRatio: remainingEnergyWh / parameters.batteryCapacityWh
    }
  })
}

function compareAlternateRoute(
  waypoints: VtlRoutePlanView["waypoints"],
  energySegments: VtlEnergySegmentView[],
  landingSiteId: string,
  landingSitePosition: V3Coordinate,
  transitionHeightMeters: number,
  parameters: VtlAircraftParameters
): NonNullable<VtlRoutePlanView["alternateComparison"]> | null {
  let diversionWaypointIndex = -1
  for (let index = waypoints.length - 1; index >= 0; index -= 1) {
    if (waypoints[index]?.phase === "TASK_EXECUTION") {
      diversionWaypointIndex = index
      break
    }
  }
  if (diversionWaypointIndex < 0) diversionWaypointIndex = waypoints.findIndex((waypoint) => waypoint.phase === "RETURN")
  const diversionWaypoint = waypoints[diversionWaypointIndex]
  if (!diversionWaypoint) return null

  const landingAltitudeMeters = Math.max(0, landingSitePosition.altitudeMeters ?? 0)
  const alternateWaypoints: VtlRoutePlanView["waypoints"] = [
    {
      ...diversionWaypoint,
      id: `${diversionWaypoint.id}-alternate-return`,
      sequence: 0,
      phase: "RETURN",
      speedMps: parameters.cruiseSpeedMps,
      taskObjectId: null,
      position: { ...diversionWaypoint.position }
    },
    {
      id: `${landingSiteId}-alternate-transition`,
      sequence: 1,
      phase: "BACK_TRANSITION",
      speedMps: parameters.transitionSpeedMps,
      taskObjectId: null,
      altitudeMeters: transitionHeightMeters,
      position: { ...landingSitePosition, altitudeMeters: transitionHeightMeters }
    },
    {
      id: `${landingSiteId}-alternate-descent`,
      sequence: 2,
      phase: "VERTICAL_LANDING",
      speedMps: parameters.transitionSpeedMps,
      taskObjectId: null,
      altitudeMeters: 10,
      position: { ...landingSitePosition, altitudeMeters: 10 }
    },
    {
      id: `${landingSiteId}-alternate-landing`,
      sequence: 3,
      phase: "VERTICAL_LANDING",
      speedMps: parameters.transitionSpeedMps,
      taskObjectId: null,
      altitudeMeters: landingAltitudeMeters,
      position: { ...landingSitePosition, altitudeMeters: landingAltitudeMeters }
    }
  ]
  const alternateSegments = calculateEnergySegments(alternateWaypoints, [], parameters)
  const nominalSegments = energySegments.slice(diversionWaypointIndex)
  const consumedEnergyWh = sumEnergy(energySegments.slice(0, diversionWaypointIndex))
  const nominalReturnEnergyWh = sumEnergy(nominalSegments)
  const alternateEnergyWh = sumEnergy(alternateSegments)
  const nominalReturnDistanceMeters = sumDistance(nominalSegments)
  const alternateDistanceMeters = sumDistance(alternateSegments)
  const nominalReturnDurationSeconds = sumDuration(nominalSegments)
  const alternateDurationSeconds = sumDuration(alternateSegments)
  const reserveEnergyWh = parameters.batteryCapacityWh * parameters.reserveEnergyRatio
  const nominalArrivalEnergyWh = Math.max(0, parameters.batteryCapacityWh - consumedEnergyWh - nominalReturnEnergyWh)
  const alternateArrivalEnergyWh = Math.max(0, parameters.batteryCapacityWh - consumedEnergyWh - alternateEnergyWh)
  const reserveMarginWh = alternateArrivalEnergyWh - reserveEnergyWh
  return {
    landingSiteId,
    diversionWaypointId: diversionWaypoint.id,
    nominalReturnDistanceMeters,
    nominalReturnDurationSeconds,
    nominalReturnEnergyWh,
    nominalArrivalEnergyWh,
    alternateDistanceMeters,
    alternateDurationSeconds,
    alternateEnergyWh,
    alternateArrivalEnergyWh,
    distanceDeltaMeters: alternateDistanceMeters - nominalReturnDistanceMeters,
    durationDeltaSeconds: alternateDurationSeconds - nominalReturnDurationSeconds,
    energyDeltaWh: alternateEnergyWh - nominalReturnEnergyWh,
    reserveMarginWh,
    feasible: reserveMarginWh >= 0
  }
}

function sumEnergy(segments: readonly VtlEnergySegmentView[]): number {
  return segments.reduce((sum, segment) => sum + segment.energyWh, 0)
}

function sumDistance(segments: readonly VtlEnergySegmentView[]): number {
  return segments.reduce((sum, segment) => sum + segment.distanceMeters, 0)
}

function sumDuration(segments: readonly VtlEnergySegmentView[]): number {
  return segments.reduce((sum, segment) => sum + segment.durationSeconds, 0)
}

function validateRouteStructure(route: VtlRoutePlanView, parameters: VtlAircraftParameters): VtlPlanCheckIssueView[] {
  const issues: VtlPlanCheckIssueView[] = []
  const phases = route.waypoints.map((waypoint) => waypoint.phase)
  let lastIndex = -1
  for (const phase of PHASE_ORDER) {
    const index = phases.indexOf(phase)
    if (index >= 0 && index < lastIndex) issues.push(issue("PHASE_ORDER", "TRANSITION", "CONFLICT", [route.aircraftId], [], `航空器 ${route.aircraftId} 的八阶段顺序不完整。`, "按垂起、转换、巡检、返航和降落顺序调整航点。"))
    if (index >= 0) lastIndex = index
  }
  const transition = route.waypoints.find((waypoint) => waypoint.phase === "FORWARD_TRANSITION")
  if (!transition || transition.altitudeMeters < parameters.minimumTransitionHeightMeters) issues.push(issue("TRANSITION_HEIGHT", "TRANSITION", "CONFLICT", [route.aircraftId], [], "前转换点未达到最低转换高度。", "提高前转换点高度。"))
  if (route.waypoints.some((waypoint) => waypoint.altitudeMeters > parameters.maximumOperatingAltitudeMeters)) issues.push(issue("ALTITUDE_LIMIT", "TRANSITION", "CONFLICT", [route.aircraftId], [], "航点高度超过机型教学运行上限。", "降低航段高度。"))
  if (route.energySegments.some((segment) => segment.remainingEnergyWh < route.reserveEnergyWh)) issues.push(issue("ENERGY_RESERVE", "ENERGY", "CONFLICT", [route.aircraftId], [], "航线末端低于返航能量余度。", "缩短航线或增加备降方案。"))
  if (route.alternateComparison && !route.alternateComparison.feasible) issues.push(issue("ALTERNATE_ENERGY", "ALTERNATE", "CONFLICT", [route.aircraftId], [], "备降方案预计到达能量低于教学余度。", "选择更近的备降点或调整任务顺序和航线。"))
  if (route.minimumTerrainClearanceMeters < 30) issues.push(issue("TERRAIN_CLEARANCE", "TERRAIN", "CONFLICT", [route.aircraftId], [], "航线地形净空不足。", "提高航段高度。"))
  if (!route.alternateLandingSiteId) issues.push(issue("ALTERNATE_MISSING", "ALTERNATE", "CONFLICT", [route.aircraftId], [], "未设置备降点。", "为每架航空器选择可用备降点。"))
  return issues
}

function buildTerrainProfile(waypoints: VtlRoutePlanView["waypoints"]): VtlTerrainProfileSample[] {
  let distanceMeters = 0
  return waypoints.map((waypoint, index) => {
    if (index > 0) distanceMeters += distanceBetween(waypoints[index - 1]!.position, waypoint.position)
    const terrainElevationMeters = Math.max(0, waypoint.position.altitudeMeters ?? 0) * 0.35
    return {
      distanceMeters,
      terrainElevationMeters,
      plannedAltitudeMeters: waypoint.altitudeMeters,
      clearanceMeters: waypoint.altitudeMeters - terrainElevationMeters,
      longitude: waypoint.position.longitude,
      latitude: waypoint.position.latitude
    }
  })
}

function powerForPhase(phase: VtlFlightPhase, parameters: VtlAircraftParameters): number {
  if (phase === "VERTICAL_TAKEOFF" || phase === "VERTICAL_LANDING") return parameters.verticalPowerWatts
  if (phase === "CLIMB" || phase === "FORWARD_TRANSITION" || phase === "BACK_TRANSITION") return parameters.hoverPowerWatts
  if (phase === "FIXED_WING_CRUISE" || phase === "RETURN") return parameters.cruisePowerWatts
  return parameters.taskPowerWatts
}

function speedForPhase(phase: VtlFlightPhase, parameters: VtlAircraftParameters): number {
  if (phase === "CLIMB") return parameters.climbSpeedMps
  if (phase === "FORWARD_TRANSITION" || phase === "BACK_TRANSITION") return parameters.transitionSpeedMps
  return parameters.cruiseSpeedMps
}

function distanceBetween(left: { longitude: number; latitude: number }, right: { longitude: number; latitude: number }): number {
  const latitude1 = left.latitude * Math.PI / 180
  const latitude2 = right.latitude * Math.PI / 180
  const deltaLatitude = (right.latitude - left.latitude) * Math.PI / 180
  const deltaLongitude = (right.longitude - left.longitude) * Math.PI / 180
  const sine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(sine), Math.sqrt(Math.max(0, 1 - sine)))
}

function interpolate(start: { longitude: number; latitude: number; altitudeMeters?: number }, end: { longitude: number; latitude: number; altitudeMeters?: number }, ratio: number) {
  return {
    longitude: start.longitude + (end.longitude - start.longitude) * ratio,
    latitude: start.latitude + (end.latitude - start.latitude) * ratio,
    altitudeMeters: (start.altitudeMeters ?? 0) + ((end.altitudeMeters ?? 0) - (start.altitudeMeters ?? 0)) * ratio
  }
}

function issue(code: string, category: VtlPlanCheckIssueView["category"], severity: VtlPlanCheckIssueView["severity"], aircraftIds: string[], taskObjectIds: string[], message: string, suggestion: string, identity = ""): VtlPlanCheckIssueView {
  return { id: `VTL-${code}-${aircraftIds.join("-")}-${taskObjectIds.join("-")}${identity ? `-${identity}` : ""}`, code, scope: aircraftIds.length > 0 ? "AIRCRAFT" : "FLEET", category, severity, aircraftIds, taskObjectIds, message, suggestion }
}
