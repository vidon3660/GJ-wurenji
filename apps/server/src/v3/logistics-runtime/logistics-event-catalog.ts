import {
  isLogisticsEventSubtypeAllowed,
  logisticsRuntimeActionCodes,
  logisticsRuntimeEventCategories
} from "@wurenji/shared"
import type {
  LogisticsRuntimeActionCode,
  LogisticsRuntimeEventCategory,
  V3AlertSeverity,
  V3ScenarioEventConfig
} from "@wurenji/shared"
import { parseScenarioEventConfig } from "../runtime/scenario-event-rules.js"

export interface LogisticsEventDefinition {
  code: string
  title: string
  detail: string
  category: LogisticsRuntimeEventCategory
  severity: V3AlertSeverity
  recommendedActions: LogisticsRuntimeActionCode[]
  detectionDelayMs: number
  escalationDelayMs: number
}

const subtypeOverrides: Record<string, Partial<Pick<LogisticsEventDefinition, "title" | "detail" | "severity" | "recommendedActions">>> = {
  BATTERY_CONSUMPTION_ANOMALY: { title: "电池消耗异常", detail: "受影响无人机电量消耗速率异常，需要判断剩余航程并及时返航或备降。", severity: "WARNING", recommendedActions: ["HOLD_POSITION", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"] },
  PROPULSION_ALERT: { title: "动力系统告警", detail: "受影响无人机动力输出异常，继续执行任务可能导致失速或迫降。", severity: "ERROR", recommendedActions: ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "EMERGENCY_LAND_AIRCRAFT"] },
  FLIGHT_CONTROL_ALERT: { title: "飞控系统告警", detail: "受影响无人机飞行控制状态异常，需要立即降低任务风险并选择安全退出方案。", severity: "ERROR", recommendedActions: ["HOLD_POSITION", "DIVERT_AIRCRAFT", "EMERGENCY_LAND_AIRCRAFT"] },
  SENSOR_ALERT: { title: "传感器告警", detail: "受影响无人机关键传感器数据异常，需要评估导航与安全返航能力。", severity: "WARNING", recommendedActions: ["HOLD_POSITION", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"] },
  RETURN_OR_LANDING_UNAVAILABLE: { title: "无法正常返航或降落", detail: "受影响无人机已不具备正常返航或按计划降落条件，需要执行备降或应急迫降。", severity: "CRITICAL", recommendedActions: ["DIVERT_AIRCRAFT", "EMERGENCY_LAND_AIRCRAFT", "ABORT_TASK"] },
  SEGMENT_CONDITION_DETERIORATION: { title: "航段运行条件恶化", detail: "局部航段运行条件持续恶化，需要暂停新任务进入并切换已验证航线。", severity: "WARNING", recommendedActions: ["PAUSE_ROUTE_ENTRY", "PAUSE_ROUTE", "SWITCH_VERIFIED_ROUTE"] },
  ROUTE_SUSPENSION: { title: "航线暂停运行", detail: "指定航线已暂停运行，需要隔离受影响任务并启用替代方案。", severity: "ERROR", recommendedActions: ["PAUSE_ROUTE", "SWITCH_VERIFIED_ROUTE", "REASSIGN_ORDER"] },
  DELIVERY_POINT_STATE_CHANGE: { title: "配送点状态变化", detail: "配送点当前无法按计划接收订单，需要等待、延期或重新分配任务。", severity: "WARNING", recommendedActions: ["HOLD_POSITION", "REASSIGN_ORDER", "DELAY_TASK"] },
  WAITING_POINT_STATE_CHANGE: { title: "等待点状态变化", detail: "计划等待点状态发生变化，受影响无人机需要保持安全间隔或切换航线。", severity: "WARNING", recommendedActions: ["HOLD_POSITION", "SWITCH_VERIFIED_ROUTE", "RETURN_AIRCRAFT"] },
  ALTERNATE_LANDING_POINT_STATE_CHANGE: { title: "备降点状态变化", detail: "计划备降点当前不可用，需要重新选择安全退出路径或返航。", severity: "ERROR", recommendedActions: ["HOLD_POSITION", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"] }
}

export interface ConfiguredLogisticsEvent extends LogisticsEventDefinition {
  scenarioConfig: V3ScenarioEventConfig | null
}

const definitions: LogisticsEventDefinition[] = [
  { code: "WEATHER_CHANGE", title: "局部气象条件恶化", detail: "局部航线风力和阵风接近运行限制。", category: "WEATHER_ENVIRONMENT", severity: "WARNING", recommendedActions: ["REDUCE_SPEED", "HOLD_POSITION", "PAUSE_ROUTE"], detectionDelayMs: 5_000, escalationDelayMs: 45_000 },
  { code: "POSITIONING_DEGRADED", title: "定位导航质量下降", detail: "受影响无人机定位质量下降，需要判断是否等待或安全退出。", category: "POSITIONING_NAVIGATION", severity: "ERROR", recommendedActions: ["HOLD_POSITION", "PROCEED_TO_WAITING_POINT", "RETURN_AIRCRAFT"], detectionDelayMs: 4_000, escalationDelayMs: 30_000 },
  { code: "COMMUNICATION_LOSS", title: "通信链路异常", detail: "受影响无人机状态回传和指令能力下降。", category: "COMMUNICATION_LINK", severity: "ERROR", recommendedActions: ["CONTINUE_MONITORING", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"], detectionDelayMs: 6_000, escalationDelayMs: 35_000 },
  { code: "AIRCRAFT_FAULT", title: "无人机设备故障", detail: "单架无人机出现动力、飞控或传感器异常。", category: "AIRCRAFT_DEVICE", severity: "ERROR", recommendedActions: ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "EMERGENCY_LAND_AIRCRAFT"], detectionDelayMs: 3_000, escalationDelayMs: 25_000 },
  { code: "ROUTE_SUSPENDED", title: "航线运行条件变化", detail: "局部航线需要暂停新任务进入并评估备用方案。", category: "ROUTE_OPERATION", severity: "WARNING", recommendedActions: ["PAUSE_ROUTE_ENTRY", "PAUSE_ROUTE", "SWITCH_VERIFIED_ROUTE"], detectionDelayMs: 2_000, escalationDelayMs: 40_000 },
  { code: "NODE_UNAVAILABLE", title: "配送节点暂不可用", detail: "配送点或运行节点短时不可用，需要调整后续任务。", category: "ROUTE_OPERATION", severity: "WARNING", recommendedActions: ["HOLD_POSITION", "REASSIGN_ORDER", "DELAY_TASK"], detectionDelayMs: 2_000, escalationDelayMs: 40_000 },
  { code: "DYNAMIC_ORDER", title: "动态新增订单", detail: "运行中新增订单进入待分配队列。", category: "ORDER_TASK_CHANGE", severity: "INFO", recommendedActions: ["REASSIGN_ORDER", "CHANGE_PRIORITY"], detectionDelayMs: 0, escalationDelayMs: 60_000 },
  { code: "ORDER_CANCELLED", title: "订单任务取消", detail: "运行中订单取消，需要释放后续运力。", category: "ORDER_TASK_CHANGE", severity: "WARNING", recommendedActions: ["CANCEL_TASK", "REASSIGN_ORDER"], detectionDelayMs: 0, escalationDelayMs: 60_000 },
  { code: "ORDER_PRIORITY_CHANGED", title: "订单优先级变化", detail: "订单优先级在运行中变化，需要重新评估任务顺序。", category: "ORDER_TASK_CHANGE", severity: "INFO", recommendedActions: ["CHANGE_PRIORITY", "REASSIGN_ORDER"], detectionDelayMs: 0, escalationDelayMs: 60_000 }
]

export function logisticsEventDefinition(code: string): LogisticsEventDefinition | null {
  return definitions.find((item) => item.code === code) ?? null
}

export function configuredLogisticsEvents(value: unknown): ConfiguredLogisticsEvent[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((code) => {
    const input = typeof code === "string" ? null : isRecord(code) ? code : null
    const eventCode = typeof code === "string" ? code.trim() : typeof input?.code === "string" ? input.code.trim() : ""
    if (!eventCode || seen.has(eventCode)) return []
    seen.add(eventCode)
    const definition = logisticsEventDefinition(eventCode) ?? resourceLogisticsEventDefinition(input)
    if (!definition) return []
    const scenarioConfig = input ? scenarioEventConfig(input, eventCode) : null
    const subtypeOverride = scenarioConfig?.eventSubtype && isLogisticsEventSubtypeAllowed(eventCode, scenarioConfig.eventSubtype)
      ? subtypeOverrides[scenarioConfig.eventSubtype]
      : undefined
    const configuredDefinition = subtypeOverride ? { ...definition, ...subtypeOverride } : definition
    return [{
      ...configuredDefinition,
      severity: scenarioConfig?.severity ?? configuredDefinition.severity,
      detectionDelayMs: scenarioConfig?.detectionDelaySeconds === null || scenarioConfig?.detectionDelaySeconds === undefined
        ? configuredDefinition.detectionDelayMs
        : scenarioConfig.detectionDelaySeconds * 1_000,
      escalationDelayMs: scenarioConfig?.escalationDelaySeconds === null || scenarioConfig?.escalationDelaySeconds === undefined
        ? configuredDefinition.escalationDelayMs
        : scenarioConfig.escalationDelaySeconds * 1_000,
      recommendedActions: [...configuredDefinition.recommendedActions],
      scenarioConfig
    }]
  })
}

export function logisticsEventDefinitions(): LogisticsEventDefinition[] {
  return definitions.map((item) => ({ ...item, recommendedActions: [...item.recommendedActions] }))
}

function scenarioEventConfig(input: Record<string, unknown>, code: string): V3ScenarioEventConfig {
  const defaults = isRecord(input.defaultScenario) ? input.defaultScenario : {}
  return parseScenarioEventConfig({ ...defaults, ...input }, code, "OUTBOUND")
}

function resourceLogisticsEventDefinition(input: Record<string, unknown> | null): LogisticsEventDefinition | null {
  if (!input || typeof input.code !== "string" || typeof input.title !== "string" || typeof input.category !== "string" || !logisticsRuntimeEventCategories.includes(input.category as LogisticsRuntimeEventCategory) || !isSeverity(input.severity)) return null
  const actions = Array.isArray(input.recommendedActions)
    ? input.recommendedActions.filter((value): value is LogisticsRuntimeActionCode => logisticsRuntimeActionCodes.includes(value as LogisticsRuntimeActionCode))
    : []
  return {
    code: input.code,
    title: input.title,
    detail: typeof input.detail === "string" ? input.detail : input.title,
    category: input.category as LogisticsRuntimeEventCategory,
    severity: input.severity,
    recommendedActions: actions.length > 0 ? actions : ["ACKNOWLEDGE_ALERT"],
    detectionDelayMs: Math.round(finiteNumber(input.detectionDelaySeconds, 0) * 1_000),
    escalationDelayMs: Math.round(finiteNumber(input.escalationDelaySeconds, 60) * 1_000)
  }
}

function isSeverity(value: unknown): value is V3AlertSeverity {
  return value === "INFO" || value === "WARNING" || value === "ERROR" || value === "CRITICAL"
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
