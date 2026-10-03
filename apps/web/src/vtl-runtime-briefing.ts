import type { V3StudentRuntimeActionView, VtlRuntimeEventView } from "@wurenji/shared"

export interface VtlEventBriefing {
  role: string
  request: string
  impact: string
  objective: string
  successCriteria: string
  scoringEvidence: string[]
}

export function vtlEventBriefing(event: VtlRuntimeEventView, recommendedAction: string): VtlEventBriefing {
  const profile = profiles[event.category]
  const affected = event.affectedAircraftIds.length > 0
    ? `${event.affectedAircraftIds.length} 架航空器（${event.affectedAircraftIds.join("、")}）`
    : "巡检运行全局"
  return {
    role: profile.role,
    request: event.detail,
    impact: affected,
    objective: profile.objective,
    successCriteria: `在处置时限内执行“${recommendedAction}”或其他有效方案，控制事件并说明判断依据。`,
    scoringEvidence: [...profile.scoringEvidence, "响应时效", "动作匹配", "事件控制", "决策说明"]
  }
}

export function vtlActionBusinessConsequences(action: V3StudentRuntimeActionView | null | undefined): string[] {
  const value = action?.result.businessConsequences
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

export function vtlActionEvidence(action: V3StudentRuntimeActionView | null | undefined): string[] {
  if (!action) return []
  const result = action.result
  const evidence: string[] = []
  const responseTimeMs = result.responseTimeMs === null || result.responseTimeMs === undefined
    ? null
    : Number(result.responseTimeMs)
  if (responseTimeMs !== null && Number.isFinite(responseTimeMs)) evidence.push(`响应时效 ${(Math.max(0, responseTimeMs) / 1_000).toFixed(1)} 秒`)
  if (result.withinDeadline === true) evidence.push("时限判定：达标")
  if (result.withinDeadline === false) evidence.push("时限判定：超时")
  if (result.eventControlled === true) evidence.push("事件控制：成功")
  if (result.eventControlled === false) evidence.push("事件控制：未完成")
  return evidence
}

const profiles: Record<VtlRuntimeEventView["category"], Pick<VtlEventBriefing, "role" | "objective" | "scoringEvidence">> = {
  WEATHER: {
    role: "气象保障系统",
    objective: "降低航空器的恶劣天气暴露，建立等待、返航或退出风险区域的安全路径。",
    scoringEvidence: ["气象风险识别"]
  },
  POSITIONING: {
    role: "导航定位监控系统",
    objective: "保护定位异常航空器的航迹安全，避免在定位质量不足时继续执行精细巡检。",
    scoringEvidence: ["定位风险识别"]
  },
  COMMUNICATION: {
    role: "通信保障系统",
    objective: "控制通信中断风险，使航空器进入可监控、可返航或可安全退出状态。",
    scoringEvidence: ["链路风险识别"]
  },
  ENERGY_POWER: {
    role: "航空器健康监控系统",
    objective: "保护剩余能源余度，停止继续消耗风险，建立返航或备降退出路径，并安排未完成巡检任务。",
    scoringEvidence: ["能源余度", "剩余任务处置"]
  },
  DEVICE: {
    role: "机务保障系统",
    objective: "隔离设备异常影响，优先保障航空器、载荷和地面巡检区域安全。",
    scoringEvidence: ["设备风险识别"]
  },
  MODE_TRANSITION: {
    role: "飞行控制监控系统",
    objective: "控制垂直与固定翼模式转换风险，避免异常航空器继续进入不稳定飞行阶段。",
    scoringEvidence: ["转换阶段判断"]
  },
  ROUTE_AREA: {
    role: "空域与航线管理系统",
    objective: "隔离受影响航段或区域，维持未受影响航空器的巡检连续性和安全间隔。",
    scoringEvidence: ["航线与区域判断"]
  },
  TASK_CONDITION: {
    role: "巡检任务管理系统",
    objective: "根据巡检对象条件变化调整任务分配，保持巡检结果完整且过程可追溯。",
    scoringEvidence: ["巡检完整性"]
  }
}
