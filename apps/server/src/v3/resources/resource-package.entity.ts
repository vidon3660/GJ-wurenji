import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from "typeorm"
import type {
  ResourcePackageStatus,
  ResourcePackageType,
  V3ResourceArchiveManifest,
  V3ResourcePackageSource,
  V3ResourceValidationCheck
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"

@Entity("resource_packages")
@Index(["packageType", "name", "version"], { unique: true })
@Index("uq_resource_packages_active_name", ["packageType", "name"], { unique: true, where: "status = 'ACTIVE'" })
export class ResourcePackageEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 40 })
  packageType!: ResourcePackageType

  @Column({ type: "varchar", length: 120 })
  name!: string

  @Column({ type: "varchar", length: 40 })
  version!: string

  @Column({ type: "integer", default: 1 })
  schemaVersion!: number

  @Column({ type: "varchar", length: 40, default: "0.1.0" })
  minimumPlatformVersion!: string

  @Column({ type: "varchar", length: 64 })
  sha256!: string

  @Column({ type: "varchar", length: 20, default: "STAGED" })
  status!: ResourcePackageStatus

  @Column({ type: "varchar", length: 30, default: "BUILT_IN" })
  source!: V3ResourcePackageSource

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  manifest!: Record<string, unknown>

  @Column({ type: "jsonb", nullable: true })
  archiveManifest!: V3ResourceArchiveManifest | null

  @ManyToOne(() => FileAssetEntity, { nullable: true, eager: true, onDelete: "RESTRICT" })
  archiveAsset!: FileAssetEntity | null

  @Column({ type: "varchar", length: 120, nullable: true })
  signatureKeyId!: string | null

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  validationChecks!: V3ResourceValidationCheck[]

  @Column({ type: "timestamptz", nullable: true })
  validatedAt!: Date | null

  @Column({ type: "text", nullable: true })
  rejectionReason!: string | null

  @ManyToOne(() => UserEntity, { nullable: false, eager: true })
  createdBy!: UserEntity

  @Column({ type: "timestamptz", nullable: true })
  activatedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  retiredAt!: Date | null

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("resource_package_validation_runs")
@Index(["packageId", "createdAt"])
export class ResourcePackageValidationRunEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) packageId!: string
  @Column({ type: "varchar", length: 20 }) status!: "PASSED" | "FAILED"
  @Column({ type: "varchar", length: 64 }) archiveSha256!: string
  @Column({ type: "varchar", length: 120, nullable: true }) signatureKeyId!: string | null
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) checks!: V3ResourceValidationCheck[]
  @Column({ type: "text", nullable: true }) errorMessage!: string | null
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) actor!: UserEntity
  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" }) completedAt!: Date
  @CreateDateColumn() createdAt!: Date
}

@Entity("resource_package_lifecycle_events")
@Index(["packageId", "createdAt"])
@Index(["packageType", "name", "createdAt"])
export class ResourcePackageLifecycleEventEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) packageId!: string
  @Column({ type: "varchar", length: 40 }) packageType!: ResourcePackageType
  @Column({ type: "varchar", length: 120 }) name!: string
  @Column({ type: "varchar", length: 40 }) version!: string
  @Column({ type: "varchar", length: 20 }) action!: "UPLOADED" | "PREFLIGHT_PASSED" | "PREFLIGHT_FAILED" | "ACTIVATED" | "RETIRED" | "ROLLED_BACK"
  @Column({ type: "uuid", nullable: true }) previousPackageId!: string | null
  @Column({ type: "text", nullable: true }) reason!: string | null
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) actor!: UserEntity
  @CreateDateColumn() createdAt!: Date
}

export const v3ResourceEntities = [ResourcePackageEntity, ResourcePackageValidationRunEntity, ResourcePackageLifecycleEventEntity]
