import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { FileAssetEntity } from "../files/file-asset.entity.js"
import { ProjectEvaluationEntity } from "../runtime/runtime.entities.js"

@Entity("show_review_annotations")
@Index(["project", "simulationTimeMs"])
export class ShowReviewAnnotationEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @ManyToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" }) project!: StudentProjectEntity
  @ManyToOne(() => ProjectEvaluationEntity, { nullable: false, onDelete: "CASCADE" }) evaluation!: ProjectEvaluationEntity
  @Column({ type: "varchar", length: 160 }) timelineItemId!: string
  @Column({ type: "bigint", nullable: true }) simulationTimeMs!: number | null
  @Column({ type: "text" }) comment!: string
  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" }) createdBy!: UserEntity
  @CreateDateColumn() createdAt!: Date
}

@Entity("show_project_reports")
@Index(["project"], { unique: true })
export class ShowProjectReportEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @OneToOne(() => StudentProjectEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  project!: StudentProjectEntity
  @OneToOne(() => ProjectEvaluationEntity, { nullable: false, eager: true, onDelete: "CASCADE" })
  @JoinColumn()
  evaluation!: ProjectEvaluationEntity
  @Column({ type: "varchar", length: 20, default: "DRAFT" }) status!: "DRAFT" | "FINAL"
  @Column({ type: "integer", default: 1 }) revision!: number
  @Column({ type: "varchar", length: 10, nullable: true }) format!: "DOCX" | "PDF" | null
  @ManyToOne(() => FileAssetEntity, { nullable: true, eager: true, onDelete: "RESTRICT" }) asset!: FileAssetEntity | null
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) snapshot!: Record<string, unknown>
  @Column({ type: "varchar", length: 64, nullable: true }) contentHash!: string | null
  @Column({ type: "timestamptz", nullable: true }) generatedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

export const v3ShowReviewEntities = [ShowReviewAnnotationEntity, ShowProjectReportEntity]
