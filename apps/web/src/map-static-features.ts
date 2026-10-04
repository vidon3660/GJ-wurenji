import type { V3RegionCatalogItem, V3RegionFeature, V3RegionLayerCode } from "@wurenji/shared"
import { Cartesian3, Color, CustomDataSource, DistanceDisplayCondition, HeightReference, PolygonHierarchy } from "cesium"
import { featureHeightMeters, isObstacleFeature, obstacleRadiusMeters } from "./map-3d-feature"
import { regionSpanMeters } from "./map-region-constraints"
import {
  buildingColorForHeight,
  mapBuildingColors,
  mapColor,
  mapObstacleColors,
  mapRestrictionColors,
  regionLayerCesiumColors
} from "./map-visual-theme"

export function renderRegionStaticFeatures(
  source: CustomDataSource,
  region: V3RegionCatalogItem | null,
  mode: "2d" | "3d",
  idPrefix: string,
  visibleLayers: readonly V3RegionLayerCode[] = ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"],
  options: { skipBuildingFootprints?: boolean } = {}
): void {
  if (!region) return
  const threeDDisplayCondition = mode === "3d" ? new DistanceDisplayCondition(0, staticFeatureFarDistance(region)) : undefined
  const visible = new Set(visibleLayers)
  for (const layer of region.layers) {
    if (!visible.has(layer.code)) continue
    if (layer.state === "UNAVAILABLE") continue
    for (const feature of layer.features) {
      // Imported packages may keep a lightweight manifest footprint for
      // teaching. Once the authoritative GeoJSON has loaded, callers can
      // suppress only those polygons while retaining manifest obstacles.
      if (options.skipBuildingFootprints
        && layer.code === "BUILDINGS"
        && feature.geometryType === "POLYGON"
        && feature.properties?.category === "BUILDING") continue
      addRegionFeature(source, layer.code, feature, mode, idPrefix, threeDDisplayCondition)
    }
  }
}

function addRegionFeature(
  source: CustomDataSource,
  code: V3RegionLayerCode,
  feature: V3RegionFeature,
  mode: "2d" | "3d",
  idPrefix: string,
  threeDDisplayCondition?: DistanceDisplayCondition
): void {
  const baseColor = regionLayerCesiumColors[code]
  const id = `${idPrefix}:layer:${code}:${feature.id}`
  if (feature.geometryType === "LINESTRING" && feature.positions && feature.positions.length >= 2) {
    source.entities.add({
      id,
      name: feature.name,
      polyline: {
        positions: Cartesian3.fromDegreesArray(flatten(feature.positions)),
        width: code === "WATER" ? 3.5 : 2.5,
        material: baseColor.withAlpha(code === "WATER" ? 0.78 : 0.62),
        clampToGround: true,
        ...(threeDDisplayCondition ? { distanceDisplayCondition: threeDDisplayCondition } : {})
      }
    })
    return
  }
  if (feature.geometryType === "POLYGON" && feature.positions && feature.positions.length >= 3) {
    const knownHeight = typeof feature.heightMeters === "number" && Number.isFinite(feature.heightMeters) && feature.heightMeters > 0
    const heightMeters = knownHeight ? (feature.heightMeters ?? 0) : 0
    const isBuilding = code === "BUILDINGS"
    const extruded = mode === "3d" && isBuilding
    const extrusionHeight = extruded ? (knownHeight ? heightMeters : mapBuildingColors.fallbackHeightMeters) : 0
    const restriction = code === "RESTRICTIONS"
    const naturalArea = code === "WATER" || code === "GREENLAND"
    const fillColor = extruded
      ? buildingColorForHeight(extrusionHeight).withAlpha(mapBuildingColors.extrudedAlpha)
      : restriction
        ? baseColor.withAlpha(mapRestrictionColors.flatAlpha)
        : naturalArea
          ? baseColor.withAlpha(code === "WATER" ? 0.34 : 0.22)
        : isBuilding
          ? buildingColorForHeight(0).withAlpha(mapBuildingColors.flatAlpha)
          : baseColor.withAlpha(0.18)
    const outlineColor = extruded
      ? mapColor(mapBuildingColors.outline3d)
      : isBuilding && !restriction
        ? mapColor(mapBuildingColors.outline2d)
        : baseColor.withAlpha(naturalArea ? 0.68 : 1)
    source.entities.add({
      id,
      name: extruded && !knownHeight ? `${feature.name}（高度未提供）` : feature.name,
      polygon: {
        hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(flatten(feature.positions))),
        material: fillColor,
        height: 0,
        heightReference: extrusionHeight > 0 ? HeightReference.RELATIVE_TO_GROUND : HeightReference.CLAMP_TO_GROUND,
        ...(extrusionHeight > 0 ? { extrudedHeight: extrusionHeight, extrudedHeightReference: HeightReference.RELATIVE_TO_GROUND } : {}),
        ...(threeDDisplayCondition ? { distanceDisplayCondition: threeDDisplayCondition } : {})
      },
      ...(!extruded ? {
        polyline: {
          positions: Cartesian3.fromDegreesArray(flattenClosed(feature.positions)),
          width: restriction ? (mode === "3d" ? mapRestrictionColors.outlineWidth3d : mapRestrictionColors.outlineWidth2d) : 1.5,
          material: outlineColor,
          clampToGround: true
        }
      } : {})
    })
    return
  }

  if (feature.geometryType !== "POINT" || !feature.position) return
  const heightMeters = featureHeightMeters(feature)
  const obstacle = isObstacleFeature(feature)
  const extrudedObstacle = mode === "3d" && obstacle && heightMeters > 0
  const pointColor = obstacle ? mapColor(mapObstacleColors.fill) : baseColor
  const positionHeight = extrudedObstacle ? heightMeters / 2 : mode === "3d" ? heightMeters : 0
  const coverageMeters = Number(feature.properties.coverageMeters ?? 0)
  source.entities.add({
    id,
    name: feature.name,
    position: Cartesian3.fromDegrees(feature.position.longitude, feature.position.latitude, positionHeight),
    ...(extrudedObstacle ? {
      cylinder: {
        length: heightMeters,
        topRadius: obstacleRadiusMeters(feature) * 0.45,
        bottomRadius: obstacleRadiusMeters(feature),
        material: pointColor.withAlpha(mapObstacleColors.cylinderAlpha),
        outlineColor: mapColor(mapObstacleColors.label),
        outlineWidth: 2,
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        ...(threeDDisplayCondition ? { distanceDisplayCondition: threeDDisplayCondition } : {})
      }
    } : {
      point: {
        pixelSize: 10,
        color: pointColor,
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        heightReference: mode === "3d" ? HeightReference.RELATIVE_TO_GROUND : HeightReference.CLAMP_TO_GROUND,
        ...(threeDDisplayCondition ? { distanceDisplayCondition: threeDDisplayCondition } : {})
      }
    }),
    ...(coverageMeters > 0 ? {
      ellipse: {
        semiMajorAxis: coverageMeters,
        semiMinorAxis: coverageMeters,
        material: pointColor.withAlpha(0.08),
        height: 0,
        heightReference: HeightReference.CLAMP_TO_GROUND,
        ...(threeDDisplayCondition ? { distanceDisplayCondition: threeDDisplayCondition } : {})
      }
    } : {})
  })
}

function staticFeatureFarDistance(region: Pick<V3RegionCatalogItem, "boundary">): number {
  return Math.max(5_000, Math.min(50_000, regionSpanMeters(region) * 3))
}

function flatten(points: readonly { longitude: number; latitude: number }[]): number[] {
  return points.flatMap((point) => [point.longitude, point.latitude])
}

function flattenClosed(points: readonly { longitude: number; latitude: number }[]): number[] {
  return points[0] ? flatten([...points, points[0]]) : []
}
