export const RUNTIME_TICK_INTERVAL_MS = 1_000

export interface RuntimeClockAnchor {
  simulationTimeMs: number
  realTimeMs: number
  rate: number
}

export function fixedTickSimulationTime(anchor: RuntimeClockAnchor, nowMs: number, durationMs: number): number {
  const elapsedRealMs = Math.max(0, nowMs - anchor.realTimeMs)
  const rate = Number.isFinite(anchor.rate) && anchor.rate > 0 ? anchor.rate : 1
  const elapsedSimulationMs = Math.floor(elapsedRealMs * rate / RUNTIME_TICK_INTERVAL_MS) * RUNTIME_TICK_INTERVAL_MS
  return Math.min(Math.max(0, Math.floor(durationMs)), Math.max(0, Math.floor(anchor.simulationTimeMs)) + elapsedSimulationMs)
}
