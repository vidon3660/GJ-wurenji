import { describe, expect, it } from "vitest"
import type { LogisticsScheduleItemView, LogisticsSchedulingOrderView } from "@wurenji/shared"
import {
  assignLogisticsTasks,
  canMoveLogisticsAircraftTask,
  matchesLogisticsTaskInput,
  reorderLogisticsAircraftTask
} from "./logistics-task-assignment"

describe("logistics task assignment", () => {
  it("binds orders to one aircraft and route pair in release order", () => {
    const assigned = assignLogisticsTasks({
      items: [],
      orders: [order("order-2", "ORD-002", 20_000, 90_000), order("order-1", "ORD-001", 10_000, 10_000)],
      aircraftId: "aircraft-1",
      outboundRouteId: "route-out",
      returnRouteId: "route-back",
      firstTakeoffTimeMs: 0,
      intervalMs: 30_000,
      createId: (() => { let index = 0; return () => `task-${++index}` })()
    })
    expect(assigned).toEqual([
      expect.objectContaining({ id: "task-1", orderId: "order-1", aircraftId: "aircraft-1", outboundRouteId: "route-out", returnRouteId: "route-back", plannedTakeoffTimeMs: 10_000 }),
      expect.objectContaining({ id: "task-2", orderId: "order-2", plannedTakeoffTimeMs: 90_000 })
    ])
  })

  it("reassigns an existing order without creating a duplicate task", () => {
    const assigned = assignLogisticsTasks({
      items: [{ id: "task-existing", orderId: "order-1", aircraftId: "aircraft-old", outboundRouteId: "old-out", returnRouteId: "old-back", plannedTakeoffTimeMs: 0 }],
      orders: [order("order-1", "ORD-001", 0, 0)],
      aircraftId: "aircraft-new",
      outboundRouteId: "new-out",
      returnRouteId: "new-back",
      firstTakeoffTimeMs: 120_000,
      intervalMs: 60_000
    })
    expect(assigned).toEqual([{ id: "task-existing", orderId: "order-1", aircraftId: "aircraft-new", outboundRouteId: "new-out", returnRouteId: "new-back", plannedTakeoffTimeMs: 120_000 }])
  })

  it("rejects a stale checked projection after an unsaved reassignment", () => {
    const checked: LogisticsScheduleItemView = {
      id: "task-existing",
      orderId: "order-1",
      orderCode: "ORD-001",
      aircraftId: "aircraft-old",
      aircraftCode: "UAV-001",
      destinationNodeId: "DELIVERY-01",
      outboundRouteId: "old-out",
      returnRouteId: "old-back",
      plannedTakeoffTimeMs: 0,
      arrivalTimeMs: 60_000,
      returnStartTimeMs: 120_000,
      landingTimeMs: 180_000,
      nextAvailableTimeMs: 240_000,
      batteryAfterMissionPercent: 80
    }
    const reassigned = {
      id: "task-existing",
      orderId: "order-1",
      aircraftId: "aircraft-new",
      outboundRouteId: "new-out",
      returnRouteId: "new-back",
      plannedTakeoffTimeMs: 120_000
    }

    expect(matchesLogisticsTaskInput(checked, checked)).toBe(true)
    expect(matchesLogisticsTaskInput(checked, reassigned)).toBe(false)
  })

  it("rejects a batch spanning multiple delivery points", () => {
    expect(() => assignLogisticsTasks({
      items: [],
      orders: [order("order-1", "ORD-001", 0, 0, "DELIVERY-01"), order("order-2", "ORD-002", 0, 0, "DELIVERY-02")],
      aircraftId: "aircraft-1",
      outboundRouteId: "route-out",
      returnRouteId: "route-back",
      firstTakeoffTimeMs: 0,
      intervalMs: 60_000
    })).toThrow("同一配送点")
  })

  it("moves a task within the same aircraft queue by swapping takeoff slots", () => {
    const source = [
      task("task-a", "order-a", "aircraft-1", 120_000),
      task("task-x", "order-x", "aircraft-2", 180_000),
      task("task-b", "order-b", "aircraft-1", 300_000)
    ]
    const reordered = reorderLogisticsAircraftTask({
      items: source,
      orders: [order("order-a", "ORD-A", 0, 0), order("order-b", "ORD-B", 0, 0), order("order-x", "ORD-X", 0, 0)],
      itemId: "task-b",
      direction: -1
    })

    expect(reordered).toEqual([
      expect.objectContaining({ id: "task-a", plannedTakeoffTimeMs: 300_000 }),
      expect.objectContaining({ id: "task-x", plannedTakeoffTimeMs: 180_000 }),
      expect.objectContaining({ id: "task-b", plannedTakeoffTimeMs: 120_000 })
    ])
    expect(canMoveLogisticsAircraftTask(reordered, "task-b", -1)).toBe(false)
    expect(canMoveLogisticsAircraftTask(reordered, "task-b", 1)).toBe(true)
  })

  it("rejects a queue move that violates an order earliest start time", () => {
    expect(() => reorderLogisticsAircraftTask({
      items: [task("task-a", "order-a", "aircraft-1", 120_000), task("task-b", "order-b", "aircraft-1", 300_000)],
      orders: [order("order-a", "ORD-A", 0, 0), order("order-b", "ORD-B", 0, 240_000)],
      itemId: "task-b",
      direction: -1
    })).toThrow("ORD-B 的目标时段早于最早执行时间")
  })
})

function task(id: string, orderId: string, aircraftId: string, plannedTakeoffTimeMs: number) {
  return { id, orderId, aircraftId, outboundRouteId: "route-out", returnRouteId: "route-back", plannedTakeoffTimeMs }
}

function order(id: string, code: string, releaseTimeMs: number, earliestStartTimeMs: number, destinationNodeId = "DELIVERY-01"): LogisticsSchedulingOrderView {
  return { id, code, destinationNodeId, releaseTimeMs, earliestStartTimeMs, latestArrivalTimeMs: 3_600_000, priority: "NORMAL", status: "UNASSIGNED" }
}
