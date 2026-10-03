import { describe, expect, it } from "vitest"
import type {
  LogisticsAircraftInstanceView,
  LogisticsOrderGenerationConfig,
  LogisticsSchedulingOrderView,
  LogisticsRouteInput,
  LogisticsSchedulingRouteView
} from "@wurenji/shared"
import { checkLogisticsSchedule, generateLogisticsOrders } from "./logistics-scheduling.js"

const config: LogisticsOrderGenerationConfig = {
  orderCount: 3,
  releaseMode: "BATCH",
  releasePhase: null,
  priorityProfile: "BALANCED",
  deliveryDistributionMode: "UNIFORM",
  timeWindowProfile: "RELAXED",
  timeWindowMinutes: 120,
  seed: "teaching-seed",
  initialUnavailableAircraftCount: 0,
  initialLowBatteryAircraftCount: 0,
  initialFleet: { readyAircraftCount: 3, standbyAircraftCount: 0, lowBatteryAircraftCount: 0, preflightAbnormalAircraftCount: 0, unavailableAircraftCount: 0 },
  initialEnvironment: { windDirection: "N", windForceState: "NORMAL", gustState: "NONE", rainState: "NONE", positioningState: "NORMAL", communicationState: "NORMAL" }
}

describe("logistics order generation", () => {
  it("is deterministic and preserves the configured order properties", () => {
    const first = generateLogisticsOrders(config, ["D-01"])
    const second = generateLogisticsOrders(config, ["D-01"])
    expect(first).toEqual(second)
    expect(first).toHaveLength(3)
    expect(first.every((order) => order.destinationNodeId === "D-01" && order.latestArrivalTimeMs > order.earliestStartTimeMs)).toBe(true)
  })

  it("supports staged, dynamic and specified-stage release without changing the seed contract", () => {
    const staged = generateLogisticsOrders({ ...config, orderCount: 9, releaseMode: "STAGED" }, ["D-01", "D-02"])
    const dynamic = generateLogisticsOrders({ ...config, orderCount: 9, releaseMode: "DYNAMIC" }, ["D-01", "D-02"])
    const atPhase = generateLogisticsOrders({ ...config, orderCount: 9, releaseMode: "AT_PHASE", releasePhase: "OUTBOUND" }, ["D-01", "D-02"])
    expect(new Set(staged.map((order) => order.releaseTimeMs)).size).toBe(3)
    expect(dynamic.some((order) => order.releaseTimeMs > 0)).toBe(true)
    expect(atPhase.every((order) => order.releaseTimeMs === 20 * 60_000)).toBe(true)
  })

  it("generates distinct deterministic windows for all five teacher profiles", () => {
    const latestOffsets = (profile: LogisticsOrderGenerationConfig["timeWindowProfile"], minutes: number) => generateLogisticsOrders({ ...config, orderCount: 6, timeWindowProfile: profile, timeWindowMinutes: minutes }, ["D-01"]).map((order) => order.latestArrivalTimeMs - order.earliestStartTimeMs)
    const none = latestOffsets("NONE", 240)
    const relaxed = latestOffsets("RELAXED", 120)
    const normal = latestOffsets("NORMAL", 45)
    const tight = latestOffsets("TIGHT", 20)
    const mixed = latestOffsets("MIXED", 45)
    expect(Math.min(...none)).toBeGreaterThan(Math.max(...relaxed))
    expect(Math.min(...relaxed)).toBeGreaterThan(Math.max(...normal))
    expect(Math.min(...normal)).toBeGreaterThan(Math.max(...tight))
    expect(new Set(mixed).size).toBeGreaterThan(2)
    expect(latestOffsets("MIXED", 45)).toEqual(mixed)
  })

  it("applies uniform, focused and multi-peak delivery demand distributions", () => {
    const destinations = ["D-01", "D-02", "D-03", "D-04", "D-05", "D-06"]
    const uniform = generateLogisticsOrders({ ...config, orderCount: 120, deliveryDistributionMode: "UNIFORM" }, destinations)
    const focused = generateLogisticsOrders({ ...config, orderCount: 120, deliveryDistributionMode: "FOCUSED" }, destinations)
    const multiPeak = generateLogisticsOrders({ ...config, orderCount: 120, deliveryDistributionMode: "MULTI_PEAK" }, destinations)
    const counts = (orders: typeof uniform) => orders.reduce<Record<string, number>>((result, order) => {
      result[order.destinationNodeId] = (result[order.destinationNodeId] ?? 0) + 1
      return result
    }, {})
    const uniformCounts = Object.values(counts(uniform))
    const focusedCounts = Object.values(counts(focused)).sort((left, right) => right - left)
    const multiPeakCounts = Object.values(counts(multiPeak)).sort((left, right) => right - left)

    expect(Math.max(...uniformCounts) - Math.min(...uniformCounts)).toBeLessThanOrEqual(1)
    expect(focusedCounts[0]).toBeGreaterThan(60)
    expect(multiPeakCounts[1]).toBeGreaterThan(multiPeakCounts[2] ?? 0)
    expect(generateLogisticsOrders({ ...config, orderCount: 120, deliveryDistributionMode: "MULTI_PEAK" }, destinations)).toEqual(multiPeak)
  })
})

describe("logistics schedule checks", () => {
  const orders: LogisticsSchedulingOrderView[] = generateLogisticsOrders(config, ["D-01"]).map((order, index) => ({ ...order, id: `order-${index + 1}`, status: "UNASSIGNED" }))
  const aircraft: LogisticsAircraftInstanceView[] = [1, 2, 3].map((index) => ({ id: `aircraft-${index}`, code: `UAV-${index}`, modelCode: "TEACHING-UAV-01", initialBatteryPercent: 100, availableAtMs: 0, status: "READY" }))
  const routes = [route("outbound", "OUTBOUND"), route("return", "RETURN")]

  it("accepts a complete serial schedule", () => {
    const result = checkLogisticsSchedule(orders.map((order, index) => ({ id: `item-${index}`, orderId: order.id, aircraftId: aircraft[index]!.id, outboundRouteId: routes[0]!.id, returnRouteId: routes[1]!.id, plannedTakeoffTimeMs: index * 20 * 60_000 + order.earliestStartTimeMs })), { orders, aircraft, routes, strictSerialOperation: true })
    expect(result.status).toBe("PASSED")
    expect(result.submittable).toBe(true)
  })

  it("blocks overlapping aircraft and missing orders", () => {
    const result = checkLogisticsSchedule([{ id: "item-1", orderId: orders[0]!.id, aircraftId: aircraft[0]!.id, outboundRouteId: routes[0]!.id, returnRouteId: routes[1]!.id, plannedTakeoffTimeMs: orders[0]!.earliestStartTimeMs }], { orders, aircraft, routes, strictSerialOperation: true })
    expect(result.status).toBe("HARD_CONFLICT")
    expect(result.evidence.filter((item) => item.code === "ORDER_UNASSIGNED")).toHaveLength(2)
  })

  it("records late arrival as a submittable risk", () => {
    const singleOrder = [{ ...orders[0]!, latestArrivalTimeMs: 1 }]
    const result = checkLogisticsSchedule([{ id: "item-1", orderId: singleOrder[0]!.id, aircraftId: aircraft[0]!.id, outboundRouteId: routes[0]!.id, returnRouteId: routes[1]!.id, plannedTakeoffTimeMs: singleOrder[0]!.earliestStartTimeMs }], { orders: singleOrder, aircraft, routes, strictSerialOperation: false })
    expect(result.status).toBe("WITH_RISK")
    expect(result.submittable).toBe(true)
  })
})

function route(id: string, direction: "OUTBOUND" | "RETURN"): LogisticsSchedulingRouteView {
  const route: LogisticsRouteInput = {
    id,
    name: id,
    destinationNodeId: "D-01",
    direction,
    role: "PRIMARY",
    groupCode: "G-01",
    departureNodeId: direction === "OUTBOUND" ? "TAKEOFF" : "D-01",
    arrivalNodeId: direction === "OUTBOUND" ? "D-01" : "LANDING",
    protectionRadiusMeters: 30,
    waitingNodeIds: [],
    alternateLandingNodeIds: [],
    emergencyAreaNodeIds: [],
    entryDirectionDegrees: 0,
    exitDirectionDegrees: 180,
    waypoints: [
      { id: `${id}-1`, name: "起点", position: { longitude: 116.3, latitude: 39.9 }, altitudeMeters: 0, segmentAltitudeMeters: 40, speedMps: 12, nodeId: null, locked: true },
      { id: `${id}-2`, name: "终点", position: { longitude: 116.31, latitude: 39.91 }, altitudeMeters: 0, segmentAltitudeMeters: 40, speedMps: 12, nodeId: null, locked: true }
    ]
  }
  return { id, versionId: "version-1", versionNo: 1, route, distanceMeters: 1_000, flightTimeMs: 5 * 60_000, batteryConsumptionPercent: 10 }
}
