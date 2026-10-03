import { Injectable, OnModuleInit } from "@nestjs/common"
import { ShowReviewService } from "../show-review/show-review.service.js"
import type { JobEntity } from "./job.entities.js"
import { SHOW_REPORT_GENERATE_JOB } from "./job-types.js"
import { JobWorkerService } from "./job-worker.service.js"

@Injectable()
export class ShowReportJobHandler implements OnModuleInit {
  constructor(
    private readonly worker: JobWorkerService,
    private readonly reviews: ShowReviewService
  ) {}

  onModuleInit(): void {
    this.worker.register(SHOW_REPORT_GENERATE_JOB, (job) => this.handle(job))
  }

  private async handle(job: JobEntity): Promise<Record<string, unknown>> {
    const projectId = requiredString(job.payload.projectId, "projectId")
    const actorId = requiredString(job.payload.actorId, "actorId")
    if (job.payload.format !== "DOCX" && job.payload.format !== "PDF") throw new Error("报告作业格式无效")
    const format = job.payload.format
    return this.reviews.generateReportFromJob(projectId, actorId, format)
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`报告作业缺少 ${field}`)
  return value
}
