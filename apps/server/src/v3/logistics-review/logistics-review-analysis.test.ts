import { describe, expect, it } from "vitest"
import type { LogisticsReviewAnalysisSources } from "./logistics-review-analysis.js"
import { computeLogisticsReviewAnalysis, isOnTimeArrival, logisticsOnTimeRate } from "./logistics-review-analysis.js"

describe("logistics objective metric boundaries", () => {
  it("uses actual arrival against the order deadline and rejects missing timestamps", () => {
    expect(isOnTimeArrival(100, 100)).toBe(true)
    expect(isOnTimeArrival(99, 100)).toBe(true)
    expect(isOnTimeArrival(101, 100)).toBe(false)
    expect(isOnTimeArrival(100, null)).toBe(false)
    expect(isOnTimeArrival(null, 100)).toBe(false)
    expect(logisticsOnTimeRate(1, 1, 1)).toBe(0.5)
    expect(logisticsOnTimeRate(1, 1, 0)).toBe(1)
  })
})

describe("logistics review analysis", () => {
  it("computes all six result domains from authoritative runtime evidence", () => {
    const analysis = computeLogisticsReviewAnalysis(sources())

    expect(Object.values(analysis).map((section) => section.code)).toEqual([
      "ROUTE_VALIDATION",
      "ON_TIME_DELIVERY",
      "RUNTIME_CONFLICTS",
      "AIRCRAFT_UTILIZATION",
      "ABNORMAL_RESPONSE",
      "RESCHEDULE_OUTCOME"
    ])
    expect(analysis.routeValidation).toMatchObject({ state: "PASS", headline: "2/2 组往返验证完成" })
    expect(metric(analysis.onTimeDelivery, "ON_TIME_RATE")).toBe(50)
    expect(analysis.runtimeConflicts).toMatchObject({ state: "RISK", headline: "1 个冲突尚未闭环" })
    expect(metric(analysis.aircraftUtilization, "FLEET_UTILIZATION")).toBe(66.7)
    expect(metric(analysis.aircraftUtilization, "PEAK_AIRBORNE")).toBe(2)
    expect(metric(analysis.abnormalResponse, "AVERAGE_RESPONSE")).toBe(60)
    expect(metric(analysis.abnormalResponse, "DEADLINE_PASS_RATE")).toBe(50)
    expect(analysis.rescheduleOutcome).toMatchObject({ state: "PASS", headline: "1 个动态调度版本已生效" })
    expect(metric(analysis.rescheduleOutcome, "AFFECTED_ORDERS")).toBe(1)
  })

  it("returns explicit informational results when no run evidence exists", () => {
    const analysis = computeLogisticsReviewAnalysis({
      routeVersion: null,
      validation: null,
      schedule: null,
      scheduleItems: [],
      snapshots: [],
      events: [],
      actions: [],
      dynamicScheduleVersions: []
    })

    expect(analysis.routeValidation.state).toBe("INFO")
    expect(analysis.aircraftUtilization.state).toBe("INFO")
    expect(analysis.abnormalResponse.state).toBe("INFO")
    expect(metric(analysis.abnormalResponse, "AVERAGE_RESPONSE")).toBe("无记录")
    expect(metric(analysis.abnormalResponse, "DEADLINE_PASS_RATE")).toBe("未设置")
    expect(analysis.rescheduleOutcome.state).toBe("INFO")
  })
})

function metric(section: ReturnType<typeof computeLogisticsReviewAnalysis>[keyof ReturnType<typeof computeLogisticsReviewAnalysis>], code: string): number | string | undefined {
  return section.metrics.find((item) => item.code === code)?.value
}

function sources(): LogisticsReviewAnalysisSources {
  return {
    routeVersion: { routes: [{ id: "route-out" }, { id: "route-return" }] },
    validation: {
      attemptNo: 2,
      status: "WITH_RISK",
      result: {
        completedRoundTripCount: 2,
        requiredRoundTripCount: 2,
        evidence: [
          { severity: "RISK", blocking: false },
          { severity: "INFO", blocking: false }
        ]
      }
    },
    schedule: { checkResult: { conflictCount: 0 } },
    scheduleItems: [
      { id: "item-1", orderId: "order-1", aircraftId: "aircraft-1" },
      { id: "item-2", orderId: "order-2", aircraftId: "aircraft-2" },
      { id: "item-3", orderId: "order-3", aircraftId: "aircraft-1" }
    ],
    snapshots: [
      { projection: { summary: { ...summary(), airborneAircraft: 1 } } },
      {
        projection: {
          summary: { ...summary(), airborneAircraft: 2 },
          orders: [
            { status: "COMPLETED", expectedArrivalTimeMs: 100, latestArrivalTimeMs: 200 },
            { status: "COMPLETED", expectedArrivalTimeMs: 300, latestArrivalTimeMs: 200 },
            { status: "DELAYED", expectedArrivalTimeMs: 400, latestArrivalTimeMs: 200 }
          ]
        }
      }
    ],
    events: [
      { id: "event-1", status: "RESOLVED", triggeredAt: new Date(), payload: { lifecycleStatus: "ENDED", detectedSimulationTimeMs: 10_000, affectedAircraftIds: ["aircraft-1"], affectedRouteIds: ["route-out"] } },
      { id: "event-2", status: "ACTIVE", triggeredAt: new Date(), payload: { lifecycleStatus: "DISCOVERED", detectedSimulationTimeMs: 20_000, affectedAircraftIds: ["aircraft-2"], affectedRouteIds: ["route-return"] } }
    ],
    actions: [
      { eventId: "event-1", simulationTimeMs: 40_000, result: { withinDeadline: true } },
      { eventId: "event-2", simulationTimeMs: 110_000, result: { withinDeadline: false } }
    ],
    dynamicScheduleVersions: [{
      status: "SUBMITTED",
      versionNo: 3,
      affectedOrderIds: ["order-3"],
      affectedAircraftIds: ["aircraft-1"],
      affectedRouteIds: ["route-return"],
      checkResult: { conflictCount: 0 }
    }]
  } as unknown as LogisticsReviewAnalysisSources
}

function summary() {
  return {
    totalAircraft: 3,
    availableAircraft: 3,
    assignedAircraft: 0,
    airborneAircraft: 0,
    holdingAircraft: 0,
    warningAircraft: 0,
    disabledAircraft: 0,
    totalOrders: 3,
    unreleasedOrders: 0,
    waitingOrders: 0,
    deliveringOrders: 0,
    completedOrders: 1,
    delayedOrders: 1,
    failedOrders: 0,
    cancelledOrders: 0
  }
}
