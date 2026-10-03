import { describe, expect, it } from "vitest"
import { decideAssignmentLifecycle } from "./assignment-lifecycle.js"

describe("assignment lifecycle", () => {
  it("withdraws only untouched published assignments", () => {
    expect(decideAssignmentLifecycle("PUBLISHED", "WITHDRAW", true)).toMatchObject({ allowed: true, targetStatus: "DRAFT" })
    expect(decideAssignmentLifecycle("PUBLISHED", "WITHDRAW", false)).toMatchObject({ allowed: false, code: "PROJECT_ALREADY_STARTED" })
    expect(decideAssignmentLifecycle("IN_PROGRESS", "WITHDRAW", true).allowed).toBe(false)
  })

  it("starts, ends and archives through valid states", () => {
    expect(decideAssignmentLifecycle("PUBLISHED", "START").targetStatus).toBe("IN_PROGRESS")
    expect(decideAssignmentLifecycle("IN_PROGRESS", "END").targetStatus).toBe("ENDED")
    expect(decideAssignmentLifecycle("ENDED", "ARCHIVE").targetStatus).toBe("ARCHIVED")
    expect(decideAssignmentLifecycle("ARCHIVED", "START").allowed).toBe(false)
  })
})
