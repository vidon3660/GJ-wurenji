import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from "typeorm"
import type { VtlRuntimeActionCode, VtlRuntimeAircraftView, VtlRuntimeGroupView, VtlTaskObjectView, VtlReorganizationRecordView } from "@wurenji/shared"

@Entity("vtl_runtime_snapshots")
@Index(["sessionId", "sequence"], { unique: true })
@Index(["projectId", "simulationTimeMs"])
export class VtlRuntimeSnapshotEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "uuid" }) sessionId!: string
  @Column({ type: "integer" }) sequence!: number
  @Column({ type: "bigint" }) simulationTimeMs!: number
  @Column({ type: "varchar", length: 30 }) reason!: "START" | "TICK" | "EVENT" | "ACTION" | "COMPLETE" | "ABORT"
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) summary!: Record<string, unknown>
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) aircraft!: VtlRuntimeAircraftView[]
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) groups!: VtlRuntimeGroupView[]
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) taskObjects!: VtlTaskObjectView[]
  @CreateDateColumn() createdAt!: Date
}

@Entity("vtl_reorganization_records")
@Index(["projectId", "executedAtMs"])
export class VtlReorganizationEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "uuid" }) projectId!: string
  @Column({ type: "uuid" }) sessionId!: string
  @Column({ type: "uuid", nullable: true }) eventId!: string | null
  @Column({ type: "varchar", length: 40 }) action!: VtlRuntimeActionCode
  @Column({ type: "varchar", length: 120, nullable: true }) sourceAircraftId!: string | null
  @Column({ type: "varchar", length: 120, nullable: true }) targetAircraftId!: string | null
  @Column({ type: "varchar", length: 120, nullable: true }) sourceGroupId!: string | null
  @Column({ type: "varchar", length: 120, nullable: true }) targetGroupId!: string | null
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) taskObjectIds!: string[]
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) previousTaskOrder!: string[]
  @Column({ type: "jsonb", default: () => "'[]'::jsonb" }) nextTaskOrder!: string[]
  @Column({ type: "boolean", default: true }) checkPassed!: boolean
  @Column({ type: "text" }) message!: string
  @Column({ type: "bigint" }) executedAtMs!: number
  @CreateDateColumn() createdAt!: Date
}

export const v3VtlRuntimeEntities = [VtlRuntimeSnapshotEntity, VtlReorganizationEntity]
