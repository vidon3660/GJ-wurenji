import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { DataSource } from "typeorm"
import { JobEntity, OutboxEventEntity } from "./job.entities.js"
import { JobQueueService } from "./job-queue.service.js"
import { TransactionalOutboxService } from "./transactional-outbox.service.js"

const integrationEnabled = Boolean(process.env.V3_INTEGRATION_DATABASE_URL)

describe.runIf(integrationEnabled)("job queue PostgreSQL integration", () => {
  let dataSource: DataSource
  let jobs: JobQueueService
  let outbox: TransactionalOutboxService
  const jobTypePrefix = `INTEGRATION_${randomUUID()}`
  const previousRetryDelay = process.env.JOB_RETRY_BASE_DELAY_MS

  beforeAll(async () => {
    dataSource = new DataSource({
      type: "postgres",
      url: process.env.V3_INTEGRATION_DATABASE_URL!,
      entities: [JobEntity, OutboxEventEntity]
    })
    await dataSource.initialize()
    jobs = new JobQueueService(dataSource)
    outbox = new TransactionalOutboxService(dataSource)
    process.env.JOB_RETRY_BASE_DELAY_MS = "1"
  })

  afterEach(async () => {
    await dataSource.query(`DELETE FROM "jobs" WHERE "jobType" LIKE $1`, [`${jobTypePrefix}%`])
    await dataSource.query(`DELETE FROM "outbox_events" WHERE "jobType" LIKE $1`, [`${jobTypePrefix}%`])
  })

  afterAll(async () => {
    restoreEnvironment("JOB_RETRY_BASE_DELAY_MS", previousRetryDelay)
    if (dataSource?.isInitialized) await dataSource.destroy()
  })

  it("rolls back an outbox event with its business transaction", async () => {
    await expect(dataSource.transaction(async (manager) => {
      await outbox.append(outboxInput("ROLLBACK"), manager)
      throw new Error("rollback")
    })).rejects.toThrow("rollback")

    const rows = await dataSource.query(`SELECT "id" FROM "outbox_events" WHERE "jobType" = $1`, [`${jobTypePrefix}_ROLLBACK`]) as unknown[]
    expect(rows).toHaveLength(0)
  })

  it("relays one outbox event to one idempotent job", async () => {
    const event = await dataSource.transaction((manager) => outbox.append(outboxInput("RELAY"), manager))

    const published = await outbox.relayNext("relay-a", 1_000, [`${jobTypePrefix}_RELAY`])
    expect(published).toMatchObject({ id: event.id, status: "PUBLISHED" })
    await expect(outbox.relayNext("relay-a", 1_000, [`${jobTypePrefix}_RELAY`])).resolves.toBeNull()

    const rows = await dataSource.query(`SELECT * FROM "jobs" WHERE "sourceOutboxEventId" = $1`, [event.id]) as JobEntity[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "PENDING", jobType: `${jobTypePrefix}_RELAY`, payload: { source: "integration" } })
  })

  it("claims different jobs concurrently and completes with a live lease", async () => {
    await jobs.enqueue(jobInput("CONCURRENT_A"))
    await jobs.enqueue(jobInput("CONCURRENT_B"))

    const [first, second] = await Promise.all([
      jobs.claimNext("worker-a", 1_000),
      jobs.claimNext("worker-b", 1_000)
    ])
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(first!.id).not.toBe(second!.id)
    await expect(jobs.heartbeat(first!.id, "worker-a", 1_000)).resolves.toBe(true)
    await expect(jobs.complete(first!.id, "worker-a", { completed: true })).resolves.toMatchObject({ status: "SUCCEEDED" })
    await expect(jobs.complete(second!.id, "wrong-worker", {})).resolves.toBeNull()
  })

  it("leaves unregistered job and outbox types untouched", async () => {
    const allowedJob = await jobs.enqueue(jobInput("FILTER_ALLOWED"))
    const blockedJob = await jobs.enqueue(jobInput("FILTER_BLOCKED"))
    await expect(jobs.claimNext("worker-filter", 1_000, [allowedJob.jobType])).resolves.toMatchObject({ id: allowedJob.id })
    await expect(jobs.claimNext("worker-filter", 1_000, [allowedJob.jobType])).resolves.toBeNull()
    await expect(jobs.find(blockedJob.id)).resolves.toMatchObject({ status: "PENDING", attempts: 0 })

    const allowedEvent = await dataSource.transaction((manager) => outbox.append(outboxInput("OUTBOX_ALLOWED"), manager))
    const blockedEvent = await dataSource.transaction((manager) => outbox.append(outboxInput("OUTBOX_BLOCKED"), manager))
    await expect(outbox.relayNext("relay-filter", 1_000, [allowedEvent.jobType])).resolves.toMatchObject({ id: allowedEvent.id, status: "PUBLISHED" })
    const blockedRows = await dataSource.query(`SELECT "status", "attempts" FROM "outbox_events" WHERE "id" = $1`, [blockedEvent.id]) as Array<{ status: string; attempts: number }>
    expect(blockedRows[0]).toMatchObject({ status: "PENDING", attempts: 0 })
  })

  it("retries with backoff and moves the final failure to dead letter", async () => {
    const queued = await jobs.enqueue({ ...jobInput("RETRY"), maxAttempts: 2 })
    const first = await jobs.claimNext("worker-retry", 1_000)
    expect(first?.id).toBe(queued.id)
    await expect(jobs.fail(queued.id, "worker-retry", new Error("first failure"))).resolves.toMatchObject({ status: "RETRY_WAIT", attempts: 1 })
    await delay(10)
    const second = await jobs.claimNext("worker-retry", 1_000)
    expect(second).toMatchObject({ id: queued.id, attempts: 2 })
    await expect(jobs.fail(queued.id, "worker-retry", new Error("final failure"))).resolves.toMatchObject({ status: "DEAD_LETTER", attempts: 2 })
  })

  it("reclaims an expired lease without duplicating the job", async () => {
    const queued = await jobs.enqueue({ ...jobInput("LEASE"), maxAttempts: 3 })
    await expect(jobs.claimNext("worker-crashed", 20)).resolves.toMatchObject({ id: queued.id, attempts: 1 })
    await delay(35)

    await expect(jobs.claimNext("worker-recovery", 1_000)).resolves.toMatchObject({ id: queued.id, attempts: 2, leaseOwner: "worker-recovery" })
    const rows = await dataSource.query(`SELECT "id" FROM "jobs" WHERE "id" = $1`, [queued.id]) as unknown[]
    expect(rows).toHaveLength(1)
  })

  function jobInput(suffix: string) {
    return {
      jobType: `${jobTypePrefix}_${suffix}`,
      payload: { source: "integration" },
      correlationId: randomUUID()
    }
  }

  function outboxInput(suffix: string) {
    return {
      eventType: `PROJECT_${suffix}`,
      jobType: `${jobTypePrefix}_${suffix}`,
      aggregateType: "PROJECT",
      aggregateId: randomUUID(),
      payload: { source: "integration" },
      correlationId: randomUUID()
    }
  }
})

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
