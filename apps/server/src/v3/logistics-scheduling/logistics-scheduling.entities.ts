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
  LogisticsAircraftAvailabilityStatus,
  LogisticsOrderGenerationConfig,
  LogisticsScheduleCheckResult,
  LogisticsScheduleItemInput,
  LogisticsScheduleVersionStatus,
  LogisticsSchedulingOrderPriority,
  LogisticsSchedulingOrderStatus
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { LogisticsRouteEntity } from "../logistics-route/logistics-route.entities.js"

@Entity("logistics_order_batches")
export class LogisticsOrderBatchEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity

  @Column({ type: "varchar", length: 40 })
  generatorVersion!: string

  @Column({ type: "varchar", length: 120 })
  seed!: string

  @Column({ type: "varchar", length: 64 })
  checksum!: string

  @Column({ type: "jsonb" })
  config!: LogisticsOrderGenerationConfig

  @OneToMany(() => LogisticsOrderEntity, (order) => order.batch)
  orders!: LogisticsOrderEntity[]

  @CreateDateColumn()
  createdAt!: Date
}

@Entity("logistics_orders")
@Index(["batch", "code"], { unique: true })
export class LogisticsOrderEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => LogisticsOrderBatchEntity, (batch) => batch.orders, { nullable: false, onDelete: "CASCADE" })
  batch!: LogisticsOrderBatchEntity

  @Column({ type: "varchar", length: 20 })
  code!: string

  @Column({ type: "varchar", length: 120 })
  destinationNodeId!: string

  @Column({ type: "integer" })
  releaseTimeMs!: number

  @Column({ type: "varchar", length: 20 })
  priority!: LogisticsSchedulingOrderPriority

  @Column({ type: "integer" })
  earliestStartTimeMs!: number

  @Column({ type: "integer" })
  latestArrivalTimeMs!: number

  @Column({ type: "varchar", length: 20, default: "UNASSIGNED" })
  status!: LogisticsSchedulingOrderStatus
}

@Entity("logistics_aircraft_instances")
@Index(["project", "code"], { unique: true })
export class LogisticsAircraftInstanceEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity

  @Column({ type: "varchar", length: 30 })
  code!: string

  @Column({ type: "varchar", length: 60 })
  modelCode!: string

  @Column({ type: "double precision" })
  initialBatteryPercent!: number

  @Column({ type: "integer", default: 0 })
  availableAtMs!: number

  @Column({ type: "varchar", length: 20, default: "READY" })
  status!: LogisticsAircraftAvailabilityStatus
}

@Entity("logistics_schedule_drafts")
export class LogisticsScheduleDraftEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  items!: LogisticsScheduleItemInput[]

  @Column({ type: "jsonb", nullable: true })
  lastCheckResult!: LogisticsScheduleCheckResult | null

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  updatedBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("logistics_schedule_versions")
@Index(["project", "versionNo"], { unique: true })
export class LogisticsScheduleVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity

  @Column({ type: "integer" })
  versionNo!: number

  @Column({ type: "integer" })
  sourceDraftRevision!: number

  @Column({ type: "varchar", length: 20 })
  status!: LogisticsScheduleVersionStatus

  @Column({ type: "jsonb" })
  checkResult!: LogisticsScheduleCheckResult

  @OneToMany(() => LogisticsDispatchItemEntity, (item) => item.version)
  items!: LogisticsDispatchItemEntity[]

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @Column({ type: "timestamptz", nullable: true })
  submittedAt!: Date | null
}

@Entity("logistics_dispatch_items")
@Index(["version", "sequence"], { unique: true })
@Index(["version", "itemKey"], { unique: true })
@Index(["version", "order"], { unique: true })
export class LogisticsDispatchItemEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => LogisticsScheduleVersionEntity, (version) => version.items, { nullable: false, onDelete: "CASCADE" })
  version!: LogisticsScheduleVersionEntity

  @Column({ type: "integer" })
  sequence!: number

  @Column({ type: "varchar", length: 80 })
  itemKey!: string

  @ManyToOne(() => LogisticsOrderEntity, { nullable: false, eager: true, onDelete: "NO ACTION" })
  order!: LogisticsOrderEntity

  @ManyToOne(() => LogisticsAircraftInstanceEntity, { nullable: false, eager: true, onDelete: "NO ACTION" })
  aircraft!: LogisticsAircraftInstanceEntity

  @ManyToOne(() => LogisticsRouteEntity, { nullable: false, eager: true, onDelete: "NO ACTION" })
  outboundRoute!: LogisticsRouteEntity

  @ManyToOne(() => LogisticsRouteEntity, { nullable: false, eager: true, onDelete: "NO ACTION" })
  returnRoute!: LogisticsRouteEntity

  @Column({ type: "integer" })
  plannedTakeoffTimeMs!: number

  @Column({ type: "integer" })
  arrivalTimeMs!: number

  @Column({ type: "integer" })
  returnStartTimeMs!: number

  @Column({ type: "integer" })
  landingTimeMs!: number

  @Column({ type: "integer" })
  nextAvailableTimeMs!: number

  @Column({ type: "double precision" })
  batteryAfterMissionPercent!: number
}

export const v3LogisticsSchedulingEntities = [
  LogisticsOrderBatchEntity,
  LogisticsOrderEntity,
  LogisticsAircraftInstanceEntity,
  LogisticsScheduleDraftEntity,
  LogisticsScheduleVersionEntity,
  LogisticsDispatchItemEntity
]
