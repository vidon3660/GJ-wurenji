import { describe, expect, it } from "vitest"
import type { ShowProjectReportView, ShowReplayTimelineItemView, ShowReviewAnnotationView, V3ProjectEvaluationView } from "@wurenji/shared"
import { applyReviewVisibility, canAccessFullReviewReport } from "./review-visibility.js"

const evaluation: V3ProjectEvaluationView = {
  id: "evaluation-1",
  projectId: "project-1",
  status: "PUBLISHED",
  rubricVersion: "report@1.0.0",
  objectiveMetrics: [{ code: "RISK", label: "风险识别", value: 60, displayValue: "60%", unit: "%", state: "RISK", detail: "识别不足" }],
  teacherScores: [{ code: "PLAN", label: "方案规划", maxScore: 20, score: 16, comment: "应优化风险判断" }],
  studentSummary: "学生总结",
  studentSubmittedAt: "2026-08-13T00:00:00.000Z",
  summary: "教师完整讲评",
  totalScore: 82,
  revision: 3,
  reviewedAt: "2026-08-13T00:10:00.000Z",
  publishedAt: "2026-08-13T00:11:00.000Z"
}
const timeline = [{ id: "timeline-1" }] as ShowReplayTimelineItemView[]
const annotations = [{ id: "annotation-1" }] as ShowReviewAnnotationView[]
const report = { id: "report-1" } as ShowProjectReportView

describe("assessment review visibility", () => {
  it("returns only the published total for TOTAL_ONLY", () => {
    const visible = applyReviewVisibility({ actor: "STUDENT", mode: "ASSESSMENT", configuredVisibility: "TOTAL_ONLY", evaluation, timeline, annotations, report })
    expect(visible).toMatchObject({ resultVisibility: "TOTAL_ONLY", canAccessReport: false, timeline: [], annotations: [], report: null })
    expect(visible.evaluation).toMatchObject({ totalScore: 82, objectiveMetrics: [], teacherScores: [], summary: "", rubricVersion: "" })
  })

  it("returns dimension scores without comments for DIMENSIONS", () => {
    const visible = applyReviewVisibility({ actor: "STUDENT", mode: "ASSESSMENT", configuredVisibility: "DIMENSIONS", evaluation, timeline, annotations, report })
    expect(visible.evaluation.teacherScores).toEqual([{ code: "PLAN", label: "方案规划", maxScore: 20, score: 16, comment: "" }])
    expect(visible.timeline).toEqual([])
    expect(visible.canAccessReport).toBe(false)
  })

  it("keeps the complete review only after FULL_REVIEW is published", () => {
    const visible = applyReviewVisibility({ actor: "STUDENT", mode: "ASSESSMENT", configuredVisibility: "FULL_REVIEW", evaluation, timeline, annotations, report })
    expect(visible).toMatchObject({ canAccessReport: true, timeline, annotations, report })
    expect(visible.evaluation).toEqual(evaluation)
    expect(canAccessFullReviewReport("STUDENT", "ASSESSMENT", "FULL_REVIEW", "PUBLISHED")).toBe(true)
  })

  it("hides all teacher results before publication regardless of configured scope", () => {
    const pending = { ...evaluation, status: "REVIEWED" as const, publishedAt: null }
    const visible = applyReviewVisibility({ actor: "STUDENT", mode: "ASSESSMENT", configuredVisibility: "FULL_REVIEW", evaluation: pending, timeline, annotations, report })
    expect(visible.evaluation).toMatchObject({ totalScore: null, objectiveMetrics: [], teacherScores: [], summary: "" })
    expect(visible.canAccessReport).toBe(false)
    expect(canAccessFullReviewReport("STUDENT", "ASSESSMENT", "FULL_REVIEW", "REVIEWED")).toBe(false)
  })

  it("keeps training and teacher workspaces complete", () => {
    expect(applyReviewVisibility({ actor: "STUDENT", mode: "TRAINING", configuredVisibility: "TOTAL_ONLY", evaluation, timeline, annotations, report }).evaluation).toEqual(evaluation)
    expect(applyReviewVisibility({ actor: "TEACHER", mode: "ASSESSMENT", configuredVisibility: "TOTAL_ONLY", evaluation, timeline, annotations, report }).report).toBe(report)
  })
})
