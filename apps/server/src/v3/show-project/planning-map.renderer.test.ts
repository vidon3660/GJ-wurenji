import { describe, expect, it } from "vitest"
import { PlanningMapRenderer } from "./planning-map.renderer.js"
import { completeFeatures, region } from "./area-plan.fixtures.js"

describe("planning map renderer", () => {
  it("renders a high-resolution PNG with the submitted source data", async () => {
    const content = await new PlanningMapRenderer().render({
      taskTitle: "区域规划测试任务",
      studentName: "测试学生",
      versionNo: 3,
      submittedAt: new Date("2026-08-05T08:00:00.000Z"),
      scaleTemplateCode: "SHOW_1000",
      region: region(),
      features: completeFeatures(),
      annotations: []
    })

    expect(content.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(content.byteLength).toBeGreaterThan(20_000)
  })
})
