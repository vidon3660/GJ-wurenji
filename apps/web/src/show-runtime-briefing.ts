import type { ShowRuntimeEventView, V3StudentRuntimeActionView } from "@wurenji/shared"
import { runtimeEventSource } from "./runtime-event-source"

export interface ShowEventBriefing {
  role: string
  request: string
  impact: string
  objective: string
  successCriteria: string
  scoringEvidence: string[]
}

export function showEventBriefing(event: ShowRuntimeEventView, recommendedAction: string): ShowEventBriefing {
  const profile = profiles[event.category]
  const groups = event.affectedGroupIds.length > 0 ? event.affectedGroupIds.join("、") : "表演机群全局"
  const impact = event.affectedCount > 0 ? `${event.affectedCount} 架无人机 · ${groups}` : groups
  return {
    role: profile?.role ?? runtimeEventSource("CITY_SHOW", event.category, event.code),
    request: event.detail,
    impact,
    objective: profile?.objective ?? "控制运行风险，保护机群与地面安全，并保持处置记录完整。",
    successCriteria: `在处置时限内执行“${recommendedAction}”或其他有效方案，控制事件并说明对编队和节目运行的影响。`,
    scoringEvidence: [...(profile?.scoringEvidence ?? ["风险识别"]), "响应时效", "动作匹配", "事件控制", "决策说明"]
  }
}

export function showActionBusinessConsequences(action: V3StudentRuntimeActionView | null | undefined): string[] {
  const value = action?.result.businessConsequences
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

export function showActionEvidence(action: V3StudentRuntimeActionView | null | undefined): string[] {
  if (!action) return []
  const result = action.result
  const evidence: string[] = []
  const responseTimeMs = result.responseTimeMs === null || result.responseTimeMs === undefined ? null : Number(result.responseTimeMs)
  if (responseTimeMs !== null && Number.isFinite(responseTimeMs)) evidence.push(`响应时效 ${(Math.max(0, responseTimeMs) / 1_000).toFixed(1)} 秒`)
  if (result.withinDeadline === true) evidence.push("时限判定：达标")
  if (result.withinDeadline === false) evidence.push("时限判定：超时")
  if (result.eventControlled === true) evidence.push("事件控制：成功")
  if (result.eventControlled === false) evidence.push("事件控制：未完成")
  return evidence
}

const profiles: Partial<Record<ShowRuntimeEventView["category"], Pick<ShowEventBriefing, "role" | "objective" | "scoringEvidence">>> = {
  WEATHER: {
    role: "气象保障系统",
    objective: "降低编队的超限气象暴露，决定暂停、返航或中止时机，保护节目运行安全。",
    scoringEvidence: ["气象风险识别", "节目中断决策"]
  },
  POSITIONING_ELECTROMAGNETIC: {
    role: "定位与电磁监控系统",
    objective: "隔离定位异常编队，避免位置偏差破坏图案和邻机安全间距。",
    scoringEvidence: ["定位风险识别", "编队间距判断"]
  },
  COMMUNICATION_CONTROL: {
    role: "通信与控制保障系统",
    objective: "控制链路异常影响，使失去可靠控制的航空器或编队安全退出。",
    scoringEvidence: ["链路风险识别", "安全退出决策"]
  },
  AIRCRAFT_DEVICE: {
    role: "机队设备监控系统",
    objective: "让异常单机安全退出，识别形成的编队缺口，并检查图案完整性、动作时序和邻机安全间距。",
    scoringEvidence: ["单机安全退出", "编队缺口识别", "图案完整性", "动作时序", "邻机安全间隔检查"]
  }
}
