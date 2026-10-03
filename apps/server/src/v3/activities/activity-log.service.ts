import { Injectable } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { EntityManager, Repository } from "typeorm"
import type {
  AuthUser,
  V3ActivityEventType,
  V3ActivityEventView,
  V3ActivityObjectType,
  V3StageCode
} from "@wurenji/shared"
import { ProjectActivityEventEntity } from "./activity-event.entity.js"

export interface RecordActivityInput {
  assignmentId?: string | null
  projectId?: string | null
  stageCode?: V3StageCode | null
  actor: AuthUser
  eventType: V3ActivityEventType
  objectType: V3ActivityObjectType
  objectId?: string | null
  realTime?: Date
  simulationTimeMs?: number | null
  beforeRevision?: number | null
  afterRevision?: number | null
  payload?: Record<string, unknown>
  result?: Record<string, unknown>
  correlationId?: string | null
}

@Injectable()
export class ActivityLogService {
  constructor(
    @InjectRepository(ProjectActivityEventEntity)
    private readonly events: Repository<ProjectActivityEventEntity>
  ) {}

  async record(manager: EntityManager, input: RecordActivityInput): Promise<void> {
    await manager.save(ProjectActivityEventEntity, manager.create(ProjectActivityEventEntity, {
      assignmentId: input.assignmentId ?? null,
      projectId: input.projectId ?? null,
      stageCode: input.stageCode ?? null,
      actorId: input.actor.id,
      actorName: input.actor.displayName,
      actorRole: input.actor.role,
      eventType: input.eventType,
      objectType: input.objectType,
      objectId: input.objectId ?? null,
      realTime: input.realTime ?? new Date(),
      simulationTimeMs: input.simulationTimeMs ?? null,
      beforeRevision: input.beforeRevision ?? null,
      afterRevision: input.afterRevision ?? null,
      payload: input.payload ?? {},
      result: input.result ?? {},
      correlationId: input.correlationId ?? null
    }))
  }

  async listProject(projectId: string): Promise<V3ActivityEventView[]> {
    const events = await this.events.find({ where: { projectId }, order: { realTime: "DESC", createdAt: "DESC" } })
    return events.map((event) => ({
      id: event.id,
      assignmentId: event.assignmentId,
      projectId: event.projectId,
      stageCode: event.stageCode,
      actorId: event.actorId,
      actorName: event.actorName,
      actorRole: event.actorRole,
      eventType: event.eventType,
      objectType: event.objectType,
      objectId: event.objectId,
      realTime: event.realTime.toISOString(),
      simulationTimeMs: event.simulationTimeMs === null ? null : Number(event.simulationTimeMs),
      beforeRevision: event.beforeRevision,
      afterRevision: event.afterRevision,
      payload: event.payload,
      result: event.result,
      correlationId: event.correlationId
    }))
  }
}
