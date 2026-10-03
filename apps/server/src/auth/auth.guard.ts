import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common"
import type { Request } from "express"
import { AuthService } from "./auth.service.js"

export interface AuthenticatedRequest extends Request {
  authUser?: Awaited<ReturnType<AuthService["verify"]>>
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const token = request.cookies?.wurenji_token as string | undefined
    if (!token) throw new UnauthorizedException("请先登录")
    request.authUser = await this.auth.verify(token)
    return true
  }
}
