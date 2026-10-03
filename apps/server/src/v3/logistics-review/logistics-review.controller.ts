import { Body, Controller, Get, Param, Post, Put, Res, UseGuards } from "@nestjs/common"
import type { Response } from "express"
import type { AuthUser, ShowTeacherScoreView, V3LogisticsStudentReviewSummaryView } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { LogisticsReviewService } from "./logistics-review.service.js"

@Controller("v3/logistics-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class LogisticsReviewController {
  constructor(private readonly review: LogisticsReviewService) {}

  @Get(":projectId/review")
  workspace(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.review.workspace(projectId, user)
  }

  @Put(":projectId/review/summary")
  saveSummary(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; summary?: string; structuredSummary?: Partial<V3LogisticsStudentReviewSummaryView> }) {
    return this.review.saveStudentSummary(projectId, user, Number(body.expectedRevision), body.summary ?? "", body.structuredSummary, false)
  }

  @Post(":projectId/review/summary/submit")
  submitSummary(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; summary?: string; structuredSummary?: Partial<V3LogisticsStudentReviewSummaryView> }) {
    return this.review.saveStudentSummary(projectId, user, Number(body.expectedRevision), body.summary ?? "", body.structuredSummary, true)
  }

  @Put(":projectId/review/evaluation")
  saveEvaluation(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; teacherScores?: ShowTeacherScoreView[]; summary?: string }) {
    return this.review.saveTeacherEvaluation(projectId, user, Number(body.expectedRevision), body.teacherScores, body.summary)
  }

  @Post(":projectId/review/evaluation/publish")
  publishEvaluation(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.review.publishTeacherEvaluation(projectId, user, Number(body.expectedRevision))
  }

  @Post(":projectId/review/annotations")
  addAnnotation(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { timelineItemId?: string; simulationTimeMs?: number | null; comment?: string }) {
    return this.review.addAnnotation(projectId, user, body)
  }

  @Post(":projectId/review/report/generate")
  generateReport(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { format?: string }) {
    return this.review.generateReport(projectId, user, body.format ?? "PDF")
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
