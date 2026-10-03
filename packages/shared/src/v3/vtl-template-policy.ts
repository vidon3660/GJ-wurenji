import type {
  V3ScenarioEventImpactScope,
  V3ScenarioEventTriggerMode
} from "./types.js"

export const vtlEventCodes = [
  "VTL_WEATHER",
  "VTL_POSITIONING",
  "VTL_COMMUNICATION",
  "VTL_ENERGY_POWER",
  "VTL_DEVICE",
  "VTL_TRANSITION",
  "VTL_ROUTE_AREA",
  "VTL_TASK_CONDITION"
] as const
export type VtlEventCode = (typeof vtlEventCodes)[number]

export interface VtlTemplatePolicy {
  totalAircraft: 1 | 5 | 20
  taskObjectRange: { minimum: number; maximum: number }
  defaultTaskObjectCount: number
  defaultGroupCount: number
  batchPlanningEnabled: boolean
  groupAllocationEnabled: boolean
  situationLevels: readonly ("OVERALL" | "GROUP" | "AIRCRAFT")[]
  eventCountRange: { minimum: number; maximum: number }
  maximumConcurrentEvents: number
  allowedEventCodes: readonly VtlEventCode[]
  allowedImpactScopes: readonly V3ScenarioEventImpactScope[]
  allowedTriggerModes: readonly V3ScenarioEventTriggerMode[]
  escalationEnabled: boolean
  eventLinksEnabled: boolean
  partialVisibilityEnabled: boolean
  expectedDeliverables: readonly string[]
}

export function vtlTemplatePolicy(scaleTemplateCode: string): VtlTemplatePolicy {
  const count = Number(scaleTemplateCode.match(/(\d+)$/)?.[1] ?? 1)
  return vtlTemplatePolicyForAircraftCount(count)
}

export function vtlTemplatePolicyForAircraftCount(count: number): VtlTemplatePolicy {
  const common = {
    allowedTriggerModes: ["AUTO", "SIMULATION_TIME", "PHASE", "TIME_RANGE", "CONDITION", "AFTER_EVENT"] as const,
    expectedDeliverables: ["任务分区", "任务分配表", "八阶段航线与剖面", "能量估算", "执行计划", "运行处置记录", "巡检复盘"] as const
  }
  if (count >= 20) return {
    ...common,
    totalAircraft: 20,
    taskObjectRange: { minimum: 12, maximum: 30 },
    defaultTaskObjectCount: 20,
    defaultGroupCount: 4,
    batchPlanningEnabled: true,
    groupAllocationEnabled: true,
    situationLevels: ["OVERALL", "GROUP", "AIRCRAFT"],
    eventCountRange: { minimum: 2, maximum: 4 },
    maximumConcurrentEvents: 3,
    allowedEventCodes: vtlEventCodes,
    allowedImpactScopes: ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP", "MULTI_GROUP", "LOCAL_AREA", "MOST", "WHOLE"],
    escalationEnabled: true,
    eventLinksEnabled: true,
    partialVisibilityEnabled: true
  }
  if (count >= 5) return {
    ...common,
    totalAircraft: 5,
    taskObjectRange: { minimum: 3, maximum: 5 },
    defaultTaskObjectCount: 5,
    defaultGroupCount: 1,
    batchPlanningEnabled: true,
    groupAllocationEnabled: false,
    situationLevels: ["OVERALL", "AIRCRAFT"],
    eventCountRange: { minimum: 1, maximum: 2 },
    maximumConcurrentEvents: 1,
    allowedEventCodes: vtlEventCodes,
    allowedImpactScopes: ["DEFAULT", "SINGLE", "SMALL_BATCH", "LOCAL_AREA"],
    escalationEnabled: true,
    eventLinksEnabled: false,
    partialVisibilityEnabled: false
  }
  return {
    ...common,
    totalAircraft: 1,
    taskObjectRange: { minimum: 2, maximum: 3 },
    defaultTaskObjectCount: 3,
    defaultGroupCount: 1,
    batchPlanningEnabled: false,
    groupAllocationEnabled: false,
    situationLevels: ["OVERALL", "AIRCRAFT"],
    eventCountRange: { minimum: 0, maximum: 1 },
    maximumConcurrentEvents: 1,
    allowedEventCodes: ["VTL_WEATHER", "VTL_ENERGY_POWER", "VTL_TRANSITION", "VTL_TASK_CONDITION"],
    allowedImpactScopes: ["DEFAULT", "SINGLE"],
    allowedTriggerModes: ["AUTO", "SIMULATION_TIME", "PHASE", "CONDITION"],
    escalationEnabled: false,
    eventLinksEnabled: false,
    partialVisibilityEnabled: false
  }
}
