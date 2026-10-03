import type {
  LogisticsAircraftInstanceView,
  LogisticsScheduleItemView,
  LogisticsSchedulingOrderView,
  LogisticsSchedulingRouteView,
  V3Coordinate,
  V3LogisticsNode
} from "@wurenji/shared"
import type { LogisticsRuntimeControlState, LogisticsRuntimeEventImpact, LogisticsRuntimeProjection } from "@wurenji/simulation"
import { computeLogisticsRuntimeProjection } from "@wurenji/simulation"

export interface LogisticsRuntimeAcceptanceArea {
  packageId: string
  mapResourceVersion: string
  regionCode: string
  logisticsNodes: V3LogisticsNode[]
}

export interface LogisticsRuntimeAcceptanceFixture {
  area: LogisticsRuntimeAcceptanceArea
  orders: LogisticsSchedulingOrderView[]
  aircraft: LogisticsAircraftInstanceView[]
  routes: LogisticsSchedulingRouteView[]
  scheduleItems: LogisticsScheduleItemView[]
  initialEnvironment: {
    windDirection: "SW"
    windForceState: "NORMAL"
    gustState: "NONE"
    rainState: "NONE"
    positioningState: "NORMAL"
    communicationState: "NORMAL"
  }
}

export interface LogisticsRuntimeAcceptanceSnapshot {
  sequence: number
  simulationTimeMs: number
  reason: "START" | "TICK" | "ACTION" | "EVENT" | "COMPLETE"
  projection: LogisticsRuntimeProjection
}

export function createLogisticsRuntimeAcceptanceFixture(aircraftCount: 1 | 2 | 3 = 3): LogisticsRuntimeAcceptanceFixture {
  const areaNodes: V3LogisticsNode[] = [
    node("airport", "CENTER_AIRPORT", 114, 22.5),
    ...[1, 2, 3].map((index) => node(`delivery-${index}`, "DELIVERY_POINT", 114 + index * 0.01, 22.5 + index * 0.01)),
    ...[1, 2, 3].map((index) => node(`waiting-${index}`, "WAITING_POINT", 114 + index * 0.005, 22.5 + index * 0.005)),
    ...[1, 2, 3].map((index) => node(`alternate-${index}`, "ALTERNATE_LANDING_POINT", 114 - index * 0.01, 22.5 - index * 0.01))
  ]
  const orders = [1, 2, 3].slice(0, aircraftCount).map((index) => ({
    id: `order-${index}`,
    code: `ORD-${String(index).padStart(3, "0")}`,
    destinationNodeId: `delivery-${index}`,
    releaseTimeMs: 0,
    priority: index === 2 ? "URGENT" as const : "NORMAL" as const,
    earliestStartTimeMs: 0,
    latestArrivalTimeMs: 180_000,
    status: "SCHEDULED" as const
  }))
  const aircraft = [1, 2, 3].slice(0, aircraftCount).map((index) => ({
    id: `aircraft-${index}`,
    code: `UAV-${String(index).padStart(3, "0")}`,
    modelCode: "LOGISTICS-STD",
    initialBatteryPercent: 100,
    availableAtMs: 0,
    status: "READY" as const
  }))
  const routes = [1, 2, 3].slice(0, aircraftCount).flatMap((index) => {
    const destination = { longitude: 114 + index * 0.01, latitude: 22.5 + index * 0.01 }
    return [
      route(`route-out-${index}`, "OUTBOUND", [airportPosition(), destination], `delivery-${index}`),
      route(`route-return-${index}`, "RETURN", [destination, airportPosition()], "airport"),
      route(`route-alt-out-${index}`, "OUTBOUND", [airportPosition(), { longitude: 114 - index * 0.01, latitude: 22.5 - index * 0.01 }], `delivery-${index}`, "ALTERNATE")
    ]
  })
  const scheduleItems = [1, 2, 3].slice(0, aircraftCount).map((index) => {
    const plannedTakeoffTimeMs = index * 5_000
    return {
      id: `task-${index}`,
      orderId: `order-${index}`,
      aircraftId: `aircraft-${index}`,
      outboundRouteId: `route-out-${index}`,
      returnRouteId: `route-return-${index}`,
      plannedTakeoffTimeMs,
      orderCode: `ORD-${String(index).padStart(3, "0")}`,
      aircraftCode: `UAV-${String(index).padStart(3, "0")}`,
      destinationNodeId: `delivery-${index}`,
      arrivalTimeMs: plannedTakeoffTimeMs + 60_000,
      returnStartTimeMs: plannedTakeoffTimeMs + 70_000,
      landingTimeMs: plannedTakeoffTimeMs + 130_000,
      nextAvailableTimeMs: plannedTakeoffTimeMs + 140_000,
      batteryAfterMissionPercent: 60
    }
  })
  return {
    area: { packageId: "teaching-region-1", mapResourceVersion: "teaching-region-1@1", regionCode: "GUANGZHOU-TEACHING", logisticsNodes: areaNodes },
    orders,
    aircraft,
    routes,
    scheduleItems,
    initialEnvironment: {
      windDirection: "SW",
      windForceState: "NORMAL",
      gustState: "NONE",
      rainState: "NONE",
      positioningState: "NORMAL",
      communicationState: "NORMAL"
    }
  }
}

export function createAcceptanceControl(): LogisticsRuntimeControlState {
  return {
    aircraftStatusOverrides: {},
    aircraftPositionOverrides: {},
    diversionPlans: {},
    returnPlans: {},
    resumePlans: {},
    holdStartedAtMs: {},
    orderStatusOverrides: {},
    routeStatusOverrides: {},
    taskStatusOverrides: {},
    taskAircraftOverrides: {},
    orderPriorityOverrides: {},
    taskSpeedFactorOverrides: {},
    activeRouteOverrides: {},
    delayOffsetsMs: {},
    eventImpacts: []
  }
}

export function projectAcceptanceTick(
  fixture: LogisticsRuntimeAcceptanceFixture,
  simulationTimeMs: number,
  control: Partial<LogisticsRuntimeControlState> = {}
): LogisticsRuntimeProjection {
  return computeLogisticsRuntimeProjection({
    simulationTimeMs,
    sessionStatus: simulationTimeMs >= 150_000 ? "COMPLETED" : "RUNNING",
    totalAircraft: fixture.aircraft.length,
    orders: fixture.orders,
    aircraft: fixture.aircraft,
    routes: fixture.routes,
    scheduleItems: fixture.scheduleItems,
    initialEnvironment: fixture.initialEnvironment,
    control
  })
}

export function captureAcceptanceSnapshot(
  fixture: LogisticsRuntimeAcceptanceFixture,
  sequence: number,
  simulationTimeMs: number,
  reason: LogisticsRuntimeAcceptanceSnapshot["reason"],
  control: Partial<LogisticsRuntimeControlState> = {}
): LogisticsRuntimeAcceptanceSnapshot {
  return { sequence, simulationTimeMs, reason, projection: projectAcceptanceTick(fixture, simulationTimeMs, control) }
}

export function positioningImpact(eventId: string, aircraftId: string): LogisticsRuntimeEventImpact {
  return {
    eventId,
    category: "POSITIONING_NAVIGATION",
    severity: "ERROR",
    affectedAircraftIds: [aircraftId],
    affectedOrderIds: [],
    affectedRouteIds: []
  }
}

function node(id: string, type: V3LogisticsNode["type"], longitude: number, latitude: number): V3LogisticsNode {
  return { id, code: id.toUpperCase(), type, name: id, geometryType: "POINT", position: { longitude, latitude, altitudeMeters: 10 }, enabled: true, properties: {} }
}

function airportPosition(): V3Coordinate {
  return { longitude: 114, latitude: 22.5, altitudeMeters: 10 }
}

function route(
  id: string,
  direction: "OUTBOUND" | "RETURN",
  positions: V3Coordinate[],
  destinationNodeId: string,
  role: "PRIMARY" | "ALTERNATE" = "PRIMARY"
): LogisticsSchedulingRouteView {
  return {
    id,
    versionId: "teaching-route-version-1",
    versionNo: 1,
    validationStatus: "PASSED",
    distanceMeters: 1_500,
    flightTimeMs: 60_000,
    batteryConsumptionPercent: 20,
    route: {
      id,
      name: id,
      destinationNodeId,
      direction,
      role,
      groupCode: "TEACHING",
      departureNodeId: direction === "OUTBOUND" ? "airport" : destinationNodeId,
      arrivalNodeId: direction === "OUTBOUND" ? destinationNodeId : "airport",
      protectionRadiusMeters: 30,
      waitingNodeIds: [],
      alternateLandingNodeIds: [],
      emergencyAreaNodeIds: [],
      entryDirectionDegrees: 0,
      exitDirectionDegrees: 0,
      waypoints: positions.map((position, index) => ({
        id: `${id}-waypoint-${index}`,
        name: `${id}-waypoint-${index}`,
        position: { longitude: position.longitude, latitude: position.latitude },
        altitudeMeters: position.altitudeMeters ?? 10,
        segmentAltitudeMeters: 80,
        speedMps: 15,
        nodeId: index === positions.length - 1 ? destinationNodeId : "airport",
        locked: index === 0 || index === positions.length - 1
      }))
    }
  }
}
