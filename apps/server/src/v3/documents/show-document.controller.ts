import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import type { Response } from "express"
import type { AuthUser } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { AssessmentWindowGuard } from "../assessment/assessment-window.guard.js"
import { ShowDocumentService } from "./show-document.service.js"

@Controller("v3/show-projects")
@UseGuards(AuthGuard, AssessmentWindowGuard)
export class ShowDocumentController {
  constructor(private readonly documents: ShowDocumentService) {}

  @Get(":projectId/documents")
  workspace(@Param("projectId") projectId: string, @CurrentUser() user: AuthUser) {
    return this.documents.workspace(projectId, user)
  }

  @Put(":projectId/documents/:documentId/content")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  save(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { expectedRevision?: string; saveMode?: string }
  ) {
    return this.documents.saveUpload(projectId, documentId, user, file, Number(body.expectedRevision), body.saveMode === "AUTO_SAVE" ? "AUTO_SAVE" : "MANUAL_SAVE")
  }

  @Post(":projectId/documents/:documentId/submit")
  submit(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { expectedRevision?: number }
  ) {
    return this.documents.submit(projectId, documentId, user, Number(body.expectedRevision))
  }

  @Post(":projectId/documents/:documentId/viewed")
  viewed(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { comment?: string; score?: number | null }
  ) {
    return this.documents.markViewed(projectId, documentId, user, body)
  }

  @Post(":projectId/documents/:documentId/return")
  returnForRevision(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: { comment?: string; score?: number | null }
  ) {
    return this.documents.returnForRevision(projectId, documentId, user, body)
  }

  @Post(":projectId/documents/:documentId/editor-session")
  editorSession(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @CurrentUser() user: AuthUser
  ) {
    return this.documents.editorSession(projectId, documentId, user)
  }

  @Post(":projectId/documents/:documentId/versions/:versionId/editor-session")
  versionEditorSession(
    @Param("projectId") projectId: string,
    @Param("documentId") documentId: string,
    @Param("versionId") versionId: string,
    @CurrentUser() user: AuthUser
  ) {
    return this.documents.versionEditorSession(projectId, documentId, versionId, user)
  }
}

@Controller("v3/office")
export class OnlyOfficeCallbackController {
  constructor(private readonly documents: ShowDocumentService) {}

  @Get("assets/:assetId")
  async asset(@Param("assetId") assetId: string, @Query("access_token") token: string | undefined, @Res() response: Response) {
    const { asset, content } = await this.documents.readOfficeAsset(assetId, token)
    response.setHeader("Content-Type", asset.mimeType)
    response.setHeader("Content-Length", String(content.byteLength))
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`)
    response.send(content)
  }

  @Post("callbacks/:sessionId")
  @HttpCode(HttpStatus.OK)
  callback(
    @Param("sessionId") sessionId: string,
    @Query("access_token") token: string | undefined,
    @Body() body: { status?: number; key?: string; url?: string }
  ) {
    return this.documents.onlyOfficeCallback(sessionId, token, body)
  }
}
