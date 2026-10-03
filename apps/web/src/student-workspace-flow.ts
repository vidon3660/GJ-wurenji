import type {
  AssessmentTimingView,
  AuthUser,
  LearningMode,
  StudentProjectStageView,
  StudentProjectStatus,
  StudentProjectView,
  V3StageCode
} from "@wurenji/shared"

export type StudentWorkspacePhaseKey = "BRIEFING" | "PLANNING" | "CHECKING" | "RUNTIME" | "HANDLING" | "REVIEW"
export type StudentWorkspacePhaseStatus = "LOCKED" | "AVAILABLE" | "ACTIVE" | "SUBMITTED" | "COMPLETED"

export interface StudentWorkspacePhaseView {
  key: StudentWorkspacePhaseKey
  label: string
  description: string
  status: StudentWorkspacePhaseStatus
  stageCodes: readonly V3StageCode[]
  stageCode: V3StageCode | null
  isCurrent: boolean
  isSelected: boolean
}

export interface StudentWorkspacePermissionView {
  kind: "TRAINING" | "ASSESSMENT_READY" | "ASSESSMENT_ACTIVE" | "ASSESSMENT_BLOCKED" | "PROJECT_BLOCKED" | "READ_ONLY"
  mode: LearningMode
  canEdit: boolean
  label: string
  detail: string
}

const phaseDefinitions: ReadonlyArray<Pick<StudentWorkspacePhaseView, "key" | "label" | "description" | "stageCodes">> = [
  { key: "BRIEFING", label: "任务说明", description: "查看任务目标、约束和完成要求。", stageCodes: [] },
  {
    key: "PLANNING",
    label: "规划",
    description: "完成区域、对象、航线或调度方案。",
    stageCodes: ["SHOW_AREA_PLANNING", "SHOW_FLIGHT_APPLICATION", "LOGISTICS_REGION_ANALYSIS", "LOGISTICS_ROUTE_PLANNING", "LOGISTICS_ORDER_SCHEDULING", "VTL_AREA_OBJECTS", "VTL_TASK_ALLOCATION", "VTL_ROUTE_PLANNING"]
  },
  {
    key: "CHECKING",
    label: "方案检查",
    description: "完成规则、资源和运行前条件检查。",
    stageCodes: ["SHOW_PREFLIGHT", "SHOW_T_MINUS_60", "LOGISTICS_ROUTE_VALIDATION", "LOGISTICS_RUNTIME_PREPARATION", "VTL_PLAN_VALIDATION", "VTL_EXECUTION_PLAN"]
  },
  {
    key: "RUNTIME",
    label: "运行",
    description: "启动并观察仿真运行状态。",
    stageCodes: ["SHOW_RUNTIME", "LOGISTICS_DELIVERY_RUNTIME", "VTL_RUNTIME"]
  },
  {
    key: "HANDLING",
    label: "异常处置",
    description: "根据告警和事件执行可用处置动作。",
    stageCodes: ["LOGISTICS_EMERGENCY_HANDLING", "VTL_EMERGENCY_HANDLING", "SHOW_FLIGHT_END_REPORT"]
  },
  {
    key: "REVIEW",
    label: "复盘",
    description: "查看运行证据并完成复盘评价。",
    stageCodes: ["SHOW_REVIEW", "LOGISTICS_REVIEW", "VTL_REVIEW"]
  }
]

export function studentWorkspacePhaseDefinitions() {
  return phaseDefinitions
}

export function studentWorkspacePhaseForStage(stageCode: V3StageCode | string | null | undefined): StudentWorkspacePhaseKey {
  return phaseDefinitions.find((phase) => phase.stageCodes.includes(stageCode as V3StageCode))?.key ?? "BRIEFING"
}

export function buildStudentWorkspaceFlow(
  project: Pick<StudentProjectView, "currentStageCode" | "status" | "stages">,
  selectedStageCode: string = project.currentStageCode
): StudentWorkspacePhaseView[] {
  return phaseDefinitions.map((definition) => {
    const stages = project.stages.filter((stage) => definition.stageCodes.includes(stage.stageCode))
    const currentStage = stages.find((stage) => stage.stageCode === project.currentStageCode)
    const selectedStage = stages.find((stage) => stage.stageCode === selectedStageCode)
    return {
      ...definition,
      status: definition.stageCodes.length === 0
        ? project.status === "GRADED" ? "COMPLETED" : "AVAILABLE"
        : phaseStatus(stages, project.status),
      stageCode: currentStage?.stageCode ?? selectedStage?.stageCode ?? stages[0]?.stageCode ?? null,
      isCurrent: Boolean(currentStage),
      isSelected: Boolean(selectedStage)
    }
  })
}

export function studentWorkspacePermission(
  project: Pick<StudentProjectView, "mode" | "status" | "assignmentStatus" | "assessmentTiming">,
  actor: Pick<AuthUser, "role">
): StudentWorkspacePermissionView {
  if (actor.role !== "student") {
    return {
      kind: "READ_ONLY",
      mode: project.mode,
      canEdit: false,
      label: "教师只读查看",
      detail: "教师可以查看学生进度，但不能代替学生写入。"
    }
  }
  if (project.status === "BLOCKED" || project.assignmentStatus === "ENDED" || project.assignmentStatus === "ARCHIVED") {
    return {
      kind: "PROJECT_BLOCKED",
      mode: project.mode,
      canEdit: false,
      label: "当前任务只读",
      detail: project.assessmentTiming.blockedReason ?? "当前任务存在阻塞事项，请先处理后再继续。"
    }
  }
  if (project.mode === "TRAINING") {
    return {
      kind: "TRAINING",
      mode: project.mode,
      canEdit: true,
      label: "训练模式 · 可继续操作",
      detail: "训练过程可以反复检查和恢复，结果不会进入考核成绩。"
    }
  }
  if (project.assessmentTiming.canWrite) {
    return {
      kind: "ASSESSMENT_ACTIVE",
      mode: project.mode,
      canEdit: true,
      label: "考核进行中 · 可写入",
      detail: "服务端会按考核窗口校验每次写入，提交后当前项目进入只读。"
    }
  }
  if (project.assessmentTiming.canStart) {
    return {
      kind: "ASSESSMENT_READY",
      mode: project.mode,
      canEdit: true,
      label: "考核已开放 · 开始后计时",
      detail: "开始首个阶段后，服务端开始计算本次考核时限。"
    }
  }
  return {
    kind: "ASSESSMENT_BLOCKED",
    mode: project.mode,
    canEdit: false,
    label: "考核暂不可写入",
    detail: project.assessmentTiming.blockedReason ?? assessmentTimingFallback(project.assessmentTiming)
  }
}

function phaseStatus(stages: StudentProjectStageView[], projectStatus: StudentProjectStatus): StudentWorkspacePhaseStatus {
  if (stages.length === 0) return "LOCKED"
  if (stages.every((stage) => stage.status === "ACCEPTED") || projectStatus === "GRADED" && stages.some((stage) => stage.status === "ACCEPTED")) return "COMPLETED"
  if (stages.some((stage) => stage.status === "IN_PROGRESS" || stage.status === "RETURNED")) return "ACTIVE"
  if (stages.some((stage) => stage.status === "SUBMITTED")) return "SUBMITTED"
  if (stages.some((stage) => stage.status === "AVAILABLE")) return "AVAILABLE"
  return "LOCKED"
}

function assessmentTimingFallback(timing: AssessmentTimingView): string {
  if (timing.state === "NOT_OPEN") return "考核尚未开放，请按开放时间进入。"
  if (timing.state === "EXPIRED") return "考核时间已结束，当前项目已转为只读。"
  if (timing.state === "SUBMITTED") return "考核已提交，当前项目已转为只读。"
  return "当前考核窗口不能继续写入。"
}
