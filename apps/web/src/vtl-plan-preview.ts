import type {
  VtlFlightPhase,
  VtlProjectPlanView,
  VtlRoutePlanView,
  VtlRuntimeAircraftView,
  VtlRuntimeGroupView,
  VtlRuntimeSummaryView,
  VtlTaskObjectView
} from "@wurenji/shared"
import { projectVtlRuntime } from "@wurenji/simulation/vtl-runtime"
import type { RuntimeTimelineMarker } from "./runtime-playback"

export interface VtlPlanPreviewState {
  aircraft: VtlRuntimeAircraftView[]
  groups: VtlRuntimeGroupView[]
  summary: VtlRuntimeSummaryView
  taskObjects: VtlTaskObjectView[]
}

const phaseLabels: Record<VtlFlightPhase, string> = {
  VERTICAL_TAKEOFF: "垂直起飞",
  CLIMB: "爬升",
  FORWARD_TRANSITION: "前转换",
  FIXED_WING_CRUISE: "固定翼巡航",
  TASK_EXECUTION: "任务执行",
  RETURN: "返航",
  BACK_TRANSITION: "后转换",
  VERTICAL_LANDING: "垂直降落"
}

export function vtlPlanPreviewDurationMs(routes: readonly VtlRoutePlanView[]): number {
  return Math.max(0, ...routes.map((route) => route.energySegments.reduce((sum, segment) => sum + segment.durationSeconds * 1_000, 0)))
}

export function projectVtlPlanPreview(plan: VtlProjectPlanView, simulationTimeMs: number): VtlPlanPreviewState {
  const routeAircraftIds = new Set(plan.routes.map((route) => route.aircraftId))
  const assignments = plan.allocation.assignments.filter((assignment) => assignment.available && routeAircraftIds.has(assignment.aircraftId))
  const projection = projectVtlRuntime({
    simulationTimeMs: Math.max(0, Math.min(vtlPlanPreviewDurationMs(plan.routes), simulationTimeMs)),
    routes: plan.routes,
    assignments,
    groups: plan.allocation.groups,
    taskObjects: plan.taskObjects
  })
  const completedTaskObjectIds = new Set(projection.aircraft.flatMap((aircraft) => aircraft.completedTaskObjectIds))
  const currentTaskObjectIds = new Set(projection.aircraft.map((aircraft) => aircraft.currentTaskObjectId).filter((taskId): taskId is string => Boolean(taskId)))
  const assignedTaskObjectIds = new Set(assignments.flatMap((assignment) => assignment.taskObjectIds))
  const taskObjects = plan.taskObjects.map((task): VtlTaskObjectView => ({
    ...task,
    positions: task.positions.map((position) => ({ ...position })),
    status: completedTaskObjectIds.has(task.id)
      ? "COMPLETED"
      : currentTaskObjectIds.has(task.id)
        ? "IN_PROGRESS"
        : assignedTaskObjectIds.has(task.id)
          ? "ASSIGNED"
          : "UNASSIGNED",
    incompleteReason: null
  }))
  return { ...projection, taskObjects }
}

export function vtlPlanPreviewMarkers(route: VtlRoutePlanView | null, taskObjects: readonly VtlTaskObjectView[]): RuntimeTimelineMarker[] {
  if (!route) return []
  const taskById = new Map(taskObjects.map((task) => [task.id, task]))
  let elapsedMs = 0
  return route.energySegments.map((segment, index) => {
    elapsedMs += segment.durationSeconds * 1_000
    const completedTask = route.waypoints[index]?.taskObjectId
      ? taskById.get(route.waypoints[index]!.taskObjectId!)
      : null
    const nextPhase = route.waypoints[index + 1]?.phase ?? segment.phase
    return {
      id: `${route.id}-preview-${index + 1}`,
      label: completedTask ? `${completedTask.code} 完成` : `进入${phaseLabels[nextPhase]}`,
      timeMs: elapsedMs,
      severity: "INFO"
    }
  })
}
