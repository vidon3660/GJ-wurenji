import type { ShowRuntimeTotalsView } from "@wurenji/shared"

export interface ShowRuntimeMonitorMetric {
  code: "TOTAL" | "TAKEOFF" | "AIRBORNE" | "LANDED" | "NORMAL" | "WARNING" | "ABNORMAL" | "LOST"
  label: string
  value: number
  tone: "neutral" | "normal" | "warning" | "danger" | "lost"
}

export function showRuntimeMonitorMetrics(totals: ShowRuntimeTotalsView | null | undefined): ShowRuntimeMonitorMetric[] {
  return [
    { code: "TOTAL", label: "总架数", value: totals?.plannedCount ?? 0, tone: "neutral" },
    { code: "TAKEOFF", label: "已起飞", value: totals?.takeoffCount ?? 0, tone: "neutral" },
    { code: "AIRBORNE", label: "空中", value: totals?.airborneCount ?? 0, tone: "neutral" },
    { code: "LANDED", label: "已降落", value: totals?.landedCount ?? 0, tone: "neutral" },
    { code: "NORMAL", label: "正常", value: totals?.normalCount ?? 0, tone: "normal" },
    { code: "WARNING", label: "告警", value: totals?.warningCount ?? 0, tone: "warning" },
    { code: "ABNORMAL", label: "异常", value: totals?.abnormalCount ?? 0, tone: "danger" },
    { code: "LOST", label: "失联", value: totals?.lostCount ?? 0, tone: "lost" }
  ]
}
