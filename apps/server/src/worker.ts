import "reflect-metadata"
import { Logger } from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import { hostname } from "node:os"
import { rename, writeFile } from "node:fs/promises"
import { JobWorkerService } from "./v3/jobs/job-worker.service.js"
import { TransactionalOutboxService } from "./v3/jobs/transactional-outbox.service.js"
import { WorkerModule } from "./worker.module.js"
import { validateProductionWorkerEnvironment } from "./config/runtime-config.js"

const logger = new Logger("JobWorker")
const healthPath = process.env.WORKER_HEALTH_FILE?.trim() || "/tmp/wurenji-worker-health.json"

async function bootstrap(): Promise<void> {
  validateProductionWorkerEnvironment()
  const app = await NestFactory.createApplicationContext(WorkerModule)
  const worker = app.get(JobWorkerService)
  const outbox = app.get(TransactionalOutboxService)
  const jobTypes = worker.registeredJobTypes()
  if (jobTypes.length === 0) throw new Error("Worker 未注册任何业务作业处理器")

  const workerId = normalizeIdentifier(process.env.WORKER_ID, `worker-${hostname()}-${process.pid}`)
  const relayId = normalizeIdentifier(process.env.OUTBOX_RELAY_ID, `relay-${hostname()}-${process.pid}`)
  const pollIntervalMs = positiveInteger(process.env.WORKER_POLL_INTERVAL_MS, 500, 50, 60_000)
  const errorDelayMs = positiveInteger(process.env.WORKER_ERROR_DELAY_MS, 5_000, 100, 300_000)
  const leaseDurationMs = positiveInteger(process.env.JOB_LEASE_DURATION_MS, 30_000, 1_000, 3_600_000)
  const batchSize = positiveInteger(process.env.WORKER_BATCH_SIZE, 20, 1, 1_000)
  let stopping = false

  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    logger.log(`收到 ${signal}，等待当前作业结束`)
  }
  process.once("SIGTERM", () => stop("SIGTERM"))
  process.once("SIGINT", () => stop("SIGINT"))

  logger.log(`Worker 已启动：${workerId}；作业类型：${jobTypes.join(", ")}`)
  while (!stopping) {
    let activity = false
    try {
      for (let index = 0; index < batchSize && !stopping; index += 1) {
        const relayed = await outbox.relayNext(relayId, leaseDurationMs, jobTypes)
        const completed = await worker.runOnce(workerId, leaseDurationMs)
        activity = activity || Boolean(relayed || completed)
        if (!relayed && !completed) break
      }
      await writeHealth({ status: "ready", workerId, jobTypes, lastSuccessfulCycleAt: new Date().toISOString() })
      if (!activity && !stopping) await delay(pollIntervalMs)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`Worker 循环失败：${message}`, error instanceof Error ? error.stack : undefined)
      await writeHealth({ status: "error", workerId, jobTypes, lastError: message, checkedAt: new Date().toISOString() })
      if (!stopping) await delay(errorDelayMs)
    }
  }
  await app.close()
}

async function writeHealth(value: Record<string, unknown>): Promise<void> {
  const temporaryPath = `${healthPath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, "utf8")
  await rename(temporaryPath, healthPath)
}

function normalizeIdentifier(value: string | undefined, fallback: string): string {
  const result = value?.trim() || fallback
  if (result.length > 160) throw new Error("Worker 标识长度不能超过 160 个字符")
  return result
}

function positiveInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const result = Number(value ?? fallback)
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`Worker 数值配置必须在 ${minimum} 到 ${maximum} 之间`)
  return result
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

void bootstrap().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined)
  process.exitCode = 1
})
