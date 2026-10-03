import type { AssessmentAttemptView, AssessmentTimingView } from "@wurenji/shared"

export function assessmentAttemptLabel(attempt: AssessmentAttemptView): string {
  return `第 ${attempt.attemptNumber} 次考核`
}

export function assessmentRetakeDefaultWindow(timing: AssessmentTimingView, now = new Date()): { availableAt: Date; dueAt: Date } {
  const durationMinutes = Math.max(1, timing.durationMinutes ?? 120)
  return {
    availableAt: now,
    dueAt: new Date(now.getTime() + Math.max(durationMinutes, 24 * 60) * 60_000)
  }
}
