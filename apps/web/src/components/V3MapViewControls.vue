<script setup lang="ts">
import { Aim, Compass, Position, RefreshLeft, RefreshRight, VideoCamera, ZoomIn, ZoomOut } from "@element-plus/icons-vue"
import { teachingMapModeLabel } from "../map-mode"

const props = defineProps<{
  mode: "2d" | "3d"
}>()

const emit = defineEmits<{
  home: []
  zoomIn: []
  zoomOut: []
  rotateLeft: []
  rotateRight: []
  resetNorth: []
  topDown: []
  flightView: []
}>()
</script>

<template>
  <div class="v3-map-view-controls" role="toolbar" aria-label="地图视角控制">
    <span class="v3-map-view-mode" role="status" aria-live="polite" :aria-label="`当前视角：${teachingMapModeLabel(props.mode)}`">{{ teachingMapModeLabel(props.mode) }}</span>
    <span />
    <el-tooltip content="回到教学区域" placement="left">
      <button type="button" aria-label="回到教学区域" @click="emit('home')"><el-icon><Aim /></el-icon></button>
    </el-tooltip>
    <el-tooltip content="放大地图" placement="left">
      <button type="button" aria-label="放大地图" @click="emit('zoomIn')"><el-icon><ZoomIn /></el-icon></button>
    </el-tooltip>
    <el-tooltip content="缩小地图" placement="left">
      <button type="button" aria-label="缩小地图" @click="emit('zoomOut')"><el-icon><ZoomOut /></el-icon></button>
    </el-tooltip>
    <span />
    <el-tooltip content="视角左旋" placement="left">
      <button type="button" aria-label="视角左旋" @click="emit('rotateLeft')"><el-icon><RefreshLeft /></el-icon></button>
    </el-tooltip>
    <el-tooltip content="视角右旋" placement="left">
      <button type="button" aria-label="视角右旋" @click="emit('rotateRight')"><el-icon><RefreshRight /></el-icon></button>
    </el-tooltip>
    <el-tooltip content="恢复正北" placement="left">
      <button type="button" aria-label="恢复正北" @click="emit('resetNorth')"><el-icon><Compass /></el-icon></button>
    </el-tooltip>
    <template v-if="mode === '3d'">
      <span />
      <el-tooltip content="俯视视角" placement="left">
        <button type="button" aria-label="俯视视角" @click="emit('topDown')"><el-icon><Position /></el-icon></button>
      </el-tooltip>
      <el-tooltip content="飞行视角" placement="left">
        <button type="button" aria-label="飞行视角" @click="emit('flightView')"><el-icon><VideoCamera /></el-icon></button>
      </el-tooltip>
    </template>
  </div>
</template>

<style scoped>
.v3-map-view-controls {
  position: absolute;
  z-index: 7;
  top: 12px;
  right: 58px;
  display: flex;
  align-items: center;
  gap: 2px;
  border: 1px solid rgba(29, 69, 55, .2);
  border-radius: 4px;
  padding: 4px;
  background: rgba(255, 255, 255, .94);
  box-shadow: 0 3px 12px rgba(25, 58, 47, .14);
}

.v3-map-view-controls button {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 3px;
  color: #536b62;
  background: transparent;
  cursor: pointer;
}

.v3-map-view-controls button:hover,
.v3-map-view-controls button:focus-visible {
  color: white;
  background: #216c50;
}

.v3-map-view-mode {
  min-width: 60px;
  color: #2a6d50;
  font-size: 11px;
  font-weight: 800;
  line-height: 30px;
  text-align: center;
  white-space: nowrap;
}

.v3-map-view-controls > span {
  width: 1px;
  height: 22px;
  margin: 0 2px;
  background: #d5dfda;
}

@media (max-width: 560px) {
  .v3-map-view-controls {
    top: 102px;
    right: 12px;
  }

  .v3-map-view-mode {
    min-width: 52px;
    font-size: 11px;
  }
}
</style>
