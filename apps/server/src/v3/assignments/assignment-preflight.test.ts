import { describe, expect, it } from "vitest"
import type { AssignmentPreflightCheckView } from "@wurenji/shared"
import { assignmentPreflightLocation, summarizeAssignmentPreflight } from "./assignment.service.js"

describe("assignment preflight summary", () => {
  it("counts blocking, warning and passed checks independently", () => {
    const checks: AssignmentPreflightCheckView[] = [
      check("CONFIGURATION", "BLOCKING"),
      check("MAP_RESOURCE", "WARNING"),
      check("PUBLISH_SCOPE", "PASSED"),
      check("RESOURCE_COVERAGE", "PASSED")
    ]

    expect(summarizeAssignmentPreflight(checks)).toEqual({ blocking: 1, warning: 1, passed: 2 })
  })

  it("returns a zeroed summary for an empty result", () => {
    expect(summarizeAssignmentPreflight([])).toEqual({ blocking: 0, warning: 0, passed: 0 })
  })

  it("locates logistics candidate point failures in the resource step", () => {
    expect(assignmentPreflightLocation("SCENARIO_RULES", "CITY_LOGISTICS", "当前模板候选配送点须在 4 到 8 个之间", 2)).toEqual({
      step: 1,
      focusTarget: "logistics-candidate-points"
    })
  })

  it("locates VTL validation failures at the matching editable control", () => {
    expect(assignmentPreflightLocation("SCENARIO_RULES", "VTOL_INSPECTION", "任务对象 VTL-01 未完全位于本次巡检任务区域内", 2)).toEqual({
      step: 2,
      focusTarget: "vtl-task-objects"
    })
    expect(assignmentPreflightLocation("SCENARIO_RULES", "VTOL_INSPECTION", "巡检评价项目总分必须为 100", 2)).toEqual({
      step: 2,
      focusTarget: "vtl-evaluation-items"
    })
  })

  it("keeps fixed checks aligned with their real wizard step", () => {
    expect(assignmentPreflightLocation("QUESTION_BANK", "CITY_SHOW", "版本不可用", 0)).toEqual({ step: 1, focusTarget: "question-bank" })
    expect(assignmentPreflightLocation("PUBLISH_SCOPE", "CITY_SHOW", "发布目标中没有学生", 3)).toEqual({ step: 3, focusTarget: "publish-classroom" })
  })

  it("locates expired publishing windows in the publishing schedule", () => {
    expect(assignmentPreflightLocation("CONFIGURATION", "CITY_SHOW", "开放时间必须晚于当前时间", 0)).toEqual({
      step: 3,
      focusTarget: "publish-schedule"
    })
  })

  it("maps every fixed preflight check to an actionable control", () => {
    const expectedTargets = {
      CONFIGURATION: [0, "task-title"],
      QUESTION_BANK: [1, "question-bank"],
      RESOURCE_AVAILABILITY: [1, "resource-dependencies"],
      RESOURCE_COVERAGE: [1, "resource-dependencies"],
      SCALE_TEMPLATE: [1, "scale-template"],
      EVALUATION_RUBRIC: [1, "resource-dependencies"],
      SHOW_PROGRAM: [1, "show-program"],
      REGION_SCOPE: [1, "region"],
      MAP_RESOURCE: [1, "map-resource"],
      PUBLISH_SCOPE: [3, "publish-classroom"]
    } as const

    for (const [code, [step, focusTarget]] of Object.entries(expectedTargets)) {
      expect(assignmentPreflightLocation(code, "CITY_SHOW", "检查失败", 2)).toEqual({ step, focusTarget })
    }
  })

  it("keeps scenario-specific failures actionable across all supported scenes", () => {
    expect(assignmentPreflightLocation("SCENARIO_RULES", "CITY_LOGISTICS", "计划运行开始时间无效", 2).focusTarget).toBe("logistics-runtime-schedule")
    expect(assignmentPreflightLocation("SCENARIO_RULES", "CITY_LOGISTICS", "订单数量与机队航空器不匹配", 2).focusTarget).toBe("logistics-order-config")
    expect(assignmentPreflightLocation("SCENARIO_RULES", "VTOL_INSPECTION", "主起降点未配置", 2).focusTarget).toBe("vtl-main-landing-site")
    expect(assignmentPreflightLocation("SCENARIO_RULES", "VTOL_INSPECTION", "开放步骤不能为空", 2).focusTarget).toBe("vtl-open-stages")
    expect(assignmentPreflightLocation("SCENARIO_RULES", "CITY_SHOW", "计划表演开始时间无效", 2).focusTarget).toBe("show-schedule")
  })
})

function check(category: AssignmentPreflightCheckView["category"], level: AssignmentPreflightCheckView["level"]): AssignmentPreflightCheckView {
  return {
    code: `${category}-${level}`,
    category,
    level,
    title: "检查项",
    message: "检查结果",
    action: "无需处理",
    step: 0
  }
}
