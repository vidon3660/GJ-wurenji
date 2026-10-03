import { describe, expect, it } from "vitest"
import type { StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { assertSameShowActionRequest, sameShowActionRequest, type ShowActionRequestIdentity } from "./show-action-idempotency.js"

const request: ShowActionRequestIdentity = {
  actionCode: "SINGLE_LAND",
  eventId: "11111111-1111-4111-8111-111111111111",
  alertId: "22222222-2222-4222-8222-222222222222",
  targetType: "AIRCRAFT",
  targetId: "G01-A001",
  reasoning: {
    observation: "发现单架无人机电池压差扩大",
    rationale: "继续飞行会降低安全返航余度",
    expectedOutcome: "异常单机退出表演并安全降落"
  }
}

const existing = {
  actionCode: request.actionCode,
  eventId: request.eventId,
  alertId: request.alertId,
  targetType: request.targetType,
  targetId: request.targetId,
  payload: { reasoning: request.reasoning, _requestId: "show-idempotency-001" }
} as StudentRuntimeActionEntity

describe("show action request idempotency", () => {
  it("recognizes the same normalized business payload", () => {
    expect(sameShowActionRequest(existing, request)).toBe(true)
    expect(() => assertSameShowActionRequest(existing, request)).not.toThrow()
  })

  it.each([
    ["actionCode", { actionCode: "REMOVE_FROM_MISSION" }],
    ["eventId", { eventId: "33333333-3333-4333-8333-333333333333" }],
    ["alertId", { alertId: "44444444-4444-4444-8444-444444444444" }],
    ["targetType", { targetType: "GROUP" }],
    ["targetId", { targetId: "G01-A002" }],
    ["observation", { reasoning: { ...request.reasoning, observation: "发现另一架无人机电池异常" } }],
    ["rationale", { reasoning: { ...request.reasoning, rationale: "改为继续观察设备变化趋势" } }],
    ["expectedOutcome", { reasoning: { ...request.reasoning, expectedOutcome: "保持原编队继续完成表演" } }]
  ] as const)("rejects a reused request id with different %s", (_field, change) => {
    const conflicting = { ...request, ...change } as ShowActionRequestIdentity
    expect(sameShowActionRequest(existing, conflicting)).toBe(false)
    expect(() => assertSameShowActionRequest(existing, conflicting)).toThrowError("同一请求号不能提交不同的城市表演处置命令")
  })
})
