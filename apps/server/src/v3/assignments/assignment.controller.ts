import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common"
import type {
  AssignmentDraftConfig,
  AssignmentTargetInput,
  AuthUser,
  LearningMode,
  SceneType
} from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AllowAssessmentStart, AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { V3AssignmentService } from "./assignment.service.js"

@Controller("v3")
@UseGuards(AuthGuard)
export class V3AssignmentController {
  constructor(private readonly assignments: V3AssignmentService) {}

  @Get("assignments/drafts")
  drafts(@CurrentUser() user: AuthUser, @Query("includeInternalData") includeInternalData?: string) {
    return this.assignments.listDrafts(user, parseBooleanQuery(includeInternalData, "includeInternalData") ?? false)
  }

  @Post("assignments/drafts")
  createDraft(@CurrentUser() user: AuthUser, @Body() body: {
    title?: string
    sceneType?: SceneType
    mode?: LearningMode
    sourceExerciseVersionId?: string
    isDemo?: boolean
    isAcceptanceData?: boolean
    config?: Partial<AssignmentDraftConfig>
  }) {
    return this.assignments.createDraft(user, body)
  }

  @Get("assignments/drafts/:id")
  draft(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.getDraft(id, user)
  }

  @Post("assignments/drafts/:id/copy")
  copyDraft(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.copyDraft(id, user)
  }

  @Delete("assignments/drafts/:id")
  deleteDraft(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.deleteDraft(id, user)
  }

  @Put("assignments/drafts/:id")
  updateDraft(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: {
    expectedRevision?: number
    title?: string
    isDemo?: boolean
    isAcceptanceData?: boolean
    config?: Partial<AssignmentDraftConfig>
  }) {
    return this.assignments.updateDraft(id, user, body)
  }

  @Post("assignments/drafts/:id/preview")
  preview(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: {
    expectedRevision?: number
    targets?: AssignmentTargetInput[]
    resourcePackageIds?: string[]
  }) {
    return this.assignments.preview(id, user, body)
  }

  @Post("assignments/drafts/:id/preflight")
  preflight(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: {
    expectedRevision?: number
    targets?: AssignmentTargetInput[]
    resourcePackageIds?: string[]
  }) {
    return this.assignments.preflight(id, user, body)
  }

  @Post("assignments/drafts/:id/publish")
  publish(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: {
    expectedRevision?: number
    configHash?: string
    targets?: AssignmentTargetInput[]
    resourcePackageIds?: string[]
    preflightConfirmation?: { checkedAt?: string; checkCodes?: string[] }
  }) {
    return this.assignments.publish(id, user, body)
  }

  @Get("assignments/:id/snapshot")
  snapshot(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.getSnapshot(id, user)
  }

  @Get("assignments/:id/detail")
  assignmentDetail(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.getAssignmentDetail(id, user)
  }

  @Get("assignments/:id/resource-upgrade")
  resourceUpgradePreview(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.previewResourceUpgrade(id, user)
  }

  @Post("assignments/:id/resource-upgrade")
  resourceUpgrade(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number; snapshotChecksum?: string }
  ) {
    return this.assignments.applyResourceUpgrade(id, user, body)
  }

  @Post("assignments/:id/withdraw")
  withdraw(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { reason?: string }) {
    return this.assignments.withdraw(id, user, body)
  }

  @Post("assignments/:id/end")
  end(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { reason?: string }) {
    return this.assignments.end(id, user, body)
  }

  @Post("assignments/:id/archive")
  archive(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { reason?: string }) {
    return this.assignments.archive(id, user, body)
  }

  @Get("my-projects")
  myProjects(@CurrentUser() user: AuthUser, @Query("includeInternalData") includeInternalData?: string) {
    return this.assignments.myProjects(user, parseBooleanQuery(includeInternalData, "includeInternalData") ?? false)
  }

  @Get("teaching/overview")
  teachingOverview(@CurrentUser() user: AuthUser, @Query("includeInternalData") includeInternalData?: string) {
    return this.assignments.teachingOverview(user, parseBooleanQuery(includeInternalData, "includeInternalData") ?? false)
  }

  @Get("teaching/progress")
  teachingProgress(
    @CurrentUser() user: AuthUser,
    @Query("sceneType") sceneType?: string,
    @Query("stageCode") stageCode?: string,
    @Query("submissionState") submissionState?: string,
    @Query("alertState") alertState?: string,
    @Query("alertSeverity") alertSeverity?: string,
    @Query("followUpStatus") followUpStatus?: string,
    @Query("stalledOnly") stalledOnly?: string,
    @Query("evaluationState") evaluationState?: string,
    @Query("focusState") focusState?: string,
    @Query("classroomId") classroomId?: string,
    @Query("keyword") keyword?: string,
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("includeInternalData") includeInternalData?: string
  ) {
    const progressInput = { sceneType, stageCode, submissionState, alertState, alertSeverity, followUpStatus, stalledOnly: parseBooleanQuery(stalledOnly, "stalledOnly"), evaluationState, focusState, classroomId, keyword, includeInternalData: parseBooleanQuery(includeInternalData, "includeInternalData") }
    if (page === undefined && pageSize === undefined) return this.assignments.teacherProgress(user, progressInput)
    const currentPage = parsePositiveQuery(page, "page", 1)
    const currentPageSize = parsePositiveQuery(pageSize, "pageSize", 50, 100)
    return this.assignments.teacherProgressPage(user, progressInput, currentPage, currentPageSize)
  }

  @Put("teaching/alerts/follow-ups")
  teacherAlertFollowUps(@CurrentUser() user: AuthUser, @Body() body: { alertIds?: string[]; status?: "WATCHING" | "CLOSED"; note?: string }) {
    return this.assignments.updateTeacherAlertFollowUps(user, body.alertIds ?? [], body.status ?? "WATCHING", body.note ?? "")
  }

  @Get("projects/:id/stages")
  projectStages(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.projectStages(id, user)
  }

  @Get("projects/:id/activities")
  projectActivities(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.assignments.projectActivities(id, user)
  }

  @Post("projects/:id/assessment-retakes")
  createAssessmentRetake(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { reason?: string; availableAt?: string; dueAt?: string }
  ) {
    return this.assignments.createAssessmentRetake(id, user, body)
  }

  @Post("projects/:id/stages/:stageCode/start")
  @UseGuards(AssessmentWindowGuard)
  @AllowAssessmentStart()
  startStage(
    @Param("id") id: string,
    @Param("stageCode") stageCode: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number }
  ) {
    return this.assignments.startStage(id, stageCode, user, Number(body.expectedRevision))
  }
}

function parseBooleanQuery(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (value === "true") return true
  if (value === "false") return false
  throw new BadRequestException(`${field}必须是 true 或 false`)
}

function parsePositiveQuery(value: string | undefined, field: string, fallback: number, max?: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) {
    throw new BadRequestException(`${field}必须是 1 到 ${max ?? "正整数"}`)
  }
  return parsed
}
