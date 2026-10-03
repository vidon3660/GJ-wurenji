<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { ArrowLeft, ArrowRight, Check, CircleCheck, Close, Delete, EditPen, MapLocation, Plus, RefreshRight, Right, Sort, UploadFilled, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  StudentProjectStageView,
  StudentProjectView,
  V3Coordinate,
  V3RegionCatalogItem,
  V3RegionLayerCode,
  VtlAircraftAssignmentView,
  VtlFlightPhase,
  VtlPlanningWorkspaceView,
  VtlRouteWaypointInput,
  VtlTerrainProfileSample,
  VtlTaskObjectView,
  VtlTaskZoneView
} from "@wurenji/shared"
import { api } from "../api"
import type { V3MapDataState } from "../map-loading-state"
import { distributeVtlTasksToGroup, moveVtlTaskInSequence, synchronizeVtlTaskZoneGroups, vtlGroupAllocationSummaries } from "../vtl-group-allocation"
import { canResumeReturnedVtlRoute } from "../vtl-stage-presentation"
import { projectVtlPlanPreview, vtlPlanPreviewDurationMs, vtlPlanPreviewMarkers } from "../vtl-plan-preview"
import { updateVtlWaypointPosition } from "../vtl-route-editing"
import { formatLandingSiteStatus, formatScaleTemplateCode, formatVtlGroupCode, formatVtlTaskType } from "../terminology"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"
import V3RuntimePlaybackBar from "./V3RuntimePlaybackBar.vue"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
  region: V3RegionCatalogItem
  mainLandingSiteId: string
  visibleLayers: readonly V3RegionLayerCode[]
  mapMode: "2d" | "3d"
}>()

const emit = defineEmits<{
  refreshProject: []
  resumeStage: []
  dataState: [state: V3MapDataState]
  toggleLayer: [code: V3RegionLayerCode]
  dirtyChange: [dirty: boolean]
}>()

const loading = ref(false)
const loadError = ref("")
const workspace = ref<VtlPlanningWorkspaceView | null>(null)
const selectedAircraftId = ref("")
const selectedTaskId = ref("")
const selectedMapFeatureId = ref("")
const selectedGroupId = ref("")
const batchTaskIds = ref<string[]>([])
const taskZones = ref<VtlTaskZoneView[]>([])
const zoneBoundary = ref<V3Coordinate[]>([])
const zoneGroupId = ref("")
const zoneDrawMode = ref(false)
const routeWaypoints = ref<VtlRouteWaypointInput[]>([])
const routeTransitionHeight = ref(0)
const routeAlternateSiteId = ref("")
const takeoffOrder = ref<string[]>([])
const landingOrder = ref<string[]>([])
const previewTimeMs = ref(0)
const previewPlaying = ref(false)
const previewRate = ref(20)
const draftDirty = ref(false)
let previewTimer: number | null = null
let workspaceRequest = 0
let workspaceAbortController: AbortController | undefined
let disposed = false

const isStudent = computed(() => props.user.role === "student")
const plan = computed(() => workspace.value?.plan ?? null)
const assignments = computed(() => plan.value?.allocation.assignments ?? [])
const selectedAssignment = computed(() => assignments.value.find((item) => item.aircraftId === selectedAircraftId.value) ?? null)
const selectedRoute = computed(() => plan.value?.routes.find((item) => item.aircraftId === selectedAircraftId.value) ?? null)
const alternateComparison = computed(() => selectedRoute.value?.alternateComparison ?? null)
const alternateLandingSite = computed(() => plan.value?.landingSites.find((site) => site.id === selectedRoute.value?.alternateLandingSiteId) ?? null)
const terrainProfile = computed(() => selectedRoute.value?.terrainProfile ?? [])
const energySegments = computed(() => selectedRoute.value?.energySegments ?? [])
const profileMaxDistance = computed(() => Math.max(1, terrainProfile.value.at(-1)?.distanceMeters ?? 0))
const profileMaxAltitude = computed(() => Math.max(1, ...terrainProfile.value.flatMap((sample) => [sample.terrainElevationMeters, sample.plannedAltitudeMeters])))
const terrainProfilePoints = computed(() => profilePoints(terrainProfile.value, (sample) => sample.terrainElevationMeters))
const plannedProfilePoints = computed(() => profilePoints(terrainProfile.value, (sample) => sample.plannedAltitudeMeters))
const lowestClearance = computed(() => terrainProfile.value.length > 0 ? Math.min(...terrainProfile.value.map((sample) => sample.clearanceMeters)) : null)
const terrainProfileRisk = computed(() => lowestClearance.value !== null && lowestClearance.value < 30)
const activeAssignments = computed(() => assignments.value.filter((item) => item.available && item.taskObjectIds.length > 0))
const selectedTask = computed(() => plan.value?.taskObjects.find((item) => item.id === selectedTaskId.value) ?? null)
const mapElements = computed(() => props.region.layers
  .filter((layer) => layer.state !== "UNAVAILABLE")
  .flatMap((layer) => layer.features.map((feature) => ({
    id: `${layer.code}:${feature.id}`,
    label: feature.name || feature.id,
    layer: layer.title,
    code: layer.code
  }))))
const allocationIssues = computed(() => plan.value?.allocation.issues ?? [])
const allCheckIssues = computed(() => [
  ...(plan.value?.checkResult?.singleAircraftIssues ?? []),
  ...(plan.value?.checkResult?.fleetIssues ?? [])
])
const currentPhaseLabel = computed(() => phaseLabel(routeWaypoints.value[0]?.phase ?? "VERTICAL_TAKEOFF"))
const canEdit = computed(() => isStudent.value && Boolean(workspace.value && (workspace.value.canConfirmArea || workspace.value.canEditAllocation || workspace.value.canEditRoutes || workspace.value.canValidate || workspace.value.canSubmitExecutionPlan)))
const canResumeRoutes = computed(() => canResumeReturnedVtlRoute(props.stage, isStudent.value))
const allocationMapEditable = computed(() => props.stage.stageCode === "VTL_TASK_ALLOCATION" && Boolean(workspace.value?.canEditAllocation))
const groupAllocationSummaries = computed(() => vtlGroupAllocationSummaries(plan.value?.allocation.groups ?? [], assignments.value))
const selectedGroupSummary = computed(() => groupAllocationSummaries.value.find((group) => group.groupId === selectedGroupId.value) ?? null)
const unassignedTaskIds = computed(() => (plan.value?.taskObjects ?? []).filter((task) => task.required && !assignments.value.some((assignment) => assignment.taskObjectIds.includes(task.id))).map((task) => task.id))
const previewEnabled = computed(() => props.stage.stageCode === "VTL_PLAN_VALIDATION" && Boolean(plan.value?.routes.length))
const previewDurationMs = computed(() => vtlPlanPreviewDurationMs(plan.value?.routes ?? []))
const previewProjection = computed(() => plan.value && previewEnabled.value ? projectVtlPlanPreview(plan.value, previewTimeMs.value) : null)
const previewMarkers = computed(() => vtlPlanPreviewMarkers(selectedRoute.value, plan.value?.taskObjects ?? []))
const previewSelectedAircraft = computed(() => previewProjection.value?.aircraft.find((aircraft) => aircraft.aircraftId === selectedAircraftId.value) ?? null)
const previewStatusLabel = computed(() => {
  const aircraft = previewSelectedAircraft.value
  const summary = previewProjection.value?.summary
  return `${aircraft ? `${aircraft.aircraftCode} · ${phaseLabel(aircraft.phase)}` : "方案预演"} · ${summary?.completedTaskObjects ?? 0}/${summary?.totalTaskObjects ?? 0} 对象`
})

const phaseLabels: Record<VtlFlightPhase, string> = {
  VERTICAL_TAKEOFF: "垂直起飞",
  CLIMB: "爬升",
  FORWARD_TRANSITION: "前转换",
  FIXED_WING_CRUISE: "固定翼巡航",
  TASK_EXECUTION: "任务执行",
  RETURN: "返航",
  BACK_TRANSITION: "后转换",
  VERTICAL_LANDING: "垂直降落"
}

onMounted(loadWorkspace)
onBeforeUnmount(() => {
  stopPreview()
  disposed = true
  workspaceRequest += 1
  workspaceAbortController?.abort()
})
watch(() => props.project.id, loadWorkspace)
watch(() => props.stage.revision, loadWorkspace)
watch(draftDirty, (value) => emit("dirtyChange", value), { immediate: true })
watch(selectedAircraftId, loadSelectedRoute)
watch(selectedTaskId, () => {
  zoneDrawMode.value = false
  loadSelectedZone()
})
watch(zoneBoundary, () => {
  const zone = taskZones.value.find((item) => item.taskObjectIds.includes(selectedTaskId.value))
  if (zone) zone.boundary = clone(zoneBoundary.value)
}, { deep: true })
watch(() => props.stage.stageCode, loadSelectedRoute)
watch(() => props.stage.stageCode, () => {
  zoneDrawMode.value = false
  resetPreview()
})
watch(() => workspace.value?.plan.revision, resetPreview)

async function loadWorkspace() {
  if (disposed) return
  const requestId = ++workspaceRequest
  workspaceAbortController?.abort()
  const abortController = new AbortController()
  workspaceAbortController = abortController
  loading.value = true
  loadError.value = ""
  try {
    const value = await api<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/planning-workspace`, { signal: abortController.signal })
    if (requestId !== workspaceRequest) return
    applyWorkspace(value)
  } catch (error) {
    if (requestId !== workspaceRequest || (error instanceof DOMException && error.name === "AbortError")) return
    loadError.value = error instanceof Error ? error.message : "垂起巡检规划工作区加载失败"
    ElMessage.error(loadError.value)
  } finally {
    if (requestId === workspaceRequest) loading.value = false
  }
}

function applyWorkspace(value: VtlPlanningWorkspaceView) {
  workspace.value = value
  draftDirty.value = false
  selectedAircraftId.value = selectedAircraftId.value && value.plan.allocation.assignments.some((item) => item.aircraftId === selectedAircraftId.value)
    ? selectedAircraftId.value
    : value.plan.allocation.assignments[0]?.aircraftId ?? ""
  selectedTaskId.value = selectedTaskId.value && value.plan.taskObjects.some((item) => item.id === selectedTaskId.value)
    ? selectedTaskId.value
    : value.plan.taskObjects[0]?.id ?? ""
  taskZones.value = value.plan.allocation.taskZones.length > 0
    ? clone(value.plan.allocation.taskZones)
    : value.plan.taskObjects.map((task) => buildTaskZone(task, value.plan.allocation.assignments.find((assignment) => assignment.taskObjectIds.includes(task.id))?.groupId ?? null))
  selectedGroupId.value = value.plan.allocation.groups.some((group) => group.id === selectedGroupId.value)
    ? selectedGroupId.value
    : value.plan.allocation.groups[0]?.id ?? ""
  batchTaskIds.value = batchTaskIds.value.filter((taskId) => value.plan.taskObjects.some((task) => task.id === taskId))
  const activeIds = value.plan.allocation.assignments.filter((item) => item.available && item.taskObjectIds.length > 0).map((item) => item.aircraftId)
  takeoffOrder.value = normalizeOrder(value.plan.executionPlan?.takeoffOrder ?? activeIds, activeIds)
  landingOrder.value = normalizeOrder(value.plan.executionPlan?.landingOrder ?? [...activeIds].reverse(), activeIds)
  loadSelectedRoute()
  loadSelectedZone()
}

function markDraftDirty() {
  if (!isStudent.value) return
  draftDirty.value = true
}

function normalizeOrder(order: string[], activeIds: string[]) {
  return [...order.filter((id) => activeIds.includes(id)), ...activeIds.filter((id) => !order.includes(id))]
}

function taskPosition(task: VtlTaskObjectView | undefined, fallback: V3Coordinate): V3Coordinate {
  return task?.positions[0] ? { ...task.positions[0] } : { ...fallback }
}

function loadSelectedRoute() {
  const route = selectedRoute.value
  if (route) {
    routeWaypoints.value = clone(route.waypoints)
    routeTransitionHeight.value = route.transitionHeightMeters
    routeAlternateSiteId.value = route.alternateLandingSiteId
    return
  }
  const assignment = selectedAssignment.value
  if (!assignment || !plan.value) {
    routeWaypoints.value = []
    return
  }
  const main = plan.value.landingSites.find((site) => site.id === props.mainLandingSiteId && site.type === "MAIN")
    ?? plan.value.landingSites.find((site) => site.type === "MAIN")
  const fallback = main?.position ?? props.region.center
  const orderedTasks = assignment.taskSequence.map((id) => plan.value?.taskObjects.find((task) => task.id === id)).filter((task): task is VtlTaskObjectView => Boolean(task))
  const first = taskPosition(orderedTasks[0], fallback)
  const last = taskPosition(orderedTasks.at(-1), first)
  const transition = Math.max(plan.value.aircraftParameters.minimumTransitionHeightMeters, 80)
  const taskAltitude = Math.min(plan.value.aircraftParameters.maximumOperatingAltitudeMeters - 10, Math.max(transition + 20, 100))
  const waypoint = (id: string, phase: VtlFlightPhase, position: V3Coordinate, altitudeMeters: number, taskObjectId: string | null = null): VtlRouteWaypointInput => ({
    id,
    sequence: 0,
    phase,
    position: { ...position, altitudeMeters },
    altitudeMeters,
    speedMps: speedForPhase(phase),
    taskObjectId
  })
  const waypoints = [
    waypoint("takeoff", "VERTICAL_TAKEOFF", fallback, 10),
    waypoint("climb", "CLIMB", fallback, transition * 0.5),
    waypoint("forward-transition", "FORWARD_TRANSITION", fallback, transition),
    waypoint("cruise", "FIXED_WING_CRUISE", first, transition),
    ...orderedTasks.map((task, index) => waypoint(`task-${index + 1}`, "TASK_EXECUTION", taskPosition(task, first), taskAltitude, task.id)),
    waypoint("return", "RETURN", last, transition),
    waypoint("back-transition", "BACK_TRANSITION", fallback, transition),
    waypoint("landing", "VERTICAL_LANDING", fallback, 10)
  ].map((item, index) => ({ ...item, sequence: index }))
  routeWaypoints.value = waypoints
  routeTransitionHeight.value = transition
  routeAlternateSiteId.value = plan.value.landingSites.find((site) => site.type === "ALTERNATE" && site.status === "AVAILABLE")?.id ?? ""
}

function speedForPhase(phase: VtlFlightPhase) {
  const parameters = plan.value?.aircraftParameters
  if (!parameters) return 12
  if (phase === "CLIMB") return parameters.climbSpeedMps
  if (phase === "FORWARD_TRANSITION" || phase === "BACK_TRANSITION") return parameters.transitionSpeedMps
  return parameters.cruiseSpeedMps
}

async function request<T>(path: string, options: RequestInit = {}, refresh = false) {
  loading.value = true
  try {
    const value = await api<T>(path, options)
    if (refresh) emit("refreshProject")
    return value
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "操作失败")
    return null
  } finally {
    loading.value = false
  }
}

async function confirmArea() {
  if (!workspace.value) return
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/area/confirm`, { method: "POST", body: JSON.stringify({ expectedRevision: workspace.value.plan.revision }) }, true)
  if (value) applyWorkspace(value)
}

function allocationPayload() {
  const currentPlan = plan.value
  if (!currentPlan) return null
  syncSelectedZoneDraft()
  const groups = currentPlan.allocation.groups.map((group) => ({ ...group, aircraftIds: [...group.aircraftIds], taskObjectIds: [...group.taskObjectIds] }))
  return {
    expectedRevision: currentPlan.revision,
    groups,
    assignments: currentPlan.allocation.assignments.map((assignment) => ({ ...assignment, taskObjectIds: [...assignment.taskObjectIds], taskSequence: [...assignment.taskSequence] })),
    taskZones: taskZones.value.map((zone) => ({ ...zone, boundary: clone(zone.boundary), taskObjectIds: [...zone.taskObjectIds] }))
  }
}

function buildTaskZone(task: VtlTaskObjectView, groupId: string | null): VtlTaskZoneView {
  return {
    id: `zone-${task.id}`,
    title: `${task.code} 任务分区`,
    boundary: taskZoneBoundary(task),
    groupId,
    taskObjectIds: [task.id],
    estimatedWorkSeconds: task.estimatedWorkSeconds
  }
}

function loadSelectedZone() {
  const zone = taskZones.value.find((item) => item.taskObjectIds.includes(selectedTaskId.value))
  zoneBoundary.value = zone ? clone(zone.boundary) : []
  zoneGroupId.value = zone?.groupId ?? ""
}

function syncSelectedZoneDraft() {
  const zone = taskZones.value.find((item) => item.taskObjectIds.includes(selectedTaskId.value))
  if (!zone) return
  zone.boundary = clone(zoneBoundary.value)
  zone.groupId = zoneGroupId.value || null
}

function addZoneVertex() {
  if (!selectedTask.value) return
  const last = zoneBoundary.value.at(-1) ?? taskPosition(selectedTask.value, props.region.center)
  zoneBoundary.value = [...zoneBoundary.value, { longitude: last.longitude + 0.0002, latitude: last.latitude + 0.0002, altitudeMeters: last.altitudeMeters ?? 0 }]
  markDraftDirty()
}

function removeZoneVertex(index: number) {
  if (zoneBoundary.value.length <= 3) return
  zoneBoundary.value = zoneBoundary.value.filter((_, vertexIndex) => vertexIndex !== index)
  markDraftDirty()
}

function resetSelectedZone() {
  if (!selectedTask.value) return
  zoneBoundary.value = taskZoneBoundary(selectedTask.value)
  zoneGroupId.value = assignments.value.find((assignment) => assignment.taskObjectIds.includes(selectedTask.value!.id))?.groupId ?? ""
  markDraftDirty()
}

function updateZoneBoundary(taskId: string, positions: V3Coordinate[]) {
  const zone = taskZones.value.find((item) => item.taskObjectIds.includes(taskId))
  if (!zone) return
  zone.boundary = clone(positions)
  if (taskId === selectedTaskId.value) zoneBoundary.value = clone(positions)
  markDraftDirty()
}

function finishMapZone(taskId: string, positions: V3Coordinate[]) {
  updateZoneBoundary(taskId, positions)
  zoneDrawMode.value = false
  ElMessage.success(`${taskLabel(taskId)} 分区边界已更新`)
}

function taskZoneBoundary(task: VtlTaskObjectView): V3Coordinate[] {
  if (task.positions.length >= 3) return task.positions.map((point) => ({ ...point }))
  const points = task.positions.length > 0 ? task.positions : [props.region.center]
  const longitudes = points.map((point) => point.longitude)
  const latitudes = points.map((point) => point.latitude)
  const longitudeMin = Math.min(...longitudes)
  const longitudeMax = Math.max(...longitudes)
  const latitudeMin = Math.min(...latitudes)
  const latitudeMax = Math.max(...latitudes)
  const longitudeOffset = 0.00045
  const latitudeOffset = 0.00036
  const altitudeMeters = points[0]?.altitudeMeters ?? 0
  return [
    { longitude: longitudeMin - longitudeOffset, latitude: latitudeMin - latitudeOffset, altitudeMeters },
    { longitude: longitudeMax + longitudeOffset, latitude: latitudeMin - latitudeOffset, altitudeMeters },
    { longitude: longitudeMax + longitudeOffset, latitude: latitudeMax + latitudeOffset, altitudeMeters },
    { longitude: longitudeMin - longitudeOffset, latitude: latitudeMax + latitudeOffset, altitudeMeters }
  ]
}

async function saveAllocation(): Promise<boolean> {
  const payload = allocationPayload()
  if (!payload) return false
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/allocation`, { method: "PUT", body: JSON.stringify(payload) })
  if (value) applyWorkspace(value)
  return Boolean(value)
}

async function submitAllocation() {
  if (!workspace.value) return
  if (!await saveAllocation()) return
  const latest = workspace.value
  if (!latest) return
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/allocation/submit`, { method: "POST", body: JSON.stringify({ expectedRevision: latest.plan.revision }) }, true)
  if (value) applyWorkspace(value)
}

function assignSelectedTask(aircraftId: string) {
  if (!plan.value || !selectedTaskId.value || !workspace.value?.canEditAllocation) return
  const taskId = selectedTaskId.value
  const assignments = plan.value.allocation.assignments.map((assignment) => {
    const taskObjectIds = assignment.taskObjectIds.filter((id) => id !== taskId)
    const taskSequence = assignment.taskSequence.filter((id) => id !== taskId)
    if (assignment.aircraftId === aircraftId) {
      taskObjectIds.push(taskId)
      taskSequence.push(taskId)
    }
    return { ...assignment, taskObjectIds, taskSequence, estimatedDurationSeconds: estimatedWorkSeconds(taskObjectIds) }
  })
  plan.value.allocation.assignments = assignments
  plan.value.allocation.issues = []
  plan.value.allocation.groups = plan.value.allocation.groups.map((group) => ({
    ...group,
    taskObjectIds: [...new Set(assignments.filter((item) => item.groupId === group.id).flatMap((item) => item.taskObjectIds))]
  }))
  const zone = taskZones.value.find((item) => item.taskObjectIds.includes(taskId))
  if (zone) {
    zone.groupId = assignments.find((assignment) => assignment.taskObjectIds.includes(taskId))?.groupId ?? null
    loadSelectedZone()
  }
  markDraftDirty()
}

function moveAssignmentTask(assignment: VtlAircraftAssignmentView, taskId: string, offset: number) {
  if (!workspace.value?.canEditAllocation) return
  assignment.taskSequence = moveVtlTaskInSequence(assignment.taskObjectIds, assignment.taskSequence, taskId, offset)
  markDraftDirty()
}

function selectUnassignedTasks() {
  batchTaskIds.value = [...unassignedTaskIds.value]
}

function selectCurrentGroupTasks() {
  batchTaskIds.value = [...new Set(assignments.value.filter((assignment) => assignment.groupId === selectedGroupId.value).flatMap((assignment) => assignment.taskObjectIds))]
}

async function confirmGroupDistribution() {
  if (!plan.value || !workspace.value?.canEditAllocation) return
  try {
    const result = distributeVtlTasksToGroup({
      groupId: selectedGroupId.value,
      taskObjectIds: batchTaskIds.value,
      groups: plan.value.allocation.groups,
      assignments: plan.value.allocation.assignments,
      taskObjects: plan.value.taskObjects
    })
    plan.value.allocation.assignments = result.assignments
    plan.value.allocation.groups = result.groups
    plan.value.allocation.issues = []
    plan.value.allocation.valid = false
    taskZones.value = synchronizeVtlTaskZoneGroups({
      taskZones: taskZones.value,
      assignments: result.assignments,
      groups: result.groups,
      taskObjects: plan.value.taskObjects
    })
    if (result.taskObjectIds.includes(selectedTaskId.value)) {
      loadSelectedZone()
    }
    markDraftDirty()
    const taskCount = result.taskObjectIds.length
    const aircraftCount = result.targetAircraftIds.length
    if (!await saveAllocation()) return
    batchTaskIds.value = []
    ElMessage.success(`已将 ${taskCount} 个任务对象分配至 ${aircraftCount} 架航空器`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "机组批量分配失败")
  }
}

function changeAircraftGroup(assignment: VtlAircraftAssignmentView, groupId: string) {
  if (!plan.value || !workspace.value?.canEditAllocation) return
  assignment.groupId = groupId
  plan.value.allocation.groups = plan.value.allocation.groups.map((group) => ({
    ...group,
    aircraftIds: plan.value!.allocation.assignments.filter((item) => item.groupId === group.id).map((item) => item.aircraftId),
    taskObjectIds: [...new Set(plan.value!.allocation.assignments.filter((item) => item.groupId === group.id).flatMap((item) => item.taskObjectIds))]
  }))
  for (const zone of taskZones.value) {
    const owner = plan.value.allocation.assignments.find((item) => zone.taskObjectIds.some((taskId) => item.taskObjectIds.includes(taskId)))
    if (owner) zone.groupId = owner.groupId
  }
  loadSelectedZone()
  markDraftDirty()
}

async function saveRoute() {
  if (!workspace.value || !selectedAircraftId.value || routeWaypoints.value.length === 0) return
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/routes/${selectedAircraftId.value}`, {
    method: "PUT",
    body: JSON.stringify({ expectedRevision: workspace.value.plan.revision, transitionHeightMeters: routeTransitionHeight.value, alternateLandingSiteId: routeAlternateSiteId.value, waypoints: routeWaypoints.value })
  })
  if (value) applyWorkspace(value)
}

function updateRouteWaypoint(aircraftId: string, waypointId: string, position: Pick<V3Coordinate, "longitude" | "latitude">) {
  if (!workspace.value?.canEditRoutes || aircraftId !== selectedAircraftId.value) return
  routeWaypoints.value = updateVtlWaypointPosition(routeWaypoints.value, waypointId, position)
  markDraftDirty()
}

async function completeRoutes() {
  if (!workspace.value) return
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/routes/complete`, { method: "POST", body: JSON.stringify({ expectedRevision: workspace.value.plan.revision }) }, true)
  if (value) applyWorkspace(value)
}

async function validatePlan() {
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/validate`, { method: "POST" }, true)
  if (value) applyWorkspace(value)
}

async function submitValidation() {
  if (!workspace.value) return
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/validation/submit`, { method: "POST", body: JSON.stringify({ expectedRevision: workspace.value.plan.revision }) }, true)
  if (value) applyWorkspace(value)
}

async function submitExecutionPlan() {
  if (!workspace.value) return
  const value = await request<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/execution-plan/submit`, { method: "POST", body: JSON.stringify({ expectedRevision: workspace.value.plan.revision, takeoffOrder: takeoffOrder.value, landingOrder: landingOrder.value }) }, true)
  if (value) applyWorkspace(value)
}

function moveOrder(kind: "TAKEOFF" | "LANDING", index: number, offset: number) {
  const order = kind === "TAKEOFF" ? takeoffOrder.value : landingOrder.value
  const target = index + offset
  if (target < 0 || target >= order.length) return
  const next = [...order]
  const [item] = next.splice(index, 1)
  if (!item) return
  next.splice(target, 0, item)
  if (kind === "TAKEOFF") takeoffOrder.value = next
  else landingOrder.value = next
  markDraftDirty()
}

function togglePreview() {
  if (previewPlaying.value) stopPreview()
  else startPreview()
}

function startPreview() {
  if (!previewEnabled.value || previewDurationMs.value <= 0) return
  if (previewTimeMs.value >= previewDurationMs.value) previewTimeMs.value = 0
  stopPreview()
  previewPlaying.value = true
  previewTimer = window.setInterval(() => {
    const next = Math.min(previewDurationMs.value, previewTimeMs.value + 100 * previewRate.value)
    previewTimeMs.value = next
    if (next >= previewDurationMs.value) stopPreview()
  }, 100)
}

function stopPreview() {
  previewPlaying.value = false
  if (previewTimer !== null) window.clearInterval(previewTimer)
  previewTimer = null
}

function resetPreview() {
  stopPreview()
  previewTimeMs.value = 0
}

function seekPreview(timeMs: number) {
  stopPreview()
  previewTimeMs.value = Math.max(0, Math.min(previewDurationMs.value, timeMs))
}

function phaseLabel(phase: VtlFlightPhase) { return phaseLabels[phase] }
function taskLabel(id: string) { return plan.value?.taskObjects.find((task) => task.id === id)?.code ?? id }
function aircraftLabel(id: string) { return assignments.value.find((item) => item.aircraftId === id)?.aircraftCode ?? id }
function taskOwnerLabel(id: string) {
  const assignment = assignments.value.find((item) => item.taskObjectIds.includes(id))
  if (!assignment) return "未分配"
  const group = plan.value?.allocation.groups.find((item) => item.id === assignment.groupId)
  return `${formatVtlGroupCode(group?.code ?? assignment.groupId)} / ${assignment.aircraftCode}`
}
function estimatedWorkSeconds(taskIds: readonly string[]) {
  return taskIds.reduce((sum, taskId) => sum + (plan.value?.taskObjects.find((task) => task.id === taskId)?.estimatedWorkSeconds ?? 0), 0)
}
function formatDistance(value: number) { return `${(value / 1000).toFixed(2)} km` }
function formatSeconds(value: number) { return `${Math.round(value / 60)} min` }
function formatEnergy(value: number) { return `${Math.round(value)} Wh` }
function profilePoints(samples: readonly VtlTerrainProfileSample[], read: (sample: VtlTerrainProfileSample) => number) {
  return samples.map((sample) => {
    const x = 12 + (sample.distanceMeters / profileMaxDistance.value) * 336
    const y = 130 - (Math.max(0, read(sample)) / profileMaxAltitude.value) * 108
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(" ")
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
</script>

<template>
  <section class="vtl-planning-workspace" v-loading="loading">
    <header class="vtl-planning-commandbar">
      <div><span>垂起广域巡检</span><strong>垂起广域巡检规划</strong><small>{{ formatScaleTemplateCode(workspace?.scaleTemplateCode) }} · {{ workspace?.plan.taskObjects.length ?? 0 }} 个任务对象 · {{ assignments.length }} 架航空器</small><small v-if="loadError" class="planning-load-error" role="alert">规划数据加载失败：{{ loadError }}，当前内容未清除，请重新加载。</small></div>
      <dl><div><dt>阶段</dt><dd>{{ props.stage.title }}</dd></div><div><dt>方案</dt><dd>R{{ plan?.revision ?? '-' }}</dd></div><div><dt>状态</dt><dd>{{ plan?.checkResult?.passed ? '可执行' : '待完善' }}</dd></div></dl>
      <span v-if="draftDirty" class="unsaved-state"><el-icon><EditPen /></el-icon>未保存修改</span>
      <div class="vtl-command-actions">
        <button v-if="canResumeRoutes" type="button" class="primary" @click="emit('resumeStage')"><el-icon><EditPen /></el-icon>继续修改航线</button>
        <button v-if="props.stage.stageCode === 'VTL_AREA_OBJECTS' && workspace?.canConfirmArea" type="button" class="primary" @click="confirmArea"><el-icon><Check /></el-icon>确认区域</button>
        <button v-if="props.stage.stageCode === 'VTL_TASK_ALLOCATION' && workspace?.canEditAllocation" type="button" @click="saveAllocation"><el-icon><RefreshRight /></el-icon>保存分配</button>
        <button v-if="props.stage.stageCode === 'VTL_TASK_ALLOCATION' && workspace?.canSubmitAllocation" type="button" class="primary" @click="submitAllocation"><el-icon><UploadFilled /></el-icon>提交分区分配</button>
        <button v-if="props.stage.stageCode === 'VTL_ROUTE_PLANNING' && workspace?.canEditRoutes" type="button" @click="saveRoute"><el-icon><EditPen /></el-icon>保存航线</button>
        <button v-if="props.stage.stageCode === 'VTL_ROUTE_PLANNING' && workspace?.canEditRoutes" type="button" class="primary" @click="completeRoutes"><el-icon><Right /></el-icon>完成航线规划</button>
        <button v-if="previewEnabled" type="button" @click="togglePreview"><el-icon><VideoPause v-if="previewPlaying" /><VideoPlay v-else /></el-icon>{{ previewPlaying ? '暂停预演' : '方案预演' }}</button>
        <button v-if="props.stage.stageCode === 'VTL_PLAN_VALIDATION' && workspace?.canValidate" type="button" @click="validatePlan"><el-icon><Check /></el-icon>执行检查</button>
        <button v-if="props.stage.stageCode === 'VTL_PLAN_VALIDATION' && workspace?.canSubmitValidation" type="button" class="primary" @click="submitValidation"><el-icon><UploadFilled /></el-icon>提交检查结果</button>
        <button v-if="props.stage.stageCode === 'VTL_EXECUTION_PLAN' && workspace?.canSubmitExecutionPlan" type="button" class="primary" @click="submitExecutionPlan"><el-icon><UploadFilled /></el-icon>提交执行计划</button>
      </div>
    </header>

    <section v-if="loadError && !workspace" class="vtl-planning-load-error" role="alert">
      <el-icon><Warning /></el-icon>
      <strong>垂起巡检规划暂时无法加载</strong>
      <span>{{ loadError }}</span>
      <button type="button" class="primary" :disabled="loading" @click="loadWorkspace"><el-icon><RefreshRight /></el-icon>重新加载</button>
    </section>

    <main v-if="workspace || !loadError" class="vtl-planning-map" :class="{ 'preview-active': previewEnabled }">
      <V3UnifiedMap :region="region" :visible-layers="visibleLayers" :mode="mapMode" :vtl-plan="plan" :vtl-selected-aircraft-id="selectedAircraftId" :vtl-task-zones="taskZones" :vtl-selected-task-id="selectedTaskId" :selected-map-feature-id="selectedMapFeatureId" :vtl-allocation-editable="allocationMapEditable" :vtl-zone-draw-mode="zoneDrawMode" :vtl-route-editable="props.stage.stageCode === 'VTL_ROUTE_PLANNING' && Boolean(workspace?.canEditRoutes)" :vtl-editing-aircraft-id="selectedAircraftId" :vtl-editing-waypoints="routeWaypoints" :vtl-runtime="previewProjection" @data-state="emit('dataState', $event)" @vtl-task-select="selectedTaskId = $event" @vtl-zone-draw-complete="finishMapZone" @vtl-zone-draw-cancel="zoneDrawMode = false" @vtl-zone-updated="updateZoneBoundary" @vtl-waypoint-updated="updateRouteWaypoint" />
      <V3EnvironmentLayerPanel :region="region" scene-type="VTOL_INSPECTION" :visible-layers="visibleLayers" @toggle-layer="emit('toggleLayer', $event)" />
      <div class="vtl-map-legend"><span><i class="task" />任务对象</span><span><i class="main-site" />主起降点</span><span><i class="alternate" />备降点</span><span><i class="route" />航线</span></div>
      <div class="vtl-map-caption"><MapLocation /> {{ region.title }} · {{ region.heightDatum }} · {{ props.stage.stageCode === 'VTL_ROUTE_PLANNING' && workspace?.canEditRoutes ? '可拖动航点调整航线' : '规划数据与服务端方案版本同步' }}</div>
      <div v-if="previewProjection" class="vtl-preview-state"><span>方案预演</span><strong>{{ previewSelectedAircraft ? `${previewSelectedAircraft.aircraftCode} · ${phaseLabel(previewSelectedAircraft.phase)}` : '总体态势' }}</strong><small>{{ Math.round((previewProjection.summary.taskCompletionRatio ?? 0) * 100) }}% 任务覆盖 · {{ previewProjection.summary.airborneAircraft }}/{{ previewProjection.summary.totalAircraft }} 架空中</small></div>
      <V3RuntimePlaybackBar v-if="previewEnabled" :time-ms="previewTimeMs" :duration-ms="previewDurationMs" :playing="previewPlaying" :live="false" :interactive="true" :toggle-enabled="previewDurationMs > 0" :rate="previewRate" :rate-options="[1, 5, 20, 60]" :rate-editable="true" :markers="previewMarkers" selected-marker-id="" :status-label="previewStatusLabel" mode-label="预演" @toggle="togglePreview" @restart="resetPreview" @seek="seekPreview" @rate-change="previewRate = $event" @marker-select="seekPreview($event.timeMs)" />
    </main>

    <aside v-if="workspace || !loadError" class="vtl-planning-inspector">
      <section class="vtl-panel" v-if="props.stage.stageCode === 'VTL_AREA_OBJECTS'">
        <header><div><strong>区域与任务对象</strong></div><b>{{ plan?.taskObjects.length ?? 0 }}</b></header>
        <p class="muted">先确认任务区域、主起降点和可用备降点，确认后进入任务分配。</p>
        <label class="field-label">巡检对象</label>
        <select v-model="selectedTaskId"><option value="">请选择巡检对象</option><option v-for="task in plan?.taskObjects ?? []" :key="task.id" :value="task.id">{{ task.code }} · {{ task.title }}</option></select>
        <div v-if="selectedTask" class="compact-object-detail"><span><b>{{ formatVtlTaskType(selectedTask.type) }}</b><small>{{ selectedTask.required ? '必做对象' : '选做对象' }} · {{ selectedTask.status }}</small></span><strong>{{ selectedTask.title }}</strong></div>
        <section class="vtl-map-element-list"><header><strong>地图元素</strong><small>{{ mapElements.length }} 项</small></header><select v-model="selectedMapFeatureId"><option value="">选择元素后定位地图</option><option v-for="element in mapElements" :key="element.id" :value="element.id">{{ element.layer }} · {{ element.label }}</option></select><p v-if="selectedMapFeatureId" class="map-element-selected">已定位：{{ mapElements.find((element) => element.id === selectedMapFeatureId)?.label }}</p><p v-if="mapElements.length === 0" class="muted">当前区域暂无基础地图元素。</p></section>
        <div class="vtl-site-list"><div v-for="site in plan?.landingSites ?? []" :key="site.id"><i :class="site.type.toLowerCase()" /><span><strong>{{ site.title }}</strong><small>{{ site.type === 'MAIN' ? '主起降点' : '备降点' }} · {{ site.elevationMeters }} m · {{ formatLandingSiteStatus(site.status) }}</small></span></div></div>
      </section>

      <section class="vtl-panel allocation-panel" v-else-if="props.stage.stageCode === 'VTL_TASK_ALLOCATION'">
        <header><div><span>任务分配</span><strong>分区与航空器分配</strong></div><b>{{ plan?.allocation.valid ? '可提交' : `${allocationIssues.length} 项待处理` }}</b></header>
        <label class="field-label">选择任务对象</label>
        <select v-model="selectedTaskId"><option v-for="task in plan?.taskObjects ?? []" :key="task.id" :value="task.id">{{ task.code }} · {{ task.title }}</option></select>
        <section v-if="selectedTask" class="allocation-object-detail"><header><strong>{{ selectedTask.code }} · {{ selectedTask.title }}</strong><span>{{ formatVtlTaskType(selectedTask.type) }}</span></header><div><span>状态 <b>{{ selectedTask.status }}</b></span><span>要求 <b>{{ selectedTask.required ? '必做' : '选做' }}</b></span><span>工作量 <b>{{ formatSeconds(selectedTask.estimatedWorkSeconds) }}</b></span></div><label>分配航空器<select v-model="selectedAircraftId"><option value="">请选择航空器</option><option v-for="assignment in assignments.filter(item => item.available)" :key="assignment.aircraftId" :value="assignment.aircraftId">{{ assignment.aircraftCode }} · {{ assignment.taskObjectIds.length }} 个对象</option></select></label><button type="button" class="compact-assign-button" :disabled="!selectedAircraftId || !workspace?.canEditAllocation" @click="assignSelectedTask(selectedAircraftId)">分配当前对象</button></section>
        <section v-if="workspace?.scaleTemplateCode === 'VTL_20'" class="group-batch-allocation">
          <header><div><span>批量分配</span><strong>机组批量分配</strong></div><b>{{ batchTaskIds.length }} 个对象</b></header>
          <div class="group-summary-list"><button v-for="group in groupAllocationSummaries" :key="group.groupId" type="button" :class="{ selected: selectedGroupId === group.groupId }" :aria-pressed="selectedGroupId === group.groupId" @click="selectedGroupId = group.groupId"><span><strong>{{ formatVtlGroupCode(group.code) }}</strong><small>{{ group.availableAircraftCount }}/{{ group.aircraftCount }} 架可用</small></span><em>{{ group.taskObjectCount }} 项 · {{ formatSeconds(group.estimatedWorkSeconds) }}</em></button></div>
          <div class="group-batch-tools"><button type="button" :disabled="!workspace?.canEditAllocation || unassignedTaskIds.length === 0" @click="selectUnassignedTasks">选择未分配</button><button type="button" :disabled="!workspace?.canEditAllocation || !selectedGroupId" @click="selectCurrentGroupTasks">选择本组任务</button><button type="button" :disabled="batchTaskIds.length === 0" title="清空批量选择" aria-label="清空批量选择" @click="batchTaskIds = []"><Delete /></button></div>
          <div class="group-task-picker"><label v-for="task in plan?.taskObjects ?? []" :key="task.id" :class="{ selected: batchTaskIds.includes(task.id) }"><input v-model="batchTaskIds" type="checkbox" :value="task.id" :disabled="!workspace?.canEditAllocation" /><span><strong>{{ task.code }}</strong><small>{{ task.title }}</small></span><em>{{ taskOwnerLabel(task.id) }}</em></label></div>
          <div class="group-batch-impact"><span>影响范围</span><strong>{{ batchTaskIds.length }} 个对象 → {{ formatVtlGroupCode(selectedGroupSummary?.code) }} · {{ selectedGroupSummary?.availableAircraftCount ?? 0 }} 架可用航空器</strong><small>确认后替换这些对象的原归属，并按预计工作量重新均衡。</small></div>
          <button type="button" class="group-batch-confirm" :disabled="!workspace?.canEditAllocation || !selectedGroupId || batchTaskIds.length === 0 || (selectedGroupSummary?.availableAircraftCount ?? 0) === 0" @click="confirmGroupDistribution"><Check />确认批量分配</button>
        </section>
        <div v-if="assignments.length" class="allocation-aircraft-list"><article v-for="assignment in assignments" :key="assignment.aircraftId" :class="{ selected: selectedAircraftId === assignment.aircraftId }" role="button" tabindex="0" :aria-pressed="selectedAircraftId === assignment.aircraftId" :aria-label="`${assignment.aircraftCode}，${assignment.taskObjectIds.length} 个对象`" @click="selectedAircraftId = assignment.aircraftId" @keydown.enter.self="selectedAircraftId = assignment.aircraftId" @keydown.space.self.prevent="selectedAircraftId = assignment.aircraftId"><div><strong>{{ assignment.aircraftCode }}</strong><small>{{ assignment.taskObjectIds.length }} 个对象 · {{ formatSeconds(assignment.estimatedDurationSeconds) }}</small></div><select :value="assignment.groupId" :disabled="!workspace?.canEditAllocation" @click.stop @change="changeAircraftGroup(assignment, ($event.target as HTMLSelectElement).value)"><option v-for="group in plan?.allocation.groups ?? []" :key="group.id" :value="group.id">{{ group.code }}</option></select><button type="button" :disabled="!workspace?.canEditAllocation || !selectedTaskId" title="分配当前任务" aria-label="分配当前任务" @click.stop="assignSelectedTask(assignment.aircraftId)"><Plus /></button><p class="assignment-task-sequence"><span v-for="(taskId, taskIndex) in assignment.taskSequence" :key="taskId" class="assignment-task-chip"><b>{{ taskIndex + 1 }} · {{ taskLabel(taskId) }}</b><i v-if="assignment.taskSequence.length > 1" class="task-sequence-actions"><button type="button" :disabled="!workspace?.canEditAllocation || taskIndex === 0" :title="`${taskLabel(taskId)} 前移`" :aria-label="`${taskLabel(taskId)} 前移`" @click.stop="moveAssignmentTask(assignment, taskId, -1)"><ArrowLeft /></button><button type="button" :disabled="!workspace?.canEditAllocation || taskIndex === assignment.taskSequence.length - 1" :title="`${taskLabel(taskId)} 后移`" :aria-label="`${taskLabel(taskId)} 后移`" @click.stop="moveAssignmentTask(assignment, taskId, 1)"><ArrowRight /></button></i></span><em v-if="assignment.taskObjectIds.length === 0">尚未分配</em></p></article></div><div v-else class="planning-empty-state" role="status"><strong>暂无可分配航空器</strong><span>请先确认任务区域和机队资源；资源加载完成后，航空器会显示在这里。</span></div>
        <div class="issue-list"><div v-for="issue in allocationIssues" :key="`${issue.code}-${issue.taskObjectId}-${issue.aircraftId}`"><Warning /><span>{{ issue.message }}</span></div><div v-if="allocationIssues.length === 0" class="passed"><CircleCheck /><span>必做任务对象均已完成唯一分配</span></div></div>
        <div v-if="selectedTask && zoneBoundary.length > 0" class="zone-editor">
          <header><div><span>任务分区</span><strong>{{ selectedTask.code }} 分区边界</strong></div><b>{{ zoneBoundary.length }} 点</b></header>
          <label>所属机组<select v-model="zoneGroupId" @change="markDraftDirty"><option value="">未指定</option><option v-for="group in plan?.allocation.groups ?? []" :key="group.id" :value="group.id">{{ formatVtlGroupCode(group.code) }} · {{ group.title }}</option></select></label>
          <div class="zone-vertex-list"><div v-for="(vertex, index) in zoneBoundary" :key="index"><strong>{{ index + 1 }}</strong><label>经度<input v-model.number="vertex.longitude" type="number" step="0.000001" :disabled="!workspace?.canEditAllocation" @input="markDraftDirty" /></label><label>纬度<input v-model.number="vertex.latitude" type="number" step="0.000001" :disabled="!workspace?.canEditAllocation" @input="markDraftDirty" /></label><button type="button" :disabled="!workspace?.canEditAllocation || zoneBoundary.length <= 3" title="删除边界点" aria-label="删除边界点" @click="removeZoneVertex(index)"><Delete /></button></div></div>
          <div class="zone-editor-actions"><button type="button" :disabled="!workspace?.canEditAllocation" title="增加边界点" @click="addZoneVertex"><Plus />增加点</button><button type="button" :disabled="!workspace?.canEditAllocation" @click="resetSelectedZone">恢复自动分区</button><button type="button" :class="{ active: zoneDrawMode }" :disabled="!workspace?.canEditAllocation" title="在地图上点击添加分区顶点，右键完成" :aria-pressed="zoneDrawMode" @click="zoneDrawMode = !zoneDrawMode"><MapLocation />{{ zoneDrawMode ? '退出绘制' : '地图绘制' }}</button></div>
          <p class="muted">任务对象必须落在所属分区内，分区边界也不能超出巡检区域。</p>
        </div>
      </section>

      <section class="vtl-panel" v-else-if="props.stage.stageCode === 'VTL_ROUTE_PLANNING'">
        <header><div><span>航线与剖面</span><strong>八阶段航线与能量</strong></div><b>{{ assignments.filter((item) => item.taskObjectIds.length > 0).length }} 架</b></header>
        <div v-if="plan?.checkResult && !plan.checkResult.passed" class="route-recheck-notice"><Warning /><span><strong>上次检查未通过</strong><small>请根据检查结果修改航线，保存后重新执行检查。</small></span></div>
        <template v-if="assignments.some(item => item.taskObjectIds.length > 0)"><label class="field-label">编辑航空器</label>
        <select v-model="selectedAircraftId"><option v-for="assignment in assignments.filter(item => item.taskObjectIds.length > 0)" :key="assignment.aircraftId" :value="assignment.aircraftId">{{ assignment.aircraftCode }} · {{ assignment.taskObjectIds.length }} 个对象</option></select></template><div v-else class="planning-empty-state" role="status"><strong>暂无可编辑航线的航空器</strong><span>请先在“分区与航空器分配”阶段为至少一个任务对象分配航空器。</span></div>
         <div class="route-parameters"><label>转换高度<input v-model.number="routeTransitionHeight" type="number" min="1" @input="markDraftDirty" /> m</label><label>备降点<select v-model="routeAlternateSiteId" @change="markDraftDirty"><option v-for="site in plan?.landingSites.filter(item => item.type === 'ALTERNATE' && item.status === 'AVAILABLE') ?? []" :key="site.id" :value="site.id">{{ site.title }}</option></select></label></div>
        <div class="phase-strip"><span v-for="waypoint in routeWaypoints" :key="waypoint.id" :class="waypoint.phase.toLowerCase()"><b>{{ waypoint.sequence + 1 }}</b><small>{{ phaseLabel(waypoint.phase) }}</small></span></div>
         <div class="waypoint-list"><article v-for="waypoint in routeWaypoints" :key="waypoint.id"><header><strong>{{ waypoint.sequence + 1 }} · {{ phaseLabel(waypoint.phase) }}</strong><em>{{ waypoint.taskObjectId ? taskLabel(waypoint.taskObjectId) : '航段控制点' }}</em></header><div><label>经度<input v-model.number="waypoint.position.longitude" type="number" step="0.000001" :disabled="!workspace?.canEditRoutes" @input="markDraftDirty" /></label><label>纬度<input v-model.number="waypoint.position.latitude" type="number" step="0.000001" :disabled="!workspace?.canEditRoutes" @input="markDraftDirty" /></label><label>高度<input v-model.number="waypoint.altitudeMeters" type="number" min="1" :disabled="!workspace?.canEditRoutes" @input="markDraftDirty" /></label></div></article></div>
        <div v-if="selectedRoute" class="route-result"><span>总距离 <strong>{{ formatDistance(selectedRoute.totalDistanceMeters) }}</strong></span><span>预计用时 <strong>{{ formatSeconds(selectedRoute.totalDurationSeconds) }}</strong></span><span>能量 <strong>{{ formatEnergy(selectedRoute.totalEnergyWh) }}</strong></span><span :class="{ danger: terrainProfileRisk }">最低净空 <strong>{{ lowestClearance === null ? '-' : `${Math.round(lowestClearance)} m` }}</strong></span></div>
        <div v-if="selectedRoute" class="route-analytics">
          <section v-if="alternateComparison" class="alternate-comparison-panel">
            <header><div><span>备降方案对比</span><strong>计划返航与备降方案</strong></div><b :class="{ danger: !alternateComparison.feasible }">{{ alternateComparison.feasible ? '余度满足' : '余度不足' }}</b></header>
            <table><thead><tr><th>比较项</th><th>计划返航</th><th>{{ alternateLandingSite?.title ?? '备降方案' }}</th></tr></thead><tbody><tr><td>尾段距离</td><td>{{ formatDistance(alternateComparison.nominalReturnDistanceMeters) }}</td><td>{{ formatDistance(alternateComparison.alternateDistanceMeters) }}</td></tr><tr><td>预计时间</td><td>{{ formatSeconds(alternateComparison.nominalReturnDurationSeconds) }}</td><td>{{ formatSeconds(alternateComparison.alternateDurationSeconds) }}</td></tr><tr><td>尾段能量</td><td>{{ formatEnergy(alternateComparison.nominalReturnEnergyWh) }}</td><td>{{ formatEnergy(alternateComparison.alternateEnergyWh) }}</td></tr><tr><td>到达电量</td><td>{{ formatEnergy(alternateComparison.nominalArrivalEnergyWh) }}</td><td>{{ formatEnergy(alternateComparison.alternateArrivalEnergyWh) }}</td></tr></tbody></table>
            <p :class="{ danger: !alternateComparison.feasible }">备降到达余度 {{ formatEnergy(alternateComparison.reserveMarginWh) }} · 决策点 {{ alternateComparison.diversionWaypointId }}</p>
          </section>
          <section class="terrain-profile-panel">
            <header><div><span>地形剖面</span><strong>地形剖面与规划高度</strong></div><b :class="{ danger: terrainProfileRisk }">{{ lowestClearance === null ? '无高程' : `净空 ${Math.round(lowestClearance)} m` }}</b></header>
            <div v-if="terrainProfile.length > 0" class="terrain-profile-chart">
              <svg viewBox="0 0 360 150" role="img" aria-label="地形剖面和规划高度">
                <line x1="12" y1="130" x2="348" y2="130" />
                <line x1="12" y1="22" x2="12" y2="130" />
                <polyline class="terrain-line" :points="terrainProfilePoints" />
                <polyline class="planned-line" :points="plannedProfilePoints" />
                <circle v-for="(sample, index) in terrainProfile" :key="`${sample.distanceMeters}-${index}`" :class="{ risk: sample.clearanceMeters < 30 }" :cx="12 + (sample.distanceMeters / profileMaxDistance) * 336" :cy="130 - (Math.max(0, sample.terrainElevationMeters) / profileMaxAltitude) * 108" r="2.5" />
              </svg>
              <div class="profile-legend"><span><i class="planned" />规划高度</span><span><i class="terrain" />地形高程</span><span v-if="terrainProfileRisk"><i class="risk" />净空不足</span></div>
              <small>起点 0 km · 终点 {{ formatDistance(profileMaxDistance) }} · 高程基于当前资源版本</small>
            </div>
            <p v-else class="muted">当前航线没有高程剖面，请保存航线后重新计算。</p>
          </section>
          <section class="energy-panel">
            <header><div><span>航段能量</span><strong>航段能量分段</strong></div><b>{{ formatEnergy(selectedRoute.reserveEnergyWh) }} 余度</b></header>
            <div class="energy-table-wrap">
              <table class="energy-table"><thead><tr><th>航段</th><th>距离</th><th>用时</th><th>消耗</th><th>剩余</th></tr></thead><tbody><tr v-for="(segment, index) in energySegments" :key="`${segment.phase}-${index}`" :class="{ danger: segment.remainingEnergyWh < selectedRoute.reserveEnergyWh }"><td>{{ index + 1 }} · {{ phaseLabel(segment.phase) }}</td><td>{{ formatDistance(segment.distanceMeters) }}</td><td>{{ formatSeconds(segment.durationSeconds) }}</td><td>{{ formatEnergy(segment.energyWh) }}</td><td>{{ formatEnergy(segment.remainingEnergyWh) }}</td></tr></tbody></table>
            </div>
          </section>
        </div>
      </section>

      <section class="vtl-panel" v-else-if="props.stage.stageCode === 'VTL_PLAN_VALIDATION'">
        <header><div><span>方案检查</span><strong>单机与多机检查</strong></div><b :class="{ passed: plan?.checkResult?.passed }">{{ plan?.checkResult?.passed ? '通过' : '待检查' }}</b></header>
        <div class="check-kpis"><span><strong>{{ plan?.checkResult?.blockingIssueCount ?? 0 }}</strong><small>必须修改</small></span><span><strong>{{ plan?.checkResult?.warningCount ?? 0 }}</strong><small>风险提示</small></span><span><strong>{{ plan?.routes.length ?? 0 }}</strong><small>已生成航线</small></span></div>
        <div class="check-list"><article v-for="issue in allCheckIssues" :key="issue.id" :class="issue.severity.toLowerCase()"><Warning /><span><strong>{{ issue.category }}</strong><small>{{ issue.message }}</small><em>{{ issue.suggestion }}</em></span></article><div v-if="plan?.checkResult?.passed" class="passed"><CircleCheck /> 单机航线与多机关系检查通过</div><div v-else-if="allCheckIssues.length === 0" class="muted">点击“执行检查”生成检查结果。</div></div>
        <section v-if="previewProjection" class="preview-summary">
          <header><div><span>仿真预演</span><strong>简化仿真态势</strong></div><b>{{ Math.round(previewProjection.summary.taskCompletionRatio * 100) }}%</b></header>
          <label class="field-label">观察航空器<select v-model="selectedAircraftId"><option v-for="aircraft in previewProjection.aircraft" :key="aircraft.aircraftId" :value="aircraft.aircraftId">{{ aircraft.aircraftCode }} · {{ phaseLabel(aircraft.phase) }}</option></select></label>
          <div class="preview-kpis"><span><strong>{{ previewProjection.summary.completedTaskObjects }}/{{ previewProjection.summary.totalTaskObjects }}</strong><small>完成对象</small></span><span><strong>{{ previewProjection.summary.airborneAircraft }}</strong><small>空中航空器</small></span><span><strong>{{ previewSelectedAircraft ? `${Math.round(previewSelectedAircraft.remainingEnergyRatio * 100)}%` : '-' }}</strong><small>所选机剩余能量</small></span></div>
          <div class="preview-phase-list"><span v-for="(count, phase) in previewProjection.summary.phaseDistribution" :key="phase"><small>{{ phaseLabel(phase) }}</small><strong>{{ count }} 架</strong></span></div>
        </section>
      </section>

      <section class="vtl-panel" v-else-if="props.stage.stageCode === 'VTL_EXECUTION_PLAN'">
        <header><div><span>执行计划</span><strong>起降顺序与执行计划</strong></div><b>{{ activeAssignments.length }} 架</b></header>
        <div class="order-panel"><header><strong>起飞顺序</strong><Sort /></header><div v-for="(id, index) in takeoffOrder" :key="id"><b>{{ index + 1 }}</b><span>{{ aircraftLabel(id) }}</span><button type="button" :disabled="index === 0 || !workspace?.canSubmitExecutionPlan" @click="moveOrder('TAKEOFF', index, -1)">上移</button><button type="button" :disabled="index === takeoffOrder.length - 1 || !workspace?.canSubmitExecutionPlan" @click="moveOrder('TAKEOFF', index, 1)">下移</button></div></div>
        <div class="order-panel"><header><strong>降落顺序</strong><Sort /></header><div v-for="(id, index) in landingOrder" :key="id"><b>{{ index + 1 }}</b><span>{{ aircraftLabel(id) }}</span><button type="button" :disabled="index === 0 || !workspace?.canSubmitExecutionPlan" @click="moveOrder('LANDING', index, -1)">上移</button><button type="button" :disabled="index === landingOrder.length - 1 || !workspace?.canSubmitExecutionPlan" @click="moveOrder('LANDING', index, 1)">下移</button></div></div>
        <div class="execution-summary"><span>任务顺序</span><strong>{{ plan?.allocation.assignments.filter(item => item.taskObjectIds.length > 0).reduce((sum, item) => sum + item.taskSequence.length, 0) ?? 0 }} 个任务对象已纳入计划</strong></div>
      </section>

      <section class="vtl-panel vtl-readonly-panel" v-else>
        <header><div><strong>巡检方案摘要</strong></div><b>{{ props.stage.title }}</b></header>
        <div class="summary-grid"><span><strong>{{ plan?.taskObjects.filter(item => item.status === 'COMPLETED').length ?? 0 }}/{{ plan?.taskObjects.length ?? 0 }}</strong><small>任务对象</small></span><span><strong>{{ plan?.routes.length ?? 0 }}</strong><small>航线</small></span><span><strong>{{ plan?.allocation.groups.length ?? 0 }}</strong><small>分组</small></span></div>
        <p class="muted">当前阶段由对应工作台处理。若阶段尚未开放，请先完成上一步提交。</p>
      </section>
    </aside>
  </section>
</template>

<style scoped>
.vtl-planning-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0,1fr) 340px; grid-template-rows: 68px minmax(0,1fr); min-width: 0; min-height: 0; overflow: hidden; color: #20322b; background: #e4e9e6; }
.vtl-planning-commandbar { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(180px,1fr) auto max-content max-content; align-items: center; gap: 12px; border-bottom: 1px solid #cdd9d3; padding: 8px 14px; background: #f7faf8; }
 .vtl-planning-commandbar > div:first-child { display: grid; gap: 2px; min-width: 0; }.vtl-planning-commandbar span,.vtl-planning-commandbar dt,.vtl-panel header span { color: #6f8179; font-size: 11px; letter-spacing: .08em; }.vtl-planning-commandbar strong { font-size: 15px; }.vtl-planning-commandbar small,.muted { color: #72847c; font-size: 11px; }.vtl-planning-commandbar dl { display: flex; gap: 20px; margin: 0; }.vtl-planning-commandbar dl div { display: grid; gap: 2px; }.vtl-planning-commandbar dd { margin: 0; font-size: 10px; font-weight: 700; }.unsaved-state { grid-column: 3; display: inline-flex; align-items: center; gap: 4px; padding: 5px 7px; border: 1px solid #e7c59d; color: #956022!important; background: #fff7eb; font-size: 11px!important; letter-spacing: 0!important; white-space: nowrap; }.unsaved-state svg { width: 11px; height: 11px; }.vtl-command-actions { grid-column: 4; display: flex; min-width: 0; justify-content: flex-end; gap: 6px; }.vtl-command-actions button,.vtl-panel button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid #cbd8d1; border-radius: 3px; padding: 6px 8px; color: #2d6651; background: white; font-size: 11px; cursor: pointer; }.vtl-command-actions button.primary { border-color: #247253; color: white; background: #247253; }.vtl-command-actions button:disabled,.vtl-panel button:disabled { cursor: not-allowed; opacity: .48; }
.vtl-planning-map { position: relative; min-width: 0; min-height: 0; overflow: hidden; }.vtl-planning-map :deep(.v3-region-map) { min-height: 100%; }.vtl-map-legend { position: absolute; left: 12px; bottom: 32px; display: flex; gap: 10px; padding: 6px 8px; border: 1px solid rgba(202,214,208,.9); background: rgba(250,252,251,.94); font-size: 11px; }.vtl-map-legend span { display: flex; align-items: center; gap: 4px; }.vtl-map-legend i { width: 8px; height: 8px; display: inline-block; border-radius: 50%; }.vtl-map-legend .task { background: #b96d2d; }.vtl-map-legend .main-site { background: #1d6f52; }.vtl-map-legend .alternate { background: #8a6a24; }.vtl-map-legend .route { height: 2px; width: 14px; border-radius: 0; background: #2667a6; }.vtl-map-caption { position: absolute; z-index: 4; top: 10px; left: 12px; display: flex; align-items: center; gap: 4px; max-width: calc(100% - 24px); overflow: hidden; padding: 5px 7px; color: #385b4d; background: rgba(250,252,251,.92); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.vtl-map-caption > svg { flex: 0 0 12px; width: 12px; height: 12px; }
.vtl-planning-map.preview-active .vtl-map-legend { bottom: 70px; }.vtl-preview-state { position: absolute; top: 40px; left: 12px; display: grid; gap: 2px; min-width: 170px; border-left: 3px solid #2b7658; padding: 7px 9px; color: #29483d; background: rgba(248,250,249,.94); }.vtl-preview-state span { color: #61786e; font-size: 11px; }.vtl-preview-state strong { font-size: 10px; }.vtl-preview-state small { color: #62776e; font-size: 11px; }
.vtl-planning-inspector { min-width: 0; overflow: auto; border-left: 1px solid #ccd7d2; background: #f4f7f5; }.vtl-panel { display: grid; gap: 10px; padding: 13px; border-bottom: 1px solid #d2ddd7; }.vtl-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }.vtl-panel > header > div { display: grid; gap: 2px; }.vtl-panel > header strong { font-size: 12px; }.vtl-panel > header b { color: #257052; font-size: 10px; }.vtl-panel > header b.passed { color: #1c714f; }.field-label { color: #637970; font-size: 11px; }.vtl-panel select,.vtl-panel input { width: 100%; box-sizing: border-box; border: 1px solid #ccd9d2; border-radius: 3px; padding: 6px; color: #27483c; background: #fff; font: inherit; font-size: 11px; }.vtl-object-list,.vtl-site-list,.allocation-aircraft-list,.waypoint-list,.check-list,.order-panel { display: grid; gap: 5px; }.vtl-object-list button { display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%; text-align: left; }.vtl-object-list button.selected { border-color: #257052; background: #e8f2ec; }.vtl-object-list button span,.allocation-aircraft-list article > div { display: grid; gap: 2px; min-width: 0; }.vtl-object-list small,.allocation-aircraft-list small,.vtl-site-list small,.waypoint-list em,.check-list small,.check-list em { color: #75877f; font-size: 11px; }.vtl-object-list em,.allocation-aircraft-list em { color: #9a6b16; font-size: 11px; font-style: normal; }.vtl-site-list { border-top: 1px solid #dbe4df; padding-top: 8px; }.vtl-site-list > div { display: flex; align-items: center; gap: 7px; }.vtl-site-list i { width: 9px; height: 9px; border-radius: 50%; background: #1d6f52; }.vtl-site-list i.alternate { background: #8a6a24; }.vtl-site-list span { display: grid; gap: 2px; }
.allocation-aircraft-list article { display: grid; grid-template-columns: minmax(0,1fr) 56px 26px; gap: 5px; align-items: center; border: 1px solid #d6e0db; padding: 7px; background: white; cursor: pointer; }.allocation-aircraft-list article.selected { border-color: #287454; }.allocation-aircraft-list article:focus-visible { outline: 2px solid #287454; outline-offset: 2px; }.allocation-aircraft-list article p { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 3px; margin: 0; }.allocation-aircraft-list article p span,.allocation-aircraft-list article p em { border-radius: 2px; padding: 2px 4px; color: #396454; background: #e5f0ea; font-size: 11px; font-style: normal; }.allocation-aircraft-list article p em { color: #8b6a26; background: #f6eed9; }.allocation-aircraft-list select { padding: 4px; font-size: 11px; }.allocation-aircraft-list button { width: 26px; height: 26px; padding: 3px; }.issue-list { display: grid; gap: 5px; }.issue-list > div,.passed { display: flex; align-items: flex-start; gap: 5px; color: #9d443d; font-size: 11px; line-height: 1.4; }.issue-list .passed,.passed { color: #247253; }
.group-batch-allocation { display: grid; gap: 7px; border-top: 1px solid #d6e0db; border-bottom: 1px solid #d6e0db; padding: 9px 0; }.group-batch-allocation > header { display: flex; align-items: flex-start; justify-content: space-between; }.group-batch-allocation > header > div { display: grid; gap: 2px; }.group-batch-allocation > header span { color: #6f8179; font-size: 11px; }.group-batch-allocation > header strong { font-size: 10px; }.group-batch-allocation > header b { color: #267052; font-size: 11px; }.group-summary-list { display: grid; grid-template-columns: repeat(2,1fr); gap: 4px; }.group-summary-list button { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 5px; justify-content: stretch; padding: 6px; text-align: left; }.group-summary-list button.selected { border-color: #267052; color: #1f5f47; background: #e6f0eb; }.group-summary-list button span { display: grid; gap: 2px; }.group-summary-list button strong { font-size: 11px; }.group-summary-list button small,.group-summary-list button em { color: #74877f; font-size: 11px; font-style: normal; }.group-batch-tools { display: grid; grid-template-columns: 1fr 1fr 28px; gap: 4px; }.group-batch-tools button { min-height: 27px; padding: 4px 6px; font-size: 11px; }.group-batch-tools button:last-child { width: 28px; padding: 4px; }.group-task-picker { display: grid; max-height: 168px; overflow: auto; border: 1px solid #d5e0da; background: #fff; }.group-task-picker label { display: grid; grid-template-columns: 14px minmax(0,1fr) auto; gap: 6px; align-items: center; padding: 5px 6px; border-bottom: 1px solid #edf1ef; cursor: pointer; }.group-task-picker label:last-child { border-bottom: 0; }.group-task-picker label.selected { background: #e8f2ec; }.group-task-picker input { width: 13px; height: 13px; padding: 0; accent-color: #267052; }.group-task-picker span { display: grid; gap: 1px; }.group-task-picker strong { font-size: 11px; }.group-task-picker small,.group-task-picker em { color: #73857d; font-size: 11px; font-style: normal; }.group-batch-impact { display: grid; gap: 2px; padding: 7px; color: #536f64; background: #edf3f0; }.group-batch-impact span,.group-batch-impact small { font-size: 11px; }.group-batch-impact strong { color: #245f49; font-size: 11px; }.group-batch-confirm { width: 100%; border-color: #267052!important; color: #fff!important; background: #267052!important; }
.zone-editor { display: grid; gap: 7px; border-top: 1px solid #dbe4df; padding-top: 9px; }.zone-editor > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }.zone-editor > header > div { display: grid; gap: 2px; }.zone-editor > header span { color: #6f8179; font-size: 11px; letter-spacing: .08em; }.zone-editor > header strong { font-size: 10px; }.zone-editor > header b { color: #267052; font-size: 11px; }.zone-editor > label { display: grid; gap: 3px; color: #6c8077; font-size: 11px; }.zone-vertex-list { display: grid; gap: 4px; }.zone-vertex-list > div { display: grid; grid-template-columns: 16px minmax(0,1fr) minmax(0,1fr) 24px; gap: 4px; align-items: end; }.zone-vertex-list > div > strong { align-self: center; color: #6f8179; font-size: 11px; text-align: center; }.zone-vertex-list label { display: grid; gap: 2px; color: #788981; font-size: 11px; }.zone-vertex-list input { padding: 4px; font-size: 11px; }.zone-vertex-list button { width: 24px; height: 24px; padding: 3px; }.zone-editor-actions { display: flex; flex-wrap: wrap; gap: 5px; }.zone-editor-actions button { font-size: 11px; }.zone-editor-actions button.active { border-color: #247253; color: #fff; background: #247253; }
.route-parameters { display: grid; grid-template-columns: 1fr 1.5fr; gap: 6px; }.route-parameters label,.waypoint-list article label { display: grid; gap: 3px; color: #6c8077; font-size: 11px; }.phase-strip { display: flex; gap: 3px; overflow-x: auto; padding-bottom: 3px; }.phase-strip span { display: grid; min-width: 36px; gap: 3px; text-align: center; }.phase-strip b { display: grid; place-items: center; width: 22px; height: 22px; margin: auto; border-radius: 50%; color: white; background: #427d99; font-size: 11px; }.phase-strip small { color: #6f8179; font-size: 11px; white-space: nowrap; }.phase-strip .task_execution b { background: #b96d2d; }.phase-strip .return b,.phase-strip .back_transition b { background: #8b6a26; }.phase-strip .vertical_landing b { background: #267052; }.waypoint-list { max-height: 310px; overflow: auto; }.waypoint-list article { display: grid; gap: 5px; border-top: 1px solid #dce5e0; padding-top: 6px; }.waypoint-list article header { display: flex; justify-content: space-between; }.waypoint-list article header strong { font-size: 11px; }.waypoint-list article header em { color: #ad6a2c; font-style: normal; }.waypoint-list article > div { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4px; }.waypoint-list input { padding: 4px; font-size: 11px; }.route-result,.check-kpis,.summary-grid { display: grid; grid-template-columns: repeat(2,1fr); border: 1px solid #d5e0da; background: white; }.route-result span,.check-kpis span,.summary-grid span { display: grid; gap: 2px; padding: 7px; border-right: 1px solid #d5e0da; border-bottom: 1px solid #d5e0da; }.route-result span:nth-child(even),.check-kpis span:nth-child(even),.summary-grid span:nth-child(even) { border-right: 0; }.route-result span:nth-last-child(-n+2),.check-kpis span:nth-last-child(-n+2),.summary-grid span:nth-last-child(-n+2) { border-bottom: 0; }.route-result strong,.check-kpis strong,.summary-grid strong { font-size: 12px; }.route-result span,.check-kpis small,.summary-grid small { color: #75877f; font-size: 11px; }.route-result span.danger,.terrain-profile-panel b.danger,.energy-table tr.danger { color: #a1443d; }.route-analytics { display: grid; gap: 10px; }.terrain-profile-panel,.energy-panel { display: grid; gap: 7px; border-top: 1px solid #dce5e0; padding-top: 8px; }.terrain-profile-panel > header,.energy-panel > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }.terrain-profile-panel > header > div,.energy-panel > header > div { display: grid; gap: 2px; }.terrain-profile-panel > header span,.energy-panel > header span { color: #6f8179; font-size: 11px; letter-spacing: .08em; }.terrain-profile-panel > header strong,.energy-panel > header strong { font-size: 10px; }.terrain-profile-panel > header b,.energy-panel > header b { color: #267052; font-size: 11px; white-space: nowrap; }.terrain-profile-chart { display: grid; gap: 5px; }.terrain-profile-chart svg { width: 100%; height: 132px; overflow: visible; border: 1px solid #d5e0da; background: #fbfdfb; }.terrain-profile-chart line { stroke: #cad8d1; stroke-width: 1; }.terrain-profile-chart polyline { fill: none; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }.terrain-profile-chart .terrain-line { stroke: #a8782e; }.terrain-profile-chart .planned-line { stroke: #267052; stroke-dasharray: 5 3; }.terrain-profile-chart circle { fill: #a8782e; }.terrain-profile-chart circle.risk { fill: #a1443d; }.profile-legend { display: flex; flex-wrap: wrap; gap: 8px; color: #6f8179; font-size: 11px; }.profile-legend span { display: inline-flex; align-items: center; gap: 3px; }.profile-legend i { width: 12px; height: 2px; display: inline-block; background: #267052; }.profile-legend i.terrain { background: #a8782e; }.profile-legend i.risk { width: 7px; height: 7px; border-radius: 50%; background: #a1443d; }.terrain-profile-chart > small { color: #7b8a83; font-size: 11px; }.energy-table-wrap { overflow-x: auto; border: 1px solid #d5e0da; background: #fff; }.energy-table { width: 100%; min-width: 420px; border-collapse: collapse; font-size: 11px; }.energy-table th,.energy-table td { padding: 5px 4px; border-bottom: 1px solid #edf1ef; text-align: right; white-space: nowrap; }.energy-table th:first-child,.energy-table td:first-child { text-align: left; }.energy-table th { color: #6f8179; font-weight: 600; background: #f5f8f6; }.energy-table tr:last-child td { border-bottom: 0; }.energy-table tr.danger td { background: #fff4f2; }.check-list article { display: grid; grid-template-columns: 14px minmax(0,1fr); gap: 5px; border-top: 1px solid #dce5e0; padding: 7px 0; color: #97711c; }.check-list article.conflict { color: #a1443d; }.check-list article span { display: grid; gap: 2px; }.check-list article strong { font-size: 11px; }.check-list article em { font-style: normal; }.order-panel { border: 1px solid #d4dfd9; background: white; }.order-panel > header { display: flex; justify-content: space-between; padding: 7px; border-bottom: 1px solid #d4dfd9; }.order-panel > header strong { font-size: 11px; }.order-panel > div { display: grid; grid-template-columns: 22px 1fr auto auto; align-items: center; gap: 4px; padding: 5px 7px; border-bottom: 1px solid #edf1ef; }.order-panel > div:last-child { border-bottom: 0; }.order-panel > div > b { color: #267052; font-size: 11px; }.order-panel > div > span { font-size: 11px; }.order-panel button { padding: 3px 5px; font-size: 11px; }.execution-summary { display: grid; gap: 3px; padding: 8px; color: #567168; background: #e8f2ec; font-size: 11px; }.execution-summary strong { color: #215f48; font-size: 10px; }
.alternate-comparison-panel { display: grid; gap: 7px; border-top: 1px solid #dce5e0; padding-top: 8px; }.alternate-comparison-panel > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }.alternate-comparison-panel > header > div { display: grid; gap: 2px; }.alternate-comparison-panel > header span { color: #6f8179; font-size: 11px; letter-spacing: .08em; }.alternate-comparison-panel > header strong { font-size: 10px; }.alternate-comparison-panel > header b { color: #267052; font-size: 11px; white-space: nowrap; }.alternate-comparison-panel > header b.danger,.alternate-comparison-panel > p.danger { color: #a1443d; }.alternate-comparison-panel table { width: 100%; border-collapse: collapse; border: 1px solid #d5e0da; background: #fff; font-size: 11px; }.alternate-comparison-panel th,.alternate-comparison-panel td { padding: 5px; border-bottom: 1px solid #edf1ef; text-align: right; }.alternate-comparison-panel th:first-child,.alternate-comparison-panel td:first-child { color: #6f8179; text-align: left; }.alternate-comparison-panel th { color: #557067; background: #f5f8f6; }.alternate-comparison-panel tr:last-child td { border-bottom: 0; }.alternate-comparison-panel > p { margin: 0; color: #267052; font-size: 11px; }
.preview-summary { display: grid; gap: 7px; border-top: 1px solid #dce5e0; padding-top: 9px; }.preview-summary > header { display: flex; align-items: flex-start; justify-content: space-between; }.preview-summary > header > div { display: grid; gap: 2px; }.preview-summary > header span { color: #6f8179; font-size: 11px; }.preview-summary > header strong { font-size: 10px; }.preview-summary > header b { color: #267052; font-size: 10px; }.preview-summary label { display: grid; gap: 3px; }.preview-kpis { display: grid; grid-template-columns: repeat(3,1fr); border: 1px solid #d5e0da; background: #fff; }.preview-kpis span { display: grid; gap: 2px; padding: 7px; border-right: 1px solid #d5e0da; }.preview-kpis span:last-child { border-right: 0; }.preview-kpis strong { font-size: 11px; }.preview-kpis small { color: #73857d; font-size: 11px; }.preview-phase-list { display: flex; flex-wrap: wrap; gap: 4px; }.preview-phase-list span { display: inline-flex; align-items: center; gap: 4px; padding: 3px 5px; color: #48665a; background: #e6eeea; }.preview-phase-list small,.preview-phase-list strong { font-size: 11px; }
.assignment-task-sequence { align-items: center; }.allocation-aircraft-list article p .assignment-task-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 3px 2px 5px; }.assignment-task-chip > b { font-size: 11px; font-weight: 700; }.task-sequence-actions { display: inline-flex; gap: 1px; font-style: normal; }.task-sequence-actions button { width: 16px; height: 16px; border: 0; padding: 2px; color: #2d6651; background: rgba(255,255,255,.78); }.task-sequence-actions button:disabled { opacity: .28; }.task-sequence-actions svg { width: 9px; height: 9px; }
.group-batch-confirm { min-height: 30px; }.group-batch-confirm > svg { flex: 0 0 12px; width: 12px; height: 12px; }
@media (max-width: 1000px) { .vtl-planning-workspace { grid-template-columns: minmax(0,1fr) 300px; }.vtl-planning-commandbar { grid-template-columns: minmax(0,1fr) auto; }.vtl-planning-commandbar dl { display: none; }.unsaved-state { grid-column: 2; }.vtl-command-actions { grid-column: 1 / -1; justify-content: flex-start; overflow-x: auto; } }
@media (max-width: 760px) { .vtl-planning-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: 68px 420px auto; overflow: auto; }.vtl-planning-map { grid-row: 2; }.vtl-planning-inspector { grid-row: 3; border-top: 1px solid #ccd7d2; border-left: 0; overflow: visible; }.vtl-planning-commandbar { position: sticky; z-index: 4; top: 0; }.vtl-planning-commandbar strong { font-size: 12px; } }
.route-recheck-notice { display: flex; align-items: flex-start; gap: 6px; padding: 7px; border: 1px solid #e6c9a0; color: #965f23; background: #fff8ed; font-size: 11px; }
.route-recheck-notice > span { display: grid; gap: 2px; }
.route-recheck-notice small { color: #8a755e; font-size: 11px; }
.planning-load-error { color: #a14b3f!important; }
.vtl-planning-load-error { grid-column: 1 / -1; display: grid; place-items: center; align-content: center; gap: 9px; min-height: 280px; padding: 32px; color: #71847c; text-align: center; background: #eef3f0; }
.vtl-planning-load-error .el-icon { color: #a14b3f; font-size: 28px; }
.vtl-planning-load-error strong { color: #8b3f35; font-size: 13px; }
.vtl-planning-load-error span { max-width: 48ch; font-size: 11px; line-height: 1.6; }
.vtl-planning-load-error button { display: inline-flex; align-items: center; gap: 4px; border: 1px solid #247253; border-radius: 3px; padding: 7px 10px; color: white; background: #247253; font-size: 11px; cursor: pointer; }
.vtl-planning-load-error button:disabled { cursor: not-allowed; opacity: .48; }
.planning-empty-state{display:grid;gap:4px;border:1px dashed #bdcec4;padding:12px;background:#f1f6f3;color:#60766b;font-size: 11px;line-height:1.5}.planning-empty-state strong{color:#365e4d;font-size: 11px}
.planning-empty-state svg,.check-list svg,.passed svg,.order-panel svg{width:14px;height:14px;max-width:14px;max-height:14px;flex:none}
.allocation-panel .allocation-aircraft-list,.allocation-panel > .planning-empty-state{display:none}
.compact-object-detail,.allocation-object-detail{display:grid;gap:5px;border:1px solid #d5e0da;padding:7px;background:#f7faf8}.compact-object-detail span,.allocation-object-detail header,.allocation-object-detail > div{display:flex;align-items:center;justify-content:space-between;gap:6px}.compact-object-detail strong,.allocation-object-detail header strong{font-size: 11px}.compact-object-detail b,.compact-object-detail small,.allocation-object-detail span{font-size: 11px;color:#60766b}.vtl-map-element-list{display:grid;gap:4px;border-top:1px solid #dce5e0;margin-top:8px;padding-top:8px}.vtl-map-element-list header{display:flex;justify-content:space-between;align-items:center}.vtl-map-element-list header strong{font-size: 11px}.vtl-map-element-list header small{color:#81928a;font-size: 11px}.vtl-map-element-list button{display:flex;justify-content:space-between;gap:6px;border:1px solid #dce5e0;padding:5px 6px;text-align:left;background:#fff;color:#3c5b4e;cursor:pointer}.vtl-map-element-list button.selected{border-color:#247253;background:#eaf4ee}.vtl-map-element-list button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size: 11px}.vtl-map-element-list button small{color:#81928a;font-size: 11px}.allocation-object-detail{margin:7px 0}.allocation-object-detail header span{color:#247253;font-size: 11px}.allocation-object-detail > div{justify-content:flex-start;flex-wrap:wrap}.allocation-object-detail > div span{font-size: 11px}.allocation-object-detail > div b{color:#315b4b}.allocation-object-detail label{display:grid;gap:3px;font-size: 11px;color:#60766b}.compact-assign-button{justify-self:start;border:1px solid #247253;padding:4px 7px;color:#fff;background:#247253;font-size: 11px;cursor:pointer}.compact-assign-button:disabled{cursor:not-allowed;opacity:.45}

@media (max-width: 1080px) {
  .vtl-planning-workspace { grid-column: 2 / 4; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(380px, 48vh) auto; overflow: auto; }
  .vtl-planning-commandbar { grid-column: 1; grid-template-columns: minmax(0, 1fr) auto; position: sticky; z-index: 5; top: 0; }
  .vtl-planning-map { grid-column: 1; grid-row: 2; }
  .vtl-planning-inspector { grid-column: 1; grid-row: 3; border-top: 1px solid #ccd7d2; border-left: 0; overflow: visible; }
  .vtl-command-actions { grid-column: 1 / -1; justify-content: flex-start; overflow-x: auto; }
}
@media (max-width: 760px) {
  .vtl-planning-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-rows: auto 360px auto; }
  .vtl-planning-commandbar { padding: 8px 9px; }
  .vtl-planning-commandbar dl { display: none; }
  .vtl-command-actions button { flex: 0 0 auto; }
}
@media (max-width: 420px) {
  .vtl-planning-workspace { grid-template-rows: auto 300px auto; }
  .vtl-planning-commandbar { grid-template-columns: minmax(0, 1fr); }
  .unsaved-state { grid-column: 1; justify-self: start; }
  .vtl-command-actions { grid-column: 1; }
  .group-summary-list, .route-result, .check-kpis, .summary-grid { grid-template-columns: 1fr; }
}

</style>
