export type VtlMapPick =
  | { kind: "AIRCRAFT"; aircraftId: string }
  | { kind: "ROUTE"; aircraftId: string }
  | { kind: "WAYPOINT"; aircraftId: string; waypointId: string }
  | null

export function parseVtlMapPickId(value: string): VtlMapPick {
  if (value.startsWith("vtl-aircraft:")) {
    const aircraftId = value.slice("vtl-aircraft:".length)
    return aircraftId ? { kind: "AIRCRAFT", aircraftId } : null
  }
  if (value.startsWith("vtl-route:")) {
    const aircraftId = value.slice("vtl-route:".length)
    return aircraftId ? { kind: "ROUTE", aircraftId } : null
  }
  if (value.startsWith("vtl-waypoint:")) {
    const raw = value.slice("vtl-waypoint:".length)
    const separator = raw.indexOf(":")
    if (separator <= 0 || separator === raw.length - 1) return null
    return { kind: "WAYPOINT", aircraftId: raw.slice(0, separator), waypointId: raw.slice(separator + 1) }
  }
  return null
}
