import { describe, expect, it, vi } from "vitest"
import type { JobEntity } from "./job.entities.js"
import type { JobQueueService } from "./job-queue.service.js"
import { JobWorkerService } from "./job-worker.service.js"

describe("job worker registry", () => {
  it("does not claim jobs before a handler is registered", async () => {
    const jobs = queueMock()
    const worker = new JobWorkerService(jobs as unknown as JobQueueService)

    await expect(worker.runOnce("worker-test")).resolves.toBeNull()
    expect(jobs.claimNext).not.toHaveBeenCalled()
  })

  it("claims only registered job types and completes the result", async () => {
    const job = { id: "job-1", jobType: "REPORT", payload: {} } as JobEntity
    const jobs = queueMock(job)
    const worker = new JobWorkerService(jobs as unknown as JobQueueService)
    worker.register("REPORT", async () => ({ reportId: "report-1" }))

    await expect(worker.runOnce("worker-test", 1_000)).resolves.toMatchObject({ status: "SUCCEEDED" })
    expect(jobs.claimNext).toHaveBeenCalledWith("worker-test", 1_000, ["REPORT"])
    expect(jobs.complete).toHaveBeenCalledWith("job-1", "worker-test", { reportId: "report-1" })
  })
})

function queueMock(job: JobEntity | null = null) {
  return {
    claimNext: vi.fn().mockResolvedValue(job),
    heartbeat: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue({ ...job, status: "SUCCEEDED" }),
    fail: vi.fn()
  }
}

