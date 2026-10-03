import { describe, expect, it } from "vitest"
import { logisticsOrderConfig } from "./logistics-scheduling.validation.js"

describe("logistics publishing conditions", () => {
  it("normalizes all frozen logistics conditions", () => {
    const config = logisticsOrderConfig("LOGISTICS_20", {
      orderCount: 30,
      orderReleaseMode: "AT_PHASE",
      orderReleasePhase: "OUTBOUND",
      priorityProfile: "BALANCED",
      deliveryDistributionMode: "UNIFORM",
      timeWindowProfile: "MIXED",
      initialStandbyAircraftCount: 2,
      initialLowBatteryAircraftCount: 1,
      initialPreflightAbnormalAircraftCount: 1,
      initialUnavailableAircraftCount: 1,
      initialWindDirection: "SW",
      initialWindForceState: "NEAR_LIMIT",
      initialGustState: "OCCASIONAL",
      initialRainState: "BELOW_LIMIT",
      initialPositioningState: "LOCAL_ABNORMAL",
      initialCommunicationState: "CONTINUOUS_ABNORMAL"
    }, "seed")
    expect(config).toMatchObject({
      releaseMode: "AT_PHASE",
      releasePhase: "OUTBOUND",
      timeWindowProfile: "MIXED",
      timeWindowMinutes: 45,
      initialFleet: { readyAircraftCount: 15, standbyAircraftCount: 2, lowBatteryAircraftCount: 1, preflightAbnormalAircraftCount: 1, unavailableAircraftCount: 1 },
      initialEnvironment: { windDirection: "SW", windForceState: "NEAR_LIMIT", gustState: "OCCASIONAL", rainState: "BELOW_LIMIT", positioningState: "LOCAL_ABNORMAL", communicationState: "CONTINUOUS_ABNORMAL" }
    })
  })

  it("keeps legacy numeric windows and environment fields compatible", () => {
    const config = logisticsOrderConfig("LOGISTICS_3", { orderCount: 3, orderReleaseMode: "BATCH", timeWindowMinutes: 35, windProfile: "GUST" }, "seed")
    expect(config).toMatchObject({ timeWindowProfile: "NORMAL", timeWindowMinutes: 35, initialEnvironment: { gustState: "OCCASIONAL", positioningState: "NORMAL", communicationState: "NORMAL" } })
  })

  it("rejects invalid states, fleet overflow and scale-gated signal conditions", () => {
    expect(() => logisticsOrderConfig("LOGISTICS_3", { orderCount: 3, initialWindDirection: "UP" }, "seed")).toThrow("初始风向")
    expect(() => logisticsOrderConfig("LOGISTICS_3", { orderCount: 3, initialStandbyAircraftCount: 2, initialUnavailableAircraftCount: 2 }, "seed")).toThrow("总数")
    expect(() => logisticsOrderConfig("LOGISTICS_5", { orderCount: 6, initialPositioningState: "CONTINUOUS_ABNORMAL" }, "seed")).toThrow("未向当前规模模板开放")
  })

  it("enforces release modes, specified phases and priority profiles by scale", () => {
    expect(() => logisticsOrderConfig("LOGISTICS_3", { orderCount: 3, orderReleaseMode: "DYNAMIC" }, "seed")).toThrow("释放方式")
    expect(() => logisticsOrderConfig("LOGISTICS_5", { orderCount: 6, orderReleaseMode: "AT_PHASE" }, "seed")).toThrow("指定阶段释放")
    expect(() => logisticsOrderConfig("LOGISTICS_10", { orderCount: 10, orderReleaseMode: "AT_PHASE", orderReleasePhase: "OUTBOUND", priorityProfile: "URGENT_HEAVY" }, "seed")).toThrow("优先级结构")
    expect(logisticsOrderConfig("LOGISTICS_20", { orderCount: 20, orderReleaseMode: "DYNAMIC", priorityProfile: "URGENT_HEAVY" }, "seed")).toMatchObject({ releaseMode: "DYNAMIC", releasePhase: null, priorityProfile: "URGENT_HEAVY" })
  })
})
