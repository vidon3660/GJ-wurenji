import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm"
import type { EvaluationMetricResult, GradeDimensionResult, GradeStatus } from "@wurenji/shared"
import { PracticeEntity, SubmissionEntity, UserEntity } from "../entities.js"
import { TeachingAssignmentEntity } from "../education/education.entities.js"

@Entity("grades")
@Index(["submission"], { unique: true })
export class GradeEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => SubmissionEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  submission!: SubmissionEntity

  @ManyToOne(() => PracticeEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  practice!: PracticeEntity

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  student!: UserEntity

  @ManyToOne(() => TeachingAssignmentEntity, { nullable: true, eager: true, onDelete: "SET NULL" })
  assignment!: TeachingAssignmentEntity | null

  @Column({ type: "varchar", length: 20, default: "AUTO" })
  status!: GradeStatus

  @Column({ type: "double precision" })
  autoScore!: number

  @Column({ type: "double precision" })
  totalScore!: number

  @Column({ type: "boolean" })
  passed!: boolean

  @Column({ type: "boolean" })
  hardConstraintsPassed!: boolean

  @Column({ type: "double precision", default: 0 })
  teacherAdjustment!: number

  @Column({ type: "text", nullable: true })
  teacherFeedback!: string | null

  @Column({ type: "jsonb" })
  dimensions!: GradeDimensionResult[]

  @Column({ type: "jsonb" })
  metrics!: EvaluationMetricResult[]

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "boolean", default: false })
  resultFileReady!: boolean

  @Column({ type: "timestamptz", nullable: true })
  publishedAt!: Date | null

  @CreateDateColumn()
  evaluatedAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("result_files")
@Index(["grade", "revision"], { unique: true })
export class ResultFileEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => GradeEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  grade!: GradeEntity

  @Column({ type: "integer" })
  revision!: number

  @Column({ type: "varchar", length: 500 })
  storagePath!: string

  @Column({ type: "varchar", length: 64 })
  sha256!: string

  @Column({ type: "varchar", length: 100, default: "application/pdf" })
  mimeType!: string

  @Column({ type: "integer" })
  size!: number

  @Column({ type: "boolean", default: true })
  active!: boolean

  @CreateDateColumn()
  createdAt!: Date
}

export const logisticsEntities = [GradeEntity, ResultFileEntity]
