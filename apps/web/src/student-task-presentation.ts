import { displayTeachingAssignmentTitle, type AssignmentDraftStatus, type SceneType, type StageStatus, type StudentProjectStageView, type StudentProjectStatus, type StudentProjectView, type V3StageCode } from "@wurenji/shared"
import { formatPlatformDate } from "./platform-date"

export const studentTaskCategories = ["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "COMPLETED"] as const
export type StudentTaskCategory = (typeof studentTaskCategories)[number]
export type StudentTaskFilter = "ALL" | StudentTaskCategory
export type StudentTaskSort = "ATTENTION" | "DEADLINE" | "RECENT_ACTIVITY"

export const studentTaskCategoryLabels: Record<StudentTaskCategory, string> = {
  NOT_STARTED: "未开始",
  IN_PROGRESS: "进行中",
  SUBMITTED: "已提交",
  COMPLETED: "已完成"
}

const studentSceneOrder: SceneType[] = ["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"]

export function firstStudentSceneWithProjects(
  projects: Array<Pick<StudentProjectView, "sceneType" | "title"> & Partial<Pick<StudentProjectView, "isDemo" | "isAcceptanceData">>>,
  includeInternal = false
): SceneType | null {
  return studentSceneOrder.find((sceneType) => projects.some((project) => (
    project.sceneType === sceneType && (includeInternal || !studentProjectIsInternal(project))
  ))) ?? null
}

export function studentTaskCategory(status: StudentProjectStatus): StudentTaskCategory {
  if (status === "NOT_STARTED") return "NOT_STARTED"
  if (status === "SUBMITTED" || status === "EVALUATING") return "SUBMITTED"
  if (status === "GRADED") return "COMPLETED"
  return "IN_PROGRESS"
}

export function studentProjectStatusLabel(status: StudentProjectStatus) {
  return ({
    NOT_STARTED: "未开始",
    IN_PROGRESS: "进行中",
    SUBMITTED: "已提交",
    EVALUATING: "待教师查看",
    GRADED: "已完成",
    BLOCKED: "待修改"
  } as Record<StudentProjectStatus, string>)[status]
}

export function studentProjectTitle(project: Pick<StudentProjectView, "id" | "title" | "sceneType"> & Partial<Pick<StudentProjectView, "displayTitle">>): string {
  return project.displayTitle ?? displayTeachingAssignmentTitle(project)
}

export function studentStageStatusLabel(status: StageStatus, stageCode?: V3StageCode, assignmentStatus?: AssignmentDraftStatus) {
  if (assignmentStatus === "ENDED" || assignmentStatus === "ARCHIVED") return "任务已结束"
  if (status === "ACCEPTED" && stageCode === "SHOW_FLIGHT_APPLICATION") return "申报材料已提交"
  return ({
    LOCKED: "未开始 · 未开放",
    AVAILABLE: "未开始 · 可开始",
    IN_PROGRESS: "进行中",
    SUBMITTED: "已提交 · 待教师查看",
    ACCEPTED: "已完成",
    RETURNED: "待修改"
  } as Record<StageStatus, string>)[status]
}

export function studentStageOpenConditionLabel(stage: Pick<StudentProjectStageView, "status" | "openCondition"> | null | undefined) {
  if (!stage) return "阶段条件未加载"
  if (stage.status !== "LOCKED") return "当前已满足开放条件"
  return stage.openCondition?.trim() || "完成前置阶段后开放"
}

export function studentProjectCurrentStage(project: Pick<StudentProjectView, "currentStageCode" | "stages">) {
  return project.stages.find((stage) => stage.stageCode === project.currentStageCode) ?? project.stages[0] ?? null
}

export function studentProjectNextAction(project: Pick<StudentProjectView, "assignmentStatus" | "status" | "currentStageCode" | "stages" | "assessmentTiming">) {
  const stage = studentProjectCurrentStage(project)
  if (stage) return studentStageNextAction(project, stage)
  return { label: "查看当前阶段", detail: "当前阶段数据正在加载。" }
}

export type StudentStagePrimaryAction = "START" | "RESUME" | null

export function studentStagePrimaryActionLabel(action: StudentStagePrimaryAction, stageStatus: StageStatus) {
  if (action === "START") return "开始本阶段"
  if (action === "RESUME" && stageStatus === "RETURNED") return "查看意见并修改"
  if (action === "RESUME") return "继续本阶段"
  return "查看当前阶段"
}

export function studentStagePrimaryAction(
  project: Pick<StudentProjectView, "assignmentStatus" | "status" | "assessmentTiming">,
  stage: Pick<StudentProjectStageView, "status" | "allowedActions">
): StudentStagePrimaryAction {
  if (project.assignmentStatus === "ENDED" || project.assignmentStatus === "ARCHIVED") return null
  if (project.status === "BLOCKED") return null
  if (!project.assessmentTiming.canStart) return null
  if (stage.status === "AVAILABLE" && stage.allowedActions.includes("START")) return "START"
  if ((stage.status === "IN_PROGRESS" || stage.status === "RETURNED") && stage.allowedActions.includes("RESUME")) return "RESUME"
  return null
}

export function studentStageNextAction(
  project: Pick<StudentProjectView, "assignmentStatus" | "status" | "assessmentTiming">,
  stage: Pick<StudentProjectStageView, "status" | "allowedActions" | "description" | "openCondition">
) {
  if (project.assignmentStatus === "ENDED" || project.assignmentStatus === "ARCHIVED") {
    return { label: "查看训练结果", detail: "任务已结束，历史记录仍可查看。" }
  }
  if (project.status === "BLOCKED") {
    return { label: "查看阻塞原因", detail: "当前任务暂时不能继续，请先处理项目阻塞事项。" }
  }
  if (stage?.status === "RETURNED") {
    return { label: "查看意见并修改", detail: "上一阶段已退回，请先处理教师意见。" }
  }
  if (!project.assessmentTiming.canStart && project.assessmentTiming.blockedReason) {
    return { label: "查看开放时间", detail: project.assessmentTiming.blockedReason }
  }
  if (stage?.status === "ACCEPTED") {
    return { label: "查看阶段结果", detail: stage.description || "本阶段已完成，可查看提交内容和系统判定。" }
  }
  if (stage?.status === "SUBMITTED") {
    return { label: "查看提交内容", detail: "本阶段已提交，可查看当前提交内容；教师处理后会开放后续阶段。" }
  }
  if (project.status === "SUBMITTED" || project.status === "EVALUATING") {
    return { label: "等待教师处理", detail: "已提交内容，教师处理后会开放后续阶段。" }
  }
  const primaryAction = studentStagePrimaryAction(project, stage)
  if (primaryAction === "START") {
    return { label: "开始本阶段", detail: stage.description || "完成当前阶段后提交，系统会开放下一阶段。" }
  }
  if (primaryAction === "RESUME") {
    return { label: "继续本阶段", detail: stage.description || "从上次保存的位置继续。" }
  }
  if (stage?.allowedActions.includes("SUBMIT")) {
    return { label: "完成并提交", detail: "检查当前内容后提交本阶段。" }
  }
  if (stage?.status === "LOCKED") {
    return { label: "查看开放条件", detail: studentStageOpenConditionLabel(stage) }
  }
  return { label: "查看当前阶段", detail: stage.description || "当前阶段暂无可执行操作。" }
}

export function studentProjectProgressPercent(project: Pick<StudentProjectView, "status" | "currentStageCode" | "stages">) {
  if (project.status === "GRADED") return 100
  const stage = studentProjectCurrentStage(project)
  if (!stage || project.stages.length === 0) return 0
  return Math.max(0, Math.min(100, Math.round((stage.sequence / project.stages.length) * 100)))
}

export function studentProjectTaskMeta(project: Pick<StudentProjectView, "mode" | "assessmentAttempt" | "assessmentTiming">, now = Date.now()): { label: string; urgent: boolean } {
  const timing = project.assessmentTiming
  const parts = [project.mode === "TRAINING" ? "训练模式" : `考核 · 第 ${project.assessmentAttempt.attemptNumber} 次`]
  if (timing.state === "ACTIVE" && timing.remainingMs !== null) {
    const serverTimestamp = Date.parse(timing.serverNow)
    const elapsedMs = Number.isFinite(serverTimestamp) ? Math.max(0, now - serverTimestamp) : 0
    const remainingMinutes = Math.max(0, Math.ceil((timing.remainingMs - elapsedMs) / 60_000))
    const hours = Math.floor(remainingMinutes / 60)
    const minutes = remainingMinutes % 60
    parts.push(`剩余 ${hours > 0 ? `${hours} 小时 ` : ""}${minutes} 分钟`)
    return { label: parts.join(" · "), urgent: remainingMinutes <= 30 }
  }
  if (timing.assignmentDueAt) parts.push(`截止 ${formatPlatformDate(timing.assignmentDueAt)}`)
  if (timing.state === "NOT_OPEN") parts.push("尚未开放")
  if (timing.state === "EXPIRED") parts.push("已过期")
  return { label: parts.join(" · "), urgent: timing.state === "EXPIRED" }
}

export function studentProjectAttentionRank(project: Pick<StudentProjectView, "status" | "lastActivityAt">) {
  const statusRank = project.status === "BLOCKED" ? 0 : project.status === "IN_PROGRESS" ? 1 : project.status === "NOT_STARTED" ? 2 : project.status === "SUBMITTED" || project.status === "EVALUATING" ? 3 : 4
  return [statusRank, -new Date(project.lastActivityAt).getTime()] as const
}

type StudentProjectSortInput = Pick<StudentProjectView, "id" | "status" | "lastActivityAt"> & {
  assessmentTiming: Pick<StudentProjectView["assessmentTiming"], "deadlineAt" | "assignmentDueAt">
}

export function studentProjectDeadlineMs(project: Pick<StudentProjectSortInput, "assessmentTiming">): number | null {
  const deadline = project.assessmentTiming.deadlineAt ?? project.assessmentTiming.assignmentDueAt
  if (!deadline) return null
  const value = Date.parse(deadline)
  return Number.isFinite(value) ? value : null
}

export function sortStudentProjects<T extends StudentProjectSortInput>(projects: T[], sort: StudentTaskSort, now = Date.now()): T[] {
  return [...projects].sort((left, right) => {
    if (sort === "RECENT_ACTIVITY") return Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt) || left.id.localeCompare(right.id)
    const leftDeadline = studentProjectDeadlineMs(left)
    const rightDeadline = studentProjectDeadlineMs(right)
    if (sort === "DEADLINE") {
      if (leftDeadline !== null && rightDeadline === null) return -1
      if (leftDeadline === null && rightDeadline !== null) return 1
      if (leftDeadline !== null && rightDeadline !== null && leftDeadline !== rightDeadline) return leftDeadline - rightDeadline
    }
    const leftRank = studentProjectAttentionRank(left)
    const rightRank = studentProjectAttentionRank(right)
    const leftUrgency = leftDeadline !== null && leftDeadline <= now ? 0 : 1
    const rightUrgency = rightDeadline !== null && rightDeadline <= now ? 0 : 1
    return leftUrgency - rightUrgency || leftRank[0] - rightRank[0] || leftRank[1] - rightRank[1] || left.id.localeCompare(right.id)
  })
}

type StudentProjectClassification = Pick<StudentProjectView, "title"> & Partial<Pick<StudentProjectView, "isDemo" | "isAcceptanceData">>

export function studentProjectIsInternal(project: StudentProjectClassification): boolean {
  if (project.isDemo !== undefined || project.isAcceptanceData !== undefined) return project.isDemo === true || project.isAcceptanceData === true
  const title = project.title.trim()
  if (!title) return false
  if (/(?:^|[^A-Z0-9])(?:P\d+|R\d+|STU-\d+|TEA-\d+|APP-\d+|ROU-\d+|ORD-\d+|RPT-\d+|SCN-\d+)(?:[^A-Z0-9]|$)/i.test(title)) return true
  if (/(?:BROWSER|ACCEPTANCE|INTEGRATION|SMOKE|TEST|测试|演示|验收)/i.test(title)) return true
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(title)
}

export function studentProjectInternalLabel(project: StudentProjectClassification): string | null {
  if (project.isAcceptanceData === true) return "验收数据"
  if (project.isDemo === true) return "演示数据"
  if (project.isDemo !== undefined || project.isAcceptanceData !== undefined) return null
  return studentProjectIsInternal(project) ? "内部数据" : null
}

export function filterStudentProjects<T extends Pick<StudentProjectView, "status">>(projects: T[], filter: StudentTaskFilter): T[] {
  return filter === "ALL" ? projects : projects.filter((project) => studentTaskCategory(project.status) === filter)
}
