import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common"
import type { AuthUser, QuestionBankCreateInput, QuestionBankVersionInput, QuestionDifficulty, QuestionType, SceneType } from "@wurenji/shared"
import { AuthGuard } from "../auth/auth.guard.js"
import { CurrentUser } from "../auth/current-user.js"
import { EducationService } from "./education.service.js"
import type { StudentImportInput } from "./student-import.js"
import { QuestionBankService } from "./question-bank.service.js"

@Controller("v1/education")
@UseGuards(AuthGuard)
export class EducationController {
  constructor(private readonly education: EducationService, private readonly questionBanks: QuestionBankService) {}

  @Get("onboarding")
  onboarding(@CurrentUser() user: AuthUser) {
    return this.education.getOnboarding(user)
  }

  @Post("onboarding/:guideKey/complete")
  completeOnboarding(@Param("guideKey") guideKey: string, @CurrentUser() user: AuthUser, @Body() body: { version?: number; skipped?: boolean }) {
    return this.education.completeOnboarding(user, guideKey, body.version ?? 1, body.skipped === true)
  }

  @Get("courses")
  courses(@CurrentUser() user: AuthUser) {
    return this.education.listCourses(user)
  }

  @Post("courses")
  createCourse(@CurrentUser() user: AuthUser, @Body() body: { code?: string; name?: string; term?: string }) {
    return this.education.createCourse(user, body)
  }

  @Get("classes")
  classes(@CurrentUser() user: AuthUser) {
    return this.education.listClasses(user)
  }

  @Post("classes")
  createClass(@CurrentUser() user: AuthUser, @Body() body: { courseId?: string; code?: string; name?: string }) {
    return this.education.createClass(user, body)
  }

  @Get("classes/:id/students")
  students(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.education.listClassStudents(id, user)
  }

  @Post("classes/:id/students/import")
  importStudents(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { students?: StudentImportInput[] }) {
    return this.education.importStudents(id, user, body.students ?? [])
  }

  @Get("question-banks")
  questionBanksList(
    @CurrentUser() user: AuthUser,
    @Query("sceneType") sceneType?: string,
    @Query("search") search?: string,
    @Query("questionType") questionType?: string,
    @Query("difficulty") difficulty?: string,
    @Query("knowledgePoint") knowledgePoint?: string,
    @Query("usage") usage?: string
  ) {
    return this.questionBanks.listBanks(user, sceneType as SceneType | undefined, search, questionType as QuestionType | undefined, difficulty as QuestionDifficulty | undefined, knowledgePoint, usage as "USED" | "UNUSED" | undefined)
  }

  @Get("question-banks/audit")
  questionBanksAudit(@CurrentUser() user: AuthUser) {
    return this.questionBanks.auditVersions(user)
  }

  @Get("question-banks/cleanup-preview")
  questionBanksCleanupPreview(@CurrentUser() user: AuthUser) {
    return this.questionBanks.previewEmptyDraftCleanup(user)
  }

  @Post("question-banks/cleanup")
  cleanupQuestionBanks(@CurrentUser() user: AuthUser, @Body() body: { versionIds?: string[] }) {
    return this.questionBanks.archiveEmptyDraftVersions(body.versionIds ?? [], user)
  }

  @Get("question-banks/:id")
  questionBank(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.questionBanks.getBank(id, user)
  }

  @Get("question-banks/:id/versions/:versionId")
  questionBankVersion(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser) {
    return this.questionBanks.getVersion(id, versionId, user)
  }

  @Post("question-banks")
  createQuestionBank(@CurrentUser() user: AuthUser, @Body() body: QuestionBankCreateInput) {
    return this.questionBanks.createBank(user, body)
  }

  @Post("question-banks/:id/versions")
  createQuestionBankVersion(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: QuestionBankVersionInput) {
    return this.questionBanks.createVersion(id, user, body)
  }

  @Post("question-banks/:id/versions/:versionId/publish")
  publishQuestionBankVersion(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser) {
    return this.questionBanks.publishVersion(id, versionId, user)
  }

  @Post("question-banks/:id/versions/:versionId/archive")
  archiveQuestionBankVersion(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser) {
    return this.questionBanks.archiveEmptyDraftVersion(id, versionId, user)
  }
}
