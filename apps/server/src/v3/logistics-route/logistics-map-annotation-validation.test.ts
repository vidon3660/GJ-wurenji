import { describe, expect, it } from "vitest"
import { normalizeLogisticsMapAnnotations } from "./logistics-route.validation.js"

describe("SCN-004 logistics map annotations", () => {
  it("normalizes persistent WGS84 annotations with terrain elevation", () => {
    expect(normalizeLogisticsMapAnnotations([{
      id: "annotation-1",
      label: "等待区入口",
      position: { longitude: 114.001, latitude: 22.002 },
      heightMeters: 18.4
    }])).toEqual([{
      id: "annotation-1",
      label: "等待区入口",
      position: { longitude: 114.001, latitude: 22.002 },
      heightMeters: 18.4
    }])
  })

  it("rejects duplicate ids and coordinates outside WGS84", () => {
    expect(() => normalizeLogisticsMapAnnotations([
      { id: "same", label: "一", position: { longitude: 114, latitude: 22 }, heightMeters: null },
      { id: "same", label: "二", position: { longitude: 114.1, latitude: 22.1 }, heightMeters: null }
    ])).toThrow("地图文字标注 ID 重复")
    expect(() => normalizeLogisticsMapAnnotations([
      { id: "outside", label: "越界", position: { longitude: 181, latitude: 22 }, heightMeters: null }
    ])).toThrow("地图文字标注经度")
  })
})
