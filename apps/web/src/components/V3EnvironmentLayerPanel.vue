<script setup lang="ts">
import { computed, ref } from "vue"
import { CloseBold, Operation } from "@element-plus/icons-vue"
import type { SceneType, V3LogisticsNodeType, V3RegionCatalogItem, V3RegionLayerCode } from "@wurenji/shared"
import { regionEnvironmentCoverage } from "../region-environment-coverage"
import { regionTerrainStateDetail, regionTerrainStateLabel, type RegionTerrainState } from "../terrain"

const props = defineProps<{
  region: V3RegionCatalogItem
  sceneType: SceneType
  visibleLayers: readonly V3RegionLayerCode[]
  details?: Record<string, string | undefined> | undefined
  plannedShowAreaTypes?: readonly string[] | undefined
  visibleNodeTypes?: readonly V3LogisticsNodeType[] | undefined
  showLabels?: boolean
  terrainState?: RegionTerrainState
}>()

const emit = defineEmits<{
  toggleLayer: [code: V3RegionLayerCode]
  toggleNodeType: [type: V3LogisticsNodeType]
  toggleLabels: []
}>()
const open = ref(false)
const items = computed(() => regionEnvironmentCoverage(props.region, props.sceneType, {
  details: props.details,
  plannedShowAreaTypes: props.plannedShowAreaTypes
}))
const nodeLayerItems = computed(() => ([
  { type: "WAITING_POINT" as const, label: "等待点" },
  { type: "ALTERNATE_LANDING_POINT" as const, label: "备降点" }
].map((item) => ({
  ...item,
  count: (props.region.logisticsNodes ?? []).filter((node) => node.enabled && node.type === item.type).length
})).filter((item) => item.count > 0)))
const majorLayers = computed(() => props.region.layers.filter((layer) => ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"].includes(layer.code)))
const mapCoverageCodes = computed(() => props.sceneType === "CITY_SHOW"
  ? new Set(["SHOW_BUILDINGS", "SHOW_ROADS", "SHOW_WATER", "SHOW_GREEN", "SHOW_UNAVAILABLE"])
  : props.sceneType === "CITY_LOGISTICS"
    ? new Set(["LOG_CENTER_AIRPORT", "LOG_DELIVERY_POINTS", "LOG_BUILDINGS", "LOG_OBSTACLES", "LOG_RESTRICTIONS", "LOG_WAITING_POINTS", "LOG_ALTERNATE_POINTS"])
    : new Set<string>())
const mapCoverageItems = computed(() => items.value.filter((item) => mapCoverageCodes.value.has(item.code)))

const terrainItem = computed(() => props.terrainState ? {
  state: props.terrainState,
  label: "地形与高程",
  source: regionTerrainStateLabel(props.terrainState),
  detail: regionTerrainStateDetail(props.terrainState, props.region)
} : null)

function stateLabel(state: V3RegionCatalogItem["imageryState"]) {
  return state === "AVAILABLE" ? "可用" : state === "DEGRADED" ? "降级" : "不可用"
}

function sourceLabel(source: ReturnType<typeof regionEnvironmentCoverage>[number]["source"]) {
  return ({ LAYER: "区域要素", BASEMAP: "底图参考", BOUNDARY: "区域边界", NODE: "区域节点", TASK: "任务条件", PLAN: "项目规划" } as const)[source]
}

function sceneLabel(sceneType: SceneType): string {
  return sceneType === "CITY_LOGISTICS" ? "物流场景" : sceneType === "CITY_SHOW" ? "城市表演" : "垂起巡检"
}
</script>

<template>
  <el-tooltip v-if="!open" content="环境图层" placement="left">
    <button class="environment-layer-trigger" type="button" aria-label="打开环境图层" @click="open = true"><el-icon><Operation /></el-icon></button>
  </el-tooltip>
  <section v-else class="environment-layer-panel" aria-label="环境图层">
    <header><div><span>{{ sceneLabel(sceneType) }}</span><strong>环境图层</strong></div><button type="button" aria-label="关闭环境图层" @click="open = false"><el-icon><CloseBold /></el-icon></button></header>
    <div class="environment-major-layers">
      <button
        v-for="layer in majorLayers"
        :key="layer.code"
        type="button"
        :class="{ active: visibleLayers.includes(layer.code) }"
        :disabled="layer.state === 'UNAVAILABLE'"
        :aria-pressed="visibleLayers.includes(layer.code)"
        :aria-label="`${layer.title}，${stateLabel(layer.state)}${layer.state === 'UNAVAILABLE' ? '，当前不可用' : visibleLayers.includes(layer.code) ? '，已显示' : '，未显示'}`"
        @click="emit('toggleLayer', layer.code)"
      ><i /><span>{{ layer.title }}</span><small>{{ stateLabel(layer.state) }}</small></button>
    </div>
    <div v-if="terrainItem && sceneType !== 'CITY_LOGISTICS'" class="environment-terrain-status" :class="terrainItem.state.toLowerCase()" role="status" aria-live="polite">
      <i /><div><strong>{{ terrainItem.label }}</strong><small>{{ terrainItem.detail }}</small></div><span>{{ terrainItem.source }}</span>
    </div>
    <div v-if="visibleNodeTypes && nodeLayerItems.length" class="environment-node-layers">
      <header><strong>节点图层</strong><small>独立控制地图显示</small></header>
      <button
        v-for="item in nodeLayerItems"
        :key="item.type"
        type="button"
        :class="{ active: visibleNodeTypes.includes(item.type) }"
        :aria-pressed="visibleNodeTypes.includes(item.type)"
        @click="emit('toggleNodeType', item.type)"
      ><i /><span>{{ item.label }}</span><small>{{ item.count }} 处</small></button>
    </div>
    <button v-if="sceneType === 'CITY_LOGISTICS' && showLabels !== undefined" type="button" class="environment-label-toggle" :class="{ active: showLabels }" :aria-pressed="showLabels" @click="emit('toggleLabels')"><i /><span>地图文字标注</span><small>{{ showLabels ? '已显示' : '已隐藏' }}</small></button>
    <div class="environment-coverage-list">
      <article v-for="item in mapCoverageItems" :key="item.code" :class="item.state.toLowerCase()">
        <i /><div><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></div><span>{{ sourceLabel(item.source) }}</span>
      </article>
    </div>
  </section>
</template>

<style scoped>
.environment-layer-trigger { position: absolute; z-index: 5; top: 12px; right: 12px; display: grid; width: 36px; height: 36px; place-items: center; border: 1px solid rgba(29,69,55,.22); border-radius: 4px; color: #245f49; background: rgba(255,255,255,.96); box-shadow: 0 3px 12px rgba(25,58,47,.14); cursor: pointer; }
.environment-layer-panel { position: absolute; z-index: 6; top: 12px; right: 12px; width: min(300px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow: auto; overscroll-behavior: contain; border: 1px solid rgba(29,69,55,.2); border-radius: 4px; background: rgba(250,252,251,.97); box-shadow: 0 8px 28px rgba(25,58,47,.2); }
.environment-layer-panel > header { position: sticky; z-index: 1; top: 0; display: flex; align-items: center; justify-content: space-between; min-height: 52px; border-bottom: 1px solid #d8e2dd; padding: 8px 10px 8px 12px; background: #f8fbf9; }
.environment-layer-panel > header > div { display: grid; gap: 2px; }.environment-layer-panel > header span { color: #277154; font-size: 11px; font-weight: 800; }.environment-layer-panel > header strong { font-size: 12px; }
.environment-layer-panel > header button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; color: #60746b; background: transparent; cursor: pointer; }
.environment-major-layers { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); border-bottom: 1px solid #d8e2dd; }
.environment-major-layers button { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 5px; min-height: 36px; border: 0; border-right: 1px solid #e2e8e5; border-bottom: 1px solid #e2e8e5; padding: 6px 7px; color: #65766e; text-align: left; background: white; cursor: pointer; }
.environment-major-layers button:nth-child(2n) { border-right: 0; }.environment-major-layers button.active { color: #1e684c; background: #e8f3ed; }.environment-major-layers button:disabled { opacity: .45; cursor: not-allowed; }
.environment-major-layers i { width: 7px; height: 7px; border: 1px solid #91a49b; border-radius: 2px; }.environment-major-layers button.active i { border-color: #267052; background: #267052; }.environment-major-layers span { overflow: hidden; font-size: 11px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }.environment-major-layers small { color: #82928b; font-size: 11px; }
.environment-terrain-status { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 7px; min-height: 50px; border-bottom: 1px solid #d8e2dd; padding: 7px 9px; background: #f7faf8; }.environment-terrain-status > i { width: 7px; height: 7px; border-radius: 50%; background: #2b7658; }.environment-terrain-status.loading > i, .environment-terrain-status.degraded > i { background: #bd872c; }.environment-terrain-status.ellipsoid > i, .environment-terrain-status.failed > i { background: #af4f46; }.environment-terrain-status > div { display: grid; gap: 2px; min-width: 0; }.environment-terrain-status strong { font-size: 11px; }.environment-terrain-status small { overflow: hidden; color: #71837b; font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }.environment-terrain-status > span { color: #61756c; font-size: 11px; white-space: nowrap; }
.environment-node-layers { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); border-bottom: 1px solid #d8e2dd; background: #f7faf8; }.environment-node-layers > header { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; min-height: 30px; padding: 5px 9px; }.environment-node-layers header strong { font-size: 11px; }.environment-node-layers header small { color: #82928b; font-size: 11px; }.environment-node-layers button { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 5px; min-height: 34px; border: 0; border-top: 1px solid #e2e8e5; border-right: 1px solid #e2e8e5; padding: 6px 7px; color: #65766e; text-align: left; background: white; cursor: pointer; }.environment-node-layers button:last-child { border-right: 0; }.environment-node-layers button.active { color: #1e684c; background: #e8f3ed; }.environment-node-layers i { width: 7px; height: 7px; border: 1px solid #91a49b; border-radius: 50%; }.environment-node-layers button.active i { border-color: #267052; background: #267052; }.environment-node-layers span { font-size: 11px; font-weight: 700; }.environment-node-layers small { color: #82928b; font-size: 11px; }
.environment-label-toggle { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 5px; width: 100%; min-height: 34px; border: 0; border-bottom: 1px solid #d8e2dd; padding: 6px 9px; color: #65766e; text-align: left; background: white; cursor: pointer; }.environment-label-toggle.active { color: #1e684c; background: #e8f3ed; }.environment-label-toggle i { width: 7px; height: 7px; border: 1px solid #91a49b; border-radius: 1px; }.environment-label-toggle.active i { border-color: #267052; background: #267052; }.environment-label-toggle span { font-size: 11px; font-weight: 700; }.environment-label-toggle small { color: #82928b; font-size: 11px; }
.environment-coverage-list { display: grid; }.environment-coverage-list article { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 7px; min-height: 46px; border-bottom: 1px solid #e3e9e6; padding: 7px 9px; background: white; }
.environment-coverage-list article > i { width: 7px; height: 7px; border-radius: 50%; background: #2b7658; }.environment-coverage-list article.degraded > i { background: #bd872c; }.environment-coverage-list article.unavailable > i { background: #af4f46; }
.environment-coverage-list article > div { display: grid; gap: 2px; min-width: 0; }.environment-coverage-list strong { font-size: 11px; }.environment-coverage-list small { overflow: hidden; color: #71837b; font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }.environment-coverage-list article > span { color: #61756c; font-size: 11px; white-space: nowrap; }
@media (max-width: 560px) {
  .environment-layer-panel { top: auto; right: 12px; bottom: 12px; width: calc(100% - 24px); max-height: min(35vh, 280px); }
  .environment-layer-trigger { top: 58px; }
}
</style>
