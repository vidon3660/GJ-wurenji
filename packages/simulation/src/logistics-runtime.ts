import type {
  LogisticsAircraftInstanceView,
  LogisticsInitialEnvironmentConfig,
  LogisticsRuntimeActionCode,
  LogisticsRuntimeAircraftStatus,
  LogisticsRuntimeAircraftView,
  LogisticsRuntimeAvailableActionView,
  LogisticsRuntimeEnvironmentView,
  LogisticsRuntimeEventCategory,
  LogisticsRuntimeOrderStatus,
  LogisticsRuntimeOrderView,
  LogisticsSchedulingOrderPriority,
  LogisticsRuntimeRouteStatus,
  LogisticsRuntimeRouteView,
  LogisticsRuntimeSummaryView,
  LogisticsRuntimeTaskStatus,
  LogisticsRuntimeTaskView,
  LogisticsScheduleItemView,
  LogisticsSchedulingOrderView,
  LogisticsSchedulingRouteView,
  V3AlertSeverity,
  V3Coordinate
} from "@wurenji/shared"

export interface LogisticsRuntimeEventImpact {
  eventId: string
  category: LogisticsRuntimeEventCategory
  severity: V3AlertSeverity
  affectedAircraftIds: string[]
  affectedOrderIds: string[]
  affectedRouteIds: string[]
}

export interface LogisticsRuntimeControlState {
  aircraftStatusOverrides: Record<string, LogisticsRuntimeAircraftStatus>
  aircraftPositionOverrides: Record<string, V3Coordinate>
  diversionPlans: Record<string, LogisticsRuntimeDiversionPlan>
  returnPlans: Record<string, LogisticsRuntimeReturnPlan>
  resumePlans: Record<string, LogisticsRuntimeResumePlan>
  holdStartedAtMs: Record<string, number>
  orderStatusOverrides: Record<string, LogisticsRuntimeOrderStatus>
  routeStatusOverrides: Record<string, LogisticsRuntimeRouteStatus>
  taskStatusOverrides: Record<string, LogisticsRuntimeTaskStatus>
  taskAircraftOverrides: Record<string, string>
  orderPriorityOverrides: Record<string, LogisticsSchedulingOrderPriority>
  taskSpeedFactorOverrides: Record<string, number>
  activeRouteOverrides: Record<string, string>
  delayOffsetsMs: Record<string, number>
  eventImpacts: LogisticsRuntimeEventImpact[]
}

export interface LogisticsRuntimeDiversionPlan {
  aircraftId: string
  taskId: string
  startSimulationTimeMs: number
  endSimulationTimeMs: number
  startPosition: V3Coordinate
  landingPosition: V3Coordinate
  landingNodeId: string
}

export interface LogisticsRuntimeReturnPlan {
  aircraftId: string
  taskId: string
  startSimulationTimeMs: number
  endSimulationTimeMs: number
  routePoints: V3Coordinate[]
}

export interface LogisticsRuntimeResumePlan {
  aircraftId: string
  taskId: string
  startSimulationTimeMs: number
  endSimulationTimeMs: number
  routePoints: V3Coordinate[]
}

export interface LogisticsRuntimeEngineInput {
  simulationTimeMs: number
  sessionStatus: string
  totalAircraft: number
  orders: LogisticsSchedulingOrderView[]
  aircraft: LogisticsAircraftInstanceView[]
  routes: LogisticsSchedulingRouteView[]
  scheduleItems: LogisticsScheduleItemView[]
  initialEnvironment?: LogisticsInitialEnvironmentConfig
  control?: Partial<LogisticsRuntimeControlState>
}

export interface LogisticsRuntimeProjection {
  durationMs: number
  tasks: LogisticsRuntimeTaskView[]
  aircraft: LogisticsRuntimeAircraftView[]
  orders: LogisticsRuntimeOrderView[]
  routes: LogisticsRuntimeRouteView[]
  summary: LogisticsRuntimeSummaryView
  environment: LogisticsRuntimeEnvironmentView
  availableActions: LogisticsRuntimeAvailableActionView[]
}

const actionDefinitions: Array<[
  LogisticsRuntimeActionCode,
  string,
  LogisticsRuntimeAvailableActionView["targetType"],
  boolean,
  number
]> = [
  ["ACKNOWLEDGE_ALERT", "确认告警", "ALERT", true, 1],
  ["CONTINUE_MONITORING", "继续监控", "GLOBAL", false, 1],
  ["REDUCE_SPEED", "降低速度", "AIRCRAFT", true, 1],
  ["MAINTAIN_ROUTE", "保持当前航线", "AIRCRAFT", true, 1],
  ["HOLD_POSITION", "悬停等待", "AIRCRAFT", true, 1],
  ["PROCEED_TO_WAITING_POINT", "前往等待点", "AIRCRAFT", true, 1],
  ["RETURN_AIRCRAFT", "无人机返航", "AIRCRAFT", true, 1],
  ["DIVERT_AIRCRAFT", "前往备降点", "AIRCRAFT", true, 1],
  ["EMERGENCY_LAND_AIRCRAFT", "应急迫降", "AIRCRAFT", true, 1],
  ["ABORT_TASK", "中止任务", "ORDER", true, 1],
  ["PAUSE_ROUTE_ENTRY", "暂停新任务进入", "ROUTE", true, 1],
  ["PAUSE_ROUTE", "暂停航线", "ROUTE", true, 1],
  ["RESUME_ROUTE", "恢复航线", "ROUTE", true, 1],
  ["SWITCH_VERIFIED_ROUTE", "切换验证航线", "ORDER", true, 1],
  ["REPLACE_AIRCRAFT", "更换无人机", "ORDER", true, 1],
  ["REASSIGN_ORDER", "重新分配订单", "ORDER", true, 1],
  ["CHANGE_PRIORITY", "调整优先级", "ORDER", true, 1],
  ["DELAY_TASK", "推迟任务", "ORDER", true, 1],
  ["CANCEL_TASK", "取消任务", "ORDER", true, 1],
  ["BATCH_REASSIGN", "批量调整", "BATCH", true, 20],
  ["GLOBAL_RESCHEDULE", "全局重调度", "GLOBAL", false, 50]
]

export function computeLogisticsRuntimeProjection(input: LogisticsRuntimeEngineInput): LogisticsRuntimeProjection {
  const time = Math.max(0, Math.floor(input.simulationTimeMs))
  const control = normalizeControl(input.control)
  const orderMap = new Map(input.orders.map((order) => [order.id, order]))
  const aircraftMap = new Map(input.aircraft.map((aircraft) => [aircraft.id, aircraft]))
  const routeMap = new Map(input.routes.map((route) => [route.id, route]))
  const tasks = input.scheduleItems
    .map((item) => projectTask(item, time, control, orderMap, aircraftMap, routeMap))
    .sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs || left.scheduleItemId.localeCompare(right.scheduleItemId))
  const projectedAircraft = projectAircraft(input.aircraft, tasks, control, time)
  const projectedOrders = projectOrders(input.orders, tasks, time, control)
  const projectedRoutes = projectRoutes(input.routes, tasks, control)
  return {
    durationMs: Math.max(0, ...tasks.map((task) => task.nextAvailableTimeMs)),
    tasks,
    aircraft: projectedAircraft,
    orders: projectedOrders,
    routes: projectedRoutes,
    summary: summarize(projectedAircraft, projectedOrders),
    environment: projectEnvironment(input.initialEnvironment, control.eventImpacts),
    availableActions: logisticsRuntimeActionsFor(input.totalAircraft, input.sessionStatus, projectedRoutes)
  }
}

export function logisticsRuntimeTaskStatusAt(item: LogisticsScheduleItemView, simulationTimeMs: number, delayOffsetMs = 0): LogisticsRuntimeTaskStatus {
  const time = Math.max(0, simulationTimeMs)
  const offset = Math.max(0, delayOffsetMs)
  const takeoff = item.plannedTakeoffTimeMs + offset
  const arrival = item.arrivalTimeMs + offset
  const returnStart = item.returnStartTimeMs + offset
  const landing = item.landingTimeMs + offset
  const available = item.nextAvailableTimeMs + offset
  const takeoffEnd = Math.min(arrival, takeoff + phaseDuration(takeoff, arrival))
  const landingStart = Math.max(returnStart, landing - phaseDuration(returnStart, landing))
  if (time < takeoff) return "WAITING_EXECUTION"
  if (time < takeoffEnd) return "TAKEOFF"
  if (time < arrival) return "OUTBOUND"
  if (time < returnStart) return "ARRIVAL_CONFIRMATION"
  if (time < landingStart) return "RETURNING"
  if (time < available) return "LANDING"
  return "AVAILABLE_AGAIN"
}

export function logisticsRuntimeActionsFor(
  totalAircraft: number,
  sessionStatus: string,
  routes: Array<Pick<LogisticsRuntimeRouteView, "status">> = []
): LogisticsRuntimeAvailableActionView[] {
  const count = Math.max(1, Math.floor(totalAircraft))
  const controllable = sessionStatus === "RUNNING" || sessionStatus === "PAUSED"
  const hasPausedRoute = routes.some((route) => route.status === "PAUSED" || route.status === "RECOVERING")
  return actionDefinitions.map(([code, title, targetType, requiresTarget, minimumCount]) => {
    const scaleEnabled = count >= minimumCount
    const routeStateEnabled = code !== "RESUME_ROUTE" || hasPausedRoute
    const enabled = controllable && scaleEnabled && routeStateEnabled
    const disabledReason = !controllable
      ? "当前运行状态不可执行"
      : !scaleEnabled
        ? "当前规模未开放该操作"
        : !routeStateEnabled
          ? "当前没有可恢复航线"
          : null
    return { code, title, targetType, requiresTarget, enabled, disabledReason, eligibleTargetIds: [], eligibleRouteIdsByTargetId: {} }
  })
}

export function logisticsRuntimeEligibleTargetIds(
  code: LogisticsRuntimeActionCode,
  projection: Pick<LogisticsRuntimeProjection, "aircraft" | "orders" | "routes" | "tasks">
): string[] {
  const taskByAircraftId = new Map(projection.tasks.map((task) => [task.aircraftId, task]))
  const taskByOrderId = new Map(projection.tasks.map((task) => [task.orderId, task]))
  const activeFlightStatuses: LogisticsRuntimeAircraftStatus[] = ["TAKING_OFF", "OUTBOUND", "ARRIVED", "HOLDING"]
  const maneuverStatuses: LogisticsRuntimeAircraftStatus[] = ["OUTBOUND", "ARRIVED", "HOLDING"]
  const targetableOrderStatuses: LogisticsRuntimeOrderStatus[] = ["SCHEDULED", "DELIVERING", "EXPECTED_DELAY", "DELAYED"]

  if (code === "REDUCE_SPEED") {
    return projection.aircraft.filter((aircraft) => activeFlightStatuses.includes(aircraft.status) && taskByAircraftId.has(aircraft.id)).map((aircraft) => aircraft.id)
  }
  if (code === "MAINTAIN_ROUTE") {
    return projection.aircraft.filter((aircraft) => ["TAKING_OFF", "OUTBOUND", "ARRIVED", "HOLDING"].includes(aircraft.status) && taskByAircraftId.has(aircraft.id)).map((aircraft) => aircraft.id)
  }
  if (code === "HOLD_POSITION" || code === "PROCEED_TO_WAITING_POINT") {
    return projection.aircraft.filter((aircraft) => maneuverStatuses.includes(aircraft.status) && taskByAircraftId.has(aircraft.id)).map((aircraft) => aircraft.id)
  }
  if (code === "RETURN_AIRCRAFT") {
    return projection.aircraft.filter((aircraft) => ["TAKING_OFF", "OUTBOUND", "ARRIVED", "HOLDING"].includes(aircraft.status) && taskByAircraftId.has(aircraft.id)).map((aircraft) => aircraft.id)
  }
  if (code === "DIVERT_AIRCRAFT") {
    return projection.aircraft.filter((aircraft) => ["TAKING_OFF", "OUTBOUND", "ARRIVED", "RETURNING", "HOLDING"].includes(aircraft.status) && taskByAircraftId.has(aircraft.id)).map((aircraft) => aircraft.id)
  }
  if (code === "EMERGENCY_LAND_AIRCRAFT") {
    return projection.aircraft.filter((aircraft) => activeFlightStatuses.includes(aircraft.status) && taskByAircraftId.has(aircraft.id)).map((aircraft) => aircraft.id)
  }
  if (code === "REPLACE_AIRCRAFT" || code === "REASSIGN_ORDER" || code === "DELAY_TASK") {
    return projection.orders.filter((order) => taskByOrderId.get(order.id)?.status === "WAITING_EXECUTION").map((order) => order.id)
  }
  if (code === "ABORT_TASK" || code === "CANCEL_TASK" || code === "CHANGE_PRIORITY") {
    return projection.orders.filter((order) => targetableOrderStatuses.includes(order.status) && taskByOrderId.has(order.id)).map((order) => order.id)
  }
  if (code === "SWITCH_VERIFIED_ROUTE") {
    const eligibleRoutes = logisticsRuntimeEligibleRouteIdsByTargetId(projection)
    return projection.orders
      .filter((order) => targetableOrderStatuses.includes(order.status) && (eligibleRoutes[order.id]?.length ?? 0) > 0)
      .map((order) => order.id)
  }
  if (code === "RESUME_ROUTE") {
    return projection.routes.filter((route) => (route.status === "PAUSED" || route.status === "RECOVERING") && route.affectedEventIds.length === 0).map((route) => route.id)
  }
  if (code === "PAUSE_ROUTE" || code === "PAUSE_ROUTE_ENTRY") {
    return projection.routes.filter((route) => route.status === "AVAILABLE" || route.status === "RISK" || route.status === "RECOVERING").map((route) => route.id)
  }
  return []
}

export function logisticsRuntimeEligibleRouteIdsByTargetId(
  projection: Pick<LogisticsRuntimeProjection, "orders" | "routes" | "tasks">
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const taskByOrderId = new Map(projection.tasks.map((task) => [task.orderId, task]))
  const routeById = new Map(projection.routes.map((route) => [route.id, route]))
  for (const order of projection.orders) {
    const task = taskByOrderId.get(order.id)
    const currentRouteId = task?.activeRouteId ?? task?.outboundRouteId
    const currentRoute = currentRouteId ? routeById.get(currentRouteId) : null
    if (!task || !currentRoute) continue
    const eligibleRouteIds = projection.routes
      .filter((route) => route.id !== currentRoute.id
        && route.destinationNodeId === order.destinationNodeId
        && route.direction === currentRoute.direction
        && route.role === "ALTERNATE"
        && route.sourceVersionId === currentRoute.sourceVersionId
        && (route.validationStatus === "PASSED" || route.validationStatus === "WITH_RISK")
        && route.status !== "ABNORMAL"
        && route.status !== "CLOSED"
        && route.status !== "PAUSED")
      .map((route) => route.id)
    if (eligibleRouteIds.length > 0) result[order.id] = eligibleRouteIds
  }
  return result
}

function projectTask(
  item: LogisticsScheduleItemView,
  time: number,
  control: LogisticsRuntimeControlState,
  orderMap: Map<string, LogisticsSchedulingOrderView>,
  aircraftMap: Map<string, LogisticsAircraftInstanceView>,
  routeMap: Map<string, LogisticsSchedulingRouteView>
): LogisticsRuntimeTaskView {
  const holdStartedAtMs = control.holdStartedAtMs[item.id]
  const activeHoldDelay = holdStartedAtMs === undefined ? 0 : Math.max(0, time - holdStartedAtMs)
  const delay = Math.max(0, Math.floor((control.delayOffsetsMs[item.id] ?? 0) + activeHoldDelay))
  const manualSpeedFactor = Math.max(1, Number(control.taskSpeedFactorOverrides[item.id] ?? 1))
  const order = orderMap.get(item.orderId)
  const aircraftId = control.taskAircraftOverrides[item.id] ?? item.aircraftId
  const aircraft = aircraftMap.get(aircraftId)
  const eventSpeedFactor = eventTaskSpeedFactor(control.eventImpacts, item, aircraftId)
  const eventBatteryPenalty = eventTaskBatteryPenalty(control.eventImpacts, item, aircraftId)
  const effectiveItem = missionWithSpeedFactor(item, manualSpeedFactor * eventSpeedFactor)
  const baseStatus = logisticsRuntimeTaskStatusAt(effectiveItem, time, delay)
  const forcedStatus = control.taskStatusOverrides[item.id]
  const diversion = control.diversionPlans[aircraftId]
  const returnPlan = control.returnPlans[aircraftId]
  const resumePlan = control.resumePlans[aircraftId]
  const diversionCompleted = diversion?.taskId === item.id && time >= diversion.endSimulationTimeMs
  const returnCompleted = returnPlan?.taskId === item.id && time >= returnPlan.endSimulationTimeMs
  const resumeActive = resumePlan?.taskId === item.id && time < resumePlan.endSimulationTimeMs
  const status = (diversionCompleted || returnCompleted) && forcedStatus !== "CANCELLED" && forcedStatus !== "FAILED"
    ? "AVAILABLE_AGAIN"
    : forcedStatus === "RETURNING" && baseStatus === "AVAILABLE_AGAIN"
      ? "AVAILABLE_AGAIN"
      : forcedStatus ?? baseStatus
  const outbound = routeMap.get(item.outboundRouteId)
  const returning = routeMap.get(item.returnRouteId)
  const overrideRoute = control.activeRouteOverrides[item.id] ? routeMap.get(control.activeRouteOverrides[item.id]!) : undefined
  const outboundStatus = status === "TAKEOFF" || status === "OUTBOUND" || status === "ARRIVAL_CONFIRMATION"
  const overrideApplies = overrideRoute && (outboundStatus && overrideRoute.route.direction === "OUTBOUND"
    || (status === "RETURNING" || status === "LANDING") && overrideRoute.route.direction === "RETURN")
  const activeRouteId = overrideApplies
    ? overrideRoute!.id
    : (outboundStatus ? item.outboundRouteId : status === "RETURNING" || status === "LANDING" ? item.returnRouteId : null)
  const activeRoute = activeRouteId ? routeMap.get(activeRouteId) : undefined
  const actionReturnStartTimeMs = returnPlan?.taskId === item.id
    ? returnPlan.startSimulationTimeMs
    : diversion?.taskId === item.id
      ? diversion.startSimulationTimeMs
      : effectiveItem.returnStartTimeMs + delay
  const actionLandingTimeMs = returnPlan?.taskId === item.id
    ? returnPlan.endSimulationTimeMs
    : diversion?.taskId === item.id
      ? diversion.endSimulationTimeMs
      : effectiveItem.landingTimeMs + delay
  const actionNextAvailableTimeMs = returnPlan?.taskId === item.id
    ? returnPlan.endSimulationTimeMs
    : diversion?.taskId === item.id
      ? diversion.endSimulationTimeMs
      : effectiveItem.nextAvailableTimeMs + delay
  const position = diversion?.taskId === item.id
    ? interpolateRoute([diversion.startPosition, diversion.landingPosition], progressBetween(time, diversion.startSimulationTimeMs, diversion.endSimulationTimeMs))
    : returnPlan?.taskId === item.id
      ? interpolateRoute(returnPlan.routePoints, progressBetween(time, returnPlan.startSimulationTimeMs, returnPlan.endSimulationTimeMs))
      : resumeActive
        ? interpolateRoute(resumePlan.routePoints, progressBetween(time, resumePlan.startSimulationTimeMs, resumePlan.endSimulationTimeMs))
        : control.aircraftPositionOverrides[aircraftId] ?? taskPosition(effectiveItem, status, time, delay, outbound, returning, activeRoute)
  const speedMps = projectedSpeedMps(
    status,
    effectiveItem,
    outbound,
    returning,
    activeRoute,
    diversion?.taskId === item.id ? diversion.endSimulationTimeMs - diversion.startSimulationTimeMs : undefined,
    diversion?.taskId === item.id ? [diversion.startPosition, diversion.landingPosition] : undefined,
    returnPlan?.taskId === item.id ? returnPlan.endSimulationTimeMs - returnPlan.startSimulationTimeMs : undefined,
    returnPlan?.taskId === item.id ? returnPlan.routePoints : undefined,
    resumeActive ? resumePlan.endSimulationTimeMs - resumePlan.startSimulationTimeMs : undefined,
    resumeActive ? resumePlan.routePoints : undefined
  )
  const progress = missionProgress(effectiveItem, time, delay)
  const eventExposureProgress = progressBetween(time, item.plannedTakeoffTimeMs + delay, item.nextAvailableTimeMs + delay)
  const initialBattery = aircraft?.initialBatteryPercent ?? 100
  return {
    scheduleItemId: item.id,
    orderId: item.orderId,
    orderCode: item.orderCode,
    aircraftId,
    aircraftCode: aircraft?.code ?? item.aircraftCode,
    destinationNodeId: order?.destinationNodeId ?? item.destinationNodeId,
    status,
    outboundRouteId: item.outboundRouteId,
    returnRouteId: item.returnRouteId,
    activeRouteId,
    plannedTakeoffTimeMs: effectiveItem.plannedTakeoffTimeMs + delay,
    arrivalTimeMs: effectiveItem.arrivalTimeMs + delay,
    returnStartTimeMs: actionReturnStartTimeMs,
    landingTimeMs: actionLandingTimeMs,
    nextAvailableTimeMs: actionNextAvailableTimeMs,
    position,
    speedMps,
    batteryPercent: round(Math.max(item.batteryAfterMissionPercent - eventBatteryPenalty, initialBattery - (initialBattery - item.batteryAfterMissionPercent) * progress - eventBatteryPenalty * eventExposureProgress), 1),
    delayedByMs: delay
  }
}

function projectAircraft(aircraft: LogisticsAircraftInstanceView[], tasks: LogisticsRuntimeTaskView[], control: LogisticsRuntimeControlState, time: number): LogisticsRuntimeAircraftView[] {
  return aircraft.map((item) => {
    const ownTasks = tasks.filter((task) => task.aircraftId === item.id)
    const active = ownTasks.find((task) => !["WAITING_EXECUTION", "AVAILABLE_AGAIN", "CANCELLED", "FAILED"].includes(task.status))
    const future = ownTasks.find((task) => task.status === "WAITING_EXECUTION")
    const relevant = active ?? future ?? ownTasks.at(-1)
    const baseStatus = item.status === "UNAVAILABLE" ? "DISABLED" : time < item.availableAtMs ? "STANDBY" : active ? aircraftStatusFor(active.status) : future ? "ASSIGNED" : "AVAILABLE"
    const diversion = control.diversionPlans[item.id]
    const configuredOverride = control.aircraftStatusOverrides[item.id]
    const overrideStatus = configuredOverride === "DIVERTING"
      && ((diversion && time >= diversion.endSimulationTimeMs) || (!diversion && (!active || ["AVAILABLE_AGAIN", "CANCELLED", "FAILED"].includes(active.status))))
      ? undefined
      : configuredOverride
    return {
      id: item.id,
      code: item.code,
      modelCode: item.modelCode,
      status: overrideStatus === "DISABLED" || overrideStatus === "EMERGENCY_LANDING"
        ? overrideStatus
        : overrideStatus && active
          ? overrideStatus
          : baseStatus,
      currentTaskId: active?.scheduleItemId ?? future?.scheduleItemId ?? null,
      currentOrderId: active?.orderId ?? future?.orderId ?? null,
      position: relevant?.position ?? zeroCoordinate(),
      speedMps: relevant?.speedMps ?? 0,
      batteryPercent: relevant?.batteryPercent ?? item.initialBatteryPercent,
      nextAvailableTimeMs: Math.max(item.availableAtMs, ...ownTasks.map((task) => task.nextAvailableTimeMs), 0)
    }
  })
}

function projectOrders(orders: LogisticsSchedulingOrderView[], tasks: LogisticsRuntimeTaskView[], time: number, control: LogisticsRuntimeControlState): LogisticsRuntimeOrderView[] {
  const taskMap = new Map(tasks.map((task) => [task.orderId, task]))
  return orders.map((order) => {
    const task = taskMap.get(order.id)
    let status: LogisticsRuntimeOrderStatus
    if (!task) status = time < order.releaseTimeMs ? "UNRELEASED" : "UNASSIGNED"
    else if (task.status === "CANCELLED") status = "CANCELLED"
    else if (task.status === "FAILED") status = "FAILED"
    else if (task.status === "AVAILABLE_AGAIN") status = task.arrivalTimeMs > order.latestArrivalTimeMs ? "DELAYED" : "COMPLETED"
    else if (task.status === "WAITING_EXECUTION") status = task.arrivalTimeMs > order.latestArrivalTimeMs ? "EXPECTED_DELAY" : "SCHEDULED"
    else status = "DELIVERING"
    return {
      id: order.id,
      code: order.code,
      priority: control.orderPriorityOverrides[order.id] ?? order.priority,
      destinationNodeId: order.destinationNodeId,
      status: control.orderStatusOverrides[order.id] ?? status,
      assignedAircraftId: task?.aircraftId ?? null,
      scheduleItemId: task?.scheduleItemId ?? null,
      releaseTimeMs: order.releaseTimeMs,
      latestArrivalTimeMs: order.latestArrivalTimeMs,
      expectedArrivalTimeMs: task?.arrivalTimeMs ?? null
    }
  })
}

function projectRoutes(routes: LogisticsSchedulingRouteView[], tasks: LogisticsRuntimeTaskView[], control: LogisticsRuntimeControlState): LogisticsRuntimeRouteView[] {
  return routes.map((item) => {
    const impacts = control.eventImpacts.filter((impact) => impact.affectedRouteIds.includes(item.id))
    const eventStatus: LogisticsRuntimeRouteStatus = impacts.some((impact) => impact.category === "ROUTE_OPERATION" && (impact.severity === "ERROR" || impact.severity === "CRITICAL"))
      ? "ABNORMAL"
      : impacts.length > 0
        ? "RISK"
        : "AVAILABLE"
    return {
      id: item.id,
      name: item.route.name,
      destinationNodeId: item.route.destinationNodeId,
      direction: item.route.direction,
      role: item.route.role,
      sourceVersionId: item.versionId,
      sourceVersionNo: item.versionNo,
      validationStatus: item.validationStatus ?? "PASSED",
      status: control.routeStatusOverrides[item.id] ?? eventStatus,
      activeTaskCount: tasks.filter((task) => task.activeRouteId === item.id).length,
      affectedEventIds: impacts.map((impact) => impact.eventId),
      waypoints: item.route.waypoints
    }
  })
}

function taskPosition(
  item: LogisticsScheduleItemView,
  status: LogisticsRuntimeTaskStatus,
  time: number,
  delay: number,
  outbound?: LogisticsSchedulingRouteView,
  returning?: LogisticsSchedulingRouteView,
  activeRoute?: LogisticsSchedulingRouteView
): V3Coordinate {
  const outboundPoints = routePoints(outbound)
  const returnPoints = routePoints(returning)
  if (status === "TAKEOFF" || status === "OUTBOUND") return interpolateRoute(routePoints(activeRoute ?? outbound), progressBetween(time, item.plannedTakeoffTimeMs + delay, item.arrivalTimeMs + delay))
  if (status === "ARRIVAL_CONFIRMATION") return routePoints(activeRoute ?? outbound).at(-1) ?? returnPoints[0] ?? zeroCoordinate()
  if (status === "RETURNING" || status === "LANDING") return interpolateRoute(routePoints(activeRoute ?? returning), progressBetween(time, item.returnStartTimeMs + delay, item.landingTimeMs + delay))
  if (status === "AVAILABLE_AGAIN") return returnPoints.at(-1) ?? outboundPoints[0] ?? zeroCoordinate()
  if (status === "CANCELLED" || status === "FAILED") return outboundPoints[0] ?? returnPoints.at(-1) ?? zeroCoordinate()
  return outboundPoints[0] ?? returnPoints.at(-1) ?? zeroCoordinate()
}

function routePoints(route?: LogisticsSchedulingRouteView): V3Coordinate[] {
  return route?.route.waypoints.map((waypoint) => ({ longitude: waypoint.position.longitude, latitude: waypoint.position.latitude, altitudeMeters: waypoint.altitudeMeters })) ?? []
}

function interpolateRoute(points: V3Coordinate[], progress: number): V3Coordinate {
  if (points.length === 0) return zeroCoordinate()
  if (points.length === 1) return points[0]!
  const distances = points.slice(1).map((point, index) => coordinateDistance(points[index]!, point))
  const total = distances.reduce((sum, value) => sum + value, 0)
  if (total <= 0) return points[0]!
  let remaining = Math.max(0, Math.min(1, progress)) * total
  for (let index = 0; index < distances.length; index += 1) {
    const distance = distances[index]!
    if (remaining <= distance || index === distances.length - 1) {
      const ratio = distance <= 0 ? 0 : remaining / distance
      const start = points[index]!
      const end = points[index + 1]!
      return {
        longitude: start.longitude + (end.longitude - start.longitude) * ratio,
        latitude: start.latitude + (end.latitude - start.latitude) * ratio,
        altitudeMeters: (start.altitudeMeters ?? 0) + ((end.altitudeMeters ?? 0) - (start.altitudeMeters ?? 0)) * ratio
      }
    }
    remaining -= distance
  }
  return points.at(-1)!
}

function missionProgress(item: LogisticsScheduleItemView, time: number, delay: number): number {
  return progressBetween(time, item.plannedTakeoffTimeMs + delay, item.landingTimeMs + delay)
}

function projectedSpeedMps(
  status: LogisticsRuntimeTaskStatus,
  item: LogisticsScheduleItemView,
  outbound?: LogisticsSchedulingRouteView,
  returning?: LogisticsSchedulingRouteView,
  activeRoute?: LogisticsSchedulingRouteView,
  diversionDurationMs?: number,
  diversionPoints?: V3Coordinate[],
  returnPlanDurationMs?: number,
  returnPlanPoints?: V3Coordinate[],
  resumePlanDurationMs?: number,
  resumePlanPoints?: V3Coordinate[]
): number {
  if (diversionDurationMs !== undefined) return round(routeDistanceMeters(diversionPoints ?? []) / Math.max(1, diversionDurationMs / 1_000), 2)
  if (returnPlanDurationMs !== undefined) return round(routeDistanceMeters(returnPlanPoints ?? []) / Math.max(1, returnPlanDurationMs / 1_000), 2)
  if (resumePlanDurationMs !== undefined) return round(routeDistanceMeters(resumePlanPoints ?? []) / Math.max(1, resumePlanDurationMs / 1_000), 2)
  if (status === "TAKEOFF" || status === "OUTBOUND") return round(routeDistanceMeters(routePoints(activeRoute ?? outbound)) / Math.max(1, (item.arrivalTimeMs - item.plannedTakeoffTimeMs) / 1_000), 2)
  if (status === "RETURNING" || status === "LANDING") return round(routeDistanceMeters(routePoints(activeRoute ?? returning)) / Math.max(1, (item.landingTimeMs - item.returnStartTimeMs) / 1_000), 2)
  return 0
}

function aircraftStatusFor(taskStatus: LogisticsRuntimeTaskStatus): LogisticsRuntimeAircraftStatus {
  const mapping: Partial<Record<LogisticsRuntimeTaskStatus, LogisticsRuntimeAircraftStatus>> = {
    TAKEOFF: "TAKING_OFF",
    OUTBOUND: "OUTBOUND",
    ARRIVAL_CONFIRMATION: "ARRIVED",
    RETURNING: "RETURNING",
    LANDING: "LANDING",
    FAILED: "DISABLED"
  }
  return mapping[taskStatus] ?? "AVAILABLE"
}

function summarize(aircraft: LogisticsRuntimeAircraftView[], orders: LogisticsRuntimeOrderView[]): LogisticsRuntimeSummaryView {
  const airborne: LogisticsRuntimeAircraftStatus[] = ["TAKING_OFF", "OUTBOUND", "ARRIVED", "RETURNING", "LANDING", "HOLDING", "DIVERTING", "EMERGENCY_LANDING"]
  return {
    totalAircraft: aircraft.length,
    availableAircraft: aircraft.filter((item) => item.status === "AVAILABLE").length,
    assignedAircraft: aircraft.filter((item) => item.status === "ASSIGNED").length,
    airborneAircraft: aircraft.filter((item) => airborne.includes(item.status)).length,
    holdingAircraft: aircraft.filter((item) => item.status === "HOLDING").length,
    warningAircraft: aircraft.filter((item) => item.status === "DIVERTING" || item.status === "EMERGENCY_LANDING").length,
    disabledAircraft: aircraft.filter((item) => item.status === "DISABLED").length,
    totalOrders: orders.length,
    unreleasedOrders: orders.filter((item) => item.status === "UNRELEASED").length,
    waitingOrders: orders.filter((item) => item.status === "UNASSIGNED" || item.status === "SCHEDULED" || item.status === "EXPECTED_DELAY").length,
    deliveringOrders: orders.filter((item) => item.status === "DELIVERING").length,
    completedOrders: orders.filter((item) => item.status === "COMPLETED").length,
    delayedOrders: orders.filter((item) => item.status === "DELAYED" || item.status === "EXPECTED_DELAY").length,
    failedOrders: orders.filter((item) => item.status === "FAILED").length,
    cancelledOrders: orders.filter((item) => item.status === "CANCELLED").length
  }
}

function projectEnvironment(initial: LogisticsInitialEnvironmentConfig | undefined, impacts: LogisticsRuntimeEventImpact[]): LogisticsRuntimeEnvironmentView {
  const severity = (category: LogisticsRuntimeEventCategory) => impacts.filter((impact) => impact.category === category).reduce<V3AlertSeverity | null>((highest, impact) => higherSeverity(highest, impact.severity), null)
  const weather = severity("WEATHER_ENVIRONMENT")
  const positioning = severity("POSITIONING_NAVIGATION")
  const communication = severity("COMMUNICATION_LINK")
  const equipment = severity("AIRCRAFT_DEVICE")
  const operation = severity("ROUTE_OPERATION")
  const initialWindState = initial?.windForceState === "OVER_LIMIT" ? "OVER_LIMIT" : initial?.windForceState === "NEAR_LIMIT" ? "NEAR_LIMIT" : "NORMAL"
  const initialPositioningQuality = signalQuality(initial?.positioningState)
  const initialCommunicationQuality = signalQuality(initial?.communicationState)
  return {
    windDirection: initial?.windDirection ?? "N",
    windState: severe(weather) ? "OVER_LIMIT" : weather ? higherOperationalState(initialWindState, "NEAR_LIMIT") : initialWindState,
    gustState: weather === "CRITICAL" ? "CONTINUOUS" : weather ? higherGustState(initial?.gustState ?? "NONE", "OCCASIONAL") : initial?.gustState ?? "NONE",
    rainState: weather === "CRITICAL" ? "OVER_LIMIT" : weather ? higherRainState(initial?.rainState ?? "NONE", "BELOW_LIMIT") : initial?.rainState ?? "NONE",
    positioningQuality: severe(positioning) ? "LOST" : positioning ? higherSignalQuality(initialPositioningQuality, "DEGRADED") : initialPositioningQuality,
    communicationQuality: severe(communication) ? "LOST" : communication ? higherSignalQuality(initialCommunicationQuality, "DEGRADED") : initialCommunicationQuality,
    equipmentState: severe(equipment) ? "FAULT" : equipment ? "WARNING" : "NORMAL",
    operationState: severe(operation) ? "SUSPENDED" : operation ? "RESTRICTED" : "NORMAL"
  }
}

function signalQuality(value: LogisticsInitialEnvironmentConfig["positioningState"] | undefined): LogisticsRuntimeEnvironmentView["positioningQuality"] {
  if (value === "CONTINUOUS_ABNORMAL") return "LOST"
  if (value === "LOCAL_WEAK" || value === "LOCAL_ABNORMAL" || value === "RECOVERING") return "DEGRADED"
  return "GOOD"
}

function higherOperationalState(left: LogisticsRuntimeEnvironmentView["windState"], right: LogisticsRuntimeEnvironmentView["windState"]): LogisticsRuntimeEnvironmentView["windState"] {
  return ["NORMAL", "NEAR_LIMIT", "OVER_LIMIT"].indexOf(left) >= ["NORMAL", "NEAR_LIMIT", "OVER_LIMIT"].indexOf(right) ? left : right
}

function higherGustState(left: LogisticsRuntimeEnvironmentView["gustState"], right: LogisticsRuntimeEnvironmentView["gustState"]): LogisticsRuntimeEnvironmentView["gustState"] {
  return ["NONE", "OCCASIONAL", "CONTINUOUS"].indexOf(left) >= ["NONE", "OCCASIONAL", "CONTINUOUS"].indexOf(right) ? left : right
}

function higherRainState(left: LogisticsRuntimeEnvironmentView["rainState"], right: LogisticsRuntimeEnvironmentView["rainState"]): LogisticsRuntimeEnvironmentView["rainState"] {
  return ["NONE", "BELOW_LIMIT", "OVER_LIMIT"].indexOf(left) >= ["NONE", "BELOW_LIMIT", "OVER_LIMIT"].indexOf(right) ? left : right
}

function higherSignalQuality(left: LogisticsRuntimeEnvironmentView["positioningQuality"], right: LogisticsRuntimeEnvironmentView["positioningQuality"]): LogisticsRuntimeEnvironmentView["positioningQuality"] {
  return ["GOOD", "DEGRADED", "LOST"].indexOf(left) >= ["GOOD", "DEGRADED", "LOST"].indexOf(right) ? left : right
}

function normalizeControl(value?: Partial<LogisticsRuntimeControlState>): LogisticsRuntimeControlState {
  return {
    aircraftStatusOverrides: value?.aircraftStatusOverrides ?? {},
    aircraftPositionOverrides: value?.aircraftPositionOverrides ?? {},
    diversionPlans: value?.diversionPlans ?? {},
    returnPlans: value?.returnPlans ?? {},
    resumePlans: value?.resumePlans ?? {},
    holdStartedAtMs: value?.holdStartedAtMs ?? {},
    orderStatusOverrides: value?.orderStatusOverrides ?? {},
    routeStatusOverrides: value?.routeStatusOverrides ?? {},
    taskStatusOverrides: value?.taskStatusOverrides ?? {},
    taskAircraftOverrides: value?.taskAircraftOverrides ?? {},
    orderPriorityOverrides: value?.orderPriorityOverrides ?? {},
    taskSpeedFactorOverrides: value?.taskSpeedFactorOverrides ?? {},
    activeRouteOverrides: value?.activeRouteOverrides ?? {},
    delayOffsetsMs: value?.delayOffsetsMs ?? {},
    eventImpacts: value?.eventImpacts ?? []
  }
}

function missionWithSpeedFactor(item: LogisticsScheduleItemView, factor: number): LogisticsScheduleItemView {
  if (factor <= 1) return item
  const takeoff = item.plannedTakeoffTimeMs
  const outboundDuration = Math.max(0, item.arrivalTimeMs - takeoff)
  const confirmationDuration = Math.max(0, item.returnStartTimeMs - item.arrivalTimeMs)
  const returnDuration = Math.max(0, item.landingTimeMs - item.returnStartTimeMs)
  const turnaroundDuration = Math.max(0, item.nextAvailableTimeMs - item.landingTimeMs)
  const arrival = takeoff + Math.round(outboundDuration * factor)
  const returnStart = arrival + Math.round(confirmationDuration * factor)
  const landing = returnStart + Math.round(returnDuration * factor)
  return {
    ...item,
    arrivalTimeMs: arrival,
    returnStartTimeMs: returnStart,
    landingTimeMs: landing,
    nextAvailableTimeMs: landing + Math.round(turnaroundDuration * factor)
  }
}

function eventTaskSpeedFactor(impacts: LogisticsRuntimeEventImpact[], item: LogisticsScheduleItemView, aircraftId: string): number {
  return impacts
    .filter((impact) => eventAffectsTask(impact, item, aircraftId))
    .reduce((factor, impact) => Math.max(factor, eventSpeedFactor(impact)), 1)
}

function eventTaskBatteryPenalty(impacts: LogisticsRuntimeEventImpact[], item: LogisticsScheduleItemView, aircraftId: string): number {
  return impacts
    .filter((impact) => eventAffectsTask(impact, item, aircraftId))
    .reduce((penalty, impact) => penalty + eventBatteryPenalty(impact), 0)
}

function eventAffectsTask(impact: LogisticsRuntimeEventImpact, item: LogisticsScheduleItemView, aircraftId: string): boolean {
  return impact.affectedAircraftIds.includes(aircraftId)
    || impact.affectedOrderIds.includes(item.orderId)
    || impact.affectedRouteIds.includes(item.outboundRouteId)
    || impact.affectedRouteIds.includes(item.returnRouteId)
}

function eventSpeedFactor(impact: LogisticsRuntimeEventImpact): number {
  const severity = severityRank(impact.severity)
  if (impact.category === "WEATHER_ENVIRONMENT") return [1, 1.15, 1.3, 1.5][severity] ?? 1
  if (impact.category === "AIRCRAFT_DEVICE") return [1, 1.1, 1.25, 1.4][severity] ?? 1
  if (impact.category === "POSITIONING_NAVIGATION") return [1, 1.05, 1.15, 1.3][severity] ?? 1
  if (impact.category === "ROUTE_OPERATION") return [1, 1.05, 1.15, 1.25][severity] ?? 1
  return 1
}

function eventBatteryPenalty(impact: LogisticsRuntimeEventImpact): number {
  const severity = severityRank(impact.severity)
  if (impact.category === "WEATHER_ENVIRONMENT") return [0, 8, 16, 24][severity] ?? 0
  if (impact.category === "AIRCRAFT_DEVICE") return [0, 4, 10, 18][severity] ?? 0
  if (impact.category === "POSITIONING_NAVIGATION") return [0, 2, 4, 8][severity] ?? 0
  return 0
}

function severityRank(value: V3AlertSeverity): number {
  return value === "CRITICAL" ? 3 : value === "ERROR" ? 2 : value === "WARNING" ? 1 : 0
}

function phaseDuration(start: number, end: number): number {
  return Math.max(1_000, Math.min(15_000, Math.floor(Math.max(0, end - start) * 0.15)))
}

function progressBetween(value: number, start: number, end: number): number {
  if (value <= start) return 0
  if (value >= end) return 1
  return (value - start) / Math.max(1, end - start)
}

function coordinateDistance(left: V3Coordinate, right: V3Coordinate): number {
  const latitude = (left.latitude + right.latitude) / 2 * Math.PI / 180
  const x = (right.longitude - left.longitude) * Math.PI / 180 * Math.cos(latitude)
  const y = (right.latitude - left.latitude) * Math.PI / 180
  return Math.sqrt(x * x + y * y) * 6_371_000
}

function routeDistanceMeters(points: V3Coordinate[]): number {
  return points.slice(1).reduce((total, point, index) => total + coordinateDistance(points[index]!, point), 0)
}

function higherSeverity(left: V3AlertSeverity | null, right: V3AlertSeverity): V3AlertSeverity {
  const order: V3AlertSeverity[] = ["INFO", "WARNING", "ERROR", "CRITICAL"]
  return !left || order.indexOf(right) > order.indexOf(left) ? right : left
}

function severe(value: V3AlertSeverity | null): boolean {
  return value === "ERROR" || value === "CRITICAL"
}

function zeroCoordinate(): V3Coordinate {
  return { longitude: 0, latitude: 0, altitudeMeters: 0 }
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision
  return Math.round(value * factor) / factor
}
