import { describe, expect, it } from "vitest"
import type { RuntimeEventEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { buildRuntimeEvidence } from "../runtime/runtime-evidence.js"
import { nextLogisticsSnapshotSequence } from "./logistics-runtime.service.js"
import {
  captureAcceptanceSnapshot,
  createAcceptanceControl,
  createLogisticsRuntimeAcceptanceFixture,
  positioningImpact
} from "./logistics-runtime-acceptance.fixtures.js"

describe("logistics runtime teaching acceptance fixture", () => {
  it("covers area, route, schedule, tick, intervention, evidence, replay snapshots, and terminal state", () => {
    const fixture = createLogisticsRuntimeAcceptanceFixture(3)
    expect(fixture.area.logisticsNodes.filter((node) => node.type === "DELIVERY_POINT")).toHaveLength(3)
    expect(fixture.area.logisticsNodes.filter((node) => node.type === "ALTERNATE_LANDING_POINT")).toHaveLength(3)
    expect(fixture.routes).toHaveLength(9)
    expect(fixture.scheduleItems).toHaveLength(3)
    expect(fixture.scheduleItems.every((item) => fixture.orders.some((order) => order.id === item.orderId))).toBe(true)

    const control = createAcceptanceControl()
    const nextSequence = nextSequenceFactory()
    const snapshots = [captureAcceptanceSnapshot(fixture, nextSequence(), 0, "START", control)]
    const at40Seconds = captureAcceptanceSnapshot(fixture, nextSequence(), 40_000, "TICK", control)
    snapshots.push(at40Seconds)
    expect(at40Seconds.projection.aircraft.filter((item) => item.status === "OUTBOUND")).toHaveLength(3)
    expect(at40Seconds.projection.aircraft.every((item) => Number.isFinite(item.position.longitude) && item.speedMps > 0)).toBe(true)

    const event = runtimeEvent("event-positioning", 60_000)
    control.eventImpacts = [positioningImpact(event.id, "aircraft-1")]
    const atEvent = captureAcceptanceSnapshot(fixture, nextSequence(), 60_000, "EVENT", control)
    snapshots.push(atEvent)
    expect(atEvent.projection.environment.positioningQuality).toBe("LOST")
    expect(atEvent.projection.aircraft[0]!.batteryPercent).toBeLessThan(at40Seconds.projection.aircraft[0]!.batteryPercent)

    const complete = captureAcceptanceSnapshot(fixture, nextSequence(), 220_000, "COMPLETE", control)
    snapshots.push(complete)
    expect(complete.projection.tasks.every((task) => task.status === "AVAILABLE_AGAIN")).toBe(true)
    expect(complete.projection.summary.availableAircraft).toBe(3)
    expect(complete.projection.summary.failedOrders).toBe(0)
    expect(snapshots.map((snapshot) => snapshot.sequence)).toEqual([1, 2, 3, 4])
    expect(snapshots.map((snapshot) => snapshot.reason)).toEqual(["START", "TICK", "EVENT", "COMPLETE"])
  
    const evidence = buildRuntimeEvidence({
      events: [event],
      actions: [runtimeAction("action-hold", "HOLD_POSITION", 70_000, "aircraft-1")]
    })
    expect(evidence.map((item) => [item.kind, item.code, item.simulationTimeMs])).toEqual([
      ["EVENT", "POSITIONING_DEGRADED", 60_000],
      ["ACTION", "HOLD_POSITION", 70_000]
    ])
    expect(evidence.map((item) => item.sequence)).toEqual([1, 2])
  })
})

function nextSequenceFactory() {
  let value = 0
  return () => {
    value = nextLogisticsSnapshotSequence(value, null)
    return value
  }
}

function runtimeEvent(id: string, simulationTimeMs: number): RuntimeEventEntity {
  return {
    id,
    sessionId: "session-acceptance",
    projectId: "project-acceptance",
    stageCode: "LOGISTICS_EMERGENCY_HANDLING",
    code: "POSITIONING_DEGRADED",
    category: "POSITIONING_NAVIGATION",
    status: "ACTIVE",
    severity: "ERROR",
    scheduledSimulationTimeMs: simulationTimeMs,
    triggeredSimulationTimeMs: simulationTimeMs,
    resolvedSimulationTimeMs: null,
    triggeredAt: new Date("2026-09-27T00:01:00.000Z"),
    resolvedAt: null,
    createdAt: new Date("2026-09-27T00:01:00.000Z"),
    updatedAt: new Date("2026-09-27T00:01:00.000Z"),
    payload: { lifecycleStatus: "DISCOVERED", title: "定位质量下降", affectedAircraftIds: ["aircraft-1"] },
    correlationId: id
  } as RuntimeEventEntity
}

function runtimeAction(id: string, actionCode: StudentRuntimeActionEntity["actionCode"], simulationTimeMs: number, targetId: string): StudentRuntimeActionEntity {
  const requestedAt = new Date(Date.parse("2026-09-27T00:00:00.000Z") + simulationTimeMs)
  return {
    id,
    projectId: "project-acceptance",
    sessionId: "session-acceptance",
    eventId: null,
    alertId: null,
    actorId: "student-acceptance",
    actionCode,
    targetType: "AIRCRAFT",
    targetId,
    status: "APPLIED",
    simulationTimeMs,
    payload: { rationale: "teaching acceptance" },
    result: { applied: true },
    correlationId: id,
    requestedAt,
    appliedAt: requestedAt,
    createdAt: requestedAt
  } as StudentRuntimeActionEntity
}
