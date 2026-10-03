export interface RuntimeAlertTimingSource {
  payload?: Record<string, unknown> | null
  actionDeadlineSeconds?: number | null
  actionDeadlineAtSimulationTimeMs?: number | null
  detectedSimulationTimeMs?: number | null
}

export interface RuntimeAlertTiming {
  deadlineAtSimulationTimeMs: number | null
  remainingMs: number | null
  label: string
  tone: "neutral" | "warning" | "danger"
}

export function runtimeAlertTiming(source: RuntimeAlertTimingSource | null | undefined, currentSimulationTimeMs: number): RuntimeAlertTiming {
  const payload = source?.payload ?? {}
  const deadlineSeconds = finiteNumber(source?.actionDeadlineSeconds ?? payload.actionDeadlineSeconds)
  const detectedSimulationTimeMs = finiteNumber(source?.detectedSimulationTimeMs ?? payload.detectedSimulationTimeMs)
  const configuredDeadlineAt = finiteNumber(source?.actionDeadlineAtSimulationTimeMs ?? payload.actionDeadlineAtSimulationTimeMs)
  const deadlineAtSimulationTimeMs = configuredDeadlineAt
    ?? (deadlineSeconds !== null && detectedSimulationTimeMs !== null ? detectedSimulationTimeMs + deadlineSeconds * 1_000 : null)

  if (deadlineAtSimulationTimeMs === null) {
    return { deadlineAtSimulationTimeMs: null, remainingMs: null, label: "未设置处置时限", tone: "neutral" }
  }

  const remainingMs = deadlineAtSimulationTimeMs - Math.max(0, finiteNumber(currentSimulationTimeMs) ?? 0)
  if (remainingMs <= 0) {
    return { deadlineAtSimulationTimeMs, remainingMs, label: `已超时 ${formatRuntimeDuration(-remainingMs)}`, tone: "danger" }
  }

  const warningThresholdMs = deadlineSeconds === null ? 30_000 : Math.max(30_000, deadlineSeconds * 1_000 * 0.25)
  return {
    deadlineAtSimulationTimeMs,
    remainingMs,
    label: `剩余 ${formatRuntimeDuration(remainingMs)}`,
    tone: remainingMs <= warningThresholdMs ? "warning" : "neutral"
  }
}

export function formatRuntimeDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainder = seconds % 60
  return `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}

export function pickRecommendedRuntimeAction<T extends { code: string; enabled: boolean }>(
  actions: readonly T[],
  recommendedCodes: readonly string[],
  excludedCodes: readonly string[] = []
): T | null {
  const excluded = new Set(excludedCodes)
  return recommendedCodes
    .map((code) => actions.find((action) => action.code === code && action.enabled && !excluded.has(action.code)))
    .find((action): action is T => Boolean(action)) ?? null
}

export function pickRuntimeTargetId(eligibleTargetIds: readonly string[], affectedIds: readonly string[]): string {
  if (eligibleTargetIds.length === 0) return ""
  const affected = new Set(affectedIds)
  return eligibleTargetIds.find((targetId) => affected.has(targetId) || targetIdTokens(targetId).some((token) => affected.has(token)))
    ?? eligibleTargetIds[0]!
}

export function runtimeRecommendedActionLabel(
  recommendedCodes: readonly string[],
  actions: readonly { code: string; title: string }[]
): string {
  const action = recommendedCodes.map((code) => actions.find((item) => item.code === code)).find((item): item is { code: string; title: string } => Boolean(item))
  return action?.title ?? "暂无推荐动作"
}

export function latestRuntimeAction<T extends {
  alertId?: string | null
  eventId?: string | null
  simulationTimeMs?: number | null
}>(actions: readonly T[], alertId: string, eventId: string | null): T | null {
  let latest: T | null = null
  let latestTime = Number.NEGATIVE_INFINITY
  for (const action of actions) {
    if (action.alertId !== alertId && (!eventId || action.eventId !== eventId)) continue
    const simulationTimeMs = Number(action.simulationTimeMs ?? 0)
    if (latest === null || simulationTimeMs >= latestTime) {
      latest = action
      latestTime = Number.isFinite(simulationTimeMs) ? simulationTimeMs : latestTime
    }
  }
  return latest
}

export function runtimeAlertStatusLabel(alertStatus: string, lifecycleStatus?: string | null): string {
  if (["HANDLING", "IN_PROGRESS"].includes(lifecycleStatus ?? "")) return "处置中"
  if (["CONTROLLED", "ENDED", "RESOLVED"].includes(lifecycleStatus ?? "")) return "已处置"
  if (alertStatus === "ACKNOWLEDGED") return "已确认"
  if (alertStatus === "RESOLVED") return "已完成"
  return "待确认"
}

export function preferredRuntimeAlertId<T extends { id: string; status: string }>(items: readonly T[], selectedId: string): string {
  const selected = items.find((item) => item.id === selectedId)
  const active = items.find((item) => item.status !== "RESOLVED")
  if (!selected || (selected.status === "RESOLVED" && active)) return active?.id ?? items[0]?.id ?? ""
  return selectedId
}

export function runtimeAlertSeverityLabel(severity: string): string {
  return ({ INFO: "提示", WARNING: "警告", ERROR: "错误", CRITICAL: "严重" } as Record<string, string>)[severity] ?? severity
}

function targetIdTokens(value: string): string[] {
  return value.match(/[A-Za-z]+\d{2,3}/g) ?? []
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}
