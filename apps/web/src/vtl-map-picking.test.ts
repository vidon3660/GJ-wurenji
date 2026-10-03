import { describe, expect, it } from "vitest"
import { parseVtlMapPickId } from "./vtl-map-picking"

describe("VTL map picking", () => {
  it.each([
    ["vtl-aircraft:UAV-01", { kind: "AIRCRAFT", aircraftId: "UAV-01" }],
    ["vtl-route:UAV-02", { kind: "ROUTE", aircraftId: "UAV-02" }],
    ["vtl-waypoint:UAV-03:WP-07", { kind: "WAYPOINT", aircraftId: "UAV-03", waypointId: "WP-07" }]
  ])("parses %s", (value, expected) => {
    expect(parseVtlMapPickId(value)).toEqual(expected)
  })

  it("ignores unrelated and malformed entities", () => {
    expect(parseVtlMapPickId("v3-layer:BUILDINGS:building-1")).toBeNull()
    expect(parseVtlMapPickId("vtl-waypoint::WP-01")).toBeNull()
    expect(parseVtlMapPickId("vtl-aircraft:")).toBeNull()
  })
})
