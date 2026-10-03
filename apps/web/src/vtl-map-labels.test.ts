import { describe, expect, it } from "vitest"
import { vtlLandingSiteLabelText, vtlTaskLabelText } from "./vtl-map-labels"

describe("VTL map task labels", () => {
  it("keeps complete labels for small task sets", () => {
    expect(vtlTaskLabelText({
      taskCount: 5,
      taskId: "task-1",
      code: "T-01",
      title: "巡检对象 01"
    })).toBe("T-01 巡检对象 01")
  })

  it("shows only selected context in dense task sets", () => {
    expect(vtlTaskLabelText({
      taskCount: 20,
      taskId: "task-1",
      code: "T-01",
      title: "巡检对象 01",
      selectedTaskId: "task-1"
    })).toBe("T-01 巡检对象 01")

    expect(vtlTaskLabelText({
      taskCount: 20,
      taskId: "task-2",
      code: "T-02",
      title: "巡检对象 02",
      selectedAircraftTaskIds: ["task-2"]
    })).toBe("T-02")

    expect(vtlTaskLabelText({
      taskCount: 20,
      taskId: "task-3",
      code: "T-03",
      title: "巡检对象 03",
      selectedAircraftTaskIds: ["task-2"]
    })).toBeNull()
  })

  it("keeps only the main landing-site label at the 20-aircraft scale", () => {
    expect(vtlLandingSiteLabelText({ aircraftCount: 20, siteId: "main", mainLandingSiteId: "main", code: "MAIN", title: "主起降点" })).toBe("MAIN 主起降点")
    expect(vtlLandingSiteLabelText({ aircraftCount: 20, siteId: "alternate", mainLandingSiteId: "main", code: "ALT", title: "备降点" })).toBeNull()
    expect(vtlLandingSiteLabelText({ aircraftCount: 5, siteId: "alternate", mainLandingSiteId: "main", code: "ALT", title: "备降点" })).toBe("ALT 备降点")
  })
})
