import type { V3RegionCatalogItem } from "@wurenji/shared"
import type { Viewer } from "cesium"
import { addV3MapImagery } from "./map-imagery"
import type { V3MapDataStateTracker } from "./map-loading-state"
import { configureRegionMapConstraints } from "./map-region-constraints"
import { loadTerrainForRegion } from "./terrain"

export interface V3MapResourceLoadOptions {
  isCurrent?: () => boolean
  forceFreshImagery?: boolean
  manageRegionConstraints?: boolean
}

export async function loadV3MapResources(
  viewer: Viewer,
  region: V3RegionCatalogItem | null | undefined,
  tracker: V3MapDataStateTracker,
  options: V3MapResourceLoadOptions = {}
): Promise<() => void> {
  const removeRegionConstraints = options.manageRegionConstraints === false
    ? null
    : configureRegionMapConstraints(viewer, region)
  const [imageryCleanup] = await Promise.all([
    addV3MapImagery(viewer, region, tracker, options),
    loadTerrainForRegion(viewer, region, (terrain) => tracker.setTerrain(terrain), options)
  ])
  return () => {
    imageryCleanup()
    if (options.isCurrent?.() ?? true) removeRegionConstraints?.()
  }
}
