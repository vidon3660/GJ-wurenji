import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm"
import type { ShowRuntimeGroupView, ShowRuntimePhase, ShowRuntimeTotalsView } from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"

@Entity("show_runtime_group_snapshots")
@Index(["sessionId", "sequence"], { unique: true })
@Index(["projectId", "simulationTimeMs"])
export class ShowRuntimeGroupSnapshotEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "uuid" }) sessionId!: string
  @Column({ type: "integer" }) sequence!: number
  @Column({ type: "bigint" }) simulationTimeMs!: number
  @Column({ type: "varchar", length: 40 }) phase!: ShowRuntimePhase
  @Column({ type: "varchar", length: 40 }) reason!: "START" | "PHASE" | "EVENT" | "ACTION" | "COMPLETE" | "ABORT"
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) checkpoint!: Record<string, unknown>
  @Column({ type: "jsonb" }) totals!: ShowRuntimeTotalsView
  @Column({ type: "jsonb" }) groups!: ShowRuntimeGroupView[]
  @CreateDateColumn() createdAt!: Date
}

@Entity("show_operational_reports")
@Index(["sessionId", "reportType"], { unique: true })
export class ShowOperationalReportEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity
  @Column({ type: "uuid" }) sessionId!: string
  @Column({ type: "varchar", length: 30 }) reportType!: "TAKEOFF" | "FLIGHT_END"
  @Column({ type: "varchar", length: 20, default: "DRAFT" }) status!: "DRAFT" | "SUBMITTED"
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) snapshot!: Record<string, unknown>
  @ManyToOne(() => UserEntity, { nullable: true, eager: true, onDelete: "RESTRICT" }) submittedBy!: UserEntity | null
  @Column({ type: "timestamptz", nullable: true }) submittedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

export const v3ShowRuntimeEntities = [ShowRuntimeGroupSnapshotEntity, ShowOperationalReportEntity]
