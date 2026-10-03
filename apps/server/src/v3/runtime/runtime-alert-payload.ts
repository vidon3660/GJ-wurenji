export function mergeRuntimeAlertPayload(
  eventPayload: Record<string, unknown>,
  existingPayload: Record<string, unknown> = {}
): Record<string, unknown> {
  const recommendedActions = Array.isArray(eventPayload.recommendedActions)
    ? eventPayload.recommendedActions.filter((item): item is string => typeof item === "string")
    : []

  return {
    ...existingPayload,
    recommendedActions,
    actionDeadlineSeconds: nullableFiniteNumber(eventPayload.actionDeadlineSeconds),
    actionDeadlineAtSimulationTimeMs: nullableFiniteNumber(eventPayload.actionDeadlineAtSimulationTimeMs),
    detectedSimulationTimeMs: nullableFiniteNumber(eventPayload.detectedSimulationTimeMs)
  }
}

function nullableFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : null
}
