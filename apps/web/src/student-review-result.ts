import type { ShowReviewWorkspaceView, ShowTeacherScoreView } from "@wurenji/shared"

type StudentReviewWorkspace = Pick<ShowReviewWorkspaceView, "actor" | "canAccessReport" | "evaluation">
type ReviewReportWorkspace = Pick<ShowReviewWorkspaceView, "actor" | "canAccessReport" | "evaluation" | "report">

export interface StudentReviewResultPresentation {
  visible: boolean
  published: boolean
  totalScore: number | null
  scores: ShowTeacherScoreView[]
  summary: string
}

export interface ReviewReportActionsPresentation {
  visible: boolean
  canGenerate: boolean
  canDownload: boolean
}

export function studentReviewResultPresentation(workspace: StudentReviewWorkspace | null): StudentReviewResultPresentation {
  if (!workspace || workspace.actor !== "STUDENT") return hiddenResult()
  const published = workspace.evaluation.status === "PUBLISHED"
  const scores = workspace.evaluation.teacherScores.filter((item) => item.score !== null)
  const summary = workspace.evaluation.summary.trim()
  const totalScore = workspace.evaluation.totalScore
  const hasTeacherResult = totalScore !== null || scores.length > 0 || summary.length > 0
  return {
    visible: published ? hasTeacherResult : workspace.canAccessReport && hasTeacherResult,
    published,
    totalScore,
    scores,
    summary
  }
}

export function reviewReportActionsPresentation(workspace: ReviewReportWorkspace | null): ReviewReportActionsPresentation {
  if (!workspace || !workspace.canAccessReport) return { visible: false, canGenerate: false, canDownload: false }
  const canGenerate = workspace.actor === "TEACHER" && workspace.evaluation.status === "PUBLISHED"
  const canDownload = Boolean(workspace.report?.downloadPath)
  const visible = workspace.actor === "TEACHER" || canDownload
  return { visible, canGenerate, canDownload }
}

function hiddenResult(): StudentReviewResultPresentation {
  return { visible: false, published: false, totalScore: null, scores: [], summary: "" }
}
