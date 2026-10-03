/** JSON values accepted in persisted runtime payloads and contract examples. */
export type RuntimeJsonValue = string | number | boolean | null | RuntimeJsonValue[] | { [key: string]: RuntimeJsonValue }

export type RuntimeJsonObject = { [key: string]: RuntimeJsonValue }

export const runtimeModes = ["TRAINING", "ASSESSMENT"] as const
export type RuntimeMode = (typeof runtimeModes)[number]

export const runtimeSessionStatuses = ["READY", "RUNNING", "PAUSED", "COMPLETED", "ABORTED", "FAILED"] as const
export type RuntimeSessionStatus = (typeof runtimeSessionStatuses)[number]

export const runtimeEventStatuses = ["PLANNED", "SCHEDULED", "ACTIVE", "RESOLVED", "CANCELLED"] as const
export type RuntimeEventStatus = (typeof runtimeEventStatuses)[number]

export const runtimeActionStatuses = ["REQUESTED", "ACCEPTED", "REJECTED", "APPLIED", "FAILED"] as const
export type RuntimeActionStatus = (typeof runtimeActionStatuses)[number]

export const runtimeActionErrorCodes = [
  "SESSION_NOT_FOUND",
  "SESSION_NOT_RUNNING",
  "SESSION_EXPIRED",
  "ASSESSMENT_LOCKED",
  "STALE_SESSION_REVISION",
  "DUPLICATE_REQUEST",
  "TARGET_NOT_FOUND",
  "TARGET_STATE_INVALID",
  "ACTION_NOT_ALLOWED",
  "EVENT_NOT_ACTIVE",
  "PLAN_VERSION_MISMATCH",
  "RESOURCE_VERSION_MISMATCH",
  "INVALID_PAYLOAD"
] as const
export type RuntimeActionErrorCode = (typeof runtimeActionErrorCodes)[number]

export interface RuntimeResourceVersions {
  mapResourceVersion: string
  sceneResourceVersion: string
  planVersion: string
}

export interface RuntimeResourceVersionInput {
  packageId: string
  packageType: string
  version: string
  sha256: string
}

export function resourceVersionIdentity(reference: RuntimeResourceVersionInput | undefined): string {
  if (!reference) return "UNRESOLVED"
  return `${reference.packageType}:${reference.packageId}@${reference.version}#${reference.sha256}`
}

export function freezeRuntimeResourceVersions(
  references: readonly RuntimeResourceVersionInput[],
  planVersion: string
): RuntimeResourceVersions {
  const mapReference = references.find((reference) => reference.packageType === "REGION")
  const sceneReference = references.find((reference) => reference.packageType === "SCALE_TEMPLATE")
    ?? references.find((reference) => reference.packageType === "RULE")
    ?? mapReference
  return {
    mapResourceVersion: resourceVersionIdentity(mapReference),
    sceneResourceVersion: resourceVersionIdentity(sceneReference),
    planVersion: planVersion.trim() || "UNRESOLVED"
  }
}

export interface RuntimeSession extends RuntimeResourceVersions {
  id: string
  projectId: string
  mode: RuntimeMode
  status: RuntimeSessionStatus
  scenarioSeed: string
  attemptNo: number
  revision: number
  createdAt: string
  startedAt: string | null
  endedAt: string | null
}

export interface RuntimeClock {
  simulationTimeMs: number
  tick: number
  tickIntervalMs: number
  rate: number
  wallClockStartedAt: string | null
  deadlineAt: string | null
  canPause: boolean
  canReset: boolean
}

export interface RuntimeState {
  session: RuntimeSession
  clock: RuntimeClock
  phase: string
  entities: RuntimeJsonObject
  environment: RuntimeJsonObject
}

export interface RuntimeEvent {
  id: string
  sessionId: string
  code: string
  status: RuntimeEventStatus
  scheduledSimulationTimeMs: number | null
  triggeredSimulationTimeMs: number | null
  resolvedSimulationTimeMs: number | null
  payload: RuntimeJsonObject
  correlationId: string
}

export interface RuntimeAction {
  id: string
  requestId: string
  sessionId: string
  actorId: string
  code: string
  targetType: string
  targetId: string | null
  status: RuntimeActionStatus
  requestedAtSimulationTimeMs: number
  appliedAtSimulationTimeMs: number | null
  payload: RuntimeJsonObject
  result: RuntimeJsonObject | null
  errorCode: RuntimeActionErrorCode | null
  correlationId: string
}

export interface RuntimeSnapshot {
  id: string
  sessionId: string
  sequence: number
  simulationTimeMs: number
  revision: number
  reason: "START" | "TICK" | "ACTION" | "EVENT" | "CHECKPOINT" | "COMPLETE" | "ERROR"
  state: RuntimeState
  createdAt: string
}

export interface RuntimeEvidence {
  id: string
  sessionId: string
  sequence: number
  kind: "STATE_CHANGE" | "EVENT" | "ACTION" | "VIOLATION" | "MILESTONE"
  code: string
  simulationTimeMs: number
  actorId: string | null
  eventId: string | null
  actionId: string | null
  data: RuntimeJsonObject
  createdAt: string
}

export interface RuntimeActionRequest {
  requestId: string
  expectedRevision: number
  code: string
  targetType: string
  targetId: string | null
  payload: RuntimeJsonObject
}

export interface RuntimeError {
  code: RuntimeActionErrorCode
  message: string
  requestId: string | null
  sessionId: string | null
  revision: number | null
  details: RuntimeJsonObject
}

export type RuntimeSseMessage =
  | { type: "SNAPSHOT"; revision: number; snapshot: RuntimeSnapshot; resumedFromRevision: number | null }
  | { type: "STATE_DELTA"; revision: number; simulationTimeMs: number; changes: RuntimeJsonObject }
  | { type: "EVENT"; revision: number; event: RuntimeEvent }
  | { type: "ACTION_RESULT"; revision: number; action: RuntimeAction }
  | { type: "ERROR"; revision: number; error: RuntimeError }
  | { type: "COMPLETED"; revision: number; session: RuntimeSession }

export const runtimeContract = {
  protocol: "wurenji-runtime-contract-v1" as const,
  coordinateOrder: "longitude,latitude,altitudeMeters" as const,
  coordinateReference: "WGS84" as const,
  displayProjection: "EPSG:3857" as const,
  heightUnit: "meters" as const,
  timeUnit: "milliseconds" as const,
  timestamps: "RFC3339 UTC" as const
}
