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
  LogisticsMapAnnotationInput,
  LogisticsRegionAnalysisStatus,
  LogisticsRouteCheckResult,
  LogisticsRouteDirection,
  LogisticsRouteInput,
  LogisticsRouteMode,
  LogisticsRouteRole,
  LogisticsRouteValidationResult,
  LogisticsRouteValidationStatus,
  LogisticsRouteVersionStatus
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"

@Entity("logistics_region_analyses")
export class LogisticsRegionAnalysisEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "varchar", length: 20, default: "DRAFT" })
  status!: LogisticsRegionAnalysisStatus

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  selectedDeliveryPointIds!: string[]

  @Column({ type: "text", default: "" })
  notes!: string

  @Column({ type: "timestamptz", nullable: true })
  submittedAt!: Date | null

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  updatedBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("logistics_route_plan_drafts")
export class LogisticsRoutePlanDraftEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  routes!: LogisticsRouteInput[]

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  annotations!: LogisticsMapAnnotationInput[]

  @Column({ type: "jsonb", nullable: true })
  lastCheckResult!: LogisticsRouteCheckResult | null

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  updatedBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("logistics_route_plan_versions")
@Index(["project", "versionNo"], { unique: true })
export class LogisticsRoutePlanVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity

  @Column({ type: "integer" })
  versionNo!: number

  @Column({ type: "integer" })
  sourceDraftRevision!: number

  @Column({ type: "varchar", length: 20 })
  status!: LogisticsRouteVersionStatus

  @Column({ type: "jsonb" })
  checkResult!: LogisticsRouteCheckResult

  @Column({ type: "jsonb", nullable: true })
  validationResult!: LogisticsRouteValidationResult | null

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  annotations!: LogisticsMapAnnotationInput[]

  @OneToMany(() => LogisticsRouteEntity, (route) => route.version)
  routes!: LogisticsRouteEntity[]

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @Column({ type: "timestamptz", nullable: true })
  validatedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  submittedAt!: Date | null
}

@Entity("logistics_routes")
@Index(["version", "routeKey"], { unique: true })
export class LogisticsRouteEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => LogisticsRoutePlanVersionEntity, (version) => version.routes, { nullable: false, onDelete: "CASCADE" })
  version!: LogisticsRoutePlanVersionEntity

  @Column({ type: "varchar", length: 80 })
  routeKey!: string

  @Column({ type: "varchar", length: 120 })
  name!: string

  @Column({ type: "varchar", length: 24, default: "FIXED_ROUND_TRIP" })
  mode!: LogisticsRouteMode

  @Column({ type: "varchar", length: 120 })
  destinationNodeId!: string

  @Column({ type: "varchar", length: 20 })
  direction!: LogisticsRouteDirection

  @Column({ type: "varchar", length: 20 })
  role!: LogisticsRouteRole

  @Column({ type: "varchar", length: 60 })
  groupCode!: string

  @Column({ type: "varchar", length: 120 })
  departureNodeId!: string

  @Column({ type: "varchar", length: 120 })
  arrivalNodeId!: string

  @Column({ type: "double precision" })
  protectionRadiusMeters!: number

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  waitingNodeIds!: string[]

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  alternateLandingNodeIds!: string[]

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  emergencyAreaNodeIds!: string[]

  @Column({ type: "double precision" })
  entryDirectionDegrees!: number

  @Column({ type: "double precision" })
  exitDirectionDegrees!: number

  @OneToMany(() => LogisticsWaypointEntity, (waypoint) => waypoint.route)
  waypoints!: LogisticsWaypointEntity[]
}

@Entity("logistics_waypoints")
@Index(["route", "sequence"], { unique: true })
@Index(["route", "waypointKey"], { unique: true })
export class LogisticsWaypointEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => LogisticsRouteEntity, (route) => route.waypoints, { nullable: false, onDelete: "CASCADE" })
  route!: LogisticsRouteEntity

  @Column({ type: "integer" })
  sequence!: number

  @Column({ type: "varchar", length: 80 })
  waypointKey!: string

  @Column({ type: "varchar", length: 120 })
  name!: string

  @Column({ type: "double precision" })
  longitude!: number

  @Column({ type: "double precision" })
  latitude!: number

  @Column({ type: "double precision", default: 0 })
  altitudeMeters!: number

  @Column({ type: "double precision", default: 40 })
  segmentAltitudeMeters!: number

  @Column({ type: "double precision", default: 12 })
  speedMps!: number

  @Column({ type: "varchar", length: 120, nullable: true })
  nodeId!: string | null

  @Column({ type: "boolean", default: false })
  locked!: boolean
}

@Entity("logistics_route_validation_runs")
@Index(["project", "attemptNo"], { unique: true })
export class LogisticsRouteValidationRunEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity

  @ManyToOne(() => LogisticsRoutePlanVersionEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  version!: LogisticsRoutePlanVersionEntity

  @Column({ type: "integer" })
  attemptNo!: number

  @Column({ type: "varchar", length: 20 })
  status!: LogisticsRouteValidationStatus

  @Column({ type: "varchar", length: 120 })
  seed!: string

  @Column({ type: "jsonb" })
  result!: LogisticsRouteValidationResult

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date
}

export const v3LogisticsRouteEntities = [
  LogisticsRegionAnalysisEntity,
  LogisticsRoutePlanDraftEntity,
  LogisticsRoutePlanVersionEntity,
  LogisticsRouteEntity,
  LogisticsWaypointEntity,
  LogisticsRouteValidationRunEntity
]
