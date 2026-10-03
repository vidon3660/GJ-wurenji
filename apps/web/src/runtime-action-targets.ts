export function eligibleRuntimeTargets<T extends { id: string }>(items: T[], eligibleTargetIds: string[]): T[] {
  const eligible = new Set(eligibleTargetIds)
  return items.filter((item) => eligible.has(item.id))
}

export function eligibleRuntimeRoutesForTarget<T extends { id: string }>(
  routes: T[],
  eligibleRouteIdsByTargetId: Record<string, string[]>,
  targetId: string
): T[] {
  return eligibleRuntimeTargets(routes, eligibleRouteIdsByTargetId[targetId] ?? [])
}

export function runtimeActionOptionLabel(title: string, enabled: boolean, disabledReason: string | null): string {
  return enabled || !disabledReason ? title : `${title} · ${disabledReason}`
}

export function runtimeActionEventId(event: { id: string; status: string } | null | undefined): string | undefined {
  return event && event.status !== "RESOLVED" ? event.id : undefined
}
