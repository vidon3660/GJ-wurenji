<script setup lang="ts">
import { ref, watch } from "vue"
import { Close, Refresh, WarningFilled } from "@element-plus/icons-vue"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { regionTerrainNoticeVisible, regionTerrainStateDetail, regionTerrainStateLabel, type RegionTerrainState } from "../terrain"

const props = defineProps<{
  state: RegionTerrainState
  region?: V3RegionCatalogItem | null
}>()

const emit = defineEmits<{
  retry: []
}>()

const dismissed = ref(false)

watch(
  () => [props.state, props.region?.packageId] as const,
  () => { dismissed.value = false }
)

function retry() {
  dismissed.value = false
  emit("retry")
}
</script>

<template>
  <div
    v-if="regionTerrainNoticeVisible(props.state) && !dismissed"
    class="v3-map-terrain-notice"
    :role="['FAILED', 'DEGRADED'].includes(props.state) ? 'alert' : 'status'"
    :aria-live="['FAILED', 'DEGRADED'].includes(props.state) ? 'assertive' : 'polite'"
  >
    <el-icon class="v3-map-terrain-notice__icon"><WarningFilled /></el-icon>
    <div class="v3-map-terrain-notice__content">
      <strong>{{ regionTerrainStateLabel(props.state) }}</strong>
      <small>{{ regionTerrainStateDetail(props.state, props.region) }}</small>
    </div>
    <div class="v3-map-terrain-notice__actions">
      <el-button text :icon="Refresh" :disabled="props.state === 'LOADING'" :aria-label="props.state === 'LOADING' ? '高程资源加载中' : '重新加载高程资源'" @click="retry">重新加载</el-button>
      <el-button text :icon="Close" aria-label="关闭高程提示" @click="dismissed = true">关闭</el-button>
    </div>
  </div>
</template>

<style scoped>
.v3-map-terrain-notice {
  position: absolute;
  z-index: 8;
  left: 12px;
  bottom: 12px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: min(440px, calc(100% - 24px));
  border: 1px solid rgba(151, 104, 35, .28);
  border-radius: 4px;
  padding: 8px 9px;
  color: #624a2f;
  background: rgba(255, 250, 240, .96);
  box-shadow: 0 4px 16px rgba(49, 58, 47, .16);
}

.v3-map-terrain-notice__icon { color: #b27725; }
.v3-map-terrain-notice__content { display: grid; min-width: 0; gap: 2px; }
.v3-map-terrain-notice strong { font-size: 10px; }
.v3-map-terrain-notice small { overflow-wrap: anywhere; color: #806f5c; font-size: 11px; line-height: 1.45; }
.v3-map-terrain-notice :deep(.el-button) { flex: 0 0 auto; color: #8c5d1d; font-size: 11px; }
.v3-map-terrain-notice__actions { display: flex; align-items: center; gap: 2px; }

@media (max-width: 560px) {
  .v3-map-terrain-notice {
    right: 12px;
    bottom: 56px;
    width: calc(100% - 24px);
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 6px;
    padding: 6px 8px;
  }
  .v3-map-terrain-notice strong { font-size: 11px; }
  .v3-map-terrain-notice small { font-size: 11px; }
  .v3-map-terrain-notice :deep(.el-button) { padding: 0; font-size: 11px; }
  .v3-map-terrain-notice__actions { align-items: flex-end; flex-direction: column; }
}
</style>
