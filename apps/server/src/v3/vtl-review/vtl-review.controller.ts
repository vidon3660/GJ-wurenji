import { Body, Controller, Get, Param, Post, Put, Res, UseGuards } from "@nestjs/common"
import type { Response } from "express"
import type { AuthUser, ShowTeacherScoreView } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { VtlReviewService } from "./vtl-review.service.js"

@Controller("v3/vtl-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class VtlReviewController {
  constructor(private readonly review: VtlReviewService) {}

  @Get(":projectId/review")
  workspace(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.review.workspace(projectId, user)
  }

  @Put(":projectId/review/summary")
  saveSummary(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; summary?: string }) {
    return this.review.saveStudentSummary(projectId, user, Number(body.expectedRevision), body.summary ?? "", false)
  }

  @Post(":projectId/review/summary/submit")
  submitSummary(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; summary?: string }) {
    return this.review.saveStudentSummary(projectId, user, Number(body.expectedRevision), body.summary ?? "", true)
  }

  @Put(":projectId/review/evaluation")
  saveEvaluation(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; teacherScores?: ShowTeacherScoreView[]; summary?: string }) {
    return this.review.saveTeacherEvaluation(projectId, user, body)
  }

  @Post(":projectId/review/evaluation/publish")
  publishEvaluation(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.review.publishTeacherEvaluation(projectId, user, Number(body.expectedRevision))
  }

  @Post(":projectId/review/report/generate")
  generateReport(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { format?: string }) {
    return this.review.requestReportGeneration(projectId, user, body.format ?? "PDF")
  }

  @Get(":projectId/review/report/download")
  async downloadReport(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    const { asset, content } = await this.review.downloadReport(projectId, user)
    response.setHeader("Content-Type", asset.mimeType)
    response.setHeader("Content-Length", String(content.byteLength))
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`)
    response.send(content)
  }
}
