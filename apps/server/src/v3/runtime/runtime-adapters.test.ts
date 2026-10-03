import { describe, expect, it } from "vitest"
import type { V3RuntimeEventView, V3RuntimeSessionView, V3StudentRuntimeActionView } from "@wurenji/shared"
import { adaptRuntimeAction, adaptRuntimeClock, adaptRuntimeEvent, adaptRuntimeSession, runtimeErrorFromMessage, runtimeJsonObject } from "./runtime-adapters.js"

describe("runtime contract adapters", () => {
  it("maps a scene session while freezing resource versions at the adapter boundary", () => {
    const session = adaptRuntimeSession({
      id: "session-1",
      projectId: "project-1",
      status: "RUNNING",
      mode: "ASSESSMENT",
      scenarioSeed: "seed-1",
      mapResourceVersion: "persisted-map",
      sceneResourceVersion: "persisted-scene",
      planVersion: "persisted-plan",
      attemptNo: 1,
      sourceSessionId: null,
      restartNodeCode: null,
      restartSimulationTimeMs: null,
      simulationTimeMs: 12_000,
      revision: 4,
      checkpoint: {},
      startedAt: "2026-09-27T00:00:00.000Z",
      endedAt: null
    } satisfies V3RuntimeSessionView, {
      mode: "TRAINING",
      mapResourceVersion: "map-1",
      sceneResourceVersion: "scene-1",
      planVersion: "plan-1"
    })

    expect(session).toMatchObject({ id: "session-1", mode: "ASSESSMENT", revision: 4, mapResourceVersion: "persisted-map", sceneResourceVersion: "persisted-scene", planVersion: "persisted-plan" })
  })

  it("maps events and actions without changing source payloads", () => {
    const event = adaptRuntimeEvent({
      id: "event-1", projectId: "project-1", sessionId: "session-1", stageCode: "LOGISTICS_DELIVERY_RUNTIME",
      code: "WEATHER_LIMIT", category: "WEATHER", status: "RESOLVED", severity: "WARNING",
      scheduledSimulationTimeMs: 30_000, triggeredSimulationTimeMs: 34_000, resolvedSimulationTimeMs: 39_000, triggeredAt: "2026-09-27T00:00:30.000Z", resolvedAt: "2026-09-27T00:01:00.000Z",
      payload: { impact: "SPEED_REDUCED" }, correlationId: "event-1"
    } satisfies V3RuntimeEventView)
    const action = adaptRuntimeAction({
      id: "action-1", projectId: "project-1", sessionId: "session-1", eventId: "event-1", alertId: null,
      actorId: "student-1", actionCode: "REDUCE_SPEED", targetType: "AIRCRAFT", targetId: "aircraft-1",
      status: "FAILED", simulationTimeMs: 31_000, payload: { speedMps: 4 }, result: { applied: false, errorCode: "TARGET_STATE_INVALID" },
      correlationId: "request-1", requestedAt: "2026-09-27T00:00:31.000Z", appliedAt: "2026-09-27T00:00:31.100Z"
    } satisfies V3StudentRuntimeActionView)

    expect(event).toMatchObject({ status: "RESOLVED", triggeredSimulationTimeMs: 34_000, resolvedSimulationTimeMs: 39_000 })
    expect(action).toMatchObject({ requestId: "request-1", code: "REDUCE_SPEED", appliedAtSimulationTimeMs: 31_000, errorCode: "TARGET_STATE_INVALID", result: { errorCode: "TARGET_STATE_INVALID" } })
  })

  it("normalizes the shared runtime clock units", () => {
    const clock = adaptRuntimeClock({ simulationTimeMs: 2_345.9, startedAt: new Date("2026-09-27T00:00:00.000Z") }, {
      rate: 60,
      deadlineAt: "2026-09-27T00:20:00.000Z",
      canPause: true,
      canReset: false
    })

    expect(clock).toEqual({
      simulationTimeMs: 2_345,
      tick: 2,
      tickIntervalMs: 1_000,
      rate: 60,
      wallClockStartedAt: "2026-09-27T00:00:00.000Z",
      deadlineAt: "2026-09-27T00:20:00.000Z",
      canPause: true,
      canReset: false
    })
  })

  it("normalizes common service errors to stable codes", () => {
    expect(runtimeErrorFromMessage("运行版本冲突，当前版本为 4", { revision: 4 }).code).toBe("STALE_SESSION_REVISION")
    expect(runtimeErrorFromMessage("考核模式不允许调整运行时钟").code).toBe("ASSESSMENT_LOCKED")
    expect(runtimeErrorFromMessage("当前运行状态不能执行处置").code).toBe("SESSION_NOT_RUNNING")
    expect(runtimeErrorFromMessage("目标航空器不存在").code).toBe("TARGET_NOT_FOUND")
    expect(runtimeErrorFromMessage("当前航空器不能进入等待").code).toBe("TARGET_STATE_INVALID")
    expect(runtimeErrorFromMessage("当前处置不可执行").code).toBe("ACTION_NOT_ALLOWED")
    expect(runtimeErrorFromMessage("同一请求号不能提交不同的巡检处置命令").code).toBe("DUPLICATE_REQUEST")
    expect(runtimeErrorFromMessage("请求标识已对应其他物流事件").code).toBe("DUPLICATE_REQUEST")
    expect(runtimeErrorFromMessage("未知错误").code).toBe("INVALID_PAYLOAD")
    expect(runtimeJsonObject({ nested: { value: true } })).toEqual({ nested: { value: true } })
  })
})
