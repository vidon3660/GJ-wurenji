<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Check, CircleCheck, FolderOpened, Operation, RefreshRight, Select, UploadFilled, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  LogisticsBatchScheduleGroup,
  LogisticsScheduleItemInput,
  LogisticsScheduleItemView,
  LogisticsSchedulingOrderView,
  LogisticsSchedulingRouteView,
  LogisticsSchedulingWorkspaceView,
  StudentProjectStageView,
  StudentProjectView,
  V3RegionCatalogItem,
  V3RegionLayerCode
} from "@wurenji/shared"
import { api } from "../api"
import { formatLogisticsEvidenceCode, formatScaleTemplateCode, formatSubmissionStatus, formatValidationStatus } from "../terminology"
import { logisticsAircraftPoolRows } from "../logistics-aircraft-pool"
import { filterLogisticsScheduleOrders, logisticsBatchGroupOrderIds } from "../logistics-batch-scheduling"
import type { V3MapDataState } from "../map-loading-state"
import {
  advanceV3OperationProgress,
  completeV3OperationProgress,
  failV3OperationProgress,
  startV3OperationProgress,
  type V3OperationProgressState
} from "../operation-progress"
import { logisticsOrderPoolRows, logisticsOrderStatusLabel } from "../logistics-order-pool"
import { buildLogisticsTaskTimeline } from "../logistics-schedule-timeline"
import {
  assignLogisticsTasks,
  matchesLogisticsTaskInput
} from "../logistics-task-assignment"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"
import V3OperationProgress from "./V3OperationProgress.vue"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
  region: V3RegionCatalogItem
  visibleLayers: readonly V3RegionLayerCode[]
  mapMode: "2d" | "3d"
}>()

const emit = defineEmits<{
  refreshProject: []
  dataState: [state: V3MapDataState]
  toggleLayer: [code: V3RegionLayerCode]
}>()

const loading = ref(false)
const workspace = ref<LogisticsSchedulingWorkspaceView | null>(null)
const showLabels = ref(true)
const items = ref<LogisticsScheduleItemInput[]>([])
const persistedItems = ref("[]")
const selectedOrderIds = ref<string[]>([])
const selectedAircraftId = ref("")
const selectedOutboundRouteId = ref("")
const selectedReturnRouteId = ref("")
const plannedTakeoffMinute = ref(0)
const batchIntervalMinutes = ref(15)
const orderDestinationFilter = ref("")
const orderPriorityFilter = ref("")
const orderStatusFilter = ref<"ALL" | "UNASSIGNED" | "SCHEDULED">("ALL")
const orderRouteFilter = ref("")
const orderAircraftFilter = ref("")
const aircraftPoolFilter = ref("")
const aircraftPoolStatusFilter = ref("ALL")
const orderSort = ref<"LATEST_ARRIVAL" | "RELEASE_TIME" | "PRIORITY">("LATEST_ARRIVAL")
const batchDialogVisible = ref(false)
const assignmentDialogVisible = ref(false)
const timelineDialogVisible = ref(false)
const timelineDialogItemId = ref("")
const batchProgress = ref<V3OperationProgressState | null>(null)
const batchGroupType = ref<Exclude<LogisticsBatchScheduleGroup, "MANUAL">>("DELIVERY_POINT")
const batchGroupValue = ref("")
const batchSelectionSource = ref<LogisticsBatchScheduleGroup>("MANUAL")
const batchSelectionValue = ref("")
const batchTargetAircraftId = ref("")
const batchTargetOutboundRouteId = ref("")
const batchTargetReturnRouteId = ref("")
const batchTakeoffShiftMinutes = ref(0)
const selectedMapRouteKey = ref("")
const selectedScheduleItemId = ref("")
const selectedVersionId = ref("")
const saveState = ref<"SAVED" | "PENDING" | "ERROR">("SAVED")
let saveTimer: number | null = null
let savePromise: Promise<boolean> | null = null
let applyingWorkspace = false
let workspaceRequest = 0
let workspaceAbortController: AbortController | undefined
let disposed = false

const canEdit = computed(() => Boolean(workspace.value?.canEdit && props.user.role === "student" && props.project.assessmentTiming.canWrite))
const dirty = computed(() => JSON.stringify(items.value) !== persistedItems.value)
const assignedOrderIds = computed(() => new Set(items.value.map((item) => item.orderId)))
const selectedOrders = computed(() => (workspace.value?.orders ?? []).filter((order) => selectedOrderIds.value.includes(order.id)))
const activeDestinationId = computed(() => selectedOrders.value[0]?.destinationNodeId ?? "")
const matchingDestinations = computed(() => new Set(selectedOrders.value.map((order) => order.destinationNodeId)).size <= 1)
const outboundRoutes = computed(() => routeOptions("OUTBOUND", activeDestinationId.value))
const returnRoutes = computed(() => routeOptions("RETURN", activeDestinationId.value))
const selectedDeliveryPointIds = computed(() => [...new Set((workspace.value?.orders ?? []).map((order) => order.destinationNodeId))])
const orderPoolRows = computed(() => logisticsOrderPoolRows(workspace.value?.orders ?? []))
const batchSchedulingMode = computed(() => workspace.value?.batchSchedulingMode ?? "NONE")
const batchMultiSelectEnabled = computed(() => batchSchedulingMode.value !== "NONE")
const filteredOrders = computed(() => filterLogisticsScheduleOrders({
  orders: orderPoolRows.value,
  items: items.value,
  filters: {
    destinationNodeId: orderDestinationFilter.value,
    priority: orderPriorityFilter.value,
    status: orderStatusFilter.value,
    outboundRouteId: orderRouteFilter.value,
    aircraftId: orderAircraftFilter.value,
    sort: orderSort.value
  }
}))
const batchGroupTypes = computed(() => batchSchedulingMode.value === "FULL"
  ? [
      { value: "DELIVERY_POINT" as const, label: "按配送点" },
      { value: "PRIORITY" as const, label: "按优先级" },
      { value: "OUTBOUND_ROUTE" as const, label: "按去程航线" },
      { value: "AIRCRAFT" as const, label: "按无人机" }
    ]
  : [{ value: "DELIVERY_POINT" as const, label: "按配送点" }])
const batchGroupValueOptions = computed(() => {
  if (batchGroupType.value === "DELIVERY_POINT") return selectedDeliveryPointIds.value.map((value) => ({ value, label: destinationName(value) }))
  if (batchGroupType.value === "PRIORITY") return [
    { value: "URGENT", label: "紧急" },
    { value: "PRIORITY", label: "优先" },
    { value: "NORMAL", label: "普通" }
  ]
  if (batchGroupType.value === "OUTBOUND_ROUTE") return (workspace.value?.routes ?? []).filter((route) => route.route.direction === "OUTBOUND").map((route) => ({ value: route.id, label: route.route.name }))
  return (workspace.value?.aircraft ?? []).map((aircraftItem) => ({ value: aircraftItem.id, label: aircraftItem.code }))
})
const selectedScheduledOrderIds = computed(() => selectedOrderIds.value.filter((id) => assignedOrderIds.value.has(id)))
const allSelectedOrdersScheduled = computed(() => selectedScheduledOrderIds.value.length === selectedOrderIds.value.length)
const batchSelectedDestinationId = computed(() => {
  const values = [...new Set(selectedOrders.value.map((order) => order.destinationNodeId))]
  return values.length === 1 ? values[0]! : ""
})
const batchTargetOutboundRoutes = computed(() => routeOptions("OUTBOUND", batchSelectedDestinationId.value))
const batchTargetReturnRoutes = computed(() => routeOptions("RETURN", batchSelectedDestinationId.value))
const batchActionReady = computed(() => selectedOrderIds.value.length >= 2
  && allSelectedOrdersScheduled.value
  && Boolean(batchTargetAircraftId.value || batchTargetOutboundRouteId.value || batchTargetReturnRouteId.value || batchTakeoffShiftMinutes.value))
const selectedMapRoute = computed(() => workspace.value?.routes.find((route) => route.route.id === selectedMapRouteKey.value) ?? null)
const computedItems = computed(() => {
  const checked = new Map((workspace.value?.draft.lastCheckResult?.items ?? []).map((item) => [item.id, item]))
  return items.value.map((item) => {
    const projection = checked.get(item.id)
    return projection && matchesLogisticsTaskInput(projection, item) ? projection : estimateItem(item)
  }).sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)
})
const aircraftPoolRows = computed(() => logisticsAircraftPoolRows(workspace.value?.aircraft ?? [], computedItems.value)
  .filter((aircraft) => {
    const query = aircraftPoolFilter.value.trim().toLowerCase()
    const matchesQuery = !query || aircraft.code.toLowerCase().includes(query) || aircraft.currentLocation.label.toLowerCase().includes(query)
    const matchesStatus = aircraftPoolStatusFilter.value === "ALL" || aircraft.status === aircraftPoolStatusFilter.value
    return matchesQuery && matchesStatus
  }))
const timelineAircraft = computed(() => {
  const scheduled = new Set(items.value.map((item) => item.aircraftId))
  const source = workspace.value?.aircraft ?? []
  return scheduled.size > 0 ? source.filter((aircraft) => scheduled.has(aircraft.id)) : source.slice(0, Math.min(5, source.length))
})
const timelineEndMs = computed(() => Math.max(60 * 60_000, ...computedItems.value.map((item) => item.nextAvailableTimeMs)))
const selectedTimeline = computed(() => {
  const item = computedItems.value.find((entry) => entry.id === selectedScheduleItemId.value) ?? computedItems.value[0]
  if (!item) return null
  const order = workspace.value?.orders.find((entry) => entry.id === item.orderId)
  return order ? { item, timeline: buildLogisticsTaskTimeline(item, order) } : null
})
const timelineDialogTimeline = computed(() => {
  const item = computedItems.value.find((entry) => entry.id === timelineDialogItemId.value) ?? selectedTimeline.value?.item
  if (!item) return null
  const order = workspace.value?.orders.find((entry) => entry.id === item.orderId)
  return order ? { item, timeline: buildLogisticsTaskTimeline(item, order) } : null
})
const timelineStageLegend = computed(() => [
  { code: "OUTBOUND", label: "起飞与去程飞行" },
  { code: "ARRIVAL_SERVICE", label: "到达确认与服务" },
  { code: "RETURNING", label: "返程飞行" },
  { code: "LANDING", label: "降落" },
  { code: "AVAILABLE_AGAIN", label: "再次可用" }
])
const checkResult = computed(() => workspace.value?.draft.lastCheckResult ?? null)
const currentVersion = computed(() => {
  const versions = workspace.value?.versions ?? []
  return versions.find((version) => version.id === selectedVersionId.value)
    ?? versions.find((version) => version.sourceDraftRevision === workspace.value?.draft.revision && version.status === "SNAPSHOT")
    ?? versions[0]
    ?? null
})
// 历史版本可以继续查看，但提交必须严格使用当前草稿对应的候选版本。
const submittableVersion = computed(() => {
  const draftRevision = workspace.value?.draft.revision
  return (workspace.value?.versions ?? []).find((version) => version.sourceDraftRevision === draftRevision
    && version.status === "SNAPSHOT"
    && version.checkResult.submittable) ?? null
})

onMounted(loadWorkspace)
onBeforeUnmount(() => {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  disposed = true
  workspaceRequest += 1
  workspaceAbortController?.abort()
  if (dirty.value) void saveDraft(false, false)
})
watch(() => props.project.id, loadWorkspace)
watch(items, () => {
  if (applyingWorkspace || !canEdit.value || !dirty.value) return
  saveState.value = "PENDING"
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    void saveDraft(false, false)
  }, 1_200)
}, { deep: true, flush: "sync" })
watch(selectedOrderIds, () => {
  const first = selectedOrders.value[0]
  if (first) plannedTakeoffMinute.value = Math.max(plannedTakeoffMinute.value, Math.ceil(first.earliestStartTimeMs / 60_000))
  if (!outboundRoutes.value.some((route) => route.id === selectedOutboundRouteId.value)) selectedOutboundRouteId.value = outboundRoutes.value[0]?.id ?? ""
  if (!returnRoutes.value.some((route) => route.id === selectedReturnRouteId.value)) selectedReturnRouteId.value = returnRoutes.value[0]?.id ?? ""
  if (!batchTargetOutboundRoutes.value.some((route) => route.id === batchTargetOutboundRouteId.value)) batchTargetOutboundRouteId.value = ""
  if (!batchTargetReturnRoutes.value.some((route) => route.id === batchTargetReturnRouteId.value)) batchTargetReturnRouteId.value = ""
  selectedMapRouteKey.value = routeById(selectedOutboundRouteId.value)?.route.id ?? ""
}, { deep: true })
watch(batchGroupType, () => {
  batchGroupValue.value = batchGroupValueOptions.value[0]?.value ?? ""
})

async function loadWorkspace() {
  if (disposed) return
  const requestId = ++workspaceRequest
  workspaceAbortController?.abort()
  const abortController = new AbortController()
  workspaceAbortController = abortController
  loading.value = true
  try {
    const value = await api<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${props.project.id}/scheduling-workspace`, { signal: abortController.signal })
    if (requestId !== workspaceRequest) return
    applyWorkspace(value)
  } catch (error) {
    if (requestId !== workspaceRequest || (error instanceof DOMException && error.name === "AbortError")) return
    ElMessage.error(error instanceof Error ? error.message : "订单调度工作台加载失败")
  } finally {
    if (requestId === workspaceRequest) loading.value = false
  }
}

function applyWorkspace(value: LogisticsSchedulingWorkspaceView) {
  applyingWorkspace = true
  workspace.value = value
  items.value = value.draft.items.map((item) => ({ ...item }))
  persistedItems.value = JSON.stringify(items.value)
  saveState.value = "SAVED"
  applyingWorkspace = false
  if (value.batchSchedulingMode === "NONE" && selectedOrderIds.value.length > 1) selectedOrderIds.value = selectedOrderIds.value.slice(0, 1)
  if (!batchGroupValueOptions.value.some((option) => option.value === batchGroupValue.value)) batchGroupValue.value = batchGroupValueOptions.value[0]?.value ?? ""
  selectedScheduleItemId.value = items.value.some((item) => item.id === selectedScheduleItemId.value)
    ? selectedScheduleItemId.value
    : items.value[0]?.id ?? ""
  selectedAircraftId.value = value.aircraft.some((aircraft) => aircraft.id === selectedAircraftId.value)
    ? selectedAircraftId.value
    : value.aircraft.find((aircraft) => aircraft.status === "READY" && aircraft.availableAtMs === 0)?.id
      ?? value.aircraft.find((aircraft) => aircraft.status === "READY")?.id
      ?? value.aircraft[0]?.id
      ?? ""
  selectedVersionId.value = value.versions.some((version) => version.id === selectedVersionId.value) ? selectedVersionId.value : value.versions[0]?.id ?? ""
}

function routeOptions(direction: "OUTBOUND" | "RETURN", destinationNodeId: string) {
  return (workspace.value?.routes ?? []).filter((route) => route.route.direction === direction && (!destinationNodeId || route.route.destinationNodeId === destinationNodeId))
}

function routeById(id: string): LogisticsSchedulingRouteView | undefined {
  return workspace.value?.routes.find((route) => route.id === id)
}

function toggleOrder(orderId: string) {
  batchSelectionSource.value = "MANUAL"
  batchSelectionValue.value = ""
  if (!batchMultiSelectEnabled.value) {
    selectedOrderIds.value = selectedOrderIds.value.includes(orderId) ? [] : [orderId]
    return
  }
  selectedOrderIds.value = selectedOrderIds.value.includes(orderId)
    ? selectedOrderIds.value.filter((id) => id !== orderId)
    : [...selectedOrderIds.value, orderId]
}

function openAssignmentDialog(orderId: string) {
  if (!canEdit.value) return
  selectedOrderIds.value = [orderId]
  const existing = items.value.find((item) => item.orderId === orderId)
  const order = workspace.value?.orders.find((item) => item.id === orderId)
  if (existing) {
    selectedAircraftId.value = existing.aircraftId
    selectedOutboundRouteId.value = existing.outboundRouteId
    selectedReturnRouteId.value = existing.returnRouteId
    plannedTakeoffMinute.value = Math.round(existing.plannedTakeoffTimeMs / 60_000)
  } else if (order) {
    plannedTakeoffMinute.value = Math.max(plannedTakeoffMinute.value, Math.ceil(order.earliestStartTimeMs / 60_000))
  }
  assignmentDialogVisible.value = true
}

function selectFilteredOrders() {
  if (!batchMultiSelectEnabled.value) {
    ElMessage.info("当前模板仅支持单条任务分配")
    return
  }
  const ids = filteredOrders.value.map((order) => order.id)
  if (batchSchedulingMode.value === "LIMITED" && new Set(filteredOrders.value.map((order) => order.destinationNodeId)).size > 1) {
    ElMessage.warning("有限批量调度需要先筛选到同一配送点")
    return
  }
  selectedOrderIds.value = ids
  batchSelectionSource.value = "MANUAL"
  batchSelectionValue.value = ""
}

function clearOrderFilters() {
  orderDestinationFilter.value = ""
  orderPriorityFilter.value = ""
  orderStatusFilter.value = "ALL"
  orderRouteFilter.value = ""
  orderAircraftFilter.value = ""
  orderSort.value = "LATEST_ARRIVAL"
}

function selectBatchGroup() {
  if (!batchGroupValue.value) return
  const orderIds = logisticsBatchGroupOrderIds({
    group: batchGroupType.value,
    value: batchGroupValue.value,
    orders: workspace.value?.orders ?? [],
    items: items.value
  })
  if (orderIds.length < 2) {
    ElMessage.warning("该分组至少需要两条已分配任务")
    return
  }
  selectedOrderIds.value = orderIds
  batchSelectionSource.value = batchGroupType.value
  batchSelectionValue.value = batchGroupValue.value
}

function openBatchDialog() {
  if (!batchMultiSelectEnabled.value) return
  if (!batchGroupValue.value) batchGroupValue.value = batchGroupValueOptions.value[0]?.value ?? ""
  batchProgress.value = null
  batchDialogVisible.value = true
}

async function applyBatchAdjustment() {
  if (!workspace.value || !canEdit.value || !batchActionReady.value) return
  if (batchSchedulingMode.value === "LIMITED" && !matchingDestinations.value) {
    ElMessage.warning("当前模板仅支持同一配送点内的有限批量调整")
    return
  }
  const selectedCount = selectedOrderIds.value.length
  batchProgress.value = startV3OperationProgress("批量调度调整", ["保存当前调度", "提交批量调整", "汇总调整结果"])
  if (!(await saveDraft(false, false)) || !workspace.value) {
    batchProgress.value = failV3OperationProgress(batchProgress.value, "调度草稿保存失败，未提交批量调整")
    return
  }
  batchProgress.value = advanceV3OperationProgress(batchProgress.value, 1)
  try {
    applyWorkspace(await api<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${props.project.id}/schedule-plan/batch-adjust`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: workspace.value.draft.revision,
        orderIds: selectedOrderIds.value,
        group: { type: batchSelectionSource.value, value: batchSelectionValue.value },
        adjustment: {
          aircraftId: batchTargetAircraftId.value || undefined,
          outboundRouteId: batchTargetOutboundRouteId.value || undefined,
          returnRouteId: batchTargetReturnRouteId.value || undefined,
          takeoffShiftMs: batchTakeoffShiftMinutes.value ? batchTakeoffShiftMinutes.value * 60_000 : undefined
        }
      })
    }))
    batchTargetAircraftId.value = ""
    batchTargetOutboundRouteId.value = ""
    batchTargetReturnRouteId.value = ""
    batchTakeoffShiftMinutes.value = 0
    batchProgress.value = advanceV3OperationProgress(batchProgress.value, 2)
    batchProgress.value = completeV3OperationProgress(batchProgress.value, `已调整 ${selectedCount} 条任务，形成调度草稿 R${workspace.value.draft.revision}，等待调度检查`)
    ElMessage.success(`已批量调整 ${selectedCount} 条任务，请执行调度检查`)
  } catch (error) {
    const message = error instanceof Error ? error.message : "批量调度调整失败"
    batchProgress.value = failV3OperationProgress(batchProgress.value, message)
    ElMessage.error(message)
  }
}

function assignSelectedOrders() {
  if (!canEdit.value || selectedOrders.value.length === 0) return
  try {
    items.value = assignLogisticsTasks({
      items: items.value,
      orders: selectedOrders.value,
      aircraftId: selectedAircraftId.value,
      outboundRouteId: selectedOutboundRouteId.value,
      returnRouteId: selectedReturnRouteId.value,
      firstTakeoffTimeMs: plannedTakeoffMinute.value * 60_000,
      intervalMs: batchIntervalMinutes.value * 60_000
    })
    selectedOrderIds.value = []
    batchSelectionSource.value = "MANUAL"
    batchSelectionValue.value = ""
    assignmentDialogVisible.value = false
  } catch (error) {
    ElMessage.warning(error instanceof Error ? error.message : "任务分配失败")
  }
}

function showItemRoute(item: LogisticsScheduleItemInput) {
  selectedScheduleItemId.value = item.id
  selectedMapRouteKey.value = routeById(item.outboundRouteId)?.route.id ?? ""
}

async function saveDraft(showMessage = true, showLoading = true): Promise<boolean> {
  if (!workspace.value || !canEdit.value) return false
  if (!dirty.value) {
    saveState.value = "SAVED"
    return true
  }
  if (savePromise) {
    const saved = await savePromise
    return saved && dirty.value ? saveDraft(showMessage, showLoading) : saved
  }
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = null
  const revision = workspace.value.draft.revision
  const payload = items.value.map((item) => ({ ...item }))
  const payloadFingerprint = JSON.stringify(payload)
  if (showLoading) loading.value = true
  saveState.value = "PENDING"
  savePromise = (async () => {
    try {
      const value = await api<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${props.project.id}/schedule-plan/draft`, {
        method: "PUT",
        body: JSON.stringify({ expectedRevision: revision, items: payload })
      })
      if (JSON.stringify(items.value) === payloadFingerprint) {
        applyWorkspace(value)
      } else {
        workspace.value = value
        persistedItems.value = JSON.stringify(value.draft.items)
        saveState.value = "PENDING"
      }
      if (showMessage) ElMessage.success("调度草稿已保存")
      return true
    } catch (error) {
      saveState.value = "ERROR"
      ElMessage.error(error instanceof Error ? error.message : "调度草稿保存失败")
      return false
    } finally {
      if (showLoading) loading.value = false
      savePromise = null
    }
  })()
  const saved = await savePromise
  return saved && dirty.value ? saveDraft(false, showLoading) : saved
}

async function checkPlan() {
  if (!(await saveDraft(false))) return
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${props.project.id}/schedule-plan/check`, { method: "POST" }))
    ElMessage.success(workspace.value?.draft.lastCheckResult?.submittable ? "调度可提交" : "调度检查完成")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "调度检查失败")
  } finally {
    loading.value = false
  }
}

async function createVersion() {
  if (!(await saveDraft(false))) return
  await checkPlan()
  if (!workspace.value?.draft.lastCheckResult) return
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${props.project.id}/schedule-plan/snapshot`, { method: "POST" }))
    ElMessage.success("调度版本已保存")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "调度版本保存失败")
  } finally {
    loading.value = false
  }
}

async function restoreVersion(versionId: string) {
  if (!workspace.value || !canEdit.value) return
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${props.project.id}/schedule-plan/versions/${versionId}/restore`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftRevision: workspace.value.draft.revision })
    }))
    ElMessage.success("已恢复调度版本")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "调度版本恢复失败")
  } finally {
    loading.value = false
  }
}

async function submitVersion() {
  if (!workspace.value || !submittableVersion.value || !workspace.value.canSubmit) return
  await ElMessageBox.confirm(`提交调度版本 V${submittableVersion.value.versionNo} 后将锁定初始计划并进入运行准备。`, "提交初始调度", { type: "warning", confirmButtonText: "确认提交" })
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsSchedulingWorkspaceView>(`/v3/logistics-projects/${props.project.id}/schedule-plan/versions/${submittableVersion.value.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ expectedDraftRevision: workspace.value.draft.revision, expectedStageRevision: props.stage.revision })
    }))
    emit("refreshProject")
    ElMessage.success("初始调度已提交")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "初始调度提交失败")
  } finally {
    loading.value = false
  }
}

function estimateItem(item: LogisticsScheduleItemInput) {
  const order = workspace.value?.orders.find((entry) => entry.id === item.orderId)
  const aircraft = workspace.value?.aircraft.find((entry) => entry.id === item.aircraftId)
  const outbound = routeById(item.outboundRouteId)
  const inbound = routeById(item.returnRouteId)
  const arrivalTimeMs = item.plannedTakeoffTimeMs + (outbound?.flightTimeMs ?? 0)
  const returnStartTimeMs = arrivalTimeMs + 60_000
  const landingTimeMs = returnStartTimeMs + (inbound?.flightTimeMs ?? 0)
  return {
    ...item,
    orderCode: order?.code ?? "-",
    aircraftCode: aircraft?.code ?? "-",
    destinationNodeId: order?.destinationNodeId ?? "",
    arrivalTimeMs,
    returnStartTimeMs,
    landingTimeMs,
    nextAvailableTimeMs: landingTimeMs + 120_000,
    batteryAfterMissionPercent: (aircraft?.initialBatteryPercent ?? 100) - (outbound?.batteryConsumptionPercent ?? 0) - (inbound?.batteryConsumptionPercent ?? 0)
  }
}

function destinationName(id: string) {
  return props.region.logisticsNodes?.find((node) => node.id === id)?.name ?? id
}

function routeLabel(routeId: string) {
  return routeById(routeId)?.route.name ?? "航线不可用"
}

function formatTime(value: number) {
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.floor(value % 60_000 / 1_000)
  return `T+${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function timelineStyle(start: number, end: number) {
  const total = Math.max(1, timelineEndMs.value)
  return { left: `${start / total * 100}%`, width: `${Math.max(2.5, (end - start) / total * 100)}%` }
}

function timelineMissionStart(item: LogisticsScheduleItemView) {
  // The bar starts at the actual takeoff. The pre-takeoff waiting window is not a task segment.
  return item.plannedTakeoffTimeMs
}

function timelineSegmentStyle(start: number, end: number, missionStart: number, missionEnd: number) {
  const duration = Math.max(1, missionEnd - missionStart)
  return { left: `${(start - missionStart) / duration * 100}%`, width: `${Math.max(1, (end - start) / duration * 100)}%` }
}

function formatStageTime(start: number, end: number) {
  return start === end ? formatTime(start) : `${formatTime(start)} - ${formatTime(end)}`
}

function orderEarliestDisplayTime(order: LogisticsSchedulingOrderView) {
  return computedItems.value.find((item) => item.orderId === order.id)?.plannedTakeoffTimeMs ?? order.earliestStartTimeMs
}

function orderLatestDisplayTime(order: LogisticsSchedulingOrderView) {
  return computedItems.value.find((item) => item.orderId === order.id)?.arrivalTimeMs ?? order.latestArrivalTimeMs
}

function timelineSegments(item: LogisticsScheduleItemView) {
  const order = workspace.value?.orders.find((entry) => entry.id === item.orderId)
  return order ? buildLogisticsTaskTimeline(item, order).segments : []
}

function openTimelineDialog(item: LogisticsScheduleItemView) {
  timelineDialogItemId.value = item.id
  timelineDialogVisible.value = true
}

function orderPriorityLabel(value: string) {
  return value === "URGENT" ? "紧急" : value === "PRIORITY" ? "优先" : "普通"
}

function aircraftStatusLabel(value: string) {
  return value === "UNAVAILABLE" ? "不可用 / 飞前异常" : value === "LOW_BATTERY" ? "低电量" : "可用"
}

function batchSelectionLabel() {
  if (batchSelectionSource.value === "MANUAL") return "手动多选"
  return batchGroupTypes.value.find((item) => item.value === batchSelectionSource.value)?.label ?? "分组选择"
}
</script>

<template>
  <section class="scheduling-workspace" v-loading="loading">
    <header class="scheduling-commandbar">
      <div><span>初始调度</span><strong>订单与初始调度</strong><small>{{ formatScaleTemplateCode(workspace?.scaleTemplateCode) }} · {{ workspace?.strictSerialOperation ? '严格单机串行' : '多机并行' }}</small></div>
      <dl><div><dt>订单</dt><dd>{{ assignedOrderIds.size }}/{{ workspace?.orders.length ?? 0 }}</dd></div><div><dt>无人机</dt><dd>{{ workspace?.aircraft.length ?? 0 }}</dd></div><div><dt>草稿</dt><dd>R{{ workspace?.draft.revision ?? 1 }}</dd></div></dl>
      <em :class="checkResult?.status.toLowerCase()">{{ !checkResult ? formatValidationStatus('PENDING') : formatValidationStatus(checkResult.status) }}</em>
      <div v-if="canEdit" class="scheduling-actions">
        <el-button @click="saveDraft()">保存</el-button>
        <el-button :disabled="items.length === 0" @click="checkPlan"><el-icon><Check /></el-icon>检查</el-button>
        <el-button :disabled="items.length === 0" @click="createVersion"><el-icon><FolderOpened /></el-icon>保存版本</el-button>
        <el-button v-if="batchSchedulingMode !== 'NONE'" @click="openBatchDialog"><el-icon><Operation /></el-icon>批量调整</el-button>
        <el-button type="primary" :disabled="!workspace?.canSubmit || !submittableVersion" @click="submitVersion"><el-icon><UploadFilled /></el-icon>提交调度</el-button>
      </div>
      <span v-else class="read-only-state"><el-icon><CircleCheck /></el-icon>{{ user.role === 'student' ? '初始调度已锁定' : '教师只读查看' }}</span>
    </header>

    <aside class="order-pool">
      <header><div><strong>订单池 · {{ filteredOrders.length }}</strong></div><nav><button type="button" :disabled="!batchMultiSelectEnabled || filteredOrders.length === 0" title="选择当前筛选结果" aria-label="选择当前筛选结果" @click="selectFilteredOrders"><el-icon><Select /></el-icon></button><button type="button" title="重置筛选" aria-label="重置筛选" @click="clearOrderFilters"><el-icon><RefreshRight /></el-icon></button></nav></header>
      <section class="order-filters">
        <el-select v-model="orderDestinationFilter" size="small" placeholder="配送点" clearable><el-option v-for="nodeId in selectedDeliveryPointIds" :key="nodeId" :label="destinationName(nodeId)" :value="nodeId" /></el-select>
        <el-select v-model="orderPriorityFilter" size="small" placeholder="优先级" clearable><el-option label="紧急" value="URGENT" /><el-option label="优先" value="PRIORITY" /><el-option label="普通" value="NORMAL" /></el-select>
        <el-select v-model="orderStatusFilter" size="small"><el-option label="全部状态" value="ALL" /><el-option label="待分配" value="UNASSIGNED" /><el-option label="已分配" value="SCHEDULED" /></el-select>
        <el-select v-model="orderSort" size="small"><el-option label="最晚到达优先" value="LATEST_ARRIVAL" /><el-option label="释放时间优先" value="RELEASE_TIME" /><el-option label="紧急程度优先" value="PRIORITY" /></el-select>
        <el-select v-model="orderRouteFilter" size="small" placeholder="去程航线" clearable><el-option v-for="route in workspace?.routes.filter(item => item.route.direction === 'OUTBOUND') ?? []" :key="route.id" :label="route.route.name" :value="route.id" /></el-select>
        <el-select v-model="orderAircraftFilter" size="small" placeholder="无人机" clearable><el-option v-for="aircraftItem in workspace?.aircraft ?? []" :key="aircraftItem.id" :label="aircraftItem.code" :value="aircraftItem.id" /></el-select>
      </section>
      <div class="order-list">
        <button v-for="order in filteredOrders" :key="order.id" type="button" :class="['order-row', order.priority.toLowerCase(), { selected: selectedOrderIds.includes(order.id), assigned: assignedOrderIds.has(order.id) }]" :aria-label="`${order.code}，点击打开任务分配`" @click="openAssignmentDialog(order.id)">
          <header><i>{{ order.code }}</i><strong>{{ destinationName(order.destinationNodeId) }}</strong><em>{{ orderPriorityLabel(order.priority) }}</em><b>{{ logisticsOrderStatusLabel(order.status) }}</b></header>
          <dl>
            <div><dt>释放</dt><dd>{{ formatTime(order.releaseTimeMs) }}</dd></div>
            <div><dt>{{ assignedOrderIds.has(order.id) ? '计划起飞' : '最早执行' }}</dt><dd>{{ formatTime(orderEarliestDisplayTime(order)) }}</dd></div>
            <div><dt>{{ assignedOrderIds.has(order.id) ? '预计到达' : '最晚到达' }}</dt><dd>{{ formatTime(orderLatestDisplayTime(order)) }}</dd></div>
          </dl>
        </button>
      </div>
      <p v-if="canEdit" class="order-pool-hint">点击订单打开任务分配；已分配订单可重新打开并调整。</p>
      <section class="schedule-check-panel">
        <header><strong>调度核定</strong><em :class="checkResult?.status.toLowerCase()">{{ formatValidationStatus(checkResult?.status ?? 'PENDING') }}</em></header>
        <dl><div><dt>硬冲突</dt><dd>{{ checkResult?.conflictCount ?? 0 }}</dd></div><div><dt>风险</dt><dd>{{ checkResult?.riskCount ?? 0 }}</dd></div><div><dt>效率项</dt><dd>{{ checkResult?.infoCount ?? 0 }}</dd></div></dl>
        <div class="schedule-evidence">
        <article v-for="evidence in checkResult?.evidence ?? []" :key="`${evidence.code}-${evidence.scheduleItemIds.join('-')}`" :class="evidence.severity.toLowerCase()"><el-icon><Warning v-if="evidence.severity !== 'INFO'" /><CircleCheck v-else /></el-icon><span><strong>{{ formatLogisticsEvidenceCode(evidence.code) }}</strong><small>{{ evidence.message }}</small></span></article>
          <span v-if="checkResult && checkResult.evidence.length === 0"><el-icon><CircleCheck /></el-icon>未发现冲突或风险</span>
          <span v-else-if="workspace?.mode === 'ASSESSMENT' && checkResult"><el-icon><Check /></el-icon>考核模式仅显示核定状态</span>
        </div>
      </section>
    </aside>

    <main class="scheduling-map">
      <V3UnifiedMap renderer="logistics-route"
        v-if="workspace"
        :region="region"
        :visible-layers="visibleLayers"
        :show-labels="showLabels"
        :visible-node-types="['CENTER_AIRPORT', 'DELIVERY_POINT', 'WAITING_POINT', 'ALTERNATE_LANDING_POINT']"
        :selected-delivery-point-ids="selectedDeliveryPointIds"
        :routes="workspace.routes.map(item => item.route)"
        :selected-route-id="selectedMapRouteKey"
        selected-waypoint-id=""
        :mode="mapMode"
        :editable="false"
        :add-waypoint-mode="false"
        @route-select="selectedMapRouteKey = $event"
        @data-state="emit('dataState', $event)"
      />
      <div class="scheduling-map-caption"><i /><div><strong>{{ selectedMapRoute?.route.name ?? '已提交航线网络' }}</strong><small>正式航线 V{{ selectedMapRoute?.versionNo ?? workspace?.routes[0]?.versionNo ?? '-' }} · {{ workspace?.routes.length ?? 0 }} 条可调度航线</small></div></div>
      <V3EnvironmentLayerPanel
        :region="region"
        scene-type="CITY_LOGISTICS"
        :visible-layers="visibleLayers"
        :visible-node-types="['WAITING_POINT', 'ALTERNATE_LANDING_POINT']"
        :show-labels="showLabels"
        @toggle-layer="emit('toggleLayer', $event)"
        @toggle-labels="showLabels = !showLabels"
      />
    </main>

    <aside class="aircraft-pool">
      <header><div><strong>无人机池</strong></div><b>{{ aircraftPoolRows.length }} / {{ workspace?.aircraft.length ?? 0 }}</b></header>
      <div class="aircraft-filters">
        <el-input v-model="aircraftPoolFilter" size="small" clearable placeholder="搜索编号或位置" />
        <el-select v-model="aircraftPoolStatusFilter" size="small" placeholder="状态">
          <el-option label="全部状态" value="ALL" /><el-option label="可用" value="READY" /><el-option label="低电量" value="LOW_BATTERY" /><el-option label="不可用" value="UNAVAILABLE" />
        </el-select>
      </div>
      <div class="aircraft-list">
        <button v-for="aircraftItem in aircraftPoolRows" :key="aircraftItem.id" type="button" :class="[aircraftItem.status.toLowerCase(), { selected: selectedAircraftId === aircraftItem.id }]" :aria-pressed="selectedAircraftId === aircraftItem.id" :disabled="aircraftItem.status === 'UNAVAILABLE'" @click="selectedAircraftId = aircraftItem.id">
          <header><i>{{ aircraftItem.code.slice(-3) }}</i><strong>{{ aircraftItem.code }}</strong><em>{{ aircraftItem.initialBatteryPercent }}% 电量</em><b>{{ aircraftStatusLabel(aircraftItem.status) }}</b></header>
          <dl>
            <div><dt>当前位置</dt><dd>{{ aircraftItem.currentLocation.label }}</dd></div>
            <div><dt>预计返回</dt><dd>{{ aircraftItem.estimatedReturnTimeMs === null ? '未安排' : formatTime(aircraftItem.estimatedReturnTimeMs) }}</dd></div>
            <div><dt>再次可用</dt><dd>{{ formatTime(aircraftItem.nextAvailableTimeMs) }}</dd></div>
          </dl>
          <section><span>已安排任务</span><small v-if="aircraftItem.taskQueue.length === 0">暂无任务</small><ol v-else><li v-for="task in aircraftItem.taskQueue" :key="task.scheduleItemId"><strong>{{ task.orderCode }}</strong><span>{{ destinationName(task.destinationNodeId) }}</span><time>{{ formatTime(task.plannedTakeoffTimeMs) }}</time></li></ol></section>
        </button>
        <span v-if="aircraftPoolRows.length === 0" class="dispatch-empty">没有符合条件的无人机</span>
      </div>
    </aside>

    <section class="aircraft-timeline">
      <header><div><strong>无人机时刻表</strong><small class="timeline-summary">{{ items.length }} 班 · 按无人机分组</small></div><div class="timeline-scale"><span v-for="step in 5" :key="step">{{ formatTime(timelineEndMs * (step - 1) / 4) }}</span></div></header>
      <div class="timeline-body">
        <div v-for="aircraftItem in timelineAircraft" :key="aircraftItem.id" class="timeline-lane"><strong>{{ aircraftItem.code }}</strong><div><button v-for="item in computedItems.filter(entry => entry.aircraftId === aircraftItem.id)" :key="item.id" type="button" :style="timelineStyle(timelineMissionStart(item), item.nextAvailableTimeMs)" :class="['timeline-mission', { selected: selectedScheduleItemId === item.id }]" :aria-label="`${item.orderCode} 任务时刻，结束于 ${formatTime(item.nextAvailableTimeMs)}，点击查看阶段详情`" :aria-pressed="selectedScheduleItemId === item.id" @click="openTimelineDialog(item)"><i v-for="segment in timelineSegments(item)" :key="segment.code" :class="segment.code.toLowerCase()" :style="timelineSegmentStyle(segment.startTimeMs, segment.endTimeMs, timelineMissionStart(item), item.nextAvailableTimeMs)" /><span>{{ item.orderCode }}</span><small>{{ formatTime(item.nextAvailableTimeMs) }}</small></button></div></div>
      </div>
      <article v-if="selectedTimeline" class="timeline-flight-stages">
        <header><strong>{{ selectedTimeline.item.orderCode }} · {{ selectedTimeline.item.aircraftCode }}</strong><span>{{ destinationName(selectedTimeline.item.destinationNodeId) }}</span><div class="timeline-legend"><span v-for="stage in timelineStageLegend" :key="stage.code"><i :class="stage.code.toLowerCase()" />{{ stage.label }}</span></div></header>
        <ol><li v-for="(stageItem, index) in selectedTimeline.timeline.stages" :key="stageItem.code" :class="stageItem.code.toLowerCase()"><i>{{ index + 1 }}</i><span>{{ stageItem.label }}</span><time>{{ formatStageTime(stageItem.startTimeMs, stageItem.endTimeMs) }}</time></li></ol>
      </article>
    </section>

    <aside class="schedule-versions">
      <header><div><span>版本</span><strong>调度版本</strong></div><b>{{ workspace?.versions.length ?? 0 }}</b></header>
      <article v-for="version in workspace?.versions ?? []" :key="version.id" :class="{ active: currentVersion?.id === version.id }" role="button" tabindex="0" :aria-pressed="currentVersion?.id === version.id" :aria-label="`调度版本 V${version.versionNo}，${formatSubmissionStatus(version.status)}`" @click="selectedVersionId = version.id" @keydown.enter.self="selectedVersionId = version.id" @keydown.space.self.prevent="selectedVersionId = version.id">
        <div><strong>V{{ version.versionNo }} · {{ version.status === 'SUBMITTED' ? '正式计划' : '候选计划' }}</strong><small>草稿 R{{ version.sourceDraftRevision }} · {{ version.items.length }} 班 · {{ formatValidationStatus(version.checkResult.status) }}</small></div><em>{{ formatSubmissionStatus(version.status) }}</em><button v-if="canEdit && version.status === 'SNAPSHOT'" type="button" aria-label="恢复调度版本" @click.stop="restoreVersion(version.id)"><el-icon><RefreshRight /></el-icon></button>
      </article>
      <span v-if="workspace?.versions.length === 0"><FolderOpened />尚未保存版本</span>
    </aside>
  </section>

  <el-dialog v-model="batchDialogVisible" class="batch-scheduling-dialog" width="min(720px, calc(100vw - 24px))" top="3vh" title="批量调度调整" append-to-body>
    <V3OperationProgress :state="batchProgress" />
    <section class="batch-group-selection">
      <header><div><span>批量选择</span><strong>按业务分组选择任务</strong></div><b>{{ selectedOrderIds.length }} 条已选</b></header>
      <div>
        <label><span>分组依据</span><el-select v-model="batchGroupType"><el-option v-for="groupItem in batchGroupTypes" :key="groupItem.value" :label="groupItem.label" :value="groupItem.value" /></el-select></label>
        <label><span>分组值</span><el-select v-model="batchGroupValue"><el-option v-for="option in batchGroupValueOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></label>
        <el-button :disabled="!batchGroupValue" @click="selectBatchGroup"><el-icon><Select /></el-icon>选择该组</el-button>
      </div>
      <p><strong>{{ batchSelectionLabel() }}</strong><span>{{ selectedOrderIds.length === 0 ? '尚未选择任务' : allSelectedOrdersScheduled ? '所选任务均已分配' : '包含未分配订单，不能执行批量调整' }}</span></p>
    </section>
    <section class="batch-adjustment-fields">
      <header><span>批量调整</span><strong>批量调整内容</strong></header>
      <div>
        <label><span>目标无人机（可选）</span><el-select v-model="batchTargetAircraftId" clearable placeholder="保持原无人机"><el-option v-for="aircraftItem in workspace?.aircraft ?? []" :key="aircraftItem.id" :disabled="aircraftItem.status === 'UNAVAILABLE'" :label="`${aircraftItem.code} · ${aircraftStatusLabel(aircraftItem.status)}`" :value="aircraftItem.id" /></el-select></label>
        <label><span>目标去程航线（可选）</span><el-select v-model="batchTargetOutboundRouteId" :disabled="!batchSelectedDestinationId" clearable placeholder="保持原航线"><el-option v-for="route in batchTargetOutboundRoutes" :key="route.id" :label="route.route.name" :value="route.id" /></el-select></label>
        <label><span>目标返程航线（可选）</span><el-select v-model="batchTargetReturnRouteId" :disabled="!batchSelectedDestinationId" clearable placeholder="保持原航线"><el-option v-for="route in batchTargetReturnRoutes" :key="route.id" :label="route.route.name" :value="route.id" /></el-select></label>
        <label><span>起飞时刻整体偏移（分钟）</span><el-input-number v-model="batchTakeoffShiftMinutes" :min="-1440" :max="1440" :step="5" /></label>
      </div>
      <p>{{ batchSelectedDestinationId ? `同一配送点：${destinationName(batchSelectedDestinationId)}，可批量切换已验证航线。` : '跨配送点选择只允许调整无人机或整体平移起飞时刻。' }}</p>
    </section>
    <template #footer><el-button @click="batchDialogVisible = false">{{ batchProgress?.status === 'SUCCEEDED' ? '关闭' : '取消' }}</el-button><el-button type="primary" :loading="batchProgress?.status === 'RUNNING'" :disabled="!batchActionReady" @click="applyBatchAdjustment"><el-icon><Operation /></el-icon>应用到 {{ selectedOrderIds.length }} 条任务</el-button></template>
  </el-dialog>

  <el-dialog v-model="assignmentDialogVisible" class="assignment-dialog" width="min(520px, calc(100vw - 24px))" title="任务分配" append-to-body>
    <template v-if="selectedOrders[0]">
      <div class="assignment-summary"><strong>{{ selectedOrders[0].code }} · {{ destinationName(selectedOrders[0].destinationNodeId) }}</strong><span>{{ orderPriorityLabel(selectedOrders[0].priority) }} · 最早执行 {{ formatTime(selectedOrders[0].earliestStartTimeMs) }} · 最晚到达 {{ formatTime(selectedOrders[0].latestArrivalTimeMs) }}</span></div>
      <section class="assignment-fields">
        <label><span>无人机</span><el-select v-model="selectedAircraftId"><el-option v-for="aircraftItem in workspace?.aircraft ?? []" :key="aircraftItem.id" :disabled="aircraftItem.status === 'UNAVAILABLE'" :label="`${aircraftItem.code} · ${aircraftItem.availableAtMs > 0 ? `待用至 ${formatTime(aircraftItem.availableAtMs)}` : aircraftStatusLabel(aircraftItem.status)}`" :value="aircraftItem.id" /></el-select></label>
        <label><span>去程航线</span><el-select v-model="selectedOutboundRouteId"><el-option v-for="route in outboundRoutes" :key="route.id" :label="route.route.name" :value="route.id" /></el-select></label>
        <label><span>返程航线</span><el-select v-model="selectedReturnRouteId"><el-option v-for="route in returnRoutes" :key="route.id" :label="route.route.name" :value="route.id" /></el-select></label>
        <div><label><span>首班起飞 (min)</span><el-input-number v-model="plannedTakeoffMinute" :min="0" :max="1440" :controls="false" /></label><label><span>批次间隔 (min)</span><el-input-number v-model="batchIntervalMinutes" :min="1" :max="240" :controls="false" /></label></div>
      </section>
    </template>
    <template #footer><el-button @click="assignmentDialogVisible = false">取消</el-button><el-button type="primary" :disabled="!selectedOrderIds.length || !selectedAircraftId || !selectedOutboundRouteId || !selectedReturnRouteId" @click="assignSelectedOrders">{{ assignedOrderIds.has(selectedOrderIds[0] ?? '') ? '保存调整' : '分配到无人机' }}</el-button></template>
  </el-dialog>

  <el-dialog v-model="timelineDialogVisible" class="timeline-dialog" width="min(760px, calc(100vw - 24px))" title="飞行任务阶段详情" append-to-body @closed="timelineDialogItemId = ''">
    <template v-if="selectedTimeline">
      <div v-if="timelineDialogTimeline" class="timeline-dialog-summary"><strong>{{ timelineDialogTimeline.item.orderCode }} · {{ timelineDialogTimeline.item.aircraftCode }}</strong><span>{{ destinationName(timelineDialogTimeline.item.destinationNodeId) }} · {{ formatTime(timelineMissionStart(timelineDialogTimeline.item)) }} 至 {{ formatTime(timelineDialogTimeline.item.nextAvailableTimeMs) }}</span></div>
      <div class="timeline-dialog-legend"><span v-for="stage in timelineStageLegend" :key="stage.code"><i :class="stage.code.toLowerCase()" />{{ stage.label }}</span></div>
      <ol v-if="timelineDialogTimeline" class="timeline-dialog-stages"><li v-for="(stageItem, index) in timelineDialogTimeline.timeline.stages" :key="stageItem.code" :class="stageItem.code.toLowerCase()"><i>{{ index + 1 }}</i><div><strong>{{ stageItem.label }}</strong><time>{{ formatStageTime(stageItem.startTimeMs, stageItem.endTimeMs) }}</time></div></li></ol>
    </template>
  </el-dialog>
</template>

<style scoped>
.scheduling-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: 224px minmax(500px,1fr) 232px; grid-template-rows: 62px minmax(300px,1fr) auto; min-width: 0; min-height: 0; overflow: hidden; color: #20322b; background: #e4e9e6; }
.scheduling-commandbar { grid-column: 1 / 4; display: grid; grid-template-columns: minmax(190px,1fr) auto auto auto; align-items: center; gap: 16px; border-bottom: 1px solid #ccd7d2; padding: 8px 14px; background: #fff; }.scheduling-commandbar > div:first-child { display: grid; gap: 1px; }.scheduling-commandbar span,.order-pool header span,.aircraft-pool header span,.dispatch-table header span,.aircraft-timeline header span,.schedule-versions header span { color: #2b7257; font-size: 11px; font-weight: 800; }.scheduling-commandbar strong { font-size: 15px; }.scheduling-commandbar small { color: #71837c; font-size: 10px; }.scheduling-commandbar dl { display: flex; margin: 0; }.scheduling-commandbar dl div { min-width: 62px; border-left: 1px solid #dde4e1; padding: 0 10px; }.scheduling-commandbar dt { color: #7a8b84; font-size: 11px; }.scheduling-commandbar dd { margin: 2px 0 0; font-size: 14px; font-weight: 800; }.scheduling-commandbar > em { padding: 6px 9px; color: #586d64; background: #edf1ef; font-size: 10px; font-style: normal; }.scheduling-commandbar > em.passed { color: #176446; background: #dff0e8; }.scheduling-commandbar > em.with_risk { color: #805f14; background: #f5edcf; }.scheduling-commandbar > em.hard_conflict { color: #963e39; background: #f7e3e1; }.scheduling-actions { display: flex; gap: 5px; }.read-only-state { display: flex; align-items: center; gap: 5px; color: #276c53; font-size: 10px; }
.order-pool,.aircraft-pool,.schedule-versions { min-height: 0; border-right: 1px solid #ccd7d2; background: #f8faf9; }.order-pool { grid-column: 1; grid-row: 2 / 4; display: grid; grid-template-rows: 48px auto minmax(120px,1fr) auto; }.order-pool > header,.aircraft-pool > header,.schedule-versions > header,.dispatch-table > header,.aircraft-timeline > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; border-bottom: 1px solid #d8e0dc; padding: 8px 11px; background: #fff; }.order-pool header > div,.aircraft-pool header > div,.dispatch-table header > div,.aircraft-timeline header > div,.schedule-versions header > div { display: grid; gap: 1px; }.order-pool header strong,.aircraft-pool header strong,.dispatch-table header strong,.aircraft-timeline header strong,.schedule-versions header strong { font-size: 12px; }.order-pool nav { display: flex; }.order-pool nav button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-left: 1px solid #dce4e0; color: #47665a; background: transparent; cursor: pointer; }.order-pool nav button:disabled { opacity: .3; cursor: default; }.order-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; border-bottom: 1px solid #d7e0dc; padding: 7px 8px; background: #f2f6f4; }.order-filters :deep(.el-select) { min-width: 0; width: 100%; }.order-filters :deep(.el-select__wrapper) { min-height: 25px; padding: 3px 7px; font-size: 11px; }.order-list,.aircraft-list { min-height: 0; overflow: auto; }.order-row { display: grid; gap: 7px; width: 100%; min-height: 76px; border: 0; border-bottom: 1px solid #e0e6e3; border-left: 3px solid #7d8f87; padding: 8px; text-align: left; background: transparent; cursor: pointer; }.order-row.priority { border-left-color: #ba8426; }.order-row.urgent { border-left-color: #b64d43; }.order-row.selected { background: #e4f0ea; }.order-row.assigned { opacity: .74; }.order-row > header { display: grid; grid-template-columns: 52px minmax(0,1fr) auto auto; align-items: center; gap: 6px; }.order-row i { color: #4f665d; font-size: 11px; font-style: normal; font-weight: 800; }.order-row strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }.order-row em,.order-row b { font-size: 11px; font-style: normal; }.order-row em { color: #795b19; }.order-row b { color: #4f6e62; }.order-row dl { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 6px; margin: 0; }.order-row dl div { min-width: 0; }.order-row dt { color: #7b8b84; font-size: 11px; }.order-row dd { margin: 2px 0 0; color: #41564e; font-size: 11px; white-space: nowrap; }.order-pool-hint { margin: 0; border-top: 1px solid #d8e2dc; padding: 7px 9px; color: #6b8076; background: #fff; font-size: 11px; line-height: 1.4; }
.dispatch-form { display: grid; gap: 4px; border-top: 1px solid #cbd7d1; padding: 7px 10px; background: #fff; }.dispatch-form header { display: flex; justify-content: space-between; }.dispatch-form header strong { font-size: 11px; }.dispatch-form header small { color: #63786f; font-size: 11px; }.dispatch-form label { display: grid; gap: 1px; }.dispatch-form label > span { color: #657971; font-size: 11px; }.dispatch-form > div { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }.dispatch-form :deep(.el-select),.dispatch-form :deep(.el-input-number) { width: 100%; }.dispatch-form :deep(.el-select__wrapper),.dispatch-form :deep(.el-input__wrapper) { min-height: 28px; }.dispatch-form > .el-button { height: 28px; }
.scheduling-map { position: relative; grid-column: 2; grid-row: 2; min-width: 0; min-height: 0; overflow: hidden; }.scheduling-map-caption { position: absolute; z-index: 3; left: 12px; bottom: 12px; display: grid; grid-template-columns: 7px minmax(0,1fr); align-items: center; gap: 8px; padding: 8px 10px; color: #fff; background: rgba(20,53,42,.9); }.scheduling-map-caption i { width: 7px; height: 30px; background: #58a47e; }.scheduling-map-caption div { display: grid; gap: 2px; }.scheduling-map-caption strong { font-size: 10px; }.scheduling-map-caption small { color: rgba(255,255,255,.7); font-size: 11px; }
.aircraft-pool { grid-column: 3; grid-row: 2 / 4; display: grid; grid-template-rows: 48px auto minmax(120px,1fr) auto; border-right: 0; border-left: 1px solid #ccd7d2; }.aircraft-pool header b { color: #2a7055; font-size: 10px; }.aircraft-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; border-bottom: 1px solid #d7e0dc; padding: 7px 8px; background: #f2f6f4; }.aircraft-filters :deep(.el-input),.aircraft-filters :deep(.el-select) { min-width: 0; width: 100%; }.aircraft-filters :deep(.el-input__wrapper),.aircraft-filters :deep(.el-select__wrapper) { min-height: 25px; padding: 3px 7px; font-size: 11px; }.aircraft-list > button { display: grid; gap: 7px; width: 100%; min-height: 118px; border: 0; border-bottom: 1px solid #e0e6e3; padding: 8px; text-align: left; background: transparent; cursor: pointer; }.aircraft-list > button.selected { background: #e4f0ea; }.aircraft-list > button.unavailable { opacity: .58; }.aircraft-list > button > header { display: grid; grid-template-columns: 30px minmax(0,1fr) auto auto; align-items: center; gap: 6px; }.aircraft-list i { display: grid; width: 30px; height: 30px; place-items: center; color: #21684f; background: #deeee7; font-size: 11px; font-style: normal; font-weight: 800; }.aircraft-list .low_battery i { color: #8b6419; background: #f4e8c4; }.aircraft-list strong { min-width: 0; font-size: 11px; }.aircraft-list em,.aircraft-list b { font-size: 11px; font-style: normal; white-space: nowrap; }.aircraft-list em { color: #50685e; }.aircraft-list b { color: #5d746a; }.aircraft-list dl { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 5px; margin: 0; }.aircraft-list dl div { min-width: 0; border-left: 2px solid #c9d9d1; padding-left: 5px; }.aircraft-list dt,.aircraft-list > button > section > span { color: #778981; font-size: 11px; }.aircraft-list dd { overflow: hidden; margin: 2px 0 0; color: #344b42; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.aircraft-list > button > section { display: grid; gap: 4px; min-width: 0; }.aircraft-list > button > section > small { color: #778981; font-size: 11px; }.aircraft-list ol { display: grid; gap: 3px; margin: 0; padding: 0; list-style: none; }.aircraft-list li { display: grid; grid-template-columns: 52px minmax(0,1fr) auto; gap: 5px; min-width: 0; padding-top: 3px; border-top: 1px solid #dce5e0; }.aircraft-list li span { overflow: hidden; color: #60746b; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }.aircraft-list time { color: #2b7257; font-size: 11px; white-space: nowrap; }
.schedule-check-panel { border-top: 1px solid #ccd7d2; padding: 10px; background: #fff; }.schedule-check-panel > header { display: flex; justify-content: space-between; }.schedule-check-panel header strong { font-size: 11px; }.schedule-check-panel header em { padding: 3px 5px; color: #61756c; background: #edf1ef; font-size: 11px; font-style: normal; }.schedule-check-panel header em.passed { color: #176446; background: #dff0e8; }.schedule-check-panel header em.with_risk { color: #805f14; background: #f5edcf; }.schedule-check-panel header em.hard_conflict { color: #963e39; background: #f7e3e1; }.schedule-check-panel dl { display: grid; grid-template-columns: repeat(3,1fr); margin: 9px 0; border: 1px solid #dce4e0; }.schedule-check-panel dl div { border-right: 1px solid #dce4e0; padding: 6px; }.schedule-check-panel dl div:last-child { border-right: 0; }.schedule-check-panel dt { color: #74877f; font-size: 11px; }.schedule-check-panel dd { margin: 2px 0 0; font-size: 14px; font-weight: 800; }.schedule-evidence { max-height: 120px; overflow: auto; }.schedule-evidence article { display: grid; grid-template-columns: 15px minmax(0,1fr); gap: 5px; border-top: 1px solid #e1e7e4; padding: 6px 0; color: #7f5e14; }.schedule-evidence article.conflict { color: #993f39; }.schedule-evidence article.info { color: #42675a; }.schedule-evidence article span { display: grid; gap: 1px; }.schedule-evidence strong { font-size: 11px; }.schedule-evidence small { color: #5f736b; font-size: 11px; line-height: 1.4; }.schedule-evidence > span { display: flex; align-items: center; gap: 5px; color: #2a7055; font-size: 11px; }
.dispatch-table { grid-column: 2; grid-row: 3; min-width: 0; min-height: 0; background: #fff; }.dispatch-table > header small { color: #6f8179; font-size: 11px; }.dispatch-table-head,.dispatch-table-row { display: grid; grid-template-columns: 64px 120px 100px 86px minmax(180px,1fr) 120px 36px; align-items: center; gap: 6px; min-width: 720px; }.dispatch-table-head { height: 29px; border-bottom: 1px solid #dce4e0; padding: 0 8px; color: #71847c; background: #f3f6f4; font-size: 11px; }.dispatch-table-body { max-height: 153px; overflow: auto; }.dispatch-table-row { min-height: 53px; border-bottom: 1px solid #e2e8e5; padding: 4px 8px; }.dispatch-table-row > span:first-child { display: flex; align-items: center; gap: 2px; }.dispatch-table-row > span:first-child b { width: 24px; font-size: 11px; }.dispatch-table-row button { display: grid; width: 22px; height: 22px; place-items: center; border: 0; color: #61766d; background: transparent; cursor: pointer; }.dispatch-table-row button:disabled { opacity: .25; }.dispatch-table-row > span:nth-child(2),.dispatch-table-row > span:nth-child(6) { display: grid; gap: 2px; }.dispatch-table-row strong { font-size: 11px; }.dispatch-table-row small { color: #778981; font-size: 11px; }.dispatch-table-row > span:nth-child(5) { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }.dispatch-table :deep(.el-select),.dispatch-table :deep(.el-input-number) { width: 100%; }.dispatch-empty { display: flex; min-height: 70px; align-items: center; justify-content: center; gap: 6px; color: #7b8c85; font-size: 10px; }
.dispatch-table > header small.save-pending { color: #8a6518; }.dispatch-table > header small.save-error { color: #a43d38; }
.dispatch-table-row.selected { background: #edf5f1; }
.dispatch-table-row:focus-visible,.schedule-versions article:focus-visible { outline: 2px solid #267052; outline-offset: -2px; }
.aircraft-timeline { display: grid; grid-column: 1 / 3; grid-row: 3; grid-template-rows: 48px minmax(36px,1fr) 67px; min-width: 0; min-height: 0; background: #fff; }.aircraft-timeline > header { display: grid; grid-template-columns: 220px minmax(0,1fr); }.timeline-scale { display: flex; justify-content: space-between; color: #71837c; font-size: 11px; }.timeline-body { min-height: 0; overflow: auto; padding: 5px 9px; }.timeline-lane { display: grid; grid-template-columns: 72px minmax(0,1fr); align-items: center; min-height: 34px; }.timeline-lane > strong { font-size: 11px; }.timeline-lane > div { position: relative; height: 24px; border-left: 1px solid #b8c8c0; background: repeating-linear-gradient(90deg,#edf2ef 0,#edf2ef 1px,transparent 1px,transparent 25%); }.timeline-mission { position: absolute; top: 3px; min-width: 36px; height: 18px; overflow: hidden; border: 0; padding: 0 4px; color: #fff; background: #31765b; cursor: pointer; }.timeline-mission.selected { z-index: 2; outline: 2px solid #c98b26; }.timeline-mission i { position: absolute; top: 0; bottom: 0; opacity: .95; }.timeline-mission i.outbound { background: #287052; }.timeline-mission i.arrival_service { background: #c38b2d; }.timeline-mission i.returning { background: #356c85; }.timeline-mission i.recovery { background: #697973; }.timeline-mission span,.timeline-mission small { position: relative; z-index: 1; text-shadow: 0 1px 2px rgba(0,0,0,.38); }.timeline-mission span { float: left; font-size: 11px; font-weight: 800; }.timeline-mission small { float: right; color: rgba(255,255,255,.82); font-size: 11px; }.timeline-flight-stages { min-width: 0; overflow-x: auto; border-top: 1px solid #d8e0dc; background: #f7f9f8; }.timeline-flight-stages > header { display: flex; height: 22px; align-items: center; gap: 8px; padding: 0 9px; }.timeline-flight-stages > header strong { font-size: 11px; }.timeline-flight-stages > header span { color: #6c7f77; font-size: 11px; }.timeline-flight-stages ol { display: grid; grid-template-columns: repeat(7,minmax(88px,1fr)); min-width: 660px; height: 44px; margin: 0; padding: 0 9px 5px; list-style: none; }.timeline-flight-stages li { position: relative; display: grid; grid-template-columns: 14px minmax(0,1fr); grid-template-rows: 17px 15px; align-items: center; border-top: 2px solid #75998a; padding: 2px 5px 0 0; }.timeline-flight-stages li::after { position: absolute; top: -4px; right: 0; width: 5px; height: 5px; background: #39765d; content: ""; }.timeline-flight-stages li i { grid-row: 1 / 3; display: grid; width: 12px; height: 12px; place-items: center; color: #fff; background: #39765d; font-size: 11px; font-style: normal; }.timeline-flight-stages li span { font-size: 11px; font-weight: 800; }.timeline-flight-stages li time { color: #6f8279; font-size: 11px; white-space: nowrap; }
.schedule-versions { grid-column: 3; grid-row: 3; overflow: auto; border-top: 1px solid #ccd7d2; border-left: 1px solid #ccd7d2; }.schedule-versions header b { color: #267052; font-size: 13px; }.schedule-versions article { display: grid; grid-template-columns: minmax(0,1fr) auto 24px; align-items: center; gap: 5px; border-bottom: 1px solid #e0e6e3; padding: 7px 9px; cursor: pointer; }.schedule-versions article.active { background: #e9f2ed; }.schedule-versions article > div { display: grid; gap: 2px; }.schedule-versions article strong { font-size: 11px; }.schedule-versions article small { color: #73867e; font-size: 11px; }.schedule-versions article em { color: #557068; font-size: 11px; font-style: normal; }.schedule-versions article button { display: grid; width: 24px; height: 24px; place-items: center; border: 0; color: #267052; background: transparent; cursor: pointer; }.schedule-versions > span { display: flex; min-height: 70px; align-items: center; justify-content: center; gap: 5px; color: #7c8c86; font-size: 11px; }
.batch-group-selection,.batch-adjustment-fields { display: grid; gap: 12px; padding: 4px 0 18px; }.batch-adjustment-fields { border-top: 1px solid #d8e0dc; padding-top: 18px; }.batch-group-selection > header,.batch-adjustment-fields > header { display: flex; align-items: end; justify-content: space-between; }.batch-group-selection > header div,.batch-adjustment-fields > header { gap: 2px; }.batch-group-selection header div,.batch-adjustment-fields header { display: grid; }.batch-group-selection header span,.batch-adjustment-fields header span { color: #2b7257; font-size: 11px; font-weight: 800; }.batch-group-selection header strong,.batch-adjustment-fields header strong { font-size: 13px; }.batch-group-selection header b { color: #276d53; font-size: 12px; }.batch-group-selection > div { display: grid; grid-template-columns: 1fr 1fr auto; align-items: end; gap: 9px; }.batch-adjustment-fields > div { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }.batch-group-selection label,.batch-adjustment-fields label { display: grid; gap: 5px; }.batch-group-selection label > span,.batch-adjustment-fields label > span { color: #667a71; font-size: 11px; }.batch-group-selection p,.batch-adjustment-fields p { display: flex; justify-content: space-between; gap: 12px; margin: 0; border-left: 3px solid #39765d; padding: 8px 10px; color: #62776e; background: #edf3f0; font-size: 11px; }.batch-group-selection p strong { color: #275d49; }.batch-group-selection :deep(.el-select),.batch-adjustment-fields :deep(.el-select),.batch-adjustment-fields :deep(.el-input-number) { width: 100%; }
:global(.batch-scheduling-dialog) { max-width: 720px; border-radius: 4px; }.batch-scheduling-dialog :deep(.el-dialog__header) { border-bottom: 1px solid #d7dfdb; padding-bottom: 14px; }.batch-scheduling-dialog :deep(.el-dialog__footer) { border-top: 1px solid #d7dfdb; padding-top: 14px; }
.timeline-mission i.waiting_execution { background: #95a59d; }.timeline-mission i.takeoff { background: #2f7055; }.timeline-mission i.outbound { background: #287052; }.timeline-mission i.arrival_confirmation { background: #c38b2d; }.timeline-mission i.returning { background: #356c85; }.timeline-mission i.landing { background: #7a6b4e; }.timeline-mission i.available_again { background: #697973; }
.timeline-flight-stages > header { min-height: 22px; height: auto; }.timeline-flight-stages > header > span { color: #6c7f77; font-size: 11px; }.timeline-legend,.timeline-dialog-legend { display: flex; align-items: center; gap: 7px; margin-left: auto; overflow-x: auto; white-space: nowrap; }.timeline-flight-stages > header > .timeline-legend { display: flex; flex: 1 1 auto; min-width: 0; }.timeline-legend span,.timeline-dialog-legend span { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 3px; color: #647970; font-size: 11px; }.timeline-legend i,.timeline-dialog-legend i { display: inline-block; width: 8px; height: 8px; }.timeline-legend i.waiting_execution,.timeline-dialog-legend i.waiting_execution { background: #95a59d; }.timeline-legend i.takeoff,.timeline-dialog-legend i.takeoff { background: #2f7055; }.timeline-legend i.outbound,.timeline-dialog-legend i.outbound { background: #287052; }.timeline-legend i.arrival_confirmation,.timeline-dialog-legend i.arrival_confirmation { background: #c38b2d; }.timeline-legend i.returning,.timeline-dialog-legend i.returning { background: #356c85; }.timeline-legend i.landing,.timeline-dialog-legend i.landing { background: #7a6b4e; }.timeline-legend i.available_again,.timeline-dialog-legend i.available_again { background: #697973; }.timeline-flight-stages li.waiting_execution { border-color: #95a59d; }.timeline-flight-stages li.takeoff { border-color: #2f7055; }.timeline-flight-stages li.outbound { border-color: #287052; }.timeline-flight-stages li.arrival_confirmation { border-color: #c38b2d; }.timeline-flight-stages li.returning { border-color: #356c85; }.timeline-flight-stages li.landing { border-color: #7a6b4e; }.timeline-flight-stages li.available_again { border-color: #697973; }
.assignment-summary,.timeline-dialog-summary { display: grid; gap: 4px; margin-bottom: 14px; padding: 10px; color: #29493d; background: #eef5f1; border-left: 3px solid #2f7055; }.assignment-summary strong,.timeline-dialog-summary strong { font-size: 13px; }.assignment-summary span,.timeline-dialog-summary span { color: #6a7d74; font-size: 11px; }.assignment-fields { display: grid; gap: 10px; }.assignment-fields label { display: grid; gap: 4px; }.assignment-fields label > span { color: #62766d; font-size: 11px; }.assignment-fields > div { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }.assignment-fields :deep(.el-select),.assignment-fields :deep(.el-input-number) { width: 100%; }.timeline-dialog-legend { margin: 0 0 12px; flex-wrap: wrap; white-space: normal; }.timeline-dialog-stages { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 7px; margin: 0; padding: 0; list-style: none; }.timeline-dialog-stages li { display: grid; grid-template-columns: 24px minmax(0,1fr); align-items: center; gap: 8px; padding: 9px; border: 1px solid #dce5e0; border-left: 3px solid #75998a; background: #f8faf9; }.timeline-dialog-stages li.waiting_execution { border-left-color: #95a59d; }.timeline-dialog-stages li.takeoff { border-left-color: #2f7055; }.timeline-dialog-stages li.outbound { border-left-color: #287052; }.timeline-dialog-stages li.arrival_confirmation { border-left-color: #c38b2d; }.timeline-dialog-stages li.returning { border-left-color: #356c85; }.timeline-dialog-stages li.landing { border-left-color: #7a6b4e; }.timeline-dialog-stages li.available_again { border-left-color: #697973; }.timeline-dialog-stages > li > i { display: grid; width: 22px; height: 22px; place-items: center; color: #fff; background: #39765d; font-size: 10px; font-style: normal; }.timeline-dialog-stages li div { display: grid; gap: 3px; }.timeline-dialog-stages strong { font-size: 11px; }.timeline-dialog-stages time { color: #6f8279; font-size: 11px; }
.aircraft-pool { grid-row: 2; }
.aircraft-timeline { grid-column: 2; }
.timeline-body { padding: 3px 9px; }
.timeline-lane { min-height: 28px; }
.dispatch-table { overflow-x: auto; }
.aircraft-timeline header > .timeline-scale { display: flex; align-items: center; justify-content: space-between; }
.timeline-legend i,.timeline-dialog-legend i { width: 24px; height: 6px; flex: 0 0 24px; }
/* Keep the merged outbound stage and the service stage visually distinct in both legends and detail rows. */
.timeline-legend i.outbound,.timeline-dialog-legend i.outbound { background: #287052; }.timeline-flight-stages li.outbound,.timeline-dialog-stages li.outbound { border-color: #287052; }
.timeline-legend i.arrival_confirmation,.timeline-dialog-legend i.arrival_confirmation { background: #b66f2f; }.timeline-flight-stages li.arrival_confirmation,.timeline-dialog-stages li.arrival_confirmation { border-color: #b66f2f; }
.timeline-legend i.arrival_service,.timeline-dialog-legend i.arrival_service { background: #c38b2d; }.timeline-flight-stages li.arrival_service,.timeline-dialog-stages li.arrival_service { border-color: #c38b2d; }
.aircraft-timeline > header > div:first-child { min-width: 0; }
.aircraft-timeline > header > div:first-child > .timeline-summary { display: block; overflow: hidden; margin-top: 2px; color: #71837c; font-size: 11px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.aircraft-timeline > header { min-width: 720px; overflow-x: auto; }
.aircraft-timeline > header > div { min-width: 0; }
.timeline-body { overflow-x: auto; overflow-y: auto; }
.timeline-body > .timeline-lane { min-width: 720px; }
.timeline-flight-stages ol { grid-template-columns: repeat(6,minmax(88px,1fr)); min-width: 540px; }
.order-row > header { grid-template-columns: 62px minmax(0,1fr) auto auto; }
.order-row > header > i { color: #176446; font-size: 11px; font-weight: 900; }
.order-pool { grid-template-rows: 48px auto minmax(120px,1fr) auto auto; }
.aircraft-pool { grid-template-rows: 48px auto minmax(120px,1fr); }
.order-pool > .schedule-check-panel { min-height: 0; overflow: hidden; border-right: 0; }
.order-pool > .schedule-check-panel .schedule-evidence { max-height: 76px; }
.scheduling-workspace { grid-template-rows: 62px minmax(300px,1fr) 205px; }
.aircraft-timeline,.schedule-versions { height: 205px; }
.aircraft-timeline { min-width: 0; overflow-x: auto; overflow-y: hidden; }
.timeline-body { min-width: 0; width: 100%; }
.order-pool > .schedule-check-panel { height: 205px; box-sizing: border-box; }
@media (max-width: 1180px) { .scheduling-workspace { grid-template-columns: 224px minmax(380px,1fr) 230px; }.scheduling-commandbar { gap: 8px; }.scheduling-commandbar dl { display: none; } }
@media (max-width: 860px) { .scheduling-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: auto 420px auto auto auto auto; overflow: auto; }.scheduling-commandbar { position: sticky; z-index: 5; top: 0; grid-column: 1; grid-row: 1; grid-template-columns: minmax(0,1fr) auto; }.scheduling-commandbar > em { display: none; }.scheduling-actions { grid-column: 1 / 3; overflow-x: auto; }.order-pool { grid-column: 1; grid-row: 3; min-height: 620px; border-right: 0; }.scheduling-map { grid-column: 1; grid-row: 2; }.aircraft-pool { grid-column: 1; grid-row: 4; min-height: 430px; border-left: 0; }.aircraft-timeline { grid-column: 1; grid-row: 5; min-height: 260px; height: 260px; overflow-x: auto; }.aircraft-timeline > header,.timeline-body,.timeline-flight-stages { min-width: 660px; }.timeline-flight-stages { overflow: visible; }.schedule-versions { grid-column: 1; grid-row: 6; min-height: 180px; height: 180px; border-left: 0; }.order-pool > .schedule-check-panel { height: 260px; }.batch-group-selection > div,.batch-adjustment-fields > div { grid-template-columns: 1fr; }.batch-group-selection p { display: grid; } }
/* The shell keeps its stage rail and inspector beside the main area until
   760px. Stack scheduling surfaces earlier so the three fixed panes cannot
   force the map below a usable width in the 760–1080px range. */
@media (max-width: 1080px) {
  .scheduling-workspace { grid-column: 2 / 4; grid-row: 2 / 4; grid-template-columns: 1fr; grid-template-rows: auto 360px auto auto auto auto; overflow: auto; }
  .scheduling-commandbar { position: sticky; z-index: 5; top: 0; grid-column: 1; grid-row: 1; grid-template-columns: minmax(0,1fr) auto; }
  .scheduling-commandbar > em { display: none; }
  .scheduling-actions { grid-column: 1 / 3; overflow-x: auto; }
  .order-pool { grid-column: 1; grid-row: 3; min-height: 620px; border-right: 0; }
  .scheduling-map { grid-column: 1; grid-row: 2; }
  .aircraft-pool { grid-column: 1; grid-row: 4; min-height: 430px; border-left: 0; }
  .aircraft-timeline { grid-column: 1; grid-row: 5; min-height: 260px; height: 260px; overflow-x: auto; }
  .aircraft-timeline > header,.timeline-body,.timeline-flight-stages { min-width: 660px; }
  .timeline-flight-stages { overflow: visible; }
  .schedule-versions { grid-column: 1; grid-row: 6; min-height: 180px; height: 180px; border-left: 0; }
  .order-pool > .schedule-check-panel { height: 260px; }
  .batch-group-selection > div,.batch-adjustment-fields > div { grid-template-columns: 1fr; }
  .batch-group-selection p { display: grid; }
}
@media (max-width: 760px) {
  .scheduling-workspace { grid-column: 1; grid-row: 3 / 5; }
}
</style>
