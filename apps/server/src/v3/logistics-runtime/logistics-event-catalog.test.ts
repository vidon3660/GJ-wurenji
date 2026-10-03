import { describe, expect, it } from "vitest"
import { configuredLogisticsEvents } from "./logistics-event-catalog.js"

describe("logistics event configuration", () => {
  it("applies teacher overrides to runtime event defaults", () => {
    const [configured] = configuredLogisticsEvents([{
      code: "NODE_UNAVAILABLE",
      triggerMode: "SIMULATION_TIME",
      triggerTimeSeconds: 120,
      severity: "ERROR",
      detectionDelaySeconds: 4,
      escalationDelaySeconds: 20,
      durationSeconds: 45,
      recoveryMode: "AUTO"
    }])
    expect(configured).toMatchObject({
      code: "NODE_UNAVAILABLE",
      severity: "ERROR",
      detectionDelayMs: 4_000,
      escalationDelayMs: 20_000,
      scenarioConfig: {
        triggerMode: "SIMULATION_TIME",
        triggerTimeSeconds: 120,
        durationSeconds: 45,
        recoveryMode: "AUTO"
      }
    })
    expect(configuredLogisticsEvents(["NODE_UNAVAILABLE"])[0]?.scenarioConfig).toBeNull()
  })

  it("accepts a custom event supplied by an active EVENT resource", () => {
    const [configured] = configuredLogisticsEvents([{
      code: "LOG_CUSTOM_ROUTE",
      title: "资源包自定义航线事件",
      category: "ROUTE_OPERATION",
      severity: "WARNING",
      detectionDelaySeconds: 2,
      escalationDelaySeconds: 18,
      recommendedActions: ["PAUSE_ROUTE"]
    }])

    expect(configured).toMatchObject({ code: "LOG_CUSTOM_ROUTE", title: "资源包自定义航线事件", detectionDelayMs: 2_000 })
  })

  it("specializes equipment and route events without changing their runtime categories", () => {
    const [aircraft] = configuredLogisticsEvents([{
      code: "AIRCRAFT_FAULT",
      eventSubtype: "RETURN_OR_LANDING_UNAVAILABLE"
    }])
    const [route] = configuredLogisticsEvents([{
      code: "NODE_UNAVAILABLE",
      eventSubtype: "WAITING_POINT_STATE_CHANGE"
    }])

    expect(aircraft).toMatchObject({
      title: "无法正常返航或降落",
      category: "AIRCRAFT_DEVICE",
      severity: "CRITICAL",
      recommendedActions: ["DIVERT_AIRCRAFT", "EMERGENCY_LAND_AIRCRAFT", "ABORT_TASK"],
      scenarioConfig: { eventSubtype: "RETURN_OR_LANDING_UNAVAILABLE" }
    })
    expect(route).toMatchObject({
      title: "等待点状态变化",
      category: "ROUTE_OPERATION",
      scenarioConfig: { eventSubtype: "WAITING_POINT_STATE_CHANGE" }
    })
  })

  it("keeps legacy generic event snapshots compatible", () => {
    expect(configuredLogisticsEvents(["AIRCRAFT_FAULT"])[0]).toMatchObject({
      title: "无人机设备故障",
      scenarioConfig: null
    })
  })
})
