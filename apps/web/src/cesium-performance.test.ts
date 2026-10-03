import { describe, expect, it } from "vitest"
import { v3CesiumPerformanceSettings } from "./cesium-performance"

describe("Cesium performance profiles", () => {
  it("uses the lightest detail settings for runtime playback", () => {
    const runtime = v3CesiumPerformanceSettings("RUNTIME")
    const edit = v3CesiumPerformanceSettings("EDIT")

    expect(runtime.settledScreenSpaceError).toBeGreaterThan(edit.settledScreenSpaceError)
    expect(runtime.movingScreenSpaceError).toBeGreaterThan(runtime.settledScreenSpaceError)
    expect(runtime.movingResolutionScale).toBeLessThan(1)
    expect(runtime.tileCacheSize).toBeLessThan(edit.tileCacheSize)
  })

  it("keeps editing detail higher than browsing detail", () => {
    expect(v3CesiumPerformanceSettings("EDIT").settledScreenSpaceError)
      .toBeLessThan(v3CesiumPerformanceSettings("BROWSE").settledScreenSpaceError)
  })
})
