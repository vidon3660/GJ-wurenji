import { describe, expect, it, vi } from "vitest"
import type { AuthUser, QuestionDefinition, SceneType } from "@wurenji/shared"
import type { Repository } from "typeorm"
import { ProjectEvaluationEntity } from "../v3/runtime/runtime.entities.js"
import { StudentProjectEntity } from "../v3/assignments/assignment.entities.js"
import { QuestionAttemptEntity, QuestionBankEntity, QuestionBankVersionEntity, QuestionResponseEntity } from "./question-bank.entities.js"
import { QuestionBankService } from "./question-bank.service.js"

const teacher = { id: "teacher-1", email: "teacher@example.com", displayName: "教师", role: "teacher" } as AuthUser

function makeBank(id: string, title: string, sceneType: SceneType | null, summary: string, ownerId = teacher.id): QuestionBankEntity {
  return {
    id,
    title,
    sceneType,
    summary,
    status: "PUBLISHED",
    currentVersion: 1,
    createdBy: { id: ownerId, displayName: "题库作者", role: ownerId === teacher.id ? "teacher" : "teacher" },
    updatedAt: new Date("2026-09-09T01:00:00Z")
  } as unknown as QuestionBankEntity
}

function makeVersion(bank: QuestionBankEntity, id: string): QuestionBankVersionEntity {
  const questions: QuestionDefinition[] = bank.sceneType === "CITY_LOGISTICS"
    ? [{ code: "SCHEDULE-01", type: "SCHEDULE", difficulty: "INTERMEDIATE", knowledgePoints: ["时刻规划"], prompt: "安排配送时刻", options: [], correctAnswer: null, explanation: "检查时间窗与航段衔接", maxScore: 10, stageCode: null, gradingRule: { kind: "REQUIRED_FIELDS", fields: ["schedule"] }, sortOrder: 1 }]
    : [{ code: "SAFETY-01", type: "TRUE_FALSE", difficulty: "BEGINNER", knowledgePoints: ["飞行安全"], prompt: "检查安全边界", options: [{ key: "TRUE", label: "正确" }, { key: "FALSE", label: "错误" }], correctAnswer: true, explanation: "核对安全边界", maxScore: 10, stageCode: null, gradingRule: { kind: "EXACT" }, sortOrder: 1 }]
  return {
    id,
    bank,
    version: 1,
    status: "PUBLISHED",
    questions,
    changeNote: "测试版本",
    publishedAt: new Date("2026-09-09T01:00:00Z"),
    createdAt: new Date("2026-09-09T01:00:00Z")
  } as unknown as QuestionBankVersionEntity
}

function buildService(banks: QuestionBankEntity[]) {
  const versionsByBank = new Map(banks.map((bank) => [bank.id, [makeVersion(bank, `version-${bank.id}`)]]))
  const bankRepository = { find: vi.fn().mockResolvedValue(banks) }
  const versionRepository = {
    find: vi.fn().mockResolvedValue([...versionsByBank.values()].flat())
  }
  const getRawMany = vi.fn().mockResolvedValue([{ versionId: "version-logistics", count: "1" }])
  const queryBuilder = {
    select: vi.fn(),
    addSelect: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
    getRawMany
  }
  queryBuilder.select.mockReturnValue(queryBuilder)
  queryBuilder.addSelect.mockReturnValue(queryBuilder)
  queryBuilder.where.mockReturnValue(queryBuilder)
  queryBuilder.groupBy.mockReturnValue(queryBuilder)
  const snapshotRepository = { createQueryBuilder: vi.fn().mockReturnValue(queryBuilder) }
  return new QuestionBankService(
    {} as Repository<never>,
    bankRepository as unknown as Repository<QuestionBankEntity>,
    versionRepository as unknown as Repository<QuestionBankVersionEntity>,
    {} as Repository<QuestionAttemptEntity>,
    {} as Repository<QuestionResponseEntity>,
    {} as Repository<StudentProjectEntity>,
    snapshotRepository as never,
    {} as Repository<ProjectEvaluationEntity>,
    {} as never,
    {} as never,
    {} as never,
    {} as never
  )
}

describe("QuestionBankService listBanks", () => {
  it("filters by scene and title or summary without exposing another teacher's bank", async () => {
    const service = buildService([
      makeBank("logistics", "物流配送基础题库", "CITY_LOGISTICS", "覆盖准时率和航线安全"),
      makeBank("show", "城市编队表演题库", "CITY_SHOW", "覆盖队形和观演区安全"),
      makeBank("other", "其他教师题库", "CITY_LOGISTICS", "准时率练习", "teacher-2")
    ])

    const result = await service.listBanks(teacher, "CITY_LOGISTICS", "准时率")

    expect(result.map((bank) => bank.id)).toEqual(["logistics"])
  })

  it("accepts an empty search and rejects an oversized search", async () => {
    const service = buildService([makeBank("logistics", "物流配送基础题库", "CITY_LOGISTICS", "物流安全")])

    await expect(service.listBanks(teacher, undefined, "   ")).resolves.toHaveLength(1)
    await expect(service.listBanks(teacher, undefined, "x".repeat(101))).rejects.toThrow("题库搜索词不能超过 100 个字符")
  })

  it("filters by current question metadata and real assignment usage", async () => {
    const service = buildService([
      makeBank("logistics", "物流配送基础题库", "CITY_LOGISTICS", "物流安全"),
      makeBank("show", "城市编队表演题库", "CITY_SHOW", "编队安全")
    ])

    const result = await service.listBanks(teacher, undefined, undefined, "SCHEDULE", "INTERMEDIATE", "时刻", "USED")

    expect(result).toEqual([expect.objectContaining({
      id: "logistics",
      questionTypes: ["SCHEDULE"],
      difficulties: ["INTERMEDIATE"],
      knowledgePoints: ["时刻规划"],
      usageCount: 1
    })])
  })
})
