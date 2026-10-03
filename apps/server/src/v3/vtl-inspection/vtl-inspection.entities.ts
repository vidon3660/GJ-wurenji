import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm"
import type {
  VtlAircraftParameters,
  VtlAllocationPlanView,
  VtlExecutionPlanView,
  VtlLandingSiteView,
  VtlPlanCheckResultView,
  VtlRoutePlanView,
  VtlTaskObjectView
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"

@Entity("vtl_project_plans")
@Index(["project"], { unique: true })
export class VtlProjectPlanEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "timestamptz", nullable: true }) areaConfirmedAt!: Date | null
  @Column({ type: "jsonb" }) taskObjects!: VtlTaskObjectView[]
  @Column({ type: "jsonb" }) landingSites!: VtlLandingSiteView[]
  @Column({ type: "jsonb" }) aircraftParameters!: VtlAircraftParameters
  @Column({ type: "jsonb" }) allocation!: VtlAllocationPlanView
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) routes!: VtlRoutePlanView[]
  @Column({ type: "jsonb", nullable: true }) checkResult!: VtlPlanCheckResultView | null
  @Column({ type: "jsonb", nullable: true }) executionPlan!: VtlExecutionPlanView | null
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) updatedBy!: UserEntity
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

export const v3VtlInspectionEntities = [VtlProjectPlanEntity]
