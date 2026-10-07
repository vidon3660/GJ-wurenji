import { Event as CesiumEvent, SceneMode, type Viewer } from "cesium"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { createV3MapDataStateTracker } from "./map-loading-state"
import { loadV3MapResources } from "./map-resources-loader"
import { addV3MapImagery } from "./map-imagery"
import { loadTerrainForRegion } from "./terrain"

vi.mock("./map-imagery", () => ({ addV3MapImagery: vi.fn() }))
vi.mock("./terrain", () => ({ loadTerrainForRegion: vi.fn() }))

const region = {
  boundary: [
    { longitude: 113.9, latitude: 22.5 }, { longitude: 113.96, latitude: 22.5 },
    { longitude: 113.96, latitude: 22.55 }, { longitude: 113.9, latitude: 22.55 }
  ]
} as V3RegionCatalogItem

function testViewer() {
  return {
    scene: {
      preUpdate: new CesiumEvent(), mode: SceneMode.SCENE3D,
      screenSpaceCameraController: { maximumZoomDistance: 900000, minimumZoomDistance: 1 }
    },
    camera: { maximumZoomFactor: 1.5, percentageChanged: 0.5, moveEnd: new CesiumEvent(), changed: new CesiumEvent() },
    isDestroyed: () => false
  } as unknown as Viewer
}
function expectListeners(viewer: Viewer, count: number) {
  expect(viewer.scene.preUpdate.numberOfListeners).toBe(count)
  expect(viewer.camera.moveEnd.numberOfListeners).toBe(count)
  expect(viewer.camera.changed.numberOfListeners).toBe(count)
}
function tracker() { return createV3MapDataStateTracker(() => {}) }

beforeEach(() => {
  vi.mocked(addV3MapImagery).mockReset().mockImplementation(async () => vi.fn<() => void>())
  vi.mocked(loadTerrainForRegion).mockReset().mockResolvedValue(undefined)
})

describe("map resource constraint ownership", () => {
  it("releases constraints even after the resource generation becomes stale", async () => {
    const viewer = testViewer()
    let generation = 0
    let cleanup: (() => void) | undefined
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = ++generation
      cleanup?.()
      cleanup = await loadV3MapResources(viewer, region, tracker(), { isCurrent: () => current === generation })
      expectListeners(viewer, 1)
    }
    generation += 1
    cleanup?.()
    cleanup?.()
    expectListeners(viewer, 0)
    expect(viewer.scene.screenSpaceCameraController.maximumZoomDistance).toBe(900000)
    expect(viewer.camera.maximumZoomFactor).toBe(1.5)
  })

  it("keeps only the new region during overlapping loads and ignores late old cleanup", async () => {
    const viewer = testViewer()
    let resolveOld!: (cleanup: () => void) => void
    const oldImageryCleanup = vi.fn()
    vi.mocked(addV3MapImagery).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    const oldLoad = loadV3MapResources(viewer, region, tracker())
    const newRegion = { ...region, boundary: region.boundary.map((point) => ({ ...point, longitude: point.longitude + 1, latitude: point.latitude + 1 })) }
    const newCleanup = await loadV3MapResources(viewer, newRegion, tracker())
    const currentMaximum = viewer.scene.screenSpaceCameraController.maximumZoomDistance
    expectListeners(viewer, 1)
    resolveOld(oldImageryCleanup)
    const oldCleanup = await oldLoad
    oldCleanup()
    oldCleanup()
    expect(oldImageryCleanup).toHaveBeenCalledTimes(1)
    expectListeners(viewer, 1)
    expect(viewer.scene.screenSpaceCameraController.maximumZoomDistance).toBe(currentMaximum)
    newCleanup()
    expectListeners(viewer, 0)
    expect(viewer.scene.screenSpaceCameraController.maximumZoomDistance).toBe(900000)
    expect(viewer.camera.percentageChanged).toBe(0.5)
  })

  it("cleans acquired imagery and constraints if terrain loading fails", async () => {
    const viewer = testViewer()
    const imageryCleanup = vi.fn()
    vi.mocked(addV3MapImagery).mockResolvedValueOnce(imageryCleanup)
    vi.mocked(loadTerrainForRegion).mockRejectedValueOnce(new Error("terrain interrupted"))
    await expect(loadV3MapResources(viewer, region, tracker())).rejects.toThrow("terrain interrupted")
    expect(imageryCleanup).toHaveBeenCalledTimes(1)
    expectListeners(viewer, 0)
  })

  it("does not take ownership when the caller manages region constraints", async () => {
    const viewer = testViewer()
    const cleanup = await loadV3MapResources(viewer, region, tracker(), { manageRegionConstraints: false })
    expectListeners(viewer, 0)
    cleanup()
    expect(viewer.scene.screenSpaceCameraController.maximumZoomDistance).toBe(900000)
  })
})
