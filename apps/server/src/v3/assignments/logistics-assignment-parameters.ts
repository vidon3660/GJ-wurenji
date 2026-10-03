import { BadRequestException } from "@nestjs/common"
import type { AssignmentDraftConfig, LogisticsAssignmentParameters } from "@wurenji/shared"

export function normalizeLogisticsAssignmentParameters(
  value: unknown,
  fallback: { taskBrief: string; availableAt: string; dueAt: string }
): LogisticsAssignmentParameters {
  if (value === undefined || value === null) {
    return {
      projectBackground: fallback.taskBrief,
      completionRequirements: fallback.taskBrief,
      plannedStartAt: fallback.availableAt,
      plannedEndAt: fallback.dueAt
    }
  }
  if (!isRecord(value)) throw new BadRequestException("物流任务项目条件格式无效")
  const plannedStartAt = date(value.plannedStartAt, "计划运行开始时间")
  const plannedEndAt = date(value.plannedEndAt, "计划运行结束时间")
  if (Date.parse(plannedStartAt) >= Date.parse(plannedEndAt)) throw new BadRequestException("计划运行结束时间必须晚于开始时间")
  return {
    projectBackground: requiredText(value.projectBackground, 2000, "项目背景"),
    completionRequirements: requiredText(value.completionRequirements, 2000, "完成要求"),
    plannedStartAt,
    plannedEndAt
  }
}

export function resolveLogisticsAssignmentParameters(config: AssignmentDraftConfig): LogisticsAssignmentParameters {
  return config.logisticsParameters ?? {
    projectBackground: config.taskBrief,
    completionRequirements: config.taskBrief,
    plannedStartAt: config.availableAt,
    plannedEndAt: config.dueAt
  }
}

function requiredText(value: unknown, maximumLength: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximumLength) {
    throw new BadRequestException(`${label}不能为空且不能超过 ${maximumLength} 个字符`)
  }
  return value.trim()
}

function date(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new BadRequestException(`${label}无效`)
  return new Date(value).toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
