<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Bell, CircleCheck, Clock, Close, EditPen, FullScreen, MapLocation, Refresh, Tickets, Van, VideoPlay, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  LogisticsRuntimeActionCode,
  LogisticsRuntimeAvailableActionView,
  LogisticsRuntimeWorkspaceView,
  LogisticsScheduleItemInput,
  LogisticsSchedulingOrderPriority,
  StudentProjectStageView,
  StudentProjectView,
  V3RegionCatalogItem,
  V3RuntimeAlertView,
  V3RuntimeActionReasoning,
  V3StudentRuntimeActionView
} from "@wurenji/shared"
import { api } from "../api"
import { createClientId } from "../client-id"
import { openRuntimeStream, type RuntimeStreamConnectionState, type RuntimeStreamController } from "../runtime-stream"
import { logisticsDestinationLabel, logisticsRuntimeMonitorMetrics, logisticsTaskTimingPresentation, sortLogisticsRuntimeTasks } from "../logistics-runtime-monitor"
import { runtimeEventCategoryLabel, runtimeEventSource } from "../runtime-event-source"
import { shouldApplyRuntimeWorkspace } from "../runtime-workspace-consistency"
import {
  advanceRuntimePlaybackTime,
  projectLogisticsRuntimePlayback,
  runtimeTimelineMarkers,
  type RuntimeTimelineMarker
} from "../runtime-playback"
import type { V3MapDataState } from "../map-loading-state"
import {
  advanceV3OperationProgress,
  completeV3OperationProgress,
  failV3OperationProgress,
  startV3OperationProgress,
  type V3OperationProgressState
} from "../operation-progress"
import { runtimeActionReasoning, runtimeActionResultLabel } from "../runtime-action-reasoning"
import { eligibleRuntimeRoutesForTarget, eligibleRuntimeTargets, runtimeActionOptionLabel } from "../runtime-action-targets"
import { latestRuntimeAction, pickRecommendedRuntimeAction, pickRuntimeTargetId, preferredRuntimeAlertId, runtimeAlertSeverityLabel, runtimeAlertStatusLabel, runtimeAlertTiming, runtimeRecommendedActionLabel } from "../runtime-alert-presentation"
import { logisticsActionBusinessConsequences, logisticsActionEvidence, logisticsEventBriefing } from "../logistics-runtime-briefing"
import { formatAircraftModelCode, formatRuntimeSessionStatus, formatScaleTemplateCode, formatSubmissionStatus, formatValidationStatus } from "../terminology"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3RuntimePlaybackBar from "./V3RuntimePlaybackBar.vue"
import V3OperationProgress from "./V3OperationProgress.vue"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
  region: V3RegionCatalogItem | null
  mapMode: "2d" | "3d"
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
const workspace = shallowRef<LogisticsRuntimeWorkspaceView | null>(null)
const selectedAircraftId = ref("")
const selectedOrderId = ref("")
const selectedRouteId = ref("")
const selectedAlertId = ref("")
const selectedEventId = ref("")
const selectedActionCode = ref<LogisticsRuntimeActionCode | "">("")
const selectedTargetId = ref("")
const selectedReplacementRouteId = ref("")
const selectedReplacementAircraftId = ref("")
const selectedPriority = ref<LogisticsSchedulingOrderPriority>("NORMAL")
const actionSpeedFactor = ref(1.5)
const actionDelayMinutes = ref(5)
const teacherEventId = ref("")
const teacherHint = ref("")
const clockRate = ref(60)
const playbackTimeMs = ref(0)
const replayRate = ref(1)
const replayPlaying = ref(false)
const dynamicDrawerVisible = ref(false)
const dynamicItems = ref<LogisticsScheduleItemInput[]>([])
const dynamicMode = ref<"SINGLE" | "BATCH" | "GLOBAL">("SINGLE")
const dynamicReason = ref("")
const selectedDynamicVersionId = ref("")
const selectedRestartNodeCode = ref("")
const actionObservation = ref("")
const actionRationale = ref("")
const actionExpectedOutcome = ref("")
const actionSubmitting = ref(false)
const actionError = ref("")
const failedAction = ref<{
  actionCode: LogisticsRuntimeActionCode
  targetId: string | null
  eventId: string | null
  alertId: string | null
  reasoning: V3RuntimeActionReasoning
  payload: Record<string, unknown>
} | null>(null)
const dynamicProgress = ref<V3OperationProgressState | null>(null)
type RuntimeQuickSection = "map" | "fleet" | "missions" | "alerts" | "handling"
const runtimeWorkspaceElement = ref<HTMLElement | null>(null)
const runtimeCommandbarElement = ref<HTMLElement | null>(null)
const runtimeMapPanelElement = ref<HTMLElement | null>(null)
const runtimeFleetPanelElement = ref<HTMLElement | null>(null)
const runtimeControlPanelElement = ref<HTMLElement | null>(null)
const runtimeMissionPanelElement = ref<HTMLElement | null>(null)
const runtimeAlertPanelElement = ref<HTMLElement | null>(null)
const activeQuickSection = ref<RuntimeQuickSection>("map")
const runtimeSideTab = ref<"fleet" | "situation">(
  props.stage.stageCode === "LOGISTICS_EMERGENCY_HANDLING" ? "situation" : "fleet"
)
const mapFullscreen = ref(false)
let runtimeStream: RuntimeStreamController | null = null
let initializationGeneration = 0
let terminalRefreshSent = false
let playbackTimer: number | null = null
let runtimeScrollFrame: number | null = null
let lastPlaybackTick = 0
const playbackTickIntervalMs = 100
const connectionState = ref<RuntimeStreamConnectionState>("CONNECTING")
interface RuntimeMutationResult {
  success: boolean
  error: string | null
}
const connectionStateLabel = computed(() => ({ CONNECTING: "连接中", LIVE: "实时在线", RECONNECTING: "正在重连", FALLBACK: "回退刷新", CLOSED: "已关闭" } as Record<RuntimeStreamConnectionState, string>)[connectionState.value])

const activeSession = computed(() => workspace.value?.session.status === "RUNNING" || workspace.value?.session.status === "PAUSED")
const isHistoricalAttempt = computed(() => Boolean(workspace.value && workspace.value.attempts[0]?.id !== workspace.value.session.id))
const isReplayMode = computed(() => Boolean(workspace.value && (isHistoricalAttempt.value || ["COMPLETED", "ABORTED"].includes(workspace.value.session.status))))
const playbackDurationMs = computed(() => {
  if (!workspace.value) return 1
  if (workspace.value.session.status === "ABORTED" || (isHistoricalAttempt.value && workspace.value.session.status !== "COMPLETED")) {
    return Math.max(1, Number(workspace.value.session.simulationTimeMs))
  }
  return Math.max(1, workspace.value.durationMs)
})
const playbackRate = computed(() => isReplayMode.value ? replayRate.value : clockRate.value)
const playbackPlaying = computed(() => isReplayMode.value ? replayPlaying.value : workspace.value?.session.status === "RUNNING")
const playbackRateOptions = computed(() => isReplayMode.value
  ? playbackDurationMs.value > 3_600_000 ? [1, 60, 300, 600, 3600] : [0.5, 1, 2, 4]
  : [1, 5, 20, 60, 300, 600, 3600])
const playbackMarkers = computed(() => runtimeTimelineMarkers(workspace.value?.events ?? [], playbackDurationMs.value))
const playbackView = computed(() => {
  if (!workspace.value || !isReplayMode.value) return null
  const preserveOperationalState = Math.abs(playbackTimeMs.value - Number(workspace.value.session.simulationTimeMs)) <= 500
  return projectLogisticsRuntimePlayback({
    simulationTimeMs: Number(workspace.value.session.simulationTimeMs),
    tasks: workspace.value.tasks,
    aircraft: workspace.value.aircraft,
    orders: workspace.value.orders,
    routes: workspace.value.routes,
    summary: workspace.value.summary
  }, playbackTimeMs.value, preserveOperationalState)
})
const displayAircraft = computed(() => playbackView.value?.aircraft ?? workspace.value?.aircraft ?? [])
const displayTasks = computed(() => playbackView.value?.tasks ?? workspace.value?.tasks ?? [])
const missionBoardTasks = computed(() => sortLogisticsRuntimeTasks(displayTasks.value))
const displayOrders = computed(() => playbackView.value?.orders ?? workspace.value?.orders ?? [])
const displaySummary = computed(() => playbackView.value?.summary ?? workspace.value?.summary ?? null)
const activeAlerts = computed(() => workspace.value?.alerts.filter((item) => item.status !== "RESOLVED") ?? [])
const recentResolvedAlerts = computed(() => [...(workspace.value?.alerts.filter((item) => item.status === "RESOLVED") ?? [])]
  .sort((left, right) => Number(right.simulationTimeMs ?? 0) - Number(left.simulationTimeMs ?? 0))
  .slice(0, 3))
const displayedAlerts = computed(() => [...activeAlerts.value, ...recentResolvedAlerts.value])
const alertDisplaySignature = computed(() => displayedAlerts.value.map((item) => `${item.id}:${item.status}:${item.eventId}`).join("|"))
const selectedAlert = computed(() => displayedAlerts.value.find((item) => item.id === selectedAlertId.value) ?? activeAlerts.value[0] ?? recentResolvedAlerts.value[0] ?? null)
const selectedAlertEvent = computed(() => workspace.value?.events.find((item) => item.id === selectedAlert.value?.eventId) ?? null)
const selectedAlertAction = computed(() => selectedAlert.value
  ? latestRuntimeAction(workspace.value?.actions ?? [], selectedAlert.value.id, selectedAlert.value.eventId)
  : null)
const selectedAlertBriefing = computed(() => selectedAlertEvent.value
  ? logisticsEventBriefing(selectedAlertEvent.value, alertRecommendedAction(selectedAlert.value!))
  : null)
const selectedAlertConsequences = computed(() => logisticsActionBusinessConsequences(selectedAlertAction.value))
const selectedAlertEvidence = computed(() => logisticsActionEvidence(selectedAlertAction.value))
const selectedEvent = computed(() => workspace.value?.events.find((item) => item.id === selectedEventId.value)
  ?? workspace.value?.events.find((item) => item.id === selectedAlert.value?.eventId)
  ?? null)
const selectedActiveEvent = computed(() => selectedEvent.value && ["DISCOVERED", "HANDLING", "ESCALATED"].includes(selectedEvent.value.lifecycleStatus) ? selectedEvent.value : null)
const selectedAircraft = computed(() => displayAircraft.value.find((item) => item.id === selectedAircraftId.value) ?? null)
const selectedOrder = computed(() => displayOrders.value.find((item) => item.id === selectedOrderId.value) ?? null)
const selectedAircraftTask = computed(() => displayTasks.value.find((item) => item.scheduleItemId === selectedAircraft.value?.currentTaskId) ?? null)
const selectedAircraftNextTask = computed(() => {
  if (!selectedAircraft.value) return null
  const currentTaskId = selectedAircraft.value.currentTaskId
  const currentTimeMs = playbackTimeMs.value
  return [...displayTasks.value]
    .filter((item) => item.aircraftId === selectedAircraft.value?.id
      && item.scheduleItemId !== currentTaskId
      && item.status === "WAITING_EXECUTION"
      && item.plannedTakeoffTimeMs >= currentTimeMs)
    .sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)[0] ?? null
})
const selectedAircraftNextOrder = computed(() => displayOrders.value.find((item) => item.id === selectedAircraftNextTask.value?.orderId) ?? null)
const selectedAircraftNextRoute = computed(() => workspace.value?.routes.find((item) => item.id === selectedAircraftNextTask.value?.outboundRouteId) ?? null)
const selectedAircraftNextTiming = computed(() => selectedAircraft.value && selectedAircraftNextTask.value && selectedAircraftNextOrder.value
  ? logisticsTaskTimingPresentation({
      task: selectedAircraftNextTask.value,
      order: selectedAircraftNextOrder.value,
      aircraft: selectedAircraft.value,
      route: selectedAircraftNextRoute.value,
      simulationTimeMs: playbackTimeMs.value,
      sessionStatus: workspace.value?.session.status ?? "READY"
    })
  : null)
const selectedAircraftOrder = computed(() => displayOrders.value.find((item) => item.id === (selectedAircraft.value?.currentOrderId ?? selectedAircraftTask.value?.orderId)) ?? null)
const selectedAircraftRoute = computed(() => {
  if (!workspace.value || !selectedAircraftTask.value) return null
  const scheduleItem = workspace.value.scheduleItems.find((item) => item.id === selectedAircraftTask.value?.scheduleItemId)
  const fallbackRouteId = ["RETURNING", "LANDING", "AVAILABLE_AGAIN"].includes(selectedAircraftTask.value.status)
    ? scheduleItem?.returnRouteId
    : scheduleItem?.outboundRouteId
  return workspace.value.routes.find((item) => item.id === (selectedAircraftTask.value?.activeRouteId ?? fallbackRouteId)) ?? null
})
const selectedAircraftMonitorMetrics = computed(() => logisticsRuntimeMonitorMetrics({
  aircraft: selectedAircraft.value,
  task: selectedAircraftTask.value,
  route: selectedAircraftRoute.value,
  order: selectedAircraftOrder.value,
  environment: workspace.value?.environment
}))
const selectedAction = computed(() => workspace.value?.availableActions.find((item) => item.code === selectedActionCode.value) ?? null)
const studentActions = computed(() => workspace.value?.availableActions.filter((item) => !["ACKNOWLEDGE_ALERT", "BATCH_REASSIGN", "GLOBAL_RESCHEDULE"].includes(item.code)) ?? [])
const actionTargetAircraft = computed(() => selectedAction.value?.targetType === "AIRCRAFT"
  ? workspace.value?.aircraft.find((item) => item.id === selectedTargetId.value) ?? null
  : null)
const actionTargetOrder = computed(() => {
  if (selectedAction.value?.targetType === "ORDER") return workspace.value?.orders.find((item) => item.id === selectedTargetId.value) ?? null
  if (actionTargetAircraft.value?.currentOrderId) return workspace.value?.orders.find((item) => item.id === actionTargetAircraft.value?.currentOrderId) ?? null
  return selectedOrder.value
})
const scheduledEvents = computed(() => workspace.value?.events.filter((item) => item.lifecycleStatus === "SCHEDULED") ?? [])
const canChangeClock = computed(() => Boolean(activeSession.value && !isHistoricalAttempt.value && workspace.value?.mode === "TRAINING"))
const canCompleteEmergency = computed(() => props.stage.stageCode === "LOGISTICS_EMERGENCY_HANDLING"
  && props.stage.status === "IN_PROGRESS"
  && (workspace.value?.session.status === "COMPLETED" || workspace.value?.session.status === "ABORTED"))
const dynamicModeOptions = computed(() => {
  const options: Array<{ value: "SINGLE" | "BATCH" | "GLOBAL"; label: string }> = [{ value: "SINGLE", label: "单任务调整" }]
  if (workspace.value?.availableActions.some((item) => item.code === "BATCH_REASSIGN" && item.enabled)) options.push({ value: "BATCH", label: "批量重调度" })
  if (workspace.value?.availableActions.some((item) => item.code === "GLOBAL_RESCHEDULE" && item.enabled)) options.push({ value: "GLOBAL", label: "全局重调度" })
  return options
})
const selectedDynamicVersion = computed(() => workspace.value?.dynamicScheduleVersions.find((item) => item.id === selectedDynamicVersionId.value)
  ?? workspace.value?.dynamicScheduleVersions[0]
  ?? null)
const playbackStatusLabel = computed(() => isReplayMode.value
  ? isHistoricalAttempt.value ? `第 ${workspace.value?.session.attemptNo ?? "-"} 次训练` : "本次训练回放"
  : formatRuntimeSessionStatus(workspace.value?.session.status ?? "READY"))
const playbackTimerActive = computed(() => isReplayMode.value || workspace.value?.session.status === "RUNNING")
const targetOptions = computed(() => actionTargets(selectedAction.value))
const replacementRoutes = computed(() => {
  const order = actionTargetOrder.value
  if (!order || !workspace.value) return []
  if (selectedActionCode.value === "SWITCH_VERIFIED_ROUTE") {
    return eligibleRuntimeRoutesForTarget(workspace.value.routes, selectedAction.value?.eligibleRouteIdsByTargetId ?? {}, order.id)
  }
  const task = workspace.value.tasks.find((item) => item.orderId === order.id)
  const currentRoute = workspace.value.routes.find((route) => route.id === (task?.activeRouteId ?? task?.outboundRouteId))
  return workspace.value.routes.filter((route) => {
    if (route.destinationNodeId !== order.destinationNodeId || route.status === "ABNORMAL" || route.status === "CLOSED" || route.status === "PAUSED") return false
    if (selectedActionCode.value === "DIVERT_AIRCRAFT") return route.role === "ALTERNATE" && route.direction === currentRoute?.direction
    return false
  })
})
const replacementAircraftOptions = computed(() => {
  const currentAircraftId = actionTargetAircraft.value?.id ?? actionTargetOrder.value?.assignedAircraftId
  return workspace.value?.aircraft.filter((aircraft) => aircraft.status === "AVAILABLE" && aircraft.id !== currentAircraftId) ?? []
})
const priorityOptions: Array<{ value: LogisticsSchedulingOrderPriority; label: string }> = [
  { value: "NORMAL", label: "普通" },
  { value: "PRIORITY", label: "优先" },
  { value: "URGENT", label: "紧急" }
]
const actionParametersValid = computed(() => {
  if (!selectedActionCode.value || !selectedAction.value?.enabled) return false
  if (selectedAction.value?.requiresTarget && !selectedTargetId.value) return false
  if (selectedActionCode.value === "DELAY_TASK") return actionDelayMinutes.value >= 1
  if (selectedActionCode.value === "REDUCE_SPEED") return actionSpeedFactor.value >= 1.05 && actionSpeedFactor.value <= 3
  if (selectedActionCode.value === "SWITCH_VERIFIED_ROUTE") return replacementRoutes.value.some((route) => route.id === selectedReplacementRouteId.value)
  if (selectedActionCode.value === "DIVERT_AIRCRAFT") return Boolean(selectedReplacementRouteId.value || replacementRoutes.value.length === 0)
  if (selectedActionCode.value === "REPLACE_AIRCRAFT" || selectedActionCode.value === "REASSIGN_ORDER") return Boolean(selectedReplacementAircraftId.value)
  if (selectedActionCode.value === "CHANGE_PRIORITY") return Boolean(selectedPriority.value)
  return true
})
const actionReasoningValid = computed(() => [actionObservation.value, actionRationale.value, actionExpectedOutcome.value].every((item) => item.trim().length >= 4))
const actionSubmissionValid = computed(() => actionParametersValid.value && actionReasoningValid.value && selectedAlert.value?.status !== "RESOLVED")
const recentActions = computed(() => [...(workspace.value?.actions ?? [])].reverse().slice(0, 3))
const studentActionSignature = computed(() => studentActions.value.map((item) => `${item.code}:${item.enabled}`).join("|"))
const targetSignature = computed(() => targetOptions.value.map((item) => item.id).join("|"))
const scheduledEventSignature = computed(() => scheduledEvents.value.map((item) => item.id).join("|"))
const restartNodeSignature = computed(() => (workspace.value?.restartNodes ?? []).map((item) => item.code).join("|"))

onMounted(() => {
  window.addEventListener("keydown", handleMapFullscreenKeydown)
  void initializeRuntimeStream()
})

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleMapFullscreenKeydown)
  initializationGeneration += 1
  runtimeStream?.close()
  stopPlaybackTimer()
  if (runtimeScrollFrame !== null) window.cancelAnimationFrame(runtimeScrollFrame)
})

function handleMapFullscreenKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && mapFullscreen.value) mapFullscreen.value = false
}

watch(() => props.project.id, () => {
  terminalRefreshSent = false
  replayPlaying.value = false
  playbackTimeMs.value = 0
  activeQuickSection.value = "map"
  runtimeStream?.close()
  void initializeRuntimeStream()
})
watch(mapFullscreen, async () => {
  await nextTick()
  window.dispatchEvent(new Event("resize"))
})
watch(playbackTimerActive, (active) => {
  if (active) startPlaybackTimer()
  else stopPlaybackTimer()
})

watch(alertDisplaySignature, () => {
  const items = displayedAlerts.value
  const nextId = preferredRuntimeAlertId(items, selectedAlertId.value)
  if (nextId !== selectedAlertId.value) selectAlert(nextId)
})

watch(studentActionSignature, () => {
  const items = studentActions.value
  if (!items.some((item) => item.code === selectedActionCode.value && item.enabled)) selectedActionCode.value = items.find((item) => item.enabled)?.code ?? ""
})

watch(selectedAction, () => {
  selectedTargetId.value = targetOptions.value[0]?.id ?? ""
  if (selectedAction.value?.targetType === "ORDER") selectedOrderId.value = selectedTargetId.value
  if (selectedAction.value?.targetType === "AIRCRAFT") selectAircraft(selectedTargetId.value)
  refreshActionParameters()
})

watch(selectedTargetId, () => {
  refreshActionParameters()
})

function refreshActionParameters() {
  selectedReplacementRouteId.value = replacementRoutes.value[0]?.id ?? ""
  selectedReplacementAircraftId.value = replacementAircraftOptions.value[0]?.id ?? ""
  selectedPriority.value = actionTargetOrder.value?.priority ?? "NORMAL"
}

watch(targetSignature, () => {
  const items = targetOptions.value
  if (!items.some((item) => item.id === selectedTargetId.value)) selectedTargetId.value = items[0]?.id ?? ""
})

watch(scheduledEventSignature, () => {
  const items = scheduledEvents.value
  if (!items.some((item) => item.id === teacherEventId.value)) teacherEventId.value = items[0]?.id ?? ""
})
watch(restartNodeSignature, () => {
  const nodes = workspace.value?.restartNodes
  if (!nodes?.some((item) => item.code === selectedRestartNodeCode.value)) selectedRestartNodeCode.value = nodes?.[0]?.code ?? ""
})

function runtimeQuickSectionElement(section: RuntimeQuickSection) {
  if (section === "map") return runtimeMapPanelElement.value
  if (section === "fleet") return runtimeFleetPanelElement.value
  if (section === "missions") return runtimeMissionPanelElement.value
  if (section === "alerts") return runtimeAlertPanelElement.value
  return runtimeControlPanelElement.value
}

function jumpToRuntimeSection(section: RuntimeQuickSection) {
  activeQuickSection.value = section
  if (section === "fleet") runtimeSideTab.value = "fleet"
  if (section === "handling") runtimeSideTab.value = "situation"
  void nextTick(() => {
    const container = runtimeWorkspaceElement.value
    const target = runtimeQuickSectionElement(section)
    if (!container || !target) return
    const commandbarHeight = runtimeCommandbarElement.value?.offsetHeight ?? 0
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    container.scrollTo({
      top: Math.max(0, target.offsetTop - commandbarHeight - 8),
      behavior: reduceMotion ? "auto" : "smooth"
    })
    window.requestAnimationFrame(() => {
      target.focus({ preventScroll: true })
      if (section === "handling") revealSelectedActionResult("auto")
    })
  })
}

function revealSelectedActionResult(behavior: ScrollBehavior) {
  const panel = runtimeControlPanelElement.value
  const result = panel?.querySelector<HTMLElement>(".runtime-business-result")
  if (!panel || !result) return
  const panelRect = panel.getBoundingClientRect()
  const resultRect = result.getBoundingClientRect()
  panel.scrollTo({
    top: Math.max(0, panel.scrollTop + resultRect.top - panelRect.top - 8),
    behavior
  })
  window.requestAnimationFrame(() => result.focus({ preventScroll: true }))
}

function onRuntimeWorkspaceScroll() {
  if (window.innerWidth > 860 || runtimeScrollFrame !== null) return
  runtimeScrollFrame = window.requestAnimationFrame(() => {
    runtimeScrollFrame = null
    const commandbarBottom = runtimeCommandbarElement.value?.getBoundingClientRect().bottom ?? 0
    const candidates: Array<[RuntimeQuickSection, HTMLElement | null]> = [
      ["map", runtimeMapPanelElement.value],
      ["fleet", runtimeFleetPanelElement.value],
      ["handling", runtimeControlPanelElement.value],
      ["missions", runtimeMissionPanelElement.value],
      ["alerts", runtimeAlertPanelElement.value]
    ]
    const visible = candidates
      .filter((entry): entry is [RuntimeQuickSection, HTMLElement] => Boolean(entry[1]))
      .map(([section, element]) => ({ section, distance: Math.abs(element.getBoundingClientRect().top - commandbarBottom - 8) }))
      .sort((left, right) => left.distance - right.distance)[0]
    if (visible) activeQuickSection.value = visible.section
  })
}

async function loadWorkspace(showError = true, generation = initializationGeneration) {
  snapshotRequestCount += 1
  snapshotLoading.value = true
  if (showError) loading.value = true
  try {
    const historicalSessionId = isHistoricalAttempt.value ? workspace.value?.session.id : null
    const path = historicalSessionId
      ? `/v3/logistics-projects/${props.project.id}/runtime/attempts/${historicalSessionId}`
      : `/v3/logistics-projects/${props.project.id}/runtime-workspace`
    const value = await api<LogisticsRuntimeWorkspaceView>(path)
    if (generation !== initializationGeneration) return
    applyWorkspace(value, isHistoricalAttempt.value)
    loadError.value = ""
    if ((workspace.value?.session.status === "COMPLETED" || workspace.value?.session.status === "ABORTED") && !terminalRefreshSent) {
      terminalRefreshSent = true
      emit("refreshProject")
    }
  } catch (error) {
    if (showError && generation === initializationGeneration) {
      loadError.value = error instanceof Error ? error.message : "配送运行工作台加载失败"
      ElMessage.error(loadError.value)
    }
  } finally {
    snapshotRequestCount = Math.max(0, snapshotRequestCount - 1)
    snapshotLoading.value = snapshotRequestCount > 0
    if (showError && generation === initializationGeneration) loading.value = false
  }
}

async function initializeRuntimeStream() {
  const generation = ++initializationGeneration
  const projectId = props.project.id
  await loadWorkspace(true, generation)
  if (generation !== initializationGeneration || projectId !== props.project.id) return
  runtimeStream?.close()
  runtimeStream = openRuntimeStream<LogisticsRuntimeWorkspaceView>(
    `/v3/logistics-projects/${projectId}/runtime/stream`,
    (snapshot) => {
      if (generation !== initializationGeneration || projectId !== props.project.id) return
      applyWorkspace(snapshot.workspace)
      if ((snapshot.workspace.session.status === "COMPLETED" || snapshot.workspace.session.status === "ABORTED") && !terminalRefreshSent) {
        terminalRefreshSent = true
        emit("refreshProject")
      }
    },
    (state) => { if (generation === initializationGeneration && projectId === props.project.id) connectionState.value = state },
    () => { if (generation === initializationGeneration && projectId === props.project.id) void loadWorkspace(false, generation) },
    (streamError) => {
      if (generation !== initializationGeneration || projectId !== props.project.id) return
      loadError.value = streamError.error.message
      ElMessage.error(loadError.value)
    }
  )
}

async function reconnectRuntime() {
  if (isReplayMode.value) return
  runtimeStream?.close()
  runtimeStream = null
  connectionState.value = "CONNECTING"
  await initializeRuntimeStream()
}

async function selectAttempt(sessionId: string) {
  const latest = workspace.value?.attempts[0]
  if (!latest || sessionId === latest.id) {
    runtimeStream?.close()
    runtimeStream = null
    await initializeRuntimeStream()
    return
  }
  runtimeStream?.close()
  runtimeStream = null
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${props.project.id}/runtime/attempts/${sessionId}`), true)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "历史训练记录加载失败")
    await initializeRuntimeStream()
  } finally {
    loading.value = false
  }
}

async function restartRuntime() {
  if (!workspace.value?.canRestart || !selectedRestartNodeCode.value || isHistoricalAttempt.value) return
  const node = workspace.value.restartNodes.find((item) => item.code === selectedRestartNodeCode.value)
  if (!node) return
  try {
    await ElMessageBox.confirm(`将从“${node.label}”节点创建第 ${workspace.value.session.attemptNo + 1} 次训练，原有记录会保留为历史记录。`, "确认重新训练", {
      type: "warning",
      confirmButtonText: "创建重训",
      cancelButtonText: "取消"
    })
  } catch {
    return
  }
  await mutate(`/v3/logistics-projects/${props.project.id}/runtime/restart`, {
    expectedRevision: workspace.value.session.revision,
    nodeCode: node.code
  }, `已创建第 ${workspace.value.session.attemptNo + 1} 次训练`)
  emit("refreshProject")
}

function applyWorkspace(value: LogisticsRuntimeWorkspaceView, allowOlderAttempt = false) {
  if (!shouldApplyRuntimeWorkspace(workspace.value, value, { allowOlderAttempt })) return
  loadError.value = ""
  const previousSessionId = workspace.value?.session.id
  const previousStatus = workspace.value?.session.status
  const historical = value.attempts[0]?.id !== value.session.id
  workspace.value = value
  clockRate.value = value.clockRate
  if (props.initialAlertId) {
    const alert = value.alerts.find((item) => item.id === props.initialAlertId)
    if (alert) selectAlert(alert.id)
  }
  if (!value.aircraft.some((item) => item.id === selectedAircraftId.value)) selectedAircraftId.value = value.aircraft[0]?.id ?? ""
  if (!value.orders.some((item) => item.id === selectedOrderId.value)) selectedOrderId.value = value.orders[0]?.id ?? ""
  if (!value.routes.some((item) => item.id === selectedRouteId.value)) selectedRouteId.value = value.routes[0]?.id ?? ""
  if (!value.dynamicScheduleVersions.some((item) => item.id === selectedDynamicVersionId.value)) selectedDynamicVersionId.value = value.dynamicScheduleVersions[0]?.id ?? ""
  if (previousSessionId !== value.session.id) {
    playbackTimeMs.value = historical ? 0 : Number(value.session.simulationTimeMs)
    replayPlaying.value = false
    lastPlaybackTick = performance.now()
    return
  }
  if (historical) return
  if (value.session.status === "PAUSED" || value.session.status === "READY") {
    playbackTimeMs.value = Number(value.session.simulationTimeMs)
  } else if (value.session.status === "RUNNING") {
    const serverTime = Number(value.session.simulationTimeMs)
    const maximumLead = Math.max(1_000, value.clockRate * 1_500)
    if (playbackTimeMs.value < serverTime || playbackTimeMs.value > serverTime + maximumLead) playbackTimeMs.value = serverTime
  } else if (previousStatus === "RUNNING" || previousStatus === "PAUSED") {
    playbackTimeMs.value = Number(value.session.simulationTimeMs)
    replayPlaying.value = false
  }
}

function tickPlayback() {
  const now = performance.now()
  const elapsed = Math.max(0, now - lastPlaybackTick)
  lastPlaybackTick = now
  if (!workspace.value) return
  if (isReplayMode.value) {
    if (!replayPlaying.value) return
    playbackTimeMs.value = advanceRuntimePlaybackTime(playbackTimeMs.value, elapsed, replayRate.value, playbackDurationMs.value)
    if (playbackTimeMs.value >= playbackDurationMs.value) replayPlaying.value = false
    return
  }
  if (workspace.value.session.status === "RUNNING") {
    playbackTimeMs.value = advanceRuntimePlaybackTime(playbackTimeMs.value, elapsed, workspace.value.clockRate, workspace.value.durationMs)
  }
}

function startPlaybackTimer() {
  if (playbackTimer !== null || !playbackTimerActive.value) return
  lastPlaybackTick = performance.now()
  playbackTimer = window.setInterval(tickPlayback, playbackTickIntervalMs)
}

function stopPlaybackTimer() {
  if (playbackTimer !== null) window.clearInterval(playbackTimer)
  playbackTimer = null
}

async function togglePlayback() {
  if (!workspace.value) return
  if (isReplayMode.value) {
    if (playbackTimeMs.value >= playbackDurationMs.value) playbackTimeMs.value = 0
    replayPlaying.value = !replayPlaying.value
    lastPlaybackTick = performance.now()
    return
  }
  if (!canChangeClock.value) return
  await changeClock(workspace.value.session.status === "RUNNING" ? "PAUSED" : "RUNNING", clockRate.value)
}

function restartPlayback() {
  replayPlaying.value = false
  playbackTimeMs.value = 0
  lastPlaybackTick = performance.now()
}

function seekPlayback(timeMs: number) {
  if (!isReplayMode.value) return
  playbackTimeMs.value = Math.max(0, Math.min(playbackDurationMs.value, timeMs))
  lastPlaybackTick = performance.now()
}

async function changePlaybackRate(rate: number) {
  if (!Number.isFinite(rate) || rate <= 0) return
  if (isReplayMode.value) {
    replayRate.value = rate
    return
  }
  if (!workspace.value || !canChangeClock.value) return
  clockRate.value = rate
  await changeClock(workspace.value.session.status as "RUNNING" | "PAUSED", rate)
}

function selectPlaybackMarker(marker: RuntimeTimelineMarker) {
  selectedEventId.value = marker.id
  const alert = workspace.value?.alerts.find((item) => item.eventId === marker.id)
  if (alert) selectedAlertId.value = alert.id
  if (isReplayMode.value) {
    replayPlaying.value = false
    seekPlayback(marker.timeMs)
  }
}

function selectRuntimeEvent(eventId: string) {
  const marker = playbackMarkers.value.find((item) => item.id === eventId)
  if (marker) selectPlaybackMarker(marker)
  else selectedEventId.value = eventId
}

async function startRuntime() {
  if (!workspace.value) return
  try {
    await ElMessageBox.confirm("启动后将以服务端权威时钟执行正式初始调度，并开始记录运行事件与学生处置。", "启动配送运行", {
      type: "warning",
      confirmButtonText: "启动运行",
      cancelButtonText: "返回"
    })
  } catch {
    return
  }
  await mutate(`/v3/logistics-projects/${props.project.id}/runtime/start`, { expectedRevision: workspace.value.session.revision }, "配送运行已启动")
}

async function changeClock(status: "RUNNING" | "PAUSED", rate = clockRate.value) {
  if (!workspace.value || !canChangeClock.value) return
  await mutate(`/v3/logistics-projects/${props.project.id}/runtime/clock`, {
    expectedRevision: workspace.value.session.revision,
    status,
    rate
  }, status === "PAUSED" ? "运行已暂停" : `运行已按 ${rate}x 继续`)
}

async function acknowledgeAlert(alertId: string) {
  const alert = workspace.value?.alerts.find((item) => item.id === alertId)
  if (!workspace.value || !alert) return
  await executeAction("ACKNOWLEDGE_ALERT", alert.id, alert.eventId, alert.id)
}

async function executeSelectedAction() {
  if (!selectedActionCode.value || !selectedAction.value) return
  const targetId = selectedAction.value.requiresTarget ? selectedTargetId.value : null
  const eventId = selectedActiveEvent.value?.id ?? null
  const alertId = selectedAlert.value?.eventId === eventId ? selectedAlert.value.id : null
  await executeAction(selectedActionCode.value, targetId, eventId, alertId)
}

async function retryFailedAction() {
  const command = failedAction.value
  if (!command) return
  if (actionSubmitting.value || !workspace.value) return
  const requestId = createClientId()
  actionError.value = ""
  actionSubmitting.value = true
  const applied = await mutate(`/v3/logistics-projects/${props.project.id}/runtime/actions`, {
    expectedRevision: workspace.value.session.revision,
    actionCode: command.actionCode,
    targetId: command.targetId,
    eventId: command.eventId,
    alertId: command.alertId,
    requestId,
    reasoning: command.reasoning,
    payload: command.payload
  }, `${command.actionCode} 已重新提交`)
  if (applied.success) {
    failedAction.value = null
    clearActionReasoning()
    await nextTick()
    revealSelectedActionResult("auto")
  } else {
    actionError.value = applied.error
      ? `重试处置未成功：${applied.error} 已保留本次判断内容。`
      : "重试处置未成功，已保留本次判断内容。"
  }
  actionSubmitting.value = false
}

async function executeAction(actionCode: LogisticsRuntimeActionCode, targetId: string | null, eventId: string | null, alertId: string | null) {
  if (actionSubmitting.value || !workspace.value) return
  const definition = workspace.value.availableActions.find((item) => item.code === actionCode)
  if (!definition?.enabled && actionCode !== "ACKNOWLEDGE_ALERT") return
  if (!actionReasoningValid.value) return ElMessage.warning("请完整填写异常发现、判断依据和预期结果")
  const reasoning: V3RuntimeActionReasoning = {
    observation: actionObservation.value,
    rationale: actionRationale.value,
    expectedOutcome: actionExpectedOutcome.value
  }
  const payload: Record<string, unknown> = {}
  if (actionCode === "DELAY_TASK") payload.delayMs = actionDelayMinutes.value * 60_000
  if (actionCode === "REDUCE_SPEED") payload.speedFactor = actionSpeedFactor.value
  if (actionCode === "SWITCH_VERIFIED_ROUTE" || actionCode === "DIVERT_AIRCRAFT") payload.routeId = selectedReplacementRouteId.value || null
  if (actionCode === "REPLACE_AIRCRAFT" || actionCode === "REASSIGN_ORDER") payload.aircraftId = selectedReplacementAircraftId.value
  if (actionCode === "CHANGE_PRIORITY") payload.priority = selectedPriority.value
  failedAction.value = { actionCode, targetId, eventId, alertId, reasoning, payload }
  const requestId = createClientId()
  actionError.value = ""
  actionSubmitting.value = true
  const applied = await mutate(`/v3/logistics-projects/${props.project.id}/runtime/actions`, {
    expectedRevision: workspace.value.session.revision,
    actionCode,
    targetId,
    eventId,
    alertId,
    requestId,
    reasoning,
    payload
  }, `${definition?.title ?? "运行处置"}已执行`)
  if (applied.success) {
    failedAction.value = null
    clearActionReasoning()
    await nextTick()
    revealSelectedActionResult("auto")
  } else actionError.value = applied.error
    ? `处置未成功：${applied.error} 已保留本次判断内容，可检查运行状态后重试。`
    : "处置未成功，已保留本次判断内容，请检查运行状态后重试。"
  actionSubmitting.value = false
}

function clearActionReasoning() {
  actionObservation.value = ""
  actionRationale.value = ""
  actionExpectedOutcome.value = ""
}

async function triggerTeacherEvent() {
  if (!workspace.value || !teacherEventId.value) return
  await mutate(`/v3/logistics-projects/${props.project.id}/runtime/events/${teacherEventId.value}/trigger`, {
    expectedRevision: workspace.value.session.revision,
    requestId: createClientId()
  }, "训练事件已触发")
}

async function sendTeacherHint() {
  if (!workspace.value || !teacherHint.value.trim()) return
  await mutate(`/v3/logistics-projects/${props.project.id}/runtime/hints`, {
    expectedRevision: workspace.value.session.revision,
    message: teacherHint.value
  }, "训练提示已发送")
  teacherHint.value = ""
}

function openDynamicSchedule() {
  if (!workspace.value) return
  dynamicItems.value = workspace.value.scheduleItems.map((item) => ({
    id: item.id,
    orderId: item.orderId,
    aircraftId: item.aircraftId,
    outboundRouteId: item.outboundRouteId,
    returnRouteId: item.returnRouteId,
    plannedTakeoffTimeMs: item.plannedTakeoffTimeMs
  }))
  dynamicReason.value = ""
  dynamicMode.value = dynamicModeOptions.value[0]?.value ?? "SINGLE"
  dynamicProgress.value = null
  dynamicDrawerVisible.value = true
}

async function createDynamicVersion() {
  if (!workspace.value || dynamicReason.value.trim().length < 4) {
    ElMessage.warning("请填写本次动态调整原因")
    return
  }
  dynamicProgress.value = startV3OperationProgress("动态重调度核定", ["封存调整时刻表", "执行调度冲突检查", "汇总核定结果"])
  dynamicProgress.value = advanceV3OperationProgress(dynamicProgress.value, 1)
  try {
    const value = await api<LogisticsRuntimeWorkspaceView>(`/v3/logistics-projects/${props.project.id}/runtime/dynamic-schedules`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: workspace.value.session.revision,
        mode: dynamicMode.value,
        reason: dynamicReason.value,
        eventId: selectedActiveEvent.value?.id ?? null,
        items: dynamicItems.value
      })
    })
    applyWorkspace(value)
    selectedDynamicVersionId.value = value.dynamicScheduleVersions[0]?.id ?? ""
    const version = value.dynamicScheduleVersions[0]
    dynamicProgress.value = advanceV3OperationProgress(dynamicProgress.value, 2)
    dynamicProgress.value = completeV3OperationProgress(
      dynamicProgress.value,
      version
        ? `版本 V${version.versionNo} 影响 ${version.affectedOrderIds.length} 条订单，硬冲突 ${version.checkResult.conflictCount} 项，${version.checkResult.submittable ? "可提交生效" : "需继续调整"}`
        : "动态调度检查完成，未返回可汇总版本"
    )
    ElMessage.success(version?.checkResult.submittable ? "动态调度版本可提交" : "动态调度检查完成，仍有硬冲突")
  } catch (error) {
    const message = error instanceof Error ? error.message : "动态调度版本创建失败"
    dynamicProgress.value = failV3OperationProgress(dynamicProgress.value, message)
    ElMessage.error(message)
    await loadWorkspace(false)
  }
}

async function submitDynamicVersion() {
  if (!workspace.value || !selectedDynamicVersion.value?.checkResult.submittable || selectedDynamicVersion.value.status !== "DRAFT") return
  const versionNo = selectedDynamicVersion.value.versionNo
  dynamicProgress.value = startV3OperationProgress("动态重调度生效", ["复核核定结果", "提交生效请求", "刷新运行时刻表"])
  dynamicProgress.value = advanceV3OperationProgress(dynamicProgress.value, 1)
  const mutation = await mutate(`/v3/logistics-projects/${props.project.id}/runtime/dynamic-schedules/${selectedDynamicVersion.value.id}/submit`, {
    expectedRevision: workspace.value.session.revision
  }, `动态调度 V${versionNo} 已生效`, false)
  if (!mutation.success) {
    dynamicProgress.value = failV3OperationProgress(dynamicProgress.value, mutation.error ?? "动态调度生效失败，运行时刻表未变更")
    return
  }
  dynamicProgress.value = advanceV3OperationProgress(dynamicProgress.value, 2)
  dynamicProgress.value = completeV3OperationProgress(dynamicProgress.value, `动态调度 V${versionNo} 已生效，运行时刻表和任务状态已刷新`)
}

async function completeEmergencyHandling() {
  try {
    await ElMessageBox.confirm("确认所有运行事件与应急处置已经复核，并进入项目复盘阶段。", "完成应急处置", {
      type: "warning",
      confirmButtonText: "完成并进入复盘",
      cancelButtonText: "返回"
    })
  } catch {
    return
  }
  await mutate(`/v3/logistics-projects/${props.project.id}/runtime/emergency-handling/complete`, {}, "应急处置阶段已完成")
  emit("refreshProject")
}

async function mutate(path: string, body: Record<string, unknown>, success: string, showLoading = true): Promise<RuntimeMutationResult> {
  if (showLoading) loading.value = true
  try {
    applyWorkspace(await api<LogisticsRuntimeWorkspaceView>(path, { method: "POST", body: JSON.stringify(body) }))
    ElMessage.success(success)
    return { success: true, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : "运行命令执行失败"
    ElMessage.error(message)
    await loadWorkspace(false)
    return { success: false, error: message }
  } finally {
    if (showLoading) loading.value = false
  }
}

function selectAircraft(id: string) {
  selectedAircraftId.value = id
  const aircraft = workspace.value?.aircraft.find((item) => item.id === id)
  selectedOrderId.value = aircraft?.currentOrderId ?? selectedOrderId.value
  const task = workspace.value?.tasks.find((item) => item.scheduleItemId === aircraft?.currentTaskId)
  if (task?.activeRouteId) selectedRouteId.value = task.activeRouteId
}

function selectAlert(id: string) {
  selectedAlertId.value = id
  const alert = workspace.value?.alerts.find((item) => item.id === id)
  selectedEventId.value = alert?.eventId ?? ""
  const event = workspace.value?.events.find((item) => item.id === alert?.eventId)
  if (event?.affectedAircraftIds[0]) selectAircraft(event.affectedAircraftIds[0])
  if (event?.affectedRouteIds[0]) selectedRouteId.value = event.affectedRouteIds[0]
  const recommended = pickRecommendedRuntimeAction(studentActions.value, event?.recommendedActions ?? [])
  const fallback = recommended ?? studentActions.value.find((item) => item.enabled)
  if (fallback) {
    selectedActionCode.value = fallback.code
    selectedTargetId.value = pickRuntimeTargetId(fallback.eligibleTargetIds, [
      ...(event?.affectedAircraftIds ?? []),
      ...(event?.affectedOrderIds ?? []),
      ...(event?.affectedRouteIds ?? [])
    ])
  }
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches) {
    jumpToRuntimeSection("handling")
  }
}

function actionTargets(action: LogisticsRuntimeAvailableActionView | null) {
  if (!action || !workspace.value) return []
  if (action.targetType === "AIRCRAFT") return eligibleRuntimeTargets(workspace.value.aircraft, action.eligibleTargetIds).map((item) => ({ id: item.id, label: `${item.code} · ${aircraftStatusLabel(item.status)}` }))
  if (action.targetType === "ORDER") {
    let orders = eligibleRuntimeTargets(workspace.value.orders, action.eligibleTargetIds)
    const event = selectedActiveEvent.value
    if (event && action.code === "SWITCH_VERIFIED_ROUTE") {
      orders = orders.filter((order) => {
        const task = workspace.value?.tasks.find((item) => item.orderId === order.id)
        const currentRouteId = task?.activeRouteId ?? task?.outboundRouteId
        return event.affectedRouteIds.length > 0 ? Boolean(currentRouteId && event.affectedRouteIds.includes(currentRouteId)) : event.affectedOrderIds.length === 0 || event.affectedOrderIds.includes(order.id)
      })
    }
    return orders.map((item) => ({ id: item.id, label: `${item.code} · ${orderStatusLabel(item.status)}` }))
  }
  if (action.targetType === "ROUTE") {
    let routes = eligibleRuntimeTargets(workspace.value.routes, action.eligibleTargetIds)
    const event = selectedActiveEvent.value
    if (event && (action.code === "PAUSE_ROUTE" || action.code === "PAUSE_ROUTE_ENTRY") && event.affectedRouteIds.length > 0) routes = routes.filter((route) => event.affectedRouteIds.includes(route.id))
    return routes.map((item) => ({ id: item.id, label: `${item.name} · ${routeRoleLabel(item.role)} · ${routeStatusLabel(item.status)}` }))
  }
  if (action.targetType === "ALERT") return activeAlerts.value.map((item) => ({ id: item.id, label: item.title }))
  return []
}

function runtimeActionTargetLabel(action: V3StudentRuntimeActionView): string {
  if (!action.targetId || !workspace.value) return "全局"
  if (action.targetType === "AIRCRAFT") return workspace.value.aircraft.find((item) => item.id === action.targetId)?.code ?? action.targetId
  if (action.targetType === "ORDER") return workspace.value.orders.find((item) => item.id === action.targetId)?.code ?? action.targetId
  if (action.targetType === "ROUTE") return workspace.value.routes.find((item) => item.id === action.targetId)?.name ?? action.targetId
  if (action.targetType === "ALERT") return workspace.value.alerts.find((item) => item.id === action.targetId)?.title ?? action.targetId
  return action.targetId
}

function alertEvent(alert: V3RuntimeAlertView) {
  return workspace.value?.events.find((item) => item.id === alert.eventId) ?? null
}

function alertTiming(alert: V3RuntimeAlertView) {
  return runtimeAlertTiming(alertEvent(alert) ?? alert, Number(playbackTimeMs.value))
}

function alertStatusLabel(alert: V3RuntimeAlertView) {
  return runtimeAlertStatusLabel(alert.status, alertEvent(alert)?.lifecycleStatus)
}

function alertRecommendedAction(alert: V3RuntimeAlertView) {
  return runtimeRecommendedActionLabel(alertEvent(alert)?.recommendedActions ?? [], workspace.value?.availableActions ?? [])
}

function alertActionResult(alert: V3RuntimeAlertView) {
  const eventId = alert.eventId
  const action = latestRuntimeAction(workspace.value?.actions ?? [], alert.id, eventId)
  if (!action) return ""
  if (action.status === "FAILED" || action.status === "REJECTED") return "处置失败"
  if (action.status === "REQUESTED") return "处置中"
  return runtimeActionResultLabel(action.result)
}

function alertAffectedScope(alert: V3RuntimeAlertView) {
  const event = alertEvent(alert)
  if (!event) return "未关联对象"
  const values = [
    ...event.affectedAircraftIds.map((id) => workspace.value?.aircraft.find((item) => item.id === id)?.code ?? id),
    ...event.affectedOrderIds.map((id) => workspace.value?.orders.find((item) => item.id === id)?.code ?? id),
    ...event.affectedRouteIds.map((id) => workspace.value?.routes.find((item) => item.id === id)?.name ?? id)
  ]
  if (!values.length) return "全局运行"
  return values.length > 4 ? `${values.slice(0, 4).join("、")} 等 ${values.length} 项` : values.join("、")
}

function updateDynamicTakeoff(item: LogisticsScheduleItemInput, minutes: number | undefined) {
  item.plannedTakeoffTimeMs = Math.max(0, Number(minutes ?? 0) * 60_000)
}

function onTargetChange(value: string | number) {
  selectedTargetId.value = String(value)
  if (selectedAction.value?.targetType === "ORDER") selectedOrderId.value = selectedTargetId.value
  if (selectedAction.value?.targetType === "AIRCRAFT") selectAircraft(selectedTargetId.value)
}

function dynamicItemLocked(item: LogisticsScheduleItemInput) {
  return workspace.value?.tasks.find((task) => task.scheduleItemId === item.id)?.status !== "WAITING_EXECUTION"
}

function routeOptions(direction: "OUTBOUND" | "RETURN", orderId: string) {
  const destinationNodeId = workspace.value?.orders.find((item) => item.id === orderId)?.destinationNodeId
  return workspace.value?.routes.filter((route) => route.direction === direction && route.destinationNodeId === destinationNodeId && route.status !== "CLOSED" && route.status !== "ABNORMAL") ?? []
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return `${hours > 0 ? `${String(hours).padStart(2, "0")}:` : ""}${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function aircraftStatusLabel(value: string) {
  return ({ STANDBY: "待用", AVAILABLE: "可用", ASSIGNED: "已派遣", TAKING_OFF: "起飞", OUTBOUND: "去程", ARRIVED: "到达", RETURNING: "返程", LANDING: "降落", HOLDING: "悬停", DIVERTING: "备降", EMERGENCY_LANDING: "迫降", DISABLED: "不可用" } as Record<string, string>)[value] ?? value
}

function destinationNodeName(nodeId: string) {
  return logisticsDestinationLabel(props.region, nodeId)
}

function orderStatusLabel(value: string) {
  return ({ UNRELEASED: "未释放", UNASSIGNED: "待分配", SCHEDULED: "待执行", DELIVERING: "配送中", COMPLETED: "已完成", EXPECTED_DELAY: "预计延误", DELAYED: "已延误", FAILED: "失败", CANCELLED: "已取消" } as Record<string, string>)[value] ?? value
}

function routeStatusLabel(value: string) {
  return ({ AVAILABLE: "可用", RISK: "风险", PAUSED: "暂停", ABNORMAL: "异常", RECOVERING: "恢复中", CLOSED: "关闭" } as Record<string, string>)[value] ?? value
}

function routeRoleLabel(value: string) {
  return value === "ALTERNATE" ? "备用方案" : "主航线"
}

function routeValidationLabel(value: string) {
  return value === "WITH_RISK" ? "已验证有风险" : value === "PASSED" ? "已验证" : "验证未通过"
}

function taskStatusLabel(value: string) {
  return ({ WAITING_EXECUTION: "待执行", TAKEOFF: "起飞", OUTBOUND: "去程飞行", ARRIVAL_CONFIRMATION: "到达确认", RETURNING: "返程飞行", LANDING: "降落", AVAILABLE_AGAIN: "再次可用", CANCELLED: "已取消", FAILED: "失败" } as Record<string, string>)[value] ?? value
}

function eventStatusLabel(value: string) {
  return ({ SCHEDULED: "待触发", OCCURRED_UNDETECTED: "已发生未发现", DISCOVERED: "已发现", HANDLING: "处置中", CONTROLLED: "已控制", ESCALATED: "已升级", ENDED: "已结束" } as Record<string, string>)[value] ?? value
}

function environmentLabel(value: string) {
  return ({ NORMAL: "正常", NEAR_LIMIT: "近限制", OVER_LIMIT: "超限", NONE: "无", OCCASIONAL: "偶发", CONTINUOUS: "持续", GOOD: "良好", DEGRADED: "降级", LOST: "丢失", WARNING: "告警", FAULT: "故障", RESTRICTED: "受限", SUSPENDED: "暂停" } as Record<string, string>)[value] ?? value
}

function windDirectionLabel(value: string) {
  return ({ N: "北", NE: "东北", E: "东", SE: "东南", S: "南", SW: "西南", W: "西", NW: "西北" } as Record<string, string>)[value] ?? value
}

function dynamicScheduleModeLabel(value: string) {
  return ({ SINGLE: "单订单调整", BATCH: "批量订单调整", GLOBAL: "全局调度调整" } as Record<string, string>)[value] ?? value
}
</script>

<template>
  <section ref="runtimeWorkspaceElement" class="logistics-runtime-workspace" :data-runtime-revision="workspace?.session.revision ?? 0" :class="{ 'has-restart': workspace?.canRestart }" v-loading="loading" @scroll.passive="onRuntimeWorkspaceScroll">
    <header ref="runtimeCommandbarElement" class="runtime-commandbar">
      <div><span>{{ isReplayMode ? 'DELIVERY REPLAY' : 'DELIVERY CONTROL' }}</span><strong>低空物流运行</strong><small>{{ formatScaleTemplateCode(workspace?.scaleTemplateCode) }} · {{ playbackStatusLabel }}</small></div>
      <div class="runtime-attempts" v-if="workspace?.attempts.length"><span>训练尝试</span><el-select :model-value="workspace.session.id" size="small" aria-label="选择物流训练记录" @change="selectAttempt"><el-option v-for="attempt in workspace.attempts" :key="attempt.id" :label="`第 ${attempt.attemptNo} 次 · ${formatRuntimeSessionStatus(attempt.status)}${attempt.id === workspace.attempts[0]?.id ? ' · 当前' : ' · 历史'}`" :value="attempt.id" /></el-select><small v-if="isHistoricalAttempt">历史记录只读</small><el-button v-if="isHistoricalAttempt" text size="small" @click="selectAttempt(workspace.attempts[0]!.id)">返回当前训练</el-button></div>
      <dl><div><dt>仿真时间</dt><dd>{{ formatDuration(playbackTimeMs) }}</dd></div><div><dt>剩余</dt><dd>{{ formatDuration(Math.max(0, playbackDurationMs - playbackTimeMs)) }}</dd></div><div><dt>运行速度</dt><dd>{{ playbackRate }}x</dd></div><div><dt>活动告警</dt><dd class="danger">{{ activeAlerts.length }}</dd></div></dl>
      <div class="runtime-command-actions"><span class="runtime-stream-status" :class="connectionState.toLowerCase()" role="status" aria-live="polite" :aria-label="`运行数据连接状态：${connectionStateLabel}`"><i />{{ connectionStateLabel }}</span><el-button v-if="!isReplayMode && ['RECONNECTING', 'FALLBACK', 'CLOSED'].includes(connectionState)" text size="small" @click="reconnectRuntime">重新连接</el-button>
        <el-button v-if="workspace?.canStart" type="primary" :icon="VideoPlay" @click="startRuntime">启动运行</el-button>
        <el-button :icon="Refresh" circle :loading="snapshotLoading" :disabled="snapshotLoading" title="刷新运行快照" aria-label="刷新运行快照" @click="loadWorkspace" />
      </div>
      <div v-if="workspace?.canRestart" class="runtime-restart-bar"><span>可重训 {{ workspace.attemptsRemaining }} 次</span><el-select v-model="selectedRestartNodeCode" size="small" placeholder="选择异常节点" aria-label="选择物流重训节点"><el-option v-for="node in workspace.restartNodes" :key="node.code" :label="`${node.label} · ${node.detail}`" :value="node.code" /></el-select><el-button type="warning" size="small" @click="restartRuntime">从节点重训</el-button></div>
      <div class="runtime-mobile-summary" aria-label="物流运行摘要">
        <span><small>当前航空器</small><b>{{ selectedAircraft?.code ?? '未选中' }}</b></span>
        <span><small>下一任务</small><b>{{ selectedAircraftNextTask?.orderCode ?? '暂无' }}</b></span>
        <span :class="{ danger: activeAlerts.length > 0 }"><small>待处理告警</small><b>{{ activeAlerts.length }}</b></span>
      </div>
      <nav class="runtime-mobile-nav" aria-label="物流运行区域快速定位">
        <button type="button" data-runtime-jump="map" :aria-pressed="activeQuickSection === 'map'" :class="{ active: activeQuickSection === 'map' }" @click="jumpToRuntimeSection('map')"><el-icon><MapLocation /></el-icon><span>地图</span></button>
        <button type="button" data-runtime-jump="fleet" :aria-pressed="activeQuickSection === 'fleet'" :class="{ active: activeQuickSection === 'fleet' }" @click="jumpToRuntimeSection('fleet')"><el-icon><Van /></el-icon><span>机队</span><b>{{ displaySummary?.airborneAircraft ?? 0 }}</b></button>
        <button type="button" data-runtime-jump="missions" :aria-pressed="activeQuickSection === 'missions'" :class="{ active: activeQuickSection === 'missions' }" @click="jumpToRuntimeSection('missions')"><el-icon><Tickets /></el-icon><span>任务</span><b>{{ displaySummary?.waitingOrders ?? 0 }}</b></button>
        <button type="button" data-runtime-jump="alerts" :aria-pressed="activeQuickSection === 'alerts'" :class="[{ active: activeQuickSection === 'alerts' }, { danger: activeAlerts.length > 0 }]" @click="jumpToRuntimeSection('alerts')"><el-icon><Bell /></el-icon><span>告警</span><b>{{ activeAlerts.length }}</b></button>
        <button type="button" data-runtime-jump="handling" :aria-pressed="activeQuickSection === 'handling'" :class="{ active: activeQuickSection === 'handling' }" @click="jumpToRuntimeSection('handling')"><el-icon><EditPen /></el-icon><span>处置</span></button>
      </nav>
    </header>
    <div v-if="loadError" class="runtime-load-error" role="alert" aria-live="assertive"><span><strong>运行数据加载失败</strong><small>{{ loadError }} 当前页面数据未被清除，请重试。</small></span><el-button size="small" type="warning" :loading="loading" @click="initializeRuntimeStream">重试加载</el-button></div>

    <aside v-show="runtimeSideTab === 'fleet'" ref="runtimeFleetPanelElement" class="runtime-fleet-panel" tabindex="-1" aria-labelledby="runtime-fleet-title">
      <header>
        <div class="runtime-side-tabs" role="tablist" aria-label="运行侧栏视图">
          <button type="button" role="tab" :aria-selected="runtimeSideTab === 'fleet'" :class="{ active: runtimeSideTab === 'fleet' }" @click="runtimeSideTab = 'fleet'"><Van />机队状态</button>
          <button type="button" role="tab" :aria-selected="runtimeSideTab === 'situation'" :class="{ active: runtimeSideTab === 'situation' }" @click="runtimeSideTab = 'situation'"><MapLocation />运行态势</button>
        </div>
        <b>{{ displaySummary?.airborneAircraft ?? 0 }} 空中</b>
      </header>
      <div class="runtime-fleet-summary"><span><b>{{ displaySummary?.availableAircraft ?? 0 }}</b>可用</span><span><b>{{ displaySummary?.assignedAircraft ?? 0 }}</b>已派</span><span><b>{{ displaySummary?.warningAircraft ?? 0 }}</b>处置</span><span><b>{{ displaySummary?.disabledAircraft ?? 0 }}</b>不可用</span></div>
      <div class="runtime-aircraft-list">
        <button v-for="aircraft in displayAircraft" :key="aircraft.id" type="button" :class="[aircraft.status.toLowerCase(), { selected: selectedAircraftId === aircraft.id }]" :data-aircraft-id="aircraft.id" :data-aircraft-status="aircraft.status" :aria-label="`${aircraft.code}，${formatAircraftModelCode(aircraft.modelCode)}，${aircraftStatusLabel(aircraft.status)}，${aircraft.currentOrderId ? displayOrders.find(item => item.id === aircraft.currentOrderId)?.code : '无任务'}`" :aria-pressed="selectedAircraftId === aircraft.id" @click="selectAircraft(aircraft.id)">
          <i>{{ aircraft.code.slice(-3) }}</i><div><strong>{{ aircraft.code }}</strong><small>{{ formatAircraftModelCode(aircraft.modelCode) }} · {{ aircraftStatusLabel(aircraft.status) }} · {{ aircraft.currentOrderId ? displayOrders.find(item => item.id === aircraft.currentOrderId)?.code : '无任务' }}</small></div><em>{{ Math.round(aircraft.batteryPercent) }}%</em>
        </button>
      </div>
    </aside>

    <main ref="runtimeMapPanelElement" class="runtime-map-panel" :class="{ 'map-fullscreen': mapFullscreen }" tabindex="-1" aria-label="物流运行地图" :aria-modal="mapFullscreen ? 'true' : undefined" :role="mapFullscreen ? 'dialog' : undefined">
      <div class="runtime-map-actions" role="toolbar" aria-label="地图显示操作">
        <el-button v-if="!mapFullscreen" text :icon="FullScreen" title="全屏查看地图" aria-label="全屏查看地图" @click="mapFullscreen = true">全屏</el-button>
        <el-button v-else text :icon="Close" title="退出全屏地图" aria-label="退出全屏地图" @click="mapFullscreen = false">退出全屏</el-button>
      </div>
      <V3UnifiedMap renderer="logistics-runtime"
        :region="region"
        :routes="workspace?.routes ?? []"
        :aircraft="displayAircraft"
        :events="workspace?.events ?? []"
        :selected-aircraft-id="selectedAircraftId"
        :selected-route-id="selectedRouteId"
        :selected-event-id="selectedEvent?.id ?? ''"
        :mode="mapMode"
        :playback-time-ms="playbackTimeMs"
        :replay="isReplayMode"
        @aircraft-select="selectAircraft"
        @route-select="selectedRouteId = $event"
        @event-select="selectedEventId = $event"
        @data-state="emit('dataState', $event)"
      />
      <V3RuntimePlaybackBar
        :time-ms="playbackTimeMs"
        :duration-ms="playbackDurationMs"
        :playing="playbackPlaying"
        :live="!isReplayMode"
        :interactive="isReplayMode"
        :toggle-enabled="isReplayMode || canChangeClock"
        :rate="playbackRate"
        :rate-options="playbackRateOptions"
        :rate-editable="isReplayMode || canChangeClock"
        :markers="playbackMarkers"
        :selected-marker-id="selectedEvent?.id ?? ''"
        :status-label="playbackStatusLabel"
        @toggle="togglePlayback"
        @restart="restartPlayback"
        @seek="seekPlayback"
        @rate-change="changePlaybackRate"
        @marker-select="selectPlaybackMarker"
      />
      <section class="runtime-aircraft-monitor">
        <header><div><span>选中航空器</span><strong class="runtime-selected-aircraft-code">{{ selectedAircraft?.code ?? '未选中无人机' }}</strong><small class="runtime-selected-aircraft-model">{{ formatAircraftModelCode(selectedAircraft?.modelCode) }}</small></div><em>{{ selectedAircraft ? aircraftStatusLabel(selectedAircraft.status) : '等待运行数据' }}</em></header>
        <div><dl v-for="metric in selectedAircraftMonitorMetrics" :key="metric.code" :class="metric.tone" :title="metric.value"><dt>{{ metric.label }}</dt><dd>{{ metric.value }}</dd></dl></div>
        <div class="next-task-strip" v-if="selectedAircraft" :data-next-task-id="selectedAircraftNextTask?.scheduleItemId ?? ''" :data-selected-aircraft-model="selectedAircraft.modelCode ?? ''">
          <span>下一任务</span>
          <strong v-if="selectedAircraftNextTask">{{ selectedAircraftNextTask.orderCode }} · {{ destinationNodeName(selectedAircraftNextTask.destinationNodeId) }}</strong>
          <strong v-else>暂无后续任务</strong>
          <small v-if="selectedAircraftNextTask" class="next-task-times">计划起飞 T+{{ formatDuration(selectedAircraftNextTask.plannedTakeoffTimeMs) }} · 预计到达 T+{{ formatDuration(selectedAircraftNextTask.arrivalTimeMs) }}</small>
          <small v-if="selectedAircraftNextTiming" class="next-task-window">配送窗口 {{ selectedAircraftNextTiming.windowLabel }}</small>
          <small v-if="selectedAircraftNextTiming" class="next-task-reason" :class="selectedAircraftNextTiming.tone">{{ selectedAircraftNextTiming.executionLabel }}</small>
          <small v-else>{{ selectedAircraft.status === 'AVAILABLE' ? '当前无人机已空闲' : `预计可用 ${formatDuration(selectedAircraft.nextAvailableTimeMs)}` }}</small>
        </div>
      </section>
      <div class="runtime-environment-strip"><span>{{ windDirectionLabel(workspace?.environment.windDirection ?? '-') }}风 {{ environmentLabel(workspace?.environment.windState ?? '-') }}</span><span>阵风 {{ environmentLabel(workspace?.environment.gustState ?? '-') }}</span><span>降雨 {{ environmentLabel(workspace?.environment.rainState ?? '-') }}</span><span>定位 {{ environmentLabel(workspace?.environment.positioningQuality ?? '-') }}</span><span>通信 {{ environmentLabel(workspace?.environment.communicationQuality ?? '-') }}</span><span>设备 {{ environmentLabel(workspace?.environment.equipmentState ?? '-') }}</span><span>运行 {{ environmentLabel(workspace?.environment.operationState ?? '-') }}</span></div>
      <div v-if="workspace?.session.status === 'READY'" class="runtime-start-overlay"><el-icon><VideoPlay /></el-icon><strong>正式调度待启动</strong><span>{{ workspace.summary.totalOrders }} 单 · {{ workspace.summary.totalAircraft }} 架无人机</span><el-button v-if="workspace.canStart" type="primary" :icon="VideoPlay" @click="startRuntime">启动配送运行</el-button></div>
    </main>

    <aside v-show="runtimeSideTab === 'situation'" ref="runtimeControlPanelElement" class="runtime-control-panel" tabindex="-1" aria-label="物流运行处置与控制">
      <div class="runtime-side-tabs runtime-side-tabs-control" role="tablist" aria-label="运行侧栏视图">
        <button type="button" role="tab" :aria-selected="runtimeSideTab === 'fleet'" :class="{ active: runtimeSideTab === 'fleet' }" @click="runtimeSideTab = 'fleet'"><Van />机队状态</button>
        <button type="button" role="tab" :aria-selected="runtimeSideTab === 'situation'" :class="{ active: runtimeSideTab === 'situation' }" @click="runtimeSideTab = 'situation'"><MapLocation />运行态势</button>
      </div>
      <section class="order-operation-summary"><header><strong>订单态势</strong><span>{{ displaySummary?.completedOrders ?? 0 }}/{{ displaySummary?.totalOrders ?? 0 }}</span></header><dl><div><dt>待执行</dt><dd>{{ displaySummary?.waitingOrders ?? 0 }}</dd></div><div><dt>配送中</dt><dd>{{ displaySummary?.deliveringOrders ?? 0 }}</dd></div><div><dt>延误</dt><dd class="warning">{{ displaySummary?.delayedOrders ?? 0 }}</dd></div><div><dt>失败/取消</dt><dd class="danger">{{ (displaySummary?.failedOrders ?? 0) + (displaySummary?.cancelledOrders ?? 0) }}</dd></div></dl></section>

      <section v-if="workspace?.canControl" class="student-runtime-actions">
        <header><strong>学生应急处置</strong><span>STUDENT</span></header>
        <div v-if="selectedAlert" class="runtime-selected-alert">
          <header><span>{{ selectedAlert.status === 'RESOLVED' ? '最近处置结果' : '当前处置告警' }}</span><em :class="alertTiming(selectedAlert).tone">{{ alertStatusLabel(selectedAlert) }}</em></header>
          <strong>{{ selectedAlert.title }}</strong>
          <dl v-if="selectedAlertBriefing" class="runtime-teaching-briefing">
            <div><dt>业务角色</dt><dd>{{ selectedAlertBriefing.role }}</dd></div>
            <div><dt>业务请求</dt><dd>{{ selectedAlertBriefing.request }}</dd></div>
            <div><dt>影响对象</dt><dd>{{ alertAffectedScope(selectedAlert) }}</dd></div>
            <div><dt>处置目标</dt><dd>{{ selectedAlertBriefing.objective }}</dd></div>
            <div><dt>成功判据</dt><dd>{{ selectedAlertBriefing.successCriteria }}</dd></div>
            <div><dt>处置时限</dt><dd :class="alertTiming(selectedAlert).tone">{{ alertTiming(selectedAlert).label }}</dd></div>
            <div><dt>评分关注</dt><dd>{{ selectedAlertBriefing.scoringEvidence.join('、') }}</dd></div>
          </dl>
          <div v-if="selectedAlertAction" class="runtime-business-result" tabindex="-1" aria-live="polite">
            <strong>实际业务后果</strong>
            <ul v-if="selectedAlertConsequences.length"><li v-for="item in selectedAlertConsequences" :key="item">{{ item }}</li></ul>
            <p v-else>{{ runtimeActionResultLabel(selectedAlertAction.result) }}</p>
            <small v-if="selectedAlertEvidence.length">评分证据：{{ selectedAlertEvidence.join(' · ') }}</small>
          </div>
        </div>
        <el-select v-model="selectedActionCode" placeholder="选择处置操作" aria-label="选择物流应急处置动作"><el-option v-for="action in studentActions" :key="action.code" :label="runtimeActionOptionLabel(action.title, action.enabled, action.disabledReason)" :value="action.code" :disabled="!action.enabled" /></el-select>
        <el-select v-if="selectedAction?.requiresTarget" v-model="selectedTargetId" placeholder="选择处置对象" aria-label="选择物流应急处置对象" @change="onTargetChange"><el-option v-for="option in targetOptions" :key="option.id" :label="option.label" :value="option.id" /></el-select>
        <label v-if="selectedActionCode === 'REDUCE_SPEED'"><span>减速系数</span><el-input-number v-model="actionSpeedFactor" :min="1.05" :max="3" :step="0.05" :precision="2" /></label>
        <label v-if="selectedActionCode === 'DELAY_TASK'"><span>推迟分钟</span><el-input-number v-model="actionDelayMinutes" :min="1" :max="240" /></label>
        <label v-if="selectedActionCode === 'SWITCH_VERIFIED_ROUTE' || selectedActionCode === 'DIVERT_AIRCRAFT'"><span>{{ selectedActionCode === 'DIVERT_AIRCRAFT' ? '备降航线' : '已验证备用方案' }}</span><el-select v-model="selectedReplacementRouteId" clearable :placeholder="selectedActionCode === 'DIVERT_AIRCRAFT' ? '使用区域备用落点' : '选择已验证备用方案'"><el-option v-for="route in replacementRoutes" :key="route.id" :label="`${route.name} · V${route.sourceVersionNo} · ${routeRoleLabel(route.role)} · ${routeStatusLabel(route.status)}`" :value="route.id" /></el-select><small v-if="selectedActionCode === 'SWITCH_VERIFIED_ROUTE' && replacementRoutes.length === 0">当前订单没有可用的已验证备用方案</small></label>
        <label v-if="selectedActionCode === 'REPLACE_AIRCRAFT' || selectedActionCode === 'REASSIGN_ORDER'"><span>替代无人机</span><el-select v-model="selectedReplacementAircraftId" placeholder="选择当前可用无人机"><el-option v-for="aircraft in replacementAircraftOptions" :key="aircraft.id" :label="`${aircraft.code} · ${Math.round(aircraft.batteryPercent)}%`" :value="aircraft.id" /></el-select></label>
        <label v-if="selectedActionCode === 'CHANGE_PRIORITY'"><span>订单优先级</span><el-select v-model="selectedPriority"><el-option v-for="option in priorityOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></label>
        <div class="action-reasoning-fields">
          <label><span>异常发现</span><el-input v-model="actionObservation" type="textarea" :rows="2" maxlength="1000" placeholder="描述看到的异常（至少4字）" /></label>
          <label><span>判断依据</span><el-input v-model="actionRationale" type="textarea" :rows="2" maxlength="1000" placeholder="说明为什么选择该动作（至少4字）" /></label>
          <label><span>预期结果</span><el-input v-model="actionExpectedOutcome" type="textarea" :rows="2" maxlength="1000" placeholder="说明希望达到的结果（至少4字）" /></label>
        </div>
        <el-button class="execute-runtime-action" type="primary" :loading="actionSubmitting" :disabled="actionSubmitting || !actionSubmissionValid" @click="executeSelectedAction">{{ selectedAlert?.status === 'RESOLVED' ? '该告警已处置' : actionSubmitting ? '提交中...' : '执行处置' }}</el-button>
        <div v-if="actionError" class="runtime-action-error" role="alert" aria-live="assertive"><span>{{ actionError }}</span><el-button type="danger" text :loading="actionSubmitting" :disabled="actionSubmitting || !failedAction" @click="retryFailedAction">重试处置</el-button></div>
        <ol v-if="recentActions.length" class="recent-action-records">
          <li v-for="action in recentActions" :key="action.id">
            <strong>{{ workspace?.availableActions.find((item) => item.code === action.actionCode)?.title ?? action.actionCode }}</strong>
            <span>对象：{{ runtimeActionTargetLabel(action) }}</span>
            <span v-if="runtimeActionReasoning(action.payload)">发现：{{ runtimeActionReasoning(action.payload)?.observation }}</span>
            <span v-if="runtimeActionReasoning(action.payload)">判断：{{ runtimeActionReasoning(action.payload)?.rationale }}</span>
            <span v-if="runtimeActionReasoning(action.payload)">预期：{{ runtimeActionReasoning(action.payload)?.expectedOutcome }}</span>
            <em>{{ runtimeActionResultLabel(action.result) }}</em>
          </li>
        </ol>
        <el-button :icon="EditPen" :disabled="!activeSession" @click="openDynamicSchedule">动态重调度</el-button>
      </section>

      <section v-if="workspace?.canTeacherIntervene" class="teacher-event-console">
        <header><strong>教师训练干预</strong><span>TEACHER</span></header>
        <el-select v-model="teacherEventId" placeholder="选择待触发事件" aria-label="选择教师注入物流事件"><el-option v-for="event in scheduledEvents" :key="event.id" :label="`${event.title} · ${formatDuration(event.scheduledSimulationTimeMs ?? 0)}`" :value="event.id" /></el-select>
        <el-button :disabled="!teacherEventId" @click="triggerTeacherEvent">立即触发</el-button>
        <el-input v-model="teacherHint" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="输入发送给学生的训练提示" />
        <el-button :disabled="!teacherHint.trim()" @click="sendTeacherHint">发送提示</el-button>
      </section>

      <section class="runtime-route-list"><header><strong>航线运行状态</strong><span>{{ workspace?.routes.length ?? 0 }} ROUTES</span></header><button v-for="route in workspace?.routes ?? []" :key="route.id" type="button" :class="[route.status.toLowerCase(), { selected: selectedRouteId === route.id }]" :aria-pressed="selectedRouteId === route.id" @click="selectedRouteId = route.id"><i /><div><strong>{{ route.name }}</strong><small>{{ route.direction === 'OUTBOUND' ? '去程' : '返程' }} · {{ routeRoleLabel(route.role) }} · V{{ route.sourceVersionNo }} {{ routeValidationLabel(route.validationStatus) }} · {{ route.activeTaskCount }} 个活动任务</small></div><em>{{ routeStatusLabel(route.status) }}</em></button></section>
      <el-button v-if="canCompleteEmergency" class="complete-emergency" type="primary" :icon="CircleCheck" :loading="loading" :disabled="loading" aria-label="完成物流应急处置并进入复盘" @click="completeEmergencyHandling">{{ loading ? '正在进入复盘...' : '完成应急处置并复盘' }}</el-button>
    </aside>

    <section ref="runtimeMissionPanelElement" class="runtime-mission-table" tabindex="-1" aria-labelledby="runtime-mission-title">
      <header><div><span>MISSION BOARD</span><strong id="runtime-mission-title">飞行任务与时刻表</strong></div><small>{{ workspace?.tasks.length ?? 0 }} 班 · 服务端权威状态</small></header>
      <div class="runtime-mission-head"><span>任务</span><span>无人机</span><span>当前阶段</span><span>计划起飞</span><span>预计到达</span><span>预计落地</span><span>电量</span></div>
      <div class="runtime-mission-body"><button v-for="task in missionBoardTasks" :key="task.scheduleItemId" type="button" :class="[task.status.toLowerCase(), { selected: selectedOrderId === task.orderId }]" :data-schedule-item-id="task.scheduleItemId" :data-order-id="task.orderId" :data-aircraft-id="task.aircraftId" :data-destination-node-id="task.destinationNodeId" :data-planned-takeoff-ms="task.plannedTakeoffTimeMs" :aria-label="`${task.orderCode}，${destinationNodeName(task.destinationNodeId)}，${task.aircraftCode}，计划起飞${formatDuration(task.plannedTakeoffTimeMs)}`" :aria-pressed="selectedOrderId === task.orderId" @click="selectedOrderId = task.orderId; selectedAircraftId = task.aircraftId; selectedRouteId = task.activeRouteId ?? selectedRouteId"><span><strong class="runtime-mission-order">{{ task.orderCode }}</strong><small class="runtime-mission-destination">{{ destinationNodeName(task.destinationNodeId) }}</small></span><span class="runtime-mission-aircraft">{{ task.aircraftCode }}</span><em>{{ taskStatusLabel(task.status) }}</em><span class="runtime-mission-planned">{{ formatDuration(task.plannedTakeoffTimeMs) }}</span><span>{{ formatDuration(task.arrivalTimeMs) }}</span><span>{{ formatDuration(task.landingTimeMs) }}</span><b>{{ Math.round(task.batteryPercent) }}%</b></button></div>
    </section>

    <section ref="runtimeAlertPanelElement" class="runtime-alert-deck" tabindex="-1" aria-labelledby="runtime-alert-title">
      <header><div><el-icon><Bell /></el-icon><strong id="runtime-alert-title">告警与事件</strong><span>{{ activeAlerts.length }} 条活动告警</span></div><small>发生 · 发现 · 确认 · 处置 · 恢复</small></header>
      <div class="runtime-alert-list"><article v-for="alert in displayedAlerts" :key="alert.id" :class="[alert.severity.toLowerCase(), { selected: selectedAlert?.id === alert.id, resolved: alert.status === 'RESOLVED' }]" role="button" tabindex="0" :aria-pressed="selectedAlert?.id === alert.id" :aria-label="`${alert.title}，${runtimeEventCategoryLabel('CITY_LOGISTICS', alertEvent(alert)?.category ?? '')}，${alertStatusLabel(alert)}，影响${alertAffectedScope(alert)}`" @click="selectAlert(alert.id)" @keydown.enter.stop.prevent="selectAlert(alert.id)" @keydown.space.stop.prevent="selectAlert(alert.id)"><el-icon><Warning /></el-icon><div><span>T+{{ formatDuration(alert.simulationTimeMs ?? 0) }} · {{ runtimeAlertSeverityLabel(alert.severity) }} · {{ runtimeEventSource('CITY_LOGISTICS', alertEvent(alert)?.category ?? '', alertEvent(alert)?.code) }} · {{ runtimeEventCategoryLabel('CITY_LOGISTICS', alertEvent(alert)?.category ?? '') }}</span><strong>{{ alert.title }}</strong><p>{{ alert.detail }}</p><small class="runtime-alert-scope"><b>影响对象</b>{{ alertAffectedScope(alert) }}</small><small class="runtime-alert-timing" :class="alertTiming(alert).tone"><b>处置时限</b>{{ alertTiming(alert).label }}</small><small class="runtime-alert-recommendation"><b>{{ alert.status === 'RESOLVED' ? '结果' : '建议' }}</b>{{ alert.status === 'RESOLVED' ? alertActionResult(alert) : alertRecommendedAction(alert) }}<template v-if="alert.status !== 'RESOLVED' && alertActionResult(alert)"> · {{ alertActionResult(alert) }}</template></small></div><div class="runtime-alert-card-actions"><em>{{ alertStatusLabel(alert) }}</em><el-button v-if="workspace?.canControl" text @click.stop="selectAlert(alert.id)">{{ alert.status === 'RESOLVED' ? '查看结果' : '进入处置' }}</el-button><el-button v-if="workspace?.canControl && alert.status === 'OPEN'" text :disabled="!actionReasoningValid" @click.stop="acknowledgeAlert(alert.id)">确认</el-button></div></article><div v-if="!displayedAlerts.length" class="runtime-alert-empty"><el-icon><CircleCheck /></el-icon><strong>当前无活动告警</strong></div></div>
      <ol class="runtime-event-strip"><li v-for="event in workspace?.events ?? []" :key="event.id" :class="[event.lifecycleStatus.toLowerCase(), { selected: selectedEvent?.id === event.id }]" role="button" tabindex="0" :aria-pressed="selectedEvent?.id === event.id" :aria-label="`${event.title}，${eventStatusLabel(event.lifecycleStatus)}`" @click="selectRuntimeEvent(event.id)" @keydown.enter="selectRuntimeEvent(event.id)" @keydown.space.prevent="selectRuntimeEvent(event.id)"><i /><span>{{ formatDuration(event.scheduledSimulationTimeMs ?? 0) }}</span><strong>{{ event.title }}<small>{{ runtimeEventSource('CITY_LOGISTICS', event.category, event.code) }}</small></strong><em>{{ eventStatusLabel(event.lifecycleStatus) }}</em></li></ol>
    </section>

    <el-drawer v-model="dynamicDrawerVisible" title="动态重调度" size="min(760px, 100%)" append-to-body>
      <div class="dynamic-schedule-drawer">
        <header><div><span>IN-RUN RESCHEDULING</span><strong>运行中时刻表调整</strong></div><em>已开始任务不可修改</em></header>
        <V3OperationProgress :state="dynamicProgress" />
        <div class="dynamic-schedule-form"><label><span>调整范围</span><el-select v-model="dynamicMode"><el-option v-for="option in dynamicModeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></label><label><span>调整原因</span><el-input v-model="dynamicReason" maxlength="500" placeholder="说明事件、风险和调度目标" /></label><el-button type="primary" @click="createDynamicVersion">检查并保存版本</el-button></div>
        <div class="dynamic-schedule-table"><div class="dynamic-head"><span>订单</span><span>无人机</span><span>起飞(min)</span><span>去程航线</span><span>返程航线</span></div><div v-for="item in dynamicItems" :key="item.id" class="dynamic-row" :class="{ locked: dynamicItemLocked(item) }"><span><strong>{{ workspace?.orders.find(order => order.id === item.orderId)?.code }}</strong><small>{{ dynamicItemLocked(item) ? '运行事实已锁定' : '可调整' }}</small></span><el-select v-model="item.aircraftId" :disabled="dynamicItemLocked(item)"><el-option v-for="aircraft in workspace?.aircraft ?? []" :key="aircraft.id" :label="aircraft.code" :value="aircraft.id" /></el-select><el-input-number :model-value="Math.round(item.plannedTakeoffTimeMs / 60000)" :disabled="dynamicItemLocked(item)" :min="0" :max="1440" :controls="false" @update:model-value="updateDynamicTakeoff(item, $event)" /><el-select v-model="item.outboundRouteId" :disabled="dynamicItemLocked(item)"><el-option v-for="route in routeOptions('OUTBOUND', item.orderId)" :key="route.id" :label="route.name" :value="route.id" /></el-select><el-select v-model="item.returnRouteId" :disabled="dynamicItemLocked(item)"><el-option v-for="route in routeOptions('RETURN', item.orderId)" :key="route.id" :label="route.name" :value="route.id" /></el-select></div></div>
        <section class="dynamic-version-result"><header><strong>动态调度版本</strong><el-select v-model="selectedDynamicVersionId" placeholder="尚无版本"><el-option v-for="version in workspace?.dynamicScheduleVersions ?? []" :key="version.id" :label="`V${version.versionNo} · ${formatSubmissionStatus(version.status)}`" :value="version.id" /></el-select></header><template v-if="selectedDynamicVersion"><dl><div><dt>调整模式</dt><dd>{{ dynamicScheduleModeLabel(selectedDynamicVersion.mode) }}</dd></div><div><dt>核定状态</dt><dd>{{ formatValidationStatus(selectedDynamicVersion.checkResult.status) }}</dd></div><div><dt>硬冲突</dt><dd>{{ selectedDynamicVersion.checkResult.conflictCount }}</dd></div><div><dt>风险</dt><dd>{{ selectedDynamicVersion.checkResult.riskCount }}</dd></div><div><dt>受影响订单</dt><dd>{{ selectedDynamicVersion.affectedOrderIds.length }}</dd></div><div><dt>生效时刻</dt><dd>{{ formatDuration(selectedDynamicVersion.effectiveSimulationTimeMs) }}</dd></div></dl><p class="dynamic-audit-summary">事件 {{ selectedDynamicVersion.eventId ? '已关联' : '未关联' }} · 内容哈希 {{ selectedDynamicVersion.contentHash.slice(0, 12) || '历史版本' }} · 提交人 {{ selectedDynamicVersion.submittedBy ?? '待提交' }}</p><article v-for="evidence in selectedDynamicVersion.checkResult.evidence" :key="`${evidence.code}-${evidence.scheduleItemIds.join('-')}`" :class="evidence.severity.toLowerCase()"><Warning /><div><strong>{{ evidence.code }}</strong><small>{{ evidence.message }}</small></div></article><el-button type="primary" :disabled="selectedDynamicVersion.status !== 'DRAFT' || !selectedDynamicVersion.checkResult.submittable" @click="submitDynamicVersion">提交并立即生效</el-button></template><span v-else>调整时刻表并保存后，系统将在这里显示核定结果。</span></section>
      </div>
    </el-drawer>
  </section>
</template>

<style scoped>
.logistics-runtime-workspace { position: relative; display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0,1fr) minmax(0,1fr) 226px; grid-template-rows: 62px minmax(360px,1fr) 208px; min-width: 0; min-height: 0; overflow: hidden; color: #20322b; background: #e5ebe8; }
.logistics-runtime-workspace.has-restart { grid-template-rows: 96px minmax(360px,1fr) 208px; }
.runtime-commandbar { grid-column: 1 / 4; display: grid; grid-template-columns: minmax(190px,1fr) 180px auto auto; align-items: center; gap: 12px; border-bottom: 1px solid #cdd8d3; padding: 8px 14px; background: #fff; }.runtime-commandbar > div:first-child { display: grid; gap: 1px; }.runtime-commandbar span,.runtime-fleet-panel header span,.runtime-mission-table header span,.runtime-alert-deck > header span,.student-runtime-actions header span,.teacher-event-console header span,.runtime-route-list header span { color: #287255; font-size: 11px; font-weight: 800; }.runtime-commandbar strong { font-size: 15px; }.runtime-commandbar small { color: #71837b; font-size: 11px; }.runtime-commandbar dl { display: flex; margin: 0; }.runtime-commandbar dl div { min-width: 66px; border-left: 1px solid #dde4e1; padding: 0 10px; }.runtime-commandbar dt { color: #778981; font-size: 11px; }.runtime-commandbar dd { margin: 2px 0 0; font-size: 14px; font-weight: 800; font-variant-numeric: tabular-nums; }.runtime-commandbar dd.danger { color: #a5403a; }.runtime-command-actions { display: flex; align-items: center; gap: 5px; }.clock-rate { width: 82px; }
.runtime-attempts { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 1px 6px; min-width: 0; }.runtime-attempts > span { grid-column: 1 / 3; }.runtime-attempts .el-select { min-width: 0; }.runtime-attempts small { color: #a56b18; }.runtime-attempts .el-button { padding: 0; font-size: 11px; }
.runtime-restart-bar { grid-column: 1 / -1; display: flex; min-width: 0; align-items: center; gap: 8px; border-top: 1px solid #ead9b8; padding: 5px 0 0; background: #fffaf0; }.runtime-restart-bar > span { flex: 0 0 auto; color: #8a5a12; font-size: 11px; font-weight: 800; }.runtime-restart-bar .el-select { width: min(380px, 42vw); }
.runtime-stream-status { display: inline-flex; align-items: center; gap: 5px; color: #64766e; font-size: 11px; white-space: nowrap; }.runtime-stream-status i { width: 6px; height: 6px; border-radius: 50%; background: #a8b5ae; }.runtime-stream-status.live { color: #1c8058; }.runtime-stream-status.live i { background: #20a66a; }.runtime-stream-status.reconnecting,.runtime-stream-status.fallback { color: #a36c12; }.runtime-stream-status.reconnecting i,.runtime-stream-status.fallback i { background: #d99a2b; }
.runtime-mobile-summary,.runtime-mobile-nav { display: none; }
.runtime-fleet-panel { grid-column: 3; grid-row: 2; display: grid; grid-template-rows: 52px 42px minmax(0,1fr); min-height: 0; overflow: hidden; border-left: 1px solid #ccd7d2; background: #f8faf9; }.runtime-fleet-panel > header,.runtime-mission-table > header,.runtime-alert-deck > header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #d9e1dd; padding: 8px 10px; background: #fff; }.runtime-fleet-panel > header > div,.runtime-mission-table > header > div { display: grid; gap: 1px; }.runtime-fleet-panel header strong,.runtime-mission-table header strong { font-size: 11px; }.runtime-fleet-panel header b { color: #247354; font-size: 11px; }.runtime-fleet-summary { display: grid; grid-template-columns: repeat(4,1fr); border-bottom: 1px solid #d9e1dd; background: #fff; }.runtime-fleet-summary span { display: grid; place-items: center; align-content: center; gap: 1px; border-right: 1px solid #e0e6e3; color: #74867e; font-size: 11px; }.runtime-fleet-summary span:last-child { border-right: 0; }.runtime-fleet-summary b { color: #263a32; font-size: 12px; }.runtime-aircraft-list { min-height: 0; overflow: auto; }.runtime-aircraft-list button { display: grid; grid-template-columns: 28px minmax(0,1fr) 31px; align-items: center; gap: 5px; width: 100%; min-height: 43px; border: 0; border-bottom: 1px solid #e0e6e3; border-left: 3px solid #6f847a; padding: 4px 6px; text-align: left; background: transparent; cursor: pointer; }.runtime-aircraft-list button.outbound,.runtime-aircraft-list button.returning,.runtime-aircraft-list button.taking_off { border-left-color: #287255; }.runtime-aircraft-list button.holding,.runtime-aircraft-list button.diverting { border-left-color: #ba8127; }.runtime-aircraft-list button.emergency_landing,.runtime-aircraft-list button.disabled { border-left-color: #b4433d; }.runtime-aircraft-list button.selected { background: #e4f0ea; }.runtime-aircraft-list i { display: grid; width: 25px; height: 25px; place-items: center; color: #21694f; background: #dcece5; font-size: 11px; font-style: normal; font-weight: 800; }.runtime-aircraft-list button > div { display: grid; gap: 2px; min-width: 0; }.runtime-aircraft-list strong { font-size: 11px; }.runtime-aircraft-list small { overflow: hidden; color: #74867e; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.runtime-aircraft-list em { font-size: 11px; font-style: normal; font-weight: 800; }
.runtime-map-panel { position: relative; z-index: 1; grid-column: 1 / 3; grid-row: 2; min-width: 0; min-height: 0; overflow: hidden; }.runtime-map-panel.map-fullscreen { position: fixed; inset: 0; z-index: 1000; display: grid; grid-template-rows: 78px minmax(0,1fr); width: 100vw; height: 100vh; background: #fff; box-shadow: 0 18px 60px rgba(15,40,31,.28); }.runtime-map-panel.map-fullscreen :deep(.logistics-runtime-map-shell) { grid-row: 2; min-height: 0; }.runtime-map-actions { position: absolute; z-index: 9; top: 10px; right: 10px; pointer-events: auto; }.runtime-map-actions .el-button { border: 1px solid rgba(39,105,79,.2); color: #205f48; background: rgba(255,255,255,.92); box-shadow: 0 3px 12px rgba(18,51,40,.14); }.runtime-aircraft-monitor { position: absolute; z-index: 3; top: 11px; left: 11px; width: min(510px, calc(100% - 22px)); border: 1px solid rgba(255,255,255,.5); color: #20322b; background: rgba(255,255,255,.94); box-shadow: 0 5px 18px rgba(18,51,40,.14); }.runtime-aircraft-monitor > header { display: flex; align-items: center; justify-content: space-between; min-height: 30px; border-bottom: 1px solid #d8e2dd; padding: 5px 8px; }.runtime-aircraft-monitor > header div { display: grid; gap: 1px; }.runtime-aircraft-monitor > header span { color: #287255; font-size: 11px; font-weight: 800; }.runtime-aircraft-monitor > header strong { font-size: 11px; }.runtime-aircraft-monitor > header small { color: #74867e; font-size: 11px; }.runtime-aircraft-monitor > header em { color: #64786f; font-size: 11px; font-style: normal; }.runtime-aircraft-monitor > div { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); }.runtime-aircraft-monitor dl { min-width: 0; min-height: 35px; margin: 0; border-right: 1px solid #e0e7e3; border-bottom: 1px solid #e0e7e3; padding: 5px 7px; }.runtime-aircraft-monitor dl:nth-child(3n) { border-right: 0; }.runtime-aircraft-monitor dl:nth-last-child(-n+3) { border-bottom: 0; }.runtime-aircraft-monitor dt { color: #74867e; font-size: 11px; }.runtime-aircraft-monitor dd { margin: 2px 0 0; overflow: hidden; color: #263a31; font-size: 11px; font-weight: 750; line-height: 1.25; overflow-wrap: anywhere; }.runtime-aircraft-monitor dl.warning dd { color: #996a1e; }.runtime-aircraft-monitor dl.danger dd { color: #aa413b; }.runtime-aircraft-monitor dl.normal dd { color: #246f54; }.runtime-environment-strip { position: absolute; z-index: 3; right: 11px; bottom: 69px; display: flex; border: 1px solid rgba(255,255,255,.46); background: rgba(255,255,255,.92); }.runtime-environment-strip span { border-right: 1px solid #d9e1dd; padding: 7px 8px; color: #4e675d; font-size: 11px; }.runtime-environment-strip span:last-child { border-right: 0; }.runtime-start-overlay { position: absolute; z-index: 4; inset: 0; display: grid; align-content: center; justify-items: center; gap: 7px; background: rgba(231,238,234,.87); backdrop-filter: blur(3px); }.runtime-start-overlay .el-icon { color: #247354; font-size: 34px; }.runtime-start-overlay strong { font-size: 15px; }.runtime-start-overlay span { color: #657970; font-size: 11px; }
.runtime-aircraft-monitor .next-task-strip { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 2px 8px; border-top: 1px solid #d8e2dd; padding: 6px 8px; background: #f5f9f7; }.next-task-strip span { color: #74867e; font-size: 11px; }.next-task-strip strong { grid-column: 2 / 4; min-width: 0; overflow: hidden; color: #246f54; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.next-task-strip small { grid-column: 2 / 4; color: #71837b; font-size: 11px; }.next-task-strip .next-task-window { grid-column: 2; }.next-task-strip .next-task-reason { grid-column: 3; font-weight: 800; }.next-task-strip .next-task-reason.warning { color: #996a1e; }.next-task-strip .next-task-reason.danger { color: #aa413b; }.next-task-strip .next-task-reason.normal { color: #246f54; }
@media (min-width: 861px) {
  .runtime-map-panel { display: grid; grid-template-rows: 78px minmax(0,1fr); background: #fff; }
  .runtime-map-panel :deep(.logistics-runtime-map-shell) { grid-row: 2; min-height: 0; }
  .runtime-aircraft-monitor { position: relative; z-index: 4; top: auto; left: auto; display: grid; grid-row: 1; grid-template-columns: minmax(105px,128px) minmax(0,1fr); grid-template-rows: 44px 33px; width: 100%; border-width: 0 0 1px; background: #fff; box-shadow: none; }
  .runtime-aircraft-monitor > header { grid-column: 1; grid-row: 1 / 3; flex-direction: column; align-items: flex-start; justify-content: center; border-right: 1px solid #d8e2dd; border-bottom: 0; }
  .runtime-aircraft-monitor > div:not(.next-task-strip) { grid-column: 2; grid-row: 1; grid-template-columns: repeat(5,minmax(0,1fr)); }
  .runtime-aircraft-monitor dl { min-height: 0; padding: 4px 6px; }
  .runtime-aircraft-monitor dl:nth-child(3n) { border-right: 1px solid #e0e7e3; }
  .runtime-aircraft-monitor dl:nth-child(5n) { border-right: 0; }
  .runtime-aircraft-monitor .next-task-strip { grid-column: 2; grid-row: 2; align-items: center; min-width: 0; border-top: 1px solid #d8e2dd; padding: 4px 7px; }
}
.runtime-control-panel { grid-column: 3; grid-row: 2; min-height: 0; overflow: auto; border-left: 1px solid #ccd7d2; background: #f9fbfa; }.runtime-control-panel > section { border-bottom: 1px solid #d8e1dc; padding: 9px 10px; }.runtime-control-panel section > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }.runtime-control-panel section > header strong { font-size: 10px; }.order-operation-summary dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: 0; background: #dce4e0; }.order-operation-summary dl div { display: flex; justify-content: space-between; padding: 6px 7px; background: #fff; }.order-operation-summary dt,.order-operation-summary dd { margin: 0; font-size: 11px; }.order-operation-summary dd { font-weight: 800; }.order-operation-summary dd.warning { color: #95691d; }.order-operation-summary dd.danger { color: #a3423b; }.student-runtime-actions,.teacher-event-console { display: grid; gap: 6px; }.student-runtime-actions label { display: grid; grid-template-columns: 58px minmax(0,1fr); align-items: center; gap: 5px; }.student-runtime-actions label span { color: #64776e; font-size: 11px; }.student-runtime-actions :deep(.el-input-number),.student-runtime-actions :deep(.el-select) { width: 100%; }.runtime-route-list { padding: 0 !important; }.runtime-route-list > header { margin: 0 !important; padding: 9px 10px; }.runtime-route-list button { display: grid; grid-template-columns: 4px minmax(0,1fr) 40px; align-items: center; gap: 6px; width: 100%; min-height: 39px; border: 0; border-top: 1px solid #e0e6e3; padding: 4px 7px; text-align: left; background: transparent; cursor: pointer; }.runtime-route-list button.selected { background: #e7f1ec; }.runtime-route-list button i { width: 4px; height: 24px; background: #2b7358; }.runtime-route-list button.risk i,.runtime-route-list button.paused i { background: #b47c26; }.runtime-route-list button.abnormal i,.runtime-route-list button.closed i { background: #b2453e; }.runtime-route-list button > div { display: grid; gap: 2px; min-width: 0; }.runtime-route-list button strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.runtime-route-list button small { color: #74867e; font-size: 11px; }.runtime-route-list button em { font-size: 11px; font-style: normal; text-align: right; }.complete-emergency { width: calc(100% - 20px); margin: 10px; }
.runtime-side-tabs { display: flex !important; align-items: stretch; gap: 2px !important; min-width: 0; }.runtime-side-tabs button { display: inline-flex; align-items: center; gap: 4px; min-width: 0; border: 0; border-bottom: 2px solid transparent; padding: 4px 5px; color: #71837b; background: transparent; cursor: pointer; font: inherit; font-size: 11px; font-weight: 800; white-space: nowrap; }.runtime-side-tabs button .el-icon { font-size: 12px; }.runtime-side-tabs button.active { border-bottom-color: #287255; color: #1f6e50; background: #edf5f1; }.runtime-side-tabs-control { min-height: 42px; border-bottom: 1px solid #d8e1dc; padding: 0 7px; }
.action-reasoning-fields { display: grid; gap: 5px; border-left: 2px solid #287255; padding-left: 7px; }.action-reasoning-fields label { display: grid; gap: 3px; }.action-reasoning-fields label > span { color: #5f776b; font-size: 11px; font-weight: 700; }
.action-reasoning-fields :deep(textarea) { min-height: 42px !important; font-size: 11px; line-height: 1.45; resize: vertical; }
.runtime-selected-alert { display: grid; gap: 7px; border: 1px solid #d6e0db; border-left: 3px solid #b67b20; padding: 8px; background: #fff; }.runtime-selected-alert > header { display: flex; align-items: center; justify-content: space-between; }.runtime-selected-alert > header span { color: #6b7c74; font-size: 11px; }.runtime-selected-alert > header em { font-size: 11px; font-style: normal; font-weight: 800; }.runtime-selected-alert > header em.warning { color: #9a6819; }.runtime-selected-alert > header em.danger { color: #aa413b; }.runtime-selected-alert > strong { font-size: 10px; }
.runtime-teaching-briefing { display: grid; gap: 1px; margin: 0; background: #dfe7e3; }.runtime-teaching-briefing > div { display: grid; grid-template-columns: 58px minmax(0,1fr); gap: 7px; padding: 5px 6px; background: #f8faf9; }.runtime-teaching-briefing dt,.runtime-teaching-briefing dd { margin: 0; font-size: 11px; line-height: 1.45; }.runtime-teaching-briefing dt { color: #657970; font-weight: 800; }.runtime-teaching-briefing dd { color: #263a31; overflow-wrap: anywhere; }.runtime-teaching-briefing dd.warning { color: #996a1e; }.runtime-teaching-briefing dd.danger { color: #aa413b; }
.runtime-business-result { display: grid; gap: 4px; border-top: 1px solid #d8e2dd; padding-top: 7px; }.runtime-business-result > strong { color: #246f54; font-size: 11px; }.runtime-business-result ul { display: grid; gap: 3px; margin: 0; padding-left: 15px; }.runtime-business-result li,.runtime-business-result p,.runtime-business-result small { margin: 0; color: #536a60; font-size: 11px; line-height: 1.45; }.runtime-business-result small { color: #287255; font-weight: 750; }
.execute-runtime-action { position: sticky; z-index: 2; bottom: 0; width: 100%; box-shadow: 0 -6px 12px rgba(249,251,250,.96); }
.recent-action-records { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }.recent-action-records li { display: grid; gap: 2px; border-top: 1px solid #d8e2dd; padding-top: 6px; }.recent-action-records strong { font-size: 11px; }.recent-action-records span { overflow: hidden; color: #60736a; font-size: 11px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }.recent-action-records em { color: #287255; font-size: 11px; font-style: normal; }
.runtime-mission-table { grid-column: 1; grid-row: 3; min-width: 0; min-height: 0; overflow: hidden; background: #fff; }.runtime-mission-table > header small { color: #70827a; font-size: 11px; }.runtime-mission-head,.runtime-mission-body button { display: grid; grid-template-columns: minmax(105px,1.2fr) 70px 78px 65px 65px 65px 40px; align-items: center; gap: 5px; min-width: 520px; }.runtime-mission-head { height: 27px; border-bottom: 1px solid #dce4e0; padding: 0 8px; color: #73857d; background: #f3f6f4; font-size: 11px; }.runtime-mission-body { max-height: 141px; overflow: auto; }.runtime-mission-body button { width: 100%; min-height: 38px; border: 0; border-bottom: 1px solid #e2e8e5; border-left: 3px solid #6f847a; padding: 4px 8px; text-align: left; background: #fff; cursor: pointer; }.runtime-mission-body button.outbound,.runtime-mission-body button.returning { border-left-color: #277155; }.runtime-mission-body button.failed,.runtime-mission-body button.cancelled { border-left-color: #b3433d; }.runtime-mission-body button.selected { background: #e8f2ed; }.runtime-mission-body button > span:first-child { display: grid; gap: 1px; min-width: 0; }.runtime-mission-body strong,.runtime-mission-body span,.runtime-mission-body em,.runtime-mission-body b { font-size: 11px; font-style: normal; }.runtime-mission-body small { overflow: hidden; color: #778981; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.runtime-mission-body em { color: #276f54; font-weight: 800; }
.runtime-alert-deck { grid-column: 2; grid-row: 3; min-width: 0; min-height: 0; overflow: hidden; border-top: 1px solid #ccd7d2; background: #fff; }.runtime-alert-deck > header { height: 36px; }.runtime-alert-deck > header > div { display: flex; align-items: center; gap: 6px; }.runtime-alert-deck > header strong { font-size: 10px; }.runtime-alert-deck > header small { color: #70827a; font-size: 11px; }.runtime-alert-list { display: flex; gap: 7px; min-height: 82px; padding: 7px 10px; overflow-x: auto; }.runtime-alert-list article { display: grid; flex: 0 0 260px; grid-template-columns: 17px minmax(0,1fr) auto; gap: 6px; border: 1px solid #d9e1dd; border-left: 3px solid #bd8429; padding: 6px; cursor: pointer; }.runtime-alert-list article.error,.runtime-alert-list article.critical { border-left-color: #b4433d; }.runtime-alert-list article.resolved { border-left-color: #4c806a; background: #f7faf8; }.runtime-alert-list article.selected { background: #eaf3ee; }.runtime-alert-list article > div { display: grid; gap: 1px; }.runtime-alert-list article span,.runtime-alert-list article p,.runtime-alert-list article em { font-size: 11px; font-style: normal; }.runtime-alert-list article strong { font-size: 11px; }.runtime-alert-list article p { margin: 0; color: #6f8179; line-height: 1.35; }.runtime-alert-list article .el-button { grid-column: 3; align-self: end; padding: 0 3px; font-size: 11px; }.runtime-alert-card-actions { align-content: start; }.runtime-alert-empty { display: flex; flex: 1; align-items: center; justify-content: center; gap: 6px; color: #5f766b; }.runtime-alert-empty strong { font-size: 11px; }.runtime-event-strip { display: flex; gap: 14px; height: 42px; align-items: center; margin: 0; border-top: 1px solid #e0e6e3; padding: 0 11px; overflow-x: auto; list-style: none; }.runtime-event-strip li { display: grid; flex: 0 0 auto; grid-template-columns: 7px 38px minmax(80px,auto) auto; align-items: center; gap: 5px; padding: 4px; cursor: pointer; }.runtime-event-strip li.selected { background: #edf4f0; }.runtime-event-strip i { width: 7px; height: 7px; border-radius: 50%; background: #8da097; }.runtime-event-strip li.discovered i,.runtime-event-strip li.handling i { background: #bd8429; }.runtime-event-strip li.escalated i { background: #b4433d; }.runtime-event-strip li.controlled i,.runtime-event-strip li.ended i { background: #287255; }.runtime-event-strip span,.runtime-event-strip em { color: #71837b; font-size: 11px; font-style: normal; }.runtime-event-strip strong { font-size: 11px; }
.dynamic-schedule-drawer { display: grid; gap: 13px; color: #20322b; }.dynamic-schedule-drawer > header { display: flex; justify-content: space-between; align-items: end; border-bottom: 1px solid #d7e0dc; padding-bottom: 10px; }.dynamic-schedule-drawer > header > div { display: grid; gap: 2px; }.dynamic-schedule-drawer > header span { color: #287255; font-size: 11px; font-weight: 800; }.dynamic-schedule-drawer > header strong { font-size: 15px; }.dynamic-schedule-drawer > header em { color: #a24941; font-size: 11px; font-style: normal; }.dynamic-schedule-form { display: grid; grid-template-columns: 150px minmax(180px,1fr) auto; align-items: end; gap: 8px; }.dynamic-schedule-form label { display: grid; gap: 4px; }.dynamic-schedule-form label span { color: #687b72; font-size: 11px; }.dynamic-schedule-table { border: 1px solid #d7e0dc; overflow-x: auto; }.dynamic-head,.dynamic-row { display: grid; grid-template-columns: 90px 105px 86px minmax(150px,1fr) minmax(150px,1fr); align-items: center; gap: 6px; min-width: 620px; padding: 6px 8px; }.dynamic-head { color: #70827a; background: #f1f5f3; font-size: 11px; }.dynamic-row { min-height: 47px; border-top: 1px solid #e0e6e3; }.dynamic-row.locked { background: #f3f5f4; opacity: .68; }.dynamic-row > span { display: grid; gap: 1px; }.dynamic-row strong { font-size: 11px; }.dynamic-row small { color: #74867e; font-size: 11px; }.dynamic-row :deep(.el-select),.dynamic-row :deep(.el-input-number) { width: 100%; }.dynamic-version-result { display: grid; gap: 8px; border-top: 1px solid #d7e0dc; padding-top: 12px; }.dynamic-version-result > header { display: flex; align-items: center; justify-content: space-between; }.dynamic-version-result > header strong { font-size: 11px; }.dynamic-version-result > header .el-select { width: 180px; }.dynamic-version-result dl { display: grid; grid-template-columns: repeat(4,1fr); margin: 0; border: 1px solid #d9e1dd; }.dynamic-version-result dl div { border-right: 1px solid #d9e1dd; padding: 7px; }.dynamic-version-result dl div:last-child { border-right: 0; }.dynamic-version-result dt { color: #71837b; font-size: 11px; }.dynamic-version-result dd { margin: 2px 0 0; font-size: 11px; font-weight: 800; }.dynamic-version-result article { display: grid; grid-template-columns: 18px minmax(0,1fr); gap: 5px; border-left: 3px solid #bc8228; padding: 6px 8px; background: #fffaf0; }.dynamic-version-result article.conflict { border-left-color: #b3433d; background: #fff7f6; }.dynamic-version-result article > div { display: grid; gap: 1px; }.dynamic-version-result article strong { font-size: 11px; }.dynamic-version-result article small,.dynamic-version-result > span { color: #6e8178; font-size: 11px; }
@media (max-width: 1180px) { .logistics-runtime-workspace { grid-template-columns: minmax(0,1fr) minmax(0,1fr) 210px; }.runtime-commandbar { grid-template-columns: minmax(190px, 1fr) 180px auto; }.runtime-commandbar dl { display: none; } }
@media (max-width: 860px) {
  .logistics-runtime-workspace,.logistics-runtime-workspace.has-restart { grid-column: 2 / 4; grid-row: 2 / 3; grid-template-columns: 1fr; grid-template-rows: auto 460px 360px 260px 240px; overflow: auto; scroll-behavior: smooth; scroll-padding-top: 160px; }
  .runtime-commandbar { position: sticky; z-index: 8; top: 0; grid-column: 1; grid-row: 1; grid-template-columns: minmax(0,1fr) minmax(150px,190px); gap: 7px 10px; padding: 7px 10px 0; box-shadow: 0 4px 12px rgba(18,51,40,.12); pointer-events: none; }
  .runtime-commandbar > .runtime-attempts,
  .runtime-commandbar > .runtime-command-actions,
  .runtime-commandbar > .runtime-mobile-nav,
  .runtime-commandbar .el-button,
  .runtime-commandbar .el-select { pointer-events: auto; }
  .runtime-command-actions { grid-column: 1 / 3; overflow-x: auto; }
  .runtime-restart-bar { grid-column: 1 / 3; }
  .runtime-restart-bar .el-select { width: min(280px,48vw); }
  .runtime-mobile-summary { display: grid; grid-column: 1 / 3; grid-template-columns: 1fr 1fr 82px; gap: 1px; min-width: 0; border: 1px solid #dce4e0; background: #dce4e0; }
  .runtime-mobile-summary > span { display: grid; min-width: 0; gap: 1px; padding: 5px 7px; background: #f8faf9; }
  .runtime-mobile-summary small { overflow: hidden; color: #71837b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .runtime-mobile-summary b { overflow: hidden; color: #263a32; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .runtime-mobile-summary .danger b { color: #aa413b; }
  .runtime-mobile-nav { display: grid; grid-column: 1 / 3; grid-template-columns: repeat(5,minmax(0,1fr)); margin: 0 -10px; border-top: 1px solid #d7e1dc; background: #f5f8f6; }
  .runtime-mobile-nav button { position: relative; display: grid; min-width: 0; min-height: 43px; grid-template-columns: auto auto; place-content: center; align-items: center; gap: 2px 4px; border: 0; border-right: 1px solid #dde5e1; border-bottom: 3px solid transparent; color: #61756c; background: transparent; cursor: pointer; }
  .runtime-mobile-nav button:last-child { border-right: 0; }
  .runtime-mobile-nav button.active { border-bottom-color: #247354; color: #185d45; background: #e7f1ec; }
  .runtime-mobile-nav button.danger:not(.active) { color: #9e3f39; }
  .runtime-mobile-nav .el-icon { font-size: 14px; }
  .runtime-mobile-nav span { font-size: 11px; font-weight: 800; }
  .runtime-mobile-nav b { display: grid; min-width: 15px; height: 15px; place-items: center; border-radius: 8px; padding: 0 4px; color: #fff; background: #6f8279; font-size: 11px; }
  .runtime-mobile-nav button.danger b { background: #a8423c; }
  .runtime-map-panel { grid-column: 1; grid-row: 2; scroll-margin-top: 148px; }
  .runtime-map-panel :deep(.v3-map-view-controls) { scroll-margin-top: 154px; }
  .runtime-fleet-panel { grid-column: 1; grid-row: 3; border-right: 0; border-left: 0; scroll-margin-top: 148px; }
  .runtime-control-panel { grid-column: 1; grid-row: 3; border-left: 0; scroll-margin-top: 148px; scroll-padding-top: 160px; }
  .runtime-mission-table { grid-column: 1; grid-row: 4; overflow-x: auto; scroll-margin-top: 148px; }
  .runtime-alert-deck { grid-column: 1; grid-row: 5; scroll-margin-top: 148px; }
  .runtime-mission-body { max-height: 169px; }
  .runtime-alert-list { min-height: 116px; }
  .runtime-environment-strip { max-width: calc(100% - 22px); overflow-x: auto; }
  .runtime-action-error { position: fixed; z-index: 20; right: 8px; bottom: 8px; left: 8px; scroll-margin-top: 160px; }
  .runtime-action-error .el-button { scroll-margin-top: 160px; }
  .dynamic-schedule-form { grid-template-columns: 1fr; }
}
@media (max-width: 760px) { .logistics-runtime-workspace { grid-column: 1; grid-row: 3 / 5; } }
@media (max-width: 560px) {
  .runtime-commandbar { grid-template-columns: minmax(0,1fr) minmax(138px,46%); }
  .runtime-commandbar > div:first-child strong { font-size: 13px; }
  .runtime-mobile-summary { grid-template-columns: 1fr 1fr 70px; }
  .runtime-map-panel { display: grid; grid-template-rows: auto minmax(0,1fr); background: #fff; }
  .runtime-map-panel :deep(.logistics-runtime-map-shell) { grid-row: 2; min-height: 0; }
  .runtime-map-panel :deep(.v3-map-view-controls) { top: 12px; right: 12px; }
  .runtime-environment-strip { right: 8px; bottom: 82px; max-width: calc(100% - 16px); }
  .runtime-aircraft-monitor { position: relative; z-index: 4; grid-row: 1; top: auto; left: auto; width: 100%; border-width: 0 0 1px; box-shadow: none; }
}
@media (prefers-reduced-motion: reduce) { .logistics-runtime-workspace { scroll-behavior: auto; } }
.dynamic-audit-summary { margin: 0; color: #61766c; font-size: 11px; line-height: 1.5; word-break: break-word; }
.runtime-alert-list article:focus-visible { outline: 2px solid #287255; outline-offset: 2px; }
.runtime-event-strip li:focus-visible { outline: 2px solid #287255; outline-offset: 2px; }
.runtime-map-panel:focus-visible,.runtime-fleet-panel:focus-visible,.runtime-control-panel:focus-visible,.runtime-mission-table:focus-visible,.runtime-alert-deck:focus-visible { outline: 3px solid #287255; outline-offset: -3px; }
.runtime-aircraft-monitor,.runtime-environment-strip { pointer-events: none; }
.runtime-action-error { position: relative; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid #e3b8b3; border-left: 3px solid #b4433d; padding: 7px 8px; background: #fff6f5; color: #8c3933; font-size: 11px; line-height: 1.4; pointer-events: auto; }
.runtime-load-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid #e2b7b2; padding: 8px 12px; background: #fff7f6; color: #783f39; }.runtime-load-error span { display: grid; gap: 2px; min-width: 0; }.runtime-load-error strong { font-size: 10px; }.runtime-load-error small { font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }.runtime-load-error .el-button { flex: 0 0 auto; }
.runtime-aircraft-monitor > header { align-items: center; gap: 4px; padding: 3px 6px; text-align: center; }.runtime-aircraft-monitor > header div { justify-items: center; text-align: center; }.runtime-aircraft-monitor > header em { line-height: 1.1; }.runtime-aircraft-monitor dl { padding: 3px 5px; }.runtime-aircraft-monitor dt,.runtime-aircraft-monitor dd { line-height: 1.1; text-align: center; white-space: nowrap; text-overflow: ellipsis; }.runtime-aircraft-monitor dd { margin-top: 1px; }.runtime-aircraft-monitor .next-task-strip { align-items: center; line-height: 1.1; padding: 3px 6px; }.runtime-aircraft-monitor .next-task-strip strong,.runtime-aircraft-monitor .next-task-strip small { line-height: 1.1; }
.runtime-map-actions { top: auto; right: auto; bottom: 111px; left: 14px; }.runtime-map-actions .el-button { min-height: 34px; padding: 0 10px; }
.runtime-alert-deck { border-top-color: #fff; }.runtime-alert-deck > header { border-bottom-color: #fff; }.runtime-alert-list article { border-color: #fff; border-left: 3px solid #bd8429; }.runtime-alert-list article.error,.runtime-alert-list article.critical { border-left-color: #b4433d; }.runtime-alert-list article.resolved { border-left-color: #4c806a; }.runtime-event-strip { border-top-color: #fff; }
@media (min-width: 861px) { .runtime-fleet-panel,.runtime-control-panel { grid-row: 2 / 4; }.runtime-map-panel,.runtime-map-panel.map-fullscreen { grid-template-rows: 91px minmax(0,1fr); }.runtime-aircraft-monitor { grid-template-rows: 58px 33px; }.runtime-aircraft-monitor > header { padding: 2px 6px; }.runtime-aircraft-monitor > div:not(.next-task-strip) { grid-template-rows: repeat(2,minmax(0,1fr)); align-items: stretch; }.runtime-aircraft-monitor dl { min-height: 0; display: grid; align-content: center; box-sizing: border-box; padding: 2px 4px; }.runtime-aircraft-monitor .next-task-strip { padding: 2px 6px; } }

@media (max-width: 1080px) {
  .logistics-runtime-workspace, .logistics-runtime-workspace.has-restart { grid-column: 2 / 4; grid-row: 2 / 4; grid-template-columns: 1fr; grid-template-rows: auto 440px 340px 250px 230px; overflow: auto; scroll-padding-top: 150px; }
  .runtime-commandbar { grid-column: 1; grid-row: 1; }
  .runtime-map-panel { grid-column: 1; grid-row: 2; }
  .runtime-fleet-panel, .runtime-control-panel { grid-column: 1; grid-row: 3; border-left: 0; border-top: 1px solid #ccd7d2; }
  .runtime-mission-table { grid-column: 1; grid-row: 4; overflow-x: auto; }
  .runtime-alert-deck { grid-column: 1; grid-row: 5; }
}
@media (max-width: 760px) {
  .logistics-runtime-workspace, .logistics-runtime-workspace.has-restart { grid-column: 1; grid-row: 3 / 5; grid-template-rows: auto 380px 330px 230px 220px; }
}
@media (max-width: 420px) {
  .logistics-runtime-workspace, .logistics-runtime-workspace.has-restart { grid-template-rows: auto 320px 330px 220px 210px; }
  .runtime-mobile-nav button { min-height: 38px; }
  .runtime-aircraft-monitor > div:not(.next-task-strip) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .runtime-mission-head, .runtime-mission-body button { min-width: 500px; }
}

</style>
