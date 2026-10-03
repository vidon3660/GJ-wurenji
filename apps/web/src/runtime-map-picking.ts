const runtimeEntityPrefixes = ["runtime-aircraft:", "runtime-event:", "runtime-route:"] as const

export interface RuntimeAircraftClusterInput {
  id: string
  position: { longitude: number; latitude: number; altitudeMeters?: number }
}

export interface RuntimeAircraftCluster {
  key: string
  longitude: number
  latitude: number
  altitudeMeters: number
  aircraftIds: string[]
}

export function clusterRuntimeAircraft(
  aircraft: readonly RuntimeAircraftClusterInput[],
  mode: "2d" | "3d"
): RuntimeAircraftCluster[] {
  const clusters = new Map<string, RuntimeAircraftCluster>()
  for (const item of aircraft) {
    const { longitude, latitude } = item.position
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || Math.abs(longitude) > 180 || Math.abs(latitude) > 90) continue
    const altitudeMeters = mode === "3d" && Number.isFinite(item.position.altitudeMeters) ? Math.max(0, item.position.altitudeMeters!) : 0
    const key = `${longitude.toFixed(6)}:${latitude.toFixed(6)}:${altitudeMeters.toFixed(1)}`
    const cluster = clusters.get(key)
    if (cluster) cluster.aircraftIds.push(item.id)
    else clusters.set(key, { key, longitude, latitude, altitudeMeters, aircraftIds: [item.id] })
  }
  return [...clusters.values()]
}

export function preferredRuntimeMapEntityId(entityIds: readonly string[]): string {
  for (const prefix of runtimeEntityPrefixes) {
    const entityId = entityIds.find((candidate) => candidate.startsWith(prefix))
    if (entityId) return entityId
  }
  return ""
}

export function nextRuntimeAircraftEntityId(candidateIds: readonly string[], selectedId: string): string {
  const aircraftIds = [...new Set(candidateIds)].filter((candidate) => candidate.startsWith("runtime-aircraft:"))
  if (!aircraftIds.length) return ""
  const selectedIndex = aircraftIds.indexOf(`runtime-aircraft:${selectedId}`)
  return aircraftIds[(selectedIndex + 1 + aircraftIds.length) % aircraftIds.length] ?? aircraftIds[0] ?? ""
}

export function orderRuntimeAircraftEntityIds(candidateIds: readonly string[], aircraftOrder: readonly string[]): string[] {
  const uniqueAircraftIds = [...new Set(candidateIds)].filter((candidate) => candidate.startsWith("runtime-aircraft:"))
  const order = new Map(aircraftOrder.map((aircraftId, index) => [`runtime-aircraft:${aircraftId}`, index]))
  return uniqueAircraftIds.sort((left, right) => {
    const leftIndex = order.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightIndex = order.get(right) ?? Number.MAX_SAFE_INTEGER
    return leftIndex - rightIndex || left.localeCompare(right)
  })
}
