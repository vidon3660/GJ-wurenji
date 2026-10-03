import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common"
import type { AuthUser } from "@wurenji/shared"
import { AuthGuard } from "../../auth/auth.guard.js"
import { CurrentUser } from "../../auth/current-user.js"
import { RuntimeService } from "./runtime.service.js"

@Controller("v3")
@UseGuards(AuthGuard)
export class RuntimeController {
  constructor(private readonly runtime: RuntimeService) {}

  @Get("projects/:id/alerts")
  alerts(@Param("id") id: string, @CurrentUser() user: AuthUser, @Query("status") status?: string) {
    return this.runtime.listProjectAlerts(id, user, status)
  }
}
