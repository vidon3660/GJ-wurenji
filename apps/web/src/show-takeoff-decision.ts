import type { ShowPreflightItemView, ShowTakeoffDecision } from "@wurenji/shared"

export interface ShowTakeoffDecisionGate {
  checksComplete: boolean
  unresolvedIssueCount: number
  rationaleComplete: boolean
  canComplete: boolean
}

export function showTakeoffDecisionGate(
  items: readonly ShowPreflightItemView[],
  decision: ShowTakeoffDecision | null,
  rationale: string
): ShowTakeoffDecisionGate {
  const checksComplete = items.length > 0 && items.every((item) => item.confirmed)
  const unresolvedIssueCount = items.filter((item) => item.sourceStatus !== "NORMAL" && (!item.resolution || !item.resolved)).length
  const rationaleComplete = rationale.trim().length > 0
  const unresolvedIssuesBlock = decision === "ALLOW" || decision === "ALLOW_AFTER_RECTIFICATION"
  return {
    checksComplete,
    unresolvedIssueCount,
    rationaleComplete,
    canComplete: checksComplete && decision !== null && rationaleComplete && (!unresolvedIssuesBlock || unresolvedIssueCount === 0)
  }
}
