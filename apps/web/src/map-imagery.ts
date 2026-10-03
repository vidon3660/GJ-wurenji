import type { V3RegionCatalogItem } from "@wurenji/shared"
import {
  Ion,
  ImageryLayer,
  IonImageryProvider,
  IonWorldImageryStyle,
  Color,
  Rectangle,
  Resource,
  SingleTileImageryProvider,
  UrlTemplateImageryProvider,
  createWorldImageryAsync,
  type ImageryProvider,
  type Viewer
} from "cesium"
import { hasConfiguredImagery, imageryRectangleForRegion, imageryTemplateForRegion } from "./map-resources"
import type { V3MapDataStateTracker } from "./map-loading-state"
import { regionRectangle } from "./map-region-constraints"
import { createTeachingImageryProvider } from "./teaching-map"

export function observeV3ImageryProvider(
  provider: Pick<ImageryProvider, "errorEvent">,
  tracker: Pick<V3MapDataStateTracker, "setImagery">
): () => void {
  const removeErrorListener = provider.errorEvent.addEventListener(() => tracker.setImagery("DEGRADED"))
  tracker.setImagery("READY")
  return removeErrorListener
}

export interface V3MapImageryLoadOptions {
  isCurrent?: () => boolean
  forceFreshImagery?: boolean
}

export async function addV3MapImagery(
  viewer: Viewer,
  region: V3RegionCatalogItem | null | undefined,
  tracker: Pick<V3MapDataStateTracker, "setImagery">,
  options: V3MapImageryLoadOptions = {}
): Promise<() => void> {
  const hasTeachingRegion = (region?.boundary.length ?? 0) >= 3
  if (!hasTeachingRegion) {
    tracker.setImagery("UNAVAILABLE")
    return () => undefined
  }

  const clippedRectangle = regionRectangle(region)
  const hasRequestedImagery = hasConfiguredImagery(region) || (!hasConfiguredImagery(region) && isV3WorldImageryEnabled())
  let teachingLayer: ImageryLayer | null = null
  const ensureTeachingLayer = () => {
    if (teachingLayer || viewer.isDestroyed()) return
    teachingLayer = new ImageryLayer(
      createTeachingImageryProvider(region),
      clippedRectangle ? { rectangle: clippedRectangle } : undefined
    )
    viewer.imageryLayers.add(teachingLayer)
  }
  if (!hasRequestedImagery) ensureTeachingLayer()
  tracker.setImagery(hasRequestedImagery ? "LOADING" : "UNCONFIGURED")

  let provider: ImageryProvider | null = null
  try {
    if (hasConfiguredImagery(region)) {
      const template = imageryTemplateForRegion(region)
      // A local XYZ/TMS package only contains tiles for its declared region.
      // Always constrain the provider itself as well as the imagery layer;
      // otherwise Cesium treats the template as global and stretches the edge
      // tile over the missing world area.
      const configuredExtent = imageryRectangleForRegion(region)
      const rectangle = configuredExtent
        ? Rectangle.fromDegrees(...configuredExtent)
        : clippedRectangle
      if (region?.imagery?.provider === "SINGLE_TILE") {
        provider = await SingleTileImageryProvider.fromUrl(template, {
          ...(rectangle ? { rectangle } : {})
        })
      } else {
        const url = region?.imagery?.provider === "TMS"
        ? template.replaceAll("{y}", "{reverseY}")
        : template
        // Do not let Cesium request a level-0/level-1 parent tile for a
        // small offline package. A parent tile often contains only the edge
        // pixel of the package, which Cesium then stretches across the whole
        // tile while finer tiles are still loading. Start at the first level
        // whose tile width is comparable to the declared extent.
        const minimumLevel = minimumImageryLevel(rectangle)
        provider = new UrlTemplateImageryProvider({
          url,
          enablePickFeatures: false,
          hasAlphaChannel: false,
          minimumLevel,
          ...(rectangle ? { rectangle } : {})
        })
      }
    } else if (isV3WorldImageryEnabled()) {
      provider = await createV3WorldImageryProvider(Boolean(options.forceFreshImagery))
    }
  } catch {
    provider = null
  }

  if (!provider || viewer.isDestroyed() || !isCurrent(options)) {
    if (isCurrent(options)) {
      ensureTeachingLayer()
      tracker.setImagery(hasRequestedImagery ? "DEGRADED" : "UNCONFIGURED")
    }
    return () => {
      if (teachingLayer && !viewer.isDestroyed()) viewer.imageryLayers.remove(teachingLayer, true)
    }
  }

  let layer: ImageryLayer | null = null
  let failed = false
  let restoreBaseColor: (() => void) | null = null
  try {
    layer = new ImageryLayer(
      provider,
      clippedRectangle ? { rectangle: clippedRectangle } : undefined
    )
    viewer.imageryLayers.add(layer)
    // The globe base color is what Cesium shows wherever the clipped local
    // imagery layer has no tile. Keep that area black so missing tiles cannot
    // expose a stretched edge texture or an online fallback map.
    const globe = viewer.scene?.globe
    const previousBaseColor = globe?.baseColor
    if (globe && hasConfiguredImagery(region)) {
      globe.baseColor = Color.BLACK
      restoreBaseColor = () => {
        if (previousBaseColor) globe.baseColor = previousBaseColor
      }
    }
    const removeErrorListener = provider.errorEvent.addEventListener(() => {
      if (failed || !isCurrent(options)) return
      failed = true
      if (layer && !viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true)
      restoreBaseColor?.()
      ensureTeachingLayer()
      tracker.setImagery("DEGRADED")
    })
    if (!isCurrent(options)) {
      removeErrorListener()
      if (layer && !viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true)
      restoreBaseColor?.()
      return () => {
        if (teachingLayer && !viewer.isDestroyed()) viewer.imageryLayers.remove(teachingLayer, true)
      }
    }
    tracker.setImagery("READY")
    return () => {
      removeErrorListener?.()
      if (layer && !viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true)
      restoreBaseColor?.()
      if (teachingLayer && !viewer.isDestroyed()) viewer.imageryLayers.remove(teachingLayer, true)
    }
  } catch {
    if (layer && !viewer.isDestroyed()) viewer.imageryLayers.remove(layer, true)
    restoreBaseColor?.()
    if (isCurrent(options)) {
      ensureTeachingLayer()
      tracker.setImagery(hasRequestedImagery ? "DEGRADED" : "UNCONFIGURED")
    }
    return () => {
      if (teachingLayer && !viewer.isDestroyed()) viewer.imageryLayers.remove(teachingLayer, true)
    }
  }
}

function minimumImageryLevel(rectangle: Rectangle | null): number {
  if (!rectangle) return 0
  const spanDegrees = Math.max(0.01, (rectangle.east - rectangle.west) * 180 / Math.PI)
  return Math.max(2, Math.min(17, Math.ceil(Math.log2(180 / (spanDegrees * 1.5)))))
}

let worldImageryRetrySequence = 0

export async function createV3WorldImageryProvider(forceFresh: boolean): Promise<ImageryProvider> {
  Ion.defaultAccessToken = ionToken()
  if (!forceFresh) return createWorldImageryAsync()

  const server = (typeof Ion.defaultServer === "string"
    ? new Resource({ url: Ion.defaultServer })
    : Ion.defaultServer).getDerivedResource({
      queryParameters: {
        __wurenji_imagery_retry: `${Date.now()}-${++worldImageryRetrySequence}`
      }
    })
  return IonImageryProvider.fromAssetId(IonWorldImageryStyle.AERIAL, { server })
}

function isCurrent(options: V3MapImageryLoadOptions): boolean {
  return options.isCurrent?.() ?? true
}

function ionToken(): string {
  return ((import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) ?? "").trim()
}

export function isV3WorldImageryEnabled(): boolean {
  // V3 教学地图默认使用限定区域的浅色教学底图。世界卫星影像
  // 只作为明确开启的诊断/对照图层，避免在线瓦片缺失时出现拉伸。
  return ionToken().length > 0 && import.meta.env.VITE_ENABLE_WORLD_IMAGERY === "true"
}
