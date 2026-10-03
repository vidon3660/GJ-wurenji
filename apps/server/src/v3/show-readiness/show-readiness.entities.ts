import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm"
import type { ShowPreflightItemView, ShowTakeoffDecision } from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"

@Entity("show_preflight_records")
export class ShowPreflightRecordEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity
  @Column({ type: "varchar", length: 20, default: "DRAFT" }) status!: "DRAFT" | "COMPLETED"
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) items!: ShowPreflightItemView[]
  @Column({ type: "varchar", length: 40, nullable: true }) decision!: ShowTakeoffDecision | null
  @Column({ type: "text", default: "" }) rationale!: string
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) updatedBy!: UserEntity
  @Column({ type: "timestamptz", nullable: true }) completedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

@Entity("show_simulation_clocks")
@Index(["project"], { unique: true })
export class ShowSimulationClockEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity
  @Column({ type: "varchar", length: 20, default: "RUNNING" }) status!: "RUNNING" | "PAUSED"
  @Column({ type: "bigint", default: 0 }) originSimulationTimeMs!: number
  @Column({ type: "timestamptz" }) originRealTime!: Date
  @Column({ type: "double precision", default: 60 }) rate!: number
  @Column({ type: "bigint" }) plannedTakeoffSimulationTimeMs!: number
  @Column({ type: "bigint" }) thresholdSimulationTimeMs!: number
  @Column({ type: "bigint" }) plannedEndSimulationTimeMs!: number
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "timestamptz", nullable: true }) submittedAt!: Date | null
  @ManyToOne(() => UserEntity, { nullable: true, eager: true, onDelete: "RESTRICT" }) submittedBy!: UserEntity | null
  @Column({ type: "jsonb", nullable: true }) submissionSnapshot!: Record<string, unknown> | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

export const v3ShowReadinessEntities = [ShowPreflightRecordEntity, ShowSimulationClockEntity]
