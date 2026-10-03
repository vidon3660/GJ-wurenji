import type { SceneType } from "./types.js"

export const questionTypes = [
  "SINGLE_CHOICE",
  "MULTIPLE_CHOICE",
  "TRUE_FALSE",
  "PLANNING",
  "SCHEDULE",
  "SCENARIO_DECISION",
  "SIMULATION_EVIDENCE"
] as const
export type QuestionType = (typeof questionTypes)[number]

export const questionDifficulties = ["BEGINNER", "INTERMEDIATE", "ADVANCED"] as const
export type QuestionDifficulty = (typeof questionDifficulties)[number]

export const questionBankStatuses = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const
export type QuestionBankStatus = (typeof questionBankStatuses)[number]

export const questionAttemptStatuses = ["IN_PROGRESS", "SUBMITTED", "GRADED", "REVIEWED"] as const
export type QuestionAttemptStatus = (typeof questionAttemptStatuses)[number]

export type QuestionAnswer = string | string[] | boolean | number | Record<string, unknown> | null

export interface QuestionOption {
  key: string
  label: string
}

export type QuestionGradingRule =
  | { kind: "EXACT" }
  | { kind: "REQUIRED_FIELDS"; fields: string[] }
  | { kind: "METRIC_THRESHOLD"; metricCode: string; operator: "GTE" | "LTE" | "EQ"; threshold: number }

export interface QuestionDefinition {
  code: string
  type: QuestionType
  difficulty: QuestionDifficulty
  knowledgePoints: string[]
  prompt: string
  options: QuestionOption[]
  correctAnswer: QuestionAnswer
  explanation: string
  maxScore: number
  stageCode: string | null
  gradingRule: QuestionGradingRule
  sortOrder: number
}

export interface QuestionView {
  code: string
  type: QuestionType
  difficulty: QuestionDifficulty
  knowledgePoints: string[]
  prompt: string
  options: QuestionOption[]
  answerFields?: string[]
  correctAnswer?: QuestionAnswer
  explanation?: string
  maxScore: number
  stageCode: string | null
  gradingRule?: QuestionGradingRule
  sortOrder: number
}

export interface QuestionBankVersionSummary {
  id: string
  version: number
  status: QuestionBankStatus
  questionCount: number
  changeNote: string | null
  publishedAt: string | null
  createdAt: string
}

export interface QuestionBankSummary {
  id: string
  title: string
  sceneType: SceneType | null
  summary: string
  status: QuestionBankStatus
  currentVersion: number
  latestVersionId: string | null
  publishedVersionId: string | null
  publishedVersion: QuestionBankVersionSummary | null
  questionCount: number
  questionTypes: QuestionType[]
  difficulties: QuestionDifficulty[]
  knowledgePoints: string[]
  usageCount: number
  updatedAt: string
}

export interface QuestionBankDetail extends QuestionBankSummary {
  versions: QuestionBankVersionSummary[]
  currentVersionId: string | null
  questions: QuestionView[]
}

export interface QuestionBankVersionDetail extends QuestionBankVersionSummary {
  questions: QuestionView[]
}

export type QuestionBankAuditIssueCategory = "EMPTY_DRAFT" | "INVALID_CONTENT"

export interface QuestionBankAuditVersion {
  bankId: string
  bankTitle: string
  sceneType: SceneType | null
  versionId: string
  version: number
  status: QuestionBankStatus
  questionCount: number
  questionTypes: QuestionType[]
  metricCodes: string[]
  valid: boolean
  issueCategory: QuestionBankAuditIssueCategory | null
  issues: string[]
}

export interface QuestionBankAuditResult {
  generatedAt: string
  summary: {
    bankCount: number
    versionCount: number
    archivedVersionCount: number
    validVersionCount: number
    invalidVersionCount: number
    emptyDraftCount: number
    invalidContentCount: number
    metricCodeCount: number
  }
  versions: QuestionBankAuditVersion[]
}

export interface QuestionBankVersionArchiveResult {
  bankId: string
  versionId: string
  archived: boolean
  alreadyArchived: boolean
  bankArchived: boolean
  fallbackVersionId: string | null
}

export interface QuestionBankCleanupPreview {
  generatedAt: string
  summary: {
    bankCount: number
    candidateCount: number
    blockedReferenceCount: number
    blockedContentCount: number
  }
  banks: Array<{
    bankId: string
    bankTitle: string
    sceneType: SceneType | null
    candidateCount: number
    blockedReferenceCount: number
    blockedContentCount: number
    versions: Array<{
      versionId: string
      version: number
      questionCount: number
      referenceCount: number
      action: "ARCHIVE" | "BLOCKED_REFERENCE" | "BLOCKED_CONTENT"
    }>
  }>
}

export interface QuestionBankCleanupBatchResult {
  requestedVersionCount: number
  archivedVersionCount: number
  bankIds: string[]
  archivedVersionIds: string[]
}

export interface QuestionEvidence {
  source: "ANSWER" | "PROJECT_EVALUATION"
  metricCode?: string
  metricLabel?: string
  value?: number | string
  displayValue?: string
  state?: string
  detail: string
}

export interface QuestionDefinitionInput {
  code?: string
  type?: QuestionType
  difficulty?: QuestionDifficulty
  knowledgePoints?: string[]
  prompt?: string
  options?: QuestionOption[]
  correctAnswer?: QuestionAnswer
  explanation?: string
  maxScore?: number
  stageCode?: string | null
  gradingRule?: QuestionGradingRule
  sortOrder?: number
}

export interface QuestionBankCreateInput {
  title?: string
  sceneType?: SceneType | null
  summary?: string
  questions?: QuestionDefinitionInput[]
}

export interface QuestionBankVersionInput {
  questions?: QuestionDefinitionInput[]
  changeNote?: string
}

export interface QuestionResponseInput {
  questionCode?: string
  answer?: QuestionAnswer
}

export interface QuestionAttemptSaveInput {
  expectedRevision?: number
  responses?: QuestionResponseInput[]
}

export interface QuestionAttemptRegradeInput {
  expectedRevision?: number
}

export interface QuestionAttemptReviewInput {
  expectedRevision?: number
  reviewComment?: string
  responses?: Array<{
    questionCode?: string
    teacherScore?: number | null
    teacherComment?: string
  }>
}

export type QuestionJudgment = "CORRECT" | "PARTIAL" | "INCORRECT" | "UNANSWERED" | "PENDING"

export interface QuestionResponseView {
  questionCode: string
  answer: QuestionAnswer
  autoScore: number | null
  maxScore: number
  judgment: QuestionJudgment
  evidence: QuestionEvidence[]
  teacherScore: number | null
  teacherComment: string
}

export interface QuestionAttemptView {
  id: string
  status: QuestionAttemptStatus
  revision: number
  autoScore: number
  teacherScore: number | null
  maxScore: number
  submittedAt: string | null
  reviewedAt: string | null
  reviewComment: string
}

export interface QuestionnaireView {
  available: boolean
  reason: string | null
  actor: "STUDENT" | "TEACHER"
  canEdit: boolean
  canSubmit: boolean
  canReview: boolean
  canRegrade: boolean
  bank: {
    id: string
    title: string
    sceneType: SceneType | null
    summary: string
    versionId: string
    version: number
  } | null
  attempt: QuestionAttemptView | null
  questions: QuestionView[]
  responses: QuestionResponseView[]
}
