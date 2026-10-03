import { describe, expect, it } from "vitest"
import { logisticsEventSelection, logisticsMaximumConcurrentEvents, logisticsRestartNodes, snapshotCheckpoint, type LogisticsRuntimeCheckpoint } from "./logistics-runtime.service.js"
import type { RuntimeEventEntity, RuntimeSessionEntity } from "../runtime/runtime.entities.js"

describe("logistics runtime restart", () => {
  it("offers only discovered event nodes in detection order", () => {
    const session = { id: "session-1", status: "PAUSED" } as RuntimeSessionEntity
    const nodes = logisticsRestartNodes(session, [
      event("event-late", "WEATHER_CHANGE", "天气变化", 80_000),
      event("event-hidden", "DYNAMIC_ORDER", "动态订单", null),
      event("event-early", "COMMUNICATION_LOSS", "通信中断", 20_000)
    ])

    expect(nodes.map((node) => ({ code: node.code, time: node.simulationTimeMs }))).toEqual([
      { code: "EVENT:event-early", time: 20_000 },
      { code: "EVENT:event-late", time: 80_000 }
    ])
    expect(nodes.every((node) => node.sourceSessionId === session.id && node.kind === "EVENT")).toBe(true)
  })

  it("does not offer restart nodes before a session starts", () => {
    expect(logisticsRestartNodes({ id: "ready", status: "READY" } as RuntimeSessionEntity, [event("event-1", "FAULT", "设备故障", 1_000)])).toEqual([])
  })

  it("falls back to the session checkpoint for legacy snapshots", () => {
    const fallback = checkpoint(42_000, "version-current")
    expect(snapshotCheckpoint({}, fallback)).toEqual(fallback)

    const historical = checkpoint(16_000, "version-historical")
    expect(snapshotCheckpoint(historical as unknown as Record<string, unknown>, fallback)).toEqual(historical)
  })

  it("freezes the event concurrency limit and derives legacy checkpoints by scale", () => {
    const fallback = checkpoint(0, "version-current")
    expect(logisticsMaximumConcurrentEvents({ ...fallback, totalAircraft: 50, maximumConcurrentEvents: 2 })).toBe(2)
    expect(logisticsMaximumConcurrentEvents({ ...fallback, totalAircraft: 20 })).toBe(1)
    expect(logisticsMaximumConcurrentEvents(fallback, "LOGISTICS_50")).toBe(3)
  })

  it("distinguishes an explicit empty event selection from legacy snapshots", () => {
    expect(logisticsEventSelection({ eventConfigs: [] })).toEqual({ selected: [], legacyDefaultEnabled: false })
    expect(logisticsEventSelection({ eventCodes: ["DYNAMIC_ORDER"] })).toEqual({ selected: ["DYNAMIC_ORDER"], legacyDefaultEnabled: false })
    expect(logisticsEventSelection({})).toEqual({ selected: [], legacyDefaultEnabled: true })
  })
})

function event(id: string, code: string, title: string, detectedSimulationTimeMs: number | null): RuntimeEventEntity {
  return {
    id,
    code,
    payload: {
      title,
      detail: `${title}详情`,
      lifecycleStatus: detectedSimulationTimeMs === null ? "SCHEDULED" : "DISCOVERED",
      detectedSimulationTimeMs
    }
  } as RuntimeEventEntity
}

function checkpoint(clockAnchorSimulationTimeMs: number, scheduleVersionId: string): LogisticsRuntimeCheckpoint {
  return {
    schemaVersion: 1,
    scheduleVersionId,
    scheduleVersionNo: 2,
    clockRate: 60,
    clockAnchorRealTime: "2026-08-13T00:00:00.000Z",
    clockAnchorSimulationTimeMs,
    durationMs: 120_000,
    lastSnapshotSequence: 4,
    activeDynamicScheduleVersionId: null,
    control: {
      aircraftStatusOverrides: {},
      aircraftPositionOverrides: {},
      diversionPlans: {},
      returnPlans: {},
      resumePlans: {},
      holdStartedAtMs: {},
      orderStatusOverrides: {},
      routeStatusOverrides: {},
      taskStatusOverrides: {},
      taskAircraftOverrides: {},
      orderPriorityOverrides: {},
      taskSpeedFactorOverrides: {},
      activeRouteOverrides: {},
      delayOffsetsMs: {},
      eventImpacts: []
    }
  }
}
