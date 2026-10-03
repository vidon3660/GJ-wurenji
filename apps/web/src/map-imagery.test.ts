import * as Cesium from "cesium"
import { Event as CesiumEvent, type ImageryProvider, type TileProviderError } from "cesium"
import { describe, expect, it, vi } from "vitest"
import { addV3MapImagery, createV3WorldImageryProvider, isV3WorldImageryEnabled, observeV3ImageryProvider } from "./map-imagery"

describe("Cesium imagery state", () => {
  it("reports asynchronous tile failures and detaches cleanly", () => {
    const errorEvent = new CesiumEvent<(error: TileProviderError) => void>()
    const setImagery = vi.fn()
    const removeListener = observeV3ImageryProvider(
      { errorEvent } as Pick<ImageryProvider, "errorEvent">,
      { setImagery }
    )

    expect(setImagery).toHaveBeenCalledWith("READY")
    errorEvent.raiseEvent({} as TileProviderError)
    expect(setImagery).toHaveBeenLastCalledWith("DEGRADED")

    removeListener()
    errorEvent.raiseEvent({} as TileProviderError)
    expect(setImagery).toHaveBeenCalledTimes(2)
  })

  it("does not create a global imagery layer when the teaching region is unavailable", async () => {
    const setImagery = vi.fn()
    const add = vi.fn()
    const cleanup = await addV3MapImagery(
      { isDestroyed: () => false, imageryLayers: { add } } as never,
      null,
      { setImagery }
    )

    expect(setImagery).toHaveBeenCalledWith("UNAVAILABLE")
    expect(add).not.toHaveBeenCalled()
    cleanup()
  })

  it("keeps world satellite imagery opt-in", () => {
    expect(isV3WorldImageryEnabled()).toBe(false)
  })

  it("uses a cache-busting ion endpoint for fresh world imagery retries", async () => {
    const provider = { errorEvent: new CesiumEvent() } as unknown as Cesium.IonImageryProvider
    const fromAssetId = vi.spyOn(Cesium.IonImageryProvider, "fromAssetId").mockResolvedValue(provider)

    await createV3WorldImageryProvider(true)

    expect(fromAssetId).toHaveBeenCalledTimes(1)
    expect(fromAssetId.mock.calls[0]?.[0]).toBe(Cesium.IonWorldImageryStyle.AERIAL)
    const server = fromAssetId.mock.calls[0]?.[1]?.server
    expect(server).toBeInstanceOf(Cesium.Resource)
    expect((server as Cesium.Resource).queryParameters.__wurenji_imagery_retry).toMatch(/^\d+-\d+$/)
    fromAssetId.mockRestore()
  })
})
