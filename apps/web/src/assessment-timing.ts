import type { AssessmentTimingView } from "@wurenji/shared"

export function assessmentServerOffsetMs(timing: AssessmentTimingView, receivedAtMs = Date.now()): number {
  return Date.parse(timing.serverNow) - receivedAtMs
}

export function assessmentRemainingMs(timing: AssessmentTimingView, clientNowMs = Date.now(), serverOffsetMs = 0): number | null {
  if (timing.state !== "ACTIVE" || !timing.deadlineAt) return timing.remainingMs
  return Math.max(0, Date.parse(timing.deadlineAt) - (clientNowMs + serverOffsetMs))
}

export function assessmentTimingLabel(timing: AssessmentTimingView, remainingMs = timing.remainingMs): string {
  if (timing.state === "NOT_APPLICABLE") return "训练模式"
  if (timing.state === "NOT_OPEN") return "尚未开放"
  if (timing.state === "NOT_STARTED") return "尚未开始"
  if (timing.state === "EXPIRED") return "已超时"
  if (timing.state === "SUBMITTED") return "已提交"
  if ((remainingMs ?? 0) <= 0) return "已超时"
  return `剩余 ${formatAssessmentDuration(remainingMs ?? 0)}`
}

export function formatAssessmentDuration(value: number): string {
  const seconds = Math.max(0, Math.ceil(value / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor(seconds % 3_600 / 60)
  const remainingSeconds = seconds % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
}
