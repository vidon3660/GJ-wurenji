import type { RegionTerrainState } from "./terrain"

export type V3MapImageryState = "LOADING" | "READY" | "TEACHING" | "DEGRADED" | "FAILED" | "UNAVAILABLE" | "UNCONFIGURED"
export type V3MapLoadingPhase = "INITIALIZING" | "LOADING" | "READY"

export interface V3MapDataState {
  imagery: V3MapImageryState
  terrain: RegionTerrainState
  phase: V3MapLoadingPhase
  pendingTiles: number
  loadPercent: number
}

export interface V3MapDataStateTracker {
  current: () => V3MapDataState
  setImagery: (imagery: V3MapImageryState) => void
  setTerrain: (terrain: RegionTerrainState) => void
  setPendingTiles: (pendingTiles: number) => void
  markInitialized: () => void
}

export function initialV3MapDataState(): V3MapDataState {
  return {
    imagery: "LOADING",
    terrain: "LOADING",
    phase: "INITIALIZING",
    pendingTiles: 0,
    loadPercent: 0
  }
}

export function createV3MapDataStateTracker(onState: (state: V3MapDataState) => void): V3MapDataStateTracker {
  let initialized = false
  let ignorePendingUntilEmpty = false
  let peakPendingTiles = 0
  let cyclePercent = 0
  let state = initialV3MapDataState()

  const publish = () => {
    state = { ...state }
    onState(state)
  }

  const tracker: V3MapDataStateTracker = {
    current: () => ({ ...state }),
    setImagery: (imagery) => {
      state.imagery = imagery
      if (imagery === "DEGRADED" || imagery === "FAILED" || imagery === "TEACHING" || imagery === "UNAVAILABLE" || imagery === "UNCONFIGURED") {
        ignorePendingUntilEmpty = true
        peakPendingTiles = 0
        cyclePercent = initialized ? 100 : 0
        state.pendingTiles = 0
        state.loadPercent = cyclePercent
        state.phase = initialized ? "READY" : "INITIALIZING"
      }
      publish()
    },
    setTerrain: (terrain) => {
      state.terrain = terrain
      publish()
    },
    setPendingTiles: (value) => {
      const pendingTiles = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
      if (ignorePendingUntilEmpty) {
        if (pendingTiles === 0) ignorePendingUntilEmpty = false
        return
      }
      if (pendingTiles === 0) {
        peakPendingTiles = 0
        cyclePercent = initialized ? 100 : 0
        state.pendingTiles = 0
        state.loadPercent = cyclePercent
        state.phase = initialized ? "READY" : "INITIALIZING"
        publish()
        return
      }

      if (state.pendingTiles === 0) {
        peakPendingTiles = pendingTiles
        cyclePercent = 0
      } else {
        peakPendingTiles = Math.max(peakPendingTiles, pendingTiles)
      }
      cyclePercent = Math.max(cyclePercent, Math.round((1 - pendingTiles / Math.max(1, peakPendingTiles)) * 100))
      state.pendingTiles = pendingTiles
      state.loadPercent = Math.min(99, cyclePercent)
      state.phase = "LOADING"
      publish()
    },
    markInitialized: () => {
      initialized = true
      if (state.pendingTiles === 0) {
        state.phase = "READY"
        state.loadPercent = 100
      }
      publish()
    }
  }

  publish()
  return tracker
}

export function v3MapLoadingLabel(state: V3MapDataState): string {
  if (state.phase === "INITIALIZING") return "场景初始化"
  if (state.phase === "LOADING") return `场景 ${state.loadPercent}% · ${state.pendingTiles} 瓦片`
  if (state.imagery === "UNAVAILABLE") return "区域资源不可用"
  if (state.imagery === "UNCONFIGURED") return "场景已加载 · 正式影像待配置"
  if (state.imagery === "TEACHING") return "场景已加载 · 教学底图"
  if (state.imagery === "DEGRADED") return "场景已加载 · 影像已降级"
  return state.imagery === "FAILED" ? "场景已加载 · 影像不可用" : "场景已加载 · 在线影像"
}

export function v3MapImageryStateLabel(state: V3MapImageryState): string {
  if (state === "LOADING") return "影像加载中"
  if (state === "READY") return "在线影像"
  if (state === "TEACHING") return "教学底图"
  if (state === "DEGRADED") return "影像已降级"
  if (state === "FAILED") return "影像不可用"
  if (state === "UNCONFIGURED") return "正式影像未配置"
  return "区域资源不可用"
}

export function v3MapImageryStateDetail(state: V3MapImageryState): string {
  if (state === "LOADING") return "正在读取区域影像资源，请稍候"
  if (state === "READY") return "当前使用区域配置的在线影像"
  if (state === "TEACHING") return "当前使用教学底图，仅用于训练表达"
  if (state === "DEGRADED") return "在线影像加载失败，当前使用教学底图 · 仅用于演示"
  if (state === "FAILED") return "影像资源加载失败，当前地图可能不完整"
  if (state === "UNCONFIGURED") return "该区域未配置正式影像资源，当前使用教学底图 · 不可作为正式地图验收"
  return "当前区域资源不可用"
}
