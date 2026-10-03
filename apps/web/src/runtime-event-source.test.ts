import { describe, expect, it } from "vitest"
import { runtimeEventCategoryLabel, runtimeEventSource } from "./runtime-event-source"

describe("runtime event source", () => {
  it("identifies scenario-specific system roles", () => {
    expect(runtimeEventSource("CITY_SHOW", "WEATHER")).toBe("气象服务")
    expect(runtimeEventSource("CITY_LOGISTICS", "ORDER_TASK_CHANGE")).toBe("仓站 / 配送点")
    expect(runtimeEventSource("VTOL_INSPECTION", "ENERGY_POWER")).toBe("能源管理服务")
  })

  it("uses the business event code when a category contains multiple NPC roles", () => {
    expect(runtimeEventSource("CITY_LOGISTICS", "ROUTE_OPERATION", "NODE_UNAVAILABLE")).toBe("仓站 / 配送点")
    expect(runtimeEventSource("CITY_LOGISTICS", "ROUTE_OPERATION", "ROUTE_SUSPENDED")).toBe("物流调度员")
  })

  it("falls back to the scene command role for unknown categories", () => {
    expect(runtimeEventSource("CITY_SHOW", "UNKNOWN")).toBe("运行指挥 / 安全员")
    expect(runtimeEventSource("CITY_LOGISTICS", "UNKNOWN")).toBe("物流运行指挥")
    expect(runtimeEventSource("VTOL_INSPECTION", "UNKNOWN")).toBe("巡检运行指挥")
  })

  it("localizes event categories without hiding unknown values", () => {
    expect(runtimeEventCategoryLabel("VTOL_INSPECTION", "ENERGY_POWER")).toBe("能源与动力")
    expect(runtimeEventCategoryLabel("CITY_LOGISTICS", "ORDER_TASK_CHANGE")).toBe("订单与任务")
    expect(runtimeEventCategoryLabel("CITY_SHOW", "CUSTOM")).toBe("CUSTOM")
  })
})
