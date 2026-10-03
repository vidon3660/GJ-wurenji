import { describe, expect, it } from "vitest"
import type { StudentProjectStageView } from "@wurenji/shared"
import { canResumeReturnedVtlRoute, shouldShowVtlPlanningWorkspace } from "./vtl-stage-presentation"

function stage(overrides: Partial<StudentProjectStageView> = {}): StudentProjectStageView {
  return {
    stageCode: "VTL_ROUTE_PLANNING",
    sequence: 3,
    title: "八阶段航线规划",
    description: "规划航线",
    status: "IN_PROGRESS",
    revision: 1,
    openCondition: "完成任务分配",
    allowedActions: [],
    ...overrides
  }
}

describe("VTL stage presentation", () => {
  it("keeps a returned route-planning stage in the specialized workspace", () => {
    const returnedStage = stage({ status: "RETURNED", allowedActions: ["RESUME"] })

    expect(shouldShowVtlPlanningWorkspace(returnedStage)).toBe(true)
    expect(canResumeReturnedVtlRoute(returnedStage, true)).toBe(true)
  })

  it("does not offer the route-resume command in unrelated states", () => {
    expect(canResumeReturnedVtlRoute(stage({ allowedActions: ["RESUME"] }), true)).toBe(false)
    expect(canResumeReturnedVtlRoute(stage({ status: "RETURNED", allowedActions: ["RESUME"] }), false)).toBe(false)
    expect(canResumeReturnedVtlRoute(stage({ stageCode: "VTL_TASK_ALLOCATION", status: "RETURNED", allowedActions: ["RESUME"] }), true)).toBe(false)
  })

  it("keeps other returned planning stages out of an inactive workspace", () => {
    expect(shouldShowVtlPlanningWorkspace(stage({ stageCode: "VTL_TASK_ALLOCATION", status: "RETURNED" }))).toBe(false)
    expect(shouldShowVtlPlanningWorkspace(stage({ status: "LOCKED" }))).toBe(false)
    expect(shouldShowVtlPlanningWorkspace(stage({ status: "AVAILABLE" }))).toBe(false)
  })
})
