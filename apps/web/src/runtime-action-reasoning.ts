import type { V3RuntimeActionReasoning } from "@wurenji/shared"

export function runtimeActionReasoning(payload: unknown): V3RuntimeActionReasoning | null {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return null
  const reasoning = payload.reasoning
  if (typeof reasoning.observation !== "string" || typeof reasoning.rationale !== "string" || typeof reasoning.expectedOutcome !== "string") return null
  return reasoning as unknown as V3RuntimeActionReasoning
}

export function runtimeActionResultLabel(result: unknown): string {
  if (!isRecord(result)) return "已记录"
  const parts: string[] = []
  if (result.applied === true) parts.push("已执行")
  if (typeof result.outcome === "string" && result.outcome.trim()) parts.push(result.outcome.trim())
  if (result.eventControlled === true) parts.push("事件已控制")
  if (result.withinDeadline === true) parts.push("时限内完成")
  if (result.withinDeadline === false) parts.push("超过处置时限")
  const responseTimeMs = Number(result.responseTimeMs)
  if (Number.isFinite(responseTimeMs)) parts.push(`响应 ${(responseTimeMs / 1_000).toFixed(1)} 秒`)
  return parts.join(" · ") || "已记录"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
