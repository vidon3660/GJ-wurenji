import type {
  LogisticsScheduleItemView,
  LogisticsSchedulingAircraftTaskView,
  LogisticsSchedulingAircraftView
} from "@wurenji/shared"

export interface LogisticsAircraftPoolRow extends LogisticsSchedulingAircraftView {
  taskQueue: LogisticsSchedulingAircraftTaskView[]
}

export function logisticsAircraftPoolRows(
  aircraft: readonly LogisticsSchedulingAircraftView[],
  scheduleItems?: readonly LogisticsScheduleItemView[]
): LogisticsAircraftPoolRow[] {
  if (!scheduleItems) return aircraft.map((item) => ({ ...item, taskQueue: [...item.taskQueue] }))
  const tasksByAircraft = new Map<string, LogisticsSchedulingAircraftTaskView[]>()
  for (const item of scheduleItems) {
    const tasks = tasksByAircraft.get(item.aircraftId) ?? []
    tasks.push({
      scheduleItemId: item.id,
      orderId: item.orderId,
      orderCode: item.orderCode,
      destinationNodeId: item.destinationNodeId,
      plannedTakeoffTimeMs: item.plannedTakeoffTimeMs,
      arrivalTimeMs: item.arrivalTimeMs,
      landingTimeMs: item.landingTimeMs,
      nextAvailableTimeMs: item.nextAvailableTimeMs
    })
    tasksByAircraft.set(item.aircraftId, tasks)
  }
  return aircraft.map((item) => {
    const taskQueue = (tasksByAircraft.get(item.id) ?? []).sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)
    const lastTask = taskQueue.at(-1)
    return {
      ...item,
      taskQueue,
      estimatedReturnTimeMs: lastTask?.landingTimeMs ?? null,
      nextAvailableTimeMs: Math.max(item.availableAtMs, lastTask?.nextAvailableTimeMs ?? 0)
    }
  })
}
