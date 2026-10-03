import { describe, expect, it } from "vitest"
import type {
  LogisticsRuntimeAircraftView,
  LogisticsRuntimeOrderView,
  LogisticsRuntimeRouteView,
  LogisticsRuntimeSummaryView,
  LogisticsRuntimeTaskView,
  ShowRuntimeGroupView,
  ShowRuntimeTotalsView,
  VtlReplayFrameView
} from "@wurenji/shared"
import {
  advanceRuntimePlaybackTime,
  projectLogisticsRuntimePlayback,
  projectShowRuntimePlayback,
  runtimeEvidenceAtTime,
  runtimeTimelineMarkers,
  vtlReplayAircraftResults,
  vtlReplayFrameAt,
  vtlReplayTaskResults
} from "./runtime-playback"

describe("runtime playback", () => {
  it("advances and clamps the local playback clock", () => {
    expect(advanceRuntimePlaybackTime(1_000, 500, 4, 10_000)).toBe(3_000)
    expect(advanceRuntimePlaybackTime(9_500, 500, 4, 10_000)).toBe(10_000)
  })

  it("orders event markers by simulation time", () => {
    expect(runtimeTimelineMarkers([
      { id: "late", code: "LATE", title: "晚事件", severity: "WARNING", scheduledSimulationTimeMs: 8_000 },
      { id: "early", code: "EARLY", title: "早事件", severity: "ERROR", scheduledSimulationTimeMs: 2_000 }
    ], 10_000).map((item) => item.id)).toEqual(["early", "late"])
  })

  it("selects the latest persisted VTL frame at the requested time", () => {
    const frames = [0, 5_000, 12_000].map((simulationTimeMs, index) => ({
      id: `frame-${index}`,
      sequence: index + 1,
      simulationTimeMs,
      reason: index === 0 ? "START" : "TICK",
      summary: {} as VtlReplayFrameView["summary"],
      aircraft: [],
      groups: [],
      taskObjects: []
    })) satisfies VtlReplayFrameView[]

    expect(vtlReplayFrameAt(frames, 7_500)?.id).toBe("frame-1")
    expect(vtlReplayFrameAt(frames, 20_000)?.id).toBe("frame-2")
    expect(vtlReplayFrameAt([], 1_000)).toBeNull()
  })

  it("projects VTL result lists from the selected persisted frame", () => {
    const frame = {
      id: "frame-start",
      sequence: 1,
      simulationTimeMs: 0,
      reason: "START",
      summary: { completedTaskObjects: 0, totalTaskObjects: 2 } as VtlReplayFrameView["summary"],
      aircraft: [{
        aircraftId: "VTL-01",
        aircraftCode: "VTL-01",
        groupId: "G-01",
        phase: "VERTICAL_TAKEOFF",
        position: { longitude: 114, latitude: 22, altitudeMeters: 0 },
        currentTaskObjectId: null,
        completedTaskObjectIds: [],
        remainingEnergyWh: 1_200,
        remainingEnergyRatio: 1,
        eventIds: [],
        status: "WAITING"
      }],
      groups: [],
      taskObjects: [
        { id: "task-1", title: "巡检对象 1", status: "ASSIGNED", incompleteReason: null },
        { id: "task-2", title: "巡检对象 2", status: "COMPLETED", incompleteReason: null }
      ] as VtlReplayFrameView["taskObjects"]
    } satisfies VtlReplayFrameView

    expect(vtlReplayTaskResults(frame)).toEqual([{
      taskObjectId: "task-1",
      title: "巡检对象 1",
      status: "ASSIGNED",
      reason: "当前时刻尚未开始"
    }])
    expect(vtlReplayAircraftResults(frame)).toEqual([{
      aircraftId: "VTL-01",
      completedTaskObjectIds: [],
      remainingEnergyRatio: 1,
      status: "WAITING"
    }])
  })

  it("hides future VTL evidence until the replay reaches it", () => {
    const evidence = [
      { id: "flow", simulationTimeMs: null },
      { id: "past", simulationTimeMs: 2_000 },
      { id: "future", simulationTimeMs: 8_000 }
    ]

    expect(runtimeEvidenceAtTime(evidence, 5_000).map((item) => item.id)).toEqual(["flow", "past"])
  })

  it("reconstructs a moving show formation", () => {
    const group: ShowRuntimeGroupView = {
      groupId: "G01",
      label: "编队 1",
      plannedCount: 20,
      airborneCount: 0,
      landedCount: 0,
      normalCount: 20,
      warningCount: 0,
      abnormalCount: 0,
      lostCount: 0,
      status: "GROUND",
      center: { longitude: 114, latitude: 22, altitudeMeters: 0 },
      radiusMeters: 18
    }
    const totals: ShowRuntimeTotalsView = {
      plannedCount: 20,
      takeoffCount: 0,
      airborneCount: 0,
      landedCount: 0,
      normalCount: 20,
      warningCount: 0,
      abnormalCount: 0,
      lostCount: 0
    }
    const state = projectShowRuntimePlayback([group], totals, { longitude: 114, latitude: 22 }, 200, 120, 100_000, 45_000, true)

    expect(state.phase).toBe("PERFORMANCE")
    expect(state.groups[0]?.airborneCount).toBe(20)
    expect(state.groups[0]?.center.altitudeMeters).toBeGreaterThan(80)
    expect(state.groups[0]?.center.longitude).not.toBe(114)
  })

  it("projects logistics aircraft along the route", () => {
    const state = projectLogisticsRuntimePlayback({
      simulationTimeMs: 0,
      routes: routes(),
      tasks: [task()],
      aircraft: [aircraft()],
      orders: [order()],
      summary: summary()
    }, 50_000, true)

    expect(state.tasks[0]?.status).toBe("OUTBOUND")
    expect(state.aircraft[0]?.status).toBe("OUTBOUND")
    expect(state.aircraft[0]?.position.longitude).toBeCloseTo(114.005, 3)
    expect(state.orders[0]?.status).toBe("DELIVERING")
    expect(state.summary.airborneAircraft).toBe(1)
  })
})

function routes(): LogisticsRuntimeRouteView[] {
  return [
    {
      id: "out",
      name: "去程",
      destinationNodeId: "D1",
      direction: "OUTBOUND",
      role: "PRIMARY",
      sourceVersionId: "version-out",
      sourceVersionNo: 1,
      validationStatus: "PASSED",
      status: "AVAILABLE",
      activeTaskCount: 1,
      affectedEventIds: [],
      waypoints: [
        { id: "out-1", name: "去程 1", position: { longitude: 114, latitude: 22 }, altitudeMeters: 50, segmentAltitudeMeters: 50, speedMps: 10, nodeId: null, locked: false },
        { id: "out-2", name: "去程 2", position: { longitude: 114.01, latitude: 22 }, altitudeMeters: 50, segmentAltitudeMeters: 50, speedMps: 10, nodeId: null, locked: false }
      ]
    },
    {
      id: "return",
      name: "返程",
      destinationNodeId: "D1",
      direction: "RETURN",
      role: "PRIMARY",
      sourceVersionId: "version-return",
      sourceVersionNo: 1,
      validationStatus: "PASSED",
      status: "AVAILABLE",
      activeTaskCount: 0,
      affectedEventIds: [],
      waypoints: [
        { id: "return-1", name: "返程 1", position: { longitude: 114.01, latitude: 22 }, altitudeMeters: 50, segmentAltitudeMeters: 50, speedMps: 10, nodeId: null, locked: false },
        { id: "return-2", name: "返程 2", position: { longitude: 114, latitude: 22 }, altitudeMeters: 50, segmentAltitudeMeters: 50, speedMps: 10, nodeId: null, locked: false }
      ]
    }
  ]
}

function task(): LogisticsRuntimeTaskView {
  return {
    scheduleItemId: "task-1",
    orderId: "order-1",
    orderCode: "ORD-001",
    aircraftId: "aircraft-1",
    aircraftCode: "UAV-001",
    destinationNodeId: "D1",
    status: "WAITING_EXECUTION",
    outboundRouteId: "out",
    returnRouteId: "return",
    activeRouteId: "out",
    plannedTakeoffTimeMs: 0,
    arrivalTimeMs: 100_000,
    returnStartTimeMs: 120_000,
    landingTimeMs: 220_000,
    nextAvailableTimeMs: 230_000,
    position: { longitude: 114, latitude: 22, altitudeMeters: 0 },
    speedMps: 0,
    batteryPercent: 70,
    delayedByMs: 0
  }
}

function aircraft(): LogisticsRuntimeAircraftView {
  return {
    id: "aircraft-1",
    code: "UAV-001",
    status: "ASSIGNED",
    currentTaskId: "task-1",
    currentOrderId: "order-1",
    position: { longitude: 114, latitude: 22, altitudeMeters: 0 },
    speedMps: 0,
    batteryPercent: 100,
    nextAvailableTimeMs: 230_000
  }
}

function order(): LogisticsRuntimeOrderView {
  return {
    id: "order-1",
    code: "ORD-001",
    priority: "NORMAL",
    destinationNodeId: "D1",
    status: "SCHEDULED",
    assignedAircraftId: "aircraft-1",
    scheduleItemId: "task-1",
    releaseTimeMs: 0,
    latestArrivalTimeMs: 150_000,
    expectedArrivalTimeMs: 100_000
  }
}

function summary(): LogisticsRuntimeSummaryView {
  return {
    totalAircraft: 1,
    availableAircraft: 0,
    assignedAircraft: 1,
    airborneAircraft: 0,
    holdingAircraft: 0,
    warningAircraft: 0,
    disabledAircraft: 0,
    totalOrders: 1,
    unreleasedOrders: 0,
    waitingOrders: 1,
    deliveringOrders: 0,
    completedOrders: 0,
    delayedOrders: 0,
    failedOrders: 0,
    cancelledOrders: 0
  }
}
