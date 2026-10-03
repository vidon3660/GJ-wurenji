import { CesiumTerrainProvider, createWorldTerrainAsync, EllipsoidTerrainProvider, Ion, type Viewer } from "cesium"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { createTeachingTerrainProvider } from "./teaching-map"

const DEFAULT_TERRAIN_REQUEST_TIMEOUT_MS = 8_000

export function terrainUrlForRegion(region: V3RegionCatalogItem | null | undefined): string {
  return region?.terrain?.url?.trim()
    || ((import.meta.env.VITE_OFFLINE_TERRAIN_URL as string | undefined) ?? "").trim()
    || ((import.meta.env.VITE_DEM_TERRAIN_URL as string | undefined) ?? "").trim()
}

export function terrainSampleUrlForRegion(region: V3RegionCatalogItem | null | undefined): string {
  return region?.terrain?.elevationSampleUrl?.trim() || ""
}

export type RegionTerrainState = "LOADING" | "ELLIPSOID" | "TEACHING" | "DEGRADED" | "CUSTOM_DEM" | "WORLD_TERRAIN" | "FAILED"

export function regionTerrainNoticeVisible(state: RegionTerrainState): boolean {
  // 在线地形是可接受的运行时回退，不再以常驻提示遮挡地图；真正需要处理的
  // 降级/失败状态仍然保留提示和重试入口。
  return ["ELLIPSOID", "TEACHING", "DEGRADED", "FAILED"].includes(state)
}

export function regionTerrainStateLabel(state: RegionTerrainState): string {
  return state === "LOADING"
    ? "高程加载中"
    : state === "CUSTOM_DEM"
      ? "正式 DEM"
      : state === "WORLD_TERRAIN"
        ? "在线地形"
        : state === "TEACHING"
          ? "教学起伏地形"
          : state === "DEGRADED"
            ? "高程已降级"
            : state === "FAILED"
            ? "椭球回退"
            : "椭球面"
}

export function regionTerrainStateDetail(state: RegionTerrainState, region?: V3RegionCatalogItem | null): string {
  if (state === "LOADING") return "正在读取区域高程资源，请稍候"
  if (state === "CUSTOM_DEM") {
    const version = region?.terrain?.version ?? region?.terrainResourceVersion
    const datum = region?.terrain?.verticalDatum ?? region?.heightDatum
    return `正式高程${version ? ` · v${version}` : ""}${datum ? ` · ${datum}` : ""}`
  }
  if (state === "WORLD_TERRAIN") return "在线地形"
  if (state === "TEACHING") return "教学起伏地形 · 非正式 DEM，仅用于训练表达"
  if (state === "DEGRADED") return "正式/在线高程加载失败，当前使用教学起伏地形 · 仅用于演示"
  if (state === "FAILED") return "正式/在线高程加载失败，当前按椭球面展示"
  return region?.boundary.length ? "当前未加载高程，按椭球面展示" : "区域资源不可用"
}

export interface TerrainLoadOptions {
  allowWorldTerrain?: boolean
  isCurrent?: () => boolean
}

export async function loadTerrainForRegion(
  viewer: Viewer,
  region: V3RegionCatalogItem | null | undefined,
  onState: (state: RegionTerrainState) => void,
  options: TerrainLoadOptions = {}
): Promise<void> {
  const hasTeachingRegion = (region?.boundary.length ?? 0) >= 3
  if (!hasTeachingRegion) {
    if (!canApplyTerrain(viewer, options)) return
    viewer.terrainProvider = new EllipsoidTerrainProvider()
    onState("ELLIPSOID")
    return
  }

  if (canApplyTerrain(viewer, options)) onState("LOADING")

  const terrainUrl = hasTeachingRegion ? terrainUrlForRegion(region) : ""
  let requestedTerrainFailed = false
  if (terrainUrl) {
    try {
      const provider = await withTimeout(CesiumTerrainProvider.fromUrl(terrainUrl, {
        requestVertexNormals: false,
        requestWaterMask: false
      }), terrainRequestTimeoutMs())
      if (!canApplyTerrain(viewer, options)) return
      viewer.terrainProvider = provider
      onState("CUSTOM_DEM")
      return
    } catch {
      requestedTerrainFailed = true
    }
  }

  if (hasTeachingRegion && (options.allowWorldTerrain ?? true) && worldTerrainEnabled()) {
    try {
      Ion.defaultAccessToken = ionToken()
      const provider = await withTimeout(createWorldTerrainAsync({
        requestVertexNormals: false,
        requestWaterMask: false
      }), terrainRequestTimeoutMs())
      if (!canApplyTerrain(viewer, options)) return
      viewer.terrainProvider = provider
      onState("WORLD_TERRAIN")
      return
    } catch {
      requestedTerrainFailed = true
    }
  }

  try {
    if (!canApplyTerrain(viewer, options)) return
    viewer.terrainProvider = createTeachingTerrainProvider(region)
    onState(requestedTerrainFailed ? "DEGRADED" : "TEACHING")
  } catch {
    if (!canApplyTerrain(viewer, options)) return
    viewer.terrainProvider = new EllipsoidTerrainProvider()
    onState("FAILED")
  }
}

function canApplyTerrain(viewer: Viewer, options: TerrainLoadOptions): boolean {
  if (options.isCurrent && !options.isCurrent()) return false
  return typeof viewer.isDestroyed !== "function" || !viewer.isDestroyed()
}

function ionToken(): string {
  return ((import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) ?? "").trim()
}

function worldTerrainEnabled(): boolean {
  return ionToken().length > 0 && import.meta.env.VITE_ENABLE_WORLD_TERRAIN === "true"
}

function terrainRequestTimeoutMs(): number {
  const configured = Number(import.meta.env.VITE_TERRAIN_REQUEST_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : DEFAULT_TERRAIN_REQUEST_TIMEOUT_MS
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("地形资源请求超时")), timeoutMs)
    promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}
