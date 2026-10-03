import { describe, expect, it } from "vitest"
import { resolveStageSelectionAfterRefresh } from "./project-stage-selection"

describe("project stage selection after refresh", () => {
  it("advances students who are following the current stage", () => {
    expect(resolveStageSelectionAfterRefresh("SHOW_RUNTIME", "SHOW_RUNTIME", "SHOW_REVIEW", true)).toBe("SHOW_REVIEW")
  })

  it("keeps a student's manually selected historical stage", () => {
    expect(resolveStageSelectionAfterRefresh("SHOW_RUNTIME", "SHOW_REVIEW", "SHOW_REVIEW", true)).toBe("SHOW_RUNTIME")
  })

  it("does not change a teacher's selected stage", () => {
    expect(resolveStageSelectionAfterRefresh("SHOW_RUNTIME", "SHOW_RUNTIME", "SHOW_REVIEW", false)).toBe("SHOW_RUNTIME")
  })
})
