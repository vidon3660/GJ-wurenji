import type { StudentProjectStageView, StudentProjectView } from "@wurenji/shared"
import { describe, expect, it } from "vitest"
import { isSimulationStage, projectSimulationStage, simulationEntryCondition, simulationEntryStatus } from "./simulation-entry"

describe("student simulation entry", () => {
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
