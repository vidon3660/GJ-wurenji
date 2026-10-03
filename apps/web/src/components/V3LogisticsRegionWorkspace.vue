<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { Check, Location, MapLocation, Refresh } from "@element-plus/icons-vue"
import type {
  AuthUser,
  LogisticsRouteWorkspaceView,
  StudentProjectStageView,
  StudentProjectView,
  V3Coordinate,
  V3LogisticsNode,
  V3LogisticsNodeType,
  V3RegionCatalogItem,
  V3RegionLayerCode
} from "@wurenji/shared"
import { api } from "../api"
import { formatCoordinateReference, formatHeightDatum } from "../terminology"
import type { V3MapDataState } from "../map-loading-state"
import type { RegionTerrainState } from "../terrain"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"
import V3UnifiedMap from "./V3UnifiedMap.vue"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
  region: V3RegionCatalogItem
  visibleLayers: readonly V3RegionLayerCode[]
  mapMode: "2d" | "3d"
  environmentDetails?: Record<string, string | undefined>
}>()

const emit = defineEmits<{
  refreshProject: []
  toggleLayer: [code: V3RegionLayerCode]
  dataState: [state: V3MapDataState]
}>()

const mapTerrainState = ref<RegionTerrainState>("LOADING")
const loading = ref(false)
const loadError = ref("")
const saving = ref(false)
const workspace = ref<LogisticsRouteWorkspaceView | null>(null)
const selectedDeliveryPointIds = ref<string[]>([])
const notes = ref("")
// 物流地图只呈现中心机场、配送点、等待点和备降点四类节点。
const visibleNodeTypes = ref<V3LogisticsNodeType[]>(["CENTER_AIRPORT", "DELIVERY_POINT", "WAITING_POINT", "ALTERNATE_LANDING_POINT"])
const showLabels = ref(true)
const focusedCoordinate = ref<V3Coordinate | null>(null)
const elementFilter = ref("ALL")

const deliveryPoints = computed(() => {
  const candidateIds = new Set(workspace.value?.candidateDeliveryPointIds ?? [])
  return (props.region.logisticsNodes ?? []).filter((node) => node.type === "DELIVERY_POINT" && node.enabled && candidateIds.has(node.id))
})
const workspaceRegion = computed<V3RegionCatalogItem>(() => {
  const candidateIds = new Set(workspace.value?.candidateDeliveryPointIds ?? [])
  return {
    ...props.region,
    logisticsNodes: (props.region.logisticsNodes ?? []).filter((node) => node.type !== "DELIVERY_POINT" || candidateIds.has(node.id))
  }
})
const regionElements = computed(() => {
  const nodes = (workspaceRegion.value.logisticsNodes ?? []).filter((node) => node.enabled && ["CENTER_AIRPORT", "DELIVERY_POINT", "WAITING_POINT", "ALTERNATE_LANDING_POINT"].includes(node.type))
    .map((node) => ({
      id: `node:${node.id}`,
      kind: "节点",
      name: node.name,
      detail: nodeTypeLabel(node.type),
      coordinate: node.position ?? node.positions?.[0] ?? null,
      node
    }))
  const features = props.region.layers.filter((layer) => ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"].includes(layer.code)).flatMap((layer) => layer.features.filter((feature) => feature.position || feature.positions?.length).map((feature) => ({
    id: `feature:${layer.code}:${feature.id}`,
    kind: layer.code === "RESTRICTIONS" ? "禁限区" : layer.code === "BUILDINGS" ? "建筑/障碍" : layer.code === "WATER" ? "水域/河流" : layer.code === "GREENLAND" ? "森林/绿地" : layer.title,
    name: feature.name,
    detail: layer.title,
    coordinate: feature.position ?? feature.positions?.[0] ?? null,
    node: null
  })))
  return [...nodes, ...features]
})
const filteredRegionElements = computed(() => elementFilter.value === "ALL"
  ? regionElements.value
  : regionElements.value.filter((element) => element.kind === elementFilter.value || element.node?.type === elementFilter.value))
const elementFilterOptions = computed(() => [
  { label: "全部元素", value: "ALL" },
  ...Array.from(new Map(regionElements.value.map((element) => [element.kind, element.kind])).entries()).map(([value, label]) => ({ label, value }))
])
const range = computed(() => workspace.value?.requiredDeliveryPointRange ?? { minimum: 1, maximum: 1 })
const selectionValid = computed(() => selectedDeliveryPointIds.value.length >= range.value.minimum && selectedDeliveryPointIds.value.length <= range.value.maximum)
const canEdit = computed(() => Boolean(workspace.value?.canEditRegion && props.user.role === "student" && props.project.assessmentTiming.canWrite))

function handleMapDataState(state: V3MapDataState) {
  mapTerrainState.value = state.terrain
  emit("dataState", state)
}

onMounted(loadWorkspace)
watch(() => props.project.id, loadWorkspace)

async function loadWorkspace() {
  loading.value = true
  loadError.value = ""
  try {
    const value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/route-workspace`)
    workspace.value = value
    selectedDeliveryPointIds.value = [...value.regionAnalysis.selectedDeliveryPointIds]
    notes.value = value.regionAnalysis.notes
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "物流区域工作台加载失败"
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

function toggleDeliveryPoint(nodeId: string) {
  const node = deliveryPoints.value.find((item) => item.id === nodeId)
  if (!node || !canEdit.value) return
  const selected = selectedDeliveryPointIds.value.includes(nodeId)
  if (!selected && selectedDeliveryPointIds.value.length >= range.value.maximum) {
    ElMessage.warning(`当前模板最多启用 ${range.value.maximum} 个配送点`)
    return
  }
  selectedDeliveryPointIds.value = selected
    ? selectedDeliveryPointIds.value.filter((id) => id !== nodeId)
    : [...selectedDeliveryPointIds.value, nodeId]
}

async function save() {
  await persistRegion(true)
}

async function persistRegion(showMessage: boolean): Promise<boolean> {
  if (!workspace.value || !canEdit.value || !selectionValid.value) return false
  saving.value = true
  try {
    workspace.value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/region-analysis`, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: workspace.value.regionAnalysis.revision,
        selectedDeliveryPointIds: selectedDeliveryPointIds.value,
        notes: notes.value
      })
    })
    selectedDeliveryPointIds.value = [...workspace.value.regionAnalysis.selectedDeliveryPointIds]
    if (showMessage) ElMessage.success("区域分析已保存")
    return true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "区域分析保存失败")
    return false
  } finally {
    saving.value = false
  }
}

async function confirm() {
  if (!workspace.value || !canEdit.value || !selectionValid.value) return
  saving.value = true
  try {
    if (!await persistRegion(false) || !workspace.value) return
    workspace.value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/region-analysis/confirm`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: workspace.value.regionAnalysis.revision, expectedStageRevision: props.stage.revision })
    })
    ElMessage.success("区域分析已确认，航线规划阶段已开放")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "区域分析确认失败")
  } finally {
    saving.value = false
  }
}

function nodeCode(node: V3LogisticsNode) {
  return node.code.replace("DP-", "D")
}

function toggleNodeType(type: V3LogisticsNodeType) {
  visibleNodeTypes.value = visibleNodeTypes.value.includes(type)
    ? visibleNodeTypes.value.filter((item) => item !== type)
    : [...visibleNodeTypes.value, type]
}

function nodeTypeLabel(type: V3LogisticsNodeType): string {
  return ({
    CENTER_AIRPORT: "中心机场",
    TAKEOFF_POINT: "起飞点",
    LANDING_POINT: "降落点",
    PARKING_POINT: "停放点",
    DELIVERY_POINT: "候选配送点",
    WAITING_POINT: "候选等待点",
    ALTERNATE_LANDING_POINT: "候选备降点",
    EMERGENCY_AREA: "应急运行区域"
  } as Record<V3LogisticsNodeType, string>)[type]
}

function focusElement(element: (typeof regionElements.value)[number]) {
  if (!element.coordinate) return
  focusedCoordinate.value = { ...element.coordinate }
}
</script>

<template>
  <section class="logistics-region-workspace" v-loading="loading || saving">
    <main class="logistics-region-canvas">
      <div v-if="loadError && !workspace" class="logistics-region-load-error" role="alert" aria-live="assertive"><span><strong>物流区域分析加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的配送点分析数据，请检查连接后重新加载。</p></span><el-button type="primary" :icon="Refresh" :loading="loading" @click="loadWorkspace">重新加载区域分析</el-button></div>
      <V3UnifiedMap renderer="logistics-route"
        :region="workspaceRegion"
        :visible-layers="visibleLayers"
        :visible-node-types="visibleNodeTypes"
        :show-labels="showLabels"
        :selected-delivery-point-ids="selectedDeliveryPointIds"
        :routes="[]"
        selected-route-id=""
        selected-waypoint-id=""
        :mode="mapMode"
        :focus-coordinate="focusedCoordinate"
        :editable="canEdit"
        :add-waypoint-mode="false"
        @node-select="toggleDeliveryPoint"
        @data-state="handleMapDataState"
      />
      <V3EnvironmentLayerPanel
        :region="workspaceRegion"
        scene-type="CITY_LOGISTICS"
        :visible-layers="visibleLayers"
        :visible-node-types="visibleNodeTypes"
        :show-labels="showLabels"
        :terrain-state="mapTerrainState"
        :details="environmentDetails"
        @toggle-layer="emit('toggleLayer', $event)"
        @toggle-node-type="toggleNodeType"
        @toggle-labels="showLabels = !showLabels"
      />
      <div class="logistics-map-legend">
        <span><i class="airport" />中心机场</span><span><i class="delivery" />候选配送点</span><span><i class="selected" />本项目启用</span><span><i class="alternate" />等待 / 备降</span>
      </div>
      <div class="logistics-region-caption"><el-icon><MapLocation /></el-icon><div><strong>{{ region.title }}</strong><small>{{ region.regionCode }} · 固定中心机场 · {{ formatCoordinateReference('WGS84') }} / {{ formatHeightDatum(region.heightDatum) }}</small></div></div>
    </main>

    <aside v-if="workspace || !loadError" class="logistics-region-inspector">
      <div v-if="loadError && workspace" class="logistics-region-sync-error" role="alert" aria-live="assertive"><span><strong>区域分析同步失败</strong><small>{{ loadError }}</small><p>当前已保留原有选择，可继续查看；保存或确认前请先重试同步。</p></span><el-button type="warning" :icon="Refresh" :loading="loading" @click="loadWorkspace">重试同步</el-button></div>
      <header>
        <div><strong>物流区域分析</strong></div>
        <p><b>{{ selectedDeliveryPointIds.length }}</b> / {{ range.minimum }}–{{ range.maximum }}</p>
      </header>

      <section class="delivery-selection">
        <header><strong>启用配送点</strong><small>选择 {{ range.minimum }}–{{ range.maximum }} 个</small></header>
        <el-select v-model="selectedDeliveryPointIds" multiple collapse-tags collapse-tags-tooltip filterable :disabled="!canEdit" placeholder="选择配送点">
          <el-option v-for="node in deliveryPoints" :key="node.id" :label="`${nodeCode(node)} · ${node.name}`" :value="node.id" />
        </el-select>
      </section>

      <section class="region-elements">
        <header><strong>区域元素</strong><small>{{ filteredRegionElements.length }} / {{ regionElements.length }} · 点击定位</small></header>
        <el-select v-model="elementFilter" size="small" placeholder="筛选元素类型">
          <el-option v-for="option in elementFilterOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <div class="region-elements-list">
          <button v-for="element in filteredRegionElements" :key="element.id" type="button" :disabled="!element.coordinate" @click="focusElement(element)">
            <span class="element-marker" :class="element.node?.type?.toLowerCase() || 'feature'" />
            <span class="element-copy"><strong>{{ element.name }}</strong><small>{{ element.kind }} · {{ element.detail }}</small></span>
            <el-icon><Location /></el-icon>
          </button>
        </div>
      </section>

      <section class="region-analysis-note">
        <header><strong>区域判断记录</strong><small>记录空间、覆盖和节点判断</small></header>
        <el-input v-model="notes" type="textarea" :rows="4" maxlength="2000" show-word-limit :disabled="!canEdit" placeholder="填写所选配送点、主要障碍、覆盖和备降条件的判断。" />
      </section>

      <footer v-if="canEdit">
        <el-button :disabled="!selectionValid" @click="save">保存分析</el-button>
        <el-button type="primary" :disabled="!selectionValid" @click="confirm">确认并进入航线规划</el-button>
      </footer>
      <footer v-else class="read-only"><el-icon><Check /></el-icon><span>{{ workspace?.regionAnalysis.status === 'CONFIRMED' ? '区域分析已确认' : '教师只读查看' }}</span></footer>
    </aside>
    <aside v-else class="logistics-region-inspector logistics-region-inspector-error" role="alert"><div class="logistics-region-load-error-side"><strong>区域分析暂不可用</strong><span>重新加载成功后才能选择配送点和提交区域判断。</span><el-button type="primary" :icon="Refresh" :loading="loading" @click="loadWorkspace">重新加载</el-button></div></aside>
  </section>
</template>

<style scoped>
.logistics-region-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0, 1fr) 350px; min-width: 0; min-height: 0; background: #dce3de; }
.logistics-region-canvas { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.logistics-region-load-error { position: absolute; z-index: 8; inset: 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; border-left: 3px solid #b05a45; padding: 16px 18px; color: #653b31; background: rgba(255,244,241,.96); box-shadow: 0 8px 24px rgba(45,65,56,.14); }
.logistics-region-load-error > span, .logistics-region-sync-error > span, .logistics-region-load-error-side { display: grid; min-width: 0; gap: 4px; }
.logistics-region-load-error strong, .logistics-region-sync-error strong, .logistics-region-load-error-side strong { font-size: 11px; }
.logistics-region-load-error small, .logistics-region-sync-error small { overflow-wrap: anywhere; font-size: 11px; }
.logistics-region-load-error p, .logistics-region-sync-error p, .logistics-region-load-error-side span { margin: 0; color: #765b54; font-size: 11px; line-height: 1.5; }
.logistics-region-load-error .el-button, .logistics-region-sync-error .el-button { flex: 0 0 auto; }
.logistics-map-legend { position: absolute; z-index: 3; top: 12px; left: 12px; display: flex; flex-wrap: wrap; gap: 8px 13px; max-width: calc(100% - 24px); border: 1px solid rgba(29,69,55,.16); border-radius: 4px; padding: 8px 10px; background: rgba(255,255,255,.94); box-shadow: 0 3px 12px rgba(25,58,47,.12); }
.logistics-map-legend span { display: flex; align-items: center; gap: 5px; color: #536860; font-size: 11px; }
.logistics-map-legend i { width: 8px; height: 8px; border-radius: 50%; background: #7f9089; }
.logistics-map-legend i.airport { border-radius: 2px; background: #263f36; }.logistics-map-legend i.selected { background: #1c7654; }.logistics-map-legend i.alternate { background: #bd7b2c; }
.logistics-region-caption { position: absolute; z-index: 3; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 8px; border-radius: 4px; padding: 9px 11px; color: white; background: rgba(21,55,44,.88); }
.logistics-region-caption > div { display: grid; gap: 2px; }.logistics-region-caption strong { font-size: 10px; }.logistics-region-caption small { color: rgba(255,255,255,.68); font-size: 11px; }
.logistics-region-inspector { min-height: 0; overflow: auto; border-left: 1px solid #ccd7d2; background: #f8faf9; }
.logistics-region-inspector-error { display: grid; place-items: center; padding: 20px; }
.logistics-region-load-error-side { border-left: 3px solid #b05a45; padding: 14px; color: #653b31; background: #fff4f1; }
.logistics-region-load-error-side .el-button { margin-top: 8px; }
.logistics-region-sync-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid #e4cbc4; padding: 10px 12px; color: #653b31; background: #fff4f1; }
.logistics-region-inspector > header { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; min-height: 64px; border-bottom: 1px solid #d9e1dd; padding: 10px 14px; background: white; }
.logistics-region-inspector > header > div { display: grid; gap: 2px; }.logistics-region-inspector > header span { color: #267052; font-size: 11px; font-weight: 700; }.logistics-region-inspector > header strong { font-size: 13px; }
.logistics-region-inspector > header p { margin: 0; color: #74867f; font-size: 10px; }.logistics-region-inspector > header p b { color: #1d6f52; font-size: 18px; }
.airport-summary { display: grid; grid-template-columns: 30px minmax(0,1fr) auto; align-items: center; gap: 9px; border-bottom: 1px solid #d8e0dc; padding: 12px 14px; background: #edf5f1; }
.airport-summary > .el-icon { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 4px; color: white; background: #245f49; }.airport-summary > div { display: grid; gap: 2px; }.airport-summary strong { font-size: 11px; }.airport-summary small { color: #71857c; font-size: 11px; }.airport-summary em { color: #27684f; font-size: 11px; font-style: normal; font-weight: 700; }
.delivery-selection,.region-analysis-note { border-bottom: 1px solid #d8e0dc; padding: 13px 14px; }.delivery-selection > header,.region-analysis-note > header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 9px; }.delivery-selection header strong,.region-analysis-note header strong { font-size: 10px; }.delivery-selection header small,.region-analysis-note header small { color: #74867f; font-size: 11px; }
.delivery-selection > div { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #dce4e0; }
.delivery-selection button { display: grid; grid-template-columns: 25px minmax(0,1fr) 16px; align-items: center; gap: 6px; min-height: 51px; border: 0; border-right: 1px solid #e0e7e3; border-bottom: 1px solid #e0e7e3; padding: 6px 7px; text-align: left; background: white; cursor: pointer; }.delivery-selection button:nth-child(2n) { border-right: 0; }.delivery-selection button.selected { box-shadow: inset 3px 0 #1f7453; background: #edf6f2; }.delivery-selection button:disabled { cursor: default; }
.delivery-selection button > i { display: grid; width: 25px; height: 25px; place-items: center; border-radius: 3px; color: #60766d; background: #edf1ef; font-size: 11px; font-style: normal; font-weight: 700; }.delivery-selection button.selected > i { color: white; background: #277255; }.delivery-selection button > span { display: grid; gap: 2px; min-width: 0; }.delivery-selection button strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.delivery-selection button small { overflow: hidden; color: #81918b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.delivery-selection button .el-icon { color: #84958e; }.delivery-selection button.selected .el-icon { color: #237153; }
.region-analysis-note :deep(.el-textarea__inner) { border-radius: 3px; font-size: 11px; line-height: 1.55; }
.region-elements { border-bottom: 1px solid #d8e0dc; padding: 13px 14px; }
.region-elements > header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.region-elements > header strong { font-size: 10px; }.region-elements > header small { color: #74867f; font-size: 11px; }
.region-elements > .el-select { width: 100%; margin-bottom: 8px; }
.region-elements-list { display: grid; max-height: 250px; overflow: auto; border: 1px solid #dce4e0; background: white; }
.region-elements-list button { display: grid; grid-template-columns: 9px minmax(0,1fr) 16px; align-items: center; gap: 7px; min-height: 38px; border: 0; border-bottom: 1px solid #e7ece9; padding: 6px 8px; text-align: left; background: white; cursor: pointer; }
.region-elements-list button:last-child { border-bottom: 0; }.region-elements-list button:hover { background: #edf6f2; }.region-elements-list button:disabled { cursor: default; opacity: .55; }
.element-marker { width: 8px; height: 8px; border-radius: 50%; background: #2c7357; }.element-marker.center_airport { border-radius: 2px; background: #263f36; }.element-marker.delivery_point { background: #538b78; }.element-marker.waiting_point { background: #bd7b2c; }.element-marker.alternate_landing_point { background: #bb6d39; }.element-marker.emergency_area { border-radius: 2px; background: #ad5149; }.element-marker.feature { border-radius: 2px; background: #7e8d87; }
.element-copy { display: grid; min-width: 0; gap: 2px; }.element-copy strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.element-copy small { overflow: hidden; color: #81918b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.region-elements-list .el-icon { color: #5c786b; }
.region-node-summary { display: grid; grid-template-columns: repeat(3,1fr); border-bottom: 1px solid #d8e0dc; background: white; }.region-node-summary > div { display: grid; grid-template-columns: 22px 1fr; align-items: center; gap: 5px; min-height: 58px; border-right: 1px solid #e1e7e4; padding: 7px; }.region-node-summary > div:last-child { border-right: 0; }.region-node-summary .el-icon { color: #2d7157; }.region-node-summary span { display: grid; gap: 1px; }.region-node-summary strong { font-size: 12px; }.region-node-summary small { color: #7d8f87; font-size: 11px; }
.logistics-region-inspector > footer { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 7px; border-top: 1px solid #d0dad5; padding: 10px 12px; background: rgba(255,255,255,.96); }.logistics-region-inspector > footer.read-only { align-items: center; justify-content: center; color: #2a7055; font-size: 11px; }
@media (max-width: 760px) { .logistics-region-load-error { inset: 12px; align-items: stretch; flex-direction: column; justify-content: center; } .logistics-region-sync-error { align-items: stretch; flex-direction: column; } }
@media (max-width: 1080px) { .logistics-region-workspace { grid-template-columns: minmax(0,1fr) 310px; }.delivery-selection > div { grid-template-columns: 1fr; }.delivery-selection button { border-right: 0; } }
@media (max-width: 760px) { .logistics-region-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: 520px auto; }.logistics-region-inspector { overflow: visible; border-top: 1px solid #ccd7d2; border-left: 0; }.delivery-selection > div { grid-template-columns: 1fr 1fr; }.delivery-selection button:nth-child(odd) { border-right: 1px solid #e0e7e3; } }

@media (max-width: 920px) {
  .logistics-region-workspace { grid-column: 2 / 4; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(360px, 50vh) auto; overflow: auto; }
  .logistics-region-inspector { border-top: 1px solid #ccd7d2; border-left: 0; overflow: visible; }
  .delivery-selection > div { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .logistics-region-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-rows: minmax(300px, 52vh) auto; }
  .logistics-map-legend { top: 8px; left: 8px; gap: 5px 9px; max-width: calc(100% - 16px); }
  .logistics-region-caption { right: 8px; bottom: 8px; left: 8px; }
}
@media (max-width: 420px) {
  .logistics-region-workspace { grid-template-rows: 280px auto; }
  .delivery-selection > div { grid-template-columns: 1fr; }
  .delivery-selection button, .delivery-selection button:nth-child(odd) { border-right: 0; }
}

</style>
