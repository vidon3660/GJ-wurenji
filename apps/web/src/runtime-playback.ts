import type {
  LogisticsRuntimeAircraftStatus,
  LogisticsRuntimeAircraftView,
  LogisticsRuntimeOrderStatus,
  LogisticsRuntimeOrderView,
  LogisticsRuntimeRouteView,
  LogisticsRuntimeSummaryView,
  LogisticsRuntimeTaskStatus,
  LogisticsRuntimeTaskView,
  ShowRuntimeGroupStatus,
  ShowRuntimeGroupView,
  ShowRuntimePhase,
  ShowRuntimeTotalsView,
  V3AlertSeverity,
  V3Coordinate,
  VtlRuntimeAircraftView,
  VtlTaskObjectView,
  VtlReplayFrameView
} from "@wurenji/shared"

export interface RuntimeTimelineMarker {
  id: string
  label: string
  timeMs: number
  severity: V3AlertSeverity
}

export interface RuntimeMarkerEvent {
  id: string
  code: string
  title?: string
  severity: V3AlertSeverity
  scheduledSimulationTimeMs: number | null
  detectedSimulationTimeMs?: number | null
}

export interface VtlReplayTaskResult {
  taskObjectId: string
  title: string
  status: VtlTaskObjectView["status"]
  reason: string
}

export interface VtlReplayAircraftResult {
  aircraftId: string
  completedTaskObjectIds: string[]
  remainingEnergyRatio: number
  status: VtlRuntimeAircraftView["status"]
}

export interface ShowRuntimePlaybackState {
  phase: ShowRuntimePhase
  phaseTitle: string
  groups: ShowRuntimeGroupView[]
  totals: ShowRuntimeTotalsView
}

export interface LogisticsRuntimePlaybackSource {
  simulationTimeMs: number
  tasks: readonly LogisticsRuntimeTaskView[]
  aircraft: readonly LogisticsRuntimeAircraftView[]
  orders: readonly LogisticsRuntimeOrderView[]
  routes: readonly LogisticsRuntimeRouteView[]
  summary: LogisticsRuntimeSummaryView
}

export interface LogisticsRuntimePlaybackState {
  tasks: LogisticsRuntimeTaskView[]
  aircraft: LogisticsRuntimeAircraftView[]
  orders: LogisticsRuntimeOrderView[]
  summary: LogisticsRuntimeSummaryView
}

interface ShowTimelineSegment {
  phase: Exclude<ShowRuntimePhase, "READY" | "COMPLETED" | "ABORTED">
  title: string
  startMs: number
  endMs: number
}

const showPhaseWeights: Array<[ShowTimelineSegment["phase"], string, number]> = [
  ["TAKEOFF_PREPARATION", "起飞准备", 0.08],
  ["BATCH_TAKEOFF", "分批起飞", 0.2],
  ["TRANSIT_TO_SHOW", "前往表演区", 0.12],
  ["PERFORMANCE", "表演运行", 0.3],
  ["RETURN_TO_LAUNCH", "返回起降区", 0.12],
  ["BATCH_LANDING", "分批降落", 0.18]
]

export function advanceRuntimePlaybackTime(
  currentTimeMs: number,
  elapsedRealMs: number,
  rate: number,
  durationMs: number
): number {
  const current = clamp(currentTimeMs, 0, Math.max(0, durationMs))
  const elapsed = Math.max(0, Number.isFinite(elapsedRealMs) ? elapsedRealMs : 0)
  const normalizedRate = Math.max(0, Number.isFinite(rate) ? rate : 0)
  return clamp(current + elapsed * normalizedRate, 0, Math.max(0, durationMs))
}

export function runtimeTimelineMarkers(events: readonly RuntimeMarkerEvent[], durationMs: number): RuntimeTimelineMarker[] {
  const duration = Math.max(0, durationMs)
  return events
    .map((event) => ({
      id: event.id,
      label: event.title?.trim() || event.code,
      timeMs: clamp(event.scheduledSimulationTimeMs ?? event.detectedSimulationTimeMs ?? 0, 0, duration),
      severity: event.severity
    }))
    .sort((left, right) => left.timeMs - right.timeMs || left.id.localeCompare(right.id))
}

export function vtlReplayFrameAt(
  frames: readonly VtlReplayFrameView[],
  simulationTimeMs: number
): VtlReplayFrameView | null {
  if (frames.length === 0) return null
  const time = Math.max(0, Number.isFinite(simulationTimeMs) ? simulationTimeMs : 0)
  let selected = frames[0]!
  for (const frame of frames) {
    if (frame.simulationTimeMs > time) break
    selected = frame
  }
  return selected
}

export function vtlReplayTaskResults(frame: VtlReplayFrameView | null): VtlReplayTaskResult[] {
  return (frame?.taskObjects ?? [])
    .filter((task) => task.status !== "COMPLETED")
    .map((task) => ({
      taskObjectId: task.id,
      title: task.title,
      status: task.status,
      reason: task.incompleteReason ?? replayTaskStatusLabel(task.status)
    }))
}

export function vtlReplayAircraftResults(frame: VtlReplayFrameView | null): VtlReplayAircraftResult[] {
  return (frame?.aircraft ?? []).map((aircraft) => ({
    aircraftId: aircraft.aircraftId,
    completedTaskObjectIds: [...aircraft.completedTaskObjectIds],
    remainingEnergyRatio: aircraft.remainingEnergyRatio,
    status: aircraft.status
  }))
}

export function runtimeEvidenceAtTime<T extends { simulationTimeMs: number | null }>(
  items: readonly T[],
  simulationTimeMs: number
): T[] {
  const time = Math.max(0, Number.isFinite(simulationTimeMs) ? simulationTimeMs : 0)
  return items.filter((item) => item.simulationTimeMs === null || item.simulationTimeMs <= time)
}

function replayTaskStatusLabel(status: VtlTaskObjectView["status"]): string {
  switch (status) {
    case "UNASSIGNED": return "当前时刻尚未分配"
    case "ASSIGNED": return "当前时刻尚未开始"
    case "IN_PROGRESS": return "当前时刻正在执行"
    case "INCOMPLETE": return "运行结束前未完成"
    default: return "当前时刻尚未完成"
  }
}

export function projectShowRuntimePlayback(
  groups: readonly ShowRuntimeGroupView[],
  totals: ShowRuntimeTotalsView,
  performanceCenter: V3Coordinate,
  performanceRadiusMeters: number,
  maximumHeightMeters: number,
  durationMs: number,
  simulationTimeMs: number,
  reconstructOperationalState: boolean
): ShowRuntimePlaybackState {
  const duration = Math.max(1_000, durationMs)
  const time = clamp(simulationTimeMs, 0, duration)
  const segment = showSegmentAt(duration, time)
  const phase = time >= duration ? "COMPLETED" : segment.phase
  const phaseTitle = time >= duration ? "表演完成" : segment.title
  const segmentProgress = progressBetween(time, segment.startMs, segment.endMs)
  const projectedGroups = groups.map((group, index) => {
    const center = showGroupCenter(
      performanceCenter,
      Math.max(20, performanceRadiusMeters),
      Math.max(10, maximumHeightMeters),
      phase,
      segmentProgress,
      index,
      Math.max(1, groups.length)
    )
    if (!reconstructOperationalState) return { ...group, center }
    const counts = showGroupCounts(group.plannedCount, phase, segmentProgress, index, Math.max(1, groups.length))
    return {
      ...group,
      ...counts,
      status: showGroupStatus(phase, counts.airborneCount, counts.landedCount),
      center
    }
  })
  if (!reconstructOperationalState) return { phase, phaseTitle, groups: projectedGroups, totals }
  const takeoffCount = projectedGroups.reduce((sum, group) => sum + group.airborneCount + group.landedCount, 0)
  const airborneCount = projectedGroups.reduce((sum, group) => sum + group.airborneCount, 0)
  const landedCount = projectedGroups.reduce((sum, group) => sum + group.landedCount, 0)
  return {
    phase,
    phaseTitle,
    groups: projectedGroups,
    totals: {
      plannedCount: projectedGroups.reduce((sum, group) => sum + group.plannedCount, 0),
      takeoffCount,
      airborneCount,
      landedCount,
      normalCount: projectedGroups.reduce((sum, group) => sum + group.normalCount, 0),
      warningCount: 0,
      abnormalCount: 0,
      lostCount: 0
    }
  }
}

export function projectLogisticsRuntimePlayback(
  source: LogisticsRuntimePlaybackSource,
  simulationTimeMs: number,
  preserveOperationalState: boolean
): LogisticsRuntimePlaybackState {
  const time = Math.max(0, simulationTimeMs)
  const routeMap = new Map(source.routes.map((route) => [route.id, route]))
  const tasks = source.tasks.map((task) => {
    if (preserveOperationalState && (task.status === "CANCELLED" || task.status === "FAILED")) return { ...task }
    const status = logisticsTaskStatusAt(task, time)
    const position = logisticsTaskPosition(task, status, time, routeMap, preserveOperationalState)
    const missionProgress = progressBetween(time, task.plannedTakeoffTimeMs, task.landingTimeMs)
    return {
      ...task,
      status,
      activeRouteId: activeRouteIdAt(task, status, routeMap),
      position,
      speedMps: playbackSpeedMps(task, status, routeMap, preserveOperationalState),
      batteryPercent: round(100 - (100 - Math.min(100, task.batteryPercent)) * missionProgress, 1)
    }
  })
  const tasksByAircraft = new Map<string, LogisticsRuntimeTaskView[]>()
  for (const task of tasks) {
    const items = tasksByAircraft.get(task.aircraftId) ?? []
    items.push(task)
    tasksByAircraft.set(task.aircraftId, items)
  }
  const aircraft = source.aircraft.map((item) => {
    const ownTasks = [...(tasksByAircraft.get(item.id) ?? [])].sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)
    const active = ownTasks.find((task) => !["WAITING_EXECUTION", "AVAILABLE_AGAIN", "CANCELLED", "FAILED"].includes(task.status))
    const future = ownTasks.find((task) => task.status === "WAITING_EXECUTION")
    const recent = [...ownTasks].reverse().find((task) => task.status === "AVAILABLE_AGAIN")
    const relevant = active ?? future ?? recent
    const preserveAbnormal = preserveOperationalState && ["HOLDING", "DIVERTING", "EMERGENCY_LANDING", "DISABLED"].includes(item.status)
    return {
      ...item,
      status: preserveAbnormal ? item.status : logisticsAircraftStatusAt(active, future),
      currentTaskId: active?.scheduleItemId ?? future?.scheduleItemId ?? null,
      currentOrderId: active?.orderId ?? future?.orderId ?? null,
      position: preserveAbnormal ? item.position : relevant?.position ?? item.position,
      speedMps: preserveAbnormal
        ? (Number.isFinite(item.speedMps) ? item.speedMps : 0)
        : relevant?.speedMps ?? (Number.isFinite(item.speedMps) ? item.speedMps : 0),
      batteryPercent: preserveAbnormal ? item.batteryPercent : relevant?.batteryPercent ?? item.batteryPercent
    }
  })
  const taskByOrderId = new Map(tasks.map((task) => [task.orderId, task]))
  const orders = source.orders.map((order) => {
    const task = taskByOrderId.get(order.id)
    const preserveTerminal = preserveOperationalState && (order.status === "FAILED" || order.status === "CANCELLED")
    return {
      ...order,
      status: preserveTerminal ? order.status : logisticsOrderStatusAt(order, task, time),
      assignedAircraftId: task?.aircraftId ?? null,
      scheduleItemId: task?.scheduleItemId ?? null,
      expectedArrivalTimeMs: task?.arrivalTimeMs ?? null
    }
  })
  const airborneStatuses: LogisticsRuntimeAircraftStatus[] = ["TAKING_OFF", "OUTBOUND", "ARRIVED", "RETURNING", "LANDING", "HOLDING", "DIVERTING", "EMERGENCY_LANDING"]
  return {
    tasks,
    aircraft,
    orders,
    summary: {
      ...source.summary,
      totalAircraft: aircraft.length,
      availableAircraft: aircraft.filter((item) => item.status === "AVAILABLE").length,
      assignedAircraft: aircraft.filter((item) => item.status === "ASSIGNED").length,
      airborneAircraft: aircraft.filter((item) => airborneStatuses.includes(item.status)).length,
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
}

function showTimeline(durationMs: number): ShowTimelineSegment[] {
  let cursor = 0
  return showPhaseWeights.map(([phase, title, weight], index) => {
    const startMs = cursor
    const endMs = index === showPhaseWeights.length - 1
      ? durationMs
      : Math.round(durationMs * showPhaseWeights.slice(0, index + 1).reduce((sum, item) => sum + item[2], 0))
    cursor = endMs
    return { phase, title, startMs, endMs }
  })
}

function showSegmentAt(durationMs: number, timeMs: number): ShowTimelineSegment {
  const timeline = showTimeline(durationMs)
  return timeline.find((segment) => timeMs >= segment.startMs && timeMs < segment.endMs) ?? timeline.at(-1)!
}

function showGroupCenter(
  center: V3Coordinate,
  radiusMeters: number,
  maximumHeightMeters: number,
  phase: ShowRuntimePhase,
  progress: number,
  index: number,
  groupCount: number
): V3Coordinate {
  const baseAngle = index / groupCount * Math.PI * 2
  const spread = phase === "TAKEOFF_PREPARATION" ? 0.18
    : phase === "BATCH_TAKEOFF" ? interpolate(0.18, 0.28, progress)
      : phase === "TRANSIT_TO_SHOW" ? interpolate(0.28, 0.68, progress)
        : phase === "PERFORMANCE" ? 0.82 + Math.sin(progress * Math.PI * 4 + baseAngle) * 0.12
          : phase === "RETURN_TO_LAUNCH" ? interpolate(0.68, 0.28, progress)
            : phase === "BATCH_LANDING" ? interpolate(0.28, 0.18, progress)
              : 0.18
  const angle = baseAngle + (phase === "PERFORMANCE" ? progress * Math.PI * 1.35 : 0)
  const radius = radiusMeters * spread
  const latitudeOffset = radius * Math.cos(angle) / 111_320
  const longitudeScale = Math.max(0.1, Math.cos(center.latitude * Math.PI / 180))
  const longitudeOffset = radius * Math.sin(angle) / (111_320 * longitudeScale)
  const altitude = phase === "BATCH_TAKEOFF" ? maximumHeightMeters * 0.48 * progress
    : phase === "TRANSIT_TO_SHOW" ? maximumHeightMeters * interpolate(0.48, 0.72, progress)
      : phase === "PERFORMANCE" ? maximumHeightMeters * (0.78 + Math.sin(progress * Math.PI * 2 + baseAngle) * 0.05)
        : phase === "RETURN_TO_LAUNCH" ? maximumHeightMeters * interpolate(0.72, 0.48, progress)
          : phase === "BATCH_LANDING" ? maximumHeightMeters * 0.48 * (1 - progress)
            : 0
  return {
    longitude: center.longitude + longitudeOffset,
    latitude: center.latitude + latitudeOffset,
    altitudeMeters: Math.max(0, altitude)
  }
}

function showGroupCounts(plannedCount: number, phase: ShowRuntimePhase, progress: number, index: number, groupCount: number) {
  const stagger = clamp(progress * 1.25 - index / groupCount * 0.25, 0, 1)
  const takeoffCount = phase === "TAKEOFF_PREPARATION" ? 0
    : phase === "BATCH_TAKEOFF" ? Math.round(plannedCount * stagger)
      : plannedCount
  const landedCount = phase === "BATCH_LANDING" ? Math.round(plannedCount * stagger)
    : phase === "COMPLETED" || phase === "ABORTED" ? plannedCount
      : 0
  const airborneCount = Math.max(0, takeoffCount - landedCount)
  return {
    airborneCount,
    landedCount,
    normalCount: plannedCount,
    warningCount: 0,
    abnormalCount: 0,
    lostCount: 0
  }
}

function showGroupStatus(phase: ShowRuntimePhase, airborneCount: number, landedCount: number): ShowRuntimeGroupStatus {
  if (phase === "BATCH_TAKEOFF") return airborneCount > 0 ? "TAKING_OFF" : "GROUND"
  if (phase === "RETURN_TO_LAUNCH") return "RETURNING"
  if (phase === "BATCH_LANDING") return landedCount > 0 && airborneCount === 0 ? "LANDED" : "LANDING"
  if (phase === "COMPLETED" || phase === "ABORTED") return "LANDED"
  if (airborneCount > 0) return "AIRBORNE"
  return "GROUND"
}

function logisticsTaskStatusAt(task: LogisticsRuntimeTaskView, timeMs: number): LogisticsRuntimeTaskStatus {
  const takeoffEnd = Math.min(task.arrivalTimeMs, task.plannedTakeoffTimeMs + phaseDuration(task.plannedTakeoffTimeMs, task.arrivalTimeMs))
  const landingStart = Math.max(task.returnStartTimeMs, task.landingTimeMs - phaseDuration(task.returnStartTimeMs, task.landingTimeMs))
  if (timeMs < task.plannedTakeoffTimeMs) return "WAITING_EXECUTION"
  if (timeMs < takeoffEnd) return "TAKEOFF"
  if (timeMs < task.arrivalTimeMs) return "OUTBOUND"
  if (timeMs < task.returnStartTimeMs) return "ARRIVAL_CONFIRMATION"
  if (timeMs < landingStart) return "RETURNING"
  if (timeMs < task.nextAvailableTimeMs) return "LANDING"
  return "AVAILABLE_AGAIN"
}

function logisticsTaskPosition(
  task: LogisticsRuntimeTaskView,
  status: LogisticsRuntimeTaskStatus,
  timeMs: number,
  routeMap: Map<string, LogisticsRuntimeRouteView>,
  preserveOperationalState: boolean
): V3Coordinate {
  const outbound = routeCoordinates(routeMap.get(task.outboundRouteId))
  const returning = routeCoordinates(routeMap.get(task.returnRouteId))
  // The authoritative task snapshot carries the route selected by runtime actions
  // (for example a verified alternate). Keep that route during interpolation so
  // replay does not jump back to the primary geometry when reconstructing a frame.
  const activeRoute = task.activeRouteId ? routeMap.get(task.activeRouteId) : undefined
  const active = activeRoute && ((status === "TAKEOFF" || status === "OUTBOUND") && activeRoute.direction === "OUTBOUND"
    || (status === "RETURNING" || status === "LANDING") && activeRoute.direction === "RETURN")
    ? routeCoordinates(activeRoute)
    : []
  if (status === "TAKEOFF" || status === "OUTBOUND") return interpolateRoute(active.length > 0 ? active : outbound, progressBetween(timeMs, task.plannedTakeoffTimeMs, task.arrivalTimeMs))
  if (status === "ARRIVAL_CONFIRMATION") return outbound.at(-1) ?? returning[0] ?? task.position
  if (status === "RETURNING" || status === "LANDING") return interpolateRoute(active.length > 0 ? active : returning, progressBetween(timeMs, task.returnStartTimeMs, task.landingTimeMs))
  if (status === "AVAILABLE_AGAIN") return returning.at(-1) ?? outbound[0] ?? task.position
  return outbound[0] ?? returning.at(-1) ?? task.position
}

function activeRouteIdAt(
  task: LogisticsRuntimeTaskView,
  status: LogisticsRuntimeTaskStatus,
  routeMap: Map<string, LogisticsRuntimeRouteView>
): string | null {
  const expectedDirection = status === "TAKEOFF" || status === "OUTBOUND" ? "OUTBOUND"
    : status === "RETURNING" || status === "LANDING" ? "RETURN"
      : null
  if (expectedDirection && task.activeRouteId && routeMap.get(task.activeRouteId)?.direction === expectedDirection) return task.activeRouteId
  if (status === "TAKEOFF" || status === "OUTBOUND") return task.outboundRouteId
  if (status === "RETURNING" || status === "LANDING") return task.returnRouteId
  return null
}

function playbackSpeedMps(task: LogisticsRuntimeTaskView, status: LogisticsRuntimeTaskStatus, routeMap: Map<string, LogisticsRuntimeRouteView>, preserveOperationalState: boolean): number {
  if (preserveOperationalState && Number.isFinite(task.speedMps)) return task.speedMps
  const expectedDirection = status === "TAKEOFF" || status === "OUTBOUND" ? "OUTBOUND"
    : status === "RETURNING" || status === "LANDING" ? "RETURN"
      : null
  const activeRoute = task.activeRouteId ? routeMap.get(task.activeRouteId) : undefined
  const routeId = expectedDirection && activeRoute?.direction === expectedDirection
    ? task.activeRouteId
    : expectedDirection === "OUTBOUND" ? task.outboundRouteId : expectedDirection === "RETURN" ? task.returnRouteId : null
  if (!routeId) return 0
  const points = routeCoordinates(routeMap.get(routeId))
  const duration = status === "TAKEOFF" || status === "OUTBOUND"
    ? task.arrivalTimeMs - task.plannedTakeoffTimeMs
    : task.landingTimeMs - task.returnStartTimeMs
  return round(points.slice(1).reduce((total, point, index) => total + coordinateDistance(points[index]!, point), 0) / Math.max(1, duration / 1_000), 2)
}

function logisticsAircraftStatusAt(active: LogisticsRuntimeTaskView | undefined, future: LogisticsRuntimeTaskView | undefined): LogisticsRuntimeAircraftStatus {
  if (!active) return future ? "ASSIGNED" : "AVAILABLE"
  const mapping: Partial<Record<LogisticsRuntimeTaskStatus, LogisticsRuntimeAircraftStatus>> = {
    TAKEOFF: "TAKING_OFF",
    OUTBOUND: "OUTBOUND",
    ARRIVAL_CONFIRMATION: "ARRIVED",
    RETURNING: "RETURNING",
    LANDING: "LANDING"
  }
  return mapping[active.status] ?? "AVAILABLE"
}

function logisticsOrderStatusAt(order: LogisticsRuntimeOrderView, task: LogisticsRuntimeTaskView | undefined, timeMs: number): LogisticsRuntimeOrderStatus {
  if (!task) return timeMs < order.releaseTimeMs ? "UNRELEASED" : "UNASSIGNED"
  if (task.status === "CANCELLED") return "CANCELLED"
  if (task.status === "FAILED") return "FAILED"
  if (task.status === "AVAILABLE_AGAIN") return task.arrivalTimeMs > order.latestArrivalTimeMs ? "DELAYED" : "COMPLETED"
  if (task.status === "WAITING_EXECUTION") return task.arrivalTimeMs > order.latestArrivalTimeMs ? "EXPECTED_DELAY" : "SCHEDULED"
  return "DELIVERING"
}

function routeCoordinates(route: LogisticsRuntimeRouteView | undefined): V3Coordinate[] {
  return route?.waypoints.map((waypoint) => ({
    longitude: waypoint.position.longitude,
    latitude: waypoint.position.latitude,
    altitudeMeters: waypoint.altitudeMeters
  })) ?? []
}

function interpolateRoute(points: readonly V3Coordinate[], progress: number): V3Coordinate {
  if (points.length === 0) return { longitude: 0, latitude: 0, altitudeMeters: 0 }
  if (points.length === 1) return { ...points[0]! }
  const distances = points.slice(1).map((point, index) => coordinateDistance(points[index]!, point))
  const total = distances.reduce((sum, distance) => sum + distance, 0)
  if (total <= 0) return { ...points[0]! }
  let remaining = clamp(progress, 0, 1) * total
  for (let index = 0; index < distances.length; index += 1) {
    const distance = distances[index]!
    if (remaining <= distance || index === distances.length - 1) {
      const ratio = distance <= 0 ? 0 : remaining / distance
      const start = points[index]!
      const end = points[index + 1]!
      return {
        longitude: interpolate(start.longitude, end.longitude, ratio),
        latitude: interpolate(start.latitude, end.latitude, ratio),
        altitudeMeters: interpolate(start.altitudeMeters ?? 0, end.altitudeMeters ?? 0, ratio)
      }
    }
    remaining -= distance
  }
  return { ...points.at(-1)! }
}

function phaseDuration(startMs: number, endMs: number): number {
  return Math.max(1_000, Math.min(15_000, Math.floor(Math.max(0, endMs - startMs) * 0.15)))
}

function coordinateDistance(left: V3Coordinate, right: V3Coordinate): number {
  const latitude = (left.latitude + right.latitude) / 2 * Math.PI / 180
  const x = (right.longitude - left.longitude) * Math.PI / 180 * Math.cos(latitude)
  const y = (right.latitude - left.latitude) * Math.PI / 180
  return Math.sqrt(x * x + y * y) * 6_371_000
}

function progressBetween(value: number, start: number, end: number): number {
  if (value <= start) return 0
  if (value >= end) return 1
  return (value - start) / Math.max(1, end - start)
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * clamp(progress, 0, 1)
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : minimum))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
