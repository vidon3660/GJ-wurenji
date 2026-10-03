import { describe, expect, it, vi } from "vitest"
import type { JobEntity } from "./job.entities.js"
import { SHOW_REPORT_GENERATE_JOB } from "./job-types.js"
import type { JobWorkerService, V3JobHandler } from "./job-worker.service.js"
import { ShowReportJobHandler } from "./show-report-job.handler.js"
import type { ShowReviewService } from "../show-review/show-review.service.js"

describe("show report job handler", () => {
  it("registers and delegates a valid report job", async () => {
    let registered: V3JobHandler | undefined
    const worker = { register: vi.fn((jobType: string, handler: V3JobHandler) => { registered = handler }) }
    const reviews = { generateReportFromJob: vi.fn().mockResolvedValue({ reportId: "report-1" }) }
    const handler = new ShowReportJobHandler(worker as unknown as JobWorkerService, reviews as unknown as ShowReviewService)

    handler.onModuleInit()
    expect(worker.register).toHaveBeenCalledWith(SHOW_REPORT_GENERATE_JOB, expect.any(Function))
    await expect(registered!({ payload: { projectId: "project-1", actorId: "teacher-1", format: "PDF" } } as JobEntity)).resolves.toEqual({ reportId: "report-1" })
    expect(reviews.generateReportFromJob).toHaveBeenCalledWith("project-1", "teacher-1", "PDF")
  })

  it("rejects an unsupported report format", async () => {
    let registered: V3JobHandler | undefined
    const worker = { register: (_jobType: string, handler: V3JobHandler) => { registered = handler } }
    const reviews = { generateReportFromJob: vi.fn() }
    new ShowReportJobHandler(worker as unknown as JobWorkerService, reviews as unknown as ShowReviewService).onModuleInit()

    await expect(registered!({ payload: { projectId: "project-1", actorId: "teacher-1", format: "HTML" } } as JobEntity)).rejects.toThrow("格式无效")
    expect(reviews.generateReportFromJob).not.toHaveBeenCalled()
  })
})

