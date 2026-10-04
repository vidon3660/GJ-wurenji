<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Bell, CircleCheck, Refresh, VideoPause, VideoPlay, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  ShowRuntimeActionCode,
  ShowRuntimeWorkspaceView,
  StudentProjectStageView,
  StudentProjectView,
  V3RuntimeAlertView,
  V3RegionCatalogItem,
  V3RegionLayerCode,
  V3RuntimeActionReasoning
} from "@wurenji/shared"
import { api } from "../api"
import { createClientId } from "../client-id"
import { formatPlatformDate } from "../platform-date"
import { openRuntimeStream, type RuntimeStreamConnectionState, type RuntimeStreamController } from "../runtime-stream"
import type { V3MapDataState } from "../map-loading-state"
import { runtimeActionReasoning, runtimeActionResultLabel } from "../runtime-action-reasoning"
import { runtimeActionOptionLabel } from "../runtime-action-targets"
import { latestRuntimeAction, pickRecommendedRuntimeAction, pickRuntimeTargetId, preferredRuntimeAlertId, runtimeAlertStatusLabel, runtimeAlertTiming, runtimeRecommendedActionLabel } from "../runtime-alert-presentation"
import { showRuntimeAlertPresentation } from "../show-runtime-alert"
import { showRuntimeEnvironmentMetrics, showRuntimeEnvironmentSummary, showRuntimeSupportMetrics } from "../show-runtime-environment"
import { showRuntimeMonitorMetrics } from "../show-runtime-monitor"
import { showActionBusinessConsequences, showActionEvidence, showEventBriefing } from "../show-runtime-briefing"
import { formatRuntimeSessionStatus, formatShowGroupCode } from "../terminology"
import { buildShowRuntimeSchedule } from "../show-runtime-schedule"
import { runtimeEventCategoryLabel, runtimeEventSource } from "../runtime-event-source"
import { shouldApplyRuntimeWorkspace } from "../runtime-workspace-consistency"
import {
  advanceRuntimePlaybackTime,
  projectShowRuntimePlayback,
  runtimeTimelineMarkers,
  type RuntimeTimelineMarker
} from "../runtime-playback"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3RuntimePlaybackBar from "./V3RuntimePlaybackBar.vue"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
  region: V3RegionCatalogItem | null
  mapMode: "2d" | "3d"
  initialAlertId?: string
}>()
const localPerformanceDiagnostic = ["localhost", "127.0.0.1"].includes(window.location.hostname)
const diagnosticParams = new URLSearchParams(window.location.search)
const disableMapForPerformanceDiagnostic = localPerformanceDiagnostic && diagnosticParams.get("disableMap") === "1"
const disableStreamForPerformanceDiagnostic = localPerformanceDiagnostic && diagnosticParams.get("disableStream") === "1"
const emit = defineEmits<{
  refreshProject: []
  dataState: [state: V3MapDataState]
}>()

const loading = ref(false)
const snapshotLoading = ref(false)
let snapshotRequestCount = 0
const loadError = ref("")
const workspace = shallowRef<ShowRuntimeWorkspaceView | null>(null)
const selectedAlertId = ref("")
const selectedEventId = ref("")
const selectedGroupId = ref("")
const selectedActionCode = ref<ShowRuntimeActionCode | "">("")
const selectedTargetId = ref("")
const selectedRestartNodeCode = ref("")
const actionObservation = ref("")
const actionRationale = ref("")
const actionExpectedOutcome = ref("")
const actionSubmitting = ref(false)
const actionError = ref("")
const lastMutationError = ref("")
const actionResultPanel = ref<HTMLElement | null>(null)
const actionConsole = ref<HTMLElement | null>(null)
const teacherEventCode = ref("WEATHER_LIMIT")
const clockRate = ref(60)
const visibleMapLayers = ref<V3RegionLayerCode[]>([])
const playbackTimeMs = ref(0)
const replayRate = ref(1)
const replayPlaying = ref(false)

watch(() => props.region, (region) => {
  visibleMapLayers.value = region?.layers
    .filter((layer) => layer.state !== "UNAVAILABLE" && ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"].includes(layer.code))
    .map((layer) => layer.code) ?? []
}, { immediate: true, deep: true })
let runtimeStream: RuntimeStreamController | null = null
let initializationGeneration = 0
let terminalRefreshSent = false
let playbackTimer: number | null = null
let lastPlaybackTick = 0
const playbackTickIntervalMs = 100
const connectionState = ref<RuntimeStreamConnectionState>("CONNECTING")
const connectionStateLabel = computed(() => ({ CONNECTING: "连接中", LIVE: "实时在线", RECONNECTING: "正在重连", FALLBACK: "回退刷新", CLOSED: "已关闭" } as Record<RuntimeStreamConnectionState, string>)[connectionState.value])

const activeAlerts = computed(() => workspace.value?.alerts.filter((item) => item.status !== "RESOLVED") ?? [])
const recentResolvedAlerts = computed(() => [...(workspace.value?.alerts.filter((item) => item.status === "RESOLVED") ?? [])]
  .sort((left, right) => Number(right.simulationTimeMs ?? 0) - Number(left.simulationTimeMs ?? 0))
  .slice(0, 3))
const displayedAlerts = computed(() => [...activeAlerts.value, ...recentResolvedAlerts.value])
const activeAlertSignature = computed(() => displayedAlerts.value.map((item) => `${item.id}:${item.status}:${item.eventId}`).join("|"))
const selectedAlert = computed(() => displayedAlerts.value.find((item) => item.id === selectedAlertId.value) ?? activeAlerts.value[0] ?? recentResolvedAlerts.value[0] ?? null)
const selectedEvent = computed(() => workspace.value?.events.find((item) => item.id === selectedEventId.value)
  ?? workspace.value?.events.find((item) => item.id === selectedAlert.value?.eventId)
  ?? null)
const selectedEventHandled = computed(() => Boolean(selectedEvent.value && (selectedEvent.value.status === "RESOLVED" || ["CONTROLLED", "ENDED"].includes(selectedEvent.value.lifecycleStatus))))
const selectedEventAction = computed(() => {
  if (!selectedEvent.value) return null
  return latestRuntimeAction(workspace.value?.actions ?? [], selectedAlert.value?.id ?? "", selectedEvent.value.id)
})
const selectedEventRecommendedAction = computed(() => runtimeRecommendedActionLabel(selectedEvent.value?.recommendedActions ?? [], workspace.value?.availableActions ?? []))
const selectedEventBriefing = computed(() => selectedEvent.value ? showEventBriefing(selectedEvent.value, selectedEventRecommendedAction.value) : null)
const selectedEventTiming = computed(() => selectedEvent.value ? runtimeAlertTiming(selectedEvent.value, playbackTimeMs.value) : null)
const selectedEventConsequences = computed(() => showActionBusinessConsequences(selectedEventAction.value))
const selectedEventEvidence = computed(() => showActionEvidence(selectedEventAction.value))
const studentActions = computed(() => workspace.value?.availableActions.filter((item) => item.code !== "ACKNOWLEDGE_ALERT") ?? [])
const studentActionSignature = computed(() => studentActions.value.map((item) => `${item.code}:${item.enabled}`).join("|"))
const selectedAction = computed(() => workspace.value?.availableActions.find((item) => item.code === selectedActionCode.value) ?? null)
const actionTargetOptions = computed(() => selectedAction.value?.eligibleTargetIds.map((id) => ({ id, label: showActionTargetLabel(id) })) ?? [])
const actionTargetSignature = computed(() => actionTargetOptions.value.map((item) => item.id).join("|"))
const isHistoricalAttempt = computed(() => Boolean(workspace.value && workspace.value.attempts[0]?.id !== workspace.value.session.id))
const isReplayMode = computed(() => Boolean(workspace.value && (isHistoricalAttempt.value || ["COMPLETED", "ABORTED"].includes(workspace.value.session.status))))
const playbackDurationMs = computed(() => {
  if (!workspace.value) return 1
  if (workspace.value.session.status === "ABORTED" || (isHistoricalAttempt.value && workspace.value.session.status !== "COMPLETED")) {
    return Math.max(1, workspace.value.session.simulationTimeMs)
  }
  return Math.max(1, workspace.value.durationMs)
})
const playbackRate = computed(() => isReplayMode.value ? replayRate.value : clockRate.value)
const playbackPlaying = computed(() => isReplayMode.value ? replayPlaying.value : workspace.value?.session.status === "RUNNING")
const canChangeClock = computed(() => Boolean(workspace.value && !isHistoricalAttempt.value && props.project.mode === "TRAINING" && ["RUNNING", "PAUSED"].includes(workspace.value.session.status)))
const playbackRateOptions = computed(() => isReplayMode.value ? [0.5, 1, 2, 4] : [1, 5, 20, 60, 300, 600])
const playbackMarkers = computed(() => runtimeTimelineMarkers(workspace.value?.events ?? [], playbackDurationMs.value))
const playbackState = computed(() => {
  if (!workspace.value || !isReplayMode.value) return null
  const reconstruct = isReplayMode.value && Math.abs(playbackTimeMs.value - workspace.value.session.simulationTimeMs) > 500
  return projectShowRuntimePlayback(
    workspace.value.groups,
    workspace.value.totals,
    workspace.value.performanceCenter,
    workspace.value.performanceRadiusMeters,
    workspace.value.maximumHeightMeters,
    workspace.value.durationMs,
    playbackTimeMs.value,
    reconstruct,
    workspace.value.program.groupTracks ?? []
  )
})
// 实时运行时服务端按秒推送快照；用本地仿真时钟补齐两次快照之间的连续位置变化，
// 快照到达后 applyWorkspace 会重新校准时间，事件和计分仍以服务端状态为准。
const livePlaybackState = computed(() => {
  if (!workspace.value || isReplayMode.value || workspace.value.session.status !== "RUNNING") return null
  return projectShowRuntimePlayback(
    workspace.value.groups,
    workspace.value.totals,
    workspace.value.performanceCenter,
    workspace.value.performanceRadiusMeters,
    workspace.value.maximumHeightMeters,
    workspace.value.durationMs,
    playbackTimeMs.value,
    false,
    workspace.value.program.groupTracks ?? []
  )
})
const runtimeProgress = computed(() => Math.min(100, playbackTimeMs.value / Math.max(1, workspace.value?.durationMs ?? 1) * 100))
const runtimeMonitorMetrics = computed(() => showRuntimeMonitorMetrics(playbackState.value?.totals ?? workspace.value?.totals))
const runtimeEnvironmentMetrics = computed(() => showRuntimeEnvironmentMetrics(workspace.value?.environment))
const runtimeSupportMetrics = computed(() => showRuntimeSupportMetrics(workspace.value?.environment))
const groupSchedule = computed(() => buildShowRuntimeSchedule(
  playbackState.value?.groups ?? workspace.value?.groups ?? [],
  workspace.value?.events ?? [],
  playbackTimeMs.value
))
const actionReasoningValid = computed(() => [actionObservation.value, actionRationale.value, actionExpectedOutcome.value].every((item) => item.trim().length >= 4))
const recentActions = computed(() => [...(workspace.value?.actions ?? [])].reverse().slice(0, 3))
const playbackStatusLabel = computed(() => isReplayMode.value
  ? isHistoricalAttempt.value ? `第 ${workspace.value?.session.attemptNo ?? "-"} 次训练` : "本次训练回放"
  : formatRuntimeSessionStatus(workspace.value?.session.status ?? "READY"))

onMounted(() => {
  void initializeRuntimeStream()
  startPlaybackTimer()
})
onBeforeUnmount(() => {
  initializationGeneration += 1
  runtimeStream?.close()
  stopPlaybackTimer()
})
watch(() => props.project.id, () => {
  terminalRefreshSent = false
  replayPlaying.value = false
  playbackTimeMs.value = 0
  runtimeStream?.close()
  void initializeRuntimeStream()
})
watch(isReplayMode, (replay) => {
  if (replay) startPlaybackTimer()
})
watch(activeAlertSignature, () => {
  const items = displayedAlerts.value
  const selected = items.find((item) => item.id === selectedAlertId.value)
  if (selected?.status === "RESOLVED" && latestRuntimeAction(workspace.value?.actions ?? [], selected.id, selected.eventId)) return
  const nextId = preferredRuntimeAlertId(items, selectedAlertId.value)
  if (nextId !== selectedAlertId.value) selectAlert(nextId)
})
watch(() => workspace.value?.groups.map((group) => group.groupId).join("|") ?? "", () => {
  if (!workspace.value?.groups.some((group) => group.groupId === selectedGroupId.value)) selectedGroupId.value = workspace.value?.groups[0]?.groupId ?? ""
})
watch(studentActionSignature, () => {
  const items = studentActions.value
  if (!items.some((item) => item.code === selectedActionCode.value && item.enabled)) selectedActionCode.value = items.find((item) => item.enabled)?.code ?? ""
})
watch(actionTargetSignature, () => {
  const items = actionTargetOptions.value
  if (!items.some((item) => item.id === selectedTargetId.value)) selectedTargetId.value = items[0]?.id ?? ""
})
const restartNodeSignature = computed(() => (workspace.value?.restartNodes ?? []).map((item) => item.code).join("|"))
watch(restartNodeSignature, () => {
  const nodes = workspace.value?.restartNodes
  if (!nodes?.some((item) => item.code === selectedRestartNodeCode.value)) selectedRestartNodeCode.value = nodes?.[0]?.code ?? ""
})

async function loadWorkspace(showError = true, generation = initializationGeneration) {
  snapshotRequestCount += 1
  snapshotLoading.value = true
  if (showError) loading.value = true
  try {
    const historicalSessionId = isHistoricalAttempt.value ? workspace.value?.session.id : null
    const path = historicalSessionId
      ? `/v3/show-projects/${props.project.id}/runtime/attempts/${historicalSessionId}`
      : `/v3/show-projects/${props.project.id}/runtime`
    const value = await api<ShowRuntimeWorkspaceView>(path)
    if (generation !== initializationGeneration) return
    applyWorkspace(value, Boolean(historicalSessionId))
    loadError.value = ""
    if ((workspace.value?.session.status === "COMPLETED" || workspace.value?.session.status === "ABORTED") && !terminalRefreshSent) {
      terminalRefreshSent = true
      emit("refreshProject")
    }
  } catch (error) {
    if (showError && generation === initializationGeneration) {
      loadError.value = error instanceof Error ? error.message : "表演运行加载失败"
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
  if (disableStreamForPerformanceDiagnostic) {
    connectionState.value = "CLOSED"
    return
  }
  runtimeStream?.close()
  runtimeStream = openRuntimeStream<ShowRuntimeWorkspaceView>(
    `/v3/show-projects/${projectId}/runtime/stream`,
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
    applyWorkspace(await api<ShowRuntimeWorkspaceView>(`/v3/show-projects/${props.project.id}/runtime/attempts/${sessionId}`), true)
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
  await mutate(`/v3/show-projects/${props.project.id}/runtime/restart`, {
    expectedRevision: workspace.value.session.revision,
    nodeCode: node.code
  }, `已创建第 ${workspace.value.session.attemptNo + 1} 次训练`)
  emit("refreshProject")
}

function applyWorkspace(value: ShowRuntimeWorkspaceView, allowOlderAttempt = false) {
  if (!shouldApplyRuntimeWorkspace(workspace.value, value, { allowOlderAttempt })) return
  loadError.value = ""
  const previousSessionId = workspace.value?.session.id
  const previousStatus = workspace.value?.session.status
  const historical = value.attempts[0]?.id !== value.session.id
  workspace.value = value
  clockRate.value = value.clockRate
  if (props.initialAlertId) {
    const alert = value.alerts.find((item) => item.id === props.initialAlertId)
    if (alert) {
      selectAlert(alert.id)
    }
  }
  if (previousSessionId !== value.session.id) {
    playbackTimeMs.value = historical ? 0 : value.session.simulationTimeMs
    replayPlaying.value = false
    lastPlaybackTick = performance.now()
    return
  }
  if (historical) return
  if (value.session.status === "PAUSED" || value.session.status === "READY") {
    playbackTimeMs.value = value.session.simulationTimeMs
  } else if (value.session.status === "RUNNING") {
    const maximumLead = Math.max(1_000, value.clockRate * 1_500)
    if (playbackTimeMs.value < value.session.simulationTimeMs || playbackTimeMs.value > value.session.simulationTimeMs + maximumLead) {
      playbackTimeMs.value = value.session.simulationTimeMs
    }
  } else if (previousStatus === "RUNNING" || previousStatus === "PAUSED") {
    playbackTimeMs.value = value.session.simulationTimeMs
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
    playbackTimeMs.value = Math.min(
      playbackDurationMs.value,
      playbackTimeMs.value + elapsed * Math.max(0.1, workspace.value.clockRate)
    )
  }
}

function startPlaybackTimer() {
  if (playbackTimer !== null) return
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
  await changeRuntimeClock(workspace.value.session.status === "RUNNING" ? "PAUSED" : "RUNNING", clockRate.value)
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
  await changeRuntimeClock(workspace.value.session.status as "RUNNING" | "PAUSED", rate)
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

function selectAlert(alertId: string) {
  selectedAlertId.value = alertId
  const alert = workspace.value?.alerts.find((item) => item.id === alertId)
  selectedEventId.value = alert?.eventId ?? ""
  if (typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches) {
    void nextTick(() => actionConsole.value?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" }))
  }
  const event = workspace.value?.events.find((item) => item.id === alert?.eventId)
  if (!event) return
  const recommended = pickRecommendedRuntimeAction(studentActions.value, event.recommendedActions)
  const fallback = recommended ?? studentActions.value.find((item) => item.enabled)
  if (fallback) {
    selectedActionCode.value = fallback.code
    selectedTargetId.value = pickRuntimeTargetId(fallback.eligibleTargetIds, event.affectedGroupIds)
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
    await ElMessageBox.confirm("确认开始起飞并记录实际起飞动态？", "确认开始起飞", {
      confirmButtonText: "确认起飞",
      cancelButtonText: "取消",
      type: "warning"
    })
  } catch {
    return
  }
  await mutate(`/v3/show-projects/${props.project.id}/runtime/start`, {
    expectedRevision: workspace.value.session.revision
  }, workspace.value.program.imported ? "导入表演程序已启动" : "固定表演程序已启动")
}

async function acknowledge(alertId: string) {
  if (!workspace.value) return
  const alert = workspace.value.alerts.find((item) => item.id === alertId)
  if (!alert) return
  await executeAction("ACKNOWLEDGE_ALERT", alert.id, alert.eventId)
}

async function executeSelectedAction() {
  if (!selectedActionCode.value || !selectedAction.value?.enabled || selectedEventHandled.value) return
  if (selectedAction.value.requiresTarget && !selectedTargetId.value) return
  await executeAction(selectedActionCode.value, selectedAlert.value?.id ?? null, selectedEvent.value?.id ?? null)
}

async function executeAction(actionCode: ShowRuntimeActionCode, alertId: string | null, eventId: string | null) {
  if (actionSubmitting.value || !workspace.value) return
  const definition = workspace.value.availableActions.find((item) => item.code === actionCode)
  if (!definition?.enabled) return
  if (!actionReasoningValid.value) return ElMessage.warning("请完整填写异常发现、处置理由和预期结果")
  const reasoning: V3RuntimeActionReasoning = {
    observation: actionObservation.value,
    rationale: actionRationale.value,
    expectedOutcome: actionExpectedOutcome.value
  }
  const targetId = definition.targetType === "ALERT"
    ? alertId
    : definition.requiresTarget ? selectedTargetId.value : null
  const requestId = createClientId()
  actionError.value = ""
  actionSubmitting.value = true
  const applied = await mutate(`/v3/show-projects/${props.project.id}/runtime/actions`, {
    expectedRevision: workspace.value.session.revision,
    actionCode,
    eventId,
    alertId,
    targetType: definition.targetType,
    targetId,
    requestId,
    reasoning
  }, `${definition.title}已执行`)
  if (applied) {
    clearActionReasoning()
    await nextTick()
    revealActionResult()
  } else actionError.value = lastMutationError.value
    ? `处置未成功：${lastMutationError.value} 已保留本次判断内容，请检查运行状态后重试。`
    : "处置未成功，已保留本次判断内容，请检查运行状态后重试。"
  actionSubmitting.value = false
}

function revealActionResult() {
  actionResultPanel.value?.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" })
  actionResultPanel.value?.focus({ preventScroll: true })
}

function showActionTargetLabel(id: string) {
  const groupIds = id.match(/G\d{2,3}/g) ?? []
  if (id.startsWith("BATCH-") && groupIds[0]) return `${formatShowGroupCode(groupIds[0])} 小批量 · 可降落`
  if (id.includes("-A") && groupIds[0]) return `${id} · ${formatShowGroupCode(groupIds[0])} 单架`
  if (groupIds.length > 1) return `${groupIds.map(formatShowGroupCode).join(" + ")} · 联合处置`
  const group = workspace.value?.groups.find((item) => item.groupId === id)
  return group ? `${group.label} · ${groupStatusLabel(group.status)}` : id
}

function clearActionReasoning() {
  actionObservation.value = ""
  actionRationale.value = ""
  actionExpectedOutcome.value = ""
}

async function updateClockRate() {
  if (!workspace.value || !["RUNNING", "PAUSED"].includes(workspace.value.session.status)) return
  await changeRuntimeClock(workspace.value.session.status as "RUNNING" | "PAUSED", clockRate.value)
}

async function changeTeacherClock(status: "RUNNING" | "PAUSED") {
  await changeRuntimeClock(status, clockRate.value)
}

async function changeRuntimeClock(status: "RUNNING" | "PAUSED", rate: number) {
  if (!workspace.value) return
  await mutate(`/v3/show-projects/${props.project.id}/runtime/clock-rate`, {
    expectedRevision: workspace.value.session.revision,
    rate,
    status
  }, status === "PAUSED" ? "表演运行已暂停" : `表演运行已按 ${rate}x 继续`)
}

async function triggerTeacherEvent() {
  if (!workspace.value) return
  await mutate(`/v3/show-projects/${props.project.id}/runtime/events/${teacherEventCode.value}/trigger`, {
    expectedRevision: workspace.value.session.revision,
    requestId: createClientId()
  }, "训练事件已触发")
}

async function sendTeacherHint() {
  if (!workspace.value) return
  let message = ""
  try {
    const result = await ElMessageBox.prompt("输入发送给学生的训练提示", "发送训练提示", {
      confirmButtonText: "发送",
      cancelButtonText: "取消",
      inputValidator: (value) => value.trim().length > 0 || "提示内容不能为空"
    })
    message = result.value
  } catch {
    return
  }
  await mutate(`/v3/show-projects/${props.project.id}/runtime/hints`, {
    expectedRevision: workspace.value.session.revision,
    message
  }, "训练提示已发送")
}

async function mutate(path: string, body: Record<string, unknown>, success: string) {
  loading.value = true
  lastMutationError.value = ""
  try {
    applyWorkspace(await api<ShowRuntimeWorkspaceView>(path, { method: "POST", body: JSON.stringify(body) }))
    ElMessage.success(success)
    if (workspace.value?.session.status === "COMPLETED" || workspace.value?.session.status === "ABORTED") emit("refreshProject")
    return true
  } catch (error) {
    lastMutationError.value = error instanceof Error ? error.message : "运行命令执行失败"
    if (path.endsWith("/runtime/actions")) actionError.value = `处置未成功：${lastMutationError.value} 已保留本次判断内容，请检查运行状态后重试。`
    ElMessage.error(lastMutationError.value)
    await loadWorkspace(false)
    return false
  } finally {
    loading.value = false
  }
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function jumpToShowRuntimeSection(selector: string) {
  if (typeof document === "undefined") return
  const target = document.querySelector<HTMLElement>(selector)
  if (!target) return
  const reduceMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start", inline: "nearest" })
}

function formatDateTime(value: string) {
  return formatPlatformDate(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function alertPresentation(alert: V3RuntimeAlertView) {
  return showRuntimeAlertPresentation(alert, workspace.value?.events.find((item) => item.id === alert.eventId))
}

function alertTiming(alert: V3RuntimeAlertView) {
  return runtimeAlertTiming(workspace.value?.events.find((item) => item.id === alert.eventId) ?? alert, playbackTimeMs.value)
}

function alertStatusLabel(alert: V3RuntimeAlertView) {
  return runtimeAlertStatusLabel(alert.status, workspace.value?.events.find((item) => item.id === alert.eventId)?.lifecycleStatus)
}

function selectGroup(groupId: string) {
  selectedGroupId.value = groupId
}

function alertRecommendedAction(alert: V3RuntimeAlertView) {
  const event = workspace.value?.events.find((item) => item.id === alert.eventId)
  return runtimeRecommendedActionLabel(event?.recommendedActions ?? [], workspace.value?.availableActions ?? [])
}

function alertActionResult(alert: V3RuntimeAlertView) {
  const eventId = alert.eventId
  const action = latestRuntimeAction(workspace.value?.actions ?? [], alert.id, eventId)
  if (!action) return ""
  if (action.status === "FAILED" || action.status === "REJECTED") return "处置失败"
  if (action.status === "REQUESTED") return "处置中"
  return runtimeActionResultLabel(action.result)
}

function eventStatusLabel(value: string) {
  return ({ SCHEDULED: "未发生", OCCURRED_UNDETECTED: "已发生未发现", DISCOVERED: "已发现", HANDLING: "正在处置", CONTROLLED: "已控制", ESCALATED: "已升级", ENDED: "已结束" } as Record<string, string>)[value] ?? value
}

function groupStatusLabel(value: string) {
  return ({ GROUND: "地面", TAKING_OFF: "起飞中", AIRBORNE: "空中", RETURNING: "返航", LANDING: "降落中", LANDED: "已降落", WARNING: "告警", ABNORMAL: "异常", LOST: "失联" } as Record<string, string>)[value] ?? value
}
</script>

<template>
  <section class="show-runtime-workspace" :data-runtime-revision="workspace?.session.revision ?? 0" v-loading="loading">
    <header class="runtime-header">
      <div><span>{{ isReplayMode ? '运行回放' : '实时运行' }}</span><h2>{{ workspace?.program.name ?? '固定表演运行' }}</h2><p>{{ playbackState?.phaseTitle ?? workspace?.phaseTitle ?? '运行会话初始化' }} · {{ playbackStatusLabel }}<template v-if="workspace?.program.imported"> · {{ workspace.program.sourceSoftware }} / v{{ workspace.program.version }}</template></p></div>
      <div class="runtime-attempts" v-if="workspace?.attempts.length"><span>训练尝试</span><el-select :model-value="workspace.session.id" size="small" aria-label="选择表演训练记录" @change="selectAttempt"><el-option v-for="attempt in workspace.attempts" :key="attempt.id" :label="`第 ${attempt.attemptNo} 次 · ${formatRuntimeSessionStatus(attempt.status)}${attempt.id === workspace.attempts[0]?.id ? ' · 当前' : ' · 历史'}`" :value="attempt.id" /></el-select><small v-if="isHistoricalAttempt">历史记录只读</small><el-button v-if="isHistoricalAttempt" text size="small" @click="selectAttempt(workspace.attempts[0]!.id)">返回当前训练</el-button></div>
      <dl>
        <div><dt>仿真时间</dt><dd>{{ formatDuration(playbackTimeMs) }}</dd></div>
        <div><dt>剩余</dt><dd>{{ formatDuration(Math.max(0, playbackDurationMs - playbackTimeMs)) }}</dd></div>
        <div><dt>运行速度</dt><dd>{{ playbackRate }}x</dd></div>
      </dl>
      <div class="runtime-header-actions"><span class="runtime-stream-status" :class="connectionState.toLowerCase()" role="status" aria-live="polite" :aria-label="`运行数据连接状态：${connectionStateLabel}`"><i />{{ connectionStateLabel }}</span><el-button v-if="!isReplayMode && ['RECONNECTING', 'FALLBACK', 'CLOSED'].includes(connectionState)" text size="small" @click="reconnectRuntime">重新连接</el-button><el-button :icon="Refresh" circle :loading="snapshotLoading" :disabled="snapshotLoading" title="刷新运行快照" aria-label="刷新运行快照" @click="loadWorkspace" /></div>
    </header>
    <div v-if="loadError" class="runtime-load-error" role="alert" aria-live="assertive"><span><strong>运行数据加载失败</strong><small>{{ loadError }} 当前页面数据未被清除，请重试。</small></span><el-button size="small" type="warning" :loading="loading" @click="initializeRuntimeStream">重试加载</el-button></div>
    <nav class="show-runtime-quick-nav" aria-label="表演运行快速定位"><button type="button" aria-label="定位到表演地图" data-runtime-jump="map" @click="jumpToShowRuntimeSection('.runtime-map-panel')">地图</button><button type="button" aria-label="定位到飞行处置" data-runtime-jump="handling" @click="jumpToShowRuntimeSection('.runtime-control-panel')">处置</button><button type="button" aria-label="定位到告警栏" data-runtime-jump="alerts" @click="jumpToShowRuntimeSection('.runtime-alert-deck')">告警<span v-if="activeAlerts.length">{{ activeAlerts.length }}</span></button></nav>
    <div v-if="workspace?.canRestart" class="runtime-restart-bar"><span>可重训 {{ workspace.attemptsRemaining }} 次</span><el-select v-model="selectedRestartNodeCode" size="small" placeholder="选择表演阶段" aria-label="选择表演重训节点"><el-option v-for="node in workspace.restartNodes" :key="node.code" :label="`${node.label} · ${node.detail}`" :value="node.code" /></el-select><el-button type="warning" size="small" @click="restartRuntime">从节点重训</el-button></div>

    <main class="runtime-map-panel">
      <V3UnifiedMap renderer="show-runtime"
        v-if="!disableMapForPerformanceDiagnostic"
        :region="region"
        :visible-layers="visibleMapLayers"
        :groups="playbackState?.groups ?? livePlaybackState?.groups ?? workspace?.groups ?? []"
        :performance-center="workspace?.performanceCenter ?? null"
        :performance-radius-meters="workspace?.performanceRadiusMeters ?? 100"
        :mode="mapMode"
        :selected-group-id="selectedGroupId"
        @group-select="selectGroup"
        @data-state="emit('dataState', $event)"
      />
      <V3EnvironmentLayerPanel v-if="region" :region="region" scene-type="CITY_SHOW" :visible-layers="visibleMapLayers" @toggle-layer="visibleMapLayers = visibleMapLayers.includes($event) ? visibleMapLayers.filter(item => item !== $event) : [...visibleMapLayers, $event]" />
      <div class="runtime-phase-ribbon">
        <span>{{ playbackState?.phaseTitle ?? workspace?.phaseTitle ?? '待起飞' }}</span>
        <div><i :style="{ width: `${runtimeProgress}%` }" /></div>
        <strong>{{ Math.round(runtimeProgress) }}%</strong>
      </div>
      <div class="runtime-totals">
        <div v-for="metric in runtimeMonitorMetrics" :key="metric.code" :class="metric.tone"><span>{{ metric.label }}</span><strong>{{ metric.value }}</strong></div>
      </div>
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
      <div v-if="workspace?.session.status === 'READY'" class="runtime-start-overlay">
        <el-icon><VideoPlay /></el-icon><strong>起飞动态待确认</strong><span>{{ workspace.totals.plannedCount }} 架 · {{ workspace.groups.length }} 个运行分组</span>
        <el-button v-if="workspace.canStart" type="primary" :icon="VideoPlay" @click="startRuntime">确认开始起飞</el-button>
      </div>
    </main>

    <aside class="runtime-control-panel">
      <section v-if="workspace?.takeoffRecord" class="runtime-takeoff-record">
        <header><strong>实际起飞动态</strong><span>已记录</span></header>
        <dl>
          <div><dt>确认人</dt><dd>{{ workspace.takeoffRecord.confirmedBy?.displayName ?? '历史记录未提供' }}</dd></div>
          <div><dt>实际起飞</dt><dd>{{ formatDateTime(workspace.takeoffRecord.confirmedAt) }}</dd></div>
          <div><dt>仿真时刻</dt><dd>T+{{ formatDuration(workspace.takeoffRecord.simulationTimeMs) }}</dd></div>
          <div><dt>起飞数量</dt><dd>{{ workspace.takeoffRecord.actualTakeoffCount }} 架</dd></div>
          <div><dt>机型</dt><dd>{{ workspace.takeoffRecord.aircraftModel || '历史记录未提供' }}</dd></div>
          <div><dt>环境快照</dt><dd>{{ showRuntimeEnvironmentSummary(workspace.takeoffRecord.environment) }}</dd></div>
        </dl>
      </section>
      <section class="runtime-environment">
        <header><strong>运行环境</strong><span>实时状态</span></header>
        <dl>
          <div v-for="metric in runtimeEnvironmentMetrics" :key="metric.code" :class="metric.tone"><dt>{{ metric.label }}</dt><dd>{{ metric.value }}</dd></div>
        </dl>
        <div class="runtime-environment-support"><span v-for="metric in runtimeSupportMetrics" :key="metric.code" :class="metric.tone">{{ metric.label }}<strong>{{ metric.value }}</strong></span></div>
      </section>

      <section v-if="workspace?.canControl" ref="actionConsole" class="runtime-action-console">
        <header><strong>飞行处置</strong><span>学生</span></header>
        <div v-if="selectedAlert" class="runtime-selected-alert">
          <header><span>当前处置告警</span><em :class="alertTiming(selectedAlert).tone">{{ alertStatusLabel(selectedAlert) }}</em></header>
          <strong>{{ selectedAlert.title }}</strong>
          <p>{{ selectedAlert.detail }}</p>
          <small>影响 {{ alertPresentation(selectedAlert).impactLabel }} · {{ alertTiming(selectedAlert).label }}</small>
          <small><b>推荐动作</b> {{ alertRecommendedAction(selectedAlert) }}</small>
        </div>
        <article v-if="selectedEventBriefing" class="show-event-briefing" aria-label="NPC 业务简报">
          <header><strong>系统角色任务</strong></header>
          <dl>
            <div><dt>业务角色</dt><dd>{{ selectedEventBriefing.role }}</dd></div>
            <div><dt>业务请求</dt><dd>{{ selectedEventBriefing.request }}</dd></div>
            <div><dt>影响对象</dt><dd>{{ selectedEventBriefing.impact }}</dd></div>
            <div><dt>处置目标</dt><dd>{{ selectedEventBriefing.objective }}</dd></div>
            <div><dt>成功判据</dt><dd>{{ selectedEventBriefing.successCriteria }}</dd></div>
            <div><dt>处置时限</dt><dd>{{ selectedEventTiming?.label ?? '未设置' }}</dd></div>
            <div class="briefing-scoring"><dt>评分关注</dt><dd><span v-for="item in selectedEventBriefing.scoringEvidence" :key="item">{{ item }}</span></dd></div>
          </dl>
        </article>
        <el-select v-model="selectedActionCode" placeholder="选择处置操作" aria-label="选择表演应急处置动作" :disabled="selectedEventHandled">
          <el-option v-for="item in studentActions" :key="item.code" :label="runtimeActionOptionLabel(item.title, item.enabled, item.disabledReason)" :value="item.code" :disabled="!item.enabled" />
        </el-select>
        <el-select v-if="selectedAction?.requiresTarget" v-model="selectedTargetId" placeholder="选择处置对象" aria-label="选择表演应急处置对象" filterable :disabled="selectedEventHandled">
          <el-option v-for="target in actionTargetOptions" :key="target.id" :label="target.label" :value="target.id" />
        </el-select>
        <div class="action-reasoning-fields">
          <label><span>异常发现</span><el-input v-model="actionObservation" type="textarea" :rows="2" maxlength="1000" placeholder="描述看到的异常（至少4字）" :disabled="selectedEventHandled" /></label>
          <label><span>处置理由</span><el-input v-model="actionRationale" type="textarea" :rows="2" maxlength="1000" placeholder="说明为什么选择该动作（至少4字）" :disabled="selectedEventHandled" /></label>
          <label><span>预期结果</span><el-input v-model="actionExpectedOutcome" type="textarea" :rows="2" maxlength="1000" placeholder="说明希望达到的结果（至少4字）" :disabled="selectedEventHandled" /></label>
        </div>
        <el-button type="primary" :loading="actionSubmitting" :disabled="selectedEventHandled || actionSubmitting || !selectedAction?.enabled || (selectedAction.requiresTarget && !selectedTargetId) || !actionReasoningValid" @click="executeSelectedAction">{{ selectedEventHandled ? '该事件已处置' : actionSubmitting ? '提交中...' : '执行处置' }}</el-button>
        <div v-if="actionError" class="runtime-action-error" role="alert" aria-live="assertive"><span>{{ actionError }}</span><el-button type="danger" text :disabled="actionSubmitting" @click="executeSelectedAction">重试处置</el-button></div>
        <article v-if="selectedEventAction" ref="actionResultPanel" class="show-action-result" tabindex="-1" aria-label="表演处置实际业务后果">
          <header><span>实际影响</span><strong>实际业务后果</strong></header>
          <ul v-if="selectedEventConsequences.length"><li v-for="item in selectedEventConsequences" :key="item">{{ item }}</li></ul>
          <p v-else>{{ runtimeActionResultLabel(selectedEventAction.result) }}</p>
          <div class="show-action-evidence"><small>评分指标</small><span v-for="item in selectedEventEvidence" :key="item">{{ item }}</span><em v-if="selectedEventEvidence.length === 0">暂无时效或事件控制指标</em></div>
        </article>
        <ol v-if="recentActions.length" class="recent-action-records">
          <li v-for="action in recentActions" :key="action.id">
            <strong>{{ workspace?.availableActions.find((item) => item.code === action.actionCode)?.title ?? action.actionCode }}</strong>
            <span>对象：{{ action.targetId ? showActionTargetLabel(action.targetId) : '全局' }}</span>
            <span v-if="runtimeActionReasoning(action.payload)">发现：{{ runtimeActionReasoning(action.payload)?.observation }}</span>
            <span v-if="runtimeActionReasoning(action.payload)">判断：{{ runtimeActionReasoning(action.payload)?.rationale }}</span>
            <span v-if="runtimeActionReasoning(action.payload)">预期：{{ runtimeActionReasoning(action.payload)?.expectedOutcome }}</span>
            <em>{{ runtimeActionResultLabel(action.result) }}</em>
          </li>
        </ol>
        <div v-if="project.mode === 'TRAINING'" class="runtime-rate-control">
          <el-select v-model="clockRate" aria-label="表演仿真速度" @change="updateClockRate">
            <el-option v-for="rate in [1, 5, 20, 60, 300, 600]" :key="rate" :label="`${rate}x`" :value="rate" />
          </el-select>
        </div>
      </section>

      <section v-if="workspace?.canTeacherIntervene" class="teacher-runtime-console">
        <header><strong>训练干预</strong><span>教师</span></header>
        <div><el-button v-if="workspace.session.status === 'RUNNING'" :icon="VideoPause" @click="changeTeacherClock('PAUSED')">暂停运行</el-button><el-button v-else :icon="VideoPlay" @click="changeTeacherClock('RUNNING')">继续运行</el-button><el-select v-model="clockRate" aria-label="教师调整表演仿真速度" @change="updateClockRate"><el-option v-for="rate in [1, 5, 20, 60, 300, 600]" :key="rate" :label="`${rate}x`" :value="rate" /></el-select></div>
        <el-select v-model="teacherEventCode" aria-label="选择教师注入事件">
          <el-option label="风力接近限制" value="WEATHER_LIMIT" />
          <el-option label="定位漂移" value="POSITIONING_DRIFT" />
          <el-option label="通信链路中断" value="COMMUNICATION_LOSS" />
          <el-option label="动力性能下降" value="MOTOR_DEGRADATION" />
          <el-option label="电池状态异常" value="BATTERY_ANOMALY" />
        </el-select>
        <div><el-button @click="triggerTeacherEvent">触发事件</el-button><el-button @click="sendTeacherHint">发送提示</el-button></div>
      </section>

      <section class="runtime-groups-list">
        <header><strong>分组状态</strong><span>{{ workspace?.groups.length ?? 0 }} 个分组</span></header>
        <ol>
          <li v-for="group in workspace?.groups ?? []" :key="group.groupId" :class="[group.status.toLowerCase(), { selected: group.groupId === selectedGroupId }]" role="button" tabindex="0" :aria-pressed="group.groupId === selectedGroupId" :aria-label="`${formatShowGroupCode(group.groupId)}，${group.label}，${groupStatusLabel(group.status)}`" @click="selectGroup(group.groupId)" @keydown.enter.prevent="selectGroup(group.groupId)" @keydown.space.prevent="selectGroup(group.groupId)">
            <span>{{ formatShowGroupCode(group.groupId) }}</span><strong>{{ group.label }}</strong><em>{{ groupStatusLabel(group.status) }}</em><small>{{ group.airborneCount }} 空中 / {{ group.landedCount }} 降落</small>
          </li>
        </ol>
      </section>
      <section class="runtime-schedule-panel">
        <header><strong>编队任务时序</strong><span>按编队聚合</span></header>
        <ol>
          <li v-for="row in groupSchedule" :key="row.groupId">
            <div class="runtime-schedule-heading"><strong>{{ formatShowGroupCode(row.groupId) }} · {{ row.label }}</strong><em>{{ groupStatusLabel(row.status) }}</em></div>
            <div><span>当前</span><b>{{ row.currentEventTitle ?? '暂无已发生事件' }}</b><small v-if="row.currentEventTimeMs !== null">T+{{ formatDuration(row.currentEventTimeMs) }}</small></div>
            <div><span>下一项</span><b>{{ row.nextEventTitle ?? '未提供计划时刻' }}</b><small v-if="row.nextEventTimeMs !== null">T+{{ formatDuration(row.nextEventTimeMs) }}</small></div>
          </li>
          <li v-if="!groupSchedule.length" class="runtime-schedule-empty"><strong>{{ workspace?.session.status === 'READY' ? '运行尚未启动' : workspace?.session.status === 'COMPLETED' || workspace?.session.status === 'ABORTED' ? '没有可回放的编队时序' : '暂无编队计划数据' }}</strong><span>{{ workspace?.session.status === 'READY' ? '启动表演运行后，系统会按编队显示当前事件和下一项任务。' : workspace?.session.status === 'COMPLETED' || workspace?.session.status === 'ABORTED' ? '当前运行没有生成可展示的编队计划，请检查表演程序或重新加载运行数据。' : '表演程序加载完成后，编队任务时序会显示在这里。' }}</span></li>
        </ol>
      </section>
    </aside>

    <section class="runtime-alert-deck">
      <header><div><el-icon><Bell /></el-icon><strong>告警栏</strong><span>{{ activeAlerts.length }} 条活动告警<template v-if="recentResolvedAlerts.length"> · {{ recentResolvedAlerts.length }} 条最近结果</template></span></div><small>事件发生 · 学生发现 · 处置 · 结果</small></header>
      <div class="runtime-alert-list">
        <article v-for="alert in displayedAlerts" :key="alert.id" :class="[alert.severity.toLowerCase(), { selected: selectedAlert?.id === alert.id, resolved: alert.status === 'RESOLVED' }]" role="button" tabindex="0" :aria-pressed="selectedAlert?.id === alert.id" :aria-label="`${alert.title}，${alertStatusLabel(alert)}，影响${alertPresentation(alert).impactLabel}`" @click="selectAlert(alert.id)" @keydown.enter.stop.prevent="selectAlert(alert.id)" @keydown.space.stop.prevent="selectAlert(alert.id)">
          <el-icon><Warning /></el-icon>
          <div><span>{{ alertPresentation(alert).severityLabel }} · T+{{ formatDuration(alert.simulationTimeMs ?? 0) }}</span><strong>{{ alert.title }}</strong><p>{{ alert.detail }}</p><small class="runtime-alert-scope"><b>影响范围</b>{{ alertPresentation(alert).impactLabel }}</small><small class="runtime-alert-timing" :class="alertTiming(alert).tone"><b>处置时限</b>{{ alertTiming(alert).label }}</small><small class="runtime-alert-recommendation"><b>{{ alert.status === 'RESOLVED' ? '结果' : '建议' }}</b>{{ alert.status === 'RESOLVED' ? alertActionResult(alert) : alertRecommendedAction(alert) }}<template v-if="alert.status !== 'RESOLVED' && alertActionResult(alert)"> · {{ alertActionResult(alert) }}</template></small></div>
          <div class="runtime-alert-card-actions"><em>{{ alertStatusLabel(alert) }}</em><el-button v-if="workspace?.canControl" text @click.stop="selectAlert(alert.id)">{{ alert.status === 'RESOLVED' ? '查看结果' : '进入处置' }}</el-button><el-button v-if="workspace?.canControl && alert.status === 'OPEN'" text :icon="CircleCheck" :disabled="!actionReasoningValid" @click.stop="acknowledge(alert.id)">确认</el-button></div>
        </article>
        <div v-if="!displayedAlerts.length" class="runtime-alert-empty"><el-icon><CircleCheck /></el-icon><strong>当前无活动告警</strong></div>
      </div>
      <ol class="runtime-event-strip">
        <li v-for="event in workspace?.events ?? []" :key="event.id" :class="[event.lifecycleStatus.toLowerCase(), { selected: selectedEvent?.id === event.id }]" role="button" tabindex="0" :aria-pressed="selectedEvent?.id === event.id" :aria-label="`${event.title}，${runtimeEventCategoryLabel('CITY_SHOW', event.category)}，${eventStatusLabel(event.lifecycleStatus)}`" @click="selectRuntimeEvent(event.id)" @keydown.enter="selectRuntimeEvent(event.id)" @keydown.space.prevent="selectRuntimeEvent(event.id)"><i /><span>{{ formatDuration(event.scheduledSimulationTimeMs ?? 0) }}</span><strong>{{ event.title }}<small>{{ runtimeEventSource('CITY_SHOW', event.category, event.code) }} · {{ runtimeEventCategoryLabel('CITY_SHOW', event.category) }}</small></strong><em>{{ eventStatusLabel(event.lifecycleStatus) }}</em></li>
      </ol>
    </section>
  </section>
</template>

<style scoped>
.show-runtime-workspace { position: relative; display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0, 1fr) 330px; grid-template-rows: 76px minmax(0, 1fr) 188px; min-width: 0; min-height: 0; background: #e9efec; }
.runtime-header { display: grid; grid-column: 1 / 3; grid-template-columns: minmax(0, 1fr) 190px auto 36px; align-items: center; gap: 14px; border-bottom: 1px solid #cfdbd5; padding: 10px 16px; background: white; }
.runtime-header > div:first-child { display: grid; gap: 2px; }
.runtime-header span, .runtime-control-panel section > header span { color: #247354; font-size: 11px; font-weight: 800; }
.runtime-header h2 { margin: 0; font-size: 16px; }
.runtime-header p { margin: 0; color: #71847b; font-size: 11px; }
.runtime-header dl { display: flex; gap: 22px; margin: 0; }
.runtime-header dl div { display: grid; gap: 2px; min-width: 58px; }
.runtime-header dt { color: #74867e; font-size: 11px; }
.runtime-header dd { margin: 0; font-size: 14px; font-weight: 750; font-variant-numeric: tabular-nums; }
.runtime-header-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.runtime-attempts { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px 6px; min-width: 0; }.runtime-attempts > span { grid-column: 1 / 3; }.runtime-attempts .el-select { min-width: 0; }.runtime-attempts small { color: #a56b18; font-size: 11px; }.runtime-attempts .el-button { padding: 0; font-size: 11px; }
.runtime-restart-bar { position: absolute; z-index: 8; top: 84px; left: 16px; display: flex; align-items: center; gap: 8px; max-width: min(620px, calc(100% - 380px)); border: 1px solid #dfcda8; padding: 6px 8px; background: rgba(255, 252, 245, .96); box-shadow: 0 4px 14px rgba(41, 53, 48, .12); }.runtime-restart-bar > span { flex: 0 0 auto; color: #8a5a12; font-size: 11px; font-weight: 800; }.runtime-restart-bar .el-select { width: min(380px, 48vw); }
.runtime-takeoff-record { border-bottom: 1px solid #d7e1dc; background: #f3f8f5; }.runtime-takeoff-record dl { grid-template-columns: repeat(2,minmax(0,1fr)); }.runtime-takeoff-record dd { overflow-wrap: anywhere; }
.runtime-stream-status { display: inline-flex; align-items: center; gap: 5px; color: #64766e; font-size: 11px; white-space: nowrap; }
.runtime-stream-status i { width: 6px; height: 6px; border-radius: 50%; background: #a8b5ae; }
.runtime-stream-status.live { color: #1c8058; }
.runtime-stream-status.live i { background: #20a66a; }
.runtime-stream-status.reconnecting, .runtime-stream-status.fallback { color: #a36c12; }
.runtime-stream-status.reconnecting i, .runtime-stream-status.fallback i { background: #d99a2b; }
.runtime-map-panel { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
.runtime-phase-ribbon { position: absolute; z-index: 2; top: 12px; left: 12px; display: grid; grid-template-columns: auto minmax(100px, 220px) 34px; align-items: center; gap: 10px; border: 1px solid rgba(255,255,255,.45); padding: 8px 10px; color: white; background: rgba(20,54,43,.9); }
.runtime-phase-ribbon span, .runtime-phase-ribbon strong { font-size: 11px; }
.runtime-phase-ribbon > div { height: 3px; background: rgba(255,255,255,.24); }
.runtime-phase-ribbon i { display: block; height: 100%; background: #83d6ad; }
.runtime-totals { position: absolute; z-index: 2; right: 12px; bottom: 69px; display: grid; grid-template-columns: repeat(8, minmax(52px, 1fr)); max-width: calc(100% - 24px); border: 1px solid rgba(255,255,255,.4); background: rgba(255,255,255,.92); }
.runtime-totals div { display: grid; gap: 2px; border-right: 1px solid #d7e0dc; padding: 8px 9px; }
.runtime-totals div:last-child { border-right: 0; }
.runtime-totals span { color: #71847b; font-size: 11px; }
.runtime-totals strong { font-size: 14px; font-variant-numeric: tabular-nums; }
.runtime-totals .normal strong { color: #247354; }
.runtime-totals .warning strong { color: #9b701f; }
.runtime-totals .danger strong { color: #a53f38; }
.runtime-totals .lost strong { color: #7f2f3b; }
.runtime-start-overlay { position: absolute; z-index: 3; inset: 0; display: grid; align-content: center; justify-items: center; gap: 8px; background: rgba(232,239,235,.86); backdrop-filter: blur(3px); }
.runtime-start-overlay .el-icon { color: #247354; font-size: 34px; }
.runtime-start-overlay strong { font-size: 16px; }
.runtime-start-overlay span { color: #667970; font-size: 11px; }
.runtime-control-panel { grid-column: 2; grid-row: 2 / 4; min-height: 0; overflow: auto; border-left: 1px solid #cfdbd5; background: #f9fbfa; }
.runtime-control-panel > section { border-bottom: 1px solid #d7e0dc; padding: 13px 14px; }
.runtime-control-panel section > header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 9px; }
.runtime-control-panel section > header strong { font-size: 10px; }
.runtime-environment dl { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; margin: 0; background: #dce4e0; }
.runtime-environment dl div { display: flex; justify-content: space-between; gap: 6px; padding: 7px 8px; background: white; }
.runtime-environment dt, .runtime-environment dd { margin: 0; font-size: 11px; }
.runtime-environment dt { color: #75867e; }
.runtime-environment dd { font-weight: 700; }
.runtime-environment dl div.warning dd { color: #a27522; }
.runtime-environment dl div.danger dd { color: #ae433b; }
.runtime-environment-support { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 7px; }
.runtime-environment-support span { display: flex; justify-content: space-between; border-left: 2px solid #247354; padding: 5px 7px; color: #75867e; background: white; font-size: 11px; }
.runtime-environment-support span.warning { border-left-color: #a27522; }.runtime-environment-support span.danger { border-left-color: #ae433b; }.runtime-environment-support strong { color: #20322b; font-size: 11px; }
.runtime-action-console, .teacher-runtime-console { display: grid; gap: 7px; }
.action-reasoning-fields { display: grid; gap: 5px; border-left: 2px solid #247354; padding-left: 7px; }.action-reasoning-fields label { display: grid; gap: 3px; }.action-reasoning-fields label > span { color: #5f776b; font-size: 11px; font-weight: 700; }
.action-reasoning-fields :deep(textarea) { min-height: 42px !important; font-size: 11px; line-height: 1.45; resize: vertical; }
.recent-action-records { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.recent-action-records li { display: grid; gap: 2px; border-top: 1px solid #d8e2dd; padding-top: 6px; }
.recent-action-records strong { font-size: 11px; }.recent-action-records span { overflow: hidden; color: #60736a; font-size: 11px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }.recent-action-records em { color: #247354; font-size: 11px; font-style: normal; }
.teacher-runtime-console > div { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.runtime-rate-control { display: grid; grid-template-columns: 1fr; }
.runtime-groups-list ol { display: grid; gap: 4px; max-height: 180px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.runtime-groups-list li { display: grid; grid-template-columns: 30px minmax(0,1fr) 44px; gap: 5px 8px; border-left: 3px solid #71847b; padding: 6px 8px; background: white; }
.runtime-groups-list li.warning { border-left-color: #be862d; }
.runtime-groups-list li.abnormal, .runtime-groups-list li.lost { border-left-color: #b54840; }
.runtime-groups-list li span, .runtime-groups-list li em, .runtime-groups-list li small { font-size: 11px; font-style: normal; }
.runtime-groups-list li strong { font-size: 11px; }
.runtime-groups-list li em { text-align: right; }
.runtime-groups-list li small { grid-column: 2 / 4; color: #71847b; }
.runtime-schedule-panel ol { display: grid; gap: 5px; max-height: 220px; margin: 0; padding: 0; overflow: auto; list-style: none; }
.runtime-schedule-panel li { display: grid; gap: 5px; border: 1px solid #dce4e0; padding: 7px 8px; background: white; }
.runtime-schedule-heading, .runtime-schedule-panel li > div:not(.runtime-schedule-heading) { display: grid; grid-template-columns: 42px minmax(0, 1fr) auto; align-items: baseline; gap: 5px; }
.runtime-schedule-heading { grid-template-columns: minmax(0, 1fr) auto; }
.runtime-schedule-heading strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.runtime-schedule-heading em, .runtime-schedule-panel span, .runtime-schedule-panel small { color: #71847b; font-size: 11px; font-style: normal; }
.runtime-schedule-panel b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 650; }
.runtime-schedule-panel small { text-align: right; font-variant-numeric: tabular-nums; }
.runtime-schedule-empty { display: grid; gap: 4px; color: #71847b; font-size: 11px; line-height: 1.5; }.runtime-schedule-empty strong { color: #365e4d; font-size: 11px; }.runtime-schedule-empty span { color: #71847b; }
.runtime-alert-deck { min-width: 0; min-height: 0; overflow: hidden; border-top: 1px solid #cfdbd5; background: white; }
.runtime-alert-deck > header { display: flex; justify-content: space-between; align-items: center; height: 37px; border-bottom: 1px solid #dbe3df; padding: 0 12px; }
.runtime-alert-deck > header div { display: flex; align-items: center; gap: 6px; }
.runtime-alert-deck > header strong { font-size: 10px; }
.runtime-alert-deck > header span, .runtime-alert-deck > header small { color: #72847b; font-size: 11px; }
.runtime-alert-list { display: flex; gap: 7px; min-height: 88px; padding: 8px 10px; overflow-x: auto; }
.runtime-alert-list article { display: grid; flex: 0 0 300px; grid-template-columns: 18px minmax(0,1fr) 62px; gap: 6px; border: 1px solid #d9e1dd; border-left: 3px solid #c38a2c; padding: 7px; cursor: pointer; }
.runtime-alert-list article.error, .runtime-alert-list article.critical { border-left-color: #b7473f; }
.runtime-alert-list article.resolved { border-left-color: #4c806a; background: #f7faf8; }
.runtime-alert-list article.selected { background: #f2f7f4; }.runtime-alert-list article:focus-visible { outline: 2px solid #247354; outline-offset: 2px; }
.runtime-alert-list article > .el-icon { margin-top: 3px; color: #a87624; }
.runtime-alert-list article > div { display: grid; gap: 2px; }
.runtime-alert-list article span, .runtime-alert-list article p, .runtime-alert-list article em { font-size: 11px; font-style: normal; }
.runtime-alert-list article strong { font-size: 11px; }
.runtime-alert-list article p { margin: 0; color: #6e8178; line-height: 1.35; }
.runtime-alert-scope, .runtime-alert-timing, .runtime-alert-recommendation { display: flex; gap: 5px; color: #536a60; font-size: 11px; line-height: 1.35; }
.runtime-alert-scope b, .runtime-alert-timing b, .runtime-alert-recommendation b { color: #9b6520; font-size: 11px; }
.runtime-alert-timing.warning { color: #9a6b20; }.runtime-alert-timing.danger { color: #a64038; font-weight: 700; }
.runtime-alert-card-actions { display: flex; flex-direction: column; align-items: flex-end; justify-content: space-between; gap: 3px; min-width: 0; }.runtime-alert-card-actions em { font-size: 11px; font-style: normal; white-space: nowrap; }
.runtime-alert-card-actions .el-button { padding: 0 2px; font-size: 11px; }
.runtime-alert-empty { display: flex; flex: 1; align-items: center; justify-content: center; gap: 7px; color: #60776c; }
.runtime-alert-empty strong { font-size: 11px; }
.runtime-selected-alert { display: grid; gap: 4px; border-left: 3px solid #bb8125; padding: 7px 8px; background: #f4f8f6; }.runtime-selected-alert > header { display: flex; align-items: center; justify-content: space-between; }.runtime-selected-alert > header span, .runtime-selected-alert > header em { color: #71847b; font-size: 11px; font-style: normal; }.runtime-selected-alert > header em.warning { color: #98671d; }.runtime-selected-alert > header em.danger { color: #a23f38; font-weight: 700; }.runtime-selected-alert > strong { font-size: 11px; }.runtime-selected-alert > p, .runtime-selected-alert > small { margin: 0; color: #667b71; font-size: 11px; line-height: 1.4; }.runtime-selected-alert > small b { color: #315f4c; }
.show-event-briefing,.show-action-result { display: grid; gap: 7px; border: 1px solid #cad8d1; padding: 8px; background: #fff; }.show-event-briefing > header,.show-action-result > header { display: flex; align-items: center; justify-content: space-between; }.show-event-briefing > header span,.show-action-result > header span { color: #71847c; font-size: 11px; }.show-event-briefing > header strong,.show-action-result > header strong { font-size: 11px; }.show-event-briefing dl { display: grid; gap: 1px; margin: 0; background: #d7e0dc; }.show-event-briefing dl div { display: grid; grid-template-columns: 58px minmax(0,1fr); gap: 7px; padding: 6px; background: #f8faf9; }.show-event-briefing dt,.show-event-briefing dd { margin: 0; font-size: 11px; line-height: 1.45; }.show-event-briefing dt { color: #71847c; }.show-event-briefing dd { font-weight: 600; overflow-wrap: anywhere; }.show-event-briefing .briefing-scoring dd { display: flex; flex-wrap: wrap; gap: 3px; }.show-event-briefing .briefing-scoring span,.show-action-evidence span { padding: 2px 4px; color: #315f4c; background: #e5f0ea; font-size: 11px; font-weight: 600; }.show-action-result { border-left: 3px solid #287354; background: #f5faf7; }.show-action-result:focus { outline: 2px solid #287354; outline-offset: 2px; }.show-action-result p,.show-action-result ul { margin: 0; color: #38594c; font-size: 11px; line-height: 1.5; }.show-action-result ul { display: grid; gap: 3px; padding-left: 15px; }.show-action-evidence { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }.show-action-evidence small { width: 100%; color: #71847c; font-size: 11px; }.show-action-evidence em { color: #71847c; font-size: 11px; font-style: normal; }
.runtime-event-strip { display: flex; gap: 16px; height: 45px; align-items: center; margin: 0; border-top: 1px solid #e0e6e3; padding: 0 12px; overflow-x: auto; list-style: none; }
.runtime-event-strip li { display: grid; flex: 0 0 auto; grid-template-columns: 7px 36px minmax(80px,auto) auto; align-items: center; gap: 5px; padding: 4px; cursor: pointer; }
.runtime-event-strip li.selected { background: #edf5f1; outline: 1px solid #a9c8b9; }
.runtime-event-strip li:focus-visible { outline: 2px solid #247354; outline-offset: 2px; }
.runtime-event-strip i { width: 7px; height: 7px; border-radius: 50%; background: #91a39a; }
.runtime-event-strip li.discovered i, .runtime-event-strip li.handling i { background: #c18729; }
.runtime-event-strip li.escalated i { background: #b7453d; }
.runtime-event-strip li.controlled i, .runtime-event-strip li.ended i { background: #247354; }
.runtime-event-strip span, .runtime-event-strip em { color: #71847b; font-size: 11px; font-style: normal; }
.runtime-event-strip strong { font-size: 11px; }
@media (max-width: 1050px) { .show-runtime-workspace { grid-template-columns: minmax(0,1fr) 280px; } .runtime-totals { grid-template-columns: repeat(4, minmax(52px, 1fr)); } }
@media (max-width: 1180px) { .runtime-header { grid-template-columns: minmax(0, 1fr) 180px 36px; }.runtime-header dl { display: none; } }
@media (max-width: 760px) { .show-runtime-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: auto auto 520px max-content max-content; align-content: start; overflow: auto; } .runtime-header { grid-column: 1; grid-template-columns: minmax(0, 1fr) 150px 36px; } .runtime-header dl { display: none; } .runtime-restart-bar { top: 84px; left: 8px; max-width: calc(100% - 16px); }.runtime-restart-bar .el-select { width: min(230px, 48vw); }.runtime-totals { right: 12px; left: 12px; grid-template-columns: repeat(4,minmax(0,1fr)); }.runtime-map-panel { grid-column: 1; grid-row: 3; }.runtime-control-panel { grid-column: 1; grid-row: 4; overflow: visible; border-top: 1px solid #cfdbd5; border-left: 0; } .runtime-alert-deck { grid-column: 1; grid-row: 5; overflow: visible; } }
.runtime-action-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid #e3b8b3; border-left: 3px solid #b7473f; padding: 7px 8px; background: #fff6f5; color: #8c3933; font-size: 11px; line-height: 1.4; }
.runtime-load-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; border: 1px solid #e2b7b2; padding: 8px 12px; background: #fff7f6; color: #783f39; }.runtime-load-error span { display: grid; gap: 2px; min-width: 0; }.runtime-load-error strong { font-size: 10px; }.runtime-load-error small { font-size: 11px; line-height: 1.4; overflow-wrap: anywhere; }.runtime-load-error .el-button { flex: 0 0 auto; }
.show-runtime-quick-nav{display:none}
@media (max-width:760px){.show-runtime-quick-nav{position:sticky;top:0;z-index:8;display:grid;grid-template-columns:repeat(3,1fr);gap:4px;border-bottom:1px solid #cbd9d2;padding:5px 7px;background:rgba(255,255,255,.96);backdrop-filter:blur(5px)}.show-runtime-quick-nav button{min-height:30px;border:1px solid #c8d8cf;background:#fff;color:#315c49;font:inherit;font-size: 11px}.show-runtime-quick-nav button span{display:inline-grid;min-width:15px;margin-left:3px;border-radius:8px;background:#b44942;color:#fff;font-size: 11px}.runtime-map-panel,.runtime-control-panel,.runtime-alert-deck{scroll-margin-top:42px}}
</style>
