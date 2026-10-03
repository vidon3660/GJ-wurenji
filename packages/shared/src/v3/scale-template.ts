import type { SceneType } from "../types.js"
import type {
  LogisticsOrderReleaseMode,
  LogisticsOrderReleasePhase,
  LogisticsPriorityProfile,
  V3ScaleTemplateCatalogItem,
  V3ScenarioEventImpactScope,
  V3ScenarioEventTriggerMode
} from "./types.js"
import { logisticsEventSubtypesForCode, type LogisticsScenarioEventSubtype } from "./logistics-event-subtypes.js"
import { showTemplatePolicyForAircraftCount } from "./show-template-policy.js"
import { vtlTemplatePolicyForAircraftCount } from "./vtl-template-policy.js"
import { isSupportedShowScaleTemplateCode } from "./show-initial-conditions.js"

export interface LogisticsTemplatePolicy {
  totalAircraft: number
  deliveryPointRange: { minimum: number; maximum: number }
  orderCountRange: { minimum: number; maximum: number }
  defaultOrderCount: number
  allowedReleaseModes: readonly LogisticsOrderReleaseMode[]
  allowedReleasePhases: readonly LogisticsOrderReleasePhase[]
  allowedPriorityProfiles: readonly LogisticsPriorityProfile[]
  defaultPriorityProfile: LogisticsPriorityProfile
  strictSerialOperation: boolean
  eventLevel: "NONE" | "PREFLIGHT_ONLY" | "LIGHTWEIGHT" | "SINGLE_TECHNICAL" | "COMPOSITE"
  allowedEventCodes: readonly string[]
  allowedEventSubtypes: readonly LogisticsScenarioEventSubtype[]
  eventCountRange: { minimum: number; maximum: number }
  maximumConcurrentEvents: number
  allowedImpactScopes: readonly V3ScenarioEventImpactScope[]
  allowedTriggerModes: readonly V3ScenarioEventTriggerMode[]
  escalationEnabled: boolean
  eventLinksEnabled: boolean
  partialVisibilityEnabled: boolean
  learningStageLabel: string
  eventLevelLabel: string
  parallelOperationLabel: string
  expectedDeliverables: readonly string[]
  batchSchedulingMode: "NONE" | "LIMITED" | "FULL"
  batchReschedulingEnabled: boolean
  globalReschedulingEnabled: boolean
}

export function logisticsTemplatePolicy(scaleTemplateCode: string): LogisticsTemplatePolicy {
  const count = Number(scaleTemplateCode.match(/(\d+)$/)?.[1] ?? 3)
  return logisticsTemplatePolicyForAircraftCount(count)
}

export function logisticsTemplatePolicyForAircraftCount(count: number): LogisticsTemplatePolicy {
  const common = {
    allowedReleasePhases: ["PREPARATION", "WAITING_EXECUTION", "TAKEOFF", "OUTBOUND", "ARRIVAL_CONFIRMATION", "RETURNING", "LANDING"] as const,
    allowedTriggerModes: ["AUTO", "SIMULATION_TIME", "PHASE", "TIME_RANGE", "CONDITION", "AFTER_EVENT"] as const,
    expectedDeliverables: ["区域分析", "往返航线方案", "订单调度表", "运行处置记录", "项目复盘"] as const
  }
  if (count >= 50) return {
    ...common,
    totalAircraft: 50,
    deliveryPointRange: { minimum: 8, maximum: 12 },
    orderCountRange: { minimum: 50, maximum: 100 },
    defaultOrderCount: 75,
    allowedReleaseModes: ["BATCH", "STAGED", "DYNAMIC", "AT_PHASE"],
    allowedPriorityProfiles: ["STANDARD_HEAVY", "BALANCED", "URGENT_HEAVY"],
    defaultPriorityProfile: "BALANCED",
    strictSerialOperation: false,
    eventLevel: "COMPOSITE",
    allowedEventCodes: ["WEATHER_CHANGE", "POSITIONING_DEGRADED", "COMMUNICATION_LOSS", "AIRCRAFT_FAULT", "ROUTE_SUSPENDED", "NODE_UNAVAILABLE", "DYNAMIC_ORDER", "ORDER_CANCELLED", "ORDER_PRIORITY_CHANGED"],
    allowedEventSubtypes: logisticsEventSubtypesForCode("AIRCRAFT_FAULT").concat(logisticsEventSubtypesForCode("ROUTE_SUSPENDED"), logisticsEventSubtypesForCode("NODE_UNAVAILABLE")),
    eventCountRange: { minimum: 2, maximum: 4 },
    maximumConcurrentEvents: 3,
    allowedImpactScopes: ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP", "LOCAL_AREA", "SINGLE_ROUTE", "MULTI_ROUTE", "OVERALL"],
    escalationEnabled: true,
    eventLinksEnabled: true,
    partialVisibilityEnabled: true,
    learningStageLabel: "综合应急处理",
    eventLevelLabel: "多事件与复合事件",
    parallelOperationLabel: "高并发运行",
    batchSchedulingMode: "FULL",
    batchReschedulingEnabled: true,
    globalReschedulingEnabled: true
  }
  if (count >= 20) return {
    ...common,
    totalAircraft: 20,
    deliveryPointRange: { minimum: 6, maximum: 8 },
    orderCountRange: { minimum: 20, maximum: 40 },
    defaultOrderCount: 30,
    allowedReleaseModes: ["BATCH", "STAGED", "DYNAMIC", "AT_PHASE"],
    allowedPriorityProfiles: ["STANDARD_HEAVY", "BALANCED", "URGENT_HEAVY"],
    defaultPriorityProfile: "BALANCED",
    strictSerialOperation: false,
    eventLevel: "SINGLE_TECHNICAL",
    allowedEventCodes: ["WEATHER_CHANGE", "POSITIONING_DEGRADED", "COMMUNICATION_LOSS", "AIRCRAFT_FAULT", "ROUTE_SUSPENDED", "DYNAMIC_ORDER", "ORDER_CANCELLED", "ORDER_PRIORITY_CHANGED"],
    allowedEventSubtypes: logisticsEventSubtypesForCode("AIRCRAFT_FAULT").concat(logisticsEventSubtypesForCode("ROUTE_SUSPENDED")),
    eventCountRange: { minimum: 0, maximum: 1 },
    maximumConcurrentEvents: 1,
    allowedImpactScopes: ["DEFAULT", "SINGLE", "SMALL_BATCH", "LOCAL_AREA", "SINGLE_ROUTE"],
    escalationEnabled: true,
    eventLinksEnabled: false,
    partialVisibilityEnabled: false,
    learningStageLabel: "批量订单与动态调度",
    eventLevelLabel: "单一技术或局部航线事件",
    parallelOperationLabel: "批量并行调度",
    batchSchedulingMode: "FULL",
    batchReschedulingEnabled: true,
    globalReschedulingEnabled: false
  }
  if (count >= 10) return {
    ...common,
    totalAircraft: 10,
    deliveryPointRange: { minimum: 4, maximum: 6 },
    orderCountRange: { minimum: 10, maximum: 20 },
    defaultOrderCount: 15,
    allowedReleaseModes: ["BATCH", "STAGED", "DYNAMIC", "AT_PHASE"],
    allowedPriorityProfiles: ["STANDARD_HEAVY", "BALANCED"],
    defaultPriorityProfile: "BALANCED",
    strictSerialOperation: false,
    eventLevel: "LIGHTWEIGHT",
    allowedEventCodes: ["DYNAMIC_ORDER", "ORDER_CANCELLED", "ORDER_PRIORITY_CHANGED"],
    allowedEventSubtypes: [],
    eventCountRange: { minimum: 0, maximum: 1 },
    maximumConcurrentEvents: 1,
    allowedImpactScopes: ["DEFAULT", "SINGLE"],
    allowedTriggerModes: ["AUTO", "SIMULATION_TIME", "PHASE", "TIME_RANGE", "CONDITION"],
    escalationEnabled: false,
    eventLinksEnabled: false,
    partialVisibilityEnabled: false,
    learningStageLabel: "多航线多订单基础调度",
    eventLevelLabel: "动态订单与轻量任务变化",
    parallelOperationLabel: "多机并行",
    batchSchedulingMode: "LIMITED",
    batchReschedulingEnabled: false,
    globalReschedulingEnabled: false
  }
  if (count >= 5) return {
    ...common,
    totalAircraft: 5,
    deliveryPointRange: { minimum: 2, maximum: 3 },
    orderCountRange: { minimum: 6, maximum: 10 },
    defaultOrderCount: 8,
    allowedReleaseModes: ["BATCH", "STAGED", "AT_PHASE"],
    allowedPriorityProfiles: ["STANDARD_HEAVY", "BALANCED"],
    defaultPriorityProfile: "STANDARD_HEAVY",
    strictSerialOperation: false,
    eventLevel: "PREFLIGHT_ONLY",
    allowedEventCodes: [],
    allowedEventSubtypes: [],
    eventCountRange: { minimum: 0, maximum: 0 },
    maximumConcurrentEvents: 0,
    allowedImpactScopes: [],
    escalationEnabled: false,
    eventLinksEnabled: false,
    partialVisibilityEnabled: false,
    learningStageLabel: "多航线规划",
    eventLevelLabel: "仅飞前条件，不注入运行事件",
    parallelOperationLabel: "基础多机协同",
    batchSchedulingMode: "NONE",
    batchReschedulingEnabled: false,
    globalReschedulingEnabled: false
  }
  return {
    ...common,
    totalAircraft: 3,
    deliveryPointRange: { minimum: 1, maximum: 1 },
    orderCountRange: { minimum: 3, maximum: 6 },
    defaultOrderCount: 3,
    allowedReleaseModes: ["BATCH"],
    allowedReleasePhases: [],
    allowedPriorityProfiles: ["STANDARD_HEAVY"],
    defaultPriorityProfile: "STANDARD_HEAVY",
    strictSerialOperation: true,
    eventLevel: "NONE",
    allowedEventCodes: [],
    allowedEventSubtypes: [],
    eventCountRange: { minimum: 0, maximum: 0 },
    maximumConcurrentEvents: 0,
    allowedImpactScopes: [],
    escalationEnabled: false,
    eventLinksEnabled: false,
    partialVisibilityEnabled: false,
    learningStageLabel: "单航线规划与验证",
    eventLevelLabel: "不设置飞行中异常",
    parallelOperationLabel: "严格单机串行",
    batchSchedulingMode: "NONE",
    batchReschedulingEnabled: false,
    globalReschedulingEnabled: false
  }
}

interface ScalePackageSource {
  id: string
  version: string
  manifest: Record<string, unknown>
}

export function parseScaleTemplatePackage(source: ScalePackageSource): V3ScaleTemplateCatalogItem[] {
  const sceneType = parseSceneType(source.manifest.sceneType)
  if (!sceneType) return []
  const detailed = Array.isArray(source.manifest.templates)
    ? source.manifest.templates.flatMap((item) => parseDetailedTemplate(source, sceneType, item))
    : []
  if (detailed.length > 0) return detailed.filter((item) => sceneType !== "CITY_SHOW" || isSupportedShowScaleTemplateCode(item.code))
  if (!Array.isArray(source.manifest.scales)) return []
  return source.manifest.scales.flatMap((value) => {
    const totalAircraft = Number(value)
    if (!Number.isInteger(totalAircraft) || totalAircraft < 1) return []
    const show = sceneType === "CITY_SHOW"
    const vtl = sceneType === "VTOL_INSPECTION"
    const showPolicy = show ? showTemplatePolicyForAircraftCount(totalAircraft) : null
    const logisticsPolicy = !show && !vtl ? logisticsTemplatePolicyForAircraftCount(totalAircraft) : null
    const vtlPolicy = vtl ? vtlTemplatePolicyForAircraftCount(totalAircraft) : null
    return [{
      packageId: source.id,
      packageVersion: source.version,
      sceneType,
      code: `${show ? "SHOW" : vtl ? "VTL" : "LOGISTICS"}_${totalAircraft}`,
      title: `${totalAircraft} 架${show ? "表演" : vtl ? "垂起巡检" : "物流"}模板`,
      totalAircraft,
      defaultGroupCount: showPolicy?.defaultGroupCount ?? vtlPolicy?.defaultGroupCount ?? totalAircraft,
      eventCountRange: showPolicy?.eventCountRange ?? vtlPolicy?.eventCountRange ?? logisticsPolicy!.eventCountRange,
      maximumConcurrentEvents: showPolicy?.maximumConcurrentEvents ?? vtlPolicy?.maximumConcurrentEvents ?? logisticsPolicy!.maximumConcurrentEvents,
      allowedActions: show
        ? ["PAUSE_PROGRAM", "RESUME_PROGRAM", "GROUP_RETURN", "GROUP_LAND"]
        : vtl
          ? ["RETURN_AIRCRAFT", "DIVERT_AIRCRAFT", "TRANSFER_TASK", "ADJUST_GROUP", "CANCEL_NOT_STARTED"]
          : ["REASSIGN_ORDER", "HOLD_ROUTE", "RETURN_AIRCRAFT", "DIVERT_AIRCRAFT"],
      aggregationLevel: show && totalAircraft >= 1000 ? "CLUSTER" : totalAircraft >= 100 ? "GROUP" : "UNIT"
    } satisfies V3ScaleTemplateCatalogItem]
  }).filter((item) => sceneType !== "CITY_SHOW" || isSupportedShowScaleTemplateCode(item.code))
}

function parseDetailedTemplate(source: ScalePackageSource, sceneType: SceneType, value: unknown): V3ScaleTemplateCatalogItem[] {
  if (!isRecord(value)) return []
  const code = stringValue(value.code)
  const title = stringValue(value.title)
  const totalAircraft = integerValue(value.totalAircraft)
  const defaultGroupCount = integerValue(value.defaultGroupCount)
  const eventRange = isRecord(value.eventCountRange) ? value.eventCountRange : null
  const minimum = integerValue(eventRange?.minimum)
  const maximum = integerValue(eventRange?.maximum)
  const maximumConcurrentEvents = integerValue(value.maximumConcurrentEvents)
  const aggregationLevel = value.aggregationLevel
  if (!code || !title || !totalAircraft || !defaultGroupCount || minimum === null || maximum === null || !maximumConcurrentEvents) return []
  if (aggregationLevel !== "UNIT" && aggregationLevel !== "GROUP" && aggregationLevel !== "CLUSTER") return []
  const allowedActions = Array.isArray(value.allowedActions)
    ? value.allowedActions.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  const showPolicy = sceneType === "CITY_SHOW" ? showTemplatePolicyForAircraftCount(totalAircraft) : null
  const logisticsPolicy = sceneType === "CITY_LOGISTICS" ? logisticsTemplatePolicyForAircraftCount(totalAircraft) : null
  const vtlPolicy = sceneType === "VTOL_INSPECTION" ? vtlTemplatePolicyForAircraftCount(totalAircraft) : null
  return [{
    packageId: source.id,
    packageVersion: source.version,
    sceneType,
    code,
    title,
    totalAircraft,
    defaultGroupCount: showPolicy?.defaultGroupCount ?? vtlPolicy?.defaultGroupCount ?? defaultGroupCount,
    eventCountRange: showPolicy?.eventCountRange ?? vtlPolicy?.eventCountRange ?? logisticsPolicy?.eventCountRange ?? { minimum, maximum },
    maximumConcurrentEvents: showPolicy?.maximumConcurrentEvents ?? vtlPolicy?.maximumConcurrentEvents ?? logisticsPolicy?.maximumConcurrentEvents ?? maximumConcurrentEvents,
    allowedActions,
    aggregationLevel
  }]
}

function parseSceneType(value: unknown): SceneType | null {
  return value === "CITY_SHOW" || value === "CITY_LOGISTICS" || value === "VTOL_INSPECTION" ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function integerValue(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
