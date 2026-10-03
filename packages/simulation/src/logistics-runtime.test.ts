import { describe, expect, it } from "vitest"
import type { LogisticsAircraftInstanceView, LogisticsScheduleItemView, LogisticsSchedulingOrderView, LogisticsSchedulingRouteView } from "@wurenji/shared"
import { logisticsTemplatePolicy } from "@wurenji/shared"
import { computeLogisticsRuntimeProjection, logisticsRuntimeActionsFor, logisticsRuntimeEligibleRouteIdsByTargetId, logisticsRuntimeEligibleTargetIds, logisticsRuntimeTaskStatusAt } from "./logistics-runtime.js"

const orders: LogisticsSchedulingOrderView[] = [{
  id: "order-1",
  code: "ORD-001",
  destinationNodeId: "delivery-1",
  releaseTimeMs: 0,
  priority: "URGENT",
  earliestStartTimeMs: 0,
  latestArrivalTimeMs: 80_000,
  status: "SCHEDULED"
}]

const aircraft: LogisticsAircraftInstanceView[] = [{
  id: "aircraft-1",
  code: "UAV-001",
  modelCode: "LOGISTICS-STD",
  initialBatteryPercent: 96,
  availableAtMs: 0,
  status: "READY"
}]

const routes: LogisticsSchedulingRouteView[] = [
  route("route-out", "OUTBOUND", [[114, 22.5], [114.01, 22.51]]),
  route("route-return", "RETURN", [[114.01, 22.51], [114, 22.5]]),
  route("route-alt-out", "OUTBOUND", [[114, 22.5], [114.012, 22.512]], "ALTERNATE"),
  route("route-alt-return", "RETURN", [[114.012, 22.512], [114, 22.5]], "ALTERNATE")
]

const scheduleItem: LogisticsScheduleItemView = {
  id: "task-1",
  orderId: "order-1",
  aircraftId: "aircraft-1",
  outboundRouteId: "route-out",
  returnRouteId: "route-return",
  plannedTakeoffTimeMs: 10_000,
  orderCode: "ORD-001",
  aircraftCode: "UAV-001",
  destinationNodeId: "delivery-1",
  arrivalTimeMs: 70_000,
  returnStartTimeMs: 80_000,
  landingTimeMs: 140_000,
  nextAvailableTimeMs: 150_000,
  batteryAfterMissionPercent: 54
}

describe("logistics runtime engine", () => {
  it("projects the required seven mission states deterministically", () => {
    expect(logisticsRuntimeTaskStatusAt(scheduleItem, 0)).toBe("WAITING_EXECUTION")
    expect(logisticsRuntimeTaskStatusAt(scheduleItem, 12_000)).toBe("TAKEOFF")
    expect(logisticsRuntimeTaskStatusAt(scheduleItem, 40_000)).toBe("OUTBOUND")
    expect(logisticsRuntimeTaskStatusAt(scheduleItem, 75_000)).toBe("ARRIVAL_CONFIRMATION")
    expect(logisticsRuntimeTaskStatusAt(scheduleItem, 100_000)).toBe("RETURNING")
    expect(logisticsRuntimeTaskStatusAt(scheduleItem, 145_000)).toBe("LANDING")
    expect(logisticsRuntimeTaskStatusAt(scheduleItem, 150_000)).toBe("AVAILABLE_AGAIN")
  })

  it("projects position, battery and aggregate state from the authoritative clock", () => {
    const first = projection(40_000)
    const second = projection(40_000)
    expect(first).toEqual(second)
    expect(first.tasks[0]).toMatchObject({ status: "OUTBOUND", activeRouteId: "route-out" })
    expect(first.tasks[0]!.position.longitude).toBeGreaterThan(114)
    expect(first.tasks[0]!.batteryPercent).toBeLessThan(96)
    expect(first.aircraft[0]).toMatchObject({ status: "OUTBOUND", currentOrderId: "order-1" })
    expect(first.orders[0]).toMatchObject({ status: "DELIVERING", assignedAircraftId: "aircraft-1" })
    expect(first.summary).toMatchObject({ airborneAircraft: 1, deliveringOrders: 1 })
  })

  it("keeps a logistics aircraft continuous across successive authoritative ticks", () => {
    const at40s = projection(40_000)
    const at80s = projection(80_000)
    const at120s = projection(120_000)
    const positions = [at40s.aircraft[0]!.position, at80s.aircraft[0]!.position, at120s.aircraft[0]!.position]
    const batteries = [at40s.aircraft[0]!.batteryPercent, at80s.aircraft[0]!.batteryPercent, at120s.aircraft[0]!.batteryPercent]
    const speeds = [at40s.aircraft[0]!.speedMps, at80s.aircraft[0]!.speedMps, at120s.aircraft[0]!.speedMps]

    expect(positions.every((position) => Number.isFinite(position.longitude) && Number.isFinite(position.latitude))).toBe(true)
    expect(positions[1]!.longitude).toBeGreaterThan(positions[0]!.longitude)
    expect(positions[2]!.longitude).toBeLessThan(positions[1]!.longitude)
    expect(batteries[1]).toBeLessThanOrEqual(batteries[0]!)
    expect(batteries[2]).toBeLessThanOrEqual(batteries[1]!)
    expect(speeds[0]).toBeGreaterThan(0)
    expect(speeds[1]).toBeGreaterThan(0)
    expect(speeds[2]).toBeCloseTo(speeds[1]!, 5)
    expect(at40s.aircraft[0]!.status).toBe("OUTBOUND")
    expect(at80s.aircraft[0]!.status).toBe("RETURNING")
    expect(at120s.aircraft[0]!.status).toBe("RETURNING")
  })

  it("keeps three-aircraft missions independent across the full delivery loop", () => {
    const fixture = threeAircraftFixture()
    const running = computeLogisticsRuntimeProjection({
      simulationTimeMs: 80_000,
      sessionStatus: "RUNNING",
      totalAircraft: 3,
      orders: fixture.orders,
      aircraft: fixture.aircraft,
      routes: fixture.routes,
      scheduleItems: fixture.scheduleItems
    })
    expect(running.tasks).toHaveLength(3)
    expect(new Set(running.tasks.map((task) => task.aircraftId)).size).toBe(3)
    expect(running.aircraft.every((item) => Number.isFinite(item.position.longitude) && item.speedMps >= 0)).toBe(true)
    expect(running.summary.airborneAircraft).toBe(3)

    const completed = computeLogisticsRuntimeProjection({
      simulationTimeMs: 210_000,
      sessionStatus: "RUNNING",
      totalAircraft: 3,
      orders: fixture.orders,
      aircraft: fixture.aircraft,
      routes: fixture.routes,
      scheduleItems: fixture.scheduleItems
    })
    expect(completed.tasks.every((task) => task.status === "AVAILABLE_AGAIN")).toBe(true)
    expect(completed.orders.every((order) => order.status === "COMPLETED")).toBe(true)
    expect(completed.summary).toMatchObject({ availableAircraft: 3, completedOrders: 3, airborneAircraft: 0 })
  })

  it("starts an action-triggered return from the aircraft's current position", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 45_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        aircraftStatusOverrides: { "aircraft-1": "RETURNING" },
        taskStatusOverrides: { "task-1": "RETURNING" },
        activeRouteOverrides: { "task-1": "route-return" },
        orderStatusOverrides: { "order-1": "DELAYED" },
        returnPlans: {
          "aircraft-1": {
            aircraftId: "aircraft-1",
            taskId: "task-1",
            startSimulationTimeMs: 45_000,
            endSimulationTimeMs: 105_000,
            routePoints: [{ longitude: 114.008, latitude: 22.508, altitudeMeters: 80 }, { longitude: 114, latitude: 22.5, altitudeMeters: 10 }]
          }
        }
      }
    })

    expect(result.tasks[0]).toMatchObject({ status: "RETURNING", activeRouteId: "route-return", position: { longitude: 114.008 }, returnStartTimeMs: 45_000, landingTimeMs: 105_000, nextAvailableTimeMs: 105_000 })
    expect(result.aircraft[0]).toMatchObject({ status: "RETURNING", position: { longitude: 114.008 } })
  })

  it("pauses the mission timeline while an aircraft is holding", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 100_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        aircraftStatusOverrides: { "aircraft-1": "HOLDING" },
        aircraftPositionOverrides: { "aircraft-1": { longitude: 114.004, latitude: 22.504, altitudeMeters: 80 } },
        holdStartedAtMs: { "task-1": 40_000 }
      }
    })

    expect(result.tasks[0]).toMatchObject({ status: "OUTBOUND", plannedTakeoffTimeMs: 70_000, position: { longitude: 114.004 } })
    expect(result.aircraft[0]).toMatchObject({ status: "HOLDING", position: { longitude: 114.004 } })
  })

  it("resumes from a waiting position without jumping back along the old route", () => {
    const atResume = computeLogisticsRuntimeProjection({
      simulationTimeMs: 100_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        delayOffsetsMs: { "task-1": 60_000 },
        resumePlans: {
          "aircraft-1": {
            aircraftId: "aircraft-1",
            taskId: "task-1",
            startSimulationTimeMs: 100_000,
            endSimulationTimeMs: 140_000,
            routePoints: [
              { longitude: 114.008, latitude: 22.508, altitudeMeters: 80 },
              { longitude: 114.01, latitude: 22.51, altitudeMeters: 80 }
            ]
          }
        }
      }
    })
    const later = computeLogisticsRuntimeProjection({
      simulationTimeMs: 120_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        delayOffsetsMs: { "task-1": 60_000 },
        resumePlans: {
          "aircraft-1": {
            aircraftId: "aircraft-1",
            taskId: "task-1",
            startSimulationTimeMs: 100_000,
            endSimulationTimeMs: 140_000,
            routePoints: [
              { longitude: 114.008, latitude: 22.508, altitudeMeters: 80 },
              { longitude: 114.01, latitude: 22.51, altitudeMeters: 80 }
            ]
          }
        }
      }
    })

    expect(atResume.tasks[0]).toMatchObject({ status: "OUTBOUND", position: { longitude: 114.008 } })
    expect(later.tasks[0]!.position.longitude).toBeGreaterThan(atResume.tasks[0]!.position.longitude)
    expect(later.aircraft[0]!.position.longitude).toBeGreaterThan(114.008)
  })

  it("applies event and control overrides without rewriting the schedule", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 20,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        aircraftStatusOverrides: { "aircraft-1": "HOLDING" },
        aircraftPositionOverrides: { "aircraft-1": { longitude: 114.005, latitude: 22.505, altitudeMeters: 80 } },
        routeStatusOverrides: { "route-out": "PAUSED" },
        delayOffsetsMs: { "task-1": 20_000 },
        eventImpacts: [{
          eventId: "event-1",
          category: "WEATHER_ENVIRONMENT",
          severity: "WARNING",
          affectedAircraftIds: ["aircraft-1"],
          affectedOrderIds: ["order-1"],
          affectedRouteIds: ["route-out"]
        }]
      }
    })
    expect(result.aircraft[0]?.status).toBe("HOLDING")
    expect(result.aircraft[0]?.position.longitude).toBe(114.005)
    expect(result.routes.find((item) => item.id === "route-out")?.status).toBe("PAUSED")
    expect(result.tasks[0]).toMatchObject({ delayedByMs: 20_000, plannedTakeoffTimeMs: 30_000 })
    expect(result.tasks[0]?.arrivalTimeMs).toBeGreaterThan(70_000)
    expect(result.tasks[0]?.batteryPercent).toBeLessThan(96)
    expect(result.environment.windState).toBe("NEAR_LIMIT")

    const withoutEvent = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 20,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: { delayOffsetsMs: { "task-1": 20_000 } }
    })
    expect(result.tasks[0]!.batteryPercent).toBeLessThan(withoutEvent.tasks[0]!.batteryPercent)
  })

  it("keeps a failed active task at its last known position", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        aircraftStatusOverrides: { "aircraft-1": "EMERGENCY_LANDING" },
        aircraftPositionOverrides: { "aircraft-1": { longitude: 114.006, latitude: 22.506, altitudeMeters: 65 } },
        taskStatusOverrides: { "task-1": "FAILED" },
        orderStatusOverrides: { "order-1": "FAILED" }
      }
    })

    expect(result.tasks[0]).toMatchObject({ status: "FAILED", position: { longitude: 114.006, altitudeMeters: 65 } })
    expect(result.aircraft[0]).toMatchObject({ status: "EMERGENCY_LANDING", position: { longitude: 114.006, altitudeMeters: 65 } })
  })

  it("interpolates an aircraft along a diversion plan instead of teleporting", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 30_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        aircraftStatusOverrides: { "aircraft-1": "DIVERTING" },
        diversionPlans: {
          "aircraft-1": {
            aircraftId: "aircraft-1",
            taskId: "task-1",
            startSimulationTimeMs: 20_000,
            endSimulationTimeMs: 40_000,
            startPosition: { longitude: 114, latitude: 22.5, altitudeMeters: 70 },
            landingPosition: { longitude: 114.02, latitude: 22.5, altitudeMeters: 10 },
            landingNodeId: "alternate-1"
          }
        }
      }
    })

    expect(result.aircraft[0]?.position.longitude).toBeCloseTo(114.01, 5)
    expect(result.aircraft[0]?.position.altitudeMeters).toBeCloseTo(40, 5)
    expect(result.tasks[0]).toMatchObject({ returnStartTimeMs: 20_000, landingTimeMs: 40_000, nextAvailableTimeMs: 40_000 })
  })

  it("limits a verified alternate route override to the matching flight direction", () => {
    const control = {
      aircraftStatusOverrides: { "aircraft-1": "DIVERTING" as const },
      activeRouteOverrides: { "task-1": "route-alt-out" }
    }
    const outbound = computeLogisticsRuntimeProjection({ simulationTimeMs: 40_000, sessionStatus: "RUNNING", totalAircraft: 1, orders, aircraft, routes, scheduleItems: [scheduleItem], control })
    expect(outbound.tasks[0]).toMatchObject({ status: "OUTBOUND", activeRouteId: "route-alt-out" })
    expect(outbound.aircraft[0]?.status).toBe("DIVERTING")

    const completed = computeLogisticsRuntimeProjection({ simulationTimeMs: 150_000, sessionStatus: "RUNNING", totalAircraft: 1, orders, aircraft, routes, scheduleItems: [scheduleItem], control })
    expect(completed.tasks[0]).toMatchObject({ status: "AVAILABLE_AGAIN", activeRouteId: null })
    expect(completed.aircraft[0]?.status).toBe("AVAILABLE")
  })

  it("keeps arrival confirmation on the selected alternate outbound route", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 75_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: { activeRouteOverrides: { "task-1": "route-alt-out" } }
    })

    expect(result.tasks[0]).toMatchObject({ status: "ARRIVAL_CONFIRMATION", activeRouteId: "route-alt-out" })
    expect(result.tasks[0]?.position).toMatchObject({ longitude: 114.012, latitude: 22.512 })
  })

  it("keeps a diverted aircraft at the alternate landing point after arrival", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 45_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        aircraftStatusOverrides: { "aircraft-1": "DIVERTING" },
        orderStatusOverrides: { "order-1": "DELAYED" },
        diversionPlans: {
          "aircraft-1": {
            aircraftId: "aircraft-1",
            taskId: "task-1",
            startSimulationTimeMs: 20_000,
            endSimulationTimeMs: 40_000,
            startPosition: { longitude: 114, latitude: 22.5, altitudeMeters: 70 },
            landingPosition: { longitude: 114.02, latitude: 22.5, altitudeMeters: 10 },
            landingNodeId: "alternate-1"
          }
        }
      }
    })

    expect(result.tasks[0]).toMatchObject({ status: "AVAILABLE_AGAIN", nextAvailableTimeMs: 40_000, position: { longitude: 114.02, altitudeMeters: 10 } })
    expect(result.aircraft[0]).toMatchObject({ status: "AVAILABLE", position: { longitude: 114.02, altitudeMeters: 10 } })
    expect(result.orders[0]).toMatchObject({ status: "DELAYED" })
  })

  it("starts from frozen environment conditions and lets events worsen them", () => {
    const initialEnvironment = {
      windDirection: "SW",
      windForceState: "NEAR_LIMIT",
      gustState: "OCCASIONAL",
      rainState: "BELOW_LIMIT",
      positioningState: "LOCAL_WEAK",
      communicationState: "RECOVERING"
    } as const
    const initial = computeLogisticsRuntimeProjection({ simulationTimeMs: 0, sessionStatus: "READY", totalAircraft: 3, orders, aircraft, routes, scheduleItems: [scheduleItem], initialEnvironment })
    expect(initial.environment).toMatchObject({ windDirection: "SW", windState: "NEAR_LIMIT", gustState: "OCCASIONAL", rainState: "BELOW_LIMIT", positioningQuality: "DEGRADED", communicationQuality: "DEGRADED" })
    const worsened = computeLogisticsRuntimeProjection({
      simulationTimeMs: 0,
      sessionStatus: "RUNNING",
      totalAircraft: 3,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      initialEnvironment,
      control: { eventImpacts: [{ eventId: "critical-weather", category: "WEATHER_ENVIRONMENT", severity: "CRITICAL", affectedAircraftIds: [], affectedOrderIds: [], affectedRouteIds: [] }] }
    })
    expect(worsened.environment).toMatchObject({ windState: "OVER_LIMIT", gustState: "CONTINUOUS", rainState: "OVER_LIMIT" })
  })

  it("consumes positioning and communication events into runtime state", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 1,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        eventImpacts: [
          { eventId: "positioning-loss", category: "POSITIONING_NAVIGATION", severity: "ERROR", affectedAircraftIds: ["aircraft-1"], affectedOrderIds: [], affectedRouteIds: [] },
          { eventId: "communication-loss", category: "COMMUNICATION_LINK", severity: "CRITICAL", affectedAircraftIds: ["aircraft-1"], affectedOrderIds: [], affectedRouteIds: [] }
        ]
      }
    })

    expect(result.environment).toMatchObject({ positioningQuality: "LOST", communicationQuality: "LOST" })
  })

  it("keeps standby aircraft unavailable until their configured time", () => {
    const standbyAircraft = [{ ...aircraft[0]!, availableAtMs: 60_000 }]
    const before = computeLogisticsRuntimeProjection({ simulationTimeMs: 0, sessionStatus: "READY", totalAircraft: 1, orders: [], aircraft: standbyAircraft, routes: [], scheduleItems: [] })
    const after = computeLogisticsRuntimeProjection({ simulationTimeMs: 60_000, sessionStatus: "RUNNING", totalAircraft: 1, orders: [], aircraft: standbyAircraft, routes: [], scheduleItems: [] })
    expect(before.aircraft[0]?.status).toBe("STANDBY")
    expect(before.summary.availableAircraft).toBe(0)
    expect(after.aircraft[0]?.status).toBe("AVAILABLE")
    expect(after.summary.availableAircraft).toBe(1)
  })

  it("opens batch and global rescheduling only at the required scales", () => {
    const small = logisticsRuntimeActionsFor(10, "RUNNING")
    const medium = logisticsRuntimeActionsFor(20, "RUNNING")
    const large = logisticsRuntimeActionsFor(50, "RUNNING", [{ status: "PAUSED" }])
    expect(small.find((item) => item.code === "BATCH_REASSIGN")?.enabled).toBe(false)
    expect(medium.find((item) => item.code === "BATCH_REASSIGN")?.enabled).toBe(true)
    expect(medium.find((item) => item.code === "GLOBAL_RESCHEDULE")?.enabled).toBe(false)
    expect(large.find((item) => item.code === "GLOBAL_RESCHEDULE")?.enabled).toBe(true)
    expect(large.find((item) => item.code === "RESUME_ROUTE")?.enabled).toBe(true)
  })

  it("only exposes aircraft and orders that can receive each flight action", () => {
    const airborne = projection(40_000)
    expect(logisticsRuntimeEligibleTargetIds("REDUCE_SPEED", airborne)).toEqual(["aircraft-1"])
    expect(logisticsRuntimeEligibleTargetIds("HOLD_POSITION", airborne)).toEqual(["aircraft-1"])
    expect(logisticsRuntimeEligibleTargetIds("RETURN_AIRCRAFT", airborne)).toEqual(["aircraft-1"])
    expect(logisticsRuntimeEligibleTargetIds("DIVERT_AIRCRAFT", airborne)).toEqual(["aircraft-1"])
    expect(logisticsRuntimeEligibleTargetIds("EMERGENCY_LAND_AIRCRAFT", airborne)).toEqual(["aircraft-1"])
    expect(logisticsRuntimeEligibleTargetIds("ABORT_TASK", airborne)).toEqual(["order-1"])
    expect(logisticsRuntimeEligibleTargetIds("SWITCH_VERIFIED_ROUTE", airborne)).toEqual(["order-1"])
    expect(logisticsRuntimeEligibleRouteIdsByTargetId(airborne)).toEqual({ "order-1": ["route-alt-out"] })

    const returning = projection(100_000)
    expect(logisticsRuntimeEligibleTargetIds("REDUCE_SPEED", returning)).toEqual([])
    expect(logisticsRuntimeEligibleTargetIds("MAINTAIN_ROUTE", returning)).toEqual([])

    const waiting = projection(0)
    expect(logisticsRuntimeEligibleTargetIds("REDUCE_SPEED", waiting)).toEqual([])
    expect(logisticsRuntimeEligibleTargetIds("HOLD_POSITION", waiting)).toEqual([])
    expect(logisticsRuntimeEligibleTargetIds("RETURN_AIRCRAFT", waiting)).toEqual([])
    expect(logisticsRuntimeEligibleTargetIds("DELAY_TASK", waiting)).toEqual(["order-1"])
    expect(logisticsRuntimeEligibleTargetIds("SWITCH_VERIFIED_ROUTE", waiting)).toEqual(["order-1"])
    expect(logisticsRuntimeEligibleRouteIdsByTargetId(waiting)).toEqual({ "order-1": ["route-alt-out"] })
  })

  it("only exposes submitted validated alternate routes and blocks recovery while an event remains active", () => {
    const pausedWithEvent = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 3,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: {
        routeStatusOverrides: { "route-out": "PAUSED" },
        eventImpacts: [{
          eventId: "event-route",
          category: "ROUTE_OPERATION",
          severity: "WARNING",
          affectedAircraftIds: [],
          affectedOrderIds: ["order-1"],
          affectedRouteIds: ["route-out"]
        }]
      }
    })
    expect(logisticsRuntimeEligibleTargetIds("RESUME_ROUTE", pausedWithEvent)).toEqual([])

    const pausedAfterRecovery = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 3,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: { routeStatusOverrides: { "route-out": "PAUSED" } }
    })
    expect(logisticsRuntimeEligibleTargetIds("RESUME_ROUTE", pausedAfterRecovery)).toEqual(["route-out"])

    const unavailableAlternate = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 3,
      orders,
      aircraft,
      routes,
      scheduleItems: [scheduleItem],
      control: { routeStatusOverrides: { "route-alt-out": "PAUSED" } }
    })
    expect(logisticsRuntimeEligibleRouteIdsByTargetId(unavailableAlternate)).toEqual({})
    expect(logisticsRuntimeEligibleTargetIds("SWITCH_VERIFIED_ROUTE", unavailableAlternate)).toEqual([])
  })

  it.each([
    ["LOGISTICS_3", 3, 1, 3, 6, true, "NONE", false, false],
    ["LOGISTICS_5", 5, 2, 6, 10, false, "PREFLIGHT_ONLY", false, false],
    ["LOGISTICS_10", 10, 4, 10, 20, false, "LIGHTWEIGHT", false, false],
    ["LOGISTICS_20", 20, 6, 20, 40, false, "SINGLE_TECHNICAL", true, false],
    ["LOGISTICS_50", 50, 8, 50, 100, false, "COMPOSITE", true, true]
  ] as const)("keeps the five logistics scales behaviorally distinct: %s", (code, totalAircraft, minimumPoints, minimumOrders, maximumOrders, strictSerialOperation, eventLevel, batchReschedulingEnabled, globalReschedulingEnabled) => {
    const policy = logisticsTemplatePolicy(code)
    expect(policy).toMatchObject({
      totalAircraft,
      strictSerialOperation,
      eventLevel,
      batchReschedulingEnabled,
      globalReschedulingEnabled,
      deliveryPointRange: { minimum: minimumPoints },
      orderCountRange: { minimum: minimumOrders, maximum: maximumOrders }
    })
  })

  it("projects operational control effects into the aircraft, order and task views", () => {
    const result = computeLogisticsRuntimeProjection({
      simulationTimeMs: 40_000,
      sessionStatus: "RUNNING",
      totalAircraft: 20,
      orders: [{ ...orders[0]!, priority: "NORMAL" }],
      aircraft: [
        ...aircraft,
        { ...aircraft[0]!, id: "aircraft-2", code: "UAV-002", initialBatteryPercent: 100 }
      ],
      routes,
      scheduleItems: [scheduleItem],
      control: {
        taskSpeedFactorOverrides: { "task-1": 1.5 },
        taskAircraftOverrides: { "task-1": "aircraft-2" },
        orderPriorityOverrides: { "order-1": "URGENT" },
        aircraftStatusOverrides: { "aircraft-1": "DISABLED" }
      }
    })
    expect(result.tasks[0]).toMatchObject({ aircraftId: "aircraft-2", aircraftCode: "UAV-002", arrivalTimeMs: 100_000 })
    expect(result.orders[0]).toMatchObject({ priority: "URGENT", assignedAircraftId: "aircraft-2" })
    expect(result.aircraft.find((item) => item.id === "aircraft-1")?.status).toBe("DISABLED")
  })
})

function projection(simulationTimeMs: number) {
  return computeLogisticsRuntimeProjection({ simulationTimeMs, sessionStatus: "RUNNING", totalAircraft: 3, orders, aircraft, routes, scheduleItems: [scheduleItem] })
}

function threeAircraftFixture(): {
  orders: LogisticsSchedulingOrderView[]
  aircraft: LogisticsAircraftInstanceView[]
  routes: LogisticsSchedulingRouteView[]
  scheduleItems: LogisticsScheduleItemView[]
} {
  const orders = [1, 2, 3].map((index) => ({
    id: `order-${index}`,
    code: `ORD-${String(index).padStart(3, "0")}`,
    destinationNodeId: `delivery-${index}`,
    releaseTimeMs: 0,
    priority: "NORMAL" as const,
    earliestStartTimeMs: 0,
    latestArrivalTimeMs: 180_000,
    status: "SCHEDULED" as const
  }))
  const aircraft = [1, 2, 3].map((index) => ({
    id: `aircraft-${index}`,
    code: `UAV-${String(index).padStart(3, "0")}`,
    modelCode: "LOGISTICS-STD",
    initialBatteryPercent: 100,
    availableAtMs: 0,
    status: "READY" as const
  }))
  const routes = [1, 2, 3].flatMap((index) => [
    route(`route-out-${index}`, "OUTBOUND", [[114, 22.5], [114 + index * 0.01, 22.5 + index * 0.01]]),
    route(`route-return-${index}`, "RETURN", [[114 + index * 0.01, 22.5 + index * 0.01], [114, 22.5]])
  ])
  const scheduleItems = [1, 2, 3].map((index) => ({
    ...scheduleItem,
    id: `task-${index}`,
    orderId: `order-${index}`,
    aircraftId: `aircraft-${index}`,
    outboundRouteId: `route-out-${index}`,
    returnRouteId: `route-return-${index}`,
    orderCode: `ORD-${String(index).padStart(3, "0")}`,
    aircraftCode: `UAV-${String(index).padStart(3, "0")}`,
    destinationNodeId: `delivery-${index}`,
    plannedTakeoffTimeMs: index * 5_000,
    arrivalTimeMs: index * 5_000 + 60_000,
    returnStartTimeMs: index * 5_000 + 70_000,
    landingTimeMs: index * 5_000 + 130_000,
    nextAvailableTimeMs: index * 5_000 + 140_000
  }))
  return { orders, aircraft, routes, scheduleItems }
}

function route(id: string, direction: "OUTBOUND" | "RETURN", positions: Array<[number, number]>, role: "PRIMARY" | "ALTERNATE" = "PRIMARY"): LogisticsSchedulingRouteView {
  return {
    id,
    versionId: "version-1",
    versionNo: 1,
    validationStatus: "PASSED",
    distanceMeters: 1_500,
    flightTimeMs: 60_000,
    batteryConsumptionPercent: 21,
    route: {
      id,
      name: id,
      destinationNodeId: "delivery-1",
      direction,
      role,
      groupCode: "G1",
      departureNodeId: direction === "OUTBOUND" ? "airport" : "delivery-1",
      arrivalNodeId: direction === "OUTBOUND" ? "delivery-1" : "airport",
      protectionRadiusMeters: 30,
      waitingNodeIds: [],
      alternateLandingNodeIds: [],
      emergencyAreaNodeIds: [],
      entryDirectionDegrees: null,
      exitDirectionDegrees: null,
      waypoints: positions.map(([longitude, latitude], index) => ({
        id: `${id}-${index}`,
        name: `${id}-${index}`,
        position: { longitude, latitude },
        altitudeMeters: index === 0 ? 0 : 80,
        segmentAltitudeMeters: 80,
        speedMps: 15,
        nodeId: null,
        locked: index === 0 || index === positions.length - 1
      }))
    }
  }
}
