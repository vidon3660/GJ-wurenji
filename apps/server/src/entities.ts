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
  MissionPlan,
  PracticeScene,
  RunStatus,
  SceneType,
  SimulationSummary,
  UserRole
} from "@wurenji/shared"

@Entity("users")
export class UserEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Index({ unique: true })
  @Column({ type: "varchar", length: 200 })
  email!: string

  @Column({ type: "varchar", length: 120 })
  displayName!: string

  @Column({ type: "varchar", length: 20 })
  role!: UserRole

  @Column({ type: "varchar", length: 200 })
  passwordHash!: string

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("practices")
export class PracticeEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 160 })
  title!: string

  @Column({ type: "varchar", length: 40 })
  type!: SceneType

  @Column({ type: "varchar", length: 20, default: "DRAFT" })
  status!: "DRAFT" | "PUBLISHED"

  @Column({ type: "jsonb" })
  sceneDraft!: PracticeScene

  @Column({ type: "jsonb", nullable: true })
  publishedScene!: PracticeScene | null

  @Column({ type: "integer", default: 0 })
  sceneVersion!: number

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  createdBy!: UserEntity

  @OneToMany(() => SolutionEntity, (solution) => solution.practice)
  solutions!: SolutionEntity[]

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("solutions")
@Index(["practice", "student"], { unique: true })
export class SolutionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => PracticeEntity, (practice) => practice.solutions, { nullable: false, onDelete: "CASCADE" })
  practice!: PracticeEntity

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  student!: UserEntity

  @Column({ type: "jsonb" })
  draft!: MissionPlan

  @Column({ type: "integer", default: 1 })
  revision!: number

  @OneToMany(() => SolutionVersionEntity, (version) => version.solution)
  versions!: SolutionVersionEntity[]

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("solution_versions")
export class SolutionVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => SolutionEntity, (solution) => solution.versions, { nullable: false, onDelete: "CASCADE" })
  solution!: SolutionEntity

  @Column({ type: "integer" })
  version!: number

  @Column({ type: "jsonb" })
  snapshot!: MissionPlan

  @Column({ type: "jsonb" })
  sceneSnapshot!: PracticeScene

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("simulation_runs")
export class SimulationRunEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => SolutionVersionEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  solutionVersion!: SolutionVersionEntity

  @Column({ type: "varchar", length: 20, default: "QUEUED" })
  status!: RunStatus

  @Column({ type: "integer", default: 0 })
  progress!: number

  @Column({ type: "jsonb", nullable: true })
  summary!: SimulationSummary | null

  @Column({ type: "varchar", length: 500, nullable: true })
  resultPath!: string | null

  @Column({ type: "text", nullable: true })
  errorMessage!: string | null

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("submissions")
@Index(["practice", "student"], { unique: true })
export class SubmissionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => PracticeEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  practice!: PracticeEntity

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  student!: UserEntity

  @ManyToOne(() => SolutionVersionEntity, { nullable: false, eager: true })
  solutionVersion!: SolutionVersionEntity

  @ManyToOne(() => SimulationRunEntity, { nullable: false, eager: true })
  simulationRun!: SimulationRunEntity

  @CreateDateColumn()
  submittedAt!: Date
}

export const entities = [
  UserEntity,
  PracticeEntity,
  SolutionEntity,
  SolutionVersionEntity,
  SimulationRunEntity,
  SubmissionEntity
]
