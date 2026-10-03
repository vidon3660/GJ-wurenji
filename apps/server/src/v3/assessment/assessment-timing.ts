import type { AssessmentTimingView, AssignmentDraftConfig, LearningMode } from "@wurenji/shared"

const MINUTE_MS = 60_000

export interface AssessmentTimingSource {
  mode: LearningMode
  config: Pick<AssignmentDraftConfig, "availableAt" | "dueAt" | "assessmentDurationMinutes">
  assessmentStartedAt: Date | null
  assessmentDeadlineAt: Date | null
  assessmentSubmittedAt: Date | null
  assessmentEndedAt: Date | null
}

export type AssessmentStartDecision = {
  allowed: true
  startedAt: Date | null
  deadlineAt: Date | null
} | {
  allowed: false
  code: "NOT_OPEN" | "EXPIRED" | "SUBMITTED"
  message: string
}

export function assessmentDurationMinutes(config: AssessmentTimingSource["config"]): number {
  const configured = Number(config.assessmentDurationMinutes)
  if (Number.isInteger(configured) && configured > 0) return configured
  return Math.max(1, Math.floor((Date.parse(config.dueAt) - Date.parse(config.availableAt)) / MINUTE_MS))
}

export function calculateAssessmentDeadline(startedAt: Date, durationMinutes: number, dueAt: Date): Date {
  return new Date(Math.min(startedAt.getTime() + durationMinutes * MINUTE_MS, dueAt.getTime()))
}

export function decideAssessmentStart(source: AssessmentTimingSource, now = new Date()): AssessmentStartDecision {
  if (source.mode !== "ASSESSMENT") return { allowed: true, startedAt: null, deadlineAt: null }
  if (source.assessmentSubmittedAt) return { allowed: false, code: "SUBMITTED", message: "考核已提交，不能继续操作" }

  const availableAt = new Date(source.config.availableAt)
  const dueAt = new Date(source.config.dueAt)
  if (now.getTime() < availableAt.getTime()) return { allowed: false, code: "NOT_OPEN", message: "考核尚未开放" }

  const startedAt = source.assessmentStartedAt ?? now
  const deadlineAt = source.assessmentDeadlineAt ?? calculateAssessmentDeadline(startedAt, assessmentDurationMinutes(source.config), dueAt)
  if (source.assessmentEndedAt || now.getTime() >= deadlineAt.getTime() || now.getTime() >= dueAt.getTime()) {
    return { allowed: false, code: "EXPIRED", message: "考核时间已结束，当前项目已转为只读" }
  }
  return { allowed: true, startedAt, deadlineAt }
}

export function buildAssessmentTimingView(source: AssessmentTimingSource, now = new Date()): AssessmentTimingView {
  const availableAt = new Date(source.config.availableAt)
  const assignmentDueAt = new Date(source.config.dueAt)
  const serverNow = now.toISOString()
  if (source.mode !== "ASSESSMENT") {
    return {
      state: "NOT_APPLICABLE",
      durationMinutes: null,
      availableAt: availableAt.toISOString(),
      assignmentDueAt: assignmentDueAt.toISOString(),
      startedAt: null,
      deadlineAt: null,
      submittedAt: null,
      endedAt: null,
      serverNow,
      remainingMs: null,
      canStart: true,
      canWrite: true,
      blockedReason: null
    }
  }

  const durationMinutes = assessmentDurationMinutes(source.config)
  const startedAt = source.assessmentStartedAt
  const deadlineAt = source.assessmentDeadlineAt ?? (startedAt ? calculateAssessmentDeadline(startedAt, durationMinutes, assignmentDueAt) : null)
  const submittedAt = source.assessmentSubmittedAt
  const effectiveExpiredAt = deadlineAt ?? assignmentDueAt
  const expired = Boolean(source.assessmentEndedAt && !submittedAt)
    || now.getTime() >= effectiveExpiredAt.getTime()

  if (submittedAt) {
    return assessmentView("SUBMITTED", false, false, "考核已提交", source, now, durationMinutes, deadlineAt, 0)
  }
  if (expired) {
    return assessmentView("EXPIRED", false, false, "考核时间已结束，当前项目已转为只读", {
      ...source,
      assessmentEndedAt: source.assessmentEndedAt ?? effectiveExpiredAt
    }, now, durationMinutes, deadlineAt ?? effectiveExpiredAt, 0)
  }
  if (now.getTime() < availableAt.getTime()) {
    return assessmentView("NOT_OPEN", false, false, "考核尚未开放", source, now, durationMinutes, deadlineAt, null)
  }
  if (!startedAt) {
    return assessmentView("NOT_STARTED", true, false, null, source, now, durationMinutes, null, null)
  }
  return assessmentView(
    "ACTIVE",
    true,
    true,
    null,
    source,
    now,
    durationMinutes,
    deadlineAt,
    Math.max(0, (deadlineAt?.getTime() ?? now.getTime()) - now.getTime())
  )
}

function assessmentView(
  state: AssessmentTimingView["state"],
  canStart: boolean,
  canWrite: boolean,
  blockedReason: string | null,
  source: AssessmentTimingSource,
  now: Date,
  durationMinutes: number,
  deadlineAt: Date | null,
  remainingMs: number | null
): AssessmentTimingView {
  return {
    state,
    durationMinutes,
    availableAt: new Date(source.config.availableAt).toISOString(),
    assignmentDueAt: new Date(source.config.dueAt).toISOString(),
    startedAt: source.assessmentStartedAt?.toISOString() ?? null,
    deadlineAt: deadlineAt?.toISOString() ?? null,
    submittedAt: source.assessmentSubmittedAt?.toISOString() ?? null,
    endedAt: source.assessmentEndedAt?.toISOString() ?? null,
    serverNow: now.toISOString(),
    remainingMs,
    canStart,
    canWrite,
    blockedReason
  }
}
