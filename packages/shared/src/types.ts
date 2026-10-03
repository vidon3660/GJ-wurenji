export type UserRole = "teacher" | "student" | "admin"
export type SceneType = "CITY_SHOW" | "CITY_LOGISTICS" | "VTOL_INSPECTION"
export type RainLevel = "NONE" | "LIGHT" | "MODERATE" | "HEAVY"
export type Severity = "INFO" | "WARNING" | "ERROR"
export type RunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"

export interface GeoPoint {
  longitude: number
  latitude: number
  altitude: number
  groundHeightMeters?: number
  heightSource?: "TERRAIN" | "ELLIPSOID" | "MANUAL"
}

export interface LocalPoint {
  east: number
  north: number
  up: number
}

export interface AircraftSpec {
  name: string
  count: number
  cruiseSpeedMps: number
  maxSpeedMps: number
  maxAltitudeMeters: number
  maxRangeMeters: number
  maxPayloadKg: number
}

export interface WindConfig {
  enabled: boolean
  directionDegrees: number
  speedMps: number
}

export interface EnvironmentConfig {
  wind: WindConfig
  rainLevel: RainLevel
  magneticDriftMeters: number
}

export interface SimulationRules {
  horizontalSeparationMeters: number
  verticalSeparationMeters: number
  maximumDurationSeconds: number
  minimumAltitudeMeters: number
  maximumAltitudeMeters: number
}

export interface GeoPolygon {
  id: string
  name: string
  positions: GeoPoint[]
}

export interface NoFlyZone extends GeoPolygon {
  minimumAltitudeMeters: number
  maximumAltitudeMeters: number
}

export interface BoxObstacle {
  id: string
  name: string
  center: GeoPoint
  widthMeters: number
  lengthMeters: number
  heightMeters: number
}

export interface TaskPoint {
  id: string
  name: string
  position: GeoPoint
  payloadKg: number
  deadlineSeconds: number
  stage: number
}

export interface PracticeScene {
  id: string
  title: string
  type: SceneType
  origin: GeoPoint
  aircraft: AircraftSpec
  boundary: GeoPolygon
  takeoffPoint: GeoPoint
  landingPoint: GeoPoint
  noFlyZones: NoFlyZone[]
  obstacles: BoxObstacle[]
  taskPoints: TaskPoint[]
  environment: EnvironmentConfig
  rules: SimulationRules
  version: number
}

export interface Waypoint {
  id: string
  position: GeoPoint
  speedMps: number
  waitSeconds: number
}

export interface DronePlan {
  droneId: string
  groupId: string
  assignedTaskIds: string[]
  takeoffDelaySeconds: number
  waypoints: Waypoint[]
}

export interface MissionPlan {
  id: string
  sceneId: string
  sceneVersion: number
  version: number
  dronePlans: DronePlan[]
  updatedAt: string
}

export interface SimulationInput {
  scene: PracticeScene
  plan: MissionPlan
  stepSeconds: number
  seed: number
}

export interface DroneTrackSample {
  timeSeconds: number
  position: GeoPoint
  speedMps: number
  distanceMeters: number
  status: "WAITING" | "FLYING" | "COMPLETED"
}

export interface DroneTrack {
  droneId: string
  samples: DroneTrackSample[]
  totalDistanceMeters: number
  completedAtSeconds: number | null
}

export interface RuleFinding {
  id: string
  ruleCode:
    | "TASK_INCOMPLETE"
    | "SEPARATION"
    | "NO_FLY_ZONE"
    | "OBSTACLE"
    | "OUT_OF_BOUNDS"
    | "TIMEOUT"
    | "RANGE_EXCEEDED"
    | "PERFORMANCE_LIMIT"
    | "PAYLOAD_EXCEEDED"
  severity: Severity
  title: string
  message: string
  startTimeSeconds: number
  endTimeSeconds: number
  objectIds: string[]
  position: GeoPoint | null
  measuredValue: number | null
  thresholdValue: number | null
  suggestion: string
}

export interface SimulationSummary {
  droneCount: number
  completedDroneCount: number
  completedTaskCount: number
  totalTaskCount: number
  completionRate: number
  totalDistanceMeters: number
  durationSeconds: number
  errorCount: number
  warningCount: number
}

export interface SimulationResult {
  runId?: string
  inputHash: string
  createdAt: string
  summary: SimulationSummary
  findings: RuleFinding[]
  tracks: DroneTrack[]
}

export type LogisticsOrderPriority = "URGENT" | "NORMAL"
export type LogisticsOrderStatus = "UNASSIGNED" | "PLANNED" | "COMPLETED" | "DELAYED" | "FAILED"
export type FlightMissionStatus = "PLANNED" | "COMPLETED" | "DELAYED" | "FAILED"

export interface LogisticsOrderView {
  id: string
  name: string
  payloadKg: number
  latestArrivalSeconds: number
  priority: LogisticsOrderPriority
  assignedDroneId: string | null
  plannedArrivalSeconds: number | null
  actualArrivalSeconds: number | null
  status: LogisticsOrderStatus
}

export interface FlightMissionView {
  id: string
  droneId: string
  orderId: string
  orderName: string
  sequence: number
  payloadKg: number
  plannedStartSeconds: number
  plannedArrivalSeconds: number
  actualArrivalSeconds: number | null
  distanceMeters: number
  status: FlightMissionStatus
}

export interface ScheduleItemView {
  id: string
  missionId: string
  droneId: string
  orderId: string
  orderName: string
  plannedTimeSeconds: number
  actualTimeSeconds: number | null
  varianceSeconds: number | null
  status: FlightMissionStatus
}

export interface AircraftRotationView {
  droneId: string
  missionCount: number
  currentMissionId: string | null
  nextMissionId: string | null
  plannedFinishSeconds: number
  actualFinishSeconds: number | null
  totalDistanceMeters: number
  status: "IDLE" | "PLANNED" | "COMPLETED" | "ATTENTION"
}

export interface LogisticsControlMetrics {
  totalOrders: number
  assignedOrders: number
  completedOrders: number
  onTimeOrders: number
  delayedOrders: number
  activeAircraft: number
  aircraftUtilizationRate: number
  onTimeRate: number
  plannedDistanceMeters: number
  actualDistanceMeters: number | null
  distanceEfficiencyRate: number | null
}

export interface LogisticsControlSnapshot {
  generatedAt: string
  runId: string | null
  orders: LogisticsOrderView[]
  missions: FlightMissionView[]
  schedule: ScheduleItemView[]
  aircraft: AircraftRotationView[]
  metrics: LogisticsControlMetrics
}

export type GradeStatus = "AUTO" | "REVIEWED" | "PUBLISHED"

export interface EvaluationMetricResult {
  code: string
  label: string
  value: number
  displayValue: string
  target: string
  passed: boolean
  evidence: string
}

export interface GradeDimensionResult {
  name: string
  maxScore: number
  earnedScore: number
  ratio: number
  evidence: string[]
}

export interface GradeResult {
  id: string
  submissionId: string
  practiceId: string
  studentId: string
  status: GradeStatus
  autoScore: number
  totalScore: number
  passed: boolean
  hardConstraintsPassed: boolean
  teacherAdjustment: number
  teacherFeedback: string | null
  dimensions: GradeDimensionResult[]
  metrics: EvaluationMetricResult[]
  revision: number
  resultFileReady: boolean
  evaluatedAt: string
  publishedAt: string | null
}

export interface ValidationIssue {
  severity: Severity
  code: string
  message: string
  objectId?: string
}

export interface PracticeSummary {
  id: string
  title: string
  type: SceneType
  status: "DRAFT" | "PUBLISHED"
  sceneVersion: number
  updatedAt: string
}

export interface AuthUser {
  id: string
  email: string
  displayName: string
  role: UserRole
}

export type ExerciseDifficulty = "BEGINNER" | "INTERMEDIATE" | "ADVANCED"
export type AssignmentStatus = "PUBLISHED" | "CLOSED"
export type StudentAssignmentStatus = "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED"
export type LeaderboardDisplayMode = "FULL_NAME" | "ANONYMIZED"

export interface EvaluationMetricTarget {
  label: string
  target: string
}

export interface EvaluationDimension {
  name: string
  weight: number
  metrics: string[]
}

export interface ReferenceAnswerSummary {
  hardConstraints: string[]
  metricTargets: EvaluationMetricTarget[]
  guidance: string
}

export interface ExerciseTemplateSummary {
  id: string
  title: string
  type: SceneType
  difficulty: ExerciseDifficulty
  summary: string
  tags: string[]
  status: "DRAFT" | "PUBLISHED"
  currentVersion: number
  updatedAt: string
}

export interface ExerciseTemplateDetail extends ExerciseTemplateSummary {
  versionId: string
  taskBrief: string
  referenceAnswer: ReferenceAnswerSummary
  evaluationScheme: EvaluationDimension[]
}

export interface ClassroomSummary {
  id: string
  name: string
  code: string
  courseId: string
  courseName: string
  term: string
  studentCount: number
}

export interface ClassroomStudent {
  id: string
  displayName: string
  email: string
  joinedAt: string
}

export interface AssignmentSummary {
  id: string
  title: string
  practiceId: string
  practiceStatus: "DRAFT" | "PUBLISHED"
  type: SceneType
  classroomId: string
  classroomName: string
  status: AssignmentStatus
  availableAt: string
  dueAt: string
  studentStatus: StudentAssignmentStatus | null
  submittedCount: number
  totalStudents: number
  leaderboardEnabled: boolean
  leaderboardDisplayLimit: number
  leaderboardDisplayMode: LeaderboardDisplayMode
}

export interface LeaderboardEntry {
  rank: number
  displayName: string
  totalScore: number
  passed: boolean
  publishedAt: string
  isCurrentUser: boolean
}

export interface AssignmentLeaderboard {
  assignmentId: string
  assignmentTitle: string
  classroomId: string
  classroomName: string
  enabled: boolean
  displayLimit: number
  displayMode: LeaderboardDisplayMode
  publishedCount: number
  entries: LeaderboardEntry[]
  currentStudent: LeaderboardEntry | null
}

export interface EducationMetric {
  key: string
  label: string
  value: number
  detail: string
}

export interface EducationOverview {
  metrics: EducationMetric[]
  assignments: AssignmentSummary[]
  classes: ClassroomSummary[]
  practices: PracticeSummary[]
}

export interface OnboardingState {
  guideKey: "teacher-basics" | "student-basics"
  version: number
  completed: boolean
  skipped: boolean
}
