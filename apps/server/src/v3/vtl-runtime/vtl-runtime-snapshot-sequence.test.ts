import { describe, expect, it } from "vitest"
import { canStudentControlVtlRuntime, nextVtlSnapshotSequence } from "./vtl-runtime.service.js"

describe("vtol runtime snapshot sequence", () => {
  it("continues after the greater checkpoint or persisted sequence", () => {
    expect(nextVtlSnapshotSequence(3, 4)).toBe(5)
    expect(nextVtlSnapshotSequence(6, 4)).toBe(7)
    expect(nextVtlSnapshotSequence(3, "9")).toBe(10)
  })

  it("starts from one when both sources are invalid", () => {
    expect(nextVtlSnapshotSequence(Number.NaN, null)).toBe(1)
    expect(nextVtlSnapshotSequence(-4, "invalid")).toBe(1)
  })

  it("freezes student controls after a runtime reaches a terminal state", () => {
    expect(canStudentControlVtlRuntime("STUDENT", "RUNNING")).toBe(true)
    expect(canStudentControlVtlRuntime("STUDENT", "PAUSED")).toBe(true)
    expect(canStudentControlVtlRuntime("STUDENT", "COMPLETED")).toBe(false)
    expect(canStudentControlVtlRuntime("STUDENT", "ABORTED")).toBe(false)
    expect(canStudentControlVtlRuntime("TEACHER", "RUNNING")).toBe(false)
  })
})
