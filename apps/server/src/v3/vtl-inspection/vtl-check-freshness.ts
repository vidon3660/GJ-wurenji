import type { VtlProjectPlanView } from "@wurenji/shared"

export function vtlPlanCheckResultIsCurrent(plan: Pick<VtlProjectPlanView, "projectId" | "allocation" | "routes" | "checkResult">): boolean {
  const result = plan.checkResult
  if (!result?.passed || result.projectId !== plan.projectId || result.allocationRevision !== plan.allocation.revision) return false
  if (Object.keys(result.routeRevisions).length !== plan.routes.length) return false
  return plan.routes.every((route) => result.routeRevisions[route.aircraftId] === route.revision)
}
