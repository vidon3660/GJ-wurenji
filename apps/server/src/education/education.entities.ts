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
  EvaluationDimension,
  ExerciseDifficulty,
  LeaderboardDisplayMode,
  PracticeScene,
  ReferenceAnswerSummary,
  SceneType
} from "@wurenji/shared"
import { PracticeEntity, UserEntity } from "../entities.js"

@Entity("courses")
export class CourseEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Index({ unique: true })
  @Column({ type: "varchar", length: 60 })
  code!: string

  @Column({ type: "varchar", length: 160 })
  name!: string

  @Column({ type: "varchar", length: 80 })
  term!: string

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  createdBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("course_classes")
@Index(["course", "code"], { unique: true })
export class ClassroomEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 60 })
  code!: string

  @Column({ type: "varchar", length: 160 })
  name!: string

  @ManyToOne(() => CourseEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  course!: CourseEntity

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  createdBy!: UserEntity

  @OneToMany(() => ClassMemberEntity, (member) => member.classroom)
  members!: ClassMemberEntity[]

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("class_members")
@Index(["classroom", "student"], { unique: true })
export class ClassMemberEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => ClassroomEntity, (classroom) => classroom.members, { nullable: false, eager: true, onDelete: "CASCADE" })
  classroom!: ClassroomEntity

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  student!: UserEntity

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("onboarding_states")
@Index(["user", "guideKey", "version"], { unique: true })
export class OnboardingStateEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => UserEntity, { nullable: false, onDelete: "CASCADE" })
  user!: UserEntity

  @Column({ type: "varchar", length: 80 })
  guideKey!: string

  @Column({ type: "integer" })
  version!: number

  @Column({ type: "boolean", default: false })
  skipped!: boolean

  @CreateDateColumn()
  completedAt!: Date
}

@Entity("exercise_templates")
export class ExerciseTemplateEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 160 })
  title!: string

  @Column({ type: "varchar", length: 40 })
  type!: SceneType

  @Column({ type: "varchar", length: 30 })
  difficulty!: ExerciseDifficulty

  @Column({ type: "text" })
  summary!: string

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  tags!: string[]

  @Column({ type: "varchar", length: 20, default: "DRAFT" })
  status!: "DRAFT" | "PUBLISHED"

  @Column({ type: "integer", default: 1 })
  currentVersion!: number

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  createdBy!: UserEntity

  @OneToMany(() => ExerciseVersionEntity, (version) => version.template)
  versions!: ExerciseVersionEntity[]

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("exercise_versions")
@Index(["template", "version"], { unique: true })
export class ExerciseVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => ExerciseTemplateEntity, (template) => template.versions, { nullable: false, eager: true, onDelete: "CASCADE" })
  template!: ExerciseTemplateEntity

  @Column({ type: "integer" })
  version!: number

  @Column({ type: "text" })
  taskBrief!: string

  @Column({ type: "jsonb" })
  sceneSnapshot!: PracticeScene

  @Column({ type: "jsonb" })
  referenceAnswer!: ReferenceAnswerSummary

  @Column({ type: "jsonb" })
  evaluationScheme!: EvaluationDimension[]

  @Column({ type: "timestamptz", nullable: true })
  publishedAt!: Date | null

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("teaching_assignments")
@Index(["classroom", "practice"], { unique: true })
export class TeachingAssignmentEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 160 })
  title!: string

  @ManyToOne(() => ClassroomEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  classroom!: ClassroomEntity

  @ManyToOne(() => PracticeEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  practice!: PracticeEntity

  @ManyToOne(() => ExerciseVersionEntity, { nullable: true, eager: true, onDelete: "SET NULL" })
  exerciseVersion!: ExerciseVersionEntity | null

  @Column({ type: "varchar", length: 20, default: "PUBLISHED" })
  status!: "PUBLISHED" | "CLOSED"

  @Column({ type: "timestamptz" })
  availableAt!: Date

  @Column({ type: "timestamptz" })
  dueAt!: Date

  @Column({ type: "boolean", default: false })
  leaderboardEnabled!: boolean

  @Column({ type: "integer", default: 10 })
  leaderboardDisplayLimit!: number

  @Column({ type: "varchar", length: 20, default: "ANONYMIZED" })
  leaderboardDisplayMode!: LeaderboardDisplayMode

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  createdBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

export const educationEntities = [
  CourseEntity,
  ClassroomEntity,
  ClassMemberEntity,
  OnboardingStateEntity,
  ExerciseTemplateEntity,
  ExerciseVersionEntity,
  TeachingAssignmentEntity
]
