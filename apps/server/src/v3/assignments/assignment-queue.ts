import type {
  AssignmentDraftView,
  V3TeachingAssignmentView,
  V3TeachingAssignmentSummary,
  V3TeacherProgressItem
} from "@wurenji/shared"

type QueueProgress = Pick<
  V3TeacherProgressItem,
  "assignmentId" | "submissionState" | "projectStatus" | "alerts" | "evaluationState"
>

export function buildTeachingAssignmentQueue(
  assignments: readonly AssignmentDraftView[],
  progress: readonly QueueProgress[]
): V3TeachingAssignmentView[] {
  const progressByAssignment = new Map<string, QueueProgress[]>()
  for (const item of progress) {
    const items = progressByAssignment.get(item.assignmentId) ?? []
    items.push(item)
    progressByAssignment.set(item.assignmentId, items)
  }

  return assignments
    .map((assignment) => ({
      ...assignment,
      summary: summarizeAssignmentProgress(progressByAssignment.get(assignment.id) ?? [])
    }))
    .sort(compareTeachingAssignments)
}

function summarizeAssignmentProgress(items: readonly QueueProgress[]): V3TeachingAssignmentSummary {
  return {
    projectCount: items.length,
    notStartedProjectCount: items.filter((item) => item.submissionState === "NOT_STARTED").length,
    inProgressProjectCount: items.filter((item) => item.projectStatus === "IN_PROGRESS").length,
    blockedProjectCount: items.filter((item) => item.projectStatus === "BLOCKED").length,
    submittedProjectCount: items.filter((item) => item.submissionState === "SUBMITTED").length,
    openAlertCount: items.reduce((count, item) => count + item.alerts.filter((alert) => alert.status === "OPEN").length, 0),
    pendingEvaluationCount: items.filter((item) => item.evaluationState === "PENDING").length,
    studentAttentionCount: items.filter((item) => item.projectStatus === "IN_PROGRESS" || item.projectStatus === "BLOCKED").length
  }
}

function compareTeachingAssignments(left: V3TeachingAssignmentView, right: V3TeachingAssignmentView): number {
  return assignmentQueueRank(left) - assignmentQueueRank(right)
    || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
    || left.title.localeCompare(right.title, "zh-CN")
    || left.id.localeCompare(right.id)
}

function assignmentQueueRank(assignment: V3TeachingAssignmentView): number {
  if (assignment.status === "DRAFT") return 0
  if (assignment.summary.pendingEvaluationCount > 0) return 1
  if (assignment.summary.openAlertCount > 0) return 2
  if (assignment.summary.studentAttentionCount > 0) return 3
  if (assignment.status === "PUBLISHED" || assignment.status === "IN_PROGRESS") return 4
  if (assignment.status === "ENDED") return 5
  return 6
}
