import type {
  LearningMode,
  ShowTeacherScoreView,
  ShowObjectiveMetricView,
  ShowReplayTimelineItemView,
  V3AlertSeverity,
  V3Coordinate,
  V3RuntimeAlertView,
  V3RuntimeSessionView,
  V3RegionCatalogItem,
  V3StudentRuntimeActionView,
  VtlStageCode
} from "./types.js"
import type { RuntimeClock } from "./runtime-contracts.js"

export interface VtlEvaluationItemConfig {
  code: string
  label: string
  maxScore: number
  description?: string
}

export interface VtlAssignmentParameters {
  projectBackground: string
  completionRequirements: string
  plannedStartAt: string
  plannedEndAt: string
  mainLandingSiteId: string
  aircraftModelCode: string
  aircraftParameterVersion: string
  taskObjectIds?: string[]
  taskAreaBoundary?: V3Coordinate[]
  openStageCodes?: VtlStageCode[]
  evaluationItems?: VtlEvaluationItemConfig[]
}

export const vtlTaskObjectTypes = ["POINT", "LINE", "AREA"] as const
export type VtlTaskObjectType = (typeof vtlTaskObjectTypes)[number]
export type VtlTaskObjectStatus = "UNASSIGNED" | "ASSIGNED" | "IN_PROGRESS" | "COMPLETED" | "INCOMPLETE"

export interface VtlTaskObjectView {
  id: string
  code: string
  title: string
  type: VtlTaskObjectType
  positions: V3Coordinate[]
  requirement: string
  completionRule: string
  required: boolean
  estimatedWorkSeconds: number
  status: VtlTaskObjectStatus
  incompleteReason: string | null
}

export type VtlLandingSiteType = "MAIN" | "ALTERNATE"
export type VtlLandingSiteStatus = "AVAILABLE" | "RESTRICTED" | "UNAVAILABLE"

export interface VtlLandingSiteView {
  id: string
  code: string
  title: string
  type: VtlLandingSiteType
  position: V3Coordinate
  elevationMeters: number
  status: VtlLandingSiteStatus
  relatedAlternateSiteIds: string[]
}

export interface VtlAircraftParameters {
  modelCode: string
  version: string
  batteryCapacityWh: number
  reserveEnergyRatio: number
  verticalPowerWatts: number
  hoverPowerWatts: number
  cruisePowerWatts: number
  taskPowerWatts: number
  climbSpeedMps: number
  cruiseSpeedMps: number
  transitionSpeedMps: number
  minimumTransitionHeightMeters: number
  maximumOperatingAltitudeMeters: number
}

export interface VtlTaskZoneView {
  id: string
  title: string
  boundary: V3Coordinate[]
  groupId: string | null
  taskObjectIds: string[]
  estimatedWorkSeconds: number
}

export interface VtlAircraftAssignmentView {
  aircraftId: string
  aircraftCode: string
  groupId: string
  available: boolean
  taskObjectIds: string[]
  taskSequence: string[]
  estimatedDurationSeconds: number
}

export interface VtlGroupView {
  id: string
  code: string
  title: string
  aircraftIds: string[]
  taskObjectIds: string[]
}

export interface VtlAllocationIssueView {
  code: "UNASSIGNED" | "DUPLICATE" | "OUTSIDE_AREA" | "AIRCRAFT_UNAVAILABLE" | "ORDER_INVALID"
  taskObjectId: string | null
  aircraftId: string | null
  message: string
  blocking: boolean
}

export interface VtlAllocationPlanView {
  projectId: string
  revision: number
  taskZones: VtlTaskZoneView[]
  assignments: VtlAircraftAssignmentView[]
  groups: VtlGroupView[]
  issues: VtlAllocationIssueView[]
  valid: boolean
  updatedAt: string
}

export const vtlFlightPhases = [
  "VERTICAL_TAKEOFF",
  "CLIMB",
  "FORWARD_TRANSITION",
  "FIXED_WING_CRUISE",
  "TASK_EXECUTION",
  "RETURN",
  "BACK_TRANSITION",
  "VERTICAL_LANDING"
] as const
export type VtlFlightPhase = (typeof vtlFlightPhases)[number]

export interface VtlRouteWaypointInput {
  id: string
  sequence: number
  phase: VtlFlightPhase
  position: V3Coordinate
  altitudeMeters: number
  speedMps: number
  taskObjectId: string | null
}

export interface VtlTerrainProfileSample {
  distanceMeters: number
  terrainElevationMeters: number
  plannedAltitudeMeters: number
  clearanceMeters: number
  longitude: number
  latitude: number
}

export interface VtlEnergySegmentView {
  phase: VtlFlightPhase
  distanceMeters: number
  durationSeconds: number
  energyWh: number
  remainingEnergyWh: number
  remainingEnergyRatio: number
}

export interface VtlAlternateRouteComparisonView {
  landingSiteId: string
  diversionWaypointId: string
  nominalReturnDistanceMeters: number
  nominalReturnDurationSeconds: number
  nominalReturnEnergyWh: number
  nominalArrivalEnergyWh: number
  alternateDistanceMeters: number
  alternateDurationSeconds: number
  alternateEnergyWh: number
  alternateArrivalEnergyWh: number
  distanceDeltaMeters: number
  durationDeltaSeconds: number
  energyDeltaWh: number
  reserveMarginWh: number
  feasible: boolean
}

export interface VtlRoutePlanView {
  id: string
  projectId: string
  aircraftId: string
  revision: number
  parameterVersion: string
  waypoints: VtlRouteWaypointInput[]
  transitionHeightMeters: number
  alternateLandingSiteId: string
  alternateComparison?: VtlAlternateRouteComparisonView
  terrainProfile: VtlTerrainProfileSample[]
  energySegments: VtlEnergySegmentView[]
  totalDistanceMeters: number
  totalDurationSeconds: number
  totalEnergyWh: number
  reserveEnergyWh: number
  minimumTerrainClearanceMeters: number
  updatedAt: string
}

export type VtlCheckScope = "AIRCRAFT" | "FLEET"
export type VtlCheckSeverity = "CONFLICT" | "RISK" | "INFO"

export interface VtlPlanCheckIssueView {
  id: string
  code: string
  scope: VtlCheckScope
  category: "COVERAGE" | "TERRAIN" | "TRANSITION" | "ENERGY" | "ALTERNATE" | "TAKEOFF_ORDER" | "SPATIAL" | "TEMPORAL"
  severity: VtlCheckSeverity
  aircraftIds: string[]
  taskObjectIds: string[]
  message: string
  suggestion: string
}

export interface VtlPlanCheckResultView {
  projectId: string
  allocationRevision: number
  routeRevisions: Record<string, number>
  singleAircraftIssues: VtlPlanCheckIssueView[]
  fleetIssues: VtlPlanCheckIssueView[]
  blockingIssueCount: number
  warningCount: number
  passed: boolean
  checkedAt: string
}

export interface VtlExecutionPlanView {
  projectId: string
  version: number
  takeoffOrder: string[]
  landingOrder: string[]
  taskOrderByAircraft: Record<string, string[]>
  allocationRevision: number
  routeRevisions: Record<string, number>
  checkResult: VtlPlanCheckResultView
  status: "DRAFT" | "SUBMITTED"
  submittedAt: string | null
}

export interface VtlProjectPlanView {
  projectId: string
  revision: number
  areaConfirmedAt: string | null
  taskObjects: VtlTaskObjectView[]
  landingSites: VtlLandingSiteView[]
  aircraftParameters: VtlAircraftParameters
  allocation: VtlAllocationPlanView
  routes: VtlRoutePlanView[]
  checkResult: VtlPlanCheckResultView | null
  executionPlan: VtlExecutionPlanView | null
  updatedAt: string
}

export interface VtlPlanningWorkspaceView {
  projectId: string
  actor: "STUDENT" | "TEACHER"
  mode: LearningMode
  scaleTemplateCode: string
  region: V3RegionCatalogItem
  plan: VtlProjectPlanView
  canConfirmArea: boolean
  canEditAllocation: boolean
  canSubmitAllocation: boolean
  canEditRoutes: boolean
  canValidate: boolean
  canSubmitValidation: boolean
  canSubmitExecutionPlan: boolean
}

export type VtlSituationLevel = "OVERALL" | "GROUP" | "AIRCRAFT"

export interface VtlRuntimeAircraftView {
  aircraftId: string
  aircraftCode: string
  groupId: string
  phase: VtlFlightPhase
  position: V3Coordinate
  currentTaskObjectId: string | null
  completedTaskObjectIds: string[]
  remainingEnergyWh: number
  remainingEnergyRatio: number
  eventIds: string[]
  status: "WAITING" | "ACTIVE" | "HOLDING" | "RETURNING" | "DIVERTING" | "LANDED" | "CANCELLED"
}

export interface VtlRuntimeGroupView {
  groupId: string
  aircraftCount: number
  activeAircraftCount: number
  completedTaskCount: number
  totalTaskCount: number
  progressRatio: number
  attentionCount: number
  phaseDistribution: Partial<Record<VtlFlightPhase, number>>
}

export interface VtlRuntimeSummaryView {
  totalAircraft: number
  airborneAircraft: number
  landedAircraft: number
  attentionAircraft: number
  totalTaskObjects: number
  completedTaskObjects: number
  incompleteTaskObjects: number
  taskCompletionRatio: number
  phaseDistribution: Partial<Record<VtlFlightPhase, number>>
  /** Runtime-computed checks exposed to the assessment result. */
  minimumRemainingEnergyWh?: number
  energyReserveViolationCount?: number
  airborneConflictCount?: number
  executable?: boolean
}

export const vtlRuntimeEventCategories = [
  "WEATHER",
  "POSITIONING",
  "COMMUNICATION",
  "ENERGY_POWER",
  "DEVICE",
  "MODE_TRANSITION",
  "ROUTE_AREA",
  "TASK_CONDITION"
] as const
export type VtlRuntimeEventCategory = (typeof vtlRuntimeEventCategories)[number]

export const vtlRuntimeActionCodes = [
  "ACKNOWLEDGE",
  "HOLD",
  "RETURN_AIRCRAFT",
  "DIVERT_AIRCRAFT",
  "TRANSFER_TASK",
  "ADJUST_GROUP",
  "CANCEL_NOT_STARTED"
] as const
export type VtlRuntimeActionCode = (typeof vtlRuntimeActionCodes)[number]

export interface VtlRuntimeEventView {
  id: string
  code: string
  category: VtlRuntimeEventCategory
  severity: V3AlertSeverity
  title: string
  detail: string
  status: "PENDING" | "OCCURRED_UNDETECTED" | "ACTIVE" | "HANDLING" | "RESOLVED" | "ESCALATED"
  affectedAircraftIds: string[]
  availableActions: VtlRuntimeActionCode[]
  actionDeadlineSeconds?: number | null
  actionDeadlineAtSimulationTimeMs?: number | null
  triggeredAtMs: number | null
  resolvedAtMs: number | null
}

export interface VtlReorganizationRecordView {
  id: string
  eventId: string
  action: VtlRuntimeActionCode
  sourceAircraftId: string | null
  targetAircraftId: string | null
  sourceGroupId: string | null
  targetGroupId: string | null
  taskObjectIds: string[]
  previousTaskOrder: string[]
  nextTaskOrder: string[]
  checkPassed: boolean
  message: string
  executedAtMs: number
}

export interface VtlRuntimeWorkspaceView {
  projectId: string
  actor: "STUDENT" | "TEACHER"
  mode: LearningMode
  scaleTemplateCode: string
  situationLevel: VtlSituationLevel
  session: V3RuntimeSessionView
  clock?: RuntimeClock
  attempts: V3RuntimeSessionView[]
  canStart: boolean
  canControl: boolean
  canTeacherIntervene: boolean
  clockRate: number
  durationMs: number
  remainingMs: number
  summary: VtlRuntimeSummaryView
  groups: VtlRuntimeGroupView[]
  aircraft: VtlRuntimeAircraftView[]
  taskObjects: VtlTaskObjectView[]
  events: VtlRuntimeEventView[]
  alerts: V3RuntimeAlertView[]
  actions: V3StudentRuntimeActionView[]
  availableActions: Array<{
    code: VtlRuntimeActionCode
    title: string
    targetType: "AIRCRAFT" | "EVENT" | "GROUP"
    requiresTarget: boolean
    enabled: boolean
    disabledReason: string | null
    eligibleTargetIds: string[]
  }>
  reorganizations: VtlReorganizationRecordView[]
}

export interface VtlAircraftReviewView {
  aircraftId: string
  groupId: string
  completedTaskObjectIds: string[]
  incompleteTaskObjectIds: string[]
  phaseDurationMs: Partial<Record<VtlFlightPhase, number>>
  plannedEnergyWh: number
  actualEnergyWh: number
  finalEnergyRatio: number
  returnOrDivertResult: string | null
}

export interface VtlReplayFrameView {
  id: string
  sequence: number
  simulationTimeMs: number
  reason: "START" | "TICK" | "EVENT" | "ACTION" | "COMPLETE" | "ABORT"
  summary: VtlRuntimeSummaryView
  aircraft: VtlRuntimeAircraftView[]
  groups: VtlRuntimeGroupView[]
  taskObjects: VtlTaskObjectView[]
}

export interface VtlReviewView {
  projectId: string
  actor: "STUDENT" | "TEACHER"
  evaluationStatus: "PENDING" | "REVIEWED" | "PUBLISHED"
  evaluationRevision: number
  totalScore: number | null
  canEditSummary: boolean
  canSubmitSummary: boolean
  canReview: boolean
  canPublish: boolean
  publishBlockedReason: string | null
  objectiveMetrics: ShowObjectiveMetricView[]
  timeline: ShowReplayTimelineItemView[]
  replayFrames: VtlReplayFrameView[]
  taskCoverageRatio: number
  completedTaskObjectIds: string[]
  incompleteTaskObjects: Array<{ taskObjectId: string; reason: string }>
  aircraftResults: VtlAircraftReviewView[]
  eventResolutionRate: number
  reorganizations: VtlReorganizationRecordView[]
  studentSummary: string
  teacherScores: ShowTeacherScoreView[]
  teacherSummary: string
  reportAssetId: string | null
  report: { id: string; status: "DRAFT" | "FINAL"; format: "DOCX" | "PDF" | null; filename: string | null } | null
  reportJob: {
    id: string
    status: "PENDING" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "DEAD_LETTER"
    format: "DOCX" | "PDF"
    error: string | null
    requestedAt: string
    finishedAt: string | null
  } | null
}
