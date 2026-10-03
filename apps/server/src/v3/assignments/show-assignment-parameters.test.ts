import { describe, expect, it } from "vitest"
import { normalizeShowAssignmentParameters, resolveShowAssignmentParameters } from "./show-assignment-parameters.js"

describe("show assignment parameters", () => {
  it("normalizes complete teacher-defined show conditions", () => {
    const value = normalizeShowAssignmentParameters({
      projectBackground: " 城市节庆活动教学项目 ",
      completionRequirements: "完成区域规划、申报、运行和复盘",
      plannedStartAt: "2026-08-20T12:00:00+08:00",
      plannedEndAt: "2026-08-20T12:30:00+08:00",
      plannedAudienceCount: 3200,
      maximumHeightMeters: 118,
      contactName: "教学联系人",
      contactPhone: "13800000000",
      aircraftModel: "教学编队机"
    })

    expect(value).toMatchObject({
      projectBackground: "城市节庆活动教学项目",
      plannedStartAt: "2026-08-20T04:00:00.000Z",
      plannedAudienceCount: 3200,
      maximumHeightMeters: 118
    })
  })

  it("rejects incomplete or unsafe task constraints", () => {
    expect(() => normalizeShowAssignmentParameters({})).toThrow("项目背景不能为空")
    expect(() => normalizeShowAssignmentParameters({
      projectBackground: "背景",
      completionRequirements: "要求",
      plannedStartAt: "2026-08-20T12:30:00+08:00",
      plannedEndAt: "2026-08-20T12:00:00+08:00",
      plannedAudienceCount: 0,
      maximumHeightMeters: 501,
      contactName: "联系人",
      contactPhone: "13800000000",
      aircraftModel: "机型"
    })).toThrow("结束时间")
  })

  it("resolves legacy snapshot fields deterministically", () => {
    const resolved = resolveShowAssignmentParameters({
      taskBrief: "旧任务说明",
      scaleTemplateCode: "SHOW_100",
      regionPackageId: "region",
      availableAt: "2026-08-20T04:00:00.000Z",
      dueAt: "2026-08-21T04:00:00.000Z",
      allowResubmission: true,
      allowedValidationAttempts: 3,
      allowedRuntimeAttempts: 2,
      resultVisibility: "FULL_REVIEW",
      scenario: { contactName: "旧联系人", maximumHeightMeters: 90 }
    })

    expect(resolved).toMatchObject({
      projectBackground: "旧任务说明",
      completionRequirements: "旧任务说明",
      plannedAudienceCount: 1,
      maximumHeightMeters: 90,
      contactName: "旧联系人"
    })
  })
})
