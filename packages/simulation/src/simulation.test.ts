import { describe, expect, it } from "vitest"
import { createDemoPlan, createDemoScene } from "@wurenji/shared"
import { positionAt, runSimulation } from "./simulation.js"

describe("runSimulation", () => {
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
