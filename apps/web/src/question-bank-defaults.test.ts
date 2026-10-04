import { describe, expect, it } from "vitest"
import type { QuestionBankSummary } from "@wurenji/shared"
import { defaultQuestionBankForScene } from "./question-bank-defaults"

function bank(overrides: Partial<QuestionBankSummary>): QuestionBankSummary {
  return {
    id: "bank-id",
    title: "示例题库",
    sceneType: "CITY_LOGISTICS",
    summary: "用于测试",
    status: "PUBLISHED",
    currentVersion: 1,
    latestVersionId: "version-id",
    publishedVersionId: "version-id",
    publishedVersion: null,
    questionCount: 1,
    questionTypes: ["PLANNING"],
    difficulties: ["BEGINNER"],
    knowledgePoints: ["安全"],
    usageCount: 0,
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides
  }
}

describe("default question bank selection", () => {
  it("selects the scene-specific published bank over a generic bank", () => {
    const result = defaultQuestionBankForScene([
      bank({ id: "generic", sceneType: null, title: "通用题库" }),
      bank({ id: "show", sceneType: "CITY_SHOW", title: "编队表演题库" })
    ], "CITY_SHOW")
    expect(result?.id).toBe("show")
  })

  it("selects the newest published bank for the scene", () => {
    const result = defaultQuestionBankForScene([
      bank({ id: "old", updatedAt: "2026-08-01T00:00:00.000Z" }),
      bank({ id: "new", updatedAt: "2026-09-20T00:00:00.000Z" })
    ], "CITY_LOGISTICS")
    expect(result?.id).toBe("new")
  })

  it("does not select draft-only or unrelated banks", () => {
    const result = defaultQuestionBankForScene([
      bank({ id: "draft", publishedVersionId: null }),
      bank({ id: "vtl", sceneType: "VTOL_INSPECTION" })
    ], "CITY_SHOW")
    expect(result).toBeNull()
  })
})
