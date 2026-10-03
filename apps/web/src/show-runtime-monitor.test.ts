import { describe, expect, it } from "vitest"
import type { ShowRuntimeTotalsView } from "@wurenji/shared"
import { showRuntimeMonitorMetrics } from "./show-runtime-monitor"

describe("show runtime monitor metrics", () => {
  it("projects every STU-021 count as an independent metric", () => {
    const totals: ShowRuntimeTotalsView = {
      plannedCount: 5000,
      takeoffCount: 4800,
      airborneCount: 4200,
      landedCount: 600,
      normalCount: 4700,
      warningCount: 70,
      abnormalCount: 20,
      lostCount: 10
    }

    expect(showRuntimeMonitorMetrics(totals).map(({ code, label, value }) => ({ code, label, value }))).toEqual([
      { code: "TOTAL", label: "总架数", value: 5000 },
      { code: "TAKEOFF", label: "已起飞", value: 4800 },
      { code: "AIRBORNE", label: "空中", value: 4200 },
      { code: "LANDED", label: "已降落", value: 600 },
      { code: "NORMAL", label: "正常", value: 4700 },
      { code: "WARNING", label: "告警", value: 70 },
      { code: "ABNORMAL", label: "异常", value: 20 },
      { code: "LOST", label: "失联", value: 10 }
    ])
  })

  it("returns a stable zero state before the workspace loads", () => {
    expect(showRuntimeMonitorMetrics(null)).toHaveLength(8)
    expect(showRuntimeMonitorMetrics(undefined).every((item) => item.value === 0)).toBe(true)
  })
})
