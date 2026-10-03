import { describe, expect, it } from "vitest"
import { normalizeLogisticsAssignmentParameters, resolveLogisticsAssignmentParameters } from "./logistics-assignment-parameters.js"

describe("logistics assignment parameters", () => {
  it("normalizes complete teacher-defined logistics conditions", () => {
    expect(normalizeLogisticsAssignmentParameters({
      projectBackground: " 城市即时配送教学项目 ",
      completionRequirements: "完成航线、调度、运行和复盘",
      plannedStartAt: "2026-08-20T09:00:00+08:00",
      plannedEndAt: "2026-08-20T17:00:00+08:00"
    }, fallback())).toEqual({
      projectBackground: "城市即时配送教学项目",
      completionRequirements: "完成航线、调度、运行和复盘",
      plannedStartAt: "2026-08-20T01:00:00.000Z",
      plannedEndAt: "2026-08-20T09:00:00.000Z"
    })
  })

  it("rejects incomplete or reversed planned runtime", () => {
    expect(() => normalizeLogisticsAssignmentParameters({
      projectBackground: "背景",
      completionRequirements: "要求",
      plannedStartAt: "2026-08-20T17:00:00+08:00",
      plannedEndAt: "2026-08-20T09:00:00+08:00"
    }, fallback())).toThrow("结束时间")
  })

  it("resolves legacy task snapshots deterministically", () => {
    expect(resolveLogisticsAssignmentParameters({
      taskBrief: "旧物流任务说明",
      scaleTemplateCode: "LOGISTICS_3",
      regionPackageId: "region",
      availableAt: fallback().availableAt,
      dueAt: fallback().dueAt,
      allowResubmission: true,
      allowedValidationAttempts: 3,
      allowedRuntimeAttempts: 2,
      resultVisibility: "FULL_REVIEW",
      scenario: {}
    })).toMatchObject({ projectBackground: "旧物流任务说明", completionRequirements: "旧物流任务说明" })
  })
})

function fallback() {
  return {
    taskBrief: "物流任务说明",
    availableAt: "2026-08-20T00:00:00.000Z",
    dueAt: "2026-08-21T00:00:00.000Z"
  }
}
