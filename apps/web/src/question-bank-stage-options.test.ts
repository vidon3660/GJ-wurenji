import { describe, expect, it } from "vitest"
import { questionBankStageOptions } from "./question-bank-stage-options"

describe("question bank stage options", () => {
  it("shows only the selected scene stages", () => {
    const options = questionBankStageOptions("CITY_LOGISTICS")
    expect(options[0]).toEqual({ value: "", label: "通用 / 不指定阶段" })
    expect(options.some((item) => item.value === "LOGISTICS_ROUTE_PLANNING" && item.label === "航线规划")).toBe(true)
    expect(options.some((item) => item.value === "SHOW_RUNTIME")).toBe(false)
  })

  it("combines all scene stages for a generic bank without duplicates", () => {
    const options = questionBankStageOptions(null)
    expect(options.filter((item) => item.value === "SHOW_REVIEW")).toHaveLength(1)
    expect(options.find((item) => item.value === "VTL_RUNTIME")?.label).toBe("垂起广域巡检 · 巡检运行")
  })

  it("keeps an unknown historical code selectable", () => {
    const options = questionBankStageOptions("CITY_SHOW", "LEGACY_STAGE_2024")
    expect(options.at(-1)).toEqual({ value: "LEGACY_STAGE_2024", label: "历史阶段（LEGACY_STAGE_2024）" })
  })
})
