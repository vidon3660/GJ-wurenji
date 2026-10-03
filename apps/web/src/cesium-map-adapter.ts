import "cesium/Build/Cesium/Widgets/widgets.css"
import { SceneMode, Viewer } from "cesium"

export type CesiumMapMode = "2d" | "3d"

export interface CesiumMapAdapter {
  readonly viewer: Viewer
  setMode(mode: CesiumMapMode): void
  requestRender(): void
  destroy(): void
}

export interface CesiumMapViewerOptions {
  antialias?: boolean
  highResolution?: boolean
}

/**
 * Single Viewer lifecycle and scene-mode entry point for every map surface.
 * Business workspaces may own separate Viewer instances, but they all create
 * them through this adapter and therefore share the same Cesium defaults.
 */
export function createCesiumMapAdapter(container: Element, options: CesiumMapViewerOptions = {}): CesiumMapAdapter {
  const viewer = new Viewer(container, {
    baseLayer: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Number.POSITIVE_INFINITY,
    useBrowserRecommendedResolution: options.highResolution ? false : true,
    contextOptions: {
      webgl: {
        alpha: false,
        antialias: options.antialias ?? false,
        preserveDrawingBuffer: false
      }
    }
  })
  viewer.scene.debugShowFramesPerSecond = false

  return {
    viewer,
    setMode(mode) {
      viewer.scene.mode = mode === "2d" ? SceneMode.SCENE2D : SceneMode.SCENE3D
      viewer.scene.requestRender()
    },
    requestRender() {
      viewer.scene.requestRender()
    },
    destroy() {
      if (!viewer.isDestroyed()) viewer.destroy()
    }
  }
}

/** Compatibility helper for map components that need direct Viewer access. */
export function createUnifiedCesiumViewer(container: Element, options: CesiumMapViewerOptions = {}): Viewer {
  return createCesiumMapAdapter(container, options).viewer
}
