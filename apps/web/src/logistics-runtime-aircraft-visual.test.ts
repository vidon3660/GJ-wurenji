import { describe, expect, it } from "vitest"
import type { LogisticsRuntimeAircraftView, LogisticsRuntimeRouteView } from "@wurenji/shared"
import { appendLogisticsAircraftTrail, isLogisticsAircraftAirborne, logisticsAircraftHeadingRadians } from "./logistics-runtime-aircraft-visual"

describe("logistics runtime aircraft visual state", () => {
  it("identifies airborne logistics states", () => {
    expect(isLogisticsAircraftAirborne("OUTBOUND")).toBe(true)
    expect(isLogisticsAircraftAirborne("HOLDING")).toBe(true)
    expect(isLogisticsAircraftAirborne("AVAILABLE")).toBe(false)
  })

  it("keeps a bounded trail and ignores sub-meter duplicate samples", () => {
    const first = { longitude: 113.3, latitude: 23.08, altitudeMeters: 80 }
    const duplicate = { longitude: 113.300001, latitude: 23.08, altitudeMeters: 80.1 }
    const moved = { longitude: 113.3001, latitude: 23.0801, altitudeMeters: 90 }
    const initial = appendLogisticsAircraftTrail([], first, 2)
    expect(appendLogisticsAircraftTrail(initial, duplicate, 2)).toEqual(initial)
    expect(appendLogisticsAircraftTrail(initial, moved, 2)).toEqual([first, moved])
    expect(appendLogisticsAircraftTrail([first, moved], { longitude: 113.301, latitude: 23.081, altitudeMeters: 95 }, 2)).toHaveLength(2)
  })

  it("orients an airborne aircraft along its nearest active route", () => {
    const aircraft = { status: "OUTBOUND", position: { longitude: 113.3005, latitude: 23.08, altitudeMeters: 100 } } as LogisticsRuntimeAircraftView
    const route = {
      activeTaskCount: 1,
      waypoints: [
        { position: { longitude: 113.3, latitude: 23.08, altitudeMeters: 100 } },
        { position: { longitude: 113.301, latitude: 23.08, altitudeMeters: 100 } }
      ]
    } as LogisticsRuntimeRouteView
    expect(logisticsAircraftHeadingRadians(aircraft, [route])).toBeCloseTo(Math.PI / 2, 4)
  })
})
