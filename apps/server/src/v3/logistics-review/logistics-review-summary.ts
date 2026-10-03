import { BadRequestException } from "@nestjs/common"
import type { V3LogisticsStudentReviewSummaryView } from "@wurenji/shared"

export interface NormalizedLogisticsStudentSummary {
  stored: string
  text: string
  structured: V3LogisticsStudentReviewSummaryView | null
}

export function normalizeLogisticsStudentSummary(
  summaryValue: string,
  input: Partial<V3LogisticsStudentReviewSummaryView> | undefined,
  submit: boolean
): NormalizedLogisticsStudentSummary {
  const structured = input && Object.values(input).some((value) => typeof value === "string" && value.trim().length > 0)
    ? {
        originalPlanProblems: normalizeText(String(input.originalPlanProblems ?? ""), 1_600, "原方案问题", submit ? 2 : 0),
        responseLessons: normalizeText(String(input.responseLessons ?? ""), 1_600, "处置得失", submit ? 2 : 0),
        routeAdjustmentSuggestions: normalizeText(String(input.routeAdjustmentSuggestions ?? ""), 1_600, "航线调整建议", submit ? 2 : 0),
        schedulingOptimization: normalizeText(String(input.schedulingOptimization ?? ""), 1_600, "调度优化", submit ? 2 : 0),
        improvements: normalizeText(String(input.improvements ?? ""), 1_600, "改进措施", submit ? 2 : 0)
      }
    : null
  const text = structured
    ? [structured.originalPlanProblems, structured.responseLessons, structured.routeAdjustmentSuggestions, structured.schedulingOptimization, structured.improvements].filter(Boolean).join("\n")
    : summaryValue
  const normalizedText = normalizeText(text, 8_000, "物流复盘总结", submit ? 20 : 0)
  return {
    stored: structured ? JSON.stringify({ schemaVersion: 1, sceneType: "CITY_LOGISTICS", ...structured }) : normalizedText,
    text: normalizedText,
    structured
  }
}

export function parseLogisticsStudentSummary(value: string): V3LogisticsStudentReviewSummaryView | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== 1 || parsed.sceneType !== "CITY_LOGISTICS") return null
    return {
      originalPlanProblems: typeof parsed.originalPlanProblems === "string" ? parsed.originalPlanProblems : "",
      responseLessons: typeof parsed.responseLessons === "string" ? parsed.responseLessons : "",
      routeAdjustmentSuggestions: typeof parsed.routeAdjustmentSuggestions === "string" ? parsed.routeAdjustmentSuggestions : "",
      schedulingOptimization: typeof parsed.schedulingOptimization === "string" ? parsed.schedulingOptimization : "",
      improvements: typeof parsed.improvements === "string" ? parsed.improvements : ""
    }
  } catch {
    return null
  }
}

export function logisticsStudentSummaryText(value: string): string {
  const summary = parseLogisticsStudentSummary(value)
  if (!summary) return value
  return [
    `原方案问题：${summary.originalPlanProblems}`,
    `处置得失：${summary.responseLessons}`,
    `航线调整建议：${summary.routeAdjustmentSuggestions}`,
    `调度优化：${summary.schedulingOptimization}`,
    `改进措施：${summary.improvements}`
  ].join("\n")
}

function normalizeText(value: string, maximumLength: number, label: string, minimumLength = 0): string {
  const text = value.trim()
  if (text.length < minimumLength) throw new BadRequestException(`${label}不能少于 ${minimumLength} 个字符`)
  if (text.length > maximumLength) throw new BadRequestException(`${label}不能超过 ${maximumLength} 个字符`)
  return text
}
