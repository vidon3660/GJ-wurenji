import { describe, expect, it } from "vitest"
import { logisticsStudentSummaryText, normalizeLogisticsStudentSummary, parseLogisticsStudentSummary } from "./logistics-review-summary.js"

const structured = {
  originalPlanProblems: "原方案对晚释放订单预留不足。",
  responseLessons: "及时识别异常，但批量调整时机偏晚。",
  routeAdjustmentSuggestions: "为北部配送点增加已验证备用航线。",
  schedulingOptimization: "按优先级和返场时间滚动重排未执行订单。",
  improvements: "提前设置触发阈值并复核调整后的冲突证据。"
}

describe("logistics student review summary", () => {
  it("stores and parses the five structured fields", () => {
    const normalized = normalizeLogisticsStudentSummary("", structured, true)
    expect(normalized.structured).toEqual(structured)
    expect(parseLogisticsStudentSummary(normalized.stored)).toEqual(structured)
    expect(logisticsStudentSummaryText(normalized.stored)).toContain("调度优化：按优先级和返场时间滚动重排未执行订单。")
  })

  it("keeps historical free text readable", () => {
    const legacy = "历史物流复盘自由文本"
    expect(parseLogisticsStudentSummary(legacy)).toBeNull()
    expect(logisticsStudentSummaryText(legacy)).toBe(legacy)
    expect(normalizeLogisticsStudentSummary(legacy, undefined, false).stored).toBe(legacy)
  })

  it("requires every structured field when submitting", () => {
    expect(() => normalizeLogisticsStudentSummary("", { ...structured, schedulingOptimization: "" }, true)).toThrow("调度优化不能少于 2 个字符")
  })
})
