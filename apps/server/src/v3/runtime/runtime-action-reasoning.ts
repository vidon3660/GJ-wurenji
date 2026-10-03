import { BadRequestException } from "@nestjs/common"
import type { V3RuntimeActionReasoning } from "@wurenji/shared"

const minimumFieldLength = 4
const maximumFieldLength = 1_000

export function normalizeRuntimeActionReasoning(value: unknown): V3RuntimeActionReasoning {
  if (!isRecord(value)) throw new BadRequestException("请完整填写异常发现、判断依据和预期结果")
  return {
    observation: normalizeField(value.observation, "异常发现"),
    rationale: normalizeField(value.rationale, "判断依据"),
    expectedOutcome: normalizeField(value.expectedOutcome, "预期结果")
  }
}

export function runtimeActionReasoningFromPayload(payload: unknown): V3RuntimeActionReasoning | null {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return null
  const reasoning = payload.reasoning
  if (typeof reasoning.observation !== "string" || typeof reasoning.rationale !== "string" || typeof reasoning.expectedOutcome !== "string") return null
  return {
    observation: reasoning.observation,
    rationale: reasoning.rationale,
    expectedOutcome: reasoning.expectedOutcome
  }
}

function normalizeField(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length < minimumFieldLength) throw new BadRequestException(`${label}至少填写 ${minimumFieldLength} 个字符`)
  if (text.length > maximumFieldLength) throw new BadRequestException(`${label}不能超过 ${maximumFieldLength} 个字符`)
  return text
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
