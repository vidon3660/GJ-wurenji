import { describe, expect, it } from "vitest"
import type { LogisticsRouteInput, LogisticsRuntimeAircraftView, LogisticsRuntimeEventView, LogisticsRuntimeRouteView } from "@wurenji/shared"
import { isSelectedLogisticsRouteEntity, logisticsFocusCoordinates, logisticsNodeTypeVisible, logisticsRuntimeFocusCoordinates } from "./logistics-map-tools"

const route = {
  id: "route-1",
  waypoints: [
    { id: "waypoint-1", position: { longitude: 114, latitude: 22 } },
    { id: "waypoint-2", position: { longitude: 114.01, latitude: 22.01 } }
  ]
} as LogisticsRouteInput

describe("SCN-003/005 logistics map tools", () => {
  it("filters node types independently", () => {
    expect(logisticsNodeTypeVisible("WAITING_POINT", ["WAITING_POINT"])).toBe(true)
    expect(logisticsNodeTypeVisible("ALTERNATE_LANDING_POINT", ["WAITING_POINT"])).toBe(false)
  })

  it("recognizes route geometry for insertion on the selected route", () => {
    expect(isSelectedLogisticsRouteEntity("log-route:route-1:center:0", "route-1")).toBe(true)
    expect(isSelectedLogisticsRouteEntity("log-route:route-1:protection:0", "route-1")).toBe(true)
    expect(isSelectedLogisticsRouteEntity("log-route:route-2:center:0", "route-1")).toBe(false)
    expect(isSelectedLogisticsRouteEntity("log-waypoint:route-1:waypoint-1", "route-1")).toBe(false)
  })

  it("focuses a selected waypoint before its route", () => {
    expect(logisticsFocusCoordinates([route], route.id, "waypoint-2")).toEqual([{ longitude: 114.01, latitude: 22.01 }])
    expect(logisticsFocusCoordinates([route], route.id, "")).toEqual(route.waypoints.map((item) => item.position))
    expect(logisticsFocusCoordinates([route], "missing", "")).toEqual([])
  })

  it("prioritizes selected runtime events, aircraft and routes", () => {
    const runtimeRoute = { id: "runtime-route", waypoints: route.waypoints } as LogisticsRuntimeRouteView
    const runtimeAircraft = { id: "aircraft-1", position: { longitude: 114.005, latitude: 22.005 } } as LogisticsRuntimeAircraftView
    const runtimeEvent = { id: "event-1", affectedAircraftIds: [runtimeAircraft.id], affectedRouteIds: [] } as unknown as LogisticsRuntimeEventView

    expect(logisticsRuntimeFocusCoordinates([runtimeRoute], [runtimeAircraft], [runtimeEvent], runtimeRoute.id, runtimeAircraft.id, runtimeEvent.id)).toEqual([runtimeAircraft.position])
    expect(logisticsRuntimeFocusCoordinates([runtimeRoute], [runtimeAircraft], [], runtimeRoute.id, runtimeAircraft.id, "")).toEqual([runtimeAircraft.position])
    expect(logisticsRuntimeFocusCoordinates([runtimeRoute], [], [], runtimeRoute.id, "", "")).toEqual(route.waypoints.map((item) => item.position))
  })
})
