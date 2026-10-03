import { describe, expect, it } from "vitest"
import { normalizeSelectedDeliveryPointIds, requiredDeliveryPointRange } from "./logistics-route.validation.js"

describe("STU-006 logistics delivery point selection", () => {
  it("uses the required range for every logistics scale template", () => {
    expect(requiredDeliveryPointRange("LOGISTICS-3")).toEqual({ minimum: 1, maximum: 1 })
    expect(requiredDeliveryPointRange("LOGISTICS-5")).toEqual({ minimum: 2, maximum: 3 })
    expect(requiredDeliveryPointRange("LOGISTICS-10")).toEqual({ minimum: 4, maximum: 6 })
    expect(requiredDeliveryPointRange("LOGISTICS-20")).toEqual({ minimum: 6, maximum: 8 })
    expect(requiredDeliveryPointRange("LOGISTICS-50")).toEqual({ minimum: 8, maximum: 12 })
  })

  it("normalizes a unique selection and rejects duplicates", () => {
    expect(normalizeSelectedDeliveryPointIds([" delivery-1 ", "delivery-2"])).toEqual(["delivery-1", "delivery-2"])
    expect(() => normalizeSelectedDeliveryPointIds(["delivery-1", "delivery-1"])).toThrow("启用配送点不能重复")
  })

  it("rejects empty and oversized delivery point selections", () => {
    expect(() => normalizeSelectedDeliveryPointIds([])).toThrow("启用配送点必须包含 1 到 12 项")
    expect(() => normalizeSelectedDeliveryPointIds(Array.from({ length: 13 }, (_, index) => `delivery-${index + 1}`))).toThrow("启用配送点必须包含 1 到 12 项")
  })
})
