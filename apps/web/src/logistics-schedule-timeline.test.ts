import { describe, expect, it } from "vitest"
import type { LogisticsScheduleItemView, LogisticsSchedulingOrderView } from "@wurenji/shared"
import { buildLogisticsTaskTimeline } from "./logistics-schedule-timeline"

describe("logistics schedule timeline", () => {
  it("projects the five displayed operational stages", () => {
    const timeline = buildLogisticsTaskTimeline(scheduleItem(), order())

    expect(timeline.stages).toEqual([
      expect.objectContaining({ code: "OUTBOUND", label: "起飞与去程飞行", startTimeMs: 120_000, endTimeMs: 240_000 }),
      expect.objectContaining({ code: "ARRIVAL_SERVICE", label: "到达确认与服务", startTimeMs: 240_000, endTimeMs: 300_000 }),
      expect.objectContaining({ code: "RETURNING", startTimeMs: 300_000, endTimeMs: 420_000 }),
      expect.objectContaining({ code: "LANDING", startTimeMs: 420_000, endTimeMs: 420_000 }),
      expect.objectContaining({ code: "AVAILABLE_AGAIN", startTimeMs: 540_000, endTimeMs: 540_000 })
    ])
  })

  it("splits a mission bar into outbound, service, return, and recovery segments", () => {
    expect(buildLogisticsTaskTimeline(scheduleItem(), order()).segments).toEqual([
      expect.objectContaining({ code: "OUTBOUND", startTimeMs: 120_000, endTimeMs: 240_000 }),
      expect.objectContaining({ code: "ARRIVAL_SERVICE", startTimeMs: 240_000, endTimeMs: 300_000 }),
      expect.objectContaining({ code: "RETURNING", startTimeMs: 300_000, endTimeMs: 420_000 }),
      expect.objectContaining({ code: "RECOVERY", startTimeMs: 420_000, endTimeMs: 540_000 })
    ])
  })
})

function scheduleItem(): LogisticsScheduleItemView {
  return {
    id: "task-1",
    orderId: "order-1",
    orderCode: "ORD-001",
    aircraftId: "aircraft-1",
    aircraftCode: "UAV-001",
    destinationNodeId: "DELIVERY-01",
    outboundRouteId: "route-out",
    returnRouteId: "route-return",
    plannedTakeoffTimeMs: 120_000,
    arrivalTimeMs: 240_000,
    returnStartTimeMs: 300_000,
    landingTimeMs: 420_000,
    nextAvailableTimeMs: 540_000,
    batteryAfterMissionPercent: 72
  }
}

function order(): LogisticsSchedulingOrderView {
  return {
    id: "order-1",
    code: "ORD-001",
    destinationNodeId: "DELIVERY-01",
    releaseTimeMs: 60_000,
    earliestStartTimeMs: 90_000,
    latestArrivalTimeMs: 600_000,
    priority: "NORMAL",
    status: "SCHEDULED"
  }
}
