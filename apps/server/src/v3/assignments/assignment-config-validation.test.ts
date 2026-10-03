import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"
import type { AssignmentDraftConfig } from "@wurenji/shared"
import { normalizeConfig } from "./assignment.service.js"

describe("assignment config validation", () => {
  it.each([0, 1.5, 1_441])("rejects invalid assessment duration %s", (assessmentDurationMinutes) => {
    expect(() => normalizeConfig({ ...validConfig(), assessmentDurationMinutes }, "CITY_LOGISTICS"))
      .toThrow("考核时长必须在 1 到 1440 分钟之间")
  })

  it("supplies a stable default assessment duration for legacy drafts", () => {
    const input = validConfig() as Partial<AssignmentDraftConfig>
    delete input.assessmentDurationMinutes
    expect(normalizeConfig(input, "CITY_LOGISTICS").assessmentDurationMinutes).toBe(120)
  })

  it.each([
    { field: "scaleTemplateCode", value: {} },
    { field: "regionPackageId", value: {} }
  ])("rejects a non-string $field with a controlled client error", ({ field, value }) => {
    const input = validConfig() as unknown as Record<string, unknown>
    input[field] = value

    expect(() => normalizeConfig(input as unknown as Partial<AssignmentDraftConfig>, "CITY_LOGISTICS"))
      .toThrow(BadRequestException)

    try {
      normalizeConfig(input as unknown as Partial<AssignmentDraftConfig>, "CITY_LOGISTICS")
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException)
      expect((error as BadRequestException).getStatus()).toBe(400)
    }
  })

  it("normalizes candidate delivery points and demand distribution", () => {
    const input = validConfig()
    input.scenario = {
      candidateDeliveryPointIds: ["delivery-1"],
      deliveryDistributionMode: "FOCUSED"
    }

    expect(normalizeConfig(input, "CITY_LOGISTICS").scenario).toMatchObject({
      candidateDeliveryPointIds: ["delivery-1"],
      deliveryDistributionMode: "FOCUSED"
    })
  })

  it("normalizes a scale-authorized logistics event and specified-stage release", () => {
    const input = validConfig()
    input.scaleTemplateCode = "LOGISTICS_20"
    input.scenario = {
      orderCount: 20,
      orderReleaseMode: "AT_PHASE",
      orderReleasePhase: "OUTBOUND",
      priorityProfile: "URGENT_HEAVY",
      eventConfigs: [logisticsEvent("ROUTE_SUSPENDED", { impactScope: "SINGLE_ROUTE", impactCount: 1 })]
    }
    expect(normalizeConfig(input, "CITY_LOGISTICS").scenario).toMatchObject({
      orderReleaseMode: "AT_PHASE",
      orderReleasePhase: "OUTBOUND",
      priorityProfile: "URGENT_HEAVY",
      eventConfigs: [{ code: "ROUTE_SUSPENDED", impactScope: "SINGLE_ROUTE" }]
    })
  })

  it("normalizes logistics event subtypes and supplies a deterministic default", () => {
    const input = validConfig()
    input.scaleTemplateCode = "LOGISTICS_50"
    input.scenario = {
      orderCount: 50,
      eventConfigs: [
        logisticsEvent("AIRCRAFT_FAULT", { eventSubtype: "FLIGHT_CONTROL_ALERT" }),
        logisticsEvent("NODE_UNAVAILABLE")
      ]
    }

    expect(normalizeConfig(input, "CITY_LOGISTICS").scenario.eventConfigs).toMatchObject([
      { code: "AIRCRAFT_FAULT", eventSubtype: "FLIGHT_CONTROL_ALERT" },
      { code: "NODE_UNAVAILABLE", eventSubtype: "DELIVERY_POINT_STATE_CHANGE" }
    ])
  })

  it.each([
    { code: "AIRCRAFT_FAULT", eventSubtype: "WAITING_POINT_STATE_CHANGE" },
    { code: "ROUTE_SUSPENDED", eventSubtype: "UNKNOWN_SUBTYPE" }
  ])("rejects an invalid logistics event subtype combination %#", ({ code, eventSubtype }) => {
    const input = validConfig()
    input.scaleTemplateCode = "LOGISTICS_20"
    input.scenario = { orderCount: 20, eventConfigs: [logisticsEvent(code, { eventSubtype })] }
    expect(() => normalizeConfig(input, "CITY_LOGISTICS")).toThrow(`事件 ${code} 的细分类型无效`)
  })

  it.each([
    { name: "runtime event at 3 aircraft", scale: "LOGISTICS_3", configs: [logisticsEvent("DYNAMIC_ORDER")], message: "须配置 0 到 0 个事件" },
    { name: "technical event at 10 aircraft", scale: "LOGISTICS_10", configs: [logisticsEvent("AIRCRAFT_FAULT", { escalationEnabled: false })], message: "未开放事件 AIRCRAFT_FAULT" },
    { name: "multiple events at 20 aircraft", scale: "LOGISTICS_20", configs: [logisticsEvent("WEATHER_CHANGE"), logisticsEvent("ROUTE_SUSPENDED")], message: "须配置 0 到 1 个事件" },
    { name: "group scope at 20 aircraft", scale: "LOGISTICS_20", configs: [logisticsEvent("AIRCRAFT_FAULT", { impactScope: "GROUP" })], message: "未开放事件 AIRCRAFT_FAULT 的影响范围" },
    { name: "event link at 20 aircraft", scale: "LOGISTICS_20", configs: [logisticsEvent("WEATHER_CHANGE", { followUpEventCode: "ROUTE_SUSPENDED" }), logisticsEvent("ROUTE_SUSPENDED")], message: "须配置 0 到 1 个事件" }
  ])("rejects logistics template-policy bypass: $name", ({ scale, configs, message }) => {
    const input = validConfig()
    input.scaleTemplateCode = scale
    input.scenario = { orderCount: Number(scale.match(/(\d+)$/)?.[1] ?? 3), eventConfigs: configs }
    expect(() => normalizeConfig(input, "CITY_LOGISTICS")).toThrow(message)
  })

  it("allows composite linked events only at the 50-aircraft scale", () => {
    const input = validConfig()
    input.scaleTemplateCode = "LOGISTICS_50"
    input.scenario = {
      orderCount: 50,
      eventConfigs: [
        logisticsEvent("WEATHER_CHANGE", { followUpEventCode: "ROUTE_SUSPENDED", impactScope: "LOCAL_AREA" }),
        logisticsEvent("ROUTE_SUSPENDED", { impactScope: "MULTI_ROUTE", impactCount: 2 })
      ]
    }
    expect(normalizeConfig(input, "CITY_LOGISTICS").scenario.eventConfigs).toMatchObject([
      { code: "WEATHER_CHANGE", followUpEventCode: "ROUTE_SUSPENDED" },
      { code: "ROUTE_SUSPENDED", triggerMode: "AFTER_EVENT", triggerAfterEventCode: "WEATHER_CHANGE" }
    ])
  })

  it.each([
    { candidateDeliveryPointIds: "delivery-1" },
    { candidateDeliveryPointIds: ["delivery-1", "delivery-1"] },
    { deliveryDistributionMode: "UNKNOWN" }
  ])("rejects invalid logistics candidate configuration %#", (scenario) => {
    const input = validConfig()
    input.scenario = scenario
    expect(() => normalizeConfig(input, "CITY_LOGISTICS")).toThrow(BadRequestException)
  })

  it("normalizes complete show initial conditions into the task snapshot", () => {
    const input = validShowConfig()
    input.scenario.showInitialConditions = {
      windDirection: "NW",
      windForceState: "NEAR_LIMIT",
      gustState: "OCCASIONAL",
      rainState: "BELOW_LIMIT",
      positioningElectromagneticState: "LOCAL_ABNORMAL",
      communicationControlState: "GROUP_ABNORMAL",
      deviceState: "BATTERY_ABNORMAL",
      deviceImpactScope: "GROUP"
    }

    expect(normalizeConfig(input, "CITY_SHOW").scenario.showInitialConditions).toMatchObject({
      windDirection: "NW",
      positioningElectromagneticState: "LOCAL_ABNORMAL",
      communicationControlState: "GROUP_ABNORMAL",
      deviceState: "BATTERY_ABNORMAL",
      deviceImpactScope: "GROUP",
      deviceAffectedCount: 100
    })
  })

  it("enforces show initial-condition gates on the server", () => {
    const input = validShowConfig()
    input.scaleTemplateCode = "SHOW_100"
    input.scenario = {
      eventCodes: ["WEATHER_LIMIT"],
      showInitialConditions: { positioningElectromagneticState: "WIDE_AREA_INTERFERENCE" }
    }
    expect(() => normalizeConfig(input, "CITY_SHOW")).toThrow("未开放所选定位与电磁状态")
  })

  it("maps legacy show condition fields deterministically", () => {
    const input = validShowConfig()
    input.scenario = { windProfile: "GUST", positioningProfile: "LOCAL_WEAK", communicationProfile: "DELAY", eventCodes: ["WEATHER_LIMIT", "POSITIONING_DRIFT"] }
    expect(normalizeConfig(input, "CITY_SHOW").scenario.showInitialConditions).toMatchObject({
      windForceState: "NORMAL",
      gustState: "OCCASIONAL",
      positioningElectromagneticState: "LOCAL_WEAK",
      communicationControlState: "DELAY",
      deviceState: "NORMAL"
    })
  })

  it("accepts a legacy 100-aircraft event code with safe evolution defaults", () => {
    const input = validShowConfig()
    input.scaleTemplateCode = "SHOW_100"
    input.scenario = { eventCodes: ["COMMUNICATION_LOSS"] }
    expect(normalizeConfig(input, "CITY_SHOW").scenario.eventConfigs).toMatchObject([{ code: "COMMUNICATION_LOSS", escalationEnabled: false }])
  })

  it.each([
    {
      name: "missing minimum event count",
      scale: "SHOW_1000",
      configs: [showEvent("WEATHER_LIMIT")],
      message: "须配置 2 到 3 个事件"
    },
    {
      name: "excess maximum event count",
      scale: "SHOW_100",
      configs: [showEvent("WEATHER_LIMIT"), showEvent("COMMUNICATION_LOSS")],
      message: "须配置 1 到 1 个事件"
    },
    {
      name: "random trigger",
      scale: "SHOW_100",
      configs: [showEvent("WEATHER_LIMIT", { triggerMode: "TIME_RANGE", triggerWindowSeconds: [10, 20], escalationEnabled: false })],
      message: "未开放事件 WEATHER_LIMIT 的触发方式"
    },
    {
      name: "group scope",
      scale: "SHOW_100",
      configs: [showEvent("COMMUNICATION_LOSS", { impactScope: "GROUP", escalationEnabled: false })],
      message: "未开放事件 COMMUNICATION_LOSS 的影响范围"
    },
    {
      name: "affected count",
      scale: "SHOW_500",
      configs: [showEvent("COMMUNICATION_LOSS", { impactScope: "SMALL_BATCH", impactCount: 26 })],
      message: "影响数量不能超过 25"
    },
    {
      name: "event link",
      scale: "SHOW_500",
      configs: [showEvent("WEATHER_LIMIT", { followUpEventCode: "COMMUNICATION_LOSS" }), showEvent("COMMUNICATION_LOSS")],
      message: "未开放事件关联"
    },
    {
      name: "partial visibility",
      scale: "SHOW_3000",
      configs: [showEvent("WEATHER_LIMIT", { visibilityMode: "PARTIAL_DELAY" }), showEvent("POSITIONING_DRIFT"), showEvent("COMMUNICATION_LOSS")],
      message: "未开放部分信息延迟"
    }
  ])("rejects show template-policy bypass: $name", ({ scale, configs, message }) => {
    const input = validShowConfig()
    input.scaleTemplateCode = scale
    input.scenario = { eventConfigs: configs }
    expect(() => normalizeConfig(input, "CITY_SHOW")).toThrow(message)
  })

  it("canonicalizes a valid follow-up event into an executable previous-event trigger", () => {
    const input = validShowConfig()
    input.scaleTemplateCode = "SHOW_1000"
    input.scenario = {
      eventConfigs: [
        showEvent("WEATHER_LIMIT", { followUpEventCode: "COMMUNICATION_LOSS" }),
        showEvent("COMMUNICATION_LOSS")
      ]
    }
    expect(normalizeConfig(input, "CITY_SHOW").scenario.eventConfigs).toMatchObject([
      { code: "WEATHER_LIMIT", followUpEventCode: "COMMUNICATION_LOSS" },
      { code: "COMMUNICATION_LOSS", triggerMode: "AFTER_EVENT", triggerAfterEventCode: "WEATHER_LIMIT" }
    ])
  })

  it("allows whole-show impact for a weather event at the 100-aircraft scale", () => {
    const input = validShowConfig()
    input.scaleTemplateCode = "SHOW_100"
    input.scenario = {
      eventConfigs: [showEvent("WEATHER_LIMIT", { impactScope: "WHOLE", impactCount: 100, escalationEnabled: false })]
    }
    expect(normalizeConfig(input, "CITY_SHOW").scenario.eventConfigs).toMatchObject([
      { code: "WEATHER_LIMIT", impactScope: "WHOLE", impactCount: 100 }
    ])
  })

  it("rejects a two-link event chain at the 1000-aircraft scale", () => {
    const input = validShowConfig()
    input.scaleTemplateCode = "SHOW_1000"
    input.scenario = {
      eventConfigs: [
        showEvent("WEATHER_LIMIT", { followUpEventCode: "POSITIONING_DRIFT" }),
        showEvent("POSITIONING_DRIFT", { followUpEventCode: "COMMUNICATION_LOSS" }),
        showEvent("COMMUNICATION_LOSS")
      ]
    }
    expect(() => normalizeConfig(input, "CITY_SHOW")).toThrow("最多支持 1 级事件关联")
  })

  it("rejects the legacy 5000-aircraft scale", () => {
    const input = validShowConfig()
    input.scaleTemplateCode = "SHOW_5000"
    expect(() => normalizeConfig(input, "CITY_SHOW")).toThrow("V1.0 编队表演仅支持 100、500、1000、3000 架模板")
  })

  it("freezes VTL task objects, opened stages, task area and a 100-point rubric", () => {
    const input = validVtlConfig()
    input.vtlParameters = {
      projectBackground: "丘陵巡检教学",
      completionRequirements: "完成对象分配与航线规划",
      plannedStartAt: "2026-08-20T04:00:00.000Z",
      plannedEndAt: "2026-08-20T05:00:00.000Z",
      mainLandingSiteId: "main-1",
      aircraftModelCode: "VTOL-TEACHING-01",
      aircraftParameterVersion: "1.0.0",
      taskObjectIds: ["object-1", "object-2"],
      taskAreaBoundary: [{ longitude: 113, latitude: 22 }, { longitude: 114, latitude: 22 }, { longitude: 114, latitude: 23 }],
      openStageCodes: ["VTL_AREA_OBJECTS", "VTL_TASK_ALLOCATION"],
      evaluationItems: [
        { code: "AREA", label: "任务区", maxScore: 40 },
        { code: "RUNTIME", label: "运行", maxScore: 60 }
      ]
    }

    expect(normalizeConfig(input, "VTOL_INSPECTION").vtlParameters).toMatchObject({
      taskObjectIds: ["object-1", "object-2"],
      openStageCodes: ["VTL_AREA_OBJECTS", "VTL_TASK_ALLOCATION"],
      evaluationItems: [{ code: "AREA", maxScore: 40 }, { code: "RUNTIME", maxScore: 60 }]
    })
  })

  it("rejects non-contiguous VTL opened stages", () => {
    const input = validVtlConfig()
    input.vtlParameters = {
      projectBackground: "巡检教学",
      completionRequirements: "完成运行",
      plannedStartAt: "2026-08-20T04:00:00.000Z",
      plannedEndAt: "2026-08-20T05:00:00.000Z",
      mainLandingSiteId: "main-1",
      aircraftModelCode: "VTOL-TEACHING-01",
      aircraftParameterVersion: "1.0.0",
      openStageCodes: ["VTL_AREA_OBJECTS", "VTL_ROUTE_PLANNING"]
    }
    expect(() => normalizeConfig(input, "VTOL_INSPECTION")).toThrow("必须按教学顺序连续开放")
  })

  it("rejects a VTL rubric whose total is not 100", () => {
    const input = validVtlConfig()
    input.vtlParameters = {
      projectBackground: "巡检教学",
      completionRequirements: "完成巡检",
      plannedStartAt: "2026-08-20T04:00:00.000Z",
      plannedEndAt: "2026-08-20T05:00:00.000Z",
      mainLandingSiteId: "main-1",
      aircraftModelCode: "VTOL-TEACHING-01",
      aircraftParameterVersion: "1.0.0",
      evaluationItems: [{ code: "AREA", label: "任务区", maxScore: 99 }]
    }
    expect(() => normalizeConfig(input, "VTOL_INSPECTION")).toThrow("总分必须为 100")
  })
})

function showEvent(code: string, overrides: Record<string, unknown> = {}) {
  return { code, escalationEnabled: true, ...overrides }
}

function logisticsEvent(code: string, overrides: Record<string, unknown> = {}) {
  return { code, ...overrides }
}

function validConfig(): AssignmentDraftConfig {
  return {
    taskBrief: "Logistics training",
    scaleTemplateCode: "LOGISTICS_3",
    regionPackageId: "region-1",
    availableAt: "2026-08-13T00:00:00.000Z",
    dueAt: "2026-08-14T00:00:00.000Z",
    assessmentDurationMinutes: 120,
    allowResubmission: true,
    allowedValidationAttempts: 3,
    allowedRuntimeAttempts: 2,
    resultVisibility: "FULL_REVIEW",
    scenario: {}
  }
}

function validShowConfig(): AssignmentDraftConfig {
  return {
    taskBrief: "Show training",
    showParameters: {
      projectBackground: "城市活动背景",
      completionRequirements: "完成规划、申报、运行和复盘",
      plannedStartAt: "2026-08-20T04:00:00.000Z",
      plannedEndAt: "2026-08-20T04:30:00.000Z",
      plannedAudienceCount: 1000,
      maximumHeightMeters: 120,
      contactName: "教学联系人",
      contactPhone: "13800000000",
      aircraftModel: "教学编队机"
    },
    scaleTemplateCode: "SHOW_1000",
    regionPackageId: "show-region-1",
    availableAt: "2026-08-13T00:00:00.000Z",
    dueAt: "2026-08-14T00:00:00.000Z",
    assessmentDurationMinutes: 120,
    allowResubmission: true,
    allowedValidationAttempts: 3,
    allowedRuntimeAttempts: 2,
    resultVisibility: "FULL_REVIEW",
    scenario: { eventCodes: ["WEATHER_LIMIT", "COMMUNICATION_LOSS"] }
  }
}

function validVtlConfig(): AssignmentDraftConfig {
  return {
    taskBrief: "VTL training",
    scaleTemplateCode: "VTL_1",
    regionPackageId: "vtl-region-1",
    availableAt: "2026-08-13T00:00:00.000Z",
    dueAt: "2026-08-14T00:00:00.000Z",
    assessmentDurationMinutes: 120,
    allowResubmission: true,
    allowedValidationAttempts: 3,
    allowedRuntimeAttempts: 2,
    resultVisibility: "FULL_REVIEW",
    scenario: {}
  }
}
