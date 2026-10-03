<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  Cartesian2,
  Cartesian3,
  ColorBlendMode,
  DistanceDisplayCondition,
  Color,
  ConstantPositionProperty,
  ConstantProperty,
  CustomDataSource,
  HeightReference,
  HeadingPitchRoll,
  HeadingPitchRange,
  Matrix4,
  Math as CesiumMath,
  Rectangle,
  SceneMode,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer
} from "cesium"
import type { ShowRuntimeGroupView, V3Coordinate, V3RegionCatalogItem, V3RegionLayerCode } from "@wurenji/shared"
import { configureV3CesiumPerformance } from "../cesium-performance"
import { createUnifiedCesiumViewer } from "../cesium-map-adapter"
import { createMapLabelAppearance, MAP_LABEL_FONT_SMALL } from "../map-label-policy"
import { mapBasemapColors, mapColor, mapColorAlpha, mapRegionColors, showRuntimeColors, showRuntimeGroupStatusColors } from "../map-visual-theme"
import { createV3MapDataStateTracker, type V3MapDataState, type V3MapDataStateTracker, type V3MapImageryState } from "../map-loading-state"
import { regionMapResourceKey } from "../map-resources"
import { loadV3MapResources } from "../map-resources-loader"
import type { RegionTerrainState } from "../terrain"
import {
  clampV3CameraRange,
  configureRegionMapConstraints,
  captureV3Camera,
  focusV3Region,
  regionMaskHierarchy,
  regionMaximumZoomDistance,
  regionMinimumZoomDistance,
  restoreV3Camera,
  resetV3CameraNorth,
  rotateV3Camera,
  setV3CameraPreset,
  zoomV3Camera,
  v3CameraDiagnostics,
  type V3CameraDiagnostics
} from "../map-region-constraints"
import { renderRegionStaticFeatures } from "../map-static-features"
import V3MapViewControls from "./V3MapViewControls.vue"
import V3MapScaleBar from "./V3MapScaleBar.vue"
import V3MapResourceNotice from "./V3MapResourceNotice.vue"
import V3MapTerrainNotice from "./V3MapTerrainNotice.vue"

const props = defineProps<{
  region: V3RegionCatalogItem | null
  visibleLayers?: readonly V3RegionLayerCode[]
  groups: readonly ShowRuntimeGroupView[]
  performanceCenter: V3Coordinate | null
  performanceRadiusMeters: number
  mode: "2d" | "3d"
  selectedGroupId?: string | null
}>()

const emit = defineEmits<{
  dataState: [state: V3MapDataState]
  groupSelect: [groupId: string]
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
let removeCameraMoveEndListener: (() => void) | null = null
let removeCameraChangedListener: (() => void) | null = null
let cameraDiagnosticsTimer: number | null = null
let mapResourceGeneration = 0
let staticSource: CustomDataSource | null = null
let runtimeSource: CustomDataSource | null = null
let runtimeInteractionHandler: ScreenSpaceEventHandler | null = null
let groupRenderFrame: number | null = null
const staticFeatureSummary = ref({ mode: "2d" as "2d" | "3d", featureIds: "", buildingExtrusions: 0, obstacleCylinders: 0 })
const cameraDiagnostics = ref<V3CameraDiagnostics | null>(null)
let removeMorphCompleteListener: (() => void) | null = null
const groupAppearanceKeys = new Map<string, string>()

async function reloadMapResources() {
  if (!viewer || !mapDataTracker) return
  const mapViewer = viewer
  const tracker = mapDataTracker
  const generation = ++mapResourceGeneration
  activeResourceCleanup?.()
  activeResourceCleanup = null
  if (groupRenderFrame !== null) window.cancelAnimationFrame(groupRenderFrame)
  groupRenderFrame = null
  const cleanup = await loadV3MapResources(mapViewer, props.region, tracker, {
    forceFreshImagery: generation > 1,
    manageRegionConstraints: false,
    isCurrent: () => viewer === mapViewer && mapDataTracker === tracker && generation === mapResourceGeneration && !mapViewer.isDestroyed()
  })
  if (viewer === mapViewer && mapDataTracker === tracker && generation === mapResourceGeneration && !mapViewer.isDestroyed()) activeResourceCleanup = cleanup
  else cleanup()
}

const statusColors = Object.fromEntries(
  Object.entries(showRuntimeGroupStatusColors).map(([status, css]) => [status, mapColor(css)])
) as Record<ShowRuntimeGroupView["status"], Color>

onMounted(async () => {
  if (!container.value) return
  viewer = createUnifiedCesiumViewer(container.value)
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
  removeCameraMoveEndListener = viewer.camera.moveEnd.addEventListener(() => scheduleCameraDiagnostics(400))
  removeCameraChangedListener = viewer.camera.changed.addEventListener(() => scheduleCameraDiagnostics(500))
  void reloadMapResources()
  staticSource = await viewer.dataSources.add(new CustomDataSource("show-runtime-static"))
  runtimeSource = await viewer.dataSources.add(new CustomDataSource("show-runtime-groups"))
  runtimeInteractionHandler = new ScreenSpaceEventHandler(viewer.scene.canvas)
  runtimeInteractionHandler.setInputAction((movement: { position: Cartesian2 }) => {
    const picked = viewer?.scene.pick(movement.position) as { id?: { id?: string } } | undefined
    const id = String(picked?.id?.id ?? "")
    if (id.startsWith("runtime-group:")) emit("groupSelect", id.slice("runtime-group:".length))
  }, ScreenSpaceEventType.LEFT_CLICK)
  renderStatic()
  renderGroups()
  setMode(props.mode)
  updateCameraDiagnostics()
  mapDataTracker.markInitialized()
})

onBeforeUnmount(() => {
  viewerReady.value = false
  mapResourceGeneration += 1
  removePerformanceTuning?.()
  removePerformanceTuning = null
  removeCameraConstraints?.()
  removeCameraConstraints = null
  removeCameraMoveEndListener?.()
  removeCameraMoveEndListener = null
  removeCameraChangedListener?.()
  removeCameraChangedListener = null
  if (cameraDiagnosticsTimer !== null) window.clearTimeout(cameraDiagnosticsTimer)
  cameraDiagnosticsTimer = null
  removeTileLoadProgressListener?.()
  removeTileLoadProgressListener = null
  activeResourceCleanup?.()
  activeResourceCleanup = null
  removeMorphCompleteListener?.()
  removeMorphCompleteListener = null
  viewer?.destroy()
  scaleViewer.value = null
  viewer = null
  mapDataTracker = null
  staticSource = null
  runtimeSource = null
  runtimeInteractionHandler?.destroy()
  runtimeInteractionHandler = null
  groupAppearanceKeys.clear()
})

watch(() => [
  regionMapResourceKey(props.region),
  props.performanceCenter?.longitude ?? null,
  props.performanceCenter?.latitude ?? null,
  props.performanceCenter?.altitudeMeters ?? null,
  props.performanceRadiusMeters
], () => renderStatic())
watch(() => regionMapResourceKey(props.region), () => { void reloadMapResources() })
watch(() => regionMapResourceKey(props.region), () => {
  removeCameraConstraints?.()
  removeCameraConstraints = viewer ? configureRegionMapConstraints(viewer, props.region) : null
  updateCameraDiagnostics()
})
watch(() => props.groups.map((group) => [
  group.groupId,
  group.status,
  group.center.longitude,
  group.center.latitude,
  group.center.altitudeMeters ?? 0,
  group.airborneCount,
  group.plannedCount,
  group.radiusMeters,
  props.selectedGroupId
].join(":")), scheduleGroupRender)
watch(() => props.mode, (mode) => { setMode(mode, false); renderStatic(false) })
watch(() => props.visibleLayers, () => renderStatic(false), { deep: true })

function scheduleGroupRender() {
  if (groupRenderFrame !== null) return
  groupRenderFrame = window.requestAnimationFrame(() => {
    groupRenderFrame = null
    renderGroups()
  })
}

function renderStatic(focus = true) {
  if (!viewer || !staticSource) return
  staticSource.entities.removeAll()
  if (props.region) {
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
        hierarchy: Cartesian3.fromDegreesArray(flatten(props.region.boundary)),
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
  if (props.performanceCenter) {
    staticSource.entities.add({
      id: "runtime-performance-area",
      position: Cartesian3.fromDegrees(props.performanceCenter.longitude, props.performanceCenter.latitude),
      ellipse: {
        semiMajorAxis: props.performanceRadiusMeters,
        semiMinorAxis: props.performanceRadiusMeters,
        material: mapColorAlpha(showRuntimeColors.performanceArea, 0.1),
        height: 0,
        outline: true,
        outlineColor: mapColor(showRuntimeColors.performanceArea),
        heightReference: HeightReference.CLAMP_TO_GROUND
      }
    })
  }
  renderRegionStaticFeatures(staticSource, props.region, props.mode, "show-runtime-static", props.visibleLayers)
  updateStaticFeatureSummary()
  if (focus) frameScene()
}

function updateStaticFeatureSummary() {
  if (!staticSource) return
  const prefix = "show-runtime-static:layer:"
  const entities = staticSource.entities.values.filter((entity) => typeof entity.id === "string" && entity.id.startsWith(prefix))
  staticFeatureSummary.value = {
    mode: props.mode,
    featureIds: entities.map((entity) => entity.id).join(","),
    buildingExtrusions: entities.filter((entity) => entity.id.includes(":BUILDINGS:") && Boolean(entity.polygon?.extrudedHeight)).length,
    obstacleCylinders: entities.filter((entity) => entity.id.includes(":BUILDINGS:") && Boolean(entity.cylinder)).length
  }
}

function renderGroups() {
  if (!viewer || !runtimeSource) return
  const entities = runtimeSource.entities
  entities.suspendEvents()
  try {
  const activeIds = new Set<string>()
  for (const group of props.groups) {
    const entityId = `runtime-group:${group.groupId}`
    activeIds.add(entityId)
    const color = statusColors[group.status]
    const selected = props.selectedGroupId === group.groupId
    const altitudeMeters = Math.max(0, group.center.altitudeMeters ?? 0)
    const appearanceKey = `${group.status}:${selected ? "selected" : "normal"}`
    let entity = runtimeSource.entities.getById(entityId)
    if (!entity || groupAppearanceKeys.get(entityId) !== appearanceKey) {
      if (entity) runtimeSource.entities.remove(entity)
      entity = runtimeSource.entities.add({
        id: entityId,
        name: group.label,
        position: Cartesian3.fromDegrees(group.center.longitude, group.center.latitude, group.center.altitudeMeters ?? 0),
        orientation: Transforms.headingPitchRollQuaternion(Cartesian3.fromDegrees(group.center.longitude, group.center.latitude, Math.max(2, altitudeMeters)), new HeadingPitchRoll(0, 0, 0)),
        point: {
          pixelSize: selected
            ? Math.max(12, Math.min(22, 10 + Math.sqrt(group.plannedCount) * 0.35))
            : Math.max(8, Math.min(18, 7 + Math.sqrt(group.plannedCount) * 0.3)),
          color,
          outlineColor: Color.WHITE,
          outlineWidth: 2,
          heightReference: HeightReference.RELATIVE_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        model: {
          uri: "/models/logistics-drone.gltf",
          scale: 2.6,
          minimumPixelSize: selected ? 46 : 32,
          maximumScale: 24,
          color,
          colorBlendMode: ColorBlendMode.MIX,
          colorBlendAmount: 0.28,
          silhouetteColor: Color.WHITE,
          silhouetteSize: selected ? 3 : 1,
          distanceDisplayCondition: new DistanceDisplayCondition(0, 100_000)
        },
        ellipse: {
          semiMajorAxis: group.radiusMeters,
          semiMinorAxis: group.radiusMeters,
          material: color.withAlpha(0.12),
          outline: true,
          outlineColor: color.withAlpha(0.65),
          height: group.center.altitudeMeters ?? 0,
          heightReference: HeightReference.RELATIVE_TO_GROUND
        },
        label: createMapLabelAppearance({
          text: `${group.label} · ${group.airborneCount}/${group.plannedCount}${props.mode === "3d" ? ` · 高度 ${Math.round(altitudeMeters)}m` : ""}`,
          color,
          priority: "TASK_POINT",
          truncate: false,
          font: MAP_LABEL_FONT_SMALL,
          offset: new Cartesian2(0, -22)
        })
      })
      groupAppearanceKeys.set(entityId, appearanceKey)
    } else {
      const position = Cartesian3.fromDegrees(group.center.longitude, group.center.latitude, group.center.altitudeMeters ?? 0)
      if (entity.position instanceof ConstantPositionProperty) entity.position.setValue(position)
      else entity.position = new ConstantPositionProperty(position)
      if (entity.model) entity.model.color = new ConstantProperty(color)
      const labelText = `${group.label} · ${group.airborneCount}/${group.plannedCount}${props.mode === "3d" ? ` · 高度 ${Math.round(altitudeMeters)}m` : ""}`
      if (entity.label?.text instanceof ConstantProperty) entity.label.text.setValue(labelText)
      else if (entity.label) entity.label.text = new ConstantProperty(labelText)
      if (entity.ellipse) {
        if (entity.ellipse.semiMajorAxis instanceof ConstantProperty) entity.ellipse.semiMajorAxis.setValue(group.radiusMeters)
        else entity.ellipse.semiMajorAxis = new ConstantProperty(group.radiusMeters)
        if (entity.ellipse.semiMinorAxis instanceof ConstantProperty) entity.ellipse.semiMinorAxis.setValue(group.radiusMeters)
        else entity.ellipse.semiMinorAxis = new ConstantProperty(group.radiusMeters)
        if (entity.ellipse.height instanceof ConstantProperty) entity.ellipse.height.setValue(group.center.altitudeMeters ?? 0)
        else entity.ellipse.height = new ConstantProperty(group.center.altitudeMeters ?? 0)
      }
    }
    if (selected && viewer.trackedEntity?.id !== entityId) viewer.trackedEntity = entity
    if (props.mode === "3d" && selected && altitudeMeters > 1) {
      const guideId = `runtime-group-altitude:${group.groupId}`
      activeIds.add(guideId)
      const previousGuide = runtimeSource.entities.getById(guideId)
      if (previousGuide) runtimeSource.entities.remove(previousGuide)
      runtimeSource.entities.add({
        id: guideId,
        name: `${group.label} 高度参考`,
        polyline: {
          positions: [
            Cartesian3.fromDegrees(group.center.longitude, group.center.latitude, 0),
            Cartesian3.fromDegrees(group.center.longitude, group.center.latitude, altitudeMeters)
          ],
          width: 2,
          material: color.withAlpha(0.78),
          depthFailMaterial: color.withAlpha(0.42)
        },
        point: { pixelSize: 5, color, outlineColor: Color.WHITE, outlineWidth: 1, heightReference: HeightReference.NONE }
      })
    }
  }
  for (const entity of [...runtimeSource.entities.values]) {
    if (activeIds.has(entity.id)) continue
    runtimeSource.entities.remove(entity)
    groupAppearanceKeys.delete(entity.id)
  }
  viewer.scene.requestRender()
  } finally {
    entities.resumeEvents()
  }
}

function setMode(mode: "2d" | "3d", refocus = true) {
  if (!viewer) return
  const targetMode = mode === "2d" ? SceneMode.SCENE2D : SceneMode.SCENE3D
  const cameraSnapshot = !refocus && viewer.scene.mode !== targetMode ? captureV3Camera(viewer) : null
  const applyMode = () => {
    renderGroups()
    if (cameraSnapshot) restoreV3Camera(viewer!, cameraSnapshot, mode)
    if (refocus) frameScene(mode)
  }
  if (viewer.scene.mode === targetMode) {
    applyMode()
    return
  }
  removeMorphCompleteListener?.()
  removeMorphCompleteListener = null
  if (viewer.scene.mode === SceneMode.MORPHING) viewer.scene.completeMorph()
  removeMorphCompleteListener = viewer.scene.morphComplete.addEventListener(() => {
    removeMorphCompleteListener = null
    applyMode()
  })
  if (mode === "2d") viewer.scene.morphTo2D(0.3)
  else viewer.scene.morphTo3D(0.3)
}

function focusMapRegion() {
  if (!viewer) return
  focusV3Region(viewer, props.region, props.mode, 0.35)
  scheduleCameraDiagnostics(450)
}

function zoomMapIn() {
  if (viewer && zoomV3Camera(viewer, props.region, props.mode, "in")) updateCameraDiagnostics()
}

function zoomMapOut() {
  if (viewer && zoomV3Camera(viewer, props.region, props.mode, "out")) updateCameraDiagnostics()
}

function updateCameraDiagnostics() {
  if (viewer && !viewer.isDestroyed() && viewer.scene && viewer.scene.mode !== SceneMode.MORPHING) cameraDiagnostics.value = v3CameraDiagnostics(viewer)
}

function scheduleCameraDiagnostics(delayMs: number) {
  if (cameraDiagnosticsTimer !== null) window.clearTimeout(cameraDiagnosticsTimer)
  cameraDiagnosticsTimer = window.setTimeout(() => {
    cameraDiagnosticsTimer = null
    updateCameraDiagnostics()
  }, delayMs)
}

function rotateMapLeft() {
  if (viewer && rotateV3Camera(viewer, props.region, props.mode, -15)) updateCameraDiagnostics()
}

function rotateMapRight() {
  if (viewer && rotateV3Camera(viewer, props.region, props.mode, 15)) updateCameraDiagnostics()
}

function resetMapNorth() {
  if (viewer && resetV3CameraNorth(viewer, props.region, props.mode)) updateCameraDiagnostics()
}

function setTopDownView() {
  if (viewer && setV3CameraPreset(viewer, props.region, props.mode, "top-down")) updateCameraDiagnostics()
}

function setFlightView() {
  if (viewer && setV3CameraPreset(viewer, props.region, props.mode, "flight")) updateCameraDiagnostics()
}

function frameScene(mode: "2d" | "3d" = props.mode) {
  if (!viewer || !staticSource) return
  if (props.performanceCenter) {
    const radius = Math.max(30, props.performanceRadiusMeters)
    if (mode === "2d") {
      const latitudePadding = radius * 1.8 / 111_320
      const longitudeScale = Math.max(0.1, Math.cos(CesiumMath.toRadians(props.performanceCenter.latitude)))
      const longitudePadding = latitudePadding / longitudeScale
      viewer.camera.flyTo({
        destination: Rectangle.fromDegrees(
          props.performanceCenter.longitude - longitudePadding,
          props.performanceCenter.latitude - latitudePadding,
          props.performanceCenter.longitude + longitudePadding,
          props.performanceCenter.latitude + latitudePadding
        ),
        duration: 0.35
      })
      scheduleCameraDiagnostics(450)
      return
    }
    const maximumGroupAltitude = Math.max(0, ...props.groups.map((group) => group.center.altitudeMeters ?? 0))
    const target = Cartesian3.fromDegrees(
      props.performanceCenter.longitude,
      props.performanceCenter.latitude,
      Math.max(20, maximumGroupAltitude * 0.4)
    )
    viewer.camera.lookAt(
      target,
      new HeadingPitchRange(
        0,
        -CesiumMath.PI_OVER_FOUR,
        clampV3CameraRange(props.region, Math.max(600, radius * 5, maximumGroupAltitude * 4))
      )
    )
    viewer.camera.lookAtTransform(Matrix4.IDENTITY)
    viewer.scene.requestRender()
    updateCameraDiagnostics()
    return
  }
  const performanceArea = staticSource.entities.getById("runtime-performance-area")
  const target = performanceArea
    ?? (runtimeSource?.entities.values.length ? runtimeSource.entities : null)
    ?? (staticSource.entities.values.length ? staticSource.entities : null)
  if (!target) return
  void viewer.flyTo(target, mode === "2d"
    ? { duration: 0.35 }
    : {
        duration: 0.35,
        offset: new HeadingPitchRange(
          0,
          -CesiumMath.PI_OVER_FOUR,
          clampV3CameraRange(props.region, Math.max(900, props.performanceRadiusMeters * 6))
        )
      }).then(updateCameraDiagnostics)
}

function flatten(points: readonly { longitude: number; latitude: number }[]): number[] {
  return points.flatMap((point) => [point.longitude, point.latitude])
}

function flattenClosed(points: readonly { longitude: number; latitude: number }[]): number[] {
  return points[0] ? flatten([...points, points[0]]) : []
}

</script>

<template>
  <div class="show-runtime-map-shell" :data-region-code="region?.regionCode ?? ''" :data-static-feature-mode="staticFeatureSummary.mode" :data-static-feature-ids="staticFeatureSummary.featureIds" :data-static-3d-building-count="staticFeatureSummary.buildingExtrusions" :data-static-3d-obstacle-count="staticFeatureSummary.obstacleCylinders" :data-selected-group-id="selectedGroupId ?? ''" :data-camera-longitude="cameraDiagnostics?.longitude" :data-camera-latitude="cameraDiagnostics?.latitude" :data-camera-height-meters="cameraDiagnostics?.heightMeters" :data-camera-heading-radians="cameraDiagnostics?.headingRadians" :data-camera-pitch-radians="cameraDiagnostics?.pitchRadians" :data-camera-ground-longitude="cameraDiagnostics?.groundLongitude" :data-camera-ground-latitude="cameraDiagnostics?.groundLatitude" :data-camera-ground-range-meters="cameraDiagnostics?.groundRangeMeters" :data-camera-minimum-range-meters="region ? regionMinimumZoomDistance(region) : ''" :data-camera-maximum-range-meters="region ? regionMaximumZoomDistance(region) : ''">
    <div ref="container" class="show-runtime-map" />
    <V3MapResourceNotice :available="Boolean(region)" :imagery-state="imageryState" @retry="reloadMapResources" />
    <V3MapTerrainNotice :state="terrainState" :region="region" @retry="reloadMapResources" />
    <V3MapViewControls :mode="mode" @home="focusMapRegion" @zoom-in="zoomMapIn" @zoom-out="zoomMapOut" @rotate-left="rotateMapLeft" @rotate-right="rotateMapRight" @reset-north="resetMapNorth" @top-down="setTopDownView" @flight-view="setFlightView" />
    <V3MapScaleBar :viewer="scaleViewer" :available="Boolean(region)" :terrain-state="terrainState" />
  </div>
</template>

<style scoped>
.show-runtime-map-shell { position: relative; width: 100%; height: 100%; min-height: 360px; background: #dce3de; }
.show-runtime-map { width: 100%; height: 100%; }
</style>
