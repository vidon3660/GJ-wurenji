import { describe, expect, it } from "vitest"
import { validateExerciseTemplateDraft } from "./exercise-library-validation"

describe("exercise library template validation", () => {
  it("requires the three fields needed by the server", () => {
    expect(validateExerciseTemplateDraft({ title: "模板", summary: "摘要", taskBrief: "任务" })).toBeNull()
    expect(validateExerciseTemplateDraft({ title: "模板", summary: " ", taskBrief: "任务" })).toBe("请填写模板名称、摘要和学生任务说明")
  })
})
