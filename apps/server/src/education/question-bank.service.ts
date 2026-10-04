import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import type {
  AuthUser,
  QuestionAnswer,
  QuestionAttemptRegradeInput,
  QuestionAttemptReviewInput,
  QuestionAttemptSaveInput,
  QuestionAttemptView,
  QuestionBankCreateInput,
  QuestionBankDetail,
  QuestionBankSummary,
  QuestionBankVersionArchiveResult,
  QuestionBankCleanupPreview,
  QuestionBankCleanupBatchResult,
  QuestionBankVersionDetail,
  QuestionBankVersionInput,
  QuestionBankVersionSummary,
  QuestionDifficulty,
  QuestionnaireView,
  QuestionResponseInput,
  QuestionResponseView,
  QuestionType,
  QuestionView,
  SceneType,
  ShowObjectiveMetricView
} from "@wurenji/shared"
import { DataSource, EntityManager, In, Repository } from "typeorm"
import { UserEntity } from "../entities.js"
import { ActivityLogService } from "../v3/activities/activity-log.service.js"
import { AssessmentWindowService, assessmentTimingForProject } from "../v3/assessment/assessment-window.service.js"
import { canonicalJson } from "../v3/common/canonical-json.js"
import { ProjectEvaluationEntity } from "../v3/runtime/runtime.entities.js"
import { AssignmentSnapshotEntity, StudentProjectEntity } from "../v3/assignments/assignment.entities.js"
import {
  QuestionAttemptEntity,
  QuestionBankEntity,
  QuestionBankVersionEntity,
  QuestionResponseEntity
} from "./question-bank.entities.js"
import { gradeQuestion, normalizeQuestionDefinitions } from "./question-bank.validation.js"

@Injectable()
export class QuestionBankService {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(QuestionBankEntity) private readonly banks: Repository<QuestionBankEntity>,
    @InjectRepository(QuestionBankVersionEntity) private readonly versions: Repository<QuestionBankVersionEntity>,
    @InjectRepository(QuestionAttemptEntity) private readonly attempts: Repository<QuestionAttemptEntity>,
    @InjectRepository(QuestionResponseEntity) private readonly responses: Repository<QuestionResponseEntity>,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(AssignmentSnapshotEntity) private readonly snapshots: Repository<AssignmentSnapshotEntity>,
    @InjectRepository(ProjectEvaluationEntity) private readonly evaluations: Repository<ProjectEvaluationEntity>,
    private readonly activities: ActivityLogService,
    private readonly assessmentWindows: AssessmentWindowService,
    private readonly dataSource: DataSource
  ) {}

  async listBanks(
    user: AuthUser,
    sceneType?: SceneType,
    search?: string,
    questionType?: QuestionType,
    difficulty?: QuestionDifficulty,
    knowledgePoint?: string,
    usage?: "USED" | "UNUSED"
  ): Promise<QuestionBankSummary[]> {
    this.requireTeacher(user)
    const normalizedSearch = normalizeSearch(search)
    const normalizedQuestionType = normalizeQuestionTypeFilter(questionType)
    const normalizedDifficulty = normalizeQuestionDifficultyFilter(difficulty)
    const normalizedKnowledgePoint = normalizeKnowledgePointFilter(knowledgePoint)
    const normalizedUsage = normalizeUsageFilter(usage)
    const banks = (await this.banks.find({ order: { updatedAt: "DESC" } })).filter((bank) => bank.status !== "ARCHIVED")
    const visible = banks.filter((bank) => {
      if (user.role !== "admin" && bank.createdBy.id !== user.id) return false
      if (sceneType && bank.sceneType !== sceneType) return false
      if (!normalizedSearch) return true
      return `${bank.title}\n${bank.summary}`.toLocaleLowerCase().includes(normalizedSearch)
    })
    if (visible.length === 0) return []
    const versions = await this.versions.find({ where: { bank: { id: In(visible.map((bank) => bank.id)) } }, order: { version: "DESC" } })
    const versionsByBankId = new Map<string, QuestionBankVersionEntity[]>()
    for (const version of versions) {
      const items = versionsByBankId.get(version.bank.id) ?? []
      items.push(version)
      versionsByBankId.set(version.bank.id, items)
    }
    const usageCountByBankId = await this.questionBankUsageCounts(versions)
    const summaries = await Promise.all(visible.map(async (bank) => ({
      ...await this.serializeBankSummary(bank, versionsByBankId.get(bank.id) ?? []),
      usageCount: usageCountByBankId.get(bank.id) ?? 0
    })))
    return summaries.filter((bank) => {
      if (normalizedQuestionType && !bank.questionTypes.includes(normalizedQuestionType)) return false
      if (normalizedDifficulty && !bank.difficulties.includes(normalizedDifficulty)) return false
      if (normalizedKnowledgePoint && !bank.knowledgePoints.some((point) => point.toLocaleLowerCase().includes(normalizedKnowledgePoint))) return false
      if (normalizedUsage === "USED" && bank.usageCount === 0) return false
      if (normalizedUsage === "UNUSED" && bank.usageCount > 0) return false
      return true
    })
  }

  async getBank(id: string, user: AuthUser): Promise<QuestionBankDetail> {
    this.requireTeacher(user)
    const bank = await this.findBank(id)
    this.requireBankAccess(bank, user)
    const versions = await this.versions.find({ where: { bank: { id: bank.id } }, order: { version: "DESC" } })
    const activeVersions = versions.filter((version) => version.status !== "ARCHIVED")
    const current = activeVersions.find((version) => version.version === bank.currentVersion) ?? activeVersions[0] ?? null
    const summary = await this.serializeBankSummary(bank, versions)
    return {
      ...summary,
      versions: versions.map((version) => this.serializeVersionSummary(version)),
      currentVersionId: current?.id ?? null,
      questions: current ? this.serializeQuestions(current.questions, true) : []
    }
  }

  async getVersion(bankId: string, versionId: string, user: AuthUser): Promise<QuestionBankVersionDetail> {
    this.requireTeacher(user)
    const bank = await this.findBank(bankId)
    this.requireBankAccess(bank, user)
    const version = await this.versions.findOne({ where: { id: versionId, bank: { id: bank.id } } })
    if (!version) throw new NotFoundException("题库版本不存在")
    return {
      ...this.serializeVersionSummary(version),
      questions: this.serializeQuestions(version.questions, true)
    }
  }

  async auditVersions(user: AuthUser) {
    this.requireTeacher(user)
    const banks = (await this.banks.find({ order: { updatedAt: "DESC" } })).filter((bank) => user.role === "admin" || bank.createdBy.id === user.id)
    const bankIds = new Set(banks.map((bank) => bank.id))
    const versions = banks.length === 0
      ? []
      : (await this.versions.find({ order: { version: "DESC" } })).filter((version) => bankIds.has(version.bank?.id ?? ""))
    const bankById = new Map(banks.map((bank) => [bank.id, bank]))
    const results = versions.map((version) => {
      const archived = version.status === "ARCHIVED"
      const issues: string[] = []
      let normalized: ReturnType<typeof normalizeQuestionDefinitions> = []
      try {
        normalized = normalizeQuestionDefinitions(version.questions, !archived)
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error))
      }
      const questionTypes = [...new Set(normalized.map((question) => question.type))]
      const metricCodes = [...new Set(normalized.flatMap((question) => question.gradingRule.kind === "METRIC_THRESHOLD" ? [question.gradingRule.metricCode] : []))]
      const issueCategory = archived || issues.length === 0
        ? null
        : normalized.length === 0 && version.status === "DRAFT" ? "EMPTY_DRAFT" : "INVALID_CONTENT"
      return {
        bankId: version.bank?.id ?? "unknown",
        bankTitle: bankById.get(version.bank?.id ?? "")?.title ?? version.bank?.title ?? "未知题库",
        sceneType: bankById.get(version.bank?.id ?? "")?.sceneType ?? version.bank?.sceneType ?? null,
        versionId: version.id,
        version: version.version,
        status: version.status,
        questionCount: normalized.length,
        questionTypes,
        metricCodes,
        valid: archived || issues.length === 0,
        issueCategory,
        issues
      }
    })
    const activeResults = results.filter((item) => item.status !== "ARCHIVED")
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        bankCount: banks.length,
        versionCount: activeResults.length,
        archivedVersionCount: results.length - activeResults.length,
        validVersionCount: activeResults.filter((item) => item.valid).length,
        invalidVersionCount: activeResults.filter((item) => !item.valid).length,
        emptyDraftCount: activeResults.filter((item) => item.issueCategory === "EMPTY_DRAFT").length,
        invalidContentCount: activeResults.filter((item) => item.issueCategory === "INVALID_CONTENT").length,
        metricCodeCount: new Set(activeResults.flatMap((item) => item.metricCodes)).size
      },
      versions: results
    }
  }

  async previewEmptyDraftCleanup(user: AuthUser): Promise<QuestionBankCleanupPreview> {
    this.requireTeacher(user)
    const banks = (await this.banks.find({ order: { updatedAt: "DESC" } })).filter((bank) => user.role === "admin" || bank.createdBy.id === user.id)
    const bankIds = new Set(banks.map((bank) => bank.id))
    const versions = (await this.versions.find({ order: { version: "ASC" } })).filter((version) => bankIds.has(version.bank?.id ?? "") && version.status === "DRAFT")
    const emptyDrafts = versions.filter((version) => {
      try {
        return normalizeQuestionDefinitions(version.questions).length === 0
      } catch {
        return false
      }
    })
    const referenceCounts = new Map<string, number>()
    if (emptyDrafts.length > 0) {
      const rows = await this.snapshots.createQueryBuilder("snapshot")
        .select(`snapshot.config ->> 'questionBankVersionId'`, "versionId")
        .addSelect("COUNT(*)", "count")
        .where(`snapshot.config ->> 'questionBankVersionId' IN (:...versionIds)`, { versionIds: emptyDrafts.map((version) => version.id) })
        .groupBy(`snapshot.config ->> 'questionBankVersionId'`)
        .getRawMany<{ versionId: string; count: string }>()
      for (const row of rows) referenceCounts.set(row.versionId, Number(row.count))
    }
    const grouped = new Map<string, QuestionBankCleanupPreview["banks"][number]>()
    for (const version of emptyDrafts) {
      const bank = version.bank
      const referenceCount = referenceCounts.get(version.id) ?? 0
      const action = referenceCount > 0 ? "BLOCKED_REFERENCE" : "ARCHIVE"
      const group = grouped.get(bank.id) ?? {
        bankId: bank.id,
        bankTitle: bank.title,
        sceneType: bank.sceneType,
        candidateCount: 0,
        blockedReferenceCount: 0,
        blockedContentCount: 0,
        versions: []
      }
      if (action === "ARCHIVE") group.candidateCount += 1
      else group.blockedReferenceCount += 1
      group.versions.push({ versionId: version.id, version: version.version, questionCount: 0, referenceCount, action })
      grouped.set(bank.id, group)
    }
    const resultBanks = [...grouped.values()].filter((bank) => bank.versions.length > 0)
    return {
      generatedAt: new Date().toISOString(),
      summary: {
        bankCount: resultBanks.length,
        candidateCount: resultBanks.reduce((total, bank) => total + bank.candidateCount, 0),
        blockedReferenceCount: resultBanks.reduce((total, bank) => total + bank.blockedReferenceCount, 0),
        blockedContentCount: 0
      },
      banks: resultBanks
    }
  }

  async archiveEmptyDraftVersions(versionIds: string[], user: AuthUser): Promise<QuestionBankCleanupBatchResult> {
    this.requireTeacher(user)
    const requested = [...new Set(versionIds.map((id) => id.trim()).filter(Boolean))]
    if (requested.length === 0) throw new BadRequestException("至少选择一个可归档版本")
    return this.dataSource.transaction(async (manager) => {
      const archivedVersionIds: string[] = []
      const bankIds = new Set<string>()
      const versions = await Promise.all(requested.map((id) => manager.findOne(QuestionBankVersionEntity, { where: { id } })))
      for (let index = 0; index < versions.length; index += 1) {
        const version = versions[index]
        if (!version) throw new NotFoundException(`题库版本不存在：${requested[index]}`)
        const bank = await this.lockBank(manager, version.bank.id)
        if (!bank) throw new NotFoundException("题库不存在")
        this.requireBankAccess(bank, user)
        if (version.status === "ARCHIVED") continue
        if (version.status !== "DRAFT") throw new ConflictException(`V${version.version} 不是未发布草稿，不能批量归档`)
        if (normalizeQuestionDefinitions(version.questions).length > 0) throw new ConflictException(`V${version.version} 含有题目，不能批量归档`)
        if (await this.questionBankVersionReferenceCount(manager, version.id) > 0) throw new ConflictException(`V${version.version} 已被任务引用，不能批量归档`)
        version.status = "ARCHIVED"
        await manager.save(version)
        bankIds.add(bank.id)
        archivedVersionIds.push(version.id)
        await this.activities.record(manager, {
          actor: user,
          eventType: "QUESTION_BANK_VERSION_ARCHIVED",
          objectType: "QUESTION_BANK_VERSION",
          objectId: version.id,
          payload: { bankId: bank.id, version: version.version, batch: true },
          result: { bankArchived: false, fallbackVersionId: null }
        })
      }
      for (const bankId of bankIds) {
        const bank = await this.lockBank(manager, bankId)
        if (!bank) continue
        const fallback = await this.findLatestActiveVersion(manager, bank.id)
        if (fallback) {
          bank.currentVersion = fallback.version
          bank.status = fallback.status
        } else bank.status = "ARCHIVED"
        await manager.save(bank)
      }
      return { requestedVersionCount: requested.length, archivedVersionCount: archivedVersionIds.length, bankIds: [...bankIds], archivedVersionIds }
    })
  }

  async createBank(user: AuthUser, input: QuestionBankCreateInput): Promise<QuestionBankDetail> {
    this.requireTeacher(user)
    const title = normalizeRequiredText(input.title, "题库名称", 160)
    const summary = normalizeRequiredText(input.summary, "题库说明", 2_000)
    const sceneType = normalizeSceneType(input.sceneType)
    const questions = normalizeQuestionDefinitions(input.questions)
    const result = await this.dataSource.transaction(async (manager) => {
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const bank = await manager.save(QuestionBankEntity, manager.create(QuestionBankEntity, {
        title,
        sceneType,
        summary,
        status: "DRAFT",
        currentVersion: 1,
        createdBy: owner
      }))
      const version = await manager.save(QuestionBankVersionEntity, manager.create(QuestionBankVersionEntity, {
        bank,
        version: 1,
        status: "DRAFT",
        questions,
        createdBy: owner,
        changeNote: "初始版本",
        publishedAt: null
      }))
      await this.activities.record(manager, {
        actor: user,
        eventType: "QUESTION_BANK_CREATED",
        objectType: "QUESTION_BANK",
        objectId: bank.id,
        result: { versionId: version.id, questionCount: questions.length }
      })
      return bank
    })
    return this.getBank(result.id, user)
  }

  async createVersion(bankId: string, user: AuthUser, input: QuestionBankVersionInput): Promise<QuestionBankDetail> {
    this.requireTeacher(user)
    const result = await this.dataSource.transaction(async (manager) => {
      const bank = await this.lockBank(manager, bankId)
      if (!bank) throw new NotFoundException("题库不存在")
      this.requireBankAccess(bank, user)
      if (bank.status === "ARCHIVED") throw new ConflictException("题库已归档，不能创建新版本")
      const current = await manager.findOne(QuestionBankVersionEntity, { where: { bank: { id: bank.id }, version: bank.currentVersion } })
      const latest = await manager.findOne(QuestionBankVersionEntity, { where: { bank: { id: bank.id } }, order: { version: "DESC" } })
      const questions = normalizeQuestionDefinitions(input.questions === undefined ? current?.questions ?? [] : input.questions)
      const owner = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const version = await manager.save(QuestionBankVersionEntity, manager.create(QuestionBankVersionEntity, {
        bank,
        version: (latest?.version ?? 0) + 1,
        status: "DRAFT",
        questions,
        createdBy: owner,
        changeNote: normalizeChangeNote(input.changeNote),
        publishedAt: null
      }))
      if (current?.status === "DRAFT" && normalizeQuestionDefinitions(current.questions).length === 0 && await this.questionBankVersionReferenceCount(manager, current.id) === 0) {
        current.status = "ARCHIVED"
        await manager.save(current)
        await this.activities.record(manager, {
          actor: user,
          eventType: "QUESTION_BANK_VERSION_ARCHIVED",
          objectType: "QUESTION_BANK_VERSION",
          objectId: current.id,
          payload: { bankId: bank.id, version: current.version, automatic: true },
          result: { bankArchived: false, fallbackVersionId: version.id, replacementVersionId: version.id }
        })
      }
      bank.currentVersion = version.version
      bank.status = "DRAFT"
      await manager.save(bank)
      await this.activities.record(manager, {
        actor: user,
        eventType: "QUESTION_BANK_VERSION_CREATED",
        objectType: "QUESTION_BANK_VERSION",
        objectId: version.id,
        payload: { bankId: bank.id, version: version.version, questionCount: questions.length },
        result: { status: version.status }
      })
      return bank.id
    })
    return this.getBank(result, user)
  }

  async publishVersion(bankId: string, versionId: string, user: AuthUser): Promise<QuestionBankDetail> {
    this.requireTeacher(user)
    await this.dataSource.transaction(async (manager) => {
      const bank = await this.lockBank(manager, bankId)
      if (!bank) throw new NotFoundException("题库不存在")
      this.requireBankAccess(bank, user)
      const version = await manager.findOne(QuestionBankVersionEntity, { where: { id: versionId, bank: { id: bank.id } } })
      if (!version) throw new NotFoundException("题库版本不存在")
      if (version.status === "ARCHIVED") throw new ConflictException("题库版本已归档，不能发布")
      if (version.status === "PUBLISHED") return
      if (version.version !== bank.currentVersion) throw new ConflictException("只能发布题库当前版本")
      const questions = normalizeQuestionDefinitions(version.questions, true)
      version.questions = questions
      version.status = "PUBLISHED"
      version.publishedAt = new Date()
      bank.status = "PUBLISHED"
      await manager.save(version)
      await manager.save(bank)
      await this.activities.record(manager, {
        actor: user,
        eventType: "QUESTION_BANK_PUBLISHED",
        objectType: "QUESTION_BANK_VERSION",
        objectId: version.id,
        payload: { bankId: bank.id, version: version.version },
        result: { questionCount: questions.length }
      })
    })
    return this.getBank(bankId, user)
  }

  async archiveEmptyDraftVersion(bankId: string, versionId: string, user: AuthUser): Promise<QuestionBankVersionArchiveResult> {
    this.requireTeacher(user)
    return this.dataSource.transaction(async (manager) => {
      const bank = await this.lockBank(manager, bankId)
      if (!bank) throw new NotFoundException("题库不存在")
      this.requireBankAccess(bank, user)
      const version = await manager.findOne(QuestionBankVersionEntity, { where: { id: versionId, bank: { id: bank.id } } })
      if (!version) throw new NotFoundException("题库版本不存在")
      if (version.status === "ARCHIVED") {
        const fallback = await this.findLatestActiveVersion(manager, bank.id)
        return { bankId, versionId, archived: true, alreadyArchived: true, bankArchived: bank.status === "ARCHIVED", fallbackVersionId: fallback?.id ?? null }
      }
      if (version.status !== "DRAFT") throw new ConflictException("只有未发布草稿可以归档")
      if (normalizeQuestionDefinitions(version.questions).length > 0) throw new ConflictException("只有不含题目的空草稿可以归档")
      if (await this.questionBankVersionReferenceCount(manager, version.id) > 0) throw new ConflictException("该题库版本已被任务引用，不能归档")
      version.status = "ARCHIVED"
      await manager.save(version)
      const fallback = await this.findLatestActiveVersion(manager, bank.id)
      const bankArchived = !fallback
      if (fallback) {
        bank.currentVersion = fallback.version
        bank.status = fallback.status
      } else {
        bank.status = "ARCHIVED"
      }
      await manager.save(bank)
      await this.activities.record(manager, {
        actor: user,
        eventType: "QUESTION_BANK_VERSION_ARCHIVED",
        objectType: "QUESTION_BANK_VERSION",
        objectId: version.id,
        payload: { bankId: bank.id, version: version.version },
        result: { bankArchived, fallbackVersionId: fallback?.id ?? null }
      })
      return { bankId, versionId, archived: true, alreadyArchived: false, bankArchived, fallbackVersionId: fallback?.id ?? null }
    })
  }

  async questionnaire(projectId: string, user: AuthUser): Promise<QuestionnaireView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    const versionId = project.snapshot.config.questionBankVersionId
    const base = {
      actor,
      canEdit: false,
      canSubmit: false,
      canReview: false,
      canRegrade: false
    } as const
    if (!versionId) return { available: false, reason: "该任务未绑定题库", ...base, bank: null, attempt: null, questions: [], responses: [] }
    const version = await this.versions.findOne({ where: { id: versionId } })
    if (!version || version.status !== "PUBLISHED") return { available: false, reason: "该任务绑定的题库版本不可用", ...base, bank: null, attempt: null, questions: [], responses: [] }
    if (version.bank.sceneType && version.bank.sceneType !== project.snapshot.sceneType) return { available: false, reason: "题库场景与任务场景不一致", ...base, bank: null, attempt: null, questions: [], responses: [] }
    await this.syncPendingEvidence(projectId, version, user)
    const questions = normalizeQuestionDefinitions(version.questions, true)
    const attempt = await this.attempts.findOne({ where: { project: { id: project.id }, bankVersion: { id: version.id } } })
    const responseEntities = attempt ? await this.responses.find({ where: { attempt: { id: attempt.id } }, order: { createdAt: "ASC" } }) : []
    const timing = assessmentTimingForProject(project)
    const attemptIsWritable = !attempt || attempt.status === "IN_PROGRESS"
    const canWrite = actor === "STUDENT" && timing.canWrite && attemptIsWritable
    const reason = actor === "STUDENT"
      ? timing.blockedReason ?? (attemptIsWritable ? null : "本次题库作答已提交，当前为只读查看")
      : null
    return {
      available: true,
      reason,
      actor,
      canEdit: canWrite,
      canSubmit: canWrite,
      canReview: actor === "TEACHER" && Boolean(attempt) && ["SUBMITTED", "GRADED"].includes(attempt!.status),
      canRegrade: actor === "TEACHER" && Boolean(attempt) && ["SUBMITTED", "GRADED"].includes(attempt!.status) && responseEntities.some((response) => response.judgment === "PENDING"),
      bank: { id: version.bank.id, title: version.bank.title, sceneType: version.bank.sceneType, summary: version.bank.summary, versionId: version.id, version: version.version },
      attempt: attempt ? this.serializeAttempt(attempt) : null,
      questions: this.serializeQuestions(questions, actor === "TEACHER"),
      responses: this.serializeResponses(questions, responseEntities, actor === "TEACHER")
    }
  }

  async saveQuestionnaire(projectId: string, user: AuthUser, input: QuestionAttemptSaveInput, submit = false): Promise<QuestionnaireView> {
    if (user.role !== "student") throw new ForbiddenException("仅学生可以提交题库作答")
    // A submit request can be retried after a network timeout. Once the
    // attempt has reached a terminal state, returning the current view keeps
    // the operation idempotent while ordinary draft saves remain protected by
    // a conflict response.
    await this.dataSource.transaction(async (manager) => {
      const project = await this.lockProject(manager, projectId)
      if (project.student.id !== user.id) throw new ForbiddenException("无权操作该学生项目")
      const version = await this.requireProjectQuestionBank(manager, project)
      let attempt = await this.lockAttempt(manager, project.id, version.id)
      if (attempt?.status !== undefined && attempt.status !== "IN_PROGRESS") {
        if (!submit) throw new ConflictException("本次题库作答已经提交，不能继续修改")
        return
      }
      await this.assessmentWindows.assertWritable(projectId, user, false)
      const timing = assessmentTimingForProject(project)
      if (!timing.canWrite) throw new ConflictException(timing.blockedReason ?? "当前项目暂不能保存题库作答")
      const questions = normalizeQuestionDefinitions(version.questions, true)
      const answers = normalizeResponseInputs(input.responses)
      const questionCodes = new Set(questions.map((question) => question.code))
      const unknownCodes = answers.filter((answer) => !questionCodes.has(answer.questionCode)).map((answer) => answer.questionCode)
      if (unknownCodes.length > 0) throw new BadRequestException(`作答题目不存在：${unknownCodes.join("、")}`)
      const responseByCode = new Map(answers.map((response) => [response.questionCode, response.answer]))
      const missing = questions.filter((question) => question.type !== "SIMULATION_EVIDENCE" && (submit && !responseByCode.has(question.code) || submit && isEmptyAnswer(responseByCode.get(question.code)))).map((question) => question.code)
      if (missing.length > 0) throw new BadRequestException(`还有 ${missing.length} 道题未作答：${missing.join("、")}`)
      if (!attempt) {
        attempt = await manager.save(QuestionAttemptEntity, manager.create(QuestionAttemptEntity, {
          project,
          bankVersion: version,
          student: project.student,
          status: "IN_PROGRESS",
          revision: 1,
          autoScore: 0,
          teacherScore: null,
          maxScore: questions.reduce((sum, question) => sum + question.maxScore, 0),
          submittedAt: null,
          reviewedAt: null,
          reviewedBy: null,
          reviewComment: ""
        }))
      }
      assertRevision(input.expectedRevision, attempt.revision)
      const evaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId: project.id } })
      const metrics = (evaluation?.objectiveMetrics ?? []) as unknown as ShowObjectiveMetricView[]
      const existingResponses = await manager.find(QuestionResponseEntity, { where: { attempt: { id: attempt.id } } })
      const graded = this.gradeResponses(manager, attempt, questions, existingResponses, responseByCode, metrics, true)
      await manager.save(QuestionResponseEntity, graded.responses)
      attempt.autoScore = graded.autoScore
      attempt.maxScore = graded.maxScore
      attempt.revision += 1
      if (submit) {
        attempt.status = "SUBMITTED"
        attempt.submittedAt = new Date()
      }
      await manager.save(attempt)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: project.currentStageCode,
        actor: user,
        eventType: submit ? "QUESTION_ATTEMPT_SUBMITTED" : "QUESTION_ATTEMPT_SAVED",
        objectType: "QUESTION_ATTEMPT",
        objectId: attempt.id,
        beforeRevision: attempt.revision - 1,
        afterRevision: attempt.revision,
        result: { status: attempt.status, autoScore: attempt.autoScore, maxScore: attempt.maxScore }
      })
    })
    return this.questionnaire(projectId, user)
  }

  async regradeQuestionnaire(projectId: string, user: AuthUser, input: QuestionAttemptRegradeInput): Promise<QuestionnaireView> {
    this.requireTeacher(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以重新判定题库作答")
      const version = await this.requireProjectQuestionBank(manager, project)
      const attempt = await this.lockAttempt(manager, project.id, version.id)
      if (!attempt) throw new NotFoundException("该学生尚未开始题库作答")
      if (attempt.status !== "SUBMITTED" && attempt.status !== "GRADED") throw new ConflictException("只有已提交且尚未完成教师复核的作答才能重新判定")
      assertRevision(input.expectedRevision, attempt.revision)
      const evaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId: project.id } })
      const metrics = (evaluation?.objectiveMetrics ?? []) as unknown as ShowObjectiveMetricView[]
      const questions = normalizeQuestionDefinitions(version.questions, true)
      const existingResponses = await manager.find(QuestionResponseEntity, { where: { attempt: { id: attempt.id } } })
      const answerByCode = new Map(existingResponses.map((response) => [response.questionCode, response.answer]))
      const graded = this.gradeResponses(manager, attempt, questions, existingResponses, answerByCode, metrics, false)
      await manager.save(QuestionResponseEntity, graded.responses)
      const beforeRevision = attempt.revision
      attempt.autoScore = graded.autoScore
      attempt.maxScore = graded.maxScore
      attempt.status = graded.pendingCount > 0 ? "SUBMITTED" : "GRADED"
      attempt.revision += 1
      await manager.save(attempt)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: project.currentStageCode,
        actor: user,
        eventType: "QUESTION_ATTEMPT_REGRADED",
        objectType: "QUESTION_ATTEMPT",
        objectId: attempt.id,
        beforeRevision,
        afterRevision: attempt.revision,
        payload: { metricCount: metrics.length, pendingCount: graded.pendingCount },
        result: { status: attempt.status, autoScore: attempt.autoScore, maxScore: attempt.maxScore, pendingCount: graded.pendingCount }
      })
    })
    return this.questionnaire(projectId, user)
  }

  async reviewQuestionnaire(projectId: string, user: AuthUser, input: QuestionAttemptReviewInput): Promise<QuestionnaireView> {
    this.requireTeacher(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "TEACHER") throw new ForbiddenException("仅教师可以复核题库作答")
      const version = await this.requireProjectQuestionBank(manager, project)
      const attempt = await this.lockAttempt(manager, project.id, version.id)
      if (!attempt) throw new NotFoundException("该学生尚未开始题库作答")
      if (attempt.status !== "SUBMITTED" && attempt.status !== "GRADED") throw new ConflictException("该题库作答已完成复核或尚未提交，不能重复复核")
      assertRevision(input.expectedRevision, attempt.revision)
      const questions = normalizeQuestionDefinitions(version.questions, true)
      const questionByCode = new Map(questions.map((question) => [question.code, question]))
      const responseEntities = await manager.find(QuestionResponseEntity, { where: { attempt: { id: attempt.id } } })
      const responseByCode = new Map(responseEntities.map((response) => [response.questionCode, response]))
      const reviewInputs = normalizeReviewInputs(input.responses)
      for (const review of reviewInputs) {
        const question = questionByCode.get(review.questionCode)
        const response = responseByCode.get(review.questionCode)
        if (!question || !response) throw new BadRequestException(`题目不存在：${review.questionCode}`)
        if (review.teacherScore !== undefined && review.teacherScore !== null) {
          if (!Number.isFinite(review.teacherScore) || review.teacherScore < 0 || review.teacherScore > question.maxScore) throw new BadRequestException(`题目 ${question.code} 的教师评分无效`)
          response.teacherScore = roundScore(review.teacherScore)
        } else if (review.teacherScore === null) {
          response.teacherScore = null
        }
        if (review.teacherComment !== undefined) response.teacherComment = normalizeOptionalText(review.teacherComment, "教师评语", 1_000)
      }
      for (const question of questions) {
        const response = responseByCode.get(question.code)
        if (!response) throw new ConflictException(`缺少题目 ${question.code} 的作答记录`)
        if (response.teacherScore === null) {
          if (response.autoScore === null) throw new BadRequestException(`请为题目 ${question.code} 填写教师评分`)
          response.teacherScore = response.autoScore
        }
      }
      await manager.save(QuestionResponseEntity, responseEntities)
      attempt.teacherScore = roundScore(responseEntities.reduce((sum, response) => sum + (response.teacherScore ?? 0), 0))
      attempt.maxScore = roundScore(responseEntities.reduce((sum, response) => sum + response.maxScore, 0))
      attempt.reviewComment = normalizeOptionalText(input.reviewComment, "复核意见", 2_000)
      attempt.reviewedAt = new Date()
      attempt.reviewedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      attempt.status = "REVIEWED"
      attempt.revision += 1
      await manager.save(attempt)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId: project.id,
        stageCode: project.currentStageCode,
        actor: user,
        eventType: "QUESTION_ATTEMPT_REVIEWED",
        objectType: "QUESTION_ATTEMPT",
        objectId: attempt.id,
        beforeRevision: attempt.revision - 1,
        afterRevision: attempt.revision,
        result: { status: attempt.status, teacherScore: attempt.teacherScore, maxScore: attempt.maxScore }
      })
    })
    return this.questionnaire(projectId, user)
  }

  private gradeResponses(
    manager: EntityManager,
    attempt: QuestionAttemptEntity,
    questions: ReturnType<typeof normalizeQuestionDefinitions>,
    existingResponses: QuestionResponseEntity[],
    answerByCode: ReadonlyMap<string, QuestionAnswer>,
    metrics: readonly ShowObjectiveMetricView[],
    createMissing: boolean
  ): { responses: QuestionResponseEntity[]; autoScore: number; maxScore: number; pendingCount: number } {
    const existingByCode = new Map(existingResponses.map((response) => [response.questionCode, response]))
    const responseEntities = questions.map((question) => {
      const response = existingByCode.get(question.code) ?? (createMissing
        ? manager.create(QuestionResponseEntity, { attempt, questionCode: question.code, teacherScore: null, teacherComment: "" })
        : null)
      if (!response) throw new ConflictException(`缺少题目 ${question.code} 的作答记录，无法重新判定`)
      const answer = (answerByCode.has(question.code) ? answerByCode.get(question.code) : response.answer ?? null) as QuestionAnswer
      const grading = gradeQuestion(question, answer, metrics)
      response.answer = answer
      response.autoScore = grading.autoScore
      response.maxScore = question.maxScore
      response.judgment = grading.judgment
      response.evidence = grading.evidence
      return response
    })
    return {
      responses: responseEntities,
      autoScore: roundScore(responseEntities.reduce((sum, response) => sum + (response.autoScore ?? 0), 0)),
      maxScore: roundScore(responseEntities.reduce((sum, response) => sum + response.maxScore, 0)),
      pendingCount: responseEntities.filter((response) => response.judgment === "PENDING").length
    }
  }

  private async syncPendingEvidence(projectId: string, version: QuestionBankVersionEntity, user: AuthUser): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const attempt = await this.lockAttempt(manager, projectId, version.id)
      if (!attempt || (attempt.status !== "SUBMITTED" && attempt.status !== "GRADED")) return
      const existingResponses = await manager.find(QuestionResponseEntity, { where: { attempt: { id: attempt.id } } })
      if (!existingResponses.some((response) => response.judgment === "PENDING")) return
      const evaluation = await manager.findOne(ProjectEvaluationEntity, { where: { projectId } })
      const metrics = (evaluation?.objectiveMetrics ?? []) as unknown as ShowObjectiveMetricView[]
      const questions = normalizeQuestionDefinitions(version.questions, true)
      const answerByCode = new Map(existingResponses.map((response) => [response.questionCode, response.answer]))
      const previousStateByCode = new Map(existingResponses.map((response) => [response.questionCode, {
        autoScore: response.autoScore,
        judgment: response.judgment,
        evidence: response.evidence
      }]))
      const graded = this.gradeResponses(manager, attempt, questions, existingResponses, answerByCode, metrics, false)
      const changed = graded.responses.some((response) => {
        const previous = previousStateByCode.get(response.questionCode)
        return previous?.autoScore !== response.autoScore || previous?.judgment !== response.judgment || canonicalJson(previous?.evidence ?? []) !== canonicalJson(response.evidence)
      })
      if (!changed) return
      await manager.save(QuestionResponseEntity, graded.responses)
      const beforeRevision = attempt.revision
      attempt.autoScore = graded.autoScore
      attempt.maxScore = graded.maxScore
      attempt.status = graded.pendingCount > 0 ? "SUBMITTED" : "GRADED"
      attempt.revision += 1
      await manager.save(attempt)
      await this.activities.record(manager, {
        assignmentId: attempt.project.snapshot.draft.id,
        projectId,
        stageCode: attempt.project.currentStageCode,
        actor: user,
        eventType: "QUESTION_ATTEMPT_REGRADED",
        objectType: "QUESTION_ATTEMPT",
        objectId: attempt.id,
        beforeRevision,
        afterRevision: attempt.revision,
        payload: { automatic: true, metricCount: metrics.length, pendingCount: graded.pendingCount },
        result: { status: attempt.status, autoScore: attempt.autoScore, maxScore: attempt.maxScore }
      })
    })
  }

  private async serializeBankSummary(bank: QuestionBankEntity, suppliedVersions?: QuestionBankVersionEntity[]): Promise<QuestionBankSummary> {
    const versions = suppliedVersions ?? await this.versions.find({ where: { bank: { id: bank.id } }, order: { version: "DESC" } })
    const activeVersions = versions.filter((version) => version.status !== "ARCHIVED")
    const latest = activeVersions[0] ?? null
    const current = activeVersions.find((version) => version.version === bank.currentVersion) ?? latest
    const published = activeVersions.find((version) => version.status === "PUBLISHED") ?? null
    const questions = current ? normalizeQuestionDefinitions(current.questions) : []
    return {
      id: bank.id,
      title: bank.title,
      sceneType: bank.sceneType,
      summary: bank.summary,
      status: bank.status,
      currentVersion: bank.currentVersion,
      latestVersionId: latest?.id ?? null,
      publishedVersionId: published?.id ?? null,
      publishedVersion: published ? this.serializeVersionSummary(published) : null,
      questionCount: questions.length,
      questionTypes: [...new Set(questions.map((question) => question.type))],
      difficulties: [...new Set(questions.map((question) => question.difficulty))],
      knowledgePoints: [...new Set(questions.flatMap((question) => question.knowledgePoints))].sort((left, right) => left.localeCompare(right, "zh-CN")),
      usageCount: 0,
      updatedAt: bank.updatedAt.toISOString()
    }
  }

  private async questionBankUsageCounts(versions: QuestionBankVersionEntity[]): Promise<Map<string, number>> {
    const bankIdByVersionId = new Map(versions.map((version) => [version.id, version.bank.id]))
    if (bankIdByVersionId.size === 0) return new Map()
    const rows = await this.snapshots.createQueryBuilder("snapshot")
      .select(`snapshot.config ->> 'questionBankVersionId'`, "versionId")
      .addSelect("COUNT(*)", "count")
      .where(`snapshot.config ->> 'questionBankVersionId' IN (:...versionIds)`, { versionIds: [...bankIdByVersionId.keys()] })
      .groupBy(`snapshot.config ->> 'questionBankVersionId'`)
      .getRawMany<{ versionId: string; count: string }>()
    const counts = new Map<string, number>()
    for (const row of rows) {
      const bankId = bankIdByVersionId.get(row.versionId)
      if (bankId) counts.set(bankId, (counts.get(bankId) ?? 0) + Number(row.count))
    }
    return counts
  }

  private serializeVersionSummary(version: QuestionBankVersionEntity): QuestionBankVersionSummary {
    return {
      id: version.id,
      version: version.version,
      status: version.status,
      questionCount: normalizeQuestionDefinitions(version.questions).length,
      changeNote: version.changeNote,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString()
    }
  }

  private serializeQuestions(questions: QuestionBankVersionEntity["questions"], includeAnswer: boolean): QuestionView[] {
    return normalizeQuestionDefinitions(questions).map((question) => ({
      code: question.code,
      type: question.type,
      difficulty: question.difficulty,
      knowledgePoints: question.knowledgePoints,
      prompt: question.prompt,
      options: question.options,
      ...(question.gradingRule.kind === "REQUIRED_FIELDS" ? { answerFields: question.gradingRule.fields } : {}),
      ...(includeAnswer ? { correctAnswer: question.correctAnswer, explanation: question.explanation, gradingRule: question.gradingRule } : {}),
      maxScore: question.maxScore,
      stageCode: question.stageCode,
      sortOrder: question.sortOrder
    }))
  }

  private serializeAttempt(attempt: QuestionAttemptEntity): QuestionAttemptView {
    return {
      id: attempt.id,
      status: attempt.status,
      revision: attempt.revision,
      autoScore: attempt.autoScore,
      teacherScore: attempt.teacherScore,
      maxScore: attempt.maxScore,
      submittedAt: attempt.submittedAt?.toISOString() ?? null,
      reviewedAt: attempt.reviewedAt?.toISOString() ?? null,
      reviewComment: attempt.reviewComment
    }
  }

  private serializeResponses(questions: QuestionBankVersionEntity["questions"], entities: QuestionResponseEntity[], includeAnswer: boolean): QuestionResponseView[] {
    const byCode = new Map(entities.map((response) => [response.questionCode, response]))
    return normalizeQuestionDefinitions(questions).map((question) => {
      const response = byCode.get(question.code)
      return {
        questionCode: question.code,
        answer: response?.answer ?? null,
        autoScore: response?.autoScore ?? null,
        maxScore: response?.maxScore ?? question.maxScore,
        judgment: response?.judgment ?? "UNANSWERED",
        evidence: response?.evidence ?? [],
        ...(includeAnswer ? { teacherScore: response?.teacherScore ?? null, teacherComment: response?.teacherComment ?? "" } : { teacherScore: null, teacherComment: "" })
      }
    })
  }

  private async findBank(id: string): Promise<QuestionBankEntity> {
    const bank = await this.banks.findOne({ where: { id } })
    if (!bank) throw new NotFoundException("题库不存在")
    return bank
  }

  private async lockBank(manager: EntityManager, bankId: string): Promise<QuestionBankEntity | null> {
    const rows = await manager.query<{ id: string }[]>(
      'SELECT "id" FROM "question_banks" WHERE "id" = $1 FOR UPDATE',
      [bankId]
    )
    if (!rows[0]) return null
    return manager.findOne(QuestionBankEntity, { where: { id: bankId } })
  }

  private async findLatestActiveVersion(manager: EntityManager, bankId: string): Promise<QuestionBankVersionEntity | null> {
    return manager.findOne(QuestionBankVersionEntity, {
      where: { bank: { id: bankId }, status: In(["DRAFT", "PUBLISHED"]) },
      order: { version: "DESC" }
    })
  }

  private async questionBankVersionReferenceCount(manager: EntityManager, versionId: string): Promise<number> {
    const references = await manager.query<{ count: string }[]>(
      `SELECT COUNT(*)::text AS "count" FROM "assignment_snapshots" WHERE "config" ->> 'questionBankVersionId' = $1`,
      [versionId]
    )
    return Number(references[0]?.count ?? 0)
  }

  private async lockProject(manager: EntityManager, id: string): Promise<StudentProjectEntity> {
    const project = typeof manager.createQueryBuilder === "function"
      ? await (async () => {
          const lockedProjectRows = await manager.createQueryBuilder(StudentProjectEntity, "project")
            .select("project.id", "id")
            .where("project.id = :id", { id })
            .setLock("pessimistic_write")
            .getRawMany<{ id: string }>()
          return lockedProjectRows[0]
            ? await manager.findOne(StudentProjectEntity, { where: { id: lockedProjectRows[0].id } })
            : null
        })()
      : await manager.findOne(StudentProjectEntity, { where: { id }, lock: { mode: "pessimistic_write" } })
    if (!project) throw new NotFoundException("学生项目不存在")
    return project
  }

  private async lockAttempt(manager: EntityManager, projectId: string, versionId: string): Promise<QuestionAttemptEntity | null> {
    if (typeof manager.createQueryBuilder === "function") {
      const lockedAttemptRows = await manager.createQueryBuilder(QuestionAttemptEntity, "attempt")
        .select("attempt.id", "id")
        .where("attempt.projectId = :projectId", { projectId })
        .andWhere("attempt.bankVersionId = :versionId", { versionId })
        .setLock("pessimistic_write")
        .getRawMany<{ id: string }>()
      return lockedAttemptRows[0]
        ? await manager.findOne(QuestionAttemptEntity, { where: { id: lockedAttemptRows[0].id } })
        : null
    }
    return manager.findOne(QuestionAttemptEntity, {
      where: { project: { id: projectId }, bankVersion: { id: versionId } },
      lock: { mode: "pessimistic_write" }
    })
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager): Promise<{ project: StudentProjectEntity; actor: "TEACHER" | "STUDENT" }> {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权查看该学生项目")
      return { project, actor: "STUDENT" }
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" }
    throw new ForbiddenException("无权查看该学生项目")
  }

  private async requireProjectQuestionBank(manager: EntityManager, project: StudentProjectEntity): Promise<QuestionBankVersionEntity> {
    const versionId = project.snapshot.config.questionBankVersionId
    if (!versionId) throw new ConflictException("该任务未绑定题库")
    const version = await manager.findOne(QuestionBankVersionEntity, { where: { id: versionId } })
    if (!version || version.status !== "PUBLISHED") throw new ConflictException("该任务绑定的题库版本不可用")
    if (version.bank.sceneType && version.bank.sceneType !== project.snapshot.sceneType) throw new ConflictException("题库场景与任务场景不一致")
    normalizeQuestionDefinitions(version.questions, true)
    return version
  }

  private requireBankAccess(bank: QuestionBankEntity, user: AuthUser): void {
    if (user.role !== "admin" && bank.createdBy.id !== user.id) throw new ForbiddenException("无权管理该题库")
  }

  private requireTeacher(user: AuthUser): void {
    if (user.role !== "teacher" && user.role !== "admin") throw new ForbiddenException("需要教师权限")
  }
}

function normalizeSceneType(value: SceneType | null | undefined): SceneType | null {
  if (value === undefined || value === null) return null
  if (value !== "CITY_SHOW" && value !== "CITY_LOGISTICS" && value !== "VTOL_INSPECTION") throw new BadRequestException("题库场景无效")
  return value
}

function normalizeRequiredText(value: unknown, label: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text || text.length > maximum) throw new BadRequestException(`${label}不能为空且不能超过 ${maximum} 个字符`)
  return text
}

function normalizeOptionalText(value: unknown, label: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length > maximum) throw new BadRequestException(`${label}不能超过 ${maximum} 个字符`)
  return text
}

function normalizeSearch(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length > 100) throw new BadRequestException("题库搜索词不能超过 100 个字符")
  return text.toLocaleLowerCase()
}

function normalizeQuestionTypeFilter(value: unknown): QuestionType | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || !["SINGLE_CHOICE", "MULTIPLE_CHOICE", "TRUE_FALSE", "PLANNING", "SCHEDULE", "SCENARIO_DECISION", "SIMULATION_EVIDENCE"].includes(value)) throw new BadRequestException("题型筛选无效")
  return value as QuestionType
}

function normalizeQuestionDifficultyFilter(value: unknown): QuestionDifficulty | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (value !== "BEGINNER" && value !== "INTERMEDIATE" && value !== "ADVANCED") throw new BadRequestException("难度筛选无效")
  return value
}

function normalizeKnowledgePointFilter(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (text.length > 60) throw new BadRequestException("知识点筛选不能超过 60 个字符")
  return text.toLocaleLowerCase()
}

function normalizeUsageFilter(value: unknown): "USED" | "UNUSED" | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (value !== "USED" && value !== "UNUSED") throw new BadRequestException("使用状态筛选无效")
  return value
}

function normalizeChangeNote(value: unknown): string {
  return normalizeOptionalText(value, "版本说明", 500)
}

function normalizeResponseInputs(value: QuestionResponseInput[] | undefined): Array<{ questionCode: string; answer: QuestionAnswer }> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200) throw new BadRequestException("作答列表无效")
  const codes = new Set<string>()
  return value.map((item) => {
    const questionCode = typeof item.questionCode === "string" ? item.questionCode.trim().toUpperCase() : ""
    if (!questionCode || codes.has(questionCode)) throw new BadRequestException("作答题目编号无效或重复")
    codes.add(questionCode)
    return { questionCode, answer: (item.answer ?? null) as QuestionAnswer }
  })
}

function normalizeReviewInputs(value: QuestionAttemptReviewInput["responses"]): Array<{ questionCode: string; teacherScore?: number | null; teacherComment?: string }> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 200) throw new BadRequestException("教师复核列表无效")
  const codes = new Set<string>()
  return value.map((item) => {
    const questionCode = typeof item.questionCode === "string" ? item.questionCode.trim().toUpperCase() : ""
    if (!questionCode || codes.has(questionCode)) throw new BadRequestException("教师复核题目编号无效或重复")
    codes.add(questionCode)
    return {
      questionCode,
      ...(Object.prototype.hasOwnProperty.call(item, "teacherScore") ? { teacherScore: item.teacherScore } : {}),
      ...(item.teacherComment !== undefined ? { teacherComment: item.teacherComment } : {})
    }
  })
}

function assertRevision(expectedRevision: number | undefined, actualRevision: number): void {
  if (expectedRevision === undefined) return
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) throw new BadRequestException("expectedRevision 必须为正整数")
  if (expectedRevision !== actualRevision) throw new ConflictException(`题库作答版本冲突，当前版本为 ${actualRevision}`)
}

function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value as object).length === 0
  return false
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}
