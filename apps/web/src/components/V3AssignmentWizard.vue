<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Check, CircleCheckFilled, Close, InfoFilled, Location, Promotion, RefreshRight, WarningFilled } from "@element-plus/icons-vue"
import {
  defaultLogisticsEventSubtype,
  isLogisticsEventSubtypeAllowed,
  logisticsEventSubtypeDefinitions,
  logisticsEventSubtypeLabel,
  logisticsTemplatePolicy,
  resolveLogisticsInitialEnvironment,
  resolveLogisticsInitialFleet,
  resolveLogisticsTimeWindowProfile,
  resolveShowInitialConditions,
  showMaximumEventImpactCount,
  showInitialDeviceAffectedCount,
  showTemplateAircraftCount,
  showTemplatePolicy,
  stageDefinitionsFor,
  vtlStageCodes,
  vtlTemplatePolicy
} from "@wurenji/shared"
import type {
  AssignmentDraftConfig,
  AssignmentDraftView,
  AssignmentPreflightCheckView,
  AssignmentPreflightView,
  AssignmentPreviewView,
  AssignmentTargetInput,
  ClassroomStudent,
  ClassroomSummary,
  LearningMode,
  LogisticsOrderDistributionMode,
  LogisticsOrderReleaseMode,
  LogisticsOrderReleasePhase,
  LogisticsPriorityProfile,
  LogisticsSignalState,
  LogisticsTimeWindowProfile,
  SceneType,
  V3RegionMapReadinessView,
  ShowCommunicationControlState,
  ShowGustState,
  ShowInitialDeviceScope,
  ShowInitialDeviceState,
  ShowPositioningElectromagneticState,
  ShowRainState,
  ShowWindDirection,
  ShowWindForceState,
  ShowProgramManifest,
  StageDefinition,
  V3Coordinate,
  V3RegionCatalogItem,
  V3ResourcePackageView,
  V3ResourceReference,
  V3ScenarioEventCondition,
  V3ScenarioEventConfig,
  V3ScenarioEventImpactScope,
  V3ScenarioOverlayVersionView,
  V3ScaleTemplateCatalogItem,
  VtlEvaluationItemConfig,
  VtlStageCode,
  QuestionBankSummary
} from "@wurenji/shared"
import { ApiError, api } from "../api"
import { formatCoordinateReference, formatHeightDatum, formatScaleTemplateCode, formatVtlTaskType } from "../terminology"
import { formatPlatformDateTime } from "../platform-date"
import {
  advanceV3OperationProgress,
  completeV3OperationProgress,
  failV3OperationProgress,
  startV3OperationProgress,
  type V3OperationProgressState
} from "../operation-progress"
import { v3SceneLabel } from "../scene-presentation"
import { vtlMapReadinessPresentation } from "../vtl-map-readiness-presentation"
import { normalizeVtlStageSelection } from "../vtl-stage-selection"
import { assignmentPreflightTargetSelector, firstPreflightFocusable, shouldInvalidateAssignmentPreview } from "../assignment-preflight-focus"
import { assignmentPlanVersion, mapResourceVersion, publishedScenarioOverlayVersions, scenarioOverlayResourceVersion } from "../assignment-overlay"
import { defaultQuestionBankForScene } from "../question-bank-defaults"
import V3OperationProgress from "./V3OperationProgress.vue"

const props = withDefaults(defineProps<{
  visible: boolean
  initialSceneType?: SceneType
  initialRegionId?: string
  initialDraftId?: string
}>(), {
  initialSceneType: "CITY_SHOW",
  initialRegionId: "",
  initialDraftId: ""
})

const emit = defineEmits<{
  "update:visible": [visible: boolean]
  opened: []
  published: [payload: { snapshotId: string; projectCount: number }]
  "open-regions": []
}>()

const step = ref(0)
const wizardContent = ref<HTMLElement | null>(null)
const loading = ref(false)
const publishing = ref(false)
const resources = ref<V3ResourcePackageView[]>([])
const regions = ref<V3RegionCatalogItem[]>([])
const scenarioOverlayVersions = ref<V3ScenarioOverlayVersionView[]>([])
const scenarioOverlayLoading = ref(false)
const scenarioOverlayError = ref("")
const scaleTemplates = ref<V3ScaleTemplateCatalogItem[]>([])
const questionBanks = ref<QuestionBankSummary[]>([])
const classes = ref<ClassroomSummary[]>([])
const classStudents = ref<ClassroomStudent[]>([])
const draft = ref<AssignmentDraftView | null>(null)
const draftContext = ref("")
const preview = ref<AssignmentPreviewView | null>(null)
const preflight = ref<AssignmentPreflightView | null>(null)
const riskConfirmed = ref(false)
const hydratingDraft = ref(false)
const wizardSnapshot = ref("")
const wizardReady = ref(false)
const previewProgress = ref<V3OperationProgressState | null>(null)
const questionBankError = ref("")
const previewInvalidationReason = ref("")
let preflightHighlightTimer: ReturnType<typeof setTimeout> | null = null
let wizardRequest = 0
let wizardAbortController: AbortController | undefined
let classStudentsRequest = 0
let classStudentsAbortController: AbortController | undefined
let scenarioOverlayRequest = 0
let scenarioOverlayAbortController: AbortController | undefined
const mapReadiness = computed(() => vtlMapReadinessPresentation(
  preview.value?.regionMapReadiness ?? preflight.value?.regionMapReadiness ?? null,
  preview.value?.formalMapRequired ?? preflight.value?.formalMapRequired ?? false
))
const environmentDiagnostics = computed(() => (
  preview.value?.regionMapReadiness?.environmentDiagnostics
  ?? preflight.value?.regionMapReadiness?.environmentDiagnostics
  ?? null
))
const mapReadinessData = computed<V3RegionMapReadinessView | null>(() => (
  preview.value?.regionMapReadiness ?? preflight.value?.regionMapReadiness ?? null
))
const preflightChecks = computed(() => preflight.value?.checks ?? [])
const preflightBlockingChecks = computed(() => preflightChecks.value.filter((check) => check.level === "BLOCKING"))
const preflightWarningChecks = computed(() => preflightChecks.value.filter((check) => check.level === "WARNING"))
const preflightConfirmationChecks = computed(() => preflightWarningChecks.value.filter((check) => check.code !== "MAP_RESOURCE"))
const preflightPassedChecks = computed(() => preflightChecks.value.filter((check) => check.level === "PASSED"))
const canPublish = computed(() => Boolean(
  draft.value
  && preview.value
  && preflight.value
  && preflight.value.summary.blocking === 0
  && (preflightConfirmationChecks.value.length === 0 || riskConfirmed.value)
))
const hasUnsavedWizardChanges = computed(() => wizardReady.value && wizardSnapshot.value !== snapshotWizardState())

const title = ref("")
const projectBackground = ref("")
const taskBrief = ref("")
const completionRequirements = ref("")
const sceneType = ref<SceneType>("CITY_SHOW")
const mode = ref<LearningMode>("TRAINING")
const regionPackageId = ref("")
const scenarioOverlayVersionId = ref("")
const scaleTemplateCode = ref("")
const questionBankVersionId = ref("")
const showProgramPackageId = ref<string | null>(null)
const classroomId = ref("")
const targetMode = ref<"CLASS" | "STUDENT">("CLASS")
const selectedStudentIds = ref<string[]>([])
const schedule = ref<[Date, Date]>(defaultAssignmentSchedule())
const showWindDirection = ref<ShowWindDirection>("SE")
const showWindForceState = ref<ShowWindForceState>("NORMAL")
const showGustState = ref<ShowGustState>("NONE")
const showRainState = ref<ShowRainState>("NONE")
const showPositioningElectromagneticState = ref<ShowPositioningElectromagneticState>("NORMAL")
const showCommunicationControlState = ref<ShowCommunicationControlState>("NORMAL")
const showDeviceState = ref<ShowInitialDeviceState>("NORMAL")
const showDeviceImpactScope = ref<ShowInitialDeviceScope>("NONE")
const eventCodes = ref<string[]>([])
const eventConfigs = ref<V3ScenarioEventConfig[]>([])
const allowResubmission = ref(true)
const assessmentDurationMinutes = ref(120)
const allowedValidationAttempts = ref(3)
const allowedRuntimeAttempts = ref(3)
const logisticsOrderCount = ref(20)
const logisticsReleaseMode = ref<LogisticsOrderReleaseMode>("BATCH")
const logisticsReleasePhase = ref<LogisticsOrderReleasePhase>("WAITING_EXECUTION")
const logisticsPriorityProfile = ref<LogisticsPriorityProfile>("STANDARD_HEAVY")
const logisticsDeliveryDistributionMode = ref<LogisticsOrderDistributionMode>("UNIFORM")
const logisticsTimeWindowProfile = ref<LogisticsTimeWindowProfile>("NORMAL")
const logisticsOrderSeed = ref(newOrderSeed())
const candidateDeliveryPointIds = ref<string[]>([])
const logisticsUnavailableAircraftCount = ref(0)
const logisticsLowBatteryAircraftCount = ref(0)
const logisticsStandbyAircraftCount = ref(0)
const logisticsPreflightAbnormalAircraftCount = ref(0)
const logisticsWindDirection = ref("N")
const logisticsWindForceState = ref("NORMAL")
const logisticsGustState = ref("NONE")
const logisticsRainState = ref("NONE")
const logisticsPositioningState = ref<LogisticsSignalState>("NORMAL")
const logisticsCommunicationState = ref<LogisticsSignalState>("NORMAL")
const logisticsRuntimeSchedule = ref<[Date, Date]>(defaultLogisticsRuntimeSchedule())
const vtlRuntimeSchedule = ref<[Date, Date]>(defaultVtlRuntimeSchedule())
const vtlMainLandingSiteId = ref("")
const vtlTaskObjectIds = ref<string[]>([])
const vtlTaskAreaBoundary = ref<V3Coordinate[]>([])
const vtlOpenStageCodes = ref<VtlStageCode[]>([])
const vtlEvaluationItems = ref<VtlEvaluationItemConfig[]>([])
const showFlightSchedule = ref<[Date, Date]>(defaultShowFlightSchedule())
const showContactName = ref("")
const showContactPhone = ref("")
const showAircraftModel = ref("教学统一编队无人机")
const showAudienceCount = ref(1000)
const showMaximumHeightMeters = ref(120)

const steps = ["场景与模式", "模板与区域", "变量与事件", "发布范围", "预览发布"]
const sceneRegions = computed(() => regions.value.filter((region) => region.sceneType === sceneType.value))
const scaleOptions = computed(() => scaleTemplates.value
  .filter((item) => item.sceneType === sceneType.value)
  .map((item) => ({ code: item.code, label: item.title })))
type ShowProgramResource = V3ResourcePackageView & { manifest: ShowProgramManifest }
const showPrograms = computed<ShowProgramResource[]>(() => resources.value
  .filter((resource): resource is ShowProgramResource => resource.packageType === "SHOW_PROGRAM" && resource.status === "ACTIVE" && isShowProgramManifest(resource.manifest))
  .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true })))
const selectedShowProgram = computed(() => showPrograms.value.find((item) => item.id === showProgramPackageId.value) ?? null)
const showProgramCompatible = computed(() => !selectedShowProgram.value || selectedShowProgram.value.manifest.aircraftCount === showAircraftCount.value)
const compatibleQuestionBanks = computed(() => questionBanks.value.filter((bank) => bank.publishedVersionId && (!bank.sceneType || bank.sceneType === sceneType.value)))
const selectedQuestionBank = computed(() => compatibleQuestionBanks.value.find((bank) => bank.publishedVersionId === questionBankVersionId.value) ?? null)
const questionBankSelectionInvalid = computed(() => Boolean(questionBankVersionId.value && !selectedQuestionBank.value))
const logisticsPolicy = computed(() => logisticsTemplatePolicy(scaleTemplateCode.value || "LOGISTICS_3"))
const vtlPolicy = computed(() => vtlTemplatePolicy(scaleTemplateCode.value || "VTL_1"))
const showAircraftCount = computed(() => showTemplateAircraftCount(scaleTemplateCode.value || "SHOW_100"))
const selectedScaleTemplate = computed(() => scaleTemplates.value.find((item) => item.code === scaleTemplateCode.value) ?? null)
const showPolicy = computed(() => showTemplatePolicy(scaleTemplateCode.value || "SHOW_100"))
const showEventCountValid = computed(() => eventCodes.value.length >= showPolicy.value.eventCountRange.minimum && eventCodes.value.length <= showPolicy.value.eventCountRange.maximum)
const logisticsEventCountValid = computed(() => eventCodes.value.length >= logisticsPolicy.value.eventCountRange.minimum && eventCodes.value.length <= logisticsPolicy.value.eventCountRange.maximum)
const vtlEventCountValid = computed(() => eventCodes.value.length >= vtlPolicy.value.eventCountRange.minimum && eventCodes.value.length <= vtlPolicy.value.eventCountRange.maximum)
const activeEventPolicy = computed(() => sceneType.value === "CITY_SHOW" ? showPolicy.value : sceneType.value === "CITY_LOGISTICS" ? logisticsPolicy.value : vtlPolicy.value)
const showTriggerOptions = computed<Array<{ label: string; value: V3ScenarioEventConfig["triggerMode"] }>>(() => {
  const options: Array<{ label: string; value: V3ScenarioEventConfig["triggerMode"] }> = [
    { label: "自动排程", value: "AUTO" },
    { label: "指定仿真时间", value: "SIMULATION_TIME" },
    { label: "指定运行阶段", value: "PHASE" },
    { label: "随机时间范围", value: "TIME_RANGE" },
    { label: "条件触发", value: "CONDITION" },
    { label: "前一事件触发", value: "AFTER_EVENT" }
  ]
  return sceneType.value === "CITY_SHOW"
    ? options.filter((option) => showPolicy.value.allowedTriggerModes.includes(option.value))
    : sceneType.value === "CITY_LOGISTICS"
      ? options.filter((option) => logisticsPolicy.value.allowedTriggerModes.includes(option.value))
      : options.filter((option) => vtlPolicy.value.allowedTriggerModes.includes(option.value))
})
const impactScopeOptions: Array<{ label: string; value: V3ScenarioEventImpactScope }> = [
  { label: "默认范围", value: "DEFAULT" },
  { label: "单架/单单", value: "SINGLE" },
  { label: "小批量", value: "SMALL_BATCH" },
  { label: "分组", value: "GROUP" },
  { label: "多分组", value: "MULTI_GROUP" },
  { label: "局部区域", value: "LOCAL_AREA" },
  { label: "大部分", value: "MOST" },
  { label: "整体运行", value: "WHOLE" },
  { label: "单条航线", value: "SINGLE_ROUTE" },
  { label: "多条航线", value: "MULTI_ROUTE" },
  { label: "全局运行", value: "OVERALL" }
]

function eventImpactScopeOptions(code: string): Array<{ label: string; value: V3ScenarioEventImpactScope }> {
  if (sceneType.value === "CITY_SHOW") return impactScopeOptions.filter((option) => showPolicy.value.allowedImpactScopes.includes(option.value) || (code === "WEATHER_LIMIT" && option.value === "WHOLE"))
  if (sceneType.value === "CITY_LOGISTICS") return impactScopeOptions.filter((option) => logisticsPolicy.value.allowedImpactScopes.includes(option.value))
  return impactScopeOptions.filter((option) => vtlPolicy.value.allowedImpactScopes.includes(option.value))
}

function showImpactScopeAllowed(code: string, scope: V3ScenarioEventImpactScope): boolean {
  return showPolicy.value.allowedImpactScopes.includes(scope) || (code === "WEATHER_LIMIT" && scope === "WHOLE")
}

const showPlannedDurationMinutes = computed(() => Math.max(1, Math.round((showFlightSchedule.value[1].getTime() - showFlightSchedule.value[0].getTime()) / 60_000)))
const showPositioningOptions = computed<Array<{ label: string; value: ShowPositioningElectromagneticState }>>(() => [
  { label: "正常", value: "NORMAL" },
  ...(showAircraftCount.value >= 500 ? [{ label: "局部较弱", value: "LOCAL_WEAK" } as const] : []),
  ...(showAircraftCount.value >= 1000 ? [{ label: "局部异常", value: "LOCAL_ABNORMAL" } as const] : []),
  ...(showAircraftCount.value >= 3000 ? [{ label: "持续干扰", value: "CONTINUOUS_INTERFERENCE" } as const] : []),
  ...(showAircraftCount.value >= 5000 ? [{ label: "大范围干扰", value: "WIDE_AREA_INTERFERENCE" } as const] : [])
])
const showCommunicationOptions = computed<Array<{ label: string; value: ShowCommunicationControlState }>>(() => [
  { label: "正常", value: "NORMAL" },
  { label: "延迟", value: "DELAY" },
  { label: "丢包", value: "PACKET_LOSS" },
  { label: "单架失联", value: "SINGLE_LOST" },
  ...(showAircraftCount.value >= 500 ? [{ label: "小批量失联", value: "SMALL_BATCH_LOST" } as const] : []),
  ...(showAircraftCount.value >= 1000 ? [{ label: "分组异常", value: "GROUP_ABNORMAL" } as const] : []),
  ...(showAircraftCount.value >= 3000 ? [{ label: "多分组异常", value: "MULTI_GROUP_ABNORMAL" } as const] : [])
])
const showDeviceScopeOptions = computed<Array<{ label: string; value: ShowInitialDeviceScope }>>(() => [
  ...(showDeviceState.value === "NORMAL" ? [{ label: "无", value: "NONE" } as const] : []),
  ...(showDeviceState.value !== "NORMAL" ? [{ label: "单架", value: "SINGLE" } as const] : []),
  ...(showDeviceState.value !== "NORMAL" && showAircraftCount.value >= 500 ? [{ label: "小批量", value: "SMALL_BATCH" } as const] : []),
  ...(showDeviceState.value !== "NORMAL" && showAircraftCount.value >= 1000 ? [{ label: "分组", value: "GROUP" } as const] : []),
  ...(showDeviceState.value !== "NORMAL" && showAircraftCount.value >= 3000 ? [{ label: "多分组", value: "MULTI_GROUP" } as const] : [])
])
const showDeviceAffectedCount = computed(() => showInitialDeviceAffectedCount(showAircraftCount.value, showDeviceState.value, showDeviceImpactScope.value))
const selectedRegion = computed(() => sceneRegions.value.find((region) => region.packageId === regionPackageId.value) ?? null)
const publishedScenarioOverlays = computed(() => publishedScenarioOverlayVersions(scenarioOverlayVersions.value, sceneType.value, regionPackageId.value))
const selectedScenarioOverlay = computed(() => scenarioOverlayVersions.value.find((version) => version.id === scenarioOverlayVersionId.value) ?? null)
const selectedPublishedScenarioOverlay = computed(() => selectedScenarioOverlay.value?.status === "PUBLISHED" ? selectedScenarioOverlay.value : null)
const frozenMapResourceVersion = computed(() => mapResourceVersion(selectedRegion.value))
const frozenSceneResourceVersion = computed(() => scenarioOverlayResourceVersion(selectedPublishedScenarioOverlay.value))
const frozenPlanVersion = computed(() => assignmentPlanVersion(draft.value?.id, draft.value?.revision, preview.value?.configHash))
const vtlTaskObjects = computed(() => selectedRegion.value?.vtlTaskObjects ?? [])
const vtlStageOptions = computed(() => stageDefinitionsFor("VTOL_INSPECTION"))
const vtlRubricOptions = computed<VtlEvaluationItemConfig[]>(() => {
  const report = resources.value.find((resource) => resource.packageType === "REPORT" && Array.isArray(resource.manifest.rubrics) && resource.manifest.rubrics.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).sceneType === "VTOL_INSPECTION"))
  const rubric = Array.isArray(report?.manifest.rubrics)
    ? report.manifest.rubrics.find((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).sceneType === "VTOL_INSPECTION") as Record<string, unknown> | undefined
    : undefined
  const items = Array.isArray(rubric?.items) ? rubric.items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const record = item as Record<string, unknown>
    const code = typeof record.code === "string" ? record.code : ""
    const label = typeof record.label === "string" ? record.label : ""
    const maxScore = Number(record.maxScore)
    return code && label && Number.isFinite(maxScore) ? [{ code, label, maxScore }] : []
  }) : []
  return items.length > 0 ? items : defaultVtlEvaluationItems()
})
const vtlSelectedTaskObjects = computed(() => vtlTaskObjects.value.filter((item) => vtlTaskObjectIds.value.includes(item.id)))
const vtlTaskAreaBoundaryValid = computed(() => vtlTaskAreaBoundary.value.length >= 3 && vtlTaskAreaBoundary.value.every((point) => Number.isFinite(point.longitude) && Number.isFinite(point.latitude)))
const vtlEvaluationTotal = computed(() => vtlEvaluationItems.value.reduce((sum, item) => sum + Number(item.maxScore || 0), 0))
const logisticsDeliveryPoints = computed(() => (selectedRegion.value?.logisticsNodes ?? []).filter((node) => node.type === "DELIVERY_POINT" && node.enabled))
const logisticsCandidatesValid = computed(() => candidateDeliveryPointIds.value.length >= logisticsPolicy.value.deliveryPointRange.minimum
  && candidateDeliveryPointIds.value.length <= logisticsPolicy.value.deliveryPointRange.maximum)
const logisticsConfiguredAircraftCount = computed(() => logisticsUnavailableAircraftCount.value
  + logisticsLowBatteryAircraftCount.value
  + logisticsStandbyAircraftCount.value
  + logisticsPreflightAbnormalAircraftCount.value)
const logisticsSignalOptions = computed<Array<{ label: string; value: LogisticsSignalState }>>(() => [
  { label: "正常", value: "NORMAL" },
  ...(logisticsPolicy.value.totalAircraft >= 5 ? [{ label: "局部较弱", value: "LOCAL_WEAK" } as const] : []),
  ...(logisticsPolicy.value.totalAircraft >= 10 ? [{ label: "局部异常", value: "LOCAL_ABNORMAL" } as const] : []),
  ...(logisticsPolicy.value.totalAircraft >= 20 ? [{ label: "持续异常", value: "CONTINUOUS_ABNORMAL" } as const] : []),
  ...(logisticsPolicy.value.totalAircraft >= 50 ? [{ label: "恢复中", value: "RECOVERING" } as const] : [])
])
const eventOptions = computed(() => sceneType.value === "CITY_SHOW"
  ? [
      { code: "WEATHER_LIMIT", label: "风力接近运行限制" },
      { code: "MOTOR_DEGRADATION", label: "动力性能下降" },
      { code: "POSITIONING_DRIFT", label: "定位漂移" },
      { code: "COMMUNICATION_LOSS", label: "通信链路中断" },
      { code: "BATTERY_ANOMALY", label: "电池状态异常" }
    ]
  : sceneType.value === "CITY_LOGISTICS" ? [
      { code: "DYNAMIC_ORDER", label: "动态新增订单" },
      { code: "ORDER_CANCELLED", label: "订单取消" },
      { code: "ORDER_PRIORITY_CHANGED", label: "订单优先级变化" },
      { code: "NODE_UNAVAILABLE", label: "配送节点不可用" },
      { code: "WEATHER_CHANGE", label: "局地天气变化" },
      { code: "POSITIONING_DEGRADED", label: "定位导航质量下降" },
      { code: "COMMUNICATION_LOSS", label: "通信链路中断" },
      { code: "AIRCRAFT_FAULT", label: "无人机故障" },
      { code: "ROUTE_SUSPENDED", label: "航线运行条件变化" }
    ].filter((event) => logisticsPolicy.value.allowedEventCodes.includes(event.code))
    : [
      { code: "VTL_WEATHER", label: "巡检区域气象恶化" },
      { code: "VTL_POSITIONING", label: "定位质量下降" },
      { code: "VTL_COMMUNICATION", label: "广域通信链路异常" },
      { code: "VTL_ENERGY_POWER", label: "能量或动力余度下降" },
      { code: "VTL_DEVICE", label: "航空器设备异常" },
      { code: "VTL_TRANSITION", label: "模式转换条件异常" },
      { code: "VTL_ROUTE_AREA", label: "航线或区域条件变化" },
      { code: "VTL_TASK_CONDITION", label: "巡检对象条件变化" }
    ].filter((event) => vtlPolicy.value.allowedEventCodes.includes(event.code as never)))

const eventPhaseOptions = computed(() => sceneType.value === "CITY_SHOW"
  ? [
      { value: "TAKEOFF_PREPARATION", label: "起飞准备" },
      { value: "BATCH_TAKEOFF", label: "分批起飞" },
      { value: "TRANSIT_TO_SHOW", label: "前往表演区" },
      { value: "PERFORMANCE", label: "表演运行" },
      { value: "RETURN_TO_LAUNCH", label: "返回起降区" },
      { value: "BATCH_LANDING", label: "分批降落" }
    ]
  : sceneType.value === "CITY_LOGISTICS" ? [
      { value: "PREPARATION", label: "运行前准备" },
      { value: "WAITING_EXECUTION", label: "等待执行" },
      { value: "TAKEOFF", label: "起飞" },
      { value: "OUTBOUND", label: "去程" },
      { value: "ARRIVAL_CONFIRMATION", label: "到达确认" },
      { value: "RETURNING", label: "返程" },
      { value: "LANDING", label: "降落" },
      { value: "AVAILABLE_AGAIN", label: "再次可用" }
    ] : [
      { value: "VERTICAL_TAKEOFF", label: "垂直起飞" },
      { value: "CLIMB", label: "爬升" },
      { value: "FORWARD_TRANSITION", label: "前转换" },
      { value: "FIXED_WING_CRUISE", label: "固定翼巡航" },
      { value: "TASK_EXECUTION", label: "任务执行" },
      { value: "RETURN", label: "返航" },
      { value: "BACK_TRANSITION", label: "后转换" },
      { value: "VERTICAL_LANDING", label: "垂直降落" }
    ])

const configuredEventOptions = computed(() => eventOptions.value.flatMap((option) => {
  const config = eventConfigs.value.find((item) => item.code === option.code)
  return config ? [{ ...option, config }] : []
}))

const canContinue = computed(() => {
  if (step.value === 0) return Boolean(title.value.trim() && projectBackground.value.trim() && taskBrief.value.trim() && completionRequirements.value.trim())
  if (step.value === 1) return Boolean(
    regionPackageId.value
    && scaleTemplateCode.value
    && (!scenarioOverlayVersionId.value || Boolean(selectedPublishedScenarioOverlay.value))
    && !questionBankSelectionInvalid.value
    && (sceneType.value !== "CITY_SHOW" || showProgramCompatible.value)
    && (sceneType.value !== "CITY_LOGISTICS" || logisticsCandidatesValid.value)
  )
  if (step.value === 2 && sceneType.value === "CITY_SHOW") return Boolean(
    showFlightSchedule.value?.length === 2
    && showFlightSchedule.value[0].getTime() < showFlightSchedule.value[1].getTime()
    && showContactName.value.trim()
    && showContactPhone.value.trim()
    && showAircraftModel.value.trim()
    && showAudienceCount.value >= 1
    && showMaximumHeightMeters.value >= 10
    && showMaximumHeightMeters.value <= 500
    && showEventCountValid.value
  )
  if (step.value === 2 && sceneType.value === "VTOL_INSPECTION") return Boolean(
    vtlRuntimeSchedule.value?.length === 2
    && vtlRuntimeSchedule.value[0].getTime() < vtlRuntimeSchedule.value[1].getTime()
    && vtlMainLandingSiteId.value
    && vtlSelectedTaskObjects.value.length >= vtlPolicy.value.taskObjectRange.minimum
    && vtlSelectedTaskObjects.value.length <= vtlPolicy.value.taskObjectRange.maximum
    && vtlTaskAreaBoundaryValid.value
    && selectedRegion.value?.vtlAircraftParameters
    && vtlEventCountValid.value
    && vtlOpenStageCodes.value.length > 0
    && Math.abs(vtlEvaluationTotal.value - 100) < 1e-9
  )
  if (step.value === 2) return (
    logisticsRuntimeSchedule.value?.length === 2
    && logisticsRuntimeSchedule.value[0].getTime() < logisticsRuntimeSchedule.value[1].getTime()
    && logisticsOrderSeed.value.trim().length > 0
    && logisticsOrderCount.value >= logisticsPolicy.value.orderCountRange.minimum
    && logisticsOrderCount.value <= logisticsPolicy.value.orderCountRange.maximum
    && logisticsPolicy.value.allowedReleaseModes.includes(logisticsReleaseMode.value as never)
    && (logisticsReleaseMode.value !== "AT_PHASE" || logisticsPolicy.value.allowedReleasePhases.includes(logisticsReleasePhase.value))
    && logisticsPolicy.value.allowedPriorityProfiles.includes(logisticsPriorityProfile.value)
    && logisticsEventCountValid.value
    && logisticsConfiguredAircraftCount.value <= logisticsPolicy.value.totalAircraft
  )
  if (step.value === 3) return Boolean(
    classroomId.value
    && schedule.value?.length === 2
    && schedule.value[0].getTime() > Date.now()
    && schedule.value[0].getTime() < schedule.value[1].getTime()
    && (targetMode.value === "CLASS" || selectedStudentIds.value.length > 0)
  )
  return false
})

const continueHint = computed(() => {
  if (canContinue.value || step.value >= 4) return ""
  if (step.value === 0) return "请补充任务名称、项目背景、任务说明和完成要求。"
  if (step.value === 1) {
    if (!regionPackageId.value || !scaleTemplateCode.value) return "请选择固定规模模板和预设教学区域。"
    if (questionBankSelectionInvalid.value) return "当前场景任务版本不可用，请重新选择已发布版本或清空绑定。"
    if (sceneType.value === "CITY_SHOW" && !showProgramCompatible.value) return "表演程序与当前机群规模不匹配，请重新选择。"
    if (sceneType.value === "CITY_LOGISTICS" && !logisticsCandidatesValid.value) return "请按模板要求冻结有效配送点。"
  }
  if (step.value === 2) return sceneType.value === "CITY_SHOW"
    ? "请补齐表演时刻、联系人、机型、高度范围和事件数量。"
    : sceneType.value === "CITY_LOGISTICS"
      ? "请补齐运行时段、订单规模、机队条件和事件数量。"
      : "请补齐巡检时段、起降点、任务对象、任务区域、开放步骤和评价权重。"
  if (step.value === 3) return targetMode.value === "STUDENT" && selectedStudentIds.value.length === 0
    ? "请选择至少一名学生，或切换为整班发布。"
    : !classroomId.value
      ? "请选择发布班级。"
      : "请将开放时间设置为晚于当前时间，并确保截止时间晚于开放时间。"
  return "请完成当前步骤的必填配置。"
})

const publishHint = computed(() => {
  if (step.value < 4 || canPublish.value) return ""
  if (!preview.value || !preflight.value) return "请先生成预览并完成发布前检查。"
  if (preflightBlockingChecks.value.length > 0) return `请先修复 ${preflightBlockingChecks.value.length} 项发布检查阻塞项。`
  if (preflightConfirmationChecks.value.length > 0 && !riskConfirmed.value) return "请阅读并确认发布检查中的建议项。"
  return "当前发布条件尚未满足，请重新检查。"
})

async function loadQuestionBanks(signal?: AbortSignal): Promise<QuestionBankSummary[]> {
  questionBankError.value = ""
  try {
    return await api<QuestionBankSummary[]>("/v1/education/question-banks", signal ? { signal } : undefined)
  } catch (error) {
    questionBankError.value = error instanceof Error ? error.message : "场景任务列表加载失败"
    return []
  }
}

async function retryQuestionBanks() {
  loading.value = true
  try {
    questionBanks.value = await loadQuestionBanks()
  } finally {
    loading.value = false
  }
}

watch(() => props.visible, async (visible) => {
  if (!visible) {
    wizardRequest += 1
    wizardAbortController?.abort()
    scenarioOverlayRequest += 1
    scenarioOverlayAbortController?.abort()
    classStudentsRequest += 1
    classStudentsAbortController?.abort()
    clearPreflightHighlight()
    return
  }
  const requestId = ++wizardRequest
  wizardAbortController?.abort()
  const abortController = new AbortController()
  wizardAbortController = abortController
  wizardReady.value = false
  resetForm()
  loading.value = true
  try {
    const [resourceItems, regionItems, scaleItems, classroomItems, questionBankItems] = await Promise.all([
      api<V3ResourcePackageView[]>("/v3/resource-packages", { signal: abortController.signal }),
      api<V3RegionCatalogItem[]>("/v3/resource-packages/regions/catalog", { signal: abortController.signal }),
      api<V3ScaleTemplateCatalogItem[]>("/v3/resource-packages/scale-templates/catalog", { signal: abortController.signal }),
      api<ClassroomSummary[]>("/v1/education/classes", { signal: abortController.signal }),
      loadQuestionBanks(abortController.signal)
    ])
    if (requestId !== wizardRequest) return
    resources.value = resourceItems.filter((item) => item.status === "ACTIVE" && item.manifest.testOnly !== true && (
      item.packageType !== "DOCUMENT_TEMPLATE" || isFormalShowDocumentPackage(item)
    ))
    regions.value = regionItems
    scaleTemplates.value = scaleItems
    classes.value = classroomItems
    questionBanks.value = questionBankItems
    if (props.initialDraftId) await loadExistingDraft(props.initialDraftId, abortController.signal, requestId)
    else applySceneDefaults()
    if (requestId !== wizardRequest) return
    markWizardClean()
    wizardReady.value = true
  } catch (error) {
    if (requestId !== wizardRequest || (error instanceof DOMException && error.name === "AbortError")) return
    ElMessage.error(error instanceof Error ? error.message : "任务向导初始化失败")
  } finally {
    if (requestId === wizardRequest) loading.value = false
  }
}, { immediate: true })

async function confirmClose(): Promise<boolean> {
  if (!hasUnsavedWizardChanges.value || publishing.value) return true
  try {
    await ElMessageBox.confirm(
      "当前任务向导有未保存修改，关闭后这些内容将丢失。确定关闭吗？",
      "放弃未保存修改",
      { type: "warning", confirmButtonText: "关闭并放弃", cancelButtonText: "继续编辑" }
    )
    return true
  } catch {
    return false
  }
}

async function requestClose() {
  if (await confirmClose()) emit("update:visible", false)
}

async function handleBeforeClose(done: () => void) {
  if (await confirmClose()) done()
}

function snapshotWizardState(): string {
  try {
    return JSON.stringify({ title: title.value, config: assignmentConfig() })
  } catch {
    return "invalid"
  }
}

function markWizardClean() {
  wizardSnapshot.value = snapshotWizardState()
}

watch(() => snapshotWizardState(), () => {
  if (hydratingDraft.value || !wizardReady.value) return
  if (!preview.value && !preflight.value) return
  preview.value = null
  preflight.value = null
  riskConfirmed.value = false
  previewProgress.value = null
})

watch(sceneType, () => {
  if (hydratingDraft.value) return
  draft.value = null
  preview.value = null
  applySceneDefaults()
  if (questionBankSelectionInvalid.value) questionBankVersionId.value = ""
  void loadScenarioOverlays()
})

watch(mode, () => {
  if (hydratingDraft.value) return
  draft.value = null
  preview.value = null
  allowResubmission.value = mode.value === "TRAINING"
})

watch(scaleTemplateCode, () => {
  if (hydratingDraft.value) return
  if (sceneType.value === "CITY_SHOW") {
    if (!showProgramCompatible.value) showProgramPackageId.value = null
    if (!showPositioningOptions.value.some((option) => option.value === showPositioningElectromagneticState.value)) showPositioningElectromagneticState.value = "NORMAL"
    if (!showCommunicationOptions.value.some((option) => option.value === showCommunicationControlState.value)) showCommunicationControlState.value = "NORMAL"
    if (!showDeviceScopeOptions.value.some((option) => option.value === showDeviceImpactScope.value)) showDeviceImpactScope.value = showDeviceState.value === "NORMAL" ? "NONE" : "SINGLE"
    sanitizeShowEventConfigs()
    return
  }
  if (sceneType.value === "VTOL_INSPECTION") {
    sanitizeVtlEventConfigs()
    syncVtlTaskObjects()
    syncVtlEvaluationItems()
    return
  }
  if (sceneType.value !== "CITY_LOGISTICS") return
  logisticsOrderCount.value = logisticsPolicy.value.defaultOrderCount
  if (!logisticsPolicy.value.allowedReleaseModes.includes(logisticsReleaseMode.value as never)) logisticsReleaseMode.value = logisticsPolicy.value.allowedReleaseModes[0] ?? "BATCH"
  if (!logisticsPolicy.value.allowedReleasePhases.includes(logisticsReleasePhase.value)) logisticsReleasePhase.value = logisticsPolicy.value.allowedReleasePhases[0] ?? "WAITING_EXECUTION"
  if (!logisticsPolicy.value.allowedPriorityProfiles.includes(logisticsPriorityProfile.value)) logisticsPriorityProfile.value = logisticsPolicy.value.defaultPriorityProfile
  logisticsUnavailableAircraftCount.value = Math.min(logisticsUnavailableAircraftCount.value, logisticsPolicy.value.totalAircraft)
  logisticsLowBatteryAircraftCount.value = Math.min(logisticsLowBatteryAircraftCount.value, Math.max(0, logisticsPolicy.value.totalAircraft - logisticsUnavailableAircraftCount.value))
  logisticsStandbyAircraftCount.value = Math.min(logisticsStandbyAircraftCount.value, Math.max(0, logisticsPolicy.value.totalAircraft - logisticsUnavailableAircraftCount.value - logisticsLowBatteryAircraftCount.value))
  logisticsPreflightAbnormalAircraftCount.value = Math.min(logisticsPreflightAbnormalAircraftCount.value, Math.max(0, logisticsPolicy.value.totalAircraft - logisticsUnavailableAircraftCount.value - logisticsLowBatteryAircraftCount.value - logisticsStandbyAircraftCount.value))
  if (!logisticsSignalOptions.value.some((option) => option.value === logisticsPositioningState.value)) logisticsPositioningState.value = "NORMAL"
  if (!logisticsSignalOptions.value.some((option) => option.value === logisticsCommunicationState.value)) logisticsCommunicationState.value = "NORMAL"
  sanitizeLogisticsEventConfigs()
  syncCandidateDeliveryPoints()
})

watch(showDeviceState, (value) => {
  if (hydratingDraft.value) return
  showDeviceImpactScope.value = value === "NORMAL" ? "NONE" : "SINGLE"
})

watch(regionPackageId, () => {
  void loadScenarioOverlays()
  if (hydratingDraft.value) return
  if (sceneType.value === "CITY_LOGISTICS") {
    candidateDeliveryPointIds.value = []
    syncCandidateDeliveryPoints()
  }
  if (sceneType.value === "VTOL_INSPECTION") {
    vtlMainLandingSiteId.value = selectedRegion.value?.vtlLandingSites?.find((site) => site.type === "MAIN" && site.status === "AVAILABLE")?.id ?? ""
    resetVtlTaskAreaBoundary()
    syncVtlTaskObjects()
    syncVtlEvaluationItems()
  }
})

async function loadScenarioOverlays() {
  const requestId = ++scenarioOverlayRequest
  scenarioOverlayAbortController?.abort()
  const abortController = new AbortController()
  scenarioOverlayAbortController = abortController
  scenarioOverlayLoading.value = Boolean(sceneType.value && regionPackageId.value)
  scenarioOverlayError.value = ""
  scenarioOverlayVersions.value = []
  if (!regionPackageId.value) {
    scenarioOverlayLoading.value = false
    return
  }
  try {
    const versions = await api<V3ScenarioOverlayVersionView[]>(`/v3/scenario-overlays?regionPackageId=${encodeURIComponent(regionPackageId.value)}`, { signal: abortController.signal })
    if (requestId !== scenarioOverlayRequest) return
    scenarioOverlayVersions.value = versions.filter((version) => version.sceneType === sceneType.value && version.regionPackageId === regionPackageId.value)
    if (scenarioOverlayVersionId.value && !scenarioOverlayVersions.value.some((version) => version.id === scenarioOverlayVersionId.value)) scenarioOverlayVersionId.value = ""
  } catch (error) {
    if (requestId !== scenarioOverlayRequest || (error instanceof DOMException && error.name === "AbortError")) return
    scenarioOverlayError.value = error instanceof Error ? error.message : "场景覆盖层版本加载失败"
  } finally {
    if (requestId === scenarioOverlayRequest) scenarioOverlayLoading.value = false
  }
}

watch(classroomId, async (id) => {
  const requestId = ++classStudentsRequest
  classStudentsAbortController?.abort()
  const abortController = new AbortController()
  classStudentsAbortController = abortController
  selectedStudentIds.value = []
  classStudents.value = []
  if (!id) return
  try {
    const loadedStudents = await api<ClassroomStudent[]>(`/v1/education/classes/${id}/students`, { signal: abortController.signal })
    if (requestId === classStudentsRequest && id === classroomId.value) classStudents.value = loadedStudents
  } catch (error) {
    if (requestId !== classStudentsRequest || (error instanceof DOMException && error.name === "AbortError")) return
    ElMessage.error(error instanceof Error ? error.message : "班级学生加载失败")
  }
})

function resetForm() {
  previewProgress.value = null
  step.value = 0
  sceneType.value = props.initialSceneType
  mode.value = "TRAINING"
  title.value = sceneTitle(props.initialSceneType)
  projectBackground.value = ""
  taskBrief.value = ""
  completionRequirements.value = ""
  regionPackageId.value = props.initialRegionId
  scenarioOverlayVersionId.value = ""
  scenarioOverlayVersions.value = []
  scenarioOverlayError.value = ""
  scaleTemplateCode.value = ""
  questionBankVersionId.value = ""
  showProgramPackageId.value = null
  classroomId.value = ""
  targetMode.value = "CLASS"
  selectedStudentIds.value = []
  classStudents.value = []
  schedule.value = defaultAssignmentSchedule()
  showWindDirection.value = "SE"
  showWindForceState.value = "NORMAL"
  showGustState.value = "NONE"
  showRainState.value = "NONE"
  showPositioningElectromagneticState.value = "NORMAL"
  showCommunicationControlState.value = "NORMAL"
  showDeviceState.value = "NORMAL"
  showDeviceImpactScope.value = "NONE"
  eventCodes.value = []
  eventConfigs.value = []
  allowResubmission.value = true
  assessmentDurationMinutes.value = 120
  allowedValidationAttempts.value = 3
  allowedRuntimeAttempts.value = 3
  logisticsOrderCount.value = 20
  logisticsReleaseMode.value = "BATCH"
  logisticsReleasePhase.value = "WAITING_EXECUTION"
  logisticsPriorityProfile.value = "STANDARD_HEAVY"
  logisticsDeliveryDistributionMode.value = "UNIFORM"
  logisticsTimeWindowProfile.value = "NORMAL"
  logisticsOrderSeed.value = newOrderSeed()
  candidateDeliveryPointIds.value = []
  logisticsUnavailableAircraftCount.value = 0
  logisticsLowBatteryAircraftCount.value = 0
  logisticsStandbyAircraftCount.value = 0
  logisticsPreflightAbnormalAircraftCount.value = 0
  logisticsWindDirection.value = "N"
  logisticsWindForceState.value = "NORMAL"
  logisticsGustState.value = "NONE"
  logisticsRainState.value = "NONE"
  logisticsPositioningState.value = "NORMAL"
  logisticsCommunicationState.value = "NORMAL"
  logisticsRuntimeSchedule.value = defaultLogisticsRuntimeSchedule()
  vtlRuntimeSchedule.value = defaultVtlRuntimeSchedule()
  vtlMainLandingSiteId.value = ""
  vtlTaskObjectIds.value = []
  vtlTaskAreaBoundary.value = []
  vtlOpenStageCodes.value = []
  vtlEvaluationItems.value = []
  showFlightSchedule.value = defaultShowFlightSchedule()
  showContactName.value = ""
  showContactPhone.value = ""
  showAircraftModel.value = "教学统一编队无人机"
  showAudienceCount.value = 1000
  showMaximumHeightMeters.value = 120
  draft.value = null
  draftContext.value = ""
  preview.value = null
  preflight.value = null
  riskConfirmed.value = false
}

function applySceneDefaults() {
  if (!title.value || title.value.includes("城市编队") || title.value.includes("城市低空") || title.value.includes("垂起广域")) {
    title.value = sceneTitle(sceneType.value)
  }
  if (!sceneRegions.value.some((region) => region.packageId === regionPackageId.value)) regionPackageId.value = sceneRegions.value[0]?.packageId ?? ""
  scaleTemplateCode.value = scaleOptions.value[0]?.code ?? ""
  // Every built-in scene ships with a reviewed question bank. Attach it to a
  // new assignment by default so students receive the scenario questions as
  // soon as the teacher publishes the task. Teachers can still clear or
  // replace the binding when creating a custom exercise.
  const defaultBank = defaultQuestionBankForScene(questionBanks.value, sceneType.value)
  if (!questionBankVersionId.value || !compatibleQuestionBanks.value.some((bank) => bank.publishedVersionId === questionBankVersionId.value)) {
    questionBankVersionId.value = defaultBank?.publishedVersionId ?? ""
  }
  scenarioOverlayVersionId.value = ""
  showProgramPackageId.value = null
  eventCodes.value = []
  eventConfigs.value = []
  syncCandidateDeliveryPoints()
  if (sceneType.value === "VTOL_INSPECTION") {
    vtlMainLandingSiteId.value = selectedRegion.value?.vtlLandingSites?.find((site) => site.type === "MAIN" && site.status === "AVAILABLE")?.id ?? ""
    resetVtlTaskAreaBoundary()
  }
}

async function loadExistingDraft(id: string, signal?: AbortSignal, requestId?: number) {
  const existing = await api<AssignmentDraftView>(`/v3/assignments/drafts/${id}`, signal ? { signal } : undefined)
  if (requestId !== undefined && requestId !== wizardRequest) return
  if (existing.status !== "DRAFT") throw new Error("只有草稿或已撤回任务可以继续编辑")
  hydratingDraft.value = true
  try {
    draft.value = existing
  draftContext.value = `${existing.sceneType}:${existing.mode}`
    title.value = existing.title
    projectBackground.value = existing.config.showParameters?.projectBackground ?? existing.config.logisticsParameters?.projectBackground ?? existing.config.vtlParameters?.projectBackground ?? existing.config.taskBrief ?? ""
    taskBrief.value = existing.config.taskBrief ?? ""
    completionRequirements.value = existing.config.showParameters?.completionRequirements ?? existing.config.logisticsParameters?.completionRequirements ?? existing.config.vtlParameters?.completionRequirements ?? existing.config.taskBrief ?? ""
    sceneType.value = existing.sceneType
    mode.value = existing.mode
    regionPackageId.value = existing.config.regionPackageId
    scenarioOverlayVersionId.value = existing.config.scenarioOverlayVersionId ?? ""
    scaleTemplateCode.value = existing.config.scaleTemplateCode
    questionBankVersionId.value = existing.config.questionBankVersionId ?? ""
    showProgramPackageId.value = existing.config.showProgramPackageId ?? null
    schedule.value = [new Date(existing.config.availableAt), new Date(existing.config.dueAt)]
    allowResubmission.value = existing.config.allowResubmission
    assessmentDurationMinutes.value = existing.config.assessmentDurationMinutes
    allowedValidationAttempts.value = existing.config.allowedValidationAttempts
    allowedRuntimeAttempts.value = existing.config.allowedRuntimeAttempts
    const scenario = existing.config.scenario
    const showInitialConditions = resolveShowInitialConditions(scenario, showTemplateAircraftCount(existing.config.scaleTemplateCode))
    showWindDirection.value = showInitialConditions.windDirection
    showWindForceState.value = showInitialConditions.windForceState
    showGustState.value = showInitialConditions.gustState
    showRainState.value = showInitialConditions.rainState
    showPositioningElectromagneticState.value = showInitialConditions.positioningElectromagneticState
    showCommunicationControlState.value = showInitialConditions.communicationControlState
    showDeviceState.value = showInitialConditions.deviceState
    showDeviceImpactScope.value = showInitialConditions.deviceImpactScope
    const legacyEventCodes = Array.isArray(scenario.eventCodes) ? scenario.eventCodes.filter((code): code is string => typeof code === "string") : []
    const savedEventConfigs = Array.isArray(scenario.eventConfigs) ? scenario.eventConfigs : legacyEventCodes.map((code) => ({ code }))
    eventConfigs.value = savedEventConfigs.flatMap((value) => normalizeEventConfigForEditor(value))
    eventCodes.value = eventConfigs.value.map((config) => config.code)
    logisticsOrderCount.value = typeof scenario.orderCount === "number" ? scenario.orderCount : 20
    logisticsReleaseMode.value = scenario.orderReleaseMode === "STAGED" || scenario.orderReleaseMode === "DYNAMIC" || scenario.orderReleaseMode === "AT_PHASE" ? scenario.orderReleaseMode : "BATCH"
    logisticsReleasePhase.value = scenario.orderReleasePhase === "PREPARATION" || scenario.orderReleasePhase === "WAITING_EXECUTION" || scenario.orderReleasePhase === "TAKEOFF" || scenario.orderReleasePhase === "OUTBOUND" || scenario.orderReleasePhase === "ARRIVAL_CONFIRMATION" || scenario.orderReleasePhase === "RETURNING" || scenario.orderReleasePhase === "LANDING" ? scenario.orderReleasePhase : "WAITING_EXECUTION"
    logisticsPriorityProfile.value = scenario.priorityProfile === "BALANCED" || scenario.priorityProfile === "URGENT_HEAVY" ? scenario.priorityProfile : "STANDARD_HEAVY"
    if (sceneType.value === "CITY_SHOW") sanitizeShowEventConfigs()
    else if (sceneType.value === "CITY_LOGISTICS") sanitizeLogisticsEventConfigs()
    else sanitizeVtlEventConfigs()
    logisticsDeliveryDistributionMode.value = scenario.deliveryDistributionMode === "FOCUSED" || scenario.deliveryDistributionMode === "MULTI_PEAK" ? scenario.deliveryDistributionMode : "UNIFORM"
    logisticsTimeWindowProfile.value = resolveLogisticsTimeWindowProfile(scenario)
    logisticsOrderSeed.value = typeof scenario.orderSeed === "string" ? scenario.orderSeed : newOrderSeed()
    candidateDeliveryPointIds.value = Array.isArray(scenario.candidateDeliveryPointIds)
      ? scenario.candidateDeliveryPointIds.filter((value): value is string => typeof value === "string")
      : []
    syncCandidateDeliveryPoints()
    const initialFleet = resolveLogisticsInitialFleet(scenario, logisticsPolicy.value.totalAircraft)
    logisticsUnavailableAircraftCount.value = initialFleet.unavailableAircraftCount
    logisticsLowBatteryAircraftCount.value = initialFleet.lowBatteryAircraftCount
    logisticsStandbyAircraftCount.value = initialFleet.standbyAircraftCount
    logisticsPreflightAbnormalAircraftCount.value = initialFleet.preflightAbnormalAircraftCount
    const initialEnvironment = resolveLogisticsInitialEnvironment(scenario)
    logisticsWindDirection.value = initialEnvironment.windDirection
    logisticsWindForceState.value = initialEnvironment.windForceState
    logisticsGustState.value = initialEnvironment.gustState
    logisticsRainState.value = initialEnvironment.rainState
    logisticsPositioningState.value = initialEnvironment.positioningState
    logisticsCommunicationState.value = initialEnvironment.communicationState
    const logisticsStartAt = new Date(existing.config.logisticsParameters?.plannedStartAt ?? existing.config.availableAt)
    const logisticsEndAt = new Date(existing.config.logisticsParameters?.plannedEndAt ?? existing.config.dueAt)
    logisticsRuntimeSchedule.value = Number.isFinite(logisticsStartAt.getTime()) && Number.isFinite(logisticsEndAt.getTime()) && logisticsEndAt > logisticsStartAt
      ? [logisticsStartAt, logisticsEndAt]
      : defaultLogisticsRuntimeSchedule()
    const vtlStartAt = new Date(existing.config.vtlParameters?.plannedStartAt ?? existing.config.availableAt)
    const vtlEndAt = new Date(existing.config.vtlParameters?.plannedEndAt ?? existing.config.dueAt)
    vtlRuntimeSchedule.value = Number.isFinite(vtlStartAt.getTime()) && Number.isFinite(vtlEndAt.getTime()) && vtlEndAt > vtlStartAt
      ? [vtlStartAt, vtlEndAt]
      : defaultVtlRuntimeSchedule()
    vtlMainLandingSiteId.value = existing.config.vtlParameters?.mainLandingSiteId ?? selectedRegion.value?.vtlLandingSites?.find((site) => site.type === "MAIN")?.id ?? ""
    vtlTaskObjectIds.value = existing.config.vtlParameters?.taskObjectIds ? [...existing.config.vtlParameters.taskObjectIds] : []
    vtlTaskAreaBoundary.value = existing.config.vtlParameters?.taskAreaBoundary?.map((point) => ({ ...point })) ?? selectedRegion.value?.boundary.map((point) => ({ ...point })) ?? []
    vtlOpenStageCodes.value = existing.config.vtlParameters?.openStageCodes ? [...existing.config.vtlParameters.openStageCodes] as VtlStageCode[] : []
    vtlEvaluationItems.value = existing.config.vtlParameters?.evaluationItems ? existing.config.vtlParameters.evaluationItems.map((item) => ({ ...item })) : []
    syncVtlTaskObjects()
    syncVtlEvaluationItems()
    const plannedStartAtValue = existing.config.showParameters?.plannedStartAt ?? scenario.plannedFlightStartAt
    const plannedEndAtValue = existing.config.showParameters?.plannedEndAt ?? scenario.plannedFlightEndAt
    const plannedStartAt = typeof plannedStartAtValue === "string" ? new Date(plannedStartAtValue) : null
    const plannedEndAt = typeof plannedEndAtValue === "string" ? new Date(plannedEndAtValue) : null
    showFlightSchedule.value = plannedStartAt && plannedEndAt && Number.isFinite(plannedStartAt.getTime()) && Number.isFinite(plannedEndAt.getTime())
      ? [plannedStartAt, plannedEndAt]
      : defaultShowFlightSchedule()
    showContactName.value = existing.config.showParameters?.contactName ?? (typeof scenario.contactName === "string" ? scenario.contactName : "")
    showContactPhone.value = existing.config.showParameters?.contactPhone ?? (typeof scenario.contactPhone === "string" ? scenario.contactPhone : "")
    showAircraftModel.value = existing.config.showParameters?.aircraftModel ?? (typeof scenario.aircraftModel === "string" ? scenario.aircraftModel : "教学统一编队无人机")
    showAudienceCount.value = existing.config.showParameters?.plannedAudienceCount ?? (typeof scenario.plannedAudienceCount === "number" ? scenario.plannedAudienceCount : 1000)
    showMaximumHeightMeters.value = existing.config.showParameters?.maximumHeightMeters ?? (typeof scenario.maximumHeightMeters === "number" ? scenario.maximumHeightMeters : 120)
  } finally {
    hydratingDraft.value = false
  }
}

async function next() {
  if (!canContinue.value) return
  if (step.value === 3) {
    await preparePreview()
    return
  }
  step.value += 1
}

async function preparePreview() {
  preview.value = null
  preflight.value = null
  previewInvalidationReason.value = ""
  riskConfirmed.value = false
  previewProgress.value = startV3OperationProgress(
    sceneType.value === "CITY_LOGISTICS" ? "订单与任务预览" : "任务预览",
    ["保存发布条件", "执行发布前检查", sceneType.value === "CITY_LOGISTICS" ? "生成订单与任务预览" : "生成任务预览", "汇总预览结果"]
  )
  try {
    const config = assignmentConfig()
    const context = `${sceneType.value}:${mode.value}`
    if (!draft.value || draftContext.value !== context) {
      draft.value = await api<AssignmentDraftView>("/v3/assignments/drafts", {
        method: "POST",
        body: JSON.stringify({ title: title.value, sceneType: sceneType.value, mode: mode.value, config })
      })
      draftContext.value = context
    } else {
      draft.value = await api<AssignmentDraftView>(`/v3/assignments/drafts/${draft.value.id}`, {
        method: "PUT",
        body: JSON.stringify({ expectedRevision: draft.value.revision, title: title.value, config })
      })
    }
    previewProgress.value = advanceV3OperationProgress(previewProgress.value, 1)
    preflight.value = await api<AssignmentPreflightView>(`/v3/assignments/drafts/${draft.value.id}/preflight`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: draft.value.revision,
        targets: assignmentTargets(),
        resourcePackageIds: selectedResourceIds()
      })
    })
    riskConfirmed.value = false
    previewProgress.value = advanceV3OperationProgress(previewProgress.value, 2)
    if (preflight.value.summary.blocking > 0) {
      preview.value = null
      step.value = 4
      markWizardClean()
      previewProgress.value = completeV3OperationProgress(
        previewProgress.value,
        `检查发现 ${preflight.value.summary.blocking} 项必须修复，暂不能发布`
      )
      return
    }
    preview.value = await api<AssignmentPreviewView>(`/v3/assignments/drafts/${draft.value.id}/preview`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: draft.value.revision,
        targets: assignmentTargets(),
        resourcePackageIds: selectedResourceIds()
      })
    })
    previewProgress.value = advanceV3OperationProgress(previewProgress.value, 3)
    step.value = 4
    const orderCount = preview.value.logisticsOrderPreview?.config.orderCount
    previewProgress.value = completeV3OperationProgress(
      previewProgress.value,
      orderCount === undefined
        ? `已生成面向 ${preview.value.studentCount} 名学生的任务预览`
        : `已生成 ${orderCount} 条订单预览，发布后覆盖 ${preview.value.studentCount} 名学生`
    )
    markWizardClean()
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务预览失败"
    previewProgress.value = failV3OperationProgress(previewProgress.value, message)
    ElMessage.error(message)
  }
}

async function publish() {
  if (!draft.value || !preview.value) return
  if (!canPublish.value) {
    ElMessage.warning(preflightBlockingChecks.value.length > 0 ? "请先修复发布检查中的阻塞项" : "请确认发布检查中的建议项")
    return
  }
  publishing.value = true
  try {
    const result = await api<{ snapshot: { id: string }; projectCount: number }>(`/v3/assignments/drafts/${draft.value.id}/publish`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: draft.value.revision,
        configHash: preview.value.configHash,
        targets: assignmentTargets(),
        resourcePackageIds: selectedResourceIds(),
        ...(preflightConfirmationChecks.value.length > 0 ? {
          preflightConfirmation: {
            checkedAt: preflight.value?.checkedAt,
            checkCodes: preflightConfirmationChecks.value.map((check) => check.code)
          }
        } : {})
      })
    })
    ElMessage.success(`任务已发布，并创建 ${result.projectCount} 个学生项目`)
    emit("published", { snapshotId: result.snapshot.id, projectCount: result.projectCount })
    emit("update:visible", false)
  } catch (error) {
    const message = error instanceof Error ? error.message : "任务发布失败"
    if (error instanceof ApiError && shouldInvalidateAssignmentPreview(error.status, message)) {
      preview.value = null
      preflight.value = null
      riskConfirmed.value = false
      previewInvalidationReason.value = "发布时发现任务配置或版本已变化，原预览已作废。请重新生成预览后再发布。"
      if (previewProgress.value) previewProgress.value = failV3OperationProgress(previewProgress.value, previewInvalidationReason.value)
      ElMessage.warning(previewInvalidationReason.value)
    } else {
      ElMessage.error(message)
    }
  } finally {
    publishing.value = false
  }
}

function goToPreflightCheck(check: AssignmentPreflightCheckView) {
  step.value = check.step
  riskConfirmed.value = false
  void nextTick(() => {
    const panel = wizardContent.value?.querySelector<HTMLElement>(".wizard-panel")
    if (!panel) return
    clearPreflightHighlight()
    const selector = assignmentPreflightTargetSelector(check)
    const target = selector ? panel.querySelector<HTMLElement>(selector) : null
    if (!target) {
      panel.tabIndex = -1
      panel.focus({ preventScroll: true })
      panel.scrollTo({ top: 0, behavior: "smooth" })
      ElMessage.warning(`已返回第 ${check.step + 1} 步，但未找到对应配置项。${check.action}`)
      return
    }
    const control = firstPreflightFocusable(target)
    if (control === target && !target.hasAttribute("tabindex")) target.tabIndex = -1
    control.focus({ preventScroll: true })
    target.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" })
    target.classList.add("preflight-focus-target")
    preflightHighlightTimer = setTimeout(() => {
      target.classList.remove("preflight-focus-target")
      preflightHighlightTimer = null
    }, 3200)
  })
}

function goToFirstPreflightCheck() {
  const check = preflightBlockingChecks.value[0] ?? preflightWarningChecks.value[0]
  if (check) goToPreflightCheck(check)
}

function clearPreflightHighlight() {
  if (preflightHighlightTimer) clearTimeout(preflightHighlightTimer)
  preflightHighlightTimer = null
  wizardContent.value?.querySelectorAll(".preflight-focus-target").forEach((element) => element.classList.remove("preflight-focus-target"))
}

onBeforeUnmount(() => {
  clearPreflightHighlight()
  wizardRequest += 1
  wizardAbortController?.abort()
  classStudentsRequest += 1
  classStudentsAbortController?.abort()
})

async function regenerateOrderPreview() {
  logisticsOrderSeed.value = newOrderSeed()
  await preparePreview()
}

function assignmentConfig(): AssignmentDraftConfig {
  return {
    taskBrief: taskBrief.value,
    ...(sceneType.value === "CITY_SHOW" ? {
      showParameters: {
        projectBackground: projectBackground.value,
        completionRequirements: completionRequirements.value,
        plannedStartAt: showFlightSchedule.value[0].toISOString(),
        plannedEndAt: showFlightSchedule.value[1].toISOString(),
        plannedAudienceCount: showAudienceCount.value,
        maximumHeightMeters: showMaximumHeightMeters.value,
        contactName: showContactName.value,
        contactPhone: showContactPhone.value,
        aircraftModel: showAircraftModel.value
      }
    } : {}),
    ...(sceneType.value === "CITY_LOGISTICS" ? {
      logisticsParameters: {
        projectBackground: projectBackground.value,
        completionRequirements: completionRequirements.value,
        plannedStartAt: logisticsRuntimeSchedule.value[0].toISOString(),
        plannedEndAt: logisticsRuntimeSchedule.value[1].toISOString()
      }
    } : {}),
    ...(sceneType.value === "VTOL_INSPECTION" ? {
      vtlParameters: {
        projectBackground: projectBackground.value,
        completionRequirements: completionRequirements.value,
        plannedStartAt: vtlRuntimeSchedule.value[0].toISOString(),
        plannedEndAt: vtlRuntimeSchedule.value[1].toISOString(),
        mainLandingSiteId: vtlMainLandingSiteId.value,
        aircraftModelCode: selectedRegion.value?.vtlAircraftParameters?.modelCode ?? "VTOL-TEACHING-01",
        aircraftParameterVersion: selectedRegion.value?.vtlAircraftParameters?.version ?? "1.0.0",
        taskObjectIds: [...vtlTaskObjectIds.value],
        taskAreaBoundary: vtlTaskAreaBoundary.value.map((point) => ({ ...point })),
        openStageCodes: [...vtlOpenStageCodes.value],
        evaluationItems: vtlEvaluationItems.value.map((item) => ({ ...item }))
      }
    } : {}),
    scaleTemplateCode: scaleTemplateCode.value,
    questionBankVersionId: questionBankVersionId.value || null,
    ...(sceneType.value === "CITY_SHOW" ? { showProgramPackageId: showProgramPackageId.value } : {}),
    regionPackageId: regionPackageId.value,
    ...(scenarioOverlayVersionId.value ? { scenarioOverlayVersionId: scenarioOverlayVersionId.value } : {}),
    availableAt: schedule.value[0].toISOString(),
    dueAt: schedule.value[1].toISOString(),
    assessmentDurationMinutes: assessmentDurationMinutes.value,
    allowResubmission: allowResubmission.value,
    allowedValidationAttempts: allowedValidationAttempts.value,
    allowedRuntimeAttempts: allowedRuntimeAttempts.value,
    resultVisibility: mode.value === "TRAINING" ? "FULL_REVIEW" : "TOTAL_ONLY",
    scenario: {
      eventCodes: eventCodes.value,
      eventConfigs: eventConfigs.value.map((config) => ({ ...config })),
      ...(sceneType.value === "CITY_SHOW" ? {
        simulationClockRate: 60,
        simulationStartLeadMinutes: 75,
        showInitialConditions: {
          windDirection: showWindDirection.value,
          windForceState: showWindForceState.value,
          gustState: showGustState.value,
          rainState: showRainState.value,
          positioningElectromagneticState: showPositioningElectromagneticState.value,
          communicationControlState: showCommunicationControlState.value,
          deviceState: showDeviceState.value,
          deviceImpactScope: showDeviceImpactScope.value
        }
      } : {}),
      ...(sceneType.value === "CITY_LOGISTICS" ? {
        orderCount: logisticsOrderCount.value,
        orderReleaseMode: logisticsReleaseMode.value,
        orderReleasePhase: logisticsReleaseMode.value === "AT_PHASE" ? logisticsReleasePhase.value : null,
        priorityProfile: logisticsPriorityProfile.value,
        deliveryDistributionMode: logisticsDeliveryDistributionMode.value,
        candidateDeliveryPointIds: [...candidateDeliveryPointIds.value],
        timeWindowProfile: logisticsTimeWindowProfile.value,
        orderSeed: logisticsOrderSeed.value.trim(),
        initialUnavailableAircraftCount: logisticsUnavailableAircraftCount.value,
        initialLowBatteryAircraftCount: logisticsLowBatteryAircraftCount.value,
        initialStandbyAircraftCount: logisticsStandbyAircraftCount.value,
        initialPreflightAbnormalAircraftCount: logisticsPreflightAbnormalAircraftCount.value,
        initialWindDirection: logisticsWindDirection.value,
        initialWindForceState: logisticsWindForceState.value,
        initialGustState: logisticsGustState.value,
        initialRainState: logisticsRainState.value,
        initialPositioningState: logisticsPositioningState.value,
        initialCommunicationState: logisticsCommunicationState.value
      } : {})
    }
  }
}

function syncCandidateDeliveryPoints() {
  if (sceneType.value !== "CITY_LOGISTICS") return
  const availableIds = logisticsDeliveryPoints.value.map((node) => node.id)
  const availableSet = new Set(availableIds)
  const retained = candidateDeliveryPointIds.value.filter((id) => availableSet.has(id)).slice(0, logisticsPolicy.value.deliveryPointRange.maximum)
  if (retained.length >= logisticsPolicy.value.deliveryPointRange.minimum) {
    candidateDeliveryPointIds.value = retained
    return
  }
  candidateDeliveryPointIds.value = availableIds.slice(0, logisticsPolicy.value.deliveryPointRange.maximum)
}

function syncVtlTaskObjects() {
  if (sceneType.value !== "VTOL_INSPECTION") return
  const availableIds = vtlTaskObjects.value.map((item) => item.id)
  const availableSet = new Set(availableIds)
  const retained = vtlTaskObjectIds.value.filter((id) => availableSet.has(id)).slice(0, vtlPolicy.value.taskObjectRange.maximum)
  vtlTaskObjectIds.value = retained.length >= vtlPolicy.value.taskObjectRange.minimum
    ? retained
    : availableIds.slice(0, vtlPolicy.value.defaultTaskObjectCount)
  if (vtlOpenStageCodes.value.length === 0) vtlOpenStageCodes.value = [...vtlStageCodes]
}

function resetVtlTaskAreaBoundary() {
  vtlTaskAreaBoundary.value = selectedRegion.value?.boundary.map((point) => ({ ...point })) ?? []
}

function addVtlTaskAreaVertex() {
  const last = vtlTaskAreaBoundary.value.at(-1) ?? selectedRegion.value?.center
  if (!last) return
  vtlTaskAreaBoundary.value = [...vtlTaskAreaBoundary.value, {
    longitude: last.longitude + 0.0002,
    latitude: last.latitude + 0.0002,
    ...(last.altitudeMeters === undefined ? {} : { altitudeMeters: last.altitudeMeters })
  }]
}

function removeVtlTaskAreaVertex(index: number) {
  if (vtlTaskAreaBoundary.value.length <= 3) return
  vtlTaskAreaBoundary.value = vtlTaskAreaBoundary.value.filter((_, pointIndex) => pointIndex !== index)
}

function syncVtlEvaluationItems() {
  if (sceneType.value !== "VTOL_INSPECTION") return
  const available = vtlRubricOptions.value
  const current = vtlEvaluationItems.value
  if (current.length > 0 && Math.abs(current.reduce((sum, item) => sum + Number(item.maxScore || 0), 0) - 100) < 1e-9) return
  vtlEvaluationItems.value = available.map((item) => ({ ...item }))
}

function normalizeVtlOpenStages() {
  vtlOpenStageCodes.value = normalizeVtlStageSelection(vtlOpenStageCodes.value, vtlStageCodes)
}

function toggleVtlEvaluationItem(item: VtlEvaluationItemConfig) {
  const index = vtlEvaluationItems.value.findIndex((selected) => selected.code === item.code)
  if (index >= 0) {
    vtlEvaluationItems.value = vtlEvaluationItems.value.filter((selected) => selected.code !== item.code)
    return
  }
  vtlEvaluationItems.value = [...vtlEvaluationItems.value, { ...item }]
}

function vtlEvaluationScore(code: string): number {
  return vtlEvaluationItems.value.find((item) => item.code === code)?.maxScore ?? 0
}

function setVtlEvaluationScore(code: string, value: number | undefined) {
  const score = Number(value)
  vtlEvaluationItems.value = vtlEvaluationItems.value.map((item) => item.code === code ? { ...item, maxScore: Number.isFinite(score) ? score : item.maxScore } : item)
}

function deliveryPointName(id: string) {
  return logisticsDeliveryPoints.value.find((node) => node.id === id)?.name ?? id
}

function logisticsPriorityLabel(value: string) {
  return value === "URGENT" ? "紧急" : value === "PRIORITY" ? "优先" : "普通"
}

function minuteLabel(value: number) {
  return value === 0 ? "任务开始" : `第 ${value} 分钟`
}

function logisticsReleaseModeLabel(value: LogisticsOrderReleaseMode) {
  return ({ BATCH: "一次性释放", STAGED: "分批释放", DYNAMIC: "运行中动态新增", AT_PHASE: "指定阶段释放" } as const)[value]
}

function logisticsReleasePhaseLabel(value: LogisticsOrderReleasePhase) {
  return ({ PREPARATION: "运行前准备", WAITING_EXECUTION: "等待执行", TAKEOFF: "起飞", OUTBOUND: "去程", ARRIVAL_CONFIRMATION: "到达确认", RETURNING: "返程", LANDING: "降落" } as const)[value]
}

function logisticsPriorityProfileLabel(value: LogisticsPriorityProfile) {
  return ({ STANDARD_HEAVY: "普通订单为主", BALANCED: "多级均衡分布", URGENT_HEAVY: "高优先级偏多" } as const)[value]
}

function assignmentTargets(): AssignmentTargetInput[] {
  return targetMode.value === "CLASS"
    ? [{ type: "CLASS", targetId: classroomId.value }]
    : selectedStudentIds.value.map((targetId) => ({ type: "STUDENT", targetId }))
}

function selectedResourceIds() {
  const documentPackageId = resources.value
    .filter((resource) => resource.packageType === "DOCUMENT_TEMPLATE" && isFormalShowDocumentPackage(resource))
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))[0]?.id
  const reportPackageId = resources.value
    .filter((resource) => resource.packageType === "REPORT" && reportSupportsScene(resource, sceneType.value))
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }) || left.name.localeCompare(right.name, "zh-CN"))[0]?.id
  return resources.value.filter((resource) => {
    if (resource.packageType === "REGION") return resource.id === regionPackageId.value
    if (resource.packageType === "SCALE_TEMPLATE" || resource.packageType === "EVENT") return resource.manifest.sceneType === sceneType.value
    if (resource.packageType === "SHOW_PROGRAM") return sceneType.value === "CITY_SHOW" && resource.id === showProgramPackageId.value
    if (resource.packageType === "DOCUMENT_TEMPLATE") return sceneType.value === "CITY_SHOW" && resource.id === documentPackageId
    if (resource.packageType === "REPORT") return resource.id === reportPackageId
    return resource.packageType === "RULE" || resource.packageType === "AIRCRAFT"
  }).map((resource) => resource.id)
}

function isShowProgramManifest(value: unknown): value is ShowProgramManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const manifest = value as Partial<ShowProgramManifest>
  return manifest.sceneType === "CITY_SHOW"
    && manifest.format === "LOCAL_ENU_CSV_V1"
    && typeof manifest.aircraftCount === "number"
    && typeof manifest.durationMs === "number"
    && typeof manifest.maximumAltitudeMeters === "number"
}

function reportSupportsScene(resource: V3ResourcePackageView, targetScene: SceneType) {
  const rubrics = resource.manifest.rubrics
  if (!Array.isArray(rubrics)) return true
  return rubrics.some((value) => value && typeof value === "object" && !Array.isArray(value) && value.sceneType === targetScene)
}

function isFormalShowDocumentPackage(resource: V3ResourcePackageView) {
  if (resource.source !== "SIGNED_ARCHIVE" || !resource.archiveAsset || !resource.archiveManifest || !resource.validation.passed) return false
  if (resource.archiveManifest.packageType !== "DOCUMENT_TEMPLATE" || resource.archiveManifest.content.sceneType !== "CITY_SHOW") return false
  const documents = resource.archiveManifest.content.documents
  if (!Array.isArray(documents) || documents.length !== 3) return false
  const requiredCodes = new Set(["AIRSPACE_APPLICATION_FORM", "AIRSPACE_APPLICATION_LETTER", "SAFETY_EMERGENCY_PLAN"])
  const declaredFiles = new Map(resource.archiveManifest.files.map((file) => [file.path, file]))
  for (const value of documents) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const document = value as Record<string, unknown>
    if (typeof document.code !== "string" || !requiredCodes.delete(document.code) || typeof document.path !== "string") return false
    const file = declaredFiles.get(document.path)
    if (!file || file.role !== document.code || file.mimeType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return false
  }
  return requiredCodes.size === 0
}

function toggleEvent(code: string) {
  if (eventCodes.value.includes(code)) {
    eventCodes.value = eventCodes.value.filter((item) => item !== code)
    eventConfigs.value = eventConfigs.value.filter((config) => config.code !== code)
    return
  }
  const maximum = activeEventPolicy.value.eventCountRange.maximum
  if (eventCodes.value.length >= maximum) {
    ElMessage.warning(`当前模板最多配置 ${maximum} 个事件`)
    return
  }
  eventCodes.value = [...eventCodes.value, code]
  eventConfigs.value = [...eventConfigs.value, defaultEventConfig(code)]
}

function defaultEventConfig(code: string): V3ScenarioEventConfig {
  return {
    code,
    eventSubtype: sceneType.value === "CITY_LOGISTICS" ? defaultLogisticsEventSubtype(code) : null,
    triggerMode: sceneType.value === "CITY_SHOW" ? "PHASE" : "AUTO",
    triggerTimeSeconds: null,
    triggerPhase: sceneType.value === "CITY_SHOW" ? "PERFORMANCE" : sceneType.value === "CITY_LOGISTICS" ? "OUTBOUND" : "TASK_EXECUTION",
    triggerOffsetSeconds: 0,
    severity: null,
    detectionDelaySeconds: null,
    escalationDelaySeconds: null,
    durationSeconds: null,
    recoveryMode: "STUDENT",
    triggerWindowSeconds: null,
    triggerCondition: null,
    triggerAfterEventCode: null,
    impactScope: "DEFAULT",
    impactCount: null,
    targetIds: [],
    visibilityMode: "AFTER_STATE_CHANGE",
    escalationEnabled: activeEventPolicy.value.escalationEnabled,
    followUpEventCode: null,
    recoveryCondition: null,
    actionDeadlineSeconds: null
  }
}

function normalizeEventConfigForEditor(value: unknown): V3ScenarioEventConfig[] {
  const record = typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : { code: value }
  if (typeof record.code !== "string" || !record.code.trim()) return []
  const base = defaultEventConfig(record.code.trim())
  return [{
    ...base,
    eventSubtype: sceneType.value === "CITY_LOGISTICS" && isLogisticsEventSubtypeAllowed(record.code.trim(), record.eventSubtype)
      ? record.eventSubtype
      : base.eventSubtype ?? null,
    triggerMode: record.triggerMode === "SIMULATION_TIME" || record.triggerMode === "PHASE" || record.triggerMode === "TIME_RANGE" || record.triggerMode === "CONDITION" || record.triggerMode === "AFTER_EVENT" || record.triggerMode === "AUTO" ? record.triggerMode : base.triggerMode,
    triggerTimeSeconds: optionalEditorNumber(record.triggerTimeSeconds),
    triggerPhase: typeof record.triggerPhase === "string" && record.triggerPhase ? record.triggerPhase : base.triggerPhase,
    triggerOffsetSeconds: editorNumber(record.triggerOffsetSeconds, 0),
    severity: record.severity === "INFO" || record.severity === "WARNING" || record.severity === "ERROR" || record.severity === "CRITICAL" ? record.severity : null,
    detectionDelaySeconds: optionalEditorNumber(record.detectionDelaySeconds),
    escalationDelaySeconds: optionalEditorNumber(record.escalationDelaySeconds),
    durationSeconds: optionalEditorNumber(record.durationSeconds),
    recoveryMode: record.recoveryMode === "AUTO" || record.recoveryMode === "CONDITION" || record.recoveryMode === "UNTIL_END" ? record.recoveryMode : "STUDENT",
    triggerWindowSeconds: editorWindow(record.triggerWindowSeconds),
    triggerCondition: editorCondition(record.triggerCondition),
    triggerAfterEventCode: typeof record.triggerAfterEventCode === "string" && record.triggerAfterEventCode ? record.triggerAfterEventCode : null,
    impactScope: isImpactScope(record.impactScope) ? record.impactScope : "DEFAULT",
    impactCount: optionalEditorNumber(record.impactCount),
    targetIds: Array.isArray(record.targetIds) ? record.targetIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [],
    visibilityMode: record.visibilityMode === "DIRECT" || record.visibilityMode === "PARTIAL_DELAY" || record.visibilityMode === "AFTER_STATE_CHANGE" ? record.visibilityMode : "AFTER_STATE_CHANGE",
    escalationEnabled: record.escalationEnabled !== false,
    followUpEventCode: typeof record.followUpEventCode === "string" && record.followUpEventCode ? record.followUpEventCode : null,
    recoveryCondition: editorCondition(record.recoveryCondition),
    actionDeadlineSeconds: optionalEditorNumber(record.actionDeadlineSeconds)
  }]
}

function editorWindow(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  return [editorNumber(value[0], 0), editorNumber(value[1], 0)]
}

function editorCondition(value: unknown): V3ScenarioEventCondition | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const type = ["PHASE", "SIMULATION_TIME", "MIN_AIRBORNE_AIRCRAFT", "MIN_ACTIVE_ORDERS", "ROUTE_STATUS", "EVENT_STATUS"].includes(String(record.type))
    ? record.type as V3ScenarioEventCondition["type"]
    : null
  if (!type) return null
  const operator = record.operator === "GTE" || record.operator === "LTE" ? record.operator : "EQ"
  return { type, operator, value: typeof record.value === "number" || typeof record.value === "string" ? record.value : type === "PHASE" ? "PERFORMANCE" : 0, targetId: typeof record.targetId === "string" ? record.targetId : null }
}

function isImpactScope(value: unknown): value is V3ScenarioEventImpactScope {
  return ["DEFAULT", "SINGLE", "SMALL_BATCH", "GROUP", "MULTI_GROUP", "LOCAL_AREA", "MOST", "WHOLE", "SINGLE_ROUTE", "MULTI_ROUTE", "OVERALL"].includes(String(value))
}

function optionalEditorNumber(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : editorNumber(value, 0)
}

function onRecoveryModeChange(config: V3ScenarioEventConfig) {
  if (config.recoveryMode === "AUTO" && config.durationSeconds === null) config.durationSeconds = 60
  if (config.recoveryMode === "CONDITION" && !config.recoveryCondition) config.recoveryCondition = { type: "PHASE", operator: "GTE", value: sceneType.value === "CITY_SHOW" ? "BATCH_LANDING" : sceneType.value === "CITY_LOGISTICS" ? "LANDING" : "RETURN", targetId: null }
}

function onTriggerModeChange(config: V3ScenarioEventConfig) {
  if (config.triggerMode === "TIME_RANGE" && !config.triggerWindowSeconds) config.triggerWindowSeconds = [120, 300]
  if (config.triggerMode === "CONDITION" && !config.triggerCondition) config.triggerCondition = { type: "PHASE", operator: "GTE", value: sceneType.value === "CITY_SHOW" ? "PERFORMANCE" : sceneType.value === "CITY_LOGISTICS" ? "OUTBOUND" : "TASK_EXECUTION", targetId: null }
}

function eventImpactCountMaximum(config: V3ScenarioEventConfig): number {
  if (sceneType.value === "CITY_SHOW") return showMaximumEventImpactCount(showPolicy.value.totalAircraft, config.impactScope ?? "DEFAULT")
  const totalAircraft = sceneType.value === "CITY_LOGISTICS" ? logisticsPolicy.value.totalAircraft : vtlPolicy.value.totalAircraft
  const scope = config.impactScope ?? "DEFAULT"
  if (scope === "SINGLE" || scope === "SINGLE_ROUTE") return 1
  if (scope === "SMALL_BATCH") return Math.min(5, Math.max(2, Math.ceil(totalAircraft * 0.2)))
  if (scope === "GROUP") return Math.max(2, Math.ceil(totalAircraft * 0.25))
  if (scope === "MULTI_ROUTE") return 3
  if (scope === "OVERALL" || scope === "WHOLE") return totalAircraft
  return Math.max(1, Math.ceil(totalAircraft * 0.4))
}

function logisticsEventSubtypeOptions(eventCode: string) {
  return logisticsEventSubtypeDefinitions(eventCode).filter((item) => logisticsPolicy.value.allowedEventSubtypes.includes(item.code))
}

function configuredLogisticsEventSummary(): string {
  return eventConfigs.value.map((config) => logisticsEventSubtypeLabel(config.eventSubtype) ?? eventOptions.value.find((item) => item.code === config.code)?.label ?? config.code).join("、")
}

function sanitizeShowEventConfigs() {
  const allowedCodes = new Set(eventCodes.value.slice(0, showPolicy.value.eventCountRange.maximum))
  eventCodes.value = eventCodes.value.filter((code) => allowedCodes.has(code))
  eventConfigs.value = eventConfigs.value.filter((config) => allowedCodes.has(config.code)).map((config) => {
    if (!showPolicy.value.allowedTriggerModes.includes(config.triggerMode)) config.triggerMode = "PHASE"
    const scope = config.impactScope ?? "DEFAULT"
    if (!showImpactScopeAllowed(config.code, scope)) config.impactScope = "DEFAULT"
    if (!showPolicy.value.escalationEnabled) {
      config.escalationEnabled = false
      config.escalationDelaySeconds = null
    }
    if (!showPolicy.value.eventLinksEnabled) {
      config.triggerAfterEventCode = null
      config.followUpEventCode = null
    }
    if (!showPolicy.value.partialVisibilityEnabled && config.visibilityMode === "PARTIAL_DELAY") config.visibilityMode = "AFTER_STATE_CHANGE"
    if (config.impactCount !== null && config.impactCount !== undefined) {
      config.impactCount = Math.min(config.impactCount, showMaximumEventImpactCount(showPolicy.value.totalAircraft, config.impactScope ?? "DEFAULT"))
    }
    return config
  })
}

function sanitizeLogisticsEventConfigs() {
  const allowedPolicyCodes = new Set(logisticsPolicy.value.allowedEventCodes)
  const retainedCodes = eventCodes.value.filter((code) => allowedPolicyCodes.has(code)).slice(0, logisticsPolicy.value.eventCountRange.maximum)
  const retainedSet = new Set(retainedCodes)
  eventCodes.value = retainedCodes
  eventConfigs.value = eventConfigs.value.filter((config) => retainedSet.has(config.code)).map((config) => {
    const subtypeOptions = logisticsEventSubtypeOptions(config.code)
    if (subtypeOptions.length > 0 && !subtypeOptions.some((item) => item.code === config.eventSubtype)) config.eventSubtype = subtypeOptions[0]!.code
    if (subtypeOptions.length === 0) config.eventSubtype = null
    if (!logisticsPolicy.value.allowedTriggerModes.includes(config.triggerMode)) config.triggerMode = "AUTO"
    if (!logisticsPolicy.value.allowedImpactScopes.includes(config.impactScope ?? "DEFAULT")) config.impactScope = "DEFAULT"
    if (!logisticsPolicy.value.escalationEnabled) {
      config.escalationEnabled = false
      config.escalationDelaySeconds = null
    }
    if (!logisticsPolicy.value.eventLinksEnabled) {
      config.triggerAfterEventCode = null
      config.followUpEventCode = null
    } else {
      if (config.triggerAfterEventCode && !retainedSet.has(config.triggerAfterEventCode)) config.triggerAfterEventCode = null
      if (config.followUpEventCode && !retainedSet.has(config.followUpEventCode)) config.followUpEventCode = null
    }
    if (!logisticsPolicy.value.partialVisibilityEnabled && config.visibilityMode === "PARTIAL_DELAY") config.visibilityMode = "AFTER_STATE_CHANGE"
    if (config.impactCount !== null && config.impactCount !== undefined) config.impactCount = Math.min(config.impactCount, eventImpactCountMaximum(config))
    return config
  })
}

function sanitizeVtlEventConfigs() {
  const allowedCodes = new Set<string>(vtlPolicy.value.allowedEventCodes)
  const retainedCodes = eventCodes.value.filter((code) => allowedCodes.has(code)).slice(0, vtlPolicy.value.eventCountRange.maximum)
  const retainedSet = new Set(retainedCodes)
  eventCodes.value = retainedCodes
  eventConfigs.value = eventConfigs.value.filter((config) => retainedSet.has(config.code)).map((config) => {
    config.eventSubtype = null
    if (!vtlPolicy.value.allowedTriggerModes.includes(config.triggerMode)) config.triggerMode = "AUTO"
    if (!vtlPolicy.value.allowedImpactScopes.includes(config.impactScope ?? "DEFAULT")) config.impactScope = "DEFAULT"
    if (!vtlPolicy.value.escalationEnabled) {
      config.escalationEnabled = false
      config.escalationDelaySeconds = null
    }
    if (!vtlPolicy.value.eventLinksEnabled) {
      config.triggerAfterEventCode = null
      config.followUpEventCode = null
    } else {
      if (config.triggerAfterEventCode && !retainedSet.has(config.triggerAfterEventCode)) config.triggerAfterEventCode = null
      if (config.followUpEventCode && !retainedSet.has(config.followUpEventCode)) config.followUpEventCode = null
    }
    if (!vtlPolicy.value.partialVisibilityEnabled && config.visibilityMode === "PARTIAL_DELAY") config.visibilityMode = "AFTER_STATE_CHANGE"
    if (config.impactCount !== null && config.impactCount !== undefined) config.impactCount = Math.min(config.impactCount, eventImpactCountMaximum(config))
    return config
  })
}

function editorNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback
}

function regionTitle() {
  return regions.value.find((region) => region.packageId === regionPackageId.value)?.title ?? "未选择"
}

function defaultVtlEvaluationItems(): VtlEvaluationItemConfig[] {
  return [
    { code: "AREA_ALLOCATION", label: "任务区与对象分配", maxScore: 15 },
    { code: "ROUTE_PROFILE", label: "航线、转换与地形剖面", maxScore: 20 },
    { code: "ENERGY_DECISION", label: "能量与备降判断", maxScore: 15 },
    { code: "EXECUTION_PLAN", label: "检查与执行计划", maxScore: 15 },
    { code: "RUNTIME_MONITORING", label: "三级态势与运行观察", maxScore: 15 },
    { code: "EMERGENCY_REORGANIZATION", label: "事件处置与集群重组", maxScore: 10 },
    { code: "REVIEW_QUALITY", label: "巡检总结质量", maxScore: 10 }
  ]
}

function defaultAssignmentSchedule(): [Date, Date] {
  const now = Date.now()
  return [new Date(now + 30 * 60_000), new Date(now + 7 * 86_400_000)]
}

function defaultShowFlightSchedule(): [Date, Date] {
  const start = new Date()
  start.setDate(start.getDate() + 1)
  start.setHours(20, 0, 0, 0)
  return [start, new Date(start.getTime() + 30 * 60_000)]
}

function defaultLogisticsRuntimeSchedule(): [Date, Date] {
  const start = new Date()
  start.setDate(start.getDate() + 1)
  start.setHours(9, 0, 0, 0)
  return [start, new Date(start.getTime() + 8 * 60 * 60_000)]
}

function defaultVtlRuntimeSchedule(): [Date, Date] {
  const start = new Date()
  start.setDate(start.getDate() + 1)
  start.setHours(8, 30, 0, 0)
  return [start, new Date(start.getTime() + 4 * 60 * 60_000)]
}

function sceneTitle(type: SceneType) {
  if (type === "CITY_SHOW") return "城市编队表演综合训练"
  if (type === "CITY_LOGISTICS") return "城市低空物流调度训练"
  return "垂起广域巡检综合训练"
}

function sceneLabel(type: SceneType) {
  return v3SceneLabel(type)
}

function environmentDiagnosticLabel(status: string) {
  return status === "READY" ? "结构完整" : status === "INCOMPLETE" ? "待正式验收" : "未提供"
}

function newOrderSeed() {
  return `ORDER-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
}

function className() {
  const classroomName = classes.value.find((classroom) => classroom.id === classroomId.value)?.name ?? "未选择"
  return targetMode.value === "CLASS" ? classroomName : `${classroomName}内指定 ${selectedStudentIds.value.length} 人`
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    width="min(980px, calc(100vw - 36px))"
    class="v3-assignment-dialog"
    :close-on-click-modal="false"
    destroy-on-close
    :before-close="handleBeforeClose"
    @opened="emit('opened')"
  >
    <template #header>
      <div class="wizard-dialog-title"><span>{{ initialDraftId ? 'V3 教师任务编辑向导' : 'V3 教师任务创建向导' }}</span><strong>{{ title || '新建实训任务' }}</strong></div>
    </template>
    <div class="assignment-wizard" v-loading="loading">
      <ol class="wizard-steps" aria-label="任务创建步骤">
        <li v-for="(label, index) in steps" :key="label" :class="{ active: step === index, complete: step > index }" :aria-current="step === index ? 'step' : undefined" :aria-label="`${index + 1}. ${label}${step === index ? '，当前步骤' : step > index ? '，已完成' : ''}`">
          <span><el-icon v-if="step > index"><Check /></el-icon><template v-else>{{ index + 1 }}</template></span><strong>{{ label }}</strong>
        </li>
      </ol>
      <div ref="wizardContent" class="wizard-content">
        <V3OperationProgress :state="previewProgress" />

        <section v-if="step === 0" class="wizard-panel">
        <header><span>01</span><div><h2>选择场景与教学模式</h2><p>模式和场景将冻结到发布快照，发布后不可变更。</p></div></header>
        <el-form label-position="top">
          <el-form-item label="任务名称" data-preflight-target="task-title"><el-input v-model="title" aria-label="任务名称" maxlength="160" /></el-form-item>
          <el-form-item label="项目背景"><el-input v-model="projectBackground" type="textarea" :rows="2" maxlength="2000" show-word-limit :placeholder="sceneType === 'CITY_SHOW' ? '说明活动背景、项目条件和教学情境' : sceneType === 'CITY_LOGISTICS' ? '说明物流业务背景、教学情境和运行区域条件' : '说明广域巡检背景、任务对象和地形条件'" /></el-form-item>
          <el-form-item label="任务说明"><el-input v-model="taskBrief" type="textarea" :rows="2" maxlength="2000" show-word-limit placeholder="说明学生需要完成的主要任务" /></el-form-item>
          <el-form-item label="完成要求"><el-input v-model="completionRequirements" type="textarea" :rows="2" maxlength="2000" show-word-limit placeholder="明确成果、流程节点和提交要求" /></el-form-item>
        </el-form>
        <div class="wizard-choice-grid">
          <button type="button" :class="{ active: sceneType === 'CITY_SHOW' }" :aria-pressed="sceneType === 'CITY_SHOW'" @click="sceneType = 'CITY_SHOW'"><span>SHOW</span><strong>城市编队表演</strong><small>区域规划、飞行申报、运行报备与异常处置</small></button>
          <button type="button" :class="{ active: sceneType === 'CITY_LOGISTICS' }" :aria-pressed="sceneType === 'CITY_LOGISTICS'" @click="sceneType = 'CITY_LOGISTICS'"><span>LOGISTICS</span><strong>城市低空物流</strong><small>航线验证、订单调度、配送运行与应急重排</small></button>
          <button type="button" :class="{ active: sceneType === 'VTOL_INSPECTION' }" :aria-pressed="sceneType === 'VTOL_INSPECTION'" @click="sceneType = 'VTOL_INSPECTION'"><span>VTOL</span><strong>垂起广域巡检</strong><small>任务分区、八阶段航线、能量管理与动态重组</small></button>
        </div>
        <div class="wizard-choice-grid mode-grid">
          <button type="button" :class="{ active: mode === 'TRAINING' }" :aria-pressed="mode === 'TRAINING'" @click="mode = 'TRAINING'"><strong>训练模式</strong><small>开放完整反馈，允许按发布策略退回与补交。</small></button>
          <button type="button" :class="{ active: mode === 'ASSESSMENT' }" :aria-pressed="mode === 'ASSESSMENT'" @click="mode = 'ASSESSMENT'"><strong>考核模式</strong><small>限制过程反馈，结果范围和重试次数严格冻结。</small></button>
        </div>
      </section>

      <section v-else-if="step === 1" class="wizard-panel">
        <header><span>02</span><div><h2>固定规模与预设区域</h2><p>只能选择已启用、与当前场景兼容的资源版本。</p></div></header>
        <div class="wizard-form-grid">
          <el-form-item label="固定规模模板" data-preflight-target="scale-template"><el-select v-model="scaleTemplateCode" aria-label="固定规模模板"><el-option v-for="option in scaleOptions" :key="option.code" :label="option.label" :value="option.code" /></el-select></el-form-item>
          <el-form-item label="预设区域" data-preflight-target="region"><el-select v-model="regionPackageId" aria-label="预设区域"><el-option v-for="region in sceneRegions" :key="region.packageId" :label="`${region.title} · ${formatHeightDatum(region.heightDatum)}`" :value="region.packageId" /></el-select><el-button class="wizard-region-link" text size="small" @click="emit('open-regions')">没有合适区域？去预设区域管理</el-button></el-form-item>
          <el-form-item label="场景覆盖层版本">
            <el-select v-model="scenarioOverlayVersionId" aria-label="场景覆盖层版本" clearable filterable :loading="scenarioOverlayLoading" :disabled="!regionPackageId" placeholder="不绑定覆盖层">
              <el-option v-for="overlay in publishedScenarioOverlays" :key="overlay.id" :label="`${overlay.title} · V${overlay.versionNo}`" :value="overlay.id">
                <span>{{ overlay.title }} · V{{ overlay.versionNo }}</span><small class="overlay-option-meta">{{ overlay.objects.length }} 个对象 · {{ overlay.checksum.slice(0, 10) }}</small>
              </el-option>
            </el-select>
            <small class="field-note">仅显示当前场景和区域的已发布版本；发布后场景版本将冻结。</small>
          </el-form-item>
          <el-form-item v-if="sceneType === 'CITY_SHOW'" label="表演程序" data-preflight-target="show-program">
            <el-select v-model="showProgramPackageId" aria-label="表演程序" clearable placeholder="使用平台内置固定程序">
              <el-option
                v-for="program in showPrograms"
                :key="program.id"
                :label="`${program.name} · ${program.version} · ${program.manifest.aircraftCount} 架`"
                :value="program.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="方案任务规则（可选）" data-preflight-target="question-bank">
            <el-select v-model="questionBankVersionId" aria-label="方案任务规则" clearable filterable placeholder="不绑定任务规则">
              <el-option
                v-for="bank in compatibleQuestionBanks"
                :key="bank.publishedVersionId ?? bank.id"
                :label="`${bank.title} · V${bank.publishedVersion?.version ?? bank.currentVersion} · ${bank.publishedVersion?.questionCount ?? bank.questionCount} 项`"
                :value="bank.publishedVersionId ?? ''"
              />
            </el-select>
          </el-form-item>
        </div>
        <div v-if="scenarioOverlayError" class="wizard-inline-warning"><el-icon><WarningFilled /></el-icon><span>覆盖层版本暂时无法加载：{{ scenarioOverlayError }}。可重新选择区域或稍后重新打开任务向导。</span><el-button text size="small" :loading="scenarioOverlayLoading" @click="loadScenarioOverlays">重新加载</el-button></div>
        <div v-else-if="scenarioOverlayVersionId && !selectedPublishedScenarioOverlay" class="wizard-inline-warning"><el-icon><WarningFilled /></el-icon><span>当前绑定的覆盖层版本已不可用于新发布，请选择当前已发布版本或清空绑定。</span></div>
        <div v-else-if="regionPackageId && !scenarioOverlayLoading && publishedScenarioOverlays.length === 0" class="wizard-inline-warning"><el-icon><InfoFilled /></el-icon><span>当前区域暂无已发布场景覆盖层，任务仍可使用基础区域资源。</span></div>
        <div class="wizard-resource-dependencies" data-preflight-target="resource-dependencies" tabindex="-1">
          <strong>发布资源依赖</strong>
          <span>当前场景自动匹配 {{ selectedResourceIds().length }} 个已启用资源包</span>
          <small>缺少规则、机型、事件或评价量表时，需由管理员在资源管理中激活对应资源后重新检查。</small>
        </div>
        <div v-if="questionBankError" class="wizard-inline-warning"><el-icon><WarningFilled /></el-icon><span>场景任务列表暂时不可用：{{ questionBankError }}。不绑定任务规则仍可继续创建任务。</span><el-button text size="small" :loading="loading" @click="retryQuestionBanks">重新加载场景任务</el-button></div>
        <div v-else-if="questionBankSelectionInvalid" class="wizard-inline-warning"><el-icon><WarningFilled /></el-icon><span>当前任务绑定的场景任务版本不可用，请重新选择已发布版本或清空任务规则绑定。</span></div>
        <div v-else-if="selectedQuestionBank" class="wizard-region-summary question-bank-summary">
          <strong>{{ selectedQuestionBank.title }} · V{{ selectedQuestionBank.publishedVersion?.version ?? selectedQuestionBank.currentVersion }}</strong>
          <span>学生将在项目工作区提交 {{ selectedQuestionBank.publishedVersion?.questionCount ?? selectedQuestionBank.questionCount }} 项方案要求，仿真指标由服务端计算。</span>
          <small>场景任务版本将在发布快照中固化，发布后不可替换。</small>
        </div>
        <div v-if="sceneRegions.find((region) => region.packageId === regionPackageId)" class="wizard-region-summary" data-preflight-target="map-resource" tabindex="-1">
          <strong>{{ regionTitle() }}</strong>
          <span>{{ sceneRegions.find((region) => region.packageId === regionPackageId)?.summary }}</span>
          <small>DEM {{ sceneRegions.find((region) => region.packageId === regionPackageId)?.terrain?.version ?? sceneRegions.find((region) => region.packageId === regionPackageId)?.terrainResourceVersion }} · {{ sceneRegions.find((region) => region.packageId === regionPackageId)?.terrain ? '区域包已声明 DEM（需正式资源验收）' : '教学起伏地形（非正式 DEM）' }} · {{ formatCoordinateReference('WGS84') }} · {{ sceneRegions.find((region) => region.packageId === regionPackageId)?.layers.length }} 类专题图层</small>
        </div>
        <div v-if="sceneType === 'CITY_SHOW'" class="logistics-template-policy show-template-policy">
          <span>{{ showPolicy.scaleClass === 'SMALL' ? '小型' : showPolicy.scaleClass === 'MEDIUM' ? '中型' : '大型' }} · {{ showPolicy.totalAircraft }} 架</span>
          <span>{{ showPlannedDurationMinutes }} 分钟计划时段</span>
          <span>{{ selectedScaleTemplate?.defaultGroupCount ?? showPolicy.defaultGroupCount }} 个默认分组</span>
          <span>{{ showPolicy.eventCountRange.minimum }}-{{ showPolicy.eventCountRange.maximum }} 个事件 · 同时 {{ showPolicy.maximumConcurrentEvents }} 个</span>
          <strong>处置层级：{{ showPolicy.responseLevels.join('、') }}</strong>
        </div>
        <div v-if="sceneType === 'CITY_SHOW' && selectedShowProgram" class="wizard-region-summary" :class="{ 'program-incompatible': !showProgramCompatible }">
          <strong>{{ selectedShowProgram.name }} · v{{ selectedShowProgram.version }}</strong>
          <span>来源：{{ selectedShowProgram.manifest.sourceSoftware }} · {{ selectedShowProgram.manifest.keyframeCount }} 个关键时刻</span>
          <small>时长 {{ Math.round(selectedShowProgram.manifest.durationMs / 1000) }} 秒 · 最大高度 {{ selectedShowProgram.manifest.maximumAltitudeMeters }} m · 水平半径 {{ selectedShowProgram.manifest.horizontalRadiusMeters }} m</small>
          <small v-if="!showProgramCompatible">程序机群规模与当前固定规模模板不一致，请更换模板或程序。</small>
        </div>
        <div v-if="sceneType === 'CITY_LOGISTICS'" class="logistics-template-overview">
          <div class="logistics-template-policy">
            <span>{{ logisticsPolicy.learningStageLabel }}</span>
            <span>{{ logisticsPolicy.parallelOperationLabel }}</span>
            <span>{{ logisticsPolicy.deliveryPointRange.minimum }}-{{ logisticsPolicy.deliveryPointRange.maximum }} 个配送点 · {{ logisticsPolicy.orderCountRange.minimum }}-{{ logisticsPolicy.orderCountRange.maximum }} 单</span>
            <span>{{ logisticsPolicy.eventLevelLabel }} · 同时 {{ logisticsPolicy.maximumConcurrentEvents }} 个</span>
            <strong>{{ logisticsPolicy.batchReschedulingEnabled ? '开放批量重调度' : '单项调度处置' }}{{ logisticsPolicy.globalReschedulingEnabled ? ' · 开放全局重调度' : '' }}</strong>
          </div>
          <small>成果：{{ logisticsPolicy.expectedDeliverables.join('、') }}</small>
        </div>
        <div v-if="sceneType === 'VTOL_INSPECTION'" class="logistics-template-overview">
          <div class="logistics-template-policy">
            <span>{{ vtlPolicy.totalAircraft }} 架垂起固定翼</span>
            <span>{{ vtlPolicy.taskObjectRange.minimum }}-{{ vtlPolicy.taskObjectRange.maximum }} 个巡检对象</span>
            <span>{{ vtlPolicy.defaultGroupCount }} 个默认分组</span>
            <span>{{ vtlPolicy.situationLevels.map((level) => level === 'OVERALL' ? '总体' : level === 'GROUP' ? '分组' : '单架').join(' / ') }}态势</span>
            <strong>{{ vtlPolicy.batchPlanningEnabled ? '开放批量规划' : '单机逐项规划' }}{{ vtlPolicy.groupAllocationEnabled ? ' · 开放组级任务调整' : '' }}</strong>
          </div>
          <small>成果：{{ vtlPolicy.expectedDeliverables.join('、') }}</small>
        </div>
        <div v-if="sceneType === 'CITY_LOGISTICS'" class="candidate-point-selector" data-preflight-target="logistics-candidate-points" tabindex="-1">
          <header><div><strong>冻结候选配送点</strong><small>学生只能在本次发布冻结的范围内确认正式配送点</small></div><span :class="{ invalid: !logisticsCandidatesValid }">{{ candidateDeliveryPointIds.length }} / {{ logisticsPolicy.deliveryPointRange.minimum }}-{{ logisticsPolicy.deliveryPointRange.maximum }}</span></header>
          <el-checkbox-group v-model="candidateDeliveryPointIds" :max="logisticsPolicy.deliveryPointRange.maximum">
            <el-checkbox v-for="node in logisticsDeliveryPoints" :key="node.id" :value="node.id">
              <span><strong>{{ node.name }}</strong><small>{{ node.code }}</small></span>
            </el-checkbox>
          </el-checkbox-group>
          <div v-if="logisticsDeliveryPoints.length === 0" class="compact-empty">当前区域没有可用配送点，不能发布物流任务。</div>
        </div>
      </section>

      <section v-else-if="step === 2" class="wizard-panel">
        <header><span>03</span><div><h2>场景变量与事件</h2><p>选择教学条件和系统模拟事件，学生不能修改原始条件。</p></div></header>
        <div v-if="sceneType === 'CITY_SHOW'" class="wizard-logistics-config">
          <strong>表演计划与报备联系人</strong>
          <el-form-item label="计划起止时间" data-preflight-target="show-schedule"><el-date-picker v-model="showFlightSchedule" type="datetimerange" range-separator="至" start-placeholder="计划起飞" end-placeholder="计划结束" /></el-form-item>
          <div class="wizard-form-grid">
            <el-form-item label="无人机型号"><el-input v-model="showAircraftModel" maxlength="80" /></el-form-item>
            <el-form-item label="联系人"><el-input v-model="showContactName" maxlength="80" /></el-form-item>
            <el-form-item label="联系电话"><el-input v-model="showContactPhone" maxlength="40" /></el-form-item>
            <el-form-item label="计划观众数量"><el-input-number v-model="showAudienceCount" :min="1" :max="1000000" :step="100" /></el-form-item>
            <el-form-item label="最大飞行高度（m）"><el-input-number v-model="showMaximumHeightMeters" :min="10" :max="500" /></el-form-item>
          </div>
          <div class="logistics-condition-group">
            <header><span>初始气象</span><small>教师选择状态，安全阈值由规则包维护</small></header>
            <div class="wizard-form-grid compact-grid">
              <el-form-item label="风向"><el-select v-model="showWindDirection"><el-option label="北风" value="N" /><el-option label="东北风" value="NE" /><el-option label="东风" value="E" /><el-option label="东南风" value="SE" /><el-option label="南风" value="S" /><el-option label="西南风" value="SW" /><el-option label="西风" value="W" /><el-option label="西北风" value="NW" /></el-select></el-form-item>
              <el-form-item label="风力状态"><el-select v-model="showWindForceState"><el-option label="正常" value="NORMAL" /><el-option label="接近限制" value="NEAR_LIMIT" /><el-option label="超过限制" value="OVER_LIMIT" /></el-select></el-form-item>
              <el-form-item label="阵风"><el-select v-model="showGustState"><el-option label="无" value="NONE" /><el-option label="偶发" value="OCCASIONAL" /><el-option label="持续" value="CONTINUOUS" /></el-select></el-form-item>
              <el-form-item label="降雨"><el-select v-model="showRainState"><el-option label="无" value="NONE" /><el-option label="低于限制" value="BELOW_LIMIT" /><el-option label="超过限制" value="OVER_LIMIT" /></el-select></el-form-item>
            </div>
          </div>
          <div class="logistics-condition-group">
            <header><span>技术环境与设备</span><small>{{ showAircraftCount }} 架模板开放范围</small></header>
            <div class="wizard-form-grid compact-grid">
              <el-form-item label="定位与电磁"><el-select v-model="showPositioningElectromagneticState"><el-option v-for="option in showPositioningOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
              <el-form-item label="通信与控制"><el-select v-model="showCommunicationControlState"><el-option v-for="option in showCommunicationOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
              <el-form-item label="设备状态"><el-select v-model="showDeviceState"><el-option label="正常" value="NORMAL" /><el-option label="自检失败" value="SELF_TEST_FAILURE" /><el-option label="电池异常" value="BATTERY_ABNORMAL" /><el-option label="电压压差异常" value="VOLTAGE_IMBALANCE" /><el-option label="动力系统异常" value="POWER_SYSTEM_ABNORMAL" /><el-option label="飞控/传感器异常" value="FLIGHT_CONTROL_SENSOR_ABNORMAL" /><el-option label="返航或降落异常" value="RETURN_LANDING_ABNORMAL" /></el-select></el-form-item>
              <el-form-item label="设备影响范围"><el-select v-model="showDeviceImpactScope"><el-option v-for="option in showDeviceScopeOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
            </div>
            <small v-if="showDeviceState !== 'NORMAL'" class="order-seed-note">当前范围确定性影响 {{ showDeviceAffectedCount }} 架；无人机能力参数不可由教师修改。</small>
          </div>
        </div>
        <div v-if="sceneType === 'VTOL_INSPECTION'" class="wizard-logistics-config">
          <strong>巡检运行与机型条件</strong>
          <el-form-item label="计划巡检时段" data-preflight-target="vtl-runtime-schedule"><el-date-picker v-model="vtlRuntimeSchedule" type="datetimerange" range-separator="至" start-placeholder="计划开始" end-placeholder="计划结束" /></el-form-item>
          <div class="wizard-form-grid">
            <el-form-item label="主起降点" data-preflight-target="vtl-main-landing-site"><el-select v-model="vtlMainLandingSiteId"><el-option v-for="site in selectedRegion?.vtlLandingSites?.filter((item) => item.type === 'MAIN' && item.status === 'AVAILABLE') ?? []" :key="site.id" :label="`${site.title} · ${site.elevationMeters} m`" :value="site.id" /></el-select></el-form-item>
            <el-form-item label="统一教学机型"><el-input :model-value="selectedRegion?.vtlAircraftParameters?.modelCode ?? '资源未加载'" disabled /></el-form-item>
            <el-form-item label="参数版本"><el-input :model-value="selectedRegion?.vtlAircraftParameters?.version ?? '-'" disabled /></el-form-item>
            <el-form-item label="电池容量"><el-input :model-value="`${selectedRegion?.vtlAircraftParameters?.batteryCapacityWh ?? 0} Wh`" disabled /></el-form-item>
            <el-form-item label="最低转换高度"><el-input :model-value="`${selectedRegion?.vtlAircraftParameters?.minimumTransitionHeightMeters ?? 0} m`" disabled /></el-form-item>
            <el-form-item label="巡航速度"><el-input :model-value="`${selectedRegion?.vtlAircraftParameters?.cruiseSpeedMps ?? 0} m/s`" disabled /></el-form-item>
          </div>
          <div class="logistics-condition-group" data-preflight-target="vtl-task-objects" tabindex="-1">
            <header><span>教师配置任务对象</span><small>当前模板要求 {{ vtlPolicy.taskObjectRange.minimum }}-{{ vtlPolicy.taskObjectRange.maximum }} 个，发布后冻结</small></header>
            <el-checkbox-group v-model="vtlTaskObjectIds" class="vtl-object-picker" :min="vtlPolicy.taskObjectRange.minimum" :max="vtlPolicy.taskObjectRange.maximum">
              <el-checkbox v-for="item in vtlTaskObjects" :key="item.id" :value="item.id">
                <span><strong>{{ item.code }} · {{ item.title }}</strong><small>{{ formatVtlTaskType(item.type) }} · {{ item.estimatedWorkSeconds }} 秒 · {{ item.requirement }}</small></span>
              </el-checkbox>
            </el-checkbox-group>
            <div class="wizard-form-grid compact-grid"><div><strong>{{ vtlSelectedTaskObjects.length }}</strong><small>已选任务对象</small></div><div><strong>{{ selectedRegion?.vtlLandingSites?.filter((site) => site.type === 'ALTERNATE' && site.status === 'AVAILABLE').length ?? 0 }}</strong><small>可用备降点</small></div></div>
          </div>
          <div class="logistics-condition-group" data-preflight-target="vtl-task-area" tabindex="-1">
            <header><span>教师配置任务区域</span><small :class="{ invalid: !vtlTaskAreaBoundaryValid }">{{ vtlTaskAreaBoundary.length }} 个顶点 · 发布后冻结</small></header>
            <div class="vtl-boundary-editor">
              <div v-for="(point, index) in vtlTaskAreaBoundary" :key="index" class="vtl-boundary-row">
                <strong>P{{ index + 1 }}</strong>
                <el-input-number v-model="point.longitude" :precision="6" :step="0.0001" controls-position="right" />
                <el-input-number v-model="point.latitude" :precision="6" :step="0.0001" controls-position="right" />
                <el-button text type="danger" :disabled="vtlTaskAreaBoundary.length <= 3" @click="removeVtlTaskAreaVertex(index)">删除</el-button>
              </div>
              <div class="vtl-boundary-actions">
                <el-button size="small" @click="resetVtlTaskAreaBoundary">恢复预设区域</el-button>
                <el-button size="small" type="primary" @click="addVtlTaskAreaVertex">增加顶点</el-button>
              </div>
            </div>
          </div>
          <div class="logistics-condition-group" data-preflight-target="vtl-open-stages" tabindex="-1">
            <header><span>开放步骤</span><small>按教学顺序连续开放，取消某一步会同时关闭后续步骤</small></header>
            <el-checkbox-group v-model="vtlOpenStageCodes" class="vtl-stage-picker" @change="normalizeVtlOpenStages">
              <el-checkbox v-for="stageItem in vtlStageOptions" :key="stageItem.code" :value="stageItem.code">{{ stageItem.title }}</el-checkbox>
            </el-checkbox-group>
          </div>
          <div class="logistics-condition-group" data-preflight-target="vtl-evaluation-items" tabindex="-1">
            <header><span>评价项目与分值</span><small :class="{ invalid: Math.abs(vtlEvaluationTotal - 100) > 1e-9 }">总分 {{ vtlEvaluationTotal.toFixed(1) }} / 100</small></header>
            <div class="vtl-rubric-picker">
              <div v-for="item in vtlRubricOptions" :key="item.code" class="vtl-rubric-row">
                <el-checkbox :model-value="vtlEvaluationItems.some((selected) => selected.code === item.code)" @change="toggleVtlEvaluationItem(item)">
                  <span><strong>{{ item.label }}</strong><small>{{ item.code }}</small></span>
                </el-checkbox>
                <el-input-number v-if="vtlEvaluationItems.some((selected) => selected.code === item.code)" :model-value="vtlEvaluationScore(item.code)" :min="0.1" :max="100" :step="0.5" controls-position="right" @change="setVtlEvaluationScore(item.code, $event)" />
              </div>
            </div>
          </div>
        </div>
        <div class="event-selector" data-preflight-target="scenario-events" tabindex="-1">
          <button v-for="event in eventOptions" :key="event.code" type="button" :class="{ active: eventCodes.includes(event.code) }" :aria-pressed="eventCodes.includes(event.code)" :aria-label="`${event.label}，${eventCodes.includes(event.code) ? '已启用' : '未启用'}`" :disabled="!eventCodes.includes(event.code) && eventCodes.length >= activeEventPolicy.eventCountRange.maximum" @click="toggleEvent(event.code)"><span>{{ eventCodes.includes(event.code) ? '已启用' : '未启用' }}</span><strong>{{ event.label }}</strong></button>
        </div>
        <small v-if="sceneType === 'CITY_SHOW'" class="event-policy-note" :class="{ invalid: !showEventCountValid }">当前模板需配置 {{ showPolicy.eventCountRange.minimum }}-{{ showPolicy.eventCountRange.maximum }} 个事件，运行时最多同时激活 {{ showPolicy.maximumConcurrentEvents }} 个。</small>
        <small v-else-if="sceneType === 'CITY_LOGISTICS'" class="event-policy-note" :class="{ invalid: !logisticsEventCountValid }">{{ logisticsPolicy.eventCountRange.maximum === 0 ? '当前模板不注入运行事件，仅保留飞前条件。' : `当前模板可配置 ${logisticsPolicy.eventCountRange.minimum}-${logisticsPolicy.eventCountRange.maximum} 个事件，运行时最多同时激活 ${logisticsPolicy.maximumConcurrentEvents} 个。` }}</small>
        <small v-else class="event-policy-note" :class="{ invalid: !vtlEventCountValid }">当前模板需配置 {{ vtlPolicy.eventCountRange.minimum }}-{{ vtlPolicy.eventCountRange.maximum }} 个事件，运行时最多同时激活 {{ vtlPolicy.maximumConcurrentEvents }} 个。</small>
        <small class="event-policy-note" :class="{ locked: mode === 'ASSESSMENT' }">{{ mode === 'ASSESSMENT' ? '考核模式：发布后事件脚本、触发条件和风险反馈锁定；运行中按任务规则执行。' : '训练模式：教师可在运行中按权限调整事件触发和处置策略。' }}</small>
        <div v-if="configuredEventOptions.length" class="event-config-list">
          <article v-for="event in configuredEventOptions" :key="event.code" class="event-config-card">
            <header>
              <div><strong>{{ event.label }}</strong><small>{{ event.config.recoveryMode === 'AUTO' ? '到时自动恢复' : '等待学生处置' }}</small></div>
              <el-button text type="danger" @click="toggleEvent(event.code)">移除</el-button>
            </header>
            <div class="event-config-grid">
              <el-form-item v-if="sceneType === 'CITY_LOGISTICS' && logisticsEventSubtypeOptions(event.code).length" label="教学事件细分"><el-select v-model="event.config.eventSubtype"><el-option v-for="option in logisticsEventSubtypeOptions(event.code)" :key="option.code" :label="option.label" :value="option.code" /></el-select></el-form-item>
              <el-form-item label="触发方式"><el-select v-model="event.config.triggerMode" @change="onTriggerModeChange(event.config)"><el-option v-for="option in showTriggerOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
              <el-form-item v-if="event.config.triggerMode === 'SIMULATION_TIME'" label="触发时间（秒）"><el-input-number v-model="event.config.triggerTimeSeconds" :min="0" :max="86400" /></el-form-item>
              <el-form-item v-else-if="event.config.triggerMode === 'PHASE'" label="触发阶段"><el-select v-model="event.config.triggerPhase"><el-option v-for="phase in eventPhaseOptions" :key="phase.value" :label="phase.label" :value="phase.value" /></el-select></el-form-item>
              <el-form-item v-if="event.config.triggerMode === 'PHASE'" label="阶段偏移（秒）"><el-input-number v-model="event.config.triggerOffsetSeconds" :min="0" :max="3600" /></el-form-item>
              <template v-if="event.config.triggerMode === 'TIME_RANGE' && event.config.triggerWindowSeconds">
                <el-form-item label="随机起点（秒）"><el-input-number v-model="event.config.triggerWindowSeconds[0]" :min="0" :max="86400" /></el-form-item>
                <el-form-item label="随机终点（秒）"><el-input-number v-model="event.config.triggerWindowSeconds[1]" :min="0" :max="86400" /></el-form-item>
              </template>
              <el-form-item v-if="event.config.triggerMode === 'AFTER_EVENT'" label="前置事件"><el-select v-model="event.config.triggerAfterEventCode"><el-option v-for="candidate in eventCodes.filter((code) => code !== event.code)" :key="candidate" :label="eventOptions.find((item) => item.code === candidate)?.label ?? candidate" :value="candidate" /></el-select></el-form-item>
              <template v-if="event.config.triggerMode === 'CONDITION' && event.config.triggerCondition">
                <el-form-item label="条件类型"><el-select v-model="event.config.triggerCondition.type"><el-option label="运行阶段" value="PHASE" /><el-option label="仿真时间" value="SIMULATION_TIME" /><el-option label="空中无人机数量" value="MIN_AIRBORNE_AIRCRAFT" /><el-option label="活动订单数量" value="MIN_ACTIVE_ORDERS" /><el-option label="航线状态" value="ROUTE_STATUS" /><el-option label="事件状态" value="EVENT_STATUS" /></el-select></el-form-item>
                <el-form-item label="条件值"><el-input v-model="event.config.triggerCondition.value" /></el-form-item>
                <el-form-item label="判断关系"><el-select v-model="event.config.triggerCondition.operator"><el-option label="等于" value="EQ" /><el-option label="大于等于" value="GTE" /><el-option label="小于等于" value="LTE" /></el-select></el-form-item>
              </template>
              <el-form-item label="初始告警等级"><el-select v-model="event.config.severity"><el-option label="跟随事件默认" :value="null" /><el-option label="提示" value="INFO" /><el-option label="警告" value="WARNING" /><el-option label="错误" value="ERROR" /><el-option label="严重" value="CRITICAL" /></el-select></el-form-item>
              <el-form-item label="发现延迟（秒）"><el-input-number v-model="event.config.detectionDelaySeconds" :min="0" :max="3600" /></el-form-item>
              <el-form-item v-if="activeEventPolicy.escalationEnabled" label="升级延迟（秒）"><el-input-number v-model="event.config.escalationDelaySeconds" :min="0" :max="86400" /></el-form-item>
              <el-form-item label="持续时间（秒）"><el-input-number v-model="event.config.durationSeconds" :min="1" :max="86400" /></el-form-item>
              <el-form-item label="影响范围"><el-select v-model="event.config.impactScope"><el-option v-for="option in eventImpactScopeOptions(event.code)" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
              <el-form-item label="影响数量"><el-input-number v-model="event.config.impactCount" :min="1" :max="eventImpactCountMaximum(event.config)" /></el-form-item>
              <el-form-item label="信息可见性"><el-select v-model="event.config.visibilityMode"><el-option label="状态变化后告警" value="AFTER_STATE_CHANGE" /><el-option label="直接告警" value="DIRECT" /><el-option v-if="activeEventPolicy.partialVisibilityEnabled" label="部分信息延迟" value="PARTIAL_DELAY" /></el-select></el-form-item>
              <el-form-item v-if="activeEventPolicy.escalationEnabled" label="允许升级"><el-switch v-model="event.config.escalationEnabled" /></el-form-item>
              <el-form-item label="处置时限（秒）"><el-input-number v-model="event.config.actionDeadlineSeconds" :min="1" :max="86400" /></el-form-item>
              <el-form-item label="恢复方式"><el-select v-model="event.config.recoveryMode" @change="onRecoveryModeChange(event.config)"><el-option label="学生处置后恢复" value="STUDENT" /><el-option label="持续时间到期自动恢复" value="AUTO" /><el-option label="满足条件后恢复" value="CONDITION" /><el-option label="持续至任务结束" value="UNTIL_END" /></el-select></el-form-item>
              <template v-if="event.config.recoveryMode === 'CONDITION' && event.config.recoveryCondition">
                <el-form-item label="恢复条件"><el-input v-model="event.config.recoveryCondition.value" /></el-form-item>
              </template>
              <el-form-item v-if="activeEventPolicy.eventLinksEnabled" label="后续事件"><el-select v-model="event.config.followUpEventCode" clearable><el-option v-for="candidate in eventCodes.filter((code) => code !== event.code)" :key="candidate" :label="eventOptions.find((item) => item.code === candidate)?.label ?? candidate" :value="candidate" /></el-select></el-form-item>
            </div>
          </article>
        </div>
        <div v-if="sceneType === 'CITY_LOGISTICS'" class="wizard-logistics-config">
          <strong>订单生成条件</strong>
          <el-form-item label="计划运行时段" data-preflight-target="logistics-runtime-schedule"><el-date-picker v-model="logisticsRuntimeSchedule" type="datetimerange" range-separator="至" start-placeholder="计划运行开始" end-placeholder="计划运行结束" /></el-form-item>
          <div class="logistics-template-policy">
            <span>{{ logisticsPolicy.totalAircraft }} 架无人机</span>
            <span>{{ logisticsPolicy.orderCountRange.minimum }}-{{ logisticsPolicy.orderCountRange.maximum }} 单</span>
            <span>{{ logisticsPolicy.deliveryPointRange.minimum }}-{{ logisticsPolicy.deliveryPointRange.maximum }} 个配送点</span>
            <span>{{ logisticsPolicy.eventLevelLabel }}</span>
            <strong>{{ logisticsPolicy.parallelOperationLabel }}</strong>
          </div>
          <div class="wizard-form-grid" data-preflight-target="logistics-order-config" tabindex="-1">
            <el-form-item label="订单数量"><el-input-number v-model="logisticsOrderCount" :min="logisticsPolicy.orderCountRange.minimum" :max="logisticsPolicy.orderCountRange.maximum" /></el-form-item>
            <el-form-item label="时间窗口"><el-select v-model="logisticsTimeWindowProfile"><el-option label="不设明确时限" value="NONE" /><el-option label="宽松" value="RELAXED" /><el-option label="一般" value="NORMAL" /><el-option label="紧张" value="TIGHT" /><el-option label="混合时间窗口" value="MIXED" /></el-select></el-form-item>
            <el-form-item label="释放方式"><el-select v-model="logisticsReleaseMode"><el-option v-if="logisticsPolicy.allowedReleaseModes.includes('BATCH')" label="一次性释放" value="BATCH" /><el-option v-if="logisticsPolicy.allowedReleaseModes.includes('STAGED')" label="分批释放" value="STAGED" /><el-option v-if="logisticsPolicy.allowedReleaseModes.includes('DYNAMIC')" label="运行中动态新增" value="DYNAMIC" /><el-option v-if="logisticsPolicy.allowedReleaseModes.includes('AT_PHASE')" label="指定阶段释放" value="AT_PHASE" /></el-select></el-form-item>
            <el-form-item v-if="logisticsReleaseMode === 'AT_PHASE'" label="订单释放阶段"><el-select v-model="logisticsReleasePhase"><el-option v-for="phase in eventPhaseOptions.filter((item) => logisticsPolicy.allowedReleasePhases.includes(item.value as LogisticsOrderReleasePhase))" :key="phase.value" :label="phase.label" :value="phase.value" /></el-select></el-form-item>
            <el-form-item label="优先级结构"><el-select v-model="logisticsPriorityProfile"><el-option v-if="logisticsPolicy.allowedPriorityProfiles.includes('STANDARD_HEAVY')" label="普通订单为主" value="STANDARD_HEAVY" /><el-option v-if="logisticsPolicy.allowedPriorityProfiles.includes('BALANCED')" label="多级均衡分布" value="BALANCED" /><el-option v-if="logisticsPolicy.allowedPriorityProfiles.includes('URGENT_HEAVY')" label="高优先级偏多" value="URGENT_HEAVY" /></el-select></el-form-item>
            <el-form-item label="配送需求分布"><el-select v-model="logisticsDeliveryDistributionMode"><el-option label="均匀分布" value="UNIFORM" /><el-option label="重点区域集中" value="FOCUSED" /><el-option label="多点高峰" value="MULTI_PEAK" /></el-select></el-form-item>
          </div>
          <div class="logistics-condition-group">
            <header><span>机队初态</span><small :class="{ invalid: logisticsConfiguredAircraftCount > logisticsPolicy.totalAircraft }">已配置 {{ logisticsConfiguredAircraftCount }} / {{ logisticsPolicy.totalAircraft }} 架</small></header>
            <div class="wizard-form-grid compact-grid">
              <el-form-item label="待用"><el-input-number v-model="logisticsStandbyAircraftCount" :min="0" :max="logisticsPolicy.totalAircraft" /></el-form-item>
              <el-form-item label="低电量"><el-input-number v-model="logisticsLowBatteryAircraftCount" :min="0" :max="logisticsPolicy.totalAircraft" /></el-form-item>
              <el-form-item label="飞前异常"><el-input-number v-model="logisticsPreflightAbnormalAircraftCount" :min="0" :max="logisticsPolicy.totalAircraft" /></el-form-item>
              <el-form-item label="不可用"><el-input-number v-model="logisticsUnavailableAircraftCount" :min="0" :max="logisticsPolicy.totalAircraft" /></el-form-item>
            </div>
          </div>
          <div class="logistics-condition-group">
            <header><span>初始气象</span><small>安全阈值由系统统一维护</small></header>
            <div class="wizard-form-grid compact-grid">
              <el-form-item label="风向"><el-select v-model="logisticsWindDirection"><el-option label="北风" value="N" /><el-option label="东北风" value="NE" /><el-option label="东风" value="E" /><el-option label="东南风" value="SE" /><el-option label="南风" value="S" /><el-option label="西南风" value="SW" /><el-option label="西风" value="W" /><el-option label="西北风" value="NW" /></el-select></el-form-item>
              <el-form-item label="风力状态"><el-select v-model="logisticsWindForceState"><el-option label="平静" value="CALM" /><el-option label="正常" value="NORMAL" /><el-option label="接近限制" value="NEAR_LIMIT" /><el-option label="超过限制" value="OVER_LIMIT" /></el-select></el-form-item>
              <el-form-item label="阵风"><el-select v-model="logisticsGustState"><el-option label="无" value="NONE" /><el-option label="偶发" value="OCCASIONAL" /><el-option label="持续" value="CONTINUOUS" /></el-select></el-form-item>
              <el-form-item label="降雨"><el-select v-model="logisticsRainState"><el-option label="无" value="NONE" /><el-option label="阈值内" value="BELOW_LIMIT" /><el-option label="超过限制" value="OVER_LIMIT" /></el-select></el-form-item>
            </div>
          </div>
          <div class="logistics-condition-group">
            <header><span>定位与通信</span><small>高风险状态将在运行前检查中阻断启动</small></header>
            <div class="wizard-form-grid compact-grid">
              <el-form-item label="定位状态"><el-select v-model="logisticsPositioningState"><el-option v-for="option in logisticsSignalOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
              <el-form-item label="通信状态"><el-select v-model="logisticsCommunicationState"><el-option v-for="option in logisticsSignalOptions" :key="option.value" :label="option.label" :value="option.value" /></el-select></el-form-item>
            </div>
          </div>
          <el-form-item label="确定性订单种子">
            <el-input v-model="logisticsOrderSeed" maxlength="120"><template #append><el-button :icon="RefreshRight" title="重新生成订单种子" aria-label="重新生成订单种子" @click="logisticsOrderSeed = newOrderSeed()" /></template></el-input>
          </el-form-item>
          <small class="order-seed-note">发布后订单条件和种子冻结。相同配送点集合将生成完全一致的订单属性。</small>
        </div>
        <div class="wizard-policy-row">
          <label><span>允许补交</span><el-switch v-model="allowResubmission" :disabled="mode === 'ASSESSMENT'" /></label>
          <label><span>规则检查次数</span><el-input-number v-model="allowedValidationAttempts" :min="1" :max="20" /></label>
          <label><span>运行次数</span><el-input-number v-model="allowedRuntimeAttempts" :min="1" :max="20" /></label>
        </div>
      </section>

      <section v-else-if="step === 3" class="wizard-panel">
        <header><span>04</span><div><h2>发布范围与时间</h2><p>可向整班或班内指定学生发布，系统会为每名目标学生创建独立项目。</p></div></header>
        <div class="wizard-form-grid">
          <el-form-item label="发布班级" data-preflight-target="publish-classroom"><el-select v-model="classroomId" aria-label="发布班级" placeholder="选择班级"><el-option v-for="classroom in classes" :key="classroom.id" :label="`${classroom.name} · ${classroom.studentCount} 人`" :value="classroom.id" /></el-select></el-form-item>
          <el-form-item label="开放与截止时间" data-preflight-target="publish-schedule">
            <el-date-picker v-model="schedule" type="datetimerange" range-separator="至" start-placeholder="开放时间" end-placeholder="截止时间" />
            <small class="order-seed-note">开放时间必须晚于当前时间，建议至少预留 10 分钟完成预览与发布。</small>
          </el-form-item>
          <el-form-item v-if="mode === 'ASSESSMENT'" label="考核时长（分钟）"><el-input-number v-model="assessmentDurationMinutes" :min="1" :max="1440" :step="10" /></el-form-item>
        </div>
        <div class="wizard-target-selector">
          <el-radio-group v-model="targetMode">
            <el-radio-button value="CLASS">整班发布</el-radio-button>
            <el-radio-button value="STUDENT">指定学生</el-radio-button>
          </el-radio-group>
          <div v-if="targetMode === 'STUDENT'" class="wizard-student-picker">
            <header><strong>选择学生</strong><small>已选 {{ selectedStudentIds.length }} / {{ classStudents.length }} 人</small></header>
            <el-checkbox-group v-model="selectedStudentIds">
              <el-checkbox v-for="student in classStudents" :key="student.id" :value="student.id"><span><strong>{{ student.displayName }}</strong><small>{{ student.email }}</small></span></el-checkbox>
            </el-checkbox-group>
            <div v-if="classroomId && classStudents.length === 0" class="compact-empty">该班级暂无学生</div>
          </div>
        </div>
        <div class="publish-policy-note"><strong>{{ mode === 'TRAINING' ? '训练模式反馈策略' : '考核模式反馈策略' }}</strong><span>{{ mode === 'TRAINING' ? '学生可查看完整检查结果和运行总结。' : '学生仅查看总分，过程错误和量表维度在结果发布前隐藏。' }}</span></div>
      </section>

      <section v-else class="wizard-panel preview-panel">
        <header><span>05</span><div><h2>发布前预览</h2><p>以下内容及资源版本将写入不可变任务快照。</p></div></header>
        <section v-if="mapReadinessData" class="map-readiness-preview" :class="mapReadiness.state.toLowerCase()">
          <header><div><span>MAP RESOURCE CHECK</span><strong>{{ mapReadiness.title }}</strong></div><b>非阻塞检查</b></header>
          <p>{{ mapReadiness.detail }}</p>
          <ul v-if="mapReadiness.issues.length"><li v-for="issue in mapReadiness.issues" :key="issue.kind"><strong>{{ issue.label }}<em>{{ issue.statusLabel }}</em></strong><span>{{ issue.message }}</span><small>下一步：{{ issue.nextStep }}</small></li></ul>
          <div v-if="environmentDiagnostics" class="map-environment-diagnostic" :class="environmentDiagnostics.status.toLowerCase()">
            <strong>建筑与障碍物</strong><em>{{ environmentDiagnosticLabel(environmentDiagnostics.status) }}</em>
            <span>{{ environmentDiagnostics.buildingCount }} 个建筑物 · {{ environmentDiagnostics.obstacleCount }} 个障碍物 · {{ environmentDiagnostics.missingHeightCount }} 项缺少高度</span>
            <small>{{ environmentDiagnostics.message }}</small>
          </div>
          <footer>当前检查仅作提示；正式验收前仍需补齐授权资源并重新检查</footer>
        </section>
        <div v-if="!preflight" class="preview-invalidated" role="status">
          <strong>预览已失效</strong>
          <span>{{ previewInvalidationReason || '发布配置发生变化，请重新生成预览并执行发布前检查。' }}</span>
          <el-button size="small" type="primary" :loading="previewProgress?.status === 'RUNNING'" :icon="RefreshRight" @click="preparePreview">重新生成预览</el-button>
        </div>
        <section v-if="preflight" class="assignment-preflight" :class="{ blocked: preflight.summary.blocking > 0, warning: preflight.summary.blocking === 0 && preflight.summary.warning > 0, ready: preflight.summary.blocking === 0 && preflight.summary.warning === 0 }" aria-live="polite" aria-atomic="false">
          <header class="preflight-heading">
            <div><span>RELEASE PREFLIGHT</span><strong>{{ preflight.summary.blocking > 0 ? '暂不能发布' : preflightConfirmationChecks.length > 0 ? '需要确认风险' : '可以发布' }}</strong></div>
            <div class="preflight-heading-actions"><small>检查时间 {{ formatPlatformDateTime(preflight.checkedAt) }}</small><el-button v-if="preflightBlockingChecks.length || preflightWarningChecks.length" text size="small" :icon="Location" @click="goToFirstPreflightCheck">定位首个待处理项</el-button><el-button text size="small" :loading="previewProgress?.status === 'RUNNING'" :icon="RefreshRight" @click="preparePreview">重新检查</el-button></div>
          </header>
          <div class="preflight-metrics">
            <span class="blocking"><b>{{ preflight.summary.blocking }}</b> 必须修复</span>
            <span class="warning"><b>{{ preflight.summary.warning }}</b> 建议确认</span>
            <span class="passed"><b>{{ preflight.summary.passed }}</b> 已通过</span>
          </div>
          <div v-if="preflightBlockingChecks.length" class="preflight-group">
            <h3><el-icon><WarningFilled /></el-icon>必须修复</h3>
            <button v-for="check in preflightBlockingChecks" :key="check.code" type="button" class="preflight-check blocking" :aria-label="`${check.title}，${check.message}。处理建议：${check.action}。点击定位`" @click="goToPreflightCheck(check)">
              <span class="preflight-check-icon"><el-icon><WarningFilled /></el-icon></span>
              <span><strong>{{ check.title }}</strong><small>{{ check.message }}</small><em>{{ check.action }}</em></span>
            </button>
          </div>
          <div v-if="preflightWarningChecks.length" class="preflight-group">
            <h3><el-icon><InfoFilled /></el-icon>建议确认</h3>
            <button v-for="check in preflightWarningChecks" :key="check.code" type="button" class="preflight-check warning" :aria-label="`${check.title}，${check.message}。处理建议：${check.action}。点击定位`" @click="goToPreflightCheck(check)">
              <span class="preflight-check-icon"><el-icon><InfoFilled /></el-icon></span>
              <span><strong>{{ check.title }}</strong><small>{{ check.message }}</small><em>{{ check.action }}</em></span>
            </button>
          </div>
          <div v-if="preflightPassedChecks.length" class="preflight-group passed-group">
            <h3><el-icon><CircleCheckFilled /></el-icon>已通过</h3>
            <div v-for="check in preflightPassedChecks" :key="check.code" class="preflight-check passed">
              <span class="preflight-check-icon"><el-icon><CircleCheckFilled /></el-icon></span>
              <span><strong>{{ check.title }}</strong><small>{{ check.message }}</small></span>
            </div>
          </div>
          <label v-if="preflight.summary.blocking === 0 && preflightConfirmationChecks.length > 0" class="preflight-confirm">
            <input v-model="riskConfirmed" type="checkbox" />
            <span><strong>我已阅读并确认以上建议项</strong><small>确认记录只针对本次预览；发布时服务端仍会重新校验最新配置。</small></span>
          </label>
        </section>
        <dl class="preview-summary">
          <div><dt>任务</dt><dd>{{ title }}</dd></div><div><dt>场景 / 模式</dt><dd>{{ sceneLabel(sceneType) }} / {{ mode === 'TRAINING' ? '训练' : '考核' }}</dd></div>
          <div v-if="mode === 'ASSESSMENT'"><dt>考核时长</dt><dd>{{ assessmentDurationMinutes }} 分钟</dd></div>
          <div><dt>模板 / 区域</dt><dd>{{ formatScaleTemplateCode(scaleTemplateCode) }} / {{ regionTitle() }}</dd></div><div><dt>方案任务规则</dt><dd>{{ selectedQuestionBank ? `${selectedQuestionBank.title} · V${selectedQuestionBank.publishedVersion?.version ?? selectedQuestionBank.currentVersion} · ${selectedQuestionBank.publishedVersion?.questionCount ?? selectedQuestionBank.questionCount} 项` : questionBankVersionId ? '绑定版本不可用' : '未绑定任务规则' }}</dd></div><div><dt>发布范围</dt><dd>{{ className() }} · {{ preview?.studentCount ?? 0 }} 名学生</dd></div>
          <div><dt>场景覆盖层</dt><dd>{{ selectedPublishedScenarioOverlay ? `${selectedPublishedScenarioOverlay.title} · V${selectedPublishedScenarioOverlay.versionNo}` : scenarioOverlayVersionId ? '绑定版本不可用' : '未绑定覆盖层' }}</dd></div>
          <div><dt>事件</dt><dd>{{ eventCodes.length ? (sceneType === 'CITY_LOGISTICS' ? configuredLogisticsEventSummary() : `${eventCodes.length} 类系统模拟事件`) : '不注入事件' }}</dd></div><div><dt>资源版本</dt><dd>{{ preview?.resourceRefs.length ?? 0 }} 个已校验资源包</dd></div>
          <div><dt>冻结引用</dt><dd class="preview-version-list"><span>地图 {{ frozenMapResourceVersion }}</span><span>场景 {{ frozenSceneResourceVersion }}</span><span>方案 {{ frozenPlanVersion }}</span></dd></div>
          <div v-if="sceneType === 'CITY_SHOW'"><dt>表演计划</dt><dd>{{ formatPlatformDateTime(showFlightSchedule[0]) }} 至 {{ formatPlatformDateTime(showFlightSchedule[1]) }}</dd></div><div v-if="sceneType === 'CITY_SHOW'"><dt>观众 / 高度</dt><dd>{{ showAudienceCount }} 人 · {{ showMaximumHeightMeters }} m</dd></div>
          <div v-if="sceneType === 'CITY_SHOW'"><dt>表演程序</dt><dd>{{ selectedShowProgram ? `${selectedShowProgram.name} · v${selectedShowProgram.version}` : '平台内置固定程序' }}</dd></div>
          <div v-if="sceneType === 'CITY_SHOW'"><dt>初始气象</dt><dd>{{ showWindDirection }} · {{ showWindForceState }} · {{ showGustState }} · {{ showRainState }}</dd></div><div v-if="sceneType === 'CITY_SHOW'"><dt>技术环境</dt><dd>{{ showPositioningElectromagneticState }} · {{ showCommunicationControlState }} · {{ showDeviceState }} / {{ showDeviceImpactScope }}</dd></div>
          <div v-if="sceneType === 'CITY_LOGISTICS'"><dt>订单批次</dt><dd>{{ logisticsOrderCount }} 单 · {{ logisticsTimeWindowProfile }} · {{ logisticsReleaseModeLabel(logisticsReleaseMode) }}{{ logisticsReleaseMode === 'AT_PHASE' ? `（${logisticsReleasePhaseLabel(logisticsReleasePhase)}）` : '' }}</dd></div><div v-if="sceneType === 'CITY_LOGISTICS'"><dt>初始机队条件</dt><dd>待用 {{ logisticsStandbyAircraftCount }} · 低电量 {{ logisticsLowBatteryAircraftCount }} · 飞前异常 {{ logisticsPreflightAbnormalAircraftCount }} · 不可用 {{ logisticsUnavailableAircraftCount }}</dd></div>
          <div v-if="sceneType === 'CITY_LOGISTICS'"><dt>模板能力</dt><dd>{{ logisticsPolicy.learningStageLabel }} · {{ logisticsPolicy.parallelOperationLabel }} · {{ logisticsPolicy.eventLevelLabel }}</dd></div><div v-if="sceneType === 'CITY_LOGISTICS'"><dt>优先级 / 重调度</dt><dd>{{ logisticsPriorityProfileLabel(logisticsPriorityProfile) }} · {{ logisticsPolicy.globalReschedulingEnabled ? '全局重调度' : logisticsPolicy.batchReschedulingEnabled ? '批量重调度' : '单项调整' }}</dd></div>
          <div v-if="sceneType === 'CITY_LOGISTICS'"><dt>初始运行环境</dt><dd>{{ logisticsWindDirection }} · {{ logisticsWindForceState }} · {{ logisticsGustState }} · {{ logisticsRainState }} · 定位 {{ logisticsPositioningState }} · 通信 {{ logisticsCommunicationState }}</dd></div>
          <div v-if="sceneType === 'CITY_LOGISTICS'"><dt>计划运行</dt><dd>{{ formatPlatformDateTime(logisticsRuntimeSchedule[0]) }} 至 {{ formatPlatformDateTime(logisticsRuntimeSchedule[1]) }}</dd></div>
          <div v-if="sceneType === 'VTOL_INSPECTION'"><dt>巡检模板</dt><dd>{{ vtlPolicy.totalAircraft }} 架 · {{ vtlSelectedTaskObjects.length }} 个任务对象 · {{ vtlPolicy.defaultGroupCount }} 组</dd></div><div v-if="sceneType === 'VTOL_INSPECTION'"><dt>计划运行</dt><dd>{{ formatPlatformDateTime(vtlRuntimeSchedule[0]) }} 至 {{ formatPlatformDateTime(vtlRuntimeSchedule[1]) }}</dd></div>
          <div v-if="sceneType === 'VTOL_INSPECTION'"><dt>开放步骤</dt><dd>{{ vtlOpenStageCodes.length }} / {{ vtlStageOptions.length }} 个 · 评价 {{ vtlEvaluationTotal.toFixed(1) }} 分</dd></div>
          <div><dt>地图资源</dt><dd :class="{ invalid: mapReadiness.publishBlocked }">{{ mapReadiness.title }}</dd></div>
        </dl>
        <section v-if="preview?.logisticsOrderPreview" class="order-preview-panel">
          <header>
            <div><span>ORDER GENERATION</span><strong>订单生成预览</strong><small>{{ preview.logisticsOrderPreview.generatorVersion }} · {{ logisticsDeliveryDistributionMode }}</small></div>
            <el-button :icon="RefreshRight" @click="regenerateOrderPreview">重新生成</el-button>
          </header>
          <div class="order-preview-metrics">
            <div><span>订单总数</span><strong>{{ preview.logisticsOrderPreview.config.orderCount }}</strong></div>
            <div><span>候选配送点</span><strong>{{ preview.logisticsOrderPreview.candidateDeliveryPointIds.length }}</strong></div>
            <div><span>释放批次</span><strong>{{ preview.logisticsOrderPreview.releaseBatchCounts.length }}</strong></div>
            <div><span>预计高峰</span><strong>{{ minuteLabel(preview.logisticsOrderPreview.peak.minuteOffset) }}</strong><small>{{ preview.logisticsOrderPreview.peak.orderCount }} 单</small></div>
          </div>
          <div class="order-preview-breakdown">
            <article><header>配送点需求</header><div><span v-for="item in preview.logisticsOrderPreview.destinationCounts" :key="item.key"><b>{{ deliveryPointName(item.key) }}</b><em>{{ item.count }} 单</em></span></div></article>
            <article><header>优先级结构</header><div><span v-for="item in preview.logisticsOrderPreview.priorityCounts" :key="item.key"><b>{{ logisticsPriorityLabel(item.key) }}</b><em>{{ item.count }} 单</em></span></div></article>
            <article><header>释放时刻</header><div><span v-for="item in preview.logisticsOrderPreview.releaseBatchCounts" :key="item.key"><b>{{ minuteLabel(Number(item.key)) }}</b><em>{{ item.count }} 单</em></span></div></article>
          </div>
          <div class="order-preview-samples">
            <header><strong>订单样本</strong><small>展示前 {{ preview.logisticsOrderPreview.samples.length }} 单</small></header>
            <div class="order-sample-head"><span>订单</span><span>配送点</span><span>优先级</span><span>释放</span><span>最迟送达</span></div>
            <div v-for="order in preview.logisticsOrderPreview.samples" :key="order.code" class="order-sample-row">
              <code>{{ order.code }}</code><span>{{ deliveryPointName(order.destinationNodeId) }}</span><span>{{ logisticsPriorityLabel(order.priority) }}</span><span>{{ minuteLabel(order.releaseTimeMs / 60000) }}</span><span>{{ minuteLabel(order.latestArrivalTimeMs / 60000) }}</span>
            </div>
          </div>
          <footer><span>订单校验和</span><code>{{ preview.logisticsOrderPreview.checksum }}</code></footer>
        </section>
        <div class="preview-stages"><strong>阶段序列</strong><ol><li v-for="stageItem in preview?.stageDefinitions ?? []" :key="stageItem.code"><span>{{ String(stageItem.sequence).padStart(2, '0') }}</span><div><strong>{{ stageItem.title }}</strong><small>{{ stageItem.description }}</small></div></li></ol></div>
        <div class="preview-hash"><span>配置哈希</span><code>{{ preview?.configHash }}</code></div>
        </section>
      </div>
    </div>

    <template #footer>
      <div class="wizard-footer">
        <el-button :icon="Close" @click="requestClose">取消</el-button>
        <span />
        <el-button v-if="step > 0" :disabled="previewProgress?.status === 'RUNNING' || publishing" @click="step -= 1">上一步</el-button>
        <small v-if="continueHint || publishHint" class="wizard-next-hint" role="status">{{ continueHint || publishHint }}</small>
        <el-button v-if="step < 4" type="primary" :disabled="!canContinue" :loading="previewProgress?.status === 'RUNNING'" :icon="step === 3 ? RefreshRight : undefined" :title="continueHint" @click="next">{{ step === 3 ? '生成预览' : '下一步' }}</el-button>
        <el-button v-else type="primary" :disabled="!canPublish" :loading="publishing" :icon="Promotion" :title="publishHint" @click="publish">确认发布</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.wizard-content { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; overflow: hidden; }
.wizard-content > .v3-operation-progress { margin: 10px 14px 0; }
.wizard-content > .wizard-panel { overflow: auto; }
.wizard-next-hint { max-width: 360px; color: #9a6a25; font-size: 10px; line-height: 1.4; }
.preview-invalidated { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 14px; border: 1px solid #e7d1a6; padding: 11px 13px; background: #fffaf1; color: #73572a; }
.preview-invalidated strong { font-size: 11px; }
.preview-invalidated span { flex: 1 1 260px; min-width: 0; font-size: 10px; line-height: 1.45; }
.wizard-inline-warning { display: flex; align-items: flex-start; gap: 7px; margin: 8px 0 12px; border: 1px solid #e7d1a6; padding: 9px 11px; background: #fffaf1; color: #8a652d; font-size: 11px; line-height: 1.5; }
.wizard-inline-warning .el-icon { flex: 0 0 auto; margin-top: 2px; }
.field-note { display: block; margin-top: 3px; color: #71847b; font-size: 11px; line-height: 1.4; }
.overlay-option-meta { display: block; color: #71847b; font-size: 11px; line-height: 1.3; }
.preview-version-list { display: flex; flex-wrap: wrap; gap: 4px 10px; }
.preview-version-list span { overflow-wrap: anywhere; }
.event-policy-note.locked { color: #8a652d; }
.question-bank-summary { margin-top: 8px; border-color: #b9d7c9; background: #f2faf5; }
.wizard-resource-dependencies { display: grid; gap: 3px; margin-top: 8px; border-left: 3px solid #7d9589; padding: 9px 11px; background: #f5f8f6; color: #52675d; }
.wizard-resource-dependencies strong { color: #29473a; font-size: 10px; }
.wizard-resource-dependencies span { font-size: 11px; }
.wizard-resource-dependencies small { color: #71847b; font-size: 11px; line-height: 1.45; }
.preflight-focus-target { outline: 3px solid rgba(28, 126, 86, .34); outline-offset: 3px; box-shadow: 0 0 0 7px rgba(28, 126, 86, .08); transition: outline-color .18s ease, box-shadow .18s ease; }
.assignment-preflight { display: grid; gap: 10px; margin: 0 0 14px; border: 1px solid #d7e1dc; padding: 12px 14px; background: #f8faf9; }
.assignment-preflight.blocked { border-color: #e2bcb8; background: #fff8f7; }
.assignment-preflight.warning { border-color: #e7d1a6; background: #fffaf1; }
.assignment-preflight.ready { border-color: #b9d7c9; background: #f2faf5; }
.preflight-heading { display: flex; align-items: end; justify-content: space-between; gap: 12px; }
.preflight-heading > div { display: grid; gap: 3px; }
.preflight-heading-actions { display: flex !important; align-items: center; justify-content: flex-end; gap: 8px; }
.preflight-heading span { color: #6d8278; font-size: 11px; letter-spacing: .08em; }
.preflight-heading strong { color: #173b2f; font-size: 15px; }
.preflight-heading small { color: #71847b; font-size: 11px; }
.preflight-metrics { display: flex; flex-wrap: wrap; gap: 7px; }
.preflight-metrics span { display: inline-flex; align-items: baseline; gap: 4px; border: 1px solid #d6e0db; padding: 5px 8px; background: rgba(255,255,255,.72); color: #5e756a; font-size: 11px; }
.preflight-metrics b { font-size: 14px; line-height: 1; }
.preflight-metrics .blocking b { color: #b34d46; }
.preflight-metrics .warning b { color: #ae7629; }
.preflight-metrics .passed b { color: #28805a; }
.preflight-group { display: grid; gap: 6px; }
.preflight-group h3 { display: flex; align-items: center; gap: 5px; margin: 0; color: #536a60; font-size: 10px; }
.preflight-group h3 .el-icon { font-size: 12px; color: #b34d46; }
.passed-group h3 .el-icon { color: #28805a; }
.preflight-check { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; width: 100%; border: 1px solid #e1e8e4; padding: 8px 9px; text-align: left; color: #20372e; background: rgba(255,255,255,.84); font: inherit; cursor: pointer; }
.preflight-check:hover { border-color: #83a997; background: #fff; }
.preflight-check.passed { cursor: default; }
.preflight-check-icon { display: grid; place-items: start center; padding-top: 1px; font-size: 13px; }
.preflight-check.blocking .preflight-check-icon { color: #b34d46; }
.preflight-check.warning .preflight-check-icon { color: #ae7629; }
.preflight-check.passed .preflight-check-icon { color: #28805a; }
.preflight-check > span:last-child { display: grid; min-width: 0; gap: 2px; }
.preflight-check strong { font-size: 10px; line-height: 1.35; }
.preflight-check small { color: #5d7469; font-size: 11px; line-height: 1.45; white-space: normal; overflow-wrap: anywhere; }
.preflight-check em { color: #2d7255; font-size: 11px; font-style: normal; }
.preflight-confirm { display: grid; grid-template-columns: 16px minmax(0, 1fr); gap: 7px; align-items: start; border-top: 1px solid #e3d4b6; padding-top: 9px; cursor: pointer; }
.preflight-confirm input { margin: 2px 0 0; accent-color: #1d7654; }
.preflight-confirm span { display: grid; gap: 2px; }
.preflight-confirm strong { color: #674b1f; font-size: 10px; }
.preflight-confirm small { color: #856c42; font-size: 11px; line-height: 1.45; }
.vtl-object-picker, .vtl-stage-picker, .vtl-rubric-picker { display: grid; gap: 8px; }
.vtl-object-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); max-height: 250px; overflow: auto; padding: 8px 0; }
.vtl-object-picker .el-checkbox, .vtl-rubric-row { min-width: 0; border: 1px solid #d9e3de; padding: 8px; background: #fbfdfc; }
.vtl-object-picker .el-checkbox :deep(.el-checkbox__label), .vtl-rubric-row :deep(.el-checkbox__label) { min-width: 0; width: 100%; }
.vtl-object-picker .el-checkbox span, .vtl-rubric-row .el-checkbox span { display: grid; gap: 3px; min-width: 0; white-space: normal; }
.vtl-object-picker .el-checkbox small, .vtl-rubric-row small { color: #71847b; line-height: 1.4; white-space: normal; }
.vtl-stage-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 8px 0; }
.vtl-boundary-editor { display: grid; gap: 6px; padding: 8px 0 2px; }
.vtl-boundary-row { display: grid; grid-template-columns: 30px minmax(0,1fr) minmax(0,1fr) 42px; gap: 6px; align-items: center; }
.vtl-boundary-row > strong { color: #71847b; font-size: 11px; text-align: center; }
.vtl-boundary-row :deep(.el-input-number) { width: 100%; }
.vtl-boundary-row :deep(.el-input__wrapper) { padding: 0 6px; }
.vtl-boundary-row :deep(.el-input__inner) { font-size: 11px; }
.vtl-boundary-actions { display: flex; gap: 6px; padding-top: 2px; }
.vtl-rubric-row { display: grid; grid-template-columns: minmax(0, 1fr) 110px; align-items: center; gap: 12px; }
.vtl-rubric-row .el-checkbox { min-width: 0; }
.map-readiness-preview { display: grid; gap: 8px; border: 1px solid #d4ded9; padding: 11px 13px; background: #f8faf9; }
.map-readiness-preview > header { display: flex; align-items: end; justify-content: space-between; gap: 12px; }
.map-readiness-preview > header div { display: grid; gap: 2px; }
.map-readiness-preview > header span, .map-readiness-preview > header b, .map-readiness-preview footer { color: #6b8177; font-size: 11px; }
.map-readiness-preview > header strong { font-size: 11px; }
.map-readiness-preview > header b { font-weight: 700; }
.map-readiness-preview p { margin: 0; color: #5f756b; font-size: 11px; line-height: 1.5; }
.map-readiness-preview ul { display: grid; gap: 5px; margin: 0; padding: 0; list-style: none; }
.map-readiness-preview li { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 8px; border-left: 3px solid #b87931; padding: 6px 8px; background: #fff8ed; font-size: 11px; }
.map-readiness-preview li strong { display: grid; gap: 2px; align-content: start; }
.map-readiness-preview li em { color: #9b6d27; font-size: 11px; font-style: normal; font-weight: 600; }
.map-readiness-preview li small { grid-column: 2; color: #806f5c; font-size: 11px; line-height: 1.4; }
.map-environment-diagnostic { display: grid; grid-template-columns: auto auto; gap: 3px 8px; border-left: 3px solid #bd842c; padding: 7px 8px; color: #765522; background: #fff9eb; font-size: 11px; }
.map-environment-diagnostic strong { font-size: 11px; }
.map-environment-diagnostic em { justify-self: end; font-style: normal; font-weight: 700; }
.map-environment-diagnostic span, .map-environment-diagnostic small { grid-column: 1 / 3; line-height: 1.45; }
.map-environment-diagnostic small { color: #8b7863; }
.map-environment-diagnostic.ready { border-left-color: #4b9271; color: #2f684d; background: #eef8f1; }
.map-environment-diagnostic.ready small { color: #5f7d6c; }
.map-environment-diagnostic.unavailable { border-left-color: #8e8175; color: #6f665e; background: #f7f5f2; }
.map-readiness-preview.ready { border-color: #bdd8cb; background: #edf7f2; }
.map-readiness-preview.blocked { border-color: #e1bbb7; background: #fff7f6; }
.map-readiness-preview.blocked li { border-left-color: #b64d45; background: #fff; }
.invalid { color: #b54747 !important; }
@media (max-width: 720px) { .wizard-content { display: block; overflow: visible; }.wizard-content > .v3-operation-progress { margin: 8px; } }
@media (max-width: 620px) { .vtl-object-picker, .vtl-stage-picker { grid-template-columns: 1fr; }.vtl-rubric-row { grid-template-columns: 1fr; }.preflight-heading { align-items: start; flex-direction: column; gap: 4px; }.preflight-metrics span { flex: 1 1 30%; justify-content: center; }.preflight-check { grid-template-columns: 20px minmax(0, 1fr); }.preview-invalidated { align-items: flex-start; }.preview-invalidated .el-button { flex: 1 0 100%; margin-left: 0; } }
</style>
