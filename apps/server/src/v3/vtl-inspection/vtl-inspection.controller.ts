import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common"
import type { AuthUser } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { VtlInspectionService } from "./vtl-inspection.service.js"

@Controller("v3/vtl-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class VtlInspectionController {
  constructor(private readonly vtl: VtlInspectionService) {}

  @Get(":id/planning-workspace")
  workspace(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.vtl.workspace(id, user)
  }

  @Post(":id/area/confirm")
  confirmArea(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.vtl.confirmArea(id, user, body)
  }

  @Put(":id/allocation")
  saveAllocation(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.vtl.saveAllocation(id, user, body)
  }

  @Post(":id/allocation/submit")
  submitAllocation(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.vtl.submitAllocation(id, user, body)
  }

  @Put(":id/routes/:aircraftId")
  saveRoute(@Param("id") id: string, @Param("aircraftId") aircraftId: string, @CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.vtl.saveRoute(id, aircraftId, user, body)
  }

  @Post(":id/routes/complete")
  completeRoutes(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.vtl.completeRoutes(id, user, body)
  }

  @Post(":id/validate")
  validate(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.vtl.validate(id, user)
  }

  @Post(":id/validation/submit")
  submitValidation(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.vtl.submitValidation(id, user, body)
  }

  @Post(":id/execution-plan/submit")
  submitExecutionPlan(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.vtl.submitExecutionPlan(id, user, body)
  }
}
