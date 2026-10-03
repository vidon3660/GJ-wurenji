import { describe, expect, it } from "vitest"
import type { ShowPreflightItemView } from "@wurenji/shared"
import { showTakeoffDecisionGate } from "./show-takeoff-decision"

describe("show takeoff decision gate", () => {
  const normalItem: ShowPreflightItemView = {
    code: "BATTERY",
    category: "AIRCRAFT",
    title: "电池",
    detail: "确认电池状态",
    sourceStatus: "NORMAL",
    affectedCount: 100,
    confirmed: true,
    resolution: "CONFIRMED",
    resolved: true,
    note: ""
  }

  it("requires a rationale for allow takeoff", () => {
    expect(showTakeoffDecisionGate([normalItem], "ALLOW", "").canComplete).toBe(false)
    expect(showTakeoffDecisionGate([normalItem], "ALLOW", "全部检查项正常").canComplete).toBe(true)
  })

  it("only enables decision completion after all checks and blocking issues are resolved", () => {
    expect(showTakeoffDecisionGate([{ ...normalItem, confirmed: false }], "DELAY", "等待复查").canComplete).toBe(false)
    const issue = { ...normalItem, sourceStatus: "ABNORMAL", resolution: "PAUSED", resolved: false } as const
    expect(showTakeoffDecisionGate([issue], "ALLOW_AFTER_RECTIFICATION", "整改后执行")).toMatchObject({ unresolvedIssueCount: 1, canComplete: false })
    expect(showTakeoffDecisionGate([issue], "DELAY", "等待异常解除").canComplete).toBe(true)
  })
})
