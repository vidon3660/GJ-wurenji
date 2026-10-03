import { describe, expect, it } from "vitest"
import type { VtlAircraftParameters, VtlRoutePlanView } from "@wurenji/shared"
import { buildVtlRoutePlan, projectVtlRuntime, validateVtlPlan } from "./vtl-runtime.js"

const parameters: VtlAircraftParameters = {
  modelCode: "VTOL-TEACHING-01",
  version: "1.0.0",
  batteryCapacityWh: 1_200,
  reserveEnergyRatio: 0.2,
  verticalPowerWatts: 2_400,
  hoverPowerWatts: 1_800,
  cruisePowerWatts: 900,
  taskPowerWatts: 1_050,
  climbSpeedMps: 4,
  cruiseSpeedMps: 22,
  transitionSpeedMps: 12,
  minimumTransitionHeightMeters: 60,
  maximumOperatingAltitudeMeters: 300
}

function route(): VtlRoutePlanView {
  const waypoints = [
    ["VERTICAL_TAKEOFF", 0, 0, 10],
    ["CLIMB", 0.001, 0, 80],
    ["FORWARD_TRANSITION", 0.002, 0, 90],
    ["FIXED_WING_CRUISE", 0.01, 0, 120],
    ["TASK_EXECUTION", 0.012, 0, 120],
    ["RETURN", 0.003, 0, 120],
    ["BACK_TRANSITION", 0.001, 0, 80],
    ["VERTICAL_LANDING", 0, 0, 10]
  ] as const
  const built = buildVtlRoutePlan({
    routeId: "route-1",
    projectId: "project-1",
    aircraftId: "aircraft-1",
    parameterVersion: parameters.version,
    transitionHeightMeters: 80,
    alternateLandingSiteId: "alt-1",
    alternateLandingSitePosition: { longitude: 0.01, latitude: 0, altitudeMeters: 0 },
    waypoints: waypoints.map(([phase, longitude, latitude, altitudeMeters], index) => ({ id: `wp-${index}`, sequence: index, phase: phase as never, position: { longitude, latitude, altitudeMeters }, altitudeMeters, speedMps: 20, taskObjectId: phase === "TASK_EXECUTION" ? "task-1" : null })),
    parameters
  })
  return built.route
}

describe("VTL runtime model", () => {
  it("calculates eight phase energy segments and terrain clearance", () => {
    const computed = route()
    expect(computed.energySegments).toHaveLength(7)
    expect(computed.totalDistanceMeters).toBeGreaterThan(0)
    expect(computed.totalEnergyWh).toBeGreaterThan(0)
    expect(computed.minimumTerrainClearanceMeters).toBeGreaterThan(0)
    expect(computed.alternateComparison).toMatchObject({ landingSiteId: "alt-1", diversionWaypointId: "wp-4", feasible: true })
    expect(computed.alternateComparison!.alternateDistanceMeters).toBeLessThan(computed.alternateComparison!.nominalReturnDistanceMeters)
    expect(computed.alternateComparison!.alternateArrivalEnergyWh).toBeGreaterThan(computed.reserveEnergyWh)
  })

  it("blocks an alternate route whose arrival energy is below reserve", () => {
    const computed = route()
    const result = buildVtlRoutePlan({
      routeId: "route-far-alternate",
      projectId: "project-1",
      aircraftId: "aircraft-1",
      parameterVersion: parameters.version,
      transitionHeightMeters: 80,
      alternateLandingSiteId: "alt-far",
      alternateLandingSitePosition: { longitude: 1, latitude: 0, altitudeMeters: 0 },
      waypoints: computed.waypoints,
      parameters
    })

    expect(result.route.alternateComparison).toMatchObject({ landingSiteId: "alt-far", feasible: false })
    expect(result.route.alternateComparison!.alternateArrivalEnergyWh).toBeLessThan(result.route.reserveEnergyWh)
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ALTERNATE_ENERGY", category: "ALTERNATE", severity: "CONFLICT" })]))
  })

  it("rejects missing task ownership and accepts a complete assignment", () => {
    const computed = route()
    const base = {
      projectId: "project-1",
      allocationRevision: 1,
      routes: [computed],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: computed.totalDurationSeconds }],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "UNASSIGNED", incompleteReason: null }],
      parameters,
      mainLandingSiteId: "main-1",
      availableAlternateLandingSiteIds: ["alt-1"]
    } as const
    expect(validateVtlPlan({ ...base, assignments: [{ ...base.assignments[0], taskObjectIds: [] }] }).passed).toBe(false)
    expect(validateVtlPlan(base).passed).toBe(true)
  })

  it("rejects a route that does not cover the assigned task sequence", () => {
    const computed = route()
    const routeWithoutTask = {
      ...computed,
      waypoints: computed.waypoints.map((waypoint) => waypoint.phase === "TASK_EXECUTION" ? { ...waypoint, taskObjectId: null } : waypoint)
    }
    const result = validateVtlPlan({
      projectId: "project-1",
      allocationRevision: 1,
      routes: [routeWithoutTask],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: computed.totalDurationSeconds }],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "UNASSIGNED", incompleteReason: null }],
      parameters,
      mainLandingSiteId: "main-1",
      availableAlternateLandingSiteIds: ["alt-1"]
    })
    expect(result.passed).toBe(false)
    expect(result.fleetIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "ROUTE_TASK_MISSING", taskObjectIds: ["task-1"] })]))
  })

  it("detects a timed multi-aircraft separation conflict", () => {
    const firstRoute = route()
    const secondRoute: VtlRoutePlanView = {
      ...firstRoute,
      id: "route-2",
      aircraftId: "aircraft-2",
      waypoints: firstRoute.waypoints.map((waypoint) => ({
        ...waypoint,
        taskObjectId: waypoint.taskObjectId ? "task-2" : null
      }))
    }
    const result = validateVtlPlan({
      projectId: "project-1",
      allocationRevision: 1,
      routes: [firstRoute, secondRoute],
      assignments: [
        { aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: firstRoute.totalDurationSeconds },
        { aircraftId: "aircraft-2", aircraftCode: "VTL-02", groupId: "group-2", available: true, taskObjectIds: ["task-2"], taskSequence: ["task-2"], estimatedDurationSeconds: secondRoute.totalDurationSeconds }
      ],
      taskObjects: [
        { id: "task-1", code: "T-01", title: "目标 1", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "ASSIGNED", incompleteReason: null },
        { id: "task-2", code: "T-02", title: "目标 2", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "ASSIGNED", incompleteReason: null }
      ],
      parameters,
      mainLandingSiteId: "main-1",
      availableAlternateLandingSiteIds: ["alt-1"],
      mainLandingSitePosition: { longitude: 0, latitude: 0, altitudeMeters: 10 }
    })
    expect(result.fleetIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "FLEET_SEPARATION", category: "SPATIAL", severity: "CONFLICT" })]))
  })

  it("projects aircraft, group and overall levels from the same runtime clock", () => {
    const computed = route()
    const projection = projectVtlRuntime({
      simulationTimeMs: computed.energySegments[0]!.durationSeconds * 1_000 + 1,
      routes: [computed],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: computed.totalDurationSeconds }],
      groups: [{ id: "group-1", code: "G-01", title: "一组", aircraftIds: ["aircraft-1"], taskObjectIds: ["task-1"] }],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "UNASSIGNED", incompleteReason: null }]
    })
    expect(projection.aircraft[0]?.phase).toBe("CLIMB")
    expect(projection.groups[0]?.aircraftCount).toBe(1)
    expect(projection.summary.totalAircraft).toBe(1)
  })

  it("completes a task only after its task-execution segment finishes", () => {
    const computed = route()
    const taskSegmentIndex = computed.energySegments.findIndex((segment) => segment.phase === "TASK_EXECUTION")
    const taskSegmentStartMs = computed.energySegments.slice(0, taskSegmentIndex).reduce((sum, segment) => sum + segment.durationSeconds * 1_000, 0)
    const taskSegmentDurationMs = computed.energySegments[taskSegmentIndex]!.durationSeconds * 1_000
    const input = {
      routes: [computed],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: computed.totalDurationSeconds }],
      groups: [{ id: "group-1", code: "G-01", title: "一组", aircraftIds: ["aircraft-1"], taskObjectIds: ["task-1"] }],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "ASSIGNED", incompleteReason: null }]
    } as const
    const executing = projectVtlRuntime({ ...input, simulationTimeMs: taskSegmentStartMs + taskSegmentDurationMs / 2 })
    const completed = projectVtlRuntime({ ...input, simulationTimeMs: taskSegmentStartMs + taskSegmentDurationMs + 1 })

    expect(executing.aircraft[0]).toMatchObject({ phase: "TASK_EXECUTION", currentTaskObjectId: "task-1", completedTaskObjectIds: [] })
    expect(executing.summary.completedTaskObjects).toBe(0)
    expect(completed.aircraft[0]?.completedTaskObjectIds).toEqual(["task-1"])
    expect(completed.summary.completedTaskObjects).toBe(1)
  })

  it("keeps the initial energy at takeoff and decreases it continuously within a segment", () => {
    const computed = route()
    const initialEnergy = computed.energySegments[0]!.remainingEnergyWh + computed.energySegments[0]!.energyWh
    const start = projectVtlRuntime({
      simulationTimeMs: 0,
      routes: [computed],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: computed.totalDurationSeconds }],
      groups: [{ id: "group-1", code: "G-01", title: "一组", aircraftIds: ["aircraft-1"], taskObjectIds: ["task-1"] }],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "UNASSIGNED", incompleteReason: null }]
    })
    const partial = projectVtlRuntime({
      simulationTimeMs: computed.energySegments[0]!.durationSeconds * 500,
      routes: [computed],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: computed.totalDurationSeconds }],
      groups: [{ id: "group-1", code: "G-01", title: "一组", aircraftIds: ["aircraft-1"], taskObjectIds: ["task-1"] }],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "UNASSIGNED", incompleteReason: null }]
    })
    expect(start.aircraft[0]?.remainingEnergyWh).toBeCloseTo(initialEnergy)
    expect(partial.aircraft[0]?.remainingEnergyWh).toBeLessThan(initialEnergy)
    expect(partial.aircraft[0]?.remainingEnergyWh).toBeGreaterThan(computed.energySegments[0]!.remainingEnergyWh)
  })

  it("keeps an aircraft waiting until the runtime clock advances", () => {
    const computed = route()
    const projection = projectVtlRuntime({
      simulationTimeMs: 0,
      routes: [computed],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: computed.totalDurationSeconds }],
      groups: [{ id: "group-1", code: "G-01", title: "一组", aircraftIds: ["aircraft-1"], taskObjectIds: ["task-1"] }],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "UNASSIGNED", incompleteReason: null }]
    })
    expect(projection.aircraft[0]?.status).toBe("WAITING")
    expect(projection.aircraft[0]?.phase).toBe("VERTICAL_TAKEOFF")
    expect(projection.aircraft[0]?.remainingEnergyWh).toBeCloseTo(computed.energySegments[0]!.remainingEnergyWh + computed.energySegments[0]!.energyWh)
  })

  it("keeps one-aircraft state while aggregating a 20-aircraft fleet into groups", () => {
    const baseRoute = route()
    const routes = Array.from({ length: 20 }, (_, index) => ({ ...baseRoute, id: `route-${index + 1}`, aircraftId: `aircraft-${index + 1}` }))
    const assignments = routes.map((item, index) => ({
      aircraftId: item.aircraftId,
      aircraftCode: `VTL-${String(index + 1).padStart(2, "0")}`,
      groupId: index < 10 ? "group-1" : "group-2",
      available: true,
      taskObjectIds: ["task-1"],
      taskSequence: ["task-1"],
      estimatedDurationSeconds: item.totalDurationSeconds
    }))
    const projection = projectVtlRuntime({
      simulationTimeMs: 0,
      routes,
      assignments,
      groups: [
        { id: "group-1", code: "G-01", title: "一组", aircraftIds: assignments.slice(0, 10).map((item) => item.aircraftId), taskObjectIds: ["task-1"] },
        { id: "group-2", code: "G-02", title: "二组", aircraftIds: assignments.slice(10).map((item) => item.aircraftId), taskObjectIds: ["task-1"] }
      ],
      taskObjects: [{ id: "task-1", code: "T-01", title: "目标", type: "POINT", positions: [{ longitude: 0.012, latitude: 0, altitudeMeters: 120 }], requirement: "观察", completionRule: "覆盖", required: true, estimatedWorkSeconds: 90, status: "ASSIGNED", incompleteReason: null }]
    })
    expect(projection.aircraft).toHaveLength(20)
    expect(projection.groups.map((group) => group.aircraftCount)).toEqual([10, 10])
    expect(projection.summary.totalAircraft).toBe(20)
    expect(projection.summary.phaseDistribution.VERTICAL_TAKEOFF).toBe(20)
  })
})
