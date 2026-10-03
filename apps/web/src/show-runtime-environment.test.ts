import { describe, expect, it } from "vitest"
import type { ShowRuntimeEnvironmentView } from "@wurenji/shared"
import { showRuntimeEnvironmentMetrics, showRuntimeEnvironmentSummary, showRuntimeSupportMetrics } from "./show-runtime-environment"

describe("show runtime environment monitor", () => {
  it("projects all seven STU-022 environment indicators with localized states", () => {
    const environment: ShowRuntimeEnvironmentView = {
      windDirection: "SW",
      windState: "NEAR_LIMIT",
      gustState: "OCCASIONAL",
      rainState: "OVER_LIMIT",
      positioningQuality: "DEGRADED",
      electromagneticState: "INTERFERENCE",
      communicationQuality: "LOST",
      equipmentState: "WARNING",
      geofenceState: "NORMAL"
    }

    expect(showRuntimeEnvironmentMetrics(environment)).toEqual([
      { code: "WIND_DIRECTION", label: "风向", value: "西南风", tone: "neutral" },
      { code: "WIND_FORCE", label: "风力", value: "接近限制", tone: "warning" },
      { code: "GUST", label: "阵风", value: "间歇阵风", tone: "warning" },
      { code: "RAIN", label: "降雨", value: "超限", tone: "danger" },
      { code: "POSITIONING", label: "定位质量", value: "下降", tone: "warning" },
      { code: "ELECTROMAGNETIC", label: "电磁状态", value: "受干扰", tone: "danger" },
      { code: "COMMUNICATION", label: "通信质量", value: "丢失", tone: "danger" }
    ])
  })

  it("keeps equipment and geofence as separate supporting states", () => {
    const environment: ShowRuntimeEnvironmentView = {
      windDirection: "N",
      windState: "NORMAL",
      gustState: "NONE",
      rainState: "NONE",
      positioningQuality: "GOOD",
      electromagneticState: "NORMAL",
      communicationQuality: "GOOD",
      equipmentState: "FAULT",
      geofenceState: "WARNING"
    }

    expect(showRuntimeSupportMetrics(environment)).toEqual([
      { code: "EQUIPMENT", label: "设备", value: "故障", tone: "danger" },
      { code: "GEOFENCE", label: "电子围栏", value: "告警", tone: "warning" }
    ])
  })

  it("returns a stable loading projection before the runtime workspace arrives", () => {
    expect(showRuntimeEnvironmentMetrics(null)).toHaveLength(7)
    expect(showRuntimeEnvironmentMetrics(undefined).every((item) => item.value === "--")).toBe(true)
  })

  it("uses localized values in the takeoff snapshot summary", () => {
    expect(showRuntimeEnvironmentSummary({
      windDirection: "SW",
      windState: "NEAR_LIMIT",
      gustState: "NONE",
      rainState: "NONE",
      positioningQuality: "GOOD",
      electromagneticState: "NORMAL",
      communicationQuality: "LOST",
      equipmentState: "NORMAL",
      geofenceState: "NORMAL"
    })).toBe("风向 西南风 · 风力 接近限制 · 通信 丢失")
    expect(showRuntimeEnvironmentSummary(null)).toBe("历史记录未提供")
  })
})
