import { describe, expect, it } from "vitest"
import { fixedTickSimulationTime, RUNTIME_TICK_INTERVAL_MS } from "./runtime-clock.js"

describe("runtime fixed tick clock", () => {
  it("holds between ticks and advances in fixed simulation intervals", () => {
    const anchor = { simulationTimeMs: 1_250, realTimeMs: 10_000, rate: 2 }
    expect(fixedTickSimulationTime(anchor, 10_499, 60_000)).toBe(1_250)
    expect(fixedTickSimulationTime(anchor, 10_500, 60_000)).toBe(2_250)
    expect(fixedTickSimulationTime(anchor, 11_499, 60_000)).toBe(3_250)
    expect(fixedTickSimulationTime(anchor, 11_500, 60_000)).toBe(4_250)
  })

  it("never moves backward from a non-aligned restart point and clamps duration", () => {
    const anchor = { simulationTimeMs: 12_345, realTimeMs: 10_000, rate: 60 }
    expect(fixedTickSimulationTime(anchor, 9_000, 12_500)).toBe(12_345)
    expect(fixedTickSimulationTime(anchor, 10_100, 12_500)).toBe(12_500)
    expect(RUNTIME_TICK_INTERVAL_MS).toBe(1_000)
  })
})
