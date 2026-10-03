import { describe, expect, it } from "vitest"
import {
  createMapLabelAppearance,
  createMapLabelBudget,
  mapDetailLevelForCameraHeight,
  mapLabelRules,
  shouldRenderBuildingDetail,
  truncateMapLabel
} from "./map-label-policy"

describe("MAP-A04/B04 label policy and zoom tiers", () => {
  it("classifies camera height into far/medium/near detail levels", () => {
    expect(mapDetailLevelForCameraHeight(40_000)).toBe("far")
    expect(mapDetailLevelForCameraHeight(15_000)).toBe("medium")
    expect(mapDetailLevelForCameraHeight(1_000)).toBe("near")
  })

  it("only suppresses fine-grained buildings at the far level", () => {
    expect(shouldRenderBuildingDetail("far")).toBe(false)
    expect(shouldRenderBuildingDetail("medium")).toBe(true)
    expect(shouldRenderBuildingDetail("near")).toBe(true)
  })

  it("caps labels per priority within one render batch", () => {
    const budget = createMapLabelBudget()
    const limit = mapLabelRules.REGION.maximumLabelsPerRender
    for (let index = 0; index < limit; index += 1) expect(budget("REGION")).toBe(true)
    expect(budget("REGION")).toBe(false)
    // Independent budgets per priority keep critical teaching objects on screen.
    expect(budget("TASK_POINT")).toBe(true)
  })

  it("keeps map labels complete by default and only truncates in explicit compact mode", () => {
    const long = "教学区域名称非常长的一个标注示例文字"
    const cut = truncateMapLabel(long, "REGION")
    expect(cut.length).toBeLessThanOrEqual(mapLabelRules.REGION.maximumCharacters)
    expect(cut.endsWith("…")).toBe(true)
    expect(createMapLabelAppearance({ text: long, color: "#000000", priority: "REGION", truncate: false }).text).toBe(long)
    expect(createMapLabelAppearance({ text: long, color: "#000000", priority: "REGION" }).text).toBe(long)
    expect(createMapLabelAppearance({ text: long, color: "#000000", priority: "REGION" }).showBackground).toBe(false)
    expect(createMapLabelAppearance({ text: long, color: "#000000", priority: "REGION", showBackground: true }).showBackground).toBe(true)
    expect(createMapLabelAppearance({ text: long, color: "#000000", priority: "REGION", truncate: true }).text).toBe(cut)
  })
})
