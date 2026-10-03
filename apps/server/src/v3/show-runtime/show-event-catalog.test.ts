import { describe, expect, it } from "vitest"
import { configuredShowEvents, showActionDeadlineSeconds } from "./show-event-catalog.js"

describe("show event configuration", () => {
  it("applies teacher overrides while preserving legacy event codes", () => {
    const [configured] = configuredShowEvents([{
      code: "COMMUNICATION_LOSS",
      triggerMode: "PHASE",
      triggerPhase: "BATCH_LANDING",
      triggerOffsetSeconds: 8,
      severity: "CRITICAL",
      detectionDelaySeconds: 2,
      escalationDelaySeconds: 12,
      durationSeconds: 30,
      recoveryMode: "AUTO"
    }])
    expect(configured).toMatchObject({
      code: "COMMUNICATION_LOSS",
      severity: "CRITICAL",
      visibilityDelayMs: 2_000,
      escalationDelayMs: 12_000,
      scenarioConfig: {
        triggerMode: "PHASE",
        triggerPhase: "BATCH_LANDING",
        triggerOffsetSeconds: 8,
        durationSeconds: 30,
        recoveryMode: "AUTO"
      }
    })
    expect(configuredShowEvents(["COMMUNICATION_LOSS"])[0]?.scenarioConfig).toBeNull()
  })

  it("accepts a custom event supplied by an active EVENT resource", () => {
    const [configured] = configuredShowEvents([{
      code: "SHOW_CUSTOM_WEATHER",
      title: "资源包自定义风场事件",
      category: "WEATHER",
      severity: "WARNING",
      affectedRatio: 0.2,
      detectionDelaySeconds: 3,
      escalationDelaySeconds: 20,
      recommendedActions: ["PAUSE_PROGRAM"]
    }])

    expect(configured).toMatchObject({ code: "SHOW_CUSTOM_WEATHER", title: "资源包自定义风场事件", affectedRatio: 0.2, visibilityDelayMs: 3_000 })
  })

  it("uses the escalation window as the built-in action deadline unless explicitly configured", () => {
    const builtIn = configuredShowEvents(["BATTERY_ANOMALY"])[0]!
    const configured = configuredShowEvents([{ code: "BATTERY_ANOMALY", actionDeadlineSeconds: 12 }])[0]!
    expect(showActionDeadlineSeconds(builtIn, builtIn.scenarioConfig?.actionDeadlineSeconds)).toBe(40)
    expect(showActionDeadlineSeconds(configured, configured.scenarioConfig?.actionDeadlineSeconds)).toBe(12)
  })
})
