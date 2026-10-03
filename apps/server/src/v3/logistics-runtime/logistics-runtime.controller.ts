import { Body, Controller, Get, Param, Post, Put, Req, Res, UseFilters, UseGuards } from "@nestjs/common"
import type { Request, Response } from "express"
import type { AuthUser, V3RuntimeActionReasoning } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { LogisticsReadinessService } from "./logistics-readiness.service.js"
import { LogisticsRuntimeService } from "./logistics-runtime.service.js"
import { streamRuntimeWorkspace } from "../runtime/runtime-stream.js"
import { RuntimeHttpExceptionFilter } from "../runtime/runtime-http-exception.filter.js"

@Controller("v3/logistics-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
@UseFilters(RuntimeHttpExceptionFilter)
export class LogisticsRuntimeController {
  constructor(
    private readonly readiness: LogisticsReadinessService,
    private readonly runtime: LogisticsRuntimeService
  ) {}

  @Get(":id/runtime-readiness")
  readinessWorkspace(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.readiness.workspace(id, user)
  }

  @Put(":id/runtime-readiness")
  saveReadiness(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; decision?: unknown; decisionBasis?: unknown }) {
    return this.readiness.save(id, user, body)
  }

  @Post(":id/runtime-readiness/check")
  checkReadiness(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.readiness.check(id, user, body.expectedRevision)
  }

  @Post(":id/runtime-readiness/confirm")
  confirmReadiness(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.readiness.confirm(id, user, body.expectedRevision)
  }

  @Get(":id/runtime-workspace")
  runtimeWorkspace(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.runtime.workspace(id, user)
  }

  @Get(":id/runtime/attempts/:sessionId")
  runtimeAttempt(@Param("id") id: string, @Param("sessionId") sessionId: string, @CurrentUser() user: AuthUser) {
    return this.runtime.workspace(id, user, sessionId)
  }

  @Get(":id/runtime/stream")
  async runtimeStream(@Param("id") id: string, @CurrentUser() user: AuthUser, @Req() request: Request, @Res() response: Response) {
    await streamRuntimeWorkspace(request, response, `logistics:${id}:${user.id}`, () => this.runtime.workspace(id, user))
  }

  @Post(":id/runtime/start")
  start(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.runtime.start(id, user, body.expectedRevision)
  }

  @Post(":id/runtime/restart")
  restart(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; nodeCode?: string }) {
    return this.runtime.restart(id, user, body.expectedRevision, body.nodeCode)
  }

  @Post(":id/runtime/clock")
  clock(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; status?: unknown; rate?: unknown }) {
    return this.runtime.changeClock(id, user, body)
  }

  @Post(":id/runtime/events/:eventId/trigger")
  triggerEvent(@Param("id") id: string, @Param("eventId") eventId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; requestId?: string }) {
    return this.runtime.triggerEvent(id, eventId, user, body.expectedRevision, body.requestId)
  }

  @Post(":id/runtime/hints")
  sendHint(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; message?: string }) {
    return this.runtime.sendTeacherHint(id, user, body.expectedRevision, body.message)
  }

  @Post(":id/runtime/actions")
  action(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; actionCode?: unknown; targetId?: unknown; eventId?: unknown; alertId?: unknown; requestId?: unknown; reasoning?: V3RuntimeActionReasoning; payload?: unknown }) {
    return this.runtime.applyAction(id, user, body)
  }

  @Post(":id/runtime/dynamic-schedules")
  createDynamicSchedule(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; mode?: unknown; reason?: unknown; items?: unknown; eventId?: unknown }) {
    return this.runtime.createDynamicSchedule(id, user, body)
  }

  @Post(":id/runtime/dynamic-schedules/:versionId/submit")
  submitDynamicSchedule(@Param("id") id: string, @Param("versionId") versionId: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number }) {
    return this.runtime.submitDynamicSchedule(id, versionId, user, body.expectedRevision)
  }

  @Post(":id/runtime/emergency-handling/complete")
  completeEmergencyHandling(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.runtime.completeEmergencyHandling(id, user)
  }
}
