import { Injectable } from "@nestjs/common"
import { JobQueueService } from "./job-queue.service.js"
import type { JobEntity } from "./job.entities.js"

export type V3JobHandler = (job: JobEntity) => Promise<Record<string, unknown> | void>

@Injectable()
export class JobWorkerService {
  private readonly handlers = new Map<string, V3JobHandler>()

  constructor(private readonly jobs: JobQueueService) {}

  register(jobType: string, handler: V3JobHandler): void {
    if (!jobType.trim() || jobType.length > 100) throw new Error("作业类型无效")
    if (this.handlers.has(jobType)) throw new Error(`作业处理器已注册：${jobType}`)
    this.handlers.set(jobType, handler)
  }

  registeredJobTypes(): string[] {
    return [...this.handlers.keys()]
  }

  async runOnce(workerId: string, leaseDurationMs = 30_000): Promise<JobEntity | null> {
    const jobTypes = this.registeredJobTypes()
    if (jobTypes.length === 0) return null
    const job = await this.jobs.claimNext(workerId, leaseDurationMs, jobTypes)
    if (!job) return null
    const handler = this.handlers.get(job.jobType)
    if (!handler) return this.jobs.fail(job.id, workerId, new Error(`未注册作业处理器：${job.jobType}`))

    const heartbeatInterval = setInterval(() => {
      void this.jobs.heartbeat(job.id, workerId, leaseDurationMs).catch(() => undefined)
    }, Math.max(10, Math.floor(leaseDurationMs / 3)))
    heartbeatInterval.unref()
    try {
      const result = await handler(job)
      return this.jobs.complete(job.id, workerId, result ?? {})
    } catch (error) {
      return this.jobs.fail(job.id, workerId, error)
    } finally {
      clearInterval(heartbeatInterval)
    }
  }
}
