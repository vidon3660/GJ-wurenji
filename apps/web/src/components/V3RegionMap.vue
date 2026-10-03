<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorBlendMode,
  DistanceDisplayCondition,
  ColorMaterialProperty,
  ConstantProperty,
  ConstantPositionProperty,
  CustomDataSource,
  GeoJsonDataSource,
  JulianDate,
  HeightReference,
  HeadingPitchRoll,
  Math as CesiumMath,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer
} from "cesium"
import type {
  V3Coordinate,
  V3RegionCatalogItem,
  V3RegionFeature,
  V3RegionLayerCode,
  VtlProjectPlanView,
  VtlReplayFrameView,
  VtlRouteWaypointInput,
  VtlRuntimeWorkspaceView,
  VtlTaskZoneView
} from "@wurenji/shared"
import { configureV3CesiumPerformance } from "../cesium-performance"
import { createUnifiedCesiumViewer } from "../cesium-map-adapter"
import {
  buildingColorForHeight,
  mapBasemapColors,
  mapBuildingColors,
  mapColor,
  mapColorAlpha,
  mapInteractionColors,
  mapObstacleColors,
  mapPoiColors,
  mapRegionColors,
  mapRestrictionColors,
  mapRouteColors,
  regionLayerCesiumColors,
  vtlColors,
  vtlPhaseColors
} from "../map-visual-theme"
import { createMapLabelAppearance, createMapLabelBudget, mapDetailLevelForCameraHeight, shouldRenderBuildingDetail, type MapLabelPriority, type MapDetailLevel } from "../map-label-policy"
import { createPoiBillboard, poiCategoryForRegionFeature } from "../map-poi-icons"
import { createV3MapDataStateTracker, type V3MapDataState, type V3MapDataStateTracker, type V3MapImageryState } from "../map-loading-state"
import { regionMapResourceKey } from "../map-resources"
import { loadV3MapResources } from "../map-resources-loader"
import type { RegionTerrainState } from "../terrain"
import { captureV3Camera, configureRegionMapConstraints, focusV3Coordinates, focusV3Region, isCoordinateInsideRegion, regionMaskHierarchy, restoreV3Camera } from "../map-region-constraints"
import { resetV3CameraNorth, rotateV3Camera, setV3CameraPreset, zoomV3Camera } from "../map-region-constraints"
import V3MapViewControls from "./V3MapViewControls.vue"
import V3MapScaleBar from "./V3MapScaleBar.vue"
import V3MapResourceNotice from "./V3MapResourceNotice.vue"
import V3MapTerrainNotice from "./V3MapTerrainNotice.vue"
import { vtlLandingSiteLabelText, vtlTaskLabelText } from "../vtl-map-labels"
import { featureHeightMeters, isObstacleFeature, obstacleRadiusMeters } from "../map-3d-feature"
import { parseVtlMapPickId } from "../vtl-map-picking"
import { buildingHeightMeters, hasRenderableOfflineBuildingFeatures, resolveBuildingDataUrl } from "../map-building-layer"

const props = defineProps<{
  region: V3RegionCatalogItem | null
  missingRegionPackageId?: string | null
  visibleLayers: readonly V3RegionLayerCode[]
  mode: "2d" | "3d"
  vtlPlan?: VtlProjectPlanView | null
  vtlSelectedAircraftId?: string | null
  vtlVisibleAircraftIds?: readonly string[] | null
  vtlMainLandingSiteId?: string | null
  vtlTaskZones?: readonly VtlTaskZoneView[]
  vtlSelectedTaskId?: string | null
  selectedMapFeatureId?: string | null
  vtlAllocationEditable?: boolean
  vtlZoneDrawMode?: boolean
  vtlRouteEditable?: boolean
  vtlEditingAircraftId?: string | null
  vtlEditingWaypoints?: readonly VtlRouteWaypointInput[]
  vtlRuntime?: Pick<VtlRuntimeWorkspaceView, "aircraft" | "taskObjects"> | null
  vtlReplayFrame?: VtlReplayFrameView | null
  /** Serializable editor overlays shared by teacher and student map flows. */
  editorFeatures?: readonly {
    id: string
    name: string
    geometryType: "POINT" | "LINESTRING" | "POLYGON"
    position?: V3Coordinate
    positions?: readonly V3Coordinate[]
    color?: string
    heightMeters?: number
    radiusMeters?: number
    type?: string
  }[]
  editorDrawingPoints?: readonly V3Coordinate[]
  editorDrawingActive?: boolean
  editorEditingEnabled?: boolean
  editorLabelsVisible?: boolean
}>()

const emit = defineEmits<{
  dataState: [state: V3MapDataState]
  vtlTaskSelect: [taskId: string]
  vtlAircraftSelect: [aircraftId: string]
  vtlZoneDrawComplete: [taskId: string, positions: V3Coordinate[]]
  vtlZoneDrawCancel: []
  vtlZoneUpdated: [taskId: string, positions: V3Coordinate[]]
  vtlWaypointUpdated: [aircraftId: string, waypointId: string, position: Pick<V3Coordinate, "longitude" | "latitude">]
  editorMapClick: [coordinate: V3Coordinate]
  editorMapSelected: [id: string | null]
  editorFeatureMoved: [id: string, coordinate: V3Coordinate, vertexIndex: number | null]
}>()

const container = shallowRef<HTMLElement | null>(null)
const viewerReady = ref(false)
const terrainState = ref<RegionTerrainState>("LOADING")
const imageryState = ref<V3MapImageryState>("LOADING")
const regionEntityIds = ref("")
const scaleViewer = shallowRef<Viewer | null>(null)
let viewer: Viewer | null = null
let mapDataTracker: V3MapDataStateTracker | null = null
let removeTileLoadProgressListener: (() => void) | null = null
let activeResourceCleanup: (() => void) | null = null
let removePerformanceTuning: (() => void) | null = null
let mapResourceGeneration = 0
let regionSource: CustomDataSource | null = null
let layerSource: CustomDataSource | null = null
let offlineBuildingSource: GeoJsonDataSource | null = null
let vtlSource: CustomDataSource | null = null
let editorSource: CustomDataSource | null = null
let editorLabelSource: CustomDataSource | null = null
let vtlRuntimeSource: CustomDataSource | null = null
const vtlRuntimeAppearanceKeys = new Map<string, string>()
const vtlTrackHistory = new Map<string, Cartesian3[]>()
let vtlTrackModeKey = ""
let vtlInteractionHandler: ScreenSpaceEventHandler | null = null
let editorInteractionHandler: ScreenSpaceEventHandler | null = null
let draggedEditorFeature: { id: string; vertexIndex: number | null } | null = null
let removeMorphCompleteListener: (() => void) | null = null
let removeCameraConstraints: (() => void) | null = null
let vtlDrawingPoints: V3Coordinate[] = []
let vtlCursorPoint: V3Coordinate | null = null
let draggedVtlVertex: { zoneId: string; vertexIndex: number } | null = null
let draggedVtlWaypoint: { aircraftId: string; waypointId: string } | null = null
let vtlOverlayFrame: number | null = null
let layerRenderKey = ""
let labelBudget = createMapLabelBudget()
let cameraDetailTier: MapDetailLevel = "near"
let removeCameraTierListener: (() => void) | null = null
let offlineBuildingGeneration = 0
const offlineBuildingHeights = new Map<string, number>()

function currentDetailTier(): MapDetailLevel {
  // 仅在 3D 空间理解视角按相机高度分层；2D 精确规划视角始终保留建筑块面。
  if (!viewer || props.mode !== "3d") return "near"
  const height = viewer.camera.positionCartographic?.height
  return typeof height === "number" && Number.isFinite(height) ? mapDetailLevelForCameraHeight(height) : "near"
}

function syncCameraDetailTier() {
  const tier = currentDetailTier()
  if (tier === cameraDetailTier) return
  cameraDetailTier = tier
  layerRenderKey = ""
  renderLayers()
  syncOfflineBuildingVisibility()
}

async function loadOfflineBuildingLayer() {
  if (!viewer || viewer.isDestroyed()) return
  const url = resolveBuildingDataUrl(
    props.region,
    (import.meta.env.VITE_LOGISTICS_BUILDINGS_URL as string | undefined) ?? ""
  )
  const generation = ++offlineBuildingGeneration
  if (offlineBuildingSource) {
    viewer.dataSources.remove(offlineBuildingSource, true)
    offlineBuildingSource = null
  }
  offlineBuildingHeights.clear()
  if (!url) return
  try {
    const source = await GeoJsonDataSource.load(url, { clampToGround: false })
    if (!viewer || viewer.isDestroyed() || generation !== offlineBuildingGeneration) {
      source.entities.removeAll()
      return
    }
    for (const entity of source.entities.values) {
      if (!entity.polygon) continue
      const rawHeight = entity.properties?.height?.getValue(JulianDate.now())
        ?? entity.properties?.height_m?.getValue(JulianDate.now())
        ?? entity.properties?.building_levels?.getValue(JulianDate.now())
      const heightMeters = buildingHeightMeters(rawHeight, String(entity.id))
      offlineBuildingHeights.set(String(entity.id), heightMeters)
      entity.name = entity.name || `离线建筑 ${entity.id}`
      entity.polygon.height = new ConstantProperty(0)
      entity.polygon.heightReference = new ConstantProperty(HeightReference.RELATIVE_TO_GROUND)
      entity.polygon.extrudedHeight = new ConstantProperty(props.mode === "3d" ? heightMeters : 0)
      entity.polygon.extrudedHeightReference = new ConstantProperty(HeightReference.RELATIVE_TO_GROUND)
      entity.polygon.material = new ColorMaterialProperty(Color.WHITE.withAlpha(0.58))
      entity.polygon.outline = new ConstantProperty(true)
      entity.polygon.outlineColor = new ConstantProperty(Color.WHITE.withAlpha(0.9))
      entity.show = props.visibleLayers.includes("BUILDINGS") && shouldRenderBuildingDetail(cameraDetailTier)
    }
    viewer.dataSources.add(source)
    offlineBuildingSource = source
    // Replace the lightweight manifest footprints only after the external
    // GeoJSON has actually loaded. If the package URL is unavailable, keep the
    // manifest buildings visible so planning never loses its spatial context.
    layerRenderKey = ""
    renderLayers()
  } catch {
    offlineBuildingSource = null
    layerRenderKey = ""
    renderLayers()
  }
}

function syncOfflineBuildingVisibility() {
  const visible = props.visibleLayers.includes("BUILDINGS") && shouldRenderBuildingDetail(cameraDetailTier)
  for (const entity of offlineBuildingSource?.entities.values ?? []) {
    entity.show = visible
    const heightMeters = offlineBuildingHeights.get(String(entity.id))
    if (heightMeters !== undefined && entity.polygon) {
      entity.polygon.extrudedHeight = new ConstantProperty(props.mode === "3d" ? heightMeters : 0)
    }
  }
}

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
  removePerformanceTuning = configureV3CesiumPerformance(viewer, "BROWSE")
  viewer.scene.globe.baseColor = mapColor(mapBasemapColors.emptyCanvas)
  viewer.scene.globe.depthTestAgainstTerrain = true
  mapDataTracker = createV3MapDataStateTracker((state) => {
    imageryState.value = state.imagery
    terrainState.value = state.terrain
    emit("dataState", state)
  })
  removeTileLoadProgressListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener((pendingTiles: number) => mapDataTracker?.setPendingTiles(pendingTiles))
  viewer.camera.percentageChanged = 0.15
  removeCameraTierListener = viewer.camera.changed.addEventListener(() => syncCameraDetailTier())
  void reloadMapResources()
  regionSource = await viewer.dataSources.add(new CustomDataSource("v3-region"))
  layerSource = await viewer.dataSources.add(new CustomDataSource("v3-region-layers"))
  vtlSource = await viewer.dataSources.add(new CustomDataSource("v3-vtl-overlay"))
  vtlRuntimeSource = await viewer.dataSources.add(new CustomDataSource("v3-vtl-runtime"))
  editorSource = await viewer.dataSources.add(new CustomDataSource("v3-editor-overlay"))
  editorLabelSource = await viewer.dataSources.add(new CustomDataSource("v3-editor-overlay-labels"))
  configureVtlInteractions()
  configureEditorInteractions()
  renderRegion()
  renderEditorFeatures()
  setMode(props.mode)
  mapDataTracker.markInitialized()
  void loadOfflineBuildingLayer()
})

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeyDown)
  window.removeEventListener("pointerup", handleGlobalPointerUp)
  window.removeEventListener("blur", handleGlobalPointerUp)
  viewerReady.value = false
  if (vtlOverlayFrame !== null) window.cancelAnimationFrame(vtlOverlayFrame)
  vtlOverlayFrame = null
  mapResourceGeneration += 1
  removePerformanceTuning?.()
  removePerformanceTuning = null
  removeTileLoadProgressListener?.()
  removeTileLoadProgressListener = null
  activeResourceCleanup?.()
  activeResourceCleanup = null
  vtlInteractionHandler?.destroy()
  vtlInteractionHandler = null
  editorInteractionHandler?.destroy()
  editorInteractionHandler = null
  draggedEditorFeature = null
  draggedVtlVertex = null
  draggedVtlWaypoint = null
  removeMorphCompleteListener?.()
  removeMorphCompleteListener = null
  removeCameraTierListener?.()
  removeCameraTierListener = null
  removeCameraConstraints?.()
  removeCameraConstraints = null
  viewer?.destroy()
  scaleViewer.value = null
  viewer = null
  mapDataTracker = null
  regionSource = null
  layerSource = null
  offlineBuildingSource = null
  offlineBuildingHeights.clear()
  vtlSource = null
  editorSource = null
  editorLabelSource = null
  vtlRuntimeSource = null
  vtlRuntimeAppearanceKeys.clear()
  vtlTrackHistory.clear()
  vtlTrackModeKey = ""
  layerRenderKey = ""
})

watch(() => regionMapResourceKey(props.region), () => { refreshCameraConstraints(); layerRenderKey = ""; cameraDetailTier = "near"; renderRegion(); renderLayers(); setMode(props.mode); void loadOfflineBuildingLayer() })
watch(() => regionMapResourceKey(props.region), () => { void reloadMapResources() })
watch(() => props.visibleLayers.join("|"), () => { renderLayers(); syncOfflineBuildingVisibility() })
watch(() => props.mode, (mode) => setMode(mode, false))
watch(() => props.vtlPlan, renderVtlOverlay, { deep: true })
watch(() => props.vtlSelectedAircraftId, renderVtlOverlay)
watch(() => props.vtlVisibleAircraftIds?.join("|") ?? "", renderVtlOverlay)
watch(() => props.vtlTaskZones, renderVtlOverlay, { deep: true })
watch(() => props.vtlSelectedTaskId, renderVtlOverlay)
watch(() => props.selectedMapFeatureId, focusSelectedMapFeature)
watch(() => props.vtlEditingWaypoints, renderVtlOverlay, { deep: true })
watch(() => props.vtlRouteEditable, renderVtlOverlay)
watch(() => [props.editorFeatures, props.editorDrawingPoints, props.editorDrawingActive, props.editorLabelsVisible], renderEditorFeatures, { deep: true })
watch(() => props.vtlZoneDrawMode, () => {
  vtlDrawingPoints = []
  vtlCursorPoint = null
  renderVtlOverlay()
})
watch(() => vtlRuntimeOverlaySignature(props.vtlRuntime), scheduleVtlRuntimeOverlayRender)
watch(() => vtlReplayFrameOverlaySignature(props.vtlReplayFrame), scheduleVtlRuntimeOverlayRender)

function scheduleVtlOverlayRender() {
  if (vtlOverlayFrame !== null) return
  vtlOverlayFrame = window.requestAnimationFrame(() => {
    vtlOverlayFrame = null
    renderVtlOverlay()
  })
}

function scheduleVtlRuntimeOverlayRender() {
  if (vtlOverlayFrame !== null) return
  vtlOverlayFrame = window.requestAnimationFrame(() => {
    vtlOverlayFrame = null
    renderVtlRuntimeOverlay()
  })
}

function vtlRuntimeOverlaySignature(value: Pick<VtlRuntimeWorkspaceView, "aircraft" | "taskObjects"> | null | undefined): string {
  if (!value) return ""
  return [
    value.aircraft.map((aircraft) => [
      aircraft.aircraftId,
      aircraft.position.longitude,
      aircraft.position.latitude,
      aircraft.position.altitudeMeters,
      aircraft.eventIds.join(",")
    ].join(":" )).join("|"),
    value.taskObjects.map((task) => [task.id, task.status].join(":" )).join("|")
  ].join("||")
}

function vtlReplayFrameOverlaySignature(value: VtlReplayFrameView | null | undefined): string {
  if (!value) return ""
  return [value.sequence, value.simulationTimeMs, vtlRuntimeOverlaySignature(value)].join("||")
}

function renderRegion() {
  if (!viewer || !regionSource) return
  regionSource.entities.removeAll()
  regionEntityIds.value = ""
  if (!props.region) return
  const boundaryColor = mapColor(mapRegionColors.boundary)
  const maskHierarchy = regionMaskHierarchy(props.region)
  if (maskHierarchy) {
    regionSource.entities.add({
      id: `v3-region-mask:${props.region.regionCode}`,
      polygon: {
        hierarchy: maskHierarchy,
        material: mapColorAlpha(mapRegionColors.mask, mapRegionColors.maskAlpha),
        height: 0,
        heightReference: HeightReference.CLAMP_TO_GROUND
      }
    })
  }
  regionSource.entities.add({
    id: `v3-region:${props.region.regionCode}`,
    name: props.region.title,
    polygon: {
      hierarchy: Cartesian3.fromDegreesArray(flatten(props.region.boundary)),
      material: mapColorAlpha(mapRegionColors.boundary, mapRegionColors.boundaryFillAlpha),
      height: 0,
      heightReference: HeightReference.CLAMP_TO_GROUND
    },
    polyline: {
      positions: Cartesian3.fromDegreesArray(flattenClosed(props.region.boundary)),
      width: 2,
      material: boundaryColor,
      clampToGround: true
    }
  })
  regionSource.entities.add({
    id: `v3-region-center:${props.region.regionCode}`,
    position: Cartesian3.fromDegrees(props.region.center.longitude, props.region.center.latitude, 8),
    point: {
      pixelSize: 9,
      color: mapColor(mapRegionColors.centerPoint),
      outlineColor: Color.WHITE,
      outlineWidth: 2,
      heightReference: HeightReference.RELATIVE_TO_GROUND
    },
    label: createMapLabelAppearance({
      text: props.region.title,
      color: mapRegionColors.titleLabel,
      priority: "REGION",
      truncate: false
    })
  })
  regionEntityIds.value = regionSource.entities.values.map((entity) => entity.id).join(",")
}

function renderLayers() {
  if (!viewer || !layerSource) return
  const renderKey = `${regionMapResourceKey(props.region)}:${props.mode}:${props.visibleLayers.join("|")}`
  if (renderKey === layerRenderKey) return
  layerRenderKey = renderKey
  labelBudget = createMapLabelBudget()
  layerSource.entities.removeAll()
  if (!props.region) return
  const visible = new Set(props.visibleLayers)
  // Some imported offline packages contain duplicate feature ids within one
  // layer. Keep a per-render set so Cesium never receives the same entity id
  // twice, even while a layer is being refreshed.
  const renderedFeatureIds = new Set<string>()
  const renderBuildingDetail = shouldRenderBuildingDetail(cameraDetailTier)
  const configuredBuildingsUrl = resolveBuildingDataUrl(
    props.region,
    (import.meta.env.VITE_LOGISTICS_BUILDINGS_URL as string | undefined) ?? ""
  )
  const offlineBuildingFeatureCount = offlineBuildingSource?.entities.values.filter((entity) => Boolean(entity.polygon)).length ?? 0
  const hasExternalBuildingFeatures = hasRenderableOfflineBuildingFeatures(offlineBuildingFeatureCount)
  for (const layer of props.region.layers) {
    if (!visible.has(layer.code) || layer.state === "UNAVAILABLE") continue
    if (!renderBuildingDetail && layer.code === "BUILDINGS") continue
    for (const feature of layer.features) {
      // Imported packages retain a small set of legacy teaching building
      // polygons for validation. The real light-gray building layer is loaded
      // from the package BUILDINGS GeoJSON below; do not render those legacy
      // dark block polygons a second time.
      if (layer.code === "BUILDINGS" && hasExternalBuildingFeatures && configuredBuildingsUrl && feature.properties?.category === "BUILDING") continue
      addFeature(layer.code, feature, renderedFeatureIds)
    }
  }
  viewer.scene.requestRender()
}

function editorPickCoordinate(position: Cartesian2): V3Coordinate | null {
  if (!viewer) return null
  const ray = viewer.camera.getPickRay(position)
  // Offline teaching basemaps may not have a rendered globe tile at the
  // clicked position. Fall back to the camera ellipsoid so editor drawing
  // remains usable in the same degraded mode as the student planner.
  const cartesian = (ray ? viewer.scene.globe.pick(ray, viewer.scene) : null)
    ?? viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
  if (!cartesian || ![cartesian.x, cartesian.y, cartesian.z].every(Number.isFinite)) return null
  const cartographic = Cartographic.fromCartesian(cartesian)
  if (![cartographic.longitude, cartographic.latitude, cartographic.height].every(Number.isFinite)) return null
  const coordinate: V3Coordinate = {
    longitude: Number(CesiumMath.toDegrees(cartographic.longitude).toFixed(8)),
    latitude: Number(CesiumMath.toDegrees(cartographic.latitude).toFixed(8)),
    altitudeMeters: Math.max(0, Number(cartographic.height.toFixed(2)))
  }
  return props.region && isCoordinateInsideRegion(props.region, coordinate) ? coordinate : null
}

function renderEditorFeatures() {
  if (!editorSource) return
  const entities = editorSource.entities
  const labelEntities = editorLabelSource?.entities
  entities.removeAll()
  labelEntities?.removeAll()
  const colorFor = (value?: string) => value ? Color.fromCssColorString(value) : mapColor(mapInteractionColors.selected)
  for (const feature of props.editorFeatures ?? []) {
    const color = colorFor(feature.color)
    const points = feature.positions ?? (feature.position ? [feature.position] : [])
    if (!points.length) continue
    const heightMeters = Math.max(0, Number(feature.heightMeters ?? 0) || 0)
    const isVolume = props.mode === "3d" && heightMeters > 0
    const labelPoint = points[0]!
    const entity = {
      id: `editor:${feature.id}`,
      name: feature.name,
      ...(feature.geometryType === "POINT" ? {
        position: Cartesian3.fromDegrees(points[0]!.longitude, points[0]!.latitude, isVolume ? heightMeters / 2 : 5),
        ...(isVolume ? {
          cylinder: { length: heightMeters, topRadius: Math.max(2, Number(feature.radiusMeters ?? 5) * 0.6), bottomRadius: Math.max(2, Number(feature.radiusMeters ?? 5)), material: color.withAlpha(0.78), outline: true, outlineColor: Color.WHITE, heightReference: HeightReference.RELATIVE_TO_GROUND }
        } : {
          point: { pixelSize: 12, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY }
        })
      } : feature.geometryType === "LINESTRING" ? {
        polyline: { positions: isVolume ? points.map((point) => Cartesian3.fromDegrees(point.longitude, point.latitude, heightMeters)) : toCartesian(points), width: 4, material: color, clampToGround: !isVolume }
      } : {
        polygon: { hierarchy: Cartesian3.fromDegreesArray(flatten(points)), material: color.withAlpha(isVolume ? 0.34 : 0.2), height: 0, heightReference: HeightReference.CLAMP_TO_GROUND, ...(isVolume ? { extrudedHeight: heightMeters, extrudedHeightReference: HeightReference.RELATIVE_TO_GROUND } : {}) },
        polyline: { positions: Cartesian3.fromDegreesArray(flattenClosed(points)), width: 3, material: color, clampToGround: true }
      })
    }
    entities.add(entity)
    if (props.editorLabelsVisible !== false) labelEntities?.add({ id: `editor-label:${feature.id}`, name: feature.name, position: Cartesian3.fromDegrees(labelPoint.longitude, labelPoint.latitude, isVolume ? heightMeters + 4 : 8), label: createMapLabelAppearance({ text: feature.name, color: color.toCssColorString(), priority: "AUX", truncate: false, offset: new Cartesian2(0, -12) }) })
    if (props.editorEditingEnabled && points.length > 1) {
      const vertexPoints = feature.geometryType === "POLYGON" ? points.slice(0, -1) : points
      vertexPoints.forEach((point, index) => entities.add({
        id: `editor-vertex:${feature.id}:${index}`,
        position: Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitudeMeters ?? 5),
        point: { pixelSize: 7, color: color.withAlpha(0.9), outlineColor: Color.WHITE, outlineWidth: 1, heightReference: HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY }
      }))
    }
  }
  const drawing = props.editorDrawingPoints ?? []
  if (props.editorDrawingActive && drawing.length) {
    const drawColor = mapColor(mapInteractionColors.drawing)
    entities.add({
      id: "editor:drawing-preview",
      ...(drawing.length >= 3 ? { polygon: { hierarchy: Cartesian3.fromDegreesArray(flatten(drawing)), material: drawColor.withAlpha(0.16), height: 0, heightReference: HeightReference.CLAMP_TO_GROUND } } : {}),
      polyline: { positions: Cartesian3.fromDegreesArray(drawing.length > 2 ? flattenClosed(drawing) : flatten(drawing)), width: 3, material: drawColor, clampToGround: true }
    })
    drawing.forEach((point, index) => entities.add({ id: `editor:drawing-point:${index}`, position: Cartesian3.fromDegrees(point.longitude, point.latitude, 4), point: { pixelSize: 9, color: drawColor, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND } }))
  }
  viewer?.scene.requestRender()
}

function configureEditorInteractions() {
  if (!viewer) return
  editorInteractionHandler?.destroy()
  editorInteractionHandler = new ScreenSpaceEventHandler(viewer.scene.canvas)
  editorInteractionHandler.setInputAction((movement: { position: Cartesian2 }) => {
    const picked = viewer?.scene.pick(movement.position) as { id?: { id?: string } } | undefined
    const pickedId = String(picked?.id?.id ?? "")
    if (pickedId.startsWith("editor:") && !pickedId.startsWith("editor:drawing")) {
      emit("editorMapSelected", pickedId.slice("editor:".length))
      return
    }
    // Vertex handles and labels are rendered as separate Cesium entities.
    // Treat them as the parent overlay object so selecting a handle never
    // falls through to the map drawing handler and accidentally adds a point.
    if (pickedId.startsWith("editor-vertex:")) {
      const raw = pickedId.slice("editor-vertex:".length)
      const separator = raw.lastIndexOf(":")
      if (separator > 0) {
        emit("editorMapSelected", raw.slice(0, separator))
        return
      }
    }
    if (pickedId.startsWith("editor-label:")) {
      emit("editorMapSelected", pickedId.slice("editor-label:".length))
      return
    }
    const coordinate = editorPickCoordinate(movement.position)
    if (coordinate) emit("editorMapClick", coordinate)
  }, ScreenSpaceEventType.LEFT_CLICK)
  editorInteractionHandler.setInputAction((movement: { position: Cartesian2 }) => beginEditorDrag(movement.position), ScreenSpaceEventType.LEFT_DOWN)
  editorInteractionHandler.setInputAction((movement: { endPosition: Cartesian2 }) => handleEditorDrag(movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE)
  editorInteractionHandler.setInputAction(() => endEditorDrag(), ScreenSpaceEventType.LEFT_UP)
}

function beginEditorDrag(position: Cartesian2) {
  if (!viewer || !props.editorEditingEnabled) return
  const picked = viewer.scene.pick(position) as { id?: { id?: string } } | undefined
  const pickedId = String(picked?.id?.id ?? "")
  if (pickedId.startsWith("editor-vertex:")) {
    const raw = pickedId.slice("editor-vertex:".length)
    const separator = raw.lastIndexOf(":")
    const index = Number(raw.slice(separator + 1))
    if (separator > 0 && Number.isInteger(index)) draggedEditorFeature = { id: raw.slice(0, separator), vertexIndex: index }
  } else if (pickedId.startsWith("editor:") && !pickedId.startsWith("editor:drawing")) {
    draggedEditorFeature = { id: pickedId.slice("editor:".length), vertexIndex: null }
  }
  if (draggedEditorFeature) {
    viewer.scene.screenSpaceCameraController.enableRotate = false
    viewer.scene.screenSpaceCameraController.enableTranslate = false
  }
}

function handleEditorDrag(position: Cartesian2) {
  if (!viewer || !draggedEditorFeature || !props.editorEditingEnabled) return
  const coordinate = editorPickCoordinate(position)
  if (coordinate) emit("editorFeatureMoved", draggedEditorFeature.id, coordinate, draggedEditorFeature.vertexIndex)
}

function endEditorDrag() {
  if (!viewer) return
  draggedEditorFeature = null
  viewer.scene.screenSpaceCameraController.enableRotate = true
  viewer.scene.screenSpaceCameraController.enableTranslate = true
}

function focusSelectedMapFeature(featureId = props.selectedMapFeatureId) {
  if (!viewer || !featureId || !props.region) return
  const separator = featureId.indexOf(":")
  if (separator < 1) return
  const layerCode = featureId.slice(0, separator) as V3RegionLayerCode
  const rawId = featureId.slice(separator + 1)
  const layer = props.region.layers.find((item) => item.code === layerCode)
  const feature = layer?.features.find((item) => item.id === rawId)
  if (!feature) return
  const points = feature.positions ?? (feature.position ? [feature.position] : [])
  if (points.length === 0) return
  const longitude = points.reduce((sum, point) => sum + point.longitude, 0) / points.length
  const latitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length
  focusV3Coordinates(viewer, [{ longitude, latitude }], props.mode, 0.45)
}

function configureVtlInteractions() {
  if (!viewer) return
  vtlInteractionHandler = new ScreenSpaceEventHandler(viewer.scene.canvas)
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  vtlInteractionHandler.setInputAction((movement: { position: Cartesian2 }) => handleVtlClick(movement.position), ScreenSpaceEventType.LEFT_CLICK)
  vtlInteractionHandler.setInputAction((movement: { endPosition: Cartesian2 }) => handleVtlMove(movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE)
  vtlInteractionHandler.setInputAction((movement: { position: Cartesian2 }) => beginVtlDrag(movement.position), ScreenSpaceEventType.LEFT_DOWN)
  vtlInteractionHandler.setInputAction(() => endVtlDrag(), ScreenSpaceEventType.LEFT_UP)
  vtlInteractionHandler.setInputAction(() => finishVtlDrawing(), ScreenSpaceEventType.RIGHT_CLICK)
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape") return
  if (draggedEditorFeature || draggedVtlVertex || draggedVtlWaypoint) {
    event.preventDefault()
    handleGlobalPointerUp()
    return
  }
  if (!props.vtlZoneDrawMode) return
  event.preventDefault()
  vtlDrawingPoints = []
  vtlCursorPoint = null
  renderVtlOverlay()
  emit("vtlZoneDrawCancel")
}

/**
 * A drag can finish outside the Cesium canvas (for example on a side panel).
 * Release the camera lock globally so editor and VTL waypoint/zone drags
 * cannot leave the shared viewer in a permanently non-interactive state.
 */
function handleGlobalPointerUp() {
  if (draggedEditorFeature) endEditorDrag()
  if (draggedVtlVertex || draggedVtlWaypoint) endVtlDrag()
}

function handleVtlClick(position: Cartesian2) {
  if (!viewer || !props.vtlPlan) return
  if (props.vtlAllocationEditable && props.vtlZoneDrawMode) {
    const coordinate = pickVtlCoordinate(position)
    if (!coordinate || !props.vtlSelectedTaskId) return
    vtlDrawingPoints = [...vtlDrawingPoints, coordinate]
    renderVtlOverlay()
    return
  }
  const picked = viewer.scene.pick(position) as { id?: { id?: string } } | undefined
  const id = String(picked?.id?.id ?? "")
  const aircraftPick = parseVtlMapPickId(id)
  if (aircraftPick) {
    emit("vtlAircraftSelect", aircraftPick.aircraftId)
    return
  }
  if (id.startsWith("vtl-zone:")) {
    const zoneId = id.slice("vtl-zone:".length)
    const zone = props.vtlTaskZones?.find((item) => item.id === zoneId)
    const taskId = zone?.taskObjectIds[0]
    if (taskId) emit("vtlTaskSelect", taskId)
  }
}

function handleVtlMove(position: Cartesian2) {
  if (!viewer || (!props.vtlAllocationEditable && !props.vtlRouteEditable)) return
  if (props.vtlZoneDrawMode) {
    if (vtlDrawingPoints.length === 0) return
    vtlCursorPoint = pickVtlCoordinate(position)
    renderVtlOverlay()
    return
  }
  if (draggedVtlWaypoint && props.vtlRouteEditable) {
    const coordinate = pickVtlCoordinate(position)
    if (!coordinate) return
    emit("vtlWaypointUpdated", draggedVtlWaypoint.aircraftId, draggedVtlWaypoint.waypointId, {
      longitude: coordinate.longitude,
      latitude: coordinate.latitude
    })
    return
  }
  if (!draggedVtlVertex) return
  const coordinate = pickVtlCoordinate(position)
  const zone = props.vtlTaskZones?.find((item) => item.id === draggedVtlVertex?.zoneId)
  const taskId = zone?.taskObjectIds[0]
  if (!coordinate || !zone || !taskId) return
  const positions = zone.boundary.map((point, index) => index === draggedVtlVertex!.vertexIndex ? coordinate : point)
  emit("vtlZoneUpdated", taskId, positions)
}

function beginVtlDrag(position: Cartesian2) {
  if (!viewer || props.vtlZoneDrawMode) return
  const picked = viewer.scene.pick(position) as { id?: { id?: string } } | undefined
  const id = String(picked?.id?.id ?? "")
  if (props.vtlRouteEditable && id.startsWith("vtl-waypoint:")) {
    const raw = id.slice("vtl-waypoint:".length)
    const separator = raw.indexOf(":")
    const aircraftId = separator > 0 ? raw.slice(0, separator) : ""
    const waypointId = separator > 0 ? raw.slice(separator + 1) : ""
    const route = props.vtlPlan?.routes.find((item) => item.aircraftId === aircraftId)
    const waypoints = aircraftId === props.vtlEditingAircraftId && props.vtlEditingWaypoints ? props.vtlEditingWaypoints : route?.waypoints
    if (aircraftId && waypointId && waypoints?.some((waypoint) => waypoint.id === waypointId)) {
      draggedVtlWaypoint = { aircraftId, waypointId }
      viewer.scene.screenSpaceCameraController.enableRotate = false
      viewer.scene.screenSpaceCameraController.enableTranslate = false
      return
    }
  }
  if (!props.vtlAllocationEditable) return
  if (!id.startsWith("vtl-zone-vertex:")) return
  const raw = id.slice("vtl-zone-vertex:".length)
  const separator = raw.lastIndexOf(":")
  const zoneId = separator > 0 ? raw.slice(0, separator) : ""
  const vertexIndex = Number(raw.slice(separator + 1))
  if (!zoneId || !Number.isInteger(vertexIndex)) return
  const zone = props.vtlTaskZones?.find((item) => item.id === zoneId)
  if (!zone || vertexIndex < 0 || vertexIndex >= zone.boundary.length) return
  draggedVtlVertex = { zoneId, vertexIndex }
  viewer.scene.screenSpaceCameraController.enableRotate = false
  viewer.scene.screenSpaceCameraController.enableTranslate = false
}

function endVtlDrag() {
  if (!viewer) return
  draggedVtlVertex = null
  draggedVtlWaypoint = null
  viewer.scene.screenSpaceCameraController.enableRotate = true
  viewer.scene.screenSpaceCameraController.enableTranslate = true
}

function finishVtlDrawing() {
  if (!props.vtlAllocationEditable || !props.vtlZoneDrawMode || !props.vtlSelectedTaskId) return
  if (vtlDrawingPoints.length >= 3) emit("vtlZoneDrawComplete", props.vtlSelectedTaskId, vtlDrawingPoints.map((point) => ({ ...point })))
  vtlDrawingPoints = []
  vtlCursorPoint = null
  renderVtlOverlay()
}

function pickVtlCoordinate(position: Cartesian2): V3Coordinate | null {
  if (!viewer) return null
  const ray = viewer.camera.getPickRay(position)
  const cartesian = ray
    ? viewer.scene.globe.pick(ray, viewer.scene)
    : viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
  if (!cartesian || ![cartesian.x, cartesian.y, cartesian.z].every(Number.isFinite)) return null
  const cartographic = Cartographic.fromCartesian(cartesian)
  const coordinate = {
    longitude: Number(CesiumMath.toDegrees(cartographic.longitude).toFixed(8)),
    latitude: Number(CesiumMath.toDegrees(cartographic.latitude).toFixed(8)),
    altitudeMeters: 0
  }
  return isCoordinateInsideRegion(props.region, coordinate) ? coordinate : null
}

function renderVtlOverlay() {
  if (!viewer || !vtlSource) return
  const entities = vtlSource.entities
  entities.suspendEvents()
  try {
    entities.removeAll()
    const plan = props.vtlPlan
    renderVtlRuntimeOverlay()
    if (!plan) return
    const replayTaskStatus = new Map((props.vtlReplayFrame?.taskObjects ?? props.vtlRuntime?.taskObjects ?? []).map((task) => [task.id, task.status]))
    const landingColor = mapColor(mapPoiColors.takeoffLanding)
    const routeColor = mapColor(mapRouteColors.vtlInspection)
    const visibleAircraftIds = props.vtlVisibleAircraftIds?.length ? new Set(props.vtlVisibleAircraftIds) : null
    const selectedAircraftTaskIds = props.vtlSelectedAircraftId
      ? plan.allocation.assignments.find((assignment) => assignment.aircraftId === props.vtlSelectedAircraftId)?.taskObjectIds ?? []
      : visibleAircraftIds
        ? plan.allocation.assignments.filter((assignment) => visibleAircraftIds.has(assignment.aircraftId)).flatMap((assignment) => assignment.taskObjectIds)
        : []
  for (const zone of props.vtlTaskZones ?? []) {
    if (zone.boundary.length < 3) continue
    const selected = Boolean(props.vtlSelectedTaskId && zone.taskObjectIds.includes(props.vtlSelectedTaskId))
    const color = vtlZoneColor(zone.groupId)
    vtlSource.entities.add({
      id: `vtl-zone:${zone.id}`,
      name: zone.title,
      polygon: {
        hierarchy: Cartesian3.fromDegreesArray(flatten(zone.boundary)),
        material: color.withAlpha(selected ? 0.28 : 0.13),
        height: 0,
        heightReference: HeightReference.CLAMP_TO_GROUND
      },
      polyline: {
        positions: Cartesian3.fromDegreesArray(flattenClosed(zone.boundary)),
        width: selected ? 4 : 2,
        material: selected ? Color.WHITE : color,
        clampToGround: true
      },
      ...labelAt(zone.boundary[0]!, zone.title, color)
    })
    if (selected && props.vtlAllocationEditable && !props.vtlZoneDrawMode) {
      zone.boundary.forEach((point, index) => vtlSource!.entities.add({
        id: `vtl-zone-vertex:${zone.id}:${index}`,
        position: Cartesian3.fromDegrees(point.longitude, point.latitude, 4),
        point: {
          pixelSize: 11,
          color: Color.WHITE,
          outlineColor: color,
          outlineWidth: 3,
          heightReference: HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      }))
    }
  }
  if (props.vtlAllocationEditable && props.vtlZoneDrawMode && props.vtlSelectedTaskId && vtlDrawingPoints.length > 0) {
    const preview = vtlCursorPoint ? [...vtlDrawingPoints, vtlCursorPoint] : vtlDrawingPoints
    const drawColor = mapColor(mapInteractionColors.drawing)
    vtlSource.entities.add({
      id: "vtl-zone-drawing:preview",
      ...(preview.length >= 3 ? {
        polygon: {
          hierarchy: Cartesian3.fromDegreesArray(flatten(preview)),
          material: drawColor.withAlpha(0.16),
          height: 0,
          heightReference: HeightReference.CLAMP_TO_GROUND
        }
      } : {}),
      polyline: {
        positions: Cartesian3.fromDegreesArray(flatten(preview)),
        width: 3,
        material: drawColor,
        clampToGround: true
      }
    })
    vtlDrawingPoints.forEach((point, index) => vtlSource!.entities.add({
      id: `vtl-zone-drawing:point:${index}`,
      position: Cartesian3.fromDegrees(point.longitude, point.latitude, 4),
      point: { pixelSize: 9, color: drawColor, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND }
    }))
  }
  for (const task of plan.taskObjects) {
    if (task.positions.length < 1) continue
    const taskColor = vtlTaskColor(replayTaskStatus.get(task.id) ?? task.status)
    const taskLabel = vtlTaskLabelText({
      taskCount: plan.taskObjects.length,
      taskId: task.id,
      code: task.code,
      title: task.title,
      selectedTaskId: props.vtlSelectedTaskId ?? null,
      selectedAircraftTaskIds
    })
    if (task.type === "POINT") {
      const point = task.positions[0]!
      vtlSource.entities.add({
        id: `vtl-task:${task.id}`,
        name: `${task.code} ${task.title}`,
        position: Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitudeMeters ?? 6),
        point: { pixelSize: 12, color: taskColor, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND },
        ...(taskLabel ? { label: labelStyle(taskLabel, taskColor.toCssColorString()) } : {})
      })
    } else if (task.type === "LINE") {
      vtlSource.entities.add({
        id: `vtl-task:${task.id}`,
        name: `${task.code} ${task.title}`,
        polyline: { positions: toCartesian(task.positions), width: 4, material: taskColor, clampToGround: true },
        ...(task.positions[0] && taskLabel ? labelAt(task.positions[0]!, taskLabel, taskColor) : {})
      })
    } else if (task.positions.length >= 3) {
      vtlSource.entities.add({
        id: `vtl-task:${task.id}`,
        name: `${task.code} ${task.title}`,
        polygon: { hierarchy: Cartesian3.fromDegreesArray(flatten(task.positions)), material: taskColor.withAlpha(0.18), height: 0, heightReference: HeightReference.CLAMP_TO_GROUND },
        polyline: { positions: Cartesian3.fromDegreesArray(flattenClosed(task.positions)), width: 2.2, material: taskColor, clampToGround: true },
        ...(taskLabel ? labelAt(task.positions[0]!, taskLabel, taskColor) : {})
      })
    }
  }
  for (const site of plan.landingSites) {
    const color = site.type === "MAIN" ? landingColor : mapColor(mapPoiColors.landingSiteSecondary)
    const siteLabel = vtlLandingSiteLabelText({
      aircraftCount: props.vtlRuntime?.aircraft.length ?? props.vtlReplayFrame?.aircraft.length ?? 0,
      siteId: site.id,
      mainLandingSiteId: props.vtlMainLandingSiteId ?? "",
      code: site.code,
      title: site.title
    })
    vtlSource.entities.add({
      id: `vtl-site:${site.id}`,
      name: site.title,
      position: Cartesian3.fromDegrees(site.position.longitude, site.position.latitude, site.position.altitudeMeters ?? site.elevationMeters + 5),
      point: { pixelSize: site.type === "MAIN" ? 14 : 11, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND },
      ...(siteLabel ? { label: labelStyle(siteLabel, color.toCssColorString()) } : {})
    })
  }
  const selectedId = props.vtlSelectedAircraftId
  const routeEntries = plan.routes.map((route) => ({ aircraftId: route.aircraftId, waypoints: route.waypoints }))
  if (props.vtlEditingAircraftId && props.vtlEditingWaypoints?.length && !routeEntries.some((route) => route.aircraftId === props.vtlEditingAircraftId)) {
    routeEntries.push({ aircraftId: props.vtlEditingAircraftId, waypoints: [...props.vtlEditingWaypoints] })
  }
  for (const route of routeEntries) {
    if (visibleAircraftIds && !visibleAircraftIds.has(route.aircraftId)) continue
    if (selectedId && route.aircraftId !== selectedId) continue
    const waypoints = route.aircraftId === props.vtlEditingAircraftId && props.vtlEditingWaypoints
      ? props.vtlEditingWaypoints
      : route.waypoints
    if (waypoints.length < 2) continue
    vtlSource.entities.add({
      id: `vtl-route:${route.aircraftId}`,
      name: `巡检航线 ${route.aircraftId}`,
      polyline: { positions: toCartesian(waypoints.map((waypoint) => waypoint.position)), width: selectedId === route.aircraftId ? 5 : 2.5, material: selectedId === route.aircraftId ? Color.WHITE : routeColor, clampToGround: false }
    })
    for (const waypoint of waypoints) {
      vtlSource.entities.add({
        id: `vtl-waypoint:${route.aircraftId}:${waypoint.id}`,
        name: waypoint.phase,
        position: Cartesian3.fromDegrees(waypoint.position.longitude, waypoint.position.latitude, waypoint.altitudeMeters),
        point: { pixelSize: selectedId === route.aircraftId ? 9 : 5, color: phaseColor(waypoint.phase), outlineColor: Color.WHITE, outlineWidth: selectedId === route.aircraftId && props.vtlRouteEditable ? 2 : 1, heightReference: HeightReference.NONE, disableDepthTestDistance: props.vtlRouteEditable ? Number.POSITIVE_INFINITY : 0 }
      })
    }
  }
    viewer.scene.requestRender()
  } finally {
    entities.resumeEvents()
  }
}

function renderVtlRuntimeOverlay() {
  if (!viewer || !vtlRuntimeSource) return
  const entities = vtlRuntimeSource.entities
  const activeIds = new Set<string>()
  const selectedId = props.vtlSelectedAircraftId
  const visibleAircraftIds = props.vtlVisibleAircraftIds?.length ? new Set(props.vtlVisibleAircraftIds) : null
  const replaying = Boolean(props.vtlReplayFrame)
  const trackModeKey = replaying ? "replay" : "live"
  if (trackModeKey !== vtlTrackModeKey) {
    vtlTrackHistory.clear()
    vtlTrackModeKey = trackModeKey
  }
  const aircraft = props.vtlReplayFrame?.aircraft ?? props.vtlRuntime?.aircraft ?? []
  entities.suspendEvents()
  try {
    for (const item of aircraft) {
      if (visibleAircraftIds && !visibleAircraftIds.has(item.aircraftId)) continue
      const entityId = `vtl-aircraft:${item.aircraftId}`
      const selected = selectedId === item.aircraftId
      const color = item.eventIds.length > 0 ? mapColor(vtlColors.aircraftAlert) : mapColor(vtlColors.aircraftNormal)
      const altitudeMeters = Math.max(0, item.position.altitudeMeters ?? 0)
      const appearanceKey = `${selected}:${item.eventIds.join(",")}:${props.mode}`
      activeIds.add(entityId)
      const currentPosition = Cartesian3.fromDegrees(item.position.longitude, item.position.latitude, item.position.altitudeMeters ?? 0)
      const history = vtlTrackHistory.get(item.aircraftId) ?? []
      const previous = history[history.length - 1]
      if (!previous || Cartesian3.distance(previous, currentPosition) >= 0.5) {
        history.push(currentPosition)
        if (history.length > 600) history.splice(0, history.length - 600)
      }
      vtlTrackHistory.set(item.aircraftId, history)
      let entity = entities.getById(entityId)
      if (!entity || vtlRuntimeAppearanceKeys.get(entityId) !== appearanceKey) {
        if (entity) entities.remove(entity)
        entity = entities.add({
          id: entityId,
          name: item.aircraftCode,
          position: currentPosition,
          orientation: Transforms.headingPitchRollQuaternion(currentPosition, new HeadingPitchRoll(0, 0, 0)),
          point: { pixelSize: selected ? 13 : 8, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.NONE },
          model: {
            uri: "/models/logistics-drone.gltf",
            scale: 2.4,
            minimumPixelSize: selected ? 46 : 32,
            maximumScale: 24,
            color,
            colorBlendMode: ColorBlendMode.MIX,
            colorBlendAmount: 0.3,
            silhouetteColor: Color.WHITE,
            silhouetteSize: selected ? 3 : 1,
            distanceDisplayCondition: new DistanceDisplayCondition(0, 100_000)
          },
          ...(selected ? { label: labelStyle(`${item.aircraftCode} · 高度 ${Math.round(altitudeMeters)}m`, color.toCssColorString()) } : {})
        })
        vtlRuntimeAppearanceKeys.set(entityId, appearanceKey)
      } else if (entity.position instanceof ConstantPositionProperty) {
        entity.position.setValue(currentPosition)
      }
      const trackId = `vtl-aircraft-track:${item.aircraftId}`
      activeIds.add(trackId)
      const track = entities.getById(trackId)
      const trackMaterial = selected ? color.withAlpha(0.95) : color.withAlpha(0.62)
      if (track) {
        track.polyline!.positions = new ConstantProperty(history)
        track.polyline!.width = new ConstantProperty(selected ? 4 : 2.5)
        track.polyline!.material = new ColorMaterialProperty(trackMaterial)
      } else if (history.length > 1) {
        entities.add({
          id: trackId,
          name: `${item.aircraftCode} 飞行轨迹`,
          polyline: { positions: history, width: selected ? 4 : 2.5, material: trackMaterial, clampToGround: false, depthFailMaterial: trackMaterial }
        })
      }
      if (selected && viewer.trackedEntity?.id !== entityId) viewer.trackedEntity = entity
      if (props.mode === "3d" && selected && altitudeMeters > 1) {
        const guideId = `vtl-aircraft-altitude:${item.aircraftId}`
        activeIds.add(guideId)
        const guide = entities.getById(guideId)
        const positions = [
          Cartesian3.fromDegrees(item.position.longitude, item.position.latitude, 0),
          Cartesian3.fromDegrees(item.position.longitude, item.position.latitude, altitudeMeters)
        ]
        if (guide) {
          guide.polyline!.positions = new ConstantProperty(positions)
        } else {
          entities.add({
            id: guideId,
            name: `${item.aircraftCode} 高度参考`,
            polyline: { positions, width: 2, material: color.withAlpha(0.78), depthFailMaterial: color.withAlpha(0.42) },
            point: { pixelSize: 5, color, outlineColor: Color.WHITE, outlineWidth: 1, heightReference: HeightReference.NONE }
          })
        }
      }
    }
    for (const entity of [...entities.values]) {
      if (activeIds.has(entity.id)) continue
      entities.remove(entity)
      vtlRuntimeAppearanceKeys.delete(entity.id)
    }
    if (!selectedId || !activeIds.has(`vtl-aircraft:${selectedId}`)) viewer.trackedEntity = undefined
  } finally {
    entities.resumeEvents()
  }
  viewer.scene.requestRender()
}

function vtlZoneColor(groupId: string | null): Color {
  const groupIndex = props.vtlPlan?.allocation.groups.findIndex((group) => group.id === groupId) ?? -1
  return mapColor(vtlColors.zonePalette[Math.max(0, groupIndex) % vtlColors.zonePalette.length]!)
}

function vtlTaskColor(status: string): Color {
  if (status === "COMPLETED") return mapColor(vtlColors.taskCompleted)
  if (status === "INCOMPLETE") return mapColor(vtlColors.taskIncomplete)
  if (status === "IN_PROGRESS") return mapColor(vtlColors.taskInProgress)
  return mapColor(vtlColors.taskPending)
}

function toCartesian(points: readonly { longitude: number; latitude: number; altitudeMeters?: number }[]): Cartesian3[] {
  return points.map((point) => Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitudeMeters ?? 0))
}

function labelAt(point: { longitude: number; latitude: number; altitudeMeters?: number }, text: string, color: Color) {
  return {
    position: Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitudeMeters ?? 8),
    label: labelStyle(text, color.toCssColorString())
  }
}

function phaseColor(phase: string) {
  const cssColor = vtlPhaseColors[phase]
  return cssColor ? mapColor(cssColor) : Color.WHITE
}

function layerLabelPriority(code: V3RegionLayerCode, obstacle: boolean): MapLabelPriority {
  if (code === "RESTRICTIONS" || obstacle) return "RESTRICTION"
  if (code === "BUILDINGS") return "BUILDING"
  return "AUX"
}

function labelsLoadedForTier(priority: MapLabelPriority): boolean {
  if (cameraDetailTier === "near") return true
  if (cameraDetailTier === "medium") return priority !== "BUILDING"
  return priority === "REGION"
}

function addFeature(code: V3RegionLayerCode, feature: V3RegionFeature, renderedFeatureIds?: Set<string>) {
  if (!layerSource) return
  // Offline map packages can contain the same source feature more than once.
  // Cesium requires entity ids to be unique, so keep the first occurrence.
  const entityId = `v3-layer:${code}:${feature.id}`
  if (renderedFeatureIds?.has(entityId)) return
  if (layerSource.entities.getById(entityId)) return
  renderedFeatureIds?.add(entityId)
  const baseColor = regionLayerCesiumColors[code]
  if (feature.geometryType === "POLYGON" && feature.positions && feature.positions.length >= 3) {
    const knownHeight = typeof feature.heightMeters === "number" && Number.isFinite(feature.heightMeters) && feature.heightMeters > 0
    const heightMeters = knownHeight ? (feature.heightMeters ?? 0) : 0
    const isExtrudedBuilding = props.mode === "3d" && code === "BUILDINGS"
    const extrusionHeight = isExtrudedBuilding
      ? (knownHeight ? heightMeters : mapBuildingColors.fallbackHeightMeters)
      : 0
    const restriction = code === "RESTRICTIONS"
    const fillColor = isExtrudedBuilding
      ? buildingColorForHeight(extrusionHeight).withAlpha(mapBuildingColors.extrudedAlpha)
      : restriction
        ? baseColor.withAlpha(mapRestrictionColors.flatAlpha)
        : code === "BUILDINGS"
          ? buildingColorForHeight(0).withAlpha(mapBuildingColors.flatAlpha)
          : baseColor.withAlpha(0.18)
    const outlineColor = isExtrudedBuilding
      ? mapColor(mapBuildingColors.outline3d)
      : restriction
        ? baseColor
        : code === "BUILDINGS"
          ? mapColor(mapBuildingColors.outline2d)
          : baseColor
    layerSource.entities.add({
      id: entityId,
      name: isExtrudedBuilding && !knownHeight ? `${feature.name}（高度未提供）` : feature.name,
      polygon: {
        hierarchy: Cartesian3.fromDegreesArray(flatten(feature.positions)),
        material: fillColor,
        height: 0,
        heightReference: extrusionHeight > 0 ? HeightReference.RELATIVE_TO_GROUND : HeightReference.CLAMP_TO_GROUND,
        ...(extrusionHeight > 0 ? {
          extrudedHeight: extrusionHeight,
          extrudedHeightReference: HeightReference.RELATIVE_TO_GROUND
        } : {})
      },
      ...(!isExtrudedBuilding ? {
        polyline: {
          positions: Cartesian3.fromDegreesArray(flattenClosed(feature.positions)),
          width: restriction ? (props.mode === "3d" ? mapRestrictionColors.outlineWidth3d : mapRestrictionColors.outlineWidth2d) : 1.5,
          material: outlineColor,
          clampToGround: true
        }
      } : {})
    })
    return
  }
  if (feature.geometryType === "POINT" && feature.position) {
    const heightMeters = featureHeightMeters(feature)
    const featureIsObstacle = isObstacleFeature(feature)
    const obstacle = featureIsObstacle && heightMeters > 0 && props.mode === "3d"
    const pointColor = featureIsObstacle ? mapColor(mapObstacleColors.fill) : baseColor
    const positionHeight = obstacle ? heightMeters / 2 : (props.mode === "3d" ? heightMeters : 0)
    const coverage = Number(feature.properties.coverageMeters ?? 0)
    const priority = layerLabelPriority(code, featureIsObstacle)
    const labelText = obstacle ? `${feature.name} · ${heightMeters.toFixed(0)}m` : feature.name
    const labelAllowed = labelsLoadedForTier(priority) && labelBudget(priority)
    const poiCategory = poiCategoryForRegionFeature(code, { obstacle: featureIsObstacle, name: feature.name })
    layerSource.entities.add({
      id: entityId,
      name: feature.name,
      position: Cartesian3.fromDegrees(feature.position.longitude, feature.position.latitude, positionHeight),
      ...(obstacle ? {
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
        billboard: createPoiBillboard(poiCategory, { width: poiCategory === "generic" ? 18 : 22 })
      }),
      ...(coverage > 0 ? {
        ellipse: {
          semiMajorAxis: coverage,
          semiMinorAxis: coverage,
          material: pointColor.withAlpha(0.08),
          height: 0,
          heightReference: HeightReference.CLAMP_TO_GROUND
        }
      } : {}),
      ...(labelAllowed ? {
        label: createMapLabelAppearance({
          text: labelText,
          color: obstacle ? mapObstacleColors.label : pointColor.toCssColorString(),
          priority,
          offset: new Cartesian2(0, obstacle ? -heightMeters / 2 - 12 : -30)
        })
      } : {})
    })
  }
}

function setMode(mode: "2d" | "3d", refocus = true) {
  if (!viewer) return
  const targetMode = mode === "2d" ? SceneMode.SCENE2D : SceneMode.SCENE3D
  const cameraSnapshot = !refocus && viewer.scene.mode !== targetMode ? captureV3Camera(viewer) : null
  const refreshMode = () => {
    cameraDetailTier = currentDetailTier()
    renderLayers()
    syncOfflineBuildingVisibility()
    renderEditorFeatures()
    renderVtlOverlay()
    if (cameraSnapshot) restoreV3Camera(viewer!, cameraSnapshot, mode)
    if (refocus) focusRegion(0.35, mode)
  }
  if (viewer.scene.mode === targetMode) {
    refreshMode()
    return
  }
  removeMorphCompleteListener?.()
  removeMorphCompleteListener = null
  if (viewer.scene.mode === SceneMode.MORPHING) viewer.scene.completeMorph()
  removeMorphCompleteListener = viewer.scene.morphComplete.addEventListener(() => {
    removeMorphCompleteListener = null
    refreshMode()
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
  focusRegion(0.35, props.mode)
}

function focusEditorFeature(id: string) {
  const feature = (props.editorFeatures ?? []).find((item) => item.id === id)
  const points = feature?.positions ?? (feature?.position ? [feature.position] : [])
  if (!viewer || points.length === 0) return
  // Frame the whole line/polygon when the object list is used for navigation;
  // focusing only the first vertex made long routes appear partially off-screen.
  focusV3Coordinates(viewer, points, props.mode, 0.45)
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

function labelStyle(text: string, color: string, priority: MapLabelPriority = "TASK_POINT") {
  return createMapLabelAppearance({ text, color, priority })
}

function flatten(points: readonly { longitude: number; latitude: number }[]): number[] {
  return points.flatMap((point) => [point.longitude, point.latitude])
}

function flattenClosed(points: readonly { longitude: number; latitude: number }[]): number[] {
  const first = points[0]
  return first ? flatten([...points, first]) : []
}

defineExpose({ focusEditorFeature, focusMapRegion })

</script>

<template>
  <div class="v3-region-map-shell" :data-region-code="region?.regionCode ?? ''" :data-region-entity-ids="regionEntityIds">
  <div ref="container" class="v3-region-map" />
  <V3MapResourceNotice :available="Boolean(region)" :package-id="missingRegionPackageId ?? null" :imagery-state="imageryState" @retry="reloadMapResources" />
  <V3MapTerrainNotice :state="terrainState" :region="region" @retry="reloadMapResources" />
  <V3MapViewControls :mode="mode" @home="focusMapRegion" @zoom-in="zoomMapIn" @zoom-out="zoomMapOut" @rotate-left="rotateMapLeft" @rotate-right="rotateMapRight" @reset-north="resetMapNorth" @top-down="setTopDownView" @flight-view="setFlightView" />
  <V3MapScaleBar :viewer="scaleViewer" :available="Boolean(region)" :terrain-state="terrainState" />
</div>
</template>

<style scoped>
.v3-region-map-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
  background: #dce3de;
}

.v3-region-map {
  width: 100%;
  height: 100%;
}
</style>
