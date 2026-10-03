import { createParamDecorator, ExecutionContext } from "@nestjs/common"
import type { AuthUser } from "@wurenji/shared"
import type { AuthenticatedRequest } from "./auth.guard.js"

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
  return request.authUser!
})
