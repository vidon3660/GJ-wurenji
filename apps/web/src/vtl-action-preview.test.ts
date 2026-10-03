import { describe, expect, it } from "vitest"
import type { VtlTaskObjectView } from "@wurenji/shared"
import { remainingVtlTasks, vtlActionPreview } from "./vtl-action-preview"

const tasks: VtlTaskObjectView[] = [
  { id: "task-1", code: "T-01", title: "河道巡检", type: "LINE", positions: [], requirement: "巡检", completionRule: "到达", required: true, estimatedWorkSeconds: 60, status: "ASSIGNED", incompleteReason: null },
  { id: "task-2", code: "T-02", title: "塔台巡检", type: "POINT", positions: [], requirement: "巡检", completionRule: "到达", required: true, estimatedWorkSeconds: 30, status: "COMPLETED", incompleteReason: null }
]

describe("VTL action decision preview", () => {
  it("keeps only unfinished tasks in the current assignment order", () => {
    expect(remainingVtlTasks(["task-2", "task-1"], ["task-2"], tasks).map((task) => task.id)).toEqual(["task-1"])
  })

  it("describes diversion and task transfer outcomes", () => {
    expect(vtlActionPreview("DIVERT_AIRCRAFT", { aircraftCode: "VTL-03", remainingTaskCount: 2, landingSiteTitle: "东侧备降点" })).toBe("VTL-03终止剩余 2 项任务并备降至东侧备降点。")
    expect(vtlActionPreview("TRANSFER_TASK", { taskTitle: "塔台巡检", destinationAircraftCode: "VTL-06" })).toContain("塔台巡检转移至VTL-06")
  })
})
