import type { V3RegionCatalogItem, VtlPlanningWorkspaceView, VtlRoutePlanView } from "@wurenji/shared"

// Shared local fixtures for component regression and Chromium acceptance.
export const planningProject = {
  id: "project-1",
  assignmentSnapshotId: "snapshot-1",
  title: "垂起巡检实训",
  sceneType: "VTOL_INSPECTION",
  mode: "PRACTICE",
  assignmentStatus: "PUBLISHED",
  isDemo: false,
  isAcceptanceData: false,
  status: "IN_PROGRESS",
  currentStageCode: "VTL_REVIEW",
  stages: [{ stageCode: "VTL_REVIEW", sequence: 1, title: "运行结果", description: "查看运行结果", openCondition: "完成运行", status: "LOCKED", revision: 1, allowedActions: [] }],
  assessmentAttempt: { attemptNumber: 1, isRetake: false, retakeOfProjectId: null, retakeReason: null, retakeCreatedAt: null },
  assessmentTiming: {
    state: "NOT_APPLICABLE",
    durationMinutes: null,
    availableAt: "2026-01-01T00:00:00.000Z",
    assignmentDueAt: "2026-12-31T00:00:00.000Z",
    startedAt: null,
    deadlineAt: null,
    submittedAt: null,
    endedAt: null,
    serverNow: "2026-01-01T00:00:00.000Z",
    remainingMs: null,
    canStart: false,
    canWrite: true,
    blockedReason: null
  },
  lastActivityAt: "2026-01-01T00:00:00.000Z"
} as const

export const planningSnapshot = {
  id: "snapshot-1",
  draftId: "draft-1",
  schemaVersion: 3,
  title: "垂起巡检实训",
  sceneType: "VTOL_INSPECTION",
  mode: "PRACTICE",
  isDemo: false,
  isAcceptanceData: false,
  config: { questionBankVersionId: "bank-version-1", regionPackageId: "region-1", taskBrief: "完成巡检航线设计" },
  resourceRefs: [],
  resourceRevision: 1,
  mapResourceVersion: "map-v1",
  sceneResourceVersion: "scene-v1",
  planVersion: "plan-v1",
  checksum: "checksum",
  publishedAt: "2026-01-01T00:00:00.000Z"
} as const

const timestamp = "2026-10-07T08:00:00.000Z"
export const planningRegion = {
  packageId: "region-1",
  packageVersion: "1.0.0",
  checksum: "checksum",
  sceneType: "VTOL_INSPECTION",
  regionCode: "TEST",
  title: "测试巡检区域",
  center: { longitude: 120, latitude: 30 },
  boundary: [],
  heightDatum: "AMSL",
  terrainResourceVersion: "terrain-v1",
  imageryState: "READY",
  layers: []
} as unknown as V3RegionCatalogItem

function route(aircraftId: string, revision: number, transitionHeightMeters: number, projectId = "project-1"): VtlRoutePlanView {
  return {
    id: `route-${aircraftId}`,
    projectId,
    aircraftId,
    revision,
    parameterVersion: "1",
    waypoints: [{ id: "task-waypoint", sequence: 0, phase: "TASK_EXECUTION", position: { longitude: 120, latitude: 30, altitudeMeters: 150 }, altitudeMeters: 150, speedMps: 20, taskObjectId: `task-${aircraftId}` }],
    transitionHeightMeters,
    alternateLandingSiteId: "alternate-1",
    terrainProfile: [],
    energySegments: [],
    totalDistanceMeters: 1000,
    totalDurationSeconds: 60,
    totalEnergyWh: 200,
    reserveEnergyWh: 500,
    minimumTerrainClearanceMeters: 100,
    updatedAt: timestamp
  }
}

export function planningWorkspace(revision = 7, transitionHeightMeters = 80, projectId = "project-1"): VtlPlanningWorkspaceView {
  return {
    projectId,
    actor: "STUDENT",
    mode: "TRAINING",
    scaleTemplateCode: "VTL_SMALL",
    region: planningRegion,
    canConfirmArea: false,
    canEditAllocation: false,
    canSubmitAllocation: false,
    canEditRoutes: true,
    canValidate: false,
    canSubmitValidation: false,
    canSubmitExecutionPlan: false,
    plan: {
      projectId,
      revision,
      areaConfirmedAt: timestamp,
      taskObjects: ["aircraft-a", "aircraft-b"].map((aircraftId, index) => ({
        id: `task-${aircraftId}`, code: `TASK-${index + 1}`, title: `巡检对象${index + 1}`, type: "POINT", positions: [{ longitude: 120 + index * 0.001, latitude: 30 }], requirement: "完成巡检", completionRule: "到达对象", required: true, estimatedWorkSeconds: 60, status: "ASSIGNED", incompleteReason: null
      })),
      landingSites: [
        { id: "main-1", code: "MAIN", title: "主起降点", type: "MAIN", position: { longitude: 120, latitude: 30 }, elevationMeters: 0, status: "AVAILABLE", relatedAlternateSiteIds: ["alternate-1"] },
        { id: "alternate-1", code: "ALTERNATE", title: "备降点", type: "ALTERNATE", position: { longitude: 120.01, latitude: 30 }, elevationMeters: 0, status: "AVAILABLE", relatedAlternateSiteIds: [] }
      ],
      aircraftParameters: { modelCode: "VTL", version: "1", batteryCapacityWh: 2000, reserveEnergyRatio: 0.2, verticalPowerWatts: 1000, hoverPowerWatts: 800, cruisePowerWatts: 600, taskPowerWatts: 700, climbSpeedMps: 5, cruiseSpeedMps: 20, transitionSpeedMps: 10, minimumTransitionHeightMeters: 50, maximumOperatingAltitudeMeters: 300 },
      allocation: {
        projectId,
        revision: 1,
        taskZones: [],
        assignments: ["aircraft-a", "aircraft-b"].map((aircraftId, index) => ({ aircraftId, aircraftCode: `VTL-${index + 1}`, groupId: "group-1", available: true, taskObjectIds: [`task-${aircraftId}`], taskSequence: [`task-${aircraftId}`], estimatedDurationSeconds: 60 })),
        groups: [{ id: "group-1", code: "GROUP_1", title: "巡检一组", aircraftIds: ["aircraft-a", "aircraft-b"], taskObjectIds: ["task-aircraft-a", "task-aircraft-b"] }],
        issues: [],
        valid: true,
        updatedAt: timestamp
      },
      routes: [route("aircraft-a", revision, transitionHeightMeters, projectId), route("aircraft-b", revision, 90, projectId)],
      checkResult: null,
      executionPlan: null,
      updatedAt: timestamp
    }
  }
}

