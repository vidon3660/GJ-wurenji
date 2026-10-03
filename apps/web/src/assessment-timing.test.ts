import { describe, expect, it } from "vitest"
import type { AssessmentTimingView } from "@wurenji/shared"
import { assessmentRemainingMs, assessmentServerOffsetMs, assessmentTimingLabel, formatAssessmentDuration } from "./assessment-timing"

describe("assessment timing presentation", () => {
  it("uses the server clock offset instead of trusting the browser clock", () => {
    const timing = activeTiming()
    const clientReceivedAt = Date.parse("2026-08-20T09:00:00.000Z")
    const offset = assessmentServerOffsetMs(timing, clientReceivedAt)
    expect(offset).toBe(-8 * 60 * 60_000)
    expect(assessmentRemainingMs(timing, clientReceivedAt + 15 * 60_000, offset)).toBe(45 * 60_000)
  })

  it("formats active and terminal states", () => {
    expect(formatAssessmentDuration(3_661_000)).toBe("01:01:01")
    expect(assessmentTimingLabel(activeTiming(), 45 * 60_000)).toBe("剩余 00:45:00")
    expect(assessmentTimingLabel({ ...activeTiming(), state: "EXPIRED", remainingMs: 0 })).toBe("已超时")
  })
})

function activeTiming(): AssessmentTimingView {
  return {
    state: "ACTIVE",
    durationMinutes: 60,
    availableAt: "2026-08-20T00:00:00.000Z",
    assignmentDueAt: "2026-08-20T03:00:00.000Z",
    startedAt: "2026-08-20T01:00:00.000Z",
    deadlineAt: "2026-08-20T02:00:00.000Z",
    submittedAt: null,
    endedAt: null,
    serverNow: "2026-08-20T01:00:00.000Z",
    remainingMs: 60 * 60_000,
    canStart: true,
    canWrite: true,
    blockedReason: null
  }
}
