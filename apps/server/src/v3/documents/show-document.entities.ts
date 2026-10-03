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
  ProjectDocumentStatus,
  ProjectDocumentVersionKind,
  ShowDocumentTemplateCode
} from "@wurenji/shared"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"

@Entity("show_project_documents")
@Index(["project", "templateCode"], { unique: true })
export class ShowProjectDocumentEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" }) project!: StudentProjectEntity
  @Column({ type: "varchar", length: 60 }) templateCode!: ShowDocumentTemplateCode
  @Column({ type: "varchar", length: 160 }) title!: string
  @Column({ type: "varchar", length: 240 }) filename!: string
  @Column({ type: "uuid" }) templatePackageId!: string
  @Column({ type: "varchar", length: 40 }) templatePackageVersion!: string
  @Column({ type: "varchar", length: 64 }) templatePackageSha256!: string
  @Column({ type: "varchar", length: 500 }) templatePath!: string
  @Column({ type: "varchar", length: 30, default: "NOT_STARTED" }) status!: ProjectDocumentStatus
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "integer", default: 0 }) currentVersionNo!: number
  @ManyToOne(() => FileAssetEntity, { nullable: true, eager: true, onDelete: "RESTRICT" }) currentAsset!: FileAssetEntity | null
  @Column({ type: "integer", nullable: true }) submittedVersionNo!: number | null
  @Column({ type: "timestamptz", nullable: true }) lastSavedAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) submittedAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) viewedAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) returnedAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) resubmittedAt!: Date | null
  @Column({ type: "text", nullable: true }) reviewComment!: string | null
  @Column({ type: "integer", nullable: true }) reviewScore!: number | null
  @OneToMany(() => ShowProjectDocumentVersionEntity, (version) => version.document) versions!: ShowProjectDocumentVersionEntity[]
  @OneToMany(() => ShowProjectDocumentReviewEntity, (review) => review.document) reviews!: ShowProjectDocumentReviewEntity[]
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

@Entity("show_project_document_versions")
@Index(["document", "versionNo"], { unique: true })
export class ShowProjectDocumentVersionEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @ManyToOne(() => ShowProjectDocumentEntity, (document) => document.versions, { nullable: false, onDelete: "CASCADE" }) document!: ShowProjectDocumentEntity
  @Column({ type: "integer" }) versionNo!: number
  @Column({ type: "varchar", length: 30 }) kind!: ProjectDocumentVersionKind
  @ManyToOne(() => FileAssetEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) asset!: FileAssetEntity
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) createdBy!: UserEntity
  @Column({ type: "uuid", nullable: true }) editorSessionId!: string | null
  @CreateDateColumn() createdAt!: Date
}

@Entity("show_project_document_reviews")
@Index(["document", "createdAt"])
export class ShowProjectDocumentReviewEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @ManyToOne(() => ShowProjectDocumentEntity, (document) => document.reviews, { nullable: false, onDelete: "CASCADE" }) document!: ShowProjectDocumentEntity
  @Column({ type: "integer" }) versionNo!: number
  @Column({ type: "varchar", length: 20 }) action!: "VIEWED" | "RETURNED" | "COMMENTED"
  @Column({ type: "text", default: "" }) comment!: string
  @Column({ type: "integer", nullable: true }) score!: number | null
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) reviewedBy!: UserEntity
  @CreateDateColumn() createdAt!: Date
}

@Entity("show_project_document_sessions")
@Index(["sessionKey"], { unique: true })
export class ShowProjectDocumentSessionEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @ManyToOne(() => ShowProjectDocumentEntity, { nullable: false, eager: true, onDelete: "CASCADE" }) document!: ShowProjectDocumentEntity
  @Column({ type: "varchar", length: 160 }) sessionKey!: string
  @Column({ type: "varchar", length: 20 }) mode!: "EDIT" | "VIEW"
  @Column({ type: "varchar", length: 20, default: "OPEN" }) status!: "OPEN" | "CLOSED" | "EXPIRED"
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) actor!: UserEntity
  @Column({ type: "timestamptz" }) expiresAt!: Date
  @Column({ type: "timestamptz", nullable: true }) lastCallbackAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) closedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
}

export const v3DocumentEntities = [
  ShowProjectDocumentEntity,
  ShowProjectDocumentVersionEntity,
  ShowProjectDocumentReviewEntity,
  ShowProjectDocumentSessionEntity
]
