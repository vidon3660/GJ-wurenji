<script setup lang="ts">
import { ref, watch } from "vue"
import { Close, Refresh, Warning } from "@element-plus/icons-vue"
import type { V3MapImageryState } from "../map-loading-state"
import { v3MapImageryStateDetail, v3MapImageryStateLabel } from "../map-loading-state"

const props = withDefaults(defineProps<{
  available: boolean
  packageId?: string | null
  imageryState?: V3MapImageryState
  imageryDetail?: string
}>(), {
  imageryState: "LOADING",
  imageryDetail: ""
})

const emit = defineEmits<{
  retry: []
}>()

const imageryDismissed = ref(false)

watch(() => props.imageryState, () => {
  imageryDismissed.value = false
})

function imageryNoticeVisible(): boolean {
  return !imageryDismissed.value && props.available && ["LOADING", "TEACHING", "DEGRADED", "FAILED", "UNAVAILABLE", "UNCONFIGURED"].includes(props.imageryState)
}
</script>

<template>
  <div v-if="!available" class="v3-map-resource-notice" role="status" aria-live="polite">
    <div class="v3-map-resource-notice__title"><el-icon><Warning /></el-icon><strong>教学区域资源不可用</strong></div>
    <p>当前项目绑定的区域不在可用资源目录中，地图、比例尺和高程数据暂不可用。</p>
    <small v-if="packageId">区域快照 ID：{{ packageId }}</small>
    <small v-else>请返回任务列表重新进入，或联系教师更新区域资源包。</small>
  </div>
  <div
    v-else-if="imageryNoticeVisible()"
    class="v3-map-resource-notice v3-map-resource-notice--imagery"
    :role="['FAILED', 'DEGRADED'].includes(imageryState) ? 'alert' : 'status'"
    :aria-live="['FAILED', 'DEGRADED'].includes(imageryState) ? 'assertive' : 'polite'"
  >
    <div class="v3-map-resource-notice__title"><el-icon><Warning /></el-icon><strong>{{ v3MapImageryStateLabel(imageryState) }}</strong><el-button text class="v3-map-resource-notice__close" aria-label="关闭提示" title="关闭提示" @click="imageryDismissed = true"><el-icon><Close /></el-icon></el-button></div>
    <p>{{ imageryDetail || v3MapImageryStateDetail(imageryState) }}</p>
    <el-button text :icon="Refresh" :disabled="imageryState === 'LOADING'" :aria-label="imageryState === 'LOADING' ? '影像加载中' : '重新加载影像资源'" @click="emit('retry')">{{ imageryState === 'LOADING' ? '加载中' : '重新加载影像' }}</el-button>
  </div>
</template>

<style scoped>
.v3-map-resource-notice {
  position: absolute;
  z-index: 8;
  top: 50%;
  left: 50%;
  display: grid;
  width: min(360px, calc(100% - 32px));
  gap: 8px;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(127, 73, 39, .22);
  border-radius: 5px;
  padding: 18px 20px;
  color: #5a4435;
  background: rgba(255, 252, 247, .96);
  box-shadow: 0 12px 32px rgba(47, 57, 48, .16);
  pointer-events: none;
}

.v3-map-resource-notice--imagery {
  top: 58px;
  right: 12px;
  bottom: auto;
  left: auto;
  transform: none;
  pointer-events: none;
}

.v3-map-resource-notice__title {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8a4c29;
  font-size: 14px;
}

.v3-map-resource-notice__close {
  position: absolute;
  top: -8px;
  right: -8px;
  display: grid;
  width: 24px;
  height: 24px;
  margin: 0;
  padding: 0;
  place-items: center;
  color: #8a4c29;
  pointer-events: auto;
}

.v3-map-resource-notice__close:hover {
  color: #5a4435;
  background: rgba(138, 76, 41, .1);
}

.v3-map-resource-notice p,
.v3-map-resource-notice small {
  margin: 0;
  line-height: 1.6;
}

.v3-map-resource-notice p { color: #6d6259; font-size: 12px; }
.v3-map-resource-notice small { color: #9a8c80; font-size: 10px; }
.v3-map-resource-notice--imagery .el-button { justify-self: start; padding: 0; color: #8a4c29; font-size: 11px; pointer-events: auto; }
.v3-map-resource-notice--imagery > * { pointer-events: none; }
.v3-map-resource-notice--imagery > .el-button { pointer-events: auto; }

@media (max-width: 560px) {
  .v3-map-resource-notice--imagery {
    top: 148px;
    right: 12px;
    left: 12px;
    width: auto;
  }
}
</style>
