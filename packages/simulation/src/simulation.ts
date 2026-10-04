import { createHash } from "node:crypto"
import type {
  DronePlan,
  DroneTrack,
  DroneTrackSample,
  GeoPoint,
  LocalPoint,
  RuleFinding,
  SimulationInput,
  SimulationResult
} from "@wurenji/shared"
import { validatePlan, validateScene } from "@wurenji/shared"
import { distance3d, horizontalDistance, interpolate, pointInPolygon, segmentIntersectsBox, segmentIntersectsPolygon, toGeo, toLocal } from "./geo.js"

interface CompiledRoute {
  drone: DronePlan
  points: LocalPoint[]
  segmentLengths: number[]
  segmentSpeeds: number[]
  totalLength: number
  duration: number
  terrainHeights: Array<number | undefined>
  energyPerMeter: number | null
  energyStops: CompiledEnergyStop[]
}

interface CompiledEnergyStop {
  waypointIndex: number
  stationId: string
  mode: "CHARGE" | "SWAP"
  durationSeconds: number
  energyWh: number
  valid: boolean
  reason?: string
}

interface ActiveFinding {
  finding: RuleFinding
  lastTick: number
}

function rainSpeedFactor(level: SimulationInput["scene"]["environment"]["rainLevel"]): number {
  if (level === "LIGHT") return 0.92
  if (level === "MODERATE") return 0.8
  if (level === "HEAVY") return 0.65
  return 1
}

function rangeConsumptionFactor(input: SimulationInput): number {
  const rainFactor = input.scene.environment.rainLevel === "HEAVY"
    ? 1.3
    : input.scene.environment.rainLevel === "MODERATE"
      ? 1.15
      : input.scene.environment.rainLevel === "LIGHT"
        ? 1.05
        : 1
  const windFactor = input.scene.environment.wind.enabled
    ? 1 + input.scene.environment.wind.speedMps * 0.01
    : 1
  return rainFactor * windFactor
}

function compileRoute(input: SimulationInput, drone: DronePlan): CompiledRoute {
  const points = drone.waypoints.map((waypoint) => toLocal(input.scene.origin, waypoint.position))
  const terrainHeights = drone.waypoints.map((waypoint) => waypoint.position.groundHeightMeters === undefined
    ? undefined
    : waypoint.position.groundHeightMeters - input.scene.origin.altitude)
  const segmentLengths: number[] = []
  const segmentSpeeds: number[] = []
  const energyStops = compileEnergyStops(input, drone, points)
  let totalLength = 0
  let duration = drone.takeoffDelaySeconds + energyStops
    .filter((stop) => stop.valid && stop.waypointIndex === 0)
    .reduce((sum, stop) => sum + stop.durationSeconds, 0)
  const weatherFactor = rainSpeedFactor(input.scene.environment.rainLevel)
  const headwindFactor = input.scene.environment.wind.enabled
    ? Math.max(0.65, 1 - input.scene.environment.wind.speedMps * 0.012)
    : 1

  for (let index = 0; index < points.length - 1; index += 1) {
    const length = distance3d(points[index]!, points[index + 1]!)
    const requestedSpeed = drone.waypoints[index + 1]?.speedMps ?? input.scene.aircraft.cruiseSpeedMps
    const speed = Math.max(0.5, Math.min(requestedSpeed, input.scene.aircraft.maxSpeedMps) * weatherFactor * headwindFactor)
    segmentLengths.push(length)
    segmentSpeeds.push(speed)
    totalLength += length
    duration += length / speed + (drone.waypoints[index + 1]?.waitSeconds ?? 0)
    duration += energyStops
      .filter((stop) => stop.valid && stop.waypointIndex === index + 1)
      .reduce((sum, stop) => sum + stop.durationSeconds, 0)
  }

  return {
    drone,
    points,
    segmentLengths,
    segmentSpeeds,
    totalLength,
    duration,
    terrainHeights,
    energyPerMeter: energyConsumptionPerMeter(input),
    energyStops
  }
}

function energyConsumptionPerMeter(input: SimulationInput): number | null {
  const configured = input.scene.aircraft.energyConsumptionWhPerMeter
  if (Number.isFinite(configured) && (configured ?? 0) > 0) return configured!
  const capacity = input.scene.aircraft.batteryCapacityWh
  const maxRange = input.scene.aircraft.maxRangeMeters
  if (Number.isFinite(capacity) && (capacity ?? 0) > 0 && Number.isFinite(maxRange) && maxRange > 0) return capacity! / maxRange
  return null
}

function compileEnergyStops(input: SimulationInput, drone: DronePlan, points: LocalPoint[]): CompiledEnergyStop[] {
  const capacity = input.scene.aircraft.batteryCapacityWh
  const stations = input.scene.chargingStations ?? []
  return (drone.energyStops ?? []).map((stop) => {
    const waypointIndex = drone.waypoints.findIndex((waypoint) => waypoint.id === stop.waypointId)
    const station = stations.find((item) => item.id === stop.stationId)
    if (waypointIndex < 0) return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds: 0, energyWh: 0, valid: false, reason: "航点不存在" }
    if (!station) return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds: 0, energyWh: 0, valid: false, reason: "能源站不存在" }
    if (!Number.isFinite(capacity) || (capacity ?? 0) <= 0) return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds: 0, energyWh: 0, valid: false, reason: "场景未设置电池容量" }
    const stationPoint = toLocal(input.scene.origin, station.position)
    const distance = horizontalDistance(points[waypointIndex]!, stationPoint)
    if (distance > 30) return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds: 0, energyWh: 0, valid: false, reason: `航点与能源站相距 ${distance.toFixed(1)} m` }
    const verticalDistance = Math.abs(points[waypointIndex]!.up - stationPoint.up)
    if (verticalDistance > 20) return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds: 0, energyWh: 0, valid: false, reason: `航点与能源站高差 ${verticalDistance.toFixed(1)} m` }
    const durationSeconds = stop.durationSeconds ?? (stop.mode === "SWAP" ? station.batterySwapSeconds : undefined) ?? 0
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds: 0, energyWh: 0, valid: false, reason: "能源服务时长无效" }
    const energyWh = stop.mode === "SWAP"
      ? capacity!
      : Number.isFinite(station.chargeRateWhPerSecond) && station.chargeRateWhPerSecond > 0
        ? Math.min(capacity!, station.chargeRateWhPerSecond * durationSeconds)
        : 0
    if (energyWh <= 0) return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds, energyWh: 0, valid: false, reason: "能源站充电功率无效" }
    return { waypointIndex, stationId: stop.stationId, mode: stop.mode, durationSeconds, energyWh, valid: true }
  })
}

interface SimulationState {
  point: LocalPoint
  speed: number
  distance: number
  status: DroneTrackSample["status"]
  segmentIndex: number
}

function stateAt(input: SimulationInput, route: CompiledRoute, timeSeconds: number): SimulationState {
  if (timeSeconds <= route.drone.takeoffDelaySeconds || route.points.length < 2) {
    return { point: route.points[0] ?? { east: 0, north: 0, up: 0 }, speed: 0, distance: 0, status: "WAITING", segmentIndex: -1 }
  }

  let remainingTime = timeSeconds - route.drone.takeoffDelaySeconds
  let travelledDistance = 0

  for (const stop of route.energyStops.filter((item) => item.valid && item.waypointIndex === 0)) {
    if (remainingTime <= stop.durationSeconds) return { point: route.points[0]!, speed: 0, distance: 0, status: "WAITING", segmentIndex: -1 }
    remainingTime -= stop.durationSeconds
  }

  for (let index = 0; index < route.segmentLengths.length; index += 1) {
    const length = route.segmentLengths[index]!
    const speed = route.segmentSpeeds[index]!
    const segmentDuration = length / speed
    if (remainingTime <= segmentDuration) {
      const ratio = Math.max(0, Math.min(1, remainingTime / segmentDuration))
      const point = interpolate(route.points[index]!, route.points[index + 1]!, ratio)
      const wind = input.scene.environment.wind
      if (wind.enabled) {
        const windRadians = wind.directionDegrees * Math.PI / 180
        const drift = wind.speedMps * 0.015 * timeSeconds
        point.east += Math.sin(windRadians) * drift
        point.north += Math.cos(windRadians) * drift
      }
      point.east += input.scene.environment.magneticDriftMeters * Math.sin(timeSeconds * 0.05)
      return { point, speed, distance: travelledDistance + length * ratio, status: "FLYING", segmentIndex: index }
    }
    remainingTime -= segmentDuration
    const waitSeconds = route.drone.waypoints[index + 1]?.waitSeconds ?? 0
    if (remainingTime <= waitSeconds) return { point: route.points[index + 1]!, speed: 0, distance: travelledDistance + length, status: "WAITING", segmentIndex: index }
    remainingTime -= waitSeconds
    for (const stop of route.energyStops.filter((item) => item.valid && item.waypointIndex === index + 1)) {
      if (remainingTime <= stop.durationSeconds) return { point: route.points[index + 1]!, speed: 0, distance: travelledDistance + length, status: "WAITING", segmentIndex: index }
      remainingTime -= stop.durationSeconds
    }
    travelledDistance += length
  }

  return {
    point: route.points.at(-1) ?? { east: 0, north: 0, up: 0 },
    speed: 0,
    distance: route.totalLength,
    status: "COMPLETED",
    segmentIndex: route.segmentLengths.length - 1
  }
}

function effectiveBatteryCapacity(input: SimulationInput): number | null {
  const capacity = input.scene.aircraft.batteryCapacityWh
  if (!Number.isFinite(capacity) || (capacity ?? 0) <= 0) return null
  const degradation = Math.max(0, Math.min(0.9, Number(input.scene.aircraft.batteryDegradationRatio ?? 0)))
  return capacity! * (1 - degradation)
}

function reserveEnergy(input: SimulationInput, capacity: number): number {
  const ratio = Math.max(0, Math.min(0.95, Number(input.scene.aircraft.reserveEnergyRatio ?? 0)))
  return capacity * ratio
}

function payloadForRoute(input: SimulationInput, route: CompiledRoute): number {
  return route.drone.assignedTaskIds.reduce((total, taskId) => total + (input.scene.taskPoints.find((task) => task.id === taskId)?.payloadKg ?? 0), 0)
}

function energyFactor(input: SimulationInput): number {
  return rangeConsumptionFactor(input)
}

function segmentEnergy(input: SimulationInput, route: CompiledRoute, segmentIndex: number): number {
  if (route.energyPerMeter === null) return 0
  const payload = payloadForRoute(input, route)
  const payloadFactor = 1 + Math.max(0, payload) * 0.02
  return route.segmentLengths[segmentIndex]! * route.energyPerMeter * energyFactor(input) * payloadFactor
}

function hoverEnergyPerSecond(input: SimulationInput, route: CompiledRoute): number {
  if (route.energyPerMeter === null) return 0
  const payloadFactor = 1 + Math.max(0, payloadForRoute(input, route)) * 0.02
  // A stationary aircraft still draws a fraction of cruise propulsion power;
  // this fallback keeps legacy scenes deterministic while accounting for air
  // holds when no separate hover-power parameter is supplied.
  return route.energyPerMeter * Math.max(1, input.scene.aircraft.cruiseSpeedMps) * 0.25 * energyFactor(input) * payloadFactor
}

function energyAt(input: SimulationInput, route: CompiledRoute, timeSeconds: number): { remainingEnergyWh: number | null; consumedEnergyWh: number } {
  const capacity = effectiveBatteryCapacity(input)
  if (capacity === null) return { remainingEnergyWh: null, consumedEnergyWh: 0 }
  let remaining = capacity
  let consumed = 0
  if (timeSeconds <= route.drone.takeoffDelaySeconds) return { remainingEnergyWh: remaining, consumedEnergyWh: consumed }
  let remainingTime = timeSeconds - route.drone.takeoffDelaySeconds
  for (const stop of route.energyStops.filter((item) => item.valid && item.waypointIndex === 0)) {
    if (remainingTime <= stop.durationSeconds) {
      const ratio = stop.durationSeconds <= 0 ? 1 : Math.max(0, Math.min(1, remainingTime / stop.durationSeconds))
      remaining = Math.min(capacity, remaining + stop.energyWh * ratio)
      return { remainingEnergyWh: remaining, consumedEnergyWh: consumed }
    }
    remainingTime -= stop.durationSeconds
    remaining = Math.min(capacity, remaining + stop.energyWh)
  }
  for (let index = 0; index < route.segmentLengths.length; index += 1) {
    const segmentDuration = route.segmentLengths[index]! / route.segmentSpeeds[index]!
    const energy = segmentEnergy(input, route, index)
    if (remainingTime <= segmentDuration) {
      const ratio = segmentDuration <= 0 ? 1 : Math.max(0, Math.min(1, remainingTime / segmentDuration))
      consumed += energy * ratio
      remaining = Math.max(0, remaining - energy * ratio)
      return { remainingEnergyWh: remaining, consumedEnergyWh: consumed }
    }
    remainingTime -= segmentDuration
    consumed += energy
    remaining = Math.max(0, remaining - energy)
    const waitSeconds = route.drone.waypoints[index + 1]?.waitSeconds ?? 0
    const hoverEnergy = hoverEnergyPerSecond(input, route) * Math.max(0, waitSeconds)
    if (remainingTime <= waitSeconds) {
      const ratio = waitSeconds <= 0 ? 1 : Math.max(0, Math.min(1, remainingTime / waitSeconds))
      consumed += hoverEnergy * ratio
      remaining = Math.max(0, remaining - hoverEnergy * ratio)
      return { remainingEnergyWh: remaining, consumedEnergyWh: consumed }
    }
    consumed += hoverEnergy
    remaining = Math.max(0, remaining - hoverEnergy)
    remainingTime -= waitSeconds
    for (const stop of route.energyStops.filter((item) => item.valid && item.waypointIndex === index + 1)) {
      if (remainingTime <= stop.durationSeconds) {
        const ratio = stop.durationSeconds <= 0 ? 1 : Math.max(0, Math.min(1, remainingTime / stop.durationSeconds))
        remaining = Math.min(capacity, remaining + stop.energyWh * ratio)
        return { remainingEnergyWh: remaining, consumedEnergyWh: consumed }
      }
      remainingTime -= stop.durationSeconds
      remaining = Math.min(capacity, remaining + stop.energyWh)
    }
  }
  return { remainingEnergyWh: remaining, consumedEnergyWh: consumed }
}

function terrainHeightAt(route: CompiledRoute, distance: number): number {
  if (!route.terrainHeights.some((value) => value !== undefined)) return 0
  let travelled = 0
  for (let index = 0; index < route.segmentLengths.length; index += 1) {
    const length = route.segmentLengths[index]!
    if (distance <= travelled + length) {
      const ratio = length <= 0 ? 0 : Math.max(0, Math.min(1, (distance - travelled) / length))
      const start = route.terrainHeights[index] ?? route.terrainHeights[index + 1] ?? 0
      const end = route.terrainHeights[index + 1] ?? start
      return start + (end - start) * ratio
    }
    travelled += length
  }
  return route.terrainHeights.at(-1) ?? 0
}

function findingId(ruleCode: RuleFinding["ruleCode"], objectIds: string[]): string {
  return `${ruleCode}:${[...objectIds].sort().join(":")}`
}

function addOrExtendFinding(
  active: Map<string, ActiveFinding>,
  completed: RuleFinding[],
  finding: Omit<RuleFinding, "id" | "endTimeSeconds">,
  tick: number,
  stepSeconds: number
): void {
  const id = findingId(finding.ruleCode, finding.objectIds)
  const current = active.get(id)
  if (current && tick - current.lastTick <= 1) {
    current.lastTick = tick
    current.finding.endTimeSeconds = finding.startTimeSeconds
    current.finding.measuredValue = finding.measuredValue
    current.finding.position = finding.position
    return
  }
  if (current) completed.push(current.finding)
  active.set(id, {
    finding: { ...finding, id, endTimeSeconds: finding.startTimeSeconds + stepSeconds },
    lastTick: tick
  })
}

function geoAverage(left: GeoPoint, right: GeoPoint): GeoPoint {
  return {
    longitude: (left.longitude + right.longitude) / 2,
    latitude: (left.latitude + right.latitude) / 2,
    altitude: (left.altitude + right.altitude) / 2
  }
}

function rotateObstaclePoint(point: LocalPoint, center: LocalPoint, headingDegrees = 0): LocalPoint {
  const heading = headingDegrees * Math.PI / 180
  const east = point.east - center.east
  const north = point.north - center.north
  return {
    east: east * Math.cos(heading) + north * Math.sin(heading),
    north: -east * Math.sin(heading) + north * Math.cos(heading),
    up: point.up - center.up
  }
}

function segmentsIntersect2d(a: LocalPoint, b: LocalPoint, c: LocalPoint, d: LocalPoint): boolean {
  const cross = (p: LocalPoint, q: LocalPoint, r: LocalPoint) => (q.east - p.east) * (r.north - p.north) - (q.north - p.north) * (r.east - p.east)
  const on = (p: LocalPoint, q: LocalPoint, r: LocalPoint) => q.east >= Math.min(p.east, r.east) - 1e-9 && q.east <= Math.max(p.east, r.east) + 1e-9 && q.north >= Math.min(p.north, r.north) - 1e-9 && q.north <= Math.max(p.north, r.north) + 1e-9
  const abC = cross(a, b, c); const abD = cross(a, b, d); const cdA = cross(c, d, a); const cdB = cross(c, d, b)
  return ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) && ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
    || Math.abs(abC) < 1e-9 && on(a, c, b) || Math.abs(abD) < 1e-9 && on(a, d, b)
    || Math.abs(cdA) < 1e-9 && on(c, a, d) || Math.abs(cdB) < 1e-9 && on(c, b, d)
}

function segmentLeavesPolygon(start: LocalPoint, end: LocalPoint, polygon: LocalPoint[]): boolean {
  const startInside = pointInPolygon(start, polygon)
  const endInside = pointInPolygon(end, polygon)
  if (!startInside || !endInside) return true
  for (let index = 0; index < polygon.length; index += 1) {
    if (segmentsIntersect2d(start, end, polygon[index]!, polygon[(index + 1) % polygon.length]!)) return true
  }
  return false
}

function separationConflictDuringInterval(
  leftStart: LocalPoint,
  leftEnd: LocalPoint,
  rightStart: LocalPoint,
  rightEnd: LocalPoint,
  horizontalLimit: number,
  verticalLimit: number
): { horizontal: number; vertical: number; ratio: number } | null {
  const x0 = leftStart.east - rightStart.east
  const y0 = leftStart.north - rightStart.north
  const vx = (leftEnd.east - leftStart.east) - (rightEnd.east - rightStart.east)
  const vy = (leftEnd.north - leftStart.north) - (rightEnd.north - rightStart.north)
  const a = vx * vx + vy * vy
  const b = 2 * (x0 * vx + y0 * vy)
  const c = x0 * x0 + y0 * y0 - horizontalLimit * horizontalLimit
  let horizontalStart = 0
  let horizontalEnd = 1
  if (a < Number.EPSILON) {
    if (c > 0) return null
  } else {
    const discriminant = b * b - 4 * a * c
    if (discriminant < 0) {
      if (c > 0) return null
    } else {
      const rawStart = (-b - Math.sqrt(discriminant)) / (2 * a)
      const rawEnd = (-b + Math.sqrt(discriminant)) / (2 * a)
      if (rawEnd < 0 || rawStart > 1) return null
      horizontalStart = Math.max(0, rawStart)
      horizontalEnd = Math.min(1, rawEnd)
      if (horizontalStart > horizontalEnd) return null
    }
  }
  const z0 = leftStart.up - rightStart.up
  const vz = (leftEnd.up - leftStart.up) - (rightEnd.up - rightStart.up)
  let verticalStart = 0
  let verticalEnd = 1
  if (Math.abs(vz) < Number.EPSILON) {
    if (Math.abs(z0) > verticalLimit) return null
  } else {
    const first = (-verticalLimit - z0) / vz
    const second = (verticalLimit - z0) / vz
    const rawStart = Math.min(first, second)
    const rawEnd = Math.max(first, second)
    if (rawEnd < 0 || rawStart > 1) return null
    verticalStart = Math.max(0, rawStart)
    verticalEnd = Math.min(1, rawEnd)
    if (verticalStart > verticalEnd) return null
  }
  const start = Math.max(horizontalStart, verticalStart)
  const end = Math.min(horizontalEnd, verticalEnd)
  if (start > end) return null
  const unconstrained = a < Number.EPSILON ? start : Math.max(start, Math.min(end, -b / (2 * a)))
  const left = interpolate(leftStart, leftEnd, unconstrained)
  const right = interpolate(rightStart, rightEnd, unconstrained)
  return { horizontal: horizontalDistance(left, right), vertical: Math.abs(left.up - right.up), ratio: unconstrained }
}

export function runSimulation(input: SimulationInput): SimulationResult {
  const validationIssues = [...validateScene(input.scene), ...validatePlan(input.scene, input.plan)]
  if (validationIssues.some((issue) => issue.severity === "ERROR")) {
    throw new Error(validationIssues.map((issue) => issue.message).join("; "))
  }
  if (input.plan.dronePlans.length > 50) throw new Error("MVP 最多支持 50 架无人机")

  const stepSeconds = Math.max(0.1, Math.min(1, input.stepSeconds))
  const routes = input.plan.dronePlans.map((drone) => compileRoute(input, drone))
  const durationSeconds = Math.min(
    input.scene.rules.maximumDurationSeconds,
    Math.max(0, ...routes.map((route) => route.duration))
  )
  const tracks = new Map<string, DroneTrack>(routes.map((route) => [route.drone.droneId, {
    droneId: route.drone.droneId,
    samples: [],
    totalDistanceMeters: route.totalLength,
    completedAtSeconds: route.duration <= durationSeconds ? route.duration : null
  }]))
  const completedFindings: RuleFinding[] = []
  const activeFindings = new Map<string, ActiveFinding>()
  const boundary = input.scene.boundary.positions.map((position) => toLocal(input.scene.origin, position))
  const zones = input.scene.noFlyZones.map((zone) => ({ ...zone, local: zone.positions.map((position) => toLocal(input.scene.origin, position)) }))
  const obstacles = input.scene.obstacles.map((obstacle) => ({ ...obstacle, local: toLocal(input.scene.origin, obstacle.center) }))
  const tickCount = Math.ceil(durationSeconds / stepSeconds)
  const previousStates = new Map<string, { point: LocalPoint; geo: GeoPoint; timeSeconds: number }>()
  const batteryCapacity = effectiveBatteryCapacity(input)
  const reserve = batteryCapacity === null ? 0 : reserveEnergy(input, batteryCapacity)

  for (let tick = 0; tick <= tickCount; tick += 1) {
    const timeSeconds = Math.min(durationSeconds, tick * stepSeconds)
    const states = routes.map((route) => {
      const state = stateAt(input, route, timeSeconds)
      const geo = toGeo(input.scene.origin, state.point)
      const energy = energyAt(input, route, timeSeconds)
      tracks.get(route.drone.droneId)!.samples.push({
        timeSeconds,
        position: geo,
        speedMps: state.speed,
        distanceMeters: state.distance,
        status: state.status,
        ...(energy.remainingEnergyWh === null ? {} : {
          energyRemainingWh: energy.remainingEnergyWh,
          batteryPercent: batteryCapacity === null || batteryCapacity <= 0 ? 0 : energy.remainingEnergyWh / batteryCapacity * 100
        })
      })
      if (energy.remainingEnergyWh !== null && (energy.remainingEnergyWh <= 0 || energy.remainingEnergyWh < reserve) && (state.status !== "WAITING" || state.segmentIndex >= 0)) {
        addOrExtendFinding(activeFindings, completedFindings, {
          ruleCode: "ENERGY_INSUFFICIENT", severity: "ERROR", title: "剩余能量低于返航余度",
          message: `${route.drone.droneId} 在 ${timeSeconds.toFixed(1)} s 时剩余能量 ${energy.remainingEnergyWh.toFixed(1)} Wh，低于返航余度 ${reserve.toFixed(1)} Wh`,
          startTimeSeconds: timeSeconds, objectIds: [route.drone.droneId], position: geo,
          measuredValue: energy.remainingEnergyWh, thresholdValue: reserve,
          suggestion: "缩短航线、调整任务顺序或在能源站充电/更换电池"
        }, tick, stepSeconds)
      }
      return { route, state, geo }
    })

    for (const item of states) {
      const droneId = item.route.drone.droneId
      const previous = previousStates.get(droneId)
      const boundaryExit = previous
        ? segmentLeavesPolygon(previous.point, item.state.point, boundary)
        : !pointInPolygon(item.state.point, boundary)
      if (boundaryExit) {
        addOrExtendFinding(activeFindings, completedFindings, {
          ruleCode: "OUT_OF_BOUNDS", severity: "ERROR", title: "无人机超出作业边界",
          message: `${droneId} 已离开教师配置的作业区域`, startTimeSeconds: timeSeconds,
          objectIds: [droneId, input.scene.boundary.id], position: item.geo,
          measuredValue: null, thresholdValue: null, suggestion: "调整航点，使完整航迹保持在作业边界内"
        }, tick, stepSeconds)
      }
      for (const zone of zones) {
        const segmentAltitudeOverlaps = !previous
          || Math.max(previous.point.up, item.state.point.up) >= zone.minimumAltitudeMeters
            && Math.min(previous.point.up, item.state.point.up) <= zone.maximumAltitudeMeters
        if (segmentAltitudeOverlaps && (pointInPolygon(item.state.point, zone.local) || previous && segmentIntersectsPolygon(previous.point, item.state.point, zone.local))) {
          addOrExtendFinding(activeFindings, completedFindings, {
            ruleCode: "NO_FLY_ZONE", severity: "ERROR", title: "航线进入禁飞区",
            message: `${droneId} 进入 ${zone.name}`, startTimeSeconds: timeSeconds,
            objectIds: [droneId, zone.id], position: item.geo,
            measuredValue: item.state.point.up, thresholdValue: zone.maximumAltitudeMeters,
            suggestion: "调整航点或高度，绕开禁飞区"
          }, tick, stepSeconds)
        }
      }
      for (const obstacle of obstacles) {
        const obstacleCurrent = rotateObstaclePoint(item.state.point, obstacle.local, obstacle.headingDegrees)
        const insideObstacle = segmentIntersectsBox(obstacleCurrent, obstacleCurrent, { east: 0, north: 0, up: 0 }, obstacle.widthMeters, obstacle.lengthMeters, obstacle.heightMeters)
        if (insideObstacle) {
          addOrExtendFinding(activeFindings, completedFindings, {
            ruleCode: "OBSTACLE", severity: "ERROR", title: "航迹穿越障碍物",
            message: `${droneId} 与 ${obstacle.name} 的简化碰撞体相交`, startTimeSeconds: timeSeconds,
            objectIds: [droneId, obstacle.id], position: item.geo,
            measuredValue: item.state.point.up, thresholdValue: obstacle.heightMeters,
            suggestion: "提高飞行高度或调整航迹绕开障碍物"
          }, tick, stepSeconds)
        }
        if (previous && segmentIntersectsBox(
          rotateObstaclePoint(previous.point, obstacle.local, obstacle.headingDegrees),
          obstacleCurrent,
          { east: 0, north: 0, up: 0 },
          obstacle.widthMeters,
          obstacle.lengthMeters,
          obstacle.heightMeters
        )) {
          addOrExtendFinding(activeFindings, completedFindings, {
            ruleCode: "OBSTACLE", severity: "ERROR", title: "航迹穿越障碍物",
            message: `${droneId} 的连续航段穿过 ${obstacle.name} 碰撞体`, startTimeSeconds: previous.timeSeconds,
            objectIds: [droneId, obstacle.id], position: geoAverage(previous.geo, item.geo),
            measuredValue: Math.max(0, item.state.point.up), thresholdValue: obstacle.heightMeters,
            suggestion: "提高飞行高度或调整航迹绕开障碍物"
          }, tick, stepSeconds)
        }
      }
      // A terrain clearance result is meaningful only when the route carries
      // sampled ground elevations. A missing terrain profile must not be
      // treated as elevation 0 (which would falsely reject take-off climbs).
      if (item.state.status === "FLYING" && item.route.terrainHeights.some((value) => value !== undefined)) {
        const terrainHeight = terrainHeightAt(item.route, item.state.distance)
        const clearance = item.state.point.up - terrainHeight
        const minimumClearance = input.scene.rules.minimumTerrainClearanceMeters ?? input.scene.rules.minimumAltitudeMeters
        if (clearance < minimumClearance) {
          addOrExtendFinding(activeFindings, completedFindings, {
            ruleCode: "GROUND_CLEARANCE", severity: "ERROR", title: "地面净空不足",
            message: `${droneId} 当前地面净空 ${clearance.toFixed(1)} m，低于运行下限 ${minimumClearance.toFixed(1)} m`,
            startTimeSeconds: timeSeconds, objectIds: [droneId], position: item.geo,
            measuredValue: clearance, thresholdValue: minimumClearance,
            suggestion: "提高航段高度并重新检查地形净空"
          }, tick, stepSeconds)
        }
      }
    }

    for (let leftIndex = 0; leftIndex < states.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < states.length; rightIndex += 1) {
        const left = states[leftIndex]!
        const right = states[rightIndex]!
        if (left.state.status === "WAITING" && right.state.status === "WAITING") continue
        const leftPrevious = previousStates.get(left.route.drone.droneId)
        const rightPrevious = previousStates.get(right.route.drone.droneId)
        const interval = leftPrevious && rightPrevious
          ? separationConflictDuringInterval(
            leftPrevious.point,
            left.state.point,
            rightPrevious.point,
            right.state.point,
            input.scene.rules.horizontalSeparationMeters,
            input.scene.rules.verticalSeparationMeters
          )
          : (() => {
            const horizontal = horizontalDistance(left.state.point, right.state.point)
            const vertical = Math.abs(left.state.point.up - right.state.point.up)
            return horizontal < input.scene.rules.horizontalSeparationMeters && vertical < input.scene.rules.verticalSeparationMeters
              ? { horizontal, vertical, ratio: 1 }
              : null
          })()
        if (!interval) continue
        const horizontal = interval.horizontal
        const vertical = interval.vertical
        addOrExtendFinding(activeFindings, completedFindings, {
            ruleCode: "SEPARATION", severity: "ERROR", title: "两机安全间距不足",
            message: `${left.route.drone.droneId} 与 ${right.route.drone.droneId} 最近水平间距 ${horizontal.toFixed(1)} m`,
            startTimeSeconds: leftPrevious && rightPrevious
              ? Math.max(0, timeSeconds - stepSeconds + stepSeconds * interval.ratio)
              : timeSeconds,
            objectIds: [left.route.drone.droneId, right.route.drone.droneId],
            position: geoAverage(left.geo, right.geo), measuredValue: horizontal,
            thresholdValue: input.scene.rules.horizontalSeparationMeters,
            suggestion: "调整起飞时间、高度层或交叉航段"
          }, tick, stepSeconds)
      }
    }

    for (const item of states) {
      previousStates.set(item.route.drone.droneId, { point: item.state.point, geo: item.geo, timeSeconds })
    }
  }

  completedFindings.push(...[...activeFindings.values()].map((item) => item.finding))

  const terrainRequired = (input.scene.rules.minimumTerrainClearanceMeters ?? 0) > 0
  if (terrainRequired && routes.some((route) => !route.terrainHeights.some((value) => value !== undefined))) {
    completedFindings.push({
      id: findingId("GROUND_CLEARANCE", [input.scene.id, "MISSING_TERRAIN"]),
      ruleCode: "GROUND_CLEARANCE", severity: "ERROR", title: "地面净空数据缺失",
      message: "已配置地面净空阈值，但至少一条航线缺少完整地面高程，不能判定方案可执行",
      startTimeSeconds: 0, endTimeSeconds: durationSeconds, objectIds: [input.scene.id], position: null,
      measuredValue: null, thresholdValue: input.scene.rules.minimumTerrainClearanceMeters ?? null,
      suggestion: "加载覆盖全部航段的地形高程数据后重新仿真"
    })
  }

  // A route that reaches zero usable energy cannot be marked as landed even if
  // the geometric path has a final waypoint. The remaining-energy result is
  // authoritative for execution feasibility.
  for (const route of routes) {
    const finalEnergy = energyAt(input, route, durationSeconds).remainingEnergyWh
    if (finalEnergy !== null && finalEnergy <= 0) {
      const track = tracks.get(route.drone.droneId)
      if (track) track.completedAtSeconds = null
    }
  }

  for (const route of routes) {
    for (const stop of route.energyStops.filter((item) => !item.valid)) {
      completedFindings.push({
        id: findingId("ENERGY_STOP_INVALID", [route.drone.droneId, stop.stationId, String(stop.waypointIndex)]),
        ruleCode: "ENERGY_STOP_INVALID", severity: "ERROR", title: "能源服务点无效",
        message: `${route.drone.droneId} 的能源服务点 ${stop.stationId} 无法执行：${stop.reason ?? "参数不完整"}`,
        startTimeSeconds: 0, endTimeSeconds: route.duration, objectIds: [route.drone.droneId, stop.stationId], position: null,
        measuredValue: null, thresholdValue: null,
        suggestion: "将能源服务航点设置在能源站位置，并填写有效的充电或换电时长"
      })
    }
  }

  const completedTasks = new Set<string>()
  for (const task of input.scene.taskPoints) {
    const assignedDrones = input.plan.dronePlans.filter((drone) => drone.assignedTaskIds.includes(task.id))
    const taskLocal = toLocal(input.scene.origin, task.position)
    let reachedBy: { droneId: string; timeSeconds: number } | null = null
    let reachedAfterDeadline: { droneId: string; timeSeconds: number } | null = null

    for (const drone of assignedDrones) {
      const track = tracks.get(drone.droneId)
      const reachedSample = track?.samples.find((sample) => {
        const sampleLocal = toLocal(input.scene.origin, sample.position)
        return horizontalDistance(sampleLocal, taskLocal) <= 15 && Math.abs(sampleLocal.up - taskLocal.up) <= 20
      })
      if (!reachedSample) continue
      const reached = { droneId: drone.droneId, timeSeconds: reachedSample.timeSeconds }
      if (reachedSample.timeSeconds <= task.deadlineSeconds && (!reachedBy || reachedSample.timeSeconds < reachedBy.timeSeconds)) reachedBy = reached
      if (reachedSample.timeSeconds > task.deadlineSeconds && (!reachedAfterDeadline || reachedSample.timeSeconds < reachedAfterDeadline.timeSeconds)) reachedAfterDeadline = reached
    }

    if (reachedBy) {
      completedTasks.add(task.id)
    } else if (reachedAfterDeadline) {
      completedFindings.push({
        id: findingId("TIMEOUT", [task.id, reachedAfterDeadline.droneId]), ruleCode: "TIMEOUT", severity: "ERROR",
        title: "任务点到达超时", message: `${task.name} 在规定时限后才被到达`, startTimeSeconds: task.deadlineSeconds,
        endTimeSeconds: reachedAfterDeadline.timeSeconds, objectIds: [task.id, reachedAfterDeadline.droneId], position: task.position,
        measuredValue: reachedAfterDeadline.timeSeconds, thresholdValue: task.deadlineSeconds,
        suggestion: "缩短前序航线、提前起飞或调整任务分配"
      })
    } else {
      const message = assignedDrones.length === 0
        ? `${task.name} 未分配给任何无人机`
        : `${task.name} 已分配，但没有航迹在时限内到达`
      completedFindings.push({
        id: findingId("TASK_INCOMPLETE", [task.id]), ruleCode: "TASK_INCOMPLETE", severity: "ERROR",
        title: "任务未完成", message, startTimeSeconds: 0,
        endTimeSeconds: durationSeconds, objectIds: [task.id], position: task.position,
        measuredValue: 0, thresholdValue: 1, suggestion: "检查任务分配，并增加经过目标位置和高度的航点"
      })
    }
  }

  const rangeFactor = rangeConsumptionFactor(input)
  for (const route of routes) {
    const droneId = route.drone.droneId
    const consumedRange = route.totalLength * rangeFactor
    if (consumedRange > input.scene.aircraft.maxRangeMeters) {
      completedFindings.push({
        id: findingId("RANGE_EXCEEDED", [droneId]), ruleCode: "RANGE_EXCEEDED", severity: "ERROR",
        title: "航程超限", message: `${droneId} 经环境修正后的航程消耗超过上限`, startTimeSeconds: 0,
        endTimeSeconds: durationSeconds, objectIds: [droneId], position: null,
        measuredValue: consumedRange, thresholdValue: input.scene.aircraft.maxRangeMeters,
        suggestion: "缩短航线、减少任务或调整分配"
      })
    }
    if (route.duration > input.scene.rules.maximumDurationSeconds) {
      completedFindings.push({
        id: findingId("TIMEOUT", [droneId]), ruleCode: "TIMEOUT", severity: "ERROR",
        title: "任务超时", message: `${droneId} 无法在最大任务时间内完成`, startTimeSeconds: input.scene.rules.maximumDurationSeconds,
        endTimeSeconds: route.duration, objectIds: [droneId], position: route.drone.waypoints.at(-1)?.position ?? null,
        measuredValue: route.duration, thresholdValue: input.scene.rules.maximumDurationSeconds,
        suggestion: "提高合理速度、缩短路线或调整任务分配"
      })
    }
    const payload = route.drone.assignedTaskIds.reduce((total, taskId) => total + (input.scene.taskPoints.find((task) => task.id === taskId)?.payloadKg ?? 0), 0)
    if (payload > input.scene.aircraft.maxPayloadKg) {
      completedFindings.push({
        id: findingId("PAYLOAD_EXCEEDED", [droneId]), ruleCode: "PAYLOAD_EXCEEDED", severity: "ERROR",
        title: "载重超限", message: `${droneId} 分配载荷超过最大载重`, startTimeSeconds: 0,
        endTimeSeconds: 0, objectIds: [droneId], position: input.scene.takeoffPoint,
        measuredValue: payload, thresholdValue: input.scene.aircraft.maxPayloadKg,
        suggestion: "拆分订单或将任务分配给其他无人机"
      })
    }

    const maximumAltitude = Math.min(input.scene.rules.maximumAltitudeMeters, input.scene.aircraft.maxAltitudeMeters)
    route.drone.waypoints.forEach((waypoint, waypointIndex) => {
      if (waypoint.speedMps > input.scene.aircraft.maxSpeedMps) {
        completedFindings.push({
          id: findingId("PERFORMANCE_LIMIT", [droneId, waypoint.id, "speed"]), ruleCode: "PERFORMANCE_LIMIT", severity: "ERROR",
          title: "航点速度超限", message: `${droneId} 的航点速度超过机型最大速度`, startTimeSeconds: 0,
          endTimeSeconds: 0, objectIds: [droneId, waypoint.id], position: waypoint.position,
          measuredValue: waypoint.speedMps, thresholdValue: input.scene.aircraft.maxSpeedMps,
          suggestion: "降低该航点的航段速度"
        })
      }
      const isGroundEndpoint = (waypointIndex === 0 || waypointIndex === route.drone.waypoints.length - 1) && waypoint.position.altitude === 0
      if (!isGroundEndpoint && (waypoint.position.altitude < input.scene.rules.minimumAltitudeMeters || waypoint.position.altitude > maximumAltitude)) {
        const threshold = waypoint.position.altitude < input.scene.rules.minimumAltitudeMeters
          ? input.scene.rules.minimumAltitudeMeters
          : maximumAltitude
        completedFindings.push({
          id: findingId("PERFORMANCE_LIMIT", [droneId, waypoint.id, "altitude"]), ruleCode: "PERFORMANCE_LIMIT", severity: "ERROR",
          title: "航点高度超限", message: `${droneId} 的航点高度不在允许范围内`, startTimeSeconds: 0,
          endTimeSeconds: 0, objectIds: [droneId, waypoint.id], position: waypoint.position,
          measuredValue: waypoint.position.altitude, thresholdValue: threshold,
          suggestion: "将航点高度调整到教师设置和机型性能允许的范围内"
        })
      }
    })
  }

  const resultTracks = [...tracks.values()]
  const completedTaskCount = completedTasks.size
  const completedDroneCount = resultTracks.filter((track) => track.completedAtSeconds !== null).length
  const errorCount = completedFindings.filter((finding) => finding.severity === "ERROR").length
  const warningCount = completedFindings.filter((finding) => finding.severity === "WARNING").length
  const energyStates = routes.map((route) => energyAt(input, route, durationSeconds))
  const totalEnergyConsumedWh = energyStates.reduce((sum, item) => sum + item.consumedEnergyWh, 0)
  const energyValues = resultTracks.flatMap((track) => track.samples.map((sample) => sample.energyRemainingWh).filter((value): value is number => value !== undefined))
  const minimumRemainingEnergyWh = energyValues.length === 0 ? null : Math.min(...energyValues)
  const energyDepletionCount = new Set(completedFindings.filter((finding) => finding.ruleCode === "ENERGY_INSUFFICIENT").flatMap((finding) => finding.objectIds)).size
  const groundRiskCount = completedFindings.filter((finding) => finding.ruleCode === "GROUND_CLEARANCE").length
  const obstacleCollisionCount = completedFindings.filter((finding) => finding.ruleCode === "OBSTACLE").length
  const airborneConflictCount = completedFindings.filter((finding) => finding.ruleCode === "SEPARATION").length
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex")

  return {
    inputHash: hash,
    createdAt: new Date(0).toISOString(),
    summary: {
      droneCount: routes.length,
      completedDroneCount,
      completedTaskCount,
      totalTaskCount: input.scene.taskPoints.length,
      completionRate: input.scene.taskPoints.length === 0 ? 1 : completedTaskCount / input.scene.taskPoints.length,
      totalDistanceMeters: resultTracks.reduce((total, track) => total + track.totalDistanceMeters, 0),
      durationSeconds,
      errorCount,
      warningCount,
      totalEnergyConsumedWh,
      minimumRemainingEnergyWh,
      energyDepletionCount,
      groundRiskCount,
      obstacleCollisionCount,
      airborneConflictCount,
      executable: errorCount === 0 && completedDroneCount === routes.length && completedTaskCount === input.scene.taskPoints.length
    },
    findings: completedFindings.sort((left, right) => left.startTimeSeconds - right.startTimeSeconds),
    tracks: resultTracks
  }
}

export function routeDuration(input: SimulationInput, droneId: string): number | null {
  const drone = input.plan.dronePlans.find((item) => item.droneId === droneId)
  return drone ? compileRoute(input, drone).duration : null
}

export function routeDistance(input: SimulationInput, droneId: string): number | null {
  const drone = input.plan.dronePlans.find((item) => item.droneId === droneId)
  return drone ? compileRoute(input, drone).totalLength : null
}

export function positionAt(input: SimulationInput, droneId: string, timeSeconds: number): GeoPoint | null {
  const route = routeByIdFor(input).get(droneId)
  return route ? toGeo(input.scene.origin, stateAt(input, route, timeSeconds).point) : null
}

function routeByIdFor(input: SimulationInput): Map<string, CompiledRoute> {
  return new Map(input.plan.dronePlans.map((drone) => [drone.droneId, compileRoute(input, drone)]))
}
