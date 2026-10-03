import { BadRequestException, Injectable } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { Repository } from "typeorm"
import { v3RuntimeAlertStatuses, type AuthUser, type V3RuntimeAlertStatus, type V3RuntimeAlertView } from "@wurenji/shared"
import { V3AssignmentService } from "../assignments/assignment.service.js"
import { RuntimeAlertEntity } from "./runtime.entities.js"

@Injectable()
export class RuntimeService {
  constructor(
    @InjectRepository(RuntimeAlertEntity) private readonly alerts: Repository<RuntimeAlertEntity>,
    private readonly assignments: V3AssignmentService
  ) {}

  async listProjectAlerts(projectId: string, user: AuthUser, status?: string): Promise<V3RuntimeAlertView[]> {
    await this.assignments.projectStages(projectId, user)
    const normalizedStatus = normalizeAlertStatus(status)
    const alerts = await this.alerts.find({
      where: normalizedStatus ? { projectId, status: normalizedStatus } : { projectId },
      order: { openedAt: "DESC" }
    })
    return alerts.map(serializeAlert)
  }
}

function normalizeAlertStatus(value: string | undefined): V3RuntimeAlertStatus | undefined {
  if (!value) return undefined
  if (!v3RuntimeAlertStatuses.includes(value as V3RuntimeAlertStatus)) throw new BadRequestException("告警状态筛选无效")
  return value as V3RuntimeAlertStatus
}

function serializeAlert(alert: RuntimeAlertEntity): V3RuntimeAlertView {
  return {
    id: alert.id,
    projectId: alert.projectId,
    sessionId: alert.sessionId,
    eventId: alert.eventId,
    stageCode: alert.stageCode,
    code: alert.code,
    title: alert.title,
    detail: alert.detail,
    severity: alert.severity,
    status: alert.status,
    simulationTimeMs: alert.simulationTimeMs === null ? null : Number(alert.simulationTimeMs),
    openedAt: alert.openedAt.toISOString(),
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    resolvedAt: alert.resolvedAt?.toISOString() ?? null,
    payload: alert.payload,
    correlationId: alert.correlationId
  }
}
