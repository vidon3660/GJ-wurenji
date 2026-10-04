import { describe, expect, it } from "vitest"
import { showActionBusinessConsequences, showActionEvidence, showEventBriefing } from "./show-runtime-briefing"

describe("show runtime teaching briefing", () => {
  it("turns a battery event into a differentiated show NPC briefing", () => {
    const briefing = showEventBriefing({
      code: "BATTERY_ANOMALY",
      category: "AIRCRAFT_DEVICE",
      detail: "部分无人机电池压差扩大。",
      affectedCount: 4,
      affectedGroupIds: ["G01"]
    } as never, "单架降落")

    expect(briefing.role).toBe("机队设备监控系统")
    expect(briefing.impact).toContain("4 架无人机")
    expect(briefing.objective).toContain("编队缺口")
    expect(briefing.successCriteria).toContain("单架降落")
    expect(briefing.scoringEvidence).toContain("邻机安全间隔检查")
  })

  it("presents authoritative consequences and scoring evidence", () => {
    const action = {
      result: {
        businessConsequences: ["G01-A001：已退出当前表演任务", ""],
        responseTimeMs: 7_200,
        withinDeadline: true,
        eventControlled: true
      }
    } as never

    expect(showActionBusinessConsequences(action)).toEqual(["G01-A001：已退出当前表演任务"])
    expect(showActionEvidence(action)).toEqual(["响应时效 7.2 秒", "时限判定：达标", "事件控制：成功"])
  })

  it("does not claim deadline compliance when no deadline result exists", () => {
    expect(showActionEvidence({ result: { responseTimeMs: null, withinDeadline: null, eventControlled: true } } as never))
      .toEqual(["事件控制：成功"])
  })
})
