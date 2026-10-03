import { describe, expect, it } from "vitest"
import { createDemoPlan, createDemoScene } from "@wurenji/shared"
import { isPointInsidePolygon, moveMapObject, selectionIdForMapEntity } from "./map-edit"

const movedPoint = { longitude: 114.01, latitude: 22.61, altitude: 0 }

describe("map editing", () => {
  it("checks whether a map placement is inside the work area", () => {
    const boundary = createDemoScene().boundary.positions
    expect(isPointInsidePolygon({ longitude: 113.948, latitude: 22.539, altitude: 0 }, boundary)).toBe(true)
    expect(isPointInsidePolygon({ longitude: 115, latitude: 28, altitude: 0 }, boundary)).toBe(false)
  })

  it("moves teacher point objects while preserving their altitude", () => {
    const scene = createDemoScene()
    const altitude = scene.taskPoints[0]!.position.altitude

    expect(moveMapObject(scene, null, `task:${scene.taskPoints[0]!.id}`, movedPoint)).toBe(true)
    expect(scene.taskPoints[0]!.position).toEqual({ ...movedPoint, altitude })

    expect(moveMapObject(scene, null, "takeoff:main", movedPoint)).toBe(true)
    expect(scene.takeoffPoint).toEqual(movedPoint)
    expect(scene.landingPoint).not.toEqual(movedPoint)

    expect(moveMapObject(scene, null, "landing:main", movedPoint)).toBe(true)
    expect(scene.landingPoint).toEqual(movedPoint)
  })

  it("moves boundary and no-fly-zone edit handles", () => {
    const scene = createDemoScene()

    expect(moveMapObject(scene, null, `vertex:boundary:${scene.boundary.id}:1`, movedPoint)).toBe(true)
    expect(scene.boundary.positions[1]!.longitude).toBe(movedPoint.longitude)

    const zone = scene.noFlyZones[0]!
    expect(moveMapObject(scene, null, `vertex:noFly:${zone.id}:2`, movedPoint)).toBe(true)
    expect(zone.positions[2]!.latitude).toBe(movedPoint.latitude)
    expect(selectionIdForMapEntity(`vertex:noFly:${zone.id}:2`)).toBe(`noFly:${zone.id}`)
  })

  it("moves student waypoints and rejects unknown objects", () => {
    const scene = createDemoScene()
    const plan = createDemoPlan(scene)
    const drone = plan.dronePlans[0]!
    const waypoint = drone.waypoints[1]!
    const altitude = waypoint.position.altitude

    expect(moveMapObject(scene, plan, `waypoint:${drone.droneId}:${waypoint.id}`, movedPoint)).toBe(true)
    expect(waypoint.position).toEqual({ ...movedPoint, altitude })
    expect(moveMapObject(scene, plan, "unknown:item", movedPoint)).toBe(false)
  })
})
