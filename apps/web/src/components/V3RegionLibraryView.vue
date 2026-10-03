<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { Aim, Connection, EditPen, Location, OfficeBuilding, Plus, Sunny } from "@element-plus/icons-vue"
import type { SceneType, V3RegionCatalogItem, V3RegionLayerCode, V3RegionMapReadinessView } from "@wurenji/shared"
import { api } from "../api"
import { initialV3MapDataState, v3MapLoadingLabel, type V3MapDataState } from "../map-loading-state"
import { v3ScenePresentation, v3SceneTypes } from "../scene-presentation"
import { regionTerrainStateLabel } from "../terrain"
import { formatCoordinateReference, formatHeightDatum, formatMapResourceSource } from "../terminology"
import { vtlMapReadinessPresentation } from "../vtl-map-readiness-presentation"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3ScenarioOverlayEditor from "./V3ScenarioOverlayEditor.vue"

const props = defineProps<{ initialSceneType?: SceneType | null }>()
const emit = defineEmits<{ createAssignment: [sceneType: SceneType, regionPackageId: string] }>()
const sceneType = ref<SceneType>(props.initialSceneType ?? "CITY_SHOW")
const regions = ref<V3RegionCatalogItem[]>([])
const selectedRegionId = ref("")
const visibleLayers = ref<V3RegionLayerCode[]>([])
const mapMode = ref<"2d" | "3d">("3d")
const loading = ref(false)
const regionsError = ref("")
const mapState = ref<V3MapDataState>(initialV3MapDataState())
const mapReadiness = ref<V3RegionMapReadinessView | null>(null)
const mapReadinessError = ref("")
const mapReadinessLoading = ref(false)
const editing = ref(false)
let regionsRequest = 0
let readinessRequest = 0
let readinessAbortController: AbortController | undefined
const sceneOptions = v3SceneTypes.map((type) => v3ScenePresentation[type])

const filteredRegions = computed(() => regions.value.filter((region) => region.sceneType === sceneType.value))
const selectedRegion = computed(() => filteredRegions.value.find((region) => region.packageId === selectedRegionId.value) ?? filteredRegions.value[0] ?? null)
const mapReadinessPresentation = computed(() => vtlMapReadinessPresentation(mapReadiness.value, false))
const environmentDiagnostics = computed(() => mapReadiness.value?.environmentDiagnostics ?? null)

const layerIcons: Record<V3RegionLayerCode, typeof OfficeBuilding> = {
  BUILDINGS: OfficeBuilding,
  RESTRICTIONS: Aim,
  WATER: Location,
  GREENLAND: Sunny,
  POSITIONING: Location,
  COMMUNICATION: Connection,
  ENVIRONMENT: Sunny
}

onMounted(loadRegions)
onBeforeUnmount(() => {
  readinessRequest += 1
  readinessAbortController?.abort()
})
watch(sceneType, selectFirstRegion)
watch(() => props.initialSceneType, (value) => {
  if (value && value !== sceneType.value) sceneType.value = value
})
watch(selectedRegion, (region) => {
  visibleLayers.value = region?.layers.filter((layer) => layer.state !== "UNAVAILABLE" && ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"].includes(layer.code)).map((layer) => layer.code) ?? []
  void loadMapReadiness(region)
}, { immediate: true })

async function loadRegions() {
  const requestId = ++regionsRequest
  loading.value = true
  regionsError.value = ""
  try {
    const loadedRegions = await api<V3RegionCatalogItem[]>("/v3/resource-packages/regions/catalog")
    if (requestId !== regionsRequest) return
    regions.value = loadedRegions
    selectFirstRegion()
  } catch (error) {
    if (requestId !== regionsRequest) return
    regionsError.value = error instanceof Error ? error.message : "预设区域加载失败"
    ElMessage.error(regionsError.value)
  } finally {
    if (requestId === regionsRequest) loading.value = false
  }
}

function retryRegions() {
  void loadRegions()
}

function selectFirstRegion() {
  selectedRegionId.value = filteredRegions.value[0]?.packageId ?? ""
}

async function loadMapReadiness(region: V3RegionCatalogItem | null) {
  const requestId = ++readinessRequest
  readinessAbortController?.abort()
  const abortController = new AbortController()
  readinessAbortController = abortController
  mapReadinessLoading.value = Boolean(region)
  mapReadiness.value = null
  mapReadinessError.value = ""
  if (!region) {
    mapReadinessLoading.value = false
    return
  }
  try {
    const readiness = await api<V3RegionMapReadinessView>(`/v3/resource-packages/regions/${region.packageId}/readiness`, { signal: abortController.signal })
    if (requestId === readinessRequest) mapReadiness.value = readiness
  } catch (error) {
    if (requestId !== readinessRequest || (error instanceof DOMException && error.name === "AbortError")) return
    if (requestId === readinessRequest) {
      mapReadinessError.value = error instanceof Error ? error.message : "地图资源检查失败"
      ElMessage.warning(mapReadinessError.value)
    }
  } finally {
    if (requestId === readinessRequest) mapReadinessLoading.value = false
  }
}

function retryMapReadiness() {
  void loadMapReadiness(selectedRegion.value)
}

function readinessLabel() {
  if (mapReadinessError.value) return "资源检查失败"
  if (!mapReadiness.value) return "地图资源检查中"
  return mapReadinessPresentation.value.title
}

function readinessClass() {
  if (mapReadinessError.value) return "failed"
  if (mapReadinessPresentation.value.state === "READY") return "ready"
  const statuses = new Set(mapReadinessPresentation.value.issues.map((issue) => issue.status))
  return statuses.has("INVALID") ? "failed" : statuses.has("EXTERNAL") ? "external" : "pending"
}

function toggleLayer(code: V3RegionLayerCode) {
  visibleLayers.value = visibleLayers.value.includes(code)
    ? visibleLayers.value.filter((item) => item !== code)
    : [...visibleLayers.value, code]
}

function layerStateLabel(state: string) {
  return state === "AVAILABLE" ? "可用" : state === "DEGRADED" ? "降级" : "不可用"
}

function environmentDiagnosticLabel(status: string) {
  return status === "READY" ? "结构完整" : status === "INCOMPLETE" ? "待正式验收" : "未提供"
}

function environmentDiagnosticClass(status: string) {
  return status.toLowerCase()
}
</script>

<template>
  <div class="education-page region-library-page" v-loading="loading">
    <header class="page-heading">
      <div><span>空间资源</span><h1>预设区域库</h1></div>
      <div v-if="!editing" class="scene-segment" aria-label="场景筛选">
        <button v-for="option in sceneOptions" :key="option.type" type="button" :class="{ active: sceneType === option.type }" :aria-pressed="sceneType === option.type" @click="sceneType = option.type">{{ option.label }}</button>
      </div>
      <span v-else class="editing-scene-lock">正在编辑：{{ v3ScenePresentation[sceneType].label }}</span>
    </header>

    <div v-if="editing && selectedRegion" class="region-editor-page">
      <V3ScenarioOverlayEditor :region="selectedRegion" @close="editing = false" />
    </div>
    <div v-else class="region-library-layout">
      <aside class="region-catalog-pane">
        <header><strong>{{ v3ScenePresentation[sceneType].catalogTitle }}</strong><small>{{ filteredRegions.length }} 个已启用版本</small></header>
        <button
          v-for="region in filteredRegions"
          :key="region.packageId"
          type="button"
          :class="{ active: selectedRegion?.packageId === region.packageId }"
          :aria-pressed="selectedRegion?.packageId === region.packageId"
          @click="selectedRegionId = region.packageId"
        >
          <span>{{ region.regionCode }}</span>
          <strong>{{ region.title }}</strong>
          <small>{{ region.summary }}</small>
        </button>
        <div v-if="!loading && regionsError" class="region-catalog-empty failed" role="alert">
          <strong>预设区域加载失败</strong>
          <span>{{ regionsError }}</span>
          <el-button text size="small" :loading="loading" :disabled="loading" @click="retryRegions">重新加载</el-button>
        </div>
        <div v-else-if="!loading && filteredRegions.length === 0" class="region-catalog-empty" role="status">
          <strong>当前场景暂无区域</strong>
          <span>请切换场景，或联系管理员启用预设区域资源。</span>
        </div>
      </aside>

      <section v-if="selectedRegion" class="region-map-pane">
        <header class="region-map-header">
          <div><span>{{ selectedRegion.regionCode }} · v{{ selectedRegion.packageVersion }}</span><h2>{{ selectedRegion.title }}</h2><p>{{ selectedRegion.summary }}</p></div>
          <div class="region-actions">
            <div class="view-segment" aria-label="预设区域地图视角"><button type="button" aria-label="2D 精确规划视角" :aria-pressed="mapMode === '2d'" :class="{ active: mapMode === '2d' }" @click="mapMode = '2d'">2D</button><button type="button" aria-label="3D 空间理解视角" :aria-pressed="mapMode === '3d'" :class="{ active: mapMode === '3d' }" @click="mapMode = '3d'">3D</button></div>
            <el-button :icon="EditPen" @click="editing = true">编辑教学覆盖层</el-button><el-button type="primary" :icon="Plus" @click="emit('createAssignment', selectedRegion.sceneType, selectedRegion.packageId)">用此区域创建任务</el-button>
          </div>
        </header>
        <div class="region-map-canvas">
          <V3UnifiedMap :region="selectedRegion" :visible-layers="visibleLayers" :mode="mapMode" @data-state="mapState = $event" />
          <div class="region-map-badges" role="status" aria-live="polite" aria-label="地图资源状态">
            <span :class="{ loading: mapState.phase !== 'READY', failed: mapState.imagery === 'FAILED', degraded: mapState.imagery === 'DEGRADED' }">{{ v3MapLoadingLabel(mapState) }}</span>
            <span :class="mapState.terrain === 'FAILED' || mapState.terrain === 'ELLIPSOID' ? 'failed' : mapState.terrain === 'LOADING' ? 'loading' : mapState.terrain === 'DEGRADED' ? 'degraded' : 'ready'">{{ regionTerrainStateLabel(mapState.terrain) }}</span>
            <span :class="readinessClass()">{{ mapReadinessError ? '资源检查失败' : readinessLabel() }}</span>
          </div>
        </div>
      </section>

      <section v-else-if="!loading && regionsError" class="region-map-empty failed" role="alert">
        <el-icon><Connection /></el-icon>
        <strong>预设区域暂时无法加载</strong>
        <span>{{ regionsError }}</span>
        <el-button type="primary" size="small" :loading="loading" :disabled="loading" @click="retryRegions">重新加载</el-button>
      </section>
      <section v-else-if="!loading" class="region-map-empty" role="status">
        <el-icon><Location /></el-icon>
        <strong>暂无可用教学区域</strong>
        <span>当前场景没有已启用的区域资源，地图和高程数据暂不可用。</span>
      </section>

      <aside v-if="selectedRegion" class="region-layer-pane">
        <header><strong>专题图层</strong><small>独立控制地图可见性</small></header>
        <button
          v-for="layer in selectedRegion.layers.filter(item => ['BUILDINGS', 'RESTRICTIONS', 'WATER', 'GREENLAND'].includes(item.code))"
          :key="layer.code"
          type="button"
          :disabled="layer.state === 'UNAVAILABLE'"
          :class="{ active: visibleLayers.includes(layer.code), degraded: layer.state === 'DEGRADED' }"
          :aria-pressed="visibleLayers.includes(layer.code)"
          :aria-label="`${layer.title}，${layerStateLabel(layer.state)}${layer.state === 'UNAVAILABLE' ? '，当前不可用' : visibleLayers.includes(layer.code) ? '，已显示' : '，未显示'}`"
          @click="toggleLayer(layer.code)"
        >
          <el-icon><component :is="layerIcons[layer.code]" /></el-icon>
          <span><strong>{{ layer.title }}</strong><small>{{ formatMapResourceSource(layer.source) }} · 版本 {{ layer.version }}</small></span>
          <em>{{ layerStateLabel(layer.state) }}</em>
        </button>
        <dl class="region-data-facts">
          <div><dt>高度基准</dt><dd>{{ formatHeightDatum(selectedRegion.heightDatum) }}</dd></div>
          <div><dt>地形版本</dt><dd>{{ selectedRegion.terrainResourceVersion || '未指定' }}</dd></div>
          <div><dt>DEM 来源</dt><dd>{{ selectedRegion.terrain ? '区域包已声明 DEM' : '教学起伏地形（非正式 DEM）' }}</dd></div>
          <div><dt>离线验收</dt><dd>{{ readinessLabel() }}</dd></div>
          <div><dt>业务坐标</dt><dd>{{ formatCoordinateReference('WGS84') }}</dd></div>
          <div><dt>资源校验</dt><dd>{{ selectedRegion.checksum.slice(0, 10) }}</dd></div>
        </dl>
        <div v-if="mapReadinessError" class="region-readiness-error" role="alert">
          <strong>地图资源检查失败</strong>
          <span>{{ mapReadinessError }}</span>
          <el-button text size="small" :loading="mapReadinessLoading" :disabled="mapReadinessLoading" @click="retryMapReadiness">重新检查</el-button>
        </div>
        <section v-if="mapReadiness" class="region-readiness-summary" :class="mapReadinessPresentation.state.toLowerCase()" aria-live="polite">
          <strong>{{ mapReadinessPresentation.title }}</strong>
          <span>{{ mapReadinessPresentation.detail }}</span>
          <ul v-if="mapReadinessPresentation.issues.length">
            <li v-for="issue in mapReadinessPresentation.issues" :key="issue.kind"><b>{{ issue.label }}</b><em>{{ issue.statusLabel }}</em><span>{{ issue.message }}</span><small>下一步：{{ issue.nextStep }}</small></li>
          </ul>
        </section>
        <section v-if="environmentDiagnostics" class="region-environment-diagnostics" :class="environmentDiagnosticClass(environmentDiagnostics.status)" aria-live="polite">
          <header><strong>环境数据诊断</strong><em>{{ environmentDiagnosticLabel(environmentDiagnostics.status) }}</em></header>
          <p>{{ environmentDiagnostics.message }}</p>
          <dl>
            <div><dt>建筑物</dt><dd>{{ environmentDiagnostics.buildingCount }} 项</dd></div>
            <div><dt>障碍物</dt><dd>{{ environmentDiagnostics.obstacleCount }} 项</dd></div>
            <div><dt>缺少高度</dt><dd>{{ environmentDiagnostics.missingHeightCount }} 项</dd></div>
          </dl>
          <small v-if="environmentDiagnostics.source">来源：{{ formatMapResourceSource(environmentDiagnostics.source) }} · 版本 {{ environmentDiagnostics.version || '未指定' }}</small>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.region-editor-page {
  display: block;
  height: calc(100dvh - 150px);
  min-height: 620px;
  overflow: hidden;
  border: 1px solid var(--line);
  background: var(--surface);
}

.region-editor-page :deep(.scenario-overlay-editor) {
  height: 100%;
  min-height: 0;
}

.editing-scene-lock {
  align-self: center;
  border: 1px solid var(--line);
  padding: 7px 10px;
  color: var(--muted);
  background: var(--surface-soft);
  font-size: 11px;
}

.region-editor-guide {
  display: grid;
  align-content: start;
  gap: 18px;
  border-left: 1px solid var(--line);
  padding: 18px 15px;
  background: var(--surface-soft);
}

.region-editor-guide header {
  display: grid;
  gap: 5px;
}

.region-editor-guide header span {
  color: var(--green);
  font-size: 10px;
  font-weight: 800;
}

.region-editor-guide header strong {
  font-size: 15px;
}

.region-editor-guide ol {
  display: grid;
  gap: 14px;
  margin: 0;
  padding: 0 0 0 18px;
}

.region-editor-guide li {
  display: grid;
  gap: 4px;
  padding-left: 3px;
}

.region-editor-guide li b {
  font-size: 11px;
}

.region-editor-guide li small,
.region-editor-guide-note {
  color: var(--muted);
  font-size: 10px;
  line-height: 1.6;
}

.region-editor-guide-note {
  border-left: 2px solid var(--green);
  padding-left: 10px;
}

@media (max-width: 760px) {
  .region-editor-page { height: auto; min-height: 0; overflow: visible; }
}
@media (max-width: 640px) {
  .region-library-page { padding-inline: 10px; }
  .region-map-canvas { height: min(62dvh, 460px); min-height: 300px; }
  .region-actions { flex-wrap: wrap; }
  .region-actions .el-button,
  .region-actions .view-segment { min-width: 0; flex: 1 1 120px; }
  .region-editor-guide { gap: 12px; padding: 14px 12px; }
  .region-editor-guide ol { gap: 9px; }
}
</style>
