import type {
  RuntimeAction,
  RuntimeClock,
  RuntimeEvent,
  RuntimeEvidence,
  RuntimeJsonObject,
  RuntimeMode,
  RuntimeSession,
  RuntimeSnapshot,
  RuntimeState
} from "@wurenji/shared"

export interface RuntimeTeachingFixture {
  namespace: "a2-logistics-teaching"
  session: RuntimeSession
  clock: RuntimeClock
  state: RuntimeState
  events: RuntimeEvent[]
  actions: RuntimeAction[]
  snapshots: RuntimeSnapshot[]
  evidence: RuntimeEvidence[]
}

export interface RuntimeTeachingFixtureOptions {
  mode?: RuntimeMode
  aircraftCount?: 1 | 2 | 3
  sessionId?: string
  projectId?: string
  scenarioSeed?: string
}

/**
 * Returns a fresh deterministic fixture on every call. It uses only teaching coordinates,
 * so tests never need a real map archive or a developer database.
 */
export function createRuntimeTeachingFixture(options: RuntimeTeachingFixtureOptions = {}): RuntimeTeachingFixture {
  const mode = options.mode ?? "TRAINING"
  const aircraftCount = options.aircraftCount ?? 3
  const sessionId = options.sessionId ?? "a2-session-001"
  const projectId = options.projectId ?? "a2-project-001"
  const now = "2026-09-27T00:00:00.000Z"
  const versions = {
    mapResourceVersion: "teaching-guangzhou-map-1",
    sceneResourceVersion: "teaching-guangzhou-logistics-1",
    planVersion: "teaching-logistics-plan-1"
  } as const
  const session: RuntimeSession = {
    id: sessionId,
    projectId,
    mode,
    status: "READY",
    scenarioSeed: options.scenarioSeed ?? "a2-seed-001",
    attemptNo: 1,
    revision: 1,
    ...versions,
    createdAt: now,
    startedAt: null,
    endedAt: null
  }
  const clock: RuntimeClock = {
    simulationTimeMs: 0,
    tick: 0,
    tickIntervalMs: 1_000,
    rate: 1,
    wallClockStartedAt: null,
    deadlineAt: mode === "ASSESSMENT" ? "2026-09-27T00:20:00.000Z" : null,
    canPause: mode === "TRAINING",
    canReset: mode === "TRAINING"
  }
  const state: RuntimeState = {
    session,
    clock,
    phase: "PREPARATION",
    entities: {
      aircraft: Array.from({ length: aircraftCount }, (_, index) => ({
        id: `a2-aircraft-${index + 1}`,
        status: "STANDBY",
        position: { longitude: 113.2644 + index * 0.001, latitude: 23.1291, altitudeMeters: 0 },
        energyPercent: 100,
        currentOrderId: null
      })),
      nodes: [
        { id: "a2-takeoff", type: "TAKEOFF_POINT", longitude: 113.2644, latitude: 23.1291 },
        { id: "a2-delivery-1", type: "DELIVERY_POINT", longitude: 113.2744, latitude: 23.1391 },
        { id: "a2-waiting-1", type: "WAITING_POINT", longitude: 113.2694, latitude: 23.1341 },
        { id: "a2-alternate-1", type: "ALTERNATE_LANDING_POINT", longitude: 113.2544, latitude: 23.1191 }
      ],
      orders: [
        { id: "a2-order-1", status: "READY", destinationNodeId: "a2-delivery-1", priority: "NORMAL" },
        { id: "a2-order-2", status: "READY", destinationNodeId: "a2-delivery-1", priority: "URGENT" }
      ]
    },
    environment: {
      positioning: "AVAILABLE",
      communication: "AVAILABLE",
      weather: "CALM",
      equipment: "NORMAL"
    }
  }
  const events: RuntimeEvent[] = [
    event(sessionId, "a2-event-positioning", "POSITIONING_DEGRADED", 30_000, { severity: "WARNING", impact: "POSITION_UNCERTAIN" }),
    event(sessionId, "a2-event-communication", "COMMUNICATION_LOSS", 60_000, { severity: "ERROR", impact: "LINK_UNAVAILABLE" }),
    event(sessionId, "a2-event-weather", "WEATHER_LIMIT", 90_000, { severity: "WARNING", impact: "SPEED_REDUCED" }),
    event(sessionId, "a2-event-equipment", "EQUIPMENT_FAULT", 120_000, { severity: "CRITICAL", impact: "DIVERSION_REQUIRED" })
  ]
  const snapshots: RuntimeSnapshot[] = [{
    id: "a2-snapshot-001",
    sessionId,
    sequence: 1,
    simulationTimeMs: 0,
    revision: 1,
    reason: "CHECKPOINT",
    state: cloneState(state),
    createdAt: now
  }]
  return { namespace: "a2-logistics-teaching", session, clock, state, events, actions: [], snapshots, evidence: [] }
}

export function cloneRuntimeTeachingFixture(fixture: RuntimeTeachingFixture): RuntimeTeachingFixture {
  return structuredClone(fixture)
}

export function resetRuntimeTeachingFixture(options: RuntimeTeachingFixtureOptions = {}): RuntimeTeachingFixture {
  return createRuntimeTeachingFixture(options)
}

function event(sessionId: string, id: string, code: string, scheduledSimulationTimeMs: number, payload: RuntimeJsonObject): RuntimeEvent {
  return {
    id,
    sessionId,
    code,
    status: "SCHEDULED",
    scheduledSimulationTimeMs,
    triggeredSimulationTimeMs: null,
    resolvedSimulationTimeMs: null,
    payload,
    correlationId: id
  }
}

function cloneState(state: RuntimeState): RuntimeState {
  return structuredClone(state)
}
