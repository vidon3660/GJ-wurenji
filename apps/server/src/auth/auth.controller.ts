import { Body, Controller, Get, Post, Res, UseGuards } from "@nestjs/common"
import type { Response } from "express"
import type { AuthUser } from "@wurenji/shared"
import { AuthService } from "./auth.service.js"
import { AuthGuard } from "./auth.guard.js"
import { CurrentUser } from "./current-user.js"

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  async login(@Body() body: { email?: string; password?: string }, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(body.email ?? "", body.password ?? "")
    response.cookie("wurenji_token", result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.COOKIE_SECURE === "true" || (process.env.COOKIE_SECURE === undefined && process.env.NODE_ENV === "production"),
      maxAge: 8 * 60 * 60 * 1000
    })
    return { user: result.user }
  }

  @Post("logout")
  logout(@Res({ passthrough: true }) response: Response) {
    response.clearCookie("wurenji_token")
    return { ok: true }
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(@CurrentUser() user: AuthUser) {
    return { user }
  }
}
