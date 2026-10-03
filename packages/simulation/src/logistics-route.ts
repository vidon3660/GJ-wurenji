import type {
  LogisticsAircraftCapabilityView,
  LogisticsRoundTripMetricView,
  LogisticsRoundTripMilestoneView,
  LogisticsRouteCheckCategory,
  LogisticsRouteCheckEvidence,
  LogisticsRouteCheckResult,
  LogisticsRouteInput,
  LogisticsRouteMetricView,
  LogisticsRouteValidationResult,
  V3Coordinate,
  V3LogisticsNode,
  V3RegionCatalogItem
} from "@wurenji/shared"
import { inspectLogisticsRouteSpatialRelations, logisticsRouteCheckCategories } from "@wurenji/shared"

const earthRadiusMeters = 6_371_008.8

export interface LogisticsRouteRuleContext {
  region: V3RegionCatalogItem
  selectedDeliveryPointIds: string[]
  aircraft: LogisticsAircraftCapabilityView
}

export function checkLogisticsRoutePlan(
  routes: readonly LogisticsRouteInput[],
  context: LogisticsRouteRuleContext,
  checkedAt = new Date()
): LogisticsRouteCheckResult {
  const evidence: LogisticsRouteCheckEvidence[] = []
  const nodeById = new Map((context.region.logisticsNodes ?? []).map((node) => [node.id, node]))
  const selectedDeliveryIds = new Set(context.selectedDeliveryPointIds)
  const selectedDeliveryNodes = context.selectedDeliveryPointIds.map((id) => nodeById.get(id)).filter((node): node is V3LogisticsNode => Boolean(node))
  const takeoff = findNode(context.region, "TAKEOFF_POINT")
  const landing = findNode(context.region, "LANDING_POINT")

  if (selectedDeliveryNodes.length !== context.selectedDeliveryPointIds.length) {
    addEvidence(evidence, "DELIVERY_NODE_INVALID", "NODES", "CONFLICT", "启用配送点不属于当前区域或已停用")
  }

  for (const deliveryNode of selectedDeliveryNodes) {
    const primaryOutbound = routes.filter((route) => route.destinationNodeId === deliveryNode.id && route.role === "PRIMARY" && route.direction === "OUTBOUND")
    const primaryReturn = routes.filter((route) => route.destinationNodeId === deliveryNode.id && route.role === "PRIMARY" && route.direction === "RETURN")
    if (primaryOutbound.length !== 1 || primaryReturn.length !== 1) {
      addEvidence(evidence, "ROUND_TRIP_PAIR_INCOMPLETE", "NODES", "CONFLICT", `${deliveryNode.name}必须且只能设置一组正式去返程航线`, [...primaryOutbound, ...primaryReturn].map((route) => route.id))
    }
    const pair = [...primaryOutbound, ...primaryReturn]
    if (pair.length > 0 && !pair.some((route) => route.waitingNodeIds.length > 0)) {
      addEvidence(evidence, "WAITING_NODE_MISSING", "NODES", "CONFLICT", `${deliveryNode.name}的往返方案缺少等待点`, pair.map((route) => route.id))
    }
    if (pair.length > 0 && !pair.some((route) => route.alternateLandingNodeIds.length > 0)) {
      addEvidence(evidence, "ALTERNATE_NODE_MISSING", "NODES", "CONFLICT", `${deliveryNode.name}的往返方案缺少备降点`, pair.map((route) => route.id))
    }
    if (pair.length > 0 && !pair.some((route) => route.emergencyAreaNodeIds.length > 0)) {
      addEvidence(evidence, "EMERGENCY_AREA_MISSING", "NODES", "CONFLICT", `${deliveryNode.name}的往返方案缺少应急运行区域`, pair.map((route) => route.id))
    }
  }

  for (const route of routes) {
    if (route.mode === "NETWORK_SEGMENT") {
      const departureNode = nodeById.get(route.departureNodeId)
      const arrivalNode = nodeById.get(route.arrivalNodeId)
      if (!departureNode || !arrivalNode || departureNode.id === arrivalNode.id) {
        addEvidence(evidence, "NETWORK_ENDPOINT_INVALID", "NODES", "CONFLICT", `${route.name}的网络航段起终点无效`, [route.id])
        continue
      }
      validateRouteNodes(route, departureNode, arrivalNode, nodeById, evidence)
      validateRouteGeometry(route, context, evidence)
      validateCoverage(route, context.region, evidence)
      validateEfficiency(route, nodeById, evidence)
      continue
    }
    const destination = nodeById.get(route.destinationNodeId)
    if (!destination || destination.type !== "DELIVERY_POINT" || !selectedDeliveryIds.has(destination.id)) {
      addEvidence(evidence, "ROUTE_DESTINATION_INVALID", "NODES", "CONFLICT", `${route.name}未关联已启用配送点`, [route.id])
      continue
    }
    if (route.waypoints.length < 3) {
      addEvidence(evidence, "INTERMEDIATE_WAYPOINT_MISSING", "NODES", "CONFLICT", `${route.name}只有系统固定端点，学生须自主添加至少一个中间航点`, [route.id])
    }
    const expectedDeparture = route.direction === "OUTBOUND" ? takeoff : destination
    const expectedArrival = route.direction === "OUTBOUND" ? destination : landing
    validateRouteNodes(route, expectedDeparture, expectedArrival, nodeById, evidence)
    validateRouteGeometry(route, context, evidence)
    validateCoverage(route, context.region, evidence)
    validateEfficiency(route, nodeById, evidence)
  }

  validateRoundTripCapability(routes, selectedDeliveryNodes, context.aircraft, evidence)
  validateRouteRelationships(routes, evidence)

  const conflictCount = evidence.filter((item) => item.severity === "CONFLICT").length
  const riskCount = evidence.filter((item) => item.severity === "RISK").length
  const infoCount = evidence.filter((item) => item.severity === "INFO").length
  const categorySummaries = logisticsRouteCheckCategories.map((category) => {
    const categoryEvidence = evidence.filter((item) => item.category === category)
    const categoryConflictCount = categoryEvidence.filter((item) => item.severity === "CONFLICT").length
    return {
      category,
      checked: true as const,
      passed: categoryConflictCount === 0,
      conflictCount: categoryConflictCount,
      riskCount: categoryEvidence.filter((item) => item.severity === "RISK").length,
      infoCount: categoryEvidence.filter((item) => item.severity === "INFO").length,
      evidenceCount: categoryEvidence.length
    }
  })
  return {
    passed: conflictCount === 0,
    checkedAt: checkedAt.toISOString(),
    routeCount: routes.length,
    selectedDeliveryPointCount: context.selectedDeliveryPointIds.length,
    conflictCount,
    riskCount,
    infoCount,
    categorySummaries,
    evidence
  }
}

export function simulateLogisticsRoundTrips(
  routes: readonly LogisticsRouteInput[],
  context: LogisticsRouteRuleContext,
  seed: string,
  checkedAt = new Date()
): LogisticsRouteValidationResult {
  const checkResult = checkLogisticsRoutePlan(routes, context, checkedAt)
  const routeMetrics = routes.map((route) => routeMetric(route, context.region, context.aircraft, seed))
  const metricByRouteId = new Map(routeMetrics.map((metric) => [metric.routeId, metric]))
  const roundTripMetrics: LogisticsRoundTripMetricView[] = context.selectedDeliveryPointIds.map((destinationNodeId) => {
    const outbound = routes.find((route) => route.destinationNodeId === destinationNodeId && route.direction === "OUTBOUND" && route.role === "PRIMARY")
    const inbound = routes.find((route) => route.destinationNodeId === destinationNodeId && route.direction === "RETURN" && route.role === "PRIMARY")
    const outboundMetric = outbound ? metricByRouteId.get(outbound.id) : undefined
    const inboundMetric = inbound ? metricByRouteId.get(inbound.id) : undefined
    const distanceMeters = round((outboundMetric?.distanceMeters ?? 0) + (inboundMetric?.distanceMeters ?? 0), 1)
    const flightTimeSeconds = round((outboundMetric?.flightTimeSeconds ?? 0) + (inboundMetric?.flightTimeSeconds ?? 0) + 30, 1)
    const batteryConsumptionPercent = round(6 + distanceMeters / context.aircraft.maximumRoundTripMeters * (100 - context.aircraft.minimumReserveBatteryPercent), 1)
    const remainingBatteryPercent = round(Math.max(0, 100 - batteryConsumptionPercent), 1)
    return {
      destinationNodeId,
      outboundRouteId: outbound?.id ?? "",
      returnRouteId: inbound?.id ?? "",
      distanceMeters,
      flightTimeSeconds,
      batteryConsumptionPercent,
      remainingBatteryPercent,
      completed: Boolean(outbound && inbound && outboundMetric && inboundMetric && distanceMeters <= context.aircraft.maximumRoundTripMeters),
      ...(outbound && inbound && outboundMetric && inboundMetric ? {
        milestones: roundTripMilestones(outbound, inbound, outboundMetric, inboundMetric, remainingBatteryPercent)
      } : {})
    }
  })
  const simulationEvidence = checkResult.evidence.map((item) => locateValidationEvidence(item, routes, routeMetrics))
  for (const metric of roundTripMetrics) {
    if (!metric.outboundRouteId || !metric.returnRouteId) continue
    if (metric.distanceMeters > context.aircraft.maximumRoundTripMeters) {
      addEvidence(simulationEvidence, "ROUND_TRIP_RANGE_EXCEEDED", "AIRCRAFT", "CONFLICT", `往返航程 ${metric.distanceMeters.toFixed(0)} 米超过统一机型能力`, [metric.outboundRouteId, metric.returnRouteId], [], [], null, { distanceMeters: metric.distanceMeters })
    } else if (metric.remainingBatteryPercent < context.aircraft.minimumReserveBatteryPercent + 5) {
      addEvidence(simulationEvidence, "BATTERY_RESERVE_NEAR_LIMIT", "AIRCRAFT", "RISK", `往返后剩余电量 ${metric.remainingBatteryPercent.toFixed(1)}%，接近安全余量`, [metric.outboundRouteId, metric.returnRouteId], [], [], null, { remainingBatteryPercent: metric.remainingBatteryPercent })
    }
  }
  for (let index = 0; index < simulationEvidence.length; index += 1) {
    simulationEvidence[index] = locateValidationEvidence(simulationEvidence[index]!, routes, routeMetrics)
  }
  const conflictCount = simulationEvidence.filter((item) => item.blocking).length
  const completedRoundTripCount = roundTripMetrics.filter((metric) => metric.completed).length
  const status = conflictCount > 0
    ? "HARD_CONFLICT"
    : completedRoundTripCount !== context.selectedDeliveryPointIds.length
      ? "INFEASIBLE"
      : simulationEvidence.some((item) => item.severity === "RISK")
        ? "WITH_RISK"
        : "PASSED"
  return {
    status,
    seed,
    checkedAt: checkedAt.toISOString(),
    aircraftModelCode: context.aircraft.modelCode,
    aircraftRuleVersion: context.aircraft.ruleVersion,
    completedRoundTripCount,
    requiredRoundTripCount: context.selectedDeliveryPointIds.length,
    routeMetrics,
    roundTripMetrics,
    evidence: simulationEvidence
  }
}

function locateValidationEvidence(
  evidence: LogisticsRouteCheckEvidence,
  routes: readonly LogisticsRouteInput[],
  routeMetrics: readonly LogisticsRouteMetricView[]
): LogisticsRouteCheckEvidence {
  const route = routes.find((item) => item.id === evidence.routeIds[0])
  const metric = routeMetrics.find((item) => item.routeId === route?.id)
  if (!route || !metric) return evidence
  const segmentIndex = evidence.segmentIndexes[0]
  const segment = segmentIndex === undefined ? null : route.waypoints[segmentIndex]
  const next = segmentIndex === undefined ? null : route.waypoints[segmentIndex + 1]
  const routeStartSeconds = route.direction === "RETURN"
    ? (routeMetrics.find((item) => item.destinationNodeId === route.destinationNodeId && item.direction === "OUTBOUND" && item.role === "PRIMARY")?.flightTimeSeconds ?? 0) + 30
    : 0
  const locatedSegmentIndex = segment && next ? segmentIndex : undefined
  const progress = locatedSegmentIndex === undefined ? 0.5 : segmentMidpointProgress(route, locatedSegmentIndex)
  return {
    ...evidence,
    simulatedAtSeconds: round(routeStartSeconds + metric.flightTimeSeconds * progress, 1),
    data: {
      ...evidence.data,
      routeDirection: route.direction,
      routeDistanceMeters: metric.distanceMeters,
      routeFlightTimeSeconds: metric.flightTimeSeconds,
      ...(segment && next && locatedSegmentIndex !== undefined ? {
        segmentNumber: locatedSegmentIndex + 1,
        segmentAltitudeMeters: segment.segmentAltitudeMeters,
        speedMps: segment.speedMps,
        startAltitudeMeters: segment.altitudeMeters,
        endAltitudeMeters: next.altitudeMeters
      } : {})
    }
  }
}

function segmentMidpointProgress(route: LogisticsRouteInput, segmentIndex: number): number {
  const distances = route.waypoints.slice(0, -1).map((waypoint, index) => distanceMeters(waypoint.position, route.waypoints[index + 1]!.position))
  const total = distances.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return 0
  const completed = distances.slice(0, segmentIndex).reduce((sum, value) => sum + value, 0)
  return Math.min(1, Math.max(0, (completed + (distances[segmentIndex] ?? 0) / 2) / total))
}

function roundTripMilestones(
  outbound: LogisticsRouteInput,
  inbound: LogisticsRouteInput,
  outboundMetric: LogisticsRouteMetricView,
  inboundMetric: LogisticsRouteMetricView,
  remainingBatteryPercent: number
): LogisticsRoundTripMilestoneView[] {
  const outboundCompletedAt = outboundMetric.flightTimeSeconds
  const returnStartedAt = outboundCompletedAt + 30
  const landedAt = returnStartedAt + inboundMetric.flightTimeSeconds
  const arrivalBattery = round(Math.max(0, 100 - outboundMetric.batteryConsumptionPercent), 1)
  const returnMidpointBattery = round(Math.max(remainingBatteryPercent, arrivalBattery - inboundMetric.batteryConsumptionPercent / 2), 1)
  return [
    milestone(1, "AIRPORT_TAKEOFF", 0, outbound.id, outbound.waypoints[0]!.position, 100),
    milestone(2, "OUTBOUND_FLIGHT", outboundCompletedAt / 2, outbound.id, routeProgressPosition(outbound, 0.5), round(100 - outboundMetric.batteryConsumptionPercent / 2, 1)),
    milestone(3, "ARRIVAL_CONFIRMATION", outboundCompletedAt, outbound.id, outbound.waypoints[outbound.waypoints.length - 1]!.position, arrivalBattery),
    milestone(4, "RETURN_FLIGHT", returnStartedAt + inboundMetric.flightTimeSeconds / 2, inbound.id, routeProgressPosition(inbound, 0.5), returnMidpointBattery),
    milestone(5, "AIRPORT_LANDING", landedAt, inbound.id, inbound.waypoints[inbound.waypoints.length - 1]!.position, remainingBatteryPercent)
  ]
}

function milestone(
  sequence: number,
  code: LogisticsRoundTripMilestoneView["code"],
  simulatedAtSeconds: number,
  routeId: string,
  position: V3Coordinate,
  remainingBatteryPercent: number
): LogisticsRoundTripMilestoneView {
  return {
    sequence,
    code,
    simulatedAtSeconds: round(simulatedAtSeconds, 1),
    routeId,
    position: { ...position },
    remainingBatteryPercent: round(remainingBatteryPercent, 1)
  }
}

function routeProgressPosition(route: LogisticsRouteInput, progress: number): V3Coordinate {
  const segments = route.waypoints.slice(0, -1).map((waypoint, index) => ({
    start: waypoint.position,
    end: route.waypoints[index + 1]!.position,
    distance: distanceMeters(waypoint.position, route.waypoints[index + 1]!.position)
  }))
  const totalDistance = segments.reduce((sum, segment) => sum + segment.distance, 0)
  if (totalDistance <= 0) return { ...route.waypoints[0]!.position }
  const targetDistance = totalDistance * Math.min(1, Math.max(0, progress))
  let traversed = 0
  for (const segment of segments) {
    if (traversed + segment.distance >= targetDistance) {
      const segmentProgress = segment.distance <= 0 ? 0 : (targetDistance - traversed) / segment.distance
      return {
        longitude: segment.start.longitude + (segment.end.longitude - segment.start.longitude) * segmentProgress,
        latitude: segment.start.latitude + (segment.end.latitude - segment.start.latitude) * segmentProgress
      }
    }
    traversed += segment.distance
  }
  return { ...route.waypoints[route.waypoints.length - 1]!.position }
}

function validateRouteNodes(
  route: LogisticsRouteInput,
  expectedDeparture: V3LogisticsNode | undefined,
  expectedArrival: V3LogisticsNode | undefined,
  nodeById: Map<string, V3LogisticsNode>,
  evidence: LogisticsRouteCheckEvidence[]
): void {
  if (!expectedDeparture || !expectedArrival || route.departureNodeId !== expectedDeparture.id || route.arrivalNodeId !== expectedArrival.id) {
    addEvidence(evidence, "ROUTE_ENDPOINT_NODE_INVALID", "NODES", "CONFLICT", `${route.name}的起止节点与去返程方向不一致`, [route.id])
  }
  const first = route.waypoints[0]
  const last = route.waypoints[route.waypoints.length - 1]
  if (!first || !last) return
  if (expectedDeparture?.position && distanceMeters(first.position, expectedDeparture.position) > 20) {
    addEvidence(evidence, "DEPARTURE_POSITION_MISMATCH", "NODES", "CONFLICT", `${route.name}未从规定节点起飞`, [route.id], [first.id], [0], first.position)
  }
  if (expectedArrival?.position && distanceMeters(last.position, expectedArrival.position) > 20) {
    addEvidence(evidence, "ARRIVAL_POSITION_MISMATCH", "NODES", "CONFLICT", `${route.name}未到达规定节点`, [route.id], [last.id], [Math.max(0, route.waypoints.length - 2)], last.position)
  }
  validateRunningNodeReferences(route, route.waitingNodeIds, "WAITING_POINT", "等待点", "WAITING_NODE_TYPE_INVALID", nodeById, evidence)
  validateRunningNodeReferences(route, route.alternateLandingNodeIds, "ALTERNATE_LANDING_POINT", "备降点", "ALTERNATE_NODE_TYPE_INVALID", nodeById, evidence)
  validateRunningNodeReferences(route, route.emergencyAreaNodeIds, "EMERGENCY_AREA", "应急运行区域", "EMERGENCY_AREA_TYPE_INVALID", nodeById, evidence)
}

function validateRunningNodeReferences(
  route: LogisticsRouteInput,
  nodeIds: readonly string[],
  expectedType: V3LogisticsNode["type"],
  label: string,
  invalidTypeCode: string,
  nodeById: ReadonlyMap<string, V3LogisticsNode>,
  evidence: LogisticsRouteCheckEvidence[]
): void {
  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId)
    if (!node?.enabled) {
      addEvidence(evidence, "RUNNING_NODE_UNAVAILABLE", "NODES", "CONFLICT", `${route.name}引用了不可用${label}`, [route.id], [], [], null, { nodeId, expectedType })
    } else if (node.type !== expectedType) {
      addEvidence(evidence, invalidTypeCode, "NODES", "CONFLICT", `${route.name}的${label}类型不正确`, [route.id], [], [], null, { nodeId, expectedType, actualType: node.type })
    }
  }
}

function validateRouteGeometry(route: LogisticsRouteInput, context: LogisticsRouteRuleContext, evidence: LogisticsRouteCheckEvidence[]): void {
  for (let index = 0; index < route.waypoints.length; index += 1) {
    const waypoint = route.waypoints[index]!
    if (!pointInPolygon(waypoint.position, context.region.boundary)) {
      addEvidence(evidence, "WAYPOINT_OUTSIDE_REGION", "SPATIAL", "CONFLICT", `${route.name}的航点 ${waypoint.name} 超出项目区域`, [route.id], [waypoint.id], [Math.max(0, index - 1)], waypoint.position)
    }
    const endpoint = index === 0 || index === route.waypoints.length - 1
    if ((!endpoint && waypoint.altitudeMeters < 20) || waypoint.altitudeMeters > context.aircraft.maximumHeightMeters) {
      addEvidence(evidence, "WAYPOINT_HEIGHT_INVALID", "AIRCRAFT", "CONFLICT", `${route.name}的航点 ${waypoint.name} 高度超出统一机型范围`, [route.id], [waypoint.id], [Math.max(0, index - 1)], waypoint.position, { altitudeMeters: waypoint.altitudeMeters })
    }
    if (waypoint.speedMps <= 0 || waypoint.speedMps > context.aircraft.maximumSpeedMps) {
      addEvidence(evidence, "WAYPOINT_SPEED_INVALID", "AIRCRAFT", "CONFLICT", `${route.name}的航点 ${waypoint.name} 速度超出统一机型范围`, [route.id], [waypoint.id], [Math.max(0, index - 1)], waypoint.position, { speedMps: waypoint.speedMps })
    }
    if (index === route.waypoints.length - 1) continue
    const next = route.waypoints[index + 1]!
    const segmentAltitude = waypoint.segmentAltitudeMeters
    if (segmentAltitude < 20 || segmentAltitude > context.aircraft.maximumHeightMeters) {
      addEvidence(evidence, "SEGMENT_HEIGHT_INVALID", "AIRCRAFT", "CONFLICT", `${route.name}第 ${index + 1} 航段高度超出统一机型范围`, [route.id], [waypoint.id, next.id], [index], midpoint(waypoint.position, next.position), { segmentAltitudeMeters: segmentAltitude })
    } else if (segmentAltitude > context.aircraft.maximumHeightMeters - 10) {
      addEvidence(evidence, "SEGMENT_HEIGHT_MARGIN_LOW", "AIRCRAFT", "RISK", `${route.name}第 ${index + 1} 航段接近统一机型高度上限`, [route.id], [waypoint.id, next.id], [index], midpoint(waypoint.position, next.position), {
        segmentAltitudeMeters: segmentAltitude,
        maximumHeightMeters: context.aircraft.maximumHeightMeters,
        heightMarginMeters: round(context.aircraft.maximumHeightMeters - segmentAltitude, 1)
      })
    }
  }
  for (const relation of inspectLogisticsRouteSpatialRelations(route, context.region)) {
    const data = {
      featureId: relation.featureId,
      featureName: relation.featureName,
      featureKind: relation.featureKind,
      horizontalRelation: relation.horizontalRelation,
      horizontalDistanceMeters: relation.horizontalDistanceMeters,
      protectionRadiusMeters: relation.protectionRadiusMeters,
      segmentAltitudeMeters: relation.segmentAltitudeMeters,
      ...(relation.featureHeightMeters === null ? {} : { featureHeightMeters: relation.featureHeightMeters }),
      ...(relation.verticalClearanceMeters === null ? {} : { clearanceMeters: relation.verticalClearanceMeters })
    }
    if (relation.featureKind === "RESTRICTION") {
      addEvidence(evidence, "RESTRICTED_AREA_CROSSING", "SPATIAL", "CONFLICT", `${route.name}第 ${relation.segmentIndex + 1} 航段${relation.message}`, [route.id], [...relation.waypointIds], [relation.segmentIndex], relation.position, data)
      continue
    }
    if (relation.status === "CLEAR") continue
    const prefix = relation.featureKind === "OBSTACLE" ? "OBSTACLE" : "BUILDING"
    const severity = relation.status === "CONFLICT" ? "CONFLICT" : "RISK"
    const suffix = relation.verticalClearanceMeters === null ? "HEIGHT_UNKNOWN" : relation.status === "CONFLICT" ? "CLEARANCE_CONFLICT" : "CLEARANCE_RISK"
    addEvidence(evidence, `${prefix}_${suffix}`, "SPATIAL", severity, `${route.name}第 ${relation.segmentIndex + 1} 航段${relation.message}`, [route.id], [...relation.waypointIds], [relation.segmentIndex], relation.position, data)
  }
}

function validateCoverage(route: LogisticsRouteInput, region: V3RegionCatalogItem, evidence: LogisticsRouteCheckEvidence[]): void {
  const communicationFeatures = region.layers.flatMap((layer) => layer.code === "COMMUNICATION" ? layer.features : []).filter((feature) => feature.geometryType === "POINT" && feature.position)
  const communicationLayer = region.layers.find((layer) => layer.code === "COMMUNICATION")
  const positioningLayer = region.layers.find((layer) => layer.code === "POSITIONING")
  if (communicationFeatures.length > 0) {
    route.waypoints.forEach((waypoint, index) => {
      const covered = communicationFeatures.some((feature) => {
        const coverageMeters = typeof feature.properties.coverageMeters === "number" ? feature.properties.coverageMeters : 1_200
        return feature.position ? distanceMeters(waypoint.position, feature.position) <= coverageMeters : false
      })
      if (!covered) addEvidence(evidence, "COMMUNICATION_COVERAGE_MISSING", "COVERAGE", "CONFLICT", `${route.name}的航点 ${waypoint.name} 不在必要通信覆盖内`, [route.id], [waypoint.id], [Math.max(0, index - 1)], waypoint.position)
    })
  }
  if (communicationLayer?.state === "DEGRADED") addEvidence(evidence, "COMMUNICATION_MARGIN_LOW", "COVERAGE", "RISK", `${route.name}所在区域通信覆盖处于弱化状态`, [route.id])
  if (positioningLayer?.state === "DEGRADED") addEvidence(evidence, "POSITIONING_MARGIN_LOW", "COVERAGE", "RISK", `${route.name}所在区域定位覆盖处于弱化状态`, [route.id])
}

function validateEfficiency(route: LogisticsRouteInput, nodeById: Map<string, V3LogisticsNode>, evidence: LogisticsRouteCheckEvidence[]): void {
  const departure = nodeById.get(route.departureNodeId)?.position
  const arrival = nodeById.get(route.arrivalNodeId)?.position
  if (!departure || !arrival) return
  const direct = distanceMeters(departure, arrival)
  const planned = routeDistance(route)
  if (direct > 50 && planned / direct > 1.8) {
    addEvidence(evidence, "ROUTE_DETOUR_HIGH", "EFFICIENCY", "INFO", `${route.name}绕行系数为 ${(planned / direct).toFixed(2)}，可在复盘中比较优化`, [route.id], [], [], null, { detourRatio: round(planned / direct, 2) })
  }
  if (route.waypoints.length > 14) addEvidence(evidence, "WAYPOINT_DENSITY_HIGH", "EFFICIENCY", "INFO", `${route.name}航点较密，建议复盘转折必要性`, [route.id])
}

function validateRoundTripCapability(
  routes: readonly LogisticsRouteInput[],
  deliveryNodes: readonly V3LogisticsNode[],
  aircraft: LogisticsAircraftCapabilityView,
  evidence: LogisticsRouteCheckEvidence[]
): void {
  for (const delivery of deliveryNodes) {
    const pair = routes.filter((route) => route.destinationNodeId === delivery.id && route.role === "PRIMARY")
    const distance = pair.reduce((sum, route) => sum + routeDistance(route), 0)
    if (pair.length === 2 && distance > aircraft.maximumRoundTripMeters) {
      addEvidence(evidence, "AIRCRAFT_RANGE_EXCEEDED", "AIRCRAFT", "CONFLICT", `${delivery.name}往返航程 ${distance.toFixed(0)} 米超过统一机型能力`, pair.map((route) => route.id), [], [], null, { distanceMeters: round(distance, 1) })
    } else if (pair.length === 2 && distance > aircraft.maximumRoundTripMeters * 0.82) {
      addEvidence(evidence, "AIRCRAFT_RANGE_MARGIN_LOW", "AIRCRAFT", "RISK", `${delivery.name}往返航程接近统一机型限制`, pair.map((route) => route.id), [], [], null, { distanceMeters: round(distance, 1) })
    }
  }
}

function validateRouteRelationships(routes: readonly LogisticsRouteInput[], evidence: LogisticsRouteCheckEvidence[]): void {
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const left = routes[leftIndex]!
      const right = routes[rightIndex]!
      if (left.destinationNodeId === right.destinationNodeId && left.direction !== right.direction) continue
      let crossingCount = 0
      for (let leftSegment = 0; leftSegment < left.waypoints.length - 1; leftSegment += 1) {
        for (let rightSegment = 0; rightSegment < right.waypoints.length - 1; rightSegment += 1) {
          if (segmentsIntersect(left.waypoints[leftSegment]!.position, left.waypoints[leftSegment + 1]!.position, right.waypoints[rightSegment]!.position, right.waypoints[rightSegment + 1]!.position)) crossingCount += 1
        }
      }
      if (crossingCount > 0) addEvidence(evidence, "MULTI_ROUTE_CROSSING", "ROUTE_RELATION", "RISK", `${left.name}与${right.name}存在 ${crossingCount} 处空间交叉，调度阶段需设置时间隔离`, [left.id, right.id], [], [], null, { crossingCount })
    }
  }
}

function routeMetric(route: LogisticsRouteInput, region: V3RegionCatalogItem, aircraft: LogisticsAircraftCapabilityView, seed: string): LogisticsRouteMetricView {
  const distance = routeDistance(route)
  const averageSpeed = route.waypoints.slice(0, -1).reduce((sum, waypoint) => sum + waypoint.speedMps, 0) / Math.max(1, route.waypoints.length - 1)
  const flightTimeSeconds = distance / Math.max(1, averageSpeed || aircraft.cruiseSpeedMps) + climbTime(route, aircraft.climbRateMps)
  const batteryConsumptionPercent = 3 + distance / aircraft.maximumRoundTripMeters * (100 - aircraft.minimumReserveBatteryPercent)
  return {
    routeId: route.id,
    routeName: route.name,
    destinationNodeId: route.destinationNodeId,
    direction: route.direction,
    role: route.role,
    distanceMeters: round(distance, 1),
    flightTimeSeconds: round(flightTimeSeconds, 1),
    batteryConsumptionPercent: round(batteryConsumptionPercent, 1),
    remainingBatteryPercent: round(Math.max(0, 100 - batteryConsumptionPercent), 1),
    maximumAltitudeMeters: Math.max(...route.waypoints.map((waypoint) => waypoint.altitudeMeters), 0),
    minimumCoveragePercent: round(coveragePercent(route, region), 1),
    maximumTrackDeviationMeters: round(1.2 + deterministicUnit(`${seed}:${route.id}`) * 3.8, 1)
  }
}

function coveragePercent(route: LogisticsRouteInput, region: V3RegionCatalogItem): number {
  const features = region.layers.flatMap((layer) => layer.code === "COMMUNICATION" ? layer.features : []).filter((feature) => feature.geometryType === "POINT" && feature.position)
  if (features.length === 0) return 100
  const covered = route.waypoints.filter((waypoint) => features.some((feature) => feature.position && distanceMeters(waypoint.position, feature.position) <= (typeof feature.properties.coverageMeters === "number" ? feature.properties.coverageMeters : 1_200))).length
  return covered / Math.max(1, route.waypoints.length) * 100
}

function climbTime(route: LogisticsRouteInput, climbRateMps: number): number {
  let verticalMeters = 0
  for (let index = 1; index < route.waypoints.length; index += 1) verticalMeters += Math.abs(route.waypoints[index]!.altitudeMeters - route.waypoints[index - 1]!.altitudeMeters)
  return verticalMeters / Math.max(0.5, climbRateMps)
}

function routeDistance(route: LogisticsRouteInput): number {
  let total = 0
  for (let index = 0; index < route.waypoints.length - 1; index += 1) total += distanceMeters(route.waypoints[index]!.position, route.waypoints[index + 1]!.position)
  return total
}

function findNode(region: V3RegionCatalogItem, type: V3LogisticsNode["type"]): V3LogisticsNode | undefined {
  return region.logisticsNodes?.find((node) => node.type === type && node.enabled)
}

function addEvidence(
  target: LogisticsRouteCheckEvidence[],
  code: string,
  category: LogisticsRouteCheckCategory,
  severity: LogisticsRouteCheckEvidence["severity"],
  message: string,
  routeIds: string[] = [],
  waypointIds: string[] = [],
  segmentIndexes: number[] = [],
  position: V3Coordinate | null = null,
  data: Record<string, string | number | boolean> = {}
): void {
  const key = `${code}:${routeIds.join(",")}:${waypointIds.join(",")}:${segmentIndexes.join(",")}`
  if (target.some((item) => `${item.code}:${item.routeIds.join(",")}:${item.waypointIds.join(",")}:${item.segmentIndexes.join(",")}` === key)) return
  target.push({ code, category, severity, blocking: severity === "CONFLICT", message, routeIds, waypointIds, segmentIndexes, position, data })
}

function distanceMeters(left: V3Coordinate, right: V3Coordinate): number {
  const latitude1 = radians(left.latitude)
  const latitude2 = radians(right.latitude)
  const deltaLatitude = latitude2 - latitude1
  const deltaLongitude = radians(right.longitude - left.longitude)
  const haversine = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine))
}

function pointInPolygon(point: V3Coordinate, polygon: readonly V3Coordinate[]): boolean {
  let inside = false
  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const currentPoint = polygon[current]!
    const previousPoint = polygon[previous]!
    const intersects = currentPoint.latitude > point.latitude !== previousPoint.latitude > point.latitude
      && point.longitude < (previousPoint.longitude - currentPoint.longitude) * (point.latitude - currentPoint.latitude) / (previousPoint.latitude - currentPoint.latitude || Number.EPSILON) + currentPoint.longitude
    if (intersects) inside = !inside
  }
  return inside
}

function segmentIntersectsPolygon(start: V3Coordinate, end: V3Coordinate, polygon: readonly V3Coordinate[]): boolean {
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
}

function midpoint(left: V3Coordinate, right: V3Coordinate): V3Coordinate {
  return { longitude: (left.longitude + right.longitude) / 2, latitude: (left.latitude + right.latitude) / 2 }
}

function deterministicUnit(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return (hash >>> 0) / 4_294_967_295
}

function radians(value: number): number {
  return value * Math.PI / 180
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
