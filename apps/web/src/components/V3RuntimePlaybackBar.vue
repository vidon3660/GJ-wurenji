<script setup lang="ts">
import { RefreshLeft, VideoPause, VideoPlay } from "@element-plus/icons-vue"
import type { RuntimeTimelineMarker } from "../runtime-playback"

const props = defineProps<{
  timeMs: number
  durationMs: number
  playing: boolean
  live: boolean
  interactive: boolean
  toggleEnabled: boolean
  rate: number
  rateOptions: readonly number[]
  rateEditable: boolean
  markers: readonly RuntimeTimelineMarker[]
  selectedMarkerId: string
  statusLabel: string
  modeLabel?: string
}>()

const emit = defineEmits<{
  toggle: []
  restart: []
  seek: [timeMs: number]
  rateChange: [rate: number]
  markerSelect: [marker: RuntimeTimelineMarker]
}>()

function seek(event: Event) {
  emit("seek", Number((event.target as HTMLInputElement).value))
}

function changeRate(event: Event) {
  emit("rateChange", Number((event.target as HTMLSelectElement).value))
}

function markerPosition(marker: RuntimeTimelineMarker) {
  return `${Math.min(100, Math.max(0, marker.timeMs / Math.max(1, props.durationMs) * 100))}%`
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const remainingSeconds = seconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
}
</script>

<template>
  <section class="runtime-playback-bar" :class="{ replay: !live }">
    <div class="playback-actions">
      <button type="button" :disabled="!toggleEnabled" :title="playing ? '暂停仿真' : '播放仿真'" :aria-label="playing ? '暂停仿真' : '播放仿真'" @click="emit('toggle')">
        <el-icon><VideoPause v-if="playing" /><VideoPlay v-else /></el-icon>
      </button>
      <button v-if="!live" type="button" title="从头回放" aria-label="从头回放" @click="emit('restart')"><el-icon><RefreshLeft /></el-icon></button>
      <span class="playback-mode"><i />{{ modeLabel ?? (live ? 'LIVE' : 'REPLAY') }}</span>
    </div>

    <strong class="playback-time">{{ formatDuration(timeMs) }}</strong>

    <div class="playback-track">
      <input
        type="range"
        :min="0"
        :max="Math.max(1, durationMs)"
        :step="1000"
        :value="timeMs"
        :disabled="!interactive"
        aria-label="仿真时间轴"
        :aria-valuetext="`${formatDuration(timeMs)} / ${formatDuration(durationMs)}`"
        @input="seek"
      />
      <button
        v-for="marker in markers"
        :key="marker.id"
        type="button"
        class="playback-marker"
        :class="[marker.severity.toLowerCase(), { selected: marker.id === selectedMarkerId }]"
        :style="{ left: markerPosition(marker) }"
        :title="`${formatDuration(marker.timeMs)} · ${marker.label}`"
        :aria-label="`${formatDuration(marker.timeMs)} ${marker.label}`"
        @click="emit('markerSelect', marker)"
      />
    </div>

    <span class="playback-duration">{{ formatDuration(durationMs) }}</span>
    <select :value="rate" :disabled="!rateEditable" title="仿真速度" aria-label="仿真速度" @change="changeRate">
      <option v-for="option in rateOptions" :key="option" :value="option">{{ option }}x</option>
    </select>
    <em>{{ statusLabel }}</em>
  </section>
</template>

<style scoped>
.runtime-playback-bar { position: absolute; z-index: 6; right: 12px; bottom: 12px; left: 12px; display: grid; grid-template-columns: auto 50px minmax(120px,1fr) 48px 58px 70px; align-items: center; gap: 9px; min-height: 45px; border: 1px solid rgba(255,255,255,.46); padding: 6px 8px; color: #fff; background: rgba(17,48,38,.94); box-shadow: 0 5px 18px rgba(18,51,40,.16); }
.runtime-playback-bar.replay { background: rgba(38,49,45,.95); }
.playback-actions { display: flex; align-items: center; gap: 4px; }
.playback-actions button { display: grid; width: 29px; height: 29px; place-items: center; border: 1px solid rgba(255,255,255,.28); padding: 0; color: #fff; background: rgba(255,255,255,.08); cursor: pointer; }
.playback-actions button:hover:not(:disabled) { background: rgba(255,255,255,.17); }
.playback-actions button:focus-visible,.playback-marker:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.playback-actions button:active:not(:disabled) { transform: translateY(1px); }
.playback-actions button:disabled { cursor: not-allowed; opacity: .42; }
.playback-mode { display: inline-flex; align-items: center; gap: 4px; margin-left: 3px; font-size: 11px; font-weight: 800; }
.playback-mode i { width: 5px; height: 5px; border-radius: 50%; background: #6bd49e; box-shadow: 0 0 0 3px rgba(107,212,158,.13); }
.replay .playback-mode i { background: #e2ad55; box-shadow: 0 0 0 3px rgba(226,173,85,.13); }
.playback-time,.playback-duration { font-size: 11px; font-variant-numeric: tabular-nums; }
.playback-duration { color: #b9c7c1; }
.playback-track { position: relative; display: grid; align-items: center; height: 20px; }
.playback-track input { width: 100%; height: 3px; margin: 0; accent-color: #69cf9a; cursor: pointer; }
.playback-track input:disabled { cursor: default; opacity: .84; }
.playback-marker { position: absolute; top: 2px; width: 7px; height: 15px; margin-left: -3px; border: 0; border-radius: 0; padding: 0; background: #d7a04a; cursor: pointer; }
.playback-marker.error,.playback-marker.critical { background: #db665e; }
.playback-marker.info { background: #77a9c3; }
.playback-marker.selected { outline: 2px solid #fff; outline-offset: 1px; }
.runtime-playback-bar select { width: 58px; height: 29px; border: 1px solid rgba(255,255,255,.28); border-radius: 0; padding: 0 6px; color: #fff; background: #244d3e; font-size: 11px; }
.runtime-playback-bar select:disabled { opacity: .55; }
.runtime-playback-bar em { overflow: hidden; color: #c9d5d0; font-size: 11px; font-style: normal; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 760px) {
  .runtime-playback-bar { grid-template-columns: auto 45px minmax(80px,1fr) 42px 52px minmax(38px,auto); gap: 6px; }
  .runtime-playback-bar em { display: block; min-width: 0; }
  .playback-mode { display: none; }
}

@media (max-width: 480px) {
  .runtime-playback-bar { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: auto auto auto; gap: 5px 6px; padding: 6px; }
  .playback-actions { grid-column: 1 / -1; grid-row: 1; }
  .playback-time { grid-column: 1; grid-row: 2; }
  .playback-track { grid-column: 2; grid-row: 2; min-width: 0; }
  .playback-duration { grid-column: 3; grid-row: 2; }
  .runtime-playback-bar select { grid-column: 1; grid-row: 3; width: 52px; }
  .runtime-playback-bar em { grid-column: 2 / 4; grid-row: 3; text-align: left; }
}

</style>
