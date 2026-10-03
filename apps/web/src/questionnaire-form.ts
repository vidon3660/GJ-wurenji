import type { QuestionAnswer, QuestionView } from "@wurenji/shared"

const structuredQuestionTypes = new Set<QuestionView["type"]>(["PLANNING", "SCHEDULE", "SCENARIO_DECISION"])

export function isStructuredQuestion(type: QuestionView["type"]): boolean {
  return structuredQuestionTypes.has(type)
}

export function answerFieldsFor(question: Pick<QuestionView, "answerFields">): string[] {
  return Array.isArray(question.answerFields) ? question.answerFields : []
}

export function questionFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    routePlan: "航线方案",
    safetyCheck: "安全检查",
    reasoning: "判断依据",
    trajectoryPlan: "舞步轨迹",
    timingPlan: "时刻同步方案",
    pauseAction: "暂停动作",
    groupAction: "分组处置",
    resumeCondition: "恢复条件",
    assignments: "订单分配",
    conflictCheck: "冲突检查",
    fallback: "备选方案",
    schedule: "配送时刻表",
    dispatchPlan: "调度方案",
    emergencyAction: "应急处置动作",
    formationPlan: "编队方案",
    altitudePlan: "高度方案",
    taskOrder: "任务点顺序",
    hoverPlan: "悬停要求",
    returnCondition: "返航条件",
    divertAction: "备降动作",
    transferAction: "任务转移",
    recoveryCondition: "恢复条件",
    eventAssessment: "事件评估",
    actionPlan: "处置方案",
    recoveryCheck: "恢复检查"
  }
  return labels[field] ?? field
}

export function isQuestionAnswerComplete(answer: QuestionAnswer, requiredFields: readonly string[] = []): boolean {
  if (answer === null) return false
  if (Array.isArray(answer)) return answer.length > 0
  if (typeof answer !== "object") return String(answer).trim().length > 0
  if (requiredFields.length === 0) return Object.keys(answer).length > 0
  return requiredFields.every((field) => {
    const value = answer[field]
    if (value === null || value === undefined) return false
    if (typeof value === "string") return value.trim().length > 0
    if (Array.isArray(value)) return value.length > 0
    return true
  })
}

export function fieldValuesFromAnswer(answer: QuestionAnswer, fields: readonly string[]): Record<string, string> {
  if (!isRecord(answer)) return Object.fromEntries(fields.map((field) => [field, ""]))
  return Object.fromEntries(fields.map((field) => [field, displayValue(answer[field])]))
}

export function structuredAnswerFromFields(values: Record<string, string> | undefined, fields: readonly string[]): QuestionAnswer {
  const answer: Record<string, string> = {}
  let hasValue = false
  for (const field of fields) {
    const value = values?.[field]?.trim() ?? ""
    if (value) {
      answer[field] = value
      hasValue = true
    }
  }
  return hasValue ? answer : null
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
