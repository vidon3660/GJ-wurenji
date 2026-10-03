import type {
  ShowRuntimeActionCode,
  ShowRuntimeAvailableActionView,
  ShowRuntimeEnvironmentView,
  ShowRuntimeEventCategory,
  ShowRuntimeGroupStatus,
  ShowRuntimeGroupView,
  ShowRuntimePhase,
  ShowRuntimeTotalsView,
  ShowInitialConditionsConfig,
  V3AlertSeverity,
  V3Coordinate,
  ShowProgramGroupTrack
} from "@wurenji/shared"

export interface ShowRuntimeEngineConfig {
  totalAircraft: number
  groupCount: number
  durationMs: number
  maximumHeightMeters: number
  performanceCenter: V3Coordinate
  performanceRadiusMeters: number
  programTracks?: ShowProgramGroupTrack[]
  initialEnvironment?: ShowInitialConditionsConfig
}

export interface ShowRuntimeEventImpact {
  category: ShowRuntimeEventCategory
  severity: V3AlertSeverity
  affectedCount: number
  affectedGroupIds: string[]
}

export interface ShowRuntimeEngineControl {
  aborted: boolean
  earlyLandedCount: number
  takeoffLimitCount: number | null
  eventImpacts: ShowRuntimeEventImpact[]
  groupRecoveryCounts?: Record<string, number>
  groupStatusOverrides?: Record<string, ShowRuntimeGroupStatus>
}

export interface ShowRuntimeProjection {
  phase: ShowRuntimePhase
  phaseTitle: string
  totals: ShowRuntimeTotalsView
  groups: ShowRuntimeGroupView[]
  environment: ShowRuntimeEnvironmentView
}

interface TimelineSegment {
  phase: Exclude<ShowRuntimePhase, "READY" | "COMPLETED" | "ABORTED">
  startMs: number
  endMs: number
}

const phaseWeights: Array<[TimelineSegment["phase"], number]> = [
  ["TAKEOFF_PREPARATION", 0.08],
  ["BATCH_TAKEOFF", 0.2],
  ["TRANSIT_TO_SHOW", 0.12],
  ["PERFORMANCE", 0.3],
  ["RETURN_TO_LAUNCH", 0.12],
  ["BATCH_LANDING", 0.18]
]

const phaseTitles: Record<ShowRuntimePhase, string> = {
  READY: "待起飞",
  TAKEOFF_PREPARATION: "起飞准备",
  BATCH_TAKEOFF: "分批起飞",
  TRANSIT_TO_SHOW: "前往表演区",
  PERFORMANCE: "表演运行",
  RETURN_TO_LAUNCH: "返回起降区",
  BATCH_LANDING: "分批降落",
  COMPLETED: "表演完成",
  ABORTED: "表演已中止"
}

export function showRuntimeTimeline(durationMs: number): TimelineSegment[] {
  const duration = normalizedDuration(durationMs)
  let cursor = 0
  return phaseWeights.map(([phase, weight], index) => {
    const startMs = cursor
    const endMs = index === phaseWeights.length - 1 ? duration : Math.round(duration * phaseWeights.slice(0, index + 1).reduce((sum, item) => sum + item[1], 0))
    cursor = endMs
    return { phase, startMs, endMs }
  })
}

export function showRuntimePhaseAt(durationMs: number, simulationTimeMs: number, aborted = false): ShowRuntimePhase {
  if (aborted) return "ABORTED"
  const duration = normalizedDuration(durationMs)
  const time = Math.max(0, simulationTimeMs)
  if (time >= duration) return "COMPLETED"
  return showRuntimeTimeline(duration).find((segment) => time >= segment.startMs && time < segment.endMs)?.phase ?? "TAKEOFF_PREPARATION"
}

export function computeShowRuntimeProjection(
  config: ShowRuntimeEngineConfig,
  simulationTimeMs: number,
  control: ShowRuntimeEngineControl
): ShowRuntimeProjection {
  const normalized = normalizeConfig(config)
  const time = Math.max(0, Math.min(normalized.durationMs, simulationTimeMs))
  const phase = showRuntimePhaseAt(normalized.durationMs, time, control.aborted)
  const timeline = showRuntimeTimeline(normalized.durationMs)
  const takeoffSegment = timeline.find((item) => item.phase === "BATCH_TAKEOFF")!
  const landingSegment = timeline.find((item) => item.phase === "BATCH_LANDING")!
  const takeoffProgress = progressBetween(time, takeoffSegment.startMs, takeoffSegment.endMs)
  const landingProgress = progressBetween(time, landingSegment.startMs, landingSegment.endMs)
  const normalTakeoffCount = phase === "TAKEOFF_PREPARATION" ? 0 : Math.round(normalized.totalAircraft * takeoffProgress)
  const takeoffCount = phase === "ABORTED"
    ? Math.max(0, Math.min(normalized.totalAircraft, Math.round(normalTakeoffCount)))
    : Math.min(normalTakeoffCount, control.takeoffLimitCount ?? normalized.totalAircraft)
  const scheduledLanded = phase === "COMPLETED"
    ? takeoffCount
    : phase === "ABORTED"
      ? takeoffCount
      : Math.round(takeoffCount * landingProgress)
  const groupFlightCounts = resolveGroupFlightCounts(normalized, takeoffCount, scheduledLanded, control)
  const landedCount = groupFlightCounts.landed.reduce((sum, value) => sum + value, 0)
  const airborneCount = groupFlightCounts.airborne.reduce((sum, value) => sum + value, 0)
  const groups = buildGroups(normalized, phase, time, groupFlightCounts, control.eventImpacts, control.groupStatusOverrides ?? {})
  const warningCount = groups.reduce((sum, group) => sum + group.warningCount, 0)
  const abnormalCount = groups.reduce((sum, group) => sum + group.abnormalCount, 0)
  const lostCount = groups.reduce((sum, group) => sum + group.lostCount, 0)
  const normalCount = Math.max(0, normalized.totalAircraft - warningCount - abnormalCount - lostCount)
  const totals: ShowRuntimeTotalsView = {
    plannedCount: normalized.totalAircraft,
    takeoffCount,
    airborneCount,
    landedCount,
    normalCount,
    warningCount,
    abnormalCount,
    lostCount
  }
  return {
    phase,
    phaseTitle: phaseTitles[phase],
    totals,
    groups,
    environment: environmentFor(normalized.initialEnvironment, control.eventImpacts)
  }
}

export function showRuntimeActionsFor(totalAircraft: number, sessionStatus: string): ShowRuntimeAvailableActionView[] {
  const count = Math.max(1, Math.floor(totalAircraft))
  const actions: Array<[ShowRuntimeActionCode, string, ShowRuntimeAvailableActionView["targetType"], boolean, number]> = [
    ["ACKNOWLEDGE_ALERT", "确认告警", "ALERT", true, 1],
    ["CONTINUE_MONITORING", "继续监控", "PROGRAM", false, 1],
    ["PAUSE_NEXT_TAKEOFF", "暂停后续起飞", "PROGRAM", false, 1],
    ["RESUME_NEXT_TAKEOFF", "恢复后续起飞", "PROGRAM", false, 1],
    ["PAUSE_PROGRAM", "暂停表演", "PROGRAM", false, 1],
    ["RESUME_PROGRAM", "恢复表演", "PROGRAM", false, 1],
    ["ABORT_PROGRAM", "中止表演", "PROGRAM", false, 1],
    ["SINGLE_LAND", "单架降落", "AIRCRAFT", true, 1],
    ["REMOVE_FROM_MISSION", "移出任务", "AIRCRAFT", true, 1],
    ["BATCH_LAND", "小批量降落", "BATCH", true, 500],
    ["GROUP_RETURN", "分组返航", "GROUP", true, 500],
    ["GROUP_LAND", "分组降落", "GROUP", true, 500],
    ["SWITCH_EMERGENCY_ZONE", "切换应急降落区", "GROUP", true, 500],
    ["MULTI_GROUP_RETURN", "多分组返航", "MULTI_GROUP", true, 3000],
    ["ZONE_LAND", "分区降落", "MULTI_GROUP", true, 3000],
    ["RETURN_ALL", "整体返航", "PROGRAM", false, 1],
    ["EMERGENCY_LAND_ALL", "整体应急降落", "PROGRAM", false, 1]
  ]
  return actions.map(([code, title, targetType, requiresTarget, minimumCount]) => {
    const scaleEnabled = count >= minimumCount
    const stateEnabled = sessionStatus !== "COMPLETED" && sessionStatus !== "ABORTED"
      && (code === "RESUME_PROGRAM" ? sessionStatus === "PAUSED" : code === "PAUSE_PROGRAM" ? sessionStatus === "RUNNING" : true)
    return {
      code,
      title,
      targetType,
      requiresTarget,
      enabled: scaleEnabled && stateEnabled,
      disabledReason: !scaleEnabled ? `当前规模未开放该操作` : !stateEnabled ? "当前运行状态不可执行" : null,
      eligibleTargetIds: []
    }
  })
}

function normalizeConfig(config: ShowRuntimeEngineConfig): Required<ShowRuntimeEngineConfig> {
  const totalAircraft = Math.max(1, Math.floor(config.totalAircraft))
  return {
    totalAircraft,
    groupCount: Math.max(1, Math.min(totalAircraft, Math.floor(config.groupCount))),
    durationMs: normalizedDuration(config.durationMs),
    maximumHeightMeters: Math.max(10, Math.min(500, config.maximumHeightMeters)),
    performanceCenter: config.performanceCenter,
    performanceRadiusMeters: Math.max(20, Math.min(5_000, config.performanceRadiusMeters)),
    programTracks: config.programTracks ?? [],
    initialEnvironment: config.initialEnvironment ?? {
      windDirection: "SE",
      windForceState: "NORMAL",
      gustState: "NONE",
      rainState: "NONE",
      positioningElectromagneticState: "NORMAL",
      communicationControlState: "NORMAL",
      deviceState: "NORMAL",
      deviceImpactScope: "NONE",
      deviceAffectedCount: 0
    }
  }
}

function normalizedDuration(value: number): number {
  return Math.max(1_000, Math.floor(value))
}

function progressBetween(value: number, start: number, end: number): number {
  if (value <= start) return 0
  if (value >= end) return 1
  return (value - start) / Math.max(1, end - start)
}

function buildGroups(
  config: Required<ShowRuntimeEngineConfig>,
  phase: ShowRuntimePhase,
  simulationTimeMs: number,
  flightCounts: { airborne: number[]; landed: number[] },
  impacts: ShowRuntimeEventImpact[],
  statusOverrides: Record<string, ShowRuntimeGroupStatus>
): ShowRuntimeGroupView[] {
  const capacities = splitCount(config.totalAircraft, config.groupCount)
  const airborne = flightCounts.airborne
  const landed = flightCounts.landed
  const effectiveImpacts = [...initialDeviceImpacts(config), ...impacts]
  const warnings = allocateImpact(effectiveImpacts.filter((item) => item.severity === "INFO" || item.severity === "WARNING"), airborne)
  const abnormal = allocateImpact(effectiveImpacts.filter((item) => item.category !== "COMMUNICATION_CONTROL" && (item.severity === "ERROR" || item.severity === "CRITICAL")), airborne)
  const lost = allocateImpact(effectiveImpacts.filter((item) => item.category === "COMMUNICATION_CONTROL" && (item.severity === "ERROR" || item.severity === "CRITICAL")), airborne)
  return capacities.map((plannedCount, index) => {
    const groupId = `G${String(index + 1).padStart(2, "0")}`
    const lostCount = Math.min(airborne[index]!, lost[index]!)
    const abnormalCount = Math.min(Math.max(0, airborne[index]! - lostCount), abnormal[index]!)
    const warningCount = Math.min(Math.max(0, airborne[index]! - lostCount - abnormalCount), warnings[index]!)
    const normalCount = Math.max(0, plannedCount - warningCount - abnormalCount - lostCount)
    const center = groupCenter(config, phase, simulationTimeMs, index)
    return {
      groupId,
      label: `编队 ${index + 1}`,
      plannedCount,
      airborneCount: airborne[index]!,
      landedCount: landed[index]!,
      normalCount,
      warningCount,
      abnormalCount,
      lostCount,
      status: landed[index]! >= plannedCount
        ? "LANDED"
        : statusOverrides[groupId] ?? groupStatus(phase, airborne[index]!, landed[index]!, warningCount, abnormalCount, lostCount),
      center,
      radiusMeters: Math.max(8, Math.sqrt(plannedCount) * 3.5)
    }
  })
}

function resolveGroupFlightCounts(
  config: Required<ShowRuntimeEngineConfig>,
  takeoffCount: number,
  scheduledLandedCount: number,
  control: ShowRuntimeEngineControl
): { airborne: number[]; landed: number[] } {
  const capacities = splitCount(config.totalAircraft, config.groupCount)
  const takeoff = allocateCount(takeoffCount, capacities)
  const landed = allocateCount(scheduledLandedCount, takeoff)
  for (let index = 0; index < capacities.length; index += 1) {
    const groupId = `G${String(index + 1).padStart(2, "0")}`
    const recovered = Math.max(0, Math.floor(control.groupRecoveryCounts?.[groupId] ?? 0))
    landed[index] = Math.min(takeoff[index]!, Math.max(landed[index]!, recovered))
  }
  let remaining = Math.max(0, Math.min(takeoffCount, Math.floor(control.earlyLandedCount)) - landed.reduce((sum, value) => sum + value, 0))
  for (let index = 0; index < capacities.length && remaining > 0; index += 1) {
    const available = Math.max(0, takeoff[index]! - landed[index]!)
    const value = Math.min(available, remaining)
    landed[index]! += value
    remaining -= value
  }
  return {
    airborne: takeoff.map((value, index) => Math.max(0, value - landed[index]!)),
    landed
  }
}

function initialDeviceImpacts(config: Required<ShowRuntimeEngineConfig>): ShowRuntimeEventImpact[] {
  const initial = config.initialEnvironment
  if (initial.deviceState === "NORMAL" || initial.deviceAffectedCount <= 0) return []
  const severe = ["POWER_SYSTEM_ABNORMAL", "FLIGHT_CONTROL_SENSOR_ABNORMAL", "RETURN_LANDING_ABNORMAL"].includes(initial.deviceState)
  const targetGroupCount = initial.deviceImpactScope === "MULTI_GROUP" ? Math.min(2, config.groupCount) : 1
  return [{
    category: "AIRCRAFT_DEVICE",
    severity: severe ? "ERROR" : "WARNING",
    affectedCount: initial.deviceAffectedCount,
    affectedGroupIds: Array.from({ length: targetGroupCount }, (_, index) => `G${String(index + 1).padStart(2, "0")}`)
  }]
}

function splitCount(total: number, groups: number): number[] {
  const base = Math.floor(total / groups)
  const remainder = total % groups
  return Array.from({ length: groups }, (_, index) => base + (index < remainder ? 1 : 0))
}

function allocateCount(total: number, capacities: number[]): number[] {
  let remaining = Math.max(0, Math.floor(total))
  return capacities.map((capacity) => {
    const value = Math.min(capacity, remaining)
    remaining -= value
    return value
  })
}

function allocateImpact(impacts: ShowRuntimeEventImpact[], capacities: number[]): number[] {
  const result = capacities.map(() => 0)
  for (const impact of impacts) {
    const targetIndexes = impact.affectedGroupIds.length
      ? impact.affectedGroupIds.map((id) => Number(id.replace(/\D/g, "")) - 1).filter((index) => index >= 0 && index < capacities.length)
      : capacities.map((_, index) => index)
    let remaining = Math.max(0, Math.floor(impact.affectedCount))
    for (const index of targetIndexes) {
      const available = capacities[index]! - result[index]!
      const value = Math.min(available, remaining)
      result[index]! += value
      remaining -= value
      if (remaining <= 0) break
    }
  }
  return result
}

function groupCenter(config: Required<ShowRuntimeEngineConfig>, phase: ShowRuntimePhase, simulationTimeMs: number, index: number): V3Coordinate {
  const program = config.programTracks?.find((track) => track.groupId === `G${String(index + 1).padStart(2, "0")}`)
  if (program && program.points.length >= 2) {
    const point = interpolateTrack(program.points, simulationTimeMs)
    const latitudeOffset = point.northMeters / 111_320
    const longitudeOffset = point.eastMeters / (111_320 * Math.max(0.1, Math.cos(config.performanceCenter.latitude * Math.PI / 180)))
    const airborne = !["READY", "TAKEOFF_PREPARATION", "COMPLETED", "ABORTED"].includes(phase)
    return {
      longitude: config.performanceCenter.longitude + longitudeOffset,
      latitude: config.performanceCenter.latitude + latitudeOffset,
      altitudeMeters: airborne ? point.upMeters : 0
    }
  }
  const angle = index / config.groupCount * Math.PI * 2
  const spread = phase === "PERFORMANCE" ? 1 : phase === "TRANSIT_TO_SHOW" || phase === "RETURN_TO_LAUNCH" ? 0.62 : 0.28
  const radius = config.performanceRadiusMeters * spread
  const latitudeOffset = radius * Math.cos(angle) / 111_320
  const longitudeOffset = radius * Math.sin(angle) / (111_320 * Math.cos(config.performanceCenter.latitude * Math.PI / 180))
  const airborne = !["READY", "TAKEOFF_PREPARATION", "COMPLETED", "ABORTED"].includes(phase)
  return {
    longitude: config.performanceCenter.longitude + longitudeOffset,
    latitude: config.performanceCenter.latitude + latitudeOffset,
    altitudeMeters: airborne ? config.maximumHeightMeters * (phase === "PERFORMANCE" ? 0.8 : 0.48) : 0
  }
}

function interpolateTrack(points: ShowProgramGroupTrack["points"], timeMs: number) {
  if (timeMs <= points[0]!.timeMs) return points[0]!
  if (timeMs >= points.at(-1)!.timeMs) return points.at(-1)!
  let low = 0
  let high = points.length - 1
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle]!.timeMs <= timeMs) low = middle
    else high = middle
  }
  const left = points[low]!
  const right = points[high]!
  const ratio = (timeMs - left.timeMs) / (right.timeMs - left.timeMs)
  return {
    eastMeters: left.eastMeters + (right.eastMeters - left.eastMeters) * ratio,
    northMeters: left.northMeters + (right.northMeters - left.northMeters) * ratio,
    upMeters: left.upMeters + (right.upMeters - left.upMeters) * ratio
  }
}

function groupStatus(
  phase: ShowRuntimePhase,
  airborneCount: number,
  landedCount: number,
  warningCount: number,
  abnormalCount: number,
  lostCount: number
): ShowRuntimeGroupStatus {
  if (lostCount > 0) return "LOST"
  if (abnormalCount > 0) return "ABNORMAL"
  if (warningCount > 0) return "WARNING"
  if (phase === "BATCH_TAKEOFF") return "TAKING_OFF"
  if (phase === "RETURN_TO_LAUNCH") return "RETURNING"
  if (phase === "BATCH_LANDING") return "LANDING"
  if (airborneCount > 0) return "AIRBORNE"
  if (landedCount > 0 || phase === "COMPLETED" || phase === "ABORTED") return "LANDED"
  return "GROUND"
}

function environmentFor(initial: ShowInitialConditionsConfig, impacts: ShowRuntimeEventImpact[]): ShowRuntimeEnvironmentView {
  const active = new Map(impacts.map((impact) => [impact.category, impact.severity]))
  const weather = active.get("WEATHER")
  const positioning = active.get("POSITIONING_ELECTROMAGNETIC")
  const communication = active.get("COMMUNICATION_CONTROL")
  const equipment = active.get("AIRCRAFT_DEVICE")
  const initialPositioning = initial.positioningElectromagneticState === "CONTINUOUS_INTERFERENCE" || initial.positioningElectromagneticState === "WIDE_AREA_INTERFERENCE"
    ? "LOST"
    : initial.positioningElectromagneticState === "NORMAL" ? "GOOD" : "DEGRADED"
  const initialCommunication = initial.communicationControlState === "SMALL_BATCH_LOST" || initial.communicationControlState === "GROUP_ABNORMAL" || initial.communicationControlState === "MULTI_GROUP_ABNORMAL"
    ? "LOST"
    : initial.communicationControlState === "NORMAL" ? "GOOD" : "DEGRADED"
  const initialEquipment = initial.deviceState === "NORMAL"
    ? "NORMAL"
    : initial.deviceState === "POWER_SYSTEM_ABNORMAL" || initial.deviceState === "FLIGHT_CONTROL_SENSOR_ABNORMAL" || initial.deviceState === "RETURN_LANDING_ABNORMAL" ? "FAULT" : "WARNING"
  return {
    windDirection: initial.windDirection,
    windState: weather === "CRITICAL" || weather === "ERROR" ? "OVER_LIMIT" : weather ? higherState(initial.windForceState, "NEAR_LIMIT", ["NORMAL", "NEAR_LIMIT", "OVER_LIMIT"]) : initial.windForceState,
    gustState: weather === "CRITICAL" ? "CONTINUOUS" : weather ? higherState(initial.gustState, "OCCASIONAL", ["NONE", "OCCASIONAL", "CONTINUOUS"]) : initial.gustState,
    rainState: weather === "CRITICAL" ? "OVER_LIMIT" : weather ? higherState(initial.rainState, "BELOW_LIMIT", ["NONE", "BELOW_LIMIT", "OVER_LIMIT"]) : initial.rainState,
    positioningQuality: positioning === "CRITICAL" || positioning === "ERROR" ? "LOST" : positioning ? higherState(initialPositioning, "DEGRADED", ["GOOD", "DEGRADED", "LOST"]) : initialPositioning,
    electromagneticState: initial.positioningElectromagneticState === "LOCAL_ABNORMAL" || initial.positioningElectromagneticState === "CONTINUOUS_INTERFERENCE" || initial.positioningElectromagneticState === "WIDE_AREA_INTERFERENCE" || Boolean(positioning) ? "INTERFERENCE" : "NORMAL",
    communicationQuality: communication === "CRITICAL" || communication === "ERROR" ? "LOST" : communication ? higherState(initialCommunication, "DEGRADED", ["GOOD", "DEGRADED", "LOST"]) : initialCommunication,
    equipmentState: equipment === "CRITICAL" || equipment === "ERROR" ? "FAULT" : equipment ? higherState(initialEquipment, "WARNING", ["NORMAL", "WARNING", "FAULT"]) : initialEquipment,
    geofenceState: "NORMAL"
  }
}

function higherState<T extends string>(left: T, right: T, order: readonly T[]): T {
  return order.indexOf(left) >= order.indexOf(right) ? left : right
}
