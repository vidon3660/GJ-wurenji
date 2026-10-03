import { vtlRuntimeActionCodes, vtlRuntimeEventCategories, type VtlRuntimeActionCode, type VtlRuntimeEventCategory, type V3AlertSeverity, type V3ScenarioEventConfig } from "@wurenji/shared"
import { parseScenarioEventConfig } from "../runtime/scenario-event-rules.js"

export interface VtlEventDefinition {
  code: string
  title: string
  detail: string
  category: VtlRuntimeEventCategory
  severity: V3AlertSeverity
  recommendedActions: VtlRuntimeActionCode[]
  detectionDelayMs: number
  escalationDelayMs: number
}

const definitions: VtlEventDefinition[] = [
  { code: "VTL_WEATHER", title: "巡检区域气象恶化", detail: "局部风场或降水条件恶化，需要评估等待、返航或备降。", category: "WEATHER", severity: "WARNING", recommendedActions: ["HOLD", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"], detectionDelayMs: 4_000, escalationDelayMs: 40_000 },
  { code: "VTL_POSITIONING", title: "巡检区域定位质量下降", detail: "任务区域定位质量下降，需要降低任务风险并保持可退出路径。", category: "POSITIONING", severity: "ERROR", recommendedActions: ["HOLD", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"], detectionDelayMs: 4_000, escalationDelayMs: 30_000 },
  { code: "VTL_COMMUNICATION", title: "广域通信链路异常", detail: "部分航空器通信质量下降，需要控制任务扩展并恢复安全链路。", category: "COMMUNICATION", severity: "ERROR", recommendedActions: ["HOLD", "RETURN_AIRCRAFT", "ADJUST_GROUP"], detectionDelayMs: 5_000, escalationDelayMs: 35_000 },
  { code: "VTL_ENERGY_POWER", title: "能量或动力余度下降", detail: "航空器剩余能量低于任务安全余度，需要返航或备降。", category: "ENERGY_POWER", severity: "CRITICAL", recommendedActions: ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "CANCEL_NOT_STARTED"], detectionDelayMs: 2_000, escalationDelayMs: 20_000 },
  { code: "VTL_DEVICE", title: "航空器设备异常", detail: "单架航空器出现设备状态异常，需要隔离任务并安全退出。", category: "DEVICE", severity: "ERROR", recommendedActions: ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "TRANSFER_TASK"], detectionDelayMs: 3_000, escalationDelayMs: 25_000 },
  { code: "VTL_TRANSITION", title: "模式转换条件异常", detail: "前转换或后转换条件未满足，需要等待、返航或备降。", category: "MODE_TRANSITION", severity: "ERROR", recommendedActions: ["HOLD", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"], detectionDelayMs: 2_000, escalationDelayMs: 25_000 },
  { code: "VTL_ROUTE_AREA", title: "航线或区域条件变化", detail: "任务航段或限制区域发生变化，需要停止进入并调整任务计划。", category: "ROUTE_AREA", severity: "WARNING", recommendedActions: ["HOLD", "TRANSFER_TASK", "ADJUST_GROUP"], detectionDelayMs: 2_000, escalationDelayMs: 40_000 },
  { code: "VTL_TASK_CONDITION", title: "巡检对象条件变化", detail: "任务对象暂时不可执行，需要等待或转移剩余任务。", category: "TASK_CONDITION", severity: "WARNING", recommendedActions: ["HOLD", "TRANSFER_TASK", "CANCEL_NOT_STARTED"], detectionDelayMs: 0, escalationDelayMs: 60_000 }
]

export function vtlEventDefinition(code: string): VtlEventDefinition | null {
  return definitions.find((item) => item.code === code) ?? null
}

export function configuredVtlEvents(value: unknown): Array<VtlEventDefinition & { scenarioConfig: V3ScenarioEventConfig | null }> {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item) => {
    const input = typeof item === "string" ? null : isRecord(item) ? item : null
    const code = typeof item === "string" ? item.trim() : typeof input?.code === "string" ? input.code.trim() : ""
    const definition = vtlEventDefinition(code)
    if (!definition || seen.has(code)) return []
    seen.add(code)
    const scenarioConfig = input ? parseScenarioEventConfig(input, code, "VERTICAL_TAKEOFF") : null
    return [{ ...definition, severity: scenarioConfig?.severity ?? definition.severity, scenarioConfig }]
  })
}

export function vtlEventDefinitions(): VtlEventDefinition[] {
  return definitions.map((item) => ({ ...item, recommendedActions: [...item.recommendedActions] }))
}

export function vtlActionDeadlineSeconds(definition: VtlEventDefinition, configuredValue: unknown): number {
  if (configuredValue !== null && configuredValue !== undefined && Number.isFinite(Number(configuredValue))) {
    return Math.max(0, Number(configuredValue))
  }
  return Math.max(0, definition.escalationDelayMs / 1_000)
}

export { vtlRuntimeActionCodes, vtlRuntimeEventCategories }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
