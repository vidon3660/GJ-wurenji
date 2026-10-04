<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { ChatLineRound, CircleCheck, DataAnalysis, Document, Download, InfoFilled, Refresh, Timer, Upload, VideoPause, VideoPlay } from "@element-plus/icons-vue"
import type {
  AuthUser,
  V3LogisticsStudentReviewSummaryView,
  V3RegionCatalogItem,
  V3StudentReviewSummaryView,
  ShowReplayTimelineItemKind,
  ShowReplayTimelineItemView,
  ShowReviewWorkspaceView,
  ShowTeacherScoreView,
  StudentProjectStageView,
  StudentProjectView
} from "@wurenji/shared"
import { api, downloadApiFile } from "../api"
import { formatPlatformDateTime } from "../platform-date"
import { teacherEvaluationDraftStatus } from "../review-scoring"
import { reviewReportActionsPresentation, studentReviewResultPresentation } from "../student-review-result"
import { formatEvaluationStatus } from "../terminology"
import V3UnifiedMap from "./V3UnifiedMap.vue"

type ReviewSnapshot = {
  id: string
  checksum: string
  planVersion: string
  mapResourceVersion: string
  sceneResourceVersion: string
  resourceRevision: number
  publishedAt: string
}
type ReviewRuntimeAttempt = {
  id: string
  status: string
  attemptNo: number
  sourceSessionId: string | null
  restartNodeCode: string | null
  restartSimulationTimeMs: number | null
  simulationTimeMs: number
  revision: number
}

const props = withDefaults(defineProps<{ user: AuthUser; project: StudentProjectView; stage: StudentProjectStageView; region?: V3RegionCatalogItem | null; mapMode?: "2d" | "3d"; sceneType?: "CITY_SHOW" | "CITY_LOGISTICS" }>(), { sceneType: "CITY_SHOW", region: null, mapMode: "3d" })
const emit = defineEmits<{ refreshProject: [] }>()
const loading = ref(false)
const loadError = ref("")
const mutationError = ref("")
const workspace = ref<ShowReviewWorkspaceView | null>(null)
const assignmentSnapshot = ref<ReviewSnapshot | null>(null)
const runtimeAttempts = ref<ReviewRuntimeAttempt[]>([])
const studentSummary = ref("")
const studentSummaryStructured = ref<V3StudentReviewSummaryView>({ completion: "", problems: "", decisions: "", improvements: "" })
const logisticsStudentSummaryStructured = ref<V3LogisticsStudentReviewSummaryView>({ originalPlanProblems: "", responseLessons: "", routeAdjustmentSuggestions: "", schedulingOptimization: "", improvements: "" })
const teacherSummary = ref("")
const teacherScores = ref<ShowTeacherScoreView[]>([])
const activeKind = ref<"ALL" | ShowReplayTimelineItemKind>("ALL")
const annotationVisible = ref(false)
const annotationTarget = ref<ShowReplayTimelineItemView | null>(null)
const annotationComment = ref("")
const replayTimeMs = ref(0)
const replayPlaying = ref(false)
const selectedReplayAircraftId = ref("")
const selectedReplayRouteId = ref("")
const selectedReplayEventId = ref("")
const reportGenerating = ref(false)
const reportGenerationError = ref("")
const reportRequestedFormat = ref<"DOCX" | "PDF">("PDF")
let replayTimer: number | null = null
let lastMutation: { path: string; method: "POST" | "PUT"; body: unknown; successMessage: string } | null = null
const isLogistics = computed(() => props.sceneType === "CITY_LOGISTICS")
const reviewBase = computed(() => `${isLogistics.value ? "/v3/logistics-projects" : "/v3/show-projects"}/${props.project.id}/review`)

const timeline = computed(() => activeKind.value === "ALL"
  ? workspace.value?.timeline ?? []
  : workspace.value?.timeline.filter((item) => item.kind === activeKind.value) ?? [])
const cohortOmissions = computed(() => workspace.value?.cohortAnalytics?.commonOmissions ?? [])
const cohortErrors = computed(() => workspace.value?.cohortAnalytics?.errorTypes ?? [])
const scoreTotal = computed(() => teacherScores.value.reduce((sum, item) => sum + Number(item.score ?? 0), 0))
const publishStatus = computed(() => teacherEvaluationDraftStatus(
  workspace.value?.evaluation.teacherScores ?? [],
  workspace.value?.evaluation.summary ?? "",
  teacherScores.value,
  teacherSummary.value,
  workspace.value?.canPublish ?? false,
  workspace.value?.publishBlockedReason ?? null
))
const annotationsByItem = computed(() => {
  const grouped = new Map<string, ShowReviewWorkspaceView["annotations"]>()
  for (const item of workspace.value?.annotations ?? []) grouped.set(item.timelineItemId, [...(grouped.get(item.timelineItemId) ?? []), item])
  return grouped
})
const replayFrames = computed(() => workspace.value?.replay?.frames ?? [])
const currentRuntimeAttempt = computed(() => [...runtimeAttempts.value].sort((left, right) => right.attemptNo - left.attemptNo)[0] ?? null)
const replayDurationMs = computed(() => workspace.value?.replay?.durationMs ?? 0)
const replayFrame = computed(() => {
  const frames = replayFrames.value
  return [...frames].reverse().find((frame) => frame.simulationTimeMs <= replayTimeMs.value) ?? frames[0] ?? null
})
const logisticsAnalysisSections = computed(() => {
  const analysis = workspace.value?.logisticsAnalysis
  return analysis ? [analysis.routeValidation, analysis.onTimeDelivery, analysis.runtimeConflicts, analysis.aircraftUtilization, analysis.abnormalResponse, analysis.rescheduleOutcome] : []
})
const studentResult = computed(() => studentReviewResultPresentation(workspace.value))
const studentCanEditSummary = computed(() => Boolean(workspace.value?.canEditSummary && (props.user.role !== "student" || props.project.assessmentTiming.canWrite)))
const reportActions = computed(() => reviewReportActionsPresentation(workspace.value))
const kindOptions: Array<{ code: "ALL" | ShowReplayTimelineItemKind; label: string }> = [
  { code: "ALL", label: "全部" },
  { code: "STATE", label: "状态" },
  { code: "EVENT", label: "事件" },
  { code: "ALERT", label: "告警" },
  { code: "ACTION", label: "处置" },
  { code: "REPORT", label: "报备" }
]

onMounted(load)
watch(() => props.project.id, load)
onBeforeUnmount(stopReplay)

async function load() {
  loading.value = true
  loadError.value = ""
  try {
    const value = await api<ShowReviewWorkspaceView>(reviewBase.value)
    workspace.value = value
    applyWorkspace(value)
    await loadReviewFacts()
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "运行评估加载失败"
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

async function loadReviewFacts() {
  const runtimeBase = isLogistics.value
    ? `/v3/logistics-projects/${props.project.id}/runtime-workspace`
    : `/v3/show-projects/${props.project.id}/runtime`
  const [snapshot, runtime] = await Promise.allSettled([
    api<ReviewSnapshot>(`/v3/assignments/${props.project.assignmentSnapshotId}/snapshot`),
    api<{ attempts?: ReviewRuntimeAttempt[] }>(runtimeBase)
  ])
  assignmentSnapshot.value = snapshot.status === "fulfilled" ? snapshot.value : null
  runtimeAttempts.value = runtime.status === "fulfilled" ? runtime.value.attempts ?? [] : []
}

function attemptLabel(attempt: ReviewRuntimeAttempt) {
  const restart = attempt.sourceSessionId ? ` · 重连自第 ${attempt.restartSimulationTimeMs === null ? "未知" : formatSimulationTime(attempt.restartSimulationTimeMs)}` : ""
  return `第 ${attempt.attemptNo} 次 · ${attempt.status} · ${formatSimulationTime(attempt.simulationTimeMs)}${restart}`
}

async function saveStudentSummary(submit: boolean) {
  if (!workspace.value) return
  if (submit) {
    try {
      await ElMessageBox.confirm("确认提交飞后总结？提交后将由教师进行综合评价。", "提交飞后总结", {
        confirmButtonText: "确认提交",
        cancelButtonText: "取消",
        type: "warning"
      })
    } catch {
      return
    }
  }
  await mutate(`${reviewBase.value}/summary${submit ? "/submit" : ""}`, submit ? "POST" : "PUT", {
    expectedRevision: workspace.value.evaluation.revision,
    summary: "",
    structuredSummary: isLogistics.value ? logisticsStudentSummaryStructured.value : studentSummaryStructured.value
  }, submit ? "飞后总结已提交" : "总结草稿已保存")
  if (submit) emit("refreshProject")
}

async function saveTeacherEvaluation(publish: boolean) {
  if (!workspace.value) return
  if (publish) {
    try {
      await ElMessageBox.confirm(`确认发布 ${scoreTotal.value.toFixed(1)} 分的综合评价？发布后评价与项目报告内容将锁定。`, "发布综合评价", {
        confirmButtonText: "确认发布",
        cancelButtonText: "取消",
        type: "warning"
      })
    } catch {
      return
    }
  }
  const path = publish ? "evaluation/publish" : "evaluation"
  const body = publish
    ? { expectedRevision: workspace.value.evaluation.revision }
    : { expectedRevision: workspace.value.evaluation.revision, teacherScores: teacherScores.value, summary: teacherSummary.value }
  await mutate(`${reviewBase.value}/${path}`, publish ? "POST" : "PUT", body, publish ? "综合评价已发布" : "评价草稿已保存")
  if (publish) emit("refreshProject")
}

function openAnnotation(item: ShowReplayTimelineItemView) {
  annotationTarget.value = item
  annotationComment.value = ""
  annotationVisible.value = true
}

function applyWorkspace(value: ShowReviewWorkspaceView) {
  workspace.value = value
  studentSummary.value = value.evaluation.studentSummary
  const structured = value.evaluation.studentSummaryStructured
  studentSummaryStructured.value = structured
    ? { ...structured }
    : { completion: isLogistics.value ? "" : value.evaluation.studentSummary, problems: "", decisions: "", improvements: "" }
  const logisticsStructured = value.evaluation.logisticsStudentSummaryStructured
  logisticsStudentSummaryStructured.value = logisticsStructured
    ? { ...logisticsStructured }
    : { originalPlanProblems: isLogistics.value ? value.evaluation.studentSummary : "", responseLessons: "", routeAdjustmentSuggestions: "", schedulingOptimization: "", improvements: "" }
  teacherSummary.value = value.evaluation.summary
  teacherScores.value = value.evaluation.teacherScores.map((item) => ({ ...item }))
  replayTimeMs.value = replayFrames.value.length ? replayFrames.value[0]!.simulationTimeMs : 0
  selectedReplayAircraftId.value = replayFrame.value?.aircraft[0]?.id ?? ""
  selectedReplayRouteId.value = replayFrame.value?.routes[0]?.id ?? ""
  selectedReplayEventId.value = replayFrame.value?.events[0]?.id ?? ""
}

function toggleReplay() {
  if (replayPlaying.value) stopReplay()
  else {
    replayPlaying.value = true
    replayTimer = window.setInterval(() => {
      const next = Math.min(replayDurationMs.value, replayTimeMs.value + 1_000)
      replayTimeMs.value = next
      if (next >= replayDurationMs.value) stopReplay()
    }, 250)
  }
}

function stopReplay() {
  replayPlaying.value = false
  if (replayTimer !== null) window.clearInterval(replayTimer)
  replayTimer = null
}

function seekReplay(item: ShowReplayTimelineItemView) {
  if (item.simulationTimeMs === null || !isLogistics.value) return
  replayTimeMs.value = item.simulationTimeMs
}

function replaySelectionChanged() {
  selectedReplayEventId.value = replayFrame.value?.events.find((item) => item.id === selectedReplayEventId.value)?.id ?? replayFrame.value?.events[0]?.id ?? ""
  selectedReplayAircraftId.value = replayFrame.value?.aircraft.find((item) => item.id === selectedReplayAircraftId.value)?.id ?? replayFrame.value?.aircraft[0]?.id ?? ""
  selectedReplayRouteId.value = replayFrame.value?.routes.find((item) => item.id === selectedReplayRouteId.value)?.id ?? replayFrame.value?.routes[0]?.id ?? ""
}

watch(replayFrame, replaySelectionChanged, { deep: true })

async function submitAnnotation() {
  if (!annotationTarget.value) return
  await mutate(`${reviewBase.value}/annotations`, "POST", {
    timelineItemId: annotationTarget.value.id,
    simulationTimeMs: annotationTarget.value.simulationTimeMs,
    comment: annotationComment.value
  }, "时间轴讲评已添加")
  annotationVisible.value = false
}

async function generateReport(format: "DOCX" | "PDF") {
  if (!workspace.value || reportGenerating.value) return
  reportRequestedFormat.value = format
  reportGenerating.value = true
  reportGenerationError.value = ""
  loading.value = true
  try {
    applyWorkspace(await api<ShowReviewWorkspaceView>(`${reviewBase.value}/report/generate`, {
      method: "POST",
      body: JSON.stringify({ format })
    }))
    const report = workspace.value.report
    if (report?.downloadPath) await downloadApiFile(report.downloadPath, report.filename ?? `项目报告.${format.toLowerCase()}`)
    ElMessage.success(`${format === "PDF" ? "PDF" : "Word"} 项目报告已生成`)
  } catch (error) {
    reportGenerationError.value = error instanceof Error ? error.message : "项目报告生成失败"
    ElMessage.error(reportGenerationError.value)
  } finally {
    reportGenerating.value = false
    loading.value = false
  }
}

async function downloadCurrentReport() {
  const report = workspace.value?.report
  if (!report?.downloadPath) return
  try {
    await downloadApiFile(report.downloadPath, report.filename ?? "项目报告")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "项目报告下载失败")
  }
}

async function mutate(path: string, method: "POST" | "PUT", body: unknown, successMessage: string) {
  loading.value = true
  mutationError.value = ""
  lastMutation = { path, method, body: JSON.parse(JSON.stringify(body)), successMessage }
  try {
    applyWorkspace(await api<ShowReviewWorkspaceView>(path, { method, body: JSON.stringify(body) }))
    lastMutation = null
    ElMessage.success(successMessage)
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : "操作失败"
    ElMessage.error(mutationError.value)
  } finally {
    loading.value = false
  }
}

async function retryMutation() {
  if (!lastMutation) return
  const { path, method, body, successMessage } = lastMutation
  await mutate(path, method, body, successMessage)
}

function formatSimulationTime(value: number | null) {
  if (value === null) return "流程"
  const seconds = Math.max(0, Math.floor(value / 1_000))
  return `T+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function formatDate(value: string | null) {
  return value ? formatPlatformDateTime(value) : "-"
}

function kindLabel(kind: ShowReplayTimelineItemKind) {
  return ({ STAGE: "阶段", STATE: "状态", EVENT: "事件", ALERT: "告警", ACTION: "处置", REPORT: "报备" } as Record<ShowReplayTimelineItemKind, string>)[kind]
}

function timelineStatusLabel(status: string) {
  return ({
    RECORDED: "已记录", TRIGGERED: "已触发", OPEN: "待确认", ESCALATED: "已升级", ACKNOWLEDGED: "已确认",
    CONTROLLED: "已控制", RESOLVED: "已解除", APPLIED: "已执行", FAILED: "失败", REJECTED: "已拒绝",
    READY: "准备", TAKEOFF_PREPARATION: "起飞准备", BATCH_TAKEOFF: "分批起飞", TRANSIT_TO_SHOW: "转场",
    PERFORMANCE: "表演中", RETURN_TO_LAUNCH: "返航", BATCH_LANDING: "分批降落", COMPLETED: "已完成", ABORTED: "已中止"
  } as Record<string, string>)[status] ?? status
}

function metricStateLabel(state: string) {
  return state === "PASS" ? "达标" : state === "RISK" ? "需改进" : "记录"
}

function runtimeEvidenceLabel(item: ShowReplayTimelineItemView) {
  const sequence = item.payload?.runtimeEvidenceSequence
  return typeof sequence === "number" ? `Runtime evidence #${sequence}${item.correlationId ? ` · ${item.correlationId}` : ""}` : ""
}
</script>

<template>
  <section class="show-review-workspace" v-loading="loading">
    <header class="review-commandbar">
      <div><span>{{ isLogistics ? 'DELIVERY ASSESSMENT' : 'POST-FLIGHT ASSESSMENT' }}</span><h2>{{ isLogistics ? '物流运行评估' : '运行评估' }}</h2><p>{{ workspace?.actor === 'TEACHER' ? '运行指标、评分量表与成果文件' : isLogistics ? '回放配送运行并完成运行总结' : '回放运行过程并完成飞后总结' }}</p></div>
      <div class="review-commandbar-actions">
        <span class="review-status" :class="workspace?.evaluation.status.toLowerCase()"><i />{{ workspace?.evaluation.status === 'PENDING' && !workspace?.evaluation.studentSubmittedAt ? '总结待提交' : formatEvaluationStatus(workspace?.evaluation.status) }}</span>
        <el-button :icon="Refresh" circle title="刷新" @click="load" />
      </div>
    </header>

    <div v-if="mutationError" class="review-mutation-error" role="alert" aria-live="assertive">
      <span><strong>保存操作失败</strong><small>{{ mutationError }}</small><p>当前填写内容已保留，修复连接后可以直接重试，不会自动覆盖草稿。</p></span>
      <el-button type="warning" :loading="loading" :disabled="loading" @click="retryMutation">重试保存</el-button>
    </div>

    <div v-if="loadError && !workspace" class="review-load-error review-load-error-full" role="alert" aria-live="assertive">
      <span><strong>运行评估加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的评估数据，请检查连接后重新加载。</p></span>
      <el-button type="primary" :icon="Refresh" :loading="loading" @click="load">重新加载评估</el-button>
    </div>

    <main v-if="workspace" class="review-main">
      <div v-if="loadError" class="review-load-error" role="alert" aria-live="assertive">
        <span><strong>评估数据同步失败</strong><small>{{ loadError }}</small><p>当前页面数据已保留，可继续查看；重新加载成功后再保存或发布评价。</p></span>
        <el-button type="warning" :icon="Refresh" :loading="loading" @click="load">重试同步</el-button>
      </div>
      <section class="review-metric-strip">
        <header class="review-metric-intro"><el-icon><InfoFilled /></el-icon><span><strong>仿真指标</strong><small>服务端依据仿真轨迹和事件记录计算；用于辅助教师评分，不自动计入最终成绩</small></span></header>
        <template v-if="workspace?.evaluation.objectiveMetrics?.length"><div v-for="metric in workspace.evaluation.objectiveMetrics" :key="metric.code" :class="metric.state.toLowerCase()">
          <span>{{ metric.label }}</span><strong>{{ metric.displayValue }}</strong><small>{{ metricStateLabel(metric.state) }}</small><p class="metric-detail">依据：{{ metric.detail }}</p>
        </div></template><p v-else class="review-metric-empty" role="status"><strong>尚未生成仿真指标</strong><span>完成仿真运行并生成运行回放后，这里会显示时效、安全和运行表现指标。</span></p>
      </section>

      <section class="review-evidence-facts" aria-label="任务快照与运行记录">
        <header><el-icon><InfoFilled /></el-icon><span><strong>任务快照与运行记录</strong><small>以下信息来自已发布任务快照和运行会话，教师只能查看</small></span></header>
        <div class="review-evidence-facts-grid">
          <div><span>任务快照</span><strong>{{ assignmentSnapshot?.id ?? props.project.assignmentSnapshotId }}</strong><small>{{ assignmentSnapshot?.publishedAt ? formatDate(assignmentSnapshot.publishedAt) : '快照信息未同步' }}</small></div>
          <div><span>D2 方案版本</span><strong>{{ assignmentSnapshot?.planVersion ?? '-' }}</strong><small>checksum {{ assignmentSnapshot?.checksum ?? '-' }}</small></div>
          <div><span>地图资源版本</span><strong>{{ assignmentSnapshot?.mapResourceVersion ?? '-' }}</strong><small>场景资源 {{ assignmentSnapshot?.sceneResourceVersion ?? '-' }}</small></div>
          <div><span>运行历史 / 重连</span><strong>{{ currentRuntimeAttempt ? `回放第 ${currentRuntimeAttempt.attemptNo} 次` : '-' }}</strong><small>{{ runtimeAttempts.length ? runtimeAttempts.map(attemptLabel).join('；') : '未同步运行会话' }}</small></div>
        </div>
        <p v-if="isLogistics && logisticsAnalysisSections.length" class="review-route-evidence"><strong>G1 航线指标：</strong>{{ logisticsAnalysisSections[0]?.detail }}；{{ logisticsAnalysisSections[0]?.metrics.map((item) => `${item.label} ${item.displayValue}`).join('，') }}</p>
      </section>

      <section v-if="isLogistics && logisticsAnalysisSections.length" class="logistics-analysis-panel">
        <header><el-icon><DataAnalysis /></el-icon><span><strong>物流结果分析</strong><small>航线、时效、冲突、机群利用、异常响应与重调度的系统统计</small></span></header>
        <div class="logistics-analysis-grid">
          <article v-for="section in logisticsAnalysisSections" :key="section.code" :class="section.state.toLowerCase()">
            <header><span>{{ section.label }}</span><em>{{ metricStateLabel(section.state) }}</em></header>
            <strong>{{ section.headline }}</strong>
            <p>{{ section.detail }}</p>
            <dl><div v-for="metric in section.metrics" :key="metric.code"><dt>{{ metric.label }}</dt><dd>{{ metric.displayValue }}</dd></div></dl>
          </article>
        </div>
      </section>

      <section v-if="isLogistics && replayFrame && region" class="review-replay-panel">
        <header>
          <div><el-icon><VideoPlay /></el-icon><span><strong>物流运行回放</strong><small>二维 / 三维同步显示无人机、航线、订单和事件状态</small></span></div>
          <span class="replay-frame-state">{{ formatSimulationTime(replayFrame.simulationTimeMs) }} · {{ replayFrame.aircraft.length }} 架 · {{ replayFrame.orders.length }} 单</span>
        </header>
        <div class="review-replay-map"><V3UnifiedMap renderer="logistics-runtime" :region="region" :routes="replayFrame.routes" :aircraft="replayFrame.aircraft" :events="replayFrame.events" :selected-aircraft-id="selectedReplayAircraftId" :selected-route-id="selectedReplayRouteId" :selected-event-id="selectedReplayEventId" :mode="mapMode" /></div>
        <footer class="review-replay-controls">
          <el-button circle :icon="replayPlaying ? VideoPause : VideoPlay" :title="replayPlaying ? '暂停回放' : '播放回放'" @click="toggleReplay" />
          <input v-model.number="replayTimeMs" type="range" min="0" :max="Math.max(1, replayDurationMs)" step="1000" aria-label="回放时刻" />
          <time>{{ formatSimulationTime(replayTimeMs) }} / {{ formatSimulationTime(replayDurationMs) }}</time>
          <span><b>{{ replayFrame.summary.completedOrders }}</b> 完成 · <b>{{ replayFrame.summary.delayedOrders }}</b> 延误 · <b>{{ replayFrame.summary.failedOrders }}</b> 失败</span>
        </footer>
      </section>

      <section class="review-timeline-panel">
        <header>
          <div><el-icon><Timer /></el-icon><span><strong>统一回放时间轴</strong><small>{{ workspace?.timeline.length ?? 0 }} 个事件节点</small></span></div>
          <nav aria-label="时间轴筛选"><button v-for="item in kindOptions" :key="item.code" type="button" :class="{ active: activeKind === item.code }" :aria-pressed="activeKind === item.code" @click="activeKind = item.code">{{ item.label }}</button></nav>
        </header>
        <ol v-if="timeline.length" class="review-timeline">
          <li v-for="item in timeline" :key="item.id" :class="[item.kind.toLowerCase(), item.severity?.toLowerCase()]">
            <time>{{ formatSimulationTime(item.simulationTimeMs) }}<small>{{ formatDate(item.realTime) }}</small></time>
            <i class="timeline-node" />
            <article role="button" tabindex="0" :aria-label="`定位回放事件：${item.title}`" @click="seekReplay(item)" @keydown.enter="seekReplay(item)" @keydown.space.prevent="seekReplay(item)">
              <header><span>{{ kindLabel(item.kind) }}</span><strong>{{ item.title }}</strong><em>{{ timelineStatusLabel(item.status) }}</em></header>
              <p>{{ item.detail }}</p>
              <small v-if="runtimeEvidenceLabel(item)" class="timeline-evidence">{{ runtimeEvidenceLabel(item) }}</small>
              <div v-if="annotationsByItem.get(item.id)?.length" class="timeline-annotations">
                <div v-for="annotation in annotationsByItem.get(item.id)" :key="annotation.id"><el-icon><ChatLineRound /></el-icon><span><strong>{{ annotation.createdBy }}</strong><p>{{ annotation.comment }}</p></span></div>
              </div>
              <button v-if="workspace?.canReview" type="button" class="annotation-command" :aria-label="`为${item.title}添加讲评`" @click.stop="openAnnotation(item)"><el-icon><ChatLineRound /></el-icon>添加讲评</button>
            </article>
          </li>
        </ol>
        <div v-else class="review-empty"><strong>当前筛选没有时间轴节点</strong><span>切换筛选查看其他运行记录</span></div>
      </section>
    </main>

    <aside v-if="workspace" class="review-inspector">
      <template v-if="workspace?.actor === 'STUDENT'">
        <section class="review-summary-editor">
          <header><el-icon><Document /></el-icon><div><strong>{{ isLogistics ? '运行总结' : '飞后总结' }}</strong><small>{{ workspace.evaluation.studentSubmittedAt ? '已提交并锁定' : isLogistics ? '分析订单、告警、处置和改进措施' : '分析异常、决策和改进措施' }}</small></div></header>
          <div v-if="isLogistics" class="structured-summary-form">
            <label><span>原方案问题</span><el-input v-model="logisticsStudentSummaryStructured.originalPlanProblems" type="textarea" :rows="3" :maxlength="1600" show-word-limit :disabled="!studentCanEditSummary" placeholder="分析原航线、订单时序或资源安排中的问题。" /></label>
            <label><span>处置得失</span><el-input v-model="logisticsStudentSummaryStructured.responseLessons" type="textarea" :rows="3" :maxlength="1600" show-word-limit :disabled="!studentCanEditSummary" placeholder="说明异常识别、处置判断的有效做法与不足。" /></label>
            <label><span>航线调整建议</span><el-input v-model="logisticsStudentSummaryStructured.routeAdjustmentSuggestions" type="textarea" :rows="3" :maxlength="1600" show-word-limit :disabled="!studentCanEditSummary" placeholder="提出主航线、备用航线或等待点的调整建议。" /></label>
            <label><span>调度优化</span><el-input v-model="logisticsStudentSummaryStructured.schedulingOptimization" type="textarea" :rows="3" :maxlength="1600" show-word-limit :disabled="!studentCanEditSummary" placeholder="提出订单优先级、飞机利用和时刻安排的优化方法。" /></label>
            <label><span>改进措施</span><el-input v-model="logisticsStudentSummaryStructured.improvements" type="textarea" :rows="3" :maxlength="1600" show-word-limit :disabled="!studentCanEditSummary" placeholder="形成下一次训练可执行的改进措施。" /></label>
          </div>
          <div v-else class="structured-summary-form">
            <label><span>任务完成情况</span><el-input v-model="studentSummaryStructured.completion" type="textarea" :rows="4" :maxlength="2000" show-word-limit :disabled="!studentCanEditSummary" placeholder="说明任务是否完成、完成质量和关键结果。" /></label>
            <label><span>主要问题</span><el-input v-model="studentSummaryStructured.problems" type="textarea" :rows="4" :maxlength="2000" show-word-limit :disabled="!studentCanEditSummary" placeholder="记录运行中发现的问题、原因和影响。" /></label>
            <label><span>处置得失</span><el-input v-model="studentSummaryStructured.decisions" type="textarea" :rows="4" :maxlength="2000" show-word-limit :disabled="!studentCanEditSummary" placeholder="说明处置判断、执行效果和不足。" /></label>
            <label><span>改进措施</span><el-input v-model="studentSummaryStructured.improvements" type="textarea" :rows="4" :maxlength="2000" show-word-limit :disabled="!studentCanEditSummary" placeholder="提出下一次训练的具体改进措施。" /></label>
          </div>
          <footer v-if="studentCanEditSummary"><el-button @click="saveStudentSummary(false)">保存草稿</el-button><el-button type="primary" :icon="Upload" @click="saveStudentSummary(true)">提交总结</el-button></footer>
          <div v-else class="review-lock-note"><el-icon><CircleCheck /></el-icon><span><strong>{{ workspace.evaluation.studentSubmittedAt ? '飞后总结已提交' : '当前不可编辑' }}</strong><small>{{ formatDate(workspace.evaluation.studentSubmittedAt) }}</small></span></div>
        </section>

        <section v-if="studentResult.visible" class="published-evaluation">
          <header><span>{{ studentResult.published ? '最终成绩' : '教师反馈' }}</span><strong v-if="studentResult.totalScore !== null">{{ studentResult.totalScore.toFixed(1) }}</strong><small v-if="studentResult.totalScore !== null">/ 100</small></header>
          <div v-if="studentResult.scores.length" class="student-result-scores">
            <article v-for="item in studentResult.scores" :key="item.code"><span><strong>{{ item.label }}</strong><small v-if="item.comment">{{ item.comment }}</small></span><b>{{ item.score?.toFixed(1) }} / {{ item.maxScore }}</b></article>
          </div>
          <p v-if="studentResult.summary">{{ studentResult.summary }}</p>
        </section>
      </template>

      <template v-else>
        <section class="teacher-rubric">
          <header><el-icon><DataAnalysis /></el-icon><div><strong>教师综合评价</strong><small>冻结评价版本 · {{ workspace?.evaluation.rubricVersion }}</small></div><b>{{ scoreTotal.toFixed(1) }} / 100</b></header>
          <div class="review-scoring-policy"><span><strong>最终成绩由教师确认</strong><small>分项评分合计为最终成绩，系统统计仅作参考</small></span><b>{{ publishStatus.completedCount }}/{{ publishStatus.totalCount }} 已评分</b></div>
          <div class="rubric-list">
            <label v-for="item in teacherScores" :key="item.code"><span><strong>{{ item.label }}</strong><small>满分 {{ item.maxScore }}</small></span><el-input-number v-model="item.score" :min="0" :max="item.maxScore" :precision="1" :step="0.5" :disabled="!workspace?.canReview" /><el-input v-model="item.comment" maxlength="1000" :disabled="!workspace?.canReview" placeholder="分项意见" /></label>
          </div>
          <label class="teacher-summary"><span>综合讲评</span><el-input v-model="teacherSummary" type="textarea" :rows="5" maxlength="5000" show-word-limit :disabled="!workspace?.canReview" /></label>
          <div v-if="workspace?.canReview" class="review-publish-state" :class="{ ready: publishStatus.canPublish }"><el-icon><CircleCheck /></el-icon><span><strong>{{ publishStatus.canPublish ? '可以发布' : '暂不可发布' }}</strong><small>{{ publishStatus.canPublish ? `教师确认后发布 ${scoreTotal.toFixed(1)} 分并锁定报告` : publishStatus.blockedReason }}</small></span></div>
          <footer v-if="workspace?.canReview"><el-button @click="saveTeacherEvaluation(false)">保存评价</el-button><el-button type="primary" :icon="CircleCheck" :disabled="!publishStatus.canPublish" :title="publishStatus.blockedReason ?? '发布并锁定最终成绩'" @click="saveTeacherEvaluation(true)">发布评价</el-button></footer>
        </section>

        <section v-if="workspace?.cohortAnalytics" class="cohort-analytics">
          <header><strong>{{ isLogistics ? '物流班级任务分析' : '表演班级任务分析' }}</strong><small>{{ workspace.cohortAnalytics.completedCount }} / {{ workspace.cohortAnalytics.projectCount }} 已完成</small></header>
          <div><span><small>完成率</small><strong>{{ Math.round(workspace.cohortAnalytics.completionRate * 100) }}%</strong></span><span><small>平均分</small><strong>{{ workspace.cohortAnalytics.averageScore?.toFixed(1) ?? '-' }}</strong></span><span><small>平均响应</small><strong>{{ workspace.cohortAnalytics.averageResponseSeconds?.toFixed(1) ?? '-' }}s</strong></span></div>
          <div v-if="cohortOmissions.length || cohortErrors.length || workspace.cohortAnalytics.commonRisks.length || workspace.cohortAnalytics.eventTypes.length" class="cohort-breakdowns">
            <section v-if="!isLogistics && cohortOmissions.length"><header>常见漏项</header><ol><li v-for="item in cohortOmissions" :key="item.code"><span>{{ item.label }}</span><strong>{{ item.count }} 人</strong></li></ol></section>
            <section v-if="!isLogistics && cohortErrors.length"><header>错误类型</header><ol><li v-for="item in cohortErrors" :key="item.code"><span>{{ item.label }}</span><strong>{{ item.count }} 人</strong></li></ol></section>
            <section v-if="isLogistics && workspace.cohortAnalytics.commonRisks.length"><header>常见风险</header><ol><li v-for="item in workspace.cohortAnalytics.commonRisks" :key="item.code"><span>{{ item.label }}</span><strong>{{ item.count }} 人</strong></li></ol></section>
            <section v-if="workspace.cohortAnalytics.eventTypes.length"><header>事件分布</header><ol><li v-for="item in workspace.cohortAnalytics.eventTypes" :key="item.code"><span>{{ item.label }}</span><strong>{{ item.count }} 次</strong></li></ol></section>
          </div>
        </section>
      </template>

      <section v-if="reportActions.visible" class="report-actions">
        <header><el-icon><Download /></el-icon><div><strong>最终项目报告</strong><small>每次保留一个当前格式文件</small></div><span class="report-state" role="status" aria-live="polite" :class="{ failed: reportGenerationError }">{{ reportGenerating ? `正在生成 ${reportRequestedFormat}` : reportGenerationError ? '生成失败' : workspace?.report ? `${workspace.report.format} 已生成` : '尚未生成' }}</span></header>
        <p v-if="!reportActions.canGenerate && workspace?.actor === 'TEACHER' && workspace?.evaluation.status !== 'PUBLISHED'" class="report-blocked">请先发布教师综合评价，再生成最终项目报告。</p>
        <p v-if="reportGenerationError" class="report-error">{{ reportGenerationError }}。可以重新生成；已有当前报告仍可继续下载。</p>
        <div v-if="reportActions.canGenerate" class="report-generate-actions"><el-button :icon="Document" :loading="reportGenerating && reportRequestedFormat === 'DOCX'" :disabled="reportGenerating" @click="generateReport('DOCX')">{{ reportGenerating && reportRequestedFormat === 'DOCX' ? '生成中...' : '生成 Word' }}</el-button><el-button type="primary" :loading="reportGenerating && reportRequestedFormat === 'PDF'" :disabled="reportGenerating" @click="generateReport('PDF')">{{ reportGenerating && reportRequestedFormat === 'PDF' ? '生成中...' : '生成 PDF' }}</el-button></div>
        <button v-if="reportActions.canDownload && workspace?.report" type="button" class="current-report" :aria-label="`下载当前${workspace.report.format ?? ''}成果文件 ${workspace.report.filename ?? ''}`" @click="downloadCurrentReport"><span><strong>{{ workspace.report.filename }}</strong><small>R{{ workspace.report.revision }} · {{ workspace.report.format }} · {{ Math.ceil((workspace.report.sizeBytes ?? 0) / 1024) }} KB</small></span><el-icon><Download /></el-icon></button>
      </section>
    </aside>

    <el-dialog v-model="annotationVisible" title="添加时间轴讲评" width="440px" append-to-body>
      <div class="annotation-dialog"><span>{{ annotationTarget ? formatSimulationTime(annotationTarget.simulationTimeMs) : '-' }}</span><strong>{{ annotationTarget?.title }}</strong><el-input v-model="annotationComment" type="textarea" :rows="5" maxlength="1000" show-word-limit placeholder="记录判断依据、漏项或改进建议。" /></div>
      <template #footer><el-button @click="annotationVisible = false">取消</el-button><el-button type="primary" :disabled="!annotationComment.trim()" @click="submitAnnotation">保存讲评</el-button></template>
    </el-dialog>
  </section>
</template>

<style scoped>
.show-review-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0, 1fr) 360px; grid-template-rows: 78px minmax(0, 1fr); min-width: 0; min-height: 0; color: #1a2822; background: #edf2ef; }
.review-mutation-error { grid-column: 1 / 3; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 8px 18px 0; border-left: 3px solid #b05a45; padding: 10px 12px; color: #653b31; background: #fff4f1; font-size: 11px; }
.review-mutation-error > span { display: grid; min-width: 0; gap: 3px; }
.review-mutation-error strong { font-size: 10px; }
.review-mutation-error small { overflow-wrap: anywhere; }
.review-mutation-error p { margin: 0; color: #765b54; line-height: 1.5; }
.review-mutation-error .el-button { flex: 0 0 auto; }
.review-commandbar { display: flex; grid-column: 1 / 3; align-items: center; justify-content: space-between; border-bottom: 1px solid #cdd9d3; padding: 10px 18px; background: #fff; }
.review-commandbar > div:first-child { display: grid; gap: 2px; }
.review-commandbar span { color: #247354; font-size: 11px; font-weight: 800; }
.review-commandbar h2 { margin: 0; font-size: 16px; }
.review-commandbar p { margin: 0; color: #71847b; font-size: 11px; }
.review-commandbar-actions { display: flex; align-items: center; gap: 9px; }
.review-load-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; border-left: 3px solid #b05a45; padding: 12px 14px; color: #653b31; background: #fff4f1; }
.review-load-error-full { grid-column: 1 / 3; align-self: start; margin: 24px; }
.review-load-error > span { display: grid; min-width: 0; gap: 3px; }
.review-load-error strong { font-size: 10px; }
.review-load-error small { overflow-wrap: anywhere; font-size: 11px; }
.review-load-error p { margin: 0; color: #765b54; font-size: 11px; line-height: 1.5; }
.review-load-error .el-button { flex: 0 0 auto; }
.review-status { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #c9d6d0; padding: 6px 9px; color: #5e7268 !important; background: #f7faf8; }
.review-status i { width: 6px; height: 6px; border-radius: 50%; background: #8ea198; }
.review-status.published i { background: #247354; }
.review-main { min-width: 0; min-height: 0; overflow: auto; padding: 18px; }
.review-metric-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid #ccd8d2; border-left: 1px solid #ccd8d2; background: #fff; }
.review-metric-empty { grid-column: 1 / -1; display: grid; gap: 4px; margin: 0; padding: 12px; color: #62776c; font-size: 11px; line-height: 1.5; }.review-metric-empty strong { color: #365e4d; font-size: 11px; }
.review-metric-intro { display: flex; grid-column: 1 / -1; align-items: center; gap: 8px; border-right: 1px solid #ccd8d2; border-bottom: 1px solid #ccd8d2; padding: 8px 12px; background: #f7faf8; }
.review-metric-intro .el-icon { color: #247354; }
.review-metric-intro span { display: grid; }
.review-metric-intro strong { font-size: 11px; }
.review-metric-intro small { color: #71847b; font-size: 11px; }
.review-metric-strip > div { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px; border-right: 1px solid #ccd8d2; border-bottom: 1px solid #ccd8d2; padding: 11px 12px; }
.review-metric-strip span { grid-column: 1 / 3; color: #71847b; font-size: 11px; }
.review-metric-strip strong { overflow: hidden; font-size: 16px; text-overflow: ellipsis; white-space: nowrap; }
.review-metric-strip small { align-self: center; color: #71847b; font-size: 11px; }
.review-metric-strip .metric-detail { grid-column: 1 / 3; margin: 0; color: #62776c; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.review-metric-strip .risk { border-top: 2px solid #b05a45; }
.review-metric-strip .pass { border-top: 2px solid #247354; }
.logistics-analysis-panel { margin-top: 14px; border: 1px solid #cedad4; background: #fff; }
.logistics-analysis-panel > header { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d5dfda; padding: 10px 14px; }
.logistics-analysis-panel > header .el-icon { color: #247354; }
.logistics-analysis-panel > header span { display: grid; }
.logistics-analysis-panel > header strong { font-size: 10px; }
.logistics-analysis-panel > header small { color: #71847b; font-size: 11px; }
.logistics-analysis-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.logistics-analysis-grid article { min-width: 0; border-right: 1px solid #dce4e0; border-bottom: 1px solid #dce4e0; padding: 12px 14px; }
.logistics-analysis-grid article:nth-child(2n) { border-right: 0; }
.logistics-analysis-grid article:nth-last-child(-n + 2) { border-bottom: 0; }
.logistics-analysis-grid article.pass { box-shadow: inset 3px 0 #247354; }
.logistics-analysis-grid article.risk { box-shadow: inset 3px 0 #b05a45; }
.logistics-analysis-grid article.info { box-shadow: inset 3px 0 #7f9188; }
.logistics-analysis-grid article > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.logistics-analysis-grid article > header span { color: #526f62; font-size: 11px; font-weight: 800; }
.logistics-analysis-grid article > header em { color: #71847b; font-size: 11px; font-style: normal; }
.logistics-analysis-grid article > strong { display: block; margin-top: 7px; font-size: 13px; }
.logistics-analysis-grid article > p { min-height: 30px; margin: 5px 0 10px; color: #60736a; font-size: 11px; line-height: 1.55; }
.logistics-analysis-grid dl { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0; border-top: 1px solid #e0e7e3; }
.logistics-analysis-grid dl div { min-width: 0; padding: 7px 5px 0 0; }
.logistics-analysis-grid dt { overflow: hidden; color: #829087; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.logistics-analysis-grid dd { overflow: hidden; margin: 2px 0 0; color: #244d3c; font-size: 11px; font-weight: 800; text-overflow: ellipsis; white-space: nowrap; }
.review-timeline-panel { margin-top: 14px; border: 1px solid #cedad4; background: #fff; }
.review-timeline-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid #d5dfda; padding: 12px 14px; }
.review-timeline-panel > header > div { display: flex; align-items: center; gap: 8px; }
.review-timeline-panel > header .el-icon { color: #247354; }
.review-timeline-panel > header span { display: grid; }
.review-timeline-panel > header strong { font-size: 10px; }
.review-timeline-panel > header small { color: #71847b; font-size: 11px; }
.review-timeline-panel nav { display: flex; border: 1px solid #ccd8d2; padding: 2px; background: #f1f5f3; }
.review-timeline-panel nav button { min-width: 42px; border: 0; padding: 5px 7px; color: #6a7c73; font-size: 11px; background: transparent; cursor: pointer; }
.review-timeline-panel nav button.active { color: #173f32; background: #fff; box-shadow: 0 1px 2px rgb(32 75 58 / 10%); }
.review-timeline { display: grid; margin: 0; padding: 8px 0 18px; list-style: none; }
.review-timeline li { display: grid; grid-template-columns: 100px 20px minmax(0, 1fr); padding: 9px 14px 0; }
.review-timeline time { display: grid; align-content: start; justify-items: end; gap: 3px; padding-top: 3px; color: #315e4b; font-size: 11px; font-weight: 800; }
.review-timeline time small { color: #8a9891; font-size: 11px; font-weight: 400; text-align: right; }
.timeline-node { position: relative; display: block; width: 8px; height: 8px; margin: 6px auto 0; border: 2px solid #fff; border-radius: 50%; outline: 1px solid #6c8f7f; background: #247354; }
.timeline-node::after { position: absolute; top: 8px; left: 2px; width: 1px; height: calc(100% + 60px); background: #d5dfda; content: ""; }
.review-timeline li:last-child .timeline-node::after { display: none; }
.review-timeline li.warning .timeline-node, .review-timeline li.error .timeline-node, .review-timeline li.critical .timeline-node { background: #b05a45; outline-color: #b05a45; }
.review-replay-panel { margin-top: 14px; border: 1px solid #cedad4; background: #fff; }
.review-replay-panel > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #d5dfda; padding: 10px 14px; }
.review-replay-panel > header > div { display: flex; align-items: center; gap: 8px; }
.review-replay-panel > header .el-icon { color: #247354; }
.review-replay-panel > header span { display: grid; }
.review-replay-panel > header strong { font-size: 10px; }
.review-replay-panel > header small, .replay-frame-state { color: #71847b; font-size: 11px; }
.review-replay-map { height: 300px; min-height: 260px; }
.review-replay-controls { display: grid; grid-template-columns: 34px minmax(80px, 1fr) auto minmax(150px, auto); align-items: center; gap: 9px; border-top: 1px solid #d5dfda; padding: 8px 12px; color: #61756b; font-size: 11px; }
.review-replay-controls input { width: 100%; accent-color: #247354; }
.review-replay-controls time { color: #315e4b; font: 800 8px ui-monospace, SFMono-Regular, Consolas, monospace; white-space: nowrap; }
.review-replay-controls > span { text-align: right; white-space: nowrap; }
.review-replay-controls b { color: #1e5e45; }
.review-timeline article { min-width: 0; border-bottom: 1px solid #e0e7e3; padding: 0 0 12px 8px; cursor: pointer; }
.review-timeline article:focus-visible { outline: 2px solid #247354; outline-offset: 2px; }
.review-timeline article > header { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: center; gap: 7px; }
.review-timeline article > header span { color: #247354; font-size: 11px; font-weight: 800; }
.review-timeline article > header strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.review-timeline article > header em { color: #76877f; font-size: 11px; font-style: normal; }
.review-timeline article > p { margin: 5px 0 0; color: #60736a; font-size: 11px; line-height: 1.55; }
.timeline-evidence { display: block; margin-top: 5px; color: #7a8e83; font: 7px ui-monospace, SFMono-Regular, Consolas, monospace; overflow-wrap: anywhere; }
.timeline-annotations { display: grid; gap: 5px; margin-top: 8px; }
.timeline-annotations > div { display: flex; gap: 6px; border-left: 2px solid #247354; padding: 7px 9px; background: #eef5f1; }
.timeline-annotations .el-icon { flex: 0 0 auto; margin-top: 2px; color: #247354; }
.timeline-annotations span { display: grid; gap: 2px; }
.timeline-annotations strong { font-size: 11px; }
.timeline-annotations p { margin: 0; color: #51675d; font-size: 11px; }
.annotation-command { display: inline-flex; align-items: center; gap: 4px; margin-top: 7px; border: 0; padding: 0; color: #247354; font-size: 11px; background: transparent; cursor: pointer; }
.review-empty { display: grid; justify-items: center; gap: 4px; padding: 60px 20px; }
.review-empty strong { font-size: 11px; }
.review-empty span { color: #71847b; font-size: 11px; }
.review-inspector { min-height: 0; overflow: auto; border-left: 1px solid #cdd9d3; padding: 16px; background: #f9fbfa; }
.review-summary-editor, .teacher-rubric, .cohort-analytics, .report-actions, .published-evaluation { border-top: 2px solid #247354; padding: 14px; background: #fff; }
.review-summary-editor > header, .teacher-rubric > header, .report-actions > header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.review-summary-editor > header .el-icon, .teacher-rubric > header .el-icon, .report-actions > header .el-icon { color: #247354; }
.review-summary-editor > header div, .teacher-rubric > header div, .report-actions > header div { display: grid; min-width: 0; }
.review-summary-editor > header strong, .teacher-rubric > header strong, .report-actions > header strong { font-size: 10px; }
.review-summary-editor > header small, .teacher-rubric > header small, .report-actions > header small { color: #71847b; font-size: 11px; }
.review-summary-editor > footer, .teacher-rubric > footer { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 10px; }
.structured-summary-form { display: grid; gap: 10px; }
.structured-summary-form label { display: grid; gap: 5px; }
.structured-summary-form label > span { color: #63776e; font-size: 11px; font-weight: 750; }
.review-lock-note { display: flex; align-items: center; gap: 8px; margin-top: 10px; border-left: 3px solid #247354; padding: 9px 10px; background: #edf5f1; }
.review-lock-note .el-icon { color: #247354; }
.review-lock-note span { display: grid; }
.review-lock-note strong { font-size: 11px; }
.review-lock-note small { color: #71847b; font-size: 11px; }
.published-evaluation { display: grid; gap: 10px; margin-top: 12px; }
.published-evaluation header { display: flex; align-items: baseline; gap: 4px; }
.published-evaluation header span { margin-right: auto; color: #71847b; font-size: 11px; }
.published-evaluation header strong { font-size: 28px; }
.published-evaluation header small { color: #71847b; font-size: 11px; }
.published-evaluation p { margin: 0; color: #52675d; font-size: 11px; line-height: 1.6; }
.student-result-scores { display: grid; border-top: 1px solid #d6e0db; }
.student-result-scores article { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; border-bottom: 1px solid #d6e0db; padding: 8px 0; }
.student-result-scores article span { display: grid; min-width: 0; gap: 2px; }
.student-result-scores article strong { font-size: 11px; }
.student-result-scores article small { color: #71847b; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.student-result-scores article b { color: #173f32; font-size: 11px; white-space: nowrap; }
.teacher-rubric > header b { margin-left: auto; color: #173f32; font-size: 10px; }
.review-scoring-policy { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; border-left: 3px solid #247354; padding: 8px 9px; background: #edf5f1; }
.review-scoring-policy span { display: grid; min-width: 0; }
.review-scoring-policy strong { font-size: 11px; }
.review-scoring-policy small { color: #61756b; font-size: 11px; line-height: 1.45; }
.review-scoring-policy b { flex: 0 0 auto; color: #247354; font-size: 11px; }
.rubric-list { display: grid; border-top: 1px solid #d6e0db; }
.rubric-list label { display: grid; grid-template-columns: minmax(0, 1fr) 104px; gap: 7px; border-bottom: 1px solid #d6e0db; padding: 9px 0; }
.rubric-list label > span { display: grid; align-content: center; }
.rubric-list label > span strong { font-size: 11px; }
.rubric-list label > span small { color: #7b8c84; font-size: 11px; }
.rubric-list label > .el-input-number { width: 100%; min-width: 0; }
.rubric-list label > .el-input:last-child { grid-column: 1 / 3; }
.teacher-summary { display: grid; gap: 6px; margin-top: 11px; }
.teacher-summary > span { color: #63776e; font-size: 11px; }
.review-publish-state { display: flex; align-items: center; gap: 7px; margin-top: 9px; border-left: 3px solid #b05a45; padding: 8px 9px; background: #fbf1ee; }
.review-publish-state.ready { border-left-color: #247354; background: #edf5f1; }
.review-publish-state .el-icon { flex: 0 0 auto; color: #b05a45; }
.review-publish-state.ready .el-icon { color: #247354; }
.review-publish-state span { display: grid; min-width: 0; }
.review-publish-state strong { font-size: 11px; }
.review-publish-state small { color: #66786f; font-size: 11px; line-height: 1.45; }
.cohort-analytics { margin-top: 12px; border-top-color: #526f62; }
.cohort-analytics > header { display: flex; justify-content: space-between; margin-bottom: 10px; }
.cohort-analytics > header strong { font-size: 10px; }
.cohort-analytics > header small { color: #71847b; font-size: 11px; }
.cohort-analytics > div { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid #d7e1dc; }
.cohort-analytics > div span { display: grid; gap: 3px; border-right: 1px solid #d7e1dc; padding: 8px; }
.cohort-analytics > div span:last-child { border-right: 0; }
.cohort-analytics > div small { color: #71847b; font-size: 11px; }
.cohort-analytics > div strong { font-size: 13px; }
.cohort-breakdowns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
.cohort-breakdowns section { min-width: 0; }
.cohort-breakdowns section > header { color: #526f62; font-size: 11px; font-weight: 800; }
.cohort-analytics ol { margin: 5px 0 0; padding: 0; list-style: none; }
.cohort-analytics li { display: flex; justify-content: space-between; border-top: 1px solid #dce4e0; padding: 7px 0; font-size: 11px; }
.cohort-analytics li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cohort-analytics li strong { flex: 0 0 auto; margin-left: 8px; }
.report-actions { margin-top: 12px; }
.report-actions > div { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.report-actions > header { min-width: 0; }
.report-actions > header > div { flex: 1; min-width: 0; }
.report-state { margin-left: auto; color: #247354; font-size: 11px; white-space: nowrap; }
.report-state.failed { color: #a86235; }
.report-error { margin: -4px 0 8px; border-left: 3px solid #b96d3e; padding: 7px 9px; color: #875230; background: #fff5ed; font-size: 11px; line-height: 1.5; }
.report-blocked { margin: -4px 0 8px; border-left: 3px solid #bd8531; padding: 7px 9px; color: #765f32; background: #fff8e9; font-size: 11px; line-height: 1.5; }
.report-generate-actions { margin-top: 2px; }
.current-report { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; margin-top: 9px; border: 1px solid #d1ddd7; padding: 9px 10px; color: #1e3028; text-align: left; background: #f5f8f6; cursor: pointer; }
.current-report span { display: grid; min-width: 0; }
.current-report strong { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.current-report small { color: #71847b; font-size: 11px; }
.current-report .el-icon { flex: 0 0 auto; color: #247354; }
.annotation-dialog { display: grid; gap: 7px; }
.annotation-dialog > span { color: #247354; font-size: 11px; font-weight: 800; }
.annotation-dialog > strong { font-size: 11px; }
.review-evidence-facts { margin-top: 14px; border: 1px solid #cedad4; background: #fff; }
.review-evidence-facts > header { display: flex; align-items: center; gap: 8px; border-bottom: 1px solid #d5dfda; padding: 10px 14px; }
.review-evidence-facts > header .el-icon { color: #247354; }
.review-evidence-facts > header span { display: grid; }
.review-evidence-facts > header strong { font-size: 10px; }
.review-evidence-facts > header small { color: #71847b; font-size: 11px; }
.review-evidence-facts-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.review-evidence-facts-grid > div { display: grid; min-width: 0; gap: 4px; border-right: 1px solid #dce4e0; padding: 10px 12px; }
.review-evidence-facts-grid > div:last-child { border-right: 0; }
.review-evidence-facts-grid span { color: #71847b; font-size: 11px; }
.review-evidence-facts-grid strong { overflow: hidden; color: #244d3c; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.review-evidence-facts-grid small { color: #60736a; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.review-route-evidence { margin: 0; border-top: 1px solid #dce4e0; padding: 9px 12px; color: #52675d; font-size: 11px; line-height: 1.5; }
.review-route-evidence strong { color: #247354; }
@media (max-width: 1080px) { .show-review-workspace { grid-template-columns: minmax(0, 1fr) 320px; } .review-metric-strip { grid-template-columns: repeat(2, 1fr); } .logistics-analysis-grid { grid-template-columns: 1fr; } .logistics-analysis-grid article, .logistics-analysis-grid article:nth-child(2n), .logistics-analysis-grid article:nth-last-child(-n + 2) { border-right: 0; border-bottom: 1px solid #dce4e0; } .logistics-analysis-grid article:last-child { border-bottom: 0; } }
@media (max-width: 1080px) { .review-evidence-facts-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .review-evidence-facts-grid > div:nth-child(2n) { border-right: 0; } }
@media (max-width: 760px) { .show-review-workspace { display: block; grid-column: 1; grid-row: 3 / 5; height: 100%; overflow-y: auto; overflow-x: hidden; } .review-commandbar { grid-column: 1; } .review-mutation-error { align-items: stretch; flex-direction: column; margin: 8px 10px 0; } .review-load-error { align-items: stretch; flex-direction: column; } .review-load-error-full { margin: 12px; } .review-main { overflow: visible; padding: 10px; } .review-inspector { overflow: visible; border-top: 1px solid #cdd9d3; border-left: 0; } .logistics-analysis-grid dl { grid-template-columns: repeat(2, minmax(0, 1fr)); } .review-replay-controls { grid-template-columns: 34px minmax(80px, 1fr) auto; } .review-replay-controls > span { grid-column: 1 / -1; text-align: left; } .review-timeline-panel > header { align-items: stretch; flex-direction: column; } .review-timeline-panel nav { overflow-x: auto; } .review-timeline li { grid-template-columns: 74px 18px minmax(0, 1fr); padding-right: 9px; padding-left: 9px; } .rubric-list label { grid-template-columns: minmax(0, 1fr); } .rubric-list label > .el-input-number, .rubric-list label > .el-input { width: 100%; } .rubric-list label > .el-input:last-child { grid-column: 1; } .review-evidence-facts-grid { grid-template-columns: 1fr; } .review-evidence-facts-grid > div, .review-evidence-facts-grid > div:nth-child(2n) { border-right: 0; border-bottom: 1px solid #dce4e0; } .review-evidence-facts-grid > div:last-child { border-bottom: 0; } }
</style>
