import { describe, expect, it } from "vitest"
import type { VtlAircraftParameters, VtlProjectPlanView } from "@wurenji/shared"
import { buildVtlRoutePlan } from "@wurenji/simulation/vtl-runtime"
import { projectVtlPlanPreview, vtlPlanPreviewDurationMs, vtlPlanPreviewMarkers } from "./vtl-plan-preview"

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

function plan(): VtlProjectPlanView {
  const phases = ["VERTICAL_TAKEOFF", "CLIMB", "FORWARD_TRANSITION", "FIXED_WING_CRUISE", "TASK_EXECUTION", "RETURN", "BACK_TRANSITION", "VERTICAL_LANDING"] as const
  const route = buildVtlRoutePlan({
    routeId: "route-1",
    projectId: "project-1",
    aircraftId: "aircraft-1",
    parameterVersion: parameters.version,
    transitionHeightMeters: 80,
    alternateLandingSiteId: "alt-1",
    alternateLandingSitePosition: { longitude: 0.004, latitude: 0, altitudeMeters: 0 },
    waypoints: phases.map((phase, index) => ({
      id: `wp-${index}`,
      sequence: index,
      phase,
      position: { longitude: index < 5 ? index * 0.001 : (7 - index) * 0.001, latitude: 0, altitudeMeters: phase === "VERTICAL_LANDING" ? 10 : 100 },
      altitudeMeters: phase === "VERTICAL_LANDING" ? 10 : 100,
      speedMps: 20,
      taskObjectId: phase === "TASK_EXECUTION" ? "task-1" : null
    })),
    parameters
  }).route
  return {
    projectId: "project-1",
    revision: 1,
    areaConfirmedAt: "2026-08-20T00:00:00.000Z",
    taskObjects: [{ id: "task-1", code: "T-01", title: "巡检目标", type: "POINT", positions: [{ longitude: 0.004, latitude: 0, altitudeMeters: 100 }], requirement: "巡检", completionRule: "覆盖", required: true, estimatedWorkSeconds: 30, status: "ASSIGNED", incompleteReason: null }],
    landingSites: [],
    aircraftParameters: parameters,
    allocation: {
      projectId: "project-1",
      revision: 1,
      taskZones: [],
      assignments: [{ aircraftId: "aircraft-1", aircraftCode: "VTL-01", groupId: "group-1", available: true, taskObjectIds: ["task-1"], taskSequence: ["task-1"], estimatedDurationSeconds: route.totalDurationSeconds }],
      groups: [{ id: "group-1", code: "G-01", title: "一组", aircraftIds: ["aircraft-1"], taskObjectIds: ["task-1"] }],
      issues: [],
      valid: true,
      updatedAt: "2026-08-20T00:00:00.000Z"
    },
    routes: [route],
    checkResult: null,
    executionPlan: null,
    updatedAt: "2026-08-20T00:00:00.000Z"
  }
}

describe("VTL plan preview", () => {
  it("projects phases, task progress and final landing without creating a runtime", () => {
    const value = plan()
    const durationMs = vtlPlanPreviewDurationMs(value.routes)
    const taskSegmentIndex = value.routes[0]!.energySegments.findIndex((segment) => segment.phase === "TASK_EXECUTION")
    const taskStartMs = value.routes[0]!.energySegments.slice(0, taskSegmentIndex).reduce((sum, segment) => sum + segment.durationSeconds * 1_000, 0)
    const taskDurationMs = value.routes[0]!.energySegments[taskSegmentIndex]!.durationSeconds * 1_000

    const executing = projectVtlPlanPreview(value, taskStartMs + taskDurationMs / 2)
    const completed = projectVtlPlanPreview(value, durationMs)

    expect(executing.aircraft[0]).toMatchObject({ phase: "TASK_EXECUTION", currentTaskObjectId: "task-1", status: "ACTIVE" })
    expect(executing.taskObjects[0]?.status).toBe("IN_PROGRESS")
    expect(completed.aircraft[0]?.status).toBe("LANDED")
    expect(completed.taskObjects[0]?.status).toBe("COMPLETED")
    expect(completed.summary.taskCompletionRatio).toBe(1)
  })

  it("builds selected-route phase and task-completion markers", () => {
    const value = plan()
    const markers = vtlPlanPreviewMarkers(value.routes[0]!, value.taskObjects)

    expect(markers).toHaveLength(value.routes[0]!.energySegments.length)
    expect(markers.map((marker) => marker.label)).toContain("T-01 完成")
    expect(markers.at(-1)?.timeMs).toBe(vtlPlanPreviewDurationMs(value.routes))
  })
})
