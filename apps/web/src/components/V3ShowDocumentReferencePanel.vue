<script setup lang="ts">
import { computed } from "vue"
import { Download, Location, Picture } from "@element-plus/icons-vue"
import type { ShowDocumentReferencePanel } from "@wurenji/shared"
import { apiBaseUrl } from "../api"
import { formatPlatformDateTime } from "../platform-date"
import { planningMapPreviewPath, showDocumentReferenceCoordinates } from "../show-document-reference"
import { formatCoordinateReference, formatScaleTemplateCode } from "../terminology"

const props = defineProps<{ reference: ShowDocumentReferencePanel }>()
const emit = defineEmits<{ downloadPlanningMap: [] }>()

const coordinates = computed(() => showDocumentReferenceCoordinates(props.reference))
const planningMapUrl = computed(() => {
  const path = planningMapPreviewPath(props.reference.planningMapAsset)
  return path ? apiBaseUrl(path) : null
})

function formatTime(value: string): string {
  return formatPlatformDateTime(value)
}
</script>

<template>
  <section class="show-document-reference-panel" aria-label="任务信息参照栏">
    <header><div><span>MISSION REFERENCE</span><strong>任务信息参照</strong></div><small>{{ formatScaleTemplateCode(reference.scaleTemplateCode) }}</small></header>
    <p><strong>{{ reference.projectName }}</strong><span>{{ reference.projectBackground || '未填写项目背景' }}</span></p>
    <dl>
      <div><dt>时间</dt><dd>{{ formatTime(reference.plannedStartAt) }}<br />至 {{ formatTime(reference.plannedEndAt) }}</dd></div>
      <div><dt>架数</dt><dd>{{ reference.aircraftCount }} 架</dd></div>
      <div><dt>机型</dt><dd>{{ reference.aircraftModel }}</dd></div>
      <div><dt>区域</dt><dd>{{ reference.regionName }} · 规划 V{{ reference.areaPlanVersion ?? '-' }}</dd></div>
      <div><dt>最大高度</dt><dd>{{ reference.maximumHeightMeters ?? '-' }} m</dd></div>
    </dl>
    <section class="reference-coordinate-list">
      <header><el-icon><Location /></el-icon><strong>坐标参照</strong><small>{{ formatCoordinateReference('WGS84') }} · {{ coordinates.length }} 点</small></header>
      <ol v-if="coordinates.length">
        <li v-for="row in coordinates" :key="row.id"><span>{{ row.label }}</span><code>{{ row.coordinate }}</code></li>
      </ol>
      <p v-else>区域规划尚未形成可引用坐标。</p>
    </section>
    <section class="reference-map">
      <header><el-icon><Picture /></el-icon><strong>区域规划图</strong><small>{{ reference.planningMapAsset ? '已冻结' : '未生成' }}</small></header>
      <button v-if="planningMapUrl" type="button" @click="emit('downloadPlanningMap')">
        <img :src="planningMapUrl" alt="学生已确认的区域规划图" />
        <span><el-icon><Download /></el-icon>下载规划图</span>
      </button>
      <p v-else>区域规划图尚未生成。</p>
    </section>
    <details>
      <summary>任务说明与完成要求</summary>
      <strong>任务说明</strong><p>{{ reference.taskBrief }}</p>
      <strong>完成要求</strong><p>{{ reference.completionRequirements }}</p>
    </details>
  </section>
</template>

<style scoped>
.show-document-reference-panel { min-width: 0; padding: 15px; color: #263a32; background: #f8faf9; }
.show-document-reference-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 11px; }
.show-document-reference-panel > header > div { display: grid; gap: 2px; }
.show-document-reference-panel > header span { color: #247354; font-size: 11px; font-weight: 800; }
.show-document-reference-panel > header strong { font-size: 11px; }
.show-document-reference-panel > header small { color: #247354; font-size: 11px; }
.show-document-reference-panel > p { display: grid; gap: 4px; margin: 0 0 12px; color: #5f736a; font-size: 11px; line-height: 1.5; }
.show-document-reference-panel > p strong { color: #263a32; font-size: 10px; }
.show-document-reference-panel dl { display: grid; margin: 0; border-top: 1px solid #dde3e0; }
.show-document-reference-panel dl > div { display: grid; grid-template-columns: 76px minmax(0,1fr); gap: 8px; border-bottom: 1px solid #e1e6e3; padding: 8px 0; font-size: 11px; }
.show-document-reference-panel dt { color: #798a82; }
.show-document-reference-panel dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.reference-coordinate-list,.reference-map { margin-top: 14px; border-top: 1px solid #d9e2dd; padding-top: 10px; }
.reference-coordinate-list > header,.reference-map > header { display: grid; grid-template-columns: 16px minmax(0,1fr) auto; align-items: center; gap: 6px; margin-bottom: 7px; color: #287154; }
.reference-coordinate-list header strong,.reference-map header strong { font-size: 11px; }
.reference-coordinate-list header small,.reference-map header small { color: #7b8c84; font-size: 11px; }
.reference-coordinate-list ol { max-height: 150px; overflow: auto; margin: 0; padding: 0; list-style: none; }
.reference-coordinate-list li { display: grid; gap: 2px; border-top: 1px solid #e4e9e6; padding: 6px 0; }
.reference-coordinate-list li span { color: #70827a; font-size: 11px; }
.reference-coordinate-list code { color: #2e5545; font-family: Consolas, monospace; font-size: 11px; white-space: nowrap; }
.reference-coordinate-list > p,.reference-map > p { margin: 0; color: #7b8c84; font-size: 11px; }
.reference-map > button { position: relative; display: block; width: 100%; overflow: hidden; border: 1px solid #d1dbd6; border-radius: 4px; padding: 0; background: #e9efec; cursor: pointer; }
.reference-map img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; background: white; }
.reference-map button span { position: absolute; right: 7px; bottom: 7px; display: flex; align-items: center; gap: 4px; border-radius: 3px; padding: 5px 7px; color: white; background: rgba(26,77,58,.9); font-size: 11px; }
.show-document-reference-panel details { margin-top: 13px; border-top: 1px solid #d9e2dd; padding-top: 9px; font-size: 11px; }
.show-document-reference-panel summary { color: #346451; cursor: pointer; font-weight: 700; }
.show-document-reference-panel details strong { display: block; margin-top: 9px; }
.show-document-reference-panel details p { margin: 3px 0 0; color: #63766e; line-height: 1.55; }
</style>
