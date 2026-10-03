import type { V3AlertSeverity, V3TeacherAlertFollowUpStatus, V3TeacherProgressItem, V3TeacherProgressMilestoneState, V3TeachingMetric } from "@wurenji/shared"

export type TeacherProgressSort = "RECENT_ACTIVITY" | "STALLED" | "RISK" | "EVALUATION"

export interface TeacherAlertStatusSummary {
  total: number
  open: number
  acknowledged: number
}

export interface TeacherMetricNavigation {
  section: "home" | "progress"
  assignmentFocus: "" | "DRAFT"
  submissionState: "" | "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED"
  alertState: "" | "OPEN"
  evaluationState: "" | "NOT_STARTED" | "PENDING" | "PUBLISHED"
}

export interface TeacherProgressFilterState {
  keyword?: string
  sceneType?: string
  stageCode?: string
  classroomId?: string
  submissionState?: string
  alertState?: string
  alertSeverity?: string
  followUpStatus?: string
  evaluationState?: string
  focusState?: string
  stalledOnly?: boolean
  includeInternalData?: boolean
}

export function countTeacherProgressFilters(filters: TeacherProgressFilterState): number {
  return [
    filters.keyword?.trim(),
    filters.sceneType,
    filters.stageCode,
    filters.classroomId,
    filters.submissionState,
    filters.alertState,
    filters.alertSeverity,
    filters.followUpStatus,
    filters.evaluationState,
    filters.focusState,
    filters.stalledOnly ? "stalled" : "",
    filters.includeInternalData ? "internal" : ""
  ].filter(Boolean).length
}

const riskMilestoneStates = new Set(["ATTENTION", "WITH_RISK", "PAUSED", "ABORTED"])
const stalledThresholdMs = 30 * 60 * 1_000

export function teacherAlertStatusSummary(items: Pick<V3TeacherProgressItem, "alerts">[]): TeacherAlertStatusSummary {
  return items.reduce<TeacherAlertStatusSummary>((summary, item) => {
    for (const alert of item.alerts) {
      if (alert.status === "OPEN") summary.open += 1
      if (alert.status === "ACKNOWLEDGED") summary.acknowledged += 1
    }
    summary.total = summary.open + summary.acknowledged
    return summary
  }, { total: 0, open: 0, acknowledged: 0 })
}

export function filterTeacherProgressAlerts(
  items: V3TeacherProgressItem[],
  severity: V3AlertSeverity | "" = "",
  followUpStatus: V3TeacherAlertFollowUpStatus | "" = ""
): V3TeacherProgressItem[] {
  if (!severity && !followUpStatus) return items
  return items
    .map((item) => ({
      ...item,
      alerts: item.alerts.filter((alert) => (
        (!severity || alert.severity === severity)
        && (!followUpStatus || alert.teacherFollowUp?.status === followUpStatus)
      ))
    }))
    .filter((item) => item.alerts.length > 0)
}

export function teacherMetricNavigation(key: V3TeachingMetric["key"]): TeacherMetricNavigation {
  if (key === "DRAFTS") {
    return { section: "home", assignmentFocus: "DRAFT", submissionState: "", alertState: "", evaluationState: "" }
  }
  return {
    section: "progress",
    assignmentFocus: "",
    submissionState: key === "NOT_STARTED" || key === "IN_PROGRESS" || key === "SUBMITTED" ? key : "",
    alertState: key === "ALERTS" ? "OPEN" : "",
    evaluationState: key === "EVALUATION" ? "PENDING" : ""
  }
}

function riskScore(item: Pick<V3TeacherProgressItem, "alerts" | "milestones">) {
  return item.alerts.length * 10 + item.milestones.filter((milestone) => riskMilestoneStates.has(milestone.state)).length
}

function activityTime(item: Pick<V3TeacherProgressItem, "lastActivityAt">) {
  const value = Date.parse(item.lastActivityAt)
  return Number.isFinite(value) ? value : 0
}

export function teacherProgressStallLabel(
  item: Pick<V3TeacherProgressItem, "submissionState" | "lastActivityAt">,
  nowMs = Date.now()
): string | null {
  if (item.submissionState !== "IN_PROGRESS") return null
  const lastActivityMs = Date.parse(item.lastActivityAt)
  const elapsedMs = nowMs - lastActivityMs
  if (!Number.isFinite(lastActivityMs) || elapsedMs < stalledThresholdMs) return null
  const totalMinutes = Math.floor(elapsedMs / 60_000)
  if (totalMinutes < 60) return `已停滞 ${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `已停滞 ${hours} 小时` : `已停滞 ${hours} 小时 ${minutes} 分钟`
}

export function filterStalledTeacherProgress(
  items: V3TeacherProgressItem[],
  nowMs = Date.now()
): V3TeacherProgressItem[] {
  return items.filter((item) => teacherProgressStallLabel(item, nowMs) !== null)
}

export function sortTeacherProgress(items: V3TeacherProgressItem[], sort: TeacherProgressSort): V3TeacherProgressItem[] {
  return [...items].sort((left, right) => {
    if (sort === "RISK") {
      const difference = riskScore(right) - riskScore(left)
      if (difference !== 0) return difference
    }
    if (sort === "EVALUATION") {
      const difference = Number(right.evaluationState === "PENDING") - Number(left.evaluationState === "PENDING")
      if (difference !== 0) return difference
    }
    if (sort === "STALLED") {
      const difference = Number(right.submissionState === "IN_PROGRESS") - Number(left.submissionState === "IN_PROGRESS")
      if (difference !== 0) return difference
      const activityDifference = activityTime(left) - activityTime(right)
      if (activityDifference !== 0) return activityDifference
    } else {
      const activityDifference = activityTime(right) - activityTime(left)
      if (activityDifference !== 0) return activityDifference
    }
    return left.studentName.localeCompare(right.studentName, "zh-CN")
  })
}

export function teacherProgressMilestoneClass(state: V3TeacherProgressMilestoneState) {
  if (state === "ATTENTION" || state === "ABORTED") return "attention"
  if (state === "WITH_RISK" || state === "PAUSED") return "warning"
  if (state === "SUBMITTED" || state === "PASSED" || state === "COMPLETED") return "complete"
  if (state === "IN_PROGRESS") return "active"
  return "pending"
}
