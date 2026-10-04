import { describe, expect, it } from "vitest"
import { createDemoPlan, createDemoScene } from "@wurenji/shared"
import { positionAt, runSimulation } from "./simulation.js"

describe("runSimulation", () => {
  function keepOneUnassignedTask(scene: ReturnType<typeof createDemoScene>): void {
    scene.taskPoints = [{
      id: "task-test",
      name: "测试任务点",
      position: { ...scene.takeoffPoint, altitude: 60 },
      payloadKg: 0,
      deadlineSeconds: 600,
      stage: 1
    }]
  }

  it("is deterministic for the same input", () => {
    const scene = createDemoScene()
    const plan = createDemoPlan(scene)
    const input = { scene, plan, stepSeconds: 0.2, seed: 42 }

    const first = runSimulation(input)
    const second = runSimulation(input)

    expect(first.inputHash).toBe(second.inputHash)
    expect(first.summary).toEqual(second.summary)
    expect(first.findings).toEqual(second.findings)
    expect(first.tracks).toEqual(second.tracks)
  })

  it("reports an unassigned task", () => {
    const scene = createDemoScene()
    const plan = createDemoPlan(scene)
    plan.dronePlans.forEach((drone) => {
      drone.assignedTaskIds = drone.assignedTaskIds.filter((taskId) => taskId !== "order-01")
    })

    const result = runSimulation({ scene, plan, stepSeconds: 0.2, seed: 42 })
    expect(result.findings.some((finding) => finding.ruleCode === "TASK_INCOMPLETE" && finding.objectIds.includes("order-01"))).toBe(true)
  })

  it("keeps a waiting drone at its takeoff point", () => {
    const scene = createDemoScene()
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.takeoffDelaySeconds = 10
    const input = { scene, plan, stepSeconds: 0.2, seed: 42 }

    const position = positionAt(input, "U-01", 5)
    expect(position?.longitude).toBeCloseTo(plan.dronePlans[0]!.waypoints[0]!.position.longitude, 8)
    expect(position?.latitude).toBeCloseTo(plan.dronePlans[0]!.waypoints[0]!.position.latitude, 8)
  })

  it("does not count an assigned task as complete unless a route reaches it", () => {
    const scene = createDemoScene()
    const plan = createDemoPlan(scene)
    const drone = plan.dronePlans.find((item) => item.assignedTaskIds.includes("order-01"))!
    drone.waypoints = drone.waypoints.map((waypoint, index) => ({
      ...waypoint,
      position: {
        ...scene.takeoffPoint,
        altitude: index === 0 || index === drone.waypoints.length - 1 ? 0 : 80
      }
    }))

    const result = runSimulation({ scene, plan, stepSeconds: 0.2, seed: 42 })

    expect(result.findings.some((finding) => finding.ruleCode === "TASK_INCOMPLETE" && finding.objectIds.includes("order-01"))).toBe(true)
    expect(result.summary.completedTaskCount).toBeLessThan(result.summary.totalTaskCount)
  })

  it("reports waypoint performance limits", () => {
    const scene = createDemoScene()
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.waypoints[1]!.speedMps = scene.aircraft.maxSpeedMps + 5
    plan.dronePlans[0]!.waypoints[1]!.position.altitude = scene.rules.maximumAltitudeMeters + 20

    const result = runSimulation({ scene, plan, stepSeconds: 0.2, seed: 42 })
    const performanceFindings = result.findings.filter((finding) => finding.ruleCode === "PERFORMANCE_LIMIT")

    expect(performanceFindings.some((finding) => finding.title.includes("速度"))).toBe(true)
    expect(performanceFindings.some((finding) => finding.title.includes("高度"))).toBe(true)
  })

  it("detects a building intersection on a continuous segment", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 1
    scene.noFlyZones = []
    keepOneUnassignedTask(scene)
    scene.rules.horizontalSeparationMeters = 5
    scene.rules.verticalSeparationMeters = 3
    scene.obstacles = [{
      id: "building-test",
      name: "测试建筑",
      center: { longitude: 113.9465, latitude: 22.5371, altitude: 0 },
      widthMeters: 30,
      lengthMeters: 30,
      heightMeters: 80
    }]
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.waypoints = [
      { id: "start", position: { ...scene.takeoffPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 },
      { id: "building-crossing", position: { longitude: 113.9465, latitude: 22.5371, altitude: 40 }, speedMps: 10, waitSeconds: 0 },
      { id: "landing", position: { ...scene.landingPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 }
    ]

    const result = runSimulation({ scene, plan, stepSeconds: 1, seed: 7 })

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: "OBSTACLE", objectIds: expect.arrayContaining(["building-test"]) })
    ]))
    expect(result.summary.obstacleCollisionCount).toBeGreaterThan(0)
    expect(result.summary.executable).toBe(false)
  })

  it("detects an airborne conflict between crossing routes even when a tick skips the crossing point", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 2
    scene.noFlyZones = []
    scene.obstacles = []
    keepOneUnassignedTask(scene)
    scene.rules.horizontalSeparationMeters = 8
    scene.rules.verticalSeparationMeters = 5
    const plan = createDemoPlan(scene)
    const center = scene.takeoffPoint
    plan.dronePlans[0]!.waypoints = [
      { id: "a-start", position: { longitude: center.longitude - 0.00075, latitude: center.latitude, altitude: 60 }, speedMps: 20, waitSeconds: 0 },
      { id: "a-end", position: { longitude: center.longitude + 0.00075, latitude: center.latitude, altitude: 60 }, speedMps: 20, waitSeconds: 0 }
    ]
    plan.dronePlans[1]!.waypoints = [
      { id: "b-start", position: { longitude: center.longitude + 0.00075, latitude: center.latitude, altitude: 60 }, speedMps: 20, waitSeconds: 0 },
      { id: "b-end", position: { longitude: center.longitude - 0.00075, latitude: center.latitude, altitude: 60 }, speedMps: 20, waitSeconds: 0 }
    ]
    plan.dronePlans.forEach((drone) => { drone.takeoffDelaySeconds = 0 })

    const result = runSimulation({ scene, plan, stepSeconds: 1, seed: 8 })
    const separation = result.findings.find((finding) => finding.ruleCode === "SEPARATION")

    expect(separation).toBeDefined()
    expect(separation?.measuredValue).toBeLessThan(scene.rules.horizontalSeparationMeters)
    expect(separation?.objectIds).toEqual(expect.arrayContaining(["U-01", "U-02"]))
    expect(result.summary.airborneConflictCount).toBeGreaterThan(0)
  })

  it("reports completion time separately from the configured execution limit", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 1
    scene.noFlyZones = []
    scene.obstacles = []
    keepOneUnassignedTask(scene)
    scene.rules.maximumDurationSeconds = 5
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.waypoints = [
      { id: "start", position: { ...scene.takeoffPoint, altitude: 0 }, speedMps: 2, waitSeconds: 0 },
      { id: "far", position: { longitude: scene.takeoffPoint.longitude + 0.001, latitude: scene.takeoffPoint.latitude, altitude: 60 }, speedMps: 2, waitSeconds: 0 },
      { id: "landing", position: { ...scene.landingPoint, altitude: 0 }, speedMps: 2, waitSeconds: 0 }
    ]

    const result = runSimulation({ scene, plan, stepSeconds: 1, seed: 9 })

    expect(result.summary.durationSeconds).toBe(scene.rules.maximumDurationSeconds)
    expect(result.summary.completedDroneCount).toBe(0)
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: "TIMEOUT", objectIds: expect.arrayContaining(["U-01"]) })
    ]))
  })

  it("accepts distinct feasible routes when both satisfy the same task and safety constraints", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 1
    scene.noFlyZones = []
    scene.obstacles = []
    scene.rules.minimumTerrainClearanceMeters = 0
    scene.taskPoints = [{
      id: "task-route-choice",
      name: "配送目标",
      position: { longitude: scene.takeoffPoint.longitude + 0.001, latitude: scene.takeoffPoint.latitude, altitude: 60 },
      payloadKg: 0,
      deadlineSeconds: 600,
      stage: 1
    }]
    const direct = createDemoPlan(scene)
    direct.dronePlans[0]!.assignedTaskIds = ["task-route-choice"]
    direct.dronePlans[0]!.waypoints = [
      { id: "start", position: { ...scene.takeoffPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 },
      { id: "target", position: scene.taskPoints[0]!.position, speedMps: 10, waitSeconds: 0 },
      { id: "landing", position: { ...scene.landingPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 }
    ]
    const detour = structuredClone(direct)
    detour.dronePlans[0]!.waypoints = [
      direct.dronePlans[0]!.waypoints[0]!,
      { id: "detour", position: { longitude: scene.takeoffPoint.longitude + 0.0005, latitude: scene.takeoffPoint.latitude + 0.0005, altitude: 60 }, speedMps: 10, waitSeconds: 0 },
      direct.dronePlans[0]!.waypoints[1]!,
      direct.dronePlans[0]!.waypoints[2]!
    ]

    const directResult = runSimulation({ scene, plan: direct, stepSeconds: 1, seed: 13 })
    const detourResult = runSimulation({ scene, plan: detour, stepSeconds: 1, seed: 14 })

    expect(directResult.summary.executable).toBe(true)
    expect(detourResult.summary.executable).toBe(true)
    expect(directResult.summary.completedTaskCount).toBe(1)
    expect(detourResult.summary.completedTaskCount).toBe(1)
    expect(detourResult.summary.totalDistanceMeters).toBeGreaterThan(directResult.summary.totalDistanceMeters)
  })

  it("uses the energy model to distinguish a feasible route from one that needs a battery swap", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 1
    scene.noFlyZones = []
    scene.obstacles = []
    keepOneUnassignedTask(scene)
    scene.aircraft.batteryCapacityWh = 100
    scene.aircraft.reserveEnergyRatio = 0.2
    scene.aircraft.energyConsumptionWhPerMeter = 0.5
    const chargePosition = { longitude: scene.takeoffPoint.longitude + 0.001, latitude: scene.takeoffPoint.latitude, altitude: 60 }
    scene.chargingStations = [{ id: "station-swap", name: "换电站", position: chargePosition, chargeRateWhPerSecond: 10, batterySwapSeconds: 5 }]
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.waypoints = [
      { id: "start", position: { ...scene.takeoffPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 },
      { id: "swap", position: chargePosition, speedMps: 10, waitSeconds: 0 },
      { id: "landing", position: { longitude: scene.takeoffPoint.longitude + 0.002, latitude: scene.takeoffPoint.latitude, altitude: 0 }, speedMps: 10, waitSeconds: 0 }
    ]
    plan.dronePlans[0]!.energyStops = [{ waypointId: "swap", stationId: "station-swap", mode: "SWAP" }]

    const withSwap = runSimulation({ scene, plan, stepSeconds: 1, seed: 10 })
    const withoutSwapPlan = structuredClone(plan)
    withoutSwapPlan.dronePlans[0]!.energyStops = []
    const withoutSwap = runSimulation({ scene, plan: withoutSwapPlan, stepSeconds: 1, seed: 10 })
    const withChargePlan = structuredClone(plan)
    withChargePlan.dronePlans[0]!.energyStops = [{ waypointId: "swap", stationId: "station-swap", mode: "CHARGE", durationSeconds: 5 }]
    const withCharge = runSimulation({ scene, plan: withChargePlan, stepSeconds: 1, seed: 10 })
    const swapTrack = withSwap.tracks[0]!
    const noSwapTrack = withoutSwap.tracks[0]!
    const chargeTrack = withCharge.tracks[0]!

    expect(swapTrack.samples.at(-1)?.energyRemainingWh).toBeGreaterThan(noSwapTrack.samples.at(-1)?.energyRemainingWh ?? Number.POSITIVE_INFINITY)
    expect(chargeTrack.samples.at(-1)?.energyRemainingWh).toBeGreaterThan(noSwapTrack.samples.at(-1)?.energyRemainingWh ?? Number.POSITIVE_INFINITY)
    expect(withSwap.findings.some((finding) => finding.ruleCode === "ENERGY_INSUFFICIENT")).toBe(false)
    expect(withCharge.findings.some((finding) => finding.ruleCode === "ENERGY_INSUFFICIENT")).toBe(false)
    expect(withoutSwap.findings.some((finding) => finding.ruleCode === "ENERGY_INSUFFICIENT")).toBe(true)
    expect(withoutSwap.summary.energyDepletionCount).toBe(1)
    expect(withSwap.summary.minimumRemainingEnergyWh).toBeGreaterThan(withoutSwap.summary.minimumRemainingEnergyWh ?? Number.POSITIVE_INFINITY)
    expect(withSwap.summary.durationSeconds).toBeGreaterThan(withoutSwap.summary.durationSeconds)
  })

  it("rejects an energy stop that is not attached to a configured station", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 1
    scene.noFlyZones = []
    scene.obstacles = []
    keepOneUnassignedTask(scene)
    scene.aircraft.batteryCapacityWh = 100
    scene.aircraft.energyConsumptionWhPerMeter = 0.2
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.waypoints = [
      { id: "start", position: { ...scene.takeoffPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 },
      { id: "landing", position: { ...scene.landingPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 }
    ]
    plan.dronePlans[0]!.energyStops = [{ waypointId: "missing-waypoint", stationId: "missing-station", mode: "SWAP" }]

    const result = runSimulation({ scene, plan, stepSeconds: 1, seed: 11 })

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: "ENERGY_STOP_INVALID", objectIds: expect.arrayContaining(["U-01"]) })
    ]))
  })

  it("applies battery degradation to the usable energy before the route starts", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 1
    scene.noFlyZones = []
    scene.obstacles = []
    keepOneUnassignedTask(scene)
    scene.aircraft.batteryCapacityWh = 100
    scene.aircraft.batteryDegradationRatio = 0.25
    scene.aircraft.energyConsumptionWhPerMeter = 0.1
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.waypoints = [
      { id: "start", position: { ...scene.takeoffPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 },
      { id: "landing", position: { ...scene.landingPoint, altitude: 0 }, speedMps: 10, waitSeconds: 0 }
    ]

    const result = runSimulation({ scene, plan, stepSeconds: 1, seed: 15 })

    expect(result.tracks[0]?.samples[0]?.energyRemainingWh).toBeCloseTo(75, 6)
    expect(result.tracks[0]?.samples[0]?.batteryPercent).toBeCloseTo(100, 6)
  })

  it("reports insufficient terrain clearance from waypoint ground heights", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 1
    scene.noFlyZones = []
    scene.obstacles = []
    keepOneUnassignedTask(scene)
    scene.rules.minimumTerrainClearanceMeters = 20
    const plan = createDemoPlan(scene)
    plan.dronePlans[0]!.waypoints = [
      { id: "start", position: { ...scene.takeoffPoint, altitude: 0, groundHeightMeters: 0 }, speedMps: 10, waitSeconds: 0 },
      { id: "ridge", position: { longitude: scene.takeoffPoint.longitude + 0.001, latitude: scene.takeoffPoint.latitude, altitude: 40, groundHeightMeters: 35 }, speedMps: 10, waitSeconds: 0 },
      { id: "landing", position: { ...scene.landingPoint, altitude: 0, groundHeightMeters: 0 }, speedMps: 10, waitSeconds: 0 }
    ]

    const result = runSimulation({ scene, plan, stepSeconds: 1, seed: 12 })

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleCode: "GROUND_CLEARANCE", objectIds: expect.arrayContaining(["U-01"]) })
    ]))
    expect(result.summary.groundRiskCount).toBeGreaterThan(0)
  })

  it("runs a 20-drone scenario within the MVP five-second target", () => {
    const scene = createDemoScene()
    scene.aircraft.count = 20
    scene.rules.maximumDurationSeconds = 300
    const plan = createDemoPlan(scene)
    const startedAt = performance.now()

    const result = runSimulation({ scene, plan, stepSeconds: 0.2, seed: 42 })

    expect(plan.dronePlans).toHaveLength(20)
    expect(result.summary.droneCount).toBe(20)
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  })
})
