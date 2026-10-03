import { Body, Controller, Get, Param, Post, Put, Res, UseGuards } from "@nestjs/common"
import type { Response } from "express"
import type { AuthUser } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { V3ShowProjectService } from "./show-project.service.js"

@Controller("v3")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class V3ShowProjectController {
  constructor(private readonly showProjects: V3ShowProjectService) {}

  @Get("show-projects/:id/area-plan")
  workspace(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.showProjects.workspace(id, user)
  }

  @Put("show-projects/:id/area-plan/draft")
  saveDraft(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: number; features?: unknown; annotations?: unknown }) {
    return this.showProjects.saveDraft(id, user, body)
  }

  @Post("show-projects/:id/area-plan/check")
  check(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.showProjects.checkDraft(id, user)
  }

  @Post("show-projects/:id/area-plan/snapshot")
  snapshot(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedDraftRevision?: number }) {
    return this.showProjects.snapshot(id, user, body.expectedDraftRevision)
  }

  @Post("show-projects/:id/area-plan/submit")
  submit(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedDraftRevision?: number; expectedStageRevision?: number }
  ) {
    return this.showProjects.submit(id, user, body.expectedDraftRevision, body.expectedStageRevision)
  }

  @Post("show-projects/:id/area-plan/versions/:versionId/accept")
  accept(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { comment?: string; score?: number | null }
  ) {
    return this.showProjects.accept(id, versionId, user, body)
  }

  @Post("show-projects/:id/area-plan/versions/:versionId/return")
  returnForRevision(
    @Param("id") id: string,
    @Param("versionId") versionId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { comment?: string; score?: number | null }
  ) {
    return this.showProjects.returnForRevision(id, versionId, user, body)
  }

  @Get("files/:id/download")
  async download(@Param("id") id: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    const { asset, content } = await this.showProjects.download(id, user)
    response.setHeader("Content-Type", asset.mimeType)
    response.setHeader("Content-Length", String(content.byteLength))
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`)
    response.send(content)
  }

  @Get("files/:id/preview")
  async preview(@Param("id") id: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    const { asset, content } = await this.showProjects.download(id, user)
    response.setHeader("Content-Type", asset.mimeType)
    response.setHeader("Content-Length", String(content.byteLength))
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`)
    response.setHeader("Cache-Control", "private, max-age=300")
    response.send(content)
  }
}
