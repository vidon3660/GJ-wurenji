import { Event as CesiumEvent } from "cesium"
import { describe, expect, it, vi } from "vitest"
import { listenForMapMorphComplete } from "./map-morph-listener"

describe("map morph completion listener", () => {
  it("runs once and removes itself before restoring the camera", () => {
    const event = new CesiumEvent<() => void>()
    const restoreCamera = vi.fn(() => {
      expect(event.numberOfListeners).toBe(0)
    })
    listenForMapMorphComplete(event, restoreCamera)

    expect(event.numberOfListeners).toBe(1)
    event.raiseEvent()
    event.raiseEvent()

    expect(restoreCamera).toHaveBeenCalledTimes(1)
    expect(event.numberOfListeners).toBe(0)
  })

  it("does not accumulate historical camera restores across repeated switches", () => {
    const event = new CesiumEvent<() => void>()
    const restoreCamera = vi.fn()

    for (let switchIndex = 0; switchIndex < 6; switchIndex += 1) {
      listenForMapMorphComplete(event, restoreCamera)
      expect(event.numberOfListeners).toBe(1)
      event.raiseEvent()
      expect(restoreCamera).toHaveBeenCalledTimes(switchIndex + 1)
      expect(event.numberOfListeners).toBe(0)
    }
  })

  it("cancels an unfinished switch before subscribing to its replacement", () => {
    const event = new CesiumEvent<() => void>()
    const restorePreviousCamera = vi.fn()
    const restoreLatestCamera = vi.fn()
    const cancelPrevious = listenForMapMorphComplete(event, restorePreviousCamera)

    cancelPrevious()
    // Completing the interrupted Cesium morph must not restore its old camera.
    event.raiseEvent()
    listenForMapMorphComplete(event, restoreLatestCamera)
    event.raiseEvent()

    expect(restorePreviousCamera).not.toHaveBeenCalled()
    expect(restoreLatestCamera).toHaveBeenCalledTimes(1)
    expect(event.numberOfListeners).toBe(0)
  })

  it("allows unmount to cancel repeatedly without removing another listener", () => {
    const event = new CesiumEvent<() => void>()
    const unrelatedListener = vi.fn()
    const restoreCamera = vi.fn()
    event.addEventListener(unrelatedListener)
    const cancel = listenForMapMorphComplete(event, restoreCamera)

    cancel()
    cancel()
    event.raiseEvent()

    expect(restoreCamera).not.toHaveBeenCalled()
    expect(unrelatedListener).toHaveBeenCalledTimes(1)
    expect(event.numberOfListeners).toBe(1)
  })

  it("preserves the next subscription created inside a completed callback", () => {
    const event = new CesiumEvent<() => void>()
    const restoreNextCamera = vi.fn()
    const restoreFirstCamera = vi.fn(() => {
      listenForMapMorphComplete(event, restoreNextCamera)
    })
    const cancelFirst = listenForMapMorphComplete(event, restoreFirstCamera)

    event.raiseEvent()
    cancelFirst()

    expect(restoreFirstCamera).toHaveBeenCalledTimes(1)
    expect(restoreNextCamera).not.toHaveBeenCalled()
    expect(event.numberOfListeners).toBe(1)

    event.raiseEvent()
    event.raiseEvent()

    expect(restoreFirstCamera).toHaveBeenCalledTimes(1)
    expect(restoreNextCamera).toHaveBeenCalledTimes(1)
    expect(event.numberOfListeners).toBe(0)
  })
})
