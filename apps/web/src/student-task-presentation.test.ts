import { describe, expect, it } from "vitest"
import type { StudentProjectStatus } from "@wurenji/shared"
import {
  filterStudentProjects,
  firstStudentSceneWithProjects,
  studentProjectAttentionRank,
  sortStudentProjects,
  studentProjectInternalLabel,
  studentProjectIsInternal,
  studentProjectNextAction,
  studentProjectProgressPercent,
  studentProjectTaskMeta,
  studentProjectStatusLabel,
  studentStagePrimaryAction,
  studentStagePrimaryActionLabel,
  studentStageOpenConditionLabel,
  studentStageNextAction,
  studentStageStatusLabel,
  studentTaskCategory
} from "./student-task-presentation"

describe("student task presentation", () => {
  it("opens the first scene that has visible student projects", () => {
    const projects = [
      { sceneType: "CITY_LOGISTICS", title: "城市物流训练" },
      { sceneType: "CITY_SHOW", title: "验收表演", isAcceptanceData: true }
    ] as const

    expect(firstStudentSceneWithProjects([...projects])).toBe("CITY_LOGISTICS")
    expect(firstStudentSceneWithProjects([...projects], true)).toBe("CITY_SHOW")
    expect(firstStudentSceneWithProjects([{ sceneType: "VTOL_INSPECTION", title: "演示任务", isDemo: true }])).toBeNull()
  })

  it.each([
    ["NOT_STARTED", "NOT_STARTED"],
    ["IN_PROGRESS", "IN_PROGRESS"],
    ["BLOCKED", "IN_PROGRESS"],
    ["SUBMITTED", "SUBMITTED"],
    ["EVALUATING", "SUBMITTED"],
    ["GRADED", "COMPLETED"]
  ] as const)("groups %s projects into %s", (status, category) => {
    expect(studentTaskCategory(status)).toBe(category)
  })

  it("filters projects using the four student-facing task categories", () => {
    const projects = (["NOT_STARTED", "IN_PROGRESS", "SUBMITTED", "EVALUATING", "GRADED", "BLOCKED"] as StudentProjectStatus[])
      .map((status, index) => ({ id: String(index), status }))

    expect(filterStudentProjects(projects, "SUBMITTED").map((project) => project.status)).toEqual(["SUBMITTED", "EVALUATING"])
    expect(filterStudentProjects(projects, "COMPLETED").map((project) => project.status)).toEqual(["GRADED"])
    expect(filterStudentProjects(projects, "ALL")).toHaveLength(6)
  })

  it("uses the required student project labels", () => {
    expect(studentProjectStatusLabel("EVALUATING")).toBe("待教师查看")
    expect(studentProjectStatusLabel("GRADED")).toBe("已完成")
    expect(studentProjectStatusLabel("BLOCKED")).toBe("待修改")
  })

  it("expresses every stage lifecycle state in student language", () => {
    expect(studentStageStatusLabel("LOCKED")).toContain("未开始")
    expect(studentStageStatusLabel("AVAILABLE")).toContain("未开始")
    expect(studentStageStatusLabel("IN_PROGRESS")).toBe("进行中")
    expect(studentStageStatusLabel("SUBMITTED")).toBe("已提交 · 待教师查看")
    expect(studentStageStatusLabel("ACCEPTED")).toBe("已完成")
    expect(studentStageStatusLabel("RETURNED")).toBe("待修改")
  })

  it("provides an actionable fallback for locked stages without conditions", () => {
    expect(studentStageOpenConditionLabel({ status: "LOCKED" } as never)).toBe("完成前置阶段后开放")
    expect(studentStageOpenConditionLabel({ status: "AVAILABLE" } as never)).toBe("当前已满足开放条件")
  })

  it("uses the required business completion label for show application materials", () => {
    expect(studentStageStatusLabel("ACCEPTED", "SHOW_FLIGHT_APPLICATION")).toBe("申报材料已提交")
    expect(studentStageStatusLabel("ACCEPTED", "SHOW_PREFLIGHT")).toBe("已完成")
  })

  it("turns project state into a single next action", () => {
    const project = {
      assignmentStatus: "PUBLISHED",
      status: "IN_PROGRESS",
      currentStageCode: "SHOW_AREA_PLANNING",
      assessmentTiming: { canStart: true, blockedReason: null },
      stages: [{ stageCode: "SHOW_AREA_PLANNING", sequence: 1, title: "区域规划", description: "完成区域规划", openCondition: "", status: "IN_PROGRESS", allowedActions: ["RESUME"] }]
    } as never

    expect(studentProjectNextAction(project)).toEqual({ label: "继续本阶段", detail: "完成区域规划" })
    expect(studentProjectProgressPercent(project)).toBe(100)
  })

  it("shows server-authoritative assessment time and deadline metadata", () => {
    const project = {
      mode: "ASSESSMENT",
      assessmentAttempt: { attemptNumber: 2 },
      assessmentTiming: { state: "ACTIVE", remainingMs: 29 * 60_000, serverNow: "2026-09-10T00:00:00.000Z", assignmentDueAt: "2026-09-20T10:00:00.000Z" }
    } as never
    expect(studentProjectTaskMeta(project, Date.parse("2026-09-10T00:00:00.000Z"))).toEqual({ label: "考核 · 第 2 次 · 剩余 29 分钟", urgent: true })
    expect(studentProjectTaskMeta(project, Date.parse("2026-09-10T00:05:00.000Z"))).toEqual({ label: "考核 · 第 2 次 · 剩余 24 分钟", urgent: true })
    expect(studentProjectTaskMeta({ mode: "TRAINING", assessmentAttempt: { attemptNumber: 1 }, assessmentTiming: { state: "NOT_OPEN", remainingMs: null, assignmentDueAt: "2026-09-20T16:00:00.000Z" } } as never).label).toContain("截止 09/21 00:00")
  })

  it("sorts student projects by deadline without mutating the source", () => {
    const now = Date.parse("2026-09-10T00:00:00.000Z")
    type SortableProject = { id: string; status: StudentProjectStatus; lastActivityAt: string; assessmentTiming: { deadlineAt: string | null; assignmentDueAt: string } }
    const recent = { id: "recent", status: "IN_PROGRESS", lastActivityAt: "2026-09-09T23:00:00.000Z", assessmentTiming: { deadlineAt: "2026-09-11T00:00:00.000Z", assignmentDueAt: "2026-09-11T00:00:00.000Z" } } as SortableProject
    const soon = { id: "soon", status: "IN_PROGRESS", lastActivityAt: "2026-09-01T00:00:00.000Z", assessmentTiming: { deadlineAt: "2026-09-10T01:00:00.000Z", assignmentDueAt: "2026-09-10T01:00:00.000Z" } } as SortableProject
    const original = [recent, soon]
    expect(sortStudentProjects(original, "DEADLINE", now).map((item) => item.id)).toEqual(["soon", "recent"])
    expect(original.map((item) => item.id)).toEqual(["recent", "soon"])
  })

  it("uses a deterministic id tie-breaker when task timing is identical", () => {
    const timing = { deadlineAt: "2026-09-11T00:00:00.000Z", assignmentDueAt: "2026-09-11T00:00:00.000Z" }
    const projects = [
      { id: "task-z", status: "IN_PROGRESS", lastActivityAt: "2026-09-10T00:00:00.000Z", assessmentTiming: timing },
      { id: "task-a", status: "IN_PROGRESS", lastActivityAt: "2026-09-10T00:00:00.000Z", assessmentTiming: timing }
    ] as const

    expect(sortStudentProjects([...projects], "DEADLINE").map((project) => project.id)).toEqual(["task-a", "task-z"])
    expect(sortStudentProjects([...projects], "RECENT_ACTIVITY").map((project) => project.id)).toEqual(["task-a", "task-z"])
  })

  it("uses the selected stage when the student inspects an earlier stage", () => {
    const project = {
      assignmentStatus: "PUBLISHED",
      status: "IN_PROGRESS",
      assessmentTiming: { canStart: true, blockedReason: null }
    } as never
    const selectedStage = {
      status: "SUBMITTED",
      allowedActions: [],
      description: "等待教师审核申报材料",
      openCondition: ""
    } as never

    expect(studentStageNextAction(project, selectedStage)).toEqual({ label: "查看提交内容", detail: "本阶段已提交，可查看当前提交内容；教师处理后会开放后续阶段。" })
  })

  it("gives completed stages a result-view action", () => {
    expect(studentStageNextAction({
      assignmentStatus: "PUBLISHED",
      status: "IN_PROGRESS",
      assessmentTiming: { canStart: true }
    } as never, {
      status: "ACCEPTED",
      allowedActions: [],
      description: "已完成区域规划",
      openCondition: ""
    } as never)).toEqual({ label: "查看阶段结果", detail: "已完成区域规划" })
  })

  it("does not expose a start action while the project or assessment is blocked", () => {
    const stage = { status: "AVAILABLE", allowedActions: ["START"] } as never
    expect(studentStagePrimaryAction({ assignmentStatus: "PUBLISHED", status: "BLOCKED", assessmentTiming: { canStart: true } } as never, stage)).toBeNull()
    expect(studentStagePrimaryAction({ assignmentStatus: "PUBLISHED", status: "IN_PROGRESS", assessmentTiming: { canStart: false } } as never, stage)).toBeNull()
  })

  it("makes returned-stage actions explicit", () => {
    expect(studentStagePrimaryActionLabel("RESUME", "RETURNED")).toBe("查看意见并修改")
    expect(studentStagePrimaryActionLabel("RESUME", "IN_PROGRESS")).toBe("继续本阶段")
    expect(studentStagePrimaryActionLabel("START", "AVAILABLE")).toBe("开始本阶段")
  })

  it("gives blocked projects a blocking explanation instead of a false returned-stage message", () => {
    expect(studentStageNextAction({
      assignmentStatus: "PUBLISHED",
      status: "BLOCKED",
      assessmentTiming: { canStart: true, blockedReason: null }
    } as never, {
      status: "AVAILABLE",
      allowedActions: [],
      description: "区域规划",
      openCondition: "完成任务配置"
    } as never)).toEqual({ label: "查看阻塞原因", detail: "当前任务暂时不能继续，请先处理项目阻塞事项。" })
  })

  it("prioritizes an assessment time window over a generic locked condition", () => {
    expect(studentStageNextAction({
      assignmentStatus: "PUBLISHED",
      status: "IN_PROGRESS",
      assessmentTiming: { canStart: false, blockedReason: "开放时间为 14:00" }
    } as never, {
      status: "LOCKED",
      allowedActions: [],
      description: "运行仿真",
      openCondition: "完成航线规划"
    } as never)).toEqual({ label: "查看开放时间", detail: "开放时间为 14:00" })
  })

  it("does not expose stale start actions for a submitted stage", () => {
    expect(studentStagePrimaryAction({ assignmentStatus: "PUBLISHED", status: "IN_PROGRESS", assessmentTiming: { canStart: true } } as never, {
      status: "SUBMITTED",
      allowedActions: ["START"]
    } as never)).toBeNull()
  })

  it("keeps resume as the single primary action for a returned stage", () => {
    expect(studentStagePrimaryAction({ assignmentStatus: "PUBLISHED", status: "IN_PROGRESS", assessmentTiming: { canStart: true } } as never, {
      status: "RETURNED",
      allowedActions: ["RESUME"]
    } as never)).toBe("RESUME")
  })

  it("prioritizes blocked projects before active projects", () => {
    const blocked = studentProjectAttentionRank({ status: "BLOCKED", lastActivityAt: "2026-01-01T00:00:00Z" })
    const active = studentProjectAttentionRank({ status: "IN_PROGRESS", lastActivityAt: "2026-12-01T00:00:00Z" })
    expect(blocked[0]).toBeLessThan(active[0])
  })

  it("recognizes internal acceptance titles without changing the project data", () => {
    expect(studentProjectIsInternal({ title: "R7-BROWSER-SCALE-CITY-SHOW" })).toBe(true)
    expect(studentProjectIsInternal({ title: "城市低空物流基础训练" })).toBe(false)
    expect(studentProjectIsInternal({ title: "演示任务 2d" })).toBe(true)
  })

  it("prefers explicit server classification over title heuristics", () => {
    expect(studentProjectIsInternal({ title: "正式测试演练", isDemo: false, isAcceptanceData: false })).toBe(false)
    expect(studentProjectIsInternal({ title: "普通训练任务", isDemo: true, isAcceptanceData: false })).toBe(true)
    expect(studentProjectInternalLabel({ title: "内部任务", isDemo: false, isAcceptanceData: true })).toBe("验收数据")
    expect(studentProjectInternalLabel({ title: "内部任务", isDemo: false, isAcceptanceData: false })).toBeNull()
  })
})
