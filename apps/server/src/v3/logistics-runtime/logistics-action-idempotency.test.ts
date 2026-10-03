import { describe, expect, it } from "vitest"
import type { StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import { assertSameLogisticsActionRequest, sameLogisticsActionRequest, type LogisticsActionRequestIdentity } from "./logistics-action-idempotency.js"

const request: LogisticsActionRequestIdentity = {
  actionCode: "REDUCE_SPEED",
  eventId: "11111111-1111-4111-8111-111111111111",
  alertId: "22222222-2222-4222-8222-222222222222",
  targetType: "AIRCRAFT",
  targetId: "aircraft-1",
  reasoning: {
    observation: "发现风力接近运行限制",
    rationale: "先降低速度并重新评估航线时效",
    expectedOutcome: "控制风险并保持后续任务可调整"
  },
  payload: { speedFactor: 1.5 }
}

const existing = {
  actionCode: request.actionCode,
  eventId: request.eventId,
  alertId: request.alertId,
  targetType: request.targetType,
  targetId: request.targetId,
  payload: { speedFactor: 1.5, reasoning: request.reasoning, rationale: request.reasoning.rationale, _requestId: "logistics-idempotency-001" }
} as StudentRuntimeActionEntity

describe("logistics action request idempotency", () => {
  it("recognizes the same business payload regardless of payload key order", () => {
    expect(sameLogisticsActionRequest(existing, { ...request, payload: { speedFactor: 1.5 } })).toBe(true)
    expect(() => assertSameLogisticsActionRequest(existing, request)).not.toThrow()
  })

  it.each([
    ["actionCode", { actionCode: "HOLD_POSITION" }],
    ["eventId", { eventId: "33333333-3333-4333-8333-333333333333" }],
    ["alertId", { alertId: "44444444-4444-4444-8444-444444444444" }],
    ["targetType", { targetType: "ORDER" }],
    ["targetId", { targetId: "aircraft-2" }],
    ["observation", { reasoning: { ...request.reasoning, observation: "发现另一条航线异常" } }],
    ["rationale", { reasoning: { ...request.reasoning, rationale: "改为继续原速度观察" } }],
    ["expectedOutcome", { reasoning: { ...request.reasoning, expectedOutcome: "保持原计划不变" } }],
    ["action payload", { payload: { speedFactor: 1.8 } }]
  ] as const)("rejects a reused request id with different %s", (_field, change) => {
    const conflicting = { ...request, ...change } as LogisticsActionRequestIdentity
    expect(sameLogisticsActionRequest(existing, conflicting)).toBe(false)
    expect(() => assertSameLogisticsActionRequest(existing, conflicting)).toThrowError("同一请求号不能提交不同的物流处置命令")
  })
})
