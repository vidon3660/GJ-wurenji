import type { LogisticsRuntimeActionCode } from "@wurenji/shared"
import type { LogisticsRuntimeProjection } from "@wurenji/simulation"

export interface LogisticsActionBusinessOutcome {
  outcome?: string
  businessConsequences: string[]
}

export function logisticsActionWithinDeadline(deadlineAtSimulationTimeMs: number | null, actionSimulationTimeMs: number): boolean | null {
  return deadlineAtSimulationTimeMs === null ? null : actionSimulationTimeMs <= deadlineAtSimulationTimeMs
}

export function logisticsActionBusinessOutcome(
  before: LogisticsRuntimeProjection,
  after: LogisticsRuntimeProjection,
  actionCode: LogisticsRuntimeActionCode,
  targetId: string | null
): LogisticsActionBusinessOutcome {
  if (!targetId) {
    const fallback = fallbackConsequences[actionCode]
    return fallback ? { outcome: fallback, businessConsequences: [fallback] } : { businessConsequences: [] }
  }

  const consequences = new Set<string>()
  const beforeAircraft = before.aircraft.find((item) => item.id === targetId)
  const afterAircraft = after.aircraft.find((item) => item.id === targetId)
  const beforeOrder = before.orders.find((item) => item.id === targetId)
  const afterOrder = after.orders.find((item) => item.id === targetId)
  const beforeRoute = before.routes.find((item) => item.id === targetId)
  const afterRoute = after.routes.find((item) => item.id === targetId)

  addChange(consequences, beforeAircraft?.code, "无人机", aircraftStatusLabel(beforeAircraft?.status), aircraftStatusLabel(afterAircraft?.status))
  addChange(consequences, beforeOrder?.code, "订单", orderStatusLabel(beforeOrder?.status), orderStatusLabel(afterOrder?.status))
  addChange(consequences, beforeOrder?.code, "订单优先级", priorityLabel(beforeOrder?.priority), priorityLabel(afterOrder?.priority))
  addChange(consequences, beforeRoute?.name, "航线", routeStatusLabel(beforeRoute?.status), routeStatusLabel(afterRoute?.status))

  const beforeTask = beforeAircraft
    ? before.tasks.find((item) => item.scheduleItemId === beforeAircraft.currentTaskId)
    : beforeOrder
      ? before.tasks.find((item) => item.orderId === beforeOrder.id)
      : null
  const afterTask = afterAircraft
    ? after.tasks.find((item) => item.scheduleItemId === (afterAircraft.currentTaskId ?? beforeAircraft?.currentTaskId))
    : afterOrder
      ? after.tasks.find((item) => item.orderId === afterOrder.id)
      : null
  const taskLabel = afterTask?.orderCode ?? beforeTask?.orderCode
  const beforeLinkedOrder = before.orders.find((item) => item.id === beforeTask?.orderId)
  const afterLinkedOrder = after.orders.find((item) => item.id === (afterTask?.orderId ?? beforeTask?.orderId))
  addChange(consequences, afterLinkedOrder?.code ?? beforeLinkedOrder?.code, "订单", orderStatusLabel(beforeLinkedOrder?.status), orderStatusLabel(afterLinkedOrder?.status))
  addChange(consequences, afterLinkedOrder?.code ?? beforeLinkedOrder?.code, "订单优先级", priorityLabel(beforeLinkedOrder?.priority), priorityLabel(afterLinkedOrder?.priority))
  addChange(consequences, taskLabel, "配送任务", taskStatusLabel(beforeTask?.status), taskStatusLabel(afterTask?.status))
  addChange(consequences, taskLabel, "执行无人机", beforeTask?.aircraftCode, afterTask?.aircraftCode)
  addChange(consequences, taskLabel, "执行航线", routeName(before, beforeTask?.activeRouteId), routeName(after, afterTask?.activeRouteId))
  if (beforeTask && afterTask && beforeTask.delayedByMs !== afterTask.delayedByMs) {
    consequences.add(`${taskLabel ?? "当前任务"}：累计延误 ${formatDuration(afterTask.delayedByMs)}`)
  }

  if (consequences.size === 0 && fallbackConsequences[actionCode]) consequences.add(fallbackConsequences[actionCode]!)
  const businessConsequences = [...consequences]
  return {
    ...(businessConsequences.length > 0 ? { outcome: businessConsequences.join("；") } : {}),
    businessConsequences
  }
}

function addChange(values: Set<string>, objectName: string | undefined, field: string, before: string | undefined, after: string | undefined): void {
  if (!objectName || !before || !after || before === after) return
  values.add(`${objectName}：${field}由“${before}”变为“${after}”`)
}

function routeName(projection: LogisticsRuntimeProjection, routeId: string | null | undefined): string | undefined {
  if (!routeId) return undefined
  return projection.routes.find((item) => item.id === routeId)?.name ?? routeId
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000))
  return `${minutes} 分钟`
}

function aircraftStatusLabel(value: string | undefined): string | undefined {
  return value ? ({ STANDBY: "待命", AVAILABLE: "可用", ASSIGNED: "已分配", TAKING_OFF: "起飞中", OUTBOUND: "去程中", ARRIVED: "已到达", RETURNING: "返航中", LANDING: "降落中", HOLDING: "悬停等待", DIVERTING: "备降中", EMERGENCY_LANDING: "应急迫降", DISABLED: "停用" } as Record<string, string>)[value] ?? value : undefined
}

function orderStatusLabel(value: string | undefined): string | undefined {
  return value ? ({ UNRELEASED: "未释放", UNASSIGNED: "待分配", SCHEDULED: "待执行", DELIVERING: "配送中", COMPLETED: "已完成", EXPECTED_DELAY: "预计延误", DELAYED: "已延误", FAILED: "失败", CANCELLED: "已取消" } as Record<string, string>)[value] ?? value : undefined
}

function taskStatusLabel(value: string | undefined): string | undefined {
  return value ? ({ WAITING_EXECUTION: "待执行", TAKEOFF: "起飞中", OUTBOUND: "去程中", ARRIVAL_CONFIRMATION: "到达确认", RETURNING: "返航中", LANDING: "降落中", AVAILABLE_AGAIN: "再次可用", CANCELLED: "已取消", FAILED: "失败" } as Record<string, string>)[value] ?? value : undefined
}

function routeStatusLabel(value: string | undefined): string | undefined {
  return value ? ({ AVAILABLE: "可用", RISK: "风险", PAUSED: "暂停", ABNORMAL: "异常", RECOVERING: "恢复中", CLOSED: "关闭" } as Record<string, string>)[value] ?? value : undefined
}

function priorityLabel(value: string | undefined): string | undefined {
  return value ? ({ NORMAL: "普通", PRIORITY: "优先", URGENT: "紧急" } as Record<string, string>)[value] ?? value : undefined
}

const fallbackConsequences: Partial<Record<LogisticsRuntimeActionCode, string>> = {
  CONTINUE_MONITORING: "已保持监控，业务状态暂未调整",
  REDUCE_SPEED: "已降低受影响无人机速度，后续任务时刻按新速度重新计算",
  MAINTAIN_ROUTE: "已维持当前航线和运行计划",
  HOLD_POSITION: "受影响无人机已进入悬停等待状态",
  PROCEED_TO_WAITING_POINT: "受影响无人机已前往计划等待点",
  RETURN_AIRCRAFT: "受影响无人机已转入返航，关联订单按延误处理",
  DIVERT_AIRCRAFT: "受影响无人机已转入备降，关联订单按延误处理",
  EMERGENCY_LAND_AIRCRAFT: "受影响无人机已应急迫降，关联任务和订单标记为失败",
  ABORT_TASK: "关联任务和订单已中止",
  CANCEL_TASK: "关联任务和订单已取消",
  PAUSE_ROUTE_ENTRY: "目标航线已暂停新任务进入",
  PAUSE_ROUTE: "目标航线已暂停运行",
  RESUME_ROUTE: "目标航线已恢复运行",
  SWITCH_VERIFIED_ROUTE: "关联任务已切换至验证通过的备用航线",
  REPLACE_AIRCRAFT: "关联任务已更换可用无人机",
  REASSIGN_ORDER: "关联订单已重新分配可用无人机",
  CHANGE_PRIORITY: "订单优先级已更新",
  DELAY_TASK: "关联任务已推迟并标记预计延误"
}
