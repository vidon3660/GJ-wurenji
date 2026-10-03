<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import {
  AddLocation,
  Back,
  Check,
  CircleCheck,
  Close,
  Connection,
  CopyDocument,
  Delete,
  DocumentAdd,
  EditPen,
  Finished,
  FolderOpened,
  Position,
  RefreshRight,
  Right,
  ScaleToOriginal,
  Select,
  SetUp,
  UploadFilled,
  Warning
} from "@element-plus/icons-vue"
import {
  inspectLogisticsRouteSpatialRelations,
  type LogisticsMapAnnotationInput,
  type AuthUser,
  type LogisticsRouteCheckEvidence,
  type LogisticsRouteDirection,
  type LogisticsRouteInput,
  type LogisticsRouteSpatialRelation,
  type LogisticsRouteVersionView,
  type LogisticsRouteWorkspaceView,
  type LogisticsWaypointInput,
  type ShowAreaDistanceMeasurement,
  type ShowAreaMeasuredPoint,
  type StudentProjectStageView,
  type StudentProjectView,
  type V3Coordinate,
  type V3LogisticsNode,
  type V3LogisticsNodeType,
  type V3RegionCatalogItem,
  type V3RegionLayerCode
} from "@wurenji/shared"
import { api } from "../api"
import { formatAircraftModelCode as formatAircraftModelCodeValue, formatCoordinateReference, formatHeightDatum, formatLogisticsEvidenceCode, formatSubmissionStatus } from "../terminology"
import type { V3MapDataState } from "../map-loading-state"
import type { RegionTerrainState } from "../terrain"
import { createPrimaryRouteSkeleton, hasPrimaryRoute } from "../logistics-route-creation"
import { applyBatchRouteHeight, parseBatchRouteHeight } from "../logistics-multi-route-management"
import { summarizeRequiredLogisticsRouteChecks } from "../logistics-route-check-summary"
import { logisticsProblemLocation } from "../logistics-problem-location"
import { compareLogisticsRouteVersions, summarizeLogisticsRouteVersion } from "../logistics-route-version-comparison"
import {
  advanceV3OperationProgress,
  completeV3OperationProgress,
  failV3OperationProgress,
  startV3OperationProgress,
  type V3OperationProgressState
} from "../operation-progress"
import {
  deleteIntermediateWaypoint,
  hasFollowingSegment,
  insertIntermediateWaypoint,
  moveIntermediateWaypoint
} from "../logistics-waypoint-editing"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3OperationProgress from "./V3OperationProgress.vue"

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
const saveState = ref<"SAVED" | "PENDING" | "ERROR">("SAVED")
const workspace = ref<LogisticsRouteWorkspaceView | null>(null)
const routes = ref<LogisticsRouteInput[]>([])
const annotations = ref<LogisticsMapAnnotationInput[]>([])
const selectedRouteId = ref("")
const selectedWaypointId = ref("")
const selectedAnnotationId = ref("")
const addWaypointMode = ref(false)
const networkDialogOpen = ref(false)
const networkDepartureNodeId = ref("")
const networkArrivalNodeId = ref("")
const deliveryPointDialogOpen = ref(false)
const versionDialogOpen = ref(false)
const toolMode = ref<"ANNOTATION" | "MEASURE" | null>(null)
const distanceMeasurement = ref<ShowAreaDistanceMeasurement | null>(null)
const visibleNodeTypes = ref<V3LogisticsNodeType[]>(["CENTER_AIRPORT", "DELIVERY_POINT", "WAITING_POINT", "ALTERNATE_LANDING_POINT"])
const showLabels = ref(true)
const panelTab = ref<"ROUTES" | "CHECK" | "VERSIONS">("ROUTES")
const relationOnly = ref(false)
const selectedEvidence = ref<LogisticsRouteCheckEvidence | null>(null)
const validationProgress = ref<V3OperationProgressState | null>(null)
interface LogisticsRouteEditorSnapshot {
  routes: LogisticsRouteInput[]
  annotations: LogisticsMapAnnotationInput[]
}

const undoStack = ref<LogisticsRouteEditorSnapshot[]>([])
const redoStack = ref<LogisticsRouteEditorSnapshot[]>([])
const routeFormRevision = ref(0)
const comparisonBaselineId = ref("")
const comparisonTargetId = ref("")
let saveTimer: number | null = null
let savePromise: Promise<boolean> | null = null
let dirty = false
let editRevision = 0
let workspaceRequest = 0
let workspaceAbortController: AbortController | undefined
let disposed = false

function handleMapDataState(state: V3MapDataState) {
  mapTerrainState.value = state.terrain
  emit("dataState", state)
}

const canEdit = computed(() => Boolean(workspace.value?.canEditRoutes && props.user.role === "student" && props.project.assessmentTiming.canWrite))
const selectedRoute = computed(() => routes.value.find((route) => route.id === selectedRouteId.value) ?? null)
const selectedWaypoint = computed(() => selectedRoute.value?.waypoints.find((waypoint) => waypoint.id === selectedWaypointId.value) ?? null)
const activeToolLabel = computed(() => {
  if (addWaypointMode.value) return "添加航点"
  if (toolMode.value === "ANNOTATION") return "文字标注"
  if (toolMode.value === "MEASURE") return "距离测量"
  return ""
})
const selectedAnnotation = computed(() => annotations.value.find((annotation) => annotation.id === selectedAnnotationId.value) ?? null)
const selectedSpatialRelations = computed(() => selectedRoute.value
  ? inspectLogisticsRouteSpatialRelations(selectedRoute.value, props.region)
  : [])
const selectedSpatialRelationCounts = computed(() => ({
  conflict: selectedSpatialRelations.value.filter((item) => item.status === "CONFLICT").length,
  risk: selectedSpatialRelations.value.filter((item) => item.status === "RISK").length,
  clear: selectedSpatialRelations.value.filter((item) => item.status === "CLEAR").length
}))
const selectedWaypointHasFollowingSegment = computed(() => Boolean(
  selectedRoute.value
  && selectedWaypoint.value
  && hasFollowingSegment(selectedRoute.value, selectedWaypoint.value.id)
))
const selectedDeliveryNodes = computed(() => {
  const selectedIds = new Set(workspace.value?.regionAnalysis.selectedDeliveryPointIds ?? [])
  return (props.region.logisticsNodes ?? []).filter((node) => node.type === "DELIVERY_POINT" && selectedIds.has(node.id))
})
const waitingNodes = computed(() => nodesOfType("WAITING_POINT"))
const alternateNodes = computed(() => nodesOfType("ALTERNATE_LANDING_POINT"))
const emergencyNodes = computed(() => nodesOfType("EMERGENCY_AREA"))
const networkEndpointNodes = computed(() => (props.region.logisticsNodes ?? []).filter((node) => node.enabled && node.position && node.type !== "EMERGENCY_AREA"))
const checkResult = computed(() => workspace.value?.draft.lastCheckResult ?? null)
const validationEvidence = computed(() => props.stage.stageCode === "LOGISTICS_ROUTE_VALIDATION" && workspace.value?.validationRuns[0]
  ? workspace.value.validationRuns[0].result.evidence
  : checkResult.value?.evidence ?? [])
const displayedEvidence = computed(() => relationOnly.value
  ? validationEvidence.value.filter((item) => item.category === "ROUTE_RELATION")
  : validationEvidence.value)
const displayedEvidenceCounts = computed(() => ({
  conflict: displayedEvidence.value.filter((item) => item.severity === "CONFLICT").length,
  risk: displayedEvidence.value.filter((item) => item.severity === "RISK").length,
  info: displayedEvidence.value.filter((item) => item.severity === "INFO").length
}))
const requiredCheckSummaries = computed(() => summarizeRequiredLogisticsRouteChecks(checkResult.value))
const latestRun = computed(() => workspace.value?.validationRuns[0] ?? null)
const problemLocation = computed(() => selectedEvidence.value
  ? logisticsProblemLocation(selectedEvidence.value, routes.value, latestRun.value?.result.routeMetrics ?? [])
  : null)
const latestSubmittableVersion = computed(() => workspace.value?.versions.find((version) => version.sourceDraftRevision === workspace.value?.draft.revision && (version.validationResult?.status === "PASSED" || version.validationResult?.status === "WITH_RISK")) ?? null)
const comparisonBaseline = computed(() => workspace.value?.versions.find((version) => version.id === comparisonBaselineId.value) ?? null)
const comparisonTarget = computed(() => workspace.value?.versions.find((version) => version.id === comparisonTargetId.value) ?? null)
const versionComparison = computed(() => comparisonBaseline.value && comparisonTarget.value && comparisonBaseline.value.id !== comparisonTarget.value.id
  ? compareLogisticsRouteVersions(comparisonBaseline.value, comparisonTarget.value)
  : null)
const formalPackageSummary = computed(() => {
  const version = latestSubmittableVersion.value
  if (!version?.validationResult) return null
  const formalRoutes = version.routes.filter((route) => route.role === "PRIMARY")
  return {
    versionNo: version.versionNo,
    formalRouteCount: formalRoutes.length,
    destinationCount: new Set(formalRoutes.map((route) => route.destinationNodeId)).size,
    completedRoundTripCount: version.validationResult.completedRoundTripCount,
    requiredRoundTripCount: version.validationResult.requiredRoundTripCount,
    riskCount: version.checkResult.riskCount,
    validationStatus: version.validationResult.status
  }
})
const isPlanningStage = computed(() => props.stage.stageCode === "LOGISTICS_ROUTE_PLANNING")
const visibleMapRoutes = computed(() => selectedRoute.value ? [selectedRoute.value] : [])

watch(() => props.stage.stageCode, (stageCode) => {
  panelTab.value = stageCode === "LOGISTICS_ROUTE_VALIDATION" ? "CHECK" : "ROUTES"
}, { immediate: true })
const canCopyAsReturn = computed(() => {
  const route = selectedRoute.value
  return Boolean(
    canEdit.value
    && route?.direction === "OUTBOUND"
    && (route.role !== "PRIMARY" || !hasPrimaryRoute(routes.value, route.destinationNodeId, "RETURN"))
  )
})

onMounted(loadWorkspace)
onBeforeUnmount(() => {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  disposed = true
  workspaceRequest += 1
  workspaceAbortController?.abort()
  if (dirty) void saveDraft(true)
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
    const value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/route-workspace`, { signal: abortController.signal })
    if (requestId !== workspaceRequest) return
    applyWorkspace(value, true)
  } catch (error) {
    if (requestId !== workspaceRequest || (error instanceof DOMException && error.name === "AbortError")) return
    loadError.value = error instanceof Error ? error.message : "物流航线工作台加载失败"
    ElMessage.error(loadError.value)
  } finally {
    if (requestId === workspaceRequest) loading.value = false
  }
}

function applyWorkspace(value: LogisticsRouteWorkspaceView, replaceRoutes: boolean) {
  workspace.value = value
  synchronizeVersionComparison(value.versions)
  selectedEvidence.value = null
  if (replaceRoutes) {
    routes.value = cloneRoutes(value.draft.routes)
    annotations.value = value.draft.annotations.map(cloneAnnotation)
    routeFormRevision.value += 1
    selectedRouteId.value = routes.value.some((route) => route.id === selectedRouteId.value) ? selectedRouteId.value : routes.value[0]?.id ?? ""
    selectedWaypointId.value = selectedRoute.value?.waypoints.some((waypoint) => waypoint.id === selectedWaypointId.value) ? selectedWaypointId.value : ""
    selectedAnnotationId.value = annotations.value.some((annotation) => annotation.id === selectedAnnotationId.value) ? selectedAnnotationId.value : ""
    undoStack.value = []
    redoStack.value = []
  }
  dirty = false
  saveState.value = "SAVED"
}

function synchronizeVersionComparison(versions: LogisticsRouteVersionView[]) {
  if (!versions.some((version) => version.id === comparisonTargetId.value)) comparisonTargetId.value = versions[0]?.id ?? ""
  if (!versions.some((version) => version.id === comparisonBaselineId.value) || comparisonBaselineId.value === comparisonTargetId.value) {
    comparisonBaselineId.value = versions.find((version) => version.id !== comparisonTargetId.value)?.id ?? ""
  }
}

function applySavedDraft(value: LogisticsRouteWorkspaceView) {
  workspace.value = value
  routes.value = cloneRoutes(value.draft.routes)
  annotations.value = value.draft.annotations.map(cloneAnnotation)
  routeFormRevision.value += 1
  normalizeSelection()
  dirty = false
  saveState.value = "SAVED"
}

function nodesOfType(type: V3LogisticsNode["type"]) {
  return (props.region.logisticsNodes ?? []).filter((node) => node.type === type && node.enabled)
}

function createPrimaryRoute(destination: V3LogisticsNode, direction: LogisticsRouteDirection) {
  if (!canEdit.value || !destination.position) return
  const takeoff = nodesOfType("TAKEOFF_POINT")[0]
  const landing = nodesOfType("LANDING_POINT")[0]
  if (!takeoff?.position || !landing?.position || hasPrimaryRoute(routes.value, destination.id, direction)) return
  pushHistory()
  const id = crypto.randomUUID()
  routes.value.push(createPrimaryRouteSkeleton({
    id,
    direction,
    destination,
    takeoff,
    landing,
    groupCode: `G-${String(selectedDeliveryNodes.value.findIndex((node) => node.id === destination.id) + 1).padStart(2, "0")}`,
    cruiseSpeedMps: workspace.value?.aircraft.cruiseSpeedMps ?? 12
  }))
  selectedRouteId.value = id
  selectedWaypointId.value = ""
  addWaypointMode.value = true
  markDirty()
}

function openNetworkRouteDialog() {
  if (!canEdit.value) return
  networkDepartureNodeId.value = networkEndpointNodes.value[0]?.id ?? ""
  networkArrivalNodeId.value = networkEndpointNodes.value.find((node) => node.id !== networkDepartureNodeId.value)?.id ?? ""
  networkDialogOpen.value = true
}

function createNetworkSegment() {
  const departure = networkEndpointNodes.value.find((node) => node.id === networkDepartureNodeId.value)
  const arrival = networkEndpointNodes.value.find((node) => node.id === networkArrivalNodeId.value)
  if (!departure?.position || !arrival?.position || departure.id === arrival.id) {
    ElMessage.warning("请选择两个不同的有效节点")
    return
  }
  pushHistory()
  const id = crypto.randomUUID()
  routes.value.push({
    id,
    name: `${departure.name} → ${arrival.name}`,
    mode: "NETWORK_SEGMENT",
    destinationNodeId: arrival.id,
    direction: "OUTBOUND",
    role: "PRIMARY",
    groupCode: "NETWORK",
    departureNodeId: departure.id,
    arrivalNodeId: arrival.id,
    protectionRadiusMeters: 30,
    waitingNodeIds: [],
    alternateLandingNodeIds: [],
    emergencyAreaNodeIds: [],
    entryDirectionDegrees: 0,
    exitDirectionDegrees: 0,
    waypoints: [
      endpointWaypoint(`${id}-start`, departure.name, departure),
      endpointWaypoint(`${id}-end`, arrival.name, arrival)
    ]
  })
  selectedRouteId.value = id
  selectedWaypointId.value = ""
  networkDialogOpen.value = false
  addWaypointMode.value = true
  markDirty()
}

function copyAsReturn() {
  const source = selectedRoute.value
  const landing = nodesOfType("LANDING_POINT")[0]
  const destination = (props.region.logisticsNodes ?? []).find((node) => node.id === source?.destinationNodeId)
  if (!canCopyAsReturn.value || !source || !landing?.position || !destination?.position) return
  pushHistory()
  const id = crypto.randomUUID()
  const intermediate = source.waypoints.slice(1, -1).reverse().map((waypoint, index) => ({ ...cloneWaypoint(waypoint), id: `${id}-copy-${index + 1}`, name: `返程航点 ${index + 1}`, nodeId: null, locked: false }))
  const route: LogisticsRouteInput = {
    ...cloneRoute(source),
    id,
    name: `${destination.name} · 返程`,
    direction: "RETURN",
    departureNodeId: destination.id,
    arrivalNodeId: landing.id,
    entryDirectionDegrees: source.exitDirectionDegrees,
    exitDirectionDegrees: source.entryDirectionDegrees,
    waypoints: [endpointWaypoint(`${id}-start`, destination.name, destination), ...intermediate, endpointWaypoint(`${id}-end`, "机场降落点", landing)]
  }
  routes.value.push(route)
  selectedRouteId.value = id
  selectedWaypointId.value = ""
  markDirty()
}

function selectOrCreateOutboundRoute(nodeId: string) {
  const destination = selectedDeliveryNodes.value.find((node) => node.id === nodeId)
  if (!destination) return
  const existing = routes.value.find((route) => route.destinationNodeId === nodeId && route.direction === "OUTBOUND" && route.role === "PRIMARY")
  if (existing) {
    selectedRouteId.value = existing.id
    selectedWaypointId.value = ""
    return
  }
  createPrimaryRoute(destination, "OUTBOUND")
}

function selectMapRoute(routeId: string) {
  selectedRouteId.value = routeId
  selectedWaypointId.value = ""
  selectedAnnotationId.value = ""
}

function selectMapWaypoint(routeId: string, waypointId: string) {
  selectedRouteId.value = routeId
  selectedWaypointId.value = waypointId
  selectedAnnotationId.value = ""
}

function duplicateAsAlternate() {
  const source = selectedRoute.value
  if (!canEdit.value || !source) return
  pushHistory()
  const id = crypto.randomUUID()
  const route = cloneRoute(source)
  route.id = id
  route.name = `${source.name} · 备用`
  route.role = "ALTERNATE"
  route.waypoints = route.waypoints.map((waypoint, index) => ({ ...waypoint, id: `${id}-waypoint-${index + 1}` }))
  routes.value.push(route)
  selectedRouteId.value = id
  selectedWaypointId.value = ""
  markDirty()
}

function endpointWaypoint(id: string, name: string, node: V3LogisticsNode): LogisticsWaypointInput {
  return { id, name, position: { ...node.position! }, altitudeMeters: 0, segmentAltitudeMeters: 40, speedMps: workspace.value?.aircraft.cruiseSpeedMps ?? 12, nodeId: node.id, locked: true }
}

function addWaypoint(position: V3Coordinate) {
  const route = selectedRoute.value
  if (!canEdit.value || !route) return
  pushHistory()
  const waypoint = insertIntermediateWaypoint(route, {
    id: crypto.randomUUID(),
    position,
    cruiseSpeedMps: workspace.value?.aircraft.cruiseSpeedMps ?? 12
  })
  selectedWaypointId.value = waypoint.id
  markDirty()
}

function setToolMode(mode: "ANNOTATION" | "MEASURE") {
  addWaypointMode.value = false
  toolMode.value = toolMode.value === mode ? null : mode
  if (mode === "MEASURE") distanceMeasurement.value = null
}

function toggleWaypointMode() {
  if (!canEdit.value || !selectedRoute.value) return
  addWaypointMode.value = !addWaypointMode.value
  if (addWaypointMode.value) {
    toolMode.value = null
    distanceMeasurement.value = null
  }
}

function cancelMapInteraction() {
  if (!addWaypointMode.value && !toolMode.value) return
  addWaypointMode.value = false
  toolMode.value = null
  distanceMeasurement.value = null
}

function addAnnotation(position: ShowAreaMeasuredPoint) {
  if (!canEdit.value) return
  pushHistory()
  const annotation: LogisticsMapAnnotationInput = {
    id: crypto.randomUUID(),
    label: `地图标注 ${annotations.value.length + 1}`,
    position: { longitude: position.longitude, latitude: position.latitude },
    heightMeters: position.heightMeters
  }
  annotations.value = [...annotations.value, annotation]
  selectedAnnotationId.value = annotation.id
  selectedRouteId.value = ""
  selectedWaypointId.value = ""
  toolMode.value = null
  markDirty()
}

function selectAnnotation(annotationId: string) {
  selectedAnnotationId.value = annotationId
  selectedRouteId.value = ""
  selectedWaypointId.value = ""
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
  annotations.value = annotations.value.filter((annotation) => annotation.id !== selectedAnnotationId.value)
  selectedAnnotationId.value = annotations.value[0]?.id ?? ""
  markDirty()
}

function applyMeasurement(value: ShowAreaDistanceMeasurement) {
  distanceMeasurement.value = value
  toolMode.value = null
}

function toggleNodeType(type: V3LogisticsNodeType) {
  visibleNodeTypes.value = visibleNodeTypes.value.includes(type)
    ? visibleNodeTypes.value.filter((item) => item !== type)
    : [...visibleNodeTypes.value, type]
}

function moveWaypoint(routeId: string, waypointId: string, position: V3Coordinate) {
  const route = routes.value.find((item) => item.id === routeId)
  if (!route || !moveIntermediateWaypoint(route, waypointId, position)) return
  selectedRouteId.value = routeId
  selectedWaypointId.value = waypointId
  markDirty()
}

function deleteSelectedWaypoint() {
  const route = selectedRoute.value
  const waypoint = selectedWaypoint.value
  if (!canEdit.value || !route || !waypoint || waypoint.locked) return
  pushHistory()
  if (!deleteIntermediateWaypoint(route, waypoint.id)) return
  selectedWaypointId.value = ""
  markDirty()
}

function deleteSelectedRoute(routeId = selectedRouteId.value) {
  if (!canEdit.value || !routes.value.some((route) => route.id === routeId)) return
  pushHistory()
  routes.value = routes.value.filter((route) => route.id !== routeId)
  selectedRouteId.value = routes.value[0]?.id ?? ""
  selectedWaypointId.value = ""
  addWaypointMode.value = false
  markDirty()
  ElMessage.success("航线已删除，可使用撤销恢复")
}

async function batchHeight() {
  if (!canEdit.value || routes.value.length === 0) return
  const maximumHeight = workspace.value?.aircraft.maximumHeightMeters ?? 120
  try {
    const result = await ElMessageBox.prompt("为全部非端点航点和航段设置统一高度", "批量高度", {
      inputValue: String(Math.min(45, maximumHeight)),
      inputValidator: (value) => parseBatchRouteHeight(value, maximumHeight) !== null,
      inputErrorMessage: `请输入 20 到 ${maximumHeight} 米的整数`
    })
    const height = parseBatchRouteHeight(result.value, maximumHeight)
    if (height === null) return
    pushHistory()
    applyBatchRouteHeight(routes.value, height)
    markDirty()
  } catch {
    return
  }
}

function beginFormEdit() {
  if (canEdit.value) pushHistory()
}

function pushHistory() {
  undoStack.value.push(editorSnapshot())
  if (undoStack.value.length > 40) undoStack.value.shift()
  redoStack.value = []
}

function undo() {
  const snapshot = undoStack.value.pop()
  if (!snapshot || !canEdit.value) return
  redoStack.value.push(editorSnapshot())
  restoreEditorSnapshot(snapshot)
}

function redo() {
  const snapshot = redoStack.value.pop()
  if (!snapshot || !canEdit.value) return
  undoStack.value.push(editorSnapshot())
  restoreEditorSnapshot(snapshot)
}

function editorSnapshot(): LogisticsRouteEditorSnapshot {
  return { routes: cloneRoutes(routes.value), annotations: annotations.value.map(cloneAnnotation) }
}

function restoreEditorSnapshot(snapshot: LogisticsRouteEditorSnapshot) {
  routes.value = cloneRoutes(snapshot.routes)
  annotations.value = snapshot.annotations.map(cloneAnnotation)
  normalizeSelection()
  markDirty()
}

function normalizeSelection() {
  if (!routes.value.some((route) => route.id === selectedRouteId.value)) selectedRouteId.value = routes.value[0]?.id ?? ""
  if (!selectedRoute.value?.waypoints.some((waypoint) => waypoint.id === selectedWaypointId.value)) selectedWaypointId.value = ""
  if (!annotations.value.some((annotation) => annotation.id === selectedAnnotationId.value)) selectedAnnotationId.value = ""
}

function markDirty() {
  editRevision += 1
  dirty = true
  saveState.value = "PENDING"
  if (workspace.value) workspace.value.draft.lastCheckResult = null
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void saveDraft(true)
  }, 1_200)
}

async function saveDraft(silent = false, showLoading = true): Promise<boolean> {
  if (!workspace.value || !canEdit.value) return true
  if (!dirty) return true
  if (savePromise) {
    const saved = await savePromise
    return saved && dirty ? saveDraft(silent, showLoading) : saved
  }
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = null
  if (showLoading) saving.value = true
  const revision = workspace.value.draft.revision
  const payload = cloneRoutes(routes.value)
  const annotationPayload = annotations.value.map(cloneAnnotation)
  const savingEditRevision = editRevision
  savePromise = (async () => {
    try {
      const value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/route-plan/draft`, { method: "PUT", body: JSON.stringify({ expectedRevision: revision, routes: payload, annotations: annotationPayload }) })
      if (editRevision === savingEditRevision) {
        applySavedDraft(value)
        if (!silent) ElMessage.success("航线草稿已保存")
      } else {
        workspace.value = {
          ...value,
          draft: {
            ...value.draft,
            routes: cloneRoutes(routes.value),
            annotations: annotations.value.map(cloneAnnotation),
            lastCheckResult: null
          }
        }
        dirty = true
        saveState.value = "PENDING"
      }
      return true
    } catch (error) {
      saveState.value = "ERROR"
      ElMessage.error(error instanceof Error ? error.message : "航线草稿保存失败")
      return false
    } finally {
      if (showLoading) saving.value = false
      savePromise = null
    }
  })()
  const saved = await savePromise
  return saved && dirty ? saveDraft(silent, showLoading) : saved
}

async function runCheck() {
  if (!await saveDraft(true)) return
  relationOnly.value = false
  await mutateWorkspace(`/v3/logistics-projects/${props.project.id}/route-plan/check`, "航线检查已完成")
  panelTab.value = "CHECK"
}

async function inspectSpatialRelationships() {
  if (!await saveDraft(true)) return
  relationOnly.value = true
  await mutateWorkspace(`/v3/logistics-projects/${props.project.id}/route-plan/check`, "空间关系检查已完成")
  panelTab.value = "CHECK"
}

async function createSnapshot() {
  if (!await saveDraft(true)) return
  await mutateWorkspace(`/v3/logistics-projects/${props.project.id}/route-plan/snapshot`, "候选版本已保存")
  panelTab.value = "VERSIONS"
}

async function completePlanning() {
  if (!workspace.value || !await saveDraft(true)) return
  saving.value = true
  try {
    const value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/route-plan/complete`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: workspace.value.draft.revision, expectedStageRevision: props.stage.revision }) })
    applyWorkspace(value, true)
    ElMessage.success("航线规划已完成，航线验证阶段已开放")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "航线规划提交失败")
  } finally {
    saving.value = false
  }
}

async function validateRoutes() {
  validationProgress.value = startV3OperationProgress("多航线往返验证", ["保存当前航线", "执行批量往返验证", "汇总验证结果"])
  if (!await saveDraft(true, false)) {
    validationProgress.value = failV3OperationProgress(validationProgress.value, "航线草稿保存失败，未开始验证")
    return
  }
  validationProgress.value = advanceV3OperationProgress(validationProgress.value, 1)
  try {
    const value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/route-plan/validate`, { method: "POST" })
    applyWorkspace(value, false)
    validationProgress.value = advanceV3OperationProgress(validationProgress.value, 2)
    const run = value.validationRuns[0]
    validationProgress.value = completeV3OperationProgress(
      validationProgress.value,
      run
        ? `完成 ${run.result.completedRoundTripCount}/${run.result.requiredRoundTripCount} 组往返，硬冲突 ${run.result.evidence.filter((item) => item.severity === "CONFLICT").length} 项`
        : "验证请求已完成，未返回可汇总的验证记录"
    )
    ElMessage.success("完整往返验证已完成")
    panelTab.value = "CHECK"
  } catch (error) {
    const message = error instanceof Error ? error.message : "完整往返验证失败"
    validationProgress.value = failV3OperationProgress(validationProgress.value, message)
    ElMessage.error(message)
  }
}

async function submitPlan() {
  if (!workspace.value || !latestSubmittableVersion.value || !await saveDraft(true)) return
  saving.value = true
  try {
    const value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/route-plan/versions/${latestSubmittableVersion.value.id}/submit`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: workspace.value.draft.revision, expectedStageRevision: props.stage.revision }) })
    applyWorkspace(value, true)
    ElMessage.success("《固定物流航线方案包》已提交，订单调度阶段已解锁")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "固定航线方案提交失败")
  } finally {
    saving.value = false
  }
}

async function restoreVersion(versionId: string) {
  if (!workspace.value || !canEdit.value) return
  saving.value = true
  try {
    const value = await api<LogisticsRouteWorkspaceView>(`/v3/logistics-projects/${props.project.id}/route-plan/versions/${versionId}/restore`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: workspace.value.draft.revision }) })
    applyWorkspace(value, true)
    ElMessage.success("候选版本已恢复为当前草稿")
    panelTab.value = "ROUTES"
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "版本恢复失败")
  } finally {
    saving.value = false
  }
}

async function mutateWorkspace(path: string, successMessage: string) {
  saving.value = true
  try {
    const value = await api<LogisticsRouteWorkspaceView>(path, { method: "POST" })
    applyWorkspace(value, false)
    ElMessage.success(successMessage)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "操作失败")
  } finally {
    saving.value = false
  }
}

function selectEvidence(evidence: LogisticsRouteCheckEvidence) {
  selectedEvidence.value = evidence
  if (evidence.routeIds[0]) selectedRouteId.value = evidence.routeIds[0]
  if (evidence.waypointIds[0]) selectedWaypointId.value = evidence.waypointIds[0]
}

function editLocatedProblem() {
  if (!selectedEvidence.value) return
  panelTab.value = "ROUTES"
}

function routeCount(destinationId: string, direction: LogisticsRouteInput["direction"]) {
  return routes.value.filter((route) => route.destinationNodeId === destinationId && route.direction === direction && route.role === "PRIMARY").length
}

function routeStatusLabel(route: LogisticsRouteInput) {
  if (route.mode === "NETWORK_SEGMENT") return "网络航段"
  return `${route.direction === "OUTBOUND" ? "去程" : "返程"} · ${route.role === "PRIMARY" ? "主方案" : "备用"}`
}

function selectSpatialRelation(relation: LogisticsRouteSpatialRelation) {
  selectedRouteId.value = relation.routeId
  selectedWaypointId.value = relation.waypointIds[0]
  selectedAnnotationId.value = ""
}

function spatialFeatureKindLabel(kind: LogisticsRouteSpatialRelation["featureKind"]): string {
  return ({ BUILDING: "建筑", OBSTACLE: "障碍物", RESTRICTION: "禁限区域" } as const)[kind]
}

function spatialRelationStatusLabel(status: LogisticsRouteSpatialRelation["status"]): string {
  return ({ CONFLICT: "冲突", RISK: "风险", CLEAR: "净空充足" } as const)[status]
}

function validationStatusLabel(status: string) {
  return ({ PASSED: "验证通过", WITH_RISK: "存在风险", HARD_CONFLICT: "硬性冲突", INFEASIBLE: "无法完成往返" } as Record<string, string>)[status] ?? status
}

function versionSummary(version: LogisticsRouteVersionView) {
  return summarizeLogisticsRouteVersion(version)
}

function versionAttemptNo(versionId: string) {
  return workspace.value?.validationRuns.find((run) => run.versionId === versionId)?.attemptNo ?? null
}

function versionStatusLabel(version: LogisticsRouteVersionView) {
  if (version.status === "SUBMITTED") return "正式方案"
  if (version.validationResult) return validationStatusLabel(version.validationResult.status)
  return "候选快照"
}

function formatDelta(value: number, digits = 0, suffix = "") {
  const rounded = value.toFixed(digits)
  return `${value > 0 ? "+" : ""}${rounded}${suffix}`
}

function changedRouteNames(ids: string[]) {
  const versions = [comparisonTarget.value, comparisonBaseline.value].filter((version): version is LogisticsRouteVersionView => Boolean(version))
  const names = ids.map((id) => versions.flatMap((version) => version.routes).find((route) => route.id === id)?.name ?? id)
  return names.join("、") || "无"
}

function milestoneLabel(code: string) {
  return ({ AIRPORT_TAKEOFF: "机场起飞", OUTBOUND_FLIGHT: "去程飞行", ARRIVAL_CONFIRMATION: "到达确认", RETURN_FLIGHT: "返航飞行", AIRPORT_LANDING: "机场降落" } as Record<string, string>)[code] ?? code
}

function formatAircraftModelCode(value: string | null | undefined) {
  return formatAircraftModelCodeValue(value)
}

function formatSimulatedTime(seconds: number) {
  const totalSeconds = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(totalSeconds / 60)
  const remainder = totalSeconds % 60
  return `T+${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}

function evidenceCategoryLabel(category: string) {
  return ({ SPATIAL: "空间与障碍", AIRCRAFT: "机型能力", COVERAGE: "定位通信", NODES: "运行节点", ROUTE_RELATION: "多航线关系", EFFICIENCY: "效率提示" } as Record<string, string>)[category] ?? category
}

function checkSummaryStatus(summary: (typeof requiredCheckSummaries.value)[number]) {
  if (!checkResult.value) return "待检查"
  if (summary.conflictCount > 0) return `${summary.conflictCount} 项阻断`
  if (summary.riskCount > 0) return `${summary.riskCount} 项风险`
  if (summary.infoCount > 0) return `${summary.infoCount} 项提示`
  return "已检查"
}

function cloneRoutes(value: readonly LogisticsRouteInput[]): LogisticsRouteInput[] {
  return value.map(cloneRoute)
}

function cloneRoute(route: LogisticsRouteInput): LogisticsRouteInput {
  return { ...route, waitingNodeIds: [...route.waitingNodeIds], alternateLandingNodeIds: [...route.alternateLandingNodeIds], emergencyAreaNodeIds: [...route.emergencyAreaNodeIds], waypoints: route.waypoints.map(cloneWaypoint) }
}

function cloneWaypoint(waypoint: LogisticsWaypointInput): LogisticsWaypointInput {
  return { ...waypoint, position: { ...waypoint.position } }
}

function cloneAnnotation(annotation: LogisticsMapAnnotationInput): LogisticsMapAnnotationInput {
  return { ...annotation, position: { ...annotation.position } }
}

function formatDistance(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)} km` : `${value.toFixed(1)} m`
}
</script>

<template>
  <section class="logistics-route-workspace" v-loading="loading || saving">
    <div v-if="loadError && !workspace" class="route-load-panel" role="alert">
      <el-icon><Warning /></el-icon>
      <strong>物流航线暂时无法加载</strong>
      <span>{{ loadError }}</span>
      <button type="button" :disabled="loading" @click="loadWorkspace"><el-icon><RefreshRight /></el-icon>重新加载</button>
    </div>

    <main v-if="workspace || !loadError" class="logistics-route-canvas">
      <V3UnifiedMap renderer="logistics-route"
        :region="region"
        :visible-layers="visibleLayers"
        :visible-node-types="visibleNodeTypes"
        :show-labels="showLabels"
        :selected-delivery-point-ids="workspace?.regionAnalysis.selectedDeliveryPointIds ?? []"
        :routes="visibleMapRoutes"
        :annotations="annotations"
        :selected-route-id="selectedRouteId"
        :selected-waypoint-id="selectedWaypointId"
        :selected-annotation-id="selectedAnnotationId"
        :mode="mapMode"
        :editable="canEdit"
        :add-waypoint-mode="addWaypointMode"
        :tool-mode="toolMode"
        :measurement="distanceMeasurement"
        @node-select="selectOrCreateOutboundRoute"
        @route-select="selectMapRoute"
        @waypoint-select="selectMapWaypoint"
        @waypoint-created="addWaypoint"
        @waypoint-moved="moveWaypoint"
        @annotation-created="addAnnotation"
        @annotation-select="selectAnnotation"
        @measured="applyMeasurement"
        @edit-start="pushHistory"
        @interaction-cancel="cancelMapInteraction"
        @data-state="handleMapDataState"
      />

      <V3EnvironmentLayerPanel
        :region="region"
        scene-type="CITY_LOGISTICS"
        :visible-layers="visibleLayers"
        :visible-node-types="visibleNodeTypes"
        :terrain-state="mapTerrainState"
        :details="environmentDetails"
        @toggle-layer="emit('toggleLayer', $event)"
        @toggle-node-type="toggleNodeType"
        @toggle-labels="showLabels = !showLabels"
      />

      <div class="route-map-toolbar">
        <el-tooltip content="撤销" placement="bottom"><button type="button" aria-label="撤销" :disabled="!canEdit || undoStack.length === 0" @click="undo"><el-icon><Back /></el-icon></button></el-tooltip>
        <el-tooltip content="重做" placement="bottom"><button type="button" aria-label="重做" :disabled="!canEdit || redoStack.length === 0" @click="redo"><el-icon><Right /></el-icon></button></el-tooltip>
        <span />
        <el-tooltip content="在地图添加航点" placement="bottom"><button type="button" aria-label="添加航点" :class="{ active: addWaypointMode }" :aria-pressed="addWaypointMode" :disabled="!canEdit || !selectedRoute" @click="toggleWaypointMode"><el-icon><EditPen /></el-icon></button></el-tooltip>
        <el-tooltip content="复制去程为返程" placement="bottom"><button type="button" aria-label="复制为返程" :disabled="!canCopyAsReturn" @click="copyAsReturn"><el-icon><CopyDocument /></el-icon></button></el-tooltip>
        <el-tooltip content="复制为备用方案" placement="bottom"><button type="button" aria-label="复制为备用方案" :disabled="!canEdit || !selectedRoute" @click="duplicateAsAlternate"><el-icon><DocumentAdd /></el-icon></button></el-tooltip>
        <el-tooltip content="批量调整高度" placement="bottom"><button type="button" aria-label="批量高度" :disabled="!canEdit || routes.length === 0" @click="batchHeight"><el-icon><SetUp /></el-icon></button></el-tooltip>
        <el-tooltip content="查看多航线空间关系" placement="bottom"><button type="button" aria-label="空间关系" :disabled="routes.length < 2" @click="inspectSpatialRelationships"><el-icon><Connection /></el-icon></button></el-tooltip>
        <span />
        <el-tooltip content="距离、方位与地形高程" placement="bottom"><button type="button" aria-label="距离与方位测量" :class="{ active: toolMode === 'MEASURE' }" :aria-pressed="toolMode === 'MEASURE'" @click="setToolMode('MEASURE')"><el-icon><ScaleToOriginal /></el-icon></button></el-tooltip>
        <el-tooltip content="添加地图文字标注" placement="bottom"><button type="button" aria-label="添加地图文字标注" :class="{ active: toolMode === 'ANNOTATION' }" :aria-pressed="toolMode === 'ANNOTATION'" :disabled="!canEdit" @click="setToolMode('ANNOTATION')"><el-icon><AddLocation /></el-icon></button></el-tooltip>
        <el-tooltip content="删除选中航线" placement="bottom"><button type="button" aria-label="删除航线" :disabled="!canEdit || !selectedRoute" @click="deleteSelectedRoute()"><el-icon><Delete /></el-icon></button></el-tooltip>
      </div>

      <div v-if="addWaypointMode && canEdit" class="route-draw-hint"><el-icon><Position /></el-icon><span>在地图上点击添加中间航点，拖动航点可调整位置</span><button type="button" aria-label="结束添加航点" @click="addWaypointMode = false"><el-icon><Check /></el-icon></button></div>
      <div v-if="activeToolLabel && !addWaypointMode" class="route-tool-status">
        <span>{{ activeToolLabel }}</span>
        <el-tooltip content="取消当前操作" placement="bottom">
          <button type="button" aria-label="取消当前操作" @click="cancelMapInteraction"><el-icon><Close /></el-icon></button>
        </el-tooltip>
      </div>
      <section v-if="selectedAnnotation" class="route-map-tool-panel annotation">
        <header><div><strong>地图文字标注</strong></div><button type="button" aria-label="删除标注" :disabled="!canEdit" @click="removeSelectedAnnotation"><el-icon><Delete /></el-icon></button></header>
        <el-input :model-value="selectedAnnotation.label" :disabled="!canEdit" maxlength="120" @update:model-value="updateAnnotationLabel" />
        <dl>
          <div><dt>{{ formatCoordinateReference('WGS84') }}</dt><dd>{{ selectedAnnotation.position.longitude.toFixed(7) }}, {{ selectedAnnotation.position.latitude.toFixed(7) }}</dd></div>
          <div><dt>地形高程</dt><dd>{{ selectedAnnotation.heightMeters === null ? '未获取' : `${selectedAnnotation.heightMeters.toFixed(1)} m` }}</dd></div>
        </dl>
      </section>
      <section v-else-if="distanceMeasurement" class="route-map-tool-panel measurement">
        <header><div><strong>距离与方位</strong></div><button type="button" aria-label="清除测量" @click="distanceMeasurement = null"><el-icon><Delete /></el-icon></button></header>
        <p><b>{{ formatDistance(distanceMeasurement.distanceMeters) }}</b><strong>{{ distanceMeasurement.bearingDegrees.toFixed(1) }}°</strong></p>
        <dl>
          <div><dt>起点</dt><dd>{{ distanceMeasurement.start.longitude.toFixed(6) }}, {{ distanceMeasurement.start.latitude.toFixed(6) }} · {{ distanceMeasurement.start.heightMeters === null ? '-' : `${distanceMeasurement.start.heightMeters.toFixed(1)} m` }}</dd></div>
          <div><dt>终点</dt><dd>{{ distanceMeasurement.end.longitude.toFixed(6) }}, {{ distanceMeasurement.end.latitude.toFixed(6) }} · {{ distanceMeasurement.end.heightMeters === null ? '-' : `${distanceMeasurement.end.heightMeters.toFixed(1)} m` }}</dd></div>
        </dl>
      </section>
      <div class="route-map-caption"><i :class="selectedRoute?.direction === 'RETURN' ? 'return' : 'outbound'" /><div><strong>{{ selectedRoute?.name ?? '尚未选择航线' }}</strong><small>{{ region.title }} · {{ routes.length }} 条学生航线 · {{ formatCoordinateReference('WGS84') }} / {{ formatHeightDatum(region.heightDatum) }}</small></div></div>
    </main>

    <aside v-if="workspace || !loadError" class="logistics-route-inspector">
      <header>
        <div><span>{{ isPlanningStage ? 'ROUTE PLANNING' : 'ROUND-TRIP VALIDATION' }}</span><strong>{{ isPlanningStage ? '固定航线规划' : '航线仿真验证' }}</strong></div>
        <em :class="saveState.toLowerCase()">{{ saveState === 'SAVED' ? '已保存' : saveState === 'PENDING' ? '待保存' : '保存异常' }}</em>
        <p><b>{{ routes.length }}</b> 条</p>
      </header>
      <p v-if="loadError" class="route-load-error" role="alert">航线数据同步失败：{{ loadError }}，当前内容未清除，请稍后重新加载。</p>
      <V3OperationProgress :state="validationProgress" />

      <nav class="route-workspace-tabs">
        <button v-if="isPlanningStage" type="button" class="active" aria-pressed="true" @click="panelTab = 'ROUTES'">航线规划</button>
        <button v-if="!isPlanningStage" type="button" class="active" aria-pressed="true">检查与验证 <i v-if="checkResult?.conflictCount">{{ checkResult.conflictCount }}</i></button>
        <el-button v-if="isPlanningStage" text size="small" @click="panelTab = 'VERSIONS'">版本</el-button>
      </nav>

      <div v-if="panelTab === 'ROUTES'">
        <section class="delivery-route-matrix">
          <header><strong>启用配送点</strong><small>{{ selectedDeliveryNodes.length }} 个</small></header>
          <el-button plain size="small" @click="deliveryPointDialogOpen = true">查看并配置配送点</el-button>
        </section>

        <section class="route-list-panel">
          <header><strong>航线清单</strong><span class="route-list-header-actions"><button v-if="canEdit" type="button" @click="openNetworkRouteDialog"><el-icon><Connection /></el-icon>网络航段</button><button v-if="canEdit" type="button" @click="createSnapshot"><el-icon><FolderOpened /></el-icon>保存版本</button></span></header>
          <div class="route-select-row">
            <el-select v-model="selectedRouteId" filterable placeholder="选择要查看的航线" @change="selectedWaypointId = ''">
              <el-option v-for="route in routes" :key="route.id" :label="`${route.name} · ${routeStatusLabel(route)}`" :value="route.id" />
            </el-select>
            <el-tooltip content="删除当前航线" placement="left"><el-button v-if="canEdit" text type="danger" :disabled="!selectedRoute" aria-label="删除当前航线" @click="deleteSelectedRoute()"><el-icon><Delete /></el-icon></el-button></el-tooltip>
          </div>
          <div v-if="routes.length === 0" class="route-empty"><Position /><span>从启用配送点分别新建去程与返程航线</span></div>
        </section>

        <section v-if="selectedRoute" :key="`${selectedRoute.id}-${routeFormRevision}`" class="route-property-panel">
          <header><strong>航线参数</strong><small>{{ routeStatusLabel(selectedRoute) }}</small></header>
          <label><span>名称</span><el-input v-model="selectedRoute.name" :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
          <div class="route-property-grid">
            <label><span>分组</span><el-input v-model="selectedRoute.groupCode" :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
            <label><span>保护范围 (m)</span><el-input-number v-model="selectedRoute.protectionRadiusMeters" :min="10" :max="200" :controls="false" :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
            <label><span>离场方向 (°)</span><el-input-number v-model="selectedRoute.exitDirectionDegrees" :min="0" :max="360" :controls="false" :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
            <label><span>进场方向 (°)</span><el-input-number v-model="selectedRoute.entryDirectionDegrees" :min="0" :max="360" :controls="false" :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
          </div>
          <label><span>等待点</span><el-select v-model="selectedRoute.waitingNodeIds" multiple collapse-tags :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty"><el-option v-for="node in waitingNodes" :key="node.id" :label="node.name" :value="node.id" /></el-select></label>
          <label><span>备降点</span><el-select v-model="selectedRoute.alternateLandingNodeIds" multiple collapse-tags :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty"><el-option v-for="node in alternateNodes" :key="node.id" :label="node.name" :value="node.id" /></el-select></label>
          <label><span>应急运行区域</span><el-select v-model="selectedRoute.emergencyAreaNodeIds" multiple collapse-tags :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty"><el-option v-for="node in emergencyNodes" :key="node.id" :label="node.name" :value="node.id" /></el-select></label>
        </section>

        <section v-if="selectedRoute" class="route-spatial-panel" aria-label="航线空间与高度关系">
          <header><div><strong>空间与高度关系</strong></div><small>{{ mapMode === '3d' ? '三维净空' : '二维保护区' }}</small></header>
          <div class="route-spatial-kpis"><span><b>{{ selectedSpatialRelationCounts.conflict }}</b><small>冲突</small></span><span><b>{{ selectedSpatialRelationCounts.risk }}</b><small>风险</small></span><span><b>{{ selectedSpatialRelationCounts.clear }}</b><small>净空充足</small></span></div>
          <button v-for="relation in selectedSpatialRelations" :key="relation.id" type="button" :class="relation.status.toLowerCase()" :aria-label="`航段${relation.segmentIndex + 1}，${spatialFeatureKindLabel(relation.featureKind)}${relation.featureName}，${spatialRelationStatusLabel(relation.status)}：${relation.message}`" @click="selectSpatialRelation(relation)">
            <i>{{ String(relation.segmentIndex + 1).padStart(2, '0') }}</i>
            <span><strong>{{ spatialFeatureKindLabel(relation.featureKind) }} · {{ relation.featureName }}</strong><small>{{ relation.message }}</small></span>
            <em>{{ spatialRelationStatusLabel(relation.status) }}</em>
          </button>
          <div v-if="selectedSpatialRelations.length === 0" class="route-spatial-empty"><CircleCheck /><span>当前航线保护范围未与建筑、障碍或禁限区域重叠</span></div>
        </section>

        <section v-if="selectedRoute" class="waypoint-panel">
          <header><strong>航点与航段</strong><small>{{ selectedRoute.waypoints.length }} 个</small></header>
          <button v-for="(waypoint, index) in selectedRoute.waypoints" :key="waypoint.id" type="button" :class="{ active: selectedWaypointId === waypoint.id, locked: waypoint.locked }" :aria-pressed="selectedWaypointId === waypoint.id" @click="selectedWaypointId = waypoint.id">
            <i>{{ String(index + 1).padStart(2, '0') }}</i><span><strong>{{ waypoint.name }}</strong><small>{{ waypoint.altitudeMeters }}m · 航段 {{ waypoint.segmentAltitudeMeters }}m · {{ waypoint.speedMps }}m/s</small></span><el-icon v-if="waypoint.locked"><Select /></el-icon>
          </button>
        </section>

        <section v-if="selectedWaypoint" class="waypoint-editor">
          <header><strong>航点属性</strong><button v-if="canEdit && !selectedWaypoint.locked" type="button" aria-label="删除航点" @click="deleteSelectedWaypoint"><el-icon><Delete /></el-icon></button></header>
          <label><span>名称</span><el-input v-model="selectedWaypoint.name" :disabled="!canEdit || selectedWaypoint.locked" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
          <div class="route-property-grid">
            <label><span>航点高度 (m)</span><el-input-number v-model="selectedWaypoint.altitudeMeters" :min="0" :max="workspace?.aircraft.maximumHeightMeters ?? 120" :controls="false" :disabled="!canEdit || selectedWaypoint.locked" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
            <label><span>下一航段高度</span><el-input-number v-model="selectedWaypoint.segmentAltitudeMeters" :min="20" :max="workspace?.aircraft.maximumHeightMeters ?? 120" :controls="false" :disabled="!canEdit || !selectedWaypointHasFollowingSegment" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
            <label><span>经度</span><el-input-number v-model="selectedWaypoint.position.longitude" :precision="7" :controls="false" :disabled="!canEdit || selectedWaypoint.locked" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
            <label><span>纬度</span><el-input-number v-model="selectedWaypoint.position.latitude" :precision="7" :controls="false" :disabled="!canEdit || selectedWaypoint.locked" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
            <label><span>速度 (m/s)</span><el-input-number v-model="selectedWaypoint.speedMps" :min="1" :max="workspace?.aircraft.maximumSpeedMps ?? 18" :controls="false" :disabled="!canEdit" @focus="beginFormEdit" @update:model-value="markDirty" /></label>
          </div>
        </section>
      </div>

      <div v-else-if="panelTab === 'CHECK'">
        <section class="route-check-overview">
          <header><strong>{{ relationOnly ? '多航线空间关系' : '规则检查' }}</strong><em :class="{ passed: checkResult?.passed }">{{ !checkResult ? '尚未检查' : relationOnly ? `${displayedEvidence.length} 项关系证据` : checkResult.passed ? '无硬冲突' : `${checkResult.conflictCount} 项阻断` }}</em></header>
          <div><span><b>{{ relationOnly ? displayedEvidenceCounts.conflict : checkResult?.conflictCount ?? 0 }}</b><small>{{ relationOnly ? '关系冲突' : '硬性冲突' }}</small></span><span><b>{{ relationOnly ? displayedEvidenceCounts.risk : checkResult?.riskCount ?? 0 }}</b><small>{{ relationOnly ? '关系风险' : '运行风险' }}</small></span><span><b>{{ relationOnly ? displayedEvidenceCounts.info : checkResult?.infoCount ?? 0 }}</b><small>{{ relationOnly ? '关系提示' : '效率提示' }}</small></span></div>
        </section>
        <section v-if="!relationOnly" class="route-check-categories" aria-label="当前航线检查分类">
          <header><strong>检查项目</strong><small>{{ checkResult ? `${checkResult.routeCount} 条当前航线` : '尚未执行' }}</small></header>
          <div>
            <article v-for="summary in requiredCheckSummaries" :key="summary.category" :class="{ passed: checkResult && summary.passed, blocked: summary.conflictCount > 0 }">
              <el-icon><Warning v-if="summary.conflictCount > 0" /><CircleCheck v-else /></el-icon>
              <strong>{{ summary.title }}</strong>
              <small>{{ checkSummaryStatus(summary) }}</small>
            </article>
          </div>
        </section>
        <section class="route-evidence-list">
          <button v-for="evidence in displayedEvidence" :key="`${evidence.code}-${evidence.routeIds.join('-')}-${evidence.segmentIndexes.join('-')}`" type="button" :class="[evidence.severity.toLowerCase(), { active: selectedEvidence === evidence }]" :aria-pressed="selectedEvidence === evidence" @click="selectEvidence(evidence)">
            <el-icon><Warning v-if="evidence.severity !== 'INFO'" /><Finished v-else /></el-icon><span><strong>{{ evidenceCategoryLabel(evidence.category) }} · {{ formatLogisticsEvidenceCode(evidence.code) }}</strong><small>{{ evidence.message }}</small></span>
          </button>
          <div v-if="displayedEvidence.length === 0" class="route-check-empty"><CircleCheck /><span>{{ checkResult ? relationOnly ? '当前航线之间未发现空间交叉' : '当前方案未发现规则问题' : '保存方案后执行权威检查' }}</span></div>
        </section>
        <section v-if="problemLocation" class="route-problem-location" aria-label="问题定位详情">
          <header><div><strong>问题定位</strong></div><em :class="problemLocation.severity.toLowerCase()">{{ problemLocation.severity === 'CONFLICT' ? '硬性冲突' : problemLocation.severity === 'RISK' ? '运行风险' : '效率提示' }}</em></header>
          <p>{{ problemLocation.message }}</p>
          <dl>
            <div><dt>问题类型</dt><dd>{{ problemLocation.problemType }}</dd></div>
            <div><dt>发生航线</dt><dd>{{ problemLocation.routeLabel }}</dd></div>
            <div><dt>发生航段</dt><dd>{{ problemLocation.segmentLabel }}</dd></div>
            <div><dt>发生时间</dt><dd>{{ problemLocation.simulatedAtLabel }}</dd></div>
            <div v-if="problemLocation.positionLabel"><dt>发生位置</dt><dd><code>{{ problemLocation.positionLabel }}</code></dd></div>
          </dl>
          <div class="problem-runtime-data">
            <header><strong>相关运行数据</strong><small>{{ problemLocation.runtimeData.length }} 项</small></header>
            <div v-if="problemLocation.runtimeData.length">
              <span v-for="item in problemLocation.runtimeData" :key="item.key"><small>{{ item.label }}</small><b>{{ item.value }}</b></span>
            </div>
            <p v-else>该问题没有额外运行参数。</p>
          </div>
          <footer><span>系统只定位问题，不生成新航点或最优路线。</span><el-button v-if="canEdit && selectedEvidence?.routeIds[0]" text @click="editLocatedProblem">查看对应航线</el-button></footer>
        </section>
        <section v-if="latestRun" class="route-validation-result">
          <header><div><strong>完整往返验证</strong><small>{{ formatAircraftModelCode(latestRun.result.aircraftModelCode ?? workspace?.aircraft.modelCode) }} · 参数 {{ latestRun.result.aircraftRuleVersion ?? workspace?.aircraft.ruleVersion ?? '未指定' }}</small></div><em :class="latestRun.status.toLowerCase()">{{ validationStatusLabel(latestRun.status) }}</em></header>
          <div class="validation-kpis"><span><b>{{ latestRun.result.completedRoundTripCount }}/{{ latestRun.result.requiredRoundTripCount }}</b><small>完成往返</small></span><span><b>{{ latestRun.attemptNo }}</b><small>验证次数</small></span><span><b>{{ latestRun.result.routeMetrics.length }}</b><small>航线指标</small></span></div>
          <article v-for="metric in latestRun.result.roundTripMetrics" :key="metric.destinationNodeId" class="round-trip-metric">
            <header><strong>{{ selectedDeliveryNodes.find(node => node.id === metric.destinationNodeId)?.name ?? metric.destinationNodeId }}</strong><small>{{ (metric.distanceMeters / 1000).toFixed(2) }} km · {{ Math.round(metric.flightTimeSeconds / 60) }} min · 剩余 {{ metric.remainingBatteryPercent }}%</small></header>
            <ol v-if="metric.milestones?.length" aria-label="往返仿真过程">
              <li v-for="milestone in metric.milestones" :key="milestone.code">
                <i>{{ milestone.sequence }}</i>
                <span><strong>{{ milestoneLabel(milestone.code) }}</strong><small>{{ milestone.position.longitude.toFixed(5) }}, {{ milestone.position.latitude.toFixed(5) }}</small></span>
                <em>{{ formatSimulatedTime(milestone.simulatedAtSeconds) }}<small>{{ milestone.remainingBatteryPercent }}%</small></em>
              </li>
            </ol>
          </article>
        </section>
      </div>

      <div v-else>
        <section class="route-version-list">
          <header><strong>方案与验证历史</strong><small>草稿 R{{ workspace?.draft.revision }} · 验证 {{ workspace?.validationAttemptCount }}/{{ workspace?.allowedValidationAttempts }}</small></header>
          <article v-for="version in workspace?.versions ?? []" :key="version.id">
            <div>
              <span>V{{ version.versionNo }}</span>
              <strong>{{ versionStatusLabel(version) }}</strong>
              <small>草稿 R{{ version.sourceDraftRevision }} · {{ version.routes.length }} 条航线 · {{ versionSummary(version).waypointCount }} 航点<span v-if="versionAttemptNo(version.id)"> · 第 {{ versionAttemptNo(version.id) }} 次验证</span></small>
              <small v-if="version.validationResult">{{ version.validationResult.completedRoundTripCount }}/{{ version.validationResult.requiredRoundTripCount }} 往返 · 硬冲突 {{ version.checkResult.conflictCount }} · 风险 {{ version.checkResult.riskCount }}</small>
            </div>
            <em :class="version.status.toLowerCase()">{{ formatSubmissionStatus(version.status) }}</em>
            <div class="version-actions">
              <button type="button" :class="{ selected: comparisonBaselineId === version.id }" :aria-pressed="comparisonBaselineId === version.id" title="设为对比基线" @click="comparisonBaselineId = version.id">基线</button>
              <button type="button" :class="{ selected: comparisonTargetId === version.id }" :aria-pressed="comparisonTargetId === version.id" title="设为对比目标" @click="comparisonTargetId = version.id">目标</button>
              <button v-if="canEdit" type="button" title="恢复为当前草稿" aria-label="恢复为当前草稿" @click="restoreVersion(version.id)"><el-icon><RefreshRight /></el-icon>恢复</button>
            </div>
          </article>
          <div v-if="workspace?.versions.length === 0" class="route-check-empty"><FolderOpened /><span>尚未保存候选版本</span></div>
        </section>
        <section v-if="versionComparison && comparisonBaseline && comparisonTarget" class="route-version-comparison" aria-label="航线版本结果对比">
          <header>
            <div><span>版本对比</span><strong>V{{ comparisonBaseline.versionNo }} 与 V{{ comparisonTarget.versionNo }}</strong></div>
            <small>目标版本相对基线</small>
          </header>
          <div class="version-delta-grid">
            <span><small>航线</small><b>{{ formatDelta(versionComparison.deltas.routeCount) }}</b></span>
            <span><small>航点</small><b>{{ formatDelta(versionComparison.deltas.waypointCount) }}</b></span>
            <span><small>硬冲突</small><b :class="{ improved: versionComparison.deltas.conflictCount < 0, worsened: versionComparison.deltas.conflictCount > 0 }">{{ formatDelta(versionComparison.deltas.conflictCount) }}</b></span>
            <span><small>运行风险</small><b :class="{ improved: versionComparison.deltas.riskCount < 0, worsened: versionComparison.deltas.riskCount > 0 }">{{ formatDelta(versionComparison.deltas.riskCount) }}</b></span>
            <span><small>总航程</small><b>{{ formatDelta(versionComparison.deltas.totalDistanceMeters, 1, ' m') }}</b></span>
            <span><small>总时长</small><b>{{ formatDelta(versionComparison.deltas.totalFlightTimeSeconds, 1, ' s') }}</b></span>
            <span><small>最低余电</small><b>{{ versionComparison.deltas.minimumRemainingBatteryPercent === null ? '-' : formatDelta(versionComparison.deltas.minimumRemainingBatteryPercent, 1, '%') }}</b></span>
            <span><small>完成往返</small><b>{{ formatDelta(versionComparison.deltas.completedRoundTripCount) }}</b></span>
          </div>
          <dl>
            <div><dt>新增航线</dt><dd>{{ changedRouteNames(versionComparison.addedRouteIds) }}</dd></div>
            <div><dt>移除航线</dt><dd>{{ changedRouteNames(versionComparison.removedRouteIds) }}</dd></div>
            <div><dt>修改航线</dt><dd>{{ changedRouteNames(versionComparison.changedRouteIds) }}</dd></div>
          </dl>
          <p>每次验证均绑定不可变方案版本；恢复历史版本后必须重新验证，旧方案和旧结果继续保留。</p>
        </section>
        <section v-else-if="(workspace?.versions.length ?? 0) > 1" class="route-version-compare-hint">
          请选择不同的基线和目标版本进行结果对比。
        </section>
      </div>

      <footer v-if="canEdit" class="route-submit-actions">
        <div v-if="!isPlanningStage && formalPackageSummary" class="formal-package-summary" aria-label="固定物流航线方案包提交摘要">
          <strong>固定物流航线方案包 · V{{ formalPackageSummary.versionNo }}</strong>
          <span>{{ formalPackageSummary.destinationCount }} 个配送点 · {{ formalPackageSummary.formalRouteCount }} 条正式去返程 · {{ formalPackageSummary.completedRoundTripCount }}/{{ formalPackageSummary.requiredRoundTripCount }} 往返完成 · {{ formalPackageSummary.riskCount }} 项非阻断风险</span>
        </div>
        <el-button @click="saveDraft(false)">保存</el-button>
        <el-button @click="runCheck">检查</el-button>
        <el-button v-if="isPlanningStage" type="primary" :disabled="!workspace?.canCompletePlanning" @click="completePlanning">完成规划</el-button>
        <el-button v-else :disabled="!workspace?.canValidate" @click="validateRoutes">往返验证</el-button>
        <el-button v-if="!isPlanningStage" type="primary" :disabled="!workspace?.canSubmit || !latestSubmittableVersion" @click="submitPlan"><el-icon><UploadFilled /></el-icon>提交航线方案包</el-button>
      </footer>
      <footer v-else class="route-submit-actions read-only"><span><el-icon><Check /></el-icon>{{ props.stage.status === 'ACCEPTED' ? '本阶段成果已锁定' : '教师只读查看学生航线' }}</span></footer>
    </aside>
    <el-dialog v-model="deliveryPointDialogOpen" title="启用配送点" width="380px" append-to-body>
      <div class="delivery-dialog-list">
        <article v-for="node in selectedDeliveryNodes" :key="node.id">
          <span><strong>{{ node.name }}</strong><small>{{ node.code }} · 去 {{ routeCount(node.id, 'OUTBOUND') }} · 返 {{ routeCount(node.id, 'RETURN') }}</small></span>
          <div class="route-direction-actions">
            <el-tooltip content="新建去程航线" placement="top"><el-button text :disabled="!canEdit || routeCount(node.id, 'OUTBOUND') > 0" @click="createPrimaryRoute(node, 'OUTBOUND')"><el-icon><Right /></el-icon></el-button></el-tooltip>
            <el-tooltip content="新建返程航线" placement="top"><el-button text :disabled="!canEdit || routeCount(node.id, 'RETURN') > 0" @click="createPrimaryRoute(node, 'RETURN')"><el-icon><Back /></el-icon></el-button></el-tooltip>
          </div>
        </article>
        <p v-if="selectedDeliveryNodes.length === 0">尚未启用配送点，请先完成区域分析。</p>
      </div>
    </el-dialog>
    <el-dialog v-model="networkDialogOpen" title="新建网络航段" width="360px" append-to-body>
      <p class="network-route-dialog-hint">选择任意两个可运行节点。此航段可保存、删除并参与空间检查；正式运行调度将在多航段任务版本中启用。</p>
      <label class="network-route-dialog-field"><span>起点</span><el-select v-model="networkDepartureNodeId" filterable><el-option v-for="node in networkEndpointNodes" :key="node.id" :label="`${node.name} · ${node.type}`" :value="node.id" /></el-select></label>
      <label class="network-route-dialog-field"><span>终点</span><el-select v-model="networkArrivalNodeId" filterable><el-option v-for="node in networkEndpointNodes" :key="node.id" :label="`${node.name} · ${node.type}`" :value="node.id" :disabled="node.id === networkDepartureNodeId" /></el-select></label>
      <template #footer><el-button @click="networkDialogOpen = false">取消</el-button><el-button type="primary" @click="createNetworkSegment">创建航段</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.logistics-route-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0,1fr) 370px; min-width: 0; min-height: 0; background: #dce3de; }.logistics-route-canvas { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.route-map-toolbar { position: absolute; z-index: 3; top: 12px; left: 12px; display: flex; max-width: calc(100% - 24px); overflow-x: auto; gap: 3px; border: 1px solid rgba(29,69,55,.18); border-radius: 4px; padding: 4px; background: rgba(255,255,255,.94); box-shadow: 0 3px 12px rgba(25,58,47,.12); }.route-map-toolbar button { display: grid; width: 32px; height: 32px; flex: 0 0 32px; place-items: center; border: 0; border-radius: 3px; color: #536b62; background: transparent; cursor: pointer; }.route-map-toolbar button:hover,.route-map-toolbar button.active { color: white; background: #216c50; }.route-map-toolbar button:disabled { opacity: .35; cursor: not-allowed; }.route-map-toolbar > span { width: 1px; flex: 0 0 1px; margin: 4px 2px; background: #d5dfda; }
.route-draw-hint { position: absolute; z-index: 3; top: 58px; left: 12px; display: flex; align-items: center; gap: 7px; border-radius: 4px; padding: 7px 8px; color: #245b47; background: rgba(240,248,244,.95); box-shadow: 0 3px 12px rgba(25,58,47,.12); font-size: 11px; }.route-draw-hint button { display: grid; width: 23px; height: 23px; place-items: center; border: 0; border-radius: 3px; color: white; background: #267052; cursor: pointer; }
.route-tool-status { position: absolute; z-index: 4; top: 58px; left: 12px; display: flex; align-items: center; gap: 8px; border: 1px solid rgba(29,69,55,.16); border-radius: 4px; padding: 6px 7px 6px 9px; color: #245b47; background: rgba(240,248,244,.96); box-shadow: 0 3px 12px rgba(25,58,47,.12); font-size: 11px; }.route-tool-status button { display: grid; width: 23px; height: 23px; place-items: center; border: 0; border-radius: 3px; color: white; background: #267052; cursor: pointer; }
.route-map-tool-panel { position: absolute; z-index: 4; right: 12px; bottom: 64px; display: grid; width: min(310px, calc(100% - 24px)); gap: 9px; border: 1px solid rgba(29,69,55,.22); border-radius: 4px; padding: 10px; color: #263e35; background: rgba(250,252,251,.97); box-shadow: 0 8px 24px rgba(25,58,47,.18); }.route-map-tool-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.route-map-tool-panel > header > div { display: grid; gap: 2px; }.route-map-tool-panel header span { color: #267052; font-size: 11px; font-weight: 800; }.route-map-tool-panel header strong { font-size: 10px; }.route-map-tool-panel header button { display: grid; width: 26px; height: 26px; place-items: center; border: 0; color: #60746b; background: transparent; cursor: pointer; }.route-map-tool-panel header button:disabled { opacity: .35; cursor: not-allowed; }.route-map-tool-panel dl { display: grid; gap: 5px; margin: 0; }.route-map-tool-panel dl > div { display: grid; grid-template-columns: 54px minmax(0,1fr); gap: 7px; font-size: 11px; }.route-map-tool-panel dt { color: #778981; }.route-map-tool-panel dd { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.route-map-tool-panel > p { display: flex; align-items: baseline; justify-content: space-between; margin: 0; border-left: 3px solid #216c50; padding: 6px 8px; background: #edf5f1; }.route-map-tool-panel > p b { color: #1d6f52; font-size: 18px; }.route-map-tool-panel > p strong { color: #536b62; font-size: 12px; }
.route-map-caption { position: absolute; z-index: 3; left: 12px; bottom: 12px; display: grid; grid-template-columns: 8px minmax(0,1fr); align-items: center; gap: 8px; border-radius: 4px; padding: 9px 11px; color: white; background: rgba(21,55,44,.88); }.route-map-caption > i { width: 8px; height: 30px; border-radius: 2px; background: #247457; }.route-map-caption > i.return { background: #4b83aa; }.route-map-caption > div { display: grid; gap: 2px; }.route-map-caption strong { font-size: 10px; }.route-map-caption small { color: rgba(255,255,255,.68); font-size: 11px; }
.logistics-route-inspector { min-width: 0; min-height: 0; overflow: auto; border-left: 1px solid #ccd7d2; background: #f8faf9; }.logistics-route-inspector > header { display: grid; grid-template-columns: minmax(0,1fr) auto auto; align-items: center; gap: 8px; min-height: 64px; border-bottom: 1px solid #d9e1dd; padding: 10px 14px; background: white; }.logistics-route-inspector > header > div { display: grid; gap: 2px; min-width: 0; }.logistics-route-inspector > header span { color: #267052; font-size: 11px; font-weight: 700; }.logistics-route-inspector > header strong { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }.logistics-route-inspector > header em { border-radius: 3px; padding: 4px 6px; color: #527066; background: #e7efeb; font-size: 11px; font-style: normal; }.logistics-route-inspector > header em.pending { color: #84631e; background: #f5efdc; }.logistics-route-inspector > header em.error { color: #9a433c; background: #f7e8e6; }.logistics-route-inspector > header p { margin: 0; color: #74867f; font-size: 11px; }.logistics-route-inspector > header p b { color: #1d6f52; font-size: 16px; }
.route-workspace-tabs { display: grid; grid-template-columns: repeat(3,1fr); border-bottom: 1px solid #d8e0dc; background: white; }.route-workspace-tabs button { position: relative; min-height: 38px; border: 0; border-right: 1px solid #e1e7e4; color: #687c74; background: white; font-size: 11px; cursor: pointer; }.route-workspace-tabs button:last-child { border-right: 0; }.route-workspace-tabs button.active { box-shadow: inset 0 -3px #247253; color: #1c684c; background: #f2f7f5; }.route-workspace-tabs i { display: inline-grid; min-width: 15px; height: 15px; place-items: center; margin-left: 3px; border-radius: 7px; color: white; background: #8a9993; font-size: 11px; font-style: normal; }
.delivery-route-matrix,.route-list-panel,.route-property-panel,.route-spatial-panel,.waypoint-panel,.waypoint-editor,.route-check-overview,.route-check-categories,.route-evidence-list,.route-problem-location,.route-validation-result,.route-version-list,.route-version-comparison { border-bottom: 1px solid #d8e0dc; padding: 12px 14px; }.delivery-route-matrix > header,.route-list-panel > header,.route-property-panel > header,.route-spatial-panel > header,.waypoint-panel > header,.waypoint-editor > header,.route-check-overview > header,.route-check-categories > header,.route-problem-location > header,.route-validation-result > header,.route-version-list > header,.route-version-comparison > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }.delivery-route-matrix header strong,.route-list-panel header strong,.route-property-panel header strong,.route-spatial-panel header strong,.waypoint-panel header strong,.waypoint-editor header strong,.route-check-overview header strong,.route-check-categories header strong,.route-problem-location header strong,.route-validation-result header strong,.route-version-list header strong,.route-version-comparison header strong { font-size: 10px; }.delivery-route-matrix header small,.route-property-panel header small,.route-spatial-panel header small,.waypoint-panel header small,.route-check-categories header small,.route-version-list header small,.route-version-comparison header small { color: #74867f; font-size: 11px; }
.route-spatial-panel > header > div { display: grid; gap: 2px; }.route-spatial-panel > header span { color: #267052; font-size: 11px; font-weight: 800; }.route-spatial-kpis { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); border: 1px solid #dce4e0; background: white; }.route-spatial-kpis > span { display: grid; gap: 2px; border-right: 1px solid #e2e8e5; padding: 7px; }.route-spatial-kpis > span:last-child { border-right: 0; }.route-spatial-kpis b { font-size: 14px; }.route-spatial-kpis small { color: #798a82; font-size: 11px; }.route-spatial-panel > button { display: grid; width: 100%; grid-template-columns: 24px minmax(0,1fr) auto; align-items: center; gap: 7px; border: 0; border-top: 1px solid #e1e7e4; padding: 8px 1px; color: #416357; text-align: left; background: transparent; cursor: pointer; }.route-spatial-panel > button > i { color: #70827a; font-size: 11px; font-style: normal; font-weight: 700; }.route-spatial-panel > button > span { display: grid; min-width: 0; gap: 2px; }.route-spatial-panel > button strong { font-size: 11px; }.route-spatial-panel > button small { color: #71847c; font-size: 11px; line-height: 1.45; }.route-spatial-panel > button em { border-radius: 3px; padding: 3px 5px; color: #1f6f50; background: #e2f1e9; font-size: 11px; font-style: normal; white-space: nowrap; }.route-spatial-panel > button.risk em { color: #856320; background: #f6efdc; }.route-spatial-panel > button.conflict em { color: #984139; background: #f5e6e3; }.route-spatial-empty { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 58px; color: #39735c; font-size: 11px; }
.route-list-panel > button,.waypoint-panel > button { display: grid; width: 100%; border: 0; border-top: 1px solid #e1e7e4; text-align: left; background: transparent; cursor: pointer; }.delivery-route-row { display: grid; grid-template-columns: 39px minmax(0,1fr) auto 16px; align-items: center; gap: 7px; min-height: 52px; border-top: 1px solid #e1e7e4; }.delivery-route-row > i { color: #70827a; font-size: 11px; font-style: normal; font-weight: 700; }.delivery-route-row > span,.route-list-select > span,.waypoint-panel > button > span { display: grid; gap: 2px; min-width: 0; }.delivery-route-row strong,.route-list-panel button strong,.waypoint-panel button strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.delivery-route-row small,.route-list-panel button small,.waypoint-panel button small { color: #81918b; font-size: 11px; }.delivery-route-row.complete { color: #1e6a4c; }.delivery-route-row > .el-icon { color: #879790; }.delivery-route-row.complete > .el-icon { color: #247253; }.route-direction-actions { display: grid; grid-template-columns: repeat(2,28px); gap: 3px; }.route-direction-actions button { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid #d5dfda; border-radius: 3px; color: #536b62; background: #fff; cursor: pointer; }.route-direction-actions button:hover { border-color: #216c50; color: #fff; background: #216c50; }.route-direction-actions button:disabled { opacity: .35; cursor: not-allowed; }.route-direction-actions button:disabled:hover { border-color: #d5dfda; color: #536b62; background: #fff; }
.route-select-row { display: flex; align-items: center; gap: 5px; border-top: 1px solid #e1e7e4; padding-top: 8px; }.route-select-row .el-select { min-width: 0; flex: 1; }
.delivery-dialog-list { display: grid; gap: 8px; }.delivery-dialog-list article { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid #e1e7e4; padding: 8px 0; }.delivery-dialog-list article > span { display: grid; gap: 3px; }.delivery-dialog-list strong { font-size: 12px; }.delivery-dialog-list small { color: #73867e; font-size: 10px; }.delivery-dialog-list p { color: #71837c; font-size: 11px; }
.route-list-panel > header button { display: flex; align-items: center; gap: 4px; border: 0; color: #267052; background: transparent; font-size: 11px; cursor: pointer; }.route-list-header-actions { display: flex; align-items: center; gap: 8px; }.route-list-item { display: grid; grid-template-columns: minmax(0,1fr) 30px; align-items: center; border-top: 1px solid #e1e7e4; }.route-list-item.active { background: #edf5f1; }.route-list-select { display: grid; width: 100%; min-height: 47px; grid-template-columns: 5px minmax(0,1fr) auto; align-items: center; gap: 8px; border: 0; padding: 5px 3px; text-align: left; background: transparent; cursor: pointer; }.route-list-select > i { width: 4px; height: 30px; border-radius: 1px; background: #247457; }.route-list-select > i.return { background: #3679a8; }.route-list-item.alternate .route-list-select > i { background: #bd7f27; }.route-list-select b { color: #63776f; font-size: 11px; }.route-list-delete { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 3px; color: #9a433c; background: transparent; cursor: pointer; }.route-list-delete:hover,.route-list-delete:focus-visible { color: #fff; background: #a8463e; }
.network-route-dialog-hint { margin: 0 0 14px; color: #657970; font-size: 12px; line-height: 1.6; }.network-route-dialog-field { display: grid; gap: 5px; margin-top: 12px; color: #536b62; font-size: 12px; }.network-route-dialog-field :deep(.el-select) { width: 100%; }
.route-empty,.route-check-empty { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 64px; color: #74867f; font-size: 11px; }
.logistics-route-inspector .route-empty > .el-icon,.logistics-route-inspector .route-check-empty > .el-icon,.logistics-route-inspector .route-spatial-empty > .el-icon { width: 14px; height: 14px; font-size: 14px; flex: 0 0 14px; }
.route-property-panel > label,.waypoint-editor > label { display: grid; gap: 4px; margin-top: 8px; }.route-property-panel label > span,.waypoint-editor label > span { color: #6f817a; font-size: 11px; }.route-property-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }.route-property-grid label { display: grid; gap: 4px; margin-top: 8px; }.route-property-grid span { color: #6f817a; font-size: 11px; }.route-property-panel :deep(.el-input-number),.waypoint-editor :deep(.el-input-number),.route-property-panel :deep(.el-select) { width: 100%; }
.waypoint-panel > button { grid-template-columns: 25px minmax(0,1fr) 16px; align-items: center; gap: 7px; min-height: 42px; padding: 4px 3px; }.waypoint-panel > button.active { box-shadow: inset 3px 0 #267052; background: #edf5f1; }.waypoint-panel > button > i { color: #687b73; font-size: 11px; font-style: normal; font-weight: 700; }.waypoint-panel > button.locked .el-icon { color: #465d54; }
.waypoint-editor > header button { display: grid; width: 24px; height: 24px; place-items: center; border: 0; color: #9a433c; background: transparent; cursor: pointer; }
.route-check-overview > header em,.route-validation-result > header em { border-radius: 3px; padding: 3px 6px; color: #9a433c; background: #f7e8e6; font-size: 11px; font-style: normal; }.route-validation-result > header > div { display: grid; gap: 2px; }.route-validation-result > header > div small { color: #6e8179; font-size: 11px; }.route-check-overview > header em.passed,.route-validation-result > header em.passed { color: #1e6a4c; background: #e3f1e9; }.route-check-overview > div,.validation-kpis { display: grid; grid-template-columns: repeat(3,1fr); border: 1px solid #dfe6e2; background: white; }.route-check-overview > div span,.validation-kpis span { display: grid; gap: 2px; min-height: 52px; align-content: center; border-right: 1px solid #dfe6e2; padding: 7px; }.route-check-overview > div span:last-child,.validation-kpis span:last-child { border-right: 0; }.route-check-overview b,.validation-kpis b { font-size: 15px; }.route-check-overview small,.validation-kpis small { color: #7a8c84; font-size: 11px; }
.route-check-categories > div { display: grid; border-top: 1px solid #e1e7e4; }.route-check-categories article { display: grid; grid-template-columns: 17px minmax(0,1fr) auto; align-items: center; gap: 7px; min-height: 34px; border-bottom: 1px solid #e1e7e4; color: #75877f; }.route-check-categories article.passed { color: #247253; }.route-check-categories article.blocked { color: #9a433c; }.route-check-categories article strong { font-size: 11px; }.route-check-categories article small { color: inherit; font-size: 11px; }
.route-evidence-list > button { display: grid; grid-template-columns: 17px minmax(0,1fr); gap: 7px; width: 100%; border: 0; border-top: 1px solid #e1e7e4; padding: 8px 0; color: #785f22; text-align: left; background: transparent; cursor: pointer; }.route-evidence-list > button.active { box-shadow: inset 3px 0 #267052; padding-left: 8px; background: #edf5f1; }.route-evidence-list > button.conflict { color: #9a433c; }.route-evidence-list > button.info { color: #4f7065; }.route-evidence-list button span { display: grid; gap: 2px; }.route-evidence-list strong { font-size: 11px; }.route-evidence-list small { color: #596d65; font-size: 11px; line-height: 1.45; }
.route-problem-location { background: #f2f6f4; }.route-problem-location > header > div { display: grid; gap: 2px; }.route-problem-location > header span { color: #267052; font-size: 11px; font-weight: 800; }.route-problem-location > header em { border-radius: 3px; padding: 3px 6px; color: #4f7065; background: #e3ece8; font-size: 11px; font-style: normal; }.route-problem-location > header em.conflict { color: #984139; background: #f5e6e3; }.route-problem-location > header em.risk { color: #7f611e; background: #f5eedb; }.route-problem-location > p { margin: 0 0 8px; color: #435c51; font-size: 11px; line-height: 1.5; }.route-problem-location dl { display: grid; margin: 0; border-top: 1px solid #dce4e0; }.route-problem-location dl > div { display: grid; grid-template-columns: 68px minmax(0,1fr); gap: 8px; border-bottom: 1px solid #dce4e0; padding: 7px 0; font-size: 11px; }.route-problem-location dt { color: #75877f; }.route-problem-location dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }.route-problem-location code { font-family: Consolas,monospace; font-size: 11px; }.problem-runtime-data { margin-top: 10px; }.problem-runtime-data > header { display: flex; justify-content: space-between; margin-bottom: 6px; }.problem-runtime-data > header strong { font-size: 11px; }.problem-runtime-data > header small { color: #75877f; font-size: 11px; }.problem-runtime-data > div { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); border: 1px solid #dce4e0; background: white; }.problem-runtime-data span { display: grid; min-width: 0; gap: 2px; border-right: 1px solid #e2e8e5; border-bottom: 1px solid #e2e8e5; padding: 7px; }.problem-runtime-data span:nth-child(2n) { border-right: 0; }.problem-runtime-data small { color: #798a82; font-size: 11px; }.problem-runtime-data b { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.problem-runtime-data > p { margin: 0; color: #798a82; font-size: 11px; }.route-problem-location > footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 9px; color: #6e8179; font-size: 11px; }
.route-validation-result > header em.with_risk { color: #856320; background: #f6efdc; }.round-trip-metric { display: grid; min-width: 0; gap: 8px; border-top: 1px solid #e1e7e4; padding: 10px 1px; }.round-trip-metric > header { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 8px; }.round-trip-metric > header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.round-trip-metric > header small { flex: 0 0 auto; }.round-trip-metric strong { font-size: 11px; }.round-trip-metric small { color: #6e8179; font-size: 11px; }.round-trip-metric ol { display: grid; min-width: 0; margin: 0; padding: 0; list-style: none; }.round-trip-metric li { display: grid; min-width: 0; grid-template-columns: 20px minmax(0,1fr) 52px; align-items: center; gap: 7px; min-height: 36px; border-top: 1px solid #e4e9e6; }.round-trip-metric li > i { display: grid; width: 18px; height: 18px; place-items: center; border: 1px solid #9bb7aa; border-radius: 50%; color: #216c50; font-size: 11px; font-style: normal; font-weight: 800; }.round-trip-metric li > span { display: grid; gap: 2px; min-width: 0; }.round-trip-metric li > span small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.round-trip-metric li > em { display: grid; min-width: 0; gap: 2px; color: #315e4c; text-align: right; font-size: 11px; font-style: normal; font-weight: 700; }.round-trip-metric li > em small { font-weight: 400; }
.route-version-list article { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 7px; border-top: 1px solid #e1e7e4; padding: 9px 1px; }.route-version-list article > div:first-child { display: grid; grid-template-columns: 27px minmax(0,1fr); gap: 2px 6px; min-width: 0; }.route-version-list article span { grid-row: 1 / 5; color: #267052; font-size: 11px; font-weight: 700; }.route-version-list article strong { font-size: 11px; }.route-version-list article small { min-width: 0; color: #81918b; font-size: 11px; overflow-wrap: anywhere; }.route-version-list article > em { justify-self: end; border-radius: 3px; padding: 3px 5px; color: #6c7e77; background: #e9efec; font-size: 11px; font-style: normal; }.route-version-list article > em.submitted { color: #1f6f50; background: #e2f1e9; }.version-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 5px; }.version-actions button { display: flex; align-items: center; gap: 3px; border: 1px solid #d2ddd7; border-radius: 3px; padding: 4px 6px; color: #526d62; background: white; font-size: 11px; cursor: pointer; }.version-actions button.selected { border-color: #247253; color: white; background: #247253; }
.route-version-comparison { background: #f2f6f4; }.route-version-comparison > header > div { display: grid; gap: 2px; }.route-version-comparison > header span { color: #267052; font-size: 11px; font-weight: 800; }.version-delta-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); border: 1px solid #dce4e0; background: white; }.version-delta-grid span { display: grid; min-width: 0; gap: 2px; border-right: 1px solid #e2e8e5; border-bottom: 1px solid #e2e8e5; padding: 7px; }.version-delta-grid span:nth-child(4n) { border-right: 0; }.version-delta-grid small { color: #798a82; font-size: 11px; }.version-delta-grid b { font-size: 11px; }.version-delta-grid b.improved { color: #1d6f52; }.version-delta-grid b.worsened { color: #9a433c; }.route-version-comparison dl { display: grid; margin: 9px 0 0; border-top: 1px solid #dce4e0; }.route-version-comparison dl > div { display: grid; grid-template-columns: 64px minmax(0,1fr); gap: 8px; border-bottom: 1px solid #dce4e0; padding: 6px 0; font-size: 11px; }.route-version-comparison dt { color: #75877f; }.route-version-comparison dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }.route-version-comparison > p,.route-version-compare-hint { margin: 9px 0 0; color: #657970; font-size: 11px; line-height: 1.55; }.route-version-compare-hint { border-bottom: 1px solid #d8e0dc; padding: 12px 14px; }
.route-submit-actions { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: flex-end; gap: 6px; border-top: 1px solid #d0dad5; padding: 10px 12px; background: rgba(255,255,255,.97); }.formal-package-summary { display: grid; min-width: 0; gap: 2px; margin-right: auto; }.formal-package-summary strong { color: #205f47; font-size: 11px; }.formal-package-summary span { overflow: hidden; color: #71847c; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.route-submit-actions.read-only { justify-content: center; color: #2a7055; font-size: 11px; }.route-submit-actions.read-only span { display: flex; align-items: center; gap: 5px; }
@media (max-width: 1120px) { .logistics-route-workspace { grid-template-columns: minmax(0,1fr) 330px; }.route-property-grid { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .logistics-route-workspace { width: 100%; max-width: 100%; grid-column: 1; grid-row: 3 / 5; grid-template-columns: minmax(0,1fr); grid-template-rows: min(440px,52vh) auto; overflow-x: hidden; }.logistics-route-inspector { width: 100%; max-width: 100%; overflow: visible; overflow-x: hidden; border-top: 1px solid #ccd7d2; border-left: 0; }.logistics-route-inspector > * { min-width: 0; max-width: 100%; }.route-property-grid { grid-template-columns: 1fr 1fr; }.round-trip-metric > header { align-items: flex-start; }.round-trip-metric > header small { max-width: 45%; text-align: right; white-space: normal; }.version-delta-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.version-delta-grid span:nth-child(2n) { border-right: 0; }.route-submit-actions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); padding-inline: 8px; }.formal-package-summary { grid-column: 1 / -1; width: 100%; margin: 0; }.formal-package-summary span { white-space: normal; }.route-submit-actions :deep(.el-button) { width: 100%; min-width: 0; margin: 0; padding-inline: 5px; } }
.route-load-panel { grid-column: 1 / -1; display: grid; place-items: center; align-content: center; gap: 9px; min-height: 320px; padding: 32px; color: #71847c; text-align: center; background: #eef3f0; }
.route-load-panel .el-icon { color: #a14b3f; font-size: 28px; }
.route-load-panel strong { color: #8b3f35; font-size: 13px; }
.route-load-panel span { max-width: 48ch; font-size: 11px; line-height: 1.6; }
.route-load-panel button { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #247253; border-radius: 3px; padding: 7px 10px; color: white; background: #247253; font-size: 11px; cursor: pointer; }
.route-load-panel button:disabled { cursor: not-allowed; opacity: .48; }
.route-load-error { margin: 0 12px; border-left: 3px solid #a14b3f; padding: 7px 10px; color: #8b3f35; background: #fff1ef; font-size: 11px; line-height: 1.5; }

/* Workspace panes stack before the shell leaves the map a sliver of width. */
@media (max-width: 1080px) {
  .logistics-route-workspace { grid-column: 2 / 4; grid-row: 2 / 4; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(360px, 52vh) auto; overflow: auto; }
  .logistics-route-inspector { border-top: 1px solid #ccd7d2; border-left: 0; overflow: visible; }
  .route-map-tool-panel { bottom: 58px; }
  .route-submit-actions { position: sticky; bottom: 0; }
}
@media (max-width: 760px) {
  .logistics-route-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-rows: minmax(320px, 54vh) auto; }
  .route-map-toolbar { left: 8px; max-width: calc(100% - 16px); }
  .route-map-caption { right: 8px; bottom: 8px; left: 8px; max-width: none; }
  .route-property-grid { grid-template-columns: 1fr; }
  .route-workspace-tabs { grid-template-columns: repeat(3, minmax(86px, 1fr)); overflow-x: auto; }
  .route-submit-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 420px) {
  .logistics-route-workspace { grid-template-rows: 300px auto; }
  .route-map-tool-panel { right: 8px; bottom: 52px; width: calc(100% - 16px); }
  .route-workspace-tabs { grid-template-columns: repeat(3, minmax(76px, 1fr)); }
  .route-submit-actions { grid-template-columns: 1fr; }
  .formal-package-summary { grid-column: 1; }
}

</style>
