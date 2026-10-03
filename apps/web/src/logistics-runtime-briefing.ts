import type { LogisticsRuntimeEventView, V3StudentRuntimeActionView } from "@wurenji/shared"
import { runtimeEventSource } from "./runtime-event-source"

export interface LogisticsEventBriefing {
  role: string
  request: string
  objective: string
  successCriteria: string
  scoringEvidence: string[]
}

export function logisticsEventBriefing(event: LogisticsRuntimeEventView, recommendedAction: string): LogisticsEventBriefing {
  const role = runtimeEventSource("CITY_LOGISTICS", event.category, event.code)
  const objective = objectives[event.category] ?? "核实运行影响，选择有效动作控制风险并保持配送过程可追溯。"
  return {
    role,
    request: event.detail,
    objective,
    successCriteria: `在处置时限内执行“${recommendedAction}”或其他有效方案，控制事件并说明判断依据。`,
    scoringEvidence: ["响应时效", "动作匹配", "事件控制", "处置说明"]
  }
}

export function logisticsActionBusinessConsequences(action: V3StudentRuntimeActionView | null | undefined): string[] {
  const value = action?.result.businessConsequences
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

export function logisticsActionEvidence(action: V3StudentRuntimeActionView | null | undefined): string[] {
  if (!action) return []
  const result = action.result
  const evidence: string[] = []
  const responseTimeMs = Number(result.responseTimeMs)
  if (Number.isFinite(responseTimeMs)) evidence.push(`响应时效 ${(responseTimeMs / 1_000).toFixed(1)} 秒`)
  if (result.withinDeadline === true) evidence.push("时限判定：达标")
  if (result.withinDeadline === false) evidence.push("时限判定：超时")
  if (result.eventControlled === true) evidence.push("事件控制：成功")
  if (result.eventControlled === false) evidence.push("事件控制：未完成")
  return evidence
}

const objectives: Record<string, string> = {
  WEATHER_ENVIRONMENT: "降低受影响航段和机队的环境暴露，避免风险继续扩大。",
  POSITIONING_NAVIGATION: "保护受影响无人机的导航安全，并建立等待、返航或退出方案。",
  COMMUNICATION_LINK: "降低失联飞行风险，确保无人机进入可监控、可返航或可安全退出状态。",
  AIRCRAFT_DEVICE: "隔离设备故障影响，优先保障航空器和地面区域安全。",
  ROUTE_OPERATION: "隔离异常航线或节点，维持未受影响订单的配送连续性。",
  ORDER_TASK_CHANGE: "更新订单优先级与运力分配，控制取消、插单或节点变化造成的延误。"
}
