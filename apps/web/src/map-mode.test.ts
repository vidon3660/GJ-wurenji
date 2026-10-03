import { describe, expect, it } from "vitest"
import { preferredV3MapMode } from "./map-mode"

describe("preferred V3 map mode", () => {
  it("uses 2D for precision planning stages", () => {
    for (const stageCode of ["SHOW_AREA_PLANNING", "LOGISTICS_ROUTE_PLANNING", "LOGISTICS_ORDER_SCHEDULING", "VTL_ROUTE_PLANNING"]) {
      expect(preferredV3MapMode(stageCode)).toBe("2d")
    }
  })

  it("uses 3D for runtime and review stages", () => {
    for (const stageCode of ["SHOW_RUNTIME", "LOGISTICS_DELIVERY_RUNTIME", "VTL_RUNTIME", "SHOW_REVIEW", undefined]) {
      expect(preferredV3MapMode(stageCode)).toBe("3d")
    }
  })
})
