<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { ArrowRight, Bell, CircleCheck, Refresh, RefreshLeft, Search, Warning } from "@element-plus/icons-vue"
import { stageDefinitionsFor, type SceneType, type V3AlertSeverity, type V3RuntimeAlertView, type V3TeacherAlertFollowUpStatus, type V3TeacherProgressItem, type V3TeacherProgressPage, type V3TeachingOverview } from "@wurenji/shared"
import { api } from "../api"
import { countTeacherProgressFilters, filterStalledTeacherProgress, filterTeacherProgressAlerts, sortTeacherProgress, teacherAlertStatusSummary, teacherProgressMilestoneClass, teacherProgressStallLabel, type TeacherProgressSort } from "../teacher-progress"
import { v3SceneClass, v3SceneShortLabel } from "../scene-presentation"
import { assessmentRemainingMs, assessmentServerOffsetMs, assessmentTimingLabel } from "../assessment-timing"
import { assessmentAttemptLabel, assessmentRetakeDefaultWindow } from "../assessment-retake"
import { teacherAssignmentDataLabel, teacherProgressTitle } from "../teacher-assignment-presentation"
import { formatPlatformDate } from "../platform-date"
import { runtimeAlertTiming } from "../runtime-alert-presentation"
import { processTeacherAlertBatches, TeacherAlertBatchError } from "../teacher-alert-batching"

const props = defineProps<{
  initialAlertState?: "" | "OPEN"
  initialSubmissionState?: "" | "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED"
  initialEvaluationState?: "" | "NOT_STARTED" | "PENDING" | "PUBLISHED"
  teachingOverview?: V3TeachingOverview | null
}>()
const emit = defineEmits<{ project: [projectId: string, alertId?: string] }>()
const loading = ref(false)
const items = ref<V3TeacherProgressItem[]>([])
const progressPage = ref(0)
const progressTotal = ref(0)
const progressHasNext = ref(false)
const errorText = ref("")
const sceneType = ref<SceneType | "">("")
const classroomId = ref("")
const stageCode = ref("")
const submissionState = ref<"" | "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED">(props.initialSubmissionState ?? "")
const alertState = ref<"" | "NONE" | "OPEN">(props.initialAlertState ?? "")
const alertSeverity = ref<V3AlertSeverity | "">("")
const followUpStatus = ref<V3TeacherAlertFollowUpStatus | "">("")
const evaluationState = ref<"" | "NOT_STARTED" | "PENDING" | "PUBLISHED">(props.initialEvaluationState ?? "")
const focusState = ref<"" | "NOT_STARTED" | "PLANNING" | "CHECK_FAILED" | "RUNNING" | "SEVERE_ALERT" | "PENDING_EVALUATION">("")
const progressSort = ref<TeacherProgressSort>("RECENT_ACTIVITY")
const stalledOnly = ref(false)
const includeInternalData = ref(false)
const keyword = ref("")
const clockNowMs = ref(Date.now())
const serverOffsetMs = ref(0)
const retakeDialogVisible = ref(false)
const retakeSubmitting = ref(false)
const retakeSource = ref<V3TeacherProgressItem | null>(null)
const retakeForm = ref({ reason: "", availableAt: new Date(), dueAt: new Date() })
const alertDrawerVisible = ref(false)
const selectedAlertProject = ref<V3TeacherProgressItem | null>(null)
const selectedAlertId = ref("")
const selectedAlertIds = ref<string[]>([])
const followUpNote = ref("")
const followUpSubmitting = ref(false)
const selectingAllMatching = ref(false)
const followUpProgress = ref("")
const loadingMore = ref(false)
const focusOptions = [
  { value: "NOT_STARTED", label: "未开始" },
  { value: "PLANNING", label: "规划中" },
  { value: "CHECK_FAILED", label: "检查失败" },
  { value: "RUNNING", label: "运行中" },
  { value: "SEVERE_ALERT", label: "严重告警" },
  { value: "PENDING_EVALUATION", label: "待评价" }
] as const
let clockTimer: number | undefined
let keywordTimer: number | undefined
let progressAbortController: AbortController | undefined
let matchingSelectionAbortController: AbortController | undefined
let loadSequence = 0
let matchingSelectionSequence = 0

const stageOptions = computed(() => sceneType.value
  ? stageDefinitionsFor(sceneType.value)
  : [...stageDefinitionsFor("CITY_SHOW"), ...stageDefinitionsFor("CITY_LOGISTICS"), ...stageDefinitionsFor("VTOL_INSPECTION")])
const classroomOptions = computed(() => {
  const options = new Map<string, string>()
  for (const assignment of props.teachingOverview?.assignments ?? []) {
    for (const classroom of assignment.targetClassrooms ?? []) options.set(classroom.id, `${classroom.name} · ${classroom.code}`)
  }
  return [...options.entries()].map(([id, label]) => ({ id, label })).sort((left, right) => left.label.localeCompare(right.label, "zh-CN"))
})
const activeFilterCount = computed(() => countTeacherProgressFilters({
  keyword: keyword.value,
  sceneType: sceneType.value,
  stageCode: stageCode.value,
  classroomId: classroomId.value,
  submissionState: submissionState.value,
  alertState: alertState.value,
  alertSeverity: alertSeverity.value,
  followUpStatus: followUpStatus.value,
  evaluationState: evaluationState.value,
  focusState: focusState.value,
  stalledOnly: stalledOnly.value,
  includeInternalData: includeInternalData.value
}))
const filteredItems = computed(() => {
  const normalizedKeyword = keyword.value.trim().toLocaleLowerCase("zh-CN")
  const matched = !normalizedKeyword
    ? items.value
    : items.value.filter((item) => `${item.studentName} ${teacherProgressTitle(item)}`.toLocaleLowerCase("zh-CN").includes(normalizedKeyword))
  const alertFiltered = filterTeacherProgressAlerts(matched, alertSeverity.value, followUpStatus.value)
  const classroomAssignments = classroomId.value
    ? new Set((props.teachingOverview?.assignments ?? []).filter((assignment) => (assignment.targetClassrooms ?? []).some((classroom) => classroom.id === classroomId.value)).map((assignment) => assignment.id))
    : null
  const classroomFiltered = classroomAssignments ? alertFiltered.filter((item) => classroomAssignments.has(item.assignmentId)) : alertFiltered
  const stalledFiltered = stalledOnly.value ? filterStalledTeacherProgress(classroomFiltered, clockNowMs.value) : classroomFiltered
  return sortTeacherProgress(stalledFiltered, progressSort.value)
})
const progressSortHint = computed(() => ({
  RECENT_ACTIVITY: "最近有动作的项目优先",
  STALLED: "进行中且较久未活动的项目优先",
  RISK: "开放告警和阶段风险优先",
  EVALUATION: "已提交且待评价的项目优先"
} as Record<TeacherProgressSort, string>)[progressSort.value])
const selectedAlert = computed(() => selectedAlertProject.value?.alerts.find((alert) => alert.id === selectedAlertId.value) ?? selectedAlertProject.value?.alerts[0] ?? null)
const alertSummary = computed(() => teacherAlertStatusSummary(filteredItems.value))
const alertQueueCount = computed(() => alertSummary.value.total)
const alertProjectCount = computed(() => filteredItems.value.filter((item) => item.alerts.length > 0).length)
const visibleAlertIds = computed(() => filteredItems.value.flatMap((item) => item.alerts.map((alert) => alert.id)))
const selectedAlertLimitExceeded = computed(() => selectedAlertIds.value.length > 100)
const selectedAlertBatchCount = computed(() => Math.max(1, Math.ceil(selectedAlertIds.value.length / 100)))

onMounted(() => {
  void loadProgress()
  clockTimer = window.setInterval(() => { clockNowMs.value = Date.now() }, 1_000)
})
onBeforeUnmount(() => {
  if (clockTimer !== undefined) window.clearInterval(clockTimer)
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer)
  loadSequence += 1
  progressAbortController?.abort()
  matchingSelectionSequence += 1
  matchingSelectionAbortController?.abort()
})
watch(sceneType, () => {
  stageCode.value = ""
  void loadProgress()
})
watch(classroomOptions, (options) => {
  if (classroomId.value && !options.some((option) => option.id === classroomId.value)) classroomId.value = ""
})
watch(() => props.initialAlertState, (value) => {
  if (value !== undefined && value !== alertState.value) alertState.value = value
})
watch(() => props.initialSubmissionState, (value) => {
  if (value !== undefined && value !== submissionState.value) submissionState.value = value
})
watch(() => props.initialEvaluationState, (value) => {
  if (value !== undefined && value !== evaluationState.value) evaluationState.value = value
})
watch([stageCode, submissionState, alertState, alertSeverity, followUpStatus, stalledOnly, evaluationState, focusState], () => void loadProgress())
watch(classroomId, () => void loadProgress())
watch(includeInternalData, () => void loadProgress())
watch(keyword, () => {
  if (keywordTimer !== undefined) window.clearTimeout(keywordTimer)
  keywordTimer = window.setTimeout(() => void loadProgress(), 250)
})

async function loadProgress() {
  const currentSequence = ++loadSequence
  progressAbortController?.abort()
  matchingSelectionSequence += 1
  matchingSelectionAbortController?.abort()
  const abortController = new AbortController()
  progressAbortController = abortController
  loading.value = true
  loadingMore.value = false
  selectedAlertIds.value = []
  errorText.value = ""
  try {
    const query = progressQuery(1)
    const value = await api<V3TeacherProgressPage>(`/v3/teaching/progress?${query}`, { signal: abortController.signal })
    if (currentSequence !== loadSequence) return
    items.value = value.items
    progressPage.value = value.page
    progressTotal.value = value.total
    progressHasNext.value = value.hasNext
    if (value.items[0]) serverOffsetMs.value = assessmentServerOffsetMs(value.items[0].assessmentTiming)
    clockNowMs.value = Date.now()
  } catch (error) {
    if (currentSequence !== loadSequence) return
    errorText.value = error instanceof Error ? error.message : "学生进度加载失败"
    ElMessage.error(errorText.value)
  } finally {
    if (currentSequence === loadSequence) loading.value = false
  }
}

async function loadMoreProgress() {
  if (!progressHasNext.value || loadingMore.value) return
  const currentSequence = ++loadSequence
  progressAbortController?.abort()
  const abortController = new AbortController()
  progressAbortController = abortController
  loadingMore.value = true
  errorText.value = ""
  try {
    const query = progressQuery(progressPage.value + 1)
    const value = await api<V3TeacherProgressPage>(`/v3/teaching/progress?${query}`, { signal: abortController.signal })
    if (currentSequence !== loadSequence) return
    items.value = [...items.value, ...value.items]
    progressPage.value = value.page
    progressTotal.value = value.total
    progressHasNext.value = value.hasNext
  } catch (error) {
    if (currentSequence !== loadSequence) return
    errorText.value = error instanceof Error ? error.message : "更多学生进度加载失败"
    ElMessage.error(errorText.value)
  } finally {
    if (currentSequence === loadSequence) loadingMore.value = false
  }
}

function progressQuery(page?: number) {
  const query = new URLSearchParams()
  if (page !== undefined) {
    query.set("page", String(page))
    query.set("pageSize", "50")
  }
  if (sceneType.value) query.set("sceneType", sceneType.value)
  if (stageCode.value) query.set("stageCode", stageCode.value)
  if (submissionState.value) query.set("submissionState", submissionState.value)
  if (alertState.value) query.set("alertState", alertState.value)
  if (alertSeverity.value) query.set("alertSeverity", alertSeverity.value)
  if (followUpStatus.value) query.set("followUpStatus", followUpStatus.value)
  if (stalledOnly.value) query.set("stalledOnly", "true")
  if (evaluationState.value) query.set("evaluationState", evaluationState.value)
  if (focusState.value) query.set("focusState", focusState.value)
  if (classroomId.value) query.set("classroomId", classroomId.value)
  if (keyword.value.trim()) query.set("keyword", keyword.value.trim())
  if (includeInternalData.value) query.set("includeInternalData", "true")
  return query
}

function clearProgressFilters() {
  keyword.value = ""
  sceneType.value = ""
  stageCode.value = ""
  classroomId.value = ""
  submissionState.value = ""
  alertState.value = ""
  alertSeverity.value = ""
  followUpStatus.value = ""
  evaluationState.value = ""
  focusState.value = ""
  stalledOnly.value = false
  includeInternalData.value = false
}

function formatDate(value: string) {
  return formatPlatformDate(value)
}

function submissionLabel(value: string) {
  return value === "NOT_STARTED" ? "未开始" : value === "IN_PROGRESS" ? "进行中" : "已提交"
}

function evaluationLabel(value: string) {
  return value === "NOT_STARTED" ? "未进入" : value === "PENDING" ? "待评价" : "已发布"
}

function assessmentLabel(item: V3TeacherProgressItem) {
  return assessmentTimingLabel(item.assessmentTiming, assessmentRemainingMs(item.assessmentTiming, clockNowMs.value, serverOffsetMs.value))
}

function openAlertDrawer(item: V3TeacherProgressItem, alertId = item.alerts[0]?.id ?? "") {
  if (!item.alerts.length) return
  matchingSelectionSequence += 1
  matchingSelectionAbortController?.abort()
  selectingAllMatching.value = false
  selectedAlertProject.value = item
  selectedAlertId.value = alertId
  selectedAlertIds.value = []
  followUpNote.value = ""
  alertDrawerVisible.value = true
}

function selectAlert(alert: V3RuntimeAlertView) {
  selectedAlertId.value = alert.id
}

function toggleAlertSelection(alertId: string) {
  selectedAlertIds.value = selectedAlertIds.value.includes(alertId)
    ? selectedAlertIds.value.filter((id) => id !== alertId)
    : [...selectedAlertIds.value, alertId]
}

function selectAllProjectAlerts() {
  selectedAlertIds.value = selectedAlertProject.value?.alerts.map((alert) => alert.id) ?? []
}

function clearAlertSelection() {
  selectedAlertIds.value = []
  matchingSelectionSequence += 1
  matchingSelectionAbortController?.abort()
  selectingAllMatching.value = false
}

function toggleVisibleAlertSelection(alertId: string) {
  toggleAlertSelection(alertId)
}

function selectAllVisibleAlerts() {
  if (selectingAllMatching.value) return
  selectedAlertIds.value = [...new Set([...selectedAlertIds.value, ...visibleAlertIds.value])]
}

async function selectAllMatchingAlerts() {
  if (selectingAllMatching.value) return
  const currentSequence = ++matchingSelectionSequence
  matchingSelectionAbortController?.abort()
  const abortController = new AbortController()
  matchingSelectionAbortController = abortController
  selectingAllMatching.value = true
  try {
    const matchingProgress = await api<V3TeacherProgressItem[]>(`/v3/teaching/progress?${progressQuery()}`, { signal: abortController.signal })
    if (currentSequence !== matchingSelectionSequence) return
    const matchingAlertIds = [...new Set(matchingProgress.flatMap((item) => item.alerts.map((alert) => alert.id)))]
    selectedAlertIds.value = matchingAlertIds
    if (matchingAlertIds.length > 100) {
      ElMessage.warning(`已选中 ${matchingAlertIds.length} 条告警，将分 ${Math.ceil(matchingAlertIds.length / 100)} 批处理`)
    } else {
      ElMessage.success(`已选中当前筛选匹配的 ${matchingAlertIds.length} 条告警`)
    }
  } catch (error) {
    if (currentSequence !== matchingSelectionSequence || (error instanceof DOMException && error.name === "AbortError")) return
    ElMessage.error(error instanceof Error ? error.message : "匹配告警加载失败")
  } finally {
    if (currentSequence === matchingSelectionSequence) selectingAllMatching.value = false
  }
}

function teacherFollowUpLabel(status: NonNullable<V3RuntimeAlertView["teacherFollowUp"]>["status"]) {
  return status === "WATCHING" ? "教师关注中" : "教师已关闭关注"
}

function teacherFollowUpClass(status: NonNullable<V3RuntimeAlertView["teacherFollowUp"]>["status"]) {
  return status === "WATCHING" ? "watching" : "closed"
}

async function updateTeacherAlertFollowUp(status: "WATCHING" | "CLOSED") {
  if (selectingAllMatching.value) {
    ElMessage.info("正在加载匹配告警，请稍候")
    return
  }
  const alertIds = [...new Set(selectedAlertIds.value)]
  if (!alertIds.length) {
    ElMessage.warning("请先选择要处理的告警")
    return
  }
  if (alertIds.length > 100) {
    ElMessage.warning("单次最多处理 100 条告警，请减少选择")
    return
  }
  followUpSubmitting.value = true
  try {
    const note = followUpNote.value.trim()
    const selectedProjectBeforeUpdate = selectedAlertProject.value
    const selectedIds = new Set(alertIds)
    let updatedProgress: V3TeacherProgressItem[] = []
    try {
      const batchProgress = await processTeacherAlertBatches(alertIds, async (batch) => api<V3TeacherProgressItem[]>("/v3/teaching/alerts/follow-ups", {
        method: "PUT",
        body: JSON.stringify({ alertIds: batch, status, note })
      }), (batchIndex, batchCount, batchSize) => {
        followUpProgress.value = `正在处理第 ${batchIndex}/${batchCount} 批（${batchSize} 条）`
      })
      updatedProgress = batchProgress.flat()
    } catch (error) {
      if (error instanceof TeacherAlertBatchError) {
        selectedAlertIds.value = error.remainingIds
        const detail = error.cause instanceof Error ? error.cause.message : "服务端返回错误"
        throw new Error(`已处理 ${error.processedCount} 条，剩余 ${error.remainingIds.length} 条可重试：${detail}`)
      }
      throw error
    }
    ElMessage.success(status === "WATCHING" ? "已关注选中告警" : "已关闭选中告警的教师关注")
    selectedAlertIds.value = []
    followUpNote.value = ""
    const projectId = selectedAlertProject.value?.projectId
    await loadProgress()
    selectedAlertProject.value = items.value.find((item) => item.projectId === projectId)
      ?? updatedProgress.find((item) => item.projectId === projectId)
      ?? (selectedProjectBeforeUpdate
        ? {
            ...selectedProjectBeforeUpdate,
            alerts: selectedProjectBeforeUpdate.alerts.map((alert) => selectedIds.has(alert.id)
              ? { ...alert, teacherFollowUp: { status, note, updatedAt: new Date().toISOString() } }
              : alert)
          }
        : null)
      ?? null
    if (!selectedAlertProject.value?.alerts.length) alertDrawerVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "教师告警跟踪更新失败")
  } finally {
    followUpSubmitting.value = false
    followUpProgress.value = ""
  }
}

function openFocusedProject() {
  const project = selectedAlertProject.value
  const alert = selectedAlert.value
  if (!project || !alert) return
  alertDrawerVisible.value = false
  emit("project", project.projectId, alert.id)
}

function alertSeverityLabel(value: V3RuntimeAlertView["severity"]) {
  return ({ INFO: "提示", WARNING: "警告", ERROR: "错误", CRITICAL: "严重" } as Record<V3RuntimeAlertView["severity"], string>)[value]
}

function alertStatusLabel(value: V3RuntimeAlertView["status"]) {
  return ({ OPEN: "待处置", ACKNOWLEDGED: "已确认", RESOLVED: "已解决" } as Record<V3RuntimeAlertView["status"], string>)[value]
}

function alertActionBoundaryLabel(alert: V3RuntimeAlertView) {
  if (alert.status === "OPEN") return "学生尚未确认；进入项目工作区后由学生完成告警确认和应急处置。"
  if (alert.status === "ACKNOWLEDGED") return "学生已确认；后续动作仍由学生在仿真运行中完成，教师可进入工作区跟踪结果。"
  return "该告警已解决，教师可进入项目工作区查看处置证据。"
}

function alertTimeLabel(alert: V3RuntimeAlertView) {
  return alert.simulationTimeMs === null ? "未记录仿真时刻" : `T+${formatDuration(alert.simulationTimeMs)}`
}

function alertStageLabel(alert: V3RuntimeAlertView) {
  const scene = selectedAlertProject.value?.sceneType
  if (!scene) return alert.stageCode
  return stageDefinitionsFor(scene).find((stage) => stage.code === alert.stageCode)?.title ?? alert.stageCode
}

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function alertImpactLabel(alert: V3RuntimeAlertView) {
  const labels: string[] = []
  const payload = alert.payload ?? {}
  const values: Array<[string, string]> = [
    ["affectedAircraftIds", "架无人机"],
    ["affectedGroupIds", "个编队"],
    ["affectedOrderIds", "个订单"],
    ["affectedRouteIds", "条航线"]
  ]
  for (const [key, suffix] of values) {
    const value = payload[key]
    if (Array.isArray(value) && value.length > 0) labels.push(`${value.length}${suffix}`)
  }
  if (typeof payload.affectedCount === "number" && Number.isFinite(payload.affectedCount)) labels.push(`${payload.affectedCount}个对象`)
  return labels.length ? labels.join(" · ") : "全局运行影响"
}

function alertRecommendationLabel(alert: V3RuntimeAlertView) {
  const recommended = alert.payload?.recommendedActions
  const labels: Record<string, string> = {
    ACKNOWLEDGE_ALERT: "确认告警",
    PAUSE_NEXT_TAKEOFF: "暂停后续起飞",
    PAUSE_PROGRAM: "暂停表演程序",
    RETURN_ALL: "全部返航",
    EMERGENCY_LAND_ALL: "全部应急降落",
    HOLD_POSITION: "悬停等待",
    RETURN_AIRCRAFT: "返航",
    DIVERT_AIRCRAFT: "备降",
    EMERGENCY_LAND_AIRCRAFT: "应急迫降",
    REDUCE_SPEED: "降低速度",
    PAUSE_ROUTE: "暂停航线",
    PAUSE_ROUTE_ENTRY: "暂停新任务进入",
    REASSIGN_ORDER: "重新分配订单",
    HOLD: "保持等待"
  }
  if (!Array.isArray(recommended)) return "未提供推荐动作"
  const first = recommended.find((item): item is string => typeof item === "string")
  return first ? labels[first] ?? first : "未提供推荐动作"
}

function alertRuleDeadlineLabel(alert: V3RuntimeAlertView) {
  const timing = runtimeAlertTiming(alert, alert.simulationTimeMs ?? 0)
  return timing.deadlineAtSimulationTimeMs === null ? "未设置处置时限" : `规则截止 T+${formatDuration(timing.deadlineAtSimulationTimeMs)}`
}

function openRetakeDialog(item: V3TeacherProgressItem) {
  const window = assessmentRetakeDefaultWindow(item.assessmentTiming)
  retakeSource.value = item
  retakeForm.value = { reason: "", ...window }
  retakeDialogVisible.value = true
}

async function createAssessmentRetake() {
  const source = retakeSource.value
  const reason = retakeForm.value.reason.trim()
  if (!source) return
  if (!reason) {
    ElMessage.warning("请填写补考原因")
    return
  }
  if (reason.length > 500) {
    ElMessage.warning("补考原因不能超过 500 个字符")
    return
  }
  if (!(retakeForm.value.availableAt instanceof Date) || !(retakeForm.value.dueAt instanceof Date) || retakeForm.value.dueAt.getTime() <= retakeForm.value.availableAt.getTime()) {
    ElMessage.warning("补考截止时间必须晚于开放时间")
    return
  }
  retakeSubmitting.value = true
  try {
    await api(`/v3/projects/${source.projectId}/assessment-retakes`, {
      method: "POST",
      body: JSON.stringify({
        reason,
        availableAt: retakeForm.value.availableAt.toISOString(),
        dueAt: retakeForm.value.dueAt.toISOString()
      })
    })
    ElMessage.success(`${source.studentName} 的新补考项目已创建`)
    retakeDialogVisible.value = false
    await loadProgress()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "补考项目创建失败")
  } finally {
    retakeSubmitting.value = false
  }
}

</script>

<template>
  <div class="education-page progress-page" v-loading="loading">
    <header class="page-heading">
      <div><span>教学运行</span><h1>{{ alertState === 'OPEN' ? '告警队列' : '学生进度' }}</h1><small v-if="alertState === 'OPEN'" class="progress-focus-note">仅显示存在开放告警的学生项目</small></div>
      <el-button :icon="Refresh" :loading="loading" :disabled="loading" @click="loadProgress">刷新</el-button>
    </header>
    <div v-if="errorText" class="progress-error" role="alert"><strong>学生进度同步失败</strong><span>{{ errorText }}，当前仍保留上一次成功加载的数据。</span><el-button text :icon="Refresh" :loading="loading" :disabled="loading" @click="loadProgress">重新加载</el-button></div>

    <section class="progress-filter-band">
      <el-input v-model="keyword" :prefix-icon="Search" placeholder="搜索学生或任务" aria-label="搜索学生或任务" clearable />
      <nav class="progress-focus-filters" aria-label="教学状态快捷筛选">
        <button v-for="option in focusOptions" :key="option.value" type="button" :class="{ active: focusState === option.value }" :aria-pressed="focusState === option.value" @click="focusState = focusState === option.value ? '' : option.value">{{ option.label }}</button>
      </nav>
      <el-select v-model="sceneType" placeholder="全部场景" aria-label="按场景筛选" clearable><el-option label="城市编队表演" value="CITY_SHOW" /><el-option label="城市低空物流" value="CITY_LOGISTICS" /><el-option label="垂起广域巡检" value="VTOL_INSPECTION" /></el-select>
      <el-select v-model="stageCode" placeholder="全部阶段" aria-label="按当前阶段筛选" clearable><el-option v-for="stage in stageOptions" :key="stage.code" :label="stage.title" :value="stage.code" /></el-select>
      <el-select v-if="classroomOptions.length" v-model="classroomId" placeholder="全部班级" clearable aria-label="按班级筛选学生进度"><el-option v-for="classroom in classroomOptions" :key="classroom.id" :label="classroom.label" :value="classroom.id" /></el-select>
      <el-select v-model="submissionState" placeholder="提交状态" aria-label="按提交状态筛选" clearable><el-option label="未开始" value="NOT_STARTED" /><el-option label="进行中" value="IN_PROGRESS" /><el-option label="已提交" value="SUBMITTED" /></el-select>
      <el-select v-model="alertState" placeholder="告警状态" aria-label="按告警状态筛选" clearable><el-option label="无开放告警" value="NONE" /><el-option label="存在开放告警" value="OPEN" /></el-select>
      <el-select v-model="alertSeverity" placeholder="告警等级" aria-label="按告警等级筛选" clearable><el-option label="提示" value="INFO" /><el-option label="警告" value="WARNING" /><el-option label="错误" value="ERROR" /><el-option label="严重" value="CRITICAL" /></el-select>
      <el-select v-model="followUpStatus" placeholder="教师跟踪状态" aria-label="按教师跟踪状态筛选" clearable><el-option label="教师关注中" value="WATCHING" /><el-option label="教师已关闭关注" value="CLOSED" /></el-select>
      <el-select v-model="evaluationState" placeholder="评价状态" aria-label="按评价状态筛选" clearable><el-option label="未进入评价" value="NOT_STARTED" /><el-option label="待评价" value="PENDING" /><el-option label="结果已发布" value="PUBLISHED" /></el-select>
      <el-select v-model="progressSort" placeholder="排序方式" aria-label="学生进度排序方式"><el-option label="最近活动" value="RECENT_ACTIVITY" /><el-option label="阶段停滞" value="STALLED" /><el-option label="存在风险" value="RISK" /><el-option label="待评价优先" value="EVALUATION" /></el-select>
      <el-checkbox v-model="stalledOnly" aria-label="只显示已停滞项目">只看已停滞</el-checkbox>
      <el-checkbox v-model="includeInternalData">包含演示/验收数据</el-checkbox>
      <el-button v-if="activeFilterCount" class="progress-clear-filters" text :icon="RefreshLeft" @click="clearProgressFilters">清除筛选（{{ activeFilterCount }}）</el-button>
    </section>

    <section v-if="alertState === 'OPEN'" class="teacher-alert-overview">
      <div class="teacher-alert-overview-icon"><el-icon><Bell /></el-icon></div>
      <div><strong>{{ alertSummary.open }} 条待确认 · {{ alertSummary.acknowledged }} 条已确认 · 共 {{ alertQueueCount }} 条活动告警</strong><span>分布在 {{ alertProjectCount }} 个学生项目中；教师可定位和跟踪，不能代替学生完成应急处置。</span></div>
      <el-button :icon="Refresh" text :loading="loading" :disabled="loading" @click="loadProgress">刷新告警</el-button>
    </section>

    <section v-if="alertState === 'OPEN' && visibleAlertIds.length" class="teacher-alert-global-toolbar">
      <div><strong>告警批量跟踪</strong><span>已选 {{ selectedAlertIds.length }} 条 · 当前已加载 {{ visibleAlertIds.length }} 条</span><small class="progress-selection-scope">刷新或更改筛选会清空选择；可选择当前页或全部匹配结果</small><em v-if="selectedAlertLimitExceeded" class="progress-selection-warning">将分 {{ selectedAlertBatchCount }} 批处理</em><em v-if="followUpProgress" class="progress-selection-warning">{{ followUpProgress }}</em></div>
      <el-input v-model="followUpNote" size="small" maxlength="1000" placeholder="可选批量备注" />
      <div><el-button text size="small" :disabled="selectingAllMatching" @click="selectAllVisibleAlerts">全选已加载</el-button><el-button text size="small" :loading="selectingAllMatching" @click="selectAllMatchingAlerts">全选匹配告警</el-button><el-button text size="small" @click="clearAlertSelection">清空选择</el-button><el-button :loading="followUpSubmitting" :disabled="!selectedAlertIds.length || selectingAllMatching" size="small" @click="updateTeacherAlertFollowUp('CLOSED')">{{ selectedAlertBatchCount > 1 ? '分批关闭关注' : '关闭关注' }}</el-button><el-button type="primary" :loading="followUpSubmitting" :disabled="!selectedAlertIds.length || selectingAllMatching" size="small" @click="updateTeacherAlertFollowUp('WATCHING')">{{ selectedAlertBatchCount > 1 ? '分批关注' : '关注选中告警' }}</el-button></div>
    </section>

    <section class="progress-table-section">
      <header><div><h2>项目进度明细</h2><p>当前筛选结果 {{ filteredItems.length }} 条 · 已加载 {{ items.length }} / {{ progressTotal }} 条 · {{ progressSortHint }}</p></div></header>
      <div class="progress-table-head"><span>学生</span><span>任务与阶段</span><span>业务进度</span><span>教学状态</span><span>最近活动</span><span>操作</span></div>
      <div v-for="item in filteredItems" :key="item.projectId" class="progress-table-row" role="link" tabindex="0" :aria-label="`打开${item.studentName}的${teacherProgressTitle(item)}，当前阶段${item.currentStageTitle}`" @click="emit('project', item.projectId)" @keydown.enter.self="emit('project', item.projectId)" @keydown.space.self.prevent="emit('project', item.projectId)">
        <span class="student-cell"><strong>{{ item.studentName }}</strong><small>{{ item.mode === 'TRAINING' ? '训练模式' : `考核模式 · ${assessmentAttemptLabel(item.assessmentAttempt)}` }}</small></span>
        <span class="task-stage-cell"><span class="task-cell"><i :class="v3SceneClass(item.sceneType)">{{ v3SceneShortLabel(item.sceneType) }}</i><span class="task-title-line"><strong>{{ teacherProgressTitle(item) }}</strong><em v-if="item.isDemo || item.isAcceptanceData" class="data-classification-tag">{{ teacherAssignmentDataLabel(item) }}</em></span></span><small>{{ item.currentStageTitle }}</small></span>
        <span class="milestone-strip">
          <span v-for="milestone in item.milestones" :key="milestone.code" :class="teacherProgressMilestoneClass(milestone.state)"><small>{{ milestone.label }}</small><strong>{{ milestone.detail }}</strong></span>
        </span>
        <span class="teaching-state-cell"><span v-if="item.alerts.length" class="progress-alert-actions"><input v-for="alert in item.alerts" :key="alert.id" type="checkbox" :checked="selectedAlertIds.includes(alert.id)" :aria-label="`选择${item.studentName}的${alert.title}`" @click.stop="toggleVisibleAlertSelection(alert.id)" /><button class="progress-alert-link" type="button" @click.stop="openAlertDrawer(item)"><el-icon><Warning /></el-icon><strong>{{ item.alerts.length }} 条告警</strong></button></span><em v-else class="neutral">无告警</em><small>{{ submissionLabel(item.submissionState) }} · {{ evaluationLabel(item.evaluationState) }}</small><strong v-if="item.mode === 'ASSESSMENT'" class="progress-assessment-time" :class="item.assessmentTiming.state.toLowerCase()">{{ assessmentLabel(item) }}</strong></span>
        <span class="progress-last-activity"><strong>{{ formatDate(item.lastActivityAt) }}</strong><em v-if="teacherProgressStallLabel(item, clockNowMs)" class="progress-stall-label">{{ teacherProgressStallLabel(item, clockNowMs) }}</em></span>
        <div class="progress-row-actions"><el-button v-if="item.canCreateAssessmentRetake" text :icon="RefreshLeft" @click.stop="openRetakeDialog(item)">补考</el-button><el-icon><ArrowRight /></el-icon></div>
      </div>
      <div v-if="filteredItems.length === 0" class="section-empty" role="status" aria-live="polite"><strong>没有符合条件的学生项目</strong><span v-if="stalledOnly">当前没有超过 30 分钟未活动的进行中项目。</span><span v-else-if="includeInternalData">当前范围没有可查看项目，请检查班级、任务发布状态或筛选条件。</span><span v-else>正式教学数据为空；演示/验收数据默认隐藏。</span><el-button v-if="stalledOnly" type="button" text @click="stalledOnly = false">显示全部项目</el-button><el-button v-else-if="!includeInternalData" type="button" text @click="includeInternalData = true">查看演示/验收数据</el-button><el-button v-if="activeFilterCount" type="button" text :icon="RefreshLeft" @click="clearProgressFilters">清除全部筛选（{{ activeFilterCount }}）</el-button><span v-if="includeInternalData && !stalledOnly">也可以发布新的 V3 实训任务后再查看学生进度。</span></div>
      <div v-if="filteredItems.length && progressHasNext" class="progress-load-more"><el-button :loading="loadingMore" :disabled="loadingMore" @click="loadMoreProgress">加载更多（还剩 {{ Math.max(progressTotal - items.length, 0) }} 条）</el-button></div>
    </section>

    <el-drawer v-model="alertDrawerVisible" title="告警详情" size="min(520px, 100%)" append-to-body>
      <div v-if="selectedAlertProject && selectedAlert" class="teacher-alert-drawer">
        <header class="teacher-alert-drawer-heading"><div><span>TEACHING ALERT</span><strong>{{ selectedAlertProject.studentName }} · {{ teacherProgressTitle(selectedAlertProject) }}</strong><small>{{ selectedAlertProject.currentStageTitle }}</small></div><em :class="selectedAlert.severity.toLowerCase()">{{ alertSeverityLabel(selectedAlert.severity) }}</em></header>
        <div class="teacher-alert-batch-toolbar"><div><strong>教师跟踪</strong><span>已选 {{ selectedAlertIds.length }} 条</span></div><div><el-button text size="small" @click="selectAllProjectAlerts">全选</el-button><el-button text size="small" @click="clearAlertSelection">清空</el-button></div></div>
        <nav class="teacher-alert-picker" aria-label="项目告警列表"><div v-for="alert in selectedAlertProject.alerts" :key="alert.id" class="teacher-alert-picker-item"><input type="checkbox" :checked="selectedAlertIds.includes(alert.id)" :aria-label="`选择${alert.title}`" @change="toggleAlertSelection(alert.id)" /><button type="button" :class="{ active: alert.id === selectedAlert.id }" :aria-label="`查看${alert.title}`" @click="selectAlert(alert)"><span><i :class="alert.severity.toLowerCase()" /><strong>{{ alert.title }}</strong></span><small>{{ alertTimeLabel(alert) }} · {{ alertStatusLabel(alert.status) }}<template v-if="alert.teacherFollowUp"> · </template><em v-if="alert.teacherFollowUp" class="teacher-follow-up-tag" :class="teacherFollowUpClass(alert.teacherFollowUp.status)">{{ teacherFollowUpLabel(alert.teacherFollowUp.status) }}</em></small></button></div></nav>
        <article class="teacher-alert-detail"><div class="teacher-alert-detail-title"><el-icon><Warning /></el-icon><div><strong>{{ selectedAlert.title }}</strong><small>{{ selectedAlert.code }} · {{ alertStatusLabel(selectedAlert.status) }}<template v-if="selectedAlert.teacherFollowUp"> · </template><em v-if="selectedAlert.teacherFollowUp" class="teacher-follow-up-tag" :class="teacherFollowUpClass(selectedAlert.teacherFollowUp.status)">{{ teacherFollowUpLabel(selectedAlert.teacherFollowUp.status) }}</em></small></div></div><p>{{ selectedAlert.detail }}</p><dl><div><dt>发生时刻</dt><dd>{{ alertTimeLabel(selectedAlert) }}</dd></div><div><dt>发生阶段</dt><dd>{{ alertStageLabel(selectedAlert) }}</dd></div><div><dt>影响范围</dt><dd>{{ alertImpactLabel(selectedAlert) }}</dd></div><div><dt>记录时间</dt><dd>{{ formatDate(selectedAlert.openedAt) }}</dd></div><div><dt>推荐动作</dt><dd>{{ alertRecommendationLabel(selectedAlert) }}</dd></div><div><dt>处置规则</dt><dd>{{ alertRuleDeadlineLabel(selectedAlert) }}</dd></div><div v-if="selectedAlert.teacherFollowUp"><dt>教师备注</dt><dd>{{ selectedAlert.teacherFollowUp.note || '未填写备注' }}<small> · 更新于 {{ formatDate(selectedAlert.teacherFollowUp.updatedAt) }}</small></dd></div></dl></article>
        <div class="teacher-alert-follow-up-form"><el-input v-model="followUpNote" type="textarea" :rows="2" maxlength="1000" show-word-limit placeholder="可选：记录本次教学跟踪备注" /><div><el-button :loading="followUpSubmitting" :disabled="!selectedAlertIds.length" @click="updateTeacherAlertFollowUp('CLOSED')">{{ selectedAlertBatchCount > 1 ? '分批关闭关注' : '关闭关注' }}</el-button><el-button type="primary" :loading="followUpSubmitting" :disabled="!selectedAlertIds.length" @click="updateTeacherAlertFollowUp('WATCHING')">{{ selectedAlertBatchCount > 1 ? '分批关注' : '关注选中告警' }}</el-button></div><small v-if="selectedAlertLimitExceeded" class="progress-selection-warning">将分 {{ selectedAlertBatchCount }} 批处理。</small><small v-if="followUpProgress" class="progress-selection-warning">{{ followUpProgress }}</small></div>
        <div class="teacher-alert-drawer-actions"><el-button type="primary" :icon="ArrowRight" @click="openFocusedProject">进入项目工作区</el-button><span>进入后将自动选择对应运行阶段和告警对象。</span><small class="teacher-alert-boundary-note">{{ alertActionBoundaryLabel(selectedAlert) }}</small></div>
      </div>
      <div v-else class="section-empty"><el-icon><CircleCheck /></el-icon><strong>告警已更新</strong><span>当前项目没有可查看的活动告警。</span></div>
    </el-drawer>

    <el-dialog v-model="retakeDialogVisible" title="创建补考项目" width="480px" :close-on-click-modal="false">
      <el-form label-position="top">
        <el-form-item label="学生与考核"><el-input :model-value="retakeSource ? `${retakeSource.studentName} · ${teacherProgressTitle(retakeSource)} · ${assessmentAttemptLabel(retakeSource.assessmentAttempt)}` : ''" disabled /></el-form-item>
        <div class="retake-time-grid">
          <el-form-item label="开放时间"><el-date-picker v-model="retakeForm.availableAt" type="datetime" /></el-form-item>
          <el-form-item label="截止时间"><el-date-picker v-model="retakeForm.dueAt" type="datetime" /></el-form-item>
        </div>
        <el-form-item label="补考原因"><el-input v-model="retakeForm.reason" type="textarea" :rows="4" maxlength="500" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="retakeDialogVisible = false">取消</el-button><el-button type="primary" :loading="retakeSubmitting" @click="createAssessmentRetake">创建补考</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.progress-focus-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; grid-column: 1 / -1; }
.progress-focus-filters button { border: 1px solid #cbd8d1; padding: 6px 9px; color: #526f62; font: inherit; font-size: 11px; background: #fff; cursor: pointer; }
.progress-focus-filters button.active { border-color: #247354; color: #fff; background: #247354; }
</style>
