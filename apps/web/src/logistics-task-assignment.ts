import type { LogisticsScheduleItemInput, LogisticsScheduleItemView, LogisticsSchedulingOrderView } from "@wurenji/shared"

export function matchesLogisticsTaskInput(
  projection: LogisticsScheduleItemView,
  input: LogisticsScheduleItemInput
): boolean {
  return projection.id === input.id
    && projection.orderId === input.orderId
    && projection.aircraftId === input.aircraftId
    && projection.outboundRouteId === input.outboundRouteId
    && projection.returnRouteId === input.returnRouteId
    && projection.plannedTakeoffTimeMs === input.plannedTakeoffTimeMs
}

export function assignLogisticsTasks(input: {
  items: readonly LogisticsScheduleItemInput[]
  orders: readonly LogisticsSchedulingOrderView[]
  aircraftId: string
  outboundRouteId: string
  returnRouteId: string
  firstTakeoffTimeMs: number
  intervalMs: number
  createId?: () => string
}): LogisticsScheduleItemInput[] {
  if (input.orders.length === 0) return input.items.map((item) => ({ ...item }))
  if (new Set(input.orders.map((order) => order.destinationNodeId)).size > 1) throw new Error("批量分配的订单必须属于同一配送点")
  if (!input.aircraftId || !input.outboundRouteId || !input.returnRouteId) throw new Error("请选择无人机和已提交的去返程航线")
  if (!Number.isFinite(input.firstTakeoffTimeMs) || input.firstTakeoffTimeMs < 0 || !Number.isFinite(input.intervalMs) || input.intervalMs <= 0) throw new Error("计划起飞时间或任务间隔无效")

  const createId = input.createId ?? (() => crypto.randomUUID())
  const result = input.items.map((item) => ({ ...item }))
  const sortedOrders = [...input.orders].sort((left, right) => left.releaseTimeMs - right.releaseTimeMs || left.code.localeCompare(right.code))
  let nextTakeoffTimeMs = Math.round(input.firstTakeoffTimeMs)
  for (const order of sortedOrders) {
    const existingIndex = result.findIndex((item) => item.orderId === order.id)
    const plannedTakeoffTimeMs = Math.max(nextTakeoffTimeMs, order.earliestStartTimeMs)
    const assignment: LogisticsScheduleItemInput = {
      id: existingIndex >= 0 ? result[existingIndex]!.id : createId(),
      orderId: order.id,
      aircraftId: input.aircraftId,
      outboundRouteId: input.outboundRouteId,
      returnRouteId: input.returnRouteId,
      plannedTakeoffTimeMs
    }
    if (existingIndex >= 0) result[existingIndex] = assignment
    else result.push(assignment)
    nextTakeoffTimeMs = plannedTakeoffTimeMs + Math.round(input.intervalMs)
  }
  return result
}

export function canMoveLogisticsAircraftTask(
  items: readonly LogisticsScheduleItemInput[],
  itemId: string,
  direction: -1 | 1
): boolean {
  const selected = items.find((item) => item.id === itemId)
  if (!selected) return false
  const queue = aircraftQueue(items, selected.aircraftId)
  const index = queue.findIndex((item) => item.id === itemId)
  return index >= 0 && index + direction >= 0 && index + direction < queue.length
}

export function reorderLogisticsAircraftTask(input: {
  items: readonly LogisticsScheduleItemInput[]
  orders: readonly LogisticsSchedulingOrderView[]
  itemId: string
  direction: -1 | 1
}): LogisticsScheduleItemInput[] {
  const selected = input.items.find((item) => item.id === input.itemId)
  if (!selected) return input.items.map((item) => ({ ...item }))
  const queue = aircraftQueue(input.items, selected.aircraftId)
  const index = queue.findIndex((item) => item.id === input.itemId)
  const adjacent = queue[index + input.direction]
  if (index < 0 || !adjacent) return input.items.map((item) => ({ ...item }))

  const orderMap = new Map(input.orders.map((order) => [order.id, order]))
  ensureSlotAllowed(selected, adjacent.plannedTakeoffTimeMs, orderMap)
  ensureSlotAllowed(adjacent, selected.plannedTakeoffTimeMs, orderMap)

  return input.items.map((item) => {
    if (item.id === selected.id) return { ...item, plannedTakeoffTimeMs: adjacent.plannedTakeoffTimeMs }
    if (item.id === adjacent.id) return { ...item, plannedTakeoffTimeMs: selected.plannedTakeoffTimeMs }
    return { ...item }
  })
}

function aircraftQueue(items: readonly LogisticsScheduleItemInput[], aircraftId: string): LogisticsScheduleItemInput[] {
  return items
    .filter((item) => item.aircraftId === aircraftId)
    .sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs || left.id.localeCompare(right.id))
}

function ensureSlotAllowed(
  item: LogisticsScheduleItemInput,
  plannedTakeoffTimeMs: number,
  orderMap: ReadonlyMap<string, LogisticsSchedulingOrderView>
): void {
  const order = orderMap.get(item.orderId)
  if (order && plannedTakeoffTimeMs < order.earliestStartTimeMs) {
    throw new Error(`${order.code} 的目标时段早于最早执行时间`)
  }
}
