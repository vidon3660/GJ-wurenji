<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Cesium3DTileset,
  CesiumTerrainProvider,
  Color,
  ConstantPositionProperty,
  CustomDataSource,
  DistanceDisplayCondition,
  Entity,
  GridImageryProvider,
  HeightReference,
  HeadingPitchRange,
  HorizontalOrigin,
  ImageryLayer,
  IonImageryProvider,
  Ion,
  IonWorldImageryStyle,
  Matrix4,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  PolygonHierarchy,
  Rectangle,
  Resource,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  TerrainProvider,
  VerticalOrigin,
  Viewer,
  createOsmBuildingsAsync,
  createWorldImageryAsync,
  createWorldTerrainAsync,
  type ImageryProvider,
  sampleTerrainMostDetailed
} from "cesium"
import type { GeoPoint, MissionPlan, PracticeScene, RuleFinding, SimulationResult } from "@wurenji/shared"
import { configureV3CesiumPerformance } from "../cesium-performance"
import { createUnifiedCesiumViewer } from "../cesium-map-adapter"
import { isPointInsidePolygon, selectionIdForMapEntity } from "../map-edit"
import {
  mapBasemapColors,
  mapColor,
  mapColorAlpha,
  mapInteractionColors,
  mapObstacleColors,
  mapPoiColors,
  mapRegionColors,
  mapRestrictionColors,
  mapRouteColors
} from "../map-visual-theme"
import { configureRegionMapConstraints } from "../map-region-constraints"
import V3MapScaleBar from "./V3MapScaleBar.vue"

const props = defineProps<{
  scene: PracticeScene | null
  plan: MissionPlan | null
  result: SimulationResult | null
  playbackTime: number
  mode: "2d" | "3d"
  activeTool: string
  drawingPoints: GeoPoint[]
  selectedObjectId: string
  selectedDroneId: string
  selectedFinding: RuleFinding | null
}>()

const emit = defineEmits<{
  mapClick: [point: GeoPoint]
  mapPickError: []
  selectObject: [id: string]
  moveObject: [id: string, point: GeoPoint]
  editState: [dragging: boolean]
  mapDataState: [state: { imagery: ImageryState; terrain: LayerState; buildings: LayerState; terrainSource: TerrainSource }]
  modeComplete: [mode: "2d" | "3d"]
}>()

type LayerState = "disabled" | "loading" | "ready" | "failed"
type ImageryState = LayerState | "degraded"
type TerrainSource = "CUSTOM_DEM" | "WORLD_TERRAIN" | "ELLIPSOID"

const container = shallowRef<HTMLElement | null>(null)
const renderedMode = ref<"2d" | "3d">("3d")
const dragging = ref(false)
const imageryState = ref<ImageryState>("disabled")
const terrainState = ref<LayerState>("disabled")
const buildingsState = ref<LayerState>("disabled")
const terrainSource = ref<TerrainSource>("ELLIPSOID")
const mapInteractionState = ref("idle")
const nativeClickCount = ref(0)
let viewer: Viewer | null = null
const viewerReady = ref(false)
let removePerformanceTuning: (() => void) | null = null
let handler: ScreenSpaceEventHandler | null = null
let sceneSource: CustomDataSource | null = null
let planSource: CustomDataSource | null = null
let simulationSource: CustomDataSource | null = null
let diagnosticSource: CustomDataSource | null = null
const droneEntities = new Map<string, Entity>()
const terrainHeightCache = new Map<string, number>()
const pendingTerrainKeys = new Set<string>()
let terrainProvider: TerrainProvider | null = null
let buildingsTileset: Cesium3DTileset | null = null
let dragTargetId = ""
let lastDragPoint: GeoPoint | null = null
let suppressNextCanvasClick = false
let fallbackImageryAdded = false
let fallbackImageryLayer: ImageryLayer | null = null
let removeFallbackImageryError: (() => void) | null = null
let realityImageryLayer: ImageryLayer | null = null
let removeRealityImageryError: (() => void) | null = null
let imageryLoadGeneration = 0
let threeDimensionalHeading = 0
let cameraReady = false
let viewFocus: { target: Cartesian3; range: number } | null = null
let removeCameraConstraints: (() => void) | null = null
let removeTileLoadProgress: (() => void) | null = null
let imageryTilesReadyTimer: number | null = null

const ionToken = (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined)?.trim() ?? ""
const customTerrainUrl = ((import.meta.env.VITE_OFFLINE_TERRAIN_URL as string | undefined)?.trim()
  || (import.meta.env.VITE_DEM_TERRAIN_URL as string | undefined)?.trim()
  || "")
const worldImageryEnabled = ionToken.length > 0 && import.meta.env.VITE_ENABLE_WORLD_IMAGERY !== "false"
const worldTerrainEnabled = ionToken.length > 0 && import.meta.env.VITE_ENABLE_WORLD_TERRAIN === "true"
const osmBuildingsEnabled = ionToken.length > 0 && import.meta.env.VITE_ENABLE_OSM_BUILDINGS === "true"
const terrainRequested = customTerrainUrl.length > 0 || worldTerrainEnabled
const imageryTilesReady = ref(!worldImageryEnabled)

function degreesArray(points: GeoPoint[]): number[] {
  return points.flatMap((point) => [point.longitude, point.latitude])
}

function degreesArrayHeights(points: GeoPoint[]): number[] {
  return points.flatMap((point) => [point.longitude, point.latitude, point.altitude + groundHeight(point)])
}

function sceneImageryRectangle(): Rectangle | undefined {
  const positions = props.scene?.boundary.positions ?? []
  if (positions.length < 3) return undefined
  const valid = positions.filter((point) => Number.isFinite(point.longitude) && Number.isFinite(point.latitude))
  if (valid.length < 3) return undefined
  return Rectangle.fromDegrees(
    Math.min(...valid.map((point) => point.longitude)),
    Math.min(...valid.map((point) => point.latitude)),
    Math.max(...valid.map((point) => point.longitude)),
    Math.max(...valid.map((point) => point.latitude))
  )
}

function sceneMaskHierarchy(): PolygonHierarchy | null {
  const positions = props.scene?.boundary.positions ?? []
  const valid = positions.filter((point) => Number.isFinite(point.longitude) && Number.isFinite(point.latitude))
  if (valid.length < 3) return null
  const west = Math.min(...valid.map((point) => point.longitude))
  const east = Math.max(...valid.map((point) => point.longitude))
  const south = Math.min(...valid.map((point) => point.latitude))
  const north = Math.max(...valid.map((point) => point.latitude))
  const longitudePadding = Math.max((east - west) * 1.2, 0.02)
  const latitudePadding = Math.max((north - south) * 1.2, 0.02)
  const outerWest = Math.max(-180, west - longitudePadding)
  const outerEast = Math.min(180, east + longitudePadding)
  const outerSouth = Math.max(-90, south - latitudePadding)
  const outerNorth = Math.min(90, north + latitudePadding)
  return new PolygonHierarchy(
    Cartesian3.fromDegreesArray([outerWest, outerSouth, outerEast, outerSouth, outerEast, outerNorth, outerWest, outerNorth]),
    [new PolygonHierarchy(Cartesian3.fromDegreesArray(degreesArray(valid)))]
  )
}

function terrainKey(point: GeoPoint): string {
  return `${point.longitude.toFixed(6)}:${point.latitude.toFixed(6)}`
}

function groundHeight(point: GeoPoint): number {
  return point.groundHeightMeters ?? terrainHeightCache.get(terrainKey(point)) ?? 0
}

function relativeHeightReference(): HeightReference {
  return HeightReference.RELATIVE_TO_GROUND
}

function emitMapDataState() {
  emit("mapDataState", {
    imagery: imageryState.value,
    terrain: terrainState.value,
    buildings: buildingsState.value,
    terrainSource: terrainSource.value
  })
}

function fallbackImageryUrl(): string {
  const configured = ((import.meta.env.VITE_MAP_TILE_URL as string | undefined) ?? "https://tile.openstreetmap.org/").trim()
  const baseUrl = configured.replace(/\{z\}\/\{x\}\/\{y\}\.png\/?$/, "")
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
}

function removeFallbackImagery() {
  removeFallbackImageryError?.()
  removeFallbackImageryError = null
  if (fallbackImageryLayer && viewer && !viewer.isDestroyed()) viewer.imageryLayers.remove(fallbackImageryLayer, true)
  fallbackImageryLayer = null
  fallbackImageryAdded = false
}

function resetImageryTileReadiness() {
  imageryTilesReady.value = !worldImageryEnabled
  if (imageryTilesReadyTimer !== null) window.clearTimeout(imageryTilesReadyTimer)
  imageryTilesReadyTimer = window.setTimeout(() => {
    imageryTilesReady.value = true
    imageryTilesReadyTimer = null
  }, 10_000)
}

function addFallbackImagery() {
  if (!viewer || fallbackImageryAdded) return
  const rectangle = sceneImageryRectangle()
  const provider: ImageryProvider = new OpenStreetMapImageryProvider({
    url: fallbackImageryUrl(),
    ...(rectangle ? { rectangle } : {})
  })
  fallbackImageryLayer = viewer.imageryLayers.addImageryProvider(provider)
  fallbackImageryAdded = true
  removeFallbackImageryError = provider.errorEvent.addEventListener(() => {
    if (!viewer || viewer.isDestroyed()) return
    imageryState.value = "failed"
    emitMapDataState()
    viewer.scene.requestRender()
  })
}

function removeRealityImagery() {
  removeRealityImageryError?.()
  removeRealityImageryError = null
  if (realityImageryLayer && viewer && !viewer.isDestroyed()) viewer.imageryLayers.remove(realityImageryLayer, true)
  realityImageryLayer = null
}

async function loadWorldImagery() {
  if (!viewer || !worldImageryEnabled) return
  const generation = ++imageryLoadGeneration
  resetImageryTileReadiness()
  removeRealityImagery()
  imageryState.value = "loading"
  emitMapDataState()

  try {
    Ion.defaultAccessToken = ionToken
    const imageryProvider = generation === 1
      ? await createWorldImageryAsync()
      : await IonImageryProvider.fromAssetId(IonWorldImageryStyle.AERIAL, {
        server: (typeof Ion.defaultServer === "string" ? new Resource({ url: Ion.defaultServer }) : Ion.defaultServer).getDerivedResource({
          queryParameters: { __wurenji_imagery_retry: `${Date.now()}-${generation}` }
        })
      })
    if (!viewer || viewer.isDestroyed() || generation !== imageryLoadGeneration) return
    const rectangle = sceneImageryRectangle()
    const imageryLayer = new ImageryLayer(imageryProvider, rectangle ? { rectangle } : undefined)
    realityImageryLayer = imageryLayer
    viewer.imageryLayers.add(imageryLayer)
    let failed = false
    removeRealityImageryError = imageryProvider.errorEvent.addEventListener(() => {
      if (failed || generation !== imageryLoadGeneration || !viewer || viewer.isDestroyed()) return
      failed = true
      removeRealityImagery()
      addFallbackImagery()
      imageryState.value = "degraded"
      emitMapDataState()
      viewer.scene.requestRender()
    })
    removeFallbackImagery()
    imageryState.value = "ready"
    emitMapDataState()
    viewer.scene.requestRender()
  } catch {
    if (!viewer || viewer.isDestroyed() || generation !== imageryLoadGeneration) return
    removeRealityImagery()
    addFallbackImagery()
    imageryState.value = "degraded"
    emitMapDataState()
  }
}

async function reloadImagery() {
  if (!viewer) return
  if (worldImageryEnabled) {
    await loadWorldImagery()
    return
  }

  imageryLoadGeneration += 1
  resetImageryTileReadiness()
  removeFallbackImagery()
  imageryState.value = "loading"
  emitMapDataState()
  addFallbackImagery()
  imageryState.value = fallbackImageryLayer ? "disabled" : "failed"
  emitMapDataState()
}

async function refineGroundHeight(point: GeoPoint): Promise<GeoPoint> {
  if (!terrainProvider) return { ...point, groundHeightMeters: point.groundHeightMeters ?? 0, heightSource: "ELLIPSOID" }
  try {
    const [sample] = await sampleTerrainMostDetailed(terrainProvider, [Cartographic.fromDegrees(point.longitude, point.latitude)])
    const height = sample?.height ?? point.groundHeightMeters ?? 0
    terrainHeightCache.set(terrainKey(point), height)
    return { ...point, groundHeightMeters: height, heightSource: "TERRAIN" }
  } catch {
    return { ...point, groundHeightMeters: point.groundHeightMeters ?? 0, heightSource: "ELLIPSOID" }
  }
}

async function ensureTerrainHeights(points: GeoPoint[]) {
  if (!terrainProvider) return
  const unique = new Map<string, GeoPoint>()
  for (const point of points) {
    const key = terrainKey(point)
    if (!terrainHeightCache.has(key) && !pendingTerrainKeys.has(key)) unique.set(key, point)
  }
  if (unique.size === 0) return
  for (const key of unique.keys()) pendingTerrainKeys.add(key)
  const entries = [...unique.entries()]
  try {
    const samples = await sampleTerrainMostDetailed(
      terrainProvider,
      entries.map(([, point]) => Cartographic.fromDegrees(point.longitude, point.latitude))
    )
    samples.forEach((sample, index) => terrainHeightCache.set(entries[index]![0], sample.height ?? 0))
    addPlanEntities()
  } catch {
  } finally {
    for (const key of unique.keys()) pendingTerrainKeys.delete(key)
  }
}

function addVertexHandles(kind: "boundary" | "noFly", ownerId: string, points: GeoPoint[], color: Color) {
  points.forEach((point, index) => sceneSource?.entities.add({
    id: `vertex:${kind}:${ownerId}:${index}`,
    name: `顶点 ${index + 1}`,
    position: Cartesian3.fromDegrees(point.longitude, point.latitude, 2),
    point: {
      pixelSize: 12,
      color,
      outlineColor: Color.WHITE,
      outlineWidth: 3,
      heightReference: relativeHeightReference(),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    }
  }))
}

function pickedEntityId(position: Cartesian2): string | null {
  if (!viewer) return null
  const picked = viewer.scene.pick(position) as { id?: Entity | string } | undefined
  if (picked?.id instanceof Entity) return picked.id.id
  return typeof picked?.id === "string" ? picked.id : null
}

function isDraggableEntity(id: string): boolean {
  if (id.startsWith("waypoint:")) return props.plan !== null
  if (props.plan) return false
  return id === "takeoff:main"
    || id === "landing:main"
    || id.startsWith("task:")
    || id.startsWith("obstacle:")
    || id.startsWith("vertex:")
}

function addSceneEntities() {
  if (!sceneSource || !props.scene) return
  sceneSource.entities.removeAll()
  const scene = props.scene
  const boundarySelected = props.selectedObjectId === `boundary:${scene.boundary.id}`
  const maskHierarchy = sceneMaskHierarchy()
  if (maskHierarchy) {
    sceneSource.entities.add({
      id: "teaching-region-mask",
      name: "教学区域外",
      polygon: {
        hierarchy: maskHierarchy,
        material: mapColorAlpha(mapRegionColors.mask, mapRegionColors.maskAlpha),
        heightReference: renderedMode.value === "3d" ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE
      }
    })
  }

  sceneSource.entities.add({
    id: `boundary:${scene.boundary.id}`,
    name: scene.boundary.name,
    polygon: {
      hierarchy: Cartesian3.fromDegreesArray(degreesArray(scene.boundary.positions)),
      material: mapColorAlpha(mapRegionColors.boundary, boundarySelected ? 0.2 : mapRegionColors.boundaryFillAlpha),
      outline: true,
      outlineColor: boundarySelected ? mapColor(mapInteractionColors.selected) : mapColor(mapRegionColors.boundary),
      heightReference: renderedMode.value === "3d" ? HeightReference.CLAMP_TO_GROUND : HeightReference.NONE
    }
  })

  sceneSource.entities.add({
    id: "landing:main",
    name: "降落点 B",
    position: Cartesian3.fromDegrees(scene.landingPoint.longitude, scene.landingPoint.latitude, 1.5),
    ellipse: {
      semiMajorAxis: 17,
      semiMinorAxis: 17,
      material: mapColorAlpha(mapPoiColors.landingPoint, props.selectedObjectId === "landing:main" ? 0.6 : 0.38),
      outline: true,
      outlineColor: props.selectedObjectId === "landing:main" ? mapColor(mapInteractionColors.selected) : mapColor(mapPoiColors.landingPoint),
      heightReference: relativeHeightReference()
    },
    label: labelStyle("降落点 B", mapPoiColors.landingPointLabel, new Cartesian2(0, 30))
  })

  sceneSource.entities.add({
    id: "takeoff:main",
    name: "起降区 A",
    position: Cartesian3.fromDegrees(scene.takeoffPoint.longitude, scene.takeoffPoint.latitude, 1),
    ellipse: {
      semiMajorAxis: 28,
      semiMinorAxis: 28,
      material: mapColorAlpha(mapPoiColors.takeoffLanding, props.selectedObjectId === "takeoff:main" ? 0.5 : 0.28),
      outline: true,
      outlineColor: props.selectedObjectId === "takeoff:main" ? mapColor(mapInteractionColors.selected) : mapColor(mapPoiColors.takeoffLanding),
      heightReference: relativeHeightReference()
    },
    label: labelStyle("起降区 A", mapPoiColors.takeoffLabel, new Cartesian2(0, -34))
  })

  for (const zone of scene.noFlyZones) {
    const selected = props.selectedObjectId === `noFly:${zone.id}`
    sceneSource.entities.add({
      id: `noFly:${zone.id}`,
      name: zone.name,
      polygon: {
        hierarchy: Cartesian3.fromDegreesArray(degreesArray(zone.positions)),
        height: zone.minimumAltitudeMeters,
        extrudedHeight: zone.maximumAltitudeMeters,
        heightReference: relativeHeightReference(),
        extrudedHeightReference: relativeHeightReference(),
        material: mapColorAlpha(mapRestrictionColors.fill, selected ? 0.42 : 0.25),
        outline: true,
        outlineColor: selected ? mapColor(mapInteractionColors.selected) : mapColor(mapRestrictionColors.fill)
      }
    })
    if (selected) addVertexHandles("noFly", zone.id, zone.positions, mapColor(mapRestrictionColors.fill))
  }

  for (const obstacle of scene.obstacles) {
    const selected = props.selectedObjectId === `obstacle:${obstacle.id}`
    sceneSource.entities.add({
      id: `obstacle:${obstacle.id}`,
      name: obstacle.name,
      position: Cartesian3.fromDegrees(obstacle.center.longitude, obstacle.center.latitude, obstacle.heightMeters / 2),
      box: {
        dimensions: new Cartesian3(obstacle.widthMeters, obstacle.lengthMeters, obstacle.heightMeters),
        heightReference: relativeHeightReference(),
        material: (selected ? mapColor(mapInteractionColors.selected) : mapColor(mapObstacleColors.box)).withAlpha(0.82),
        outline: true,
        outlineColor: Color.WHITE.withAlpha(0.7)
      }
    })
  }

  for (const task of scene.taskPoints) {
    const selected = props.selectedObjectId === `task:${task.id}`
    sceneSource.entities.add({
      id: `task:${task.id}`,
      name: task.name,
      position: Cartesian3.fromDegrees(task.position.longitude, task.position.latitude, task.position.altitude),
      point: {
        pixelSize: selected ? 15 : 10,
        color: selected
          ? mapColor(mapInteractionColors.selected)
          : scene.type === "CITY_LOGISTICS" ? mapColor(mapPoiColors.deliveryPoint) : mapColor(mapPoiColors.inspectionPoint),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        heightReference: relativeHeightReference(),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: labelStyle(task.name, mapInteractionColors.labelInk, new Cartesian2(10, -14))
    })
  }

  if (boundarySelected) addVertexHandles("boundary", scene.boundary.id, scene.boundary.positions, mapColor(mapRegionColors.boundary))

  if (props.drawingPoints.length > 0) {
    sceneSource.entities.add({
      id: "drawing:active",
      polyline: {
        positions: Cartesian3.fromDegreesArray(degreesArray(props.drawingPoints)),
        width: 3,
        clampToGround: true,
        material: mapColor(mapInteractionColors.drawing)
      }
    })
    props.drawingPoints.forEach((point, index) => sceneSource?.entities.add({
      id: `drawing:${index}`,
      position: Cartesian3.fromDegrees(point.longitude, point.latitude, 2),
      point: { pixelSize: 8, color: mapColor(mapInteractionColors.drawing), outlineColor: Color.WHITE, outlineWidth: 2, heightReference: relativeHeightReference() }
    }))
  }

  viewer?.scene.requestRender()
}

function labelStyle(text: string, color: string, offset: Cartesian2) {
  return {
    text,
    font: "12px Microsoft YaHei, sans-serif",
    fillColor: Color.fromCssColorString(color),
    showBackground: true,
    backgroundColor: Color.WHITE.withAlpha(0.88),
    backgroundPadding: new Cartesian2(6, 4),
    pixelOffset: offset,
    horizontalOrigin: HorizontalOrigin.LEFT,
    verticalOrigin: VerticalOrigin.CENTER,
    heightReference: relativeHeightReference(),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    distanceDisplayCondition: new DistanceDisplayCondition(0, 6000)
  }
}

function addPlanEntities() {
  if (!planSource) return
  planSource.entities.removeAll()
  if (!props.plan) return
  void ensureTerrainHeights(props.plan.dronePlans.flatMap((drone) => drone.waypoints.map((waypoint) => waypoint.position)))
  const colors = mapRouteColors.multiDronePalette
  props.plan.dronePlans.forEach((drone, index) => {
    if (drone.waypoints.length < 2) return
    const color = mapColor(colors[index % colors.length]!)
    const droneSelected = props.selectedDroneId === drone.droneId
    planSource?.entities.add({
      id: `route:${drone.droneId}`,
      name: `${drone.droneId} 航线`,
      polyline: {
        positions: Cartesian3.fromDegreesArrayHeights(degreesArrayHeights(drone.waypoints.map((waypoint) => waypoint.position))),
        width: droneSelected ? 5 : 2,
        material: color.withAlpha(droneSelected ? 1 : 0.6)
      }
    })
    drone.waypoints.forEach((waypoint, waypointIndex) => {
      const waypointId = `waypoint:${drone.droneId}:${waypoint.id}`
      const selected = props.selectedObjectId === waypointId
      planSource?.entities.add({
        id: waypointId,
        position: Cartesian3.fromDegrees(waypoint.position.longitude, waypoint.position.latitude, waypoint.position.altitude),
        point: {
          pixelSize: selected ? 14 : waypointIndex === 0 || waypointIndex === drone.waypoints.length - 1 ? 9 : 7,
          color: selected ? mapColor(mapInteractionColors.selected) : color,
          outlineColor: Color.WHITE,
          outlineWidth: selected ? 3 : 1,
          heightReference: relativeHeightReference(),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      })
    })
  })
  viewer?.scene.requestRender()
}

function createSimulationEntities() {
  if (!simulationSource) return
  simulationSource.entities.removeAll()
  droneEntities.clear()
  if (!props.result) return
  const colors = mapRouteColors.multiDronePalette
  props.result.tracks.forEach((track, index) => {
    const sample = track.samples[0]
    if (!sample) return
    const entity = simulationSource?.entities.add({
      id: `simulation:${track.droneId}`,
      name: track.droneId,
      position: Cartesian3.fromDegrees(sample.position.longitude, sample.position.latitude, sample.position.altitude),
      point: {
        pixelSize: 12,
        color: mapColor(colors[index % colors.length]!),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        heightReference: relativeHeightReference(),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      },
      label: labelStyle(track.droneId, mapInteractionColors.droneLabelInk, new Cartesian2(9, -15))
    })
    if (entity) droneEntities.set(track.droneId, entity)
  })
  updatePlayback()
}

function updatePlayback() {
  if (!props.result) return
  for (const track of props.result.tracks) {
    const entity = droneEntities.get(track.droneId)
    if (!entity || track.samples.length === 0) continue
    const step = track.samples.length > 1 ? track.samples[1]!.timeSeconds - track.samples[0]!.timeSeconds : 0.2
    const index = Math.max(0, Math.min(track.samples.length - 1, Math.round(props.playbackTime / Math.max(step, 0.01))))
    const sample = track.samples[index]!
    entity.position = new ConstantPositionProperty(
      Cartesian3.fromDegrees(sample.position.longitude, sample.position.latitude, sample.position.altitude)
    )
  }
  viewer?.scene.requestRender()
}

function showFinding() {
  if (!diagnosticSource) return
  diagnosticSource.entities.removeAll()
  const finding = props.selectedFinding
  if (!finding?.position || !viewer) return
  const position = Cartesian3.fromDegrees(finding.position.longitude, finding.position.latitude, finding.position.altitude)
  diagnosticSource.entities.add({
    id: `finding:${finding.id}`,
    position,
    point: {
      pixelSize: 18,
      color: mapColor(mapInteractionColors.alert),
      outlineColor: Color.WHITE,
      outlineWidth: 3,
      heightReference: relativeHeightReference(),
      disableDepthTestDistance: Number.POSITIVE_INFINITY
    },
    label: labelStyle("!", mapInteractionColors.hover, new Cartesian2(-2, 0))
  })
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(finding.position.longitude, finding.position.latitude, Math.max(280, finding.position.altitude + 220)),
    orientation: { heading: 0, pitch: CesiumMath.toRadians(-70), roll: 0 },
    duration: 0.6
  })
}

function cartesianFromScreen(position: Cartesian2): Cartesian3 | null {
  if (!viewer) return null
  const ray = viewer.camera.getPickRay(position)
  return (ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined)
    ?? viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
    ?? null
}

function updatePlacementPreview(position: Cartesian2) {
  if (!sceneSource || !viewer || props.activeTool === "select") return
  const cartesian = cartesianFromScreen(position)
  if (!cartesian) return
  if (props.scene) {
    const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian)
    const point: GeoPoint = {
      longitude: CesiumMath.toDegrees(cartographic.longitude),
      latitude: CesiumMath.toDegrees(cartographic.latitude),
      altitude: 0,
      groundHeightMeters: cartographic.height,
      heightSource: terrainProvider ? "TERRAIN" : "ELLIPSOID"
    }
    if (!isPointInsidePolygon(point, props.scene.boundary.positions)) {
      clearPlacementPreview()
      mapInteractionState.value = "outside-region"
      return
    }
  }
  let preview = sceneSource.entities.getById("placement:preview")
  if (!preview) {
    preview = sceneSource.entities.add({
      id: "placement:preview",
      position: cartesian,
      point: {
        pixelSize: 13,
        color: mapColorAlpha(mapInteractionColors.selected, 0.72),
        outlineColor: Color.WHITE,
        outlineWidth: 2,
        heightReference: relativeHeightReference(),
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    })
  } else {
    preview.position = new ConstantPositionProperty(cartesian)
  }
  viewer.scene.requestRender()
}

function clearPlacementPreview() {
  sceneSource?.entities.removeById("placement:preview")
  viewer?.scene.requestRender()
}

function handleLeftClick(event: { position: Cartesian2 }) {
  if (!viewer) return
  if (props.activeTool === "select") {
    mapInteractionState.value = "select"
    const id = pickedEntityId(event.position)
    if (id === "teaching-region-mask") {
      mapInteractionState.value = "outside-region"
      return
    }
    if (id) emit("selectObject", selectionIdForMapEntity(id))
    return
  }
  const cartesian = cartesianFromScreen(event.position)
  if (!cartesian) {
    mapInteractionState.value = "pick-error"
    emit("mapPickError")
    return
  }
  const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian)
  const point: GeoPoint = {
    longitude: CesiumMath.toDegrees(cartographic.longitude),
    latitude: CesiumMath.toDegrees(cartographic.latitude),
    altitude: 0,
    groundHeightMeters: cartographic.height,
    heightSource: terrainProvider ? "TERRAIN" : "ELLIPSOID"
  }
  if (props.scene && !isPointInsidePolygon(point, props.scene.boundary.positions)) {
    mapInteractionState.value = "outside-region"
    clearPlacementPreview()
    return
  }
  mapInteractionState.value = `emit:${props.activeTool}`
  emit("mapClick", point)
}

function handleCanvasClick(event: MouseEvent) {
  if (!viewer) return
  nativeClickCount.value += 1
  if (suppressNextCanvasClick) {
    suppressNextCanvasClick = false
    mapInteractionState.value = "suppressed"
    return
  }
  const bounds = viewer.scene.canvas.getBoundingClientRect()
  handleLeftClick({ position: new Cartesian2(event.clientX - bounds.left, event.clientY - bounds.top) })
}

function handleLeftDown(event: { position: Cartesian2 }) {
  if (!viewer || props.activeTool !== "select") return
  const id = pickedEntityId(event.position)
  if (!id || !isDraggableEntity(id)) return
  dragTargetId = id
  dragging.value = true
  viewer.scene.screenSpaceCameraController.enableInputs = false
  emit("selectObject", selectionIdForMapEntity(id))
  emit("editState", true)
}

function handleMouseMove(event: { endPosition: Cartesian2 }) {
  if (!viewer) return
  if (!dragTargetId) {
    updatePlacementPreview(event.endPosition)
    return
  }
  const cartesian = cartesianFromScreen(event.endPosition)
  if (!cartesian) return
  const cartographic = viewer.scene.globe.ellipsoid.cartesianToCartographic(cartesian)
  lastDragPoint = {
    longitude: CesiumMath.toDegrees(cartographic.longitude),
    latitude: CesiumMath.toDegrees(cartographic.latitude),
    altitude: 0,
    groundHeightMeters: cartographic.height,
    heightSource: terrainProvider ? "TERRAIN" : "ELLIPSOID"
  }
  emit("moveObject", dragTargetId, lastDragPoint)
}

function finishDrag() {
  if (!dragTargetId && !dragging.value) return
  const completedTargetId = dragTargetId
  const completedPoint = lastDragPoint
  if (completedTargetId && completedPoint) suppressNextCanvasClick = true
  dragTargetId = ""
  lastDragPoint = null
  dragging.value = false
  if (viewer) viewer.scene.screenSpaceCameraController.enableInputs = true
  emit("editState", false)
  if (completedTargetId && completedPoint) {
    void refineGroundHeight(completedPoint).then((refined) => emit("moveObject", completedTargetId, refined))
  }
}

function focusFromCamera() {
  if (!viewer) return null
  const canvas = viewer.scene.canvas
  const screenCenter = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
  const target = cartesianFromScreen(screenCenter)
    ?? (props.scene?.boundary.positions.length
      ? BoundingSphere.fromPoints(props.scene.boundary.positions.map((point) => Cartesian3.fromDegrees(point.longitude, point.latitude))).center
      : null)
  if (!target) return null
  return {
    target,
    range: Math.max(25, Cartesian3.distance(viewer.camera.positionWC, target))
  }
}

function rememberCameraFocus() {
  const focus = focusFromCamera()
  if (focus) viewFocus = { target: focus.target.clone(), range: focus.range }
}

function lookAtCurrentFocus(heading: number, pitch: number) {
  if (!viewer) return false
  const focus = viewFocus ?? focusFromCamera()
  if (!focus) return false
  viewer.camera.cancelFlight()
  viewer.camera.lookAt(focus.target, new HeadingPitchRange(heading, pitch, focus.range))
  viewer.camera.lookAtTransform(Matrix4.IDENTITY)
  viewer.scene.requestRender()
  return true
}

function refreshRenderedMode(mode: "2d" | "3d") {
  renderedMode.value = mode
  if (buildingsTileset) buildingsTileset.show = mode === "3d"
  addSceneEntities()
  addPlanEntities()
  createSimulationEntities()
  showFinding()
  viewer?.scene.requestRender()
  emit("modeComplete", mode)
}

function setMode(mode: "2d" | "3d") {
  if (!viewer || !cameraReady || renderedMode.value === mode) return
  viewer.camera.completeFlight()
  if (renderedMode.value === "3d") threeDimensionalHeading = viewer.camera.heading
  const heading = mode === "2d" ? viewer.camera.heading : threeDimensionalHeading
  const pitch = mode === "2d" ? -CesiumMath.PI_OVER_TWO : CesiumMath.toRadians(-55)
  lookAtCurrentFocus(heading, pitch)
  refreshRenderedMode(mode)
}

async function initializeRealityLayers() {
  if (!viewer) return
  if (ionToken) Ion.defaultAccessToken = ionToken
  imageryState.value = worldImageryEnabled ? "loading" : "disabled"
  terrainState.value = terrainRequested ? "loading" : "disabled"
  buildingsState.value = osmBuildingsEnabled ? "loading" : "disabled"
  emitMapDataState()

  if (worldImageryEnabled) await loadWorldImagery()

  if (terrainRequested) {
    let loadedProvider: TerrainProvider | null = null
    try {
      if (customTerrainUrl) {
        loadedProvider = await CesiumTerrainProvider.fromUrl(customTerrainUrl, {
          requestVertexNormals: true,
          requestWaterMask: true
        })
        terrainSource.value = "CUSTOM_DEM"
      }
    } catch {
      loadedProvider = null
    }
    if (!loadedProvider && worldTerrainEnabled) {
      try {
        loadedProvider = await createWorldTerrainAsync({ requestVertexNormals: true, requestWaterMask: true })
        terrainSource.value = "WORLD_TERRAIN"
      } catch {
        loadedProvider = null
      }
    }
    if (loadedProvider && viewer) {
      terrainProvider = loadedProvider
      viewer.terrainProvider = loadedProvider
      terrainState.value = "ready"
      addSceneEntities()
      addPlanEntities()
    } else {
      terrainProvider = null
      terrainSource.value = "ELLIPSOID"
      terrainState.value = "failed"
    }
    emitMapDataState()
  }

  if (osmBuildingsEnabled) {
    try {
      buildingsTileset = await createOsmBuildingsAsync()
      if (!viewer) return
      buildingsTileset.show = renderedMode.value === "3d"
      viewer.scene.primitives.add(buildingsTileset)
      buildingsState.value = "ready"
      viewer.scene.requestRender()
    } catch {
      buildingsTileset = null
      buildingsState.value = "failed"
    }
    emitMapDataState()
  }
}

function flyHome(duration = 0.8) {
  if (!viewer || !props.scene) return
  const boundary = props.scene.boundary.positions
  if (boundary.length < 3) return
  const sphere = BoundingSphere.fromPoints(boundary.map((point) => Cartesian3.fromDegrees(point.longitude, point.latitude, 0)))
  const offset = new HeadingPitchRange(
    renderedMode.value === "2d" ? 0 : threeDimensionalHeading,
    renderedMode.value === "2d" ? -CesiumMath.PI_OVER_TWO : CesiumMath.toRadians(-55),
    Math.max(250, sphere.radius * 2.8)
  )
  viewFocus = { target: sphere.center.clone(), range: offset.range }
  if (duration === 0) {
    viewer.camera.cancelFlight()
    viewer.camera.lookAt(sphere.center, offset)
    viewer.camera.lookAtTransform(Matrix4.IDENTITY)
    viewer.scene.requestRender()
    return
  }
  viewer.camera.flyToBoundingSphere(sphere, {
    offset,
    duration,
    complete: rememberCameraFocus
  })
}

function rotateLeft() {
  if (!viewer) return
  resetImageryTileReadiness()
  viewer.camera.completeFlight()
  const heading = viewer.camera.heading - CesiumMath.toRadians(15)
  lookAtCurrentFocus(heading, viewer.camera.pitch)
  if (renderedMode.value === "3d") threeDimensionalHeading = heading
}

function rotateRight() {
  if (!viewer) return
  viewer.camera.completeFlight()
  const heading = viewer.camera.heading + CesiumMath.toRadians(15)
  lookAtCurrentFocus(heading, viewer.camera.pitch)
  if (renderedMode.value === "3d") threeDimensionalHeading = heading
}

function resetNorth() {
  if (!viewer) return
  viewer.camera.completeFlight()
  lookAtCurrentFocus(0, renderedMode.value === "2d" ? -CesiumMath.PI_OVER_TWO : viewer.camera.pitch)
  if (renderedMode.value === "3d") threeDimensionalHeading = 0
}

function configureSceneCameraConstraints() {
  removeCameraConstraints?.()
  removeCameraConstraints = null
  if (!viewer || !props.scene || props.scene.boundary.positions.length < 3) return
  removeCameraConstraints = configureRegionMapConstraints(viewer, {
    boundary: props.scene.boundary.positions.map((point) => ({
      longitude: point.longitude,
      latitude: point.latitude
    }))
  })
}

onMounted(async () => {
  if (!container.value) return
  viewer = createUnifiedCesiumViewer(container.value)
  viewerReady.value = true
  removePerformanceTuning = configureV3CesiumPerformance(viewer, "EDIT")
  viewer.scene.globe.baseColor = mapColor(mapBasemapColors.emptyCanvas)
  viewer.scene.globe.depthTestAgainstTerrain = true
  removeTileLoadProgress = viewer.scene.globe.tileLoadProgressEvent.addEventListener((pendingTiles) => {
    if (pendingTiles > 0) {
      imageryTilesReady.value = false
      return
    }
    if (["loading", "ready", "degraded"].includes(imageryState.value)) imageryTilesReady.value = true
  })
  viewer.imageryLayers.addImageryProvider(new GridImageryProvider({
    color: mapColor(mapBasemapColors.gridFallbackStroke),
    glowColor: mapColor(mapBasemapColors.gridFallbackGlow),
    backgroundColor: mapColor(mapBasemapColors.emptyCanvas),
    cells: 12
  }))
  if (!worldImageryEnabled) addFallbackImagery()
  sceneSource = await viewer.dataSources.add(new CustomDataSource("teacher-scene"))
  planSource = await viewer.dataSources.add(new CustomDataSource("student-plan"))
  simulationSource = await viewer.dataSources.add(new CustomDataSource("simulation"))
  diagnosticSource = await viewer.dataSources.add(new CustomDataSource("diagnostic"))
  configureSceneCameraConstraints()
  if (import.meta.env.DEV) {
    window.__wurenjiMapTest = {
      entityScreenPosition(id: string) {
        if (!viewer) return null
        const sources = [sceneSource, planSource, simulationSource, diagnosticSource]
        const entity = sources.flatMap((source) => source ? [source.entities.getById(id)] : []).find(Boolean)
        const worldPosition = entity?.position?.getValue(viewer.clock.currentTime)
        if (!worldPosition) return null
        const screenPosition = SceneTransforms.worldToWindowCoordinates(viewer.scene, worldPosition)
        return screenPosition ? { x: screenPosition.x, y: screenPosition.y } : null
      },
      geoPointScreenPosition(longitude: number, latitude: number, altitude = 0) {
        if (!viewer) return null
        const screenPosition = SceneTransforms.worldToWindowCoordinates(
          viewer.scene,
          Cartesian3.fromDegrees(longitude, latitude, altitude)
        )
        return screenPosition ? { x: screenPosition.x, y: screenPosition.y } : null
      },
      viewState() {
        if (!viewer) return null
        const cameraPosition = viewer.scene.globe.ellipsoid.cartesianToCartographic(viewer.camera.positionWC)
        const focusPosition = viewFocus
          ? viewer.scene.globe.ellipsoid.cartesianToCartographic(viewFocus.target)
          : null
        return {
          camera: {
            longitude: CesiumMath.toDegrees(cameraPosition.longitude),
            latitude: CesiumMath.toDegrees(cameraPosition.latitude),
            height: cameraPosition.height,
            heading: viewer.camera.heading,
            pitch: viewer.camera.pitch
          },
          focus: focusPosition && viewFocus ? {
            longitude: CesiumMath.toDegrees(focusPosition.longitude),
            latitude: CesiumMath.toDegrees(focusPosition.latitude),
            height: focusPosition.height,
            range: viewFocus.range
          } : null,
          ready: cameraReady
        }
      }
    }
  }
  handler = new ScreenSpaceEventHandler(viewer.scene.canvas)
  handler.setInputAction(handleLeftDown, ScreenSpaceEventType.LEFT_DOWN)
  handler.setInputAction(handleMouseMove, ScreenSpaceEventType.MOUSE_MOVE)
  handler.setInputAction(finishDrag, ScreenSpaceEventType.LEFT_UP)
  viewer.scene.canvas.addEventListener("click", handleCanvasClick)
  addSceneEntities()
  addPlanEntities()
  createSimulationEntities()
  flyHome(0)
  cameraReady = true
  viewer.camera.moveEnd.addEventListener(rememberCameraFocus)
  setMode(props.mode)
  void initializeRealityLayers()
})

onBeforeUnmount(() => {
  finishDrag()
  imageryLoadGeneration += 1
  removeTileLoadProgress?.()
  removeTileLoadProgress = null
  if (imageryTilesReadyTimer !== null) window.clearTimeout(imageryTilesReadyTimer)
  imageryTilesReadyTimer = null
  removeRealityImagery()
  removeFallbackImagery()
  viewerReady.value = false
  removeCameraConstraints?.()
  removeCameraConstraints = null
  removePerformanceTuning?.()
  removePerformanceTuning = null
  viewer?.scene.canvas.removeEventListener("click", handleCanvasClick)
  handler?.destroy()
  viewer?.destroy()
  handler = null
  viewer = null
  cameraReady = false
  viewFocus = null
  if (import.meta.env.DEV) delete window.__wurenjiMapTest
})

watch(() => [props.scene, props.drawingPoints, props.selectedObjectId], addSceneEntities, { deep: true })
watch(() => props.scene?.id, (id, previousId) => {
  if (id && id !== previousId) {
    configureSceneCameraConstraints()
    flyHome(0)
    resetImageryTileReadiness()
    void reloadImagery()
  }
})
watch(() => [props.plan, props.selectedObjectId, props.selectedDroneId], addPlanEntities, { deep: true })
watch(() => props.result, createSimulationEntities, { deep: true })
watch(() => props.playbackTime, updatePlayback)
watch(() => props.selectedFinding, showFinding)
watch(() => props.mode, setMode)
watch(() => props.activeTool, (tool) => {
  if (tool === "select") clearPlacementPreview()
})

defineExpose({ setMode, flyHome, rotateLeft, rotateRight, resetNorth, reloadImagery })
</script>

<template>
  <div
    ref="container"
    class="cesium-map"
    :class="{ 'is-edit-tool': activeTool !== 'select', 'is-dragging': dragging }"
    :data-scene-mode="renderedMode"
    :data-imagery-state="imageryState"
    :data-terrain-state="terrainState"
    :data-terrain-source="terrainSource"
    :data-buildings-state="buildingsState"
    :data-map-interaction="mapInteractionState"
    :data-native-click-count="nativeClickCount"
  >
    <V3MapScaleBar :viewer="viewerReady ? viewer : null" :terrain-state="terrainSource" />
    <div v-if="imageryState !== 'disabled' && !imageryTilesReady && imageryState !== 'failed'" class="cesium-map-status" role="status" aria-live="polite">
      <strong>{{ imageryState === 'loading' ? '地图底图连接中' : '地图细节加载中' }}</strong>
      <span>正在加载当前教学区域可见范围</span>
    </div>
    <div v-else-if="imageryState === 'failed'" class="cesium-map-status cesium-map-status--failed" role="alert">
      <strong>地图底图暂不可用</strong>
      <button type="button" @click="reloadImagery">重新加载地图</button>
    </div>
  </div>
</template>

<style scoped>
.cesium-map-status {
  position: absolute;
  z-index: 8;
  top: 14px;
  left: 50%;
  display: grid;
  gap: 3px;
  min-width: 168px;
  transform: translateX(-50%);
  border: 1px solid rgba(29, 69, 55, .18);
  border-radius: 4px;
  padding: 7px 10px;
  color: #294d3f;
  background: rgba(248, 252, 249, .94);
  box-shadow: 0 3px 12px rgba(25, 58, 47, .14);
  pointer-events: none;
  text-align: center;
}

.cesium-map-status strong { font-size: 10px; }
.cesium-map-status span { color: #6d8177; font-size: 11px; }
.cesium-map-status--failed { border-color: rgba(149, 76, 62, .24); color: #8a4c3f; pointer-events: auto; }
.cesium-map-status--failed button { border: 0; padding: 0; color: #8a4c3f; background: transparent; cursor: pointer; font: inherit; font-size: 11px; text-decoration: underline; }

@media (max-width: 560px) {
  .cesium-map-status { top: 14px; max-width: calc(100% - 120px); min-width: 0; }
}
</style>
