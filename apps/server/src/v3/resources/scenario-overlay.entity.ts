import { Column, CreateDateColumn, Entity, Index, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm"
import type { SceneType, V3ScenarioOverlayObject, V3ScenarioOverlayVersionStatus } from "@wurenji/shared"
import { UserEntity } from "../../entities.js"

@Entity("scenario_overlays")
@Index(["regionPackageId", "createdBy"])
export class ScenarioOverlayEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @Column({ type: "varchar", length: 40 })
  sceneType!: SceneType

  @Column({ type: "uuid" })
  regionPackageId!: string

  @Column({ type: "varchar", length: 160 })
  title!: string

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @OneToMany(() => ScenarioOverlayVersionEntity, (version) => version.overlay)
  versions!: ScenarioOverlayVersionEntity[]

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

@Entity("scenario_overlay_versions")
@Index(["overlay", "versionNo"], { unique: true })
@Index(["sceneType", "regionPackageId", "title", "versionNo"], { unique: true })
@Index("UQ_scenario_overlay_versions_published_scope", ["sceneType", "regionPackageId", "title"], { unique: true, where: `"status" = 'PUBLISHED'` })
@Index(["regionPackageId", "status"])
export class ScenarioOverlayVersionEntity {
  @PrimaryGeneratedColumn("uuid")
  id!: string

  @ManyToOne(() => ScenarioOverlayEntity, (overlay) => overlay.versions, { nullable: false, onDelete: "CASCADE" })
  overlay!: ScenarioOverlayEntity

  @Column({ type: "integer" })
  versionNo!: number

  @Column({ type: "integer", default: 1 })
  revision!: number

  @Column({ type: "varchar", length: 40 })
  sceneType!: SceneType

  @Column({ type: "uuid" })
  regionPackageId!: string

  @Column({ type: "varchar", length: 160 })
  title!: string

  @Column({ type: "varchar", length: 20, default: "DRAFT" })
  status!: V3ScenarioOverlayVersionStatus

  @Column({ type: "jsonb", default: () => "'[]'::jsonb" })
  objects!: V3ScenarioOverlayObject[]

  @Column({ type: "varchar", length: 64 })
  checksum!: string

  @ManyToOne(() => UserEntity, { nullable: false, eager: true, onDelete: "RESTRICT" })
  createdBy!: UserEntity

  @Column({ type: "timestamptz", nullable: true })
  publishedAt!: Date | null

  @Column({ type: "timestamptz", nullable: true })
  archivedAt!: Date | null

  @CreateDateColumn()
  createdAt!: Date

  @UpdateDateColumn()
  updatedAt!: Date
}

export const scenarioOverlayEntities = [ScenarioOverlayEntity, ScenarioOverlayVersionEntity]
