<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { Aim, Check, Close, Delete, EditPen, Plus, Refresh, RefreshLeft, RefreshRight, Upload } from "@element-plus/icons-vue"
import type { SceneType, V3Coordinate, V3RegionCatalogItem, V3RegionLayerCode, V3ScenarioOverlayObject, V3ScenarioOverlayObjectType, V3ScenarioOverlayVersionView } from "@wurenji/shared"
import { v3ScenarioOverlayObjectTypes } from "@wurenji/shared"
import { api } from "../api"
import { validateScenarioOverlayDraft } from "../scenario-overlay-validation"
import { firstDrawableType, sceneEditorWorkflowFor, type SceneEditorStep } from "../scene-editor-workflows"
import { commitOverlayEditorHistory, createOverlayEditorHistory, redoOverlayEditorHistory, undoOverlayEditorHistory, type OverlayEditorHistory } from "../overlay-editor-history"
import { moveOverlayObjectVertex } from "../overlay-editor-geometry"
import V3UnifiedMap from "./V3UnifiedMap.vue"

const props = defineProps<{ region: V3RegionCatalogItem }>()
const emit = defineEmits<{ close: [] }>()

const overlays = ref<V3ScenarioOverlayVersionView[]>([])
const selectedId = ref("")
const selected = computed(() => overlays.value.find((item) => item.id === selectedId.value) ?? null)
const name = ref("")
const objects = ref<V3ScenarioOverlayObject[]>([])
const objectType = ref<V3ScenarioOverlayObjectType>("DELIVERY_POINT")
const objectName = ref("")
const objectHeightMeters = ref(12)
const selectedObjectId = ref("")
const mapRef = ref<InstanceType<typeof V3UnifiedMap> | null>(null)
const drawing = ref(false)
const drawingPoints = ref<V3Coordinate[]>([])
const loading = ref(false)
const saving = ref(false)
const loadError = ref("")
const mapMode = ref<"2d" | "3d">("2d")
const labelsVisible = ref(true)
const visibleBaseLayers = ref<V3RegionLayerCode[]>([])
const entityLayerCodes = new Set<V3RegionLayerCode>(["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"])
const baseLayerOptions = computed(() => props.region.layers.filter((layer) => entityLayerCodes.has(layer.code) && layer.state !== "UNAVAILABLE"))
const activeStep = ref("base")
const objectFilter = ref<"ALL" | V3ScenarioOverlayObjectType>("ALL")
type OverlayEditorSnapshot = { objects: V3ScenarioOverlayObject[]; name: string }
const history = ref<OverlayEditorHistory<OverlayEditorSnapshot>>(createOverlayEditorHistory({ objects: [], name: "" }))
const canUndo = computed(() => history.value.past.length > 0 && canEdit.value)
const canRedo = computed(() => history.value.future.length > 0 && canEdit.value)

const objectTypeLabels: Record<V3ScenarioOverlayObjectType, string> = {
  LOGISTICS_CENTER: "物流中心",
  DELIVERY_POINT: "配送点",
  ALTERNATE_LANDING_POINT: "备降点",
  WAITING_POINT: "等待点",
  AIRWAY: "航路",
  FLIGHT_CORRIDOR: "航路",
  FLYABLE_AREA: "禁限区域",
  TASK_POINT: "任务点",
  MISSION_POINT: "任务点",
  EMERGENCY_POINT: "异常处置点",
  OBSTACLE: "障碍物",
  EVENT_AREA: "教学事件区域",
  TEACHING_EVENT_AREA: "教学事件区域"
}
const pointTypes = new Set<V3ScenarioOverlayObjectType>(["LOGISTICS_CENTER", "DELIVERY_POINT", "ALTERNATE_LANDING_POINT", "WAITING_POINT", "TASK_POINT", "MISSION_POINT", "EMERGENCY_POINT", "OBSTACLE"])
const lineTypes = new Set<V3ScenarioOverlayObjectType>(["AIRWAY", "FLIGHT_CORRIDOR"])
const editorSteps = computed<readonly SceneEditorStep[]>(() => sceneEditorWorkflowFor(props.region.sceneType))
const activeStepDefinition = computed(() => editorSteps.value.find((step) => step.id === activeStep.value) ?? editorSteps.value[0]!)
const availableObjectTypes = computed(() => activeStepDefinition.value.types.length ? activeStepDefinition.value.types : v3ScenarioOverlayObjectTypes)
const stepCanDraw = computed(() => activeStepDefinition.value.types.length > 0 && canEdit.value)
const minimumDrawingPoints = computed(() => pointTypes.has(objectType.value) ? 1 : lineTypes.has(objectType.value) ? 2 : 3)
const filteredObjects = computed(() => objectFilter.value === "ALL" ? objects.value : objects.value.filter((item) => item.type === objectFilter.value))
const objectFilterTypes = computed(() => Array.from(new Set(objects.value.map((item) => item.type))))
const drawingHint = computed(() => pointTypes.has(objectType.value) ? "点击地图放置一个点" : lineTypes.has(objectType.value) ? "连续点击地图添加航点，完成后保存" : "连续点击地图添加边界，完成后闭合并保存")
const canEdit = computed(() => !selected.value || selected.value.status === "DRAFT")
const editorFeatures = computed(() => {
  const result: Array<{ id: string; name: string; type: V3ScenarioOverlayObjectType; geometryType: "POINT" | "LINESTRING" | "POLYGON"; position?: V3Coordinate; positions?: V3Coordinate[]; color?: string; heightMeters?: number; radiusMeters?: number }> = []
  for (const object of filteredObjects.value) {
    const geometry = object.geometry
    const storedHeight = Number(object.properties.heightMeters ?? 0)
    const heightMeters = storedHeight > 0 ? storedHeight : (requiresHeight(object.type) ? 12 : 0)
    const color = objectColor(object.type)
    if (geometry.type === "Point") result.push({ id: object.id, name: object.name, type: object.type, color, heightMeters, radiusMeters: Number(object.properties.radiusMeters ?? 5), geometryType: "POINT", position: coordinate(geometry.coordinates as readonly number[]) })
    else if (geometry.type === "LineString") result.push({ id: object.id, name: object.name, type: object.type, color, heightMeters, geometryType: "LINESTRING", positions: (geometry.coordinates as readonly number[][]).map(coordinate) })
    else if (geometry.type === "Polygon") result.push({ id: object.id, name: object.name, type: object.type, color, heightMeters, geometryType: "POLYGON", positions: (geometry.coordinates as readonly (readonly number[][])[])[0]?.map(coordinate) ?? [] })
  }
  return result
})

onMounted(() => {
  window.addEventListener("keydown", handleHistoryKeyDown)
  // Buildings are imported base-map context.  Teacher-created obstacles are
  // stored in the overlay, so keep the imported building layer hidden by
  // default while still exposing it as an optional filter.
  visibleBaseLayers.value = baseLayerOptions.value.filter((layer) => layer.code !== "BUILDINGS").map((layer) => layer.code)
  loadOverlays()
})
onBeforeUnmount(() => window.removeEventListener("keydown", handleHistoryKeyDown))
watch(() => props.region, () => {
  visibleBaseLayers.value = baseLayerOptions.value.filter((layer) => layer.code !== "BUILDINGS").map((layer) => layer.code)
  mapMode.value = "2d"
  activeStep.value = editorSteps.value[0]?.id ?? "base"
  objectType.value = firstDrawableType(props.region.sceneType)
}, { deep: true })

async function loadOverlays() {
  loading.value = true
  loadError.value = ""
  try {
    overlays.value = await api<V3ScenarioOverlayVersionView[]>(`/v3/scenario-overlays?sceneType=${encodeURIComponent(props.region.sceneType)}&regionPackageId=${encodeURIComponent(props.region.packageId)}`)
    // A published/archived version is an immutable history record.  Do not
    // select it as the active editor document when no draft exists, otherwise
    // every drawing control becomes disabled as soon as the editor opens.
    // Start with a clean draft instead; an existing version can still be
    // selected from the history list and explicitly forked when needed.
    const preferred = overlays.value.find((item) => item.status === "DRAFT")
    if (preferred) selectOverlay(preferred)
    else resetDraft()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "覆盖层列表加载失败"
  } finally {
    loading.value = false
  }
}

function selectOverlay(value: V3ScenarioOverlayVersionView) {
  selectedId.value = value.id
  name.value = value.name
  objects.value = cloneOverlayObjects(value.objects)
  drawing.value = false
  drawingPoints.value = []
  selectedObjectId.value = ""
  activeStep.value = "base"
  objectFilter.value = "ALL"
  syncObjectTypeForStep()
  resetHistory()
}

function resetDraft() {
  selectedId.value = ""
  name.value = `${props.region.title} 教学覆盖层`
  objects.value = []
  drawing.value = false
  drawingPoints.value = []
  selectedObjectId.value = ""
  activeStep.value = "base"
  objectFilter.value = "ALL"
  objectType.value = firstDrawableType(props.region.sceneType)
  resetHistory()
}

function snapshot(): OverlayEditorSnapshot {
  return { objects: cloneOverlayObjects(objects.value), name: name.value }
}

function resetHistory() {
  history.value = createOverlayEditorHistory(snapshot())
}

function commitHistory() {
  history.value = commitOverlayEditorHistory(history.value, snapshot())
}

function restoreSnapshot(value: OverlayEditorSnapshot) {
  objects.value = cloneOverlayObjects(value.objects)
  name.value = value.name
  selectedObjectId.value = ""
  drawing.value = false
  drawingPoints.value = []
}

function undoEdit() {
  if (!canUndo.value) return
  history.value = undoOverlayEditorHistory(history.value)
  restoreSnapshot(history.value.present)
}

function redoEdit() {
  if (!canRedo.value) return
  history.value = redoOverlayEditorHistory(history.value)
  restoreSnapshot(history.value.present)
}

function handleHistoryKeyDown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  if (event.key.toLowerCase() === "z") {
    event.preventDefault()
    if (event.shiftKey) redoEdit()
    else undoEdit()
  } else if (event.key.toLowerCase() === "y") {
    event.preventDefault()
    redoEdit()
  }
}

function cloneOverlayObjects(value: readonly V3ScenarioOverlayObject[]): V3ScenarioOverlayObject[] {
  // API responses can be reactive Vue proxies after they enter the ref. JSON
  // cloning keeps only the persisted overlay data and avoids structuredClone
  // rejecting a proxy or a non-cloneable object from a custom map adapter.
  return JSON.parse(JSON.stringify(value)) as V3ScenarioOverlayObject[]
}

function selectStep(stepId: string) {
  const currentIndex = editorSteps.value.findIndex((step) => step.id === activeStep.value)
  const targetIndex = editorSteps.value.findIndex((step) => step.id === stepId)
  if (targetIndex > currentIndex) {
    const error = validateStepBeforeNext(activeStep.value)
    if (error) {
      ElMessage.warning(error)
      return
    }
  }
  activeStep.value = stepId
  syncObjectTypeForStep()
}

function countObjects(...types: V3ScenarioOverlayObjectType[]): number {
  return objects.value.filter((item) => types.includes(item.type)).length
}

function validateStepBeforeNext(stepId: string): string | null {
  if (stepId === "base") {
    return baseLayerOptions.value.length === 0 ? "当前区域没有可用的基础地图图层，暂时无法继续。" : null
  }
  if (props.region.sceneType === "CITY_LOGISTICS" && stepId === "network") {
    const waiting = countObjects("WAITING_POINT")
    const alternate = countObjects("ALTERNATE_LANDING_POINT")
    const center = countObjects("LOGISTICS_CENTER")
    if (center < 1) return "请至少添加 1 个固定中心物流机场。"
    if (waiting < 2) return `等待点至少需要 2 个，当前为 ${waiting} 个。`
    if (alternate < 2) return `备降点至少需要 2 个，当前为 ${alternate} 个。`
  }
  if (props.region.sceneType === "CITY_LOGISTICS" && stepId === "tasks") {
    const delivery = countObjects("DELIVERY_POINT")
    if (delivery < 3) return `配送点至少需要 3 个，当前为 ${delivery} 个。`
  }
  if (props.region.sceneType === "CITY_LOGISTICS" && stepId === "limits") {
    if (countObjects("OBSTACLE") < 1) return "请至少添加 1 个障碍物。"
    if (countObjects("FLYABLE_AREA") < 1) return "请至少添加 1 个禁限区域。"
  }
  if (props.region.sceneType === "CITY_SHOW" && stepId === "areas") {
    if (countObjects("OBSTACLE") < 1) return "请至少添加 1 个障碍物。"
    if (countObjects("FLYABLE_AREA") < 1) return "请至少添加 1 个禁限区域。"
  }
  if (props.region.sceneType === "VTOL_INSPECTION" && stepId === "objects") {
    if (countObjects("OBSTACLE") < 1) return "请至少添加 1 个障碍物。"
    if (countObjects("TASK_POINT", "MISSION_POINT") < 1) return "请至少添加 1 个任务点或任务区。"
  }
  if (props.region.sceneType === "VTOL_INSPECTION" && stepId === "airfields") {
    if (countObjects("ALTERNATE_LANDING_POINT") < 1) return "请至少添加 1 个候选起降/备降区域。"
  }
  if (props.region.sceneType === "VTOL_INSPECTION" && stepId === "limits") {
    if (countObjects("FLYABLE_AREA") < 1) return "请至少添加 1 个禁限区域。"
  }
  return null
}

function syncObjectTypeForStep() {
  const types = activeStepDefinition.value.types
  if (types.length && !types.includes(objectType.value)) objectType.value = types[0]!
}

function startDrawing() {
  if (!stepCanDraw.value) return
  if (pointTypes.has(objectType.value) && !objectName.value.trim()) objectName.value = objectTypeLabels[objectType.value]
  drawing.value = true
  drawingPoints.value = []
}

function handleMapClick(coordinate: V3Coordinate) {
  if (!drawing.value || !canEdit.value) return
  if (pointTypes.has(objectType.value)) {
    drawingPoints.value = [coordinate]
    finishDrawing()
  } else drawingPoints.value = [...drawingPoints.value, coordinate]
}

function finishDrawing() {
  if (!drawing.value || drawingPoints.value.length < minimumDrawingPoints.value) return
  const points = drawingPoints.value
  const id = `obj_${Date.now().toString(36)}_${objects.value.length + 1}`
  const nameValue = objectName.value.trim() || objectTypeLabels[objectType.value]
  const geometryType = pointTypes.has(objectType.value) ? "POINT" as const : lineTypes.has(objectType.value) ? "LINESTRING" as const : "POLYGON" as const
  const geometry: V3ScenarioOverlayObject["geometry"] = pointTypes.has(objectType.value)
    ? { type: "Point", coordinates: tupleWithAltitude(points[0]!) }
    : lineTypes.has(objectType.value)
      ? { type: "LineString", coordinates: points.map(tupleWithAltitude) }
      : { type: "Polygon", coordinates: [[...points, points[0]!].map(tupleWithAltitude)] }
  const height = requiresHeight(objectType.value) ? Math.max(1, Math.round(Number(objectHeightMeters.value) || 12)) : 0
  objects.value = [...objects.value, { id, code: id, type: objectType.value, name: nameValue, geometryType, geometry, properties: height > 0 ? { heightMeters: height } : {} }]
  commitHistory()
  drawing.value = false
  drawingPoints.value = []
  objectName.value = ""
  objectHeightMeters.value = 12
}

function removeObject(id: string) {
  if (!canEdit.value) return
  if (!objects.value.some((item) => item.id === id)) return
  objects.value = objects.value.filter((item) => item.id !== id)
  commitHistory()
}

async function saveDraft() {
  if (!name.value.trim()) return ElMessage.warning("请填写覆盖层名称")
  if (!objects.value.length) return ElMessage.warning("至少配置一个覆盖层对象")
  const validation = validateScenarioOverlayDraft(name.value, objects.value, props.region.boundary)
  if (!validation.valid) return ElMessage.warning(validation.errors[0] ?? "覆盖层对象校验失败")
  saving.value = true
  try {
    const body = { sceneType: props.region.sceneType as SceneType, regionPackageId: props.region.packageId, name: name.value.trim(), objects: objects.value, ...(selected.value ? { expectedRevision: selected.value.revision } : {}) }
    const saved = selected.value
      ? await api<V3ScenarioOverlayVersionView>(`/v3/scenario-overlays/${selected.value.id}`, { method: "PUT", body: JSON.stringify(body) })
      : await api<V3ScenarioOverlayVersionView>("/v3/scenario-overlays", { method: "POST", body: JSON.stringify(body) })
    replaceOverlay(saved)
    selectOverlay(saved)
    ElMessage.success("覆盖层草稿已保存")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "覆盖层保存失败")
  } finally {
    saving.value = false
  }
}

async function publishDraft() {
  if (!selected.value || selected.value.status !== "DRAFT") return
  saving.value = true
  try {
    const published = await api<V3ScenarioOverlayVersionView>(`/v3/scenario-overlays/versions/${selected.value.id}/publish`, { method: "POST", body: JSON.stringify({ expectedRevision: selected.value.revision }) })
    replaceOverlay(published)
    selectOverlay(published)
    ElMessage.success("覆盖层已发布")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "覆盖层发布失败")
  } finally {
    saving.value = false
  }
}

async function createDraftFromSelected() {
  if (!selected.value || selected.value.status === "DRAFT") return
  saving.value = true
  try {
    const draft = await api<V3ScenarioOverlayVersionView>(`/v3/scenario-overlays/versions/${selected.value.id}/fork`, { method: "POST" })
    replaceOverlay(draft)
    selectOverlay(draft)
    ElMessage.success("已创建新的可编辑草稿")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "创建草稿失败")
  } finally {
    saving.value = false
  }
}

function replaceOverlay(value: V3ScenarioOverlayVersionView) {
  const index = overlays.value.findIndex((item) => item.id === value.id)
  if (index < 0) overlays.value = [value, ...overlays.value]
  else overlays.value.splice(index, 1, value)
}

function coordinate(value: readonly number[]): V3Coordinate {
  return { longitude: value[0] ?? 0, latitude: value[1] ?? 0, ...(typeof value[2] === "number" ? { altitudeMeters: value[2] } : {}) }
}

function tuple(point: V3Coordinate): [number, number] { return [point.longitude, point.latitude] }

function tupleWithAltitude(point: V3Coordinate): [number, number] | [number, number, number] {
  return typeof point.altitudeMeters === "number" ? [point.longitude, point.latitude, point.altitudeMeters] : tuple(point)
}

function handleMapSelected(id: string | null) { selectedObjectId.value = id ?? "" }

function handleEditorFeatureMoved(id: string, point: V3Coordinate, vertexIndex: number | null) {
  if (!canEdit.value) return
  const next = cloneOverlayObjects(objects.value)
  const index = next.findIndex((candidate) => candidate.id === id)
  if (index < 0) return
  const moved = moveOverlayObjectVertex(next[index]!, point, vertexIndex)
  if (!moved) return
  next.splice(index, 1, moved)
  objects.value = next
  selectedObjectId.value = id
}

function handleMapDataState() {
  // Specialized scene maps own resource and terrain status; the editor only needs their shared canvas.
}

function focusObject(item: V3ScenarioOverlayObject) {
  selectedObjectId.value = item.id
  const coordinates = item.geometry.type === "Point"
    ? [coordinate(item.geometry.coordinates)]
    : item.geometry.type === "LineString"
      ? item.geometry.coordinates.map(coordinate)
      : (item.geometry.coordinates[0] ?? []).map(coordinate)
  const first = coordinates[0]
  if (first) mapRef.value?.focusEditorFeature(item.id)
  selectedObjectId.value = item.id
}

function toggleBaseLayer(code: V3RegionLayerCode) {
  visibleBaseLayers.value = visibleBaseLayers.value.includes(code)
    ? visibleBaseLayers.value.filter((item) => item !== code)
    : [...visibleBaseLayers.value, code]
}

function requiresHeight(type: V3ScenarioOverlayObjectType): boolean {
  return type === "OBSTACLE" || type === "FLYABLE_AREA" || type === "AIRWAY"
}

function objectColor(type: V3ScenarioOverlayObjectType): string {
  const colors: Partial<Record<V3ScenarioOverlayObjectType, string>> = {
    OBSTACLE: "#a83b56", FLYABLE_AREA: "#c55245", AIRWAY: "#247457", FLIGHT_CORRIDOR: "#247457",
    DELIVERY_POINT: "#2f6fa9", ALTERNATE_LANDING_POINT: "#bd7b2c", WAITING_POINT: "#2f78a5",
    LOGISTICS_CENTER: "#244d3e", TASK_POINT: "#b9700c", MISSION_POINT: "#b9700c",
    EVENT_AREA: "#7258a6", TEACHING_EVENT_AREA: "#7258a6"
  }
  return colors[type] ?? "#55706a"
}

function statusLabel(status: V3ScenarioOverlayVersionView["status"]) { return status === "DRAFT" ? "草稿" : status === "PUBLISHED" ? "已发布" : "已归档" }
</script>

<template>
  <div class="scenario-overlay-editor" v-loading="loading || saving">
    <header class="overlay-editor-header">
      <div><span>TEACHING OVERLAY · {{ region.regionCode }}</span><h2>教师场景覆盖层</h2><p>基础地图保持只读，新增对象保存为可发布版本。</p></div>
      <div class="overlay-editor-actions"><el-button :icon="Refresh" @click="loadOverlays">刷新版本</el-button><el-button :icon="Close" @click="emit('close')">返回区域</el-button></div>
    </header>
    <div class="overlay-editor-layout">
      <aside class="overlay-editor-sidebar">
        <header><strong>覆盖层版本</strong><el-button text :icon="Plus" aria-label="新建覆盖层草稿" title="新建覆盖层草稿" @click="resetDraft" /></header>
        <ol class="overlay-editor-steps" aria-label="编辑流程"><li v-for="(step, index) in editorSteps" :key="step.id" :class="{ done: (step.id === 'base' && visibleBaseLayers.length > 0) || (step.id !== 'base' && step.id !== 'publish' && objects.some(item => step.types.includes(item.type))) }"><button type="button" class="overlay-step-button" :class="{ active: activeStep === step.id }" :aria-current="activeStep === step.id ? 'step' : undefined" @click="selectStep(step.id)"><span>{{ index + 1 }}</span><div><strong>{{ step.title }}</strong><small>{{ step.hint }}</small></div></button></li></ol>
        <div v-if="overlays.length" class="overlay-version-list"><button v-for="item in overlays" :key="item.id" type="button" :class="{ active: item.id === selectedId }" @click="selectOverlay(item)"><span><strong>{{ item.name }}</strong><small>v{{ item.versionNo }} · {{ statusLabel(item.status) }}</small></span><em>{{ item.objects.length }} 项</em></button></div>
        <div v-else-if="!loadError" class="overlay-empty">还没有覆盖层版本</div>
        <div v-if="loadError" class="overlay-error" role="alert">{{ loadError }}<el-button text size="small" @click="loadOverlays">重试</el-button></div>
        <section class="overlay-layer-list">
          <header><strong>地图图层</strong><small>实体基础要素</small></header>
          <button v-for="layer in baseLayerOptions" :key="layer.code" type="button" :class="{ active: visibleBaseLayers.includes(layer.code) }" :aria-pressed="visibleBaseLayers.includes(layer.code)" @click="toggleBaseLayer(layer.code)"><i /><span>{{ layer.title }}</span><small>{{ visibleBaseLayers.includes(layer.code) ? '显示' : '隐藏' }}</small></button>
          <button type="button" :class="{ active: labelsVisible }" :aria-pressed="labelsVisible" @click="labelsVisible = !labelsVisible"><i /><span>对象名称</span><small>{{ labelsVisible ? '显示' : '隐藏' }}</small></button>
        </section>
        <label class="overlay-name-field"><span>版本名称</span><el-input v-model="name" maxlength="120" :disabled="!canEdit" /></label>
        <div v-if="activeStep !== 'base' && activeStep !== 'publish'" class="overlay-type-field"><label><span>对象类型</span><el-select v-model="objectType" :disabled="!canEdit"><el-option v-for="type in availableObjectTypes" :key="type" :label="objectTypeLabels[type]" :value="type" /></el-select></label><label><span>对象名称</span><el-input v-model="objectName" :disabled="!canEdit" maxlength="160" /></label><label v-if="requiresHeight(objectType)"><span>立体高度（米）</span><el-input-number v-model="objectHeightMeters" :min="1" :max="500" :step="1" :disabled="!canEdit" /></label></div>
        <p v-if="activeStep === 'base'" class="overlay-hint">{{ activeStepDefinition.hint }} 建筑、水域和绿地是可选的基础地图背景；教师新增的障碍、禁限区和任务对象保存在覆盖层中。定位、通信、环境与气象属于配置参数。</p>
        <p v-else-if="activeStep === 'publish'" class="overlay-hint">{{ activeStepDefinition.hint }}</p>
        <template v-else><p class="overlay-hint">{{ drawingHint }}</p><div class="overlay-drawing-actions"><el-button type="primary" :icon="EditPen" :disabled="!stepCanDraw || drawing" @click="startDrawing">开始绘制</el-button><el-button v-if="drawing && !pointTypes.has(objectType)" :disabled="drawingPoints.length < minimumDrawingPoints" @click="finishDrawing">完成对象</el-button></div></template>
        <p v-if="selected && selected.status !== 'DRAFT'" class="overlay-readonly-hint">当前是{{ statusLabel(selected.status) }}版本，不能直接修改。请先在底部点击“复制为草稿”。</p>
        <label class="overlay-filter-field"><span>对象列表筛选</span><el-select v-model="objectFilter" :disabled="!objects.length"><el-option label="全部对象" value="ALL" /><el-option v-for="type in objectFilterTypes" :key="type" :label="objectTypeLabels[type]" :value="type" /></el-select></label>
        <div class="overlay-object-list"><div v-for="item in filteredObjects" :key="item.id" :class="{ selected: item.id === selectedObjectId }"><button class="overlay-object-focus" type="button" :aria-pressed="item.id === selectedObjectId" @click="focusObject(item)"><span><strong>{{ item.name }}</strong><small>{{ objectTypeLabels[item.type] }} · {{ item.geometry.type }}</small></span><el-icon aria-hidden="true"><Aim /></el-icon></button><el-button text type="danger" :icon="Delete" :disabled="!canEdit" aria-label="删除覆盖层对象" title="删除覆盖层对象" @click="removeObject(item.id)" /></div><p v-if="!filteredObjects.length">{{ objects.length ? '当前筛选没有对象' : '地图上还没有教师对象' }}</p></div>
        <footer><el-button type="primary" :icon="Check" :disabled="!canEdit" @click="saveDraft">保存草稿</el-button><el-button v-if="selected?.status === 'DRAFT'" :icon="Upload" :disabled="!canEdit" @click="publishDraft">发布版本</el-button><el-button v-else-if="selected" :icon="EditPen" @click="createDraftFromSelected">复制为草稿</el-button></footer>
      </aside>
      <main class="overlay-editor-map">
        <div class="overlay-map-toolbar" role="toolbar" aria-label="地图视图与图层控制">
          <div class="overlay-view-switch" aria-label="编辑器地图视图">
            <button type="button" :class="{ active: mapMode === '2d' }" :aria-pressed="mapMode === '2d'" @click="mapMode = '2d'">2D 编辑</button>
            <button type="button" :class="{ active: mapMode === '3d' }" :aria-pressed="mapMode === '3d'" @click="mapMode = '3d'">3D 复核</button>
          </div>
          <div class="overlay-history-actions" aria-label="编辑历史">
            <button type="button" title="撤销 (Ctrl+Z)" aria-label="撤销" :disabled="!canUndo" @click="undoEdit"><el-icon><RefreshLeft /></el-icon></button>
            <button type="button" title="重做 (Ctrl+Y)" aria-label="重做" :disabled="!canRedo" @click="redoEdit"><el-icon><RefreshRight /></el-icon></button>
          </div>
          <span class="overlay-map-mode-note">{{ mapMode === '2d' ? '二维编辑 · 可放置和绘制教学元素' : '三维编辑 · 可复核空间关系并继续绘制' }}</span>
        </div>
        <V3UnifiedMap ref="mapRef" class="overlay-editor-map-canvas" :region="region" :visible-layers="visibleBaseLayers" :mode="mapMode" :editor-features="editorFeatures" :editor-drawing-points="drawingPoints" :editor-drawing-active="drawing" :editor-editing-enabled="canEdit" :editor-labels-visible="labelsVisible" @data-state="handleMapDataState" @editor-map-click="handleMapClick" @editor-map-selected="handleMapSelected" @editor-feature-moved="handleEditorFeatureMoved" />
        <div class="overlay-map-note">{{ drawing ? `正在绘制：${objectTypeLabels[objectType]} · 已选 ${drawingPoints.length} 个点` : '基础图层只读 · 覆盖层对象可编辑' }}</div>
      </main>
      <aside class="overlay-editor-guide">
        <section class="overlay-guide-card">
          <span class="overlay-guide-kicker">区域基础资源</span>
          <h3>{{ region.title }}</h3>
          <dl>
            <div><dt>区域编码</dt><dd>{{ region.regionCode }}</dd></div>
            <div><dt>资源版本</dt><dd>v{{ region.packageVersion }}</dd></div>
            <div><dt>基础图层</dt><dd>{{ region.layers.length }} 个</dd></div>
            <div><dt>边界点</dt><dd>{{ region.boundary.length }} 个</dd></div>
          </dl>
        </section>
        <section class="overlay-guide-card">
          <header><strong>当前编辑</strong><em>{{ objects.length }} 项</em></header>
          <p v-if="drawing">正在添加“{{ objectTypeLabels[objectType] }}”，在地图上继续点击，完成后保存对象。</p>
          <p v-else-if="!objects.length">请选择对象类型并点击“开始绘制”，在基础地图上添加教学元素。</p>
          <p v-else>已添加的教学元素会显示在地图上。删除或调整后请先保存草稿，再发布版本。</p>
          <ul class="overlay-guide-checklist">
            <li :class="{ done: Boolean(name.trim()) }"><span>{{ name.trim() ? '✓' : '1' }}</span>填写覆盖层名称</li>
            <li :class="{ done: objects.length > 0 }"><span>{{ objects.length ? '✓' : '2' }}</span>添加至少一个教学对象</li>
            <li :class="{ done: selected?.status === 'PUBLISHED' }"><span>{{ selected?.status === 'PUBLISHED' ? '✓' : '3' }}</span>保存并发布版本</li>
          </ul>
        </section>
        <section class="overlay-guide-note">
          <strong>编辑规则</strong>
          <p>系统已加载的道路、建筑物和地形属于地图基础资源，只读不可修改。配送点、障碍物、航路和事件区域等教学元素由教师在此覆盖层中配置。</p>
        </section>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.scenario-overlay-editor { display: grid; min-height: 100%; grid-template-rows: auto minmax(0, 1fr); background: #f6f9f7; color: #294137; }
.overlay-editor-layout { display: grid; min-height: 0; grid-template-columns: minmax(286px, 320px) minmax(0, 1fr) minmax(260px, 300px); overflow: hidden; }
.overlay-editor-sidebar { display: grid; min-width: 0; min-height: 0; align-content: start; gap: 10px; overflow: auto; border-right: 1px solid #d6e1db; padding: 12px; background: #fbfdfc; }
.overlay-editor-sidebar > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; }
.overlay-editor-sidebar > header strong { color: #365747; font-size: 10px; }
.overlay-editor-map { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: #e7eee9; }
.overlay-editor-map-canvas { position: absolute; inset: 0; display: block; width: 100%; height: 100%; min-height: 0; }
.overlay-editor-map-canvas :deep(.v3-region-map-shell), .overlay-editor-map-canvas :deep(.v3-region-map) { width: 100%; height: 100%; min-height: 0; }
.overlay-map-toolbar { position: absolute; z-index: 8; top: 12px; right: 12px; left: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; pointer-events: none; }
.overlay-view-switch, .overlay-history-actions { display: flex; gap: 4px; pointer-events: auto; }
.overlay-view-switch button, .overlay-history-actions button { display: grid; min-height: 29px; place-items: center; border: 1px solid rgba(38, 91, 68, .24); padding: 4px 9px; color: #456658; background: rgba(255, 255, 255, .94); box-shadow: 0 3px 12px rgba(25, 58, 47, .12); cursor: pointer; }
.overlay-view-switch button.active { color: #1e684c; border-color: #287252; background: #eaf5ef; }
.overlay-map-mode-note { max-width: 280px; overflow: hidden; border: 1px solid rgba(38, 91, 68, .18); padding: 7px 9px; color: #547064; background: rgba(255, 255, 255, .92); box-shadow: 0 3px 12px rgba(25, 58, 47, .1); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.overlay-map-note { position: absolute; z-index: 7; right: 12px; bottom: 12px; max-width: calc(100% - 24px); border: 1px solid rgba(38, 91, 68, .18); padding: 7px 9px; color: #547064; background: rgba(255, 255, 255, .92); box-shadow: 0 3px 12px rgba(25, 58, 47, .1); font-size: 11px; }
.overlay-editor-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #d6e1db; padding: 14px 18px; background: #fff; }.overlay-editor-header > div:first-child { display: grid; gap: 3px; }.overlay-editor-header span { color: #287252; font-size: 11px; font-weight: 800; }.overlay-editor-header h2 { margin: 0; font-size: 17px; }.overlay-editor-header p { margin: 0; color: #6d8076; font-size: 11px; }.overlay-editor-actions { display: flex; gap: 6px; }
.overlay-readonly-hint { margin: 0; border-left: 3px solid #bd872c; padding: 7px 8px; color: #85631f; background: #fff8e8; font-size: 11px; line-height: 1.5; }
.overlay-history-actions { display: flex; gap: 4px; }
.overlay-history-actions button { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid #cbdad2; color: #287252; background: #fff; cursor: pointer; }
.overlay-history-actions button:disabled { color: #a6b4ad; background: #f2f6f3; cursor: not-allowed; }
.overlay-editor-guide { display: flex; min-height: 0; flex-direction: column; gap: 10px; overflow: auto; border-left: 1px solid #d6e1db; padding: 12px; background: #f8fbf9; }.overlay-guide-card,.overlay-guide-note { border: 1px solid #dce6e1; padding: 12px; background: #fff; }.overlay-guide-kicker { color: #287252; font-size: 11px; font-weight: 800; letter-spacing: .04em; }.overlay-guide-card h3 { margin: 5px 0 10px; color: #294137; font-size: 14px; line-height: 1.35; }.overlay-guide-card dl { display: grid; gap: 7px; margin: 0; }.overlay-guide-card dl div { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; border-bottom: 1px solid #edf2ef; padding-bottom: 6px; }.overlay-guide-card dl div:last-child { border-bottom: 0; padding-bottom: 0; }.overlay-guide-card dt { color: #789087; font-size: 11px; }.overlay-guide-card dd { margin: 0; color: #3e5c4e; font-size: 11px; font-weight: 700; text-align: right; }.overlay-guide-card header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.overlay-guide-card header strong,.overlay-guide-note strong { color: #365747; font-size: 10px; }.overlay-guide-card header em { color: #287252; font-size: 11px; font-style: normal; font-weight: 700; }.overlay-guide-card p,.overlay-guide-note p { margin: 8px 0 0; color: #6c8175; font-size: 11px; line-height: 1.6; }.overlay-guide-checklist { display: grid; gap: 7px; margin: 12px 0 0; padding: 0; list-style: none; }.overlay-guide-checklist li { display: flex; align-items: flex-start; gap: 6px; color: #71857a; font-size: 11px; line-height: 1.4; }.overlay-guide-checklist li span { display: inline-grid; flex: 0 0 16px; width: 16px; height: 16px; place-items: center; border: 1px solid #cbdad2; border-radius: 50%; color: #80958a; font-size: 11px; }.overlay-guide-checklist li.done { color: #287252; }.overlay-guide-checklist li.done span { border-color: #287252; color: #287252; background: #eaf5ef; }.overlay-guide-note { border-left: 3px solid #6f9d83; background: #eef7f1; }.overlay-guide-note p { margin-top: 6px; }
.overlay-version-list { display: grid; gap: 5px; }.overlay-version-list button { display: grid; width: 100%; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 7px; border: 1px solid #dce6e1; border-radius: 4px; padding: 7px 8px; color: #365747; text-align: left; background: #fff; cursor: pointer; }.overlay-version-list button:hover,.overlay-version-list button.active { border-color: #7caf96; background: #edf6f1; }.overlay-version-list button > span { display: grid; min-width: 0; gap: 2px; }.overlay-version-list button strong { overflow: hidden; font-size: 11px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }.overlay-version-list button small { color: #74867d; font-size: 11px; }.overlay-version-list button em { color: #527463; font-size: 11px; font-style: normal; white-space: nowrap; }
.overlay-editor-steps { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
.overlay-editor-steps li { min-width: 0; color: #8a9a92; }
.overlay-editor-steps li.done { color: #4e7560; }
.overlay-step-button { display: grid; grid-template-columns: 22px minmax(0, 1fr); align-items: center; gap: 7px; width: 100%; min-height: 30px; border: 1px solid transparent; border-radius: 3px; padding: 3px 4px; color: inherit; text-align: left; background: transparent; cursor: pointer; }
.overlay-step-button:hover { border-color: #c9d8d0; background: #f5faf7; }
.overlay-step-button:focus-visible { outline: 2px solid #287252; outline-offset: 2px; }
.overlay-step-button > span { display: grid; width: 20px; height: 20px; place-items: center; border: 1px solid #c9d8d0; border-radius: 50%; font-size: 11px; }
.overlay-step-button > div { display: grid; gap: 2px; min-width: 0; }
.overlay-editor-steps strong { font-size: 11px; }
.overlay-editor-steps small { font-size: 11px; }
.overlay-step-button.active { color: #287252; background: #f1f8f4; }
.overlay-step-button.active > span { border-color: #287252; background: #eaf5ef; }
@media (max-width: 1120px) { .overlay-editor-layout { grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: minmax(390px, 1fr) auto; }.overlay-editor-guide { grid-column: 1 / -1; border-top: 1px solid #d6e1db; border-left: 0; flex-direction: row; }.overlay-editor-guide > * { flex: 1; } }
@media (max-width: 760px) { .overlay-editor-header { align-items: flex-start; flex-direction: column; }.overlay-editor-layout { grid-template-columns: 1fr; grid-template-rows: minmax(390px, 54vh) auto auto; }.overlay-editor-sidebar { order: 2; border-top: 1px solid #d6e1db; border-right: 0; }.overlay-editor-map { order: 1; }.overlay-editor-guide { order: 3; flex-direction: column; border-top: 1px solid #d6e1db; }.overlay-map-mode-note { display: none; } }
.overlay-layer-list { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #dce6e1; }.overlay-layer-list header { grid-column: 1 / -1; display: flex; justify-content: space-between; padding: 7px 8px; border-bottom: 1px solid #e3ebe7; }.overlay-layer-list header strong { font-size: 11px; }.overlay-layer-list header small { color: #7c8d84; font-size: 11px; }.overlay-layer-list button { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 5px; min-height: 30px; border: 0; border-right: 1px solid #e3ebe7; padding: 5px 7px; text-align: left; background: #fff; cursor: pointer; }.overlay-layer-list button.active { color: #287252; background: #edf6f1; }.overlay-layer-list i { width: 7px; height: 7px; border: 1px solid #91a49b; }.overlay-layer-list button.active i { background: #287252; }.overlay-layer-list span { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.overlay-layer-list button small { color: #7c8d84; font-size: 11px; }
.overlay-object-list > div.selected { background: #edf6f1; box-shadow: inset 3px 0 #287252; }
.overlay-filter-field { display: grid; gap: 4px; color: #60776b; font-size: 11px; }
.overlay-object-focus { display: grid; grid-template-columns: minmax(0, 1fr) 16px; align-items: center; flex: 1; gap: 6px; min-width: 0; border: 0; padding: 0; color: #365747; text-align: left; background: transparent; cursor: pointer; }
.overlay-object-focus > span { display: grid; min-width: 0; gap: 2px; }
.overlay-object-focus .el-icon { color: #287252; font-size: 13px; }
.overlay-object-focus:focus-visible { outline: 2px solid #287252; outline-offset: 2px; }
.overlay-editor-map-2d { position: absolute; inset: 0; z-index: 2; width: 100%; min-height: 100%; height: 100%; background: #e7eee9; }
.overlay-editor-map-2d :deep(.v3-region-map) { width: 100%; height: 100%; min-height: 100%; }

@media (max-width: 760px) {
  .scenario-overlay-editor { min-height: 0; }
  .overlay-editor-header { padding: 10px 12px; }
  .overlay-editor-actions { width: 100%; flex-wrap: wrap; }
  .overlay-editor-actions .el-button { flex: 1 1 120px; min-width: 0; }
  .overlay-editor-layout { min-height: 0; overflow: visible; }
  .overlay-editor-map { min-height: 390px; }
  .overlay-editor-sidebar { max-height: none; overflow: visible; padding: 10px; }
  .overlay-editor-guide > * { flex: 0 0 auto; }
}
@media (max-width: 420px) {
  .overlay-editor-layout { grid-template-rows: 360px auto auto; }
  .overlay-editor-map { min-height: 360px; }
  .overlay-map-toolbar { top: 8px; right: 8px; left: 8px; align-items: flex-start; flex-direction: column; }
  .overlay-map-mode-note { display: none; }
  .overlay-layer-list { grid-template-columns: 1fr; }
  .overlay-layer-list header { grid-column: auto; }
  .overlay-layer-list button { border-right: 0; }
  .overlay-editor-sidebar footer { display: grid; grid-template-columns: 1fr; }
}
</style>
