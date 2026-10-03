import {
  showRuntimeActionCodes,
  showRuntimeEventCategories
} from "@wurenji/shared"
import type {
  ShowRuntimeActionCode,
  ShowRuntimeEventCategory,
  V3AlertSeverity,
  V3ScenarioEventConfig
} from "@wurenji/shared"
import { parseScenarioEventConfig } from "../runtime/scenario-event-rules.js"

export interface ShowEventDefinition {
  code: string
  title: string
  detail: string
  category: ShowRuntimeEventCategory
  severity: V3AlertSeverity
  affectedRatio: number
  visibilityDelayMs: number
  escalationDelayMs: number
  recommendedActions: ShowRuntimeActionCode[]
}

export interface ConfiguredShowEvent extends ShowEventDefinition {
  scenarioConfig: V3ScenarioEventConfig | null
}

const definitions: ShowEventDefinition[] = [
  {
    code: "WEATHER_LIMIT",
    title: "风力接近运行限制",
    detail: "表演区域阵风增强，部分编队位置稳定性下降。",
    category: "WEATHER",
    severity: "WARNING",
    affectedRatio: 0.12,
    visibilityDelayMs: 3_000,
    escalationDelayMs: 45_000,
    recommendedActions: ["PAUSE_NEXT_TAKEOFF", "PAUSE_PROGRAM", "RETURN_ALL", "ABORT_PROGRAM"]
  },
  {
    code: "POSITIONING_DRIFT",
    title: "编队定位精度下降",
    detail: "局部定位与电磁环境异常，受影响分组出现位置偏差。",
    category: "POSITIONING_ELECTROMAGNETIC",
    severity: "WARNING",
    affectedRatio: 0.08,
    visibilityDelayMs: 4_000,
    escalationDelayMs: 40_000,
    recommendedActions: ["SINGLE_LAND", "BATCH_LAND", "GROUP_RETURN", "GROUP_LAND", "RETURN_ALL"]
  },
  {
    code: "COMMUNICATION_LOSS",
    title: "通信与控制链路异常",
    detail: "部分无人机状态回传延迟，控制链路质量持续下降。",
    category: "COMMUNICATION_CONTROL",
    severity: "ERROR",
    affectedRatio: 0.06,
    visibilityDelayMs: 6_000,
    escalationDelayMs: 30_000,
    recommendedActions: ["PAUSE_PROGRAM", "GROUP_RETURN", "EMERGENCY_LAND_ALL", "ABORT_PROGRAM"]
  },
  {
    code: "MOTOR_DEGRADATION",
    title: "动力系统性能下降",
    detail: "部分无人机动力输出异常，需要缩小影响范围并安全退出任务。",
    category: "AIRCRAFT_DEVICE",
    severity: "ERROR",
    affectedRatio: 0.03,
    visibilityDelayMs: 2_000,
    escalationDelayMs: 35_000,
    recommendedActions: ["SINGLE_LAND", "BATCH_LAND", "REMOVE_FROM_MISSION", "GROUP_LAND"]
  },
  {
    code: "BATTERY_ANOMALY",
    title: "电池状态异常",
    detail: "部分无人机电池压差扩大，继续运行可能导致返航能力不足。",
    category: "AIRCRAFT_DEVICE",
    severity: "WARNING",
    affectedRatio: 0.04,
    visibilityDelayMs: 2_000,
    escalationDelayMs: 40_000,
    recommendedActions: ["SINGLE_LAND", "BATCH_LAND", "REMOVE_FROM_MISSION", "GROUP_RETURN"]
  }
]

export function showEventDefinition(code: string): ShowEventDefinition | null {
  return definitions.find((item) => item.code === code) ?? null
}

export function showActionDeadlineSeconds(definition: ShowEventDefinition, configuredValue: unknown): number {
  if (configuredValue !== null && configuredValue !== undefined && Number.isFinite(Number(configuredValue))) {
    return Math.max(0, Number(configuredValue))
  }
  return Math.max(0, definition.escalationDelayMs / 1_000)
}

export function configuredShowEvents(codes: unknown): ConfiguredShowEvent[] {
  if (!Array.isArray(codes)) return []
  const seen = new Set<string>()
  return codes.flatMap((value) => {
    const input = typeof value === "string" ? null : isRecord(value) ? value : null
    const code = typeof value === "string" ? value.trim() : typeof input?.code === "string" ? input.code.trim() : ""
    const definition = showEventDefinition(code) ?? resourceShowEventDefinition(input)
    if (!definition || seen.has(code)) return []
    seen.add(code)
    const scenarioConfig = input ? scenarioEventConfig(input, code) : null
    return [{
      ...definition,
      severity: scenarioConfig?.severity ?? definition.severity,
      visibilityDelayMs: scenarioConfig?.detectionDelaySeconds === null || scenarioConfig?.detectionDelaySeconds === undefined
        ? definition.visibilityDelayMs
        : scenarioConfig.detectionDelaySeconds * 1_000,
      escalationDelayMs: scenarioConfig?.escalationDelaySeconds === null || scenarioConfig?.escalationDelaySeconds === undefined
        ? definition.escalationDelayMs
        : scenarioConfig.escalationDelaySeconds * 1_000,
      recommendedActions: [...definition.recommendedActions],
      scenarioConfig
    }]
  })
}

function scenarioEventConfig(input: Record<string, unknown>, code: string): V3ScenarioEventConfig | null {
  const defaults = isRecord(input.defaultScenario) ? input.defaultScenario : {}
  return parseScenarioEventConfig({ ...defaults, ...input }, code, "PERFORMANCE")
}

function resourceShowEventDefinition(input: Record<string, unknown> | null): ShowEventDefinition | null {
  if (!input || typeof input.code !== "string" || typeof input.title !== "string" || typeof input.category !== "string" || !showRuntimeEventCategories.includes(input.category as ShowRuntimeEventCategory) || !isSeverity(input.severity)) return null
  const actions = Array.isArray(input.recommendedActions)
    ? input.recommendedActions.filter((value): value is ShowRuntimeActionCode => showRuntimeActionCodes.includes(value as ShowRuntimeActionCode))
    : []
  return {
    code: input.code,
    title: input.title,
    detail: typeof input.detail === "string" ? input.detail : input.title,
    category: input.category as ShowRuntimeEventCategory,
    severity: input.severity,
    affectedRatio: finiteRatio(input.affectedRatio, 0.05),
    visibilityDelayMs: Math.round(finiteNumber(input.detectionDelaySeconds, 0) * 1_000),
    escalationDelayMs: Math.round(finiteNumber(input.escalationDelaySeconds, 60) * 1_000),
    recommendedActions: actions.length > 0 ? actions : ["PAUSE_PROGRAM"]
  }
}

function isSeverity(value: unknown): value is V3AlertSeverity {
  return value === "INFO" || value === "WARNING" || value === "ERROR" || value === "CRITICAL"
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function finiteRatio(value: unknown, fallback: number): number {
  return Math.min(1, finiteNumber(value, fallback))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function escalateSeverity(value: V3AlertSeverity): V3AlertSeverity {
  if (value === "INFO") return "WARNING"
  if (value === "WARNING") return "ERROR"
  return "CRITICAL"
}
