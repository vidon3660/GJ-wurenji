import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm"
import type {
  V3AlertSeverity,
  V3EvaluationStatus,
  ShowObjectiveMetricView,
  ShowTeacherScoreView,
  V3RuntimeAlertStatus,
  V3RuntimeEventStatus,
  V3RuntimeSessionStatus,
  V3StageCode,
  V3StudentActionStatus
} from "@wurenji/shared"

@Entity("runtime_sessions")
@Index(["projectId", "createdAt"])
@Index(["projectId", "attemptNo"], { unique: true })
export class RuntimeSessionEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "varchar", length: 20, default: "READY" }) status!: V3RuntimeSessionStatus
  @Column({ type: "varchar", length: 20, nullable: true }) mode!: "TRAINING" | "ASSESSMENT" | null
  @Column({ type: "varchar", length: 120 }) scenarioSeed!: string
  @Column({ type: "varchar", length: 220, nullable: true }) mapResourceVersion!: string | null
  @Column({ type: "varchar", length: 220, nullable: true }) sceneResourceVersion!: string | null
  @Column({ type: "varchar", length: 220, nullable: true }) planVersion!: string | null
  @Column({ type: "integer", default: 1 }) attemptNo!: number
  @Column({ type: "uuid", nullable: true }) sourceSessionId!: string | null
  @Column({ type: "varchar", length: 120, nullable: true }) restartNodeCode!: string | null
  @Column({ type: "bigint", nullable: true }) restartSimulationTimeMs!: number | null
  @Column({ type: "bigint", default: 0 }) simulationTimeMs!: number
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) checkpoint!: Record<string, unknown>
  @Column({ type: "timestamptz", nullable: true }) startedAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) endedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

@Entity("runtime_events")
@Index(["projectId", "status"])
@Index(["sessionId", "scheduledSimulationTimeMs"])
@Index(["correlationId"])
export class RuntimeEventEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "uuid" }) sessionId!: string
  @Column({ type: "varchar", length: 60 }) stageCode!: V3StageCode
  @Column({ type: "varchar", length: 80 }) code!: string
  @Column({ type: "varchar", length: 60 }) category!: string
  @Column({ type: "varchar", length: 20, default: "SCHEDULED" }) status!: V3RuntimeEventStatus
  @Column({ type: "varchar", length: 20 }) severity!: V3AlertSeverity
  @Column({ type: "bigint", nullable: true }) scheduledSimulationTimeMs!: number | null
  @Column({ type: "bigint", nullable: true }) triggeredSimulationTimeMs!: number | null
  @Column({ type: "bigint", nullable: true }) resolvedSimulationTimeMs!: number | null
  @Column({ type: "timestamptz", nullable: true }) triggeredAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) resolvedAt!: Date | null
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) payload!: Record<string, unknown>
  @Column({ type: "uuid" }) correlationId!: string
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

@Entity("runtime_alerts")
@Index(["projectId", "status"])
@Index(["sessionId", "openedAt"])
@Index(["severity", "openedAt"])
@Index(["correlationId"])
export class RuntimeAlertEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "uuid", nullable: true }) sessionId!: string | null
  @Column({ type: "uuid", nullable: true }) eventId!: string | null
  @Column({ type: "varchar", length: 60 }) stageCode!: V3StageCode
  @Column({ type: "varchar", length: 80 }) code!: string
  @Column({ type: "varchar", length: 160 }) title!: string
  @Column({ type: "text" }) detail!: string
  @Column({ type: "varchar", length: 20 }) severity!: V3AlertSeverity
  @Column({ type: "varchar", length: 20, default: "OPEN" }) status!: V3RuntimeAlertStatus
  @Column({ type: "bigint", nullable: true }) simulationTimeMs!: number | null
  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" }) openedAt!: Date
  @Column({ type: "timestamptz", nullable: true }) acknowledgedAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) resolvedAt!: Date | null
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) payload!: Record<string, unknown>
  @Column({ type: "uuid" }) correlationId!: string
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

@Entity("student_runtime_actions")
@Index(["projectId", "requestedAt"])
@Index(["sessionId", "simulationTimeMs"])
@Index(["correlationId"])
export class StudentRuntimeActionEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "uuid" }) sessionId!: string
  @Column({ type: "uuid", nullable: true }) eventId!: string | null
  @Column({ type: "uuid", nullable: true }) alertId!: string | null
  @Column({ type: "uuid" }) actorId!: string
  @Column({ type: "varchar", length: 80 }) actionCode!: string
  @Column({ type: "varchar", length: 60 }) targetType!: string
  @Column({ type: "varchar", length: 120, nullable: true }) targetId!: string | null
  @Column({ type: "varchar", length: 20, default: "REQUESTED" }) status!: V3StudentActionStatus
  @Column({ type: "bigint" }) simulationTimeMs!: number
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) payload!: Record<string, unknown>
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) result!: Record<string, unknown>
  @Column({ type: "uuid" }) correlationId!: string
  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" }) requestedAt!: Date
  @Column({ type: "timestamptz", nullable: true }) appliedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
}

@Entity("project_evaluations")
@Index(["projectId"], { unique: true })
export class ProjectEvaluationEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "varchar", length: 20, default: "PENDING" }) status!: V3EvaluationStatus
  @Column({ type: "varchar", length: 120 }) rubricVersion!: string
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) objectiveMetrics!: ShowObjectiveMetricView[]
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) teacherScores!: ShowTeacherScoreView[]
  @Column({ type: "text", default: "" }) studentSummary!: string
  @Column({ type: "timestamptz", nullable: true }) studentSubmittedAt!: Date | null
  @Column({ type: "text", default: "" }) summary!: string
  @Column({ type: "double precision", nullable: true }) totalScore!: number | null
  @Column({ type: "uuid", nullable: true }) reviewedById!: string | null
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "timestamptz", nullable: true }) reviewedAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) publishedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

export const v3RuntimeEntities = [
  RuntimeSessionEntity,
  RuntimeEventEntity,
  RuntimeAlertEntity,
  StudentRuntimeActionEntity,
  ProjectEvaluationEntity
]
