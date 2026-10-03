import { describe, expect, it } from "vitest"
import { vtlActionBusinessConsequences, vtlActionEvidence, vtlEventBriefing } from "./vtl-runtime-briefing"

describe("vtl runtime teaching briefing", () => {
  it("turns an energy event into a differentiated NPC briefing", () => {
    const briefing = vtlEventBriefing({
      category: "ENERGY_POWER",
      detail: "VTL-001 剩余能源不足以继续执行当前巡检任务。",
      affectedAircraftIds: ["aircraft-1"]
    } as never, "执行备降")

    expect(briefing.role).toBe("航空器健康监控系统")
    expect(briefing.impact).toContain("1 架航空器")
    expect(briefing.objective).toContain("剩余能源余度")
    expect(briefing.objective).toContain("未完成巡检任务")
    expect(briefing.successCriteria).toContain("执行备降")
    expect(briefing.scoringEvidence).toContain("能源余度")
  })

  it("presents authoritative business consequences and scoring evidence", () => {
    const action = {
      result: {
        businessConsequences: ["VTL-001：运行状态由“执行中”变为“备降”", ""],
        responseTimeMs: 6_400,
        withinDeadline: true,
        eventControlled: true
      }
    } as never

    expect(vtlActionBusinessConsequences(action)).toEqual(["VTL-001：运行状态由“执行中”变为“备降”"])
    expect(vtlActionEvidence(action)).toEqual(["响应时效 6.4 秒", "时限判定：达标", "事件控制：成功"])
  })

  it("does not claim deadline compliance when no deadline result exists", () => {
    expect(vtlActionEvidence({ result: { responseTimeMs: null, withinDeadline: null, eventControlled: true } } as never))
      .toEqual(["事件控制：成功"])
  })
})
