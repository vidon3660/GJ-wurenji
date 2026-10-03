import type { LogisticsSchedulingOrderStatus, LogisticsSchedulingOrderView } from "@wurenji/shared"

export interface LogisticsOrderPoolRow {
  id: string
  code: string
  destinationNodeId: string
  priority: LogisticsSchedulingOrderView["priority"]
  releaseTimeMs: number
  earliestStartTimeMs: number
  latestArrivalTimeMs: number
  status: LogisticsSchedulingOrderStatus
}

export function logisticsOrderPoolRows(orders: LogisticsSchedulingOrderView[]): LogisticsOrderPoolRow[] {
  return orders.map((order) => ({
    id: order.id,
    code: order.code,
    destinationNodeId: order.destinationNodeId,
    priority: order.priority,
    releaseTimeMs: order.releaseTimeMs,
    earliestStartTimeMs: order.earliestStartTimeMs,
    latestArrivalTimeMs: order.latestArrivalTimeMs,
    status: order.status
  }))
}

export function logisticsOrderStatusLabel(status: LogisticsSchedulingOrderStatus): string {
  return ({
    UNRELEASED: "未释放",
    UNASSIGNED: "待分配",
    SCHEDULED: "已排程"
  } as const)[status]
}
