import { describe, expect, it } from "vitest"
import { SceneMode } from "cesium"
import { formatScaleDistance, mapScaleValue, niceScaleDistance } from "./map-scale"

describe("map scale", () => {
  it("rounds distances down to readable map scale values", () => {
    expect(niceScaleDistance(1)).toBe(1)
    expect(niceScaleDistance(178)).toBe(100)
    expect(niceScaleDistance(2_900)).toBe(2_000)
    expect(niceScaleDistance(8_100)).toBe(5_000)
  })

  it("formats metric labels for the scale bar", () => {
    expect(formatScaleDistance(250)).toBe("250 m")
    expect(formatScaleDistance(1_500)).toBe("1.5 km")
    expect(formatScaleDistance(12_000)).toBe("12 km")
    expect(formatScaleDistance(0.1)).toBe("0.1 m")
  })

  it("falls back to the camera frustum when ground picking is unavailable", () => {
    const viewer = {
      isDestroyed: () => false,
      scene: {
        mode: SceneMode.SCENE2D,
        canvas: { clientWidth: 1_000 },
        globe: { ellipsoid: {} }
      },
      camera: {
        computeViewRectangle: () => null,
        frustum: { left: -500, right: 500 },
        positionCartographic: { height: 1_000 }
      }
    } as never

    expect(mapScaleValue(viewer)?.distanceMeters).toBe(100)
    expect(mapScaleValue(viewer)?.label).toBe("100 m")
  })
})
