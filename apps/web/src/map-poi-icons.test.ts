import { HeightReference, VerticalOrigin } from "cesium"
import { describe, expect, it } from "vitest"
import {
  createPoiBillboard,
  poiCategoryForLogisticsNode,
  poiCategoryForRegionFeature,
  poiIconDataUrl
} from "./map-poi-icons"

describe("MAP-B02 teaching POI icon module", () => {
  it("maps logistics node types to distinct POI categories", () => {
    expect(poiCategoryForLogisticsNode("TAKEOFF_POINT")).toBe("takeoff")
    expect(poiCategoryForLogisticsNode("LANDING_POINT")).toBe("landing")
    expect(poiCategoryForLogisticsNode("CENTER_AIRPORT")).toBe("airport")
    expect(poiCategoryForLogisticsNode("DELIVERY_POINT")).toBe("delivery")
    expect(poiCategoryForLogisticsNode("WAITING_POINT")).toBe("waiting")
    expect(poiCategoryForLogisticsNode("ALTERNATE_LANDING_POINT")).toBe("alternate")
    expect(poiCategoryForLogisticsNode("EMERGENCY_AREA")).toBe("emergency")
    expect(poiCategoryForLogisticsNode("PARKING_POINT")).toBe("generic")
  })

  it("classifies region layer points by teaching semantics", () => {
    expect(poiCategoryForRegionFeature("ENVIRONMENT", { obstacle: true })).toBe("obstacle")
    expect(poiCategoryForRegionFeature("COMMUNICATION")).toBe("communication")
    expect(poiCategoryForRegionFeature("BUILDINGS")).toBe("building")
    expect(poiCategoryForRegionFeature("POSITIONING")).toBe("generic")
  })

  it("emits self-contained svg data urls without any external service", () => {
    const url = poiIconDataUrl("takeoff", "normal")
    expect(url.startsWith("data:image/svg+xml;utf8,")).toBe(true)
    expect(url).not.toMatch(/https?:\/\//)
    expect(decodeURIComponent(url)).toContain("<svg")
  })

  it("renders a different icon per interaction state and caches stable results", () => {
    const normal = poiIconDataUrl("delivery", "normal")
    const selected = poiIconDataUrl("delivery", "selected")
    expect(normal).not.toBe(selected)
    expect(poiIconDataUrl("delivery", "selected")).toBe(selected)
  })

  it("anchors the billboard at the site so 2D and 3D positions match", () => {
    const billboard = createPoiBillboard("landing", { state: "hover" })
    expect(billboard.verticalOrigin).toBe(VerticalOrigin.BOTTOM)
    expect(billboard.heightReference).toBe(HeightReference.CLAMP_TO_GROUND)
    expect(billboard.width).toBeGreaterThan(0)
    expect(billboard.height).toBeGreaterThan(billboard.width)
    const selected = createPoiBillboard("landing", { state: "selected" })
    expect(selected.width).toBeGreaterThan(billboard.width)
  })
})
