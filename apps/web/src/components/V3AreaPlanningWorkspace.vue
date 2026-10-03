<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { formatCoordinateReference, formatHeightDatum } from "../terminology"
import {
  AddLocation,
  Back,
  CircleCheck,
  Close,
  Crop,
  Delete,
  DocumentAdd,
  Download,
  EditPen,
  Rank,
  RefreshRight,
  Right,
  ScaleToOriginal,
  Select,
  UploadFilled,
  Warning
} from "@element-plus/icons-vue"
import {
  showAreaFeatureTypes,
  type AuthUser,
  type ShowAreaAnnotationInput,
  type ShowAreaCheckResult,
  type ShowAreaDistanceMeasurement,
  type ShowAreaFeatureInput,
  type ShowAreaFeatureMeasurement,
  type ShowAreaFeatureType,
  type ShowAreaFeatureView,
  type ShowAreaPlanMutationResult,
  type ShowAreaPlanVersionView,
  type ShowAreaPlanWorkspaceView,
  type ShowAreaMeasuredPoint,
  type StudentProjectStageView,
  type StudentProjectView,
  type V3Coordinate,
  type V3RegionCatalogItem,
  type V3RegionLayerCode
} from "@wurenji/shared"
import { api, apiBaseUrl, downloadApiFile } from "../api"
import { areaFeatureCoordinateRows, areaSpatialRelationRows, preferredAreaReviewVersion } from "../area-review"
import type { V3MapDataState } from "../map-loading-state"
import { formatPlatformDateTime } from "../platform-date"
import type { RegionTerrainState } from "../terrain"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"

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
  projectUpdated: [project: StudentProjectView]
  toggleLayer: [code: V3RegionLayerCode]
  dataState: [state: V3MapDataState]
}>()

const mapTerrainState = ref<RegionTerrainState>("LOADING")
const loading = ref(false)
const loadError = ref("")
const saving = ref(false)
const saveState = ref<"SAVED" | "PENDING" | "ERROR">("SAVED")
const workspace = ref<ShowAreaPlanWorkspaceView | null>(null)
const features = ref<ShowAreaFeatureView[]>([])
const annotations = ref<ShowAreaAnnotationInput[]>([])
const selectedFeatureId = ref("")
const selectedAnnotationId = ref("")
const selectedType = ref<ShowAreaFeatureType>("TAKEOFF_LANDING")
const drawMode = ref<"POLYGON" | "RECTANGLE" | null>(null)
const toolMode = ref<"ANNOTATION" | "MEASURE" | null>(null)
const editMode = ref<"VERTEX" | "MOVE">("VERTEX")
const distanceMeasurement = ref<ShowAreaDistanceMeasurement | null>(null)
const checkResult = ref<ShowAreaCheckResult | null>(null)
const viewingVersionId = ref("")
const reviewComment = ref("")
const reviewScore = ref<number | null>(null)
let saveTimer: number | null = null
let workspaceRequest = 0
let workspaceAbortController: AbortController | undefined
let disposed = false

function handleMapDataState(state: V3MapDataState) {
  mapTerrainState.value = state.terrain
  emit("dataState", state)
}
let savePromise: Promise<void> | null = null
let dirty = false
const undoStack = ref<AreaEditorSnapshot[]>([])
const redoStack = ref<AreaEditorSnapshot[]>([])

const isStudent = computed(() => props.user.role === "student")
const canEdit = computed(() => Boolean(workspace.value?.canEdit && isStudent.value && props.project.assessmentTiming.canWrite && !viewingVersionId.value))
const selectedFeature = computed(() => features.value.find((item) => item.id === selectedFeatureId.value) ?? null)
const selectedAnnotation = computed(() => annotations.value.find((item) => item.id === selectedAnnotationId.value) ?? null)
const completeTypeCount = computed(() => new Set(features.value.map((item) => item.type)).size)
const latestSubmittedVersion = computed(() => workspace.value?.versions.find((item) => item.status === "SUBMITTED") ?? null)
const viewedVersion = computed(() => workspace.value?.versions.find((item) => item.id === viewingVersionId.value) ?? null)
const reviewedTotalArea = computed(() => features.value.reduce((total, feature) => total + feature.measurement.areaSquareMeters, 0))
const activeToolLabel = computed(() => {
  if (drawMode.value === "RECTANGLE") return "矩形绘制"
  if (drawMode.value === "POLYGON") return "多边形绘制"
  if (toolMode.value === "ANNOTATION") return "文字标注"
  if (toolMode.value === "MEASURE") return "距离测量"
  return ""
})
const spatialRelationRows = computed(() => areaSpatialRelationRows(checkResult.value, features.value))
const planningMapPreviewUrl = computed(() => {
  const path = viewedVersion.value?.planningMapAsset?.downloadPath
  return path ? apiBaseUrl(path.replace(/\/download$/, "/preview")) : ""
})

const featureDefinitions: Record<ShowAreaFeatureType, { title: string; color: string; short: string }> = {
  TAKEOFF_LANDING: { title: "起降区", color: "#1d6f52", short: "起降" },
  FLIGHT: { title: "飞行区", color: "#3182bd", short: "飞行" },
  PERFORMANCE: { title: "表演区", color: "#7258a6", short: "表演" },
  BUFFER: { title: "缓冲区", color: "#d49b31", short: "缓冲" },
  GROUND_ISOLATION: { title: "地面隔离区", color: "#9b6554", short: "隔离" },
  AUDIENCE: { title: "观众区", color: "#d45f6e", short: "观众" },
  OPERATION: { title: "操作区", color: "#52766f", short: "操作" },
  EMERGENCY_LANDING: { title: "应急降落区", color: "#cf7041", short: "应急" },
  GEOFENCE: { title: "电子围栏", color: "#ae3c4b", short: "围栏" }
}

interface AreaEditorSnapshot {
  features: ShowAreaFeatureView[]
  annotations: ShowAreaAnnotationInput[]
}

onMounted(loadWorkspace)
onBeforeUnmount(() => {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  disposed = true
  workspaceRequest += 1
  workspaceAbortController?.abort()
  if (dirty) void flushSave()
})
watch(() => props.project.id, loadWorkspace)

async function loadWorkspace() {
  if (disposed) return
  const requestId = ++workspaceRequest
  workspaceAbortController?.abort()
  const abortController = new AbortController()
  workspaceAbortController = abortController
  loading.value = true
  loadError.value = ""
  try {
    const value = await api<ShowAreaPlanWorkspaceView>(`/v3/show-projects/${props.project.id}/area-plan`, { signal: abortController.signal })
    if (requestId !== workspaceRequest) return
    applyWorkspace(value)
  } catch (error) {
    if (requestId !== workspaceRequest || (error instanceof DOMException && error.name === "AbortError")) return
    loadError.value = error instanceof Error ? error.message : "区域规划工作台加载失败"
    ElMessage.error(loadError.value)
  } finally {
    if (requestId === workspaceRequest) loading.value = false
  }
}

function applyWorkspace(value: ShowAreaPlanWorkspaceView) {
  workspace.value = value
  const preferredVersion = preferredAreaReviewVersion(value.versions)
  if (value.canEdit) {
    viewingVersionId.value = ""
    features.value = value.draft.features.map(cloneFeature)
    annotations.value = (value.draft.annotations ?? []).map(cloneAnnotation)
  } else if (preferredVersion) {
    viewingVersionId.value = preferredVersion.id
    features.value = preferredVersion.features.map(cloneFeature)
    annotations.value = (preferredVersion.annotations ?? []).map(cloneAnnotation)
    checkResult.value = preferredVersion.checkResult
  } else {
    features.value = value.draft.features.map(cloneFeature)
    annotations.value = (value.draft.annotations ?? []).map(cloneAnnotation)
  }
  selectedFeatureId.value = features.value[0]?.id ?? ""
  selectedAnnotationId.value = ""
  selectedType.value = features.value[0]?.type ?? firstMissingType() ?? "TAKEOFF_LANDING"
  saveState.value = "SAVED"
  dirty = false
  undoStack.value = []
  redoStack.value = []
}

function selectType(type: ShowAreaFeatureType) {
  selectedType.value = type
  const feature = features.value.find((item) => item.type === type)
  selectedFeatureId.value = feature?.id ?? ""
  selectedAnnotationId.value = ""
}

function selectFeature(featureId: string) {
  selectedFeatureId.value = featureId
  selectedAnnotationId.value = ""
  const feature = features.value.find((item) => item.id === featureId)
  if (feature) selectedType.value = feature.type
}

function selectAnnotation(annotationId: string) {
  selectedAnnotationId.value = annotationId
  selectedFeatureId.value = ""
}

function beginDraw(mode: "POLYGON" | "RECTANGLE") {
  if (!canEdit.value) return
  toolMode.value = null
  drawMode.value = drawMode.value === mode ? null : mode
}

function cancelMapInteraction() {
  if (!drawMode.value && !toolMode.value) return
  drawMode.value = null
  toolMode.value = null
  distanceMeasurement.value = null
}

function addFeature(positions: V3Coordinate[]) {
  pushHistory()
  const type = selectedType.value
  const sameTypeCount = features.value.filter((item) => item.type === type).length
  const input: ShowAreaFeatureInput = {
    id: crypto.randomUUID(),
    type,
    label: `${featureDefinitions[type].title}${sameTypeCount > 0 ? ` ${sameTypeCount + 1}` : ""}`,
    positions,
    ...defaultHeightRange(type),
    properties: defaultProperties(type)
  }
  const feature = toFeatureView(input)
  features.value = [...features.value, feature]
  selectedFeatureId.value = feature.id
  drawMode.value = null
  markDirty()
}

function updateFeaturePositions(featureId: string, positions: V3Coordinate[]) {
  features.value = features.value.map((item) => item.id === featureId
    ? toFeatureView({ ...stripMeasurement(item), positions })
    : item)
  markDirty()
}

function removeSelected() {
  if (!canEdit.value || !selectedFeature.value) return
  pushHistory()
  features.value = features.value.filter((item) => item.id !== selectedFeatureId.value)
  selectedFeatureId.value = features.value[0]?.id ?? ""
  selectedType.value = features.value[0]?.type ?? firstMissingType() ?? "TAKEOFF_LANDING"
  markDirty()
}

function beginMapEdit() {
  if (canEdit.value) pushHistory()
}

function setToolMode(mode: "ANNOTATION" | "MEASURE") {
  drawMode.value = null
  toolMode.value = toolMode.value === mode ? null : mode
  if (mode === "MEASURE") distanceMeasurement.value = null
}

function addAnnotation(position: ShowAreaMeasuredPoint) {
  if (!canEdit.value) return
  pushHistory()
  const annotation: ShowAreaAnnotationInput = {
    id: crypto.randomUUID(),
    label: `关键点 ${annotations.value.length + 1}`,
    position: { longitude: position.longitude, latitude: position.latitude },
    heightMeters: position.heightMeters
  }
  annotations.value = [...annotations.value, annotation]
  selectedAnnotationId.value = annotation.id
  selectedFeatureId.value = ""
  toolMode.value = null
  markDirty()
}

function updateAnnotationLabel(value: string) {
  if (!selectedAnnotation.value || value === selectedAnnotation.value.label) return
  pushHistory()
  selectedAnnotation.value.label = value
  markDirty()
}

function removeSelectedAnnotation() {
  if (!canEdit.value || !selectedAnnotation.value) return
  pushHistory()
  annotations.value = annotations.value.filter((item) => item.id !== selectedAnnotationId.value)
  selectedAnnotationId.value = annotations.value[0]?.id ?? ""
  markDirty()
}

function applyMeasurement(value: ShowAreaDistanceMeasurement) {
  distanceMeasurement.value = value
  toolMode.value = null
}

function pushHistory() {
  undoStack.value = [...undoStack.value.slice(-49), editorSnapshot()]
  redoStack.value = []
}

function undo() {
  if (!canEdit.value || undoStack.value.length === 0) return
  const previous = undoStack.value[undoStack.value.length - 1]!
  redoStack.value = [...redoStack.value.slice(-49), editorSnapshot()]
  undoStack.value = undoStack.value.slice(0, -1)
  restoreSnapshot(previous)
}

function redo() {
  if (!canEdit.value || redoStack.value.length === 0) return
  const next = redoStack.value[redoStack.value.length - 1]!
  undoStack.value = [...undoStack.value.slice(-49), editorSnapshot()]
  redoStack.value = redoStack.value.slice(0, -1)
  restoreSnapshot(next)
}

function editorSnapshot(): AreaEditorSnapshot {
  return {
    features: features.value.map(cloneFeature),
    annotations: annotations.value.map(cloneAnnotation)
  }
}

function restoreSnapshot(snapshot: AreaEditorSnapshot) {
  features.value = snapshot.features.map(cloneFeature)
  annotations.value = snapshot.annotations.map(cloneAnnotation)
  if (!features.value.some((item) => item.id === selectedFeatureId.value)) selectedFeatureId.value = features.value[0]?.id ?? ""
  if (!annotations.value.some((item) => item.id === selectedAnnotationId.value)) selectedAnnotationId.value = ""
  markDirty()
}

function markDirty() {
  if (!canEdit.value) return
  dirty = true
  saveState.value = "PENDING"
  checkResult.value = null
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void flushSave(), 900)
}

async function flushSave(showMessage = false): Promise<void> {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = null
  if (savePromise) {
    await savePromise
    if (dirty) await flushSave(showMessage)
    return
  }
  if (!dirty || !workspace.value || !canEdit.value) {
    if (showMessage) ElMessage.success("区域草稿已保存")
    return
  }
  const revision = workspace.value.draft.revision
  const payload = features.value.map(stripMeasurement)
  const annotationPayload = annotations.value.map(cloneAnnotation)
  dirty = false
  saving.value = true
  savePromise = api<ShowAreaPlanWorkspaceView>(`/v3/show-projects/${props.project.id}/area-plan/draft`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: revision, features: payload, annotations: annotationPayload })
  }).then((value) => {
    workspace.value = value
    saveState.value = dirty ? "PENDING" : "SAVED"
    if (showMessage) ElMessage.success("区域草稿已保存")
  }).catch(async (error) => {
    dirty = true
    saveState.value = "ERROR"
    ElMessage.error(error instanceof Error ? error.message : "区域草稿保存失败")
    if (!disposed) await loadWorkspace()
  }).finally(() => {
    saving.value = false
    savePromise = null
  })
  await savePromise
}

async function runCheck() {
  await flushSave()
  loading.value = true
  try {
    checkResult.value = await api<ShowAreaCheckResult>(`/v3/show-projects/${props.project.id}/area-plan/check`, { method: "POST" })
    if (checkResult.value.passed) ElMessage.success("区域规划检查通过提交门禁")
    else ElMessage.warning("区域规划仍有阻断问题")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "区域规划检查失败")
  } finally {
    loading.value = false
  }
}

async function createSnapshot() {
  await flushSave()
  if (!workspace.value || workspace.value.draft.revision === 0) return
  loading.value = true
  try {
    applyWorkspace(await api<ShowAreaPlanWorkspaceView>(`/v3/show-projects/${props.project.id}/area-plan/snapshot`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftRevision: workspace.value.draft.revision })
    }))
    ElMessage.success("已创建不可变版本快照")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "版本快照创建失败")
  } finally {
    loading.value = false
  }
}

async function submitPlan() {
  await flushSave()
  if (!workspace.value || workspace.value.draft.revision === 0) return
  try {
    await ElMessageBox.confirm(
      "提交后系统将生成不可变区域规划图并进入教师审核，当前草稿在退回前不可继续编辑。",
      "确认提交区域规划",
      { confirmButtonText: "确认提交", cancelButtonText: "继续修改", type: "warning" }
    )
  } catch {
    return
  }
  loading.value = true
  try {
    const result = await api<ShowAreaPlanMutationResult>(`/v3/show-projects/${props.project.id}/area-plan/submit`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftRevision: workspace.value.draft.revision, expectedStageRevision: props.stage.revision })
    })
    applyWorkspace(result.workspace)
    emit("projectUpdated", result.project)
    ElMessage.success("区域规划已提交，正式规划图已生成")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "区域规划提交失败")
  } finally {
    loading.value = false
  }
}

function viewDraft() {
  if (!workspace.value) return
  viewingVersionId.value = ""
  features.value = workspace.value.draft.features.map(cloneFeature)
  annotations.value = (workspace.value.draft.annotations ?? []).map(cloneAnnotation)
  checkResult.value = null
  selectedFeatureId.value = features.value[0]?.id ?? ""
  selectedAnnotationId.value = ""
  selectedType.value = features.value[0]?.type ?? firstMissingType() ?? "TAKEOFF_LANDING"
}

function viewVersion(version: ShowAreaPlanVersionView) {
  viewingVersionId.value = version.id
  features.value = version.features.map(cloneFeature)
  annotations.value = (version.annotations ?? []).map(cloneAnnotation)
  checkResult.value = version.checkResult
  selectedFeatureId.value = features.value[0]?.id ?? ""
  selectedAnnotationId.value = ""
  selectedType.value = features.value[0]?.type ?? "TAKEOFF_LANDING"
  reviewComment.value = version.review?.comment ?? ""
  reviewScore.value = version.review?.score ?? null
}

async function review(target: "accept" | "return") {
  const version = latestSubmittedVersion.value
  if (!version) return
  loading.value = true
  try {
    const result = await api<ShowAreaPlanMutationResult>(`/v3/show-projects/${props.project.id}/area-plan/versions/${version.id}/${target}`, {
      method: "POST",
      body: JSON.stringify({ comment: reviewComment.value, score: reviewScore.value })
    })
    applyWorkspace(result.workspace)
    emit("projectUpdated", result.project)
    ElMessage.success(target === "accept" ? "区域规划已通过" : "区域规划已退回学生修改")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "区域规划审核失败")
  } finally {
    loading.value = false
  }
}

async function downloadMap(version: ShowAreaPlanVersionView) {
  if (!version.planningMapAsset) return
  try {
    await downloadApiFile(version.planningMapAsset.downloadPath, version.planningMapAsset.originalName)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "规划图下载失败")
  }
}

function updateLabel(value: string) {
  if (!selectedFeature.value || value === selectedFeature.value.label) return
  pushHistory()
  selectedFeature.value.label = value
  markDirty()
}

function updateNumberProperty(key: string, value: number | undefined) {
  if (!selectedFeature.value || value === undefined || selectedFeature.value.properties[key] === value) return
  pushHistory()
  selectedFeature.value.properties[key] = value
  markDirty()
}

function updateTextProperty(key: string, value: string) {
  if (!selectedFeature.value || selectedFeature.value.properties[key] === value) return
  pushHistory()
  selectedFeature.value.properties[key] = value
  markDirty()
}

function updateHeight(key: "minimumMeters" | "maximumMeters", value: number | undefined) {
  if (!selectedFeature.value?.heightRange || value === undefined || selectedFeature.value.heightRange[key] === value) return
  pushHistory()
  selectedFeature.value.heightRange[key] = value
  markDirty()
}

function numberProperty(key: string): number {
  const value = selectedFeature.value?.properties[key]
  return typeof value === "number" ? value : 0
}

function textProperty(key: string): string {
  const value = selectedFeature.value?.properties[key]
  return typeof value === "string" ? value : ""
}

function typeCount(type: ShowAreaFeatureType) {
  return features.value.filter((item) => item.type === type).length
}

function firstMissingType(): ShowAreaFeatureType | null {
  return showAreaFeatureTypes.find((type) => !features.value.some((item) => item.type === type)) ?? null
}

function statusLabel(status: ShowAreaPlanVersionView["status"]) {
  return ({ SNAPSHOT: "手动快照", GENERATING: "生成中", GENERATION_FAILED: "生成失败", SUBMITTED: "待审核", RETURNED: "已退回", ACCEPTED: "已通过" } as const)[status]
}

function defaultHeightRange(type: ShowAreaFeatureType): Pick<ShowAreaFeatureInput, "heightRange"> | Record<string, never> {
  return type === "FLIGHT" || type === "PERFORMANCE" || type === "GEOFENCE"
    ? { heightRange: { datum: "AGL", minimumMeters: type === "GEOFENCE" ? 0 : 20, maximumMeters: 120 } }
    : {}
}

function defaultProperties(type: ShowAreaFeatureType): Record<string, string | number | boolean> {
  if (type === "TAKEOFF_LANDING") return { capacity: 100, orientationDegrees: 0, groundElevationMeters: 0 }
  if (type === "PERFORMANCE") return { orientationDegrees: 0 }
  if (type === "BUFFER") return { referenceWidthMeters: 30, relatedArea: "PERFORMANCE" }
  if (type === "GROUND_ISOLATION") return { purpose: "人员与设备隔离" }
  if (type === "AUDIENCE") return { orientationDegrees: 0, capacityLevel: "中型" }
  if (type === "OPERATION") return { purpose: "地面站与指挥席" }
  if (type === "EMERGENCY_LANDING") return { availability: "全程可用", capacityLevel: "单组" }
  if (type === "GEOFENCE") return { policy: "越界告警并阻止继续外飞" }
  return {}
}

function cloneFeature(feature: ShowAreaFeatureView): ShowAreaFeatureView {
  return {
    ...feature,
    positions: feature.positions.map((point) => ({ ...point })),
    ...(feature.heightRange ? { heightRange: { ...feature.heightRange } } : {}),
    properties: { ...feature.properties },
    measurement: { ...feature.measurement, centroid: { ...feature.measurement.centroid } }
  }
}

function cloneAnnotation(annotation: ShowAreaAnnotationInput): ShowAreaAnnotationInput {
  return { ...annotation, position: { ...annotation.position } }
}

function stripMeasurement(feature: ShowAreaFeatureView): ShowAreaFeatureInput {
  return {
    id: feature.id,
    type: feature.type,
    label: feature.label,
    positions: feature.positions.map((point) => ({ ...point })),
    ...(feature.heightRange ? { heightRange: { ...feature.heightRange } } : {}),
    properties: { ...feature.properties }
  }
}

function toFeatureView(feature: ShowAreaFeatureInput): ShowAreaFeatureView {
  return { ...feature, measurement: measure(feature.positions) }
}

function measure(points: readonly V3Coordinate[]): ShowAreaFeatureMeasurement {
  const meanLatitude = points.reduce((sum, point) => sum + point.latitude, 0) / points.length
  const radius = 6_371_008.8
  const projected = points.map((point) => ({
    x: point.longitude * Math.PI / 180 * Math.cos(meanLatitude * Math.PI / 180) * radius,
    y: point.latitude * Math.PI / 180 * radius
  }))
  let twiceArea = 0
  let perimeterMeters = 0
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index]!
    const next = projected[(index + 1) % projected.length]!
    twiceArea += current.x * next.y - next.x * current.y
    perimeterMeters += Math.hypot(next.x - current.x, next.y - current.y)
  }
  const centroid = points.reduce((result, point) => ({ longitude: result.longitude + point.longitude / points.length, latitude: result.latitude + point.latitude / points.length }), { longitude: 0, latitude: 0 })
  return { areaSquareMeters: Math.round(Math.abs(twiceArea / 2) * 10) / 10, perimeterMeters: Math.round(perimeterMeters * 10) / 10, centroid }
}

function formatArea(value: number) {
  return value >= 10_000 ? `${(value / 10_000).toFixed(2)} ha` : `${value.toFixed(0)} m²`
}

function formatDistance(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${value.toFixed(1)} m`
}
</script>

<template>
  <section class="area-planning-workspace" v-loading="loading || saving">
    <section v-if="loadError && !workspace" class="area-planning-load-error" role="alert">
      <el-icon><Warning /></el-icon>
      <strong>区域规划暂时无法加载</strong>
      <span>{{ loadError }}</span>
      <button type="button" :disabled="loading" @click="loadWorkspace"><el-icon><RefreshRight /></el-icon>重新加载</button>
    </section>

    <main v-if="workspace || !loadError" class="area-planning-canvas">
      <V3UnifiedMap renderer="area-planning"
        :region="region"
        :visible-layers="visibleLayers"
        :features="features"
        :annotations="annotations"
        :selected-feature-id="selectedFeatureId"
        :selected-annotation-id="selectedAnnotationId"
        :draw-mode="drawMode"
        :tool-mode="toolMode"
        :measurement="distanceMeasurement"
        :draw-type="selectedType"
        :edit-mode="editMode"
        :editable="canEdit"
        :mode="mapMode"
        @select="selectFeature"
        @created="addFeature"
        @updated="updateFeaturePositions"
        @edit-start="beginMapEdit"
        @annotation-created="addAnnotation"
        @annotation-select="selectAnnotation"
        @measured="applyMeasurement"
        @draw-complete="drawMode = null"
        @interaction-cancel="cancelMapInteraction"
        @data-state="handleMapDataState"
      />

      <V3EnvironmentLayerPanel
        :region="region"
        scene-type="CITY_SHOW"
        :visible-layers="visibleLayers"
        :details="environmentDetails"
        :terrain-state="mapTerrainState"
        :planned-show-area-types="features.map(item => item.type)"
        @toggle-layer="emit('toggleLayer', $event)"
      />

      <div class="area-map-toolbar">
        <el-tooltip content="撤销" placement="bottom"><button type="button" aria-label="撤销" :disabled="!canEdit || undoStack.length === 0" @click="undo"><el-icon><Back /></el-icon></button></el-tooltip>
        <el-tooltip content="重做" placement="bottom"><button type="button" aria-label="重做" :disabled="!canEdit || redoStack.length === 0" @click="redo"><el-icon><Right /></el-icon></button></el-tooltip>
        <span />
        <el-tooltip content="矩形建面" placement="bottom"><button type="button" aria-label="矩形建面" :class="{ active: drawMode === 'RECTANGLE' }" :aria-pressed="drawMode === 'RECTANGLE'" :disabled="!canEdit" @click="beginDraw('RECTANGLE')"><el-icon><Crop /></el-icon></button></el-tooltip>
        <el-tooltip content="多边形建面，右键完成" placement="bottom"><button type="button" aria-label="多边形建面" :class="{ active: drawMode === 'POLYGON' }" :aria-pressed="drawMode === 'POLYGON'" :disabled="!canEdit" @click="beginDraw('POLYGON')"><el-icon><EditPen /></el-icon></button></el-tooltip>
        <span />
        <el-tooltip content="编辑顶点" placement="bottom"><button type="button" aria-label="编辑顶点" :class="{ active: editMode === 'VERTEX' && !drawMode && !toolMode }" :aria-pressed="editMode === 'VERTEX' && !drawMode && !toolMode" :disabled="!canEdit" @click="drawMode = null; toolMode = null; editMode = 'VERTEX'"><el-icon><Select /></el-icon></button></el-tooltip>
        <el-tooltip content="整体移动" placement="bottom"><button type="button" aria-label="整体移动" :class="{ active: editMode === 'MOVE' && !drawMode && !toolMode }" :aria-pressed="editMode === 'MOVE' && !drawMode && !toolMode" :disabled="!canEdit" @click="drawMode = null; toolMode = null; editMode = 'MOVE'"><el-icon><Rank /></el-icon></button></el-tooltip>
        <span />
        <el-tooltip content="距离与方位测量" placement="bottom"><button type="button" aria-label="距离与方位测量" :class="{ active: toolMode === 'MEASURE' }" :aria-pressed="toolMode === 'MEASURE'" @click="setToolMode('MEASURE')"><el-icon><ScaleToOriginal /></el-icon></button></el-tooltip>
        <el-tooltip content="添加文字标注" placement="bottom"><button type="button" aria-label="添加文字标注" :class="{ active: toolMode === 'ANNOTATION' }" :aria-pressed="toolMode === 'ANNOTATION'" :disabled="!canEdit" @click="setToolMode('ANNOTATION')"><el-icon><AddLocation /></el-icon></button></el-tooltip>
        <el-tooltip content="删除选中区域" placement="bottom"><button type="button" aria-label="删除选中区域" :disabled="!canEdit || !selectedFeature" @click="removeSelected"><el-icon><Delete /></el-icon></button></el-tooltip>
      </div>

      <div v-if="activeToolLabel" class="area-tool-status">
        <span>{{ activeToolLabel }}</span>
        <el-tooltip content="取消当前操作" placement="bottom">
          <button type="button" aria-label="取消当前操作" @click="cancelMapInteraction"><el-icon><Close /></el-icon></button>
        </el-tooltip>
      </div>

      <div class="area-map-caption">
        <span :style="{ background: featureDefinitions[selectedType].color }" />
        <strong>{{ featureDefinitions[selectedType].title }}</strong>
        <small>{{ region.title }} · {{ formatCoordinateReference('WGS84') }} / {{ formatHeightDatum(region.heightDatum) }}</small>
      </div>
    </main>

    <aside v-if="workspace || !loadError" class="area-planning-inspector">
      <header class="area-progress-header">
        <div><span>SHOW AREA PLAN</span><strong>功能区规划</strong></div>
        <em :class="saveState.toLowerCase()">{{ saveState === 'SAVED' ? '已保存' : saveState === 'PENDING' ? '待保存' : '保存异常' }}</em>
        <p><b>{{ completeTypeCount }}</b> / 9</p>
      </header>
      <p v-if="loadError" class="area-load-error" role="alert">规划数据同步失败：{{ loadError }}，当前内容未清除，请稍后重新加载。</p>

      <section class="area-type-list">
        <button v-for="type in showAreaFeatureTypes" :key="type" type="button" :class="{ active: selectedType === type, complete: typeCount(type) > 0 }" :aria-pressed="selectedType === type" @click="selectType(type)">
          <i :style="{ background: featureDefinitions[type].color }" />
          <span><strong>{{ featureDefinitions[type].title }}</strong><small>{{ typeCount(type) > 0 ? `${typeCount(type)} 个区域` : '尚未规划' }}</small></span>
          <el-icon v-if="typeCount(type) > 0"><CircleCheck /></el-icon><b v-else>{{ featureDefinitions[type].short }}</b>
        </button>
      </section>

      <section v-if="!isStudent && viewedVersion" class="area-review-evidence">
        <header>
          <div><span>TEA-021</span><strong>区域成果审阅</strong></div>
          <em>V{{ viewedVersion.versionNo }} · {{ statusLabel(viewedVersion.status) }}</em>
        </header>
        <div class="area-review-metrics">
          <div><span>区域</span><strong>{{ features.length }}</strong></div>
          <div><span>总面积</span><strong>{{ formatArea(reviewedTotalArea) }}</strong></div>
          <div><span>位置关系</span><strong>{{ spatialRelationRows.length }}</strong></div>
          <div><span>检查</span><strong>{{ checkResult?.passed ? '通过' : '有提示' }}</strong></div>
        </div>
        <div v-if="planningMapPreviewUrl" class="area-planning-map-preview">
          <img :src="planningMapPreviewUrl" :alt="`区域规划图 V${viewedVersion.versionNo}`" />
          <button type="button" @click="downloadMap(viewedVersion)"><el-icon><Download /></el-icon><span>下载原图</span></button>
        </div>
        <div class="area-review-feature-list">
          <details v-for="feature in features" :key="feature.id">
            <summary @click="selectFeature(feature.id)">
              <i :style="{ background: featureDefinitions[feature.type].color }" />
              <span><strong>{{ featureDefinitions[feature.type].title }} · {{ feature.label }}</strong><small>{{ formatArea(feature.measurement.areaSquareMeters) }} · 周长 {{ feature.measurement.perimeterMeters.toFixed(1) }} m · {{ feature.positions.length }} 点</small></span>
            </summary>
            <dl>
              <div><dt>中心</dt><dd>{{ feature.measurement.centroid.longitude.toFixed(7) }}, {{ feature.measurement.centroid.latitude.toFixed(7) }}</dd></div>
              <div v-if="feature.heightRange"><dt>高度</dt><dd>{{ feature.heightRange.minimumMeters }}-{{ feature.heightRange.maximumMeters }} m {{ feature.heightRange.datum }}</dd></div>
            </dl>
            <ol><li v-for="coordinate in areaFeatureCoordinateRows(feature)" :key="coordinate">{{ coordinate }}</li></ol>
          </details>
        </div>
        <section class="area-spatial-relations">
          <header><strong>位置关系提示</strong><small>系统提供测量与重叠提示，合理性由教师判断</small></header>
          <ul v-if="spatialRelationRows.length"><li v-for="relation in spatialRelationRows" :key="relation.key" :class="relation.severity.toLowerCase()">{{ relation.label }}</li></ul>
          <p v-else>历史版本未保存结构化位置关系，可结合地图与权威检查提示审核。</p>
        </section>
      </section>

      <section v-if="selectedFeature" class="area-property-editor">
        <header><strong>区域属性</strong><small>{{ formatArea(selectedFeature.measurement.areaSquareMeters) }} · {{ selectedFeature.positions.length }} 点</small></header>
        <label><span>名称</span><el-input :model-value="selectedFeature.label" :disabled="!canEdit" @update:model-value="updateLabel" /></label>
        <div v-if="selectedFeature.heightRange" class="property-pair">
          <label><span>下限 (m)</span><el-input-number :model-value="selectedFeature.heightRange.minimumMeters" :disabled="!canEdit" :controls="false" @update:model-value="updateHeight('minimumMeters', $event)" /></label>
          <label><span>上限 (m)</span><el-input-number :model-value="selectedFeature.heightRange.maximumMeters" :disabled="!canEdit" :controls="false" @update:model-value="updateHeight('maximumMeters', $event)" /></label>
        </div>
        <div v-if="selectedFeature.type === 'TAKEOFF_LANDING'" class="property-pair">
          <label><span>容量</span><el-input-number :model-value="numberProperty('capacity')" :disabled="!canEdit" :controls="false" @update:model-value="updateNumberProperty('capacity', $event)" /></label>
          <label><span>朝向 (°)</span><el-input-number :model-value="numberProperty('orientationDegrees')" :disabled="!canEdit" :controls="false" @update:model-value="updateNumberProperty('orientationDegrees', $event)" /></label>
        </div>
        <label v-else-if="selectedFeature.type === 'PERFORMANCE' || selectedFeature.type === 'AUDIENCE'"><span>朝向 (°)</span><el-input-number :model-value="numberProperty('orientationDegrees')" :disabled="!canEdit" :controls="false" @update:model-value="updateNumberProperty('orientationDegrees', $event)" /></label>
        <label v-if="selectedFeature.type === 'BUFFER'"><span>参考宽度 (m)</span><el-input-number :model-value="numberProperty('referenceWidthMeters')" :disabled="!canEdit" :controls="false" @update:model-value="updateNumberProperty('referenceWidthMeters', $event)" /></label>
        <label v-if="selectedFeature.type === 'GROUND_ISOLATION' || selectedFeature.type === 'OPERATION'"><span>用途</span><el-input :model-value="textProperty('purpose')" :disabled="!canEdit" @update:model-value="updateTextProperty('purpose', $event)" /></label>
        <label v-if="selectedFeature.type === 'AUDIENCE' || selectedFeature.type === 'EMERGENCY_LANDING'"><span>容量等级</span><el-input :model-value="textProperty('capacityLevel')" :disabled="!canEdit" @update:model-value="updateTextProperty('capacityLevel', $event)" /></label>
        <label v-if="selectedFeature.type === 'EMERGENCY_LANDING'"><span>可用条件</span><el-input :model-value="textProperty('availability')" :disabled="!canEdit" @update:model-value="updateTextProperty('availability', $event)" /></label>
        <label v-if="selectedFeature.type === 'GEOFENCE'"><span>围栏策略</span><el-input :model-value="textProperty('policy')" :disabled="!canEdit" @update:model-value="updateTextProperty('policy', $event)" /></label>
        <dl><div><dt>周长</dt><dd>{{ selectedFeature.measurement.perimeterMeters.toFixed(1) }} m</dd></div><div><dt>中心</dt><dd>{{ selectedFeature.measurement.centroid.longitude.toFixed(6) }}, {{ selectedFeature.measurement.centroid.latitude.toFixed(6) }}</dd></div></dl>
      </section>

      <section v-if="selectedAnnotation" class="area-annotation-editor">
        <header><strong>文字标注</strong><small>关键点坐标</small></header>
        <label><span>标注内容</span><el-input :model-value="selectedAnnotation.label" :disabled="!canEdit" maxlength="120" @update:model-value="updateAnnotationLabel" /></label>
        <dl>
          <div><dt>经度</dt><dd>{{ selectedAnnotation.position.longitude.toFixed(7) }}</dd></div>
          <div><dt>纬度</dt><dd>{{ selectedAnnotation.position.latitude.toFixed(7) }}</dd></div>
          <div><dt>地形高程</dt><dd>{{ selectedAnnotation.heightMeters === null ? '未获取' : `${selectedAnnotation.heightMeters.toFixed(1)} m` }}</dd></div>
        </dl>
        <el-button v-if="canEdit" :icon="Delete" @click="removeSelectedAnnotation">删除标注</el-button>
      </section>

      <section v-if="distanceMeasurement" class="area-measurement-panel">
        <header><strong>距离与方位</strong><button type="button" aria-label="清除测量" @click="distanceMeasurement = null"><el-icon><Delete /></el-icon></button></header>
        <div><strong>{{ formatDistance(distanceMeasurement.distanceMeters) }}</strong><span>{{ distanceMeasurement.bearingDegrees.toFixed(1) }}°</span></div>
        <dl>
          <div><dt>起点</dt><dd>{{ distanceMeasurement.start.longitude.toFixed(6) }}, {{ distanceMeasurement.start.latitude.toFixed(6) }} · {{ distanceMeasurement.start.heightMeters === null ? '-' : `${distanceMeasurement.start.heightMeters.toFixed(1)} m` }}</dd></div>
          <div><dt>终点</dt><dd>{{ distanceMeasurement.end.longitude.toFixed(6) }}, {{ distanceMeasurement.end.latitude.toFixed(6) }} · {{ distanceMeasurement.end.heightMeters === null ? '-' : `${distanceMeasurement.end.heightMeters.toFixed(1)} m` }}</dd></div>
        </dl>
      </section>

      <section v-if="checkResult" class="area-check-results">
        <header><strong>权威检查</strong><em :class="{ passed: checkResult.passed }">{{ checkResult.passed ? '门禁通过' : '存在阻断' }}</em></header>
        <div v-if="checkResult.evidence.length === 0" class="empty-evidence"><el-icon><CircleCheck /></el-icon><span>未发现几何或完整性问题</span></div>
        <button v-for="item in checkResult.evidence" :key="`${item.code}:${item.featureIds.join('-')}`" type="button" :class="item.severity.toLowerCase()" @click="item.featureIds[0] && (selectedFeatureId = item.featureIds[0])">
          <el-icon><Warning /></el-icon><span><strong>{{ item.severity }}</strong><small>{{ item.message }}</small></span>
        </button>
      </section>

      <section class="area-version-list">
        <header><strong>版本记录</strong><button v-if="workspace?.canEdit" type="button" :class="{ active: !viewingVersionId }" :aria-pressed="!viewingVersionId" @click="viewDraft"><el-icon><RefreshRight /></el-icon>当前草稿</button></header>
        <button v-for="version in workspace?.versions ?? []" :key="version.id" type="button" :class="{ active: viewingVersionId === version.id }" :aria-pressed="viewingVersionId === version.id" @click="viewVersion(version)">
          <span>V{{ version.versionNo }}</span><div><strong>{{ statusLabel(version.status) }}</strong><small>草稿 r{{ version.sourceDraftRevision }} · {{ formatPlatformDateTime(version.createdAt) }}</small></div>
          <el-icon v-if="version.planningMapAsset" title="下载规划图" @click.stop="downloadMap(version)"><Download /></el-icon>
        </button>
      </section>

      <section v-if="!isStudent && latestSubmittedVersion" class="area-review-panel">
        <header><strong>教师审核</strong><small>V{{ latestSubmittedVersion.versionNo }}</small></header>
        <el-input v-model="reviewComment" type="textarea" :rows="3" maxlength="2000" placeholder="审核批注与修改要求" />
        <label><span>分数</span><el-input-number v-model="reviewScore" :min="0" :max="100" :step="1" placeholder="可选" /></label>
        <div><el-button @click="review('return')">退回修改</el-button><el-button type="primary" @click="review('accept')">通过规划</el-button></div>
      </section>

      <footer v-if="canEdit" class="area-submit-actions">
        <el-tooltip content="手动保存草稿"><el-button aria-label="手动保存草稿" :icon="RefreshRight" circle @click="flushSave(true)" /></el-tooltip>
        <el-tooltip content="创建不可变快照"><el-button aria-label="创建不可变快照" :icon="DocumentAdd" circle @click="createSnapshot" /></el-tooltip>
        <el-button :icon="CircleCheck" @click="runCheck">检查</el-button>
        <el-button type="primary" :icon="UploadFilled" @click="submitPlan">提交规划</el-button>
      </footer>
      <footer v-else-if="viewedVersion?.planningMapAsset" class="area-submit-actions read-only">
        <el-button type="primary" :icon="Download" @click="downloadMap(viewedVersion)">下载正式规划图</el-button>
      </footer>
    </aside>
  </section>
</template>

<style scoped>
.area-planning-workspace {
  display: grid;
  grid-column: 2 / 4;
  grid-template-columns: minmax(0, 1fr) 340px;
  min-width: 0;
  min-height: 0;
  background: #dce3de;
}

.area-planning-canvas {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.area-map-toolbar {
  position: absolute;
  z-index: 3;
  top: 12px;
  left: 12px;
  display: flex;
  gap: 4px;
  border: 1px solid rgba(29, 69, 55, 0.18);
  border-radius: 4px;
  padding: 4px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: 0 3px 12px rgba(25, 58, 47, 0.12);
}

.area-tool-status { position: absolute; z-index: 4; top: 58px; left: 12px; display: flex; align-items: center; gap: 8px; border: 1px solid rgba(29,69,55,.16); border-radius: 4px; padding: 6px 7px 6px 9px; color: #245b47; background: rgba(240,248,244,.96); box-shadow: 0 3px 12px rgba(25,58,47,.12); font-size: 11px; }
.area-tool-status button { display: grid; width: 23px; height: 23px; place-items: center; border: 0; border-radius: 3px; color: white; background: #267052; cursor: pointer; }

.area-map-toolbar button {
  display: grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border: 0;
  border-radius: 3px;
  color: #536b62;
  background: transparent;
  cursor: pointer;
}

.area-map-toolbar button:hover,
.area-map-toolbar button.active {
  color: white;
  background: #216c50;
}

.area-map-toolbar button:disabled { opacity: .35; cursor: not-allowed; }
.area-map-toolbar > span { width: 1px; margin: 4px 2px; background: #d5dfda; }

.area-map-caption {
  position: absolute;
  z-index: 2;
  left: 12px;
  bottom: 12px;
  display: grid;
  grid-template-columns: 9px auto;
  align-items: center;
  gap: 3px 7px;
  border-radius: 4px;
  padding: 8px 10px;
  color: white;
  background: rgba(21, 55, 44, .88);
}

.area-map-caption > span { grid-row: 1 / 3; width: 8px; height: 28px; border-radius: 2px; }
.area-map-caption strong { font-size: 10px; }
.area-map-caption small { color: rgba(255, 255, 255, .68); font-size: 11px; }

.area-planning-inspector {
  min-height: 0;
  overflow: auto;
  border-left: 1px solid #ccd7d2;
  background: #f8faf9;
}

.area-progress-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  min-height: 64px;
  border-bottom: 1px solid #d9e1dd;
  padding: 10px 14px;
  background: white;
}

.area-progress-header > div { display: grid; gap: 2px; }
.area-progress-header span { color: #267052; font-size: 11px; font-weight: 700; }
.area-progress-header strong { font-size: 13px; }
.area-progress-header em { border-radius: 3px; padding: 4px 6px; color: #527066; background: #e7efeb; font-size: 11px; font-style: normal; }
.area-progress-header em.pending { color: #84631e; background: #f5efdc; }
.area-progress-header em.error { color: #9a433c; background: #f7e8e6; }
.area-progress-header p { margin: 0; color: #74867f; font-size: 10px; }
.area-progress-header p b { color: #1d6f52; font-size: 18px; }

.area-type-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-bottom: 1px solid #d8e0dc; background: white; }
.area-type-list > button { display: grid; grid-template-columns: 5px minmax(0, 1fr) 17px; align-items: center; gap: 6px; min-height: 54px; border: 0; border-right: 1px solid #e1e7e4; border-bottom: 1px solid #e1e7e4; padding: 7px 8px; text-align: left; background: white; cursor: pointer; }
.area-type-list > button:nth-child(3n) { border-right: 0; }
.area-type-list > button.active { box-shadow: inset 0 -3px #247253; background: #f1f7f4; }
.area-type-list > button > i { width: 4px; height: 29px; border-radius: 1px; opacity: .52; }
.area-type-list > button.complete > i { opacity: 1; }
.area-type-list > button > span { display: grid; gap: 3px; min-width: 0; }
.area-type-list strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.area-type-list small { color: #82918b; font-size: 11px; }
.area-type-list .el-icon { color: #1f7453; font-size: 14px; }
.area-type-list b { color: #9aa8a2; font-size: 11px; font-weight: 500; }

.area-property-editor,
.area-review-evidence,
.area-annotation-editor,
.area-measurement-panel,
.area-check-results,
.area-version-list,
.area-review-panel { border-bottom: 1px solid #d8e0dc; padding: 13px 14px; }
.area-review-evidence > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.area-review-evidence > header > div { display: grid; gap: 2px; }
.area-review-evidence > header span { color: #267052; font-size: 11px; font-weight: 700; }
.area-review-evidence > header strong { font-size: 11px; }
.area-review-evidence > header em { color: #526d63; font-size: 11px; font-style: normal; }
.area-review-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid #dbe4df; }
.area-review-metrics > div { display: grid; gap: 3px; border-right: 1px solid #dbe4df; border-bottom: 1px solid #dbe4df; padding: 8px; background: white; }
.area-review-metrics > div:nth-child(2n) { border-right: 0; }
.area-review-metrics > div:nth-last-child(-n + 2) { border-bottom: 0; }
.area-review-metrics span { color: #7b8c85; font-size: 11px; }
.area-review-metrics strong { overflow-wrap: anywhere; color: #214f3f; font-size: 10px; }
.area-planning-map-preview { position: relative; margin-top: 10px; border: 1px solid #d4dfd9; background: #e9efec; }
.area-planning-map-preview img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; }
.area-planning-map-preview button { position: absolute; right: 7px; bottom: 7px; display: flex; align-items: center; gap: 4px; border: 1px solid rgba(255,255,255,.4); border-radius: 3px; padding: 6px 8px; color: white; background: rgba(23,62,50,.9); font-size: 11px; cursor: pointer; }
.area-review-feature-list { display: grid; margin-top: 10px; border-top: 1px solid #dce4e0; }
.area-review-feature-list details { border-bottom: 1px solid #dce4e0; background: white; }
.area-review-feature-list summary { display: grid; grid-template-columns: 4px minmax(0, 1fr); gap: 8px; padding: 9px 7px; cursor: pointer; list-style: none; }
.area-review-feature-list summary::-webkit-details-marker { display: none; }
.area-review-feature-list summary > i { width: 4px; height: 30px; border-radius: 1px; }
.area-review-feature-list summary > span { display: grid; gap: 3px; min-width: 0; }
.area-review-feature-list summary strong { overflow-wrap: anywhere; font-size: 11px; }
.area-review-feature-list summary small { color: #70837b; font-size: 11px; line-height: 1.45; }
.area-review-feature-list details > dl { display: grid; gap: 4px; margin: 0 10px; border-top: 1px dashed #dce4e0; padding: 7px 0; }
.area-review-feature-list details > dl > div { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 5px; font-size: 11px; }
.area-review-feature-list dt { color: #778981; }
.area-review-feature-list dd { margin: 0; overflow-wrap: anywhere; }
.area-review-feature-list ol { display: grid; gap: 3px; margin: 0; padding: 0 10px 9px 28px; color: #50675f; font: 7px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
.area-spatial-relations { margin-top: 12px; }
.area-spatial-relations > header { display: grid; gap: 3px; }
.area-spatial-relations > header strong { font-size: 11px; }
.area-spatial-relations > header small { color: #7a8983; font-size: 11px; line-height: 1.45; }
.area-spatial-relations ul { display: grid; gap: 1px; margin: 8px 0 0; padding: 0; list-style: none; }
.area-spatial-relations li { border-left: 2px solid #92aaa0; padding: 6px 7px; overflow-wrap: anywhere; color: #526b61; background: #edf2ef; font-size: 11px; line-height: 1.5; }
.area-spatial-relations li.attention,
.area-spatial-relations li.risk { border-color: #c79331; color: #72581f; background: #f7f1df; }
.area-spatial-relations p { margin: 8px 0 0; color: #74867f; font-size: 11px; line-height: 1.5; }
.area-property-editor > header,
.area-annotation-editor > header,
.area-measurement-panel > header,
.area-check-results > header,
.area-version-list > header,
.area-review-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.area-property-editor > header strong,
.area-annotation-editor > header strong,
.area-measurement-panel > header strong,
.area-check-results > header strong,
.area-version-list > header strong,
.area-review-panel > header strong { font-size: 10px; }
.area-property-editor > header small,
.area-annotation-editor > header small,
.area-review-panel > header small { color: #74867f; font-size: 11px; }
.area-property-editor > label,
.area-annotation-editor > label,
.property-pair label,
.area-review-panel > label { display: grid; gap: 4px; margin-top: 8px; }
.area-property-editor label > span,
.area-annotation-editor label > span,
.area-review-panel label > span { color: #6f817a; font-size: 11px; }
.property-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.area-property-editor :deep(.el-input-number),
.area-property-editor :deep(.el-input),
.area-review-panel :deep(.el-input-number) { width: 100%; }
.area-property-editor dl { display: grid; gap: 5px; margin: 11px 0 0; border-top: 1px solid #e0e6e3; padding-top: 9px; }
.area-property-editor dl > div,
.area-annotation-editor dl > div,
.area-measurement-panel dl > div { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 8px; font-size: 11px; }
.area-property-editor dt,
.area-annotation-editor dt,
.area-measurement-panel dt { color: #7b8c85; }
.area-property-editor dd,
.area-annotation-editor dd,
.area-measurement-panel dd { overflow: hidden; margin: 0; text-overflow: ellipsis; white-space: nowrap; }
.area-annotation-editor dl,
.area-measurement-panel dl { display: grid; gap: 6px; margin: 10px 0 0; }
.area-annotation-editor > .el-button { width: 100%; margin-top: 10px; }
.area-measurement-panel > header button { display: grid; width: 24px; height: 24px; place-items: center; border: 0; color: #687c74; background: transparent; cursor: pointer; }
.area-measurement-panel > div { display: flex; align-items: baseline; justify-content: space-between; border-left: 3px solid #216c50; padding: 5px 8px; background: #edf5f1; }
.area-measurement-panel > div strong { color: #1d6f52; font-size: 18px; }
.area-measurement-panel > div span { color: #536b62; font-size: 12px; font-weight: 700; }

.area-check-results > header em { border-radius: 3px; padding: 3px 6px; color: #9a433c; background: #f7e8e6; font-size: 11px; font-style: normal; }
.area-check-results > header em.passed { color: #1e6a4c; background: #e3f1e9; }
.area-check-results > button { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 7px; width: 100%; border: 0; border-top: 1px solid #e1e7e4; padding: 8px 0; color: #785f22; text-align: left; background: transparent; cursor: pointer; }
.area-check-results > button.conflict { color: #9a433c; }
.area-check-results > button.info { color: #4f7065; }
.area-check-results > button span { display: grid; gap: 2px; }
.area-check-results > button strong { font-size: 11px; }
.area-check-results > button small { color: #596d65; font-size: 11px; line-height: 1.45; }
.empty-evidence { display: flex; align-items: center; gap: 7px; color: #1f6f50; font-size: 11px; }

.area-version-list > header button { display: flex; align-items: center; gap: 4px; border: 0; color: #647970; background: transparent; font-size: 11px; cursor: pointer; }
.area-version-list > header button.active { color: #1f6f50; }
.area-version-list > button { display: grid; grid-template-columns: 28px minmax(0, 1fr) 20px; align-items: center; gap: 8px; width: 100%; border: 0; border-top: 1px solid #e1e7e4; padding: 8px 3px; text-align: left; background: transparent; cursor: pointer; }
.area-version-list > button.active { background: #edf5f1; }
.area-version-list > button > span { color: #1f6f50; font-size: 11px; font-weight: 700; }
.area-version-list > button > div { display: grid; gap: 2px; min-width: 0; }
.area-version-list strong { font-size: 11px; }
.area-version-list small { color: #81918b; font-size: 11px; }
.area-version-list .el-icon { color: #2c7458; }

.area-review-panel > div:last-child { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.area-submit-actions { position: sticky; bottom: 0; display: flex; justify-content: flex-end; gap: 6px; border-top: 1px solid #d0dad5; padding: 10px 12px; background: rgba(255, 255, 255, .96); }
.area-submit-actions.read-only .el-button { width: 100%; }

@media (max-width: 1080px) {
  .area-planning-workspace { grid-template-columns: minmax(0, 1fr) 300px; }
  .area-type-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .area-type-list > button:nth-child(3n) { border-right: 1px solid #e1e7e4; }
  .area-type-list > button:nth-child(2n) { border-right: 0; }
}

@media (max-width: 760px) {
  .area-planning-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: 520px auto; }
  .area-planning-inspector { overflow: visible; border-top: 1px solid #ccd7d2; border-left: 0; }
  .area-type-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .area-type-list > button:nth-child(2n) { border-right: 1px solid #e1e7e4; }
  .area-type-list > button:nth-child(3n) { border-right: 0; }
}
.area-planning-load-error { grid-column: 1 / -1; display: grid; place-items: center; align-content: center; gap: 9px; min-height: 300px; padding: 32px; color: #71847c; text-align: center; background: #eef3f0; }
.area-planning-load-error .el-icon { color: #a14b3f; font-size: 28px; }
.area-planning-load-error strong { color: #8b3f35; font-size: 13px; }
.area-planning-load-error span { max-width: 48ch; font-size: 11px; line-height: 1.6; }
.area-planning-load-error button { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #247253; border-radius: 3px; padding: 7px 10px; color: white; background: #247253; font-size: 11px; cursor: pointer; }
.area-planning-load-error button:disabled { cursor: not-allowed; opacity: .48; }
.area-load-error { margin: 0; padding: 7px 10px; border-left: 3px solid #a14b3f; color: #8b3f35; background: #fff1ef; font-size: 11px; line-height: 1.5; }
</style>
