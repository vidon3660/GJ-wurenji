import type {
  LogisticsRouteValidationStatus,
  ProjectDocumentStatus,
  SceneType,
  StageStatus,
  V3RuntimeSessionStatus,
  V3TeacherProgressMilestone
} from "@wurenji/shared"

export interface ShowTeacherProgressFacts {
  documentStatuses: ProjectDocumentStatus[]
  t60Submitted: boolean
  runtimeStatus: V3RuntimeSessionStatus | null
  flightEndStatus: "DRAFT" | "SUBMITTED" | null
}

export interface LogisticsTeacherProgressFacts {
  routeDraftExists: boolean
  routeSubmitted: boolean
  validationStatus: LogisticsRouteValidationStatus | null
  scheduleDraftExists: boolean
  scheduleSubmitted: boolean
  runtimeStatus: V3RuntimeSessionStatus | null
  reviewSubmitted: boolean
}

export interface VtlTeacherProgressFacts {
  allocationStatus: StageStatus | null
  routeStatus: StageStatus | null
  validationStatus: StageStatus | null
  executionPlanStatus: StageStatus | null
  runtimeStatus: V3RuntimeSessionStatus | null
  reviewSubmitted: boolean
}

export function buildTeacherProgressMilestones(
  sceneType: SceneType,
  facts: ShowTeacherProgressFacts | LogisticsTeacherProgressFacts | VtlTeacherProgressFacts
): V3TeacherProgressMilestone[] {
  if (sceneType === "CITY_SHOW") return buildShowMilestones(facts as ShowTeacherProgressFacts)
  if (sceneType === "CITY_LOGISTICS") return buildLogisticsMilestones(facts as LogisticsTeacherProgressFacts)
  return buildVtlMilestones(facts as VtlTeacherProgressFacts)
}

function buildShowMilestones(facts: ShowTeacherProgressFacts): V3TeacherProgressMilestone[] {
  const submittedStatuses = new Set<ProjectDocumentStatus>(["SUBMITTED", "VIEWED", "RESUBMITTED"])
  const submittedCount = facts.documentStatuses.filter((status) => submittedStatuses.has(status)).length
  const returnedCount = facts.documentStatuses.filter((status) => status === "RETURNED").length
  const documentDetail = facts.documentStatuses.length === 0
    ? "尚未创建"
    : returnedCount > 0
      ? `${returnedCount} 份待修改`
      : `${submittedCount}/${facts.documentStatuses.length} 已提交`
  return [
    {
      code: "SHOW_DOCUMENTS",
      label: "申报材料",
      state: returnedCount > 0 ? "ATTENTION" : submittedCount === 3 ? "SUBMITTED" : submittedCount > 0 ? "IN_PROGRESS" : "NOT_STARTED",
      detail: documentDetail
    },
    {
      code: "SHOW_T_MINUS_60",
      label: "T-60 报备",
      state: facts.t60Submitted ? "SUBMITTED" : "NOT_STARTED",
      detail: facts.t60Submitted ? "已提交" : "待提交"
    },
    runtimeMilestone("SHOW_RUNTIME", "仿真运行", facts.runtimeStatus),
    {
      code: "SHOW_FLIGHT_END_REPORT",
      label: "结束报备",
      state: facts.flightEndStatus === "SUBMITTED" ? "SUBMITTED" : facts.flightEndStatus === "DRAFT" ? "IN_PROGRESS" : "NOT_STARTED",
      detail: facts.flightEndStatus === "SUBMITTED" ? "已提交" : facts.flightEndStatus === "DRAFT" ? "填写中" : "未开始"
    }
  ]
}

function buildLogisticsMilestones(facts: LogisticsTeacherProgressFacts): V3TeacherProgressMilestone[] {
  return [
    {
      code: "LOGISTICS_ROUTE_SUBMISSION",
      label: "航线提交",
      state: facts.routeSubmitted ? "SUBMITTED" : facts.routeDraftExists ? "IN_PROGRESS" : "NOT_STARTED",
      detail: facts.routeSubmitted ? "方案已提交" : facts.routeDraftExists ? "规划中" : "未开始"
    },
    {
      code: "LOGISTICS_ROUTE_VALIDATION",
      label: "航线验证",
      state: validationState(facts.validationStatus),
      detail: validationDetail(facts.validationStatus)
    },
    {
      code: "LOGISTICS_SCHEDULE",
      label: "调度计划",
      state: facts.scheduleSubmitted ? "SUBMITTED" : facts.scheduleDraftExists ? "IN_PROGRESS" : "NOT_STARTED",
      detail: facts.scheduleSubmitted ? "计划已提交" : facts.scheduleDraftExists ? "编排中" : "未开始"
    },
    runtimeMilestone("LOGISTICS_RUNTIME", "配送运行", facts.runtimeStatus),
    {
      code: "LOGISTICS_REVIEW",
      label: "复盘提交",
      state: facts.reviewSubmitted ? "SUBMITTED" : "NOT_STARTED",
      detail: facts.reviewSubmitted ? "总结已提交" : "待提交"
    }
  ]
}

function buildVtlMilestones(facts: VtlTeacherProgressFacts): V3TeacherProgressMilestone[] {
  return [
    vtlPlanningMilestone("VTL_ALLOCATION", "分区与分配", facts.allocationStatus, "方案已提交", "分区分配中"),
    vtlPlanningMilestone("VTL_ROUTE", "航线与剖面", facts.routeStatus, "航线已提交", "航线规划中"),
    vtlValidationMilestone(facts),
    runtimeMilestone("VTL_RUNTIME", "巡检运行", facts.runtimeStatus),
    { code: "VTL_REVIEW", label: "复盘提交", state: facts.reviewSubmitted ? "SUBMITTED" : "NOT_STARTED", detail: facts.reviewSubmitted ? "总结已提交" : "待提交" }
  ]
}

function vtlPlanningMilestone(
  code: "VTL_ALLOCATION" | "VTL_ROUTE",
  label: string,
  status: StageStatus | null,
  submittedDetail: string,
  inProgressDetail: string
): V3TeacherProgressMilestone {
  if (status === "SUBMITTED" || status === "ACCEPTED") return { code, label, state: "SUBMITTED", detail: submittedDetail }
  if (status === "RETURNED") return { code, label, state: "ATTENTION", detail: "已退回修改" }
  if (status === "IN_PROGRESS") return { code, label, state: "IN_PROGRESS", detail: inProgressDetail }
  return { code, label, state: "NOT_STARTED", detail: status === "AVAILABLE" ? "待开始" : "等待前序阶段" }
}

function vtlValidationMilestone(facts: VtlTeacherProgressFacts): V3TeacherProgressMilestone {
  if (facts.executionPlanStatus === "SUBMITTED" || facts.executionPlanStatus === "ACCEPTED") {
    return { code: "VTL_VALIDATION", label: "检查与执行计划", state: "SUBMITTED", detail: "计划已提交" }
  }
  if (facts.routeStatus === "RETURNED" || facts.validationStatus === "RETURNED") {
    return { code: "VTL_VALIDATION", label: "检查与执行计划", state: "ATTENTION", detail: "检查未通过，待修改" }
  }
  if (facts.validationStatus === "SUBMITTED" || facts.validationStatus === "ACCEPTED") {
    return { code: "VTL_VALIDATION", label: "检查与执行计划", state: "PASSED", detail: "检查通过，待执行计划" }
  }
  if (facts.validationStatus === "IN_PROGRESS" || facts.executionPlanStatus === "IN_PROGRESS") {
    return { code: "VTL_VALIDATION", label: "检查与执行计划", state: "IN_PROGRESS", detail: facts.executionPlanStatus === "IN_PROGRESS" ? "执行计划编排中" : "方案检查中" }
  }
  return { code: "VTL_VALIDATION", label: "检查与执行计划", state: "NOT_STARTED", detail: "待检查" }
}

function validationState(status: LogisticsRouteValidationStatus | null): V3TeacherProgressMilestone["state"] {
  if (status === "PASSED") return "PASSED"
  if (status === "WITH_RISK") return "WITH_RISK"
  if (status === "HARD_CONFLICT" || status === "INFEASIBLE") return "ATTENTION"
  return "NOT_STARTED"
}

function validationDetail(status: LogisticsRouteValidationStatus | null): string {
  if (status === "PASSED") return "验证通过"
  if (status === "WITH_RISK") return "存在风险"
  if (status === "HARD_CONFLICT") return "存在硬冲突"
  if (status === "INFEASIBLE") return "无法完成往返"
  return "未验证"
}

function runtimeMilestone(
  code: "SHOW_RUNTIME" | "LOGISTICS_RUNTIME" | "VTL_RUNTIME",
  label: string,
  status: V3RuntimeSessionStatus | null
): V3TeacherProgressMilestone {
  if (!status || status === "READY") return { code, label, state: "NOT_STARTED", detail: status === "READY" ? "待启动" : "未开始" }
  if (status === "RUNNING") return { code, label, state: "IN_PROGRESS", detail: "运行中" }
  if (status === "PAUSED") return { code, label, state: "PAUSED", detail: "已暂停" }
  if (status === "COMPLETED") return { code, label, state: "COMPLETED", detail: "已完成" }
  if (status === "ABORTED") return { code, label, state: "ABORTED", detail: "已中止" }
  return { code, label, state: "ATTENTION", detail: "运行失败" }
}
