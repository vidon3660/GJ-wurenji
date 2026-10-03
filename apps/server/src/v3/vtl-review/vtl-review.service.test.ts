import { describe, expect, it } from "vitest"
import type { ProjectActivityEventEntity } from "../activities/activity-event.entity.js"
import type { RuntimeAlertEntity, RuntimeEventEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { buildTimeline, vtlReviewVisibility } from "./vtl-review.service.js"

const at = (value: string) => new Date(`2026-01-01T00:${value}:00.000Z`)

describe("VTL review timeline", () => {
  it("redacts assessment evidence until the configured result visibility is available", () => {
    expect(vtlReviewVisibility("STUDENT", "ASSESSMENT", "TOTAL_ONLY", "PENDING")).toEqual({ full: false, dimensions: false })
    expect(vtlReviewVisibility("STUDENT", "ASSESSMENT", "DIMENSIONS", "PUBLISHED")).toEqual({ full: false, dimensions: true })
    expect(vtlReviewVisibility("STUDENT", "ASSESSMENT", "FULL_REVIEW", "PUBLISHED")).toEqual({ full: true, dimensions: false })
    expect(vtlReviewVisibility("TEACHER", "ASSESSMENT", "TOTAL_ONLY", "PENDING")).toEqual({ full: true, dimensions: true })
  })

  it("adds deterministic shared runtime evidence sequences without changing source payloads", () => {
    const event = {
      id: "event-late",
      code: "WEATHER_CHANGE",
      status: "TRIGGERED",
      severity: "WARNING",
      scheduledSimulationTimeMs: 2_000,
      triggeredSimulationTimeMs: 2_500,
      triggeredAt: at("02"),
      createdAt: at("02"),
      correlationId: "corr-event",
      payload: { title: "天气变化", detail: "能见度下降", marker: "kept" }
    } as unknown as RuntimeEventEntity
    const action = {
      id: "action-early",
      actionCode: "ACKNOWLEDGE",
      status: "APPLIED",
      simulationTimeMs: 1_000,
      requestedAt: at("01"),
      createdAt: at("01"),
      correlationId: "corr-action",
      payload: { reasoning: "确认告警", marker: "kept" },
      result: { outcome: "已确认" }
    } as unknown as StudentRuntimeActionEntity

    const timeline = buildTimeline([], [event], [], [action], [])
    const eventItem = timeline.find((item) => item.sourceId === event.id)!
    const actionItem = timeline.find((item) => item.sourceId === action.id)!

    expect(actionItem.payload).toMatchObject({ marker: "kept", result: { outcome: "已确认" }, runtimeEvidenceSequence: 1 })
    expect(eventItem.payload).toMatchObject({ marker: "kept", runtimeEvidenceSequence: 2 })
    expect(eventItem.simulationTimeMs).toBe(2_500)
    expect(event.payload).toEqual({ title: "天气变化", detail: "能见度下降", marker: "kept" })
    expect(action.payload).toEqual({ reasoning: "确认告警", marker: "kept" })
  })

  it("renders runtime activity transitions for events and alerts", () => {
    const correlationId = "corr-lifecycle"
    const event = {
      id: "event-weather",
      code: "WEATHER_CHANGE",
      status: "RESOLVED",
      severity: "WARNING",
      scheduledSimulationTimeMs: 1_000,
      triggeredSimulationTimeMs: 2_000,
      triggeredAt: at("02"),
      createdAt: at("02"),
      correlationId,
      payload: { title: "天气变化", detail: "能见度下降", lifecycleStatus: "RESOLVED" }
    } as unknown as RuntimeEventEntity
    const alert = {
      id: "alert-weather",
      eventId: event.id,
      title: "天气变化",
      detail: "能见度下降",
      status: "RESOLVED",
      severity: "WARNING",
      simulationTimeMs: 3_000,
      openedAt: at("03"),
      correlationId,
      payload: {}
    } as unknown as RuntimeAlertEntity
    const activity = (id: string, eventType: ProjectActivityEventEntity["eventType"], objectId: string, simulationTimeMs: number, minute: string) => ({
      id,
      eventType,
      objectType: eventType === "RUNTIME_EVENT_DISCOVERED" ? "RUNTIME_ALERT" : "RUNTIME_EVENT",
      objectId,
      correlationId,
      simulationTimeMs,
      realTime: at(minute),
      payload: {},
      result: {}
    } as unknown as ProjectActivityEventEntity)
    const timeline = buildTimeline([], [event], [alert], [], [], [
      activity("triggered", "RUNTIME_EVENT_TRIGGERED", event.id, 2_000, "02"),
      activity("discovered", "RUNTIME_EVENT_DISCOVERED", alert.id, 3_000, "03"),
      activity("escalated", "RUNTIME_EVENT_ESCALATED", event.id, 4_000, "04"),
      activity("resolved", "RUNTIME_EVENT_RESOLVED", event.id, 5_000, "05")
    ])

    expect(timeline.filter((item) => item.kind === "EVENT").map((item) => item.status)).toEqual(["TRIGGERED", "ESCALATED", "RESOLVED"])
    expect(timeline.filter((item) => item.kind === "ALERT").map((item) => item.status)).toEqual(["OPEN", "ESCALATED", "RESOLVED"])
  })
})
