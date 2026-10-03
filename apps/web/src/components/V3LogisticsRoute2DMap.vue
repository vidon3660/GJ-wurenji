<script setup lang="ts">
/** Unified Cesium SCENE2D entry for logistics route planning. */
import type {
  LogisticsMapAnnotationInput,
  LogisticsRouteCheckEvidence,
  LogisticsRouteInput,
  ShowAreaDistanceMeasurement,
  ShowAreaMeasuredPoint,
  V3Coordinate,
  V3LogisticsNodeType,
  V3RegionCatalogItem,
  V3RegionLayerCode
} from "@wurenji/shared"
import type { V3MapDataState } from "../map-loading-state"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import { computed } from "vue"

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
  editable: boolean
  addWaypointMode: boolean
  toolMode?: "ANNOTATION" | "MEASURE" | null
  measurement?: ShowAreaDistanceMeasurement | null
  /** Kept for compatibility; evidence is handled by the workspace. */
  evidence?: readonly LogisticsRouteCheckEvidence[]
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

function forwardWaypointSelect(routeId: string, waypointId: string) { emit("waypointSelect", routeId, waypointId) }
function forwardWaypointMoved(routeId: string, waypointId: string, position: V3Coordinate) { emit("waypointMoved", routeId, waypointId, position) }

const mapProps = computed(() => ({
  region: props.region,
  visibleLayers: props.visibleLayers,
  ...(props.visibleNodeTypes ? { visibleNodeTypes: props.visibleNodeTypes } : {}),
  ...(props.showLabels !== undefined ? { showLabels: props.showLabels } : {}),
  selectedDeliveryPointIds: props.selectedDeliveryPointIds,
  routes: props.routes,
  ...(props.annotations ? { annotations: props.annotations } : {}),
  selectedRouteId: props.selectedRouteId,
  selectedWaypointId: props.selectedWaypointId,
  ...(props.selectedAnnotationId !== undefined ? { selectedAnnotationId: props.selectedAnnotationId } : {}),
  mode: "2d" as const,
  editable: props.editable,
  addWaypointMode: props.addWaypointMode,
  ...(props.toolMode !== undefined ? { toolMode: props.toolMode } : {}),
  ...(props.measurement !== undefined ? { measurement: props.measurement } : {})
}))
</script>

<template>
  <div class="v3-logistics-route-2d-map">
    <V3UnifiedMap renderer="logistics-route"
      v-bind="mapProps"
      @node-select="emit('nodeSelect', $event)"
      @route-select="emit('routeSelect', $event)"
      @waypoint-select="forwardWaypointSelect"
      @waypoint-moved="forwardWaypointMoved"
      @waypoint-created="emit('waypointCreated', $event)"
      @annotation-created="emit('annotationCreated', $event)"
      @annotation-select="emit('annotationSelect', $event)"
      @measured="emit('measured', $event)"
      @interaction-cancel="emit('interactionCancel')"
      @edit-start="emit('editStart')"
      @data-state="emit('dataState', $event)"
    />
    <div class="route-2d-map-note">Cesium 二维规划 · 基础边界只读<span v-if="props.addWaypointMode"> · 点击地图添加航点</span></div>
  </div>
</template>

<style scoped>
.v3-logistics-route-2d-map { position: relative; width: 100%; height: 100%; min-height: 420px; }
.v3-logistics-route-2d-map :deep(.v3-logistics-route-map-shell) { min-height: 100%; }
.route-2d-map-note { position: absolute; right: 12px; bottom: 12px; z-index: 2; border: 1px solid rgba(29,69,55,.18); padding: 7px 9px; color: #49675a; background: rgba(255,255,255,.92); font-size: 11px; pointer-events: none; }
</style>
