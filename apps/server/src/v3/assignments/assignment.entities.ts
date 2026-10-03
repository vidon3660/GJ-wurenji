import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm"
import type {
  AssignmentDraftConfig,
  AssignmentDraftStatus,
  AssignmentTargetType,
  LearningMode,
  SceneType,
  StageStatus,
  StudentProjectStatus,
  V3ResourceReference,
  V3StageCode
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { ClassroomEntity, ExerciseVersionEntity } from "../../education/education.entities.js"
import { TeacherAlertFollowUpEntity } from "./teacher-alert-follow-up.entity.js"

@Entity("assignment_drafts")
export class AssignmentDraftEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 160 })
  title!: string

  @Column({ type: "varchar", length: 40 })
  sceneType!: SceneType

  @Column({ type: "varchar", length: 20 })
  mode!: LearningMode

  @Column({ type: "varchar", length: 20, default: "DRAFT" })
  status!: AssignmentDraftStatus

  @Column({ type: "boolean", default: false })
  isDemo!: boolean

  @Column({ type: "boolean", default: false })
  isAcceptanceData!: boolean

  @Column({ type: "jsonb" })
  config!: AssignmentDraftConfig

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "varchar", length: 64, nullable: true })
  configHash!: string | null

  @Column({ type: "timestamptz", nullable: true })
  endedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  archivedAt!: Date | null

  @Column({ type: "text", nullable: true })
  lifecycleReason!: string | null

  @ManyToOne(() => ExerciseVersionEntity, { nullable: true, eager: true, onDelete: "SET NULL" })
  sourceExerciseVersion!: ExerciseVersionEntity | null

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  createdBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("assignment_snapshots")
export class AssignmentSnapshotEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @OneToOne(() => AssignmentDraftEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  @JoinColumn()
  draft!: AssignmentDraftEntity

  @Column({ type: "integer", default: 3 })
  schemaVersion!: 3

  @Column({ type: "varchar", length: 160 })
  title!: string

  @Column({ type: "varchar", length: 40 })
  sceneType!: SceneType

  @Column({ type: "varchar", length: 20 })
  mode!: LearningMode

  @Column({ type: "boolean", default: false })
  isDemo!: boolean

  @Column({ type: "boolean", default: false })
  isAcceptanceData!: boolean

  @Column({ type: "jsonb" })
  config!: AssignmentDraftConfig

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  resourceRefs!: V3ResourceReference[]

  @Column({ type: "integer", default: 1 })
  resourceRevision!: number

  @Column({ type: "varchar", length: 220, default: "UNRESOLVED" })
  mapResourceVersion!: string

  @Column({ type: "varchar", length: 220, default: "UNRESOLVED" })
  sceneResourceVersion!: string

  @Column({ type: "varchar", length: 220, default: "UNRESOLVED" })
  planVersion!: string

  @Index({ unique: true })
  @Column({ type: "varchar", length: 64 })
  checksum!: string

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  publishedBy!: UserEntity

  @CreateDateColumn()
  publishedAt!: Date
}

@Entity("assignment_snapshot_resource_revisions")
@Index(["snapshot", "revision"], { unique: true })
export class AssignmentSnapshotResourceRevisionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => AssignmentSnapshotEntity, { nullable: false, onDelete: "CASCADE" })
  snapshot!: AssignmentSnapshotEntity

  @Column({ type: "integer" })
  revision!: number

  @Column({ type: "jsonb" })
  config!: AssignmentDraftConfig

  @Column({ type: "jsonb" })
  resourceRefs!: V3ResourceReference[]

  @Column({ type: "varchar", length: 64 })
  checksum!: string

  @Column({ type: "text", nullable: true })
  reason!: string | null

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  changedBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("assignment_targets")
export class AssignmentTargetEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => AssignmentSnapshotEntity, { nullable: false, onDelete: "CASCADE" })
  snapshot!: AssignmentSnapshotEntity

  @Column({ type: "varchar", length: 20 })
  targetType!: AssignmentTargetType

  @ManyToOne(() => ClassroomEntity, { nullable: true, eager: true, onDelete: "RESTRICT" })
  classroom!: ClassroomEntity | null

  @ManyToOne(() => UserEntity, { nullable: true, eager: true, onDelete: "RESTRICT" })
  student!: UserEntity | null

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("student_projects")
@Index("IDX_student_projects_snapshot_student_attempt", ["snapshot", "student", "attemptNumber"], { unique: true })
export class StudentProjectEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => AssignmentSnapshotEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  snapshot!: AssignmentSnapshotEntity

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  student!: UserEntity

  @Column({ type: "integer", default: 1 })
  attemptNumber!: number

  @Index("IDX_student_projects_retake_of")
  @Column({ type: "uuid", nullable: true })
  retakeOfProjectId!: string | null

  @Column({ type: "text", nullable: true })
  retakeReason!: string | null

  @Column({ type: "uuid", nullable: true })
  retakeCreatedById!: string | null

  @Column({ type: "timestamptz", nullable: true })
  retakeCreatedAt!: Date | null

  @Column({ type: "varchar", length: 20, default: "NOT_STARTED" })
  status!: StudentProjectStatus

  @Column({ type: "varchar", length: 60 })
  currentStageCode!: V3StageCode

  @OneToMany(() => StudentProjectStageEntity, (stage) => stage.project)
  stages!: StudentProjectStageEntity[]

  @Column({ type: "timestamptz", nullable: true })
  assessmentStartedAt!: Date | null

  @Index()
  @Column({ type: "timestamptz", nullable: true })
  assessmentDeadlineAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  assessmentSubmittedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  assessmentEndedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  assessmentAvailableAtOverride!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  assessmentDueAtOverride!: Date | null

  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  lastActivityAt!: Date

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("student_project_stages")
@Index(["project", "stageCode"], { unique: true })
@Index(["project", "sequence"], { unique: true })
export class StudentProjectStageEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => StudentProjectEntity, (project) => project.stages, { nullable: false, onDelete: "CASCADE" })
  project!: StudentProjectEntity

  @Column({ type: "varchar", length: 60 })
  stageCode!: V3StageCode

  @Column({ type: "integer" })
  sequence!: number

  @Column({ type: "varchar", length: 20 })
  status!: StageStatus

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "timestamptz", nullable: true })
  submittedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  acceptedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  returnedAt!: Date | null

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("project_activity_counters")
export class ProjectActivityCounterEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @OneToOne(() => StudentProjectEntity, { nullable: false, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity

  @Column({ type: "integer", default: 0 })
  savedVersionCount!: number

  @Column({ type: "integer", default: 0 })
  validationCount!: number

  @Column({ type: "integer", default: 0 })
  runtimeCount!: number

  @Column({ type: "integer", default: 0 })
  actionCount!: number

  @Column({ type: "integer", default: 0 })
  submissionCount!: number

  @Column({ type: "integer", default: 0 })
  resubmissionCount!: number

  @UpdateDateColumn()
  updatedAt!: Date
}

export const v3AssignmentEntities = [
  AssignmentDraftEntity,
  AssignmentSnapshotEntity,
  AssignmentSnapshotResourceRevisionEntity,
  AssignmentTargetEntity,
  StudentProjectEntity,
  StudentProjectStageEntity,
  ProjectActivityCounterEntity,
  TeacherAlertFollowUpEntity
]
