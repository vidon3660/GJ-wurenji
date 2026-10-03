import { describe, expect, it } from "vitest"
import { clusterRuntimeAircraft, nextRuntimeAircraftEntityId, orderRuntimeAircraftEntityIds, preferredRuntimeMapEntityId } from "./runtime-map-picking"

describe("preferredRuntimeMapEntityId", () => {
  it("prioritizes aircraft when route geometry overlaps its marker", () => {
    expect(preferredRuntimeMapEntityId([
      "runtime-route:route-01",
      "runtime-aircraft:aircraft-02",
      "runtime-event:event-03"
    ])).toBe("runtime-aircraft:aircraft-02")
  })

  it("uses an event before a route when no aircraft is present", () => {
    expect(preferredRuntimeMapEntityId([
      "runtime-route:route-01",
      "runtime-event:event-03"
    ])).toBe("runtime-event:event-03")
  })

  it("ignores unrelated map entities", () => {
    expect(preferredRuntimeMapEntityId(["runtime-region-mask:region-01", "building:01"])).toBe("")
  })

  it("cycles overlapping aircraft after the currently selected one", () => {
    expect(nextRuntimeAircraftEntityId([
      "runtime-aircraft:aircraft-01",
      "runtime-aircraft:aircraft-02",
      "runtime-aircraft:aircraft-03"
    ], "aircraft-01")).toBe("runtime-aircraft:aircraft-02")
    expect(nextRuntimeAircraftEntityId([
      "runtime-aircraft:aircraft-01",
      "runtime-aircraft:aircraft-02",
      "runtime-aircraft:aircraft-03"
    ], "aircraft-03")).toBe("runtime-aircraft:aircraft-01")
  })

  it("deduplicates candidates and ignores non-aircraft entities", () => {
    expect(nextRuntimeAircraftEntityId([
      "runtime-route:route-01",
      "runtime-aircraft:aircraft-02",
      "runtime-aircraft:aircraft-02"
    ], "aircraft-02")).toBe("runtime-aircraft:aircraft-02")
    expect(nextRuntimeAircraftEntityId(["runtime-route:route-01"], "aircraft-02")).toBe("")
  })

  it("orders dense aircraft candidates by the stable business fleet order", () => {
    expect(orderRuntimeAircraftEntityIds([
      "runtime-aircraft:aircraft-03",
      "runtime-aircraft:aircraft-01",
      "runtime-route:route-01",
      "runtime-aircraft:aircraft-02",
      "runtime-aircraft:aircraft-03"
    ], ["aircraft-02", "aircraft-01", "aircraft-03"])).toEqual([
      "runtime-aircraft:aircraft-02",
      "runtime-aircraft:aircraft-01",
      "runtime-aircraft:aircraft-03"
    ])
  })

  it("groups aircraft at the same position while preserving their ids", () => {
    const clusters = clusterRuntimeAircraft([
      { id: "aircraft-01", position: { longitude: 114, latitude: 22, altitudeMeters: 0 } },
      { id: "aircraft-02", position: { longitude: 114.0000004, latitude: 22.0000004, altitudeMeters: 0 } },
      { id: "aircraft-03", position: { longitude: 114.001, latitude: 22, altitudeMeters: 30 } }
    ], "3d")
    expect(clusters[0]?.aircraftIds).toEqual(["aircraft-01", "aircraft-02"])
    expect(clusters[1]?.aircraftIds).toEqual(["aircraft-03"])
  })

  it("groups ground markers regardless of altitude in 2D", () => {
    expect(clusterRuntimeAircraft([
      { id: "aircraft-01", position: { longitude: 114, latitude: 22, altitudeMeters: 10 } },
      { id: "aircraft-02", position: { longitude: 114, latitude: 22, altitudeMeters: 80 } }
    ], "2d")[0]?.aircraftIds).toEqual(["aircraft-01", "aircraft-02"])
  })
})
