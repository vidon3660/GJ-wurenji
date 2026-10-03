<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { ArrowLeft, Clock, Connection, DocumentChecked, InfoFilled, MapLocation, OfficeBuilding, Position, Refresh, Sunny, VideoPlay, Warning } from "@element-plus/icons-vue"
import {
  displayTeachingAssignmentTitle,
  type AssignmentSnapshotView,
  AuthUser,
  type QuestionnaireView,
  StudentProjectStageView,
  StudentProjectView,
  V3ActivityEventView,
  V3RegionCatalogItem,
  V3RegionLayerCode,
  V3RuntimeAlertView
} from "@wurenji/shared"
import { api } from "../api"
import { logisticsTaskSummary } from "../logistics-task-summary"
import { initialV3MapDataState, v3MapLoadingLabel, type V3MapDataState } from "../map-loading-state"
import { projectActivityLabel, projectActivitySummary } from "../project-activity"
import { showTaskInitialConditionsSummary } from "../show-task-summary"
import { sceneRoleProfile } from "../scene-role-profile"
import { regionTerrainStateLabel } from "../terrain"
import { resolveStageSelectionAfterRefresh } from "../project-stage-selection"
import { shouldShowVtlPlanningWorkspace } from "../vtl-stage-presentation"
import { isSimulationStage, projectSimulationStage, simulationEntryCondition, simulationEntryStatus } from "../simulation-entry"
import { studentStageNextAction, studentProjectNextAction, studentProjectTitle, studentStageOpenConditionLabel, studentStagePrimaryAction, studentStagePrimaryActionLabel, studentStageStatusLabel } from "../student-task-presentation"
import { assessmentRemainingMs, assessmentServerOffsetMs, assessmentTimingLabel } from "../assessment-timing"
import { preferredV3MapMode } from "../map-mode"
import { formatCoordinateReference, formatHeightDatum, formatMapResourceSource, formatScaleTemplateCode } from "../terminology"
import { formatPlatformDate, formatPlatformDateTime } from "../platform-date"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import QuestionnairePanel from "./QuestionnairePanel.vue"
import { defineAsyncComponentWithLoading } from "../async-component"
import V3ProjectModeStatus from "./V3ProjectModeStatus.vue"
import V3ProjectStageNavigation from "./V3ProjectStageNavigation.vue"
import V3ProjectSyncState from "./V3ProjectSyncState.vue"

const V3AreaPlanningWorkspace = defineAsyncComponentWithLoading(() => import("./V3AreaPlanningWorkspace.vue"))
const V3ShowDocumentWorkspace = defineAsyncComponentWithLoading(() => import("./V3ShowDocumentWorkspace.vue"))
const V3ShowPreflightWorkspace = defineAsyncComponentWithLoading(() => import("./V3ShowPreflightWorkspace.vue"))
const V3ShowT60Workspace = defineAsyncComponentWithLoading(() => import("./V3ShowT60Workspace.vue"))
const V3ShowRuntimeWorkspace = defineAsyncComponentWithLoading(() => import("./V3ShowRuntimeWorkspace.vue"))
const V3ShowFlightEndWorkspace = defineAsyncComponentWithLoading(() => import("./V3ShowFlightEndWorkspace.vue"))
const V3ShowReviewWorkspace = defineAsyncComponentWithLoading(() => import("./V3ShowReviewWorkspace.vue"))
const V3LogisticsRegionWorkspace = defineAsyncComponentWithLoading(() => import("./V3LogisticsRegionWorkspace.vue"))
const V3LogisticsRouteWorkspace = defineAsyncComponentWithLoading(() => import("./V3LogisticsRouteWorkspace.vue"))
const V3LogisticsSchedulingWorkspace = defineAsyncComponentWithLoading(() => import("./V3LogisticsSchedulingWorkspace.vue"))
const V3LogisticsReadinessWorkspace = defineAsyncComponentWithLoading(() => import("./V3LogisticsReadinessWorkspace.vue"))
const V3LogisticsRuntimeWorkspace = defineAsyncComponentWithLoading(() => import("./V3LogisticsRuntimeWorkspace.vue"))
const V3VtlPlanningWorkspace = defineAsyncComponentWithLoading(() => import("./V3VtlPlanningWorkspace.vue"))
const V3VtlRuntimeWorkspace = defineAsyncComponentWithLoading(() => import("./V3VtlRuntimeWorkspace.vue"))
const V3VtlReviewWorkspace = defineAsyncComponentWithLoading(() => import("./V3VtlReviewWorkspace.vue"))

const props = defineProps<{ user: AuthUser; projectId: string; initialAlertId?: string }>()
const emit = defineEmits<{ back: []; onboardingAction: [action: "stage-started" | "simulation-opened"] }>()
const loading = ref(false)
const project = ref<StudentProjectView | null>(null)
const snapshot = ref<AssignmentSnapshotView | null>(null)
const region = ref<V3RegionCatalogItem | null>(null)
const focusedAlert = ref<V3RuntimeAlertView | null>(null)
const selectedStageCode = ref("")
const visibleLayers = ref<V3RegionLayerCode[]>([])
const mapMode = ref<"2d" | "3d">("3d")
const mapState = ref<V3MapDataState>(initialV3MapDataState())
const activities = ref<V3ActivityEventView[]>([])
const questionnaire = ref<QuestionnaireView | null>(null)
const activityDrawerVisible = ref(false)
const taskDrawerVisible = ref(false)
const questionnaireVisible = ref(false)
const questionnaireLoading = ref(false)
const vtlPlanningDirty = ref(false)
const activitiesLoading = ref(false)
const serviceState = ref<"CONNECTING" | "CONNECTED" | "ERROR">("CONNECTING")
const clockNowMs = ref(Date.now())
const assessmentServerOffset = ref(0)
const expiryRefreshRequested = ref(false)
let assessmentClockTimer: number | undefined

const selectedStage = computed(() => project.value?.stages.find((stage) => stage.stageCode === selectedStageCode.value) ?? project.value?.stages[0] ?? null)
const isCurrentStage = computed(() => Boolean(project.value && selectedStage.value && selectedStage.value.stageCode === project.value.currentStageCode))
const simulationStage = computed(() => projectSimulationStage(project.value))
const isStudent = computed(() => props.user.role === "student")
const isTeacher = computed(() => props.user.role === "teacher" || props.user.role === "admin")

function vtlLandingSiteLabel(id: string | null | undefined) {
  const site = region.value?.vtlLandingSites?.find((item) => item.id === id)
  return site ? `${site.title}（${site.code}）` : id || "起降点未指定"
}

function vtlAircraftLabel(modelCode: string | null | undefined, version: string | null | undefined) {
  const configured = region.value?.vtlAircraftParameters
  if (configured && configured.modelCode === modelCode && configured.version === version) return `区域默认垂起机型（参数 v${version}）`
  return modelCode ? `${modelCode} · 参数 v${version ?? "未指定"}` : "机型参数未指定"
}
const questionnaireConfigured = computed(() => Boolean(snapshot.value?.config.questionBankVersionId))
const questionnaireEntryVisible = computed(() => questionnaire.value?.available === true || questionnaireConfigured.value)
const nextAction = computed(() => project.value && selectedStage.value
  ? studentStagePrimaryAction(project.value, selectedStage.value)
  : null)
const projectGuidance = computed(() => project.value && selectedStage.value
  ? studentStageNextAction(project.value, selectedStage.value)
  : { label: "读取当前阶段", detail: "正在加载项目状态。" })
const areaWorkspaceReady = computed(() => selectedStage.value?.stageCode === "SHOW_AREA_PLANNING"
  && (selectedStage.value.status === "IN_PROGRESS" || selectedStage.value.status === "SUBMITTED" || selectedStage.value.status === "ACCEPTED"))
const documentWorkspaceReady = computed(() => selectedStage.value?.stageCode === "SHOW_FLIGHT_APPLICATION"
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const preflightWorkspaceReady = computed(() => selectedStage.value?.stageCode === "SHOW_PREFLIGHT"
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const t60WorkspaceReady = computed(() => selectedStage.value?.stageCode === "SHOW_T_MINUS_60"
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const runtimeWorkspaceReady = computed(() => selectedStage.value?.stageCode === "SHOW_RUNTIME"
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const flightEndWorkspaceReady = computed(() => selectedStage.value?.stageCode === "SHOW_FLIGHT_END_REPORT"
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const reviewWorkspaceReady = computed(() => (project.value?.sceneType === "CITY_SHOW" || project.value?.sceneType === "CITY_LOGISTICS")
  && (selectedStage.value?.stageCode === "SHOW_REVIEW" || selectedStage.value?.stageCode === "LOGISTICS_REVIEW")
  && (isTeacher.value || (selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")))
const logisticsRegionWorkspaceReady = computed(() => selectedStage.value?.stageCode === "LOGISTICS_REGION_ANALYSIS"
  && (selectedStage.value.status === "IN_PROGRESS" || selectedStage.value.status === "SUBMITTED" || selectedStage.value.status === "ACCEPTED"))
const logisticsRouteWorkspaceReady = computed(() => (selectedStage.value?.stageCode === "LOGISTICS_ROUTE_PLANNING" || selectedStage.value?.stageCode === "LOGISTICS_ROUTE_VALIDATION")
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const logisticsSchedulingWorkspaceReady = computed(() => selectedStage.value?.stageCode === "LOGISTICS_ORDER_SCHEDULING"
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const logisticsReadinessWorkspaceReady = computed(() => selectedStage.value?.stageCode === "LOGISTICS_RUNTIME_PREPARATION"
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const logisticsRuntimeWorkspaceReady = computed(() => (selectedStage.value?.stageCode === "LOGISTICS_DELIVERY_RUNTIME" || selectedStage.value?.stageCode === "LOGISTICS_EMERGENCY_HANDLING")
  && selectedStage.value.status !== "LOCKED" && selectedStage.value.status !== "AVAILABLE" && selectedStage.value.status !== "RETURNED")
const vtlPlanningWorkspaceReady = computed(() => shouldShowVtlPlanningWorkspace(selectedStage.value))
const vtlRuntimeWorkspaceReady = computed(() => ["VTL_RUNTIME", "VTL_EMERGENCY_HANDLING"].includes(selectedStage.value?.stageCode ?? "")
  && selectedStage.value?.status !== "LOCKED" && selectedStage.value?.status !== "AVAILABLE" && selectedStage.value?.status !== "RETURNED")
const vtlReviewWorkspaceReady = computed(() => selectedStage.value?.stageCode === "VTL_REVIEW"
  && (isTeacher.value || (selectedStage.value?.status !== "LOCKED" && selectedStage.value?.status !== "AVAILABLE" && selectedStage.value?.status !== "RETURNED")))
const stageUsesMap = computed(() => !(
  documentWorkspaceReady.value
  || preflightWorkspaceReady.value
  || t60WorkspaceReady.value
  || flightEndWorkspaceReady.value
  || logisticsReadinessWorkspaceReady.value
))
const sceneTitle = computed(() => project.value?.sceneType === "CITY_SHOW" ? "城市编队表演" : project.value?.sceneType === "CITY_LOGISTICS" ? "城市低空物流" : "垂起广域巡检")
const currentSceneRoleProfile = computed(() => sceneRoleProfile(project.value?.sceneType ?? "CITY_SHOW"))
const reviewSceneType = computed<"CITY_SHOW" | "CITY_LOGISTICS">(() => project.value?.sceneType === "CITY_LOGISTICS" ? "CITY_LOGISTICS" : "CITY_SHOW")
const logisticsTask = computed(() => snapshot.value?.sceneType === "CITY_LOGISTICS"
  ? logisticsTaskSummary(snapshot.value.config, snapshot.value.mode, region.value)
  : null)
const showInitialConditions = computed(() => snapshot.value?.sceneType === "CITY_SHOW"
  ? showTaskInitialConditionsSummary(snapshot.value.config)
  : null)
const showEnvironmentDetails = computed(() => ({
  WEATHER: showInitialConditions.value?.weather,
  POSITIONING: showInitialConditions.value?.positioningElectromagnetic,
  ELECTROMAGNETIC: showInitialConditions.value?.positioningElectromagnetic,
  AUDIENCE: snapshot.value?.config.showParameters ? `计划观众 ${snapshot.value.config.showParameters.plannedAudienceCount} 人` : undefined
}))
const currentAssessmentRemainingMs = computed(() => project.value
  ? assessmentRemainingMs(project.value.assessmentTiming, clockNowMs.value, assessmentServerOffset.value)
  : null)
const currentAssessmentLabel = computed(() => project.value
  ? assessmentTimingLabel(project.value.assessmentTiming, currentAssessmentRemainingMs.value)
  : "")
const logisticsEnvironmentDetails = computed(() => ({
  WEATHER: logisticsTask.value?.weatherState,
  POSITIONING: logisticsTask.value?.positioningState,
  COMMUNICATION: logisticsTask.value?.communicationState
}))
const layerIcons: Record<V3RegionLayerCode, typeof OfficeBuilding> = {
  BUILDINGS: OfficeBuilding,
  RESTRICTIONS: Warning,
  WATER: MapLocation,
  GREENLAND: Sunny,
  POSITIONING: Position,
  COMMUNICATION: Connection,
  ENVIRONMENT: Sunny
}

watch(selectedStageCode, (stageCode) => {
  mapMode.value = preferredV3MapMode(stageCode)
})

onMounted(() => {
  void loadProject()
  assessmentClockTimer = window.setInterval(() => { clockNowMs.value = Date.now() }, 1_000)
  window.addEventListener("beforeunload", handleBeforeUnload)
})
onBeforeUnmount(() => {
  if (assessmentClockTimer !== undefined) window.clearInterval(assessmentClockTimer)
  window.removeEventListener("beforeunload", handleBeforeUnload)
})
watch(region, (value) => {
  const availableLayers = value?.layers
    .filter((layer) => layer.state !== "UNAVAILABLE" && ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"].includes(layer.code))
    .map((layer) => layer.code) ?? []
  // 地图只承载实体区域要素；定位、通信、气象等信息由各阶段侧栏展示。
  visibleLayers.value = availableLayers
})
watch(currentAssessmentRemainingMs, (value) => {
  if (value !== 0 || project.value?.assessmentTiming.state !== "ACTIVE" || expiryRefreshRequested.value) return
  expiryRefreshRequested.value = true
  void refreshProjectFromSpecializedStage()
})

async function loadProject() {
  loading.value = true
  serviceState.value = "CONNECTING"
  try {
    const value = await api<StudentProjectView>(`/v3/projects/${props.projectId}/stages`)
    setProject(value)
    snapshot.value = await api<AssignmentSnapshotView>(`/v3/assignments/${value.assignmentSnapshotId}/snapshot`)
    region.value = await api<V3RegionCatalogItem>(`/v3/resource-packages/regions/${snapshot.value.config.regionPackageId}`)
    focusedAlert.value = null
    if (props.initialAlertId) {
      try {
        const alerts = await api<V3RuntimeAlertView[]>(`/v3/projects/${props.projectId}/alerts`)
        focusedAlert.value = alerts.find((item) => item.id === props.initialAlertId) ?? null
      } catch {
        focusedAlert.value = null
      }
    }
    const teacherReviewStage = !isStudent.value
      ? value.stages.find((stage) => stage.stageCode === (value.sceneType === "CITY_LOGISTICS" ? "LOGISTICS_REVIEW" : value.sceneType === "CITY_SHOW" ? "SHOW_REVIEW" : "VTL_REVIEW"))
      : null
    selectedStageCode.value = teacherReviewStage?.stageCode
      ?? (focusedAlert.value && value.stages.some((stage) => stage.stageCode === focusedAlert.value?.stageCode)
      ? focusedAlert.value.stageCode
      : value.currentStageCode)
    questionnaireVisible.value = false
    await Promise.all([loadActivities(), loadQuestionnaire()])
    serviceState.value = "CONNECTED"
  } catch (error) {
    serviceState.value = "ERROR"
    ElMessage.error(error instanceof Error ? error.message : "学生项目加载失败")
  } finally {
    loading.value = false
  }
}

async function loadQuestionnaire(showError = false) {
  if (!snapshot.value?.config.questionBankVersionId) {
    questionnaire.value = null
    questionnaireLoading.value = false
    return
  }
  questionnaireLoading.value = true
  try {
    questionnaire.value = await api<QuestionnaireView>(`/v3/projects/${props.projectId}/questionnaire`)
  } catch (error) {
    questionnaire.value = null
    if (showError || questionnaireVisible.value) ElMessage.error(error instanceof Error ? error.message : "题库加载失败")
  } finally {
    questionnaireLoading.value = false
  }
}

async function openQuestionnaire() {
  if (!questionnaireEntryVisible.value) return
  questionnaireVisible.value = true
  await loadQuestionnaire(true)
}

function handleQuestionnaireUpdated(value: QuestionnaireView) {
  questionnaire.value = value
}

async function startSelectedStage() {
  if (!selectedStage.value || !isStudent.value || (nextAction.value !== "START" && nextAction.value !== "RESUME")) return
  const action = nextAction.value
  loading.value = true
  try {
    const value = await api<StudentProjectView>(`/v3/projects/${props.projectId}/stages/${selectedStage.value.stageCode}/start`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: selectedStage.value.revision })
    })
    setProject(value)
    serviceState.value = "CONNECTED"
    selectedStageCode.value = value.currentStageCode
    await Promise.all([loadActivities(), loadQuestionnaire()])
    ElMessage.success(action === "RESUME" ? "已恢复本阶段" : "阶段已开始")
    emit("onboardingAction", "stage-started")
  } catch (error) {
    serviceState.value = "ERROR"
    ElMessage.error(error instanceof Error ? error.message : "阶段启动失败")
  } finally {
    loading.value = false
  }
}

function applyProjectUpdate(value: StudentProjectView) {
  setProject(value)
  void Promise.all([loadActivities(), loadQuestionnaire()])
}

function setProject(value: StudentProjectView) {
  project.value = value
  assessmentServerOffset.value = assessmentServerOffsetMs(value.assessmentTiming)
  clockNowMs.value = Date.now()
}

async function refreshProjectFromSpecializedStage() {
  serviceState.value = "CONNECTING"
  try {
    const value = await api<StudentProjectView>(`/v3/projects/${props.projectId}/stages`)
    selectedStageCode.value = resolveStageSelectionAfterRefresh(
      selectedStageCode.value,
      project.value?.currentStageCode,
      value.currentStageCode,
      isStudent.value
    )
    setProject(value)
    await Promise.all([loadActivities(), loadQuestionnaire()])
    serviceState.value = "CONNECTED"
  } catch (error) {
    serviceState.value = "ERROR"
    ElMessage.error(error instanceof Error ? error.message : "项目阶段刷新失败")
  }
}

async function loadActivities() {
  activitiesLoading.value = true
  try {
    activities.value = await api<V3ActivityEventView[]>(`/v3/projects/${props.projectId}/activities`)
  } catch (error) {
    if (activityDrawerVisible.value) ElMessage.error(error instanceof Error ? error.message : "活动记录加载失败")
  } finally {
    activitiesLoading.value = false
  }
}

function toggleLayer(code: V3RegionLayerCode) {
  visibleLayers.value = visibleLayers.value.includes(code)
    ? visibleLayers.value.filter((item) => item !== code)
    : [...visibleLayers.value, code]
}

function openSimulationMode() {
  if (!simulationStage.value) return
  selectedStageCode.value = simulationStage.value.stageCode
  if (simulationStage.value.status === "LOCKED") ElMessage.info(`仿真暂未开放：${simulationEntryCondition(simulationStage.value)}`)
  else emit("onboardingAction", "simulation-opened")
}

async function selectStage(stageCode: string) {
  if (stageCode === selectedStageCode.value) return
  if (vtlPlanningDirty.value && isStudent.value) {
    try {
      await ElMessageBox.confirm("当前阶段存在未保存的规划修改，离开后这些修改会丢失。", "确认离开阶段", {
        confirmButtonText: "离开阶段",
        cancelButtonText: "继续编辑",
        type: "warning"
      })
    } catch {
      return
    }
  }
  vtlPlanningDirty.value = false
  selectedStageCode.value = stageCode
}

async function continueFromTaskDrawer() {
  if (!project.value?.currentStageCode) return
  if (selectedStageCode.value !== project.value.currentStageCode) {
    await selectStage(project.value.currentStageCode)
    if (selectedStageCode.value !== project.value.currentStageCode) return
  }
  taskDrawerVisible.value = false
  if (nextAction.value === "START" || nextAction.value === "RESUME") {
    await startSelectedStage()
  }
}

async function leaveProject() {
  if (vtlPlanningDirty.value && isStudent.value) {
    try {
      await ElMessageBox.confirm("当前阶段存在未保存的规划修改，返回首页后这些修改会丢失。", "确认返回教学首页", {
        confirmButtonText: "返回首页",
        cancelButtonText: "继续编辑",
        type: "warning"
      })
    } catch {
      return
    }
  }
  vtlPlanningDirty.value = false
  emit("back")
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  if (!vtlPlanningDirty.value || !isStudent.value) return
  event.preventDefault()
  event.returnValue = ""
}

function stageStatusLabel(stage: StudentProjectStageView) {
  return studentStageStatusLabel(stage.status, stage.stageCode, project.value?.assignmentStatus)
}

function activityStage(event: V3ActivityEventView) {
  if (!event.stageCode) return "任务"
  return project.value?.stages.find((stage) => stage.stageCode === event.stageCode)?.title ?? event.stageCode
}

function formatActivityTime(value: string) {
  return formatPlatformDate(value, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function formatDateTime(value: string | undefined) {
  return value ? formatPlatformDateTime(value) : "-"
}

function serviceStateLabel(state: typeof serviceState.value): string {
  if (state === "CONNECTING") return "正在同步"
  if (state === "ERROR") return "连接异常"
  return "服务已连接"
}
</script>

<template>
  <div class="v3-project-shell" :class="{ 'v3-project-shell-vtl': vtlRuntimeWorkspaceReady || vtlReviewWorkspaceReady }" v-loading="loading">
    <header class="v3-project-header">
      <button type="button" class="icon-command" title="返回教学首页" aria-label="返回教学首页" @click="leaveProject"><el-icon><ArrowLeft /></el-icon></button>
      <div class="v3-project-title"><span>{{ sceneTitle }} · V3</span><strong>{{ project ? studentProjectTitle(project) : '学生项目' }}</strong><small v-if="project?.mode === 'ASSESSMENT'" class="assessment-clock" :class="project.assessmentTiming.state.toLowerCase()"><Clock />考核 {{ currentAssessmentLabel }}</small></div>
      <div v-if="selectedStage" class="project-stage-guidance" :title="projectGuidance.detail" role="status" aria-live="polite" :aria-label="`${isCurrentStage ? '当前阶段' : '正在查看阶段'}：${selectedStage.title}；下一步：${projectGuidance.label}；${projectGuidance.detail}`"><span>{{ isCurrentStage ? '当前阶段' : '正在查看阶段' }}</span><strong>{{ selectedStage.title }}</strong><small>{{ projectGuidance.label }}</small><em>{{ projectGuidance.detail }}</em></div>
      <div v-if="selectedStage" class="project-stage-guidance-mobile" role="status" aria-live="polite" :aria-label="`${isCurrentStage ? '当前阶段' : '正在查看阶段'}：${selectedStage.title}；下一步：${projectGuidance.label}；${projectGuidance.detail}`"><span>{{ isCurrentStage ? '当前阶段' : '查看阶段' }} · {{ selectedStage.title }}</span><strong>{{ projectGuidance.label }}</strong><em>{{ projectGuidance.detail }}</em></div>
      <V3ProjectModeStatus :project="project" :actor-role="user.role" />
      <button
        v-if="isStudent && simulationStage"
        type="button"
        class="simulation-command"
        :class="{ active: isSimulationStage(selectedStage?.stageCode), locked: simulationStage.status === 'LOCKED' }"
        :title="simulationStage.status === 'LOCKED' ? `开放条件：${simulationEntryCondition(simulationStage)}` : '进入仿真运行阶段'"
        :aria-label="`仿真运行：${simulationEntryStatus(simulationStage)}${simulationStage.status === 'LOCKED' ? `；开放条件：${simulationEntryCondition(simulationStage)}` : ''}`"
        @click="openSimulationMode"
      >
        <el-icon><VideoPlay /></el-icon>
        <span><strong>仿真运行</strong><small :title="simulationStage.status === 'LOCKED' ? `开放条件：${simulationEntryCondition(simulationStage)}` : undefined">{{ simulationEntryStatus(simulationStage) }}</small></span>
      </button>
      <button
        v-if="questionnaireEntryVisible"
        type="button"
        class="project-activity-command questionnaire-command"
        :class="{ active: questionnaireVisible }"
        title="题库作答与判定"
        :aria-label="`题库作答与判定：${questionnaireLoading ? '加载中' : questionnaire?.attempt?.status === 'SUBMITTED' ? '已提交，等待教师复核' : questionnaire?.attempt?.status === 'GRADED' ? '自动判定已完成' : questionnaire?.canEdit ? '可继续作答' : '只读查看'}`"
        :aria-busy="questionnaireLoading"
        @click="openQuestionnaire"
      >
        <el-icon><DocumentChecked /></el-icon><span>题库</span>
      </button>
      <button type="button" class="project-activity-command" title="任务条件" aria-label="任务条件" @click="taskDrawerVisible = true"><el-icon><InfoFilled /></el-icon><span>条件</span></button>
      <button type="button" class="project-activity-command" title="项目活动记录" aria-label="项目活动记录" @click="activityDrawerVisible = true"><el-icon><Clock /></el-icon><span>{{ activities.length }}</span></button>
      <div v-if="stageUsesMap" class="view-segment" aria-label="地图视角"><button type="button" title="2D 精确规划视角" aria-label="2D 精确规划视角" :aria-pressed="mapMode === '2d'" :class="{ active: mapMode === '2d' }" @click="mapMode = '2d'">2D</button><button type="button" title="3D 空间理解视角" aria-label="3D 空间理解视角" :aria-pressed="mapMode === '3d'" :class="{ active: mapMode === '3d' }" @click="mapMode = '3d'">3D</button></div>
    </header>

    <V3ProjectSyncState :state="serviceState" :has-project="Boolean(project)" :loading="loading" @retry="loadProject" />

    <V3ProjectStageNavigation :project="project" :selected-stage-code="selectedStageCode" @select="selectStage" />

    <V3LogisticsRegionWorkspace
      v-if="logisticsRegionWorkspaceReady && project && selectedStage && region"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :visible-layers="visibleLayers"
      :map-mode="mapMode"
      :environment-details="logisticsEnvironmentDetails"
      @refresh-project="refreshProjectFromSpecializedStage"
      @toggle-layer="toggleLayer"
      @data-state="mapState = $event"
    />

    <V3LogisticsRouteWorkspace
      v-else-if="logisticsRouteWorkspaceReady && project && selectedStage && region"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :visible-layers="visibleLayers"
      :map-mode="mapMode"
      :environment-details="logisticsEnvironmentDetails"
      @refresh-project="refreshProjectFromSpecializedStage"
      @toggle-layer="toggleLayer"
      @data-state="mapState = $event"
    />

    <V3LogisticsSchedulingWorkspace
      v-else-if="logisticsSchedulingWorkspaceReady && project && selectedStage && region"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :visible-layers="visibleLayers"
      :map-mode="mapMode"
      @refresh-project="refreshProjectFromSpecializedStage"
      @resume-stage="startSelectedStage"
      @dirty-change="vtlPlanningDirty = $event"
      @data-state="mapState = $event"
      @toggle-layer="toggleLayer"
    />

    <V3LogisticsReadinessWorkspace
      v-else-if="logisticsReadinessWorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      @refresh-project="refreshProjectFromSpecializedStage"
    />

    <V3LogisticsRuntimeWorkspace
      v-else-if="logisticsRuntimeWorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :map-mode="mapMode"
      :initial-alert-id="focusedAlert?.id ?? ''"
      @refresh-project="refreshProjectFromSpecializedStage"
      @data-state="mapState = $event"
    />

    <V3VtlPlanningWorkspace
      v-else-if="vtlPlanningWorkspaceReady && project && selectedStage && region"
      :key="`vtl-planning-${project.id}-${project.assessmentTiming.state}`"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :main-landing-site-id="snapshot?.config.vtlParameters?.mainLandingSiteId ?? ''"
      :visible-layers="visibleLayers"
      :map-mode="mapMode"
      @refresh-project="refreshProjectFromSpecializedStage"
      @resume-stage="startSelectedStage"
      @data-state="mapState = $event"
      @toggle-layer="toggleLayer"
    />

    <V3VtlRuntimeWorkspace
      v-else-if="vtlRuntimeWorkspaceReady && project && selectedStage"
      :key="`vtl-runtime-${project.id}-${project.assessmentTiming.state}`"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :map-mode="mapMode"
      :main-landing-site-id="snapshot?.config.vtlParameters?.mainLandingSiteId ?? ''"
      :initial-alert-id="focusedAlert?.id ?? ''"
      @refresh-project="refreshProjectFromSpecializedStage"
      @data-state="mapState = $event"
    />

    <V3VtlReviewWorkspace
      v-else-if="vtlReviewWorkspaceReady && project && selectedStage"
      :key="`vtl-review-${project.id}-${project.assessmentTiming.state}`"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :map-mode="mapMode"
      @refresh-project="refreshProjectFromSpecializedStage"
    />

    <V3AreaPlanningWorkspace
      v-else-if="areaWorkspaceReady && project && selectedStage && region"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :visible-layers="visibleLayers"
      :map-mode="mapMode"
      :environment-details="showEnvironmentDetails"
      @project-updated="applyProjectUpdate"
      @toggle-layer="toggleLayer"
      @data-state="mapState = $event"
    />

    <V3ShowDocumentWorkspace
      v-else-if="documentWorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      @refresh-project="refreshProjectFromSpecializedStage"
    />

    <V3ShowPreflightWorkspace
      v-else-if="preflightWorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      @refresh-project="refreshProjectFromSpecializedStage"
    />

    <V3ShowT60Workspace
      v-else-if="t60WorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      @refresh-project="refreshProjectFromSpecializedStage"
    />

    <V3ShowRuntimeWorkspace
      v-else-if="runtimeWorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :region="region"
      :map-mode="mapMode"
      :initial-alert-id="focusedAlert?.id ?? ''"
      @refresh-project="refreshProjectFromSpecializedStage"
      @data-state="mapState = $event"
    />

    <V3ShowFlightEndWorkspace
      v-else-if="flightEndWorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      @refresh-project="refreshProjectFromSpecializedStage"
    />

    <V3ShowReviewWorkspace
      v-else-if="reviewWorkspaceReady && project && selectedStage"
      :user="user"
      :project="project"
      :stage="selectedStage"
      :scene-type="reviewSceneType"
      :region="region"
      :map-mode="mapMode"
      @refresh-project="refreshProjectFromSpecializedStage"
    />

    <template v-else>
      <main class="v3-project-map">
        <V3UnifiedMap :region="region" :missing-region-package-id="snapshot?.config.regionPackageId ?? null" :visible-layers="visibleLayers" :mode="mapMode" @data-state="mapState = $event" />
        <div class="v3-map-caption"><span><el-icon><MapLocation /></el-icon>{{ region?.title ?? '区域资源不可用' }}</span><small v-if="region">{{ region.regionCode }} · {{ formatCoordinateReference('WGS84') }} · {{ formatHeightDatum(region.heightDatum) }} · DEM {{ region.terrain?.version ?? region.terrainResourceVersion }}</small><small v-else>区域快照未找到 · 地图资源不可用</small></div>
      </main>

      <aside class="v3-project-inspector">
        <section class="stage-inspector">
          <span>阶段 {{ String(selectedStage?.sequence ?? 0).padStart(2, '0') }}</span>
          <h2>{{ selectedStage?.title }}</h2>
          <p>{{ selectedStage?.description }}</p>
          <dl><div><dt>当前状态</dt><dd>{{ selectedStage ? stageStatusLabel(selectedStage) : '-' }}</dd></div><div><dt>开放条件</dt><dd>{{ studentStageOpenConditionLabel(selectedStage) }}</dd></div></dl>
          <el-button v-if="isStudent && (nextAction === 'START' || nextAction === 'RESUME')" type="primary" :icon="VideoPlay" :loading="loading" :disabled="loading" :aria-label="studentStagePrimaryActionLabel(nextAction, selectedStage?.status ?? 'LOCKED')" @click="startSelectedStage">{{ studentStagePrimaryActionLabel(nextAction, selectedStage?.status ?? 'LOCKED') }}</el-button>
          <div v-else class="stage-action-note" :class="{ warning: isStudent && !nextAction }"><strong>{{ isStudent ? projectGuidance.label : '教师只读模式' }}</strong><span>{{ isStudent ? projectGuidance.detail : '专项能力将在对应阶段开放。' }}</span></div>
        </section>

        <section class="workspace-layer-list">
          <header><strong>专题图层</strong><small>区域包 v{{ region?.packageVersion }}</small></header>
          <button v-for="layer in (region?.layers ?? []).filter(item => ['BUILDINGS', 'RESTRICTIONS', 'WATER', 'GREENLAND'].includes(item.code))" :key="layer.code" type="button" :class="{ active: visibleLayers.includes(layer.code) }" :aria-pressed="visibleLayers.includes(layer.code)" :aria-label="`${layer.title}，${layer.state === 'DEGRADED' ? '降级数据' : formatMapResourceSource(layer.source)}，${visibleLayers.includes(layer.code) ? '已显示' : '未显示'}`" :disabled="layer.state === 'UNAVAILABLE'" @click="toggleLayer(layer.code)">
            <el-icon><component :is="layerIcons[layer.code]" /></el-icon><span><strong>{{ layer.title }}</strong><small>{{ layer.state === 'DEGRADED' ? `降级数据 · ${formatMapResourceSource(layer.source)}` : formatMapResourceSource(layer.source) }}</small></span><i />
          </button>
        </section>
      </aside>
    </template>

    <footer class="v3-project-statusbar">
      <span class="service-state" :class="serviceState.toLowerCase()" role="status" aria-live="polite">{{ serviceStateLabel(serviceState) }}</span>
      <button v-if="serviceState === 'ERROR'" class="service-retry" type="button" aria-label="重新连接服务" @click="loadProject"><el-icon><Refresh /></el-icon>重新连接</button>
      <template v-if="stageUsesMap">
        <span v-if="region" :class="{ loading: mapState.phase !== 'READY', failed: mapState.imagery === 'FAILED' || mapState.imagery === 'UNAVAILABLE', degraded: mapState.imagery === 'DEGRADED' }">{{ v3MapLoadingLabel(mapState) }}</span>
        <span v-else class="failed">教学区域资源不可用</span>
        <span v-if="region && mapState.terrain !== 'WORLD_TERRAIN'">{{ regionTerrainStateLabel(mapState.terrain) }}</span>
      </template>
      <span v-else>当前阶段无需地图</span>
      <span>{{ formatCoordinateReference('WGS84') }} / {{ region ? formatHeightDatum(region.heightDatum) : '区域未绑定' }}</span>
      <span class="status-right">{{ mapMode.toUpperCase() }} 视图</span>
    </footer>

    <el-drawer v-model="activityDrawerVisible" title="项目活动记录" size="min(420px, 100%)" append-to-body>
      <div class="project-activity-drawer" v-loading="activitiesLoading">
        <header><span>全过程留痕</span><el-button text :icon="Refresh" @click="loadActivities">刷新</el-button></header>
        <ol v-if="activities.length" class="project-activity-timeline">
          <li v-for="event in activities" :key="event.id">
            <i :class="event.actorRole" />
            <div><span>{{ activityStage(event) }}</span><strong>{{ projectActivityLabel(event.eventType) }}</strong><p>{{ projectActivitySummary(event) }}</p><small>{{ event.actorName }} · {{ formatActivityTime(event.realTime) }}</small></div>
          </li>
        </ol>
        <div v-else class="section-empty"><strong>暂无活动记录</strong><span>开始项目阶段后，关键操作会显示在这里</span></div>
      </div>
    </el-drawer>

    <el-drawer v-model="taskDrawerVisible" title="任务条件" size="min(420px, 100%)" append-to-body>
      <div class="project-task-drawer">
        <header><span>{{ sceneTitle }}</span><strong>{{ snapshot ? (snapshot.displayTitle ?? displayTeachingAssignmentTitle({ id: snapshot.draftId, title: snapshot.title, sceneType: snapshot.sceneType })) : '任务条件' }}</strong></header>
        <section v-if="selectedStage" class="task-drawer-next-step" role="status" aria-live="polite">
          <div><span>{{ isCurrentStage ? '当前阶段' : '项目当前阶段' }}</span><strong>{{ isCurrentStage ? selectedStage.title : project?.stages.find((stage) => stage.stageCode === project?.currentStageCode)?.title }}</strong></div>
          <p>{{ isCurrentStage ? projectGuidance.detail : '当前查看的阶段不是项目当前阶段，继续操作将回到项目当前阶段。' }}</p>
          <el-button v-if="isStudent && isCurrentStage && (nextAction === 'START' || nextAction === 'RESUME')" type="primary" :icon="VideoPlay" :loading="loading" :disabled="loading" :aria-label="`${studentStagePrimaryActionLabel(nextAction, selectedStage.status)}，${loading ? '处理中' : '执行'}`" @click="continueFromTaskDrawer">{{ studentStagePrimaryActionLabel(nextAction, selectedStage.status) }}</el-button>
          <el-button v-else-if="isStudent && !isCurrentStage" type="primary" :icon="ArrowLeft" @click="continueFromTaskDrawer">回到当前阶段</el-button>
          <small v-else>{{ isStudent ? projectGuidance.label : '教师只读模式' }}</small>
        </section>
        <section class="scene-role-brief">
          <header><span>当前由学生操作</span><strong>{{ currentSceneRoleProfile.studentRole }}</strong></header>
          <p>{{ currentSceneRoleProfile.objective }}</p>
          <dl>
            <div><dt>系统模拟角色</dt><dd>{{ currentSceneRoleProfile.systemRoles.join(' · ') }}</dd></div>
            <div><dt>主要对象</dt><dd>{{ currentSceneRoleProfile.coreObjects }}</dd></div>
            <div><dt>关键约束</dt><dd>{{ currentSceneRoleProfile.keyConstraints }}</dd></div>
          </dl>
          <small>系统角色的反馈会记录到运行事件、告警或项目活动中。</small>
        </section>
        <template v-if="project?.sceneType === 'CITY_SHOW' && snapshot?.config.showParameters">
          <section><strong>项目背景</strong><p>{{ snapshot.config.showParameters.projectBackground }}</p></section>
          <section><strong>任务说明</strong><p>{{ snapshot.config.taskBrief }}</p></section>
          <section><strong>完成要求</strong><p>{{ snapshot.config.showParameters.completionRequirements }}</p></section>
          <dl>
            <div><dt>预设区域</dt><dd>{{ region?.title }}</dd></div>
            <div><dt>机群规模</dt><dd>{{ formatScaleTemplateCode(snapshot.config.scaleTemplateCode) }}</dd></div>
            <div><dt>表演时间</dt><dd>{{ formatDateTime(snapshot.config.showParameters.plannedStartAt) }}<br />至 {{ formatDateTime(snapshot.config.showParameters.plannedEndAt) }}</dd></div>
            <div><dt>最大高度</dt><dd>{{ snapshot.config.showParameters.maximumHeightMeters }} m</dd></div>
            <div><dt>计划观众</dt><dd>{{ snapshot.config.showParameters.plannedAudienceCount }} 人</dd></div>
            <div><dt>无人机型号</dt><dd>{{ snapshot.config.showParameters.aircraftModel }}</dd></div>
            <div><dt>现场联系人</dt><dd>{{ snapshot.config.showParameters.contactName }} · {{ snapshot.config.showParameters.contactPhone }}</dd></div>
            <div><dt>初始气象</dt><dd>{{ showInitialConditions?.weather }}</dd></div>
            <div><dt>定位与电磁</dt><dd>{{ showInitialConditions?.positioningElectromagnetic }}</dd></div>
            <div><dt>通信与控制</dt><dd>{{ showInitialConditions?.communicationControl }}</dd></div>
            <div><dt>设备初态</dt><dd>{{ showInitialConditions?.device }}</dd></div>
          </dl>
        </template>
        <template v-else-if="logisticsTask">
          <section><strong>项目背景</strong><p>{{ logisticsTask.projectBackground }}</p></section>
          <section><strong>任务说明</strong><p>{{ logisticsTask.taskBrief }}</p></section>
          <section><strong>完成要求</strong><p>{{ logisticsTask.completionRequirements }}</p></section>
          <dl>
            <div><dt>教学模式</dt><dd>{{ logisticsTask.mode }}</dd></div>
            <div><dt>预设区域</dt><dd>{{ region?.title ?? '区域资源未命名' }}</dd></div>
            <div><dt>中心机场</dt><dd>{{ logisticsTask.centerAirport }}</dd></div>
            <div><dt>机群规模</dt><dd>{{ formatScaleTemplateCode(snapshot?.config.scaleTemplateCode) }}</dd></div>
            <div><dt>计划运行</dt><dd>{{ formatDateTime(logisticsTask.plannedStartAt) }}<br />至 {{ formatDateTime(logisticsTask.plannedEndAt) }}</dd></div>
            <div><dt>订单数量</dt><dd>{{ logisticsTask.orderCount }} 单</dd></div>
            <div><dt>释放方式</dt><dd>{{ logisticsTask.releaseMode }}</dd></div>
            <div><dt>需求分布</dt><dd>{{ logisticsTask.deliveryDistributionMode }}</dd></div>
            <div><dt>优先级结构</dt><dd>{{ logisticsTask.priorityProfile }}</dd></div>
            <div><dt>时间窗口</dt><dd>{{ logisticsTask.timeWindow }}</dd></div>
            <div><dt>初始机队</dt><dd>{{ logisticsTask.initialAircraftState }}</dd></div>
            <div><dt>初始气象</dt><dd>{{ logisticsTask.weatherState }}</dd></div>
            <div><dt>定位 / 通信</dt><dd>{{ logisticsTask.positioningState }} / {{ logisticsTask.communicationState }}</dd></div>
            <div><dt>系统模拟事件</dt><dd>{{ logisticsTask.scenarioEvents.length ? logisticsTask.scenarioEvents.join('、') : '不注入运行事件' }}</dd></div>
          </dl>
          <section class="task-node-section">
            <strong>候选配送点 · {{ logisticsTask.candidateDeliveryPoints.length }}</strong>
            <div class="task-node-list"><span v-for="name in logisticsTask.candidateDeliveryPoints" :key="name">{{ name }}</span></div>
          </section>
        </template>
        <template v-else-if="snapshot?.config.vtlParameters">
          <section><strong>项目背景</strong><p>{{ snapshot.config.vtlParameters.projectBackground }}</p></section>
          <section><strong>任务说明</strong><p>{{ snapshot.config.taskBrief }}</p></section>
          <section><strong>完成要求</strong><p>{{ snapshot.config.vtlParameters.completionRequirements }}</p></section>
          <dl>
            <div><dt>巡检区域</dt><dd>{{ region?.title }}</dd></div>
            <div><dt>机群规模</dt><dd>{{ formatScaleTemplateCode(snapshot.config.scaleTemplateCode) }}</dd></div>
            <div><dt>计划时间</dt><dd>{{ formatDateTime(snapshot.config.vtlParameters.plannedStartAt) }}<br />至 {{ formatDateTime(snapshot.config.vtlParameters.plannedEndAt) }}</dd></div>
            <div><dt>主起降点</dt><dd>{{ vtlLandingSiteLabel(snapshot.config.vtlParameters.mainLandingSiteId) }}</dd></div>
            <div><dt>机型参数</dt><dd>{{ vtlAircraftLabel(snapshot.config.vtlParameters.aircraftModelCode, snapshot.config.vtlParameters.aircraftParameterVersion) }}</dd></div>
          </dl>
        </template>
        <template v-else>
          <section><strong>任务说明</strong><p>{{ snapshot?.config.taskBrief || '未填写任务说明' }}</p></section>
        </template>
      </div>
    </el-drawer>

    <QuestionnairePanel
      v-if="project"
      :visible="questionnaireVisible"
      :project-id="project.id"
      :user="user"
      :questionnaire="questionnaire"
      :loading="questionnaireLoading"
      @update:visible="questionnaireVisible = $event"
      @updated="handleQuestionnaireUpdated"
      @retry="loadQuestionnaire(true)"
    />
  </div>
</template>
