import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm"
import type {
  LogisticsDynamicScheduleVersionStatus,
  LogisticsDynamicScheduleMode,
  LogisticsReadinessCheckItemView,
  LogisticsReadinessDecision,
  LogisticsReadinessStatus,
  LogisticsScheduleCheckResult,
  LogisticsScheduleItemInput
} from "@wurenji/shared"
import type { LogisticsRuntimeProjection } from "@wurenji/simulation"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { LogisticsScheduleVersionEntity } from "../logistics-scheduling/logistics-scheduling.entities.js"

@Entity("logistics_runtime_readiness")
@Index(["project"], { unique: true })
export class LogisticsRuntimeReadinessEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity
  @ManyToOne(() => LogisticsScheduleVersionEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  scheduleVersion!: LogisticsScheduleVersionEntity
  @Column({ type: "varchar", length: 20, default: "DRAFT" }) status!: LogisticsReadinessStatus
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "varchar", length: 40, nullable: true }) decision!: LogisticsReadinessDecision | null
  @Column({ type: "text", default: "" }) decisionBasis!: string
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) checks!: LogisticsReadinessCheckItemView[]
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) updatedBy!: UserEntity
  @Column({ type: "timestamptz", nullable: true }) confirmedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

@Entity("logistics_runtime_snapshots")
@Index(["sessionId", "sequence"], { unique: true })
@Index(["projectId", "simulationTimeMs"])
export class LogisticsRuntimeSnapshotEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "uuid" }) sessionId!: string
  @Column({ type: "integer" }) sequence!: number
  @Column({ type: "bigint" }) simulationTimeMs!: number
  @Column({ type: "varchar", length: 40 }) reason!: "READY" | "START" | "TICK" | "CLOCK" | "EVENT" | "ACTION" | "RESCHEDULE" | "COMPLETE"
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) checkpoint!: Record<string, unknown>
  @Column({ type: "jsonb" }) projection!: LogisticsRuntimeProjection
  @Column({ type: "varchar", length: 64 }) contentHash!: string
  @CreateDateColumn() createdAt!: Date
}

@Entity("logistics_dynamic_schedule_versions")
@Index(["project", "versionNo"], { unique: true })
export class LogisticsDynamicScheduleVersionEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity
  @Column({ type: "uuid", nullable: true }) parentVersionId!: string | null
  @Column({ type: "integer" }) versionNo!: number
  @Column({ type: "varchar", length: 20, default: "DRAFT" }) status!: LogisticsDynamicScheduleVersionStatus
  @Column({ type: "varchar", length: 20, default: "SINGLE" }) mode!: LogisticsDynamicScheduleMode
  @Column({ type: "text", default: "" }) reason!: string
  @Column({ type: "uuid", nullable: true }) eventId!: string | null
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) affectedOrderIds!: string[]
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) affectedAircraftIds!: string[]
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) affectedRouteIds!: string[]
  @Column({ type: "bigint" }) effectiveSimulationTimeMs!: number
  @Column({ type: "jsonb" }) items!: LogisticsScheduleItemInput[]
  @Column({ type: "jsonb" }) checkResult!: LogisticsScheduleCheckResult
  @Column({ type: "varchar", length: 64, default: "" }) contentHash!: string
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) createdBy!: UserEntity
  @ManyToOne(() => UserEntity, { nullable: true, eager: true, onDelete: "RESTRICT" }) submittedBy!: UserEntity | null
  @Column({ type: "uuid", nullable: true }) correlationId!: string | null
  @Column({ type: "timestamptz", nullable: true }) submittedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
}

export const v3LogisticsRuntimeEntities = [
  LogisticsRuntimeReadinessEntity,
  LogisticsRuntimeSnapshotEntity,
  LogisticsDynamicScheduleVersionEntity
]
