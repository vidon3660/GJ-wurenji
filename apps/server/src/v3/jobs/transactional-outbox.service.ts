import { Injectable } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import { DataSource, EntityManager } from "typeorm"
import { OutboxEventEntity } from "./job.entities.js"
import { returnedRows } from "./sql-result.js"

export interface AppendOutboxInput {
  eventType: string
  jobType: string
  aggregateType: string
  aggregateId: string
  payload: Record<string, unknown>
  priority?: number
  maxAttempts?: number
  availableAt?: Date
  correlationId?: string
}

@Injectable()
export class TransactionalOutboxService {
  constructor(private readonly dataSource: DataSource) {}

  async append(input: AppendOutboxInput, manager: EntityManager): Promise<OutboxEventEntity> {
    const event = manager.create(OutboxEventEntity, {
      ...input,
      status: "PENDING",
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      availableAt: input.availableAt ?? new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: null,
      correlationId: input.correlationId ?? randomUUID(),
      publishedAt: null
    })
    return manager.save(OutboxEventEntity, event)
  }

  async relayNext(relayId: string, leaseDurationMs = 30_000, jobTypes?: readonly string[]): Promise<OutboxEventEntity | null> {
    const claimed = await this.claimNext(relayId, leaseDurationMs, jobTypes)
    if (!claimed) return null
    try {
      return await this.dataSource.transaction(async (manager) => {
        const lockedRows = await manager.query(`
          SELECT * FROM "outbox_events"
          WHERE "id" = $1 AND "status" = 'PROCESSING' AND "leaseOwner" = $2 AND "leaseExpiresAt" > now()
          FOR UPDATE
        `, [claimed.id, relayId]) as OutboxEventEntity[]
        const event = lockedRows[0]
        if (!event) return null
        await manager.query(`
          INSERT INTO "jobs" (
            "jobType", "status", "payload", "result", "priority", "attempts", "maxAttempts",
            "availableAt", "correlationId", "sourceOutboxEventId", "createdAt", "updatedAt"
          ) VALUES ($1, 'PENDING', $2::jsonb, '{}'::jsonb, $3, 0, $4, $5, $6, $7, now(), now())
          ON CONFLICT ("sourceOutboxEventId") DO NOTHING
        `, [event.jobType, JSON.stringify(event.payload), event.priority, event.maxAttempts, event.availableAt, event.correlationId, event.id])
        const publishedResult = await manager.query(`
          UPDATE "outbox_events"
          SET "status" = 'PUBLISHED', "publishedAt" = now(), "leaseOwner" = NULL,
              "leaseExpiresAt" = NULL, "lastError" = NULL, "updatedAt" = now()
          WHERE "id" = $1 AND "leaseOwner" = $2
          RETURNING *
        `, [event.id, relayId])
        const publishedRows = returnedRows<OutboxEventEntity>(publishedResult)
        return publishedRows[0] ?? null
      })
    } catch (error) {
      await this.markRelayFailure(claimed.id, relayId, error)
      throw error
    }
  }

  private async claimNext(relayId: string, leaseDurationMs: number, jobTypes?: readonly string[]): Promise<OutboxEventEntity | null> {
    if (!relayId.trim() || relayId.length > 160) throw new Error("Outbox 转发器标识无效")
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 10 || leaseDurationMs > 3_600_000) throw new Error("Outbox 租约时长无效")
    const jobTypeFilter = normalizeJobTypes(jobTypes)
    if (jobTypeFilter?.length === 0) return null
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`
        UPDATE "outbox_events"
        SET "status" = 'FAILED', "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
            "lastError" = COALESCE("lastError", 'Outbox 租约过期且已达到最大尝试次数'), "updatedAt" = now()
        WHERE "status" = 'PROCESSING' AND "leaseExpiresAt" < now() AND "attempts" >= "maxAttempts"
          AND ($1::text[] IS NULL OR "jobType" = ANY($1::text[]))
      `, [jobTypeFilter])
      const result = await manager.query(`
        WITH candidate AS (
          SELECT "id"
          FROM "outbox_events"
          WHERE (
            ("status" IN ('PENDING', 'FAILED') AND "availableAt" <= now() AND "attempts" < "maxAttempts")
            OR ("status" = 'PROCESSING' AND "leaseExpiresAt" < now() AND "attempts" < "maxAttempts")
          )
          AND ($3::text[] IS NULL OR "jobType" = ANY($3::text[]))
          ORDER BY "availableAt" ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "outbox_events" AS event
        SET "status" = 'PROCESSING', "attempts" = event."attempts" + 1,
            "leaseOwner" = $1, "leaseExpiresAt" = now() + ($2::integer * interval '1 millisecond'),
            "updatedAt" = now()
        FROM candidate
        WHERE event."id" = candidate."id"
        RETURNING event.*
      `, [relayId, leaseDurationMs, jobTypeFilter])
      const rows = returnedRows<OutboxEventEntity>(result)
      return rows[0] ?? null
    })
  }

  private async markRelayFailure(eventId: string, relayId: string, error: unknown): Promise<void> {
    await this.dataSource.query(`
      UPDATE "outbox_events"
      SET "status" = 'FAILED',
          "availableAt" = now() + (LEAST(300000, 1000 * power(2, GREATEST(0, "attempts" - 1)))::integer * interval '1 millisecond'),
          "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = $3, "updatedAt" = now()
      WHERE "id" = $1 AND "leaseOwner" = $2
    `, [eventId, relayId, normalizeError(error)])
  }
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 8_000)
}

function normalizeJobTypes(jobTypes: readonly string[] | undefined): string[] | null {
  if (jobTypes === undefined) return null
  const normalized = [...new Set(jobTypes.map((jobType) => jobType.trim()))]
  if (normalized.some((jobType) => !jobType || jobType.length > 100)) throw new Error("Outbox 作业类型过滤条件无效")
  return normalized
}
