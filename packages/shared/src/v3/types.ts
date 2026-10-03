import type { SceneType, UserRole } from "../types.js"

export const learningModes = ["TRAINING", "ASSESSMENT"] as const
export type LearningMode = (typeof learningModes)[number]

export const resourcePackageTypes = [
  "RULE",
  "REGION",
  "SCALE_TEMPLATE",
  "AIRCRAFT",
  "EVENT",
  "SHOW_PROGRAM",
  "DOCUMENT_TEMPLATE",
  "REPORT"
] as const
export type ResourcePackageType = (typeof resourcePackageTypes)[number]

export const resourcePackageStatuses = ["UPLOADED", "VALIDATING", "STAGED", "ACTIVE", "REJECTED", "RETIRED"] as const
export type ResourcePackageStatus = (typeof resourcePackageStatuses)[number]
export type V3ResourcePackageSource = "BUILT_IN" | "SIGNED_ARCHIVE" | "IMPORTED_TRAJECTORY" | "UNSIGNED_TEST"

export interface ShowProgramTrackPoint {
  timeMs: number
  eastMeters: number
  northMeters: number
  upMeters: number
}

export interface ShowProgramGroupTrack {
  groupId: string
  points: ShowProgramTrackPoint[]
}

export interface ShowProgramManifest {
  sceneType: "CITY_SHOW"
  format: "LOCAL_ENU_CSV_V1"
  sourceSoftware: string
  aircraftCount: number
  groupSize: number
  keyframeCount: number
  sourceRowCount: number
  durationMs: number
  maximumAltitudeMeters: number
  horizontalRadiusMeters: number
  maximumSpeedMetersPerSecond: number
  groupTracks: ShowProgramGroupTrack[]
}

export interface V3ResourcePackageDependency {
  packageType: ResourcePackageType
  name: string
  version: string
}

export interface V3ResourcePackageFileEntry {
  path: string
  role: string
  mimeType: string
  sizeBytes: number
  sha256: string
}

export interface V3ResourceArchiveManifest {
  formatVersion: 1
  packageType: ResourcePackageType
  name: string
  version: string
  schemaVersion: number
  minimumPlatformVersion: string
  publishedAt: string
  signature: { algorithm: "Ed25519"; keyId: string }
  dependencies: V3ResourcePackageDependency[]
  files: V3ResourcePackageFileEntry[]
  content: Record<string, unknown>
}

export interface V3ResourceValidationCheck {
  code: string
  passed: boolean
  message: string
}

export interface V3ResourceValidationSummary {
  passed: boolean
  checks: V3ResourceValidationCheck[]
  signatureKeyId: string | null
  validatedAt: string | null
  rejectionReason: string | null
}

export const assignmentDraftStatuses = ["DRAFT", "PUBLISHED", "IN_PROGRESS", "ENDED", "ARCHIVED"] as const
export type AssignmentDraftStatus = (typeof assignmentDraftStatuses)[number]

export const v3ActivityEventTypes = [
  "ASSIGNMENT_CREATED",
  "ASSIGNMENT_COPIED",
  "ASSIGNMENT_PUBLISHED",
  "ASSIGNMENT_RESOURCES_UPDATED",
  "ASSIGNMENT_WITHDRAWN",
  "ASSIGNMENT_DELETED",
  "ASSIGNMENT_ENDED",
  "ASSIGNMENT_ARCHIVED",
  "PROJECT_ASSIGNED",
  "ASSESSMENT_RETAKE_CREATED",
  "STAGE_STARTED",
  "AREA_DRAFT_SAVED",
  "AREA_DRAFT_CHECKED",
  "AREA_SNAPSHOT_CREATED",
  "AREA_PLAN_SUBMITTED",
  "AREA_PLAN_ACCEPTED",
  "AREA_PLAN_RETURNED",
  "DOCUMENTS_PROVISIONED",
  "DOCUMENT_SAVED",
  "DOCUMENT_SUBMITTED",
  "DOCUMENT_VIEWED",
  "DOCUMENT_RETURNED",
  "DOCUMENT_RESUBMITTED",
  "PREFLIGHT_SAVED",
  "PREFLIGHT_COMPLETED",
  "T60_CLOCK_STARTED",
  "T60_REPORT_SUBMITTED",
  "RUNTIME_SESSION_CREATED",
  "RUNTIME_RESTARTED",
  "TAKEOFF_REPORTED",
  "RUNTIME_STARTED",
  "RUNTIME_CLOCK_CHANGED",
  "RUNTIME_EVENT_TRIGGERED",
  "RUNTIME_EVENT_DISCOVERED",
  "RUNTIME_EVENT_ESCALATED",
  "RUNTIME_EVENT_RESOLVED",
  "RUNTIME_ACTION_APPLIED",
  "RUNTIME_COMPLETED",
  "RUNTIME_ABORTED",
  "RUNTIME_EMERGENCY_SUBMITTED",
  "TEACHER_RUNTIME_INTERVENTION",
  "FLIGHT_END_REPORT_SUBMITTED",
  "REVIEW_SUMMARY_SAVED",
  "REVIEW_SUMMARY_SUBMITTED",
  "REVIEW_ANNOTATION_ADDED",
  "EVALUATION_SAVED",
  "EVALUATION_PUBLISHED",
  "REPORT_GENERATED",
  "LOGISTICS_REGION_SAVED",
  "LOGISTICS_REGION_CONFIRMED",
  "LOGISTICS_ROUTE_DRAFT_SAVED",
  "LOGISTICS_ROUTE_CHECKED",
  "LOGISTICS_ROUTE_VERSION_CREATED",
  "LOGISTICS_ROUTE_VALIDATED",
  "LOGISTICS_ROUTE_PLAN_SUBMITTED",
  "LOGISTICS_ORDER_BATCH_GENERATED",
  "LOGISTICS_SCHEDULE_DRAFT_SAVED",
  "LOGISTICS_SCHEDULE_BATCH_ADJUSTED",
  "LOGISTICS_SCHEDULE_CHECKED",
  "LOGISTICS_SCHEDULE_VERSION_CREATED",
  "LOGISTICS_SCHEDULE_VERSION_RESTORED",
  "LOGISTICS_INITIAL_SCHEDULE_SUBMITTED",
  "LOGISTICS_READINESS_SAVED",
  "LOGISTICS_READINESS_CONFIRMED",
  "LOGISTICS_RUNTIME_SESSION_CREATED",
  "LOGISTICS_RUNTIME_RESTARTED",
  "LOGISTICS_RUNTIME_STARTED",
  "LOGISTICS_RUNTIME_CLOCK_CHANGED",
  "LOGISTICS_RUNTIME_EVENT_TRIGGERED",
  "LOGISTICS_RUNTIME_EVENT_DISCOVERED",
  "LOGISTICS_RUNTIME_EVENT_ESCALATED",
  "LOGISTICS_RUNTIME_EVENT_RESOLVED",
  "LOGISTICS_RUNTIME_ACTION_APPLIED",
  "LOGISTICS_DYNAMIC_SCHEDULE_CREATED",
  "LOGISTICS_DYNAMIC_SCHEDULE_SUBMITTED",
  "LOGISTICS_RUNTIME_COMPLETED",
  "LOGISTICS_REVIEW_SUMMARY_SAVED",
  "LOGISTICS_REVIEW_SUMMARY_SUBMITTED",
  "LOGISTICS_EVALUATION_SAVED",
  "LOGISTICS_EVALUATION_PUBLISHED",
  "LOGISTICS_REPORT_GENERATED",
  "QUESTION_BANK_CREATED",
  "QUESTION_BANK_VERSION_CREATED",
  "QUESTION_BANK_PUBLISHED",
  "QUESTION_BANK_VERSION_ARCHIVED",
  "QUESTION_ATTEMPT_SAVED",
  "QUESTION_ATTEMPT_SUBMITTED",
  "QUESTION_ATTEMPT_REGRADED",
  "QUESTION_ATTEMPT_REVIEWED",
  "TEACHER_ALERT_FOLLOW_UP_UPDATED"
] as const
export type V3ActivityEventType = (typeof v3ActivityEventTypes)[number]

export const v3ActivityObjectTypes = [
  "ASSIGNMENT",
  "PROJECT",
  "STAGE",
  "AREA_PLAN",
  "AREA_VERSION",
  "DOCUMENT",
  "DOCUMENT_VERSION",
  "PREFLIGHT",
  "SIMULATION_CLOCK",
  "REPORTING",
  "RUNTIME_SESSION",
  "RUNTIME_EVENT",
  "RUNTIME_ALERT",
  "RUNTIME_ACTION",
  "RUNTIME_SNAPSHOT",
  "EVALUATION",
  "REVIEW_ANNOTATION",
  "FINAL_REPORT",
  "LOGISTICS_REGION_ANALYSIS",
  "LOGISTICS_ROUTE_DRAFT",
  "LOGISTICS_ROUTE_VERSION",
  "LOGISTICS_ROUTE_VALIDATION",
  "LOGISTICS_ORDER_BATCH",
  "LOGISTICS_SCHEDULE_DRAFT",
  "LOGISTICS_SCHEDULE_VERSION",
  "LOGISTICS_READINESS",
  "LOGISTICS_RUNTIME_SNAPSHOT",
  "LOGISTICS_DYNAMIC_SCHEDULE_VERSION",
  "QUESTION_BANK",
  "QUESTION_BANK_VERSION",
  "QUESTION_ATTEMPT",
  "QUESTION_RESPONSE",
  "TEACHER_ALERT_FOLLOW_UP"
] as const
export type V3ActivityObjectType = (typeof v3ActivityObjectTypes)[number]

export const assignmentTargetTypes = ["CLASS", "STUDENT"] as const
export type AssignmentTargetType = (typeof assignmentTargetTypes)[number]

export const studentProjectStatuses = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "EVALUATING", "GRADED", "BLOCKED"] as const
export type StudentProjectStatus = (typeof studentProjectStatuses)[number]

export const stageStatuses = ["LOCKED", "AVAILABLE", "IN_PROGRESS", "SUBMITTED", "ACCEPTED", "RETURNED"] as const
export type StageStatus = (typeof stageStatuses)[number]

export const showStageCodes = [
  "SHOW_AREA_PLANNING",
  "SHOW_FLIGHT_APPLICATION",
  "SHOW_PREFLIGHT",
  "SHOW_T_MINUS_60",
  "SHOW_RUNTIME",
  "SHOW_FLIGHT_END_REPORT",
  "SHOW_REVIEW"
] as const
export type ShowStageCode = (typeof showStageCodes)[number]

export const logisticsStageCodes = [
  "LOGISTICS_REGION_ANALYSIS",
  "LOGISTICS_ROUTE_PLANNING",
  "LOGISTICS_ROUTE_VALIDATION",
  "LOGISTICS_ORDER_SCHEDULING",
  "LOGISTICS_RUNTIME_PREPARATION",
  "LOGISTICS_DELIVERY_RUNTIME",
  "LOGISTICS_EMERGENCY_HANDLING",
  "LOGISTICS_REVIEW"
] as const
export type LogisticsStageCode = (typeof logisticsStageCodes)[number]

export const vtlStageCodes = [
  "VTL_AREA_OBJECTS",
  "VTL_TASK_ALLOCATION",
  "VTL_ROUTE_PLANNING",
  "VTL_PLAN_VALIDATION",
  "VTL_EXECUTION_PLAN",
  "VTL_RUNTIME",
  "VTL_EMERGENCY_HANDLING",
  "VTL_REVIEW"
] as const
export type VtlStageCode = (typeof vtlStageCodes)[number]
export type V3StageCode = ShowStageCode | LogisticsStageCode | VtlStageCode

export interface V3ResourceReference {
  packageId: string
  packageType: ResourcePackageType
  name: string
  version: string
  sha256: string
}

export interface V3ResourcePackageView {
  id: string
  packageType: ResourcePackageType
  name: string
  version: string
  schemaVersion: number
  minimumPlatformVersion: string
  sha256: string
  status: ResourcePackageStatus
  source: V3ResourcePackageSource
  manifest: Record<string, unknown>
  archiveManifest: V3ResourceArchiveManifest | null
  archiveAsset: V3FileAssetView | null
  validation: V3ResourceValidationSummary
  activatedAt: string | null
  retiredAt: string | null
  createdAt: string
  updatedAt: string
}

export const v3RegionLayerCodes = ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"] as const
export type V3RegionLayerCode = (typeof v3RegionLayerCodes)[number]
export type V3RegionLayerState = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE"
export type V3HeightDatum = "AGL" | "AMSL"
export type V3TerrainProviderCode = "CESIUM_QUANTIZED_MESH"
export type V3TerrainVerticalDatum = "AMSL" | "ELLIPSOID"
export type V3ImageryProviderCode = "XYZ" | "TMS" | "SINGLE_TILE"
export type V3VectorResourceFormat = "GEOJSON" | "MVT"

export interface V3MapResourceManifestLayer {
  id: string
  format: V3ImageryProviderCode | V3VectorResourceFormat | V3TerrainProviderCode
  path: string
  version: string
  sha256: string
  coordinateReference: "EPSG:4326"
  verticalDatum?: V3HeightDatum | V3TerrainVerticalDatum
  extent: [number, number, number, number]
}

export interface V3MapResourceManifest {
  manifestVersion: 1
  mapResourceVersion: string
  coordinateReference: "EPSG:4326"
  heightDatum: V3HeightDatum
  coverage: [number, number, number, number]
  baseLayers?: V3MapResourceManifestLayer[]
  vectorLayers?: V3MapResourceManifestLayer[]
  terrain?: Record<string, unknown>
  imagery?: Record<string, unknown>
}

export interface V3Coordinate {
  longitude: number
  latitude: number
  altitudeMeters?: number
}

export interface V3RegionFeature {
  id: string
  name: string
  geometryType: "POINT" | "LINESTRING" | "POLYGON"
  position?: V3Coordinate
  positions?: V3Coordinate[]
  heightMeters?: number
  properties: Record<string, string | number | boolean>
}

export interface V3RegionLayerDefinition {
  code: V3RegionLayerCode
  title: string
  state: V3RegionLayerState
  source: string
  version: string
  features: V3RegionFeature[]
  /** Optional offline vector source served from the platform /map mount. */
  dataUrl?: string
  /** Optional format for an offline GeoJSON or Mapbox Vector Tile source. */
  format?: V3VectorResourceFormat
  /** Resource CRS. Runtime coordinates remain WGS84 (EPSG:4326). */
  coordinateReference?: "EPSG:4326"
  /** SHA-256 of the local vector file or tile directory. */
  sha256?: string
  /** WGS84 extent [west, south, east, north]. */
  extent?: [number, number, number, number]
}

export interface V3TerrainResource {
  provider: V3TerrainProviderCode
  url: string
  version: string
  sha256: string
  verticalDatum: V3TerrainVerticalDatum
  extent: [number, number, number, number]
  coordinateReference?: "EPSG:4326"
  elevationSampleUrl?: string
  elevationSampleSha256?: string
}

export interface V3ImageryResource {
  provider: V3ImageryProviderCode
  url: string
  version: string
  sha256: string
  extent: [number, number, number, number]
  coordinateReference?: "EPSG:4326"
}

export interface V3RegionCatalogItem {
  packageId: string
  packageVersion: string
  checksum: string
  sceneType: SceneType
  regionCode: string
  title: string
  summary: string
  center: V3Coordinate
  boundary: V3Coordinate[]
  heightDatum: V3HeightDatum
  terrainResourceVersion: string
  /** Immutable map bundle identity used when a task is frozen. */
  mapResourceVersion?: string | null
  mapResourceManifest?: V3MapResourceManifest | null
  terrain?: V3TerrainResource | null
  imagery?: V3ImageryResource | null
  imageryState: V3RegionLayerState
  layers: V3RegionLayerDefinition[]
  logisticsNodes?: V3LogisticsNode[]
  vtlTaskObjects?: import("./vtl-types.js").VtlTaskObjectView[]
  vtlLandingSites?: import("./vtl-types.js").VtlLandingSiteView[]
  vtlAircraftParameters?: import("./vtl-types.js").VtlAircraftParameters
}

export type V3MapResourceKind = "TERRAIN" | "IMAGERY" | "ELEVATION_SNAPSHOT"
export type V3MapResourceReadinessStatus = "READY" | "MISSING" | "INVALID" | "EXTERNAL" | "UNCONFIGURED"

export interface V3MapResourceReadinessCheck {
  kind: V3MapResourceKind
  status: V3MapResourceReadinessStatus
  required: boolean
  message: string
  url: string | null
  localPath: string | null
  expectedSha256: string | null
  actualSha256: string | null
}

export type V3EnvironmentDiagnosticsStatus = "READY" | "INCOMPLETE" | "UNAVAILABLE"

export interface V3EnvironmentDiagnostics {
  status: V3EnvironmentDiagnosticsStatus
  layerPresent: boolean
  buildingCount: number
  obstacleCount: number
  missingHeightCount: number
  authoritativeSourceDeclared: boolean
  source: string | null
  version: string | null
  message: string
}

export interface V3RegionMapReadinessView {
  regionPackageId: string
  regionCode: string
  packageVersion: string
  checkedAt: string
  formalReady: boolean
  checks: V3MapResourceReadinessCheck[]
  environmentDiagnostics: V3EnvironmentDiagnostics
}

export const v3LogisticsNodeTypes = [
  "CENTER_AIRPORT",
  "TAKEOFF_POINT",
  "LANDING_POINT",
  "PARKING_POINT",
  "DELIVERY_POINT",
  "WAITING_POINT",
  "ALTERNATE_LANDING_POINT",
  "EMERGENCY_AREA"
] as const
export type V3LogisticsNodeType = (typeof v3LogisticsNodeTypes)[number]

export interface V3LogisticsNode {
  id: string
  code: string
  type: V3LogisticsNodeType
  name: string
  geometryType: "POINT" | "POLYGON"
  position?: V3Coordinate
  positions?: V3Coordinate[]
  enabled: boolean
  properties: Record<string, string | number | boolean>
}

export const v3ScenarioOverlayObjectTypes = [
  "LOGISTICS_CENTER",
  "DELIVERY_POINT",
  "ALTERNATE_LANDING_POINT",
  "WAITING_POINT",
  "AIRWAY",
  "FLIGHT_CORRIDOR",
  "FLYABLE_AREA",
  "TASK_POINT",
  "MISSION_POINT",
  "EMERGENCY_POINT",
  "OBSTACLE",
  "EVENT_AREA",
  "TEACHING_EVENT_AREA"
] as const
export type V3ScenarioOverlayObjectType = (typeof v3ScenarioOverlayObjectTypes)[number]
export type V3ScenarioOverlayGeometryType = "POINT" | "LINESTRING" | "POLYGON"
export type V3ScenarioOverlayVersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED"

export type V3ScenarioOverlayGeometry =
  | { type: "Point"; coordinates: [number, number] | [number, number, number] }
  | { type: "LineString"; coordinates: Array<[number, number] | [number, number, number]> }
  | { type: "Polygon"; coordinates: Array<Array<[number, number] | [number, number, number]>> }

export interface V3ScenarioOverlayObject {
  id: string
  code: string
  name: string
  type: V3ScenarioOverlayObjectType
  geometryType: V3ScenarioOverlayGeometryType
  geometry: V3ScenarioOverlayGeometry
  position?: V3Coordinate
  positions?: V3Coordinate[]
  properties: Record<string, string | number | boolean>
}

export interface V3ScenarioOverlayVersionView {
  id: string
  overlayId: string
  versionNo: number
  revision: number
  sceneType: SceneType
  regionPackageId: string
  title: string
  name: string
  status: V3ScenarioOverlayVersionStatus
  objects: V3ScenarioOverlayObject[]
  checksum: string
  createdById: string
  createdByName: string
  publishedAt: string | null
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type LogisticsRegionAnalysisStatus = "DRAFT" | "CONFIRMED"

export interface LogisticsRegionAnalysisView {
  id: string
  revision: number
  status: LogisticsRegionAnalysisStatus
  selectedDeliveryPointIds: string[]
  notes: string
  submittedAt: string | null
  updatedAt: string
}

export const logisticsRouteDirections = ["OUTBOUND", "RETURN"] as const
export type LogisticsRouteDirection = (typeof logisticsRouteDirections)[number]
export const logisticsRouteRoles = ["PRIMARY", "ALTERNATE"] as const
export type LogisticsRouteRole = (typeof logisticsRouteRoles)[number]
export const logisticsRouteModes = ["FIXED_ROUND_TRIP", "NETWORK_SEGMENT"] as const
export type LogisticsRouteMode = (typeof logisticsRouteModes)[number]

export interface LogisticsWaypointInput {
  id: string
  name: string
  position: V3Coordinate
  altitudeMeters: number
  segmentAltitudeMeters: number
  speedMps: number
  nodeId: string | null
  locked: boolean
}

export interface LogisticsRouteInput {
  id: string
  name: string
  mode?: LogisticsRouteMode
  destinationNodeId: string
  direction: LogisticsRouteDirection
  role: LogisticsRouteRole
  groupCode: string
  departureNodeId: string
  arrivalNodeId: string
  protectionRadiusMeters: number
  waitingNodeIds: string[]
  alternateLandingNodeIds: string[]
  emergencyAreaNodeIds: string[]
  entryDirectionDegrees: number
  exitDirectionDegrees: number
  waypoints: LogisticsWaypointInput[]
}

export interface LogisticsMapAnnotationInput {
  id: string
  label: string
  position: V3Coordinate
  heightMeters: number | null
}

export const logisticsRouteCheckCategories = ["SPATIAL", "AIRCRAFT", "COVERAGE", "NODES", "ROUTE_RELATION", "EFFICIENCY"] as const
export type LogisticsRouteCheckCategory = (typeof logisticsRouteCheckCategories)[number]
export type LogisticsRouteCheckSeverity = "CONFLICT" | "RISK" | "INFO"

export interface LogisticsRouteCheckEvidence {
  code: string
  category: LogisticsRouteCheckCategory
  severity: LogisticsRouteCheckSeverity
  blocking: boolean
  message: string
  routeIds: string[]
  waypointIds: string[]
  segmentIndexes: number[]
  position: V3Coordinate | null
  simulatedAtSeconds?: number | null
  data: Record<string, string | number | boolean>
}

export interface LogisticsRouteCheckCategorySummary {
  category: LogisticsRouteCheckCategory
  checked: true
  passed: boolean
  conflictCount: number
  riskCount: number
  infoCount: number
  evidenceCount: number
}

export interface LogisticsRouteCheckResult {
  passed: boolean
  checkedAt: string
  routeCount: number
  selectedDeliveryPointCount: number
  conflictCount: number
  riskCount: number
  infoCount: number
  categorySummaries?: LogisticsRouteCheckCategorySummary[]
  evidence: LogisticsRouteCheckEvidence[]
}

export interface LogisticsAircraftCapabilityView {
  modelCode: string
  cruiseSpeedMps: number
  maximumSpeedMps: number
  maximumHeightMeters: number
  maximumRoundTripMeters: number
  minimumReserveBatteryPercent: number
  climbRateMps: number
  ruleVersion: string
}

export interface LogisticsRouteMetricView {
  routeId: string
  routeName: string
  destinationNodeId: string
  direction: LogisticsRouteDirection
  role: LogisticsRouteRole
  distanceMeters: number
  flightTimeSeconds: number
  batteryConsumptionPercent: number
  remainingBatteryPercent: number
  maximumAltitudeMeters: number
  minimumCoveragePercent: number
  maximumTrackDeviationMeters: number
}

export const logisticsRoundTripMilestoneCodes = [
  "AIRPORT_TAKEOFF",
  "OUTBOUND_FLIGHT",
  "ARRIVAL_CONFIRMATION",
  "RETURN_FLIGHT",
  "AIRPORT_LANDING"
] as const
export type LogisticsRoundTripMilestoneCode = (typeof logisticsRoundTripMilestoneCodes)[number]

export interface LogisticsRoundTripMilestoneView {
  sequence: number
  code: LogisticsRoundTripMilestoneCode
  simulatedAtSeconds: number
  routeId: string
  position: V3Coordinate
  remainingBatteryPercent: number
}

export interface LogisticsRoundTripMetricView {
  destinationNodeId: string
  outboundRouteId: string
  returnRouteId: string
  distanceMeters: number
  flightTimeSeconds: number
  batteryConsumptionPercent: number
  remainingBatteryPercent: number
  completed: boolean
  milestones?: LogisticsRoundTripMilestoneView[]
}

export type LogisticsRouteValidationStatus = "PASSED" | "WITH_RISK" | "HARD_CONFLICT" | "INFEASIBLE"

export interface LogisticsRouteValidationResult {
  status: LogisticsRouteValidationStatus
  seed: string
  checkedAt: string
  aircraftModelCode?: string
  aircraftRuleVersion?: string
  completedRoundTripCount: number
  requiredRoundTripCount: number
  routeMetrics: LogisticsRouteMetricView[]
  roundTripMetrics: LogisticsRoundTripMetricView[]
  evidence: LogisticsRouteCheckEvidence[]
}

export type LogisticsRouteVersionStatus = "SNAPSHOT" | "VALIDATED" | "SUBMITTED"

export interface LogisticsRouteVersionView {
  id: string
  versionNo: number
  sourceDraftRevision: number
  status: LogisticsRouteVersionStatus
  routes: LogisticsRouteInput[]
  annotations: LogisticsMapAnnotationInput[]
  checkResult: LogisticsRouteCheckResult
  validationResult: LogisticsRouteValidationResult | null
  createdBy: string
  createdAt: string
  validatedAt: string | null
  submittedAt: string | null
}

export interface LogisticsRouteValidationRunView {
  id: string
  versionId: string
  attemptNo: number
  status: LogisticsRouteValidationStatus
  result: LogisticsRouteValidationResult
  createdAt: string
}

export interface LogisticsRouteDraftView {
  id: string
  revision: number
  routes: LogisticsRouteInput[]
  annotations: LogisticsMapAnnotationInput[]
  lastCheckResult: LogisticsRouteCheckResult | null
  updatedAt: string
}

export interface LogisticsRouteWorkspaceView {
  projectId: string
  actor: "STUDENT" | "TEACHER"
  mode: LearningMode
  scaleTemplateCode: string
  candidateDeliveryPointIds: string[]
  requiredDeliveryPointRange: { minimum: number; maximum: number }
  allowedValidationAttempts: number
  validationAttemptCount: number
  canEditRegion: boolean
  canConfirmRegion: boolean
  canEditRoutes: boolean
  canCompletePlanning: boolean
  canValidate: boolean
  canSubmit: boolean
  regionAnalysis: LogisticsRegionAnalysisView
  draft: LogisticsRouteDraftView
  versions: LogisticsRouteVersionView[]
  validationRuns: LogisticsRouteValidationRunView[]
  aircraft: LogisticsAircraftCapabilityView
}

export const logisticsOrderReleaseModes = ["BATCH", "STAGED", "DYNAMIC", "AT_PHASE"] as const
export type LogisticsOrderReleaseMode = (typeof logisticsOrderReleaseModes)[number]
export const logisticsOrderReleasePhases = ["PREPARATION", "WAITING_EXECUTION", "TAKEOFF", "OUTBOUND", "ARRIVAL_CONFIRMATION", "RETURNING", "LANDING"] as const
export type LogisticsOrderReleasePhase = (typeof logisticsOrderReleasePhases)[number]
export const logisticsPriorityProfiles = ["BALANCED", "URGENT_HEAVY", "STANDARD_HEAVY"] as const
export type LogisticsPriorityProfile = (typeof logisticsPriorityProfiles)[number]
export const logisticsOrderDistributionModes = ["UNIFORM", "FOCUSED", "MULTI_PEAK"] as const
export type LogisticsOrderDistributionMode = (typeof logisticsOrderDistributionModes)[number]
export const logisticsTimeWindowProfiles = ["NONE", "RELAXED", "NORMAL", "TIGHT", "MIXED"] as const
export type LogisticsTimeWindowProfile = (typeof logisticsTimeWindowProfiles)[number]
export const logisticsOrderPriorities = ["NORMAL", "PRIORITY", "URGENT"] as const
export type LogisticsSchedulingOrderPriority = (typeof logisticsOrderPriorities)[number]
export const logisticsOrderStatuses = ["UNRELEASED", "UNASSIGNED", "SCHEDULED"] as const
export type LogisticsSchedulingOrderStatus = (typeof logisticsOrderStatuses)[number]
export const logisticsAircraftAvailabilityStatuses = ["READY", "LOW_BATTERY", "UNAVAILABLE"] as const
export type LogisticsAircraftAvailabilityStatus = (typeof logisticsAircraftAvailabilityStatuses)[number]
export const logisticsWindDirections = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const
export type LogisticsWindDirection = (typeof logisticsWindDirections)[number]
export const logisticsWindForceStates = ["CALM", "NORMAL", "NEAR_LIMIT", "OVER_LIMIT"] as const
export type LogisticsWindForceState = (typeof logisticsWindForceStates)[number]
export const logisticsGustStates = ["NONE", "OCCASIONAL", "CONTINUOUS"] as const
export type LogisticsGustState = (typeof logisticsGustStates)[number]
export const logisticsRainStates = ["NONE", "BELOW_LIMIT", "OVER_LIMIT"] as const
export type LogisticsRainState = (typeof logisticsRainStates)[number]
export const logisticsSignalStates = ["NORMAL", "LOCAL_WEAK", "LOCAL_ABNORMAL", "CONTINUOUS_ABNORMAL", "RECOVERING"] as const
export type LogisticsSignalState = (typeof logisticsSignalStates)[number]

export interface LogisticsInitialFleetConfig {
  readyAircraftCount: number
  standbyAircraftCount: number
  lowBatteryAircraftCount: number
  preflightAbnormalAircraftCount: number
  unavailableAircraftCount: number
}

export interface LogisticsInitialEnvironmentConfig {
  windDirection: LogisticsWindDirection
  windForceState: LogisticsWindForceState
  gustState: LogisticsGustState
  rainState: LogisticsRainState
  positioningState: LogisticsSignalState
  communicationState: LogisticsSignalState
}

export interface LogisticsOrderGenerationConfig {
  orderCount: number
  releaseMode: LogisticsOrderReleaseMode
  releasePhase?: LogisticsOrderReleasePhase | null
  priorityProfile: LogisticsPriorityProfile
  deliveryDistributionMode: LogisticsOrderDistributionMode
  timeWindowProfile: LogisticsTimeWindowProfile
  timeWindowMinutes: number
  seed: string
  initialUnavailableAircraftCount: number
  initialLowBatteryAircraftCount: number
  initialFleet: LogisticsInitialFleetConfig
  initialEnvironment: LogisticsInitialEnvironmentConfig
}

export const showWindDirections = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const
export type ShowWindDirection = (typeof showWindDirections)[number]
export const showWindForceStates = ["NORMAL", "NEAR_LIMIT", "OVER_LIMIT"] as const
export type ShowWindForceState = (typeof showWindForceStates)[number]
export const showGustStates = ["NONE", "OCCASIONAL", "CONTINUOUS"] as const
export type ShowGustState = (typeof showGustStates)[number]
export const showRainStates = ["NONE", "BELOW_LIMIT", "OVER_LIMIT"] as const
export type ShowRainState = (typeof showRainStates)[number]
export const showPositioningElectromagneticStates = ["NORMAL", "LOCAL_WEAK", "LOCAL_ABNORMAL", "CONTINUOUS_INTERFERENCE", "WIDE_AREA_INTERFERENCE"] as const
export type ShowPositioningElectromagneticState = (typeof showPositioningElectromagneticStates)[number]
export const showCommunicationControlStates = ["NORMAL", "DELAY", "PACKET_LOSS", "SINGLE_LOST", "SMALL_BATCH_LOST", "GROUP_ABNORMAL", "MULTI_GROUP_ABNORMAL"] as const
export type ShowCommunicationControlState = (typeof showCommunicationControlStates)[number]
export const showInitialDeviceStates = ["NORMAL", "SELF_TEST_FAILURE", "BATTERY_ABNORMAL", "VOLTAGE_IMBALANCE", "POWER_SYSTEM_ABNORMAL", "FLIGHT_CONTROL_SENSOR_ABNORMAL", "RETURN_LANDING_ABNORMAL"] as const
export type ShowInitialDeviceState = (typeof showInitialDeviceStates)[number]
export const showInitialDeviceScopes = ["NONE", "SINGLE", "SMALL_BATCH", "GROUP", "MULTI_GROUP"] as const
export type ShowInitialDeviceScope = (typeof showInitialDeviceScopes)[number]

export interface ShowInitialConditionsConfig {
  windDirection: ShowWindDirection
  windForceState: ShowWindForceState
  gustState: ShowGustState
  rainState: ShowRainState
  positioningElectromagneticState: ShowPositioningElectromagneticState
  communicationControlState: ShowCommunicationControlState
  deviceState: ShowInitialDeviceState
  deviceImpactScope: ShowInitialDeviceScope
  deviceAffectedCount: number
}

export interface GeneratedLogisticsOrder {
  code: string
  destinationNodeId: string
  releaseTimeMs: number
  priority: LogisticsSchedulingOrderPriority
  earliestStartTimeMs: number
  latestArrivalTimeMs: number
}

export interface LogisticsOrderPreviewCount {
  key: string
  count: number
}

export interface LogisticsOrderPreviewPeak {
  minuteOffset: number
  orderCount: number
}

export interface LogisticsOrderPreviewView {
  generatorVersion: string
  checksum: string
  config: LogisticsOrderGenerationConfig
  candidateDeliveryPointIds: string[]
  destinationCounts: LogisticsOrderPreviewCount[]
  priorityCounts: LogisticsOrderPreviewCount[]
  releaseBatchCounts: LogisticsOrderPreviewCount[]
  peak: LogisticsOrderPreviewPeak
  samples: GeneratedLogisticsOrder[]
}

export interface LogisticsOrderBatchView {
  id: string
  generatorVersion: string
  seed: string
  checksum: string
  config: LogisticsOrderGenerationConfig
  createdAt: string
}

export interface LogisticsSchedulingOrderView extends GeneratedLogisticsOrder {
  id: string
  status: LogisticsSchedulingOrderStatus
}

export interface LogisticsAircraftInstanceView {
  id: string
  code: string
  modelCode: string
  initialBatteryPercent: number
  availableAtMs: number
  status: LogisticsAircraftAvailabilityStatus
}

export interface LogisticsSchedulingAircraftTaskView {
  scheduleItemId: string
  orderId: string
  orderCode: string
  destinationNodeId: string
  plannedTakeoffTimeMs: number
  arrivalTimeMs: number
  landingTimeMs: number
  nextAvailableTimeMs: number
}

export interface LogisticsSchedulingAircraftView extends LogisticsAircraftInstanceView {
  currentLocation: {
    type: "CENTER_AIRPORT"
    label: string
  }
  taskQueue: LogisticsSchedulingAircraftTaskView[]
  estimatedReturnTimeMs: number | null
  nextAvailableTimeMs: number
}

export interface LogisticsSchedulingRouteView {
  id: string
  versionId: string
  versionNo: number
  validationStatus?: LogisticsRouteValidationStatus
  route: LogisticsRouteInput
  distanceMeters: number
  flightTimeMs: number
  batteryConsumptionPercent: number
}

export interface LogisticsScheduleItemInput {
  id: string
  orderId: string
  aircraftId: string
  outboundRouteId: string
  returnRouteId: string
  plannedTakeoffTimeMs: number
}

export interface LogisticsScheduleItemView extends LogisticsScheduleItemInput {
  orderCode: string
  aircraftCode: string
  destinationNodeId: string
  arrivalTimeMs: number
  returnStartTimeMs: number
  landingTimeMs: number
  nextAvailableTimeMs: number
  batteryAfterMissionPercent: number
}

export const logisticsBatchScheduleGroups = ["MANUAL", "DELIVERY_POINT", "PRIORITY", "OUTBOUND_ROUTE", "AIRCRAFT"] as const
export type LogisticsBatchScheduleGroup = (typeof logisticsBatchScheduleGroups)[number]
export type LogisticsBatchSchedulingMode = "NONE" | "LIMITED" | "FULL"

export interface LogisticsBatchScheduleAdjustmentInput {
  expectedRevision: number
  orderIds: string[]
  group: {
    type: LogisticsBatchScheduleGroup
    value: string
  }
  adjustment: {
    aircraftId?: string
    outboundRouteId?: string
    returnRouteId?: string
    takeoffShiftMs?: number
  }
}

export type LogisticsScheduleCheckCategory = "COMPLETENESS" | "ORDER" | "AIRCRAFT" | "ROUTE" | "TIME" | "TRAFFIC" | "EFFICIENCY"
export type LogisticsScheduleCheckSeverity = "CONFLICT" | "RISK" | "INFO"

export interface LogisticsScheduleCheckEvidence {
  code: string
  category: LogisticsScheduleCheckCategory
  severity: LogisticsScheduleCheckSeverity
  blocking: boolean
  message: string
  orderIds: string[]
  aircraftIds: string[]
  scheduleItemIds: string[]
  routeIds: string[]
  timeRangeMs: [number, number] | null
  data: Record<string, string | number | boolean>
}

export type LogisticsScheduleCheckStatus = "PASSED" | "WITH_RISK" | "HARD_CONFLICT"

export interface LogisticsScheduleCheckResult {
  status: LogisticsScheduleCheckStatus
  submittable: boolean
  checkedAt: string
  orderCount: number
  assignedOrderCount: number
  scheduledAircraftCount: number
  conflictCount: number
  riskCount: number
  infoCount: number
  items: LogisticsScheduleItemView[]
  evidence: LogisticsScheduleCheckEvidence[]
}

export interface LogisticsScheduleDraftView {
  id: string
  revision: number
  items: LogisticsScheduleItemInput[]
  lastCheckResult: LogisticsScheduleCheckResult | null
  updatedAt: string
}

export type LogisticsScheduleVersionStatus = "SNAPSHOT" | "SUBMITTED"

export interface LogisticsScheduleVersionView {
  id: string
  versionNo: number
  sourceDraftRevision: number
  status: LogisticsScheduleVersionStatus
  items: LogisticsScheduleItemInput[]
  checkResult: LogisticsScheduleCheckResult
  createdBy: string
  createdAt: string
  submittedAt: string | null
}

export interface LogisticsSchedulingWorkspaceView {
  projectId: string
  actor: "STUDENT" | "TEACHER"
  mode: LearningMode
  scaleTemplateCode: string
  strictSerialOperation: boolean
  batchSchedulingMode: LogisticsBatchSchedulingMode
  canEdit: boolean
  canCheck: boolean
  canCreateVersion: boolean
  canSubmit: boolean
  orderBatch: LogisticsOrderBatchView
  orders: LogisticsSchedulingOrderView[]
  aircraft: LogisticsSchedulingAircraftView[]
  routes: LogisticsSchedulingRouteView[]
  draft: LogisticsScheduleDraftView
  versions: LogisticsScheduleVersionView[]
}

export const logisticsReadinessDecisions = ["PROCEED", "PROCEED_AFTER_ADJUSTMENT", "DELAY", "CANCEL"] as const
export type LogisticsReadinessDecision = (typeof logisticsReadinessDecisions)[number]
export type LogisticsReadinessStatus = "DRAFT" | "CONFIRMED"
export type LogisticsReadinessCheckStatus = "PASS" | "WARNING" | "FAIL"
export type LogisticsReadinessCheckCategory = "AIRCRAFT" | "ROUTE" | "ORDER" | "ENVIRONMENT" | "NODE" | "SCHEDULE"

export interface LogisticsReadinessCheckItemView {
  code: string
  category: LogisticsReadinessCheckCategory
  status: LogisticsReadinessCheckStatus
  blocking: boolean
  title: string
  detail: string
  entityIds: string[]
}

export interface LogisticsRuntimeReadinessView {
  id: string
  projectId: string
  scheduleVersionId: string
  scheduleVersionNo: number
  status: LogisticsReadinessStatus
  revision: number
  decision: LogisticsReadinessDecision | null
  decisionBasis: string
  checks: LogisticsReadinessCheckItemView[]
  confirmedAt: string | null
  updatedAt: string
}

export interface LogisticsRuntimeReadinessWorkspaceView {
  projectId: string
  actor: "STUDENT" | "TEACHER"
  mode: LearningMode
  scaleTemplateCode: string
  canEdit: boolean
  canCheck: boolean
  canConfirm: boolean
  submittedSchedule: LogisticsScheduleVersionView
  readiness: LogisticsRuntimeReadinessView
}

export const logisticsRuntimeTaskStatuses = [
  "WAITING_EXECUTION",
  "TAKEOFF",
  "OUTBOUND",
  "ARRIVAL_CONFIRMATION",
  "RETURNING",
  "LANDING",
  "AVAILABLE_AGAIN",
  "CANCELLED",
  "FAILED"
] as const
export type LogisticsRuntimeTaskStatus = (typeof logisticsRuntimeTaskStatuses)[number]

export const logisticsRuntimeAircraftStatuses = [
  "STANDBY",
  "AVAILABLE",
  "ASSIGNED",
  "TAKING_OFF",
  "OUTBOUND",
  "ARRIVED",
  "RETURNING",
  "LANDING",
  "HOLDING",
  "DIVERTING",
  "EMERGENCY_LANDING",
  "DISABLED"
] as const
export type LogisticsRuntimeAircraftStatus = (typeof logisticsRuntimeAircraftStatuses)[number]

export const logisticsRuntimeOrderStatuses = [
  "UNRELEASED",
  "UNASSIGNED",
  "SCHEDULED",
  "DELIVERING",
  "COMPLETED",
  "EXPECTED_DELAY",
  "DELAYED",
  "FAILED",
  "CANCELLED"
] as const
export type LogisticsRuntimeOrderStatus = (typeof logisticsRuntimeOrderStatuses)[number]

export const logisticsRuntimeRouteStatuses = ["AVAILABLE", "RISK", "PAUSED", "ABNORMAL", "RECOVERING", "CLOSED"] as const
export type LogisticsRuntimeRouteStatus = (typeof logisticsRuntimeRouteStatuses)[number]

export const logisticsRuntimeEventCategories = [
  "WEATHER_ENVIRONMENT",
  "POSITIONING_NAVIGATION",
  "COMMUNICATION_LINK",
  "AIRCRAFT_DEVICE",
  "ROUTE_OPERATION",
  "ORDER_TASK_CHANGE"
] as const
export type LogisticsRuntimeEventCategory = (typeof logisticsRuntimeEventCategories)[number]

export const logisticsRuntimeEventLifecycleStatuses = [
  "SCHEDULED",
  "OCCURRED_UNDETECTED",
  "DISCOVERED",
  "HANDLING",
  "CONTROLLED",
  "ESCALATED",
  "ENDED"
] as const
export type LogisticsRuntimeEventLifecycleStatus = (typeof logisticsRuntimeEventLifecycleStatuses)[number]

export const logisticsRuntimeActionCodes = [
  "ACKNOWLEDGE_ALERT",
  "CONTINUE_MONITORING",
  "REDUCE_SPEED",
  "MAINTAIN_ROUTE",
  "HOLD_POSITION",
  "PROCEED_TO_WAITING_POINT",
  "RETURN_AIRCRAFT",
  "DIVERT_AIRCRAFT",
  "EMERGENCY_LAND_AIRCRAFT",
  "ABORT_TASK",
  "PAUSE_ROUTE_ENTRY",
  "PAUSE_ROUTE",
  "RESUME_ROUTE",
  "SWITCH_VERIFIED_ROUTE",
  "REPLACE_AIRCRAFT",
  "REASSIGN_ORDER",
  "CHANGE_PRIORITY",
  "DELAY_TASK",
  "CANCEL_TASK",
  "BATCH_REASSIGN",
  "GLOBAL_RESCHEDULE"
] as const
export type LogisticsRuntimeActionCode = (typeof logisticsRuntimeActionCodes)[number]

export type LogisticsRuntimeActionTargetType = "ALERT" | "AIRCRAFT" | "ORDER" | "ROUTE" | "SCHEDULE" | "BATCH" | "GLOBAL"

export interface LogisticsRuntimeEventConfig {
  code: string
  title: string
  category: LogisticsRuntimeEventCategory
  triggerStage: "PREPARATION" | LogisticsRuntimeTaskStatus
  triggerMode: "FIXED_TIME" | "TIME_RANGE" | "CONDITION" | "PREVIOUS_EVENT"
  triggerAtMs: number | null
  triggerWindowMs: [number, number] | null
  targetType: "AIRCRAFT" | "ORDER" | "ROUTE" | "AREA" | "GLOBAL"
  targetIds: string[]
  severity: V3AlertSeverity
  durationMs: number | null
  recoveryMode: "FIXED_DURATION" | "STUDENT_ACTION" | "CONDITION" | "UNTIL_END"
  escalationAfterMs: number | null
  recommendedActions: LogisticsRuntimeActionCode[]
}

export interface LogisticsRuntimeTaskView {
  scheduleItemId: string
  orderId: string
  orderCode: string
  aircraftId: string
  aircraftCode: string
  destinationNodeId: string
  status: LogisticsRuntimeTaskStatus
  outboundRouteId: string
  returnRouteId: string
  activeRouteId: string | null
  plannedTakeoffTimeMs: number
  arrivalTimeMs: number
  returnStartTimeMs: number
  landingTimeMs: number
  nextAvailableTimeMs: number
  position: V3Coordinate
  speedMps: number
  batteryPercent: number
  delayedByMs: number
}

export interface LogisticsRuntimeAircraftView {
  id: string
  code: string
  modelCode?: string
  status: LogisticsRuntimeAircraftStatus
  currentTaskId: string | null
  currentOrderId: string | null
  position: V3Coordinate
  speedMps: number
  batteryPercent: number
  nextAvailableTimeMs: number
}

export interface LogisticsRuntimeOrderView {
  id: string
  code: string
  priority: LogisticsSchedulingOrderPriority
  destinationNodeId: string
  status: LogisticsRuntimeOrderStatus
  assignedAircraftId: string | null
  scheduleItemId: string | null
  releaseTimeMs: number
  latestArrivalTimeMs: number
  expectedArrivalTimeMs: number | null
}

export interface LogisticsRuntimeRouteView {
  id: string
  name: string
  destinationNodeId: string
  direction: LogisticsRouteDirection
  role: LogisticsRouteRole
  sourceVersionId: string
  sourceVersionNo: number
  validationStatus: LogisticsRouteValidationStatus
  status: LogisticsRuntimeRouteStatus
  activeTaskCount: number
  affectedEventIds: string[]
  waypoints: LogisticsWaypointInput[]
}

export interface LogisticsRuntimeEnvironmentView {
  windDirection: LogisticsWindDirection
  windState: "NORMAL" | "NEAR_LIMIT" | "OVER_LIMIT"
  gustState: "NONE" | "OCCASIONAL" | "CONTINUOUS"
  rainState: "NONE" | "BELOW_LIMIT" | "OVER_LIMIT"
  positioningQuality: "GOOD" | "DEGRADED" | "LOST"
  communicationQuality: "GOOD" | "DEGRADED" | "LOST"
  equipmentState: "NORMAL" | "WARNING" | "FAULT"
  operationState: "NORMAL" | "RESTRICTED" | "SUSPENDED"
}

export interface LogisticsRuntimeSummaryView {
  totalAircraft: number
  availableAircraft: number
  assignedAircraft: number
  airborneAircraft: number
  holdingAircraft: number
  warningAircraft: number
  disabledAircraft: number
  totalOrders: number
  unreleasedOrders: number
  waitingOrders: number
  deliveringOrders: number
  completedOrders: number
  delayedOrders: number
  failedOrders: number
  cancelledOrders: number
}

export interface LogisticsRuntimeEventView extends V3RuntimeEventView {
  category: LogisticsRuntimeEventCategory
  lifecycleStatus: LogisticsRuntimeEventLifecycleStatus
  title: string
  detail: string
  affectedAircraftIds: string[]
  affectedOrderIds: string[]
  affectedRouteIds: string[]
  recommendedActions: LogisticsRuntimeActionCode[]
  detectedSimulationTimeMs: number | null
  controlledSimulationTimeMs: number | null
}

export interface LogisticsRuntimeAvailableActionView {
  code: LogisticsRuntimeActionCode
  title: string
  targetType: LogisticsRuntimeActionTargetType
  requiresTarget: boolean
  enabled: boolean
  disabledReason: string | null
  eligibleTargetIds: string[]
  eligibleRouteIdsByTargetId: Record<string, string[]>
}

export type LogisticsDynamicScheduleVersionStatus = "DRAFT" | "SUBMITTED"
export type LogisticsDynamicScheduleMode = "SINGLE" | "BATCH" | "GLOBAL"

export interface LogisticsDynamicScheduleVersionView {
  id: string
  versionNo: number
  parentVersionId: string | null
  status: LogisticsDynamicScheduleVersionStatus
  mode: LogisticsDynamicScheduleMode
  reason: string
  eventId: string | null
  affectedOrderIds: string[]
  affectedAircraftIds: string[]
  affectedRouteIds: string[]
  effectiveSimulationTimeMs: number
  items: LogisticsScheduleItemInput[]
  checkResult: LogisticsScheduleCheckResult
  contentHash: string
  createdBy: string
  submittedBy: string | null
  createdAt: string
  submittedAt: string | null
}

export interface LogisticsRuntimeWorkspaceView {
  projectId: string
  actor: "STUDENT" | "TEACHER"
  mode: LearningMode
  scaleTemplateCode: string
  session: V3RuntimeSessionView
  clock?: import("./runtime-contracts.js").RuntimeClock
  attempts: V3RuntimeSessionView[]
  restartNodes: V3RuntimeRestartNodeView[]
  attemptsRemaining: number
  canRestart: boolean
  canStart: boolean
  canControl: boolean
  canTeacherIntervene: boolean
  clockRate: number
  durationMs: number
  remainingMs: number
  summary: LogisticsRuntimeSummaryView
  environment: LogisticsRuntimeEnvironmentView
  scheduleItems: LogisticsScheduleItemView[]
  tasks: LogisticsRuntimeTaskView[]
  aircraft: LogisticsRuntimeAircraftView[]
  orders: LogisticsRuntimeOrderView[]
  routes: LogisticsRuntimeRouteView[]
  events: LogisticsRuntimeEventView[]
  alerts: V3RuntimeAlertView[]
  actions: V3StudentRuntimeActionView[]
  availableActions: LogisticsRuntimeAvailableActionView[]
  dynamicScheduleVersions: LogisticsDynamicScheduleVersionView[]
}

export interface AssignmentTargetInput {
  type: AssignmentTargetType
  targetId: string
}

export const v3ScenarioEventTriggerModes = ["AUTO", "SIMULATION_TIME", "PHASE", "TIME_RANGE", "CONDITION", "AFTER_EVENT"] as const
export type V3ScenarioEventTriggerMode = (typeof v3ScenarioEventTriggerModes)[number]

export const v3ScenarioEventRecoveryModes = ["STUDENT", "AUTO", "CONDITION", "UNTIL_END"] as const
export type V3ScenarioEventRecoveryMode = (typeof v3ScenarioEventRecoveryModes)[number]

export const v3ScenarioEventImpactScopes = [
  "DEFAULT",
  "SINGLE",
  "SMALL_BATCH",
  "GROUP",
  "MULTI_GROUP",
  "LOCAL_AREA",
  "MOST",
  "WHOLE",
  "SINGLE_ROUTE",
  "MULTI_ROUTE",
  "OVERALL"
] as const
export type V3ScenarioEventImpactScope = (typeof v3ScenarioEventImpactScopes)[number]

export const v3ScenarioEventVisibilityModes = ["DIRECT", "AFTER_STATE_CHANGE", "PARTIAL_DELAY"] as const
export type V3ScenarioEventVisibilityMode = (typeof v3ScenarioEventVisibilityModes)[number]

export const v3ScenarioEventConditionTypes = [
  "PHASE",
  "SIMULATION_TIME",
  "MIN_AIRBORNE_AIRCRAFT",
  "MIN_ACTIVE_ORDERS",
  "ROUTE_STATUS",
  "EVENT_STATUS"
] as const
export type V3ScenarioEventConditionType = (typeof v3ScenarioEventConditionTypes)[number]

export interface V3ScenarioEventCondition {
  type: V3ScenarioEventConditionType
  operator: "EQ" | "GTE" | "LTE"
  value: string | number
  targetId?: string | null
}

export interface V3ScenarioEventConfig {
  code: string
  eventSubtype?: import("./logistics-event-subtypes.js").LogisticsScenarioEventSubtype | null
  triggerMode: V3ScenarioEventTriggerMode
  triggerTimeSeconds: number | null
  triggerPhase: string | null
  triggerOffsetSeconds: number
  severity: V3AlertSeverity | null
  detectionDelaySeconds: number | null
  escalationDelaySeconds: number | null
  durationSeconds: number | null
  recoveryMode: V3ScenarioEventRecoveryMode
  triggerWindowSeconds?: [number, number] | null
  triggerCondition?: V3ScenarioEventCondition | null
  triggerAfterEventCode?: string | null
  impactScope?: V3ScenarioEventImpactScope
  impactCount?: number | null
  targetIds?: string[]
  visibilityMode?: V3ScenarioEventVisibilityMode
  escalationEnabled?: boolean
  followUpEventCode?: string | null
  recoveryCondition?: V3ScenarioEventCondition | null
  actionDeadlineSeconds?: number | null
}

export interface AssignmentDraftConfig {
  taskBrief: string
  showParameters?: ShowAssignmentParameters
  logisticsParameters?: LogisticsAssignmentParameters
  vtlParameters?: import("./vtl-types.js").VtlAssignmentParameters
  scaleTemplateCode: string
  showProgramPackageId?: string | null
  questionBankVersionId?: string | null
  regionPackageId: string
  scenarioOverlayVersionId?: string | null
  availableAt: string
  dueAt: string
  assessmentDurationMinutes: number
  allowResubmission: boolean
  allowedValidationAttempts: number
  allowedRuntimeAttempts: number
  resultVisibility: "TOTAL_ONLY" | "DIMENSIONS" | "FULL_REVIEW"
  scenario: Record<string, unknown>
}

export const assessmentTimingStates = [
  "NOT_APPLICABLE",
  "NOT_OPEN",
  "NOT_STARTED",
  "ACTIVE",
  "EXPIRED",
  "SUBMITTED"
] as const
export type AssessmentTimingState = (typeof assessmentTimingStates)[number]

export interface AssessmentTimingView {
  state: AssessmentTimingState
  durationMinutes: number | null
  availableAt: string
  assignmentDueAt: string
  startedAt: string | null
  deadlineAt: string | null
  submittedAt: string | null
  endedAt: string | null
  serverNow: string
  remainingMs: number | null
  canStart: boolean
  canWrite: boolean
  blockedReason: string | null
}

export interface LogisticsAssignmentParameters {
  projectBackground: string
  completionRequirements: string
  plannedStartAt: string
  plannedEndAt: string
}

export interface ShowAssignmentParameters {
  projectBackground: string
  completionRequirements: string
  plannedStartAt: string
  plannedEndAt: string
  plannedAudienceCount: number
  maximumHeightMeters: number
  contactName: string
  contactPhone: string
  aircraftModel: string
}

export interface AssignmentTargetView {
  type: AssignmentTargetType
  targetId: string
  name: string
  detail: string
}

export const assignmentPreflightLevels = ["BLOCKING", "WARNING", "PASSED"] as const
export type AssignmentPreflightLevel = (typeof assignmentPreflightLevels)[number]
export type AssignmentPreflightCategory = "CONFIGURATION" | "RESOURCE" | "MAP" | "SCENARIO" | "SCOPE"
export type AssignmentPreflightStep = 0 | 1 | 2 | 3
export type AssignmentPreflightFocusTarget =
  | "task-title"
  | "question-bank"
  | "scale-template"
  | "region"
  | "show-program"
  | "resource-dependencies"
  | "map-resource"
  | "show-schedule"
  | "logistics-candidate-points"
  | "logistics-runtime-schedule"
  | "logistics-order-config"
  | "vtl-runtime-schedule"
  | "vtl-main-landing-site"
  | "vtl-task-objects"
  | "vtl-task-area"
  | "vtl-open-stages"
  | "vtl-evaluation-items"
  | "scenario-events"
  | "publish-classroom"
  | "publish-schedule"

export interface AssignmentPreflightCheckView {
  code: string
  category: AssignmentPreflightCategory
  level: AssignmentPreflightLevel
  title: string
  message: string
  action: string
  step: AssignmentPreflightStep
  focusTarget?: AssignmentPreflightFocusTarget
}

export interface AssignmentPreflightView {
  draftId: string
  draftRevision: number
  checkedAt: string
  formalMapRequired: boolean
  regionMapReadiness: V3RegionMapReadinessView | null
  summary: {
    blocking: number
    warning: number
    passed: number
  }
  checks: AssignmentPreflightCheckView[]
}

export interface AssignmentDraftDetailView {
  assignment: AssignmentDraftView
  snapshot: AssignmentSnapshotView | null
  targets: AssignmentTargetView[]
  projectCount: number
  startedProjectCount: number
}

export interface AssignmentPreviewView {
  draft: AssignmentDraftView
  configHash: string
  resourceRefs: V3ResourceReference[]
  targets: AssignmentTargetInput[]
  studentCount: number
  stageDefinitions: StageDefinition[]
  logisticsOrderPreview: LogisticsOrderPreviewView | null
  regionMapReadiness: V3RegionMapReadinessView | null
  formalMapRequired: boolean
}

export interface AssignmentResourceUpgradeChangeView {
  packageType: ResourcePackageType
  current: V3ResourceReference
  replacement: V3ResourceReference
}

export interface AssignmentUpgradePreviewView {
  assignmentId: string
  eligible: boolean
  reason: string | null
  expectedRevision: number
  snapshotId: string
  snapshotChecksum: string
  projectCount: number
  startedProjectCount: number
  currentResourceRefs: V3ResourceReference[]
  candidateResourceRefs: V3ResourceReference[] | null
  candidateConfig: AssignmentDraftConfig | null
  candidateSnapshotChecksum: string | null
  changes: AssignmentResourceUpgradeChangeView[]
}

export interface AssignmentUpgradeResultView {
  assignment: AssignmentDraftView
  snapshot: AssignmentSnapshotView
  changes: AssignmentResourceUpgradeChangeView[]
}

export interface AssignmentDraftView {
  id: string
  title: string
  displayTitle?: string
  sceneType: SceneType
  mode: LearningMode
  status: AssignmentDraftStatus
  isDemo: boolean
  isAcceptanceData: boolean
  config: AssignmentDraftConfig
  revision: number
  configHash: string | null
  endedAt: string | null
  archivedAt: string | null
  lifecycleReason: string | null
  createdAt: string
  updatedAt: string
}

export interface AssignmentTargetClassroomView {
  id: string
  code: string
  name: string
  courseName: string
}

export interface V3TeachingAssignmentSummary {
  projectCount: number
  notStartedProjectCount: number
  inProgressProjectCount: number
  blockedProjectCount: number
  submittedProjectCount: number
  openAlertCount: number
  pendingEvaluationCount: number
  studentAttentionCount: number
}

export interface V3TeachingAssignmentView extends AssignmentDraftView {
  summary: V3TeachingAssignmentSummary
  targetClassrooms?: AssignmentTargetClassroomView[]
}

export interface AssignmentSnapshotView {
  id: string
  draftId: string
  schemaVersion: 3
  title: string
  displayTitle?: string
  sceneType: SceneType
  mode: LearningMode
  isDemo: boolean
  isAcceptanceData: boolean
  config: AssignmentDraftConfig
  resourceRefs: V3ResourceReference[]
  resourceRevision: number
  mapResourceVersion: string
  sceneResourceVersion: string
  planVersion: string
  checksum: string
  publishedAt: string
}

export interface StudentProjectStageView {
  stageCode: V3StageCode
  sequence: number
  title: string
  description: string
  openCondition: string
  status: StageStatus
  revision: number
  allowedActions: StageAction[]
}

export interface AssessmentAttemptView {
  attemptNumber: number
  isRetake: boolean
  retakeOfProjectId: string | null
  retakeReason: string | null
  retakeCreatedAt: string | null
}

export interface StudentProjectView {
  id: string
  assignmentSnapshotId: string
  title: string
  displayTitle?: string
  sceneType: SceneType
  mode: LearningMode
  assignmentStatus: AssignmentDraftStatus
  isDemo: boolean
  isAcceptanceData: boolean
  status: StudentProjectStatus
  currentStageCode: V3StageCode
  stages: StudentProjectStageView[]
  assessmentAttempt: AssessmentAttemptView
  assessmentTiming: AssessmentTimingView
  lastActivityAt: string
}

export const stageActions = ["OPEN", "START", "SUBMIT", "ACCEPT", "RETURN", "RESUME"] as const
export type StageAction = (typeof stageActions)[number]

export interface StageDefinition {
  code: V3StageCode
  sequence: number
  title: string
  description: string
  prerequisiteCodes: readonly V3StageCode[]
}

export type V3ProgressSubmissionState = "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED"
export type V3ProgressAlertState = "NONE" | "OPEN"
export type V3ProgressEvaluationState = "NOT_STARTED" | "PENDING" | "PUBLISHED"

export const v3TeacherProgressMilestoneCodes = [
  "SHOW_DOCUMENTS",
  "SHOW_T_MINUS_60",
  "SHOW_RUNTIME",
  "SHOW_FLIGHT_END_REPORT",
  "LOGISTICS_ROUTE_SUBMISSION",
  "LOGISTICS_ROUTE_VALIDATION",
  "LOGISTICS_SCHEDULE",
  "LOGISTICS_RUNTIME",
  "LOGISTICS_REVIEW",
  "VTL_ALLOCATION",
  "VTL_ROUTE",
  "VTL_VALIDATION",
  "VTL_RUNTIME",
  "VTL_REVIEW"
] as const
export type V3TeacherProgressMilestoneCode = (typeof v3TeacherProgressMilestoneCodes)[number]

export const v3TeacherProgressMilestoneStates = [
  "NOT_STARTED",
  "IN_PROGRESS",
  "SUBMITTED",
  "PASSED",
  "WITH_RISK",
  "ATTENTION",
  "COMPLETED",
  "PAUSED",
  "ABORTED"
] as const
export type V3TeacherProgressMilestoneState = (typeof v3TeacherProgressMilestoneStates)[number]

export interface V3TeacherProgressMilestone {
  code: V3TeacherProgressMilestoneCode
  label: string
  state: V3TeacherProgressMilestoneState
  detail: string
}

export interface V3TeacherProgressItem {
  projectId: string
  studentId: string
  studentName: string
  assignmentId: string
  assignmentSnapshotId: string
  assignmentTitle: string
  assignmentDisplayTitle?: string
  sceneType: SceneType
  mode: LearningMode
  isDemo: boolean
  isAcceptanceData: boolean
  projectStatus: StudentProjectStatus
  currentStageCode: V3StageCode
  currentStageTitle: string
  submissionState: V3ProgressSubmissionState
  alertState: V3ProgressAlertState
  alerts: V3RuntimeAlertView[]
  evaluationState: V3ProgressEvaluationState
  milestones: V3TeacherProgressMilestone[]
  assessmentAttempt: AssessmentAttemptView
  assessmentTiming: AssessmentTimingView
  canCreateAssessmentRetake: boolean
  lastActivityAt: string
}

export interface V3TeacherProgressPage {
  items: V3TeacherProgressItem[]
  page: number
  pageSize: number
  total: number
  hasNext: boolean
}

export interface V3TeachingMetric {
  key: "DRAFTS" | "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" | "ALERTS" | "EVALUATION"
  label: string
  value: number
  detail: string
}

export interface V3TeachingOverview {
  metrics: V3TeachingMetric[]
  assignments: V3TeachingAssignmentView[]
  drafts: V3TeachingAssignmentView[]
  recentProgress: V3TeacherProgressItem[]
}

export interface V3ActivityEventView {
  id: string
  assignmentId: string | null
  projectId: string | null
  stageCode: V3StageCode | null
  actorId: string
  actorName: string
  actorRole: UserRole
  eventType: V3ActivityEventType
  objectType: V3ActivityObjectType
  objectId: string | null
  realTime: string
  simulationTimeMs: number | null
  beforeRevision: number | null
  afterRevision: number | null
  payload: Record<string, unknown>
  result: Record<string, unknown>
  correlationId: string | null
}

export const v3RuntimeSessionStatuses = ["READY", "RUNNING", "PAUSED", "COMPLETED", "ABORTED", "FAILED"] as const
export type V3RuntimeSessionStatus = (typeof v3RuntimeSessionStatuses)[number]

export const v3RuntimeEventStatuses = ["SCHEDULED", "ACTIVE", "RESOLVED", "CANCELLED"] as const
export type V3RuntimeEventStatus = (typeof v3RuntimeEventStatuses)[number]

export const v3AlertSeverities = ["INFO", "WARNING", "ERROR", "CRITICAL"] as const
export type V3AlertSeverity = (typeof v3AlertSeverities)[number]

export const v3RuntimeAlertStatuses = ["OPEN", "ACKNOWLEDGED", "RESOLVED"] as const
export type V3RuntimeAlertStatus = (typeof v3RuntimeAlertStatuses)[number]

export const v3TeacherAlertFollowUpStatuses = ["WATCHING", "CLOSED"] as const
export type V3TeacherAlertFollowUpStatus = (typeof v3TeacherAlertFollowUpStatuses)[number]

export interface V3TeacherAlertFollowUpView {
  status: V3TeacherAlertFollowUpStatus
  note: string
  updatedAt: string
}

export const v3StudentActionStatuses = ["REQUESTED", "ACCEPTED", "REJECTED", "APPLIED", "FAILED"] as const
export type V3StudentActionStatus = (typeof v3StudentActionStatuses)[number]

export const v3EvaluationStatuses = ["PENDING", "REVIEWED", "PUBLISHED"] as const
export type V3EvaluationStatus = (typeof v3EvaluationStatuses)[number]

export interface V3RuntimeSessionView {
  id: string
  projectId: string
  status: V3RuntimeSessionStatus
  scenarioSeed: string
  mode?: LearningMode | null
  mapResourceVersion?: string | null
  sceneResourceVersion?: string | null
  planVersion?: string | null
  attemptNo: number
  sourceSessionId: string | null
  restartNodeCode: string | null
  restartSimulationTimeMs: number | null
  simulationTimeMs: number
  revision: number
  checkpoint: Record<string, unknown>
  startedAt: string | null
  endedAt: string | null
}

export interface V3RuntimeStreamSnapshot<TWorkspace = unknown> {
  protocol: "wurenji-runtime-stream-v1"
  contractProtocol?: "wurenji-runtime-contract-v1"
  messageType?: "SNAPSHOT"
  revision: number
  resumedFromRevision: number | null
  workspace: TWorkspace
}

export interface V3RuntimeEventView {
  id: string
  projectId: string
  sessionId: string
  stageCode: V3StageCode
  code: string
  category: string
  status: V3RuntimeEventStatus
  severity: V3AlertSeverity
  scheduledSimulationTimeMs: number | null
  triggeredSimulationTimeMs: number | null
  resolvedSimulationTimeMs: number | null
  triggeredAt: string | null
  resolvedAt: string | null
  payload: Record<string, unknown>
  correlationId: string
}

export interface V3RuntimeAlertView {
  id: string
  projectId: string
  sessionId: string | null
  eventId: string | null
  stageCode: V3StageCode
  code: string
  title: string
  detail: string
  severity: V3AlertSeverity
  status: V3RuntimeAlertStatus
  simulationTimeMs: number | null
  openedAt: string
  acknowledgedAt: string | null
  resolvedAt: string | null
  payload: Record<string, unknown>
  correlationId: string
  teacherFollowUp?: V3TeacherAlertFollowUpView | null
}

export type V3RuntimeRestartNodeKind = "PHASE" | "EVENT"

export interface V3RuntimeRestartNodeView {
  code: string
  label: string
  kind: V3RuntimeRestartNodeKind
  sourceSessionId: string
  simulationTimeMs: number
  detail: string
}

export interface V3RuntimeActionReasoning {
  observation: string
  rationale: string
  expectedOutcome: string
}

export interface V3StudentRuntimeActionView {
  id: string
  projectId: string
  sessionId: string
  eventId: string | null
  alertId: string | null
  actorId: string
  actionCode: string
  targetType: string
  targetId: string | null
  status: V3StudentActionStatus
  simulationTimeMs: number
  payload: Record<string, unknown>
  result: Record<string, unknown>
  correlationId: string
  requestedAt: string
  appliedAt: string | null
}

export interface V3ProjectEvaluationView {
  id: string
  projectId: string
  status: V3EvaluationStatus
  rubricVersion: string
  objectiveMetrics: ShowObjectiveMetricView[]
  teacherScores: ShowTeacherScoreView[]
  studentSummary: string
  studentSummaryStructured?: V3StudentReviewSummaryView | null
  logisticsStudentSummaryStructured?: V3LogisticsStudentReviewSummaryView | null
  studentSubmittedAt: string | null
  summary: string
  totalScore: number | null
  revision: number
  reviewedAt: string | null
  publishedAt: string | null
}

export interface V3StudentReviewSummaryView {
  completion: string
  problems: string
  decisions: string
  improvements: string
}

export interface V3LogisticsStudentReviewSummaryView {
  originalPlanProblems: string
  responseLessons: string
  routeAdjustmentSuggestions: string
  schedulingOptimization: string
  improvements: string
}

export type ShowObjectiveMetricState = "PASS" | "RISK" | "INFO"

export interface ShowObjectiveMetricView {
  code: string
  label: string
  value: number | string
  displayValue: string
  unit: string | null
  state: ShowObjectiveMetricState
  detail: string
}

export interface ShowTeacherScoreView {
  code: string
  label: string
  maxScore: number
  score: number | null
  comment: string
}

export type ShowReplayTimelineItemKind = "STAGE" | "STATE" | "EVENT" | "ALERT" | "ACTION" | "REPORT"

export interface ShowReplayTimelineItemView {
  id: string
  sourceId: string
  kind: ShowReplayTimelineItemKind
  simulationTimeMs: number | null
  realTime: string
  title: string
  detail: string
  status: string
  severity: V3AlertSeverity | null
  correlationId: string | null
  payload: Record<string, unknown>
}

export interface V3LogisticsReviewReplayFrameView {
  simulationTimeMs: number
  realTime: string
  tasks: LogisticsRuntimeTaskView[]
  aircraft: LogisticsRuntimeAircraftView[]
  orders: LogisticsRuntimeOrderView[]
  routes: LogisticsRuntimeRouteView[]
  summary: LogisticsRuntimeSummaryView
  events: LogisticsRuntimeEventView[]
  alerts: V3RuntimeAlertView[]
}

export interface V3ReviewReplayView {
  sceneType: SceneType
  durationMs: number
  frames: V3LogisticsReviewReplayFrameView[]
}

export type V3LogisticsReviewAnalysisCode =
  | "ROUTE_VALIDATION"
  | "ON_TIME_DELIVERY"
  | "RUNTIME_CONFLICTS"
  | "AIRCRAFT_UTILIZATION"
  | "ABNORMAL_RESPONSE"
  | "RESCHEDULE_OUTCOME"

export interface V3LogisticsReviewAnalysisMetricView {
  code: string
  label: string
  value: number | string
  displayValue: string
  unit: string | null
}

export interface V3LogisticsReviewAnalysisSectionView {
  code: V3LogisticsReviewAnalysisCode
  label: string
  state: ShowObjectiveMetricState
  headline: string
  detail: string
  metrics: V3LogisticsReviewAnalysisMetricView[]
}

export interface V3LogisticsReviewAnalysisView {
  routeValidation: V3LogisticsReviewAnalysisSectionView
  onTimeDelivery: V3LogisticsReviewAnalysisSectionView
  runtimeConflicts: V3LogisticsReviewAnalysisSectionView
  aircraftUtilization: V3LogisticsReviewAnalysisSectionView
  abnormalResponse: V3LogisticsReviewAnalysisSectionView
  rescheduleOutcome: V3LogisticsReviewAnalysisSectionView
}

export interface ShowReviewAnnotationView {
  id: string
  timelineItemId: string
  simulationTimeMs: number | null
  comment: string
  createdBy: string
  createdAt: string
}

export interface ShowProjectReportView {
  id: string
  status: "DRAFT" | "FINAL"
  revision: number
  format: "DOCX" | "PDF" | null
  filename: string | null
  sizeBytes: number | null
  sha256: string | null
  generatedAt: string | null
  downloadPath: string | null
}

export interface ShowReviewCohortMetricView {
  code: string
  label: string
  count: number
  ratio: number
}

export interface ShowReviewCohortAnalyticsView {
  assignmentId: string
  projectCount: number
  completedCount: number
  completionRate: number
  publishedCount: number
  averageScore: number | null
  averageResponseSeconds: number | null
  commonOmissions: ShowReviewCohortMetricView[]
  errorTypes: ShowReviewCohortMetricView[]
  commonRisks: ShowReviewCohortMetricView[]
  eventTypes: ShowReviewCohortMetricView[]
}

export interface ShowReviewWorkspaceView {
  projectId: string
  mapResourceVersion: string
  sceneResourceVersion: string
  planVersion: string
  scenarioOverlayVersionId: string | null
  actor: "STUDENT" | "TEACHER"
  resultVisibility: "TOTAL_ONLY" | "DIMENSIONS" | "FULL_REVIEW"
  canAccessReport: boolean
  canEditSummary: boolean
  canSubmitSummary: boolean
  canReview: boolean
  canPublish: boolean
  publishBlockedReason: string | null
  timeline: ShowReplayTimelineItemView[]
  replay?: V3ReviewReplayView | null
  logisticsAnalysis?: V3LogisticsReviewAnalysisView | null
  annotations: ShowReviewAnnotationView[]
  evaluation: V3ProjectEvaluationView
  report: ShowProjectReportView | null
  cohortAnalytics: ShowReviewCohortAnalyticsView | null
}

export const showRuntimePhases = [
  "READY",
  "TAKEOFF_PREPARATION",
  "BATCH_TAKEOFF",
  "TRANSIT_TO_SHOW",
  "PERFORMANCE",
  "RETURN_TO_LAUNCH",
  "BATCH_LANDING",
  "COMPLETED",
  "ABORTED"
] as const
export type ShowRuntimePhase = (typeof showRuntimePhases)[number]

export const showRuntimeEventCategories = [
  "WEATHER",
  "POSITIONING_ELECTROMAGNETIC",
  "COMMUNICATION_CONTROL",
  "AIRCRAFT_DEVICE"
] as const
export type ShowRuntimeEventCategory = (typeof showRuntimeEventCategories)[number]

export const showRuntimeEventLifecycleStatuses = [
  "SCHEDULED",
  "OCCURRED_UNDETECTED",
  "DISCOVERED",
  "HANDLING",
  "CONTROLLED",
  "ESCALATED",
  "ENDED"
] as const
export type ShowRuntimeEventLifecycleStatus = (typeof showRuntimeEventLifecycleStatuses)[number]

export const showRuntimeActionCodes = [
  "ACKNOWLEDGE_ALERT",
  "CONTINUE_MONITORING",
  "PAUSE_NEXT_TAKEOFF",
  "RESUME_NEXT_TAKEOFF",
  "PAUSE_PROGRAM",
  "RESUME_PROGRAM",
  "ABORT_PROGRAM",
  "SINGLE_LAND",
  "BATCH_LAND",
  "REMOVE_FROM_MISSION",
  "GROUP_RETURN",
  "GROUP_LAND",
  "SWITCH_EMERGENCY_ZONE",
  "MULTI_GROUP_RETURN",
  "ZONE_LAND",
  "RETURN_ALL",
  "EMERGENCY_LAND_ALL"
] as const
export type ShowRuntimeActionCode = (typeof showRuntimeActionCodes)[number]

export type ShowRuntimeGroupStatus = "GROUND" | "TAKING_OFF" | "AIRBORNE" | "RETURNING" | "LANDING" | "LANDED" | "WARNING" | "ABNORMAL" | "LOST"

export interface ShowRuntimeGroupView {
  groupId: string
  label: string
  plannedCount: number
  airborneCount: number
  landedCount: number
  normalCount: number
  warningCount: number
  abnormalCount: number
  lostCount: number
  status: ShowRuntimeGroupStatus
  center: V3Coordinate
  radiusMeters: number
}

export interface ShowRuntimeTotalsView {
  plannedCount: number
  takeoffCount: number
  airborneCount: number
  landedCount: number
  normalCount: number
  warningCount: number
  abnormalCount: number
  lostCount: number
}

export interface ShowRuntimeEnvironmentView {
  windDirection: ShowWindDirection
  windState: "NORMAL" | "NEAR_LIMIT" | "OVER_LIMIT"
  gustState: "NONE" | "OCCASIONAL" | "CONTINUOUS"
  rainState: "NONE" | "BELOW_LIMIT" | "OVER_LIMIT"
  positioningQuality: "GOOD" | "DEGRADED" | "LOST"
  electromagneticState: "NORMAL" | "INTERFERENCE"
  communicationQuality: "GOOD" | "DEGRADED" | "LOST"
  equipmentState: "NORMAL" | "WARNING" | "FAULT"
  geofenceState: "NORMAL" | "WARNING"
}

export interface ShowTakeoffRecordView {
  id: string
  confirmedBy: {
    id: string
    displayName: string
  } | null
  confirmedAt: string
  simulationTimeMs: number
  actualTakeoffCount: number
  aircraftModel: string
  environment: ShowRuntimeEnvironmentView | null
}

export interface ShowRuntimeEventView extends V3RuntimeEventView {
  category: ShowRuntimeEventCategory
  lifecycleStatus: ShowRuntimeEventLifecycleStatus
  title: string
  detail: string
  affectedCount: number
  affectedGroupIds: string[]
  recommendedActions: ShowRuntimeActionCode[]
  detectedSimulationTimeMs: number | null
  controlledSimulationTimeMs: number | null
}

export interface ShowRuntimeAvailableActionView {
  code: ShowRuntimeActionCode
  title: string
  targetType: "PROGRAM" | "AIRCRAFT" | "BATCH" | "GROUP" | "MULTI_GROUP" | "ALERT"
  requiresTarget: boolean
  enabled: boolean
  disabledReason: string | null
  eligibleTargetIds: string[]
}

export interface ShowRuntimeWorkspaceView {
  projectId: string
  session: V3RuntimeSessionView
  clock?: import("./runtime-contracts.js").RuntimeClock
  attempts: V3RuntimeSessionView[]
  restartNodes: V3RuntimeRestartNodeView[]
  attemptsRemaining: number
  canRestart: boolean
  phase: ShowRuntimePhase
  phaseTitle: string
  canStart: boolean
  canControl: boolean
  canTeacherIntervene: boolean
  clockRate: number
  durationMs: number
  program: {
    packageId: string | null
    name: string
    version: string | null
    sourceSoftware: string | null
    imported: boolean
  }
  remainingMs: number
  actualTakeoffAt: string | null
  takeoffRecord: ShowTakeoffRecordView | null
  maximumHeightMeters: number
  performanceCenter: V3Coordinate
  performanceRadiusMeters: number
  totals: ShowRuntimeTotalsView
  groups: ShowRuntimeGroupView[]
  environment: ShowRuntimeEnvironmentView
  events: ShowRuntimeEventView[]
  alerts: V3RuntimeAlertView[]
  actions: V3StudentRuntimeActionView[]
  availableActions: ShowRuntimeAvailableActionView[]
}

export interface ShowFlightEndReportView {
  projectId: string
  revision: number
  status: "DRAFT" | "SUBMITTED"
  canSubmit: boolean
  actualTakeoffAt: string | null
  landingCompletedAt: string | null
  plannedCount: number
  actualTakeoffCount: number
  suggestedNormalLandedCount: number
  suggestedAbnormalCount: number
  authoritativeNormalLandedCount: number
  authoritativeAbnormalCount: number
  completionStatus: "NORMAL" | "ABNORMAL" | "ABORTED" | null
  normalLandedCount: number | null
  abnormalCount: number | null
  abnormalDescription: string
  completedAsPlanned: boolean | null
  answerCorrect: boolean | null
  submittedBy: string | null
  submittedAt: string | null
}

export interface V3ScaleTemplateCatalogItem {
  packageId: string
  packageVersion: string
  sceneType: SceneType
  code: string
  title: string
  totalAircraft: number
  defaultGroupCount: number
  eventCountRange: { minimum: number; maximum: number }
  maximumConcurrentEvents: number
  allowedActions: string[]
  aggregationLevel: "UNIT" | "GROUP" | "CLUSTER"
}

export const showAreaFeatureTypes = [
  "TAKEOFF_LANDING",
  "FLIGHT",
  "PERFORMANCE",
  "BUFFER",
  "GROUND_ISOLATION",
  "AUDIENCE",
  "OPERATION",
  "EMERGENCY_LANDING",
  "GEOFENCE"
] as const
export type ShowAreaFeatureType = (typeof showAreaFeatureTypes)[number]

export type ShowAreaPlanVersionStatus = "SNAPSHOT" | "GENERATING" | "GENERATION_FAILED" | "SUBMITTED" | "RETURNED" | "ACCEPTED"
export type ShowAreaCheckSeverity = "CONFLICT" | "RISK" | "INFO"

export interface ShowAreaHeightRange {
  datum: V3HeightDatum
  minimumMeters: number
  maximumMeters: number
}

export interface ShowAreaFeatureInput {
  id: string
  type: ShowAreaFeatureType
  label: string
  positions: V3Coordinate[]
  heightRange?: ShowAreaHeightRange
  properties: Record<string, string | number | boolean>
}

export interface ShowAreaFeatureMeasurement {
  areaSquareMeters: number
  perimeterMeters: number
  centroid: V3Coordinate
}

export interface ShowAreaFeatureView extends ShowAreaFeatureInput {
  measurement: ShowAreaFeatureMeasurement
}

export interface ShowAreaAnnotationInput {
  id: string
  label: string
  position: V3Coordinate
  heightMeters: number | null
}

export interface ShowAreaMeasuredPoint extends V3Coordinate {
  heightMeters: number | null
}

export interface ShowAreaDistanceMeasurement {
  start: ShowAreaMeasuredPoint
  end: ShowAreaMeasuredPoint
  distanceMeters: number
  bearingDegrees: number
}

export interface ShowAreaCheckEvidence {
  code: string
  severity: ShowAreaCheckSeverity
  blocking: boolean
  message: string
  featureIds: string[]
}

export const showAreaSpatialRelationTypes = ["DISJOINT", "OVERLAP", "CONTAINS", "WITHIN"] as const
export type ShowAreaSpatialRelationType = (typeof showAreaSpatialRelationTypes)[number]

export interface ShowAreaSpatialRelationView {
  leftFeatureId: string
  rightFeatureId: string
  relation: ShowAreaSpatialRelationType
  centroidDistanceMeters: number
  message: string
}

export interface ShowAreaCheckResult {
  passed: boolean
  checkedAt: string
  featureCount: number
  completeTypeCount: number
  requiredTypeCount: number
  evidence: ShowAreaCheckEvidence[]
  spatialRelations?: ShowAreaSpatialRelationView[]
}

export interface ShowAreaPlanDraftView {
  revision: number
  features: ShowAreaFeatureView[]
  annotations: ShowAreaAnnotationInput[]
  updatedAt: string | null
}

export interface V3FileAssetView {
  id: string
  category: "PLANNING_MAP" | "DOCUMENT" | "FINAL_PDF" | "FINAL_REPORT" | "ROUTE_MAP" | "RESOURCE_PACKAGE"
  originalName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  createdAt: string
  downloadPath: string
}

export interface ShowAreaPlanReview {
  comment: string
  score: number | null
  reviewedBy: string
  reviewedAt: string
}

export interface ShowAreaPlanVersionView {
  id: string
  versionNo: number
  sourceDraftRevision: number
  status: ShowAreaPlanVersionStatus
  features: ShowAreaFeatureView[]
  annotations: ShowAreaAnnotationInput[]
  checkResult: ShowAreaCheckResult
  planningMapAsset: V3FileAssetView | null
  review: ShowAreaPlanReview | null
  createdAt: string
  submittedAt: string | null
}

export interface ShowAreaPlanWorkspaceView {
  projectId: string
  canEdit: boolean
  requiredTypes: ShowAreaFeatureType[]
  draft: ShowAreaPlanDraftView
  versions: ShowAreaPlanVersionView[]
}

export interface ShowAreaPlanMutationResult {
  workspace: ShowAreaPlanWorkspaceView
  project: StudentProjectView
}

export const showDocumentTemplateCodes = [
  "AIRSPACE_APPLICATION_FORM",
  "AIRSPACE_APPLICATION_LETTER",
  "SAFETY_EMERGENCY_PLAN"
] as const
export type ShowDocumentTemplateCode = (typeof showDocumentTemplateCodes)[number]

export const showDocumentTemplateTitles: Record<ShowDocumentTemplateCode, string> = {
  AIRSPACE_APPLICATION_FORM: "无人机临时飞行空域申请表",
  AIRSPACE_APPLICATION_LETTER: "关于申请无人机临时飞行空域的函",
  SAFETY_EMERGENCY_PLAN: "安全应急预案"
}

export const projectDocumentStatuses = [
  "NOT_STARTED",
  "EDITING",
  "SUBMITTED",
  "VIEWED",
  "RETURNED",
  "RESUBMITTED"
] as const
export type ProjectDocumentStatus = (typeof projectDocumentStatuses)[number]

export const projectDocumentVersionKinds = [
  "TEMPLATE_COPY",
  "AUTO_SAVE",
  "MANUAL_SAVE",
  "ONLYOFFICE_CALLBACK",
  "SUBMISSION"
] as const
export type ProjectDocumentVersionKind = (typeof projectDocumentVersionKinds)[number]

export interface ShowDocumentVersionView {
  id: string
  versionNo: number
  kind: ProjectDocumentVersionKind
  asset: V3FileAssetView
  createdBy: string
  createdAt: string
}

export interface ShowDocumentReviewView {
  id: string
  versionNo: number
  action: "VIEWED" | "RETURNED" | "COMMENTED"
  comment: string
  score: number | null
  reviewedBy: string
  createdAt: string
}

export interface ShowProjectDocumentView {
  id: string
  templateCode: ShowDocumentTemplateCode
  title: string
  filename: string
  status: ProjectDocumentStatus
  revision: number
  currentVersionNo: number
  currentAsset: V3FileAssetView | null
  lastSavedAt: string | null
  submittedAt: string | null
  viewedAt: string | null
  returnedAt: string | null
  resubmittedAt: string | null
  reviewComment: string | null
  reviewScore: number | null
  canReturn: boolean
  returnBlockedReason: string | null
  versions: ShowDocumentVersionView[]
  reviews: ShowDocumentReviewView[]
}

export interface ShowDocumentReferencePanel {
  projectName: string
  projectBackground: string
  taskBrief: string
  completionRequirements: string
  scaleTemplateCode: string
  aircraftCount: number
  plannedStartAt: string
  plannedEndAt: string
  plannedAudienceCount: number
  aircraftModel: string
  contactName: string
  contactPhone: string
  regionName: string
  areaPlanVersion: number | null
  planningMapAsset: V3FileAssetView | null
  takeoffPoints: V3Coordinate[]
  airspaceBoundary: V3Coordinate[]
  maximumHeightMeters: number | null
}

export interface ShowDocumentWorkspaceView {
  projectId: string
  canEdit: boolean
  allRequiredSubmitted: boolean
  editorPublicUrl: string | null
  documents: ShowProjectDocumentView[]
  reference: ShowDocumentReferencePanel
}

export interface OnlyOfficeEditorConfigView {
  publicApiUrl: string
  config: Record<string, unknown>
  capabilities: ShowDocumentEditorCapabilities
}

export const showDocumentEditorTools = [
  "TEXT_INPUT",
  "TABLE_CELL_EDIT",
  "COPY_PASTE",
  "UNDO_REDO",
  "BASIC_FORMATTING",
  "AUTO_SAVE",
  "MANUAL_SAVE"
] as const
export type ShowDocumentEditorTool = (typeof showDocumentEditorTools)[number]

export interface ShowDocumentEditorCapabilities {
  directTemplateEditing: true
  tools: ShowDocumentEditorTool[]
}

export const showPreflightCategories = [
  "AIRCRAFT",
  "GROUND_SYSTEM",
  "POSITIONING",
  "COMMUNICATION",
  "WEATHER",
  "SITE_AREA",
  "PERSONNEL",
  "APPLICATION_SUPPORT"
] as const
export type ShowPreflightCategory = (typeof showPreflightCategories)[number]
export type ShowPreflightSourceStatus = "NORMAL" | "WARNING" | "ABNORMAL"
export type ShowPreflightResolution = "CONFIRMED" | "EXCLUDED" | "REPLACED" | "RECHECKED" | "PAUSED"
export type ShowTakeoffDecision = "ALLOW" | "ALLOW_AFTER_RECTIFICATION" | "DELAY" | "CANCEL"

export interface ShowPreflightItemView {
  code: string
  category: ShowPreflightCategory
  title: string
  detail: string
  sourceStatus: ShowPreflightSourceStatus
  affectedCount: number
  confirmed: boolean
  resolution: ShowPreflightResolution | null
  resolved: boolean
  note: string
}

export interface ShowPreflightWorkspaceView {
  projectId: string
  canEdit: boolean
  revision: number
  status: "DRAFT" | "COMPLETED"
  items: ShowPreflightItemView[]
  decision: ShowTakeoffDecision | null
  rationale: string
  completedAt: string | null
  updatedAt: string | null
}

export interface ShowT60ConfirmationView {
  projectName: string
  plannedStartAt: string
  plannedEndAt: string
  takeoffPoint: V3Coordinate | null
  airspaceBoundary: V3Coordinate[]
  maximumHeightMeters: number | null
  aircraftModel: string
  aircraftCount: number
  contactName: string
  contactPhone: string
  environment: Record<string, string | number | boolean>
}

export interface ShowT60SubmissionView {
  reportCode: string | null
  submittedAt: string
  submittedBy: {
    id: string
    displayName: string
  } | null
  simulationTimeMs: number | null
}

export interface ShowT60WorkspaceView {
  projectId: string
  revision: number
  canSubmit: boolean
  status: "NOT_OPEN" | "READY" | "SUBMITTED"
  clockStatus: "RUNNING" | "PAUSED"
  simulationTimeMs: number
  plannedTakeoffSimulationTimeMs: number
  thresholdSimulationTimeMs: number
  millisecondsUntilOpen: number
  clockRate: number
  submittedAt: string | null
  submission: ShowT60SubmissionView | null
  confirmation: ShowT60ConfirmationView
}
