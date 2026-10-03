import { describe, expect, it } from "vitest"
import type { VtlRouteWaypointInput } from "@wurenji/shared"
import { updateVtlWaypointPosition } from "./vtl-route-editing"

const waypoints: VtlRouteWaypointInput[] = [{
  id: "task-1",
  sequence: 0,
  phase: "TASK_EXECUTION",
  position: { longitude: 120, latitude: 30, altitudeMeters: 120 },
  altitudeMeters: 120,
  speedMps: 22,
  taskObjectId: "object-1",
}]

describe("updateVtlWaypointPosition", () => {
  it("updates only the horizontal position and preserves route properties", () => {
    const updated = updateVtlWaypointPosition(waypoints, "task-1", { longitude: 120.1, latitude: 30.2 })

    expect(updated).toEqual([{
      ...waypoints[0],
      position: { longitude: 120.1, latitude: 30.2, altitudeMeters: 120 },
    }])
    expect(waypoints[0]?.position).toEqual({ longitude: 120, latitude: 30, altitudeMeters: 120 })
    expect(updated).not.toBe(waypoints)
    expect(updated[0]).not.toBe(waypoints[0])
  })

  it("returns an independent copy when the waypoint id is unknown", () => {
    const updated = updateVtlWaypointPosition(waypoints, "missing", { longitude: 1, latitude: 2 })

    expect(updated).toEqual(waypoints)
    expect(updated).not.toBe(waypoints)
    expect(updated[0]).not.toBe(waypoints[0])
  })
})
