import { describe, expect, it } from "vitest"
import type { V3ProjectEvaluationView } from "@wurenji/shared"
import { reviewReportActionsPresentation, studentReviewResultPresentation } from "./student-review-result"

const evaluation: V3ProjectEvaluationView = {
  id: "evaluation-1",
  projectId: "project-1",
  status: "PUBLISHED",
  rubricVersion: "LOGISTICS-1.0",
  objectiveMetrics: [],
  teacherScores: [],
  studentSummary: "学生复盘",
  studentSubmittedAt: "2026-08-14T00:00:00.000Z",
  summary: "",
  totalScore: 86,
  revision: 3,
  reviewedAt: "2026-08-14T01:00:00.000Z",
  publishedAt: "2026-08-14T02:00:00.000Z"
}
const base = {
  actor: "STUDENT" as const,
  canAccessReport: false,
  evaluation
}

describe("student review result presentation", () => {
  it("shows only the published total returned for TOTAL_ONLY", () => {
    expect(studentReviewResultPresentation(base)).toEqual({ visible: true, published: true, totalScore: 86, scores: [], summary: "" })
  })

  it("shows dimension scores without inventing redacted comments", () => {
    const workspace = {
      ...base,
      evaluation: { ...base.evaluation, teacherScores: [{ code: "PLAN", label: "方案规划", maxScore: 20, score: 17, comment: "" }] }
    }
    expect(studentReviewResultPresentation(workspace).scores).toEqual([{ code: "PLAN", label: "方案规划", maxScore: 20, score: 17, comment: "" }])
  })

  it("keeps comments and summary returned for FULL_REVIEW", () => {
    const workspace = {
      ...base,
      canAccessReport: true,
      evaluation: { ...base.evaluation, teacherScores: [{ code: "PLAN", label: "方案规划", maxScore: 20, score: 17, comment: "继续优化" }], summary: "教师完整讲评" }
    }
    expect(studentReviewResultPresentation(workspace)).toMatchObject({ visible: true, scores: [expect.objectContaining({ comment: "继续优化" })], summary: "教师完整讲评" })
  })

  it("shows saved teacher feedback immediately in training mode", () => {
    const workspace = {
      ...base,
      canAccessReport: true,
      evaluation: { ...base.evaluation, status: "REVIEWED" as const, teacherScores: [{ code: "PLAN", label: "方案规划", maxScore: 20, score: 16, comment: "训练反馈" }], summary: "可继续修改方案" }
    }
    expect(studentReviewResultPresentation(workspace)).toMatchObject({ visible: true, published: false, summary: "可继续修改方案" })
  })

  it("hides unpublished assessment feedback and teacher workspaces", () => {
    const unpublished = { ...base, evaluation: { ...base.evaluation, status: "REVIEWED" as const } }
    const teacher = { ...base, actor: "TEACHER" as const, canAccessReport: true }
    expect(studentReviewResultPresentation(unpublished).visible).toBe(false)
    expect(studentReviewResultPresentation(teacher).visible).toBe(false)
  })

  it("shows teacher report status before publish but only enables generation after publish", () => {
    const report = { id: "report-1", status: "FINAL" as const, revision: 1, format: "PDF" as const, filename: "report.pdf", sizeBytes: 1024, sha256: "a".repeat(64), generatedAt: "2026-08-14T03:00:00.000Z", downloadPath: "/v3/review/report/download" }
    expect(reviewReportActionsPresentation({ ...base, actor: "TEACHER", canAccessReport: true, report: null })).toEqual({ visible: true, canGenerate: true, canDownload: false })
    expect(reviewReportActionsPresentation({ ...base, actor: "TEACHER", canAccessReport: true, evaluation: { ...base.evaluation, status: "REVIEWED" }, report: null })).toEqual({ visible: true, canGenerate: false, canDownload: false })
    expect(reviewReportActionsPresentation({ ...base, canAccessReport: true, report: null })).toEqual({ visible: false, canGenerate: false, canDownload: false })
    expect(reviewReportActionsPresentation({ ...base, canAccessReport: true, report })).toEqual({ visible: true, canGenerate: false, canDownload: true })
  })
})
