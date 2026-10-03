import { describe, expect, it } from "vitest"
import type { LogisticsScheduleItemView, LogisticsSchedulingAircraftView } from "@wurenji/shared"
import { logisticsAircraftPoolRows } from "./logistics-aircraft-pool"

describe("logistics aircraft pool", () => {
  const aircraft: LogisticsSchedulingAircraftView[] = [{
    id: "aircraft-1",
    code: "UAV-001",
    modelCode: "TEACHING-UAV-01",
    initialBatteryPercent: 100,
    availableAtMs: 0,
    status: "READY",
    currentLocation: { type: "CENTER_AIRPORT", label: "中心机场" },
    taskQueue: [],
    estimatedReturnTimeMs: null,
    nextAvailableTimeMs: 0
  }]

  it("projects the ordered task queue and availability from current draft items", () => {
    const items = [mission("task-2", "ORD-002", 20_000, 50_000, 60_000), mission("task-1", "ORD-001", 10_000, 30_000, 40_000)]
    const [row] = logisticsAircraftPoolRows(aircraft, items)
    expect(row).toMatchObject({
      currentLocation: { label: "中心机场" },
      initialBatteryPercent: 100,
      status: "READY",
      estimatedReturnTimeMs: 50_000,
      nextAvailableTimeMs: 60_000
    })
    expect(row?.taskQueue.map((item) => item.orderCode)).toEqual(["ORD-001", "ORD-002"])
  })

  it("keeps the initial availability when no task is arranged", () => {
    const [row] = logisticsAircraftPoolRows([{ ...aircraft[0]!, availableAtMs: 600_000, nextAvailableTimeMs: 600_000 }], [])
    expect(row).toMatchObject({ taskQueue: [], estimatedReturnTimeMs: null, nextAvailableTimeMs: 600_000 })
  })
})

function mission(id: string, orderCode: string, plannedTakeoffTimeMs: number, landingTimeMs: number, nextAvailableTimeMs: number): LogisticsScheduleItemView {
  return {
    id,
    orderId: `order-${id}`,
    orderCode,
    aircraftId: "aircraft-1",
    aircraftCode: "UAV-001",
    destinationNodeId: "DELIVERY-01",
    outboundRouteId: "outbound-1",
    returnRouteId: "return-1",
    plannedTakeoffTimeMs,
    arrivalTimeMs: plannedTakeoffTimeMs + 10_000,
    returnStartTimeMs: plannedTakeoffTimeMs + 20_000,
    landingTimeMs,
    nextAvailableTimeMs,
    batteryAfterMissionPercent: 80
  }
}
