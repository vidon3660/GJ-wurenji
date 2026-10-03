import { describe, expect, it } from "vitest"
import { showAreaFeatureTypes } from "@wurenji/shared"
import { rectangleFromDiagonal } from "./area-drawing"

describe("STU-006 area drawing", () => {
  it("keeps all nine required show area types", () => {
    expect(showAreaFeatureTypes).toEqual([
      "TAKEOFF_LANDING",
      "FLIGHT",
      "PERFORMANCE",
      "BUFFER",
      "GROUND_ISOLATION",
      "AUDIENCE",
      "OPERATION",
      "EMERGENCY_LANDING",
      "GEOFENCE"
    ])
  })

  it("builds a clockwise rectangle from either diagonal direction", () => {
    const expected = [
      { longitude: 113.9, latitude: 21.8 },
      { longitude: 114.1, latitude: 21.8 },
      { longitude: 114.1, latitude: 22.2 },
      { longitude: 113.9, latitude: 22.2 }
    ]

    expect(rectangleFromDiagonal(expected[0]!, expected[2]!)).toEqual(expected)
    expect(rectangleFromDiagonal(expected[2]!, expected[0]!)).toEqual(expected)
  })
})
