import { describe, expect, it } from "vitest"
import type { LogisticsSchedulingOrderView } from "@wurenji/shared"
import { logisticsOrderPoolRows, logisticsOrderStatusLabel } from "./logistics-order-pool"

describe("logistics order pool", () => {
  it("projects all seven required order fields", () => {
    const order: LogisticsSchedulingOrderView = {
      id: "order-1",
      code: "ORD-001",
      destinationNodeId: "delivery-a",
      priority: "URGENT",
      releaseTimeMs: 60_000,
      earliestStartTimeMs: 120_000,
      latestArrivalTimeMs: 300_000,
      status: "UNRELEASED"
    }

    expect(logisticsOrderPoolRows([order])).toEqual([order])
  })

  it("uses authoritative order status labels", () => {
    expect(logisticsOrderStatusLabel("UNRELEASED")).toBe("未释放")
    expect(logisticsOrderStatusLabel("UNASSIGNED")).toBe("待分配")
    expect(logisticsOrderStatusLabel("SCHEDULED")).toBe("已排程")
  })
})
