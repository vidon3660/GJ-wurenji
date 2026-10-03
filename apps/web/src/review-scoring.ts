import type { ShowTeacherScoreView } from "@wurenji/shared"

export interface TeacherEvaluationDraftStatus {
  completedCount: number
  totalCount: number
  isDirty: boolean
  canPublish: boolean
  blockedReason: string | null
}

export function teacherEvaluationDraftStatus(
  savedScores: ShowTeacherScoreView[],
  savedSummary: string,
  draftScores: ShowTeacherScoreView[],
  draftSummary: string,
  authoritativeCanPublish: boolean,
  authoritativeBlockedReason: string | null
): TeacherEvaluationDraftStatus {
  const completedCount = draftScores.filter(validScore).length
  const isDirty = savedSummary !== draftSummary || !sameScores(savedScores, draftScores)
  const blockedReason = isDirty
    ? "请先保存当前评分修改"
    : authoritativeCanPublish ? null : authoritativeBlockedReason ?? "当前评价尚未满足发布条件"
  return {
    completedCount,
    totalCount: draftScores.length,
    isDirty,
    canPublish: !isDirty && authoritativeCanPublish,
    blockedReason
  }
}

function validScore(item: ShowTeacherScoreView): boolean {
  return typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= item.maxScore
}

function sameScores(left: ShowTeacherScoreView[], right: ShowTeacherScoreView[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && item.code === candidate.code
      && item.score === candidate.score
      && item.comment === candidate.comment
  })
}
