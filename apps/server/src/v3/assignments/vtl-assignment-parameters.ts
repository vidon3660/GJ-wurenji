import { BadRequestException } from "@nestjs/common"
import { vtlStageCodes, type AssignmentDraftConfig, type VtlAssignmentParameters, type VtlEvaluationItemConfig } from "@wurenji/shared"

export function normalizeVtlAssignmentParameters(
  input: Partial<VtlAssignmentParameters> | undefined,
  context: Pick<AssignmentDraftConfig, "taskBrief" | "availableAt" | "dueAt">
): VtlAssignmentParameters {
  const projectBackground = text(input?.projectBackground, "巡检项目背景", 2_000) || context.taskBrief
  const completionRequirements = text(input?.completionRequirements, "完成要求", 2_000) || "完成任务分区、航线剖面、执行计划、运行处置和巡检复盘"
  const plannedStartAt = date(input?.plannedStartAt, "计划开始时间", context.availableAt)
  const plannedEndAt = date(input?.plannedEndAt, "计划结束时间", context.dueAt)
  if (Date.parse(plannedStartAt) >= Date.parse(plannedEndAt)) throw new BadRequestException("垂起巡检计划结束时间必须晚于开始时间")
  const mainLandingSiteId = text(input?.mainLandingSiteId, "主起降点", 120) || "VTL-MAIN-01"
  const aircraftModelCode = text(input?.aircraftModelCode, "机型代码", 120) || "VTOL-TEACHING-01"
  const aircraftParameterVersion = text(input?.aircraftParameterVersion, "机型参数版本", 80) || "1.0.0"
  const taskObjectIds = input?.taskObjectIds === undefined ? undefined : stringIds(input.taskObjectIds, "巡检任务对象")
  const taskAreaBoundary = input?.taskAreaBoundary === undefined ? undefined : coordinates(input.taskAreaBoundary, "任务区域")
  const openStageCodes = input?.openStageCodes === undefined ? [...vtlStageCodes] : stageCodes(input.openStageCodes)
  const evaluationItems = input?.evaluationItems === undefined ? undefined : evaluation(input.evaluationItems)
  return {
    projectBackground,
    completionRequirements,
    plannedStartAt,
    plannedEndAt,
    mainLandingSiteId,
    aircraftModelCode,
    aircraftParameterVersion,
    ...(taskObjectIds ? { taskObjectIds } : {}),
    ...(taskAreaBoundary ? { taskAreaBoundary } : {}),
    openStageCodes,
    ...(evaluationItems ? { evaluationItems } : {})
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new BadRequestException(`${label}格式无效`)
  const result = value.trim()
  if (result.length > maximum) throw new BadRequestException(`${label}不能超过 ${maximum} 个字符`)
  return result
}

function date(value: unknown, label: string, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new BadRequestException(`${label}格式无效`)
  return new Date(value).toISOString()
}

function stringIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) throw new BadRequestException(`${label}必须包含 1 到 30 项`)
  const ids = value.map((item) => typeof item === "string" ? item.trim() : "")
  if (ids.some((id) => !id || id.length > 160) || new Set(ids).size !== ids.length) throw new BadRequestException(`${label}标识无效或重复`)
  return ids
}

function coordinates(value: unknown, label: string): NonNullable<VtlAssignmentParameters["taskAreaBoundary"]> {
  if (!Array.isArray(value) || value.length < 3 || value.length > 100) throw new BadRequestException(`${label}至少需要 3 个坐标点`)
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BadRequestException(`${label}坐标无效`)
    const record = item as Record<string, unknown>
    const longitude = Number(record.longitude)
    const latitude = Number(record.latitude)
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new BadRequestException(`${label}坐标无效`)
    return { longitude, latitude }
  })
}

function stageCodes(value: unknown): NonNullable<VtlAssignmentParameters["openStageCodes"]> {
  if (!Array.isArray(value) || value.length === 0) throw new BadRequestException("开放步骤不能为空")
  const codes = value.map((item) => typeof item === "string" ? item.trim() : "")
  if (codes.some((code) => !(vtlStageCodes as readonly string[]).includes(code)) || new Set(codes).size !== codes.length) throw new BadRequestException("垂起巡检开放步骤无效或重复")
  if (codes.some((code, index) => code !== vtlStageCodes[index])) throw new BadRequestException("垂起巡检开放步骤必须按教学顺序连续开放")
  return codes as NonNullable<VtlAssignmentParameters["openStageCodes"]>
}

function evaluation(value: unknown): VtlEvaluationItemConfig[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) throw new BadRequestException("巡检评价项目必须包含 1 到 20 项")
  const items = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new BadRequestException(`第 ${index + 1} 个评价项目格式无效`)
    const record = item as Record<string, unknown>
    const code = typeof record.code === "string" ? record.code.trim() : ""
    const label = typeof record.label === "string" ? record.label.trim() : ""
    const maxScore = Number(record.maxScore)
    const description = record.description === undefined ? undefined : typeof record.description === "string" ? record.description.trim() : ""
    if (!/^[A-Z][A-Z0-9_:-]{0,79}$/.test(code) || !label || label.length > 160 || !Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 100 || (description !== undefined && description.length > 500)) throw new BadRequestException(`第 ${index + 1} 个评价项目无效`)
    return { code, label, maxScore: Math.round(maxScore * 10) / 10, ...(description ? { description } : {}) }
  })
  if (new Set(items.map((item) => item.code)).size !== items.length) throw new BadRequestException("巡检评价项目代码不能重复")
  if (Math.abs(items.reduce((sum, item) => sum + item.maxScore, 0) - 100) > 1e-9) throw new BadRequestException("巡检评价项目总分必须为 100")
  return items
}
