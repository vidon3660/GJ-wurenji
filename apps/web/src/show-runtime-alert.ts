import type { ShowRuntimeEventView, V3AlertSeverity, V3RuntimeAlertView } from "@wurenji/shared"

export interface ShowRuntimeAlertPresentation {
  severityLabel: string
  affectedCount: number
  affectedGroupsLabel: string
  impactLabel: string
}

export function showRuntimeAlertPresentation(
  alert: Pick<V3RuntimeAlertView, "severity">,
  event: Pick<ShowRuntimeEventView, "affectedCount" | "affectedGroupIds"> | null | undefined
): ShowRuntimeAlertPresentation {
  const affectedCount = Math.max(0, Math.floor(event?.affectedCount ?? 0))
  const affectedGroupsLabel = event?.affectedGroupIds.length ? event.affectedGroupIds.join("、") : "未指定分组"
  return {
    severityLabel: showRuntimeAlertSeverityLabel(alert.severity),
    affectedCount,
    affectedGroupsLabel,
    impactLabel: `${affectedCount} 架 · ${affectedGroupsLabel}`
  }
}

export function showRuntimeAlertSeverityLabel(severity: V3AlertSeverity): string {
  return ({ INFO: "提示", WARNING: "一般", ERROR: "重要", CRITICAL: "紧急" } as const)[severity]
}
