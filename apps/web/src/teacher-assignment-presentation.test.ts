import { describe, expect, it } from "vitest"
import type { V3TeachingAssignmentView } from "@wurenji/shared"
import { assignmentQueueHint, assignmentQueuePriority, teacherAssignmentDataLabel, teacherAssignmentIsInternal, teacherAssignmentMatchesDateRange, teacherAssignmentMatchesSearch, teacherAssignmentTitle } from "./teacher-assignment-presentation"

const summary: V3TeachingAssignmentView["summary"] = {
  projectCount: 3,
  notStartedProjectCount: 0,
  inProgressProjectCount: 1,
  blockedProjectCount: 1,
  submittedProjectCount: 1,
  openAlertCount: 0,
  pendingEvaluationCount: 1,
  studentAttentionCount: 2
}

function assignment(input: Partial<V3TeachingAssignmentView> = {}): V3TeachingAssignmentView {
  return {
    id: "assignment-1",
    title: "城市编队基础训练",
    sceneType: "CITY_SHOW",
    mode: "TRAINING",
    status: "PUBLISHED",
    isDemo: false,
    isAcceptanceData: false,
    config: {} as V3TeachingAssignmentView["config"],
    revision: 1,
    configHash: null,
    endedAt: null,
    archivedAt: null,
    lifecycleReason: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    summary,
    ...input
  }
}

describe("teacher assignment presentation", () => {
  it("uses server classification for the default formal-data boundary", () => {
    expect(teacherAssignmentIsInternal(assignment())).toBe(false)
    expect(teacherAssignmentIsInternal(assignment({ isDemo: true }))).toBe(true)
    expect(teacherAssignmentDataLabel(assignment({ isAcceptanceData: true }))).toBe("验收数据")
  })

  it("searches task names and actionable queue states", () => {
    expect(teacherAssignmentMatchesSearch(assignment(), "编队", "城市表演")).toBe(true)
    expect(teacherAssignmentMatchesSearch(assignment(), "待评价", "城市表演")).toBe(true)
    expect(teacherAssignmentMatchesSearch(assignment(), "物流", "城市表演")).toBe(false)
    expect(teacherAssignmentMatchesSearch(assignment(), "待修改", "城市表演")).toBe(true)
  })

  it("matches task update dates inclusively by local calendar day", () => {
    const task = assignment({ updatedAt: "2026-09-09T12:00:00.000Z" })
    expect(teacherAssignmentMatchesDateRange(task, [new Date("2026-09-09T00:00:00.000Z"), new Date("2026-09-09T00:00:00.000Z")])).toBe(true)
    expect(teacherAssignmentMatchesDateRange(task, [new Date("2026-09-08T00:00:00.000Z"), new Date("2026-09-08T00:00:00.000Z")])).toBe(false)
    expect(teacherAssignmentMatchesDateRange(task, null)).toBe(true)
  })

  it("distinguishes blocked students from students still working", () => {
    expect(assignmentQueueHint(assignment())).toBe("待评价 1 项")
    expect(assignmentQueueHint(assignment({ summary: { ...summary, pendingEvaluationCount: 0, blockedProjectCount: 1, inProgressProjectCount: 2 } }))).toBe("学生待修改 1 项")
    expect(assignmentQueueHint(assignment({ summary: { ...summary, pendingEvaluationCount: 0, blockedProjectCount: 0, inProgressProjectCount: 2 } }))).toBe("学生进行中 2 项")
  })

  it("uses a traceable scene title when stored text is unreadable", () => {
    expect(teacherAssignmentTitle(assignment({ id: "12345678-1234-1234-1234-123456789abc", title: "???????? 09729b3e-cc10-4d50-b23d-dcdee8a3133f" }))).toBe("城市编队表演历史教学任务 · 12345678")
  })

  it("orders actionable assignments before quiet and historical work", () => {
    expect(assignmentQueuePriority(assignment({ status: "DRAFT" }))[0]).toBe(0)
    expect(assignmentQueuePriority(assignment({ summary: { ...summary, pendingEvaluationCount: 0 } }))[0]).toBe(3)
    expect(assignmentQueuePriority(assignment({ summary: { ...summary, pendingEvaluationCount: 0, openAlertCount: 0, blockedProjectCount: 0 } }))[0]).toBe(4)
    expect(assignmentQueuePriority(assignment({ status: "ENDED", summary: { ...summary, pendingEvaluationCount: 0, openAlertCount: 0, blockedProjectCount: 0, inProgressProjectCount: 0 } }))[0]).toBe(6)
  })

  it("uses larger actionable counts as the tie breaker within a queue", () => {
    const fewer = assignmentQueuePriority(assignment({ summary: { ...summary, pendingEvaluationCount: 1 } }))
    const more = assignmentQueuePriority(assignment({ summary: { ...summary, pendingEvaluationCount: 3 } }))
    expect(more[0]).toBe(fewer[0])
    expect(more[1]).toBeLessThan(fewer[1])
  })
})
