import { describe, expect, it } from "vitest"
import { nextLogisticsSnapshotSequence, shouldSaveLogisticsTickSnapshot } from "./logistics-runtime.service.js"

describe("logistics runtime snapshot sequence", () => {
  it("continues after the greater checkpoint or persisted sequence", () => {
    expect(nextLogisticsSnapshotSequence(3, 4)).toBe(5)
    expect(nextLogisticsSnapshotSequence(6, 4)).toBe(7)
    expect(nextLogisticsSnapshotSequence(3, "9")).toBe(10)
  })

  it("starts from one when both sources are invalid", () => {
    expect(nextLogisticsSnapshotSequence(Number.NaN, null)).toBe(1)
    expect(nextLogisticsSnapshotSequence(-4, "invalid")).toBe(1)
  })

  it("persists a tick snapshot only when time advanced without another snapshot", () => {
    expect(shouldSaveLogisticsTickSnapshot(1_000, 2_000, 3, 3)).toBe(true)
    expect(shouldSaveLogisticsTickSnapshot(1_000, 1_000, 3, 3)).toBe(false)
    expect(shouldSaveLogisticsTickSnapshot(1_000, 2_000, 3, 4)).toBe(false)
    expect(shouldSaveLogisticsTickSnapshot(Number.NaN, 2_000, 3, 3)).toBe(false)
  })
})
