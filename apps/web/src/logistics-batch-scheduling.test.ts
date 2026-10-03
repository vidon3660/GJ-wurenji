import { describe, expect, it } from "vitest"
import type { LogisticsScheduleItemInput, LogisticsSchedulingOrderView } from "@wurenji/shared"
import { filterLogisticsScheduleOrders, logisticsBatchGroupOrderIds } from "./logistics-batch-scheduling"

describe("logistics batch scheduling presentation", () => {
  it("filters by delivery point, priority, state, route and aircraft", () => {
    expect(filterLogisticsScheduleOrders({
      orders,
      items,
      filters: {
        destinationNodeId: "DELIVERY-01",
        priority: "URGENT",
        status: "SCHEDULED",
        outboundRouteId: "route-out-1",
        aircraftId: "aircraft-1",
        sort: "LATEST_ARRIVAL"
      }
    }).map((order) => order.id)).toEqual(["order-2"])
  })

  it("sorts urgent orders first without changing authoritative order data", () => {
    const source = structuredClone(orders)
    expect(filterLogisticsScheduleOrders({
      orders,
      items,
      filters: { destinationNodeId: "", priority: "", status: "ALL", outboundRouteId: "", aircraftId: "", sort: "PRIORITY" }
    }).map((order) => order.id)).toEqual(["order-4", "order-2", "order-1", "order-3"])
    expect(orders).toEqual(source)
  })

  it("selects assigned groups by delivery point, priority, route and aircraft", () => {
    expect(group("DELIVERY_POINT", "DELIVERY-01")).toEqual(["order-1", "order-2"])
    expect(group("PRIORITY", "URGENT")).toEqual(["order-2"])
    expect(group("OUTBOUND_ROUTE", "route-out-1")).toEqual(["order-1", "order-2"])
    expect(group("AIRCRAFT", "aircraft-2")).toEqual(["order-3"])
  })
})

function group(groupType: "DELIVERY_POINT" | "PRIORITY" | "OUTBOUND_ROUTE" | "AIRCRAFT", value: string) {
  return logisticsBatchGroupOrderIds({ group: groupType, value, orders, items })
}

const orders: LogisticsSchedulingOrderView[] = [
  order("order-1", "ORD-001", "DELIVERY-01", "PRIORITY", 600_000),
  order("order-2", "ORD-002", "DELIVERY-01", "URGENT", 300_000),
  order("order-3", "ORD-003", "DELIVERY-02", "NORMAL", 900_000),
  order("order-4", "ORD-004", "DELIVERY-02", "URGENT", 200_000)
]

const items: LogisticsScheduleItemInput[] = [
  task("task-1", "order-1", "aircraft-1", "route-out-1"),
  task("task-2", "order-2", "aircraft-1", "route-out-1"),
  task("task-3", "order-3", "aircraft-2", "route-out-2")
]

function order(id: string, code: string, destinationNodeId: string, priority: "NORMAL" | "PRIORITY" | "URGENT", latestArrivalTimeMs: number): LogisticsSchedulingOrderView {
  return { id, code, destinationNodeId, priority, releaseTimeMs: 0, earliestStartTimeMs: 0, latestArrivalTimeMs, status: "UNASSIGNED" }
}

function task(id: string, orderId: string, aircraftId: string, outboundRouteId: string): LogisticsScheduleItemInput {
  return { id, orderId, aircraftId, outboundRouteId, returnRouteId: outboundRouteId.replace("out", "return"), plannedTakeoffTimeMs: 0 }
}
