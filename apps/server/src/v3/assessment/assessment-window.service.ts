import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import type { AuthUser } from "@wurenji/shared"
import { Repository } from "typeorm"
import { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { buildAssessmentTimingView, decideAssessmentStart } from "./assessment-timing.js"

export function assessmentTimingForProject(project: StudentProjectEntity, now = new Date()) {
  return buildAssessmentTimingView({
    mode: project.snapshot.mode,
    config: assessmentConfigForProject(project),
    assessmentStartedAt: project.assessmentStartedAt,
    assessmentDeadlineAt: project.assessmentDeadlineAt,
    assessmentSubmittedAt: project.assessmentSubmittedAt,
    assessmentEndedAt: project.assessmentEndedAt
  }, now)
}

@Injectable()
export class AssessmentWindowService {
  constructor(@InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>) {}

  timing(project: StudentProjectEntity, now = new Date()) {
    return assessmentTimingForProject(project, now)
  }

  start(project: StudentProjectEntity, now = new Date()): void {
    const decision = decideAssessmentStart(this.source(project), now)
    if (!decision.allowed) throw new ConflictException(decision.message)
    if (project.snapshot.mode !== "ASSESSMENT") return
    project.assessmentStartedAt ??= decision.startedAt
    project.assessmentDeadlineAt ??= decision.deadlineAt
  }

  submit(project: StudentProjectEntity, now = new Date()): void {
    if (project.snapshot.mode !== "ASSESSMENT") return
    project.assessmentSubmittedAt ??= now
    project.assessmentEndedAt ??= now
  }

  end(project: StudentProjectEntity, endedAt = new Date()): void {
    if (project.snapshot.mode !== "ASSESSMENT" || project.assessmentEndedAt) return
    project.assessmentEndedAt = project.assessmentDeadlineAt && project.assessmentDeadlineAt.getTime() < endedAt.getTime()
      ? project.assessmentDeadlineAt
      : endedAt
  }

  async synchronize(projects: StudentProjectEntity[], now = new Date()): Promise<void> {
    const expired = projects.filter((project) => this.synchronizeOne(project, now))
    if (expired.length > 0) await this.projects.save(expired)
  }

  async assertWritable(projectId: string, user: AuthUser, allowStart: boolean): Promise<void> {
    const project = await this.projects.findOne({ where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (project.student.id !== user.id) throw new ForbiddenException("无权操作该学生项目")
    if (project.snapshot.mode !== "ASSESSMENT") return
    const timing = this.timing(project)
    if (timing.state === "EXPIRED" && this.synchronizeOne(project, new Date(timing.serverNow))) await this.projects.save(project)
    if (timing.canWrite || allowStart && timing.canStart) return
    throw new ConflictException(timing.blockedReason ?? "当前考核项目不能继续操作")
  }

  private synchronizeOne(project: StudentProjectEntity, now: Date): boolean {
    const timing = this.timing(project, now)
    if (project.snapshot.mode !== "ASSESSMENT" || timing.state !== "EXPIRED") return false
    let changed = false
    if (!project.assessmentDeadlineAt && timing.deadlineAt) {
      project.assessmentDeadlineAt = new Date(timing.deadlineAt)
      changed = true
    }
    if (!project.assessmentEndedAt && timing.endedAt) {
      project.assessmentEndedAt = new Date(timing.endedAt)
      changed = true
    }
    return changed
  }

  private source(project: StudentProjectEntity) {
    return {
      mode: project.snapshot.mode,
      config: assessmentConfigForProject(project),
      assessmentStartedAt: project.assessmentStartedAt,
      assessmentDeadlineAt: project.assessmentDeadlineAt,
      assessmentSubmittedAt: project.assessmentSubmittedAt,
      assessmentEndedAt: project.assessmentEndedAt
    }
  }
}

function assessmentConfigForProject(project: StudentProjectEntity) {
  return {
    ...project.snapshot.config,
    availableAt: project.assessmentAvailableAtOverride?.toISOString() ?? project.snapshot.config.availableAt,
    dueAt: project.assessmentDueAtOverride?.toISOString() ?? project.snapshot.config.dueAt
  }
}
