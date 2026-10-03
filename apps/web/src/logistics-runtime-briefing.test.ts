import { describe, expect, it } from "vitest"
import { logisticsActionBusinessConsequences, logisticsActionEvidence, logisticsEventBriefing } from "./logistics-runtime-briefing"

describe("logistics runtime teaching briefing", () => {
  it("turns an authoritative event into a business-role briefing", () => {
    const briefing = logisticsEventBriefing({
      code: "NODE_UNAVAILABLE",
      category: "ROUTE_OPERATION",
      detail: "配送点暂时无法接收订单。"
    } as never, "重新分配订单")
    expect(briefing.role).toBe("仓站 / 配送点")
    expect(briefing.objective).toContain("配送连续性")
    expect(briefing.successCriteria).toContain("重新分配订单")
    expect(briefing.scoringEvidence).toEqual(["响应时效", "动作匹配", "事件控制", "处置说明"])
  })

  it("presents business consequences and scoring evidence from action results", () => {
    const action = {
      result: {
        businessConsequences: ["ORD-01：订单由配送中变为已延误", ""],
        responseTimeMs: 8_500,
        withinDeadline: true,
        eventControlled: true
      }
    } as never
    expect(logisticsActionBusinessConsequences(action)).toEqual(["ORD-01：订单由配送中变为已延误"])
    expect(logisticsActionEvidence(action)).toEqual(["响应时效 8.5 秒", "时限判定：达标", "事件控制：成功"])
  })
})
