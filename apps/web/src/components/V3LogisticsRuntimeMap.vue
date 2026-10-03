<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorBlendMode,
  ConstantPositionProperty,
  ConstantProperty,
  CustomDataSource,
  DistanceDisplayCondition,
  Entity,
  HeadingPitchRoll,
  HeightReference,
  LabelStyle,
  NearFarScalar,
  PolygonHierarchy,
  PolylineOutlineMaterialProperty,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  VerticalOrigin,
  Viewer
} from "cesium"
import { Aim } from "@element-plus/icons-vue"
import type {
  LogisticsRuntimeAircraftView,
  LogisticsRuntimeEventView,
  LogisticsRuntimeRouteView,
  V3Coordinate,
  V3RegionCatalogItem
} from "@wurenji/shared"
import { configureV3CesiumPerformance } from "../cesium-performance"
import { createUnifiedCesiumViewer } from "../cesium-map-adapter"
import { createMapLabelAppearance, MAP_LABEL_FONT_SMALL } from "../map-label-policy"
import {
  logisticsRuntimeAircraftStatusColors,
  logisticsRuntimeRouteStatusColors,
  mapBasemapColors,
  mapColor,
  mapColorAlpha,
  mapInteractionColors,
  mapPoiColors,
  mapRegionColors,
  mapRuntimeEventColors
} from "../map-visual-theme"
import { logisticsRuntimeFocusCoordinates } from "../logistics-map-tools"
import { appendLogisticsAircraftTrail, isLogisticsAircraftAirborne, logisticsAircraftHeadingRadians } from "../logistics-runtime-aircraft-visual"
import { clusterRuntimeAircraft, nextRuntimeAircraftEntityId, orderRuntimeAircraftEntityIds, preferredRuntimeMapEntityId } from "../runtime-map-picking"
import { createV3MapDataStateTracker, type V3MapDataState, type V3MapDataStateTracker, type V3MapImageryState } from "../map-loading-state"
import { regionMapResourceKey } from "../map-resources"
import { loadV3MapResources } from "../map-resources-loader"
import type { RegionTerrainState } from "../terrain"
import { captureV3Camera, configureRegionMapConstraints, focusV3Coordinates, focusV3Region, regionMaskHierarchy, restoreV3Camera, v3CameraDiagnostics, type V3CameraDiagnostics } from "../map-region-constraints"
import { renderRegionStaticFeatures } from "../map-static-features"
import { buildingHeightMeters, resolveBuildingDataUrl } from "../map-building-layer"
import { resetV3CameraNorth, rotateV3Camera, setV3CameraPreset, zoomV3Camera } from "../map-region-constraints"
import V3MapViewControls from "./V3MapViewControls.vue"
import V3MapScaleBar from "./V3MapScaleBar.vue"
import V3MapResourceNotice from "./V3MapResourceNotice.vue"
import V3MapTerrainNotice from "./V3MapTerrainNotice.vue"

const props = withDefaults(defineProps<{
  region: V3RegionCatalogItem | null
  routes: readonly LogisticsRuntimeRouteView[]
  aircraft: readonly LogisticsRuntimeAircraftView[]
  events: readonly LogisticsRuntimeEventView[]
  selectedAircraftId: string
  selectedRouteId: string
  selectedEventId: string
  mode: "2d" | "3d"
  playbackTimeMs?: number
  replay?: boolean
}>(), {
  playbackTimeMs: 0,
  replay: false
})

const emit = defineEmits<{
  aircraftSelect: [aircraftId: string]
  routeSelect: [routeId: string]
  eventSelect: [eventId: string]
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
let removeCameraConstraints: (() => void) | null = null
let removePostRenderListener: (() => void) | null = null
let mapResourceGeneration = 0
let offlineBuildingGeneration = 0
let handler: ScreenSpaceEventHandler | null = null
let staticSource: CustomDataSource | null = null
let routeSource: CustomDataSource | null = null
let aircraftSource: CustomDataSource | null = null
let eventSource: CustomDataSource | null = null
let offlineBuildingsSource: import("cesium").GeoJsonDataSource | null = null
const offlineBuildingHeights = new Map<string, number>()
let runtimeRenderFrame: number | null = null
let routeRenderKey = ""
const staticFeatureSummary = ref({ mode: "2d" as "2d" | "3d", featureIds: "", buildingExtrusions: 0, obstacleCylinders: 0 })
const cameraDiagnostics = ref<V3CameraDiagnostics | null>(null)
const followSelectedAircraft = ref(false)
let previousFollowCoordinate: V3Coordinate | null = null
const aircraftVisualCount = ref(0)
const aircraftTrailCount = ref(0)
const aircraftModelCount = ref(0)
const aircraftBillboardCount = ref(0)
let removeMorphCompleteListener: (() => void) | null = null
let removeCameraMoveEndListener: (() => void) | null = null
let cameraDiagnosticsTimer: number | null = null
let lastAircraftPickPointsAt = 0
const aircraftAppearanceKeys = new Map<string, string>()
const aircraftTrailHistory = new Map<string, V3Coordinate[]>()
const aircraftBillboardCache = new Map<string, string>()
const routeAppearanceKeys = new Map<string, string>()
const eventAppearanceKeys = new Map<string, string>()
const runtimeEventCriticalColor = mapColor(mapRuntimeEventColors.critical)
const runtimeEventWarningColor = mapColor(mapRuntimeEventColors.warning)
const runtimeEventCriticalPointColor = mapColorAlpha(mapRuntimeEventColors.critical, mapRuntimeEventColors.pointOverlayAlpha)
const runtimeEventWarningPointColor = mapColorAlpha(mapRuntimeEventColors.warning, mapRuntimeEventColors.pointOverlayAlpha)
const runtimeClusterPointColor = mapColorAlpha(mapRuntimeEventColors.clusterFill, mapRuntimeEventColors.clusterFillAlpha)
const runtimeClusterOutlineColor = mapColor(mapRuntimeEventColors.clusterOutline)
const runtimeClusterLabelColor = mapColor(mapRuntimeEventColors.clusterLabel)

defineExpose({ scaleViewer, get aircraftSource() { return aircraftSource } })

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

const aircraftColors = Object.fromEntries(
  Object.entries(logisticsRuntimeAircraftStatusColors).map(([status, css]) => [status, mapColor(css)])
) as Record<LogisticsRuntimeAircraftView["status"], Color>

const aircraftStatusLabels: Record<LogisticsRuntimeAircraftView["status"], string> = {
  STANDBY: "待用",
  AVAILABLE: "可用",
  ASSIGNED: "已派遣",
  TAKING_OFF: "起飞",
  OUTBOUND: "去程",
  ARRIVED: "到达",
  RETURNING: "返程",
  LANDING: "降落",
  HOLDING: "悬停",
  DIVERTING: "备降",
  EMERGENCY_LANDING: "迫降",
  DISABLED: "不可用"
}

onMounted(async () => {
  if (!container.value) return
  viewer = createUnifiedCesiumViewer(container.value, { antialias: true, highResolution: true })
  scaleViewer.value = viewer
  viewerReady.value = true
  removeCameraConstraints = configureRegionMapConstraints(viewer, props.region)
  removePerformanceTuning = configureV3CesiumPerformance(viewer, "RUNTIME")
  viewer.scene.globe.baseColor = mapColor(mapBasemapColors.emptyCanvas)
  viewer.scene.globe.depthTestAgainstTerrain = true
  mapDataTracker = createV3MapDataStateTracker((state) => {
    imageryState.value = state.imagery
    terrainState.value = state.terrain
    emit("dataState", state)
  })
  removeTileLoadProgressListener = viewer.scene.globe.tileLoadProgressEvent.addEventListener((pendingTiles: number) => mapDataTracker?.setPendingTiles(pendingTiles))
  removeCameraMoveEndListener = viewer.camera.moveEnd.addEventListener(updateCameraDiagnostics)
  removePostRenderListener = viewer.scene.postRender.addEventListener(updateAircraftPickPoints)
  void reloadMapResources()
  staticSource = await viewer.dataSources.add(new CustomDataSource("logistics-runtime-static"))
  routeSource = await viewer.dataSources.add(new CustomDataSource("logistics-runtime-routes"))
  aircraftSource = await viewer.dataSources.add(new CustomDataSource("logistics-runtime-aircraft"))
  eventSource = await viewer.dataSources.add(new CustomDataSource("logistics-runtime-events"))
  void loadOfflineLogisticsResources()
  handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
  handler.setInputAction((movement: { position: Cartesian2 }) => handleClick(movement.position), ScreenSpaceEventType.LEFT_CLICK)
  renderStatic()
  renderRoutes()
  renderAircraft()
  renderEvents()
  setMode(props.mode)
  updateCameraDiagnostics()
  mapDataTracker.markInitialized()
})

onBeforeUnmount(() => {
  if (runtimeRenderFrame !== null) window.cancelAnimationFrame(runtimeRenderFrame)
  runtimeRenderFrame = null
  viewerReady.value = false
  mapResourceGeneration += 1
  offlineBuildingGeneration += 1
  removePerformanceTuning?.()
  removePerformanceTuning = null
  removeCameraConstraints?.()
  removeCameraConstraints = null
  removeTileLoadProgressListener?.()
  removeTileLoadProgressListener = null
  removePostRenderListener?.()
  removePostRenderListener = null
  activeResourceCleanup?.()
  activeResourceCleanup = null
  removeMorphCompleteListener?.()
  removeCameraMoveEndListener?.()
  removeCameraMoveEndListener = null
  if (cameraDiagnosticsTimer !== null) window.clearTimeout(cameraDiagnosticsTimer)
  cameraDiagnosticsTimer = null
  handler?.destroy()
  if (offlineBuildingsSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(offlineBuildingsSource, true)
  offlineBuildingsSource = null
  offlineBuildingHeights.clear()
  viewer?.destroy()
  scaleViewer.value = null
  handler = null
  viewer = null
  mapDataTracker = null
  staticSource = null
  routeSource = null
  aircraftSource = null
  eventSource = null
  routeRenderKey = ""
  lastAircraftPickPointsAt = 0
  aircraftAppearanceKeys.clear()
  aircraftTrailHistory.clear()
  aircraftBillboardCache.clear()
  routeAppearanceKeys.clear()
  eventAppearanceKeys.clear()
})

async function loadOfflineLogisticsResources() {
  const generation = ++offlineBuildingGeneration
  if (offlineBuildingsSource && viewer && !viewer.isDestroyed()) viewer.dataSources.remove(offlineBuildingsSource, true)
  offlineBuildingsSource = null
  offlineBuildingHeights.clear()
  if (!viewer || viewer.isDestroyed()) return
  const { GeoJsonDataSource, HeightReference, JulianDate, Color, ColorMaterialProperty, ConstantProperty } = await import("cesium")
  if (!viewer || viewer.isDestroyed() || generation !== offlineBuildingGeneration) return
  const buildingsUrl = resolveBuildingDataUrl(
    props.region,
    (import.meta.env.VITE_LOGISTICS_BUILDINGS_URL as string | undefined) ?? ""
  )
  if (!buildingsUrl) return
  try {
    const source = await GeoJsonDataSource.load(buildingsUrl, { clampToGround: false })
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
      entity.polygon.height = new ConstantProperty(0)
      entity.polygon.heightReference = new ConstantProperty(HeightReference.RELATIVE_TO_GROUND)
      entity.polygon.extrudedHeight = new ConstantProperty(props.mode === "3d" ? heightMeters : 0)
      entity.polygon.extrudedHeightReference = new ConstantProperty(HeightReference.RELATIVE_TO_GROUND)
      entity.polygon.material = new ColorMaterialProperty(Color.WHITE.withAlpha(0.58))
      entity.polygon.outline = new ConstantProperty(true)
      entity.polygon.outlineColor = new ConstantProperty(Color.WHITE.withAlpha(0.9))
    }
    offlineBuildingsSource = source
    viewer.dataSources.add(source)
    syncOfflineBuildingMode()
  } catch {
    if (generation === offlineBuildingGeneration) offlineBuildingsSource = null
  }
}

function syncOfflineBuildingMode() {
  for (const entity of offlineBuildingsSource?.entities.values ?? []) {
    const heightMeters = offlineBuildingHeights.get(String(entity.id))
    if (heightMeters !== undefined && entity.polygon) {
      entity.polygon.extrudedHeight = new ConstantProperty(props.mode === "3d" ? heightMeters : 0)
    }
  }
}

watch(() => regionMapResourceKey(props.region), () => {
  removeCameraConstraints?.()
  removeCameraConstraints = viewer ? configureRegionMapConstraints(viewer, props.region) : null
  renderStatic()
  void loadOfflineLogisticsResources()
})
watch(() => regionMapResourceKey(props.region), () => { void reloadMapResources() })
watch(() => [logisticsRouteRenderSignature(props.routes), props.selectedRouteId], scheduleRuntimeEntitiesRender)
watch(() => [logisticsAircraftRenderSignature(props.aircraft), props.selectedAircraftId], scheduleRuntimeEntitiesRender)
watch(() => [
  logisticsEventRenderSignature(props.events),
  logisticsAircraftRenderSignature(props.aircraft),
  logisticsRouteRenderSignature(props.routes),
  props.selectedEventId,
  props.playbackTimeMs,
  props.replay
], scheduleRuntimeEntitiesRender)
watch(() => props.mode, (mode) => { setMode(mode, false); renderStatic(false); syncOfflineBuildingMode() })
watch(() => props.playbackTimeMs, (time, previous) => {
  if (props.replay && time < previous) {
    aircraftTrailHistory.clear()
    scheduleRuntimeEntitiesRender()
  }
})
watch(() => props.selectedAircraftId, (aircraftId) => {
  previousFollowCoordinate = null
  if (!aircraftId) followSelectedAircraft.value = false
  else if (followSelectedAircraft.value) scheduleRuntimeEntitiesRender()
})

function scheduleRuntimeEntitiesRender() {
  if (runtimeRenderFrame !== null) return
  runtimeRenderFrame = window.requestAnimationFrame(() => {
    runtimeRenderFrame = null
    renderRoutes()
    renderAircraft()
    renderEvents()
  })
}

function handleShellClick(event: MouseEvent) {
  if (!viewer || !container.value || event.target === viewer.scene.canvas) return
  const target = event.target
  if (target instanceof Element && target.closest(".v3-map-view-controls, .v3-map-resource-notice, .v3-map-scale-bar, .aircraft-follow-toggle, .cesium-viewer-bottom")) return
  const rect = container.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientY < rect.top || event.clientX > rect.right || event.clientY > rect.bottom) return
  handleClick(new Cartesian2(event.clientX - rect.left, event.clientY - rect.top))
}

function handleClick(position: Cartesian2) {
  if (!viewer) return
  const picked = viewer.scene.drillPick(position, 16) as Array<{ id?: Entity }>
  const pickedIds = picked
    .map((item) => item.id?.id)
    .filter((item): item is string => typeof item === "string")
  const pickedAircraftIds = pickedIds.filter((item) => item.startsWith("runtime-aircraft:"))
  const uniquePickedAircraftIds = [...new Set(pickedAircraftIds)]
  if (aircraftSource) {
    const currentTime = viewer.clock.currentTime
    const hitRadius = 18
    const nearbyAircraftIds = aircraftSource.entities.values.filter((entity) => entity.id.startsWith("runtime-aircraft:")).flatMap((entity) => {
      const entityPosition = entity.position?.getValue(currentTime)
      const canvasPosition = entityPosition ? viewer!.scene.cartesianToCanvasCoordinates(entityPosition) : undefined
      if (!canvasPosition) return []
      const distance = Math.hypot(canvasPosition.x - position.x, canvasPosition.y - position.y)
      return distance <= hitRadius ? [entity.id] : []
    })
    const candidateAircraftIds = orderRuntimeAircraftEntityIds(
      [...new Set([...uniquePickedAircraftIds, ...nearbyAircraftIds])],
      props.aircraft.map((aircraft) => aircraft.id)
    )
    const id = candidateAircraftIds.length === 1
      ? candidateAircraftIds[0]
      : nextRuntimeAircraftEntityId(candidateAircraftIds, props.selectedAircraftId)
    if (id) {
      emit("aircraftSelect", id.slice("runtime-aircraft:".length))
      return
    }
  }
  const id = preferredRuntimeMapEntityId(pickedIds)
  if (id.startsWith("runtime-aircraft:")) emit("aircraftSelect", id.slice("runtime-aircraft:".length))
  else if (id.startsWith("runtime-route:")) emit("routeSelect", id.slice("runtime-route:".length))
  else if (id.startsWith("runtime-event:")) emit("eventSelect", id.slice("runtime-event:".length))
}

function renderStatic(focus = true) {
  if (!viewer || !staticSource) return
  staticSource.entities.removeAll()
  if (props.region?.boundary.length) {
    const maskHierarchy = regionMaskHierarchy(props.region)
    if (maskHierarchy) {
      staticSource.entities.add({
        id: `runtime-region-mask:${props.region.regionCode}`,
        polygon: {
          hierarchy: maskHierarchy,
          material: mapColorAlpha(mapRegionColors.mask, mapRegionColors.maskAlpha),
          height: 0,
          heightReference: HeightReference.CLAMP_TO_GROUND
        }
      })
    }
    staticSource.entities.add({
      id: `runtime-region:${props.region.regionCode}`,
      polygon: {
        hierarchy: new PolygonHierarchy(Cartesian3.fromDegreesArray(flatten(props.region.boundary))),
        material: mapColorAlpha(mapRegionColors.boundary, mapRegionColors.boundaryFillAlpha),
        height: 0,
        heightReference: HeightReference.CLAMP_TO_GROUND
      },
      polyline: {
        positions: Cartesian3.fromDegreesArray(flattenClosed(props.region.boundary)),
        width: 2,
        material: mapColor(mapRegionColors.boundary),
        clampToGround: true
      }
    })
  }
  for (const node of props.region?.logisticsNodes ?? []) {
    if (!node.enabled || !node.position || !["CENTER_AIRPORT", "DELIVERY_POINT", "WAITING_POINT", "ALTERNATE_LANDING_POINT"].includes(node.type)) continue
    const color = node.type === "DELIVERY_POINT" ? mapColor(mapPoiColors.deliveryNode)
      : node.type === "WAITING_POINT" ? mapColor(mapPoiColors.waitingPoint)
        : node.type === "ALTERNATE_LANDING_POINT" ? mapColor(mapPoiColors.alternateLanding)
          : mapColor(mapPoiColors.centerAirport)
    staticSource.entities.add({
      id: `runtime-node:${node.id}`,
      position: Cartesian3.fromDegrees(node.position.longitude, node.position.latitude, 2),
      point: { pixelSize: node.type === "CENTER_AIRPORT" ? 10 : 6, color, outlineColor: Color.WHITE, outlineWidth: 2, heightReference: HeightReference.RELATIVE_TO_GROUND, disableDepthTestDistance: Number.POSITIVE_INFINITY }
    })
  }
  renderRegionStaticFeatures(staticSource, props.region, props.mode, "logistics-runtime-static")
  updateStaticFeatureSummary()
  if (focus && viewer) focusV3Region(viewer, props.region, props.mode, 0.3)
  viewer.scene.requestRender()
}

function updateStaticFeatureSummary() {
  if (!staticSource) return
  const prefix = "logistics-runtime-static:layer:"
  const entities = staticSource.entities.values.filter((entity) => typeof entity.id === "string" && entity.id.startsWith(prefix))
  staticFeatureSummary.value = {
    mode: props.mode,
    featureIds: entities.map((entity) => entity.id).join(","),
    buildingExtrusions: entities.filter((entity) => entity.id.includes(":BUILDINGS:") && Boolean(entity.polygon?.extrudedHeight)).length,
    obstacleCylinders: entities.filter((entity) => entity.id.includes(":BUILDINGS:") && Boolean(entity.cylinder)).length
  }
}

function renderRoutes() {
  if (!viewer || !routeSource) return
  const renderKey = `${logisticsRouteRenderSignature(props.routes)}:${props.selectedRouteId}:${props.mode}`
  if (renderKey === routeRenderKey) return
  routeRenderKey = renderKey
  const entities = routeSource.entities
  entities.suspendEvents()
  try {
    const activeIds = new Set<string>()
    for (const route of props.routes) {
      const entityId = `runtime-route:${route.id}`
      activeIds.add(entityId)
      const selected = route.id === props.selectedRouteId
      const color = routeColor(route.status)
      const positions = route.waypoints.map((waypoint) => Cartesian3.fromDegrees(waypoint.position.longitude, waypoint.position.latitude, props.mode === "3d" ? waypoint.altitudeMeters : 0))
      const appearanceKey = `${route.status}:${route.activeTaskCount}:${selected}:${props.mode}`
      const entity = entities.getById(entityId)
      if (entity?.polyline) {
        entity.name = route.name
        entity.polyline.positions = new ConstantProperty(positions)
        if (routeAppearanceKeys.get(entityId) !== appearanceKey) {
          entity.polyline.width = new ConstantProperty(selected ? 6 : route.activeTaskCount > 0 ? 4.5 : 2.5)
          entity.polyline.material = new PolylineOutlineMaterialProperty({ color, outlineColor: Color.WHITE.withAlpha(selected ? 0.9 : 0.5), outlineWidth: selected ? 2 : 1 })
          entity.polyline.clampToGround = new ConstantProperty(props.mode === "2d")
          routeAppearanceKeys.set(entityId, appearanceKey)
        }
      } else {
        entities.add({
          id: entityId,
          name: route.name,
          polyline: {
            positions,
            width: selected ? 6 : route.activeTaskCount > 0 ? 4.5 : 2.5,
            material: new PolylineOutlineMaterialProperty({ color, outlineColor: Color.WHITE.withAlpha(selected ? 0.9 : 0.5), outlineWidth: selected ? 2 : 1 }),
            clampToGround: props.mode === "2d"
          }
        })
        routeAppearanceKeys.set(entityId, appearanceKey)
      }
    }
    for (const entity of [...entities.values]) {
      if (!activeIds.has(entity.id)) {
        entities.remove(entity)
        routeAppearanceKeys.delete(entity.id)
      }
    }
  } finally {
    entities.resumeEvents()
  }
  viewer.scene.requestRender()
}

function renderAircraft() {
  if (!viewer || !aircraftSource) return
  const entities = aircraftSource.entities
  entities.suspendEvents()
  try {
  const activeIds = new Set<string>()
  const activeAircraftIds = new Set<string>()
  let visualCount = 0
  let trailCount = 0
  for (const aircraft of props.aircraft) {
    if (!validCoordinate(aircraft.position)) continue
    activeAircraftIds.add(aircraft.id)
    const entityId = `runtime-aircraft:${aircraft.id}`
    activeIds.add(entityId)
    const selected = aircraft.id === props.selectedAircraftId
    const color = aircraftColors[aircraft.status]
    const abnormal = ["HOLDING", "DIVERTING", "EMERGENCY_LANDING", "DISABLED"].includes(aircraft.status)
    const airborne = isLogisticsAircraftAirborne(aircraft.status)
    const altitudeMeters = Math.max(0, aircraft.position.altitudeMeters ?? 0)
    const groundHeight = viewer.scene.globe.getHeight(Cartographic.fromDegrees(aircraft.position.longitude, aircraft.position.latitude)) ?? 0
    const displayAltitudeMeters = props.mode === "3d" ? groundHeight + Math.max(airborne ? 2 : 1, altitudeMeters) : 1
    const position = Cartesian3.fromDegrees(aircraft.position.longitude, aircraft.position.latitude, displayAltitudeMeters)
    const heading = logisticsAircraftHeadingRadians(aircraft, props.routes)
    const orientation = Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(heading, 0, 0))
    const appearanceKey = `${aircraft.status}:${selected}:${abnormal}:${airborne}:${props.mode}`
    let entity = aircraftSource.entities.getById(entityId)
    if (!entity || aircraftAppearanceKeys.get(entityId) !== appearanceKey) {
      if (entity) aircraftSource.entities.remove(entity)
      entity = aircraftSource.entities.add({
        id: entityId,
        name: aircraft.code,
        position,
        orientation,
        point: {
          pixelSize: selected ? 13 : abnormal ? 11 : 7,
          color: color.withAlpha(props.mode === "3d" ? 0.48 : 0.28),
          outlineColor: selected ? mapColor(mapInteractionColors.selectedOutline) : Color.WHITE,
          outlineWidth: selected ? 3 : 1,
          heightReference: props.mode === "2d" ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        ...(props.mode === "3d" ? {
          model: {
            uri: "/models/logistics-drone.gltf",
            scale: 2.4,
            minimumPixelSize: selected ? 48 : 34,
            maximumScale: 28,
            color,
            colorBlendMode: ColorBlendMode.MIX,
            colorBlendAmount: 0.28,
            silhouetteColor: selected ? mapColor(mapInteractionColors.selectedOutline) : color,
            silhouetteSize: selected ? 3 : abnormal ? 2 : 0.5,
            heightReference: HeightReference.NONE,
            distanceDisplayCondition: new DistanceDisplayCondition(0, 100_000)
          }
        } : {}),
          billboard: {
            image: aircraftBillboardImage(logisticsRuntimeAircraftStatusColors[aircraft.status], selected, abnormal),
            width: selected ? 48 : 38,
            height: selected ? 48 : 38,
            rotation: -heading,
            verticalOrigin: VerticalOrigin.CENTER,
            heightReference: props.mode === "2d" ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE,
            pixelOffset: props.mode === "3d" ? new Cartesian2(0, -16) : Cartesian2.ZERO,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new NearFarScalar(100, 1.15, 12_000, 0.8),
            distanceDisplayCondition: new DistanceDisplayCondition(0, 100_000)
          },
        ...(selected || abnormal || airborne ? { label: createMapLabelAppearance({
          text: aircraftLabelText(aircraft, altitudeMeters),
          color,
          priority: "TASK_POINT",
          truncate: false,
          font: MAP_LABEL_FONT_SMALL,
          outlineWidth: 4,
          offset: new Cartesian2(0, props.mode === "3d" ? -32 : -26)
        }) } : {})
      })
      aircraftAppearanceKeys.set(entityId, appearanceKey)
    } else {
      if (entity.position instanceof ConstantPositionProperty) entity.position.setValue(position)
      else entity.position = new ConstantPositionProperty(position)
      if (entity.orientation instanceof ConstantProperty) entity.orientation.setValue(orientation)
      else entity.orientation = new ConstantProperty(orientation)
      if (entity.billboard?.rotation instanceof ConstantProperty) entity.billboard.rotation.setValue(-heading)
      const labelText = aircraftLabelText(aircraft, altitudeMeters)
      if (entity.label?.text instanceof ConstantProperty) entity.label.text.setValue(labelText)
      else if (entity.label) entity.label.text = new ConstantProperty(labelText)
    }
    visualCount += 1

    const previousTrail = aircraftTrailHistory.get(aircraft.id) ?? []
    const nextTrail = appendLogisticsAircraftTrail(previousTrail, aircraft.position)
    if (airborne || previousTrail.length > 0 || selected) aircraftTrailHistory.set(aircraft.id, nextTrail)
    if (nextTrail.length >= 2) {
      const trailId = `runtime-aircraft-trail:${aircraft.id}`
      activeIds.add(trailId)
      const trailPositions = nextTrail.map((point) => Cartesian3.fromDegrees(
        point.longitude,
        point.latitude,
        props.mode === "3d" ? Math.max(1, point.altitudeMeters ?? 0) : 1
      ))
      let trail = aircraftSource.entities.getById(trailId)
      if (!trail?.polyline) {
        if (trail) aircraftSource.entities.remove(trail)
        trail = aircraftSource.entities.add({
          id: trailId,
          name: `${aircraft.code} 已飞轨迹`,
          polyline: {
            positions: trailPositions,
            width: selected ? 6 : 3.5,
            material: new PolylineOutlineMaterialProperty({
              color: color.withAlpha(selected ? 0.96 : 0.78),
              outlineColor: Color.WHITE.withAlpha(selected ? 0.85 : 0.55),
              outlineWidth: selected ? 2 : 1
            }),
            clampToGround: props.mode === "2d"
          }
        })
      } else {
        trail.polyline.positions = new ConstantProperty(trailPositions)
        trail.polyline.width = new ConstantProperty(selected ? 6 : 3.5)
        trail.polyline.clampToGround = new ConstantProperty(props.mode === "2d")
        trail.polyline.material = new PolylineOutlineMaterialProperty({
          color: color.withAlpha(selected ? 0.96 : 0.78),
          outlineColor: Color.WHITE.withAlpha(selected ? 0.85 : 0.55),
          outlineWidth: selected ? 2 : 1
        })
      }
      trailCount += 1
    }
    if (props.mode === "3d" && selected && altitudeMeters > 1) {
      const guideId = `runtime-aircraft-altitude:${aircraft.id}`
      activeIds.add(guideId)
      const ground = Cartesian3.fromDegrees(aircraft.position.longitude, aircraft.position.latitude, 0)
      const air = Cartesian3.fromDegrees(aircraft.position.longitude, aircraft.position.latitude, altitudeMeters)
      const guide = aircraftSource.entities.getById(guideId)
      if (guide?.polyline) {
        guide.polyline.positions = new ConstantProperty([ground, air])
      } else {
        aircraftSource.entities.add({
          id: guideId,
          name: `${aircraft.code} 高度参考`,
          polyline: {
            positions: [ground, air],
            width: 2,
            material: color.withAlpha(0.78),
            depthFailMaterial: color.withAlpha(0.42)
          },
          point: { pixelSize: 5, color, outlineColor: Color.WHITE, outlineWidth: 1, heightReference: HeightReference.NONE }
        })
      }
    }
  }
  for (const cluster of clusterRuntimeAircraft(props.aircraft, props.mode)) {
    if (cluster.aircraftIds.length < 2) continue
    const clusterId = `runtime-aircraft-cluster:${cluster.key}`
    activeIds.add(clusterId)
    const previousCluster = aircraftSource.entities.getById(clusterId)
    const clusterPosition = Cartesian3.fromDegrees(cluster.longitude, cluster.latitude, props.mode === "3d" ? cluster.altitudeMeters : 1)
    if (previousCluster) {
      if (previousCluster.position instanceof ConstantPositionProperty) previousCluster.position.setValue(clusterPosition)
      else previousCluster.position = new ConstantPositionProperty(clusterPosition)
      if (previousCluster.label?.text instanceof ConstantProperty) previousCluster.label.text.setValue(`${cluster.aircraftIds.length} 架`)
    } else {
      aircraftSource.entities.add({
        id: clusterId,
        name: `${cluster.aircraftIds.length} 架无人机重叠`,
        position: clusterPosition,
        point: {
          pixelSize: 20,
          color: runtimeClusterPointColor,
          outlineColor: runtimeClusterOutlineColor,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: `${cluster.aircraftIds.length} 架`,
          font: "bold 11px system-ui",
          fillColor: runtimeClusterLabelColor,
          outlineColor: Color.WHITE,
          outlineWidth: 3,
          style: LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: runtimeClusterPointColor,
          pixelOffset: new Cartesian2(0, -18),
          verticalOrigin: VerticalOrigin.BOTTOM,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    }
  }
  for (const aircraftId of aircraftTrailHistory.keys()) {
    if (!activeAircraftIds.has(aircraftId)) aircraftTrailHistory.delete(aircraftId)
  }
  for (const entity of [...aircraftSource.entities.values]) {
    if (activeIds.has(entity.id)) continue
    aircraftSource.entities.remove(entity)
    aircraftAppearanceKeys.delete(entity.id)
  }
  aircraftVisualCount.value = visualCount
  aircraftTrailCount.value = trailCount
  aircraftModelCount.value = props.mode === "3d" ? visualCount : 0
  aircraftBillboardCount.value = props.mode === "2d" ? visualCount : 0
  } finally {
    entities.resumeEvents()
  }
  viewer.scene.requestRender()
  if (followSelectedAircraft.value) focusSelectedAircraft(0)
}

function aircraftLabelText(aircraft: LogisticsRuntimeAircraftView, altitudeMeters: number): string {
  const status = aircraftStatusLabels[aircraft.status]
  const altitude = props.mode === "3d" ? ` · 高度 ${Math.round(altitudeMeters)}m` : ""
  return `${aircraft.code} · ${status} · 电量 ${Math.round(aircraft.batteryPercent)}%${altitude}`
}

function aircraftBillboardImage(color: string, selected: boolean, abnormal: boolean): string {
  const cacheKey = `${color}:${selected}:${abnormal}`
  const cached = aircraftBillboardCache.get(cacheKey)
  if (cached) return cached
  const outline = selected ? "#f8c44f" : abnormal ? "#ffffff" : "#f7faf8"
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><circle cx="32" cy="32" r="29" fill="#101b18" fill-opacity=".78" stroke="${outline}" stroke-width="${selected ? 4 : 2}"/><g fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"><path d="M19 19l26 26M45 19L19 45"/></g><g fill="#101b18" stroke="${outline}" stroke-width="2"><circle cx="16" cy="16" r="8"/><circle cx="48" cy="16" r="8"/><circle cx="16" cy="48" r="8"/><circle cx="48" cy="48" r="8"/></g><path d="M32 10l6 12H26z" fill="#f8c44f"/><rect x="25" y="25" width="14" height="14" rx="4" fill="${color}" stroke="#ffffff" stroke-width="2"/></svg>`
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  aircraftBillboardCache.set(cacheKey, uri)
  return uri
}

function updateAircraftPickPoints() {
  if (!viewer || !aircraftSource || !container.value) return
  const now = performance.now()
  if (now - lastAircraftPickPointsAt < 100) return
  lastAircraftPickPointsAt = now
  const points = aircraftSource.entities.values.filter((entity) => entity.id.startsWith("runtime-aircraft:")).flatMap((entity) => {
    const position = entity.position?.getValue(viewer!.clock.currentTime)
    const canvasPosition = position ? viewer!.scene.cartesianToCanvasCoordinates(position) : undefined
    if (!canvasPosition || canvasPosition.x < 0 || canvasPosition.y < 0 || canvasPosition.x > container.value!.clientWidth || canvasPosition.y > container.value!.clientHeight) return []
    return [{ id: entity.id, code: entity.name ?? "", x: Math.round(canvasPosition.x * 100) / 100, y: Math.round(canvasPosition.y * 100) / 100 }]
  })
  if (container.value.parentElement) container.value.parentElement.setAttribute("data-aircraft-pick-points", JSON.stringify(points))
}

function renderEvents() {
  if (!viewer || !eventSource) return
  const entities = eventSource.entities
  entities.suspendEvents()
  try {
  const activeIds = new Set<string>()
  const aircraftById = new Map(props.aircraft.map((aircraft) => [aircraft.id, aircraft]))
  const routesById = new Map(props.routes.map((route) => [route.id, route]))
  for (const event of props.events) {
    const eventTimeMs = event.detectedSimulationTimeMs ?? event.scheduledSimulationTimeMs ?? 0
    if (eventTimeMs > props.playbackTimeMs) continue
    if (!props.replay && (event.lifecycleStatus === "SCHEDULED" || event.lifecycleStatus === "ENDED")) continue
    const position = eventPosition(event, aircraftById, routesById)
    if (!position) continue
    const entityId = `runtime-event:${event.id}`
    activeIds.add(entityId)
    const selected = event.id === props.selectedEventId
    const color = event.severity === "CRITICAL" || event.severity === "ERROR" ? runtimeEventCriticalColor : runtimeEventWarningColor
    const pointColor = event.severity === "CRITICAL" || event.severity === "ERROR" ? runtimeEventCriticalPointColor : runtimeEventWarningPointColor
    const appearanceKey = `${event.severity}:${selected}:${props.mode}`
    let entity = eventSource.entities.getById(entityId)
    if (!entity || eventAppearanceKeys.get(entityId) !== appearanceKey) {
      if (entity) eventSource.entities.remove(entity)
      entity = eventSource.entities.add({
        id: entityId,
        position: Cartesian3.fromDegrees(position.longitude, position.latitude, props.mode === "3d" ? (position.altitudeMeters ?? 0) + 18 : 1),
        point: { pixelSize: selected ? 18 : 14, color: pointColor, outlineColor: color, outlineWidth: 3, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: {
          text: selected ? event.title : "!",
          font: selected ? "bold 11px system-ui" : "bold 13px system-ui",
          fillColor: color,
          outlineColor: Color.WHITE,
          outlineWidth: 4,
          style: LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cartesian2(0, selected ? -20 : 1),
          verticalOrigin: selected ? VerticalOrigin.BOTTOM : VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
      eventAppearanceKeys.set(entityId, appearanceKey)
    } else {
      const cartesian = Cartesian3.fromDegrees(position.longitude, position.latitude, props.mode === "3d" ? (position.altitudeMeters ?? 0) + 18 : 1)
      if (entity.position instanceof ConstantPositionProperty) entity.position.setValue(cartesian)
      else entity.position = new ConstantPositionProperty(cartesian)
    }
  }
  for (const entity of [...eventSource.entities.values]) {
    if (activeIds.has(entity.id)) continue
    eventSource.entities.remove(entity)
    eventAppearanceKeys.delete(entity.id)
  }
  } finally {
    entities.resumeEvents()
  }
  viewer.scene.requestRender()
}

function eventPosition(
  event: LogisticsRuntimeEventView,
  aircraftById: ReadonlyMap<string, LogisticsRuntimeAircraftView>,
  routesById: ReadonlyMap<string, LogisticsRuntimeRouteView>
): V3Coordinate | null {
  const aircraft = event.affectedAircraftIds
    .map((aircraftId) => aircraftById.get(aircraftId))
    .find((item) => item && validCoordinate(item.position))
  if (aircraft) return aircraft.position
  const route = event.affectedRouteIds
    .map((routeId) => routesById.get(routeId))
    .find((item) => item && item.waypoints.length > 0)
  if (route) return route.waypoints[Math.floor((route.waypoints.length - 1) / 2)]?.position ?? null
  return null
}

function logisticsRouteRenderSignature(routes: readonly LogisticsRuntimeRouteView[]): string {
  return routes.map((route) => [
    route.id,
    route.status,
    route.activeTaskCount,
    route.waypoints.map((waypoint) => [waypoint.position.longitude, waypoint.position.latitude, waypoint.altitudeMeters].join(",")).join(";")
  ].join(":" )).join("|")
}

function logisticsAircraftRenderSignature(aircraft: readonly LogisticsRuntimeAircraftView[]): string {
  return aircraft.map((item) => [
    item.id,
    item.code,
    item.status,
    item.batteryPercent,
    item.position.longitude,
    item.position.latitude,
    item.position.altitudeMeters
  ].join(":" )).join("|")
}

function logisticsEventRenderSignature(events: readonly LogisticsRuntimeEventView[]): string {
  return events.map((event) => [
    event.id,
    event.status,
    event.lifecycleStatus,
    event.severity,
    event.detectedSimulationTimeMs,
    event.scheduledSimulationTimeMs,
    event.affectedAircraftIds.join(","),
    event.affectedRouteIds.join(",")
  ].join(":" )).join("|")
}

function routeColor(status: LogisticsRuntimeRouteView["status"]) {
  return mapColor(logisticsRuntimeRouteStatusColors[status])
}

function setMode(mode: "2d" | "3d", refocus = true) {
  previousFollowCoordinate = null
  if (!viewer) return
  const targetMode = mode === "2d" ? SceneMode.SCENE2D : SceneMode.SCENE3D
  const cameraSnapshot = !refocus && viewer.scene.mode !== targetMode ? captureV3Camera(viewer) : null
  if (viewer.scene.mode === targetMode) {
    renderRoutes()
    renderAircraft()
    renderEvents()
    if (refocus) focusCurrentSelection(0.25, mode)
    else if (cameraSnapshot) restoreV3Camera(viewer, cameraSnapshot, mode)
    return
  }
  removeMorphCompleteListener?.()
  if (viewer.scene.mode === SceneMode.MORPHING) viewer.scene.completeMorph()
  removeMorphCompleteListener = viewer.scene.morphComplete.addEventListener(() => {
    removeMorphCompleteListener = null
    renderRoutes()
    renderAircraft()
    renderEvents()
    if (refocus) focusCurrentSelection(0.25, mode)
    else if (cameraSnapshot) restoreV3Camera(viewer!, cameraSnapshot, mode)
  })
  if (mode === "2d") viewer.scene.morphTo2D(0.3)
  else viewer.scene.morphTo3D(0.3)
}

function focusCurrentSelection(duration: number, mode: "2d" | "3d" = props.mode) {
  if (!viewer) return
  const coordinates = logisticsRuntimeFocusCoordinates(
    props.routes,
    props.aircraft,
    props.events,
    props.selectedRouteId,
    props.selectedAircraftId,
    props.selectedEventId
  )
  if (coordinates.length > 0) focusV3Coordinates(viewer, coordinates, mode, duration)
  else focusV3Region(viewer, props.region, mode, duration)
  scheduleCameraDiagnostics(duration)
}

function toggleAircraftFollow() {
  if (!props.selectedAircraftId) return
  followSelectedAircraft.value = !followSelectedAircraft.value
  previousFollowCoordinate = null
  if (followSelectedAircraft.value) focusSelectedAircraft(0.2)
}

function focusSelectedAircraft(duration = 0) {
  if (!viewer || !props.selectedAircraftId || viewer.scene.mode === SceneMode.MORPHING) return
  const aircraft = props.aircraft.find((item) => item.id === props.selectedAircraftId)
  if (!aircraft || !validCoordinate(aircraft.position)) return
  if (props.mode === "2d") {
    focusV3Coordinates(viewer, [aircraft.position], props.mode, 0)
  } else {
    // Translate horizontally only: repeatedly framing a sphere measures range
    // against the ground and adds flight altitude again on every update.
    const camera = viewer.camera
    const current = Cartographic.clone(camera.positionCartographic)
    const diagnostics = v3CameraDiagnostics(viewer)
    const origin = previousFollowCoordinate ?? {
      longitude: diagnostics.groundLongitude ?? diagnostics.longitude,
      latitude: diagnostics.groundLatitude ?? diagnostics.latitude
    }
    camera.cancelFlight()
    camera.setView({
      destination: Cartesian3.fromRadians(
        current.longitude + (aircraft.position.longitude - origin.longitude) * Math.PI / 180,
        current.latitude + (aircraft.position.latitude - origin.latitude) * Math.PI / 180,
        current.height
      ),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll }
    })
  }
  previousFollowCoordinate = { ...aircraft.position }
  scheduleCameraDiagnostics(duration)
}

function updateCameraDiagnostics() {
  if (viewer && viewer.scene.mode !== SceneMode.MORPHING) cameraDiagnostics.value = v3CameraDiagnostics(viewer)
}

function scheduleCameraDiagnostics(durationSeconds: number) {
  if (cameraDiagnosticsTimer !== null) window.clearTimeout(cameraDiagnosticsTimer)
  cameraDiagnosticsTimer = window.setTimeout(() => {
    cameraDiagnosticsTimer = null
    updateCameraDiagnostics()
  }, Math.max(0, durationSeconds * 1_000) + 100)
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

function validCoordinate(value: V3Coordinate) {
  return Number.isFinite(value.longitude) && Number.isFinite(value.latitude) && Math.abs(value.longitude) <= 180 && Math.abs(value.latitude) <= 90 && (value.longitude !== 0 || value.latitude !== 0)
}

function flatten(points: readonly V3Coordinate[]) {
  return points.flatMap((point) => [point.longitude, point.latitude])
}

function flattenClosed(points: readonly V3Coordinate[]) {
  return points[0] ? flatten([...points, points[0]]) : []
}

</script>

<template>
  <div class="logistics-runtime-map-shell" :data-selected-aircraft-id="selectedAircraftId" :data-selected-route-id="selectedRouteId" :data-aircraft-pick-points="'[]'" :data-aircraft-visual-count="aircraftVisualCount" :data-aircraft-model-count="aircraftModelCount" :data-aircraft-billboard-count="aircraftBillboardCount" :data-aircraft-trail-count="aircraftTrailCount" :data-following-aircraft="followSelectedAircraft ? selectedAircraftId : ''" :data-static-feature-mode="staticFeatureSummary.mode" :data-static-feature-ids="staticFeatureSummary.featureIds" :data-static-3d-building-count="staticFeatureSummary.buildingExtrusions" :data-static-3d-obstacle-count="staticFeatureSummary.obstacleCylinders" :data-camera-longitude="cameraDiagnostics?.longitude" :data-camera-latitude="cameraDiagnostics?.latitude" :data-camera-height-meters="cameraDiagnostics?.heightMeters" :data-camera-heading-radians="cameraDiagnostics?.headingRadians" :data-camera-pitch-radians="cameraDiagnostics?.pitchRadians" :data-camera-ground-range-meters="cameraDiagnostics?.groundRangeMeters" @click="handleShellClick">
    <div ref="container" class="logistics-runtime-map" />
    <V3MapResourceNotice :available="Boolean(region)" :imagery-state="imageryState" @retry="reloadMapResources" />
    <V3MapTerrainNotice :state="terrainState" :region="region" @retry="reloadMapResources" />
    <button v-if="selectedAircraftId" type="button" class="aircraft-follow-toggle" :class="{ active: followSelectedAircraft }" :aria-pressed="followSelectedAircraft" :title="followSelectedAircraft ? '停止跟随飞行器' : '跟随飞行器'" @click.stop="toggleAircraftFollow">
      <el-icon><Aim /></el-icon>
      <span>{{ followSelectedAircraft ? "跟随中" : "跟随飞行器" }}</span>
    </button>
    <V3MapViewControls :mode="mode" @home="focusMapRegion" @zoom-in="zoomMapIn" @zoom-out="zoomMapOut" @rotate-left="rotateMapLeft" @rotate-right="rotateMapRight" @reset-north="resetMapNorth" @top-down="setTopDownView" @flight-view="setFlightView" />
    <V3MapScaleBar :viewer="scaleViewer" :available="Boolean(region)" :terrain-state="terrainState" />
  </div>
</template>

<style scoped>
.logistics-runtime-map-shell { position: relative; z-index: 2; isolation: isolate; width: 100%; height: 100%; min-height: 380px; background: #dce3de; pointer-events: auto; }
.logistics-runtime-map { position: relative; z-index: 3; display: block; width: 100%; height: 100%; pointer-events: auto; }
.logistics-runtime-map :deep(canvas) { position: relative; z-index: 1; pointer-events: auto; }
.aircraft-follow-toggle { position: absolute; z-index: 8; bottom: 69px; left: 14px; display: inline-flex; align-items: center; gap: 7px; min-height: 34px; padding: 0 11px; border: 1px solid rgba(255, 255, 255, 0.72); border-radius: 4px; background: rgba(20, 32, 29, 0.86); color: #fff; box-shadow: 0 2px 7px rgba(13, 25, 21, 0.2); font: 600 13px/1 system-ui; cursor: pointer; backdrop-filter: blur(5px); }
.aircraft-follow-toggle:hover { background: rgba(31, 54, 47, 0.94); }
.aircraft-follow-toggle.active { border-color: #f8c44f; background: #1d5a45; color: #fff7d5; }
.aircraft-follow-toggle .el-icon { width: 16px; height: 16px; font-size: 16px; }
</style>
