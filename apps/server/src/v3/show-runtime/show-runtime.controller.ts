import { Body, Controller, Get, Param, Post, Put, Req, Res, UseFilters, UseGuards } from "@nestjs/common"
import type { Request, Response } from "express"
import type { AuthUser, ShowRuntimeActionCode, V3RuntimeActionReasoning } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { ShowRuntimeService } from "./show-runtime.service.js"
import { streamRuntimeWorkspace } from "../runtime/runtime-stream.js"
import { RuntimeHttpExceptionFilter } from "../runtime/runtime-http-exception.filter.js"

@Controller("v3/show-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
@UseFilters(RuntimeHttpExceptionFilter)
export class ShowRuntimeController {
  constructor(private readonly runtime: ShowRuntimeService) {}

  @Get(":projectId/runtime")
  workspace(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.runtime.workspace(projectId, user)
  }

  @Get(":projectId/runtime/attempts/:sessionId")
  attempt(@Param("projectId") projectId: string, @Param("sessionId") sessionId: string, @CurrentUser() user: AuthUser) {
    return this.runtime.workspace(projectId, user, sessionId)
  }

  @Get(":projectId/runtime/stream")
  async stream(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Req() request: Request, @Res() response: Response) {
    await streamRuntimeWorkspace(request, response, `show:${projectId}:${user.id}`, () => this.runtime.workspace(projectId, user))
  }

  @Post(":projectId/runtime/start")
  start(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.runtime.start(projectId, user, Number(body.expectedRevision))
  }

  @Post(":projectId/runtime/restart")
  restart(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number; nodeCode?: string }
  ) {
    return this.runtime.restart(projectId, user, Number(body.expectedRevision), body.nodeCode ?? "")
  }

  @Post(":projectId/runtime/actions")
  action(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: {
      expectedRevision?: number
      actionCode?: ShowRuntimeActionCode
      eventId?: string | null
      alertId?: string | null
      targetType?: string
      targetId?: string | null
      requestId?: string
      reasoning?: V3RuntimeActionReasoning
    }
  ) {
    return this.runtime.applyAction(projectId, user, body)
  }

  @Post(":projectId/runtime/clock-rate")
  clockRate(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number; rate?: number; status?: "RUNNING" | "PAUSED" }
  ) {
    return this.runtime.setClockRate(projectId, user, Number(body.expectedRevision), Number(body.rate), body.status)
  }

  @Post(":projectId/runtime/events/:code/trigger")
  triggerEvent(
    @Param("projectId") projectId: string,
    @Param("code") code: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number; requestId?: string }
  ) {
    return this.runtime.triggerEvent(projectId, code, user, Number(body.expectedRevision), body.requestId)
  }

  @Post(":projectId/runtime/hints")
  hint(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number; message?: string }
  ) {
    return this.runtime.sendTeacherHint(projectId, user, Number(body.expectedRevision), body.message ?? "")
  }

  @Get(":projectId/flight-end-report")
  endReport(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.runtime.endReport(projectId, user)
  }

  @Put(":projectId/flight-end-report")
  saveEndReport(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: {
      expectedRevision?: number
      completionStatus?: "NORMAL" | "ABNORMAL" | "ABORTED" | null
      normalLandedCount?: number | null
      abnormalCount?: number | null
      abnormalDescription?: string
    }
  ) {
    return this.runtime.saveEndReport(projectId, user, body)
  }

  @Post(":projectId/flight-end-report/submit")
  submitEndReport(
    @Param("projectId") projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: {
      expectedRevision?: number
      completionStatus?: "NORMAL" | "ABNORMAL" | "ABORTED" | null
      normalLandedCount?: number | null
      abnormalCount?: number | null
      abnormalDescription?: string
    }
  ) {
    return this.runtime.submitEndReport(projectId, user, body)
  }
}
