import { describe, expect, it } from "vitest"
import { createV3MapDataStateTracker, initialV3MapDataState, v3MapLoadingLabel } from "./map-loading-state"

describe("Cesium map loading state", () => {
  it("starts with terrain loading instead of claiming an ellipsoid fallback", () => {
    expect(initialV3MapDataState().terrain).toBe("LOADING")
  })

  it("keeps imagery and terrain results independent", () => {
    const tracker = createV3MapDataStateTracker(() => undefined)

    tracker.setImagery("FAILED")
    tracker.setTerrain("WORLD_TERRAIN")
    tracker.markInitialized()

    expect(tracker.current()).toMatchObject({ imagery: "FAILED", terrain: "WORLD_TERRAIN", phase: "READY", loadPercent: 100 })
  })

  it("reports monotonic progress inside one tile loading cycle", () => {
    const states: Array<{ pendingTiles: number; loadPercent: number; phase: string }> = []
    const tracker = createV3MapDataStateTracker((state) => states.push(state))
    tracker.markInitialized()
    tracker.setPendingTiles(12)
    tracker.setPendingTiles(8)
    tracker.setPendingTiles(14)
    tracker.setPendingTiles(4)
    tracker.setPendingTiles(0)

    const loading = states.filter((state) => state.phase === "LOADING")
    expect(loading.map((state) => state.loadPercent)).toEqual([0, 33, 33, 71])
    expect(tracker.current()).toMatchObject({ phase: "READY", pendingTiles: 0, loadPercent: 100 })
  })

  it("starts a fresh progress cycle after the camera requests more tiles", () => {
    const tracker = createV3MapDataStateTracker(() => undefined)
    tracker.markInitialized()
    tracker.setPendingTiles(10)
    tracker.setPendingTiles(0)
    tracker.setPendingTiles(6)

    expect(tracker.current()).toMatchObject({ phase: "LOADING", pendingTiles: 6, loadPercent: 0 })
  })

  it("settles failed imagery on the fallback layer while retries drain", () => {
    const tracker = createV3MapDataStateTracker(() => undefined)
    tracker.markInitialized()
    tracker.setPendingTiles(12)
    tracker.setImagery("FAILED")

    expect(tracker.current()).toMatchObject({ imagery: "FAILED", phase: "READY", pendingTiles: 0, loadPercent: 100 })

    tracker.setPendingTiles(8)
    expect(tracker.current()).toMatchObject({ phase: "READY", pendingTiles: 0, loadPercent: 100 })

    tracker.setPendingTiles(0)
    tracker.setPendingTiles(4)
    expect(tracker.current()).toMatchObject({ phase: "LOADING", pendingTiles: 4, loadPercent: 0 })

    tracker.setImagery("FAILED")
    expect(tracker.current()).toMatchObject({ phase: "READY", pendingTiles: 0, loadPercent: 100 })
  })

  it("settles online failures on the local teaching map", () => {
    const tracker = createV3MapDataStateTracker(() => undefined)
    tracker.markInitialized()
    tracker.setPendingTiles(7)
    tracker.setImagery("TEACHING")

    expect(tracker.current()).toMatchObject({ imagery: "TEACHING", phase: "READY", pendingTiles: 0, loadPercent: 100 })
    expect(v3MapLoadingLabel(tracker.current())).toBe("场景已加载 · 教学底图")
  })

  it("keeps a failed online imagery source visible as a degraded fallback", () => {
    const tracker = createV3MapDataStateTracker(() => undefined)
    tracker.markInitialized()
    tracker.setImagery("DEGRADED")

    expect(tracker.current()).toMatchObject({ imagery: "DEGRADED", phase: "READY", loadPercent: 100 })
    expect(v3MapLoadingLabel(tracker.current())).toBe("场景已加载 · 影像已降级")
  })

  it("provides consistent imagery state labels and recovery details", async () => {
    const { v3MapImageryStateDetail, v3MapImageryStateLabel } = await import("./map-loading-state")

    expect(v3MapImageryStateLabel("DEGRADED")).toBe("影像已降级")
    expect(v3MapImageryStateDetail("DEGRADED")).toContain("教学底图")
    expect(v3MapImageryStateLabel("LOADING")).toBe("影像加载中")
    expect(v3MapImageryStateDetail("LOADING")).toContain("正在读取区域影像资源")
  })

  it("reports a missing teaching region as an unavailable resource", () => {
    const tracker = createV3MapDataStateTracker(() => undefined)
    tracker.setImagery("UNAVAILABLE")
    tracker.markInitialized()

    expect(tracker.current()).toMatchObject({ imagery: "UNAVAILABLE", phase: "READY", loadPercent: 100 })
    expect(v3MapLoadingLabel(tracker.current())).toBe("区域资源不可用")
  })

  it("provides concise user-facing loading labels", () => {
    expect(v3MapLoadingLabel(initialV3MapDataState())).toBe("场景初始化")
    expect(v3MapLoadingLabel({ ...initialV3MapDataState(), phase: "LOADING", pendingTiles: 9, loadPercent: 42 })).toBe("场景 42% · 9 瓦片")
    expect(v3MapLoadingLabel({ ...initialV3MapDataState(), phase: "READY", imagery: "FAILED", loadPercent: 100 })).toBe("场景已加载 · 影像不可用")
  })
})
