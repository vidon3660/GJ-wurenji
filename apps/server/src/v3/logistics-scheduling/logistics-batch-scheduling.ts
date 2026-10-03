import { BadRequestException, ConflictException } from "@nestjs/common"
import {
  logisticsBatchScheduleGroups,
  type LogisticsAircraftInstanceView,
  type LogisticsBatchScheduleAdjustmentInput,
  type LogisticsBatchScheduleGroup,
  type LogisticsBatchSchedulingMode,
  type LogisticsScheduleItemInput,
  type LogisticsSchedulingOrderView,
  type LogisticsSchedulingRouteView
} from "@wurenji/shared"
import { normalizeScheduleItems } from "./logistics-scheduling.validation.js"

export interface LogisticsBatchSchedulingContext {
  mode: LogisticsBatchSchedulingMode
  items: readonly LogisticsScheduleItemInput[]
  orders: readonly LogisticsSchedulingOrderView[]
  aircraft: readonly LogisticsAircraftInstanceView[]
  routes: readonly LogisticsSchedulingRouteView[]
}

export function normalizeLogisticsBatchScheduleAdjustment(value: unknown): LogisticsBatchScheduleAdjustmentInput {
  const record = asRecord(value, "批量调度参数")
  const expectedRevision = Number(record.expectedRevision)
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new BadRequestException("调度草稿版本必须为正整数")
  if (!Array.isArray(record.orderIds) || record.orderIds.length < 2 || record.orderIds.length > 100) {
    throw new BadRequestException("批量调整必须选择 2 到 100 个订单")
  }
  const orderIds = [...new Set(record.orderIds.map((item, index) => text(item, 80, `第 ${index + 1} 个订单 ID`)))]
  if (orderIds.length !== record.orderIds.length) throw new BadRequestException("批量调整订单不能重复")

  const groupRecord = asRecord(record.group, "批量选择分组")
  const groupType = text(groupRecord.type, 40, "批量选择分组类型") as LogisticsBatchScheduleGroup
  if (!(logisticsBatchScheduleGroups as readonly string[]).includes(groupType)) throw new BadRequestException("批量选择分组类型无效")
  const groupValue = groupType === "MANUAL" ? "" : text(groupRecord.value, 120, "批量选择分组值")

  const adjustmentRecord = asRecord(record.adjustment, "批量调整内容")
  const aircraftId = optionalText(adjustmentRecord.aircraftId, 80, "目标无人机 ID")
  const outboundRouteId = optionalText(adjustmentRecord.outboundRouteId, 80, "目标去程航线 ID")
  const returnRouteId = optionalText(adjustmentRecord.returnRouteId, 80, "目标返程航线 ID")
  const takeoffShiftMs = adjustmentRecord.takeoffShiftMs === undefined ? undefined : Number(adjustmentRecord.takeoffShiftMs)
  if (takeoffShiftMs !== undefined && (!Number.isInteger(takeoffShiftMs) || takeoffShiftMs < -86_400_000 || takeoffShiftMs > 86_400_000)) {
    throw new BadRequestException("批量起飞时刻偏移必须为正负 24 小时内的整数毫秒")
  }
  if (!aircraftId && !outboundRouteId && !returnRouteId && !takeoffShiftMs) throw new BadRequestException("请至少选择一项批量调整内容")

  return {
    expectedRevision,
    orderIds,
    group: { type: groupType, value: groupValue },
    adjustment: {
      ...(aircraftId ? { aircraftId } : {}),
      ...(outboundRouteId ? { outboundRouteId } : {}),
      ...(returnRouteId ? { returnRouteId } : {}),
      ...(takeoffShiftMs ? { takeoffShiftMs } : {})
    }
  }
}

export function applyLogisticsBatchScheduleAdjustment(
  input: LogisticsBatchScheduleAdjustmentInput,
  context: LogisticsBatchSchedulingContext
): LogisticsScheduleItemInput[] {
  assertGroupAllowed(input.group.type, context.mode)
  const orderMap = new Map(context.orders.map((order) => [order.id, order]))
  const itemsByOrder = new Map<string, LogisticsScheduleItemInput[]>()
  for (const item of context.items) itemsByOrder.set(item.orderId, [...(itemsByOrder.get(item.orderId) ?? []), item])

  const selected = input.orderIds.map((orderId) => {
    const order = orderMap.get(orderId)
    if (!order) throw new BadRequestException(`批量调整包含不存在的订单：${orderId}`)
    const matches = itemsByOrder.get(orderId) ?? []
    if (matches.length === 0) throw new ConflictException(`${order.code} 尚未分配，不能批量调整`)
    if (matches.length > 1) throw new ConflictException(`${order.code} 存在重复调度任务，请先处理硬性冲突`)
    return { order, item: matches[0]! }
  })
  assertSelectionMatchesGroup(selected, input.group.type, input.group.value)
  if (context.mode === "LIMITED" && new Set(selected.map(({ order }) => order.destinationNodeId)).size > 1) {
    throw new ConflictException("当前模板仅支持同一配送点内的有限批量调整")
  }

  const aircraft = input.adjustment.aircraftId
    ? context.aircraft.find((item) => item.id === input.adjustment.aircraftId)
    : undefined
  if (input.adjustment.aircraftId && !aircraft) throw new BadRequestException("目标无人机不存在")
  if (aircraft?.status === "UNAVAILABLE") throw new ConflictException("目标无人机当前不可用")

  const outbound = input.adjustment.outboundRouteId
    ? context.routes.find((item) => item.id === input.adjustment.outboundRouteId)
    : undefined
  const returning = input.adjustment.returnRouteId
    ? context.routes.find((item) => item.id === input.adjustment.returnRouteId)
    : undefined
  if (input.adjustment.outboundRouteId && (!outbound || outbound.route.direction !== "OUTBOUND")) throw new BadRequestException("目标去程航线无效")
  if (input.adjustment.returnRouteId && (!returning || returning.route.direction !== "RETURN")) throw new BadRequestException("目标返程航线无效")
  for (const { order } of selected) {
    if (outbound && outbound.route.destinationNodeId !== order.destinationNodeId) throw new ConflictException(`${order.code} 与目标去程航线配送点不一致`)
    if (returning && returning.route.destinationNodeId !== order.destinationNodeId) throw new ConflictException(`${order.code} 与目标返程航线配送点不一致`)
  }

  const selectedOrderIds = new Set(input.orderIds)
  const shift = input.adjustment.takeoffShiftMs ?? 0
  const result = context.items.map((item) => {
    if (!selectedOrderIds.has(item.orderId)) return { ...item }
    const order = orderMap.get(item.orderId)!
    const plannedTakeoffTimeMs = item.plannedTakeoffTimeMs + shift
    if (plannedTakeoffTimeMs < order.earliestStartTimeMs) throw new ConflictException(`${order.code} 调整后早于最早执行时间`)
    return {
      ...item,
      ...(aircraft ? { aircraftId: aircraft.id } : {}),
      ...(outbound ? { outboundRouteId: outbound.id } : {}),
      ...(returning ? { returnRouteId: returning.id } : {}),
      plannedTakeoffTimeMs
    }
  })
  const changed = result.some((item, index) => JSON.stringify(item) !== JSON.stringify(context.items[index]))
  if (!changed) throw new ConflictException("批量调整没有产生任何变化")
  return normalizeScheduleItems(result)
}

function assertGroupAllowed(group: LogisticsBatchScheduleGroup, mode: LogisticsBatchSchedulingMode): void {
  if (mode === "NONE") throw new ConflictException("当前模板未开放批量调度")
  if (mode === "LIMITED" && group !== "MANUAL" && group !== "DELIVERY_POINT") {
    throw new ConflictException("当前模板仅开放手动多选或按配送点批量调整")
  }
}

function assertSelectionMatchesGroup(
  selected: readonly { order: LogisticsSchedulingOrderView; item: LogisticsScheduleItemInput }[],
  group: LogisticsBatchScheduleGroup,
  value: string
): void {
  if (group === "MANUAL") return
  const matches = selected.every(({ order, item }) => {
    if (group === "DELIVERY_POINT") return order.destinationNodeId === value
    if (group === "PRIORITY") return order.priority === value
    if (group === "OUTBOUND_ROUTE") return item.outboundRouteId === value
    return item.aircraftId === value
  })
  if (!matches) throw new BadRequestException("所选订单与批量分组条件不一致")
}

function optionalText(value: unknown, maximum: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  return text(value, maximum, label)
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new BadRequestException(`${label}不能为空且不能超过 ${maximum} 个字符`)
  return value.trim()
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequestException(`${label}格式无效`)
  return value as Record<string, unknown>
}
