import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm"

export type V3JobStatus = "PENDING" | "RUNNING" | "RETRY_WAIT" | "SUCCEEDED" | "DEAD_LETTER" | "CANCELLED"
export type V3OutboxStatus = "PENDING" | "PROCESSING" | "PUBLISHED" | "FAILED"

@Entity("jobs")
@Index(["status", "availableAt", "priority"])
@Index(["leaseExpiresAt"])
@Index(["correlationId"])
export class JobEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "varchar", length: 100 }) jobType!: string
  @Column({ type: "varchar", length: 20, default: "PENDING" }) status!: V3JobStatus
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) payload!: Record<string, unknown>
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) result!: Record<string, unknown>
  @Column({ type: "integer", default: 0 }) priority!: number
  @Column({ type: "integer", default: 0 }) attempts!: number
  @Column({ type: "integer", default: 5 }) maxAttempts!: number
  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" }) availableAt!: Date
  @Column({ type: "varchar", length: 160, nullable: true }) leaseOwner!: string | null
  @Column({ type: "timestamptz", nullable: true }) leaseExpiresAt!: Date | null
  @Column({ type: "timestamptz", nullable: true }) heartbeatAt!: Date | null
  @Column({ type: "text", nullable: true }) lastError!: string | null
  @Column({ type: "uuid" }) correlationId!: string
  @Column({ type: "varchar", length: 200, nullable: true, unique: true }) idempotencyKey!: string | null
  @Column({ type: "uuid", nullable: true, unique: true }) sourceOutboxEventId!: string | null
  @Column({ type: "timestamptz", nullable: true }) finishedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

@Entity("outbox_events")
@Index(["status", "availableAt"])
@Index(["leaseExpiresAt"])
@Index(["aggregateType", "aggregateId"])
@Index(["correlationId"])
export class OutboxEventEntity {
  @PrimaryGeneratedColumn("uuid") id!: string
  @Column({ type: "varchar", length: 100 }) eventType!: string
  @Column({ type: "varchar", length: 100 }) jobType!: string
  @Column({ type: "varchar", length: 80 }) aggregateType!: string
  @Column({ type: "varchar", length: 160 }) aggregateId!: string
  @Column({ type: "varchar", length: 20, default: "PENDING" }) status!: V3OutboxStatus
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" }) payload!: Record<string, unknown>
  @Column({ type: "integer", default: 0 }) priority!: number
  @Column({ type: "integer", default: 0 }) attempts!: number
  @Column({ type: "integer", default: 5 }) maxAttempts!: number
  @Column({ type: "timestamptz", default: () => "CURRENT_TIMESTAMP" }) availableAt!: Date
  @Column({ type: "varchar", length: 160, nullable: true }) leaseOwner!: string | null
  @Column({ type: "timestamptz", nullable: true }) leaseExpiresAt!: Date | null
  @Column({ type: "text", nullable: true }) lastError!: string | null
  @Column({ type: "uuid" }) correlationId!: string
  @Column({ type: "timestamptz", nullable: true }) publishedAt!: Date | null
  @CreateDateColumn() createdAt!: Date
  @UpdateDateColumn() updatedAt!: Date
}

export const v3JobEntities = [JobEntity, OutboxEventEntity]
