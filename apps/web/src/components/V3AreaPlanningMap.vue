<script setup lang="ts">
import { listenForMapMorphComplete } from "../map-morph-listener"
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomDataSource,
  HeightReference,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Viewer
} from "cesium"
import type {
  ShowAreaAnnotationInput,
  ShowAreaDistanceMeasurement,
  ShowAreaFeatureInput,
  ShowAreaFeatureType,
  ShowAreaFeatureView,
  ShowAreaMeasuredPoint,
  V3Coordinate,
  V3RegionCatalogItem,
  V3RegionFeature,
  V3RegionLayerCode
} from "@wurenji/shared"
import { rectangleFromDiagonal } from "../area-drawing"
import { createDistanceMeasurement } from "../area-measurement"
import { configureV3CesiumPerformance } from "../cesium-performance"
import { createUnifiedCesiumViewer } from "../cesium-map-adapter"
import { createMapLabelAppearance } from "../map-label-policy"
import {
  buildingColorForHeight,
  mapBasemapColors,
  mapBuildingColors,
  mapColor,
  mapColorAlpha,
  mapInteractionColors,
  mapObstacleColors,
  mapRegionColors,
  mapRestrictionColors,
  regionLayerCesiumColors,
  showAreaFeatureColors
} from "../map-visual-theme"
import { createV3MapDataStateTracker, type V3MapDataState, type V3MapDataStateTracker, type V3MapImageryState } from "../map-loading-state"
import { regionMapResourceKey } from "../map-resources"
import { loadV3MapResources } from "../map-resources-loader"
import { captureV3Camera, configureRegionMapConstraints, focusV3Region, isCoordinateInsideRegion, regionMaskHierarchy, restoreV3Camera } from "../map-region-constraints"
import { resetV3CameraNorth, rotateV3Camera, setV3CameraPreset, zoomV3Camera } from "../map-region-constraints"
import type { RegionTerrainState } from "../terrain"
import V3MapViewControls from "./V3MapViewControls.vue"
import V3MapScaleBar from "./V3MapScaleBar.vue"
import V3MapResourceNotice from "./V3MapResourceNotice.vue"
import V3MapTerrainNotice from "./V3MapTerrainNotice.vue"
import { featureHeightMeters, isObstacleFeature, obstacleRadiusMeters } from "../map-3d-feature"

const props = defineProps<{
  region: V3RegionCatalogItem
  visibleLayers: readonly V3RegionLayerCode[]
  features: readonly ShowAreaFeatureView[]
  annotations: readonly ShowAreaAnnotationInput[]
  selectedFeatureId: string
  selectedAnnotationId: string
  drawMode: "POLYGON" | "RECTANGLE" | null
  toolMode: "ANNOTATION" | "MEASURE" | null
  measurement: ShowAreaDistanceMeasurement | null
  drawType: ShowAreaFeatureType | null
  editMode: "VERTEX" | "MOVE"
  editable: boolean
  mode: "2d" | "3d"
}>()

const emit = defineEmits<{
  select: [featureId: string]
  created: [positions: V3Coordinate[]]
  updated: [featureId: string, positions: V3Coordinate[]]
  editStart: []
  annotationCreated: [position: ShowAreaMeasuredPoint]
  annotationSelect: [annotationId: string]
  measured: [measurement: ShowAreaDistanceMeasurement]
  drawComplete: []
  interactionCancel: []
  dataState: [state: V3MapDataState]
}>()

const container = shallowRef<HTMLElement | null>(null)
const viewerReady = ref(false)
const terrainState = ref<RegionTerrainState>("LOADING")
const imageryState = ref<V3MapImageryState>("LOADING")
const scaleViewer = shallowRef<Viewer | null>(null)
let viewer: Viewer | null = null
let mapDataTracker: V3MapDataStateTracker | null = null
let removeTileLoadProgressListener: (() => void) | null = null
let activeResourceCleanup: (() => void) | null = null
let removePerformanceTuning: (() => void) | null = null
let mapResourceGeneration = 0
let handler: ScreenSpaceEventHandler | null = null
let regionSource: CustomDataSource | null = null
let layerSource: CustomDataSource | null = null
let planSource: CustomDataSource | null = null
let interactionSource: CustomDataSource | null = null
let drawingPoints: V3Coordinate[] = []
let measurePoints: ShowAreaMeasuredPoint[] = []
let cursorPoint: ShowAreaMeasuredPoint | null = null
let draggedVertex: { featureId: string; vertexIndex: number } | null = null
let movedFeature: { featureId: string; origin: V3Coordinate; positions: V3Coordinate[] } | null = null
let removeMorphCompleteListener: (() => void) | null = null
let removeCameraConstraints: (() => void) | null = null

const areaColors: Record<ShowAreaFeatureType, Color> = Object.fromEntries(
  Object.entries(showAreaFeatureColors).map(([key, value]) => [key, mapColor(value)])
) as Record<ShowAreaFeatureType, Color>

const layerColors: Record<V3RegionLayerCode, Color> = regionLayerCesiumColors

async function reloadMapResources() {
  if (!viewer || !mapDataTracker) return
  const mapViewer = viewer
  const tracker = mapDataTracker
  const generation = ++mapResourceGeneration
  activeResourceCleanup?.()
  activeResourceCleanup = null
  const cleanup = await loadV3MapResources(mapViewer, props.region, tracker, {
    forceFreshImagery: generation > 1,
    manageRegionConstraints: false,
    isCurrent: () => viewer === mapViewer && mapDataTracker === tracker && generation === mapResourceGeneration && !mapViewer.isDestroyed()
  })
  if (viewer === mapViewer && mapDataTracker === tracker && generation === mapResourceGeneration && !mapViewer.isDestroyed()) activeResourceCleanup = cleanup
  else cleanup()
}

onMounted(async () => {
  if (!container.value) return
  window.addEventListener("keydown", handleKeyDown)
  window.addEventListener("pointerup", handleGlobalPointerUp)
  window.addEventListener("blur", handleGlobalPointerUp)
  viewer = createUnifiedCesiumViewer(container.value)
  scaleViewer.value = viewer
  viewerReady.value = true
  removeCameraConstraints = configureRegionMapConstraints(viewer, props.region)
  removePerformanceTuning = configureV3CesiumPerformance(viewer, "EDIT")
  viewer.scene.globe.baseColor = mapColor(mapBasemapColors.emptyCanvas)
  viewer.scene.globe.depthTestAgainstTerrain = true
  mapDataTracker = createV3MapDataStateTracker((state) => {
    imageryState.value = state.imagery
    terrainState.value = state.terrain
    emit("dataState", state)
  })
  removeTileLoadProgressListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener((pendingTiles: number) => mapDataTracker?.setPendingTiles(pendingTiles))
  void reloadMapResources()
  regionSource = await viewer.dataSources.add(new CustomDataSource("v3-area-region"))
  layerSource = await viewer.dataSources.add(new CustomDataSource("v3-area-layers"))
  planSource = await viewer.dataSources.add(new CustomDataSource("v3-area-plan"))
  interactionSource = await viewer.dataSources.add(new CustomDataSource("v3-area-interaction"))
  configureInteractions()
  renderRegion()
  setMode(props.mode)
  mapDataTracker.markInitialized()
})

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeyDown)
  window.removeEventListener("pointerup", handleGlobalPointerUp)
  window.removeEventListener("blur", handleGlobalPointerUp)
  viewerReady.value = false
  mapResourceGeneration += 1
  removePerformanceTuning?.()
  removePerformanceTuning = null
  removeTileLoadProgressListener?.()
  removeTileLoadProgressListener = null
  activeResourceCleanup?.()
  activeResourceCleanup = null
  removeMorphCompleteListener?.()
  removeMorphCompleteListener = null
  removeCameraConstraints?.()
  removeCameraConstraints = null
  handler?.destroy()
  handler = null
  viewer?.destroy()
  scaleViewer.value = null
  viewer = null
  mapDataTracker = null
  regionSource = null
  layerSource = null
  planSource = null
  interactionSource = null
})

watch(() => props.region, () => { refreshCameraConstraints(); renderRegion(); setMode(props.mode) }, { deep: true })
watch(() => regionMapResourceKey(props.region), () => { void reloadMapResources() })
watch(() => props.visibleLayers, renderLayers, { deep: true })
watch(() => props.features, renderPlan, { deep: true })
watch(() => props.annotations, renderPlan, { deep: true })
watch(() => props.selectedFeatureId, (featureId) => {
  renderPlan()
  focusSelectedFeature(featureId)
})
watch(() => props.selectedAnnotationId, renderPlan)
watch(() => props.measurement, renderInteraction, { deep: true })
watch(() => props.editMode, renderPlan)
watch(() => props.mode, (mode) => setMode(mode, false))
watch(() => [props.drawMode, props.drawType, props.toolMode, props.editMode], () => { endDrag(); resetDrawing() })

function configureInteractions() {
  if (!viewer) return
  handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  handler.setInputAction((movement: { position: Cartesian2 }) => handleClick(movement.position), ScreenSpaceEventType.LEFT_CLICK)
  handler.setInputAction((movement: { endPosition: Cartesian2 }) => handleMove(movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE)
  handler.setInputAction(() => finishPolygon(), ScreenSpaceEventType.RIGHT_CLICK)
  handler.setInputAction((movement: { position: Cartesian2 }) => beginDrag(movement.position), ScreenSpaceEventType.LEFT_DOWN)
  handler.setInputAction(() => endDrag(), ScreenSpaceEventType.LEFT_UP)
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  if (draggedVertex || movedFeature) {
    event.preventDefault()
    endDrag()
    emit("interactionCancel")
    return
  }
  if (!props.drawMode && !props.toolMode) return
  event.preventDefault()
  resetDrawing()
  emit("interactionCancel")
}

/** Restore camera controls when a vertex/feature drag ends outside the map. */
function handleGlobalPointerUp() {
  if (draggedVertex || movedFeature) endDrag()
}

function handleClick(position: Cartesian2) {
  if (!viewer) return
  if (props.editable && props.drawMode && props.drawType) {
    const coordinate = pickCoordinate(position)
    if (!coordinate) return
    if (props.drawMode === "RECTANGLE") {
      if (drawingPoints.length === 0) drawingPoints = [coordinate]
      else {
        const rectangle = rectangleFromDiagonal(drawingPoints[0]!, coordinate)
        if (!isUsablePolygon(rectangle)) return
        emit("created", rectangle)
        resetDrawing()
        emit("drawComplete")
      }
    } else {
      drawingPoints = [...drawingPoints, coordinate]
    }
    renderInteraction()
    return
  }
  if (props.editable && props.toolMode === "ANNOTATION") {
    const coordinate = pickCoordinate(position)
    if (coordinate) emit("annotationCreated", coordinate)
    return
  }
  if (props.toolMode === "MEASURE") {
    const coordinate = pickCoordinate(position)
    if (!coordinate) return
    if (measurePoints.length === 0) measurePoints = [coordinate]
    else {
      const measurement = createDistanceMeasurement(measurePoints[0]!, coordinate)
      measurePoints = []
      cursorPoint = null
      emit("measured", measurement)
    }
    renderInteraction()
    return
  }
  const picked = viewer.scene.pick(position) as { id?: { id?: string } } | undefined
  const id = String(picked?.id?.id ?? "")
  if (id.startsWith("area-feature:")) emit("select", id.slice("area-feature:".length))
  else if (id.startsWith("area-annotation:")) emit("annotationSelect", id.slice("area-annotation:".length))
}

function handleMove(position: Cartesian2) {
  if (!viewer) return
  const coordinate = pickCoordinate(position)
  if (!coordinate) return
  if (draggedVertex) {
    const feature = props.features.find((item) => item.id === draggedVertex?.featureId)
    if (!feature) return
    const positions = feature.positions.map((point, index) => index === draggedVertex!.vertexIndex ? coordinate : point)
    emit("updated", feature.id, positions)
    return
  }
  if (movedFeature) {
    const deltaLongitude = coordinate.longitude - movedFeature.origin.longitude
    const deltaLatitude = coordinate.latitude - movedFeature.origin.latitude
    emit("updated", movedFeature.featureId, movedFeature.positions.map((point) => ({
      ...point,
      longitude: point.longitude + deltaLongitude,
      latitude: point.latitude + deltaLatitude
    })))
    return
  }
  if ((props.drawMode && drawingPoints.length > 0) || (props.toolMode === "MEASURE" && measurePoints.length > 0)) {
    cursorPoint = coordinate
    renderInteraction()
  }
}

function beginDrag(position: Cartesian2) {
  if (!viewer || !props.editable || props.drawMode || props.toolMode) return
  const picked = viewer.scene.pick(position) as { id?: { id?: string } } | undefined
  const id = String(picked?.id?.id ?? "")
  if (props.editMode === "VERTEX" && id.startsWith("area-vertex:")) {
    const [, featureId, vertexIndex] = id.split(":")
    if (!featureId || !Number.isInteger(Number(vertexIndex))) return
    draggedVertex = { featureId, vertexIndex: Number(vertexIndex) }
  } else if (props.editMode === "MOVE" && id.startsWith("area-feature:")) {
    const featureId = id.slice("area-feature:".length)
    if (featureId !== props.selectedFeatureId) return
    const origin = pickCoordinate(position)
    const feature = props.features.find((item) => item.id === featureId)
    if (!origin || !feature) return
    movedFeature = { featureId, origin, positions: feature.positions.map((point) => ({ ...point })) }
  }
  if (draggedVertex || movedFeature) {
    emit("editStart")
    viewer.scene.screenSpaceCameraController.enableRotate = false
    viewer.scene.screenSpaceCameraController.enableTranslate = false
  }
}

function endDrag() {
  if (!viewer) return
  draggedVertex = null
  movedFeature = null
  viewer.scene.screenSpaceCameraController.enableRotate = true
  viewer.scene.screenSpaceCameraController.enableTranslate = true
}

function finishPolygon() {
  if (props.drawMode !== "POLYGON") return
  if (isUsablePolygon(drawingPoints)) emit("created", drawingPoints)
  resetDrawing()
  emit("drawComplete")
}

function resetDrawing() {
  drawingPoints = []
  measurePoints = []
  cursorPoint = null
  renderInteraction()
}

function renderRegion() {
  if (!viewer || !regionSource) return
  regionSource.entities.removeAll()
  const boundaryColor = mapColor(mapRegionColors.boundary)
  const maskHierarchy = regionMaskHierarchy(props.region)
  if (maskHierarchy) {
    regionSource.entities.add({
      id: `area-region-mask:${props.region.regionCode}`,
      polygon: {
        hierarchy: maskHierarchy,
        material: mapColorAlpha(mapRegionColors.mask, mapRegionColors.maskAlpha),
        height: 0,
        heightReference: HeightReference.CLAMP_TO_GROUND
      }
    })
  }
  regionSource.entities.add({
    id: `area-region:${props.region.regionCode}`,
    polygon: { hierarchy: Cartesian3.fromDegreesArray(flatten(props.region.boundary)), material: boundaryColor.withAlpha(0.06), height: 0, heightReference: HeightReference.CLAMP_TO_GROUND },
    polyline: { positions: Cartesian3.fromDegreesArray(flattenClosed(props.region.boundary)), width: 2.5, material: boundaryColor, clampToGround: true }
  })
}

function renderLayers() {
  if (!viewer || !layerSource) return
  layerSource.entities.removeAll()
  const visible = new Set(props.visibleLayers)
  for (const layer of props.region.layers) {
    if (!visible.has(layer.code) || layer.state === "UNAVAILABLE") continue
    for (const feature of layer.features) addRegionFeature(layer.code, feature)
  }
  viewer.scene.requestRender()
}

function addRegionFeature(code: V3RegionLayerCode, feature: V3RegionFeature) {
  if (!layerSource) return
  const entityId = `area-layer:${code}:${feature.id}`
  // Offline vector sources can contain the same OSM feature more than once
  // (for example when adjacent tiles overlap). Cesium requires unique IDs.
  if (layerSource.entities.getById(entityId)) return
  const baseColor = layerColors[code]
  const restriction = code === "RESTRICTIONS"
  const isBuilding = code === "BUILDINGS"
  if (feature.geometryType === "LINESTRING" && feature.positions && feature.positions.length >= 2) {
    layerSource.entities.add({
      id: entityId,
      name: feature.name,
      polyline: { positions: Cartesian3.fromDegreesArray(flatten(feature.positions)), width: code === "WATER" ? 3.5 : 2.5, material: baseColor.withAlpha(code === "WATER" ? 0.78 : 0.62), clampToGround: true }
    })
    return
  }
  if (feature.geometryType === "POLYGON" && feature.positions && feature.positions.length >= 3) {
    const knownHeight = typeof feature.heightMeters === "number" && Number.isFinite(feature.heightMeters) && feature.heightMeters > 0
    const heightMeters = knownHeight ? (feature.heightMeters ?? 0) : 0
    const extruded = props.mode === "3d" && isBuilding
    const extrusionHeight = extruded ? (knownHeight ? heightMeters : mapBuildingColors.fallbackHeightMeters) : 0
    layerSource.entities.add({
      id: entityId,
      name: extruded && !knownHeight ? `${feature.name}（高度未提供）` : feature.name,
      polygon: {
        hierarchy: Cartesian3.fromDegreesArray(flatten(feature.positions)),
        material: extruded
          ? buildingColorForHeight(extrusionHeight).withAlpha(mapBuildingColors.extrudedAlpha)
          : restriction
            ? baseColor.withAlpha(mapRestrictionColors.flatAlpha)
            : isBuilding
              ? buildingColorForHeight(0).withAlpha(mapBuildingColors.flatAlpha)
              : baseColor.withAlpha(0.18),
        height: 0,
        ...(extruded ? { extrudedHeight: extrusionHeight, extrudedHeightReference: HeightReference.RELATIVE_TO_GROUND } : {}),
        heightReference: extruded ? HeightReference.RELATIVE_TO_GROUND : HeightReference.CLAMP_TO_GROUND
      },
      ...(!extruded ? {
        polyline: {
          positions: Cartesian3.fromDegreesArray(flattenClosed(feature.positions)),
          width: restriction ? (props.mode === "3d" ? mapRestrictionColors.outlineWidth3d : mapRestrictionColors.outlineWidth2d) : 1.5,
          material: restriction || !isBuilding ? baseColor : mapColor(mapBuildingColors.outline2d),
          clampToGround: true
        }
      } : {})
    })
  } else if (feature.geometryType === "POINT" && feature.position) {
    const heightMeters = featureHeightMeters(feature)
    const obstacle = isObstacleFeature(feature)
    const extrudedObstacle = props.mode === "3d" && obstacle && heightMeters > 0
    const pointColor = obstacle ? mapColor(mapObstacleColors.fill) : baseColor
    layerSource.entities.add({
      id: entityId,
      name: feature.name,
      position: Cartesian3.fromDegrees(feature.position.longitude, feature.position.latitude, extrudedObstacle ? heightMeters / 2 : (props.mode === "3d" ? heightMeters : 0)),
      ...(extrudedObstacle ? {
        cylinder: {
          length: heightMeters,
          topRadius: obstacleRadiusMeters(feature) * 0.45,
          bottomRadius: obstacleRadiusMeters(feature),
          material: pointColor.withAlpha(mapObstacleColors.cylinderAlpha),
          outlineColor: mapColor(mapObstacleColors.label),
          outlineWidth: 2,
          heightReference: HeightReference.RELATIVE_TO_GROUND
        }
      } : {
        point: { pixelSize: 9, color: pointColor, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: props.mode === "3d" ? HeightReference.RELATIVE_TO_GROUND : HeightReference.CLAMP_TO_GROUND }
      })
    })
  }
}

function renderPlan() {
  if (!viewer || !planSource || !interactionSource) return
  planSource.entities.removeAll()
  interactionSource.entities.removeAll()
  for (const feature of props.features) {
    if (!isUsablePolygon(feature.positions) || !isFiniteCoordinate(feature.measurement.centroid)) continue
    const color = areaColors[feature.type]
    const selected = feature.id === props.selectedFeatureId
    const heightRange = feature.heightRange
    const hasHeightRange = Boolean(heightRange
      && Number.isFinite(heightRange.minimumMeters)
      && Number.isFinite(heightRange.maximumMeters)
      && heightRange.maximumMeters > heightRange.minimumMeters)
    const minimumHeight = hasHeightRange ? Math.max(0, heightRange!.minimumMeters) : 0
    const maximumHeight = hasHeightRange ? Math.max(minimumHeight, heightRange!.maximumMeters) : 0
    const showVolume = props.mode === "3d" && hasHeightRange
    planSource.entities.add({
      id: `area-feature:${feature.id}`,
      name: feature.label,
      polygon: {
        hierarchy: Cartesian3.fromDegreesArray(flatten(feature.positions)),
        material: color.withAlpha(showVolume ? (selected ? 0.26 : 0.15) : (selected ? 0.34 : 0.2)),
        height: showVolume ? minimumHeight : 0,
        ...(showVolume ? {
          extrudedHeight: maximumHeight,
        extrudedHeightReference: heightRange!.datum === "AGL" ? HeightReference.RELATIVE_TO_GROUND : HeightReference.NONE
      } : {}),
        heightReference: showVolume
          ? heightRange!.datum === "AGL" ? HeightReference.RELATIVE_TO_GROUND : HeightReference.NONE
          : HeightReference.CLAMP_TO_GROUND
      },
      polyline: {
        positions: Cartesian3.fromDegreesArray(flattenClosed(feature.positions)),
        width: selected ? 4 : 2.2,
        material: selected ? Color.WHITE : color,
        clampToGround: true
      },
      position: Cartesian3.fromDegrees(feature.measurement.centroid.longitude, feature.measurement.centroid.latitude, 8),
      label: createMapLabelAppearance({
        text: showVolume ? `${feature.label}\n${heightRange!.minimumMeters.toFixed(0)}-${heightRange!.maximumMeters.toFixed(0)} m ${heightRange!.datum}` : feature.label,
        color,
        priority: "TASK_POINT",
        truncate: false,
        outlineWidth: 4,
        offset: new Cartesian2(0, -12)
      })
    })
    if (selected && props.editable && !props.drawMode && props.editMode === "VERTEX") {
      feature.positions.forEach((point, index) => interactionSource!.entities.add({
        id: `area-vertex:${feature.id}:${index}`,
        position: Cartesian3.fromDegrees(point.longitude, point.latitude, 4),
        point: { pixelSize: 11, color: Color.WHITE, outlineColor: color, outlineWidth: 3, heightReference: HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY }
      }))
    }
  }
  for (const annotation of props.annotations) {
    const selected = annotation.id === props.selectedAnnotationId
    const inkColor = mapColor(mapInteractionColors.annotationInk)
    planSource.entities.add({
      id: `area-annotation:${annotation.id}`,
      position: Cartesian3.fromDegrees(annotation.position.longitude, annotation.position.latitude, Math.max(annotation.heightMeters ?? 3, 3)),
      point: {
        pixelSize: selected ? 13 : 10,
        color: selected ? inkColor : Color.WHITE,
        outlineColor: inkColor,
        outlineWidth: 3,
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: createMapLabelAppearance({
        text: annotation.label,
        color: mapInteractionColors.annotationInk,
        priority: "AUX",
        outlineWidth: 4,
        offset: new Cartesian2(12, 0)
      })
    })
  }
  renderInteraction()
  viewer.scene.requestRender()
}

function focusSelectedFeature(featureId: string) {
  if (!viewer || !featureId) return
  const feature = props.features.find((item) => item.id === featureId)
  const center = feature?.measurement?.centroid
  if (!center) return
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(center.longitude, center.latitude, 260),
    duration: 0.45
  })
}

function renderInteraction() {
  if (!interactionSource) return
  interactionSource.entities.values.filter((entity) => entity.id.startsWith("area-drawing:") || entity.id.startsWith("area-measure:")).forEach((entity) => interactionSource!.entities.remove(entity))
  if (props.measurement) renderMeasurement(props.measurement)
  if (props.toolMode === "MEASURE" && measurePoints.length > 0) {
    const preview = cursorPoint ? [measurePoints[0]!, cursorPoint] : measurePoints
    interactionSource.entities.add({
      id: "area-measure:preview",
      polyline: { positions: Cartesian3.fromDegreesArray(flatten(preview)), width: 3, material: mapColor(mapInteractionColors.measurement), clampToGround: true }
    })
    return
  }
  if (!props.drawMode || drawingPoints.length === 0) return
  const preview = cursorPoint ? [...drawingPoints, cursorPoint] : drawingPoints
  const color = props.drawType ? areaColors[props.drawType] : Color.WHITE
  const positions = props.drawMode === "RECTANGLE" && preview.length >= 2 ? rectangleFromDiagonal(preview[0]!, preview[preview.length - 1]!) : preview
  if (hasDistinctPoints(positions)) interactionSource.entities.add({
    id: "area-drawing:preview",
    ...(isUsablePolygon(positions) ? { polygon: { hierarchy: Cartesian3.fromDegreesArray(flatten(positions)), material: color.withAlpha(0.16), height: 0, heightReference: HeightReference.CLAMP_TO_GROUND } } : {}),
    polyline: { positions: Cartesian3.fromDegreesArray(flatten(props.drawMode === "POLYGON" ? positions : [...positions, positions[0]!])), width: 3, material: color, clampToGround: true }
  })
  drawingPoints.forEach((point, index) => interactionSource!.entities.add({
    id: `area-drawing:point:${index}`,
    position: Cartesian3.fromDegrees(point.longitude, point.latitude, 4),
    point: { pixelSize: 9, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND }
  }))
}

function renderMeasurement(measurement: ShowAreaDistanceMeasurement) {
  if (!interactionSource) return
  interactionSource.entities.add({
    id: "area-measure:result",
    polyline: { positions: Cartesian3.fromDegreesArray(flatten([measurement.start, measurement.end])), width: 3, material: mapColor(mapInteractionColors.measurement), clampToGround: true },
    position: Cartesian3.fromDegrees((measurement.start.longitude + measurement.end.longitude) / 2, (measurement.start.latitude + measurement.end.latitude) / 2, 6),
    label: createMapLabelAppearance({
      text: `${formatDistance(measurement.distanceMeters)} / ${measurement.bearingDegrees.toFixed(1)}°`,
      color: mapInteractionColors.measurement,
      priority: "AUX",
      truncate: false,
      outlineWidth: 4,
      offset: new Cartesian2(0, -10)
    })
  })
}

function pickCoordinate(position: Cartesian2): ShowAreaMeasuredPoint | null {
  if (!viewer) return null
  const ray = viewer.camera.getPickRay(position)
  const cartesian = (ray ? viewer.scene.globe.pick(ray, viewer.scene) : null)
    ?? viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
  if (!cartesian || ![cartesian.x, cartesian.y, cartesian.z].every(Number.isFinite)) return null
  const cartographic = Cartographic.fromCartesian(cartesian)
  const coordinate = {
    longitude: Number((cartographic.longitude * 180 / Math.PI).toFixed(8)),
    latitude: Number((cartographic.latitude * 180 / Math.PI).toFixed(8)),
    heightMeters: Number.isFinite(cartographic.height) ? Number(cartographic.height.toFixed(1)) : null
  }
  return isFiniteCoordinate(coordinate) && isCoordinateInsideRegion(props.region, coordinate) ? coordinate : null
}

function formatDistance(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${value.toFixed(1)} m`
}

function setMode(mode: "2d" | "3d", refocus = true) {
  if (!viewer) return
  const targetMode = mode === "2d" ? SceneMode.SCENE2D : SceneMode.SCENE3D
  const cameraSnapshot = !refocus && viewer.scene.mode !== targetMode ? captureV3Camera(viewer) : null
  const applyCamera = () => { if (cameraSnapshot) restoreV3Camera(viewer!, cameraSnapshot, mode) }
  if (viewer.scene.mode === targetMode) {
    if (refocus) focusRegion(0.35, mode)
    else applyCamera()
    renderLayers()
    renderPlan()
    return
  }
  removeMorphCompleteListener?.()
  removeMorphCompleteListener = null
  if (viewer.scene.mode === SceneMode.MORPHING) viewer.scene.completeMorph()
  removeMorphCompleteListener = listenForMapMorphComplete(viewer.scene.morphComplete, () => {
    removeMorphCompleteListener = null
    if (refocus) focusRegion(0.35, mode)
    renderLayers()
    renderPlan()
    applyCamera()
  })
  if (mode === "2d") viewer.scene.morphTo2D(0.3)
  else viewer.scene.morphTo3D(0.3)
}

function focusRegion(duration: number, mode: "2d" | "3d" = props.mode) {
  if (!viewer) return
  focusV3Region(viewer, props.region, mode, duration)
}

function refreshCameraConstraints() {
  if (!viewer) return
  removeCameraConstraints?.()
  removeCameraConstraints = configureRegionMapConstraints(viewer, props.region)
}

function focusMapRegion() {
  focusRegion(0.35)
}

function zoomMapIn() {
  if (viewer) zoomV3Camera(viewer, props.region, props.mode, "in")
}

function zoomMapOut() {
  if (viewer) zoomV3Camera(viewer, props.region, props.mode, "out")
}

function rotateMapLeft() {
  if (viewer) rotateV3Camera(viewer, props.region, props.mode, -15)
}

function rotateMapRight() {
  if (viewer) rotateV3Camera(viewer, props.region, props.mode, 15)
}

function resetMapNorth() {
  if (viewer) resetV3CameraNorth(viewer, props.region, props.mode)
}

function setTopDownView() {
  if (viewer) setV3CameraPreset(viewer, props.region, props.mode, "top-down")
}

function setFlightView() {
  if (viewer) setV3CameraPreset(viewer, props.region, props.mode, "flight")
}

function isFiniteCoordinate(point: V3Coordinate): boolean {
  return Number.isFinite(point.longitude) && Number.isFinite(point.latitude)
}

function hasDistinctPoints(points: readonly V3Coordinate[]): boolean {
  if (points.length < 2 || points.some((point) => !isFiniteCoordinate(point))) return false
  const first = points[0]!
  return points.some((point) => Math.abs(point.longitude - first.longitude) > 1e-10 || Math.abs(point.latitude - first.latitude) > 1e-10)
}

function isUsablePolygon(points: readonly V3Coordinate[]): boolean {
  if (points.length < 3 || !hasDistinctPoints(points)) return false
  const origin = points[0]!
  let twiceArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!
    const next = points[(index + 1) % points.length]!
    twiceArea += (current.longitude - origin.longitude) * (next.latitude - origin.latitude)
      - (next.longitude - origin.longitude) * (current.latitude - origin.latitude)
  }
  return Math.abs(twiceArea) > 1e-14
}

function flatten(points: readonly V3Coordinate[]): number[] {
  return points.flatMap((point) => [point.longitude, point.latitude])
}

function flattenClosed(points: readonly V3Coordinate[]): number[] {
  return points[0] ? flatten([...points, points[0]]) : []
}

</script>

<template>
  <div class="v3-area-planning-map-shell">
  <div ref="container" class="v3-area-planning-map" />
  <V3MapResourceNotice :available="Boolean(region)" :imagery-state="imageryState" @retry="reloadMapResources" />
  <V3MapTerrainNotice :state="terrainState" :region="region" @retry="reloadMapResources" />
  <V3MapViewControls :mode="mode" @home="focusMapRegion" @zoom-in="zoomMapIn" @zoom-out="zoomMapOut" @rotate-left="rotateMapLeft" @rotate-right="rotateMapRight" @reset-north="resetMapNorth" @top-down="setTopDownView" @flight-view="setFlightView" />
  <V3MapScaleBar :viewer="scaleViewer" :terrain-state="terrainState" />
</div>
</template>

<style scoped>
.v3-area-planning-map-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;
  background: #dce3de;
}

.v3-area-planning-map {
  width: 100%;
  height: 100%;
}
</style>
