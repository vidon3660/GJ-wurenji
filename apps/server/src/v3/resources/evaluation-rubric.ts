import type { SceneType, ShowTeacherScoreView } from "@wurenji/shared"
import { BadRequestException } from "@nestjs/common"

export interface EvaluationRubricItemDefinition {
  code: string
  label: string
  maxScore: number
  sourceReferences: string[]
}

export interface EvaluationRubricDefinition {
  sceneType: SceneType
  version: string
  title: string
  sourceReferences: string[]
  items: EvaluationRubricItemDefinition[]
}

export interface EvaluationRubricInspection {
  rubrics: EvaluationRubricDefinition[]
  errors: string[]
  declared: boolean
}

const defaultRubrics: Record<SceneType, EvaluationRubricDefinition> = {
  CITY_SHOW: {
    sceneType: "CITY_SHOW",
    version: "1.1.0",
    title: "城市无人机编队表演综合评价量表",
    sourceReferences: ["TEA-024", "需求规格说明书 12.2", "需求规格说明书 13.2", "需求规格说明书 13.3"],
    items: [
      item("AREA_PLANNING", "区域规划", 15, "TEA-024 区域规划"),
      item("FLIGHT_APPLICATION", "申报文件内容", 15, "TEA-024 文件内容"),
      item("PREFLIGHT_REPORTING", "飞前判断与动态报备", 15, "TEA-024 飞前判断"),
      item("RISK_DECISION", "运行风险识别与决策", 25, "TEA-024 运行处置"),
      item("PROCEDURE_RESULT", "运行处置流程与结果", 15, "TEA-024 运行处置"),
      item("REVIEW_QUALITY", "飞后运行分析质量", 15, "需求规格说明书 13.3")
    ]
  },
  CITY_LOGISTICS: {
    sceneType: "CITY_LOGISTICS",
    version: "1.0.0",
    title: "城市低空物流综合评价量表",
    sourceReferences: ["TEA-028", "需求规格说明书 12.1", "需求规格说明书 12.2", "需求规格说明书 13.2", "需求规格说明书 13.3"],
    items: [
      item("REGION_ROUTE_PLANNING", "区域与航线规划", 20, "TEA-028 区域与航线规划"),
      item("ROUTE_VALIDATION", "航线验证与风险识别", 15, "需求规格说明书 12.1"),
      item("ORDER_SCHEDULING", "订单与机群调度", 20, "TEA-028 订单与调度"),
      item("RUNTIME_MONITORING", "运行监控与时序管理", 15, "需求规格说明书 12.2"),
      item("EMERGENCY_RESOLUTION", "应急处置与动态重调度", 20, "需求规格说明书 13.2"),
      item("REVIEW_QUALITY", "运行结果分析与改进建议", 10, "需求规格说明书 13.3")
    ]
  },
  VTOL_INSPECTION: {
    sceneType: "VTOL_INSPECTION",
    version: "1.0.0",
    title: "垂起广域巡检综合评价量表",
    sourceReferences: ["VTL-008", "需求规格说明书 4.4.8", "需求规格说明书 13.2", "需求规格说明书 13.3"],
    items: [
      item("AREA_ALLOCATION", "任务区与对象分配", 15, "VTL-002/VTL-003"),
      item("ROUTE_PROFILE", "航线、转换与地形剖面", 20, "VTL-004"),
      item("ENERGY_DECISION", "能量与备降判断", 15, "VTL-004/VTL-005"),
      item("EXECUTION_PLAN", "检查与执行计划", 15, "VTL-005"),
      item("RUNTIME_MONITORING", "三级态势与运行观察", 15, "VTL-006"),
      item("EMERGENCY_REORGANIZATION", "事件处置与集群重组", 10, "VTL-007"),
      item("REVIEW_QUALITY", "巡检结果分析质量", 10, "VTL-008")
    ]
  }
}

export function inspectEvaluationRubrics(content: unknown): EvaluationRubricInspection {
  if (!isPlainObject(content) || content.rubrics === undefined) return { rubrics: [], errors: [], declared: false }
  if (!Array.isArray(content.rubrics)) return { rubrics: [], errors: ["/rubrics must be an array"], declared: true }
  const errors: string[] = []
  const rubrics = content.rubrics.flatMap((value, rubricIndex) => {
    const path = `/rubrics/${rubricIndex}`
    if (!isPlainObject(value)) {
      errors.push(`${path} must be an object`)
      return []
    }
    const sceneType = value.sceneType
    const version = stringValue(value.version)
    const title = stringValue(value.title)
    const sourceReferences = stringArray(value.sourceReferences, `${path}/sourceReferences`, errors)
    const itemValues = value.items
    if (sceneType !== "CITY_SHOW" && sceneType !== "CITY_LOGISTICS" && sceneType !== "VTOL_INSPECTION") errors.push(`${path}/sceneType is invalid`)
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) errors.push(`${path}/version must be a semantic version`)
    if (!title || title.length > 160) errors.push(`${path}/title must contain 1 to 160 characters`)
    if (!Array.isArray(itemValues) || itemValues.length === 0 || itemValues.length > 50) {
      errors.push(`${path}/items must contain 1 to 50 entries`)
      return []
    }
    const items = itemValues.flatMap((itemValue, itemIndex) => parseItem(itemValue, `${path}/items/${itemIndex}`, errors))
    const duplicateCodes = duplicates(items.map((definition) => definition.code))
    if (duplicateCodes.length > 0) errors.push(`${path}/items contains duplicate codes: ${duplicateCodes.join(", ")}`)
    const totalScore = items.reduce((sum, definition) => sum + definition.maxScore, 0)
    if (items.length === itemValues.length && Math.abs(totalScore - 100) > 1e-9) errors.push(`${path}/items maxScore total must equal 100`)
    if (
      (sceneType !== "CITY_SHOW" && sceneType !== "CITY_LOGISTICS" && sceneType !== "VTOL_INSPECTION")
      || !version || !title || sourceReferences.length === 0 || items.length !== itemValues.length
    ) return []
    return [{ sceneType: sceneType as SceneType, version, title, sourceReferences, items }]
  })
  const duplicateScenes = duplicates(rubrics.map((definition) => definition.sceneType))
  if (duplicateScenes.length > 0) errors.push(`/rubrics contains duplicate sceneType values: ${duplicateScenes.join(", ")}`)
  return { rubrics, errors, declared: true }
}

export function defaultEvaluationRubric(sceneType: SceneType): EvaluationRubricDefinition {
  return cloneRubric(defaultRubrics[sceneType])
}

export function teacherScoresFromRubric(rubric: EvaluationRubricDefinition): ShowTeacherScoreView[] {
  return rubric.items.map(({ code, label, maxScore }) => ({ code, label, maxScore, score: null, comment: "" }))
}

export function rubricFromContent(sceneType: SceneType, content: unknown): { rubric: EvaluationRubricDefinition; resourceDefined: boolean } {
  const inspection = inspectEvaluationRubrics(content)
  if (inspection.errors.length > 0) throw new Error(inspection.errors.join("; "))
  if (!inspection.declared) return { rubric: defaultEvaluationRubric(sceneType), resourceDefined: false }
  const rubric = inspection.rubrics.find((definition) => definition.sceneType === sceneType)
  if (!rubric) throw new Error(`REPORT resource does not define a rubric for ${sceneType}`)
  return { rubric: cloneRubric(rubric), resourceDefined: true }
}

export function normalizeFrozenTeacherScores(
  input: ShowTeacherScoreView[] | undefined,
  current: ShowTeacherScoreView[]
): ShowTeacherScoreView[] {
  assertFrozenRubric(current)
  const byCode = new Map((input ?? current).map((definition) => [definition.code, definition]))
  return current.map((definition) => {
    const item = byCode.get(definition.code)
    const score = item?.score === null || item?.score === undefined ? null : Number(item.score)
    if (score !== null && (!Number.isFinite(score) || score < 0 || score > definition.maxScore)) {
      throw new BadRequestException(`${definition.label}评分必须在 0 至 ${definition.maxScore} 之间`)
    }
    const comment = item?.comment?.trim() ?? ""
    if (comment.length > 1_000) throw new BadRequestException("分项意见不能超过 1000 个字符")
    return { ...definition, score: score === null ? null : round(score, 1), comment }
  })
}

export function frozenTeacherScoresComplete(scores: ShowTeacherScoreView[]): boolean {
  try {
    assertFrozenRubric(scores)
  } catch {
    return false
  }
  return scores.every((item) => typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= item.maxScore)
}

export function totalFrozenTeacherScore(scores: ShowTeacherScoreView[]): number | null {
  return frozenTeacherScoresComplete(scores) ? round(scores.reduce((sum, item) => sum + Number(item.score), 0), 1) : null
}

export function teacherEvaluationContentBlockedReason(scores: ShowTeacherScoreView[], summary: string): string | null {
  const completedCount = scores.filter((item) => typeof item.score === "number" && Number.isFinite(item.score) && item.score >= 0 && item.score <= item.maxScore).length
  if (!frozenTeacherScoresComplete(scores)) return `请完成全部分项评分（已完成 ${completedCount}/${scores.length}）`
  const summaryLength = summary.trim().length
  if (summaryLength < 10) return `综合讲评至少 10 个字符（当前 ${summaryLength} 个）`
  return null
}

function assertFrozenRubric(scores: ShowTeacherScoreView[]): void {
  if (scores.length === 0 || new Set(scores.map((item) => item.code)).size !== scores.length) throw new BadRequestException("冻结评价量表无效")
  if (scores.some((item) => !item.code || !item.label || !Number.isFinite(item.maxScore) || item.maxScore <= 0)) throw new BadRequestException("冻结评价量表无效")
  if (Math.abs(scores.reduce((sum, item) => sum + item.maxScore, 0) - 100) > 1e-9) throw new BadRequestException("冻结评价量表总分必须为 100")
}

function parseItem(value: unknown, path: string, errors: string[]): EvaluationRubricItemDefinition[] {
  if (!isPlainObject(value)) {
    errors.push(`${path} must be an object`)
    return []
  }
  const code = stringValue(value.code)
  const label = stringValue(value.label)
  const maxScore = Number(value.maxScore)
  const sourceReferences = stringArray(value.sourceReferences, `${path}/sourceReferences`, errors)
  if (!/^[A-Z][A-Z0-9_:-]{0,79}$/.test(code)) errors.push(`${path}/code is invalid`)
  if (!label || label.length > 160) errors.push(`${path}/label must contain 1 to 160 characters`)
  if (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 100) errors.push(`${path}/maxScore must be greater than 0 and no more than 100`)
  if (!code || !label || !Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 100 || sourceReferences.length === 0) return []
  return [{ code, label, maxScore, sourceReferences }]
}

function stringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    errors.push(`${path} must contain 1 to 30 entries`)
    return []
  }
  const strings = value.map(stringValue)
  if (strings.some((entry) => !entry || entry.length > 240)) {
    errors.push(`${path} entries must contain 1 to 240 characters`)
    return []
  }
  return strings
}

function item(code: string, label: string, maxScore: number, sourceReference: string): EvaluationRubricItemDefinition {
  return { code, label, maxScore, sourceReferences: [sourceReference] }
}

function cloneRubric(rubric: EvaluationRubricDefinition): EvaluationRubricDefinition {
  return {
    ...rubric,
    sourceReferences: [...rubric.sourceReferences],
    items: rubric.items.map((definition) => ({ ...definition, sourceReferences: [...definition.sourceReferences] }))
  }
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicateValues = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicateValues.add(value)
    seen.add(value)
  }
  return [...duplicateValues]
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
