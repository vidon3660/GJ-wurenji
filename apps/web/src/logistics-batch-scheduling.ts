import type {
  LogisticsBatchScheduleGroup,
  LogisticsScheduleItemInput,
  LogisticsSchedulingOrderView
} from "@wurenji/shared"

export type LogisticsOrderScheduleFilterStatus = "ALL" | "UNASSIGNED" | "SCHEDULED"
export type LogisticsOrderScheduleSort = "LATEST_ARRIVAL" | "RELEASE_TIME" | "PRIORITY"

export interface LogisticsOrderScheduleFilters {
  destinationNodeId: string
  priority: string
  status: LogisticsOrderScheduleFilterStatus
  outboundRouteId: string
  aircraftId: string
  sort: LogisticsOrderScheduleSort
}

export function filterLogisticsScheduleOrders(input: {
  orders: readonly LogisticsSchedulingOrderView[]
  items: readonly LogisticsScheduleItemInput[]
  filters: LogisticsOrderScheduleFilters
}): LogisticsSchedulingOrderView[] {
  const itemMap = new Map(input.items.map((item) => [item.orderId, item]))
  return input.orders.filter((order) => {
    const item = itemMap.get(order.id)
    if (input.filters.destinationNodeId && order.destinationNodeId !== input.filters.destinationNodeId) return false
    if (input.filters.priority && order.priority !== input.filters.priority) return false
    if (input.filters.status === "UNASSIGNED" && item) return false
    if (input.filters.status === "SCHEDULED" && !item) return false
    if (input.filters.outboundRouteId && item?.outboundRouteId !== input.filters.outboundRouteId) return false
    if (input.filters.aircraftId && item?.aircraftId !== input.filters.aircraftId) return false
    return true
  }).sort((left, right) => compareOrders(left, right, input.filters.sort))
}

export function logisticsBatchGroupOrderIds(input: {
  group: LogisticsBatchScheduleGroup
  value: string
  orders: readonly LogisticsSchedulingOrderView[]
  items: readonly LogisticsScheduleItemInput[]
}): string[] {
  const itemMap = new Map(input.items.map((item) => [item.orderId, item]))
  return input.orders.filter((order) => {
    const item = itemMap.get(order.id)
    if (!item) return false
    if (input.group === "MANUAL") return false
    if (input.group === "DELIVERY_POINT") return order.destinationNodeId === input.value
    if (input.group === "PRIORITY") return order.priority === input.value
    if (input.group === "OUTBOUND_ROUTE") return item.outboundRouteId === input.value
    return item.aircraftId === input.value
  }).map((order) => order.id)
}

function compareOrders(
  left: LogisticsSchedulingOrderView,
  right: LogisticsSchedulingOrderView,
  sort: LogisticsOrderScheduleSort
): number {
  if (sort === "RELEASE_TIME") return left.releaseTimeMs - right.releaseTimeMs || left.code.localeCompare(right.code)
  if (sort === "PRIORITY") return priorityRank(left.priority) - priorityRank(right.priority) || left.latestArrivalTimeMs - right.latestArrivalTimeMs || left.code.localeCompare(right.code)
  return left.latestArrivalTimeMs - right.latestArrivalTimeMs || priorityRank(left.priority) - priorityRank(right.priority) || left.code.localeCompare(right.code)
}

function priorityRank(value: LogisticsSchedulingOrderView["priority"]): number {
  return value === "URGENT" ? 0 : value === "PRIORITY" ? 1 : 2
}
