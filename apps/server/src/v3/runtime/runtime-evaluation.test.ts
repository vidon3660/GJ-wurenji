import { describe, expect, it, vi } from "vitest"
import { clearUnpublishedObjectiveMetrics } from "./runtime-evaluation.js"

describe("clearUnpublishedObjectiveMetrics", () => {
  it("clears metrics for an unpublished evaluation", async () => {
    const evaluation = { projectId: "project-1", status: "REVIEWED", objectiveMetrics: [{ code: "FLIGHT_TIME" }] }
    const manager = {
      findOne: vi.fn().mockResolvedValue(evaluation),
      save: vi.fn().mockResolvedValue(evaluation)
    }

    await expect(clearUnpublishedObjectiveMetrics(manager as never, "project-1")).resolves.toBe(true)
    expect(evaluation.objectiveMetrics).toEqual([])
    expect(manager.save).toHaveBeenCalledWith(evaluation)
  })

  it("keeps published metrics and does not write", async () => {
    const evaluation = { projectId: "project-1", status: "PUBLISHED", objectiveMetrics: [{ code: "FLIGHT_TIME" }] }
    const manager = {
      findOne: vi.fn().mockResolvedValue(evaluation),
      save: vi.fn()
    }

    await expect(clearUnpublishedObjectiveMetrics(manager as never, "project-1")).resolves.toBe(false)
    expect(evaluation.objectiveMetrics).toHaveLength(1)
    expect(manager.save).not.toHaveBeenCalled()
  })
})
