import { describe, expect, it } from "vitest"
import { logisticsReadinessGatePresentation } from "./logistics-readiness-presentation"

describe("logistics readiness gate presentation", () => {
  it("keeps a confirmed readiness record visibly passed after editing locks", () => {
    expect(logisticsReadinessGatePresentation("CONFIRMED", false, 0)).toEqual({
      passed: true,
      title: "运行准备已确认",
      detail: "检查结论已锁定，配送运行阶段已开放"
    })
  })

  it("shows a draft as confirmable only after the authoritative gate opens", () => {
    expect(logisticsReadinessGatePresentation("DRAFT", true, 0)).toEqual({
      passed: true,
      title: "满足运行门禁",
      detail: "可确认并开放配送运行阶段"
    })
  })

  it("prioritizes blocking check counts for a draft that cannot proceed", () => {
    expect(logisticsReadinessGatePresentation("DRAFT", false, 2)).toEqual({
      passed: false,
      title: "尚不能进入运行",
      detail: "仍有 2 项阻断条件"
    })
  })
})
