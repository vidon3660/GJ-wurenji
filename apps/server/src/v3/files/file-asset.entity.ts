import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from "typeorm"
import type { V3FileAssetView } from "@wurenji/shared"
import { UserEntity } from "../../entities.js"

export type FileStorageProvider = "LOCAL" | "MINIO" | "S3"

@Entity("file_assets")
@Index(["ownerType", "ownerId"])
export class FileAssetEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "varchar", length: 40 }) category!: V3FileAssetView["category"]
  @Column({ type: "varchar", length: 20, default: "LOCAL" }) storageProvider!: FileStorageProvider
  @Column({ type: "varchar", length: 500, unique: true }) objectKey!: string
  @Column({ type: "varchar", length: 240 }) originalName!: string
  @Column({ type: "varchar", length: 120 }) mimeType!: string
  @Column({ type: "integer" }) sizeBytes!: number
  @Column({ type: "varchar", length: 64 }) sha256!: string
  @Column({ type: "varchar", length: 20, default: "AVAILABLE" }) status!: "AVAILABLE" | "ARCHIVED" | "DELETED"
  @Column({ type: "varchar", length: 40 }) ownerType!: "PROJECT" | "RESOURCE_PACKAGE"
  @Column({ type: "uuid" }) ownerId!: string
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) createdBy!: UserEntity
  @CreateDateColumn() createdAt!: Date
}

export const v3FileEntities = [FileAssetEntity]
