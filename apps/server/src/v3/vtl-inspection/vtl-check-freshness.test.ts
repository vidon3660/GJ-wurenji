import { describe, expect, it } from "vitest"
import type { VtlProjectPlanView } from "@wurenji/shared"
import { vtlPlanCheckResultIsCurrent } from "./vtl-check-freshness.js"

describe("VTL check result freshness", () => {
  it("accepts a passed result bound to the current allocation and routes", () => {
    expect(vtlPlanCheckResultIsCurrent(plan())).toBe(true)
  })

  it.each([
    { label: "allocation revision", change: (value: VtlProjectPlanView) => { value.allocation.revision += 1 } },
    { label: "route revision", change: (value: VtlProjectPlanView) => { value.routes[0]!.revision += 1 } },
    { label: "missing route result", change: (value: VtlProjectPlanView) => { delete value.checkResult!.routeRevisions["aircraft-2"] } },
    { label: "different project", change: (value: VtlProjectPlanView) => { value.checkResult!.projectId = "other-project" } }
  ])("rejects stale $label", ({ change }) => {
    const value = plan()
    change(value)
    expect(vtlPlanCheckResultIsCurrent(value)).toBe(false)
  })
})

function plan(): VtlProjectPlanView {
  return {
    projectId: "project-1",
    revision: 3,
    areaConfirmedAt: null,
    taskObjects: [],
    landingSites: [],
    aircraftParameters: {} as VtlProjectPlanView["aircraftParameters"],
    allocation: { projectId: "project-1", revision: 4, taskZones: [], assignments: [], groups: [], issues: [], valid: true, updatedAt: "2026-08-20T00:00:00.000Z" },
    routes: [
      { id: "route-1", projectId: "project-1", aircraftId: "aircraft-1", revision: 2, parameterVersion: "p1", waypoints: [], transitionHeightMeters: 90, alternateLandingSiteId: "alternate-1", terrainProfile: [], energySegments: [], totalDistanceMeters: 0, totalDurationSeconds: 0, totalEnergyWh: 0, reserveEnergyWh: 0, minimumTerrainClearanceMeters: 100, updatedAt: "2026-08-20T00:00:00.000Z" },
      { id: "route-2", projectId: "project-1", aircraftId: "aircraft-2", revision: 1, parameterVersion: "p1", waypoints: [], transitionHeightMeters: 90, alternateLandingSiteId: "alternate-1", terrainProfile: [], energySegments: [], totalDistanceMeters: 0, totalDurationSeconds: 0, totalEnergyWh: 0, reserveEnergyWh: 0, minimumTerrainClearanceMeters: 100, updatedAt: "2026-08-20T00:00:00.000Z" }
    ],
    checkResult: {
      projectId: "project-1",
      allocationRevision: 4,
      routeRevisions: { "aircraft-1": 2, "aircraft-2": 1 },
      singleAircraftIssues: [],
      fleetIssues: [],
      blockingIssueCount: 0,
      warningCount: 0,
      passed: true,
      checkedAt: "2026-08-20T00:00:00.000Z"
    },
    executionPlan: null,
    updatedAt: "2026-08-20T00:00:00.000Z"
  }
}
