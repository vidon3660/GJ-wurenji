import type {
  GeneratedLogisticsOrder,
  LogisticsAircraftInstanceView,
  LogisticsOrderGenerationConfig,
  LogisticsSchedulingOrderView,
  LogisticsScheduleCheckCategory,
  LogisticsScheduleCheckEvidence,
  LogisticsScheduleCheckResult,
  LogisticsScheduleItemInput,
  LogisticsScheduleItemView,
  LogisticsSchedulingRouteView
} from "@wurenji/shared"

export const logisticsOrderGeneratorVersion = "LOGISTICS-ORDER-1.3.0"

export interface LogisticsScheduleRuleContext {
  orders: readonly LogisticsSchedulingOrderView[]
  aircraft: readonly LogisticsAircraftInstanceView[]
  routes: readonly LogisticsSchedulingRouteView[]
  strictSerialOperation: boolean
  turnaroundTimeMs?: number
  deliveryServiceTimeMs?: number
}

export function generateLogisticsOrders(
  config: LogisticsOrderGenerationConfig,
  destinationNodeIds: readonly string[]
): GeneratedLogisticsOrder[] {
  if (destinationNodeIds.length === 0) throw new Error("订单生成至少需要一个配送点")
  const destinations = deterministicShuffle([...new Set(destinationNodeIds)], `${config.seed}:destinations`)
  const orders = Array.from({ length: config.orderCount }, (_, index) => {
    const releaseTimeMs = releaseTime(config, index)
    const priority = priorityFor(config, index)
    const earliestStartTimeMs = releaseTimeMs + (priority === "NORMAL" ? 180_000 : priority === "PRIORITY" ? 60_000 : 0)
    const windowScale = timeWindowScale(config, index, priority)
    return {
      code: `ORD-${String(index + 1).padStart(3, "0")}`,
      destinationNodeId: destinationFor(config, destinations, index),
      releaseTimeMs,
      priority,
      earliestStartTimeMs,
      latestArrivalTimeMs: earliestStartTimeMs + Math.round(config.timeWindowMinutes * 60_000 * windowScale)
    } satisfies GeneratedLogisticsOrder
  })
  return orders.sort((left, right) => left.releaseTimeMs - right.releaseTimeMs || priorityRank(right.priority) - priorityRank(left.priority) || left.code.localeCompare(right.code))
}

function timeWindowScale(config: LogisticsOrderGenerationConfig, index: number, priority: GeneratedLogisticsOrder["priority"]): number {
  const profileScale = config.timeWindowProfile === "MIXED" ? [0.55, 1, 1.6][index % 3]! : 1
  const priorityScale = priority === "URGENT" ? 0.6 : priority === "PRIORITY" ? 0.8 : 1
  return profileScale * priorityScale
}

function destinationFor(
  config: LogisticsOrderGenerationConfig,
  destinations: readonly string[],
  index: number
): string {
  if (destinations.length === 1 || config.deliveryDistributionMode === "UNIFORM") {
    return destinations[index % destinations.length]!
  }
  if (config.deliveryDistributionMode === "FOCUSED") {
    const focusedCount = Math.ceil(config.orderCount * 0.65)
    if (index < focusedCount) return destinations[0]!
    return destinations[1 + ((index - focusedCount) % (destinations.length - 1))]!
  }
  const peakCount = Math.min(destinations.length, Math.max(2, Math.ceil(destinations.length / 3)))
  const peakOrders = Math.ceil(config.orderCount * 0.8)
  if (index < peakOrders || peakCount === destinations.length) return destinations[index % peakCount]!
  return destinations[peakCount + ((index - peakOrders) % (destinations.length - peakCount))]!
}

export function checkLogisticsSchedule(
  input: readonly LogisticsScheduleItemInput[],
  context: LogisticsScheduleRuleContext,
  checkedAt = new Date().toISOString()
): LogisticsScheduleCheckResult {
  const evidence: LogisticsScheduleCheckEvidence[] = []
  const itemIds = new Set<string>()
  const orderMap = new Map(context.orders.map((order) => [order.id, order]))
  const aircraftMap = new Map(context.aircraft.map((aircraft) => [aircraft.id, aircraft]))
  const routeMap = new Map(context.routes.map((route) => [route.id, route]))
  const computed: LogisticsScheduleItemView[] = []

  for (const item of input) {
    if (itemIds.has(item.id)) addEvidence(evidence, "DUPLICATE_ITEM_ID", "COMPLETENESS", "CONFLICT", "调度项标识重复", [], [], [item.id])
    itemIds.add(item.id)
    const order = orderMap.get(item.orderId)
    const aircraft = aircraftMap.get(item.aircraftId)
    const outbound = routeMap.get(item.outboundRouteId)
    const inbound = routeMap.get(item.returnRouteId)
    if (!order) addEvidence(evidence, "ORDER_NOT_FOUND", "ORDER", "CONFLICT", "调度项引用的订单不存在", [item.orderId], [], [item.id])
    if (!aircraft) addEvidence(evidence, "AIRCRAFT_NOT_FOUND", "AIRCRAFT", "CONFLICT", "调度项引用的无人机不存在", [], [item.aircraftId], [item.id])
    if (!outbound || !inbound) addEvidence(evidence, "ROUTE_NOT_FOUND", "ROUTE", "CONFLICT", "调度项必须引用已提交的去程和返程航线", order ? [order.id] : [], aircraft ? [aircraft.id] : [], [item.id], [item.outboundRouteId, item.returnRouteId])
    if (!order || !aircraft || !outbound || !inbound) continue

    if (outbound.route.direction !== "OUTBOUND" || inbound.route.direction !== "RETURN") {
      addEvidence(evidence, "ROUTE_DIRECTION_INVALID", "ROUTE", "CONFLICT", "去程或返程航线方向不正确", [order.id], [aircraft.id], [item.id], [outbound.id, inbound.id])
    }
    if (outbound.route.destinationNodeId !== order.destinationNodeId || inbound.route.destinationNodeId !== order.destinationNodeId) {
      addEvidence(evidence, "ROUTE_DESTINATION_MISMATCH", "ROUTE", "CONFLICT", "航线目的地与订单配送点不一致", [order.id], [aircraft.id], [item.id], [outbound.id, inbound.id])
    }
    if (!Number.isInteger(item.plannedTakeoffTimeMs) || item.plannedTakeoffTimeMs < 0 || item.plannedTakeoffTimeMs > 86_400_000) {
      addEvidence(evidence, "TAKEOFF_TIME_INVALID", "TIME", "CONFLICT", "计划起飞时刻必须位于任务日内", [order.id], [aircraft.id], [item.id])
      continue
    }

    const deliveryServiceTimeMs = context.deliveryServiceTimeMs ?? 60_000
    const turnaroundTimeMs = context.turnaroundTimeMs ?? 120_000
    const arrivalTimeMs = item.plannedTakeoffTimeMs + outbound.flightTimeMs
    const returnStartTimeMs = arrivalTimeMs + deliveryServiceTimeMs
    const landingTimeMs = returnStartTimeMs + inbound.flightTimeMs
    const nextAvailableTimeMs = landingTimeMs + turnaroundTimeMs
    const batteryAfterMissionPercent = round(aircraft.initialBatteryPercent - outbound.batteryConsumptionPercent - inbound.batteryConsumptionPercent, 1)
    computed.push({
      ...item,
      orderCode: order.code,
      aircraftCode: aircraft.code,
      destinationNodeId: order.destinationNodeId,
      arrivalTimeMs,
      returnStartTimeMs,
      landingTimeMs,
      nextAvailableTimeMs,
      batteryAfterMissionPercent
    })

    if (item.plannedTakeoffTimeMs < order.earliestStartTimeMs) addEvidence(evidence, "BEFORE_EARLIEST_START", "TIME", "CONFLICT", "计划起飞早于订单最早可执行时刻", [order.id], [aircraft.id], [item.id], [], [item.plannedTakeoffTimeMs, order.earliestStartTimeMs])
    if (arrivalTimeMs > order.latestArrivalTimeMs) addEvidence(evidence, "LATEST_ARRIVAL_RISK", "TIME", "RISK", "预计到达晚于订单最迟送达时刻", [order.id], [aircraft.id], [item.id], [], [order.latestArrivalTimeMs, arrivalTimeMs], { delayMinutes: round((arrivalTimeMs - order.latestArrivalTimeMs) / 60_000, 1) })
    if (aircraft.status === "UNAVAILABLE") addEvidence(evidence, "AIRCRAFT_UNAVAILABLE", "AIRCRAFT", "CONFLICT", "无人机初始状态不可用或存在飞前异常", [order.id], [aircraft.id], [item.id])
    if (item.plannedTakeoffTimeMs < aircraft.availableAtMs) addEvidence(evidence, "AIRCRAFT_NOT_YET_AVAILABLE", "AIRCRAFT", "CONFLICT", "计划起飞早于无人机可用时刻", [order.id], [aircraft.id], [item.id], [], [item.plannedTakeoffTimeMs, aircraft.availableAtMs])
    if (batteryAfterMissionPercent < 20) addEvidence(evidence, "BATTERY_RESERVE_INSUFFICIENT", "AIRCRAFT", "CONFLICT", "任务完成后的预计电量低于安全余量", [order.id], [aircraft.id], [item.id], [], null, { batteryAfterMissionPercent })
  }

  const orderAssignments = groupBy(computed, (item) => item.orderId)
  for (const order of context.orders) {
    const assigned = orderAssignments.get(order.id) ?? []
    if (assigned.length === 0) addEvidence(evidence, "ORDER_UNASSIGNED", "COMPLETENESS", "CONFLICT", "存在尚未分配的订单", [order.id])
    if (assigned.length > 1) addEvidence(evidence, "ORDER_DUPLICATE_ASSIGNMENT", "ORDER", "CONFLICT", "同一订单被重复分配", [order.id], [...new Set(assigned.map((item) => item.aircraftId))], assigned.map((item) => item.id))
  }

  for (const [aircraftId, missions] of groupBy(computed, (item) => item.aircraftId)) {
    const ordered = [...missions].sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]!
      const current = ordered[index]!
      if (current.plannedTakeoffTimeMs < previous.nextAvailableTimeMs) addEvidence(evidence, "AIRCRAFT_TASK_OVERLAP", "AIRCRAFT", "CONFLICT", "同一无人机的任务时间重叠", [previous.orderId, current.orderId], [aircraftId], [previous.id, current.id], [], [current.plannedTakeoffTimeMs, previous.nextAvailableTimeMs])
      else if (current.plannedTakeoffTimeMs - previous.nextAvailableTimeMs > 15 * 60_000) addEvidence(evidence, "AIRCRAFT_IDLE_GAP", "EFFICIENCY", "INFO", "无人机任务间存在较长空闲时间", [previous.orderId, current.orderId], [aircraftId], [previous.id, current.id], [], [previous.nextAvailableTimeMs, current.plannedTakeoffTimeMs])
    }
  }

  const chronological = [...computed].sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)
  for (let leftIndex = 0; leftIndex < chronological.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < chronological.length; rightIndex += 1) {
      const left = chronological[leftIndex]!
      const right = chronological[rightIndex]!
      if (left.aircraftId === right.aircraftId || right.plannedTakeoffTimeMs >= left.landingTimeMs) continue
      if (context.strictSerialOperation) {
        addEvidence(evidence, "STRICT_SERIAL_VIOLATION", "TRAFFIC", "CONFLICT", "当前模板要求任一时刻仅允许一架无人机在空中", [left.orderId, right.orderId], [left.aircraftId, right.aircraftId], [left.id, right.id], [], [right.plannedTakeoffTimeMs, Math.min(left.landingTimeMs, right.landingTimeMs)])
        continue
      }
      const sharedRoutes = [left.outboundRouteId, left.returnRouteId].filter((routeId) => routeId === right.outboundRouteId || routeId === right.returnRouteId)
      if (sharedRoutes.length > 0) addEvidence(evidence, "SHARED_ROUTE_CONFLICT", "TRAFFIC", "CONFLICT", "多架无人机在重叠时段使用同一航线", [left.orderId, right.orderId], [left.aircraftId, right.aircraftId], [left.id, right.id], sharedRoutes, [right.plannedTakeoffTimeMs, Math.min(left.landingTimeMs, right.landingTimeMs)])
      else if (routesCross(left, right, routeMap)) addEvidence(evidence, "CROSSING_ROUTE_RISK", "TRAFFIC", "RISK", "并行任务航线存在空间交叉，请核查时间隔离", [left.orderId, right.orderId], [left.aircraftId, right.aircraftId], [left.id, right.id], [left.outboundRouteId, left.returnRouteId, right.outboundRouteId, right.returnRouteId], [right.plannedTakeoffTimeMs, Math.min(left.landingTimeMs, right.landingTimeMs)])
    }
  }

  const taskCounts = [...groupBy(computed, (item) => item.aircraftId).values()].map((items) => items.length)
  if (taskCounts.length > 1 && Math.max(...taskCounts) - Math.min(...taskCounts) > 2) addEvidence(evidence, "AIRCRAFT_LOAD_IMBALANCE", "EFFICIENCY", "INFO", "无人机任务数量分配不均衡", [], [], [], [], null, { minimumTasks: Math.min(...taskCounts), maximumTasks: Math.max(...taskCounts) })

  const conflictCount = evidence.filter((item) => item.severity === "CONFLICT").length
  const riskCount = evidence.filter((item) => item.severity === "RISK").length
  const infoCount = evidence.filter((item) => item.severity === "INFO").length
  return {
    status: conflictCount > 0 ? "HARD_CONFLICT" : riskCount > 0 ? "WITH_RISK" : "PASSED",
    submittable: conflictCount === 0 && computed.length === context.orders.length,
    checkedAt,
    orderCount: context.orders.length,
    assignedOrderCount: new Set(computed.map((item) => item.orderId)).size,
    scheduledAircraftCount: new Set(computed.map((item) => item.aircraftId)).size,
    conflictCount,
    riskCount,
    infoCount,
    items: computed.sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs),
    evidence
  }
}

function releaseTime(config: LogisticsOrderGenerationConfig, index: number): number {
  if (config.releaseMode === "BATCH") return 0
  if (config.releaseMode === "STAGED") {
    const stageSize = Math.max(1, Math.ceil(config.orderCount / 3))
    return Math.floor(index / stageSize) * 10 * 60_000
  }
  if (config.releaseMode === "AT_PHASE") return releasePhaseOffsetMinutes(config.releasePhase) * 60_000
  if (index < Math.max(1, Math.ceil(config.orderCount * 0.25))) return 0
  return (5 + Math.floor(deterministicUnit(`${config.seed}:release:${index}`) * 86)) * 60_000
}

function releasePhaseOffsetMinutes(phase: LogisticsOrderGenerationConfig["releasePhase"]): number {
  return ({ PREPARATION: 0, WAITING_EXECUTION: 5, TAKEOFF: 10, OUTBOUND: 20, ARRIVAL_CONFIRMATION: 35, RETURNING: 45, LANDING: 55 } as const)[phase ?? "WAITING_EXECUTION"]
}

function priorityFor(config: LogisticsOrderGenerationConfig, index: number): GeneratedLogisticsOrder["priority"] {
  const unit = deterministicUnit(`${config.seed}:priority:${index}`)
  const thresholds = config.priorityProfile === "URGENT_HEAVY"
    ? { urgent: 0.3, priority: 0.72 }
    : config.priorityProfile === "STANDARD_HEAVY"
      ? { urgent: 0.05, priority: 0.2 }
      : { urgent: 0.15, priority: 0.5 }
  return unit < thresholds.urgent ? "URGENT" : unit < thresholds.priority ? "PRIORITY" : "NORMAL"
}

function priorityRank(value: GeneratedLogisticsOrder["priority"]): number {
  return value === "URGENT" ? 3 : value === "PRIORITY" ? 2 : 1
}

function deterministicShuffle<T>(values: T[], seed: string): T[] {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(deterministicUnit(`${seed}:${index}`) * (index + 1))
    ;[values[index], values[target]] = [values[target]!, values[index]!]
  }
  return values
}

function deterministicUnit(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619)
  return (hash >>> 0) / 4_294_967_295
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>()
  for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value])
  return result
}

function routesCross(left: LogisticsScheduleItemView, right: LogisticsScheduleItemView, routeMap: Map<string, LogisticsSchedulingRouteView>): boolean {
  const leftRoutes = [routeMap.get(left.outboundRouteId), routeMap.get(left.returnRouteId)].filter((route): route is LogisticsSchedulingRouteView => Boolean(route))
  const rightRoutes = [routeMap.get(right.outboundRouteId), routeMap.get(right.returnRouteId)].filter((route): route is LogisticsSchedulingRouteView => Boolean(route))
  return leftRoutes.some((leftRoute) => rightRoutes.some((rightRoute) => polylinesIntersect(leftRoute.route.waypoints, rightRoute.route.waypoints)))
}

function polylinesIntersect(left: LogisticsSchedulingRouteView["route"]["waypoints"], right: LogisticsSchedulingRouteView["route"]["waypoints"]): boolean {
  for (let leftIndex = 0; leftIndex < left.length - 1; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length - 1; rightIndex += 1) {
      if (segmentsIntersect(left[leftIndex]!.position, left[leftIndex + 1]!.position, right[rightIndex]!.position, right[rightIndex + 1]!.position)) return true
    }
  }
  return false
}

function segmentsIntersect(a: { longitude: number; latitude: number }, b: { longitude: number; latitude: number }, c: { longitude: number; latitude: number }, d: { longitude: number; latitude: number }): boolean {
  if (samePoint(a, c) || samePoint(a, d) || samePoint(b, c) || samePoint(b, d)) return false
  const orientation = (left: typeof a, middle: typeof a, right: typeof a) => (middle.latitude - left.latitude) * (right.longitude - middle.longitude) - (middle.longitude - left.longitude) * (right.latitude - middle.latitude)
  const first = orientation(a, b, c)
  const second = orientation(a, b, d)
  const third = orientation(c, d, a)
  const fourth = orientation(c, d, b)
  return (first > 0) !== (second > 0) && (third > 0) !== (fourth > 0)
}

function samePoint(left: { longitude: number; latitude: number }, right: { longitude: number; latitude: number }): boolean {
  return Math.abs(left.longitude - right.longitude) < 1e-9 && Math.abs(left.latitude - right.latitude) < 1e-9
}

function addEvidence(
  target: LogisticsScheduleCheckEvidence[],
  code: string,
  category: LogisticsScheduleCheckCategory,
  severity: LogisticsScheduleCheckEvidence["severity"],
  message: string,
  orderIds: string[] = [],
  aircraftIds: string[] = [],
  scheduleItemIds: string[] = [],
  routeIds: string[] = [],
  timeRangeMs: [number, number] | null = null,
  data: Record<string, string | number | boolean> = {}
): void {
  const key = `${code}:${orderIds.join(",")}:${aircraftIds.join(",")}:${scheduleItemIds.join(",")}:${routeIds.join(",")}`
  if (target.some((item) => `${item.code}:${item.orderIds.join(",")}:${item.aircraftIds.join(",")}:${item.scheduleItemIds.join(",")}:${item.routeIds.join(",")}` === key)) return
  target.push({ code, category, severity, blocking: severity === "CONFLICT", message, orderIds, aircraftIds, scheduleItemIds, routeIds, timeRangeMs, data })
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
