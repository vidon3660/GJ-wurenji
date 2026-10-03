import type {
  LearningMode,
  StageAction,
  StageDefinition,
  StageStatus,
  V3StageCode,
  VtlStageCode
} from "./types.js"
import type { SceneType } from "../types.js"
import { logisticsStageCodes, showStageCodes, vtlStageCodes } from "./types.js"

export type StageActor = "SYSTEM" | "TEACHER" | "STUDENT"

export interface StageTransitionContext {
  actor: StageActor
  mode: LearningMode
  allowResubmission: boolean
  prerequisitesSatisfied: boolean
  submissionGatePassed: boolean
}

export interface StageTransitionDecision {
  allowed: boolean
  code: "ALLOWED" | "ACTOR_DENIED" | "PREREQUISITES_NOT_MET" | "SUBMISSION_GATE_FAILED" | "MODE_POLICY_DENIED" | "INVALID_TRANSITION"
}

export function stageDefinitionsFor(sceneType: SceneType, openVtlStageCodes?: readonly VtlStageCode[]): StageDefinition[] {
  const codes = sceneType === "CITY_SHOW"
    ? showStageCodes
    : sceneType === "CITY_LOGISTICS"
      ? logisticsStageCodes
      : openVtlStageCodes ? vtlStageCodes.filter((code) => openVtlStageCodes.includes(code)) : vtlStageCodes
  return codes.map((code, index) => ({
    code,
    sequence: index + 1,
    ...stageMetadata[code],
    prerequisiteCodes: index === 0 ? [] : [codes[index - 1]!]
  }))
}

export function decideStageTransition(
  from: StageStatus,
  to: StageStatus,
  context: StageTransitionContext
): StageTransitionDecision {
  if (from === "LOCKED" && to === "AVAILABLE") {
    if (context.actor !== "SYSTEM") return denied("ACTOR_DENIED")
    return context.prerequisitesSatisfied ? allowed() : denied("PREREQUISITES_NOT_MET")
  }
  if ((from === "AVAILABLE" || from === "RETURNED") && to === "IN_PROGRESS") {
    return context.actor === "STUDENT" ? allowed() : denied("ACTOR_DENIED")
  }
  if (from === "IN_PROGRESS" && to === "SUBMITTED") {
    if (context.actor !== "STUDENT") return denied("ACTOR_DENIED")
    return context.submissionGatePassed ? allowed() : denied("SUBMISSION_GATE_FAILED")
  }
  if (from === "SUBMITTED" && to === "ACCEPTED") {
    return context.actor === "TEACHER" || context.actor === "SYSTEM" ? allowed() : denied("ACTOR_DENIED")
  }
  if (from === "SUBMITTED" && to === "RETURNED") {
    if (context.actor !== "TEACHER") return denied("ACTOR_DENIED")
    return context.mode === "TRAINING" || context.allowResubmission ? allowed() : denied("MODE_POLICY_DENIED")
  }
  return denied("INVALID_TRANSITION")
}

export function allowedStageActions(
  status: StageStatus,
  mode: LearningMode,
  allowResubmission: boolean,
  actor: StageActor
): StageAction[] {
  const candidates: Array<[StageAction, StageStatus]> = status === "LOCKED"
    ? [["OPEN", "AVAILABLE"]]
    : status === "AVAILABLE"
      ? [["START", "IN_PROGRESS"]]
      : status === "IN_PROGRESS"
        ? [["SUBMIT", "SUBMITTED"]]
        : status === "SUBMITTED"
          ? [["ACCEPT", "ACCEPTED"], ["RETURN", "RETURNED"]]
          : status === "RETURNED"
            ? [["RESUME", "IN_PROGRESS"]]
            : []
  return candidates
    .filter(([, target]) => decideStageTransition(status, target, {
      actor,
      mode,
      allowResubmission,
      prerequisitesSatisfied: true,
      submissionGatePassed: true
    }).allowed)
    .map(([action]) => action)
}

export function isV3StageCode(value: string): value is V3StageCode {
  return (showStageCodes as readonly string[]).includes(value)
    || (logisticsStageCodes as readonly string[]).includes(value)
    || (vtlStageCodes as readonly string[]).includes(value)
}

function allowed(): StageTransitionDecision {
  return { allowed: true, code: "ALLOWED" }
}

function denied(code: Exclude<StageTransitionDecision["code"], "ALLOWED">): StageTransitionDecision {
  return { allowed: false, code }
}

const stageMetadata: Record<V3StageCode, Pick<StageDefinition, "title" | "description">> = {
  SHOW_AREA_PLANNING: { title: "区域规划", description: "分析预设区域并完成表演功能区规划。" },
  SHOW_FLIGHT_APPLICATION: { title: "飞行申报", description: "基于区域成果填写并提交飞行申报资料。" },
  SHOW_PREFLIGHT: { title: "飞前准备", description: "完成设备、场地、通信和人员检查。" },
  SHOW_T_MINUS_60: { title: "起飞前报备", description: "在 T-60 节点确认动态条件和放飞状态。" },
  SHOW_RUNTIME: { title: "表演运行", description: "监控固定表演程序并处理技术异常。" },
  SHOW_FLIGHT_END_REPORT: { title: "结束报备", description: "确认降落、清点和飞行结束信息。" },
  SHOW_REVIEW: { title: "复盘评价", description: "查看运行证据并完成学习复盘。" },
  LOGISTICS_REGION_ANALYSIS: { title: "区域分析", description: "识别中心机场、配送点和空间限制。" },
  LOGISTICS_ROUTE_PLANNING: { title: "航线规划", description: "规划去程、返程和备用航线。" },
  LOGISTICS_ROUTE_VALIDATION: { title: "航线验证", description: "检查规则并验证航线往返可用性。" },
  LOGISTICS_ORDER_SCHEDULING: { title: "订单调度", description: "将订单分配到无人机并编排时刻。" },
  LOGISTICS_RUNTIME_PREPARATION: { title: "运行准备", description: "完成资源、计划和放飞条件检查。" },
  LOGISTICS_DELIVERY_RUNTIME: { title: "配送运行", description: "监控任务执行、时间窗和飞机周转。" },
  LOGISTICS_EMERGENCY_HANDLING: { title: "应急处置", description: "响应事件并执行重调度或飞行处置。" },
  LOGISTICS_REVIEW: { title: "复盘评价", description: "查看运行证据、指标和改进建议。" },
  VTL_AREA_OBJECTS: { title: "区域与对象", description: "分析广域地形、主起降点、备降点和巡检对象。" },
  VTL_TASK_ALLOCATION: { title: "分区与分配", description: "划分任务区域并完成单机或机组任务分配。" },
  VTL_ROUTE_PLANNING: { title: "航线与剖面", description: "规划八阶段航线、转换点、地形剖面和能量方案。" },
  VTL_PLAN_VALIDATION: { title: "方案检查", description: "完成单机检查、多机关系检查和简化仿真验证。" },
  VTL_EXECUTION_PLAN: { title: "执行计划", description: "确定起降顺序、任务顺序并正式提交执行计划。" },
  VTL_RUNTIME: { title: "巡检运行", description: "观察总体、分组和单架三级态势及任务覆盖。" },
  VTL_EMERGENCY_HANDLING: { title: "事件处置", description: "执行返航、备降、任务转移和动态集群重组。" },
  VTL_REVIEW: { title: "复盘评价", description: "复盘任务覆盖、能量、阶段用时、事件处置和未完成原因。" }
}
