import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"
import { normalizeRuntimeActionReasoning, runtimeActionReasoningFromPayload } from "./runtime-action-reasoning.js"

describe("runtime action reasoning", () => {
  it("normalizes a complete student reasoning record", () => {
    expect(normalizeRuntimeActionReasoning({
      observation: "  发现通信链路持续丢包  ",
      rationale: "告警趋势表明链路质量仍在下降",
      expectedOutcome: "暂停任务后链路风险不再扩大"
    })).toEqual({
      observation: "发现通信链路持续丢包",
      rationale: "告警趋势表明链路质量仍在下降",
      expectedOutcome: "暂停任务后链路风险不再扩大"
    })
  })

  it.each([
    ["observation", { rationale: "链路质量持续下降", expectedOutcome: "暂停后风险停止扩大" }],
    ["rationale", { observation: "发现通信链路异常", expectedOutcome: "暂停后风险停止扩大" }],
    ["expectedOutcome", { observation: "发现通信链路异常", rationale: "链路质量持续下降" }]
  ])("rejects a missing %s field", (_field, reasoning) => {
    expect(() => normalizeRuntimeActionReasoning(reasoning)).toThrow(BadRequestException)
  })

  it("keeps legacy action payloads readable", () => {
    expect(runtimeActionReasoningFromPayload({ rationale: "旧版判断依据" })).toBeNull()
  })
})
