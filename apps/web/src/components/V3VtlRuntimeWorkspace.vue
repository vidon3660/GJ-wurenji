<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Bell, CircleCheck, Refresh, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  StudentProjectStageView,
  StudentProjectView,
  V3RegionCatalogItem,
  V3RegionLayerCode,
  VtlFlightPhase,
  VtlPlanningWorkspaceView,
  VtlRuntimeActionCode,
  VtlRuntimeEventView,
  VtlRuntimeWorkspaceView,
  VtlSituationLevel
} from "@wurenji/shared"
import { api } from "../api"
import { createClientId } from "../client-id"
import type { V3MapDataState } from "../map-loading-state"
import { openRuntimeStream, type RuntimeStreamConnectionState, type RuntimeStreamController } from "../runtime-stream"
import { runtimeActionEventId } from "../runtime-action-targets"
import { runtimeActionReasoning } from "../runtime-action-reasoning"
import { runtimeEventCategoryLabel, runtimeEventSource } from "../runtime-event-source"
import { shouldApplyRuntimeWorkspace } from "../runtime-workspace-consistency"
import { pickRecommendedRuntimeAction, pickRuntimeTargetId, runtimeAlertSeverityLabel, runtimeAlertStatusLabel, runtimeAlertTiming, runtimeRecommendedActionLabel } from "../runtime-alert-presentation"
import { remainingVtlTasks, vtlActionPreview } from "../vtl-action-preview"
import { vtlAircraftTaskSummary } from "../vtl-aircraft-task-presentation"
import { vtlActionBusinessConsequences, vtlActionEvidence, vtlEventBriefing } from "../vtl-runtime-briefing"
import { formatRuntimeSessionStatus, formatScaleTemplateCode, formatVtlGroupCode } from "../terminology"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
  region: V3RegionCatalogItem | null
  mapMode: "2d" | "3d"
  mainLandingSiteId: string
  initialAlertId?: string
}>()
const emit = defineEmits<{
  refreshProject: []
  dataState: [state: V3MapDataState]
}>()

const loading = ref(false)
const snapshotLoading = ref(false)
let snapshotRequestCount = 0
const loadError = ref("")
const workspace = shallowRef<VtlRuntimeWorkspaceView | null>(null)
const planning = shallowRef<VtlPlanningWorkspaceView | null>(null)
const situationLevel = ref<VtlSituationLevel>("OVERALL")
const selectedGroupId = ref("")
const selectedAircraftId = ref("")
const selectedEventId = ref("")
const selectedActionCode = ref<VtlRuntimeActionCode | "">("")
const selectedTargetId = ref("")
const destinationAircraftId = ref("")
const destinationGroupId = ref("")
const selectedTaskObjectId = ref("")
const actionObservation = ref("")
const actionRationale = ref("")
const actionExpectedOutcome = ref("")
const actionSubmitting = ref(false)
const actionError = ref("")
const visibleMapLayers = ref<V3RegionLayerCode[]>([])
const lastMutationError = ref("")
const actionResultPanel = ref<HTMLElement | null>(null)
const actionConsole = ref<HTMLElement | null>(null)
const teacherEventCode = ref("VTL_WEATHER")
const clockRate = ref(60)

watch(() => props.region, (region) => {
  visibleMapLayers.value = region?.layers
    .filter((layer) => layer.state !== "UNAVAILABLE" && ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"].includes(layer.code))
    .map((layer) => layer.code) ?? []
}, { immediate: true, deep: true })
const connectionState = ref<RuntimeStreamConnectionState>("CONNECTING")
let runtimeStream: RuntimeStreamController | null = null
let initializationGeneration = 0

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
const eventOptions = [
  ["VTL_WEATHER", "区域气象恶化"],
  ["VTL_POSITIONING", "定位质量下降"],
  ["VTL_COMMUNICATION", "通信链路异常"],
  ["VTL_ENERGY_POWER", "能量或动力余度下降"],
  ["VTL_DEVICE", "航空器设备异常"],
  ["VTL_TRANSITION", "模式转换异常"],
  ["VTL_ROUTE_AREA", "航线或区域变化"],
  ["VTL_TASK_CONDITION", "任务对象条件变化"]
] as const

const connectionStateLabel = computed(() => ({
  CONNECTING: "连接中",
  LIVE: "实时在线",
  RECONNECTING: "正在重连",
  FALLBACK: "回退刷新",
  CLOSED: "已关闭"
} as Record<RuntimeStreamConnectionState, string>)[connectionState.value])
const currentAttempt = computed(() => workspace.value?.attempts[0] ?? null)
const isHistoricalAttempt = computed(() => Boolean(workspace.value && currentAttempt.value?.id !== workspace.value.session.id))
const visibleEvents = computed(() => workspace.value?.events.filter((event) => workspace.value?.actor === "TEACHER" || !["PENDING", "OCCURRED_UNDETECTED"].includes(event.status)) ?? [])
const visibleEventSignature = computed(() => visibleEvents.value.map((event) => `${event.id}:${event.status}`).join("|"))
const activeAlerts = computed(() => workspace.value?.alerts.filter((alert) => alert.status !== "RESOLVED") ?? [])
const selectedEvent = computed(() => visibleEvents.value.find((event) => event.id === selectedEventId.value)
  ?? visibleEvents.value.find((event) => event.status !== "RESOLVED")
  ?? visibleEvents.value[0]
  ?? null)
const selectedEventAction = computed(() => {
  const eventId = selectedEvent.value?.id
  if (!eventId) return null
  return [...(workspace.value?.actions ?? [])].reverse().find((action) => action.eventId === eventId && action.actionCode !== "ACKNOWLEDGE") ?? null
})
const selectedEventBriefing = computed(() => selectedEvent.value
  ? vtlEventBriefing(selectedEvent.value, eventRecommendedAction(selectedEvent.value))
  : null)
const selectedEventConsequences = computed(() => vtlActionBusinessConsequences(selectedEventAction.value))
const selectedEventEvidence = computed(() => vtlActionEvidence(selectedEventAction.value))
const selectedAction = computed(() => workspace.value?.availableActions.find((action) => action.code === selectedActionCode.value) ?? null)
const selectedAircraft = computed(() => workspace.value?.aircraft.find((aircraft) => aircraft.aircraftId === selectedAircraftId.value) ?? null)
const selectedAircraftTask = computed(() => {
  const aircraft = selectedAircraft.value
  if (!aircraft) return null
  return vtlAircraftTaskSummary({
    currentTaskObjectId: aircraft.currentTaskObjectId,
    completedTaskObjectIds: aircraft.completedTaskObjectIds,
    assignedTaskObjectIds: effectiveTaskIds(aircraft.aircraftId)
  }, workspace.value?.taskObjects ?? []).currentTask
})
const selectedAircraftNextTask = computed(() => {
  const aircraft = selectedAircraft.value
  if (!aircraft) return null
  return vtlAircraftTaskSummary({
    currentTaskObjectId: aircraft.currentTaskObjectId,
    completedTaskObjectIds: aircraft.completedTaskObjectIds,
    assignedTaskObjectIds: effectiveTaskIds(aircraft.aircraftId)
  }, workspace.value?.taskObjects ?? []).nextTask
})
const selectedTargetAircraft = computed(() => workspace.value?.aircraft.find((aircraft) => aircraft.aircraftId === selectedTargetId.value) ?? null)
const selectedGroup = computed(() => workspace.value?.groups.find((group) => group.groupId === selectedGroupId.value) ?? null)
const selectedGroupAircraft = computed(() => workspace.value?.aircraft.filter((aircraft) => aircraft.groupId === selectedGroup.value?.groupId) ?? [])
const mapVisibleAircraftIds = computed(() => situationLevel.value === "OVERALL"
  ? null
  : situationLevel.value === "GROUP"
    ? selectedGroupAircraft.value.map((aircraft) => aircraft.aircraftId)
    : selectedAircraftId.value ? [selectedAircraftId.value] : [])
const mapSelectedAircraftId = computed(() => situationLevel.value === "AIRCRAFT" ? selectedAircraftId.value : null)
const targetAircraftOptions = computed(() => {
  const ids = new Set(selectedAction.value?.eligibleTargetIds ?? [])
  return workspace.value?.aircraft.filter((aircraft) => ids.has(aircraft.aircraftId)) ?? []
})
const targetAircraftSignature = computed(() => targetAircraftOptions.value.map((aircraft) => aircraft.aircraftId).join("|"))
const destinationAircraftOptions = computed(() => workspace.value?.aircraft.filter((aircraft) =>
  aircraft.aircraftId !== selectedTargetId.value && ["WAITING", "ACTIVE"].includes(aircraft.status)
) ?? [])
const sourceTaskOptions = computed(() => effectiveTaskIds(selectedTargetId.value)
  .filter((taskId) => !workspace.value?.aircraft.find((aircraft) => aircraft.aircraftId === selectedTargetId.value)?.completedTaskObjectIds.includes(taskId))
  .map((taskId) => workspace.value?.taskObjects.find((task) => task.id === taskId))
  .filter((task): task is NonNullable<typeof task> => Boolean(task)))
const sourceTaskSignature = computed(() => sourceTaskOptions.value.map((task) => task.id).join("|"))
const selectedRemainingTasks = computed(() => remainingVtlTasks(
  effectiveTaskIds(selectedTargetId.value),
  selectedTargetAircraft.value?.completedTaskObjectIds ?? [],
  workspace.value?.taskObjects ?? []
))
const selectedLandingSite = computed(() => {
  const plan = planning.value?.plan
  if (!plan || !selectedTargetId.value) return null
  const route = plan.routes.find((item) => item.aircraftId === selectedTargetId.value)
  const landingSiteId = selectedActionCode.value === "RETURN_AIRCRAFT"
    ? plan.landingSites.find((site) => site.type === "MAIN")?.id
    : route?.alternateLandingSiteId
  return plan.landingSites.find((site) => site.id === landingSiteId) ?? null
})
const actionOutcomePreview = computed(() => vtlActionPreview(selectedActionCode.value, {
  aircraftCode: selectedTargetAircraft.value?.aircraftCode ?? null,
  destinationAircraftCode: workspace.value?.aircraft.find((aircraft) => aircraft.aircraftId === destinationAircraftId.value)?.aircraftCode ?? null,
  destinationGroupTitle: planning.value?.plan.allocation.groups.find((group) => group.id === destinationGroupId.value)?.title ?? null,
  landingSiteTitle: selectedLandingSite.value?.title ?? null,
  remainingTaskCount: selectedRemainingTasks.value.length,
  taskTitle: sourceTaskOptions.value.find((task) => task.id === selectedTaskObjectId.value)?.title ?? null
}))
const actionValid = computed(() => {
  if (selectedEvent.value?.status === "RESOLVED") return false
  if (!selectedAction.value?.enabled) return false
  if (selectedAction.value.code === "ACKNOWLEDGE") return Boolean(selectedEvent.value)
  if (!selectedTargetId.value) return false
  if (selectedAction.value.code === "TRANSFER_TASK") return Boolean(destinationAircraftId.value && selectedTaskObjectId.value)
  if (selectedAction.value.code === "ADJUST_GROUP") return Boolean(destinationGroupId.value)
  return true
})
const reasoningValid = computed(() => [actionObservation.value, actionRationale.value, actionExpectedOutcome.value].every((value) => value.trim().length >= 4))
const unresolvedEvents = computed(() => workspace.value?.events.filter((event) => !["PENDING", "RESOLVED"].includes(event.status)) ?? [])
const eventPauseActive = computed(() => workspace.value?.session.status === "PAUSED" && unresolvedEvents.value.length > 0)
const canCompleteEmergency = computed(() => props.stage.stageCode === "VTL_EMERGENCY_HANDLING"
  && props.stage.status === "IN_PROGRESS"
  && workspace.value?.session.status === "COMPLETED"
  && unresolvedEvents.value.length === 0)

onMounted(initialize)
onBeforeUnmount(() => {
  initializationGeneration += 1
  runtimeStream?.close()
})
watch(() => props.project.id, initialize)
watch(visibleEventSignature, () => {
  const events = visibleEvents.value
  if (!events.some((event) => event.id === selectedEventId.value)) selectedEventId.value = events.find((event) => event.status !== "RESOLVED")?.id ?? events[0]?.id ?? ""
})
watch(targetAircraftSignature, () => {
  const aircraft = targetAircraftOptions.value
  if (!aircraft.some((item) => item.aircraftId === selectedTargetId.value)) selectedTargetId.value = aircraft[0]?.aircraftId ?? ""
})
watch(sourceTaskSignature, () => {
  const tasks = sourceTaskOptions.value
  if (!tasks.some((task) => task.id === selectedTaskObjectId.value)) selectedTaskObjectId.value = tasks[0]?.id ?? ""
})

async function initialize() {
  const generation = ++initializationGeneration
  const projectId = props.project.id
  runtimeStream?.close()
  await Promise.all([loadPlanning(generation), loadWorkspace(true, undefined, generation)])
  if (generation !== initializationGeneration || projectId !== props.project.id) return
  runtimeStream = openRuntimeStream<VtlRuntimeWorkspaceView>(
    `/v3/vtl-projects/${projectId}/runtime/stream`,
    (snapshot) => { if (generation === initializationGeneration && projectId === props.project.id) applyWorkspace(snapshot.workspace) },
    (state) => { if (generation === initializationGeneration && projectId === props.project.id) connectionState.value = state },
    () => { if (generation === initializationGeneration && projectId === props.project.id) void loadWorkspace(false, undefined, generation) },
    (streamError) => {
      if (generation !== initializationGeneration || projectId !== props.project.id) return
      loadError.value = streamError.error.message
      ElMessage.error(loadError.value)
    }
  )
}

async function reconnectRuntime() {
  if (isHistoricalAttempt.value) return
  runtimeStream?.close()
  runtimeStream = null
  connectionState.value = "CONNECTING"
  await initialize()
}

async function loadPlanning(generation = initializationGeneration) {
  try {
    const value = await api<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/planning-workspace`)
    if (generation !== initializationGeneration) return
    planning.value = value
  } catch (error) {
    if (generation === initializationGeneration) ElMessage.error(error instanceof Error ? error.message : "巡检方案加载失败")
  }
}

async function loadWorkspace(showLoading = true, sessionId?: string, generation = initializationGeneration) {
  snapshotRequestCount += 1
  snapshotLoading.value = true
  if (showLoading) loading.value = true
  try {
    const path = sessionId
      ? `/v3/vtl-projects/${props.project.id}/runtime/attempts/${sessionId}`
      : `/v3/vtl-projects/${props.project.id}/runtime`
    const value = await api<VtlRuntimeWorkspaceView>(path)
    if (generation !== initializationGeneration) return
    applyWorkspace(value, Boolean(sessionId))
    loadError.value = ""
  } catch (error) {
    if (showLoading && generation === initializationGeneration) {
      loadError.value = error instanceof Error ? error.message : "巡检运行加载失败"
      ElMessage.error(loadError.value)
    }
  } finally {
    snapshotRequestCount = Math.max(0, snapshotRequestCount - 1)
    snapshotLoading.value = snapshotRequestCount > 0
    if (showLoading && generation === initializationGeneration) loading.value = false
  }
}

function applyWorkspace(value: VtlRuntimeWorkspaceView, allowOlderAttempt = false) {
  if (!shouldApplyRuntimeWorkspace(workspace.value, value, { allowOlderAttempt })) return
  loadError.value = ""
  workspace.value = value
  clockRate.value = value.clockRate
  selectedGroupId.value = value.groups.some((group) => group.groupId === selectedGroupId.value) ? selectedGroupId.value : value.groups[0]?.groupId ?? ""
  selectedAircraftId.value = value.aircraft.some((aircraft) => aircraft.aircraftId === selectedAircraftId.value) ? selectedAircraftId.value : value.aircraft[0]?.aircraftId ?? ""
  if (props.initialAlertId) {
    const alert = value.alerts.find((item) => item.id === props.initialAlertId)
    const event = value.events.find((item) => item.id === alert?.eventId)
    if (event) eventSelected(event)
  }
  selectedActionCode.value = value.availableActions.some((action) => action.code === selectedActionCode.value && action.enabled)
    ? selectedActionCode.value
    : value.availableActions.find((action) => action.enabled)?.code ?? ""
}

async function selectAttempt(sessionId: string) {
  if (sessionId === currentAttempt.value?.id) {
    await initialize()
    return
  }
  runtimeStream?.close()
  runtimeStream = null
  connectionState.value = "CLOSED"
  await loadWorkspace(true, sessionId)
}

async function startRuntime() {
  if (!workspace.value) return
  await mutate(`/v3/vtl-projects/${props.project.id}/runtime/start`, { expectedRevision: workspace.value.session.revision }, "巡检运行已启动")
}

async function toggleClock() {
  if (!workspace.value || isHistoricalAttempt.value) return
  if (workspace.value.session.status === "PAUSED" && eventPauseActive.value) {
    ElMessage.warning("请先完成当前巡检事件处置，再继续运行")
    return
  }
  const status = workspace.value.session.status === "RUNNING" ? "PAUSED" : "RUNNING"
  await mutate(`/v3/vtl-projects/${props.project.id}/runtime/clock-rate`, { expectedRevision: workspace.value.session.revision, rate: clockRate.value, status }, status === "PAUSED" ? "运行已暂停" : "运行已继续")
}

async function changeClockRate(value: number) {
  clockRate.value = value
  if (!workspace.value || !["RUNNING", "PAUSED"].includes(workspace.value.session.status) || props.project.mode !== "TRAINING") return
  await mutate(`/v3/vtl-projects/${props.project.id}/runtime/clock-rate`, { expectedRevision: workspace.value.session.revision, rate: value, status: workspace.value.session.status }, `仿真倍率已调整为 ${value}x`, false)
}

async function executeAction() {
  if (actionSubmitting.value || !workspace.value || !selectedAction.value || !actionValid.value || !reasoningValid.value) return
  const actionCode = selectedAction.value.code
  const body: Record<string, unknown> = {
    expectedRevision: workspace.value.session.revision,
    requestId: createClientId(),
    actionCode,
    eventId: runtimeActionEventId(selectedEvent.value),
    targetId: actionCode === "ACKNOWLEDGE" ? undefined : selectedTargetId.value,
    reasoning: {
      observation: actionObservation.value.trim(),
      rationale: actionRationale.value.trim(),
      expectedOutcome: actionExpectedOutcome.value.trim()
    }
  }
  if (actionCode === "TRANSFER_TASK") {
    body.targetAircraftId = destinationAircraftId.value
    body.taskObjectId = selectedTaskObjectId.value
  }
  if (actionCode === "ADJUST_GROUP") body.targetGroupId = destinationGroupId.value
  actionError.value = ""
  actionSubmitting.value = true
  const succeeded = await mutate(`/v3/vtl-projects/${props.project.id}/runtime/actions`, body, "巡检处置已执行")
  if (succeeded) {
    actionObservation.value = ""
    actionRationale.value = ""
    actionExpectedOutcome.value = ""
    await nextTick()
    actionResultPanel.value?.scrollIntoView({ behavior: "smooth", block: "nearest" })
    actionResultPanel.value?.focus({ preventScroll: true })
  } else actionError.value = lastMutationError.value
    ? `处置未成功：${lastMutationError.value} 已保留本次判断内容，请检查运行状态后重试。`
    : "处置未成功，已保留本次判断内容，请检查运行状态后重试。"
  actionSubmitting.value = false
}

async function triggerTeacherEvent() {
  if (!workspace.value) return
  await mutate(`/v3/vtl-projects/${props.project.id}/runtime/events/${teacherEventCode.value}/trigger`, { expectedRevision: workspace.value.session.revision, requestId: createClientId() }, "训练事件已触发")
}

async function completeEmergency() {
  if (!workspace.value || !canCompleteEmergency.value) return
  try {
    await ElMessageBox.confirm("确认所有巡检事件均已完成处置，并进入复盘评价阶段？", "完成事件处置", {
      type: "warning",
      confirmButtonText: "确认进入复盘",
      cancelButtonText: "返回"
    })
  } catch {
    return
  }
  await mutate(`/v3/vtl-projects/${props.project.id}/emergency/complete`, { expectedRevision: workspace.value.session.revision }, "事件处置阶段已完成")
  emit("refreshProject")
}

async function mutate(path: string, body: Record<string, unknown>, success: string, showLoading = true): Promise<boolean> {
  if (showLoading) loading.value = true
  lastMutationError.value = ""
  try {
    applyWorkspace(await api<VtlRuntimeWorkspaceView>(path, { method: "POST", body: JSON.stringify(body) }))
    ElMessage.success(success)
    return true
  } catch (error) {
    lastMutationError.value = error instanceof Error ? error.message : "巡检运行命令执行失败"
    if (path.endsWith("/runtime/actions")) actionError.value = `处置未成功：${lastMutationError.value} 已保留本次判断内容，请检查运行状态后重试。`
    ElMessage.error(lastMutationError.value)
    await loadWorkspace(false)
    return false
  } finally {
    if (showLoading) loading.value = false
  }
}

function effectiveTaskIds(aircraftId: string): string[] {
  const initial = planning.value?.plan.allocation.assignments.find((assignment) => assignment.aircraftId === aircraftId)?.taskObjectIds ?? []
  const result = new Set(initial)
  for (const record of workspace.value?.reorganizations ?? []) {
    if (record.action !== "TRANSFER_TASK") continue
    if (record.sourceAircraftId === aircraftId) record.taskObjectIds.forEach((taskId) => result.delete(taskId))
    if (record.targetAircraftId === aircraftId) record.taskObjectIds.forEach((taskId) => result.add(taskId))
  }
  return [...result]
}

function selectGroup(groupId: string) {
  selectedGroupId.value = groupId
  situationLevel.value = "GROUP"
  const aircraft = workspace.value?.aircraft.find((item) => item.groupId === groupId)
  if (aircraft) selectedAircraftId.value = aircraft.aircraftId
}

function selectAircraft(aircraftId: string) {
  selectedAircraftId.value = aircraftId
  selectedGroupId.value = workspace.value?.aircraft.find((aircraft) => aircraft.aircraftId === aircraftId)?.groupId ?? selectedGroupId.value
  situationLevel.value = "AIRCRAFT"
}

function eventSelected(event: VtlRuntimeEventView) {
  selectedEventId.value = event.id
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 680px)").matches) {
    void nextTick(() => actionConsole.value?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" }))
  }
  if (event.status === "RESOLVED") {
    const recorded = [...(workspace.value?.actions ?? [])].reverse().find((action) => action.eventId === event.id && action.actionCode !== "ACKNOWLEDGE")
    if (recorded) {
      selectedActionCode.value = recorded.actionCode as VtlRuntimeActionCode
      selectedTargetId.value = recorded.targetId ?? ""
    }
    const affectedAircraftId = event.affectedAircraftIds[0]
    if (affectedAircraftId) selectAircraft(affectedAircraftId)
    return
  }
  const recommended = pickRecommendedRuntimeAction(workspace.value?.availableActions ?? [], event.availableActions)
  const fallback = recommended ?? workspace.value?.availableActions.find((action) => action.enabled)
  if (fallback) {
    selectedActionCode.value = fallback.code
    selectedTargetId.value = pickRuntimeTargetId(fallback.eligibleTargetIds, fallback.targetType === "EVENT" ? [event.id] : event.affectedAircraftIds)
  }
  const affectedAircraftId = event.affectedAircraftIds.find((aircraftId) => targetAircraftOptions.value.some((aircraft) => aircraft.aircraftId === aircraftId)) ?? event.affectedAircraftIds[0]
  if (affectedAircraftId) {
    selectAircraft(affectedAircraftId)
  }
}

function phaseLabel(phase: VtlFlightPhase) { return phaseLabels[phase] }
function statusLabel(status: string) { return ({ WAITING: "待起飞", ACTIVE: "执行中", HOLDING: "等待", RETURNING: "返航", DIVERTING: "备降", LANDED: "已降落", CANCELLED: "已取消" } as Record<string, string>)[status] ?? status }
function eventStatusLabel(status: string) { return ({ PENDING: "待发生", OCCURRED_UNDETECTED: "已发生未发现", ACTIVE: "已发现", HANDLING: "处置中", ESCALATED: "已升级", RESOLVED: "已解除" } as Record<string, string>)[status] ?? status }
function eventAttentionLabel(event: VtlRuntimeEventView) {
  if (["PENDING", "OCCURRED_UNDETECTED"].includes(event.status)) return eventStatusLabel(event.status)
  return runtimeAlertStatusLabel(workspace.value?.alerts.find((alert) => alert.eventId === event.id)?.status ?? "OPEN", event.status)
}
function eventTiming(event: VtlRuntimeEventView) {
  return runtimeAlertTiming(event, workspace.value?.session.simulationTimeMs ?? 0)
}
function eventRecommendedAction(event: VtlRuntimeEventView) {
  return runtimeRecommendedActionLabel(event.availableActions, workspace.value?.availableActions ?? [])
}
function actionLabel(code: string) { return workspace.value?.availableActions.find((action) => action.code === code)?.title ?? code }
function actionResultMessage(result: Record<string, unknown>) {
  if (typeof result.outcome === "string" && result.outcome.trim()) return result.outcome
  const consequences = Array.isArray(result.businessConsequences)
    ? result.businessConsequences.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : []
  return consequences.length > 0 ? consequences.join("；") : typeof result.message === "string" ? result.message : "处置已记录"
}
function formatDuration(milliseconds: number | null) {
  const seconds = Math.max(0, Math.floor((milliseconds ?? 0) / 1_000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}
function jumpToVtlSection(selector: string) {
  if (typeof document === "undefined") return
  const target = document.querySelector<HTMLElement>(selector)
  if (!target) return
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start", inline: "nearest" })
}
</script>

<template>
  <section class="vtl-runtime-workspace" :data-runtime-revision="workspace?.session.revision ?? 0" v-loading="loading">
    <header class="vtl-runtime-commandbar">
      <div><span>垂起巡检运行</span><strong>垂起广域巡检运行</strong><small>{{ workspace ? formatScaleTemplateCode(workspace.scaleTemplateCode) : '规模加载中' }} · {{ workspace ? formatRuntimeSessionStatus(workspace.session.status) : '状态加载中' }} · 第 {{ workspace?.session.attemptNo ?? 1 }} 次</small></div>
      <div class="vtl-attempt-select" v-if="workspace?.attempts.length"><label>运行记录</label><select :value="workspace.session.id" aria-label="选择运行记录" @change="selectAttempt(($event.target as HTMLSelectElement).value)"><option v-for="attempt in workspace.attempts" :key="attempt.id" :value="attempt.id">第 {{ attempt.attemptNo }} 次 · {{ formatRuntimeSessionStatus(attempt.status) }}{{ attempt.id === workspace.attempts[0]?.id ? ' · 当前' : '' }}</option></select></div>
      <dl><div><dt>仿真时间</dt><dd>{{ formatDuration(workspace?.session.simulationTimeMs ?? 0) }}</dd></div><div><dt>任务覆盖</dt><dd>{{ Math.round((workspace?.summary.taskCompletionRatio ?? 0) * 100) }}%</dd></div><div><dt>空中/总数</dt><dd>{{ workspace?.summary.airborneAircraft ?? 0 }}/{{ workspace?.summary.totalAircraft ?? 0 }}</dd></div><div><dt>活动告警</dt><dd class="danger">{{ activeAlerts.length }}</dd></div></dl>
      <div class="vtl-runtime-actions"><div v-if="eventPauseActive" class="event-pause-state" role="status" aria-live="polite" aria-label="未处置事件，仿真已暂停。处置时限按仿真时间计算，完成当前事件后才能继续"><Warning /><span><strong>未处置事件，仿真已暂停</strong><small>处置时限按仿真时间计算，完成当前事件后才能继续</small></span></div><span class="stream-state" :class="connectionState.toLowerCase()" role="status" aria-live="polite" :aria-label="`运行数据连接状态：${connectionStateLabel}`"><i />{{ connectionStateLabel }}</span><button v-if="!isHistoricalAttempt && ['RECONNECTING', 'FALLBACK', 'CLOSED'].includes(connectionState)" type="button" title="重新连接实时运行流" aria-label="重新连接实时运行流" @click="reconnectRuntime">重新连接</button><button v-if="workspace?.canStart" type="button" class="primary" @click="startRuntime"><VideoPlay />启动运行</button><button v-if="workspace?.canControl && ['RUNNING','PAUSED'].includes(workspace.session.status) && project.mode === 'TRAINING'" type="button" :disabled="eventPauseActive" :title="eventPauseActive ? '请先完成当前巡检事件处置' : ''" :aria-label="workspace.session.status === 'RUNNING' ? '暂停仿真' : '继续仿真'" @click="toggleClock"><component :is="workspace.session.status === 'RUNNING' ? VideoPause : VideoPlay" />{{ workspace.session.status === 'RUNNING' ? '暂停' : '继续' }}</button><button type="button" title="刷新运行快照" aria-label="刷新运行快照" :disabled="snapshotLoading" @click="loadWorkspace()"><Refresh /></button></div>
    </header>
    <div v-if="loadError" class="runtime-load-error" role="alert" aria-live="assertive"><span><strong>运行数据加载失败</strong><small>{{ loadError }} 当前页面数据未被清除，请重试。</small></span><button type="button" :disabled="loading" @click="initialize">重试加载</button></div>
    <nav class="vtl-runtime-quick-nav" aria-label="巡检运行快速定位"><button type="button" aria-label="定位到总体运行态势" data-runtime-jump="situation" @click="jumpToVtlSection('.vtl-situation-panel')">态势</button><button type="button" aria-label="定位到巡检地图" data-runtime-jump="map" @click="jumpToVtlSection('.vtl-runtime-map')">地图</button><button type="button" aria-label="定位到告警与事件" data-runtime-jump="alerts" @click="jumpToVtlSection('.vtl-event-panel')">告警<span v-if="activeAlerts.length">{{ activeAlerts.length }}</span></button><button type="button" aria-label="定位到学生应急处置" data-runtime-jump="handling" @click="jumpToVtlSection('.student-action-console')">处置</button></nav>

    <aside class="vtl-situation-panel">
      <div class="situation-segments"><button v-for="level in (['OVERALL','GROUP','AIRCRAFT'] as VtlSituationLevel[])" :key="level" type="button" :class="{ active: situationLevel === level }" :aria-pressed="situationLevel === level" @click="situationLevel = level">{{ level === 'OVERALL' ? '总体' : level === 'GROUP' ? '分组' : '单架' }}</button></div>
      <section v-if="situationLevel === 'OVERALL'" class="overall-situation"><header><span>总体态势</span><strong>总体运行态势</strong></header><div class="situation-kpis"><span><b>{{ workspace?.summary.completedTaskObjects ?? 0 }}</b>已完成</span><span><b>{{ workspace?.summary.incompleteTaskObjects ?? 0 }}</b>未完成</span><span><b>{{ workspace?.summary.attentionAircraft ?? 0 }}</b>需关注</span><span><b>{{ workspace?.summary.landedAircraft ?? 0 }}</b>已降落</span></div><div class="phase-distribution"><div v-for="(count, phase) in workspace?.summary.phaseDistribution ?? {}" :key="phase"><span>{{ phaseLabel(phase as VtlFlightPhase) }}</span><b>{{ count }}</b></div></div></section>
      <section class="group-list"><header><strong>运行分组</strong></header><button v-for="group in workspace?.groups ?? []" :key="group.groupId" type="button" :class="{ selected: group.groupId === selectedGroupId }" :aria-pressed="group.groupId === selectedGroupId" @click="selectGroup(group.groupId)"><div><strong>{{ formatVtlGroupCode(group.groupId) }}</strong><small>{{ group.activeAircraftCount }}/{{ group.aircraftCount }} 架活动 · {{ group.completedTaskCount }}/{{ group.totalTaskCount }} 项</small></div><em>{{ Math.round(group.progressRatio * 100) }}%</em><i :style="{ width: `${Math.round(group.progressRatio * 100)}%` }" /></button></section>
      <section v-if="situationLevel !== 'OVERALL'" class="aircraft-list"><header><span>航空器</span><strong>{{ situationLevel === 'GROUP' ? `${formatVtlGroupCode(selectedGroupId)} 单架状态` : '全部航空器' }}</strong></header><button v-for="aircraft in (situationLevel === 'GROUP' ? selectedGroupAircraft : workspace?.aircraft ?? [])" :key="aircraft.aircraftId" type="button" :class="[aircraft.status.toLowerCase(), { selected: aircraft.aircraftId === selectedAircraftId }]" :aria-pressed="aircraft.aircraftId === selectedAircraftId" @click="selectAircraft(aircraft.aircraftId)"><i /><div><strong>{{ aircraft.aircraftCode }}</strong><small>{{ phaseLabel(aircraft.phase) }} · {{ statusLabel(aircraft.status) }}</small></div><em>{{ Math.round(aircraft.remainingEnergyRatio * 100) }}%</em></button></section>
      <section v-if="selectedAircraft" class="aircraft-detail-panel">
        <header><span>航空器详情</span><strong>{{ selectedAircraft.aircraftCode }}</strong></header>
        <dl>
          <div><dt>所属编队</dt><dd>{{ formatVtlGroupCode(selectedAircraft.groupId) }}</dd></div>
          <div><dt>飞行阶段</dt><dd>{{ phaseLabel(selectedAircraft.phase) }}</dd></div>
          <div><dt>运行状态</dt><dd>{{ statusLabel(selectedAircraft.status) }}</dd></div>
          <div><dt>剩余能量</dt><dd>{{ selectedAircraft.remainingEnergyWh.toFixed(0) }} Wh · {{ Math.round(selectedAircraft.remainingEnergyRatio * 100) }}%</dd></div>
        </dl>
        <div class="aircraft-task-summary"><span>当前任务</span><strong>{{ selectedAircraftTask ? `${selectedAircraftTask.code} · ${selectedAircraftTask.title}` : '当前阶段无执行中任务' }}</strong></div>
        <div class="aircraft-task-summary next"><span>下一任务</span><strong>{{ selectedAircraftNextTask ? `${selectedAircraftNextTask.code} · ${selectedAircraftNextTask.title}` : '暂无已分配的下一任务' }}</strong></div>
      </section>
    </aside>

    <main class="vtl-runtime-map">
      <V3UnifiedMap :region="region" :visible-layers="visibleMapLayers" :mode="mapMode" :vtl-plan="planning?.plan ?? null" :vtl-runtime="workspace" :vtl-selected-aircraft-id="mapSelectedAircraftId" :vtl-visible-aircraft-ids="mapVisibleAircraftIds" :vtl-main-landing-site-id="mainLandingSiteId" @data-state="emit('dataState', $event)" @vtl-aircraft-select="selectAircraft" />
      <V3EnvironmentLayerPanel v-if="region" :region="region" scene-type="VTOL_INSPECTION" :visible-layers="visibleMapLayers" @toggle-layer="visibleMapLayers = visibleMapLayers.includes($event) ? visibleMapLayers.filter(item => item !== $event) : [...visibleMapLayers, $event]" />
      <div class="map-situation-badge"><span>{{ situationLevel === 'OVERALL' ? '总体态势' : situationLevel === 'GROUP' ? formatVtlGroupCode(selectedGroupId) : selectedAircraft?.aircraftCode }}</span><strong>{{ situationLevel === 'AIRCRAFT' && selectedAircraft ? `${phaseLabel(selectedAircraft.phase)} · ${Math.round(selectedAircraft.remainingEnergyRatio * 100)}%` : situationLevel === 'GROUP' ? `${selectedGroupAircraft.length} 架航空器` : `${workspace?.summary.totalTaskObjects ?? 0} 个任务对象` }}</strong></div>
      <div v-if="workspace?.session.status === 'READY'" class="runtime-start-overlay"><VideoPlay /><strong>巡检执行计划待启动</strong><span>{{ workspace.summary.totalAircraft }} 架航空器 · {{ workspace.summary.totalTaskObjects }} 个任务对象</span><button v-if="workspace.canStart" type="button" class="primary" @click="startRuntime">启动巡检运行</button></div>
      <footer class="runtime-clockbar"><button v-if="workspace?.canControl && ['RUNNING','PAUSED'].includes(workspace.session.status) && project.mode === 'TRAINING'" type="button" :disabled="eventPauseActive" :title="eventPauseActive ? '请先完成当前巡检事件处置' : ''" :aria-label="workspace.session.status === 'RUNNING' ? '暂停仿真' : '继续仿真'" @click="toggleClock"><component :is="workspace.session.status === 'RUNNING' ? VideoPause : VideoPlay" /></button><input :value="workspace?.session.simulationTimeMs ?? 0" type="range" min="0" :max="Math.max(1, workspace?.durationMs ?? 1)" aria-label="巡检仿真时间进度" disabled /><time>{{ formatDuration(workspace?.session.simulationTimeMs ?? 0) }} / {{ formatDuration(workspace?.durationMs ?? 0) }}</time><select v-if="project.mode === 'TRAINING'" v-model.number="clockRate" aria-label="巡检仿真速度" :disabled="!workspace?.canControl || !['RUNNING','PAUSED'].includes(workspace.session.status)" @change="changeClockRate(clockRate)"><option v-for="rate in [1,5,20,60,300,600,1800,3600]" :key="rate" :value="rate">{{ rate }}x</option></select></footer>
    </main>

      <aside class="vtl-event-panel">
      <section class="alert-console"><header><div><Bell /><span><strong>告警与事件</strong><small>{{ activeAlerts.length }} 项待处置</small></span></div><b v-if="unresolvedEvents.length">{{ unresolvedEvents.length }}</b></header><div class="event-list"><button v-for="event in visibleEvents" :key="event.id" type="button" :class="[event.severity.toLowerCase(), { selected: event.id === selectedEvent?.id, resolved: event.status === 'RESOLVED' }]" :aria-pressed="event.id === selectedEvent?.id" @click="eventSelected(event)"><i /><div><strong>{{ event.title }}</strong><small>{{ runtimeEventSource('VTOL_INSPECTION', event.category, event.code) }} · {{ runtimeAlertSeverityLabel(event.severity) }} · {{ eventAttentionLabel(event) }} · {{ event.affectedAircraftIds.length }} 架 · {{ eventTiming(event).label }}</small></div><em>{{ formatDuration(event.triggeredAtMs) }}</em></button><p v-if="visibleEvents.length === 0" class="event-empty" role="status"><strong>{{ workspace?.session.status === 'READY' ? '运行尚未启动' : '当前没有已发现事件' }}</strong><span>{{ workspace?.session.status === 'READY' ? '启动巡检运行后，系统会根据仿真进程显示事件和告警。' : workspace?.session.status === 'COMPLETED' ? '本次运行未产生需要展示的事件。' : '继续运行并关注告警栏，系统发现异常后会在这里显示。' }}</span></p></div><article v-if="selectedEvent" class="event-detail"><header><span>{{ runtimeEventSource('VTOL_INSPECTION', selectedEvent.category, selectedEvent.code) }} · {{ runtimeEventCategoryLabel('VTOL_INSPECTION', selectedEvent.category) }}</span><b>{{ eventAttentionLabel(selectedEvent) }}</b></header><strong>{{ selectedEvent.title }}</strong><p>{{ selectedEvent.detail }}</p><small>影响：{{ selectedEvent.affectedAircraftIds.join('、') || '全局' }}</small><small class="event-timing" :class="eventTiming(selectedEvent).tone">处置时限：{{ eventTiming(selectedEvent).label }}</small><small class="event-recommendation">建议动作：{{ eventRecommendedAction(selectedEvent) }}</small></article></section>

      <section v-if="workspace?.canControl && !isHistoricalAttempt" ref="actionConsole" class="student-action-console">
        <header><strong>学生应急处置</strong><span>学生</span></header>
        <div v-if="selectedEvent" class="runtime-selected-alert">
          <header><span>当前处置事件</span><em :class="eventTiming(selectedEvent).tone">{{ eventAttentionLabel(selectedEvent) }}</em></header>
          <strong>{{ selectedEvent.title }}</strong>
          <p>{{ selectedEvent.detail }}</p>
          <small>影响 {{ selectedEvent.affectedAircraftIds.join('、') || '全局运行' }} · {{ eventTiming(selectedEvent).label }}</small>
          <small><b>推荐动作</b> {{ eventRecommendedAction(selectedEvent) }}</small>
        </div>
        <article v-if="selectedEventBriefing" class="vtl-event-briefing" aria-label="NPC 业务简报">
          <header><strong>系统角色任务</strong></header>
          <dl>
            <div class="briefing-role"><dt>业务角色</dt><dd>{{ selectedEventBriefing.role }}</dd></div>
            <div class="briefing-request"><dt>业务请求</dt><dd>{{ selectedEventBriefing.request }}</dd></div>
            <div class="briefing-impact"><dt>影响对象</dt><dd>{{ selectedEventBriefing.impact }}</dd></div>
            <div class="briefing-objective"><dt>处置目标</dt><dd>{{ selectedEventBriefing.objective }}</dd></div>
            <div class="briefing-success"><dt>成功判据</dt><dd>{{ selectedEventBriefing.successCriteria }}</dd></div>
            <div class="briefing-deadline"><dt>处置时限</dt><dd>{{ selectedEvent ? eventTiming(selectedEvent).label : '未设置' }}</dd></div>
            <div class="briefing-scoring"><dt>评分关注</dt><dd><span v-for="item in selectedEventBriefing.scoringEvidence" :key="item">{{ item }}</span></dd></div>
          </dl>
        </article>
        <select v-model="selectedActionCode" aria-label="选择应急处置动作" :disabled="selectedEvent?.status === 'RESOLVED'"><option v-for="action in workspace.availableActions" :key="action.code" :value="action.code" :disabled="!action.enabled">{{ action.title }}{{ action.disabledReason ? ` · ${action.disabledReason}` : '' }}</option></select>
        <select v-if="selectedAction && selectedAction.code !== 'ACKNOWLEDGE'" v-model="selectedTargetId" aria-label="选择处置航空器" :disabled="selectedEvent?.status === 'RESOLVED'"><option v-for="aircraft in targetAircraftOptions" :key="aircraft.aircraftId" :value="aircraft.aircraftId">{{ aircraft.aircraftCode }} · {{ statusLabel(aircraft.status) }}</option></select>
        <div v-if="selectedActionCode !== 'ACKNOWLEDGE' && selectedTargetAircraft" class="action-decision-grid">
          <span><small>剩余能量</small><strong>{{ selectedTargetAircraft.remainingEnergyWh.toFixed(0) }} Wh · {{ Math.round(selectedTargetAircraft.remainingEnergyRatio * 100) }}%</strong></span>
          <span><small>剩余任务</small><strong>{{ selectedRemainingTasks.length }} 项</strong></span>
          <span><small>自动备降点</small><strong>{{ selectedLandingSite?.title ?? '当前动作不涉及落点' }}</strong></span>
        </div>
        <div v-if="selectedRemainingTasks.length && selectedActionCode !== 'ACKNOWLEDGE'" class="remaining-task-list"><span v-for="task in selectedRemainingTasks.slice(0, 4)" :key="task.id">{{ task.code }} · {{ task.title }}</span><small v-if="selectedRemainingTasks.length > 4">另有 {{ selectedRemainingTasks.length - 4 }} 项</small></div>
        <select v-if="selectedActionCode === 'TRANSFER_TASK'" v-model="selectedTaskObjectId" aria-label="选择待转移任务" :disabled="selectedEvent?.status === 'RESOLVED'"><option v-for="task in sourceTaskOptions" :key="task.id" :value="task.id">{{ task.code }} · {{ task.title }}</option></select>
        <select v-if="selectedActionCode === 'TRANSFER_TASK'" v-model="destinationAircraftId" aria-label="选择任务接收航空器" :disabled="selectedEvent?.status === 'RESOLVED'"><option v-for="aircraft in destinationAircraftOptions" :key="aircraft.aircraftId" :value="aircraft.aircraftId">转移至 {{ aircraft.aircraftCode }}</option></select>
        <select v-if="selectedActionCode === 'ADJUST_GROUP'" v-model="destinationGroupId" aria-label="选择目标分组" :disabled="selectedEvent?.status === 'RESOLVED'"><option v-for="group in planning?.plan.allocation.groups ?? []" :key="group.id" :value="group.id">调整至 {{ formatVtlGroupCode(group.code) }}</option></select>
        <div class="action-outcome-preview"><small>预期处置结果</small><strong>{{ actionOutcomePreview }}</strong></div>
        <textarea v-model="actionObservation" rows="2" maxlength="1000" aria-label="异常发现" placeholder="异常发现（至少4字）" :disabled="selectedEvent?.status === 'RESOLVED'" />
        <textarea v-model="actionRationale" rows="2" maxlength="1000" aria-label="判断依据" placeholder="判断依据（至少4字）" :disabled="selectedEvent?.status === 'RESOLVED'" />
        <textarea v-model="actionExpectedOutcome" rows="2" maxlength="1000" aria-label="预期处置结果" placeholder="预期结果（至少4字）" :disabled="selectedEvent?.status === 'RESOLVED'" />
        <button type="button" class="primary" :disabled="actionSubmitting || !actionValid || !reasoningValid" :aria-busy="actionSubmitting" @click="executeAction">{{ selectedEvent?.status === 'RESOLVED' ? '该事件已处置' : actionSubmitting ? '提交中...' : '执行处置' }}</button>
        <div v-if="actionError" class="runtime-action-error" role="alert" aria-live="assertive"><span>{{ actionError }}</span><button type="button" :disabled="actionSubmitting" @click="executeAction">重试处置</button></div>
        <article v-if="selectedEventAction" ref="actionResultPanel" class="vtl-action-result" tabindex="-1" aria-label="实际处置结果">
          <header><span>实际影响</span><strong>实际业务后果</strong></header>
          <p v-if="selectedEventConsequences.length === 0">{{ actionResultMessage(selectedEventAction.result) }}</p>
          <ul v-else><li v-for="item in selectedEventConsequences" :key="item">{{ item }}</li></ul>
          <div class="vtl-action-evidence"><small>评分证据</small><span v-for="item in selectedEventEvidence" :key="item">{{ item }}</span><em v-if="selectedEventEvidence.length === 0">暂无时效或事件控制证据</em></div>
        </article>
      </section>

      <section v-if="workspace?.canTeacherIntervene && !isHistoricalAttempt" class="teacher-event-console"><header><strong>教师事件注入</strong><span>教师</span></header><select v-model="teacherEventCode"><option v-for="event in eventOptions" :key="event[0]" :value="event[0]">{{ event[1] }}</option></select><button type="button" @click="triggerTeacherEvent"><Warning />立即触发</button></section>

      <section class="action-decision-log"><header><strong>应急处置决策</strong><span>{{ workspace?.actions.length ?? 0 }}</span></header><ol><li v-for="action in [...(workspace?.actions ?? [])].reverse().slice(0, 8)" :key="action.id"><time>{{ formatDuration(action.simulationTimeMs) }}</time><div><strong>{{ actionLabel(action.actionCode) }}</strong><small>{{ actionResultMessage(action.result) }}</small><template v-if="runtimeActionReasoning(action.payload)"><span>发现：{{ runtimeActionReasoning(action.payload)?.observation }}</span><span>判断：{{ runtimeActionReasoning(action.payload)?.rationale }}</span><span>预期：{{ runtimeActionReasoning(action.payload)?.expectedOutcome }}</span></template></div></li></ol><p v-if="!workspace?.actions.length">暂无处置决策</p></section>
      <section class="reorganization-log"><header><strong>动态集群重组</strong><span>{{ workspace?.reorganizations.length ?? 0 }}</span></header><ol><li v-for="record in [...(workspace?.reorganizations ?? [])].reverse().slice(0, 8)" :key="record.id"><time>{{ formatDuration(record.executedAtMs) }}</time><div><strong>{{ actionLabel(record.action) }}</strong><small>{{ record.message }}</small></div><CircleCheck v-if="record.checkPassed" /></li></ol><p v-if="!workspace?.reorganizations.length">暂无重组记录</p></section>
      <button v-if="canCompleteEmergency" type="button" class="complete-emergency" :disabled="loading" :aria-busy="loading" @click="completeEmergency"><CircleCheck />{{ loading ? '正在进入复盘...' : '完成事件处置并进入复盘' }}</button>
    </aside>
  </section>
</template>

<style scoped>
.vtl-runtime-workspace{grid-column:2/4;grid-row:2/4;display:grid;grid-template-columns:minmax(220px,260px) minmax(420px,1fr) minmax(300px,360px);grid-template-rows:72px minmax(0,1fr);min-width:0;min-height:0;overflow:hidden;background:#eef3f0;color:#203d33}
.vtl-runtime-commandbar{grid-column:1/-1;grid-row:1;display:grid;grid-template-columns:minmax(210px,1fr) auto auto;align-items:center;gap:12px;border-bottom:1px solid #c8d5ce;padding:9px 13px;background:#f8faf9;min-width:0}
.vtl-runtime-commandbar>div:first-child{display:grid;gap:2px;min-width:0}.vtl-runtime-commandbar>div:first-child span{color:#287252;font-size: 11px;font-weight:800;letter-spacing:.08em}.vtl-runtime-commandbar>div:first-child strong{overflow:hidden;color:#193f32;font-size:15px;text-overflow:ellipsis;white-space:nowrap}.vtl-runtime-commandbar>div:first-child small{overflow:hidden;color:#6b8177;font-size: 11px;text-overflow:ellipsis;white-space:nowrap}
.vtl-attempt-select{display:grid;grid-template-columns:auto minmax(130px,190px);align-items:center;gap:6px}.vtl-attempt-select label{color:#6b8177;font-size: 11px}.vtl-attempt-select select,.vtl-runtime-commandbar select,.runtime-clockbar select{min-width:0;height:28px;border:1px solid #c4d2ca;padding:0 6px;background:#fff;color:#2b4e40;font:inherit;font-size: 11px}
.vtl-runtime-commandbar dl{display:grid;grid-template-columns:repeat(4,auto);gap:1px;margin:0;background:#d8e3dd}.vtl-runtime-commandbar dl div{display:grid;gap:2px;min-width:52px;padding:5px 7px;background:#fff}.vtl-runtime-commandbar dt{color:#71847b;font-size: 11px}.vtl-runtime-commandbar dd{margin:0;color:#274d3e;font-size:11px;font-weight:800}.vtl-runtime-commandbar dd.danger{color:#aa413b}
.vtl-runtime-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}.vtl-runtime-actions button,.student-action-console button,.teacher-event-console button,.complete-emergency{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:28px;border:1px solid #b8cbc1;padding:0 8px;background:#fff;color:#2b5444;font:inherit;font-size: 11px;cursor:pointer}.vtl-runtime-actions button.primary,.student-action-console button.primary,.complete-emergency{border-color:#246d50;background:#246d50;color:#fff}.vtl-runtime-actions button svg,.teacher-event-console button svg,.complete-emergency svg{width:13px}.stream-state{display:inline-flex;align-items:center;gap:4px;color:#60766b;font-size: 11px;white-space:nowrap}.stream-state i{width:7px;height:7px;border-radius:50%;background:#9aa9a2}.stream-state.live i{background:#2b865d}.stream-state.reconnecting i,.stream-state.fallback i{background:#bb8125}.stream-state.closed i{background:#a7463f}
.vtl-situation-panel,.vtl-event-panel{min-height:0;overflow:auto;background:#f9fbfa}.vtl-situation-panel{grid-column:1;grid-row:2;border-right:1px solid #c8d5ce}.vtl-event-panel{grid-column:3;grid-row:2;border-left:1px solid #c8d5ce}.vtl-runtime-map{position:relative;grid-column:2;grid-row:2;min-width:0;min-height:0;overflow:hidden;background:#dce3de}.vtl-runtime-map :deep(.v3-region-map-shell){min-height:0}.vtl-runtime-map :deep(.v3-map-view-controls){top:12px;right:12px}.map-situation-badge{position:absolute;z-index:3;top:12px;left:12px;display:grid;gap:2px;max-width:calc(100% - 78px);border:1px solid rgba(255,255,255,.75);padding:7px 9px;background:rgba(255,255,255,.91);box-shadow:0 3px 10px rgba(22,55,42,.14)}.map-situation-badge span{color:#287252;font-size: 11px;font-weight:800}.map-situation-badge strong{overflow:hidden;color:#294d3f;font-size: 11px;text-overflow:ellipsis;white-space:nowrap}.runtime-start-overlay{position:absolute;z-index:4;inset:0;display:grid;align-content:center;justify-items:center;gap:8px;background:rgba(235,242,238,.86);backdrop-filter:blur(3px)}.runtime-start-overlay .el-icon{color:#247354;font-size:34px}.runtime-start-overlay strong{font-size:15px}.runtime-start-overlay span{color:#657970;font-size: 11px}.runtime-clockbar{position:absolute;z-index:5;right:10px;bottom:10px;left:10px;display:grid;grid-template-columns:28px minmax(80px,1fr) auto auto;align-items:center;gap:7px;border:1px solid rgba(187,203,194,.92);padding:6px 8px;background:rgba(249,251,250,.94);box-shadow:0 4px 12px rgba(28,55,44,.12)}.runtime-clockbar button{display:grid;width:26px;height:26px;place-items:center;border:1px solid #b8cbc1;background:#fff;color:#246d50;cursor:pointer}.runtime-clockbar button svg{width:13px}.runtime-clockbar input{width:100%;accent-color:#287354}.runtime-clockbar time{color:#4d695c;font-size: 11px;white-space:nowrap}.runtime-clockbar select{height:26px}
.situation-segments{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;padding:8px;background:#d5e0da}.situation-segments button{min-height:28px;border:0;color:#60766c;background:#f8faf9;font:inherit;font-size: 11px;cursor:pointer}.situation-segments button.active{color:#fff;background:#2b7658;font-weight:800}.overall-situation,.group-list,.aircraft-list{border-bottom:1px solid #d5e0da}.overall-situation{display:grid;gap:9px;padding:11px}.overall-situation header,.group-list>header,.aircraft-list>header{display:flex;align-items:end;justify-content:space-between;gap:8px}.overall-situation header span,.group-list>header span,.aircraft-list>header span{color:#71847c;font-size: 11px}.overall-situation header strong,.group-list>header strong,.aircraft-list>header strong{font-size:10px}.situation-kpis{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:#d8e3dd}.situation-kpis span{display:grid;gap:2px;padding:7px;background:#fff;color:#71847c;font-size: 11px}.situation-kpis b{color:#2b6f53;font-size:13px}.phase-distribution{display:grid;gap:3px}.phase-distribution div{display:flex;justify-content:space-between;color:#60766c;font-size: 11px}.phase-distribution b{color:#284e40}.group-list>header,.aircraft-list>header{padding:10px 11px 7px}.group-list>button,.aircraft-list>button{position:relative;display:grid;width:100%;min-height:46px;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px;border:0;border-top:1px solid #e0e7e3;padding:6px 10px;text-align:left;background:transparent;color:#284b3d;cursor:pointer}.group-list>button:hover,.aircraft-list>button:hover,.group-list>button.selected,.aircraft-list>button.selected{background:#e7f1ec}.group-list>button>div,.aircraft-list>button>div{display:grid;gap:2px;min-width:0}.group-list button strong,.aircraft-list button strong{overflow:hidden;font-size: 11px;text-overflow:ellipsis;white-space:nowrap}.group-list button small,.aircraft-list button small{overflow:hidden;color:#71847c;font-size: 11px;text-overflow:ellipsis;white-space:nowrap}.group-list button em,.aircraft-list button em{font-size: 11px;font-style:normal}.group-list button i{position:absolute;right:0;bottom:0;left:0;height:2px;background:#2b7658}.aircraft-list button i{width:7px;height:7px;border-radius:50%;background:#2b7658}.aircraft-list button.waiting i,.aircraft-list button.holding i{background:#b47c26}.aircraft-list button.returning i,.aircraft-list button.diverting i{background:#b47c26}.aircraft-list button.landed i{background:#6c8b7c}.aircraft-list button.cancelled i{background:#b2453e}
.alert-console,.student-action-console,.teacher-event-console,.action-decision-log,.reorganization-log{border-bottom:1px solid #d5e0da;padding:10px 11px}.alert-console>header,.student-action-console>header,.teacher-event-console>header,.action-decision-log>header,.reorganization-log>header{display:flex;align-items:center;justify-content:space-between;gap:7px;margin-bottom:8px}.alert-console>header>div{display:flex;align-items:center;gap:6px}.alert-console>header svg{width:14px;color:#b27a23}.alert-console>header span{display:grid;gap:2px}.alert-console>header strong,.student-action-console>header strong,.teacher-event-console>header strong,.action-decision-log>header strong,.reorganization-log>header strong{font-size:10px}.alert-console>header small,.student-action-console>header span,.teacher-event-console>header span,.action-decision-log>header span,.reorganization-log>header span{color:#71847c;font-size: 11px}.alert-console>header>b{display:grid;min-width:18px;height:18px;place-items:center;border-radius:10px;background:#b44942;color:#fff;font-size: 11px}.event-list{display:grid;gap:4px}.event-list>button{display:grid;grid-template-columns:7px minmax(0,1fr) auto;align-items:start;gap:6px;width:100%;border:1px solid #d5e0da;padding:7px;text-align:left;background:#fff;color:#284b3d;cursor:pointer}.event-list>button.selected{border-color:#b67b20;background:#fffaf0}.event-list>button.resolved{border-left:3px solid #3d8063}.event-list>button>i{width:7px;height:7px;margin-top:3px;border-radius:50%;background:#bb8125}.event-list>button.critical>i,.event-list>button.error>i{background:#b3443d}.event-list>button>div{display:grid;gap:2px;min-width:0}.event-list>button strong{overflow:hidden;font-size: 11px;text-overflow:ellipsis;white-space:nowrap}.event-list>button small{color:#71847c;font-size: 11px;line-height:1.35}.event-list>button em{color:#71847c;font-size: 11px;font-style:normal;white-space:nowrap}.event-empty{display:grid;gap:4px;margin:0;border:1px dashed #c8d5ce;padding:11px;color:#71847c}.event-empty strong{font-size: 11px}.event-empty span{font-size: 11px;line-height:1.45}.event-detail{display:grid;gap:5px;margin-top:8px;border-left:3px solid #b67b20;padding:8px;background:#fffaf0}.event-detail header{display:flex;justify-content:space-between;gap:6px}.event-detail header span,.event-detail header b,.event-detail small{color:#71847c;font-size: 11px}.event-detail>strong{font-size:10px}.event-detail>p{margin:0;color:#526b60;font-size: 11px;line-height:1.45}.event-detail .danger{color:#a64038;font-weight:700}.event-detail .warning{color:#9a6b20;font-weight:700}
.student-action-console{display:grid;gap:7px;background:#f4f8f6}.student-action-console>select,.teacher-event-console select,.student-action-console textarea{width:100%;box-sizing:border-box;border:1px solid #c8d5ce;padding:6px;background:#fff;color:#284a3d;font:inherit;font-size: 11px}.student-action-console textarea{min-height:42px;resize:vertical}.teacher-event-console{display:grid;gap:6px}.teacher-event-console select{height:28px}.action-decision-log ol,.reorganization-log ol{display:grid;gap:5px;margin:0;padding:0;list-style:none}.action-decision-log li,.reorganization-log li{display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:6px;border-top:1px solid #e0e7e3;padding-top:5px}.action-decision-log time,.reorganization-log time{color:#71847c;font-size: 11px}.action-decision-log li div,.reorganization-log li div{display:grid;gap:2px;min-width:0}.action-decision-log li strong,.reorganization-log li strong{font-size: 11px}.action-decision-log li small,.reorganization-log li small,.action-decision-log li span{color:#71847c;font-size: 11px;line-height:1.35}.action-decision-log li svg{width:12px;color:#2b7658}.complete-emergency{width:calc(100% - 22px);margin:11px}.runtime-selected-alert{border:1px solid #d6e0db}
.event-pause-state span{display:grid;min-width:0;gap:2px}.event-pause-state strong{font-size:10px;line-height:1.25}.event-pause-state small{color:#8b6c37;font-size: 11px;line-height:1.35}.vtl-runtime-actions button:disabled,.runtime-clockbar button:disabled{opacity:.45;cursor:not-allowed}.event-pause-state{display:flex;align-items:flex-start;min-width:0;max-width:250px;gap:5px;padding:4px 6px;border:1px solid #e4c98d;background:#fff8e8;color:#8d641e;font-size: 11px;line-height:1.35}.event-pause-state svg{flex:0 0 auto;width:14px;margin-top:1px}
.action-decision-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}.action-decision-grid span{display:grid;gap:2px;padding:6px;border:1px solid #d2ddd7;background:#fff}.action-decision-grid span:last-child{grid-column:1/-1}.action-decision-grid small,.action-outcome-preview small{color:#71847c;font-size: 11px}.action-decision-grid strong{font-size: 11px}.remaining-task-list{display:flex;flex-wrap:wrap;gap:4px}.remaining-task-list span{padding:3px 5px;background:#e9f1ed;color:#35584a;font-size: 11px}.remaining-task-list small{color:#71847c;font-size: 11px}.action-outcome-preview{display:grid;gap:3px;padding:7px;border-left:3px solid #2b7658;background:#edf4f0}.action-outcome-preview strong{font-size: 11px;line-height:1.5}
.vtl-event-briefing,.vtl-action-result{display:grid;gap:7px;padding:8px;border:1px solid #cad8d1;background:#fff}.vtl-event-briefing>header,.vtl-action-result>header{display:flex;align-items:center;justify-content:space-between}.vtl-event-briefing>header span,.vtl-action-result>header span{color:#71847c;font-size: 11px}.vtl-event-briefing>header strong,.vtl-action-result>header strong{font-size: 11px}.vtl-event-briefing dl{display:grid;gap:1px;margin:0;background:#d7e0dc}.vtl-event-briefing dl div{display:grid;grid-template-columns:58px minmax(0,1fr);gap:7px;padding:6px;background:#f8faf9}.vtl-event-briefing dt,.vtl-event-briefing dd{margin:0;font-size: 11px;line-height:1.45}.vtl-event-briefing dt{color:#71847c}.vtl-event-briefing dd{font-weight:600;overflow-wrap:anywhere}.vtl-event-briefing .briefing-scoring dd{display:flex;flex-wrap:wrap;gap:3px}.vtl-event-briefing .briefing-scoring span,.vtl-action-evidence span{padding:2px 4px;background:#e5f0ea;color:#315f4c;font-size: 11px;font-weight:600}.vtl-action-result{border-left:3px solid #287354;background:#f5faf7}.vtl-action-result:focus{outline:2px solid #287354;outline-offset:2px}.vtl-action-result p,.vtl-action-result ul{margin:0;color:#38594c;font-size: 11px;line-height:1.5}.vtl-action-result ul{display:grid;gap:3px;padding-left:15px}.vtl-action-evidence{display:flex;flex-wrap:wrap;align-items:center;gap:4px}.vtl-action-evidence small{width:100%;color:#71847c;font-size: 11px}.vtl-action-evidence em{color:#71847c;font-size: 11px;font-style:normal}
.event-timing.warning{color:#9a6b20;font-weight:700}.event-timing.danger{color:#a64038;font-weight:700}.event-recommendation{color:#315f4c!important}.runtime-selected-alert{display:grid;gap:4px;border-left:3px solid #bb8125;padding:7px 8px;background:#f4f8f6}.runtime-selected-alert>header{display:flex;align-items:center;justify-content:space-between}.runtime-selected-alert>header span,.runtime-selected-alert>header em{color:#71847b;font-size: 11px;font-style:normal}.runtime-selected-alert>header em.warning{color:#98671d}.runtime-selected-alert>header em.danger{color:#a23f38;font-weight:700}.runtime-selected-alert>strong{font-size: 11px}.runtime-selected-alert>p,.runtime-selected-alert>small{margin:0;color:#667b71;font-size: 11px;line-height:1.4}.runtime-selected-alert>small b{color:#315f4c}
.aircraft-detail-panel{display:grid;gap:7px;padding:11px;border-bottom:1px solid #d3ddd8;background:#eef5f1}.aircraft-detail-panel>header{display:flex;align-items:center;justify-content:space-between}.aircraft-detail-panel>header span{color:#71847c;font-size: 11px}.aircraft-detail-panel>header strong{font-size:10px}.aircraft-detail-panel dl{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin:0;background:#d2ddd7}.aircraft-detail-panel dl div{display:grid;gap:2px;padding:6px;background:#fff}.aircraft-detail-panel dt,.aircraft-detail-panel dd{margin:0;font-size: 11px}.aircraft-detail-panel dt{color:#71847c}.aircraft-detail-panel dd{font-weight:700;overflow-wrap:anywhere}.aircraft-task-summary{display:grid;gap:3px;border-left:3px solid #2b7658;padding:6px 7px;background:#fff}.aircraft-task-summary.next{border-left-color:#9b7627}.aircraft-task-summary span{color:#71847c;font-size: 11px}.aircraft-task-summary strong{font-size: 11px;line-height:1.4;overflow-wrap:anywhere}
.runtime-action-error{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1px solid #e3b8b3;border-left:3px solid #b64e44;padding:7px 8px;background:#fff6f5;color:#8c3933;font-size: 11px;line-height:1.4}
.runtime-load-error{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid #e2b7b2;padding:8px 12px;background:#fff7f6;color:#783f39}.runtime-load-error span{display:grid;gap:2px;min-width:0}.runtime-load-error strong{font-size:10px}.runtime-load-error small{font-size: 11px;line-height:1.4;overflow-wrap:anywhere}.runtime-load-error button{flex:0 0 auto;height:26px;border:1px solid #b37a34;padding:0 9px;background:#fff;color:#80521d;font-size: 11px;cursor:pointer}.runtime-load-error button:disabled{cursor:not-allowed;opacity:.5}
.vtl-runtime-quick-nav{display:none}
@media (max-width:680px){.vtl-runtime-quick-nav{position:sticky;top:0;z-index:8;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;border-bottom:1px solid #cbd9d2;padding:5px 7px;background:rgba(248,251,249,.96);backdrop-filter:blur(5px)}.vtl-runtime-quick-nav button{min-height:30px;border:1px solid #c8d8cf;background:#fff;color:#315c49;font:inherit;font-size: 11px}.vtl-runtime-quick-nav button span{display:inline-grid;min-width:15px;margin-left:3px;border-radius:8px;background:#b44942;color:#fff;font-size: 11px}.vtl-situation-panel,.vtl-runtime-map,.vtl-event-panel,.student-action-console{scroll-margin-top:42px}}
@media (max-width:1180px){.vtl-runtime-workspace{grid-template-columns:230px minmax(360px,1fr) 300px}.vtl-runtime-commandbar{grid-template-columns:minmax(180px,1fr) auto}.vtl-runtime-commandbar dl{display:none}}
@media (max-width:900px){.vtl-runtime-workspace{grid-column:2/4;grid-row:2/4;grid-template-columns:1fr;grid-template-rows:auto 41px 440px 300px 520px;overflow:auto;scroll-behavior:smooth;scroll-padding-top:120px}.vtl-runtime-commandbar{position:sticky;top:0;z-index:8;grid-column:1;grid-row:1;grid-template-columns:minmax(0,1fr) auto;box-shadow:0 4px 12px rgba(18,51,40,.12)}.vtl-runtime-actions{grid-column:1/-1;justify-content:flex-start;overflow-x:auto}.vtl-runtime-commandbar .vtl-attempt-select{grid-column:2;grid-row:1}.vtl-runtime-quick-nav{grid-column:1;grid-row:2;display:grid;position:sticky;top:0;z-index:9}.vtl-runtime-quick-nav button{min-height:30px}.vtl-situation-panel{grid-column:1;grid-row:4;min-height:0;overflow:auto;border-right:0;border-top:1px solid #c8d5ce}.vtl-runtime-map{grid-column:1;grid-row:3}.vtl-event-panel{grid-column:1;grid-row:5;min-height:0;overflow:auto;border-top:1px solid #c8d5ce;border-left:0}.runtime-clockbar{position:sticky;bottom:8px}.vtl-runtime-commandbar dl{display:none}}
@media (max-width:680px){.vtl-runtime-workspace{grid-column:1;grid-row:3/5;grid-template-rows:auto 41px 360px 300px 560px}.vtl-runtime-commandbar{grid-template-columns:minmax(0,1fr);gap:6px;padding:8px 9px}.vtl-runtime-commandbar .vtl-attempt-select{grid-column:1;grid-row:auto;grid-template-columns:auto minmax(0,1fr)}.vtl-runtime-actions{grid-column:1;flex-wrap:wrap}.vtl-runtime-actions .event-pause-state{order:-1;max-width:none;flex:1 0 100%}.vtl-runtime-commandbar>div:first-child strong{font-size:13px}.map-situation-badge{top:8px;left:8px}.runtime-clockbar{right:7px;bottom:7px;left:7px;grid-template-columns:28px minmax(60px,1fr);gap:5px}.runtime-clockbar time{grid-column:2;font-size: 11px}.runtime-clockbar select{grid-column:1/-1;width:100%}.situation-kpis{grid-template-columns:repeat(4,1fr)}.situation-kpis span{padding:6px 4px}.situation-kpis b{font-size:11px}.vtl-runtime-map :deep(.v3-region-map-shell){min-height:0}}
@media (prefers-reduced-motion:reduce){.vtl-runtime-workspace{scroll-behavior:auto}}

@media (max-width: 1080px) {
  .vtl-runtime-workspace { grid-column: 2 / 4; grid-row: 2 / 4; grid-template-columns: 1fr; grid-template-rows: auto 41px 420px 300px 500px; overflow: auto; scroll-padding-top: 120px; }
  .vtl-runtime-commandbar { grid-column: 1; grid-row: 1; position: sticky; top: 0; z-index: 8; grid-template-columns: minmax(0, 1fr) auto; }
  .vtl-runtime-quick-nav { grid-column: 1; grid-row: 2; display: grid; position: sticky; top: 0; z-index: 9; }
  .vtl-runtime-map { grid-column: 1; grid-row: 3; }
  .vtl-situation-panel { grid-column: 1; grid-row: 4; border-top: 1px solid #c8d5ce; border-right: 0; overflow: auto; }
  .vtl-event-panel { grid-column: 1; grid-row: 5; border-top: 1px solid #c8d5ce; border-left: 0; overflow: auto; }
}
@media (max-width: 760px) {
  .vtl-runtime-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-rows: auto 41px 360px 300px 500px; }
}
@media (max-width: 420px) {
  .vtl-runtime-workspace { grid-template-rows: auto 41px 320px 300px 500px; }
  .vtl-runtime-commandbar { grid-template-columns: minmax(0, 1fr); }
  .vtl-runtime-commandbar .vtl-attempt-select { grid-column: 1; }
  .vtl-runtime-actions { justify-content: flex-start; flex-wrap: wrap; }
  .situation-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

</style>
