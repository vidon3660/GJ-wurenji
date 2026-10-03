import { BadRequestException } from "@nestjs/common"
import { describe, expect, it } from "vitest"
import { assertFormalAssignmentTitle, normalizeAssignmentDataClassification } from "./assignment.service.js"

describe("assignment data classification", () => {
  it("defaults new assignments to formal teaching data", () => {
    expect(normalizeAssignmentDataClassification({})).toEqual({ isDemo: false, isAcceptanceData: false })
  })

  it("validates explicit classification flags", () => {
    expect(normalizeAssignmentDataClassification({ isDemo: true })).toEqual({ isDemo: true, isAcceptanceData: false })
    expect(normalizeAssignmentDataClassification({ isAcceptanceData: true })).toEqual({ isDemo: false, isAcceptanceData: true })
    expect(normalizeAssignmentDataClassification({ isDemo: false, isAcceptanceData: false }, { isDemo: true, isAcceptanceData: false })).toEqual({ isDemo: false, isAcceptanceData: false })
  })

  it.each([
    { input: { isDemo: "true" }, message: "isDemo必须是布尔值" },
    { input: { isAcceptanceData: 1 }, message: "isAcceptanceData必须是布尔值" },
    { input: { isDemo: true, isAcceptanceData: true }, message: "不能同时标记" }
  ])("rejects invalid classification: $message", ({ input, message }) => {
    expect(() => normalizeAssignmentDataClassification(input)).toThrow(BadRequestException)
    expect(() => normalizeAssignmentDataClassification(input)).toThrow(message)
  })

  it("rejects internal test identifiers on formal task titles", () => {
    expect(() => assertFormalAssignmentTitle("P0 编队表演发布测试", { isDemo: false, isAcceptanceData: false })).toThrow("正式任务标题不能包含内部测试编号")
    expect(() => assertFormalAssignmentTitle("R12 垂起巡检全流程", { isDemo: true, isAcceptanceData: false })).not.toThrow()
    expect(() => assertFormalAssignmentTitle("城市物流基础训练", { isDemo: false, isAcceptanceData: false })).not.toThrow()
  })
})
