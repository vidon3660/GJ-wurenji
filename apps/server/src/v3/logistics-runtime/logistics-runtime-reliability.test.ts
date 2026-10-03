import { EventEmitter } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { performance } from "node:perf_hooks"
import type { Request, Response } from "express"
import { describe, expect, it } from "vitest"
import type { RuntimeEventEntity, RuntimeSessionEntity } from "../runtime/runtime.entities.js"
import { streamRuntimeWorkspace } from "../runtime/runtime-stream.js"
import { computeLogisticsRuntimeProjection, type LogisticsRuntimeControlState, type LogisticsRuntimeProjection } from "@wurenji/simulation"
import {
  createAcceptanceControl,
  createLogisticsRuntimeAcceptanceFixture,
  type LogisticsRuntimeAcceptanceFixture
} from "./logistics-runtime-acceptance.fixtures.js"
import {
  logisticsRestartNodes,
  nextLogisticsSnapshotSequence,
  snapshotCheckpoint,
  type LogisticsRuntimeCheckpoint
} from "./logistics-runtime.service.js"

const longRunDurationMs = 30 * 60 * 1_000
const tickIntervalMs = 30 * 1_000

describe("logistics runtime reliability baseline", () => {
  it("runs deterministic 30-minute traces for 1/2/3 aircraft and writes evidence", async () => {
    const startedAt = performance.now()
    const scaleResults = ([1, 2, 3] as const).map((aircraftCount) => runLongTrace(aircraftCount))
    const report = {
      format: "wurenji-logistics-runtime-reliability-baseline",
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      virtualDurationMs: longRunDurationMs,
      tickIntervalMs,
      elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      scales: scaleResults,
      recovery: {
        disconnectedStreamResumed: await verifyStreamReconnect(),
        restartNodesFromDiscoveredEvents: verifyRestartNodes(),
        snapshotReplayReadOnly: verifySnapshotReplay()
      }
    }
    await mkdir("artifacts/performance", { recursive: true })
    await writeFile("artifacts/performance/logistics-reliability-baseline.json", `${JSON.stringify(report, null, 2)}\n`, "utf8")

    expect(scaleResults.every((item) => item.finalAvailableAircraft === item.aircraftCount)).toBe(true)
    expect(scaleResults.every((item) => item.replayEquivalent)).toBe(true)
    expect(report.recovery).toEqual({
      disconnectedStreamResumed: true,
      restartNodesFromDiscoveredEvents: true,
      snapshotReplayReadOnly: true
    })
  })
})

function runLongTrace(aircraftCount: 1 | 2 | 3) {
  const fixture = createLogisticsRuntimeAcceptanceFixture(aircraftCount)
  const control = createAcceptanceControl()
  control.eventImpacts = [{
    eventId: "reliability-weather",
    category: "WEATHER_ENVIRONMENT",
    severity: "WARNING",
    affectedAircraftIds: fixture.aircraft.slice(0, 1).map((item) => item.id),
    affectedOrderIds: fixture.orders.slice(0, 1).map((item) => item.id),
    affectedRouteIds: fixture.routes.slice(0, 1).map((item) => item.id)
  }]
  const samples: Array<{ timeMs: number; sequence: number; projection: LogisticsRuntimeProjection }> = []
  const startedAt = performance.now()
  let sequence = 0
  let sawInFlight = false
  for (let timeMs = 0; timeMs <= longRunDurationMs; timeMs += tickIntervalMs) {
    const projection = project(fixture, timeMs, timeMs >= 60_000 ? control : createAcceptanceControl())
    sequence = nextLogisticsSnapshotSequence(sequence, null)
    samples.push({ timeMs, sequence, projection })
    sawInFlight = sawInFlight || projection.aircraft.some((item) => ["TAKING_OFF", "OUTBOUND", "ARRIVED", "RETURNING"].includes(item.status))
    expect(projection.aircraft).toHaveLength(aircraftCount)
    expect(projection.orders).toHaveLength(aircraftCount)
    expect(projection.tasks).toHaveLength(aircraftCount)
    expect(projection.aircraft.every((item) => Number.isFinite(item.position.longitude) && Number.isFinite(item.position.latitude) && Number.isFinite(item.batteryPercent))).toBe(true)
    expect(projection.tasks.every((item) => Number.isFinite(item.plannedTakeoffTimeMs) && item.aircraftId && item.orderId)).toBe(true)
  }
  const checkpointTimeMs = 15 * 60 * 1_000
  const checkpointControl = createAcceptanceControl()
  const checkpoint = makeCheckpoint(fixture, checkpointTimeMs, checkpointControl)
  const restored = snapshotCheckpoint(structuredClone(checkpoint) as unknown as Record<string, unknown>, makeCheckpoint(fixture, 0, createAcceptanceControl()))
  const replay = project(fixture, longRunDurationMs, restored.control)
  const direct = project(fixture, longRunDurationMs, checkpoint.control)
  expect(JSON.stringify(replay)).toBe(JSON.stringify(direct))
  expect(sawInFlight).toBe(true)
  expect(samples.at(-1)?.projection.tasks.every((item) => item.status === "AVAILABLE_AGAIN")).toBe(true)
  return {
    aircraftCount,
    ticks: samples.length,
    snapshotCount: sequence,
    elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    sawInFlight,
    finalAvailableAircraft: samples.at(-1)?.projection.summary.availableAircraft ?? 0,
    replayEquivalent: JSON.stringify(replay) === JSON.stringify(direct)
  }
}

function project(fixture: LogisticsRuntimeAcceptanceFixture, simulationTimeMs: number, control: LogisticsRuntimeControlState): LogisticsRuntimeProjection {
  return computeLogisticsRuntimeProjection({
    simulationTimeMs,
    sessionStatus: simulationTimeMs >= longRunDurationMs ? "COMPLETED" : "RUNNING",
    totalAircraft: fixture.aircraft.length,
    orders: fixture.orders,
    aircraft: fixture.aircraft,
    routes: fixture.routes,
    scheduleItems: fixture.scheduleItems,
    initialEnvironment: fixture.initialEnvironment,
    control
  })
}

function makeCheckpoint(fixture: LogisticsRuntimeAcceptanceFixture, simulationTimeMs: number, control: LogisticsRuntimeControlState): LogisticsRuntimeCheckpoint {
  return {
    schemaVersion: 1,
    scheduleVersionId: "teaching-route-version-1",
    scheduleVersionNo: 1,
    clockRate: 60,
    clockAnchorRealTime: "2026-09-27T00:00:00.000Z",
    clockAnchorSimulationTimeMs: simulationTimeMs,
    durationMs: longRunDurationMs,
    totalAircraft: fixture.aircraft.length,
    maximumConcurrentEvents: 1,
    lastSnapshotSequence: 31,
    activeDynamicScheduleVersionId: null,
    control
  }
}

async function verifyStreamReconnect(): Promise<boolean> {
  let revision = 1
  const loadWorkspace = async () => ({
    projectId: "logistics-reliability-stream",
    session: { revision, simulationTimeMs: revision * tickIntervalMs, status: "RUNNING" },
    aircraft: [{ id: "aircraft-1", status: revision === 1 ? "OUTBOUND" : "ARRIVED" }]
  })
  const active = fakeConnection()
  await streamRuntimeWorkspace(active.request, active.response, "logistics-reliability-stream", loadWorkspace)
  revision = 2
  const reconnect = fakeConnection({ "last-event-id": "1" })
  await streamRuntimeWorkspace(reconnect.request, reconnect.response, "logistics-reliability-stream", loadWorkspace)
  const resumed = reconnect.frames[0]?.includes('"resumedFromRevision":1')
    && reconnect.frames[0]?.includes('"revision":2')
    && reconnect.frames[0]?.includes('"simulationTimeMs":60000')
  active.events.emit("close")
  reconnect.events.emit("close")
  return Boolean(resumed)
}

function verifyRestartNodes(): boolean {
  const session = { id: "reliability-session", status: "PAUSED" } as RuntimeSessionEntity
  const nodes = logisticsRestartNodes(session, [
    reliabilityEvent("late", "WEATHER_CHANGE", 90_000),
    reliabilityEvent("early", "COMMUNICATION_LOSS", 30_000),
    reliabilityEvent("undiscovered", "DYNAMIC_ORDER", null)
  ])
  return JSON.stringify(nodes.map((node) => [node.code, node.simulationTimeMs])) === JSON.stringify([
    ["EVENT:early", 30_000],
    ["EVENT:late", 90_000]
  ])
}

function verifySnapshotReplay(): boolean {
  const fixture = createLogisticsRuntimeAcceptanceFixture(3)
  const fallback = makeCheckpoint(fixture, 0, createAcceptanceControl())
  const persisted = makeCheckpoint(fixture, 120_000, createAcceptanceControl())
  const restored = snapshotCheckpoint(structuredClone(persisted) as unknown as Record<string, unknown>, fallback)
  const fallbackRestored = snapshotCheckpoint({}, fallback)
  return restored.clockAnchorSimulationTimeMs === 120_000
    && restored.lastSnapshotSequence === persisted.lastSnapshotSequence
    && fallbackRestored.clockAnchorSimulationTimeMs === 0
}

function reliabilityEvent(id: string, code: string, detectedSimulationTimeMs: number | null): RuntimeEventEntity {
  return {
    id,
    code,
    payload: {
      title: code,
      detail: code,
      lifecycleStatus: detectedSimulationTimeMs === null ? "SCHEDULED" : "DISCOVERED",
      detectedSimulationTimeMs
    }
  } as RuntimeEventEntity
}

function fakeConnection(headers: Record<string, string> = {}) {
  const events = new EventEmitter()
  const frames: string[] = []
  const request = Object.assign(events, { headers, destroyed: false }) as unknown as Request
  const response = {
    statusCode: 0,
    setHeader: () => undefined,
    flushHeaders: () => undefined,
    write: (frame: string) => { frames.push(frame); return true },
    end: () => undefined
  } as unknown as Response
  return { events, request, response, frames }
}
