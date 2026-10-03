import { describe, expect, it } from "vitest"
import type { LogisticsScheduleItemInput, LogisticsScheduleItemView } from "@wurenji/shared"
import { assertDynamicScheduleMode, dynamicScheduleChanges, dynamicScheduleContentHash } from "./logistics-runtime.service.js"
import { optionalUuid, requiredUuid } from "./logistics-runtime.validation.js"

const current: LogisticsScheduleItemView[] = [
  item("task-1", "order-1", "aircraft-1", 10_000),
  item("task-2", "order-2", "aircraft-2", 20_000),
  item("task-3", "order-3", "aircraft-3", 30_000)
]

describe("logistics dynamic schedule audit", () => {
  it("derives affected orders, aircraft and routes from immutable schedule differences", () => {
    const changes = dynamicScheduleChanges(current, [
      input(current[0]!),
      { ...input(current[1]!), aircraftId: "aircraft-4", plannedTakeoffTimeMs: 25_000 },
      input(current[2]!)
    ])

    expect(changes).toEqual({
      orderIds: ["order-2"],
      aircraftIds: ["aircraft-2", "aircraft-4"],
      routeIds: ["route-out-2", "route-return-2"]
    })
  })

  it("enforces single, batch and global scope at the service boundary", () => {
    const single = dynamicScheduleChanges(current, [
      { ...input(current[0]!), plannedTakeoffTimeMs: 11_000 },
      input(current[1]!),
      input(current[2]!)
    ])
    const batch = dynamicScheduleChanges(current, [
      { ...input(current[0]!), plannedTakeoffTimeMs: 11_000 },
      { ...input(current[1]!), plannedTakeoffTimeMs: 21_000 },
      input(current[2]!)
    ])

    expect(() => assertDynamicScheduleMode("SINGLE", 20, true, false, batch)).toThrow()
    expect(() => assertDynamicScheduleMode("BATCH", 10, false, false, batch)).toThrow()
    expect(() => assertDynamicScheduleMode("BATCH", 20, true, false, single)).toThrow()
    expect(() => assertDynamicScheduleMode("GLOBAL", 20, true, true, batch)).toThrow()
    expect(() => assertDynamicScheduleMode("GLOBAL", 50, true, true, batch)).not.toThrow()
  })

  it("generates a stable content hash independent of item ordering", () => {
    const base = { mode: "SINGLE" as const, reason: "调整延误订单", eventId: null, parentVersionId: null, items: current.map(input) }
    const reordered = { ...base, items: [...base.items].reverse() }
    expect(dynamicScheduleContentHash(base)).toHaveLength(64)
    expect(dynamicScheduleContentHash(base)).toBe(dynamicScheduleContentHash(reordered))
    expect(dynamicScheduleContentHash(base)).not.toBe(dynamicScheduleContentHash({ ...base, reason: "调整航线冲突" }))
  })
  it("rejects malformed UUID references before database lookup", () => {
    expect(() => optionalUuid("event-1", "关联事件")).toThrow()
    expect(optionalUuid(null, "关联事件")).toBeNull()
    expect(requiredUuid("550e8400-e29b-41d4-a716-446655440000", "运行事件")).toBe("550e8400-e29b-41d4-a716-446655440000")
    expect(() => requiredUuid("not-a-uuid", "运行事件")).toThrow()
  })
})

function input(value: LogisticsScheduleItemView): LogisticsScheduleItemInput {
  return {
    id: value.id,
    orderId: value.orderId,
    aircraftId: value.aircraftId,
    outboundRouteId: value.outboundRouteId,
    returnRouteId: value.returnRouteId,
    plannedTakeoffTimeMs: value.plannedTakeoffTimeMs
  }
}

function item(id: string, orderId: string, aircraftId: string, plannedTakeoffTimeMs: number): LogisticsScheduleItemView {
  const routeNumber = aircraftId.replace("aircraft-", "")
  return {
    id,
    orderId,
    aircraftId,
    outboundRouteId: `route-out-${routeNumber}`,
    returnRouteId: `route-return-${routeNumber}`,
    plannedTakeoffTimeMs,
    orderCode: orderId.toUpperCase(),
    aircraftCode: aircraftId.toUpperCase(),
    destinationNodeId: "delivery-1",
    arrivalTimeMs: plannedTakeoffTimeMs + 60_000,
    returnStartTimeMs: plannedTakeoffTimeMs + 120_000,
    landingTimeMs: plannedTakeoffTimeMs + 180_000,
    nextAvailableTimeMs: plannedTakeoffTimeMs + 240_000,
    batteryAfterMissionPercent: 80
  }
}
