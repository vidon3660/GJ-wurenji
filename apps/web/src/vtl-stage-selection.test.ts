import { describe, expect, it } from "vitest"
import { normalizeVtlStageSelection } from "./vtl-stage-selection"

const stages = ["AREA", "ALLOCATION", "ROUTE", "VALIDATION", "RUNTIME"] as const

describe("VTL stage selection", () => {
  it("closes every stage after the first unchecked stage", () => {
    expect(normalizeVtlStageSelection(["AREA", "ALLOCATION", "VALIDATION", "RUNTIME"], stages)).toEqual([
      "AREA",
      "ALLOCATION"
    ])
  })

  it("keeps a continuous prefix when opening the next stage", () => {
    expect(normalizeVtlStageSelection(["AREA", "ALLOCATION", "ROUTE"], stages)).toEqual([
      "AREA",
      "ALLOCATION",
      "ROUTE"
    ])
  })

  it("keeps the complete stage sequence", () => {
    expect(normalizeVtlStageSelection(stages, stages)).toEqual(stages)
  })
})
