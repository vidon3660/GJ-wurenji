import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common"
import type { AuthUser, SceneType } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { ScenarioOverlayService } from "./scenario-overlay.service.js"

@Controller("v3/scenario-overlays")
@UseGuards(AuthGuard)
export class ScenarioOverlayController {
  constructor(private readonly overlays: ScenarioOverlayService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query("regionPackageId") regionPackageId?: string) {
    return this.overlays.list(user, regionPackageId)
  }

  @Get("versions/:id")
  detail(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.overlays.detail(id, user)
  }

  @Get("published/:id")
  published(@Param("id") id: string) {
    return this.overlays.publishedDetail(id)
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: { sceneType?: SceneType; regionPackageId?: string; title?: string; name?: string; objects?: unknown[] }) {
    return this.overlays.create(user, body)
  }

  @Put("versions/:id")
  update(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { title?: string; objects?: unknown[]; expectedRevision?: unknown }) {
    return this.overlays.update(id, user, body)
  }

  @Put(":id")
  updateLegacy(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { title?: string; name?: string; objects?: unknown; expectedRevision?: unknown } = {}) {
    return this.overlays.update(id, user, { ...(body.title !== undefined || body.name !== undefined ? { title: body.title ?? body.name } : {}), ...(body.objects !== undefined ? { objects: body.objects } : {}), expectedRevision: body.expectedRevision })
  }

  @Post("versions/:id/fork")
  fork(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.overlays.fork(id, user)
  }

  @Post(":id/draft")
  forkLegacy(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.overlays.fork(id, user)
  }

  @Post("versions/:id/publish")
  publish(@Param("id") id: string, @CurrentUser() user: AuthUser, @Body() body: { expectedRevision?: unknown }) {
    return this.overlays.publish(id, user, body?.expectedRevision)
  }

  @Post("versions/:id/archive")
  archive(@Param("id") id: string, @CurrentUser() user: AuthUser) {
    return this.overlays.archive(id, user)
  }
}
