import { describe, expect, it } from "vitest"
import type { AssignmentDraftConfig, V3RegionCatalogItem } from "@wurenji/shared"
import { logisticsTaskSummary } from "./logistics-task-summary"

describe("logistics task summary", () => {
  it("presents frozen teacher conditions with named logistics nodes", () => {
    const summary = logisticsTaskSummary(config(), "ASSESSMENT", region())

    expect(summary).toMatchObject({
      projectBackground: "保障城区药品配送",
      completionRequirements: "完成规划、调度、运行和复盘",
      mode: "考核模式",
      fleetTemplate: "10 架物流机群（LOGISTICS_10）",
      centerAirport: "城北物流机场",
      candidateDeliveryPoints: ["医院配送点", "社区配送点"],
      orderCount: 18,
      releaseMode: "分批释放",
      priorityProfile: "高优先级偏多",
      deliveryDistributionMode: "多点高峰",
      timeWindow: "混合时间窗口",
      initialAircraftState: "可用 4 架 · 待用 2 架 · 低电量 2 架 · 飞前异常 1 架 · 不可用 1 架",
      weatherState: "西南风 · 风力接近限制 · 阵风偶发 · 降雨阈值内",
      positioningState: "局部异常",
      communicationState: "正常",
      scenarioEvents: []
    })
  })

  it("falls back deterministically for legacy task snapshots", () => {
    const legacy = config()
    delete legacy.logisticsParameters
    legacy.scenario = {}

    const summary = logisticsTaskSummary(legacy, "TRAINING", region())

    expect(summary.projectBackground).toBe(legacy.taskBrief)
    expect(summary.completionRequirements).toBe(legacy.taskBrief)
    expect(summary.candidateDeliveryPoints).toEqual(["医院配送点", "社区配送点", "园区配送点"])
    expect(summary.timeWindow).toBe("一般")
    expect(summary.initialAircraftState).toBe("可用 10 架 · 待用 0 架 · 低电量 0 架 · 飞前异常 0 架 · 不可用 0 架")
    expect(summary.weatherState).toBe("北风 · 风力正常 · 阵风无 · 降雨无")
    expect(summary.positioningState).toBe("正常")
    expect(summary.communicationState).toBe("正常")
  })

  it("describes specified-stage release from the frozen task snapshot", () => {
    const input = config()
    input.scenario.orderReleaseMode = "AT_PHASE"
    input.scenario.orderReleasePhase = "OUTBOUND"
    expect(logisticsTaskSummary(input, "TRAINING", region()).releaseMode).toBe("指定阶段释放（去程）")
  })

  it("shows frozen event subtype labels and legacy generic events", () => {
    const input = config()
    input.scenario.eventConfigs = [
      { code: "AIRCRAFT_FAULT", eventSubtype: "BATTERY_CONSUMPTION_ANOMALY" },
      { code: "ROUTE_SUSPENDED" }
    ]
    expect(logisticsTaskSummary(input, "TRAINING", region()).scenarioEvents).toEqual(["电池消耗异常", "航线运行条件变化"])

    input.scenario = { eventCodes: ["NODE_UNAVAILABLE"] }
    expect(logisticsTaskSummary(input, "TRAINING", region()).scenarioEvents).toEqual(["配送节点不可用"])
  })
})

function config(): AssignmentDraftConfig {
  return {
    taskBrief: "规划安全高效的物流配送方案",
    logisticsParameters: {
      projectBackground: "保障城区药品配送",
      completionRequirements: "完成规划、调度、运行和复盘",
      plannedStartAt: "2026-08-20T01:00:00.000Z",
      plannedEndAt: "2026-08-20T09:00:00.000Z"
    },
    scaleTemplateCode: "LOGISTICS_10",
    regionPackageId: "region-logistics",
    availableAt: "2026-08-19T00:00:00.000Z",
    dueAt: "2026-08-21T00:00:00.000Z",
    assessmentDurationMinutes: 120,
    allowResubmission: false,
    allowedValidationAttempts: 3,
    allowedRuntimeAttempts: 2,
    resultVisibility: "FULL_REVIEW",
    scenario: {
      candidateDeliveryPointIds: ["delivery-1", "delivery-2"],
      orderCount: 18,
      orderReleaseMode: "STAGED",
      priorityProfile: "URGENT_HEAVY",
      deliveryDistributionMode: "MULTI_PEAK",
      timeWindowProfile: "MIXED",
      initialUnavailableAircraftCount: 1,
      initialLowBatteryAircraftCount: 2,
      initialStandbyAircraftCount: 2,
      initialPreflightAbnormalAircraftCount: 1,
      initialWindDirection: "SW",
      initialWindForceState: "NEAR_LIMIT",
      initialGustState: "OCCASIONAL",
      initialRainState: "BELOW_LIMIT",
      initialPositioningState: "LOCAL_ABNORMAL",
      initialCommunicationState: "NORMAL"
    }
  }
}

function region(): V3RegionCatalogItem {
  return {
    logisticsNodes: [
      { id: "airport", code: "APT", type: "CENTER_AIRPORT", name: "城北物流机场", geometryType: "POINT", enabled: true, properties: {} },
      { id: "delivery-1", code: "D01", type: "DELIVERY_POINT", name: "医院配送点", geometryType: "POINT", enabled: true, properties: {} },
      { id: "delivery-2", code: "D02", type: "DELIVERY_POINT", name: "社区配送点", geometryType: "POINT", enabled: true, properties: {} },
      { id: "delivery-3", code: "D03", type: "DELIVERY_POINT", name: "园区配送点", geometryType: "POINT", enabled: true, properties: {} }
    ]
  } as V3RegionCatalogItem
}
