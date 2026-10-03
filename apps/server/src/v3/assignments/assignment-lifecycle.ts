import type { AssignmentDraftStatus } from "@wurenji/shared"

export type AssignmentLifecycleAction = "WITHDRAW" | "START" | "END" | "ARCHIVE"

export interface AssignmentLifecycleDecision {
  allowed: boolean
  targetStatus: AssignmentDraftStatus | null
  code: "ALLOWED" | "INVALID_STATUS" | "PROJECT_ALREADY_STARTED"
}

export function decideAssignmentLifecycle(
  status: AssignmentDraftStatus,
  action: AssignmentLifecycleAction,
  allProjectsNotStarted = true
): AssignmentLifecycleDecision {
  if (action === "WITHDRAW") {
    if (status !== "PUBLISHED") return { allowed: false, targetStatus: null, code: "INVALID_STATUS" }
    if (!allProjectsNotStarted) return { allowed: false, targetStatus: null, code: "PROJECT_ALREADY_STARTED" }
    return { allowed: true, targetStatus: "DRAFT", code: "ALLOWED" }
  }
  if (action === "START") {
    return status === "PUBLISHED" || status === "IN_PROGRESS"
      ? { allowed: true, targetStatus: "IN_PROGRESS", code: "ALLOWED" }
      : { allowed: false, targetStatus: null, code: "INVALID_STATUS" }
  }
  if (action === "END") {
    return status === "PUBLISHED" || status === "IN_PROGRESS"
      ? { allowed: true, targetStatus: "ENDED", code: "ALLOWED" }
      : { allowed: false, targetStatus: null, code: "INVALID_STATUS" }
  }
  return status === "ENDED"
    ? { allowed: true, targetStatus: "ARCHIVED", code: "ALLOWED" }
    : { allowed: false, targetStatus: null, code: "INVALID_STATUS" }
}
