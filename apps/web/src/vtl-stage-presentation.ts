import type { StudentProjectStageView } from "@wurenji/shared"

const planningStageCodes = new Set([
  "VTL_AREA_OBJECTS",
  "VTL_TASK_ALLOCATION",
  "VTL_ROUTE_PLANNING",
  "VTL_PLAN_VALIDATION",
  "VTL_EXECUTION_PLAN"
])

export function shouldShowVtlPlanningWorkspace(stage: StudentProjectStageView | null | undefined): boolean {
  if (!stage || !planningStageCodes.has(stage.stageCode)) return false
  if (stage.status === "LOCKED" || stage.status === "AVAILABLE") return false
  return stage.status !== "RETURNED" || stage.stageCode === "VTL_ROUTE_PLANNING"
}

export function canResumeReturnedVtlRoute(stage: StudentProjectStageView, isStudent: boolean): boolean {
  return isStudent
    && stage.stageCode === "VTL_ROUTE_PLANNING"
    && stage.status === "RETURNED"
    && stage.allowedActions.includes("RESUME")
}
