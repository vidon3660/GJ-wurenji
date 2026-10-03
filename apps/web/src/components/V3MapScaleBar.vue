<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue"
import { Cartesian2, Cartographic, type Viewer } from "cesium"
import { mapScaleDefaults, mapScaleValue, type MapScaleValue } from "../map-scale"
import { regionTerrainStateLabel, type RegionTerrainState } from "../terrain"

const props = withDefaults(defineProps<{
  viewer: Viewer | null
  available?: boolean | undefined
  terrainState?: RegionTerrainState
}>(), {
  available: undefined
})

const scale = ref<MapScaleValue | null>(null)
const elevationMeters = ref<number | null>(null)
let removeCameraChanged: (() => void) | null = null
let removeCameraMoveStart: (() => void) | null = null
let removeCameraMoveEnd: (() => void) | null = null
let removePointerMove: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null
let frameId: number | null = null
let elevationFrameId: number | null = null

function updateScale() {
  frameId = null
  scale.value = props.viewer && !props.viewer.isDestroyed() ? mapScaleValue(props.viewer, mapScaleDefaults.widthPixels) : null
}

function scheduleUpdate() {
  if (frameId !== null) return
  frameId = window.requestAnimationFrame(updateScale)
}

function unbindViewer() {
  removeCameraChanged?.()
  removeCameraChanged = null
  removeCameraMoveStart?.()
  removeCameraMoveStart = null
  removeCameraMoveEnd?.()
  removeCameraMoveEnd = null
  removePointerMove?.()
  removePointerMove = null
  resizeObserver?.disconnect()
  resizeObserver = null
  if (frameId !== null) window.cancelAnimationFrame(frameId)
  frameId = null
  if (elevationFrameId !== null) window.cancelAnimationFrame(elevationFrameId)
  elevationFrameId = null
}

function bindViewer(viewer: Viewer | null) {
  unbindViewer()
  scale.value = null
  elevationMeters.value = null
  if (!viewer || viewer.isDestroyed()) return
  let cameraMoving = false
  removeCameraChanged = viewer.camera.changed.addEventListener(scheduleUpdate)
  removeCameraMoveStart = viewer.camera.moveStart.addEventListener(() => {
    cameraMoving = true
    elevationMeters.value = null
  })
  removeCameraMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    cameraMoving = false
    scheduleUpdate()
  })
  const canvas = viewer.scene.canvas
  let pendingPointer: { clientX: number; clientY: number } | null = null
  const updateElevation = () => {
    elevationFrameId = null
    if (!pendingPointer || viewer.isDestroyed()) return
    const pointer = pendingPointer
    pendingPointer = null
    const rectangle = canvas.getBoundingClientRect()
    const position = new Cartesian2(pointer.clientX - rectangle.left, pointer.clientY - rectangle.top)
    const ray = viewer.camera.getPickRay(position)
    const cartesian = ray ? viewer.scene.globe.pick(ray, viewer.scene) : viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
    if (!cartesian) {
      elevationMeters.value = null
      return
    }
    const cartographic = Cartographic.fromCartesian(cartesian)
    elevationMeters.value = Number.isFinite(cartographic.height) ? Number(cartographic.height.toFixed(1)) : null
  }
  const scheduleElevation = (event: MouseEvent) => {
    if (cameraMoving) return
    pendingPointer = { clientX: event.clientX, clientY: event.clientY }
    if (elevationFrameId !== null) return
    elevationFrameId = window.requestAnimationFrame(updateElevation)
  }
  const clearElevation = () => {
    pendingPointer = null
    if (elevationFrameId !== null) window.cancelAnimationFrame(elevationFrameId)
    elevationFrameId = null
    elevationMeters.value = null
  }
  canvas.addEventListener("mousemove", scheduleElevation)
  canvas.addEventListener("mouseleave", clearElevation)
  removePointerMove = () => {
    canvas.removeEventListener("mousemove", scheduleElevation)
    canvas.removeEventListener("mouseleave", clearElevation)
    pendingPointer = null
  }
  resizeObserver = new ResizeObserver(scheduleUpdate)
  resizeObserver.observe(viewer.container)
  scheduleUpdate()
}

watch(() => props.viewer, bindViewer, { immediate: true })
watch(() => props.available, (available) => {
  if (available === false) {
    scale.value = null
    return
  }
  scheduleUpdate()
})
watch(() => props.terrainState, scheduleUpdate)
onMounted(() => bindViewer(props.viewer))
onBeforeUnmount(unbindViewer)

</script>

<template>
  <div v-if="available !== false" class="v3-map-scale-bar" :class="{ unavailable: !scale }" :title="scale ? `当前比例尺约 ${scale.label}` : '当前视角暂时无法计算比例尺'" aria-label="地图比例尺" role="status">
    <template v-if="scale">
      <div class="v3-map-scale-bar__rule" :style="{ width: `${scale.widthPixels}px` }"><i /><i /></div>
      <strong>{{ scale.label }}</strong>
    </template>
    <strong v-else>比例尺不可用</strong>
    <small v-if="terrainState && terrainState !== 'WORLD_TERRAIN'">
      {{ scale ? regionTerrainStateLabel(terrainState) : '等待有效地图距离数据' }}<template v-if="scale && elevationMeters !== null"> · 地面 {{ elevationMeters.toFixed(1) }} m</template>
    </small>
  </div>
</template>

<style scoped>
.v3-map-scale-bar {
  position: absolute;
  z-index: 7;
  right: 12px;
  bottom: 12px;
  display: grid;
  grid-template-columns: auto auto;
  align-items: end;
  column-gap: 7px;
  border: 1px solid rgba(29, 69, 55, .18);
  border-radius: 3px;
  padding: 6px 8px 5px;
  color: #25443a;
  background: rgba(255, 255, 255, .92);
  box-shadow: 0 3px 12px rgba(25, 58, 47, .12);
  pointer-events: none;
}

.v3-map-scale-bar__rule {
  position: relative;
  grid-column: 1;
  height: 8px;
  border-bottom: 2px solid #25443a;
}

.v3-map-scale-bar__rule i {
  position: absolute;
  bottom: -2px;
  width: 2px;
  height: 8px;
  background: #25443a;
}

.v3-map-scale-bar__rule i:first-child { left: 0; }
.v3-map-scale-bar__rule i:last-child { right: 0; }
.v3-map-scale-bar strong { align-self: end; font-size: 11px; line-height: 1; white-space: nowrap; }
.v3-map-scale-bar small { grid-column: 1 / -1; margin-top: 4px; color: #71847b; font-size: 11px; line-height: 1; text-align: right; }
.v3-map-scale-bar.unavailable { grid-template-columns: auto; color: #7b6a45; }
.v3-map-scale-bar.unavailable small { text-align: left; }
</style>
