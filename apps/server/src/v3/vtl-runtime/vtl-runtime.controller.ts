import { Body, Controller, Get, Param, Post, Req, Res, UseFilters, UseGuards } from "@nestjs/common"
import type { Request, Response } from "express"
import type { AuthUser } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { streamRuntimeWorkspace } from "../runtime/runtime-stream.js"
import { VtlRuntimeService } from "./vtl-runtime.service.js"
import { RuntimeHttpExceptionFilter } from "../runtime/runtime-http-exception.filter.js"

@Controller("v3/vtl-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
@UseFilters(RuntimeHttpExceptionFilter)
export class VtlRuntimeController {
  constructor(private readonly runtime: VtlRuntimeService) {}

  @Get(":projectId/runtime")
  workspace(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) { return this.runtime.workspace(projectId, user) }

  @Get(":projectId/runtime/attempts/:sessionId")
  attempt(@Param("projectId") projectId: string, @Param("sessionId") sessionId: string, @CurrentUser() user: AuthUser) { return this.runtime.workspace(projectId, user, sessionId) }

  @Get(":projectId/runtime/stream")
  async stream(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Req() request: Request, @Res() response: Response) {
    await streamRuntimeWorkspace(request, response, `vtl:${projectId}:${user.id}`, () => this.runtime.workspace(projectId, user))
  }

  @Post(":projectId/runtime/start")
  start(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) { return this.runtime.start(projectId, user, Number(body.expectedRevision)) }

  @Post(":projectId/runtime/clock-rate")
  clockRate(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; rate?: number; status?: "RUNNING" | "PAUSED" }) {
    return this.runtime.setClockRate(projectId, user, Number(body.expectedRevision), Number(body.rate), body.status)
  }

  @Post(":projectId/runtime/actions")
  action(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) { return this.runtime.applyAction(projectId, user, body) }

  @Post(":projectId/runtime/events/:code/trigger")
  triggerEvent(@Param("projectId") projectId: string, @Param("code") code: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; requestId?: string }) { return this.runtime.triggerEvent(projectId, code, user, Number(body.expectedRevision), body.requestId) }

  @Post(":projectId/emergency/complete")
  completeEmergency(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) { return this.runtime.completeEmergency(projectId, user, Number(body.expectedRevision)) }
}
