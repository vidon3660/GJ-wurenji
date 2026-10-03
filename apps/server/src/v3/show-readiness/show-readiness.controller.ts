import { Body, Controller, Get, Param, Post, Put, UseGuards } from "@nestjs/common"
import type { AuthUser, ShowPreflightResolution, ShowTakeoffDecision } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { ShowReadinessService } from "./show-readiness.service.js"

@Controller("v3/show-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class ShowReadinessController {
  constructor(private readonly readiness: ShowReadinessService) {}

  @Get(":projectId/preflight")
  preflight(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.readiness.preflightWorkspace(projectId, user)
  }

  @Put(":projectId/preflight")
  savePreflight(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: {
      expectedRevision?: number
      responses?: Array<{ code?: string; confirmed?: boolean; resolution?: ShowPreflightResolution | null; resolved?: boolean; note?: string }>
      decision?: ShowTakeoffDecision | null
      rationale?: string
    }
  ) {
    return this.readiness.savePreflight(projectId, user, body)
  }

  @Post(":projectId/preflight/complete")
  completePreflight(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number }
  ) {
    return this.readiness.completePreflight(projectId, user, Number(body.expectedRevision))
  }

  @Get(":projectId/t60-report")
  t60(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.readiness.t60Workspace(projectId, user)
  }

  @Post(":projectId/t60-report/submit")
  submitT60(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number }
  ) {
    return this.readiness.submitT60(projectId, user, Number(body.expectedRevision))
  }
}
