import { describe, expect, it } from "vitest"
import type { V3RegionCatalogItem, V3ScenarioOverlayObject } from "@wurenji/shared"
import { validateScenarioOverlayObjects, validateScenarioOverlayPublish } from "./scenario-overlay.service.js"

const region = {
  sceneType: "CITY_LOGISTICS",
  boundary: [{ longitude: 0, latitude: 0 }, { longitude: 10, latitude: 0 }, { longitude: 10, latitude: 10 }, { longitude: 0, latitude: 10 }],
  layers: [{ code: "BASE", title: "基础", state: "READY", source: "fixture", version: "1", features: [{ id: "base-feature", name: "基础要素", geometryType: "POINT", position: { longitude: 2, latitude: 2 }, properties: {} }] }],
  logisticsNodes: [{ id: "node-1", code: "NODE-1", type: "DELIVERY_POINT", name: "节点", geometryType: "POINT", position: { longitude: 3, latitude: 3 }, enabled: true, properties: {} }]
} as V3RegionCatalogItem
const object = (type: V3ScenarioOverlayObject["type"], id: string, longitude = 1, latitude = 1): V3ScenarioOverlayObject => ({ id, code: id, name: id, type, geometryType: "POINT", position: { longitude, latitude }, geometry: { type: "Point", coordinates: [longitude, latitude] }, properties: {} })

describe("scenario overlay validation", () => {
  it("accepts WGS84 objects inside the immutable region boundary", () => {
    expect(validateScenarioOverlayObjects([object("TASK_POINT", "task-1")], region)).toHaveLength(1)
  })

  it("normalizes editor aliases and GeoJSON geometry", () => {
    const [item] = validateScenarioOverlayObjects([{ id: "corridor", name: "航路", type: "FLIGHT_CORRIDOR", geometry: { type: "LineString", coordinates: [[1, 1], [2, 2]] } }], region)
    expect(item).toMatchObject({ type: "AIRWAY", geometryType: "LINESTRING", geometry: { type: "LineString" } })
  })

  it("rejects objects outside the region boundary", () => {
    expect(() => validateScenarioOverlayObjects([object("TASK_POINT", "task-1", 20, 20)], region)).toThrow("超出区域范围")
  })

  it("accepts points on the boundary and rejects immutable ids or codes", () => {
    expect(validateScenarioOverlayObjects([object("TASK_POINT", "edge", 0, 5)], region)).toHaveLength(1)
    expect(() => validateScenarioOverlayObjects([object("TASK_POINT", "base-feature")], region)).toThrow("基础地图对象")
    expect(() => validateScenarioOverlayObjects([{ ...object("TASK_POINT", "custom"), code: "NODE-1" }], region)).toThrow("基础地图对象")
  })

  it("requires closed, non-self-intersecting polygons and preserves WGS84 order", () => {
    const polygon = {
      id: "area", code: "AREA", name: "区域", type: "EVENT_AREA", geometryType: "POLYGON",
      positions: [{ longitude: 1, latitude: 1 }, { longitude: 8, latitude: 1 }, { longitude: 8, latitude: 8 }, { longitude: 1, latitude: 1 }]
    }
    const [item] = validateScenarioOverlayObjects([polygon], region)
    expect(item.geometry).toEqual({ type: "Polygon", coordinates: [[[1, 1], [8, 1], [8, 8], [1, 1], [1, 1]]] })
    expect(() => validateScenarioOverlayObjects([{ ...polygon, positions: [{ longitude: 1, latitude: 1 }, { longitude: 8, latitude: 1 }, { longitude: 8, latitude: 8 }, { longitude: 1, latitude: 8 }] }], region)).toThrow("闭合")
    expect(() => validateScenarioOverlayObjects([{ ...polygon, positions: [{ longitude: 1, latitude: 1 }, { longitude: 8, latitude: 8 }, { longitude: 1, latitude: 8 }, { longitude: 8, latitude: 1 }, { longitude: 1, latitude: 1 }] }], region)).toThrow("自相交")
  })

  it("rejects duplicate codes and unsupported property values", () => {
    expect(() => validateScenarioOverlayObjects([object("TASK_POINT", "one"), { ...object("TASK_POINT", "two"), code: "one" }], region)).toThrow("编码重复")
    expect(() => validateScenarioOverlayObjects([{ ...object("TASK_POINT", "props"), properties: { nested: { value: true } } }], region)).toThrow("属性值")
    expect(() => validateScenarioOverlayObjects([{ ...object("TASK_POINT", "props"), properties: { long: "x".repeat(1001) } }], region)).toThrow("属性值")
  })

  it("requires the logistics minimum publish set", () => {
    const objects = [
      object("LOGISTICS_CENTER", "center"),
      object("DELIVERY_POINT", "delivery-1"), object("DELIVERY_POINT", "delivery-2"), object("DELIVERY_POINT", "delivery-3"),
      object("ALTERNATE_LANDING_POINT", "alternate-1"), object("ALTERNATE_LANDING_POINT", "alternate-2"),
      object("WAITING_POINT", "waiting-1"), object("WAITING_POINT", "waiting-2"), object("EVENT_AREA", "event-1")
    ]
    expect(() => validateScenarioOverlayPublish("CITY_LOGISTICS", objects, region)).not.toThrow()
    expect(() => validateScenarioOverlayPublish("CITY_LOGISTICS", objects.slice(0, 2), region)).toThrow("配送点")
  })

  it("rejects empty overlays for every scene", () => {
    expect(() => validateScenarioOverlayPublish("CITY_SHOW", [], { ...region, sceneType: "CITY_SHOW" })).toThrow("至少需要一个教学对象")
    expect(() => validateScenarioOverlayPublish("VTOL_INSPECTION", [], { ...region, sceneType: "VTOL_INSPECTION" })).toThrow("至少需要一个教学对象")
  })
})
