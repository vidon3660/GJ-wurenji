import type { VtlRuntimeActionCode, VtlTaskObjectView } from "@wurenji/shared"

export interface VtlActionPreviewContext {
  aircraftCode?: string | null
  destinationAircraftCode?: string | null
  destinationGroupTitle?: string | null
  landingSiteTitle?: string | null
  remainingTaskCount?: number
  taskTitle?: string | null
}

export function remainingVtlTasks(taskIds: string[], completedTaskIds: string[], tasks: VtlTaskObjectView[]): VtlTaskObjectView[] {
  const completed = new Set(completedTaskIds)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return taskIds.filter((taskId) => !completed.has(taskId)).map((taskId) => byId.get(taskId)).filter((task): task is VtlTaskObjectView => Boolean(task))
}

export function vtlActionPreview(action: VtlRuntimeActionCode | "", context: VtlActionPreviewContext): string {
  const aircraft = context.aircraftCode || "目标航空器"
  const remaining = Math.max(0, context.remainingTaskCount ?? 0)
  if (action === "ACKNOWLEDGE") return "确认告警并进入处置中状态，航空器任务和分组暂不改变。"
  if (action === "HOLD") return `${aircraft}进入短时等待，事件解除后继续当前任务序列。`
  if (action === "RETURN_AIRCRAFT") return `${aircraft}终止剩余 ${remaining} 项任务并返回${context.landingSiteTitle || "主起降点"}。`
  if (action === "DIVERT_AIRCRAFT") return `${aircraft}终止剩余 ${remaining} 项任务并备降至${context.landingSiteTitle || "自动备降点"}。`
  if (action === "TRANSFER_TASK") return `${context.taskTitle || "所选任务"}转移至${context.destinationAircraftCode || "目标航空器"}，系统重建任务顺序和动态航段。`
  if (action === "ADJUST_GROUP") return `${aircraft}调整至${context.destinationGroupTitle || "目标分组"}，任务归属保持不变。`
  if (action === "CANCEL_NOT_STARTED") return `${aircraft}取消起飞，剩余 ${remaining} 项任务标记为未完成。`
  return "选择处置动作后显示预期状态、任务和落点变化。"
}
