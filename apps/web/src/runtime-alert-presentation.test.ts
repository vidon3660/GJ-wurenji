import { describe, expect, it } from "vitest"
import {
  pickRecommendedRuntimeAction,
  pickRuntimeTargetId,
  latestRuntimeAction,
  preferredRuntimeAlertId,
  runtimeAlertSeverityLabel,
  runtimeAlertStatusLabel,
  runtimeAlertTiming,
  runtimeRecommendedActionLabel
} from "./runtime-alert-presentation"

describe("runtime alert presentation", () => {
  it("localizes alert severity labels and preserves unknown values", () => {
    expect(["INFO", "WARNING", "ERROR", "CRITICAL"].map(runtimeAlertSeverityLabel)).toEqual(["提示", "警告", "错误", "严重"])
    expect(runtimeAlertSeverityLabel("CUSTOM")).toBe("CUSTOM")
  })

  it("calculates remaining handling time from event payload", () => {
    expect(runtimeAlertTiming({ payload: { actionDeadlineSeconds: 30, detectedSimulationTimeMs: 10_000 } }, 25_000)).toEqual({
      deadlineAtSimulationTimeMs: 40_000,
      remainingMs: 15_000,
      label: "剩余 00:15",
      tone: "warning"
    })
    expect(runtimeAlertTiming({ actionDeadlineAtSimulationTimeMs: 8_000 }, 10_000).label).toBe("已超时 00:02")
  })

  it("makes missing deadlines explicit", () => {
    expect(runtimeAlertTiming({}, 0)).toEqual({ deadlineAtSimulationTimeMs: null, remainingMs: null, label: "未设置处置时限", tone: "neutral" })
    expect(runtimeAlertTiming({ payload: { actionDeadlineSeconds: null, actionDeadlineAtSimulationTimeMs: null } }, 0).label).toBe("未设置处置时限")
  })

  it("selects an enabled recommended action and affected target", () => {
    const actions = [{ code: "RETURN_AIRCRAFT", enabled: true }, { code: "HOLD", enabled: true }]
    expect(pickRecommendedRuntimeAction(actions, ["RETURN_AIRCRAFT"])).toEqual(actions[0])
    expect(pickRuntimeTargetId(["BATCH-G01", "G02"], ["G01"])).toBe("BATCH-G01")
  })

  it("uses lifecycle state before alert acknowledgement state", () => {
    expect(runtimeAlertStatusLabel("ACKNOWLEDGED", "HANDLING")).toBe("处置中")
    expect(runtimeAlertStatusLabel("OPEN", "DISCOVERED")).toBe("待确认")
    expect(runtimeRecommendedActionLabel(["HOLD"], [{ code: "HOLD", title: "保持等待" }])).toBe("保持等待")
  })

  it("uses the latest action result when an alert is handled more than once", () => {
    const actions = [
      { id: "first", alertId: "alert-1", eventId: "event-1", simulationTimeMs: 10_000 },
      { id: "retry", alertId: "alert-1", eventId: "event-1", simulationTimeMs: 20_000 },
      { id: "other", alertId: "alert-2", eventId: "event-2", simulationTimeMs: 30_000 }
    ]
    expect(latestRuntimeAction(actions, "alert-1", "event-1")?.id).toBe("retry")
    expect(latestRuntimeAction(actions, "missing", "event-2")?.id).toBe("other")
  })

  it("focuses a new active alert after the previous selection is resolved", () => {
    const items = [{ id: "resolved", status: "RESOLVED" }, { id: "new", status: "OPEN" }]
    expect(preferredRuntimeAlertId(items, "resolved")).toBe("new")
    expect(preferredRuntimeAlertId(items, "new")).toBe("new")
    expect(preferredRuntimeAlertId([], "resolved")).toBe("")
  })
})
