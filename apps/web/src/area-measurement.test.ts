import { describe, expect, it } from "vitest"
import { createDistanceMeasurement } from "./area-measurement"

describe("STU-007 show area measurement", () => {
  it("calculates distance and a normalized 0-360 degree bearing", () => {
    const measurement = createDistanceMeasurement(
      { longitude: 114, latitude: 22, heightMeters: 15.2 },
      { longitude: 114.01, latitude: 22, heightMeters: 36.8 }
    )

    expect(measurement.distanceMeters).toBeCloseTo(1030.9, 0)
    expect(measurement.bearingDegrees).toBeGreaterThanOrEqual(0)
    expect(measurement.bearingDegrees).toBeLessThan(360)
    expect(measurement.bearingDegrees).toBeCloseTo(90, 1)
  })

  it("preserves endpoint coordinates and terrain elevations", () => {
    const start = { longitude: 113.93456789, latitude: 22.51234567, heightMeters: null }
    const end = { longitude: 113.94567891, latitude: 22.52345678, heightMeters: 42.4 }

    const measurement = createDistanceMeasurement(start, end)

    expect(measurement.start).toEqual(start)
    expect(measurement.end).toEqual(end)
    expect(measurement.start).not.toBe(start)
    expect(measurement.end).not.toBe(end)
  })
})
