import { describe, expect, it } from "vitest"
import { countTeacherProgressFilters, filterStalledTeacherProgress, filterTeacherProgressAlerts, sortTeacherProgress, teacherAlertStatusSummary, teacherMetricNavigation, teacherProgressMilestoneClass, teacherProgressStallLabel } from "./teacher-progress"
import type { V3TeacherProgressItem } from "@wurenji/shared"

describe("teacher progress filter presentation", () => {
  it("counts the internal-data scope as an active filter", () => {
    expect(countTeacherProgressFilters({ includeInternalData: true })).toBe(1)
    expect(countTeacherProgressFilters({ includeInternalData: false })).toBe(0)
  })

  it("ignores whitespace-only keywords", () => {
    expect(countTeacherProgressFilters({ keyword: "  ", stalledOnly: true })).toBe(1)
  })

  it("counts a quick teaching-state filter as active", () => {
    expect(countTeacherProgressFilters({ focusState: "CHECK_FAILED" })).toBe(1)
  })
})

function progress(overrides: Partial<V3TeacherProgressItem> = {}): V3TeacherProgressItem {
  return {
    projectId: "project",
    studentId: "student",
    studentName: "学生",
    assignmentId: "assignment",
    assignmentSnapshotId: "snapshot",
    assignmentTitle: "任务",
    sceneType: "CITY_SHOW",
    mode: "TRAINING",
    isDemo: false,
    isAcceptanceData: false,
    projectStatus: "IN_PROGRESS",
    currentStageCode: "SHOW_AREA_PLANNING",
    currentStageTitle: "任务条件",
    submissionState: "NOT_STARTED",
    alertState: "NONE",
    alerts: [],
    evaluationState: "NOT_STARTED",
    milestones: [],
    assessmentAttempt: { attemptNumber: 1, isRetake: false, retakeOfProjectId: null, retakeReason: null, retakeCreatedAt: null },
    assessmentTiming: { state: "NOT_STARTED", durationMinutes: null, availableAt: "2026-09-09T00:00:00.000Z", assignmentDueAt: "2026-09-10T00:00:00.000Z", startedAt: null, deadlineAt: null, submittedAt: null, endedAt: null, serverNow: "2026-09-09T00:00:00.000Z", remainingMs: null, canStart: true, canWrite: false, blockedReason: null },
    canCreateAssessmentRetake: false,
    lastActivityAt: "2026-09-09T10:00:00.000Z",
    ...overrides
  }
}

describe("teacher progress milestone presentation", () => {
  it("routes every teacher overview metric to one explicit queue", () => {
    expect(teacherMetricNavigation("DRAFTS")).toEqual({ section: "home", assignmentFocus: "DRAFT", submissionState: "", alertState: "", evaluationState: "" })
    expect(teacherMetricNavigation("ALERTS")).toEqual({ section: "progress", assignmentFocus: "", submissionState: "", alertState: "OPEN", evaluationState: "" })
    expect(teacherMetricNavigation("EVALUATION")).toEqual({ section: "progress", assignmentFocus: "", submissionState: "", alertState: "", evaluationState: "PENDING" })
    expect(teacherMetricNavigation("IN_PROGRESS")).toEqual({ section: "progress", assignmentFocus: "", submissionState: "IN_PROGRESS", alertState: "", evaluationState: "" })
  })

  it("summarizes active alert ownership without counting resolved alerts", () => {
    const summary = teacherAlertStatusSummary([
      progress({ alerts: [
        { id: "open", projectId: "project", sessionId: null, eventId: null, title: "待确认", code: "OPEN", severity: "WARNING", status: "OPEN", detail: "", stageCode: "SHOW_RUNTIME", openedAt: "2026-09-09T09:00:00.000Z", acknowledgedAt: null, resolvedAt: null, simulationTimeMs: 1000, payload: {}, correlationId: "open" },
        { id: "ack", projectId: "project", sessionId: null, eventId: null, title: "已确认", code: "ACK", severity: "INFO", status: "ACKNOWLEDGED", detail: "", stageCode: "SHOW_RUNTIME", openedAt: "2026-09-09T09:01:00.000Z", acknowledgedAt: "2026-09-09T09:02:00.000Z", resolvedAt: null, simulationTimeMs: 2000, payload: {}, correlationId: "ack" },
        { id: "resolved", projectId: "project", sessionId: null, eventId: null, title: "已解决", code: "RESOLVED", severity: "INFO", status: "RESOLVED", detail: "", stageCode: "SHOW_RUNTIME", openedAt: "2026-09-09T09:03:00.000Z", acknowledgedAt: "2026-09-09T09:04:00.000Z", resolvedAt: "2026-09-09T09:05:00.000Z", simulationTimeMs: 3000, payload: {}, correlationId: "resolved" }
      ] }),
      progress()
    ])
    expect(summary).toEqual({ total: 2, open: 1, acknowledged: 1 })
  })

  it("filters alert projects and keeps only matching severity and teacher follow-up state", () => {
    const matching = {
      id: "matching",
      projectId: "project",
      sessionId: null,
      eventId: null,
      title: "气象恶化",
      code: "WEATHER",
      severity: "WARNING" as const,
      status: "OPEN" as const,
      detail: "",
      stageCode: "SHOW_RUNTIME" as const,
      openedAt: "2026-09-09T09:00:00.000Z",
      acknowledgedAt: null,
      resolvedAt: null,
      simulationTimeMs: 1000,
      payload: {},
      correlationId: "matching",
      teacherFollowUp: { status: "WATCHING" as const, note: "重点关注", updatedAt: "2026-09-09T09:01:00.000Z" }
    }
    const other = { ...matching, id: "other", severity: "ERROR" as const, teacherFollowUp: null }
    const result = filterTeacherProgressAlerts([progress({ alerts: [matching, other] }), progress({ projectId: "empty", alerts: [] })], "WARNING", "WATCHING")
    expect(result).toHaveLength(1)
    const first = result[0]
    expect(first).toBeDefined()
    expect(first?.alerts.map((alert) => alert.id)).toEqual(["matching"])
    expect(filterTeacherProgressAlerts(result)).toBe(result)
  })

  it("explains stalled in-progress work without flagging fresh or invalid activity", () => {
    const now = Date.parse("2026-09-09T12:00:00.000Z")
    expect(teacherProgressStallLabel(progress({ submissionState: "IN_PROGRESS", lastActivityAt: "2026-09-09T11:20:00.000Z" }), now)).toBe("已停滞 40 分钟")
    expect(teacherProgressStallLabel(progress({ submissionState: "IN_PROGRESS", lastActivityAt: "2026-09-09T10:15:00.000Z" }), now)).toBe("已停滞 1 小时 45 分钟")
    expect(teacherProgressStallLabel(progress({ submissionState: "NOT_STARTED", lastActivityAt: "2026-09-09T08:00:00.000Z" }), now)).toBeNull()
    expect(teacherProgressStallLabel(progress({ submissionState: "IN_PROGRESS", lastActivityAt: "invalid" }), now)).toBeNull()
  })

  it("filters only in-progress projects past the stall threshold", () => {
    const now = Date.parse("2026-09-09T12:00:00.000Z")
    const stalled = progress({ projectId: "stalled", submissionState: "IN_PROGRESS", lastActivityAt: "2026-09-09T11:00:00.000Z" })
    const fresh = progress({ projectId: "fresh", submissionState: "IN_PROGRESS", lastActivityAt: "2026-09-09T11:45:00.000Z" })
    const submitted = progress({ projectId: "submitted", submissionState: "SUBMITTED", lastActivityAt: "2026-09-09T08:00:00.000Z" })
    expect(filterStalledTeacherProgress([stalled, fresh, submitted], now).map((item) => item.projectId)).toEqual(["stalled"])
  })

  it("separates completed, active, warning and attention states", () => {
    expect(teacherProgressMilestoneClass("PASSED")).toBe("complete")
    expect(teacherProgressMilestoneClass("IN_PROGRESS")).toBe("active")
    expect(teacherProgressMilestoneClass("WITH_RISK")).toBe("warning")
    expect(teacherProgressMilestoneClass("ABORTED")).toBe("attention")
    expect(teacherProgressMilestoneClass("NOT_STARTED")).toBe("pending")
  })

  it("sorts stalled projects by oldest activity after prioritizing active work", () => {
    const recent = progress({ projectId: "recent", studentName: "最近", submissionState: "IN_PROGRESS", lastActivityAt: "2026-09-09T11:00:00.000Z" })
    const stalled = progress({ projectId: "stalled", studentName: "停滞", submissionState: "IN_PROGRESS", lastActivityAt: "2026-09-09T08:00:00.000Z" })
    const notStarted = progress({ projectId: "not-started", studentName: "未开始", lastActivityAt: "2026-09-09T07:00:00.000Z" })
    expect(sortTeacherProgress([recent, notStarted, stalled], "STALLED").map((item) => item.projectId)).toEqual(["stalled", "recent", "not-started"])
  })

  it("prioritizes open alerts and pending evaluation without mutating input", () => {
    const normal = progress({ projectId: "normal", studentName: "普通" })
    const pending = progress({ projectId: "pending", studentName: "待评价", evaluationState: "PENDING" })
    const risky = progress({ projectId: "risky", studentName: "风险", alerts: [{ id: "alert", projectId: "risky", sessionId: null, eventId: null, title: "通信异常", code: "COMMS", severity: "WARNING", status: "OPEN", detail: "", stageCode: "SHOW_RUNTIME", openedAt: "2026-09-09T09:00:00.000Z", acknowledgedAt: null, resolvedAt: null, simulationTimeMs: 1000, payload: {}, correlationId: "correlation" }] })
    const input = [normal, pending, risky]
    expect(sortTeacherProgress(input, "RISK").map((item) => item.projectId)).toEqual(["risky", "pending", "normal"])
    expect(sortTeacherProgress(input, "EVALUATION").map((item) => item.projectId)).toEqual(["pending", "risky", "normal"])
    expect(input.map((item) => item.projectId)).toEqual(["normal", "pending", "risky"])
  })
})
