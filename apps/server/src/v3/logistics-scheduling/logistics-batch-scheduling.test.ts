import { describe, expect, it } from "vitest"
import type {
  LogisticsAircraftInstanceView,
  LogisticsBatchScheduleAdjustmentInput,
  LogisticsScheduleItemInput,
  LogisticsSchedulingOrderView,
  LogisticsSchedulingRouteView
} from "@wurenji/shared"
import {
  applyLogisticsBatchScheduleAdjustment,
  normalizeLogisticsBatchScheduleAdjustment
} from "./logistics-batch-scheduling.js"

describe("logistics batch scheduling", () => {
  it("reassigns a full-template priority group while preserving task ids", () => {
    const adjusted = applyLogisticsBatchScheduleAdjustment(input({
      orderIds: ["order-1", "order-2"],
      group: { type: "PRIORITY", value: "URGENT" },
      adjustment: { aircraftId: "aircraft-2", takeoffShiftMs: 60_000 }
    }), context("FULL"))

    expect(adjusted).toEqual([
      expect.objectContaining({ id: "task-1", orderId: "order-1", aircraftId: "aircraft-2", plannedTakeoffTimeMs: 180_000 }),
      expect.objectContaining({ id: "task-2", orderId: "order-2", aircraftId: "aircraft-2", plannedTakeoffTimeMs: 360_000 }),
      expect.objectContaining({ id: "task-3", orderId: "order-3", aircraftId: "aircraft-1", plannedTakeoffTimeMs: 480_000 })
    ])
  })

  it("switches a delivery-point group to another verified route pair", () => {
    const adjusted = applyLogisticsBatchScheduleAdjustment(input({
      orderIds: ["order-1", "order-2"],
      group: { type: "DELIVERY_POINT", value: "DELIVERY-01" },
      adjustment: { outboundRouteId: "outbound-2", returnRouteId: "return-2" }
    }), context("FULL"))

    expect(adjusted.slice(0, 2)).toEqual([
      expect.objectContaining({ outboundRouteId: "outbound-2", returnRouteId: "return-2" }),
      expect.objectContaining({ outboundRouteId: "outbound-2", returnRouteId: "return-2" })
    ])
  })

  it("keeps limited scheduling within one delivery point", () => {
    expect(() => applyLogisticsBatchScheduleAdjustment(input({
      orderIds: ["order-1", "order-2"],
      group: { type: "PRIORITY", value: "URGENT" },
      adjustment: { takeoffShiftMs: 60_000 }
    }), context("LIMITED"))).toThrow("仅开放手动多选或按配送点")

    expect(() => applyLogisticsBatchScheduleAdjustment(input({
      orderIds: ["order-1", "order-3"],
      group: { type: "MANUAL", value: "" },
      adjustment: { takeoffShiftMs: 60_000 }
    }), context("LIMITED"))).toThrow("同一配送点")
  })

  it("rejects closed templates and unsafe adjustments", () => {
    expect(() => applyLogisticsBatchScheduleAdjustment(input({
      orderIds: ["order-1", "order-2"],
      group: { type: "DELIVERY_POINT", value: "DELIVERY-01" },
      adjustment: { takeoffShiftMs: 60_000 }
    }), context("NONE"))).toThrow("未开放批量调度")

    expect(() => applyLogisticsBatchScheduleAdjustment(input({
      orderIds: ["order-1", "order-2"],
      group: { type: "DELIVERY_POINT", value: "DELIVERY-01" },
      adjustment: { takeoffShiftMs: -180_000 }
    }), context("FULL"))).toThrow("早于最早执行时间")
  })

  it("normalizes the API contract and rejects empty actions", () => {
    expect(normalizeLogisticsBatchScheduleAdjustment({
      expectedRevision: 3,
      orderIds: ["order-1", "order-2"],
      group: { type: "AIRCRAFT", value: "aircraft-1" },
      adjustment: { aircraftId: "aircraft-2", takeoffShiftMs: 120_000 }
    })).toMatchObject({ expectedRevision: 3, group: { type: "AIRCRAFT" }, adjustment: { aircraftId: "aircraft-2", takeoffShiftMs: 120_000 } })
    expect(() => normalizeLogisticsBatchScheduleAdjustment({
      expectedRevision: 3,
      orderIds: ["order-1", "order-2"],
      group: { type: "MANUAL", value: "" },
      adjustment: { takeoffShiftMs: 0 }
    })).toThrow("至少选择一项")
  })
})

function input(overrides: Partial<LogisticsBatchScheduleAdjustmentInput>): LogisticsBatchScheduleAdjustmentInput {
  return {
    expectedRevision: 1,
    orderIds: ["order-1", "order-2"],
    group: { type: "MANUAL", value: "" },
    adjustment: { takeoffShiftMs: 60_000 },
    ...overrides
  }
}

function context(mode: "NONE" | "LIMITED" | "FULL") {
  return { mode, items, orders, aircraft, routes }
}

const orders: LogisticsSchedulingOrderView[] = [
  order("order-1", "ORD-001", "DELIVERY-01", "URGENT", 60_000),
  order("order-2", "ORD-002", "DELIVERY-01", "URGENT", 120_000),
  order("order-3", "ORD-003", "DELIVERY-02", "NORMAL", 180_000)
]

const items: LogisticsScheduleItemInput[] = [
  task("task-1", "order-1", 120_000),
  task("task-2", "order-2", 300_000),
  task("task-3", "order-3", 480_000, "outbound-3", "return-3")
]

const aircraft: LogisticsAircraftInstanceView[] = [
  { id: "aircraft-1", code: "UAV-001", modelCode: "TEACHING-UAV-01", initialBatteryPercent: 100, availableAtMs: 0, status: "READY" },
  { id: "aircraft-2", code: "UAV-002", modelCode: "TEACHING-UAV-01", initialBatteryPercent: 100, availableAtMs: 0, status: "READY" }
]

const routes: LogisticsSchedulingRouteView[] = [
  route("outbound-1", "DELIVERY-01", "OUTBOUND"),
  route("return-1", "DELIVERY-01", "RETURN"),
  route("outbound-2", "DELIVERY-01", "OUTBOUND"),
  route("return-2", "DELIVERY-01", "RETURN"),
  route("outbound-3", "DELIVERY-02", "OUTBOUND"),
  route("return-3", "DELIVERY-02", "RETURN")
]

function order(id: string, code: string, destinationNodeId: string, priority: "NORMAL" | "PRIORITY" | "URGENT", earliestStartTimeMs: number): LogisticsSchedulingOrderView {
  return { id, code, destinationNodeId, priority, releaseTimeMs: 0, earliestStartTimeMs, latestArrivalTimeMs: 3_600_000, status: "SCHEDULED" }
}

function task(id: string, orderId: string, plannedTakeoffTimeMs: number, outboundRouteId = "outbound-1", returnRouteId = "return-1"): LogisticsScheduleItemInput {
  return { id, orderId, aircraftId: "aircraft-1", outboundRouteId, returnRouteId, plannedTakeoffTimeMs }
}

function route(id: string, destinationNodeId: string, direction: "OUTBOUND" | "RETURN"): LogisticsSchedulingRouteView {
  return {
    id,
    versionId: "version-1",
    versionNo: 1,
    route: {
      id: `key-${id}`,
      name: id,
      destinationNodeId,
      direction,
      role: "PRIMARY",
      groupCode: "G-01",
      departureNodeId: direction === "OUTBOUND" ? "CENTER" : destinationNodeId,
      arrivalNodeId: direction === "OUTBOUND" ? destinationNodeId : "CENTER",
      protectionRadiusMeters: 30,
      waitingNodeIds: [],
      alternateLandingNodeIds: [],
      emergencyAreaNodeIds: [],
      entryDirectionDegrees: 90,
      exitDirectionDegrees: 270,
      waypoints: []
    },
    distanceMeters: 1_000,
    flightTimeMs: 60_000,
    batteryConsumptionPercent: 10
  }
}
