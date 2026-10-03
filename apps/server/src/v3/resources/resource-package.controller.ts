import { BadRequestException, Body, Controller, Get, Param, Post, Query, Res, UploadedFile, UseGuards, UseInterceptors } from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"
import type { Response } from "express"
import type { AuthUser, ResourcePackageType, SceneType } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { ResourcePackageService } from "./resource-package.service.js"

@Controller("v3/resource-packages")
@UseGuards(AuthGuard)
export class ResourcePackageController {
  constructor(private readonly resources: ResourcePackageService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.resources.list(user)
  }

  @Get("regions/catalog")
  regions(@Query("sceneType") sceneType?: string) {
    if (sceneType !== undefined && sceneType !== "CITY_SHOW" && sceneType !== "CITY_LOGISTICS" && sceneType !== "VTOL_INSPECTION") throw new BadRequestException("场景类型无效")
    return this.resources.listRegions(sceneType as SceneType | undefined)
  }

  @Get("regions/:id")
  region(@Param("id") id: string) {
    return this.resources.findRegion(id)
  }

  @Get("regions/:id/readiness")
  readiness(@Param("id") id: string) {
    return this.resources.mapReadiness(id)
  }

  @Get("scale-templates/catalog")
  scaleTemplates(@Query("sceneType") sceneType?: string) {
    if (sceneType !== undefined && sceneType !== "CITY_SHOW" && sceneType !== "CITY_LOGISTICS" && sceneType !== "VTOL_INSPECTION") throw new BadRequestException("场景类型无效")
    return this.resources.listScaleTemplates(sceneType as SceneType | undefined)
  }

  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024, files: 1 } }))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.resources.upload(user, file)
  }

  @Post("show-programs/import")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 50 * 1024 * 1024, files: 1 } }))
  importShowProgram(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { name?: string; version?: string; sourceSoftware?: string }
  ) {
    return this.resources.importShowProgram(user, file, body)
  }

  @Post()
  register(@CurrentUser() user: AuthUser, @Body() body: {
    packageType?: ResourcePackageType
    name?: string
    version?: string
    schemaVersion?: number
    minimumPlatformVersion?: string
    sha256?: string
    manifest?: Record<string, unknown>
  }) {
    return this.resources.register(user, body)
  }

  @Get(":id")
  detail(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.resources.detail(id, user)
  }

  @Get(":id/archive")
  async archive(@Param("id") id: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    const { asset, content } = await this.resources.downloadArchive(id, user)
    response.setHeader("Content-Type", asset.mimeType)
    response.setHeader("Content-Length", String(content.byteLength))
    response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`)
    response.send(content)
  }

  @Post(":id/preflight")
  preflight(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.resources.preflight(id, user)
  }

  @Post(":id/activate")
  activate(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body?: { reason?: string }) {
    return this.resources.activate(id, user, body?.reason)
  }

  @Post(":id/rollback")
  rollback(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body?: { reason?: string }) {
    return this.resources.rollback(id, user, body?.reason)
  }

  @Post(":id/retire")
  retire(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body?: { reason?: string }) {
    return this.resources.retire(id, user, body?.reason)
  }
}
