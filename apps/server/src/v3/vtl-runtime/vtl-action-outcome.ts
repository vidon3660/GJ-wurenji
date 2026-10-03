import type { VtlRuntimeActionCode, VtlRuntimeAircraftView, VtlTaskObjectView } from "@wurenji/shared"

export interface VtlActionOutcomeInput {
  actionCode: VtlRuntimeActionCode
  beforeAircraft: VtlRuntimeAircraftView | null
  afterAircraft: VtlRuntimeAircraftView | null
  taskObjects: VtlTaskObjectView[]
  assignedTaskObjectIds: string[]
  landingSiteTitle?: string | null
  reorganizationMessage?: string | null
}

export interface VtlActionBusinessOutcome {
  outcome?: string
  businessConsequences: string[]
}

export function vtlActionWithinDeadline(deadlineAtSimulationTimeMs: number | null, actionSimulationTimeMs: number): boolean | null {
  return deadlineAtSimulationTimeMs === null ? null : actionSimulationTimeMs <= deadlineAtSimulationTimeMs
}

export function vtlActionBusinessOutcome(input: VtlActionOutcomeInput): VtlActionBusinessOutcome {
  const consequences = new Set<string>()
  const aircraftCode = input.afterAircraft?.aircraftCode ?? input.beforeAircraft?.aircraftCode ?? "目标航空器"

  addChange(consequences, aircraftCode, "运行状态", statusLabel(input.beforeAircraft?.status), statusLabel(input.afterAircraft?.status))
  addChange(consequences, aircraftCode, "飞行阶段", phaseLabel(input.beforeAircraft?.phase), phaseLabel(input.afterAircraft?.phase))

  const beforeTask = taskLabel(input.beforeAircraft?.currentTaskObjectId, input.taskObjects)
  const afterTask = taskLabel(input.afterAircraft?.currentTaskObjectId, input.taskObjects)
  if (beforeTask && !afterTask) consequences.add(`${aircraftCode}：已停止当前巡检任务“${beforeTask}”`)
  else addChange(consequences, aircraftCode, "当前任务", beforeTask, afterTask)

  if (input.landingSiteTitle && ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"].includes(input.actionCode)) {
    consequences.add(`${aircraftCode}：已转向${input.actionCode === "DIVERT_AIRCRAFT" ? "备降点" : "主起降点"}“${input.landingSiteTitle}”`)
  }

  const completed = new Set(input.afterAircraft?.completedTaskObjectIds ?? input.beforeAircraft?.completedTaskObjectIds ?? [])
  const remainingTasks = input.assignedTaskObjectIds.filter((taskId) => !completed.has(taskId))
  if (remainingTasks.length > 0 && ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "CANCEL_NOT_STARTED"].includes(input.actionCode)) {
    consequences.add(`${aircraftCode}：${remainingTasks.length} 项未完成巡检任务需要重新安排`)
  }

  if (input.reorganizationMessage) consequences.add(input.reorganizationMessage)
  if (consequences.size === 0) consequences.add(fallbackConsequences[input.actionCode])
  const businessConsequences = [...consequences]
  return { outcome: businessConsequences.join("；"), businessConsequences }
}

function addChange(values: Set<string>, objectName: string, field: string, before: string | undefined, after: string | undefined): void {
  if (!before || !after || before === after) return
  values.add(`${objectName}：${field}由“${before}”变为“${after}”`)
}

function taskLabel(taskId: string | null | undefined, taskObjects: VtlTaskObjectView[]): string | undefined {
  if (!taskId) return undefined
  const task = taskObjects.find((item) => item.id === taskId)
  return task ? `${task.code} · ${task.title}` : taskId
}

function statusLabel(value: VtlRuntimeAircraftView["status"] | undefined): string | undefined {
  return value ? ({ WAITING: "待起飞", ACTIVE: "执行中", HOLDING: "等待", RETURNING: "返航", DIVERTING: "备降", LANDED: "已降落", CANCELLED: "已取消" } satisfies Record<VtlRuntimeAircraftView["status"], string>)[value] : undefined
}

function phaseLabel(value: VtlRuntimeAircraftView["phase"] | undefined): string | undefined {
  return value ? ({ VERTICAL_TAKEOFF: "垂直起飞", CLIMB: "爬升", FORWARD_TRANSITION: "前转换", FIXED_WING_CRUISE: "固定翼巡航", TASK_EXECUTION: "任务执行", RETURN: "返航", BACK_TRANSITION: "后转换", VERTICAL_LANDING: "垂直降落" } satisfies Record<VtlRuntimeAircraftView["phase"], string>)[value] : undefined
}

const fallbackConsequences = {
  ACKNOWLEDGE: "已确认巡检告警，等待学生选择处置动作",
  HOLD: "目标航空器已进入等待，暂不继续进入风险区域",
  RETURN_AIRCRAFT: "目标航空器已转入返航，未完成任务等待重新安排",
  DIVERT_AIRCRAFT: "目标航空器已转入备降，未完成任务等待重新安排",
  TRANSFER_TASK: "未完成巡检任务已转移并重建动态航段",
  ADJUST_GROUP: "航空器分组已调整，后续任务按新分组执行",
  CANCEL_NOT_STARTED: "未起飞航空器及其未完成任务已取消"
} satisfies Record<VtlRuntimeActionCode, string>
