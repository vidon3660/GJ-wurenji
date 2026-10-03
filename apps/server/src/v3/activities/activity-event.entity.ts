import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm"
import type {
  UserRole,
  V3ActivityEventType,
  V3ActivityObjectType,
  V3StageCode
} from "@wurenji/shared"

@Entity("project_activity_events")
@Index(["assignmentId", "realTime"])
@Index(["projectId", "realTime"])
@Index(["correlationId"])
export class ProjectActivityEventEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "uuid", nullable: true })
  assignmentId!: string | null

  @Column({ type: "uuid", nullable: true })
  projectId!: string | null

  @Column({ type: "varchar", length: 60, nullable: true })
  stageCode!: V3StageCode | null

  @Column({ type: "uuid" })
  actorId!: string

  @Column({ type: "varchar", length: 120 })
  actorName!: string

  @Column({ type: "varchar", length: 20 })
  actorRole!: UserRole

  @Column({ type: "varchar", length: 60 })
  eventType!: V3ActivityEventType

  @Column({ type: "varchar", length: 40 })
  objectType!: V3ActivityObjectType

  @Column({ type: "uuid", nullable: true })
  objectId!: string | null

  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  realTime!: Date

  @Column({ type: "bigint", nullable: true })
  simulationTimeMs!: number | null

  @Column({ type: "integer", nullable: true })
  beforeRevision!: number | null

  @Column({ type: "integer", nullable: true })
  afterRevision!: number | null

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  payload!: Record<string, unknown>

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  result!: Record<string, unknown>

  @Column({ type: "uuid", nullable: true })
  correlationId!: string | null

  @CreateDateColumn()
  createdAt!: Date
}

export const v3ActivityEntities = [ProjectActivityEventEntity]
