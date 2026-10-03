import { describe, expect, it } from "vitest"
import type { ShowRuntimeGroupView, ShowRuntimeTotalsView } from "@wurenji/shared"
import { showActionBusinessOutcome, showActionWithinDeadline, type ShowActionProjection } from "./show-action-outcome.js"

function group(airborneCount: number, landedCount: number): ShowRuntimeGroupView {
  return {
    groupId: "G01",
    label: "编队 1",
    plannedCount: 100,
    airborneCount,
    landedCount,
    normalCount: 96,
    warningCount: 4,
    abnormalCount: 0,
    lostCount: 0,
    status: "WARNING",
    center: { longitude: 114, latitude: 22, altitudeMeters: 100 },
    radiusMeters: 35
  }
}

function projection(airborneCount: number, landedCount: number): ShowActionProjection {
  const totals: ShowRuntimeTotalsView = {
    plannedCount: 100,
    takeoffCount: 100,
    airborneCount,
    landedCount,
    normalCount: 96,
    warningCount: 4,
    abnormalCount: 0,
    lostCount: 0
  }
  return { phase: "PERFORMANCE", phaseTitle: "表演运行", totals, groups: [group(airborneCount, landedCount)] }
}

describe("show action business outcome", () => {
  it("describes a single-aircraft exit without claiming unproven geometry safety", () => {
    const result = showActionBusinessOutcome({
      actionCode: "SINGLE_LAND",
      targetId: "G01-A001",
      before: projection(100, 0),
      after: projection(99, 1)
    })

    expect(result.businessConsequences).toEqual([
      "G01-A001：已退出当前表演任务并计入提前降落",
      "编队 1：空中数量由 100 架变为 99 架",
      "编队 1：已降落数量由 0 架变为 1 架",
      "编队 1：本次处置形成 1 架编队缺口，图案完整性需按当前空中 99/100 架复核",
      "表演机群：空中数量由 100 架变为 99 架",
      "表演机群：已降落数量由 0 架变为 1 架",
      "节目仍处于“表演运行”阶段，现有节目时序未由本次处置自动重排",
      "邻机安全间距尚无单机轨迹判定证据，需要结合后续轨迹继续复核"
    ])
    expect(result.outcome).toContain("编队缺口")
  })

  it("does not claim deadline compliance without a deadline", () => {
    expect(showActionWithinDeadline(null, 12_000)).toBeNull()
    expect(showActionWithinDeadline(15_000, 12_000)).toBe(true)
    expect(showActionWithinDeadline(10_000, 12_000)).toBe(false)
  })
})
