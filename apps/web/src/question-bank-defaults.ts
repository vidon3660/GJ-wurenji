import type { QuestionBankSummary, SceneType } from "@wurenji/shared"

/**
 * Picks the published question bank that should be attached to a new
 * assignment. Scene-specific banks always win over a generic bank; within a
 * scene we use the most recently updated bank so a teacher receives the latest
 * published version without having to remember an id.
 */
export function defaultQuestionBankForScene(
  banks: readonly QuestionBankSummary[],
  sceneType: SceneType
): QuestionBankSummary | null {
  const candidates = banks
    .filter((bank) => Boolean(bank.publishedVersionId))
    .filter((bank) => bank.sceneType === sceneType || bank.sceneType === null)
    .sort((left, right) => {
      const sceneRank = Number(right.sceneType === sceneType) - Number(left.sceneType === sceneType)
      if (sceneRank !== 0) return sceneRank
      const leftTime = Date.parse(left.updatedAt)
      const rightTime = Date.parse(right.updatedAt)
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime
      return left.title.localeCompare(right.title, "zh-CN")
    })
  return candidates[0] ?? null
}
