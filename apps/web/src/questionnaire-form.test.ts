import { describe, expect, it } from "vitest"
import { answerFieldsFor, fieldValuesFromAnswer, isQuestionAnswerComplete, questionFieldLabel, structuredAnswerFromFields } from "./questionnaire-form"

describe("questionnaire structured answer form", () => {
  it("uses business labels for known structured answer fields", () => {
    expect(questionFieldLabel("routePlan")).toBe("航线方案")
    expect(questionFieldLabel("safetyCheck")).toBe("安全检查")
    expect(questionFieldLabel("assignments")).toBe("订单分配")
    expect(questionFieldLabel("conflictCheck")).toBe("冲突检查")
    expect(questionFieldLabel("fallback")).toBe("备选方案")
    expect(questionFieldLabel("trajectoryPlan")).toBe("舞步轨迹")
    expect(questionFieldLabel("taskOrder")).toBe("任务点顺序")
    expect(questionFieldLabel("divertAction")).toBe("备降动作")
    expect(questionFieldLabel("eventAssessment")).toBe("事件评估")
    expect(questionFieldLabel("actionPlan")).toBe("处置方案")
    expect(questionFieldLabel("customField")).toBe("customField")
  })

  it("uses safe field metadata without exposing grading details", () => {
    expect(answerFieldsFor({ answerFields: ["routePlan", "safetyCheck"] })).toEqual(["routePlan", "safetyCheck"])
    expect(answerFieldsFor({})).toEqual([])
  })

  it("round-trips required fields and omits blank values", () => {
    const fields = ["routePlan", "safetyCheck"]
    expect(fieldValuesFromAnswer({ routePlan: "备用航线", safetyCheck: true }, fields)).toEqual({ routePlan: "备用航线", safetyCheck: "true" })
    expect(structuredAnswerFromFields({ routePlan: "  备用航线 ", safetyCheck: "" }, fields)).toEqual({ routePlan: "备用航线" })
    expect(structuredAnswerFromFields({ routePlan: "", safetyCheck: "" }, fields)).toBeNull()
  })

  it("detects completed choice and structured answers", () => {
    expect(isQuestionAnswerComplete("A")).toBe(true)
    expect(isQuestionAnswerComplete([])).toBe(false)
    expect(isQuestionAnswerComplete({ routePlan: "航线", safetyCheck: "已检查" }, ["routePlan", "safetyCheck"])).toBe(true)
    expect(isQuestionAnswerComplete({ routePlan: "航线", safetyCheck: "" }, ["routePlan", "safetyCheck"])).toBe(false)
  })
})
