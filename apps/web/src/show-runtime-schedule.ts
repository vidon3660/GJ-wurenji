import type { ShowRuntimeEventView, ShowRuntimeGroupView } from "@wurenji/shared"

export interface ShowRuntimeScheduleRow {
  groupId: string
  label: string
  status: ShowRuntimeGroupView["status"]
  plannedCount: number
  currentEventTitle: string | null
  currentEventTimeMs: number | null
  nextEventTitle: string | null
  nextEventTimeMs: number | null
}

export function buildShowRuntimeSchedule(
  groups: ShowRuntimeGroupView[],
  events: ShowRuntimeEventView[],
  simulationTimeMs: number
): ShowRuntimeScheduleRow[] {
  return groups.map((group) => {
    const relatedEvents = events
      .filter((event) => event.affectedGroupIds.includes(group.groupId) && event.scheduledSimulationTimeMs !== null)
      .sort((left, right) => (left.scheduledSimulationTimeMs ?? 0) - (right.scheduledSimulationTimeMs ?? 0))
    const currentEvent = [...relatedEvents].reverse().find((event) => (event.scheduledSimulationTimeMs ?? 0) <= simulationTimeMs)
    const nextEvent = relatedEvents.find((event) => (event.scheduledSimulationTimeMs ?? 0) > simulationTimeMs)

    return {
      groupId: group.groupId,
      label: group.label,
      status: group.status,
      plannedCount: group.plannedCount,
      currentEventTitle: currentEvent?.title ?? null,
      currentEventTimeMs: currentEvent?.scheduledSimulationTimeMs ?? null,
      nextEventTitle: nextEvent?.title ?? null,
      nextEventTimeMs: nextEvent?.scheduledSimulationTimeMs ?? null
    }
  }).sort((left, right) => left.groupId.localeCompare(right.groupId, "en", { numeric: true }))
}
