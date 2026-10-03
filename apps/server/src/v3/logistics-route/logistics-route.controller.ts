import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common"
import type { AuthUser } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { LogisticsRouteService } from "./logistics-route.service.js"

@Controller("v3/logistics-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class LogisticsRouteController {
  constructor(private readonly logisticsRoutes: LogisticsRouteService) {}

  @Get(":id/route-workspace")
  workspace(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.logisticsRoutes.workspace(id, user)
  }

  @Put(":id/region-analysis")
  saveRegion(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; selectedDeliveryPointIds?: unknown; notes?: unknown }) {
    return this.logisticsRoutes.saveRegionAnalysis(id, user, body)
  }

  @Post(":id/region-analysis/confirm")
  confirmRegion(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; expectedStageRevision?: number }) {
    return this.logisticsRoutes.confirmRegionAnalysis(id, user, body)
  }

  @Put(":id/route-plan/draft")
  saveDraft(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; routes?: unknown; annotations?: unknown }) {
    return this.logisticsRoutes.saveDraft(id, user, body)
  }

  @Post(":id/route-plan/check")
  check(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.logisticsRoutes.checkDraft(id, user)
  }

  @Post(":id/route-plan/snapshot")
  snapshot(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.logisticsRoutes.createSnapshot(id, user)
  }

  @Post(":id/route-plan/complete")
  completePlanning(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedDraftRevision?: number; expectedStageRevision?: number }) {
    return this.logisticsRoutes.completePlanning(id, user, body)
  }

  @Post(":id/route-plan/validate")
  validate(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.logisticsRoutes.validateDraft(id, user)
  }

  @Post(":id/route-plan/versions/:versionId/restore")
  restore(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedDraftRevision?: number }) {
    return this.logisticsRoutes.restoreVersion(id, versionId, user, body)
  }

  @Post(":id/route-plan/versions/:versionId/submit")
  submit(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedDraftRevision?: number; expectedStageRevision?: number }) {
    return this.logisticsRoutes.submitValidatedPlan(id, versionId, user, body)
  }
}
