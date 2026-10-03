import { describe, expect, it } from "vitest"
import type { LogisticsRuntimeProjection } from "@wurenji/simulation"
import { logisticsActionBusinessOutcome, logisticsActionWithinDeadline } from "./logistics-action-outcome.js"

function projection(overrides: Partial<LogisticsRuntimeProjection> = {}): LogisticsRuntimeProjection {
  return {
    durationMs: 60_000,
    tasks: [],
    aircraft: [],
    orders: [],
    routes: [],
    summary: {} as LogisticsRuntimeProjection["summary"],
    environment: {} as LogisticsRuntimeProjection["environment"],
    availableActions: [],
    ...overrides
  }
}

describe("logistics action business outcome", () => {
  it("describes linked aircraft, task, order, and route changes", () => {
    const before = projection({
      aircraft: [{ id: "aircraft-1", code: "UAV-01", status: "OUTBOUND", currentTaskId: "task-1", currentOrderId: "order-1" } as never],
      orders: [{ id: "order-1", code: "ORD-01", status: "DELIVERING", priority: "NORMAL" } as never],
      tasks: [{ scheduleItemId: "task-1", orderId: "order-1", orderCode: "ORD-01", aircraftCode: "UAV-01", status: "OUTBOUND", activeRouteId: "route-a", delayedByMs: 0 } as never],
      routes: [{ id: "route-a", name: "A 主航线", status: "AVAILABLE" } as never, { id: "route-r", name: "A 返航线", status: "AVAILABLE" } as never]
    })
    const after = projection({
      aircraft: [{ id: "aircraft-1", code: "UAV-01", status: "RETURNING", currentTaskId: "task-1", currentOrderId: "order-1" } as never],
      orders: [{ id: "order-1", code: "ORD-01", status: "DELAYED", priority: "NORMAL" } as never],
      tasks: [{ scheduleItemId: "task-1", orderId: "order-1", orderCode: "ORD-01", aircraftCode: "UAV-01", status: "RETURNING", activeRouteId: "route-r", delayedByMs: 0 } as never],
      routes: before.routes
    })

    expect(logisticsActionBusinessOutcome(before, after, "RETURN_AIRCRAFT", "aircraft-1").businessConsequences).toEqual([
      "UAV-01：无人机由“去程中”变为“返航中”",
      "ORD-01：订单由“配送中”变为“已延误”",
      "ORD-01：配送任务由“去程中”变为“返航中”",
      "ORD-01：执行航线由“A 主航线”变为“A 返航线”"
    ])
  })

  it("reports order priority changes and safe no-change actions", () => {
    const normal = projection({ orders: [{ id: "order-1", code: "ORD-01", status: "WAITING", priority: "NORMAL" } as never] })
    const urgent = projection({ orders: [{ id: "order-1", code: "ORD-01", status: "WAITING", priority: "URGENT" } as never] })
    expect(logisticsActionBusinessOutcome(normal, urgent, "CHANGE_PRIORITY", "order-1").outcome).toBe("ORD-01：订单优先级由“普通”变为“紧急”")
    expect(logisticsActionBusinessOutcome(normal, normal, "CONTINUE_MONITORING", null).outcome).toBe("已保持监控，业务状态暂未调整")
    expect(logisticsActionBusinessOutcome(normal, normal, "CONTINUE_MONITORING", null).businessConsequences).toEqual(["已保持监控，业务状态暂未调整"])
  })

  it("uses business labels for arrival phase transitions", () => {
    const before = projection({
      aircraft: [{ id: "aircraft-1", code: "UAV-01", status: "RETURNING", currentTaskId: "task-1", currentOrderId: "order-1" } as never],
      orders: [{ id: "order-1", code: "ORD-01", status: "DELIVERING", priority: "NORMAL" } as never],
      tasks: [{ scheduleItemId: "task-1", orderId: "order-1", orderCode: "ORD-01", aircraftCode: "UAV-01", status: "RETURNING", activeRouteId: "route-a", delayedByMs: 0 } as never],
      routes: [{ id: "route-a", name: "A 航线", status: "AVAILABLE" } as never]
    })
    const after = projection({
      aircraft: [{ id: "aircraft-1", code: "UAV-01", status: "ARRIVED", currentTaskId: "task-1", currentOrderId: "order-1" } as never],
      orders: before.orders,
      tasks: [{ scheduleItemId: "task-1", orderId: "order-1", orderCode: "ORD-01", aircraftCode: "UAV-01", status: "ARRIVAL_CONFIRMATION", activeRouteId: "route-a", delayedByMs: 0 } as never],
      routes: before.routes
    })

    expect(logisticsActionBusinessOutcome(before, after, "REDUCE_SPEED", "aircraft-1").businessConsequences).toEqual([
      "UAV-01：无人机由“返航中”变为“已到达”",
      "ORD-01：配送任务由“返航中”变为“到达确认”"
    ])
  })

  it("does not award a deadline result when the event has no deadline", () => {
    expect(logisticsActionWithinDeadline(null, 10_000)).toBeNull()
    expect(logisticsActionWithinDeadline(12_000, 10_000)).toBe(true)
    expect(logisticsActionWithinDeadline(8_000, 10_000)).toBe(false)
  })
})
