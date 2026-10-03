import { Cartesian3, Cartographic, Ellipsoid, Math as CesiumMath, Rectangle, SceneMode } from "cesium"
import { describe, expect, it, vi } from "vitest"
import { captureV3Camera, focusV3Coordinates, initialTwoDimensionalViewWidth, repairV3TwoDimensionalFrustum, restoreV3Camera, setV3CameraPreset, zoomV3Camera } from "./map-region-constraints"

describe("V3 camera presets", () => {
  it("zooms a 2D map from its orthographic frustum span", () => {
    const camera = {
      frustum: { left: -500, right: 500, top: 300, bottom: -300 },
      cancelFlight: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn()
    }
    const viewer = {
      isDestroyed: () => false,
      camera,
      scene: {
        mode: SceneMode.SCENE2D,
        globe: { ellipsoid: Ellipsoid.WGS84 },
        requestRender: vi.fn()
      }
    } as unknown as Parameters<typeof zoomV3Camera>[0]

    expect(zoomV3Camera(viewer, null, "2d", "in")).toBe(true)
    expect(camera.zoomIn.mock.calls[0]?.[0]).toBeCloseTo(192)
    expect(camera.zoomOut).not.toHaveBeenCalled()
    expect(camera.cancelFlight).toHaveBeenCalledOnce()
  })

  it("repairs an invalid off-center frustum during a projection morph", () => {
    const frustum = { left: 100, right: -100, top: 0, bottom: 0 }
    const viewer = {
      isDestroyed: () => false,
      camera: { frustum },
      scene: {
        mode: SceneMode.MORPHING,
        canvas: { clientWidth: 800, clientHeight: 400 }
      }
    } as unknown as Parameters<typeof repairV3TwoDimensionalFrustum>[0]

    expect(repairV3TwoDimensionalFrustum(viewer)).toBe(true)
    expect(frustum.right).toBeGreaterThan(frustum.left)
    expect(frustum.top).toBeGreaterThan(frustum.bottom)
  })

  it("does not apply a 3D preset while the map is in 2D mode", () => {
    const viewer = {} as Parameters<typeof setV3CameraPreset>[0]

    expect(setV3CameraPreset(viewer, null, "2d", "flight")).toBe(false)
  })

  it("starts a 2D map at the viewport width that produces a 200 m scale bar", () => {
    const viewer = { scene: { canvas: { clientWidth: 1_000, width: 1_000 } } } as unknown as Parameters<typeof initialTwoDimensionalViewWidth>[0]

    expect(initialTwoDimensionalViewWidth(viewer)).toBeCloseTo(1_378.38, 1)
  })

  it("keeps the current 2D scale when focusing a selected map element", () => {
    const camera = {
      frustum: { left: -350, right: 350, top: 250, bottom: -250 },
      flyTo: vi.fn(),
      positionCartographic: { height: 700 }
    }
    const viewer = {
      isDestroyed: () => false,
      camera,
      scene: {
        mode: SceneMode.SCENE2D,
        canvas: { clientWidth: 1_000, clientHeight: 700, width: 1_000, height: 700 }
      }
    } as unknown as Parameters<typeof focusV3Coordinates>[0]

    expect(focusV3Coordinates(viewer, [{ longitude: 113.3049, latitude: 23.085 }], "2d")).toBe(true)
    const destination = camera.flyTo.mock.calls[0]?.[0].destination
    expect(Cartographic.fromCartesian(destination).height).toBeCloseTo(700, 1)
  })

  it("captures the 2D screen center and restores its width after a morph", () => {
    const center = Cartesian3.fromDegrees(113.31, 23.08)
    const camera = {
      frustum: { left: -500, right: 500, top: 300, bottom: -300 },
      heading: 0.2,
      pitch: -CesiumMath.PI_OVER_TWO,
      getPickRay: vi.fn(() => null),
      pickEllipsoid: vi.fn(() => center),
      cancelFlight: vi.fn(),
      flyTo: vi.fn()
    }
    const viewer = {
      isDestroyed: () => false,
      camera,
      scene: {
        mode: SceneMode.SCENE2D,
        canvas: { clientWidth: 1_000, clientHeight: 600, width: 1_000, height: 600 },
        globe: { ellipsoid: Ellipsoid.WGS84, pick: vi.fn(() => null) },
        requestRender: vi.fn()
      }
    } as unknown as Parameters<typeof captureV3Camera>[0]

    const snapshot = captureV3Camera(viewer)
    expect(snapshot?.center.longitude).toBeCloseTo(113.31, 5)
    expect(snapshot?.metersPerPixel).toBeCloseTo(1, 5)
    expect(restoreV3Camera(viewer, snapshot, "2d")).toBe(true)
    expect(camera.flyTo.mock.calls[0]?.[0].destination).toBeDefined()
    expect(Cartographic.fromCartesian(camera.flyTo.mock.calls[0]![0].destination).height).toBeCloseTo(1_000, 1)
  })

  it("returns no transition snapshot when the viewport is invalid", () => {
    const viewer = {
      isDestroyed: () => false,
      camera: {},
      scene: { canvas: { clientWidth: 0, clientHeight: 0, width: 0, height: 0 } }
    } as unknown as Parameters<typeof captureV3Camera>[0]
    expect(captureV3Camera(viewer)).toBeNull()
    expect(restoreV3Camera(viewer, null, "3d")).toBe(false)
  })

  it("uses a north-up vertical view for the 3D top-down preset", () => {
    const camera = {
      computeViewRectangle: () => Rectangle.fromDegrees(113.9, 22.5, 114, 22.6),
      positionWC: Cartesian3.fromDegrees(114, 22.55, 900),
      heading: 0.8,
      cancelFlight: vi.fn(),
      lookAt: vi.fn(),
      lookAtTransform: vi.fn()
    }
    const viewer = {
      camera,
      scene: { mode: SceneMode.SCENE2D, globe: { ellipsoid: Ellipsoid.WGS84 }, requestRender: vi.fn() }
    } as unknown as Parameters<typeof setV3CameraPreset>[0]

    expect(setV3CameraPreset(viewer, null, "3d", "top-down")).toBe(true)
    const offset = camera.lookAt.mock.calls[0]?.[1]
    expect(offset.heading).toBe(0)
    expect(offset.pitch).toBe(-CesiumMath.PI_OVER_TWO)
    expect(camera.cancelFlight).toHaveBeenCalledOnce()
    expect(camera.lookAtTransform).not.toHaveBeenCalled()
  })

  it("keeps the current heading for the 3D flight preset", () => {
    const camera = {
      computeViewRectangle: () => Rectangle.fromDegrees(113.9, 22.5, 114, 22.6),
      positionWC: Cartesian3.fromDegrees(114, 22.55, 900),
      heading: 0.8,
      cancelFlight: vi.fn(),
      lookAt: vi.fn(),
      lookAtTransform: vi.fn()
    }
    const viewer = {
      camera,
      scene: { mode: SceneMode.SCENE2D, globe: { ellipsoid: Ellipsoid.WGS84 }, requestRender: vi.fn() }
    } as unknown as Parameters<typeof setV3CameraPreset>[0]

    expect(setV3CameraPreset(viewer, null, "3d", "flight")).toBe(true)
    const offset = camera.lookAt.mock.calls[0]?.[1]
    expect(offset.heading).toBe(0.8)
    expect(offset.pitch).toBe(CesiumMath.toRadians(-35))
    expect(camera.lookAtTransform).not.toHaveBeenCalled()
  })
})
