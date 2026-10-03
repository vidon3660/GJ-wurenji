import { describe, expect, it } from "vitest"
import type { V3LogisticsNode } from "@wurenji/shared"
import { selectNearestAlternateLandingPoint } from "./logistics-diversion.js"

describe("logistics diversion point selection", () => {
  it("selects the nearest enabled preferred alternate landing point", () => {
    const result = selectNearestAlternateLandingPoint(
      { longitude: 113.95, latitude: 22.54 },
      [node("near", 113.951, 22.54), node("far", 114, 22.6)],
      ["near", "far"]
    )

    expect(result?.node.id).toBe("near")
    expect(result?.distanceMeters).toBeGreaterThan(0)
  })

  it("does not use disabled, closed, or non-preferred landing points", () => {
    const disabled = node("disabled", 113.951, 22.54, false)
    const closed = node("closed", 113.952, 22.54)
    closed.properties.status = "CLOSED"

    expect(selectNearestAlternateLandingPoint(
      { longitude: 113.95, latitude: 22.54 },
      [disabled, closed, node("other", 113.953, 22.54)],
      ["disabled", "closed"]
    )).toBeNull()
  })

  it("uses any available alternate landing point when the route has no preferred points", () => {
    const result = selectNearestAlternateLandingPoint(
      { longitude: 113.95, latitude: 22.54 },
      [node("alternate", 113.951, 22.54)],
      []
    )

    expect(result?.node.id).toBe("alternate")
  })

  it("breaks equal-distance choices by node id instead of input order", () => {
    const result = selectNearestAlternateLandingPoint(
      { longitude: 113.95, latitude: 22.54 },
      [node("zeta", 113.951, 22.54), node("alpha", 113.951, 22.54)],
      []
    )

    expect(result?.node.id).toBe("alpha")
  })
})

function node(id: string, longitude: number, latitude: number, enabled = true): V3LogisticsNode {
  return {
    id,
    code: id.toUpperCase(),
    type: "ALTERNATE_LANDING_POINT",
    name: `备降点 ${id}`,
    geometryType: "POINT",
    position: { longitude, latitude, altitudeMeters: 12 },
    enabled,
    properties: {}
  }
}
