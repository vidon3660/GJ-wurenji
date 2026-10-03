import { BadRequestException } from "@nestjs/common"
import type { AssignmentDraftConfig, ShowAssignmentParameters } from "@wurenji/shared"

export function normalizeShowAssignmentParameters(value: unknown): ShowAssignmentParameters {
  if (!isRecord(value)) throw new BadRequestException("表演任务必须填写完整项目条件")
  const projectBackground = requiredText(value.projectBackground, 2000, "项目背景")
  const completionRequirements = requiredText(value.completionRequirements, 2000, "完成要求")
  const plannedStartAt = date(value.plannedStartAt, "计划表演开始时间")
  const plannedEndAt = date(value.plannedEndAt, "计划表演结束时间")
  if (Date.parse(plannedStartAt) >= Date.parse(plannedEndAt)) throw new BadRequestException("计划表演结束时间必须晚于开始时间")
  return {
    projectBackground,
    completionRequirements,
    plannedStartAt,
    plannedEndAt,
    plannedAudienceCount: integer(value.plannedAudienceCount, 1, 1_000_000, "计划观众数量"),
    maximumHeightMeters: number(value.maximumHeightMeters, 10, 500, "最大飞行高度"),
    contactName: requiredText(value.contactName, 80, "现场联系人"),
    contactPhone: requiredText(value.contactPhone, 40, "联系电话"),
    aircraftModel: requiredText(value.aircraftModel, 80, "无人机型号")
  }
}

export function resolveShowAssignmentParameters(config: AssignmentDraftConfig): ShowAssignmentParameters {
  const value = config.showParameters
  if (value) return value
  const scenario = config.scenario
  const plannedStartAt = validDate(scenario.plannedFlightStartAt) ?? config.availableAt
  const plannedEndAt = validDate(scenario.plannedFlightEndAt) ?? config.dueAt
  return {
    projectBackground: text(scenario.projectBackground) ?? config.taskBrief,
    completionRequirements: text(scenario.completionRequirements) ?? config.taskBrief,
    plannedStartAt,
    plannedEndAt: Date.parse(plannedEndAt) > Date.parse(plannedStartAt) ? plannedEndAt : config.dueAt,
    plannedAudienceCount: validInteger(scenario.plannedAudienceCount, 1, 1_000_000) ?? 1,
    maximumHeightMeters: validNumber(scenario.maximumHeightMeters, 10, 500) ?? 120,
    contactName: text(scenario.contactName) ?? "未设置",
    contactPhone: text(scenario.contactPhone) ?? "未设置",
    aircraftModel: text(scenario.aircraftModel) ?? "教学统一编队无人机"
  }
}

function requiredText(value: unknown, maximumLength: number, label: string): string {
  const normalized = text(value)
  if (!normalized || normalized.length > maximumLength) throw new BadRequestException(`${label}不能为空且不能超过 ${maximumLength} 个字符`)
  return normalized
}

function date(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new BadRequestException(`${label}无效`)
  return new Date(value).toISOString()
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) throw new BadRequestException(`${label}必须在 ${minimum} 到 ${maximum} 之间`)
  return normalized
}

function number(value: unknown, minimum: number, maximum: number, label: string): number {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized < minimum || normalized > maximum) throw new BadRequestException(`${label}必须在 ${minimum} 到 ${maximum} 之间`)
  return normalized
}

function validDate(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}

function validInteger(value: unknown, minimum: number, maximum: number): number | null {
  const normalized = Number(value)
  return Number.isInteger(normalized) && normalized >= minimum && normalized <= maximum ? normalized : null
}

function validNumber(value: unknown, minimum: number, maximum: number): number | null {
  const normalized = Number(value)
  return Number.isFinite(normalized) && normalized >= minimum && normalized <= maximum ? normalized : null
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
