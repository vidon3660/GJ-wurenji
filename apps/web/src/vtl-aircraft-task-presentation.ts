import type { VtlTaskObjectView } from "@wurenji/shared"

export interface VtlAircraftTaskSummaryInput {
  currentTaskObjectId: string | null
  completedTaskObjectIds: string[]
  assignedTaskObjectIds: string[]
}

export interface VtlAircraftTaskSummary {
  currentTask: VtlTaskObjectView | null
  nextTask: VtlTaskObjectView | null
}

export function vtlAircraftTaskSummary(
  input: VtlAircraftTaskSummaryInput,
  taskObjects: VtlTaskObjectView[]
): VtlAircraftTaskSummary {
  const taskById = new Map(taskObjects.map((task) => [task.id, task]))
  const completed = new Set(input.completedTaskObjectIds)
  const currentTask = input.currentTaskObjectId ? taskById.get(input.currentTaskObjectId) ?? null : null
  const nextTask = input.assignedTaskObjectIds
    .filter((taskId) => taskId !== input.currentTaskObjectId && !completed.has(taskId))
    .map((taskId) => taskById.get(taskId))
    .find((task): task is VtlTaskObjectView => Boolean(task)) ?? null

  return { currentTask, nextTask }
}
