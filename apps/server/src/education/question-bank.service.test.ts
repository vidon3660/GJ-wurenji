import { describe, expect, it, vi } from "vitest"
import type { AuthUser, QuestionDefinition } from "@wurenji/shared"
import type { DataSource, EntityManager, Repository } from "typeorm"
import { ProjectEvaluationEntity } from "../v3/runtime/runtime.entities.js"
import { AssignmentSnapshotEntity, StudentProjectEntity } from "../v3/assignments/assignment.entities.js"
import { QuestionAttemptEntity, QuestionBankEntity, QuestionBankVersionEntity, QuestionResponseEntity } from "./question-bank.entities.js"
import { QuestionBankService } from "./question-bank.service.js"

const teacher = { id: "teacher-1", email: "teacher@example.com", displayName: "教师", role: "teacher" } as AuthUser
const otherTeacher = { id: "teacher-2", email: "other@example.com", displayName: "其他教师", role: "teacher" } as AuthUser

function question(code: string, type: QuestionDefinition["type"], maxScore: number): QuestionDefinition {
  return {
    code,
    type,
    difficulty: "BEGINNER",
    knowledgePoints: [],
    prompt: code,
    options: type === "TRUE_FALSE" ? [{ key: "TRUE", label: "正确" }, { key: "FALSE", label: "错误" }] : [],
    correctAnswer: type === "TRUE_FALSE" ? true : null,
    explanation: "用于测试判定结果",
    maxScore,
    stageCode: null,
    gradingRule: type === "SIMULATION_EVIDENCE" ? { kind: "METRIC_THRESHOLD", metricCode: "ON_TIME_DELIVERY", operator: "GTE", threshold: 90 } : { kind: "EXACT" },
    sortOrder: Number(code.split("-").at(-1)) || 1
  }
}

function buildService(options: {
  project: StudentProjectEntity
  version: QuestionBankVersionEntity
  attempt: QuestionAttemptEntity
  responses: QuestionResponseEntity[]
  evaluation: ProjectEvaluationEntity
}) {
  const manager = {
    findOne: vi.fn().mockImplementation((entity: unknown) => {
      if (entity === StudentProjectEntity) return options.project
      if (entity === QuestionBankVersionEntity) return options.version
      if (entity === QuestionAttemptEntity) return options.attempt
      if (entity === ProjectEvaluationEntity) return options.evaluation
      return null
    }),
    findOneByOrFail: vi.fn().mockResolvedValue(teacher),
    find: vi.fn().mockResolvedValue(options.responses),
    save: vi.fn().mockImplementation(async (...args: unknown[]) => args.length === 1 ? args[0] : args[1]),
    create: vi.fn().mockImplementation((_entity: unknown, value: unknown) => value)
  } as unknown as EntityManager
  const dataSource = { transaction: vi.fn((callback: (value: EntityManager) => unknown) => callback(manager)) } as unknown as DataSource
  const projects = { findOne: vi.fn().mockResolvedValue(options.project), manager } as unknown as Repository<StudentProjectEntity>
  const versions = { findOne: vi.fn().mockResolvedValue(options.version) } as unknown as Repository<QuestionBankVersionEntity>
  const attempts = { findOne: vi.fn().mockResolvedValue(options.attempt) } as unknown as Repository<QuestionAttemptEntity>
  const responses = { find: vi.fn().mockResolvedValue(options.responses) } as unknown as Repository<QuestionResponseEntity>
  const activities = { record: vi.fn().mockResolvedValue(undefined) }
  const evaluations = { findOne: vi.fn().mockResolvedValue(options.evaluation) } as unknown as Repository<ProjectEvaluationEntity>
  const service = new QuestionBankService(
    {} as Repository<never>,
    {} as Repository<QuestionBankEntity>,
    versions,
    attempts,
    responses,
    projects,
    {} as never,
    evaluations,
    activities as never,
    { assertWritable: vi.fn().mockResolvedValue(undefined) } as never,
    dataSource
  )
  return { service, manager, activities }
}

function fixture() {
  const owner = { id: teacher.id, displayName: teacher.displayName, role: teacher.role }
  const student = { id: "student-1", displayName: "学生", role: "student" }
  const questions = [question("TRUE-01", "TRUE_FALSE", 10), question("EVIDENCE-02", "SIMULATION_EVIDENCE", 20)]
  const bank = { id: "bank-1", title: "物流题库", sceneType: "CITY_LOGISTICS", summary: "", createdBy: owner }
  const version = { id: "version-1", version: 1, status: "PUBLISHED", bank, questions } as unknown as QuestionBankVersionEntity
  const project = {
    id: "project-1",
    student,
    currentStageCode: "LOGISTICS_REVIEW",
    snapshot: {
      sceneType: "CITY_LOGISTICS",
      mode: "TRAINING",
      config: {
        questionBankVersionId: version.id,
        availableAt: "2026-09-08T00:00:00.000Z",
        dueAt: "2026-09-10T00:00:00.000Z"
      },
      draft: { id: "assignment-1", createdBy: owner }
    }
  } as unknown as StudentProjectEntity
  const attempt = {
    id: "attempt-1",
    project,
    bankVersion: version,
    student,
    status: "SUBMITTED",
    revision: 2,
    autoScore: 10,
    teacherScore: null,
    maxScore: 30,
    submittedAt: new Date("2026-09-09T01:00:00Z"),
    reviewedAt: null,
    reviewedBy: null,
    reviewComment: ""
  } as unknown as QuestionAttemptEntity
  const responses = [
    { id: "response-1", attempt, questionCode: "TRUE-01", answer: true, autoScore: 10, maxScore: 10, judgment: "CORRECT", evidence: [], teacherScore: 7, teacherComment: "保留教师评语" },
    { id: "response-2", attempt, questionCode: "EVIDENCE-02", answer: null, autoScore: null, maxScore: 20, judgment: "PENDING", evidence: [], teacherScore: null, teacherComment: "" }
  ] as unknown as QuestionResponseEntity[]
  const evaluation = { projectId: project.id, objectiveMetrics: [{ code: "ON_TIME_DELIVERY", label: "准时到达率", value: 95, displayValue: "95%", unit: "%", state: "PASS", detail: "" }] } as unknown as ProjectEvaluationEntity
  return { project, version, attempt, responses, evaluation }
}

describe("QuestionBankService regrade", () => {
  it("refreshes pending evidence when a questionnaire is reopened after metrics arrive", async () => {
    const value = fixture()
    const { service, activities } = buildService(value)
    const student = { id: value.project.student.id, email: "student@example.com", displayName: "学生", role: "student" } as AuthUser

    const result = await service.questionnaire(value.project.id, student)

    expect(value.attempt.status).toBe("GRADED")
    expect(value.attempt.revision).toBe(3)
    expect(value.responses[1]).toMatchObject({ autoScore: 20, judgment: "CORRECT" })
    expect(result.attempt).toMatchObject({ status: "GRADED", autoScore: 30, revision: 3 })
    expect(activities.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "QUESTION_ATTEMPT_REGRADED", payload: expect.objectContaining({ automatic: true }) }))
  })

  it("regrades pending evidence from server metrics and preserves teacher fields", async () => {
    const value = fixture()
    const { service, activities } = buildService(value)

    const result = await service.regradeQuestionnaire(value.project.id, teacher, { expectedRevision: 2 })

    expect(value.attempt.status).toBe("GRADED")
    expect(value.attempt.revision).toBe(3)
    expect(value.attempt.autoScore).toBe(30)
    expect(value.responses[0]).toMatchObject({ teacherScore: 7, teacherComment: "保留教师评语" })
    expect(value.responses[1]).toMatchObject({ autoScore: 20, judgment: "CORRECT" })
    expect(result.canRegrade).toBe(false)
    expect(result.attempt).toMatchObject({ status: "GRADED", autoScore: 30, revision: 3 })
    expect(result.responses.find((item) => item.questionCode === "EVIDENCE-02")).toMatchObject({ autoScore: 20, judgment: "CORRECT" })
    expect(activities.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "QUESTION_ATTEMPT_REGRADED", result: expect.objectContaining({ pendingCount: 0, autoScore: 30 }) }))
  })

  it("keeps the attempt submitted when metrics are still unavailable", async () => {
    const value = fixture()
    value.evaluation.objectiveMetrics = []
    const { service } = buildService(value)

    const result = await service.regradeQuestionnaire(value.project.id, teacher, { expectedRevision: 2 })

    expect(value.attempt.status).toBe("SUBMITTED")
    expect(value.attempt.autoScore).toBe(10)
    expect(result.canRegrade).toBe(true)
    expect(result.responses.find((item) => item.questionCode === "EVIDENCE-02")).toMatchObject({ autoScore: null, judgment: "PENDING" })
  })

  it("rejects unauthorized teachers and reviewed attempts", async () => {
    const unauthorized = fixture()
    const unauthorizedService = buildService(unauthorized).service
    unauthorized.project.snapshot.draft.createdBy = { id: teacher.id, displayName: teacher.displayName, role: teacher.role }
    await expect(unauthorizedService.regradeQuestionnaire(unauthorized.project.id, otherTeacher, { expectedRevision: 2 })).rejects.toThrow("无权查看该学生项目")

    const reviewed = fixture()
    reviewed.attempt.status = "REVIEWED"
    const reviewedService = buildService(reviewed).service
    await expect(reviewedService.regradeQuestionnaire(reviewed.project.id, teacher, { expectedRevision: 2 })).rejects.toThrow("只有已提交且尚未完成教师复核的作答才能重新判定")
    await expect(reviewedService.reviewQuestionnaire(reviewed.project.id, teacher, { expectedRevision: 2, responses: [], reviewComment: "重复复核" })).rejects.toThrow("该题库作答已完成复核或尚未提交，不能重复复核")
  })

  it("rejects answer codes that are not part of the published question bank", async () => {
    const value = fixture()
    value.attempt.status = "IN_PROGRESS"
    value.attempt.revision = 1
    const { service, manager } = buildService(value)
    const student = { id: value.project.student.id, email: "student@example.com", displayName: "学生", role: "student" } as AuthUser

    await expect(service.saveQuestionnaire(value.project.id, student, {
      expectedRevision: 1,
      responses: [{ questionCode: "UNKNOWN-99", answer: true }]
    })).rejects.toThrow("作答题目不存在：UNKNOWN-99")
    expect(manager.save).not.toHaveBeenCalled()
  })

  it("treats a retried submit as idempotent after the attempt is already submitted", async () => {
    const value = fixture()
    value.responses[1]!.judgment = "CORRECT"
    value.responses[1]!.autoScore = 20
    const { service, manager } = buildService(value)
    const student = { id: value.project.student.id, email: "student@example.com", displayName: "学生", role: "student" } as AuthUser

    const result = await service.saveQuestionnaire(value.project.id, student, {
      expectedRevision: value.attempt.revision,
      responses: []
    }, true)

    expect(result.attempt).toMatchObject({ status: "SUBMITTED", revision: value.attempt.revision })
    expect(manager.save).not.toHaveBeenCalled()
  })

  it("hides assessment scores and evidence from students before the teacher publishes results", async () => {
    const value = fixture()
    value.project.snapshot.mode = "ASSESSMENT"
    value.project.snapshot.config.resultVisibility = "FULL_REVIEW"
    value.evaluation.status = "REVIEWED"
    const { service } = buildService(value)
    const student = { id: value.project.student.id, email: "student@example.com", displayName: "学生", role: "student" } as AuthUser

    const result = await service.questionnaire(value.project.id, student)

    expect(result.attempt).toMatchObject({ autoScore: 0, teacherScore: null, reviewComment: "" })
    expect(result.responses.every((response) => response.autoScore === null && response.judgment === "UNANSWERED" && response.evidence.length === 0)).toBe(true)
  })

  it("does not expose answers or grading rules in the student questionnaire view", async () => {
    const value = fixture()
    const { service } = buildService(value)
    const student = { id: value.project.student.id, email: "student@example.com", displayName: "学生", role: "student" } as AuthUser

    const result = await service.questionnaire(value.project.id, student)

    expect(result.actor).toBe("STUDENT")
    expect(result.questions).toHaveLength(2)
    expect(result.questions.every((item) => !Object.prototype.hasOwnProperty.call(item, "correctAnswer"))).toBe(true)
    expect(result.questions.every((item) => !Object.prototype.hasOwnProperty.call(item, "explanation"))).toBe(true)
    expect(result.questions.every((item) => !Object.prototype.hasOwnProperty.call(item, "gradingRule"))).toBe(true)
    expect(result.responses.every((item) => item.teacherScore === null && item.teacherComment === "")).toBe(true)
  })
})

describe("QuestionBankService audit", () => {
  it("reports invalid historical versions without aborting the whole audit", async () => {
    const valid = fixture()
    const invalid = fixture()
    invalid.version.id = "version-invalid"
    invalid.version.version = 2
    invalid.version.questions = [{ code: "BROKEN-01", type: "SIMULATION_EVIDENCE", difficulty: "BEGINNER", knowledgePoints: [], prompt: "缺少指标", options: [], correctAnswer: null, explanation: "", maxScore: 10, stageCode: null, gradingRule: { kind: "EXACT" } }] as never
    const archived = { ...invalid.version, id: "version-archived", version: 3, status: "ARCHIVED", questions: [] } as QuestionBankVersionEntity
    const { service } = buildService(valid)
    ;(service as unknown as { banks: { find: () => Promise<unknown[]> }; versions: { find: () => Promise<unknown[]> } }).banks.find = vi.fn().mockResolvedValue([{ id: "bank-1", title: "物流题库", sceneType: "CITY_LOGISTICS", createdBy: { id: teacher.id } }])
    ;(service as unknown as { versions: { find: () => Promise<unknown[]> } }).versions.find = vi.fn().mockResolvedValue([valid.version, invalid.version, archived])
    const result = await service.auditVersions(teacher)
    expect(result.summary).toMatchObject({ bankCount: 1, versionCount: 2, archivedVersionCount: 1, validVersionCount: 1, invalidVersionCount: 1 })
    expect(result.versions.find((item) => item.versionId === "version-invalid")).toMatchObject({ valid: false, issueCategory: "INVALID_CONTENT", issues: ["第 1 道仿真证据题必须配置指标阈值规则"] })
    expect(result.versions.find((item) => item.versionId === "version-archived")).toMatchObject({ status: "ARCHIVED", valid: true, issueCategory: null })
  })

  it("keeps another teacher's versions out of the audit result", async () => {
    const value = fixture()
    const { service } = buildService(value)
    ;(service as unknown as { banks: { find: () => Promise<unknown[]> }; versions: { find: () => Promise<unknown[]> } }).banks.find = vi.fn().mockResolvedValue([
      { id: "bank-1", title: "我的题库", sceneType: "CITY_LOGISTICS", createdBy: { id: teacher.id } },
      { id: "bank-other", title: "其他教师题库", sceneType: "CITY_LOGISTICS", createdBy: { id: otherTeacher.id } }
    ])
    ;(service as unknown as { versions: { find: () => Promise<unknown[]> } }).versions.find = vi.fn().mockResolvedValue([
      value.version,
      { ...value.version, id: "version-other", bank: { id: "bank-other", title: "其他教师题库", sceneType: "CITY_LOGISTICS" } }
    ])

    const result = await service.auditVersions(teacher)

    expect(result.summary.bankCount).toBe(1)
    expect(result.versions.map((item) => item.versionId)).toEqual([value.version.id])
  })
})

describe("QuestionBankService empty draft archive", () => {
  function archiveFixture(options: { fallback?: QuestionBankVersionEntity | null; referenceCount?: number; questions?: QuestionDefinition[] } = {}) {
    const owner = { id: teacher.id, displayName: teacher.displayName, role: teacher.role }
    const bank = {
      id: "bank-archive",
      title: "待治理题库",
      sceneType: "CITY_LOGISTICS",
      summary: "历史验收数据",
      status: "DRAFT",
      currentVersion: 2,
      createdBy: owner
    } as unknown as QuestionBankEntity
    const version = {
      id: "version-empty",
      bank,
      version: 2,
      status: "DRAFT",
      questions: options.questions ?? [],
      createdBy: owner,
      changeNote: "空草稿",
      publishedAt: null
    } as unknown as QuestionBankVersionEntity
    const fallback = options.fallback === undefined
      ? ({ id: "version-published", bank, version: 1, status: "PUBLISHED", questions: [question("TRUE-01", "TRUE_FALSE", 10)] } as unknown as QuestionBankVersionEntity)
      : options.fallback
    const query = vi.fn().mockImplementation(async (sql: string) => sql.includes("FOR UPDATE")
      ? [{ id: bank.id }]
      : [{ count: String(options.referenceCount ?? 0) }])
    const manager = {
      query,
      findOne: vi.fn().mockImplementation(async (entity: unknown, findOptions: { where?: { id?: string } }) => {
        if (entity === QuestionBankEntity) return bank
        if (entity === QuestionBankVersionEntity && findOptions.where?.id) return version
        if (entity === QuestionBankVersionEntity) return fallback
        return null
      }),
      save: vi.fn().mockImplementation(async (...args: unknown[]) => args.length === 1 ? args[0] : args[1])
    } as unknown as EntityManager
    const activities = { record: vi.fn().mockResolvedValue(undefined) }
    const dataSource = { transaction: vi.fn((callback: (value: EntityManager) => unknown) => callback(manager)) } as unknown as DataSource
    const service = new QuestionBankService(
      {} as Repository<never>,
      {} as Repository<QuestionBankEntity>,
      {} as Repository<QuestionBankVersionEntity>,
      {} as Repository<QuestionAttemptEntity>,
      {} as Repository<QuestionResponseEntity>,
      {} as Repository<StudentProjectEntity>,
      {} as never,
      {} as Repository<ProjectEvaluationEntity>,
      activities as never,
      {} as never,
      dataSource
    )
    return { service, bank, version, fallback, manager, activities }
  }

  it("archives an empty current draft and restores the latest active version", async () => {
    const value = archiveFixture()

    const result = await value.service.archiveEmptyDraftVersion(value.bank.id, value.version.id, teacher)

    expect(value.version.status).toBe("ARCHIVED")
    expect(value.bank).toMatchObject({ status: "PUBLISHED", currentVersion: 1 })
    expect(result).toEqual({ bankId: value.bank.id, versionId: value.version.id, archived: true, alreadyArchived: false, bankArchived: false, fallbackVersionId: value.fallback?.id })
    expect(value.activities.record).toHaveBeenCalledWith(value.manager, expect.objectContaining({ eventType: "QUESTION_BANK_VERSION_ARCHIVED", result: expect.objectContaining({ bankArchived: false }) }))
  })

  it("archives the bank when its only version is an empty draft", async () => {
    const value = archiveFixture({ fallback: null })

    const result = await value.service.archiveEmptyDraftVersion(value.bank.id, value.version.id, teacher)

    expect(value.bank.status).toBe("ARCHIVED")
    expect(result).toMatchObject({ archived: true, bankArchived: true, fallbackVersionId: null })
  })

  it("blocks archive when a task references the draft", async () => {
    const value = archiveFixture({ referenceCount: 1 })

    await expect(value.service.archiveEmptyDraftVersion(value.bank.id, value.version.id, teacher)).rejects.toThrow("该题库版本已被任务引用，不能归档")
    expect(value.version.status).toBe("DRAFT")
    expect(value.activities.record).not.toHaveBeenCalled()
  })

  it("blocks archive when the draft contains questions", async () => {
    const value = archiveFixture({ questions: [question("TRUE-01", "TRUE_FALSE", 10)] })

    await expect(value.service.archiveEmptyDraftVersion(value.bank.id, value.version.id, teacher)).rejects.toThrow("只有不含题目的空草稿可以归档")
    expect(value.version.status).toBe("DRAFT")
  })

  it("automatically archives the empty placeholder when the first real version is saved", async () => {
    const owner = { id: teacher.id, displayName: teacher.displayName, role: teacher.role }
    const bank = { id: "bank-first-save", title: "新题库", sceneType: "CITY_LOGISTICS", summary: "首次保存", status: "DRAFT", currentVersion: 1, createdBy: owner, updatedAt: new Date("2026-09-16T00:00:00Z") } as unknown as QuestionBankEntity
    const placeholder = { id: "version-placeholder", bank, version: 1, status: "DRAFT", questions: [], createdBy: owner, changeNote: "初始版本", publishedAt: null, createdAt: new Date("2026-09-16T00:00:00Z") } as unknown as QuestionBankVersionEntity
    let createdVersion: QuestionBankVersionEntity | null = null
    const manager = {
      query: vi.fn().mockImplementation(async (sql: string) => sql.includes("FOR UPDATE") ? [{ id: bank.id }] : [{ count: "0" }]),
      findOne: vi.fn().mockImplementation(async (entity: unknown) => entity === QuestionBankEntity ? bank : placeholder),
      findOneByOrFail: vi.fn().mockResolvedValue(owner),
      create: vi.fn().mockImplementation((_entity: unknown, value: Record<string, unknown>) => ({ id: "version-real", createdAt: new Date("2026-09-16T00:01:00Z"), ...value })),
      save: vi.fn().mockImplementation(async (...args: unknown[]) => {
        const value = args.length === 1 ? args[0] : args[1]
        if ((value as { id?: string }).id === "version-real") createdVersion = value as QuestionBankVersionEntity
        return value
      })
    } as unknown as EntityManager
    const banks = { findOne: vi.fn().mockResolvedValue(bank) } as unknown as Repository<QuestionBankEntity>
    const versions = { find: vi.fn().mockImplementation(async () => [createdVersion, placeholder].filter(Boolean)) } as unknown as Repository<QuestionBankVersionEntity>
    const activities = { record: vi.fn().mockResolvedValue(undefined) }
    const dataSource = { transaction: vi.fn((callback: (value: EntityManager) => unknown) => callback(manager)) } as unknown as DataSource
    const service = new QuestionBankService(
      {} as Repository<never>, banks, versions, {} as Repository<QuestionAttemptEntity>, {} as Repository<QuestionResponseEntity>,
      {} as Repository<StudentProjectEntity>, {} as never, {} as Repository<ProjectEvaluationEntity>, activities as never, {} as never, dataSource
    )

    const detail = await service.createVersion(bank.id, teacher, { questions: [question("TRUE-01", "TRUE_FALSE", 10)], changeNote: "首次录入题目" })

    expect(placeholder.status).toBe("ARCHIVED")
    expect(createdVersion).toMatchObject({ version: 2, status: "DRAFT" })
    expect(bank).toMatchObject({ currentVersion: 2, status: "DRAFT" })
    expect(detail.versions.map((item) => [item.version, item.status])).toEqual([[2, "DRAFT"], [1, "ARCHIVED"]])
    expect(activities.record).toHaveBeenCalledWith(manager, expect.objectContaining({ eventType: "QUESTION_BANK_VERSION_ARCHIVED", payload: expect.objectContaining({ automatic: true }) }))
  })
})

it("treats already archived versions as a batch cleanup no-op", async () => {
  const owner = { id: teacher.id, displayName: teacher.displayName, role: teacher.role }
  const bank = { id: "bank-batch", title: "历史题库", sceneType: "CITY_SHOW", createdBy: owner, status: "ARCHIVED", currentVersion: 1 }
  const version = { id: "version-batch-archived", version: 1, status: "ARCHIVED", bank, questions: [] }
  const manager = {
    query: vi.fn().mockResolvedValue([{ id: bank.id }]),
    findOne: vi.fn().mockImplementation((entity: unknown) => entity === QuestionBankVersionEntity ? version : bank),
    save: vi.fn()
  } as unknown as EntityManager
  const service = new QuestionBankService(
    {} as Repository<never>,
    {} as Repository<QuestionBankEntity>,
    { findOne: vi.fn().mockResolvedValue(version) } as unknown as Repository<QuestionBankVersionEntity>,
    {} as Repository<QuestionAttemptEntity>,
    {} as Repository<QuestionResponseEntity>,
    {} as Repository<StudentProjectEntity>,
    {} as Repository<AssignmentSnapshotEntity>,
    {} as Repository<ProjectEvaluationEntity>,
    { record: vi.fn() } as never,
    {} as never,
    { transaction: vi.fn((callback: (value: EntityManager) => unknown) => callback(manager)) } as unknown as DataSource
  )
  await expect(service.archiveEmptyDraftVersions([version.id], teacher)).resolves.toMatchObject({ requestedVersionCount: 1, archivedVersionCount: 0, archivedVersionIds: [] })
  expect(manager.save).not.toHaveBeenCalled()
})
