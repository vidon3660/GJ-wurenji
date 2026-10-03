import { describe, expect, it } from "vitest"
import { runtimeActionReasoning, runtimeActionResultLabel } from "./runtime-action-reasoning"

describe("runtime action reasoning view helpers", () => {
  it("reads new reasoning and ignores legacy payloads", () => {
    expect(runtimeActionReasoning({ reasoning: { observation: "发现异常", rationale: "判断依据", expectedOutcome: "风险受控" } })).toEqual({ observation: "发现异常", rationale: "判断依据", expectedOutcome: "风险受控" })
    expect(runtimeActionReasoning({ rationale: "旧版依据" })).toBeNull()
  })

  it("summarizes authoritative action results", () => {
    expect(runtimeActionResultLabel({ applied: true, eventControlled: true, withinDeadline: true, responseTimeMs: 8_500 })).toBe("已执行 · 事件已控制 · 时限内完成 · 响应 8.5 秒")
    expect(runtimeActionResultLabel({ applied: true, outcome: "已切换至备用方案 A-02", eventControlled: true })).toBe("已执行 · 已切换至备用方案 A-02 · 事件已控制")
  })
})
