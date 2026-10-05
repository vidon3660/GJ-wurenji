import type { StudentProjectStageView, StudentProjectView } from "@wurenji/shared"
import { describe, expect, it } from "vitest"
import { isSimulationStage, projectSimulationStage, simulationEntryCondition, simulationEntryStatus } from "./simulation-entry"

describe("student simulation entry", () => {
  it.each([
    ["CITY_LOGISTICS", "LOGISTICS_DELIVERY_RUNTIME", "LOGISTICS_EMERGENCY_HANDLING"],
    ["VTOL_INSPECTION", "VTL_RUNTIME", "VTL_EMERGENCY_HANDLING"]
  ] as const)("prioritizes the actionable %s stage over accepted history", (sceneType, completed, next) => {
    for (const status of ["AVAILABLE", "IN_PROGRESS", "RETURNED"] as const) {
      const project = {
        sceneType,
        currentStageCode: "REVIEW",
        stages: [stage(completed, "ACCEPTED"), stage(next, status)]
      } as unknown as StudentProjectView
      expect(projectSimulationStage(project)?.stageCode).toBe(next)
    }
  })

  it("labels returned work as needing changes instead of running", () => {
    expect(simulationEntryStatus(stage("SHOW_RUNTIME", "RETURNED"))).toBe("待修改")
  })

  it("finds the explicit show runtime stage even while it is locked", () => {
    const project = {
      sceneType: "CITY_SHOW",
      currentStageCode: "SHOW_AREA_PLANNING",
      stages: [stage("SHOW_AREA_PLANNING", "IN_PROGRESS"), stage("SHOW_RUNTIME", "LOCKED")]
    } as StudentProjectView

    expect(projectSimulationStage(project)?.stageCode).toBe("SHOW_RUNTIME")
    expect(simulationEntryStatus(projectSimulationStage(project))).toBe("待开放 · 完成前置阶段后开放")
    expect(simulationEntryCondition(projectSimulationStage(project))).toBe("完成前置阶段后开放")
  })

  it("keeps logistics emergency handling inside simulation mode", () => {
    const project = {
      sceneType: "CITY_LOGISTICS",
      currentStageCode: "LOGISTICS_EMERGENCY_HANDLING",
      stages: [
        stage("LOGISTICS_DELIVERY_RUNTIME", "ACCEPTED"),
        stage("LOGISTICS_EMERGENCY_HANDLING", "IN_PROGRESS")
      ]
    } as StudentProjectView

    expect(projectSimulationStage(project)?.stageCode).toBe("LOGISTICS_EMERGENCY_HANDLING")
    expect(isSimulationStage("LOGISTICS_EMERGENCY_HANDLING")).toBe(true)
    expect(simulationEntryStatus(projectSimulationStage(project))).toBe("运行中")
  })

  it("provides a stable action hint when the server omits the condition", () => {
    expect(simulationEntryCondition({ status: "LOCKED" } as StudentProjectStageView)).toBe("完成前置阶段后开放")
  })
})

function stage(stageCode: StudentProjectStageView["stageCode"], status: StudentProjectStageView["status"]): StudentProjectStageView {
  return { stageCode, status, sequence: 1, revision: 1 } as StudentProjectStageView
}
