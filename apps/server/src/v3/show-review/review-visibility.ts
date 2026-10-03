import type {
  LearningMode,
  ShowProjectReportView,
  ShowReplayTimelineItemView,
  ShowReviewAnnotationView,
  V3EvaluationStatus,
  V3ProjectEvaluationView
} from "@wurenji/shared"

export type ReviewResultVisibility = "TOTAL_ONLY" | "DIMENSIONS" | "FULL_REVIEW"

interface ReviewVisibilityInput {
  actor: "STUDENT" | "TEACHER"
  mode: LearningMode
  configuredVisibility: unknown
  evaluation: V3ProjectEvaluationView
  timeline: ShowReplayTimelineItemView[]
  annotations: ShowReviewAnnotationView[]
  report: ShowProjectReportView | null
}

export interface VisibleReviewData {
  resultVisibility: ReviewResultVisibility
  canAccessReport: boolean
  evaluation: V3ProjectEvaluationView
  timeline: ShowReplayTimelineItemView[]
  annotations: ShowReviewAnnotationView[]
  report: ShowProjectReportView | null
}

export function applyReviewVisibility(input: ReviewVisibilityInput): VisibleReviewData {
  const resultVisibility = normalizeReviewResultVisibility(input.configuredVisibility, input.mode)
  if (input.actor === "TEACHER" || input.mode === "TRAINING") {
    return { resultVisibility, canAccessReport: true, evaluation: input.evaluation, timeline: input.timeline, annotations: input.annotations, report: input.report }
  }
  const published = input.evaluation.status === "PUBLISHED"
  if (published && resultVisibility === "FULL_REVIEW") {
    return { resultVisibility, canAccessReport: true, evaluation: input.evaluation, timeline: input.timeline, annotations: input.annotations, report: input.report }
  }
  const evaluation = redactEvaluation(input.evaluation, published && resultVisibility === "DIMENSIONS")
  return { resultVisibility, canAccessReport: false, evaluation, timeline: [], annotations: [], report: null }
}

export function canAccessFullReviewReport(actor: "STUDENT" | "TEACHER", mode: LearningMode, configuredVisibility: unknown, status: V3EvaluationStatus): boolean {
  if (actor === "TEACHER" || mode === "TRAINING") return true
  return status === "PUBLISHED" && normalizeReviewResultVisibility(configuredVisibility, mode) === "FULL_REVIEW"
}

export function normalizeReviewResultVisibility(value: unknown, mode: LearningMode): ReviewResultVisibility {
  if (value === "TOTAL_ONLY" || value === "DIMENSIONS" || value === "FULL_REVIEW") return value
  return mode === "TRAINING" ? "FULL_REVIEW" : "TOTAL_ONLY"
}

function redactEvaluation(evaluation: V3ProjectEvaluationView, includeDimensions: boolean): V3ProjectEvaluationView {
  return {
    ...evaluation,
    rubricVersion: "",
    objectiveMetrics: [],
    teacherScores: includeDimensions ? evaluation.teacherScores.map((item) => ({ ...item, comment: "" })) : [],
    summary: "",
    totalScore: evaluation.status === "PUBLISHED" ? evaluation.totalScore : null,
    reviewedAt: evaluation.status === "PUBLISHED" ? evaluation.reviewedAt : null
  }
}
