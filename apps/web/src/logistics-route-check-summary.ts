import type {
  LogisticsRouteCheckCategory,
  LogisticsRouteCheckCategorySummary,
  LogisticsRouteCheckResult
} from "@wurenji/shared"

export const requiredLogisticsRouteChecks = [
  { category: "SPATIAL", title: "空间与障碍" },
  { category: "AIRCRAFT", title: "设备能力" },
  { category: "COVERAGE", title: "定位通信" },
  { category: "NODES", title: "运行节点" },
  { category: "ROUTE_RELATION", title: "多航线关系" }
] as const satisfies ReadonlyArray<{ category: LogisticsRouteCheckCategory; title: string }>

export interface RequiredLogisticsRouteCheckView extends Omit<LogisticsRouteCheckCategorySummary, "checked"> {
  title: string
  checked: boolean
}

export function summarizeRequiredLogisticsRouteChecks(result: LogisticsRouteCheckResult | null): RequiredLogisticsRouteCheckView[] {
  return requiredLogisticsRouteChecks.map(({ category, title }) => {
    const summary = result?.categorySummaries?.find((item) => item.category === category)
    if (summary) return { ...summary, title }
    const evidence = result?.evidence.filter((item) => item.category === category) ?? []
    const conflictCount = evidence.filter((item) => item.severity === "CONFLICT").length
    return {
      category,
      title,
      checked: Boolean(result),
      passed: Boolean(result) && conflictCount === 0,
      conflictCount,
      riskCount: evidence.filter((item) => item.severity === "RISK").length,
      infoCount: evidence.filter((item) => item.severity === "INFO").length,
      evidenceCount: evidence.length
    }
  })
}
