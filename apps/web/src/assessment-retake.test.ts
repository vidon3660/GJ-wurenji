import { describe, expect, it } from "vitest"
import type { AssessmentAttemptView, AssessmentTimingView } from "@wurenji/shared"
import { assessmentAttemptLabel, assessmentRetakeDefaultWindow } from "./assessment-retake"

describe("assessment retake presentation", () => {
  it("distinguishes independent assessment attempts", () => {
    const attempt: AssessmentAttemptView = {
      attemptNumber: 2,
      isRetake: true,
      retakeOfProjectId: "original-project",
      retakeReason: "设备故障",
      retakeCreatedAt: "2026-08-20T08:00:00.000Z"
    }
    expect(assessmentAttemptLabel(attempt)).toBe("第 2 次考核")
  })

  it("creates a full-day default registration window without changing the exam duration", () => {
    const now = new Date("2026-08-20T08:00:00.000Z")
    const window = assessmentRetakeDefaultWindow(timing(), now)
    expect(window.availableAt).toEqual(now)
    expect(window.dueAt).toEqual(new Date("2026-08-21T08:00:00.000Z"))
  })
})

function timing(): AssessmentTimingView {
  return {
    state: "EXPIRED",
    durationMinutes: 60,
    availableAt: "2026-08-19T08:00:00.000Z",
    assignmentDueAt: "2026-08-20T08:00:00.000Z",
    startedAt: "2026-08-19T09:00:00.000Z",
    deadlineAt: "2026-08-19T10:00:00.000Z",
    submittedAt: null,
    endedAt: "2026-08-19T10:00:00.000Z",
    serverNow: "2026-08-20T08:00:00.000Z",
    remainingMs: 0,
    canStart: false,
    canWrite: false,
    blockedReason: "考核时间已结束"
  }
}
