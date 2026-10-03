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
  ShowAreaCheckResult,
  ShowAreaAnnotationInput,
  ShowAreaFeatureInput,
  ShowAreaFeatureType,
  ShowAreaPlanVersionStatus,
  V3HeightDatum
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"

export interface PolygonGeometry {
  type: "Polygon"
  coordinates: number[][][]
}

@Entity("show_area_plan_drafts")
export class ShowAreaPlanDraftEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  features!: ShowAreaFeatureInput[]

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  annotations!: ShowAreaAnnotationInput[]

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  updatedBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("show_area_plan_versions")
@Index(["project", "versionNo"], { unique: true })
export class ShowAreaPlanVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  project!: StudentProjectEntity

  @Column({ type: "integer" })
  versionNo!: number

  @Column({ type: "integer" })
  sourceDraftRevision!: number

  @Column({ type: "varchar", length: 30 })
  status!: ShowAreaPlanVersionStatus

  @Column({ type: "jsonb" })
  terrainSnapshot!: Record<string, unknown>

  @Column({ type: "jsonb" })
  checkResult!: ShowAreaCheckResult

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  annotations!: ShowAreaAnnotationInput[]

  @ManyToOne(() => FileAssetEntity, { nullable: true, eager: true, onDelete: "RESTRICT" })
  planningMapAsset!: FileAssetEntity | null

  @OneToMany(() => ShowAreaFeatureEntity, (feature) => feature.version)
  features!: ShowAreaFeatureEntity[]

  @Column({ type: "text", nullable: true })
  reviewComment!: string | null

  @Column({ type: "integer", nullable: true })
  reviewScore!: number | null

  @ManyToOne(() => UserEntity, { nullable: true, eager: true, onDelete: "RESTRICT" })
  reviewedBy!: UserEntity | null

  @Column({ type: "timestamptz", nullable: true })
  reviewedAt!: Date | null

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @CreateDateColumn()
  createdAt!: Date

  @Column({ type: "timestamptz", nullable: true })
  submittedAt!: Date | null
}

@Entity("show_area_features")
@Index(["version", "featureKey"], { unique: true })
@Index(["version", "type"])
export class ShowAreaFeatureEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => ShowAreaPlanVersionEntity, (version) => version.features, { nullable: false, onDelete: "CASCADE" })
  version!: ShowAreaPlanVersionEntity

  @Column({ type: "varchar", length: 80 })
  featureKey!: string

  @Column({ type: "varchar", length: 40 })
  type!: ShowAreaFeatureType

  @Column({ type: "varchar", length: 120 })
  label!: string

  @Column({ type: "geometry", spatialFeatureType: "Polygon", srid: 4326 })
  geometry!: PolygonGeometry

  @Column({ type: "varchar", length: 10, nullable: true })
  heightDatum!: V3HeightDatum | null

  @Column({ type: "double precision", nullable: true })
  minimumHeightMeters!: number | null

  @Column({ type: "double precision", nullable: true })
  maximumHeightMeters!: number | null

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  properties!: Record<string, string | number | boolean>

  @Column({ type: "integer" })
  sourceRevision!: number

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  updatedBy!: UserEntity
}

export const v3ShowProjectEntities = [
  ShowAreaPlanDraftEntity,
  ShowAreaPlanVersionEntity,
  ShowAreaFeatureEntity
]
