import { describe, expect, it } from "vitest"
import type { VtlTaskObjectView } from "@wurenji/shared"
import { vtlAircraftTaskSummary } from "./vtl-aircraft-task-presentation"

const task = (id: string): VtlTaskObjectView => ({
  id,
  code: id,
  title: `任务 ${id}`,
  type: "POINT",
  positions: [],
  requirement: "完成巡检",
  completionRule: "采集证据",
  required: true,
  estimatedWorkSeconds: 60,
  status: "ASSIGNED",
  incompleteReason: null
})

describe("vtl aircraft task presentation", () => {
  it("keeps the assigned order and skips completed/current tasks", () => {
    const result = vtlAircraftTaskSummary({
      currentTaskObjectId: "T02",
      completedTaskObjectIds: ["T01"],
      assignedTaskObjectIds: ["T01", "T02", "T03"]
    }, [task("T01"), task("T02"), task("T03")])

    expect(result.currentTask?.id).toBe("T02")
    expect(result.nextTask?.id).toBe("T03")
  })

  it("does not invent a task when the runtime references missing data", () => {
    const result = vtlAircraftTaskSummary({
      currentTaskObjectId: "missing-current",
      completedTaskObjectIds: [],
      assignedTaskObjectIds: ["missing-next"]
    }, [])

    expect(result).toEqual({ currentTask: null, nextTask: null })
  })
})
