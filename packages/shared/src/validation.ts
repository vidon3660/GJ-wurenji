import type { MissionPlan, PracticeScene, ValidationIssue } from "./types.js"

export function validateScene(scene: PracticeScene): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (scene.aircraft.count < 1 || scene.aircraft.count > 50) {
    issues.push({ severity: "ERROR", code: "AIRCRAFT_COUNT", message: "无人机数量必须在 1 到 50 架之间" })
  }
  if (scene.boundary.positions.length < 3) {
    issues.push({ severity: "ERROR", code: "BOUNDARY", message: "作业边界至少需要 3 个点", objectId: scene.boundary.id })
  }
  if (scene.taskPoints.length === 0) {
    issues.push({ severity: "ERROR", code: "TASK_POINTS", message: "至少需要配置一个目标点或配送点" })
  }
  if (scene.rules.maximumDurationSeconds <= 0 || scene.rules.maximumDurationSeconds > 600) {
    issues.push({ severity: "ERROR", code: "DURATION", message: "最大任务时间必须在 1 到 600 秒之间" })
  }
  if (scene.rules.horizontalSeparationMeters <= 0 || scene.rules.verticalSeparationMeters <= 0) {
    issues.push({ severity: "ERROR", code: "SEPARATION", message: "安全距离必须大于 0" })
  }
  if (scene.environment.wind.speedMps > 15) {
    issues.push({ severity: "WARNING", code: "HIGH_WIND", message: "风速超过 15 m/s，可能导致大部分方案无法完成" })
  }
  if (scene.aircraft.cruiseSpeedMps <= 0 || scene.aircraft.maxSpeedMps <= 0 || scene.aircraft.cruiseSpeedMps > scene.aircraft.maxSpeedMps) {
    issues.push({ severity: "ERROR", code: "AIRCRAFT_SPEED", message: "巡航速度必须大于 0 且不能超过最大速度" })
  }
  if (scene.aircraft.maxRangeMeters <= 0 || scene.aircraft.maxAltitudeMeters <= 0 || scene.aircraft.maxPayloadKg < 0) {
    issues.push({ severity: "ERROR", code: "AIRCRAFT_PERFORMANCE", message: "无人机航程、高度和载重参数不合法" })
  }
  if (scene.rules.minimumAltitudeMeters < 0 || scene.rules.maximumAltitudeMeters <= scene.rules.minimumAltitudeMeters) {
    issues.push({ severity: "ERROR", code: "ALTITUDE_RULE", message: "任务高度范围设置不合法" })
  }
  const scenePoints = [scene.origin, scene.takeoffPoint, scene.landingPoint, ...scene.boundary.positions]
  if (scenePoints.some((point) => !Number.isFinite(point.longitude) || !Number.isFinite(point.latitude) || !Number.isFinite(point.altitude))) {
    issues.push({ severity: "ERROR", code: "COORDINATE", message: "场景中存在无效坐标" })
  }
  for (const zone of scene.noFlyZones) {
    if (zone.positions.length < 3 || zone.maximumAltitudeMeters <= zone.minimumAltitudeMeters) {
      issues.push({ severity: "ERROR", code: "NO_FLY_ZONE", message: `${zone.name} 的边界或高度范围不完整`, objectId: zone.id })
    }
  }
  for (const obstacle of scene.obstacles) {
    if (obstacle.widthMeters <= 0 || obstacle.lengthMeters <= 0 || obstacle.heightMeters <= 0) {
      issues.push({ severity: "ERROR", code: "OBSTACLE", message: `${obstacle.name} 的尺寸必须大于 0`, objectId: obstacle.id })
    }
  }
  for (const task of scene.taskPoints) {
    if (task.deadlineSeconds <= 0 || task.payloadKg < 0) {
      issues.push({ severity: "ERROR", code: "TASK_PARAMETER", message: `${task.name} 的时限或载荷参数不合法`, objectId: task.id })
    }
  }

  return issues
}

export function validatePlan(scene: PracticeScene, plan: MissionPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const assignedTasks = new Set(plan.dronePlans.flatMap((drone) => drone.assignedTaskIds))
  const taskIds = new Set(scene.taskPoints.map((task) => task.id))
  const droneIds = new Set<string>()

  if (plan.sceneId !== scene.id || plan.sceneVersion !== scene.version) {
    issues.push({ severity: "ERROR", code: "SCENE_VERSION", message: "方案与当前发布场景版本不一致" })
  }
  if (plan.dronePlans.length !== scene.aircraft.count) {
    issues.push({ severity: "ERROR", code: "DRONE_COUNT", message: `方案必须配置 ${scene.aircraft.count} 架无人机` })
  }

  for (const drone of plan.dronePlans) {
    if (droneIds.has(drone.droneId)) {
      issues.push({ severity: "ERROR", code: "DRONE_DUPLICATE", message: `${drone.droneId} 重复`, objectId: drone.droneId })
    }
    droneIds.add(drone.droneId)
    if (drone.waypoints.length < 2) {
      issues.push({ severity: "ERROR", code: "ROUTE_INCOMPLETE", message: `${drone.droneId} 至少需要两个航点`, objectId: drone.droneId })
    }
    if (drone.takeoffDelaySeconds < 0) {
      issues.push({ severity: "ERROR", code: "TAKEOFF_DELAY", message: `${drone.droneId} 的起飞延迟不能为负数`, objectId: drone.droneId })
    }
    if (drone.assignedTaskIds.some((taskId) => !taskIds.has(taskId))) {
      issues.push({ severity: "ERROR", code: "TASK_UNKNOWN", message: `${drone.droneId} 分配了不存在的任务`, objectId: drone.droneId })
    }
    if (drone.waypoints.some((waypoint) => waypoint.speedMps <= 0 || !Number.isFinite(waypoint.position.longitude) || !Number.isFinite(waypoint.position.latitude) || !Number.isFinite(waypoint.position.altitude))) {
      issues.push({ severity: "ERROR", code: "WAYPOINT", message: `${drone.droneId} 存在无效航点`, objectId: drone.droneId })
    }
  }
  for (const task of scene.taskPoints) {
    if (!assignedTasks.has(task.id)) {
      issues.push({ severity: "WARNING", code: "TASK_UNASSIGNED", message: `${task.name} 尚未分配`, objectId: task.id })
    }
  }

  return issues
}
