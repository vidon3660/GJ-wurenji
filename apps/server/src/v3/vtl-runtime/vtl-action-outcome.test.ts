import { describe, expect, it } from "vitest"
import type { VtlRuntimeAircraftView, VtlTaskObjectView } from "@wurenji/shared"
import { vtlActionBusinessOutcome, vtlActionWithinDeadline } from "./vtl-action-outcome.js"

const taskObjects = [{ id: "task-1", code: "OBJ-01", title: "输电杆塔巡检" }] as VtlTaskObjectView[]

function aircraft(status: VtlRuntimeAircraftView["status"], currentTaskObjectId: string | null): VtlRuntimeAircraftView {
  return {
    aircraftId: "aircraft-1",
    aircraftCode: "VTL-001",
    groupId: "group-1",
    phase: status === "DIVERTING" ? "RETURN" : "TASK_EXECUTION",
    position: { longitude: 114, latitude: 22, altitudeMeters: 120 },
    currentTaskObjectId,
    completedTaskObjectIds: [],
    remainingEnergyWh: 220,
    remainingEnergyRatio: 0.22,
    eventIds: [],
    status
  }
}

describe("vtl action business outcome", () => {
  it("describes diversion, interrupted work, landing destination, and remaining tasks", () => {
    expect(vtlActionBusinessOutcome({
      actionCode: "DIVERT_AIRCRAFT",
      beforeAircraft: aircraft("ACTIVE", "task-1"),
      afterAircraft: aircraft("DIVERTING", null),
      taskObjects,
      assignedTaskObjectIds: ["task-1"],
      landingSiteTitle: "东侧备降点"
    }).businessConsequences).toEqual([
      "VTL-001：运行状态由“执行中”变为“备降”",
      "VTL-001：飞行阶段由“任务执行”变为“返航”",
      "VTL-001：已停止当前巡检任务“OBJ-01 · 输电杆塔巡检”",
      "VTL-001：已转向备降点“东侧备降点”",
      "VTL-001：1 项未完成巡检任务需要重新安排"
    ])
  })

  it("does not claim deadline compliance when no deadline is configured", () => {
    expect(vtlActionWithinDeadline(null, 12_000)).toBeNull()
    expect(vtlActionWithinDeadline(15_000, 12_000)).toBe(true)
    expect(vtlActionWithinDeadline(10_000, 12_000)).toBe(false)
  })
})
