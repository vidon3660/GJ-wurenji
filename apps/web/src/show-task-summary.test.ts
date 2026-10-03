import { describe, expect, it } from "vitest"
import type { AssignmentDraftConfig } from "@wurenji/shared"
import { showTaskInitialConditionsSummary } from "./show-task-summary"

describe("show task initial conditions summary", () => {
  it("presents all frozen teacher-defined show conditions", () => {
    expect(showTaskInitialConditionsSummary(config())).toEqual({
      weather: "西北风 · 风力接近限制 · 阵风偶发 · 降雨低于限制",
      positioningElectromagnetic: "局部异常",
      communicationControl: "分组异常",
      device: "电池异常 · 分组 · 100 架"
    })
  })

  it("maps legacy show snapshots deterministically", () => {
    const value = config()
    value.scaleTemplateCode = "SHOW_100"
    value.scenario = { windProfile: "GUST", visibilityLevel: "LIMITED", communicationProfile: "DELAY" }
    expect(showTaskInitialConditionsSummary(value)).toEqual({
      weather: "东南风 · 风力正常 · 阵风偶发 · 降雨低于限制",
      positioningElectromagnetic: "正常",
      communicationControl: "延迟",
      device: "正常"
    })
  })
})

function config(): AssignmentDraftConfig {
  return {
    taskBrief: "完成编队表演教学项目",
    scaleTemplateCode: "SHOW_1000",
    regionPackageId: "show-region",
    availableAt: "2026-08-20T00:00:00.000Z",
    dueAt: "2026-08-21T00:00:00.000Z",
    assessmentDurationMinutes: 120,
    allowResubmission: true,
    allowedValidationAttempts: 3,
    allowedRuntimeAttempts: 3,
    resultVisibility: "FULL_REVIEW",
    scenario: {
      showInitialConditions: {
        windDirection: "NW",
        windForceState: "NEAR_LIMIT",
        gustState: "OCCASIONAL",
        rainState: "BELOW_LIMIT",
        positioningElectromagneticState: "LOCAL_ABNORMAL",
        communicationControlState: "GROUP_ABNORMAL",
        deviceState: "BATTERY_ABNORMAL",
        deviceImpactScope: "GROUP"
      }
    }
  }
}
