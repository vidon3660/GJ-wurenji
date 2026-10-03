<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  CustomDataSource,
  Entity,
  GeoJsonDataSource,
  HeightReference,
  HorizontalOrigin,
  LabelStyle,
  PolygonHierarchy,
  PolylineOutlineMaterialProperty,
  JulianDate,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  VerticalOrigin,
  Viewer
} from "cesium"
import type {
  LogisticsMapAnnotationInput,
  LogisticsRouteInput,
  ShowAreaDistanceMeasurement,
  ShowAreaMeasuredPoint,
  V3Coordinate,
  V3LogisticsNode,
  V3LogisticsNodeType,
  V3RegionCatalogItem,
  V3RegionLayerCode
} from "@wurenji/shared"
import { logisticsSpatialFeatureKind } from "@wurenji/shared"
import { createDistanceMeasurement } from "../area-measurement"
import { configureV3CesiumPerformance } from "../cesium-performance"
import { createUnifiedCesiumViewer } from "../cesium-map-adapter"
import { createMapLabelAppearance, createMapLabelBudget, mapDetailLevelForCameraHeight, type MapDetailLevel } from "../map-label-policy"
import { createPoiBillboard, poiCategoryForLogisticsNode, type V3PoiState } from "../map-poi-icons"
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
  regionLayerCesiumColors
} from "../map-visual-theme"
import { logisticsFocusCoordinates, logisticsNodeTypeVisible } from "../logistics-map-tools"
import { createV3MapDataStateTracker, type V3MapDataState, type V3MapDataStateTracker, type V3MapImageryState } from "../map-loading-state"
import { regionMapResourceKey } from "../map-resources"
import { loadV3MapResources } from "../map-resources-loader"
import { captureV3Camera, focusV3Coordinates, focusV3Region, isCoordinateInsideRegion, regionMaskHierarchy, restoreV3Camera } from "../map-region-constraints"
import { resetV3CameraNorth, rotateV3Camera, setV3CameraPreset, zoomV3Camera } from "../map-region-constraints"
import type { RegionTerrainState } from "../terrain"
import V3MapViewControls from "./V3MapViewControls.vue"
import V3MapScaleBar from "./V3MapScaleBar.vue"
import V3MapResourceNotice from "./V3MapResourceNotice.vue"
import V3MapTerrainNotice from "./V3MapTerrainNotice.vue"

const props = defineProps<{
  region: V3RegionCatalogItem
  visibleLayers: readonly V3RegionLayerCode[]
  visibleNodeTypes?: readonly V3LogisticsNodeType[]
  showLabels?: boolean
  selectedDeliveryPointIds: readonly string[]
  routes: readonly LogisticsRouteInput[]
  annotations?: readonly LogisticsMapAnnotationInput[]
  selectedRouteId: string
  selectedWaypointId: string
  selectedAnnotationId?: string
  mode: "2d" | "3d"
  editable: boolean
  addWaypointMode: boolean
  toolMode?: "ANNOTATION" | "MEASURE" | null
  measurement?: ShowAreaDistanceMeasurement | null
  focusCoordinate?: V3Coordinate | null
}>()

const emit = defineEmits<{
  nodeSelect: [nodeId: string]
  routeSelect: [routeId: string]
  waypointSelect: [routeId: string, waypointId: string]
  waypointCreated: [position: V3Coordinate]
  waypointMoved: [routeId: string, waypointId: string, position: V3Coordinate]
  annotationCreated: [position: ShowAreaMeasuredPoint]
  annotationSelect: [annotationId: string]
  measured: [measurement: ShowAreaDistanceMeasurement]
  interactionCancel: []
  editStart: []
  dataState: [state: V3MapDataState]
}>()

const container = ref<HTMLElement | null>(null)
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
let nodeSource: CustomDataSource | null = null
let routeSource: CustomDataSource | null = null
let toolSource: CustomDataSource | null = null
let offlineBuildingsSource: GeoJsonDataSource | null = null
let draggedWaypoint: { routeId: string; waypointId: string } | null = null
let measurePoints: ShowAreaMeasuredPoint[] = []
let cursorPoint: ShowAreaMeasuredPoint | null = null
let removeMorphCompleteListener: (() => void) | null = null
let labelResizeObserver: ResizeObserver | null = null
let compactLabels = false
let hoveredNodeId: string | null = null
let cameraDetailTier: MapDetailLevel = "near"
let removeCameraDetailListener: (() => void) | null = null
const offlineBuildingHeights = new Map<string, number>()

const routeColors = {
  OUTBOUND: mapColor(mapRouteColors.outbound),
  RETURN: mapColor(mapRouteColors.return),
  ALTERNATE: mapColor(mapRouteColors.alternate)
}

function labelsLoadedForTier(priority: "BUILDING" | "RESTRICTION" | "TASK_POINT") {
  if (props.showLabels === false) return false
  if (cameraDetailTier === "near") return true
  if (cameraDetailTier === "medium") return priority !== "BUILDING"
  return priority === "TASK_POINT"
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
    isCurrent: () => viewer === mapViewer && mapDataTracker === tracker && generation === mapResourceGeneration && !mapViewer.isDestroyed()
  })
  if (viewer === mapViewer && mapDataTracker === tracker && generation === mapResourceGeneration && !mapViewer.isDestroyed()) activeResourceCleanup = cleanup
  else cleanup()
}

onMounted(async () => {
  if (!container.value) return
  window.addEventListener("keydown", handleKeyDown)
  compactLabels = container.value.clientWidth <= 520
  labelResizeObserver = new ResizeObserver(([entry]) => {
    const nextCompactLabels = (entry?.contentRect.width ?? container.value?.clientWidth ?? 0) <= 520
    if (nextCompactLabels === compactLabels) return
    compactLabels = nextCompactLabels
    renderNodes()
    renderRoutes()
  })
  labelResizeObserver.observe(container.value)
  viewer = createUnifiedCesiumViewer(container.value, { antialias: true, highResolution: true })
  scaleViewer.value = viewer
  viewerReady.value = true
  removeCameraDetailListener = viewer.camera.changed.addEventListener(() => {
    const height = viewer?.camera.positionCartographic?.height
    const nextTier = typeof height === "number" && Number.isFinite(height) ? mapDetailLevelForCameraHeight(height) : "near"
    if (nextTier === cameraDetailTier) return
    cameraDetailTier = nextTier
    renderLayers()
    renderNodes()
    renderRoutes()
  })
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
  regionSource = await viewer.dataSources.add(new CustomDataSource("logistics-region"))
  layerSource = await viewer.dataSources.add(new CustomDataSource("logistics-layers"))
  nodeSource = await viewer.dataSources.add(new CustomDataSource("logistics-nodes"))
  routeSource = await viewer.dataSources.add(new CustomDataSource("logistics-routes"))
  toolSource = await viewer.dataSources.add(new CustomDataSource("logistics-map-tools"))
  void loadOfflineLogisticsResources()
  configureInteractions()
  renderAll()
  setMode(props.mode)
  mapDataTracker.markInitialized()
})

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeyDown)
  viewerReady.value = false
  mapResourceGeneration += 1
  removePerformanceTuning?.()
  removePerformanceTuning = null
  removeTileLoadProgressListener?.()
  removeTileLoadProgressListener = null
  activeResourceCleanup?.()
  activeResourceCleanup = null
  removeMorphCompleteListener?.()
  removeCameraDetailListener?.()
  removeCameraDetailListener = null
  labelResizeObserver?.disconnect()
  handler?.destroy()
  if (offlineBuildingsSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(offlineBuildingsSource, true)
  offlineBuildingsSource = null
  offlineBuildingHeights.clear()
  viewer?.destroy()
  scaleViewer.value = null
  handler = null
  viewer = null
  mapDataTracker = null
  regionSource = null
  layerSource = null
  nodeSource = null
  routeSource = null
  toolSource = null
  labelResizeObserver = null
})

async function loadOfflineLogisticsResources() {
  if (!viewer || viewer.isDestroyed()) return
  // 提供的 L17/建筑数据覆盖广州北部教学区；其他预设区域继续使用其自身资源，避免错位叠加。
  const center = props.region.center
  if (center.longitude < 113.10 || center.longitude > 113.50 || center.latitude < 22.95 || center.latitude > 23.20) return
  const buildingsUrl = ((import.meta.env.VITE_LOGISTICS_BUILDINGS_URL as string | undefined)
    ?? props.region.layers.find((layer) => layer.code === "BUILDINGS")?.dataUrl
    ?? "/map/logistics/gd-north-core-buildings.geojson").trim()
  try {
    offlineBuildingsSource = await GeoJsonDataSource.load(buildingsUrl, { clampToGround: false })
    if (!viewer || viewer.isDestroyed()) return
    for (const entity of offlineBuildingsSource.entities.values) {
      if (!entity.polygon) continue
      const rawHeight = entity.properties?.height?.getValue(JulianDate.now())
      const seed = stableBuildingSeed(entity.id)
      const heightMeters = Number.isFinite(Number(rawHeight)) && Number(rawHeight) > 0
        ? Number(rawHeight)
        : 8 + (seed % 35)
      offlineBuildingHeights.set(String(entity.id), heightMeters)
      entity.name = entity.name || `离线建筑 ${entity.id}`
      entity.polygon.height = new ConstantProperty(0)
      entity.polygon.heightReference = new ConstantProperty(HeightReference.RELATIVE_TO_GROUND)
      entity.polygon.extrudedHeight = new ConstantProperty(props.mode === "3d" ? heightMeters : 0)
      entity.polygon.extrudedHeightReference = new ConstantProperty(HeightReference.RELATIVE_TO_GROUND)
      entity.polygon.material = new ColorMaterialProperty(Color.WHITE.withAlpha(0.58))
      entity.polygon.outline = new ConstantProperty(true)
      entity.polygon.outlineColor = new ConstantProperty(Color.WHITE.withAlpha(0.9))
    }
    viewer.dataSources.add(offlineBuildingsSource)
    syncOfflineBuildingVisibility()
  } catch {
    offlineBuildingsSource = null
  }
}

function syncOfflineBuildingVisibility() {
  const visible = props.visibleLayers.includes("BUILDINGS")
  for (const entity of offlineBuildingsSource?.entities.values ?? []) {
    entity.show = visible
    const heightMeters = offlineBuildingHeights.get(String(entity.id))
    if (heightMeters !== undefined && entity.polygon) {
      entity.polygon.extrudedHeight = new ConstantProperty(props.mode === "3d" ? heightMeters : 0)
    }
  }
}

function stableBuildingSeed(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619)
  return Math.abs(hash >>> 0)
}

watch(() => props.region, renderAll, { deep: true })
watch(() => regionMapResourceKey(props.region), () => { void reloadMapResources() })
watch(() => props.visibleLayers, () => { renderLayers(); syncOfflineBuildingVisibility() }, { deep: true })
watch(() => props.visibleNodeTypes, renderNodes, { deep: true })
watch(() => props.showLabels, renderAll)
watch(() => props.selectedDeliveryPointIds, renderNodes, { deep: true })
watch(() => props.routes, renderRoutes, { deep: true })
watch(() => props.annotations, renderTools, { deep: true })
watch(() => [props.selectedRouteId, props.selectedWaypointId], renderRoutes)
watch(() => props.selectedAnnotationId, renderTools)
watch(() => props.measurement, renderTools, { deep: true })
watch(() => props.mode, (mode) => { setMode(mode, false); syncOfflineBuildingVisibility() })
watch(() => props.focusCoordinate, (coordinate) => {
  if (!viewer || !coordinate) return
  focusV3Coordinates(viewer, [coordinate], props.mode, 0.35)
}, { deep: true })
watch(() => props.toolMode, resetToolInteraction)

function configureInteractions() {
  if (!viewer) return
  handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
  viewer.cesiumWidget.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK)
  handler.setInputAction((movement: { position: Cartesian2 }) => handleClick(movement.position), ScreenSpaceEventType.LEFT_CLICK)
  handler.setInputAction((movement: { position: Cartesian2 }) => beginDrag(movement.position), ScreenSpaceEventType.LEFT_DOWN)
  handler.setInputAction((movement: { endPosition: Cartesian2 }) => handleMove(movement.endPosition), ScreenSpaceEventType.MOUSE_MOVE)
  handler.setInputAction(() => endDrag(), ScreenSpaceEventType.LEFT_UP)
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== "Escape" || (!props.addWaypointMode && !props.toolMode)) return
  event.preventDefault()
  resetToolInteraction()
  emit("interactionCancel")
}

function handleClick(position: Cartesian2) {
  if (!viewer) return
  if (props.editable && props.toolMode === "ANNOTATION") {
    const coordinate = pickMeasuredPoint(position)
    if (coordinate) emit("annotationCreated", coordinate)
    return
  }
  if (props.toolMode === "MEASURE") {
    const coordinate = pickMeasuredPoint(position)
    if (!coordinate) return
    if (measurePoints.length === 0) measurePoints = [coordinate]
    else {
      emit("measured", createDistanceMeasurement(measurePoints[0]!, coordinate))
      measurePoints = []
      cursorPoint = null
    }
    renderTools()
    return
  }
  const picked = viewer.scene.pick(position) as { id?: Entity } | undefined
  const id = typeof picked?.id?.id === "string" ? picked.id.id : ""
  if (id.startsWith("log-annotation:")) {
    emit("annotationSelect", id.slice("log-annotation:".length))
    return
  }
  if (id.startsWith("log-node:")) {
    emit("nodeSelect", id.slice("log-node:".length))
    return
  }
  if (id.startsWith("log-waypoint:")) {
    const [, routeId, waypointId] = id.split(":")
    if (routeId && waypointId) emit("waypointSelect", routeId, waypointId)
    return
  }
  if (id.startsWith("log-route:")) {
    const routeId = id.split(":")[1]
    if (routeId) emit("routeSelect", routeId)
    return
  }
  if (props.editable && props.addWaypointMode && props.selectedRouteId) {
    const coordinate = pickCoordinate(position)
    if (coordinate) emit("waypointCreated", coordinate)
  }
}

function beginDrag(position: Cartesian2) {
  if (!viewer || !props.editable || props.toolMode) return
  const picked = viewer.scene.pick(position) as { id?: Entity } | undefined
  const id = typeof picked?.id?.id === "string" ? picked.id.id : ""
  if (!id.startsWith("log-waypoint:")) return
  const [, routeId, waypointId] = id.split(":")
  const route = props.routes.find((item) => item.id === routeId)
  const waypoint = route?.waypoints.find((item) => item.id === waypointId)
  if (!routeId || !waypointId || waypoint?.locked) return
  draggedWaypoint = { routeId, waypointId }
  emit("editStart")
  viewer.scene.screenSpaceCameraController.enableRotate = false
  viewer.scene.screenSpaceCameraController.enableTranslate = false
}

function dragWaypoint(position: Cartesian2) {
  if (!draggedWaypoint) return
  const coordinate = pickCoordinate(position)
  if (coordinate) emit("waypointMoved", draggedWaypoint.routeId, draggedWaypoint.waypointId, coordinate)
}

function handleMove(position: Cartesian2) {
  if (draggedWaypoint) {
    dragWaypoint(position)
    return
  }
  if (props.toolMode === "MEASURE" && measurePoints.length > 0) {
    cursorPoint = pickMeasuredPoint(position)
    renderTools()
    return
  }
  if (props.toolMode) return
  const picked = viewer?.scene.pick(position) as { id?: Entity } | undefined
  const id = typeof picked?.id?.id === "string" ? picked.id.id : ""
  const nextHovered = id.startsWith("log-node:") ? id.slice("log-node:".length) : null
  if (nextHovered === hoveredNodeId) return
  hoveredNodeId = nextHovered
  if (viewer) viewer.scene.canvas.style.cursor = nextHovered ? "pointer" : ""
  renderNodes()
}

function endDrag() {
  if (!viewer || !draggedWaypoint) return
  draggedWaypoint = null
  viewer.scene.screenSpaceCameraController.enableRotate = true
  viewer.scene.screenSpaceCameraController.enableTranslate = true
}

function renderAll() {
  renderRegion()
  renderLayers()
  renderNodes()
  renderRoutes()
  renderTools()
}

function renderRegion() {
  if (!regionSource) return
  regionSource.entities.removeAll()
  const maskHierarchy = regionMaskHierarchy(props.region)
  if (maskHierarchy) {
    regionSource.entities.add({
      id: `log-region-mask:${props.region.regionCode}`,
      polygon: {
        hierarchy: maskHierarchy,
        material: mapColorAlpha(mapRegionColors.mask, mapRegionColors.maskAlpha),
        height: 0,
        heightReference: HeightReference.CLAMP_TO_GROUND
      }
    })
  }
  regionSource.entities.add({
    id: "log-region-boundary",
    polyline: {
      positions: Cartesian3.fromDegreesArray(flattenClosed(props.region.boundary)),
      width: 4,
      material: mapColor(mapRegionColors.boundary),
      clampToGround: true
    },
    polygon: {
      hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(flatten(props.region.boundary))),
      material: mapColorAlpha(mapRegionColors.boundary, mapRegionColors.boundaryFillAlpha),
      height: 0,
      heightReference: HeightReference.CLAMP_TO_GROUND
    }
  })
  viewer?.scene.requestRender()
}

function renderLayers() {
  if (!layerSource) return
  layerSource.entities.removeAll()
  const labelBudget = createMapLabelBudget()
  const visible = new Set(props.visibleLayers)
  for (const layer of props.region.layers) {
    if (!visible.has(layer.code)) continue
    for (const feature of layer.features) {
      const featureKind = logisticsSpatialFeatureKind(layer.code, feature)
      const isBuilding = layer.code === "BUILDINGS"
      const isRestriction = layer.code === "RESTRICTIONS"
      const color = featureKind === "OBSTACLE" ? mapColor(mapObstacleColors.fill) : regionLayerCesiumColors[layer.code]
      const featureHeight = typeof feature.heightMeters === "number" && Number.isFinite(feature.heightMeters) ? feature.heightMeters : null
      if (feature.geometryType === "LINESTRING" && feature.positions && feature.positions.length >= 2) {
        layerSource.entities.add({
          id: `log-layer:${layer.code}:${feature.id}`,
          name: feature.name,
          polyline: { positions: Cartesian3.fromDegreesArray(flatten(feature.positions)), width: layer.code === "WATER" ? 3.5 : 2.5, material: color.withAlpha(layer.code === "WATER" ? 0.78 : 0.62), clampToGround: true }
        })
      } else if (feature.geometryType === "POLYGON" && feature.positions) {
        const featureCenter = centroid(feature.positions)
        const extruded = isBuilding && featureHeight !== null
        layerSource.entities.add({
          id: `log-layer:${layer.code}:${feature.id}`,
          polygon: {
            hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(flatten(feature.positions))),
            material: isBuilding
              ? buildingColorForHeight(featureHeight ?? 0).withAlpha(featureHeight === null ? mapBuildingColors.flatAlpha : 0.52)
              : isRestriction
                ? mapColorAlpha(mapRestrictionColors.fill, mapRestrictionColors.flatAlpha)
                : color.withAlpha(0.24),
            height: 0,
            ...(extruded ? { extrudedHeight: featureHeight, extrudedHeightReference: HeightReference.RELATIVE_TO_GROUND } : {}),
            heightReference: isBuilding ? HeightReference.RELATIVE_TO_GROUND : HeightReference.CLAMP_TO_GROUND
          },
          polyline: {
            positions: Cartesian3.fromDegreesArray(flattenClosed(feature.positions)),
            width: isRestriction ? 4 : isBuilding ? 2.5 : 2,
            material: isBuilding ? mapColor(mapBuildingColors.outline2d) : color.withAlpha(0.9),
            clampToGround: true
          },
          ...(labelsLoadedForTier("BUILDING") && props.mode === "3d" && layer.code === "BUILDINGS" && labelBudget("BUILDING") ? {
            position: Cartesian3.fromDegrees(featureCenter.longitude, featureCenter.latitude, (featureHeight ?? 0) + 4),
            label: environmentFeatureLabel(feature.name, featureKind, featureHeight)
          } : {})
        })
      } else if (feature.position) {
        if (featureKind === "OBSTACLE" && featureHeight !== null) {
          const radius = numericFeatureProperty(feature.properties.radiusMeters, 5)
          layerSource.entities.add({
            id: `log-layer:${layer.code}:${feature.id}`,
            position: Cartesian3.fromDegrees(feature.position.longitude, feature.position.latitude, featureHeight / 2),
            cylinder: {
              length: featureHeight,
              topRadius: Math.max(1, radius * 0.45),
              bottomRadius: radius,
              material: color.withAlpha(mapObstacleColors.cylinderAlpha),
              heightReference: HeightReference.RELATIVE_TO_GROUND
            }
          })
          if (labelsLoadedForTier("RESTRICTION") && props.mode === "3d" && labelBudget("RESTRICTION")) {
            layerSource.entities.add({
              id: `log-layer:${layer.code}:${feature.id}:label`,
              position: Cartesian3.fromDegrees(feature.position.longitude, feature.position.latitude, featureHeight + 5),
              label: environmentFeatureLabel(feature.name, featureKind, featureHeight)
            })
          }
        } else {
          layerSource.entities.add({
            id: `log-layer:${layer.code}:${feature.id}`,
            position: Cartesian3.fromDegrees(feature.position.longitude, feature.position.latitude, 3),
            point: { pixelSize: 7, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND }
          })
        }
      }
    }
  }
  viewer?.scene.requestRender()
}

function nodeBillboardState(node: V3LogisticsNode, selected: boolean): V3PoiState {
  if (selected) return "selected"
  if (hoveredNodeId === node.id) return "hover"
  return "normal"
}

function renderNodes() {
  if (!nodeSource) return
  nodeSource.entities.removeAll()
  const selectedDeliveryIds = new Set(props.selectedDeliveryPointIds)
  const referencedNodeIds = routeReferencedNodeIds()
  for (const node of props.region.logisticsNodes ?? []) {
    if (!node.enabled || (props.visibleNodeTypes && !logisticsNodeTypeVisible(node.type, props.visibleNodeTypes))) continue
    const selected = selectedDeliveryIds.has(node.id)
    const state = nodeBillboardState(node, selected)
    const color = nodeColor(node, selected)
    const category = poiCategoryForLogisticsNode(node.type)
    const billboard = createPoiBillboard(category, { state })
    const showLabel = labelsLoadedForTier("TASK_POINT") && (!compactLabels || selected || referencedNodeIds.has(node.id) || hoveredNodeId === node.id)
    if (node.geometryType === "POLYGON" && node.positions) {
      const center = centroid(node.positions)
      nodeSource.entities.add({
        id: `log-node:${node.id}`,
        polygon: {
          hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(flatten(node.positions))),
          material: color.withAlpha(0.28),
          height: 0,
          heightReference: HeightReference.CLAMP_TO_GROUND
        },
        polyline: {
          positions: Cartesian3.fromDegreesArray(flattenClosed(node.positions)),
          width: 1.5,
          material: color,
          clampToGround: true
        },
        position: Cartesian3.fromDegrees(center.longitude, center.latitude, 8),
        billboard,
        ...(showLabel ? { label: nodeLabel(node, color) } : {})
      })
    } else if (node.position) {
      nodeSource.entities.add({
        id: `log-node:${node.id}`,
        position: Cartesian3.fromDegrees(node.position.longitude, node.position.latitude, 5),
        billboard,
        ...(showLabel ? { label: nodeLabel(node, color) } : {})
      })
    }
  }
  viewer?.scene.requestRender()
}

function renderRoutes() {
  if (!routeSource) return
  routeSource.entities.removeAll()
  for (const route of props.routes) {
    const selected = route.id === props.selectedRouteId
    const baseColor = route.role === "ALTERNATE" ? routeColors.ALTERNATE : routeColors[route.direction]
    const color = selected ? mapColor(mapInteractionColors.selectedSoft) : baseColor
    route.waypoints.slice(0, -1).forEach((waypoint, segmentIndex) => {
      const next = route.waypoints[segmentIndex + 1]!
      const segmentCoordinates = [waypoint.position, next.position]
      const segmentAltitude = waypoint.segmentAltitudeMeters
      routeSource!.entities.add({
        id: `log-route:${route.id}:protection:${segmentIndex}`,
        corridor: {
          positions: Cartesian3.fromDegreesArray(flatten(segmentCoordinates)),
          width: Math.max(route.protectionRadiusMeters * 2, 2),
          material: color.withAlpha(selected ? 0.17 : 0.07),
          height: props.mode === "3d" ? segmentAltitude : 0,
          heightReference: props.mode === "3d" ? HeightReference.RELATIVE_TO_GROUND : HeightReference.CLAMP_TO_GROUND
        }
      })
      routeSource!.entities.add(props.mode === "3d" ? {
        id: `log-route:${route.id}:center:${segmentIndex}`,
        corridor: {
          positions: Cartesian3.fromDegreesArray(flatten(segmentCoordinates)),
          width: selected ? 4 : route.role === "ALTERNATE" ? 2 : 3,
          material: color,
          height: segmentAltitude + 0.4,
          heightReference: HeightReference.RELATIVE_TO_GROUND
        }
      } : {
        id: `log-route:${route.id}:center:${segmentIndex}`,
        polyline: {
          positions: Cartesian3.fromDegreesArray(flatten(segmentCoordinates)),
              width: selected ? 7 : route.role === "ALTERNATE" ? 4 : 5,
          material: new PolylineOutlineMaterialProperty({ color, outlineColor: Color.WHITE.withAlpha(0.75), outlineWidth: selected ? 2 : 1 }),
          clampToGround: true
        }
      })
      if (labelsLoadedForTier("TASK_POINT") && selected && props.mode === "3d") {
        const segmentCenter = centroid(segmentCoordinates)
        routeSource!.entities.add({
          id: `log-route:${route.id}:height:${segmentIndex}`,
          position: Cartesian3.fromDegrees(segmentCenter.longitude, segmentCenter.latitude, segmentAltitude + 2),
          label: {
            ...createMapLabelAppearance({
              text: `航段 ${segmentIndex + 1} · ${segmentAltitude.toFixed(0)}m`,
              color: mapInteractionColors.measurement,
              priority: "TASK_POINT",
              truncate: false,
              font: "600 15px Arial, 'Microsoft YaHei', sans-serif",
              showBackground: false,
              outlineWidth: 4,
              offset: new Cartesian2(0, -8)
            }),
            heightReference: HeightReference.RELATIVE_TO_GROUND
          }
        })
      }
    })
    route.waypoints.forEach((waypoint, index) => routeSource!.entities.add({
      id: `log-waypoint:${route.id}:${waypoint.id}`,
      position: Cartesian3.fromDegrees(waypoint.position.longitude, waypoint.position.latitude, props.mode === "3d" ? waypoint.altitudeMeters : 1),
      point: {
        pixelSize: waypoint.id === props.selectedWaypointId ? 13 : waypoint.locked ? 9 : 8,
        color: waypoint.id === props.selectedWaypointId ? mapColor(mapInteractionColors.selectedSoft) : waypoint.locked ? mapColor(mapInteractionColors.lockedWaypoint) : color,
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        heightReference: props.mode === "2d" ? HeightReference.CLAMP_TO_GROUND : HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      ...(labelsLoadedForTier("TASK_POINT") && selected && (!compactLabels || !waypoint.locked) ? { label: createMapLabelAppearance({
        text: `${index + 1} · ${waypoint.altitudeMeters.toFixed(0)}m`,
        color: mapInteractionColors.measurement,
        priority: "TASK_POINT",
        truncate: false,
        font: "600 15px Arial, 'Microsoft YaHei', sans-serif",
        showBackground: false,
        outlineWidth: 4,
        offset: new Cartesian2(0, -14)
      }) } : {})
    }))
    if (props.mode === "3d") renderRouteVerticalTransitions(route, color, selected)
  }
  viewer?.scene.requestRender()
}

function renderRouteVerticalTransitions(route: LogisticsRouteInput, color: Color, selected: boolean) {
  if (!routeSource) return
  route.waypoints.forEach((waypoint, index) => {
    const adjacentHeights = [
      waypoint.altitudeMeters,
      ...(index > 0 ? [route.waypoints[index - 1]!.segmentAltitudeMeters] : []),
      ...(index < route.waypoints.length - 1 ? [waypoint.segmentAltitudeMeters] : [])
    ]
    const minimum = Math.min(...adjacentHeights)
    const maximum = Math.max(...adjacentHeights)
    if (maximum - minimum < 0.5) return
    routeSource!.entities.add({
      id: `log-route:${route.id}:transition:${index}`,
      position: Cartesian3.fromDegrees(waypoint.position.longitude, waypoint.position.latitude, (minimum + maximum) / 2),
      cylinder: {
        length: maximum - minimum,
        topRadius: selected ? 1.1 : 0.7,
        bottomRadius: selected ? 1.1 : 0.7,
        material: color.withAlpha(selected ? 0.9 : 0.65),
        heightReference: HeightReference.RELATIVE_TO_GROUND
      }
    })
  })
}

function environmentFeatureLabel(
  name: string,
  kind: ReturnType<typeof logisticsSpatialFeatureKind>,
  heightMeters: number | null
) {
  const obstacle = kind === "OBSTACLE"
  return {
    ...createMapLabelAppearance({
      text: `${obstacle ? "障碍" : "建筑"} · ${name}\n${heightMeters === null ? "高度未提供" : `${heightMeters.toFixed(0)} m`}`,
      color: obstacle ? mapObstacleColors.label : mapPoiColors.teachingBuilding,
      priority: obstacle ? "RESTRICTION" : "BUILDING",
      truncate: false,
      font: "600 15px Arial, 'Microsoft YaHei', sans-serif",
      showBackground: false,
      outlineWidth: 5
    }),
    heightReference: HeightReference.RELATIVE_TO_GROUND
  }
}

function numericFeatureProperty(value: string | number | boolean | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
}

function renderTools() {
  if (!toolSource) return
  toolSource.entities.removeAll()
  for (const annotation of props.annotations ?? []) {
    const selected = annotation.id === props.selectedAnnotationId
    toolSource.entities.add({
      id: `log-annotation:${annotation.id}`,
      position: Cartesian3.fromDegrees(annotation.position.longitude, annotation.position.latitude, Math.max(annotation.heightMeters ?? 3, 3)),
      point: {
        pixelSize: selected ? 13 : 10,
        color: selected ? mapColor(mapInteractionColors.annotationInk) : Color.WHITE,
        outlineColor: mapColor(mapInteractionColors.annotationInk),
        outlineWidth: 3,
        heightReference: HeightReference.RELATIVE_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: {
        text: annotation.label,
        font: "12px system-ui",
        fillColor: mapColor(mapInteractionColors.annotationInk),
        outlineColor: Color.WHITE,
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(12, 0),
        horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    })
  }
  if (props.measurement) renderMeasurement(props.measurement)
  if (props.toolMode === "MEASURE" && measurePoints.length > 0) {
    const preview = cursorPoint ? [measurePoints[0]!, cursorPoint] : measurePoints
    toolSource.entities.add({
      id: "log-measure:preview",
      polyline: { positions: Cartesian3.fromDegreesArray(flatten(preview)), width: 3, material: mapColor(mapInteractionColors.measurement), clampToGround: true }
    })
  }
  viewer?.scene.requestRender()
}

function renderMeasurement(measurement: ShowAreaDistanceMeasurement) {
  if (!toolSource) return
  toolSource.entities.add({
    id: "log-measure:result",
    polyline: { positions: Cartesian3.fromDegreesArray(flatten([measurement.start, measurement.end])), width: 3, material: mapColor(mapInteractionColors.measurement), clampToGround: true },
    position: Cartesian3.fromDegrees((measurement.start.longitude + measurement.end.longitude) / 2, (measurement.start.latitude + measurement.end.latitude) / 2, 6),
    label: {
      text: `${formatDistance(measurement.distanceMeters)} / ${measurement.bearingDegrees.toFixed(1)}°`,
      font: "12px system-ui",
      fillColor: mapColor(mapInteractionColors.measurement),
      outlineColor: Color.WHITE,
      outlineWidth: 4,
      style: LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cartesian2(0, -10),
      verticalOrigin: VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  })
}

function resetToolInteraction() {
  measurePoints = []
  cursorPoint = null
  renderTools()
}

function nodeLabel(node: V3LogisticsNode, color: Color) {
  return {
    ...createMapLabelAppearance({
      text: compactLabels ? compactNodeName(node) : node.name,
      color: color.darken(0.25, new Color()),
      priority: "TASK_POINT",
      truncate: false,
      font: "600 15px Arial, 'Microsoft YaHei', sans-serif",
      showBackground: false,
      outlineWidth: 5,
      offset: new Cartesian2(0, 8)
    }),
    horizontalOrigin: HorizontalOrigin.CENTER,
    verticalOrigin: VerticalOrigin.TOP
  }
}

function routeReferencedNodeIds(): Set<string> {
  const ids = new Set<string>()
  for (const route of props.routes) {
    ids.add(route.departureNodeId)
    ids.add(route.arrivalNodeId)
    route.waitingNodeIds.forEach((id) => ids.add(id))
    route.alternateLandingNodeIds.forEach((id) => ids.add(id))
    route.emergencyAreaNodeIds.forEach((id) => ids.add(id))
  }
  return ids
}

function compactNodeName(node: V3LogisticsNode): string {
  if (node.type === "DELIVERY_POINT") return node.name.replace("候选配送点", "配送")
  if (node.type === "WAITING_POINT") return node.name.replace("候选等待点", "等待")
  if (node.type === "ALTERNATE_LANDING_POINT") return node.name.replace("候选备降点", "备降")
  if (node.type === "EMERGENCY_AREA") return node.name.replace("应急运行区域", "应急")
  if (node.type === "TAKEOFF_POINT") return "起飞"
  if (node.type === "LANDING_POINT") return "降落"
  if (node.type === "CENTER_AIRPORT") return "机场"
  return node.name
}

function nodeColor(node: V3LogisticsNode, selected: boolean): Color {
  if (node.type === "DELIVERY_POINT") return mapColor(selected ? mapPoiColors.deliveryNodeSelected : mapPoiColors.deliveryNodeInactive)
  if (node.type === "WAITING_POINT") return mapColor(mapPoiColors.waitingPoint)
  if (node.type === "ALTERNATE_LANDING_POINT") return mapColor(mapPoiColors.alternateLanding)
  if (node.type === "EMERGENCY_AREA") return mapColor(mapPoiColors.emergencyArea)
  if (node.type === "TAKEOFF_POINT") return mapColor(mapPoiColors.takeoffPoint)
  if (node.type === "LANDING_POINT") return mapColor(mapPoiColors.landingPoint)
  return mapColor(mapPoiColors.nodeDefault)
}

function pickCoordinate(position: Cartesian2): V3Coordinate | null {
  const coordinate = pickMeasuredPoint(position)
  return coordinate ? { longitude: coordinate.longitude, latitude: coordinate.latitude } : null
}

function pickMeasuredPoint(position: Cartesian2): ShowAreaMeasuredPoint | null {
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
  return isCoordinateInsideRegion(props.region, coordinate) ? coordinate : null
}

function setMode(mode: "2d" | "3d", refocus = true) {
  if (!viewer) return
  const targetMode = mode === "2d" ? SceneMode.SCENE2D : SceneMode.SCENE3D
  const cameraSnapshot = !refocus && viewer.scene.mode !== targetMode ? captureV3Camera(viewer) : null
  const applyCamera = () => { if (cameraSnapshot) restoreV3Camera(viewer!, cameraSnapshot, mode) }
  if (viewer.scene.mode === targetMode) {
    if (refocus) focusCurrentSelection(0.35, mode)
    else applyCamera()
    renderRoutes()
    return
  }
  removeMorphCompleteListener?.()
  removeMorphCompleteListener = null
  if (viewer.scene.mode === SceneMode.MORPHING) viewer.scene.completeMorph()
  removeMorphCompleteListener = viewer.scene.morphComplete.addEventListener(() => {
    removeMorphCompleteListener = null
    if (refocus) focusCurrentSelection(0.35, mode)
    renderLayers()
    renderRoutes()
    applyCamera()
  })
  if (mode === "2d") viewer.scene.morphTo2D(0.3)
  else viewer.scene.morphTo3D(0.3)
}

function focusCurrentSelection(duration: number, mode: "2d" | "3d" = props.mode) {
  if (!viewer) return
  const selectedCoordinates = logisticsFocusCoordinates(props.routes, props.selectedRouteId, props.selectedWaypointId)
  if (selectedCoordinates.length > 0) focusV3Coordinates(viewer, selectedCoordinates, mode, duration)
  else focusV3Region(viewer, props.region, mode, duration)
}

function focusMapRegion() {
  if (viewer) focusV3Region(viewer, props.region, props.mode, 0.35)
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

function centroid(points: readonly V3Coordinate[]): V3Coordinate {
  return points.reduce((result, point) => ({ longitude: result.longitude + point.longitude / points.length, latitude: result.latitude + point.latitude / points.length }), { longitude: 0, latitude: 0 })
}

function flatten(points: readonly V3Coordinate[]): number[] {
  return points.flatMap((point) => [point.longitude, point.latitude])
}

function flattenClosed(points: readonly V3Coordinate[]): number[] {
  return points[0] ? flatten([...points, points[0]]) : []
}

function formatDistance(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)} km` : `${value.toFixed(1)} m`
}

</script>

<template>
  <div class="v3-logistics-route-map-shell">
    <div ref="container" class="v3-logistics-route-map" />
    <V3MapResourceNotice :available="Boolean(region)" :imagery-state="imageryState" @retry="reloadMapResources" />
    <V3MapTerrainNotice :state="terrainState" :region="region" @retry="reloadMapResources" />
    <V3MapViewControls :mode="mode" @home="focusMapRegion" @zoom-in="zoomMapIn" @zoom-out="zoomMapOut" @rotate-left="rotateMapLeft" @rotate-right="rotateMapRight" @reset-north="resetMapNorth" @top-down="setTopDownView" @flight-view="setFlightView" />
    <V3MapScaleBar :viewer="scaleViewer" :terrain-state="terrainState" />
  </div>
</template>

<style scoped>
.v3-logistics-route-map-shell {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;
  background: #dce3de;
}

.v3-logistics-route-map {
  width: 100%;
  height: 100%;
}
</style>
