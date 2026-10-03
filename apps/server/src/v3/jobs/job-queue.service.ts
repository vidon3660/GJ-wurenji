import { Injectable } from "@nestjs/common"
import { randomUUID } from "node:crypto"
import { DataSource, EntityManager } from "typeorm"
import { JobEntity, type V3JobStatus } from "./job.entities.js"
import { returnedRows } from "./sql-result.js"

export interface EnqueueJobInput {
  jobType: string
  payload: Record<string, unknown>
  priority?: number
  maxAttempts?: number
  availableAt?: Date
  correlationId?: string
  idempotencyKey?: string
  sourceOutboxEventId?: string
}

@Injectable()
export class JobQueueService {
  constructor(private readonly dataSource: DataSource) {}

  async enqueue(input: EnqueueJobInput, manager: EntityManager = this.dataSource.manager): Promise<JobEntity> {
    const job = manager.create(JobEntity, {
      ...input,
      status: "PENDING",
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? 5,
      availableAt: input.availableAt ?? new Date(),
      correlationId: input.correlationId ?? randomUUID(),
      idempotencyKey: input.idempotencyKey ?? null,
      sourceOutboxEventId: input.sourceOutboxEventId ?? null,
      result: {},
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      lastError: null,
      finishedAt: null
    })
    return manager.save(JobEntity, job)
  }

  async claimNext(workerId: string, leaseDurationMs = 30_000, jobTypes?: readonly string[]): Promise<JobEntity | null> {
    validateWorkerId(workerId)
    validateLeaseDuration(leaseDurationMs)
    const jobTypeFilter = normalizeJobTypes(jobTypes)
    if (jobTypeFilter?.length === 0) return null
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`
        UPDATE "jobs"
        SET "status" = 'DEAD_LETTER', "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
            "lastError" = COALESCE("lastError", 'Worker 租约过期且已达到最大尝试次数'),
            "finishedAt" = now(), "updatedAt" = now()
        WHERE "status" = 'RUNNING' AND "leaseExpiresAt" < now() AND "attempts" >= "maxAttempts"
          AND ($1::text[] IS NULL OR "jobType" = ANY($1::text[]))
      `, [jobTypeFilter])
      const result = await manager.query(`
        WITH candidate AS (
          SELECT "id"
          FROM "jobs"
          WHERE (
            ("status" IN ('PENDING', 'RETRY_WAIT') AND "availableAt" <= now() AND "attempts" < "maxAttempts")
            OR ("status" = 'RUNNING' AND "leaseExpiresAt" < now() AND "attempts" < "maxAttempts")
          )
          AND ($3::text[] IS NULL OR "jobType" = ANY($3::text[]))
          ORDER BY "priority" DESC, "availableAt" ASC, "createdAt" ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE "jobs" AS job
        SET "status" = 'RUNNING', "attempts" = job."attempts" + 1,
            "leaseOwner" = $1, "leaseExpiresAt" = now() + ($2::integer * interval '1 millisecond'),
            "heartbeatAt" = now(), "updatedAt" = now()
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job.*
      `, [workerId, leaseDurationMs, jobTypeFilter])
      const rows = returnedRows<JobEntity>(result)
      return rows[0] ?? null
    })
  }

  async heartbeat(jobId: string, workerId: string, leaseDurationMs = 30_000): Promise<boolean> {
    validateWorkerId(workerId)
    validateLeaseDuration(leaseDurationMs)
    const result = await this.dataSource.query(`
      UPDATE "jobs"
      SET "heartbeatAt" = now(), "leaseExpiresAt" = now() + ($3::integer * interval '1 millisecond'), "updatedAt" = now()
      WHERE "id" = $1 AND "status" = 'RUNNING' AND "leaseOwner" = $2 AND "leaseExpiresAt" > now()
      RETURNING "id"
    `, [jobId, workerId, leaseDurationMs])
    const rows = returnedRows<{ id: string }>(result)
    return rows.length === 1
  }

  async complete(jobId: string, workerId: string, result: Record<string, unknown> = {}): Promise<JobEntity | null> {
    const queryResult = await this.dataSource.query(`
      UPDATE "jobs"
      SET "status" = 'SUCCEEDED', "result" = $3::jsonb, "leaseOwner" = NULL,
          "leaseExpiresAt" = NULL, "heartbeatAt" = now(), "lastError" = NULL,
          "finishedAt" = now(), "updatedAt" = now()
      WHERE "id" = $1 AND "status" = 'RUNNING' AND "leaseOwner" = $2 AND "leaseExpiresAt" > now()
      RETURNING *
    `, [jobId, workerId, JSON.stringify(result)])
    const rows = returnedRows<JobEntity>(queryResult)
    return rows[0] ?? null
  }

  async fail(jobId: string, workerId: string, error: unknown): Promise<JobEntity | null> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await manager.query(`
        SELECT * FROM "jobs"
        WHERE "id" = $1 AND "status" = 'RUNNING' AND "leaseOwner" = $2 AND "leaseExpiresAt" > now()
        FOR UPDATE
      `, [jobId, workerId]) as JobEntity[]
      const job = rows[0]
      if (!job) return null
      const status: V3JobStatus = job.attempts >= job.maxAttempts ? "DEAD_LETTER" : "RETRY_WAIT"
      const retryDelayMs = status === "RETRY_WAIT" ? calculateRetryDelayMs(job.attempts) : 0
      const failedResult = await manager.query(`
        UPDATE "jobs"
        SET "status" = $3::varchar, "availableAt" = now() + ($4::integer * interval '1 millisecond'),
            "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL,
            "lastError" = $5, "finishedAt" = CASE WHEN $3::varchar = 'DEAD_LETTER' THEN now() ELSE NULL END,
            "updatedAt" = now()
        WHERE "id" = $1 AND "leaseOwner" = $2
        RETURNING *
      `, [jobId, workerId, status, retryDelayMs, normalizeError(error)])
      const failedRows = returnedRows<JobEntity>(failedResult)
      return failedRows[0] ?? null
    })
  }

  async find(jobId: string): Promise<JobEntity | null> {
    return this.dataSource.manager.findOneBy(JobEntity, { id: jobId })
  }
}

export function calculateRetryDelayMs(attempts: number): number {
  const baseDelayMs = normalizePositiveInteger(process.env.JOB_RETRY_BASE_DELAY_MS, 1_000)
  const maximumDelayMs = normalizePositiveInteger(process.env.JOB_RETRY_MAX_DELAY_MS, 300_000)
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1))
}

function validateWorkerId(workerId: string): void {
  if (!workerId.trim() || workerId.length > 160) throw new Error("Worker 标识无效")
}

function validateLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 10 || leaseDurationMs > 3_600_000) throw new Error("作业租约时长无效")
}

function normalizeJobTypes(jobTypes: readonly string[] | undefined): string[] | null {
  if (jobTypes === undefined) return null
  const normalized = [...new Set(jobTypes.map((jobType) => jobType.trim()))]
  if (normalized.some((jobType) => !jobType || jobType.length > 100)) throw new Error("作业类型过滤条件无效")
  return normalized
}

function normalizePositiveInteger(value: string | undefined, fallback: number): number {
  const normalized = Number(value ?? fallback)
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback
}

function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 8_000)
}
