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
import { distance3d, horizontalDistance, interpolate, pointInPolygon, toGeo, toLocal } from "./geo.js"

interface CompiledRoute {
  drone: DronePlan
  points: LocalPoint[]
  segmentLengths: number[]
  segmentSpeeds: number[]
  totalLength: number
  duration: number
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
  const segmentLengths: number[] = []
  const segmentSpeeds: number[] = []
  let totalLength = 0
  let duration = drone.takeoffDelaySeconds
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
  }

  return { drone, points, segmentLengths, segmentSpeeds, totalLength, duration }
}

function stateAt(input: SimulationInput, route: CompiledRoute, timeSeconds: number): { point: LocalPoint; speed: number; distance: number; status: DroneTrackSample["status"] } {
  if (timeSeconds <= route.drone.takeoffDelaySeconds || route.points.length < 2) {
    return { point: route.points[0] ?? { east: 0, north: 0, up: 0 }, speed: 0, distance: 0, status: "WAITING" }
  }

  let remainingTime = timeSeconds - route.drone.takeoffDelaySeconds
  let travelledDistance = 0

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
      return { point, speed, distance: travelledDistance + length * ratio, status: "FLYING" }
    }
    remainingTime -= segmentDuration + (route.drone.waypoints[index + 1]?.waitSeconds ?? 0)
    travelledDistance += length
  }

  return {
    point: route.points.at(-1) ?? { east: 0, north: 0, up: 0 },
    speed: 0,
    distance: route.totalLength,
    status: "COMPLETED"
  }
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

  for (let tick = 0; tick <= tickCount; tick += 1) {
    const timeSeconds = Math.min(durationSeconds, tick * stepSeconds)
    const states = routes.map((route) => {
      const state = stateAt(input, route, timeSeconds)
      const geo = toGeo(input.scene.origin, state.point)
      tracks.get(route.drone.droneId)!.samples.push({
        timeSeconds,
        position: geo,
        speedMps: state.speed,
        distanceMeters: state.distance,
        status: state.status
      })
      return { route, state, geo }
    })

    for (const item of states) {
      const droneId = item.route.drone.droneId
      if (!pointInPolygon(item.state.point, boundary)) {
        addOrExtendFinding(activeFindings, completedFindings, {
          ruleCode: "OUT_OF_BOUNDS", severity: "ERROR", title: "无人机超出作业边界",
          message: `${droneId} 已离开教师配置的作业区域`, startTimeSeconds: timeSeconds,
          objectIds: [droneId, input.scene.boundary.id], position: item.geo,
          measuredValue: null, thresholdValue: null, suggestion: "调整航点，使完整航迹保持在作业边界内"
        }, tick, stepSeconds)
      }
      for (const zone of zones) {
        if (item.state.point.up >= zone.minimumAltitudeMeters && item.state.point.up <= zone.maximumAltitudeMeters && pointInPolygon(item.state.point, zone.local)) {
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
        const insideHorizontal = Math.abs(item.state.point.east - obstacle.local.east) <= obstacle.widthMeters / 2
          && Math.abs(item.state.point.north - obstacle.local.north) <= obstacle.lengthMeters / 2
        if (insideHorizontal && item.state.point.up >= 0 && item.state.point.up <= obstacle.heightMeters) {
          addOrExtendFinding(activeFindings, completedFindings, {
            ruleCode: "OBSTACLE", severity: "ERROR", title: "航迹穿越障碍物",
            message: `${droneId} 与 ${obstacle.name} 的简化碰撞体相交`, startTimeSeconds: timeSeconds,
            objectIds: [droneId, obstacle.id], position: item.geo,
            measuredValue: item.state.point.up, thresholdValue: obstacle.heightMeters,
            suggestion: "提高飞行高度或调整航迹绕开障碍物"
          }, tick, stepSeconds)
        }
      }
    }

    for (let leftIndex = 0; leftIndex < states.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < states.length; rightIndex += 1) {
        const left = states[leftIndex]!
        const right = states[rightIndex]!
        if (left.state.status === "WAITING" && right.state.status === "WAITING") continue
        const horizontal = horizontalDistance(left.state.point, right.state.point)
        const vertical = Math.abs(left.state.point.up - right.state.point.up)
        if (horizontal < input.scene.rules.horizontalSeparationMeters && vertical < input.scene.rules.verticalSeparationMeters) {
          addOrExtendFinding(activeFindings, completedFindings, {
            ruleCode: "SEPARATION", severity: "ERROR", title: "两机安全间距不足",
            message: `${left.route.drone.droneId} 与 ${right.route.drone.droneId} 最近水平间距 ${horizontal.toFixed(1)} m`,
            startTimeSeconds: timeSeconds,
            objectIds: [left.route.drone.droneId, right.route.drone.droneId],
            position: geoAverage(left.geo, right.geo), measuredValue: horizontal,
            thresholdValue: input.scene.rules.horizontalSeparationMeters,
            suggestion: "调整起飞时间、高度层或交叉航段"
          }, tick, stepSeconds)
        }
      }
    }
  }

  completedFindings.push(...[...activeFindings.values()].map((item) => item.finding))

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
      warningCount
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
