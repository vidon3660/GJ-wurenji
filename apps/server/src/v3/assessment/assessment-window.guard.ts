import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import type { AuthenticatedRequest } from "../../auth/auth.guard.js"
import { AssessmentWindowService } from "./assessment-window.service.js"

const assessmentStartAllowed = "assessment-start-allowed"

export const AllowAssessmentStart = () => SetMetadata(assessmentStartAllowed, true)

@Injectable()
export class AssessmentWindowGuard implements CanActivate {
  constructor(private readonly windows: AssessmentWindowService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) || request.authUser?.role !== "student") return true
    const projectId = String(request.params.projectId ?? request.params.id ?? "").trim()
    if (!projectId) return true
    const allowStart = this.reflector.getAllAndOverride<boolean>(assessmentStartAllowed, [context.getHandler(), context.getClass()]) === true
    await this.windows.assertWritable(projectId, request.authUser, allowStart)
    return true
  }
}
