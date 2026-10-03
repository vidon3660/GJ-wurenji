import { ConflictException, NotFoundException } from "@nestjs/common"
import { vtlStageCodes, type StudentProjectStatus, type VtlStageCode } from "@wurenji/shared"
import type { EntityManager } from "typeorm"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"

export function openVtlStageCodes(project: StudentProjectEntity): VtlStageCode[] {
  const configured = project.snapshot.config.vtlParameters?.openStageCodes
  return configured?.length ? [...configured] : [...vtlStageCodes]
}

export function configuredMainLandingSiteId(project: StudentProjectEntity): string {
  const value = project.snapshot.config.vtlParameters?.mainLandingSiteId?.trim()
  if (!value) throw new ConflictException("任务快照缺少教师选择的主起降点")
  return value
}

export async function completeVtlStage(
  manager: EntityManager,
  project: StudentProjectEntity,
  currentCode: VtlStageCode,
  nextProjectStatus: StudentProjectStatus = "IN_PROGRESS"
): Promise<VtlStageCode | null> {
  const codes = openVtlStageCodes(project)
  const currentIndex = codes.indexOf(currentCode)
  if (currentIndex < 0) throw new NotFoundException("当前垂起巡检阶段未在任务中开放")
  const current = await manager.findOne(StudentProjectStageEntity, {
    where: { project: { id: project.id }, stageCode: currentCode },
    lock: { mode: "pessimistic_write" }
  })
  if (!current) throw new NotFoundException("当前垂起巡检阶段不存在")
  if (current.status !== "IN_PROGRESS") throw new ConflictException("请先开始当前垂起巡检阶段")

  const now = new Date()
  current.status = "ACCEPTED"
  current.submittedAt = now
  current.acceptedAt = now
  current.returnedAt = null
  current.revision += 1

  const nextCode = codes[currentIndex + 1] ?? null
  if (!nextCode) {
    project.currentStageCode = currentCode
    project.status = "SUBMITTED"
    if (project.snapshot.mode === "ASSESSMENT") {
      project.assessmentSubmittedAt ??= now
      project.assessmentEndedAt ??= now
    }
    project.lastActivityAt = now
    await manager.save([current, project])
    return null
  }

  const next = await manager.findOne(StudentProjectStageEntity, {
    where: { project: { id: project.id }, stageCode: nextCode },
    lock: { mode: "pessimistic_write" }
  })
  if (!next) throw new NotFoundException("下一垂起巡检阶段不存在")
  if (next.status === "LOCKED") {
    next.status = "AVAILABLE"
    next.revision += 1
  }
  project.currentStageCode = nextCode
  project.status = nextProjectStatus
  project.lastActivityAt = now
  await manager.save([current, next, project])
  return nextCode
}
