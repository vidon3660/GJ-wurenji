import type {
  V3ScenarioEventImpactScope,
  V3ScenarioEventTriggerMode
} from "./types.js"
import { showTemplateAircraftCount } from "./show-initial-conditions.js"

export interface ShowTemplatePolicy {
  totalAircraft: number
  scaleClass: "SMALL" | "MEDIUM" | "LARGE"
  defaultGroupCount: number
  eventCountRange: { minimum: number; maximum: number }
  maximumConcurrentEvents: number
  allowedTriggerModes: readonly V3ScenarioEventTriggerMode[]
  allowedImpactScopes: readonly V3ScenarioEventImpactScope[]
  escalationEnabled: boolean
  eventLinksEnabled: boolean
  maximumEventChainDepth: number
  partialVisibilityEnabled: boolean
  responseLevels: readonly string[]
}

export function showTemplatePolicy(scaleTemplateCode: string): ShowTemplatePolicy {
  return showTemplatePolicyForAircraftCount(showTemplateAircraftCount(scaleTemplateCode))
}

export function showTemplatePolicyForAircraftCount(totalAircraft: number): ShowTemplatePolicy {
  if (totalAircraft >= 5_000) return policy(5_000, "LARGE", 4, 6, 3, ["SIMULATION_TIME", "PHASE", "TIME_RANGE", "AFTER_EVENT"], ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP", "MULTI_GROUP", "LOCAL_AREA", "MOST", "WHOLE"], true, true, 5, true, ["基础", "单架", "小批量", "分组", "多分组", "整体"])
  if (totalAircraft >= 3_000) return policy(3_000, "LARGE", 3, 4, 3, ["SIMULATION_TIME", "PHASE", "TIME_RANGE", "AFTER_EVENT"], ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP", "MULTI_GROUP", "MOST", "WHOLE"], true, true, 3, false, ["基础", "单架", "小批量", "分组", "多分组", "整体"])
  if (totalAircraft >= 1_000) return policy(1_000, "MEDIUM", 2, 3, 2, ["SIMULATION_TIME", "PHASE", "TIME_RANGE", "AFTER_EVENT"], ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP", "MULTI_GROUP", "LOCAL_AREA"], true, true, 1, false, ["基础", "单架", "小批量", "分组", "整体"])
  if (totalAircraft >= 500) return policy(500, "SMALL", 1, 2, 1, ["SIMULATION_TIME", "PHASE", "TIME_RANGE"], ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP"], true, false, 0, false, ["基础", "单架", "小批量", "有限分组", "整体"])
  return policy(100, "SMALL", 1, 1, 1, ["SIMULATION_TIME", "PHASE"], ["DEFAULT", "SINGLE"], false, false, 0, false, ["基础", "单架", "整体"])
}

export function showMaximumEventImpactCount(totalAircraft: number, scope: V3ScenarioEventImpactScope): number {
  const total = Math.max(1, Math.floor(totalAircraft))
  const groupCount = Math.max(1, Math.ceil(total / 100))
  if (scope === "DEFAULT") {
    if (total >= 3_000) return total
    if (total >= 1_000) return Math.min(total, Math.ceil(total * 0.2))
    if (total >= 500) return Math.min(total, Math.ceil(total / groupCount))
    return Math.min(total, Math.max(1, Math.ceil(total * 0.05)))
  }
  if (scope === "SINGLE") return 1
  if (scope === "SMALL_BATCH") return Math.min(total, Math.max(2, Math.ceil(total * 0.05)))
  if (scope === "GROUP") return Math.min(total, Math.ceil(total / groupCount))
  if (scope === "MULTI_GROUP") return Math.min(total, Math.ceil(total / groupCount) * 2)
  if (scope === "LOCAL_AREA") return Math.min(total, Math.ceil(total * 0.2))
  if (scope === "MOST") return Math.min(total, Math.ceil(total * 0.65))
  if (scope === "WHOLE") return total
  return total
}

function policy(
  totalAircraft: number,
  scaleClass: ShowTemplatePolicy["scaleClass"],
  minimumEvents: number,
  maximumEvents: number,
  maximumConcurrentEvents: number,
  allowedTriggerModes: ShowTemplatePolicy["allowedTriggerModes"],
  allowedImpactScopes: ShowTemplatePolicy["allowedImpactScopes"],
  escalationEnabled: boolean,
  eventLinksEnabled: boolean,
  maximumEventChainDepth: number,
  partialVisibilityEnabled: boolean,
  responseLevels: ShowTemplatePolicy["responseLevels"]
): ShowTemplatePolicy {
  return {
    totalAircraft,
    scaleClass,
    defaultGroupCount: Math.max(1, Math.ceil(totalAircraft / 100)),
    eventCountRange: { minimum: minimumEvents, maximum: maximumEvents },
    maximumConcurrentEvents,
    allowedTriggerModes,
    allowedImpactScopes,
    escalationEnabled,
    eventLinksEnabled,
    maximumEventChainDepth,
    partialVisibilityEnabled,
    responseLevels
  }
}
