// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { assignmentPreflightTarget, assignmentPreflightTargetSelector, firstPreflightFocusable, shouldInvalidateAssignmentPreview } from "./assignment-preflight-focus"

describe("assignment preflight focus", () => {
  it("prefers the server-provided business target", () => {
    const check = { code: "SCENARIO_RULES", focusTarget: "logistics-candidate-points" as const }
    expect(assignmentPreflightTarget(check)).toBe("logistics-candidate-points")
    expect(assignmentPreflightTargetSelector(check)).toBe('[data-preflight-target="logistics-candidate-points"]')
  })

  it("supports checks returned by an older server", () => {
    expect(assignmentPreflightTarget({ code: "QUESTION_BANK" })).toBe("question-bank")
    expect(assignmentPreflightTarget({ code: "UNKNOWN" })).toBeNull()
  })

  it("focuses the first enabled control inside a target", () => {
    const target = document.createElement("section")
    target.innerHTML = '<button disabled>不可用</button><input aria-label="目标输入" /><button>后续按钮</button>'
    expect(firstPreflightFocusable(target).getAttribute("aria-label")).toBe("目标输入")
  })

  it("falls back to the target container when no control exists", () => {
    const target = document.createElement("section")
    expect(firstPreflightFocusable(target)).toBe(target)
  })
})

describe("assignment publish recovery", () => {
  it("invalidates a preview when the server reports a stale publish version", () => {
    expect(shouldInvalidateAssignmentPreview(409, "发布配置已变化，请重新预览")).toBe(true)
    expect(shouldInvalidateAssignmentPreview(409, "任务草稿版本冲突，当前版本为 4")).toBe(true)
  })

  it("keeps transient failures from discarding the current preview", () => {
    expect(shouldInvalidateAssignmentPreview(503, "服务暂时不可用")).toBe(false)
    expect(shouldInvalidateAssignmentPreview(409, "发布目标中没有学生")).toBe(false)
  })
})
