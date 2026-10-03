import type {
  LogisticsRuntimeAircraftView,
  LogisticsRuntimeEnvironmentView,
  LogisticsRuntimeOrderView,
  LogisticsRuntimeRouteView,
  LogisticsRuntimeTaskView,
  V3RegionCatalogItem
} from "@wurenji/shared"

export interface LogisticsRuntimeMonitorSource {
  aircraft: Pick<LogisticsRuntimeAircraftView, "position" | "speedMps" | "batteryPercent"> | null | undefined
  task: Pick<LogisticsRuntimeTaskView, "status"> | null | undefined
  route: Pick<LogisticsRuntimeRouteView, "name" | "direction" | "status"> | null | undefined
  order: Pick<LogisticsRuntimeOrderView, "code" | "status"> | null | undefined
  environment: LogisticsRuntimeEnvironmentView | null | undefined
}

export interface LogisticsRuntimeMonitorMetric {
  code: "POSITION" | "ROUTE" | "TASK_STAGE" | "SPEED" | "BATTERY" | "POSITIONING" | "COMMUNICATION" | "EQUIPMENT" | "ORDER" | "ENVIRONMENT"
  label: string
  value: string
  tone: "neutral" | "normal" | "warning" | "danger"
}

type SortableLogisticsRuntimeTask = Pick<LogisticsRuntimeTaskView, "plannedTakeoffTimeMs" | "orderCode" | "scheduleItemId">

export function sortLogisticsRuntimeTasks<Task extends SortableLogisticsRuntimeTask>(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((left, right) => (
    left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs
    || left.orderCode.localeCompare(right.orderCode, "zh-CN")
    || left.scheduleItemId.localeCompare(right.scheduleItemId)
  ))
}

export function logisticsDestinationLabel(region: V3RegionCatalogItem | null | undefined, nodeId: string): string {
  return region?.logisticsNodes?.find((node) => node.id === nodeId)?.name ?? nodeId
}

export interface LogisticsTaskTimingPresentation {
  windowLabel: string
  executionLabel: string
  tone: "neutral" | "normal" | "warning" | "danger"
}

export function logisticsTaskTimingPresentation(input: {
  task: Pick<LogisticsRuntimeTaskView, "status" | "plannedTakeoffTimeMs">
  order: Pick<LogisticsRuntimeOrderView, "status" | "releaseTimeMs" | "latestArrivalTimeMs">
  aircraft: Pick<LogisticsRuntimeAircraftView, "status" | "nextAvailableTimeMs">
  route: Pick<LogisticsRuntimeRouteView, "status"> | null | undefined
  simulationTimeMs: number
  sessionStatus: string
}): LogisticsTaskTimingPresentation {
  const windowLabel = `${relativeTime(input.order.releaseTimeMs)} - ${relativeTime(input.order.latestArrivalTimeMs)}`
  if (input.task.status === "FAILED") return { windowLabel, executionLabel: "任务失败，原因待运行记录确认", tone: "danger" }
  if (input.task.status === "CANCELLED") return { windowLabel, executionLabel: "任务已取消，原因待运行记录确认", tone: "danger" }
  if (input.task.status === "AVAILABLE_AGAIN") return { windowLabel, executionLabel: "任务已完成", tone: "normal" }
  if (input.task.status !== "WAITING_EXECUTION") return { windowLabel, executionLabel: "任务执行中", tone: "normal" }
  if (input.order.status === "EXPECTED_DELAY") return { windowLabel, executionLabel: "预计超过最晚送达时刻", tone: "warning" }
  if (input.route?.status === "CLOSED") return { windowLabel, executionLabel: "航线已关闭，等待重新调度", tone: "danger" }
  if (input.route?.status === "ABNORMAL" || input.route?.status === "PAUSED") return { windowLabel, executionLabel: "航线不可用，等待恢复或改派", tone: "warning" }
  if (input.aircraft.status === "DISABLED") return { windowLabel, executionLabel: "航空器不可用，等待改派", tone: "danger" }
  if (input.sessionStatus === "PAUSED") return { windowLabel, executionLabel: "仿真已暂停", tone: "warning" }
  if (input.order.releaseTimeMs > input.simulationTimeMs) return { windowLabel, executionLabel: "订单尚未释放", tone: "neutral" }
  if (input.aircraft.nextAvailableTimeMs > input.simulationTimeMs && input.task.plannedTakeoffTimeMs <= input.aircraft.nextAvailableTimeMs) return { windowLabel, executionLabel: "等待航空器可用", tone: "neutral" }
  if (input.task.plannedTakeoffTimeMs > input.simulationTimeMs) return { windowLabel, executionLabel: "等待计划起飞", tone: "neutral" }
  return { windowLabel, executionLabel: "待运行状态推进", tone: "neutral" }
}

function relativeTime(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1000))
  const hours = Math.floor(totalSeconds / 3600).toString().padStart(2, "0")
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0")
  const seconds = (totalSeconds % 60).toString().padStart(2, "0")
  return `T+${hours}:${minutes}:${seconds}`
}

export function logisticsRuntimeMonitorMetrics(source: LogisticsRuntimeMonitorSource): LogisticsRuntimeMonitorMetric[] {
  return [
    { code: "POSITION", label: "无人机位置", value: coordinateLabel(source.aircraft?.position), tone: "neutral" },
    { code: "ROUTE", label: "航线", value: routeLabel(source.route), tone: routeTone(source.route?.status) },
    { code: "TASK_STAGE", label: "任务阶段", value: taskStatusLabel(source.task?.status), tone: taskTone(source.task?.status) },
    { code: "SPEED", label: "速度", value: speedLabel(source.aircraft?.speedMps), tone: "neutral" },
    { code: "BATTERY", label: "电量", value: batteryLabel(source.aircraft?.batteryPercent), tone: batteryTone(source.aircraft?.batteryPercent) },
    { code: "POSITIONING", label: "定位", value: qualityLabel(source.environment?.positioningQuality), tone: qualityTone(source.environment?.positioningQuality) },
    { code: "COMMUNICATION", label: "通信", value: qualityLabel(source.environment?.communicationQuality), tone: qualityTone(source.environment?.communicationQuality) },
    { code: "EQUIPMENT", label: "设备", value: equipmentLabel(source.environment?.equipmentState), tone: equipmentTone(source.environment?.equipmentState) },
    { code: "ORDER", label: "订单", value: orderLabel(source.order), tone: orderTone(source.order?.status) },
    { code: "ENVIRONMENT", label: "环境状态", value: environmentLabel(source.environment), tone: environmentTone(source.environment) }
  ]
}

function coordinateLabel(position: LogisticsRuntimeAircraftView["position"] | undefined): string {
  if (!position) return "--"
  const altitude = position.altitudeMeters === undefined ? "高度 --" : `高度 ${position.altitudeMeters.toFixed(1)} m`
  return `${position.longitude.toFixed(6)}, ${position.latitude.toFixed(6)} · ${altitude}`
}

function speedLabel(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? "--" : `${value.toFixed(1)} m/s`
}

function routeLabel(route: LogisticsRuntimeMonitorSource["route"]): string {
  if (!route) return "待进入航线"
  const direction = route.direction === "OUTBOUND" ? "去程" : "返程"
  return `${route.name} · ${direction} · ${routeStatusLabel(route.status)}`
}

function routeStatusLabel(value: LogisticsRuntimeRouteView["status"]): string {
  return ({ AVAILABLE: "可用", RISK: "风险", PAUSED: "暂停", ABNORMAL: "异常", RECOVERING: "恢复中", CLOSED: "关闭" } as const)[value]
}

function routeTone(value: LogisticsRuntimeRouteView["status"] | undefined): LogisticsRuntimeMonitorMetric["tone"] {
  if (value === "ABNORMAL" || value === "CLOSED") return "danger"
  if (value === "RISK" || value === "PAUSED" || value === "RECOVERING") return "warning"
  return value ? "normal" : "neutral"
}

function taskStatusLabel(value: LogisticsRuntimeTaskView["status"] | undefined): string {
  if (!value) return "无执行任务"
  return ({ WAITING_EXECUTION: "待执行", TAKEOFF: "起飞", OUTBOUND: "去程飞行", ARRIVAL_CONFIRMATION: "到达确认", RETURNING: "返程飞行", LANDING: "降落", AVAILABLE_AGAIN: "再次可用", CANCELLED: "已取消", FAILED: "失败" } as const)[value]
}

function taskTone(value: LogisticsRuntimeTaskView["status"] | undefined): LogisticsRuntimeMonitorMetric["tone"] {
  if (value === "FAILED" || value === "CANCELLED") return "danger"
  return value ? "normal" : "neutral"
}

function batteryLabel(value: number | undefined): string {
  return value === undefined ? "--" : `${Math.round(value)}%`
}

function batteryTone(value: number | undefined): LogisticsRuntimeMonitorMetric["tone"] {
  if (value === undefined) return "neutral"
  if (value < 20) return "danger"
  if (value < 35) return "warning"
  return "normal"
}

function qualityLabel(value: LogisticsRuntimeEnvironmentView["positioningQuality"] | undefined): string {
  return value ? ({ GOOD: "良好", DEGRADED: "降级", LOST: "丢失" } as const)[value] : "--"
}

function qualityTone(value: LogisticsRuntimeEnvironmentView["positioningQuality"] | undefined): LogisticsRuntimeMonitorMetric["tone"] {
  if (!value) return "neutral"
  return ({ GOOD: "normal", DEGRADED: "warning", LOST: "danger" } as const)[value]
}

function equipmentLabel(value: LogisticsRuntimeEnvironmentView["equipmentState"] | undefined): string {
  return value ? ({ NORMAL: "正常", WARNING: "告警", FAULT: "故障" } as const)[value] : "--"
}

function equipmentTone(value: LogisticsRuntimeEnvironmentView["equipmentState"] | undefined): LogisticsRuntimeMonitorMetric["tone"] {
  if (value === "FAULT") return "danger"
  if (value === "WARNING") return "warning"
  return value ? "normal" : "neutral"
}

function orderLabel(order: LogisticsRuntimeMonitorSource["order"]): string {
  return order ? `${order.code} · ${orderStatusLabel(order.status)}` : "无关联订单"
}

function orderStatusLabel(value: LogisticsRuntimeOrderView["status"]): string {
  return ({ UNRELEASED: "未释放", UNASSIGNED: "待分配", SCHEDULED: "待执行", DELIVERING: "配送中", COMPLETED: "已完成", EXPECTED_DELAY: "预计延误", DELAYED: "已延误", FAILED: "失败", CANCELLED: "已取消" } as const)[value]
}

function orderTone(value: LogisticsRuntimeOrderView["status"] | undefined): LogisticsRuntimeMonitorMetric["tone"] {
  if (value === "FAILED" || value === "CANCELLED") return "danger"
  if (value === "EXPECTED_DELAY" || value === "DELAYED") return "warning"
  return value ? "normal" : "neutral"
}

function environmentLabel(environment: LogisticsRuntimeEnvironmentView | null | undefined): string {
  if (!environment) return "--"
  return `${windDirectionLabel(environment.windDirection)}风 · ${windStateLabel(environment.windState)} · 阵风${gustStateLabel(environment.gustState)} · 降雨${rainStateLabel(environment.rainState)}`
}

function windDirectionLabel(value: LogisticsRuntimeEnvironmentView["windDirection"]): string {
  return ({ N: "北", NE: "东北", E: "东", SE: "东南", S: "南", SW: "西南", W: "西", NW: "西北" } as const)[value]
}

function windStateLabel(value: LogisticsRuntimeEnvironmentView["windState"]): string {
  return ({ NORMAL: "正常", NEAR_LIMIT: "近限制", OVER_LIMIT: "超限" } as const)[value]
}

function gustStateLabel(value: LogisticsRuntimeEnvironmentView["gustState"]): string {
  return ({ NONE: "无", OCCASIONAL: "偶发", CONTINUOUS: "持续" } as const)[value]
}

function rainStateLabel(value: LogisticsRuntimeEnvironmentView["rainState"]): string {
  return ({ NONE: "无", BELOW_LIMIT: "限制内", OVER_LIMIT: "超限" } as const)[value]
}

function environmentTone(environment: LogisticsRuntimeEnvironmentView | null | undefined): LogisticsRuntimeMonitorMetric["tone"] {
  if (!environment) return "neutral"
  if (environment.windState === "OVER_LIMIT" || environment.rainState === "OVER_LIMIT" || environment.operationState === "SUSPENDED") return "danger"
  if (environment.windState === "NEAR_LIMIT" || environment.gustState !== "NONE" || environment.operationState === "RESTRICTED") return "warning"
  return "normal"
}
