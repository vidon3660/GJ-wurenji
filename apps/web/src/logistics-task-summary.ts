import {
  logisticsEventSubtypeLabel,
  logisticsTemplatePolicy,
  resolveLogisticsInitialEnvironment,
  resolveLogisticsInitialFleet,
  resolveLogisticsTimeWindowProfile
} from "@wurenji/shared"
import type { AssignmentDraftConfig, LearningMode, V3RegionCatalogItem } from "@wurenji/shared"

export interface LogisticsTaskSummary {
  projectBackground: string
  taskBrief: string
  completionRequirements: string
  mode: string
  fleetTemplate: string
  centerAirport: string
  candidateDeliveryPoints: string[]
  plannedStartAt: string
  plannedEndAt: string
  orderCount: number
  releaseMode: string
  priorityProfile: string
  deliveryDistributionMode: string
  timeWindow: string
  initialAircraftState: string
  weatherState: string
  positioningState: string
  communicationState: string
  scenarioEvents: string[]
}

export function logisticsTaskSummary(
  config: AssignmentDraftConfig,
  mode: LearningMode,
  region: V3RegionCatalogItem | null | undefined
): LogisticsTaskSummary {
  const scenario = config.scenario
  const policy = logisticsTemplatePolicy(config.scaleTemplateCode)
  const parameters = config.logisticsParameters ?? {
    projectBackground: config.taskBrief,
    completionRequirements: config.taskBrief,
    plannedStartAt: config.availableAt,
    plannedEndAt: config.dueAt
  }
  const enabledDeliveryPoints = (region?.logisticsNodes ?? []).filter((node) => node.type === "DELIVERY_POINT" && node.enabled)
  const deliveryPointNames = new Map(enabledDeliveryPoints.map((node) => [node.id, node.name]))
  const configuredCandidateIds = stringArray(scenario.candidateDeliveryPointIds)
  const candidateIds = configuredCandidateIds.length > 0 ? configuredCandidateIds : enabledDeliveryPoints.map((node) => node.id)
  const initialFleet = resolveLogisticsInitialFleet(scenario, policy.totalAircraft)
  const initialEnvironment = resolveLogisticsInitialEnvironment(scenario)

  return {
    projectBackground: parameters.projectBackground,
    taskBrief: config.taskBrief,
    completionRequirements: parameters.completionRequirements,
    mode: mode === "TRAINING" ? "训练模式" : "考核模式",
    fleetTemplate: `${policy.totalAircraft} 架物流机群（${config.scaleTemplateCode}）`,
    centerAirport: (region?.logisticsNodes ?? []).find((node) => node.type === "CENTER_AIRPORT" && node.enabled)?.name ?? "中心机场资源未命名",
    candidateDeliveryPoints: candidateIds.map((id) => deliveryPointNames.get(id) ?? id),
    plannedStartAt: parameters.plannedStartAt,
    plannedEndAt: parameters.plannedEndAt,
    orderCount: count(scenario.orderCount, policy.defaultOrderCount),
    releaseMode: releaseModeLabel(scenario.orderReleaseMode, scenario.orderReleasePhase),
    priorityProfile: priorityProfileLabel(scenario.priorityProfile ?? policy.defaultPriorityProfile),
    deliveryDistributionMode: distributionModeLabel(scenario.deliveryDistributionMode),
    timeWindow: timeWindowLabel(resolveLogisticsTimeWindowProfile(scenario)),
    initialAircraftState: `可用 ${initialFleet.readyAircraftCount} 架 · 待用 ${initialFleet.standbyAircraftCount} 架 · 低电量 ${initialFleet.lowBatteryAircraftCount} 架 · 飞前异常 ${initialFleet.preflightAbnormalAircraftCount} 架 · 不可用 ${initialFleet.unavailableAircraftCount} 架`,
    weatherState: `${windDirectionLabel(initialEnvironment.windDirection)} · 风力${environmentLabel(initialEnvironment.windForceState)} · 阵风${environmentLabel(initialEnvironment.gustState)} · 降雨${environmentLabel(initialEnvironment.rainState)}`,
    positioningState: signalLabel(initialEnvironment.positioningState),
    communicationState: signalLabel(initialEnvironment.communicationState),
    scenarioEvents: scenarioEventLabels(scenario)
  }
}

function scenarioEventLabels(scenario: Record<string, unknown>): string[] {
  const configs = Array.isArray(scenario.eventConfigs) ? scenario.eventConfigs : []
  if (configs.length > 0) return configs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return []
    const record = value as Record<string, unknown>
    return [logisticsEventSubtypeLabel(record.eventSubtype) ?? eventCodeLabel(record.code)]
  })
  return stringArray(scenario.eventCodes).map(eventCodeLabel)
}

function eventCodeLabel(value: unknown): string {
  const code = String(value ?? "")
  return ({ WEATHER_CHANGE: "局地天气变化", POSITIONING_DEGRADED: "定位导航质量下降", COMMUNICATION_LOSS: "通信链路中断", AIRCRAFT_FAULT: "无人机设备故障", ROUTE_SUSPENDED: "航线运行条件变化", NODE_UNAVAILABLE: "配送节点不可用", DYNAMIC_ORDER: "动态新增订单", ORDER_CANCELLED: "订单取消", ORDER_PRIORITY_CHANGED: "订单优先级变化" } as Record<string, string>)[code] ?? code
}

function releaseModeLabel(value: unknown, phase: unknown): string {
  const mode = String(value ?? "BATCH")
  if (mode === "AT_PHASE") return `指定阶段释放（${releasePhaseLabel(phase)}）`
  return ({ BATCH: "一次性释放", STAGED: "分批释放", DYNAMIC: "运行中动态新增" } as Record<string, string>)[mode] ?? mode
}

function releasePhaseLabel(value: unknown): string {
  return ({ PREPARATION: "运行前准备", WAITING_EXECUTION: "等待执行", TAKEOFF: "起飞", OUTBOUND: "去程", ARRIVAL_CONFIRMATION: "到达确认", RETURNING: "返程", LANDING: "降落" } as Record<string, string>)[String(value ?? "WAITING_EXECUTION")] ?? String(value)
}

function priorityProfileLabel(value: unknown): string {
  return ({ BALANCED: "优先级均衡", URGENT_HEAVY: "高优先级偏多", STANDARD_HEAVY: "普通订单为主" } as Record<string, string>)[String(value ?? "BALANCED")] ?? String(value)
}

function distributionModeLabel(value: unknown): string {
  return ({ UNIFORM: "均匀分布", FOCUSED: "重点区域集中", MULTI_PEAK: "多点高峰" } as Record<string, string>)[String(value ?? "UNIFORM")] ?? String(value)
}

function timeWindowLabel(value: string): string {
  return ({ NONE: "不设明确时限", RELAXED: "宽松", NORMAL: "一般", TIGHT: "紧张", MIXED: "混合时间窗口" } as Record<string, string>)[value] ?? value
}

function windDirectionLabel(value: string): string {
  return ({ N: "北风", NE: "东北风", E: "东风", SE: "东南风", S: "南风", SW: "西南风", W: "西风", NW: "西北风" } as Record<string, string>)[value] ?? value
}

function environmentLabel(value: string): string {
  return ({ CALM: "平静", NORMAL: "正常", NEAR_LIMIT: "接近限制", OVER_LIMIT: "超限", NONE: "无", OCCASIONAL: "偶发", CONTINUOUS: "持续", BELOW_LIMIT: "阈值内" } as Record<string, string>)[value] ?? value
}

function signalLabel(value: string): string {
  return ({ NORMAL: "正常", LOCAL_WEAK: "局部较弱", LOCAL_ABNORMAL: "局部异常", CONTINUOUS_ABNORMAL: "持续异常", RECOVERING: "恢复中" } as Record<string, string>)[value] ?? value
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function count(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}
