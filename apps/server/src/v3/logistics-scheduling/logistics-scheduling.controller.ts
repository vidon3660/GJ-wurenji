import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common"
import type { AuthUser } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { LogisticsSchedulingService } from "./logistics-scheduling.service.js"

@Controller("v3/logistics-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class LogisticsSchedulingController {
  constructor(private readonly scheduling: LogisticsSchedulingService) {}

  @Get(":id/scheduling-workspace")
  workspace(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.scheduling.workspace(id, user)
  }

  @Put(":id/schedule-plan/draft")
  saveDraft(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; items?: unknown }) {
    return this.scheduling.saveDraft(id, user, body)
  }

  @Post(":id/schedule-plan/batch-adjust")
  batchAdjust(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.scheduling.batchAdjustDraft(id, user, body)
  }

  @Post(":id/schedule-plan/check")
  check(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.scheduling.checkDraft(id, user)
  }

  @Post(":id/schedule-plan/snapshot")
  snapshot(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.scheduling.createVersion(id, user)
  }

  @Post(":id/schedule-plan/versions/:versionId/restore")
  restore(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedDraftRevision?: number }) {
    return this.scheduling.restoreVersion(id, versionId, user, body)
  }

  @Post(":id/schedule-plan/versions/:versionId/submit")
  submit(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedDraftRevision?: number; expectedStageRevision?: number }) {
    return this.scheduling.submitVersion(id, versionId, user, body)
  }
}
