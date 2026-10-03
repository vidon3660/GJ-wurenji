import { BadRequestException } from "@nestjs/common"
import type {
  QuestionAnswer,
  QuestionDefinition,
  QuestionDefinitionInput,
  QuestionDifficulty,
  QuestionEvidence,
  QuestionGradingRule,
  QuestionJudgment,
  ShowObjectiveMetricView
} from "@wurenji/shared"
import { questionDifficulties, questionTypes } from "@wurenji/shared"
import { canonicalJson } from "../v3/common/canonical-json.js"

export interface QuestionGradingResult {
  autoScore: number | null
  judgment: QuestionJudgment
  evidence: QuestionEvidence[]
}

export function normalizeQuestionDefinitions(value: unknown, requireAtLeastOne = false): QuestionDefinition[] {
  if (value === undefined || value === null) {
    if (requireAtLeastOne) throw new BadRequestException("题库至少需要包含一道题")
    return []
  }
  if (!Array.isArray(value)) throw new BadRequestException("题目列表必须为数组")
  if (value.length > 200) throw new BadRequestException("单个题库版本最多包含 200 道题")
  const codes = new Set<string>()
  const questions = value.map((raw, index) => {
    if (!isRecord(raw)) throw new BadRequestException(`第 ${index + 1} 道题格式无效`)
    const code = normalizeCode(raw.code, index)
    if (codes.has(code)) throw new BadRequestException(`题目编号重复：${code}`)
    codes.add(code)
    const type = normalizeQuestionType(raw.type, index)
    const difficulty = normalizeQuestionDifficulty(raw.difficulty, index)
    const knowledgePoints = normalizeKnowledgePoints(raw.knowledgePoints, index)
    const prompt = normalizeText(raw.prompt, `第 ${index + 1} 道题题干`, 2_000)
    const options = normalizeOptions(raw.options, type, index)
    const correctAnswer = normalizeAnswer(raw.correctAnswer, `第 ${index + 1} 道题正确答案`)
    assertCorrectAnswer(type, correctAnswer, options, index)
    const explanation = normalizeText(raw.explanation, `第 ${index + 1} 道题解析`, 3_000, "")
    const maxScore = normalizeScore(raw.maxScore, index)
    const stageCode = normalizeStageCode(raw.stageCode, index)
    const gradingRule = normalizeGradingRule(raw.gradingRule, type, index)
    assertExecutableGradingRule(type, correctAnswer, gradingRule, index)
    const sortOrder = normalizeSortOrder(raw.sortOrder, index)
    return { code, type, difficulty, knowledgePoints, prompt, options, correctAnswer, explanation, maxScore, stageCode, gradingRule, sortOrder }
  })
  if (requireAtLeastOne && questions.length === 0) throw new BadRequestException("题库至少需要包含一道题")
  return questions.sort((left, right) => left.sortOrder - right.sortOrder || left.code.localeCompare(right.code))
}

export function gradeQuestion(question: QuestionDefinition, answer: QuestionAnswer, metrics: readonly ShowObjectiveMetricView[]): QuestionGradingResult {
  if (question.gradingRule.kind === "METRIC_THRESHOLD") return gradeMetricThreshold(question, metrics)
  if (isEmptyAnswer(answer)) {
    return { autoScore: 0, judgment: "UNANSWERED", evidence: [{ source: "ANSWER", detail: "本题未作答" }] }
  }
  if (question.gradingRule.kind === "REQUIRED_FIELDS") return gradeRequiredFields(question, answer)
  const unordered = question.type === "MULTIPLE_CHOICE"
  const correct = canonicalJson(comparableAnswer(answer, unordered)) === canonicalJson(comparableAnswer(question.correctAnswer, unordered))
  return {
    autoScore: correct ? question.maxScore : 0,
    judgment: correct ? "CORRECT" : "INCORRECT",
    evidence: [{ source: "ANSWER", detail: correct ? "答案符合题目判定规则" : "答案不符合题目判定规则" }]
  }
}

function gradeRequiredFields(question: QuestionDefinition, answer: QuestionAnswer): QuestionGradingResult {
  if (!isRecord(answer)) {
    return { autoScore: 0, judgment: "INCORRECT", evidence: [{ source: "ANSWER", detail: "答案不是结构化字段对象" }] }
  }
  const fields = question.gradingRule.kind === "REQUIRED_FIELDS" ? question.gradingRule.fields : []
  const filled = fields.filter((field) => !isEmptyAnswer(answer[field]))
  const ratio = fields.length === 0 ? 0 : filled.length / fields.length
  const score = roundScore(question.maxScore * ratio)
  return {
    autoScore: score,
    judgment: filled.length === fields.length ? "CORRECT" : filled.length > 0 ? "PARTIAL" : "INCORRECT",
    evidence: [{ source: "ANSWER", detail: `已填写 ${filled.length}/${fields.length} 个必填字段` }]
  }
}

function gradeMetricThreshold(question: QuestionDefinition, metrics: readonly ShowObjectiveMetricView[]): QuestionGradingResult {
  const rule = question.gradingRule
  if (rule.kind !== "METRIC_THRESHOLD") return { autoScore: 0, judgment: "INCORRECT", evidence: [] }
  const metric = metrics.find((item) => item.code === rule.metricCode)
  if (!metric) {
    return {
      autoScore: null,
      judgment: "PENDING",
      evidence: [{ source: "PROJECT_EVALUATION", metricCode: rule.metricCode, detail: "尚未生成对应的仿真评价指标，等待系统补齐证据" }]
    }
  }
  const value = typeof metric.value === "number" ? metric.value : Number(metric.value)
  if (!Number.isFinite(value)) {
    return {
      autoScore: null,
      judgment: "PENDING",
      evidence: [{ source: "PROJECT_EVALUATION", metricCode: metric.code, metricLabel: metric.label, value: metric.value, displayValue: metric.displayValue, state: metric.state, detail: "评价指标不是可比较的数值" }]
    }
  }
  const threshold = rule.threshold
  const correct = rule.operator === "GTE"
    ? value >= threshold
    : rule.operator === "LTE"
      ? value <= threshold
      : value === threshold
  return {
    autoScore: correct ? question.maxScore : 0,
    judgment: correct ? "CORRECT" : "INCORRECT",
    evidence: [{
      source: "PROJECT_EVALUATION",
      metricCode: metric.code,
      metricLabel: metric.label,
      value: metric.value,
      displayValue: metric.displayValue,
      state: metric.state,
      detail: `仿真指标 ${metric.label}=${metric.displayValue}，判定阈值 ${operatorLabel(rule.operator)} ${threshold}`
    }]
  }
}

function normalizeCode(value: unknown, index: number): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : ""
  if (!code || code.length > 80 || !/^[A-Z0-9][A-Z0-9_-]*$/.test(code)) throw new BadRequestException(`第 ${index + 1} 道题编号无效`)
  return code
}

function normalizeQuestionType(value: unknown, index: number): QuestionDefinition["type"] {
  if (!questionTypes.includes(value as QuestionDefinition["type"])) throw new BadRequestException(`第 ${index + 1} 道题题型无效`)
  return value as QuestionDefinition["type"]
}

function normalizeQuestionDifficulty(value: unknown, index: number): QuestionDifficulty {
  if (value === undefined || value === null || value === "") return "BEGINNER"
  if (!questionDifficulties.includes(value as QuestionDifficulty)) throw new BadRequestException(`第 ${index + 1} 道题难度无效`)
  return value as QuestionDifficulty
}

function normalizeKnowledgePoints(value: unknown, index: number): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 20) throw new BadRequestException(`第 ${index + 1} 道题知识点无效`)
  const points = value.map((item) => typeof item === "string" ? item.trim() : "")
  if (points.some((item) => !item || item.length > 60) || new Set(points).size !== points.length) throw new BadRequestException(`第 ${index + 1} 道题知识点无效或重复`)
  return points
}

function normalizeOptions(value: unknown, type: QuestionDefinition["type"], index: number) {
  if (type === "TRUE_FALSE" && value === undefined) return [{ key: "TRUE", label: "正确" }, { key: "FALSE", label: "错误" }]
  if (!Array.isArray(value)) {
    if (type === "PLANNING" || type === "SCHEDULE" || type === "SCENARIO_DECISION" || type === "SIMULATION_EVIDENCE") return []
    throw new BadRequestException(`第 ${index + 1} 道题必须配置选项`)
  }
  if (value.length > 50) throw new BadRequestException(`第 ${index + 1} 道题选项过多`)
  const keys = new Set<string>()
  return value.map((option, optionIndex) => {
    if (!isRecord(option)) throw new BadRequestException(`第 ${index + 1} 道题第 ${optionIndex + 1} 个选项无效`)
    const key = typeof option.key === "string" ? option.key.trim() : ""
    const label = typeof option.label === "string" ? option.label.trim() : ""
    if (!key || key.length > 40 || keys.has(key)) throw new BadRequestException(`第 ${index + 1} 道题选项编号无效或重复`)
    if (!label || label.length > 200) throw new BadRequestException(`第 ${index + 1} 道题选项内容无效`)
    keys.add(key)
    return { key, label }
  })
}

function normalizeAnswer(value: unknown, label: string): QuestionAnswer {
  if (value === undefined) return null
  if (!isJsonValue(value)) throw new BadRequestException(`${label}必须是可保存的 JSON 值`)
  return value as QuestionAnswer
}

function assertCorrectAnswer(type: QuestionDefinition["type"], answer: QuestionAnswer, options: Array<{ key: string; label: string }>, index: number): void {
  if (type === "SINGLE_CHOICE" && (typeof answer !== "string" || !options.some((option) => option.key === answer))) throw new BadRequestException(`第 ${index + 1} 道单选题正确答案无效`)
  if (type === "MULTIPLE_CHOICE" && (!Array.isArray(answer) || answer.length === 0 || answer.some((item) => typeof item !== "string" || !options.some((option) => option.key === item)) || new Set(answer).size !== answer.length)) throw new BadRequestException(`第 ${index + 1} 道多选题正确答案无效`)
  if (type === "TRUE_FALSE" && typeof answer !== "boolean" && answer !== "TRUE" && answer !== "FALSE") throw new BadRequestException(`第 ${index + 1} 道判断题正确答案无效`)
}

function normalizeGradingRule(value: unknown, type: QuestionDefinition["type"], index: number): QuestionGradingRule {
  if (value === undefined || value === null) return { kind: "EXACT" }
  if (!isRecord(value) || typeof value.kind !== "string") throw new BadRequestException(`第 ${index + 1} 道题评分规则无效`)
  if (value.kind === "EXACT") return { kind: "EXACT" }
  if (value.kind === "REQUIRED_FIELDS") {
    if (type !== "PLANNING" && type !== "SCHEDULE" && type !== "SCENARIO_DECISION") throw new BadRequestException(`第 ${index + 1} 道题的必填字段规则仅适用于规划、时刻表或场景决策题`)
    if (!Array.isArray(value.fields) || value.fields.length === 0 || value.fields.length > 50) throw new BadRequestException(`第 ${index + 1} 道题必须配置必填字段`)
    const fields = value.fields.map((field) => typeof field === "string" ? field.trim() : "")
    if (fields.some((field) => !field || field.length > 80) || new Set(fields).size !== fields.length) throw new BadRequestException(`第 ${index + 1} 道题必填字段无效`)
    return { kind: "REQUIRED_FIELDS", fields }
  }
  if (value.kind === "METRIC_THRESHOLD") {
    if (type !== "SIMULATION_EVIDENCE") throw new BadRequestException(`第 ${index + 1} 道题的指标阈值规则仅适用于仿真证据题`)
    const metricCode = typeof value.metricCode === "string" ? value.metricCode.trim() : ""
    const operator = value.operator === "GTE" || value.operator === "LTE" || value.operator === "EQ" ? value.operator : null
    const threshold = Number(value.threshold)
    if (!metricCode || metricCode.length > 80 || !operator || !Number.isFinite(threshold)) throw new BadRequestException(`第 ${index + 1} 道题指标阈值规则无效`)
    return { kind: "METRIC_THRESHOLD", metricCode, operator, threshold }
  }
  throw new BadRequestException(`第 ${index + 1} 道题评分规则类型无效`)
}

function assertExecutableGradingRule(type: QuestionDefinition["type"], correctAnswer: QuestionAnswer, gradingRule: QuestionGradingRule, index: number): void {
  if (type === "SIMULATION_EVIDENCE" && gradingRule.kind !== "METRIC_THRESHOLD") {
    throw new BadRequestException(`第 ${index + 1} 道仿真证据题必须配置指标阈值规则`)
  }
  if ((type === "PLANNING" || type === "SCHEDULE" || type === "SCENARIO_DECISION") && gradingRule.kind === "EXACT" && correctAnswer === null) {
    throw new BadRequestException(`第 ${index + 1} 道规划、时刻表或场景决策题必须配置必填字段规则或结构化正确答案`)
  }
}

function normalizeScore(value: unknown, index: number): number {
  const score = value === undefined ? 10 : Number(value)
  if (!Number.isFinite(score) || score <= 0 || score > 1_000) throw new BadRequestException(`第 ${index + 1} 道题分值无效`)
  return roundScore(score)
}

function normalizeSortOrder(value: unknown, index: number): number {
  const order = value === undefined ? index + 1 : Number(value)
  if (!Number.isInteger(order) || order < 1 || order > 10_000) throw new BadRequestException(`第 ${index + 1} 道题顺序无效`)
  return order
}

function normalizeStageCode(value: unknown, index: number): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || value.trim().length > 60) throw new BadRequestException(`第 ${index + 1} 道题阶段编号无效`)
  return value.trim()
}

function normalizeText(value: unknown, label: string, maximum: number, fallback?: string): string {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback
  const text = typeof value === "string" ? value.trim() : ""
  if (!text || text.length > maximum) throw new BadRequestException(`${label}不能为空且不能超过 ${maximum} 个字符`)
  return text
}

function comparableAnswer(value: QuestionAnswer, unordered: boolean): unknown {
  if (value === "TRUE") return true
  if (value === "FALSE") return false
  if (unordered && Array.isArray(value)) return [...value].sort()
  return value
}

function isEmptyAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (isRecord(value)) return Object.keys(value).length === 0
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (isRecord(value)) return Object.values(value).every(isJsonValue)
  return false
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100
}

function operatorLabel(operator: "GTE" | "LTE" | "EQ"): string {
  return operator === "GTE" ? ">=" : operator === "LTE" ? "<=" : "="
}
