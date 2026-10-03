import { displayTeachingAssignmentTitle, type V3TeachingAssignmentView, type V3TeacherProgressItem } from "@wurenji/shared"
import { PLATFORM_TIME_ZONE } from "./platform-date"

export type TeacherAssignmentDataFilter = "FORMAL" | "INTERNAL"

export function teacherAssignmentIsInternal(assignment: Pick<V3TeachingAssignmentView, "isDemo" | "isAcceptanceData">): boolean {
  return assignment.isDemo || assignment.isAcceptanceData
}

export function teacherAssignmentDataLabel(assignment: Pick<V3TeachingAssignmentView, "isDemo" | "isAcceptanceData">): string {
  if (assignment.isAcceptanceData) return "验收数据"
  if (assignment.isDemo) return "演示数据"
  return "正式任务"
}

export function teacherAssignmentTitle(assignment: Pick<V3TeachingAssignmentView, "id" | "title" | "sceneType"> & Partial<Pick<V3TeachingAssignmentView, "displayTitle">>): string {
  return assignment.displayTitle ?? displayTeachingAssignmentTitle(assignment)
}

export function teacherProgressTitle(item: Pick<V3TeacherProgressItem, "assignmentId" | "assignmentTitle" | "sceneType"> & Partial<Pick<V3TeacherProgressItem, "assignmentDisplayTitle">>): string {
  return item.assignmentDisplayTitle ?? displayTeachingAssignmentTitle({ id: item.assignmentId, title: item.assignmentTitle, sceneType: item.sceneType })
}

export function teacherAssignmentMatchesSearch(assignment: Pick<V3TeachingAssignmentView, "id" | "title" | "sceneType" | "summary"> & Partial<Pick<V3TeachingAssignmentView, "displayTitle">>, query: string, sceneLabel: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true
  return [
    teacherAssignmentTitle(assignment),
    assignment.title,
    sceneLabel,
    assignment.summary.pendingEvaluationCount > 0 ? "待评价" : "",
    assignment.summary.openAlertCount > 0 ? "告警" : "",
    assignment.summary.blockedProjectCount > 0 ? "待修改" : "",
    assignment.summary.inProgressProjectCount > 0 ? "进行中" : "",
    assignment.summary.studentAttentionCount > 0 ? "学生待处理" : ""
  ]
    .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
}

export function teacherAssignmentMatchesDateRange(assignment: Pick<V3TeachingAssignmentView, "updatedAt">, range: readonly [Date, Date] | null): boolean {
  if (!range) return true
  const updatedAt = new Date(assignment.updatedAt)
  if (Number.isNaN(updatedAt.getTime())) return false
  // Date pickers return browser-local Date objects, while task timestamps are
  // UTC. Compare calendar days in the platform timezone so filtering remains
  // stable on lab computers with different OS timezone settings.
  const calendarDay = (value: Date) => new Intl.DateTimeFormat("en-CA", {
    timeZone: PLATFORM_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value)
  const updatedDay = calendarDay(updatedAt)
  return updatedDay >= calendarDay(range[0]) && updatedDay <= calendarDay(range[1])
}

export function assignmentQueueHint(assignment: Pick<V3TeachingAssignmentView, "status" | "summary">): string {
  if (assignment.status === "DRAFT") return "待发布"
  if (assignment.summary.pendingEvaluationCount > 0) return `待评价 ${assignment.summary.pendingEvaluationCount} 项`
  if (assignment.summary.openAlertCount > 0) return `开放告警 ${assignment.summary.openAlertCount} 条`
  if (assignment.summary.blockedProjectCount > 0) return `学生待修改 ${assignment.summary.blockedProjectCount} 项`
  if (assignment.summary.inProgressProjectCount > 0) return `学生进行中 ${assignment.summary.inProgressProjectCount} 项`
  if (assignment.status === "ENDED") return "已结束，可查看历史"
  if (assignment.status === "ARCHIVED") return "已归档"
  return "当前无待处理事项"
}

export function assignmentQueuePriority(assignment: Pick<V3TeachingAssignmentView, "status" | "summary" | "updatedAt">): [number, number] {
  const summary = assignment.summary
  const actionableCount = summary.pendingEvaluationCount + summary.openAlertCount + summary.blockedProjectCount + summary.inProgressProjectCount
  if (assignment.status === "DRAFT") return [0, 0]
  if (summary.pendingEvaluationCount > 0) return [1, -summary.pendingEvaluationCount]
  if (summary.openAlertCount > 0) return [2, -summary.openAlertCount]
  if (summary.blockedProjectCount > 0) return [3, -summary.blockedProjectCount]
  if (summary.inProgressProjectCount > 0) return [4, -summary.inProgressProjectCount]
  if (assignment.status === "ENDED") return [6, 0]
  if (assignment.status === "ARCHIVED") return [7, 0]
  return [5, -actionableCount]
}
