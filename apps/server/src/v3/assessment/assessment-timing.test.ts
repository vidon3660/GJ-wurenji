import { describe, expect, it } from "vitest"
import { buildAssessmentTimingView, calculateAssessmentDeadline, decideAssessmentStart, type AssessmentTimingSource } from "./assessment-timing.js"

describe("assessment timing", () => {
  it("starts once and clips the deadline to the assignment due time", () => {
    const source = assessmentSource()
    const startedAt = new Date("2026-08-20T01:30:00.000Z")
    const decision = decideAssessmentStart(source, startedAt)
    expect(decision).toEqual({
      allowed: true,
      startedAt,
      deadlineAt: new Date("2026-08-20T03:00:00.000Z")
    })
    expect(calculateAssessmentDeadline(startedAt, 120, new Date(source.config.dueAt))).toEqual(new Date("2026-08-20T03:00:00.000Z"))
  })

  it("keeps the same deadline after refresh and decreases remaining time", () => {
    const source = assessmentSource({
      assessmentStartedAt: new Date("2026-08-20T01:00:00.000Z"),
      assessmentDeadlineAt: new Date("2026-08-20T03:00:00.000Z")
    })
    const first = buildAssessmentTimingView(source, new Date("2026-08-20T01:30:00.000Z"))
    const refreshed = buildAssessmentTimingView(source, new Date("2026-08-20T01:45:00.000Z"))
    expect(first.deadlineAt).toBe(refreshed.deadlineAt)
    expect(first.remainingMs).toBe(90 * 60_000)
    expect(refreshed.remainingMs).toBe(75 * 60_000)
  })

  it("expires at the authoritative deadline and freezes writes", () => {
    const view = buildAssessmentTimingView(assessmentSource({
      assessmentStartedAt: new Date("2026-08-20T01:00:00.000Z"),
      assessmentDeadlineAt: new Date("2026-08-20T03:00:00.000Z")
    }), new Date("2026-08-20T03:00:00.000Z"))
    expect(view).toMatchObject({ state: "EXPIRED", remainingMs: 0, canStart: false, canWrite: false, endedAt: "2026-08-20T03:00:00.000Z" })
  })

  it("does not apply an assessment window to training mode", () => {
    const view = buildAssessmentTimingView({ ...assessmentSource(), mode: "TRAINING" }, new Date("2026-08-21T00:00:00.000Z"))
    expect(view).toMatchObject({ state: "NOT_APPLICABLE", durationMinutes: null, canStart: true, canWrite: true })
  })
})

function assessmentSource(overrides: Partial<AssessmentTimingSource> = {}): AssessmentTimingSource {
  return {
    mode: "ASSESSMENT",
    config: {
      availableAt: "2026-08-20T00:00:00.000Z",
      dueAt: "2026-08-20T03:00:00.000Z",
      assessmentDurationMinutes: 120
    },
    assessmentStartedAt: null,
    assessmentDeadlineAt: null,
    assessmentSubmittedAt: null,
    assessmentEndedAt: null,
    ...overrides
  }
}
