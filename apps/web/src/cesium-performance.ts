import { type Viewer } from "cesium"
import { mapBasemapColors, mapColor } from "./map-visual-theme"

export type V3CesiumPerformanceProfile = "BROWSE" | "EDIT" | "RUNTIME"

interface V3CesiumPerformanceSettings {
  settledScreenSpaceError: number
  movingScreenSpaceError: number
  movingResolutionScale: number
  tileCacheSize: number
  loadingDescendantLimit: number
}

const performanceSettings: Record<V3CesiumPerformanceProfile, V3CesiumPerformanceSettings> = {
  BROWSE: {
    settledScreenSpaceError: 7,
    movingScreenSpaceError: 14,
    movingResolutionScale: 0.82,
    tileCacheSize: 64,
    loadingDescendantLimit: 20
  },
  EDIT: {
    settledScreenSpaceError: 5,
    movingScreenSpaceError: 12,
    movingResolutionScale: 0.86,
    tileCacheSize: 96,
    loadingDescendantLimit: 28
  },
  RUNTIME: {
    settledScreenSpaceError: 8,
    movingScreenSpaceError: 16,
    movingResolutionScale: 0.76,
    tileCacheSize: 48,
    loadingDescendantLimit: 16
  }
}

export function v3CesiumPerformanceSettings(profile: V3CesiumPerformanceProfile): Readonly<V3CesiumPerformanceSettings> {
  return performanceSettings[profile]
}

export function configureV3CesiumPerformance(
  viewer: Viewer,
  profile: V3CesiumPerformanceProfile
): () => void {
  const settings = performanceSettings[profile]
  const { scene } = viewer
  const settledResolutionScale = 1
  let settleTimer: number | null = null

  scene.backgroundColor = mapColor(mapBasemapColors.emptyCanvas)
  viewer.useBrowserRecommendedResolution = true
  scene.globe.maximumScreenSpaceError = settings.settledScreenSpaceError
  scene.globe.tileCacheSize = settings.tileCacheSize
  scene.globe.loadingDescendantLimit = settings.loadingDescendantLimit
  scene.globe.preloadAncestors = false
  scene.globe.preloadSiblings = false
  scene.globe.showGroundAtmosphere = false
  scene.globe.enableLighting = false
  scene.fog.enabled = false
  scene.highDynamicRange = false
  scene.msaaSamples = 1
  scene.postProcessStages.fxaa.enabled = false
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  if (scene.skyBox) scene.skyBox.show = false
  if (scene.sun) scene.sun.show = false
  if (scene.moon) scene.moon.show = false

  const applySettledQuality = () => {
    settleTimer = null
    viewer.resolutionScale = settledResolutionScale
    scene.globe.maximumScreenSpaceError = settings.settledScreenSpaceError
    scene.requestRender()
  }

  const scheduleSettledQuality = (delayMs: number) => {
    if (settleTimer !== null) window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(applySettledQuality, delayMs)
  }

  const useMovingQuality = () => {
    viewer.resolutionScale = settings.movingResolutionScale
    scene.globe.maximumScreenSpaceError = settings.movingScreenSpaceError
    scene.requestRender()
    scheduleSettledQuality(500)
  }

  const restoreSettledQuality = () => {
    scheduleSettledQuality(120)
  }

  const removeMoveStartListener = viewer.camera.moveStart.addEventListener(useMovingQuality)
  const removeMoveEndListener = viewer.camera.moveEnd.addEventListener(restoreSettledQuality)

  return () => {
    if (settleTimer !== null) window.clearTimeout(settleTimer)
    removeMoveStartListener()
    removeMoveEndListener()
  }
}
