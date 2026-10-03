import { describe, expect, it } from "vitest"
import { defaultEvaluationForScene } from "./default-evaluation.js"

describe("default evaluation by scene", () => {
  it("keeps logistics dimensions focused on delivery and scheduling", () => {
    expect(defaultEvaluationForScene("CITY_LOGISTICS").map((item) => item.name)).toEqual(["飞行安全", "完成与准时", "调度效率", "应急处置"])
  })

  it("uses inspection-specific dimensions for vtol", () => {
    const evaluation = defaultEvaluationForScene("VTOL_INSPECTION")
    expect(evaluation.map((item) => item.name)).toEqual(["飞行安全", "任务覆盖", "能量与航段", "应急处置"])
    expect(evaluation[0]?.metrics).toContain("地形净距")
  })

  it("keeps show dimensions separate from the other scenes", () => {
    expect(defaultEvaluationForScene("CITY_SHOW").map((item) => item.name)).toEqual(["飞行安全", "轨迹与时序", "运行组织", "应急处置"])
  })
})
