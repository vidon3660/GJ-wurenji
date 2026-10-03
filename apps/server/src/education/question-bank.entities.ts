import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm"
import type {
  QuestionAttemptStatus,
  QuestionBankStatus,
  QuestionDefinition,
  QuestionEvidence,
  QuestionJudgment,
  QuestionAnswer,
  SceneType
} from "@wurenji/shared"
import { UserEntity } from "../entities.js"
import { StudentProjectEntity } from "../v3/assignments/assignment.entities.js"

@Entity("question_banks")
export class QuestionBankEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 160 })
  title!: string

  @Column({ type: "varchar", length: 40, nullable: true })
  sceneType!: SceneType | null

  @Column({ type: "text" })
  summary!: string

  @Column({ type: "varchar", length: 20, default: "DRAFT" })
  status!: QuestionBankStatus

  @Column({ type: "integer", default: 0 })
  currentVersion!: number

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @OneToMany(() => QuestionBankVersionEntity, (version) => version.bank)
  versions!: QuestionBankVersionEntity[]

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("question_bank_versions")
@Index(["bank", "version"], { unique: true })
export class QuestionBankVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => QuestionBankEntity, (bank) => bank.versions, { nullable: false, eager: true, onDelete: "CASCADE" })
  bank!: QuestionBankEntity

  @Column({ type: "integer" })
  version!: number

  @Column({ type: "varchar", length: 20, default: "DRAFT" })
  status!: QuestionBankStatus

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  questions!: QuestionDefinition[]

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @Column({ type: "text", nullable: true })
  changeNote!: string | null

  @Column({ type: "timestamptz", nullable: true })
  publishedAt!: Date | null

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("question_attempts")
@Index(["project", "bankVersion"], { unique: true })
export class QuestionAttemptEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity

  @ManyToOne(() => QuestionBankVersionEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  bankVersion!: QuestionBankVersionEntity

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  student!: UserEntity

  @Column({ type: "varchar", length: 20, default: "IN_PROGRESS" })
  status!: QuestionAttemptStatus

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "double precision", default: 0 })
  autoScore!: number

  @Column({ type: "double precision", nullable: true })
  teacherScore!: number | null

  @Column({ type: "double precision", default: 0 })
  maxScore!: number

  @Column({ type: "timestamptz", nullable: true })
  submittedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  reviewedAt!: Date | null

  @ManyToOne(() => UserEntity, { nullable: true, eager: true, onDelete: "SET NULL" })
  reviewedBy!: UserEntity | null

  @Column({ type: "text", default: "" })
  reviewComment!: string

  @OneToMany(() => QuestionResponseEntity, (response) => response.attempt)
  responses!: QuestionResponseEntity[]

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("question_responses")
@Index(["attempt", "questionCode"], { unique: true })
export class QuestionResponseEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => QuestionAttemptEntity, (attempt) => attempt.responses, { nullable: false, onDelete: "CASCADE" })
  attempt!: QuestionAttemptEntity

  @Column({ type: "varchar", length: 80 })
  questionCode!: string

  @Column({ type: "jsonb", nullable: true })
  answer!: QuestionAnswer

  @Column({ type: "double precision", nullable: true })
  autoScore!: number | null

  @Column({ type: "double precision" })
  maxScore!: number

  @Column({ type: "varchar", length: 20, default: "UNANSWERED" })
  judgment!: QuestionJudgment

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  evidence!: QuestionEvidence[]

  @Column({ type: "double precision", nullable: true })
  teacherScore!: number | null

  @Column({ type: "text", default: "" })
  teacherComment!: string

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

export const questionBankEntities = [
  QuestionBankEntity,
  QuestionBankVersionEntity,
  QuestionAttemptEntity,
  QuestionResponseEntity
]

