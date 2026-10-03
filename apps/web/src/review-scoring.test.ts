import { describe, expect, it } from "vitest"
import type { ShowTeacherScoreView } from "@wurenji/shared"
import { teacherEvaluationDraftStatus } from "./review-scoring"

const savedScores: ShowTeacherScoreView[] = [
  { code: "AREA", label: "区域规划", maxScore: 40, score: 32, comment: "规划完整" },
  { code: "OPERATIONS", label: "运行处置", maxScore: 60, score: 48, comment: "处置合理" }
]

describe("teacher evaluation draft status", () => {
  it("allows publication only when the saved authoritative evaluation is ready", () => {
    expect(teacherEvaluationDraftStatus(savedScores, "综合讲评满足要求", structuredClone(savedScores), "综合讲评满足要求", true, null)).toEqual({
      completedCount: 2,
      totalCount: 2,
      isDirty: false,
      canPublish: true,
      blockedReason: null
    })
  })

  it("blocks publication when the displayed score has unsaved changes", () => {
    const draftScores = structuredClone(savedScores)
    draftScores[0]!.score = 36

    expect(teacherEvaluationDraftStatus(savedScores, "综合讲评满足要求", draftScores, "综合讲评满足要求", true, null)).toMatchObject({
      completedCount: 2,
      isDirty: true,
      canPublish: false,
      blockedReason: "请先保存当前评分修改"
    })
  })

  it("presents the authoritative reason for an unchanged incomplete evaluation", () => {
    const incompleteScores = savedScores.map((item, index) => ({ ...item, score: index === 0 ? item.score : null }))

    expect(teacherEvaluationDraftStatus(incompleteScores, "短", structuredClone(incompleteScores), "短", false, "请完成全部分项评分（已完成 1/2）")).toMatchObject({
      completedCount: 1,
      totalCount: 2,
      isDirty: false,
      canPublish: false,
      blockedReason: "请完成全部分项评分（已完成 1/2）"
    })
  })
})
