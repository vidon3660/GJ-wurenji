<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Check, Download, Refresh, Upload } from "@element-plus/icons-vue"
import type { AuthUser, StudentProjectStageView, StudentProjectView, V3RegionCatalogItem, V3RegionLayerCode, VtlPlanningWorkspaceView, VtlReviewView } from "@wurenji/shared"
import { api, downloadApiFile } from "../api"
import {
  advanceRuntimePlaybackTime,
  runtimeEvidenceAtTime,
  runtimeTimelineMarkers,
  vtlReplayAircraftResults,
  vtlReplayFrameAt,
  vtlReplayTaskResults,
  type RuntimeTimelineMarker
} from "../runtime-playback"
import V3UnifiedMap from "./V3UnifiedMap.vue"
import V3EnvironmentLayerPanel from "./V3EnvironmentLayerPanel.vue"
import V3RuntimePlaybackBar from "./V3RuntimePlaybackBar.vue"
import { runtimeActionReasoning } from "../runtime-action-reasoning"
import { formatEvaluationStatus, formatReportJobStatus, formatTimelineStatus } from "../terminology"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
  region: V3RegionCatalogItem | null
  mapMode: "2d" | "3d"
}>()
const emit = defineEmits<{ refreshProject: [] }>()
const loading = ref(false)
const loadError = ref("")
const mutationError = ref("")
const workspace = ref<VtlReviewView | null>(null)
const planning = ref<VtlPlanningWorkspaceView | null>(null)
const studentSummary = ref("")
const teacherSummary = ref("")
const teacherScores = ref<VtlReviewView["teacherScores"]>([])
const timelineFilter = ref<"ALL" | "STATE" | "EVENT" | "ALERT" | "ACTION">("ALL")
const replayTimeMs = ref(0)
const replayRate = ref(1)
const replayPlaying = ref(false)
const selectedTimelineItemId = ref("")
const reportFormat = ref<"DOCX" | "PDF">("PDF")
const reportPollingError = ref("")
const visibleMapLayers = ref<V3RegionLayerCode[]>([])
let playbackTimer: number | null = null
let reportJobTimer: number | null = null
let reportPollingInFlight = false
let lastPlaybackTick = 0
let lastMutation: { path: string; method: "POST" | "PUT"; body: Record<string, unknown>; success: string } | null = null

watch(() => props.region, (region) => {
  visibleMapLayers.value = region?.layers
    .filter((layer) => layer.state !== "UNAVAILABLE" && ["BUILDINGS", "RESTRICTIONS", "WATER", "GREENLAND"].includes(layer.code))
    .map((layer) => layer.code) ?? []
}, { immediate: true, deep: true })

const isTeacher = computed(() => props.user.role === "teacher" || props.user.role === "admin")
const scoreTotal = computed(() => teacherScores.value.reduce((sum, item) => sum + Number(item.score ?? 0), 0))
const canSubmitStudent = computed(() => studentSummary.value.trim().length >= 10 && Boolean(workspace.value?.canSubmitSummary))
const canSaveTeacher = computed(() => Boolean(workspace.value?.canReview && teacherScores.value.length > 0))
const canPublish = computed(() => Boolean(workspace.value?.canPublish && teacherScores.value.every((item) => typeof item.score === "number") && teacherSummary.value.trim().length >= 10))
const reportJobBusy = computed(() => ["PENDING", "RUNNING", "RETRY_WAIT"].includes(workspace.value?.reportJob?.status ?? ""))
const reportJobLabel = computed(() => {
  return formatReportJobStatus(workspace.value?.reportJob?.status)
})
const replayDurationMs = computed(() => Math.max(1, workspace.value?.replayFrames.at(-1)?.simulationTimeMs ?? 1))
const replayFrame = computed(() => vtlReplayFrameAt(workspace.value?.replayFrames ?? [], replayTimeMs.value))
const replayTaskResults = computed(() => vtlReplayTaskResults(replayFrame.value))
const replayAircraftResults = computed(() => vtlReplayAircraftResults(replayFrame.value))
const timeline = computed(() => {
  const visible = runtimeEvidenceAtTime(workspace.value?.timeline ?? [], replayFrame.value?.simulationTimeMs ?? replayTimeMs.value)
  return timelineFilter.value === "ALL" ? visible : visible.filter((item) => item.kind === timelineFilter.value)
})
const replayReorganizations = computed(() => (workspace.value?.reorganizations ?? [])
  .filter((item) => item.executedAtMs <= (replayFrame.value?.simulationTimeMs ?? replayTimeMs.value)))
const replayMarkers = computed(() => runtimeTimelineMarkers((workspace.value?.timeline ?? [])
  .filter((item) => item.kind !== "STATE" && item.simulationTimeMs !== null)
  .map((item) => ({ id: item.id, code: item.kind, title: item.title, severity: item.severity ?? "INFO", scheduledSimulationTimeMs: item.simulationTimeMs })), replayDurationMs.value))

onMounted(() => {
  lastPlaybackTick = performance.now()
  void load()
})
onBeforeUnmount(() => {
  stopPlaybackTimer()
  stopReportJobPolling()
})
watch(replayPlaying, syncPlaybackTimer)
watch(() => props.project.id, () => {
  stopReportJobPolling()
  replayPlaying.value = false
  replayTimeMs.value = 0
  selectedTimelineItemId.value = ""
  void load()
})

async function load() {
  loading.value = true
  loadError.value = ""
  try {
    const [review, plan] = await Promise.all([
      api<VtlReviewView>(`/v3/vtl-projects/${props.project.id}/review`),
      api<VtlPlanningWorkspaceView>(`/v3/vtl-projects/${props.project.id}/planning-workspace`)
    ])
    planning.value = plan
    applyWorkspace(review)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "巡检评估加载失败"
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

function applyWorkspace(value: VtlReviewView) {
  workspace.value = value
  studentSummary.value = value.studentSummary
  teacherSummary.value = value.teacherSummary
  teacherScores.value = value.teacherScores.map((item) => ({ ...item }))
  syncReportJobPolling()
  if (replayTimeMs.value === 0 || replayTimeMs.value > replayDurationMs.value) replayTimeMs.value = replayDurationMs.value
}

function syncReportJobPolling() {
  if (reportJobBusy.value) {
    if (reportJobTimer === null) reportJobTimer = window.setInterval(() => void pollReportJob(), 2_000)
    return
  }
  stopReportJobPolling()
}

function stopReportJobPolling() {
  if (reportJobTimer !== null) window.clearInterval(reportJobTimer)
  reportJobTimer = null
  reportPollingInFlight = false
}

async function pollReportJob() {
  if (reportPollingInFlight || !reportJobBusy.value) return
  reportPollingInFlight = true
  try {
    applyWorkspace(await api<VtlReviewView>(`/v3/vtl-projects/${props.project.id}/review`))
    reportPollingError.value = ""
  } catch {
    reportPollingError.value = "报告状态暂时无法同步，系统会继续重试。当前页面数据未被清除。"
  } finally {
    reportPollingInFlight = false
  }
}

function tickPlayback() {
  const now = performance.now()
  const elapsed = now - lastPlaybackTick
  lastPlaybackTick = now
  if (!replayPlaying.value) return
  replayTimeMs.value = advanceRuntimePlaybackTime(replayTimeMs.value, elapsed, replayRate.value, replayDurationMs.value)
  if (replayTimeMs.value >= replayDurationMs.value) replayPlaying.value = false
}

function syncPlaybackTimer(playing: boolean) {
  if (playing && playbackTimer === null) {
    lastPlaybackTick = performance.now()
    playbackTimer = window.setInterval(tickPlayback, 100)
    return
  }
  if (!playing) stopPlaybackTimer()
}

function stopPlaybackTimer() {
  if (playbackTimer !== null) window.clearInterval(playbackTimer)
  playbackTimer = null
}

function toggleReplay() {
  if (replayTimeMs.value >= replayDurationMs.value) replayTimeMs.value = 0
  replayPlaying.value = !replayPlaying.value
}

function seekReplay(timeMs: number) {
  replayPlaying.value = false
  replayTimeMs.value = Math.max(0, Math.min(replayDurationMs.value, timeMs))
}

function selectTimelineItem(item: VtlReviewView["timeline"][number]) {
  selectedTimelineItemId.value = item.id
  if (item.simulationTimeMs !== null) seekReplay(item.simulationTimeMs)
}

function selectReplayMarker(marker: RuntimeTimelineMarker) {
  selectedTimelineItemId.value = marker.id
  seekReplay(marker.timeMs)
}

async function saveStudentSummary(submit: boolean) {
  if (!workspace.value) return
  if (submit) {
    try {
      await ElMessageBox.confirm("确认提交巡检总结？提交后由教师填写评价。", "提交巡检总结", { confirmButtonText: "确认提交", cancelButtonText: "取消", type: "warning" })
    } catch { return }
  }
  await mutate(`/v3/vtl-projects/${props.project.id}/review/summary${submit ? "/submit" : ""}`, submit ? "POST" : "PUT", { expectedRevision: workspace.value.evaluationRevision, summary: studentSummary.value }, submit ? "巡检总结已提交" : "总结草稿已保存")
  if (submit) emit("refreshProject")
}

async function saveTeacherEvaluation(publish: boolean) {
  if (!workspace.value) return
  if (publish) {
    try {
      await ElMessageBox.confirm(`确认发布 ${scoreTotal.value.toFixed(1)} 分的巡检评价？发布后评价内容锁定。`, "发布巡检评价", { confirmButtonText: "确认发布", cancelButtonText: "取消", type: "warning" })
    } catch { return }
  }
  const path = publish ? "evaluation/publish" : "evaluation"
  const body = publish ? { expectedRevision: workspace.value.evaluationRevision } : { expectedRevision: workspace.value.evaluationRevision, teacherScores: teacherScores.value, summary: teacherSummary.value }
  await mutate(`/v3/vtl-projects/${props.project.id}/review/${path}`, publish ? "POST" : "PUT", body, publish ? "巡检评价已发布" : "评价草稿已保存")
  if (publish) emit("refreshProject")
}

async function generateReport() {
  if (reportJobBusy.value) return
  await mutate(`/v3/vtl-projects/${props.project.id}/review/report/generate`, "POST", { format: reportFormat.value }, `巡检 ${reportFormat.value} 成果文件已提交后台生成`)
}

async function downloadReport() {
  try {
    await downloadApiFile(`/v3/vtl-projects/${props.project.id}/review/report/download`, workspace.value?.report?.filename ?? `垂起广域巡检报告.${reportFormat.value.toLowerCase()}`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "报告下载失败")
  }
}

async function mutate(path: string, method: "POST" | "PUT", body: Record<string, unknown>, success: string) {
  loading.value = true
  mutationError.value = ""
  lastMutation = { path, method, body: JSON.parse(JSON.stringify(body)) as Record<string, unknown>, success }
  try {
    applyWorkspace(await api<VtlReviewView>(path, { method, body: JSON.stringify(body) }))
    lastMutation = null
    ElMessage.success(success)
  } catch (error) {
    mutationError.value = error instanceof Error ? error.message : "评估操作失败"
    ElMessage.error(mutationError.value)
  } finally {
    loading.value = false
  }
}

async function retryMutation() {
  if (!lastMutation) return
  const { path, method, body, success } = lastMutation
  await mutate(path, method, body, success)
}

function formatTime(value: number | null) {
  if (value === null) return "流程"
  const seconds = Math.floor(Math.max(0, value) / 1_000)
  return `T+${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}

function aircraftStatusLabel(status: ReturnType<typeof vtlReplayAircraftResults>[number]["status"]) {
  return ({
    WAITING: "待起飞",
    ACTIVE: "执行中",
    HOLDING: "等待中",
    RETURNING: "返航中",
    DIVERTING: "备降中",
    LANDED: "已降落",
    CANCELLED: "已取消"
  } as const)[status]
}

function aircraftLabel(aircraftId: string) {
  return planning.value?.plan.allocation.assignments.find((item) => item.aircraftId === aircraftId)?.aircraftCode ?? aircraftId
}
</script>

<template>
  <section class="vtl-review-workspace" v-loading="loading">
    <header class="vtl-review-commandbar"><div><strong>垂起广域巡检运行评估</strong><small>{{ formatEvaluationStatus(workspace?.evaluationStatus) }} · {{ workspace?.taskCoverageRatio ? `${Math.round(workspace.taskCoverageRatio * 100)}% 任务覆盖` : '等待仿真指标' }}</small><small v-if="workspace && workspace.totalScore !== null">评价总分：{{ workspace.totalScore }} 分</small><small v-if="loadError" class="review-load-error" role="alert">评估数据加载失败：{{ loadError }}，请重新加载。</small></div><div class="review-actions"><span v-if="workspace?.report" class="report-status" role="status" aria-live="polite">当前成果：{{ workspace.report.format }} 已生成</span><span v-if="workspace?.reportJob" class="report-job-status" role="status" aria-live="polite" :class="{ failed: workspace.reportJob.status === 'DEAD_LETTER' }">报告{{ reportJobLabel }}</span><button v-if="workspace?.report" type="button" :aria-label="`下载当前${workspace.report.format ?? ''}成果文件 ${workspace.report.filename ?? ''}`" @click="downloadReport"><Download />下载当前成果</button><button type="button" :title="loadError ? '重新加载评估数据' : '刷新评价和报告状态'" :aria-label="loadError ? '重新加载评估数据' : '刷新评价和报告状态'" :disabled="loading" @click="load"><Refresh />{{ loadError ? '重新加载' : '' }}</button></div></header>
    <div v-if="mutationError" class="vtl-review-mutation-error" role="alert" aria-live="assertive"><span><strong>保存操作失败</strong><small>{{ mutationError }}</small><p>当前填写内容已保留，修复连接后可以直接重试，不会自动覆盖草稿。</p></span><button type="button" :disabled="loading" @click="retryMutation"><Refresh />重试保存</button></div>
    <div v-if="loadError && !workspace" class="vtl-review-load-error vtl-review-load-error-full" role="alert" aria-live="assertive"><span><strong>巡检评估加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的评估数据，请检查连接后重新加载。</p></span><button type="button" class="primary" :disabled="loading" aria-label="重新加载评估" @click="load"><Refresh />重新加载评估</button></div>
    <main v-if="workspace || !loadError" class="vtl-review-main">
      <div v-if="loadError && workspace" class="vtl-review-load-error vtl-review-load-error-inline" role="alert" aria-live="assertive"><span><strong>评估数据同步失败</strong><small>{{ loadError }}</small><p>当前页面数据已保留，可继续查看；重新加载成功后再保存或发布评价。</p></span><button type="button" :disabled="loading" aria-label="重试同步" @click="load"><Refresh />重试同步</button></div>
      <section class="review-metrics"><header><strong>系统采集的客观指标</strong></header><div v-if="workspace?.objectiveMetrics?.length" class="metric-grid"><article v-for="metric in workspace.objectiveMetrics" :key="metric.code" :class="metric.state.toLowerCase()"><span>{{ metric.label }}</span><strong>{{ metric.displayValue }}</strong><small>{{ metric.detail }}</small></article></div><div v-else class="review-section-empty" role="status"><strong>尚未生成运行指标</strong><span>完成一次巡检仿真并结束运行后，系统会在这里展示任务覆盖、能量和安全等客观指标。</span></div></section>
      <section class="review-plan-map"><header><div><strong>任务对象与运行回放</strong></div><small>{{ formatTime(replayFrame?.simulationTimeMs ?? null) }} · {{ replayFrame?.summary.completedTaskObjects ?? 0 }}/{{ replayFrame?.summary.totalTaskObjects ?? 0 }} 对象完成</small></header><div class="review-map"><V3UnifiedMap :region="region" :visible-layers="visibleMapLayers" :mode="mapMode" :vtl-plan="planning?.plan ?? null" :vtl-replay-frame="replayFrame" @data-state="() => undefined" /><V3EnvironmentLayerPanel v-if="region" :region="region" scene-type="VTOL_INSPECTION" :visible-layers="visibleMapLayers" @toggle-layer="visibleMapLayers = visibleMapLayers.includes($event) ? visibleMapLayers.filter(item => item !== $event) : [...visibleMapLayers, $event]" /><div v-if="!workspace?.replayFrames.length" class="review-map-empty" role="status"><strong>暂无运行回放</strong><span>完成一次巡检仿真并结束运行后，系统会生成可拖动查看的回放快照。</span></div><V3RuntimePlaybackBar :time-ms="replayTimeMs" :duration-ms="replayDurationMs" :playing="replayPlaying" :live="false" :interactive="true" :toggle-enabled="Boolean(workspace?.replayFrames.length)" :rate="replayRate" :rate-options="[0.5, 1, 2, 4]" :rate-editable="true" :markers="replayMarkers" :selected-marker-id="selectedTimelineItemId" :status-label="replayFrame ? `快照 S${replayFrame.sequence} · ${replayFrame.reason}` : '暂无快照'" @toggle="toggleReplay" @restart="seekReplay(0)" @seek="seekReplay" @rate-change="replayRate = $event" @marker-select="selectReplayMarker" /></div></section>
      <section class="result-columns"><div class="task-results"><header><strong>当前时刻任务状态</strong><span>{{ replayTaskResults.length }} 项未完成</span></header><div v-if="replayTaskResults.length" class="incomplete-list"><article v-for="item in replayTaskResults" :key="item.taskObjectId"><b>{{ item.title }}</b><span>{{ item.reason }}</span></article></div><div v-else class="passed"><Check /> 当前时刻全部巡检对象已完成</div></div><div class="aircraft-results"><header><strong>当前时刻单架状态</strong><span>{{ replayAircraftResults.length ? `${replayAircraftResults.length} 架` : '暂无数据' }}</span></header><div v-if="replayAircraftResults.length" class="aircraft-table"><div class="table-head"><span>航空器</span><span>完成</span><span>能量</span><span>状态</span></div><div v-for="item in replayAircraftResults" :key="item.aircraftId" class="table-row"><strong>{{ aircraftLabel(item.aircraftId) }}</strong><span>{{ item.completedTaskObjectIds.length }} 项</span><span>{{ Math.round(item.remainingEnergyRatio * 100) }}%</span><span>{{ aircraftStatusLabel(item.status) }}</span></div></div><div v-else class="review-section-empty" role="status"><strong>暂无航空器回放数据</strong><span>完成巡检仿真并生成回放后，这里会显示每架航空器的任务完成、能量和运行状态。</span></div></div></section>
      <section class="vtl-review-timeline"><header><div><span>REPLAY TIMELINE</span><strong>运行事件与处置时间线</strong></div><select v-model="timelineFilter"><option value="ALL">全部</option><option value="STATE">状态</option><option value="EVENT">事件</option><option value="ALERT">告警</option><option value="ACTION">处置</option></select></header><ol><li v-for="item in timeline" :key="item.id" :class="{ selected: item.id === selectedTimelineItemId }" role="button" tabindex="0" :aria-pressed="item.id === selectedTimelineItemId" :aria-label="`${formatTime(item.simulationTimeMs)}：${item.title}`" @click="selectTimelineItem(item)" @keydown.enter="selectTimelineItem(item)" @keydown.space.prevent="selectTimelineItem(item)"><time>{{ formatTime(item.simulationTimeMs) }}</time><div><strong>{{ item.title }}</strong><small>{{ formatTimelineStatus(item.status) }} · {{ item.detail }}</small><template v-if="item.kind === 'ACTION' && runtimeActionReasoning(item.payload)"><span>发现：{{ runtimeActionReasoning(item.payload)?.observation }}</span><span>判断：{{ runtimeActionReasoning(item.payload)?.rationale }}</span><span>预期：{{ runtimeActionReasoning(item.payload)?.expectedOutcome }}</span></template></div></li><li v-if="!timeline.length" class="empty">暂无运行记录</li></ol></section>
      <section class="reorg-panel"><header><strong>当前时刻动态集群重组</strong><span>{{ replayReorganizations.length }} 次</span></header><div v-if="replayReorganizations.length" class="reorg-grid"><article v-for="item in replayReorganizations" :key="item.id"><strong>{{ item.action }}</strong><span>{{ item.message }}</span><small>{{ formatTime(item.executedAtMs) }} · {{ item.taskObjectIds.join('、') || '分组调整' }}</small></article></div><p v-else class="empty">当前时刻尚无动态重组</p></section>
      <p class="review-metric-boundary" role="note">客观指标由服务端依据运行轨迹、事件和处置记录计算，仅供运行总结参考，不自动计入教师最终评分。</p>
    </main>
    <aside v-if="workspace || !loadError" class="vtl-review-side">
      <section v-if="!isTeacher" class="student-summary"><header><strong>学生巡检总结</strong><span>{{ workspace?.canEditSummary ? '可编辑' : '已提交' }}</span></header><textarea v-model="studentSummary" :disabled="!workspace?.canEditSummary" maxlength="5000" rows="10" placeholder="记录任务完成判断、异常处置依据、能量与备降决策，以及下一次改进计划。" /><div><button type="button" :disabled="!workspace?.canEditSummary" aria-label="保存巡检总结草稿" @click="saveStudentSummary(false)"><Upload />保存草稿</button><button type="button" class="primary" :disabled="!canSubmitStudent" aria-label="提交巡检总结" @click="saveStudentSummary(true)"><Check />提交运行总结</button></div></section>
      <section v-if="isTeacher" class="teacher-evaluation"><header><div><span>TEACHER SCORING</span><strong>教师评价量表</strong></div><b>{{ scoreTotal.toFixed(1) }}/100</b></header><div class="score-list"><article v-for="item in teacherScores" :key="item.code"><div><strong>{{ item.label }}</strong><small>满分 {{ item.maxScore }}</small></div><input v-model.number="item.score" type="number" min="0" :max="item.maxScore" step="0.5" /><textarea v-model="item.comment" rows="2" maxlength="1000" placeholder="分项意见" /></article></div><textarea v-model="teacherSummary" rows="5" maxlength="5000" placeholder="综合讲评至少 10 个字符" /><div class="teacher-actions"><button type="button" :disabled="!canSaveTeacher" aria-label="保存教师评价" @click="saveTeacherEvaluation(false)">保存评价</button><button type="button" class="primary" :disabled="!canPublish" aria-label="发布教师评价" @click="saveTeacherEvaluation(true)"><Check />发布评价</button></div><p class="blocked-reason" v-if="workspace?.publishBlockedReason">{{ workspace.publishBlockedReason }}</p></section>
      <section v-if="isTeacher" class="report-panel"><header><strong>当前成果文件</strong><span>{{ workspace?.reportJob ? `报告${reportJobLabel}` : workspace?.report ? `${workspace.report.format} 已生成` : '尚未生成' }}</span></header><p>发布评价后生成一个当前成果文件，包含任务对象、单架结果、能量、事件、重组和讲评；历史版本用于查看历次成果。</p><p v-if="workspace?.evaluationStatus !== 'PUBLISHED'" class="blocked-reason">请先发布教师评价，再生成或更新成果文件。</p><p v-if="reportPollingError" class="report-error">{{ reportPollingError }}</p><select v-model="reportFormat" aria-label="成果文件格式" :disabled="reportJobBusy"><option value="PDF">PDF</option><option value="DOCX">DOCX</option></select><button type="button" class="primary" :disabled="workspace?.evaluationStatus !== 'PUBLISHED' || reportJobBusy" :aria-label="reportJobBusy ? `成果文件${reportJobLabel}` : `生成或更新${reportFormat}成果文件`" @click="generateReport"><Download />{{ reportJobBusy ? `报告${reportJobLabel}...` : `生成 / 更新 ${reportFormat} 成果文件` }}</button><p v-if="workspace?.reportJob?.status === 'DEAD_LETTER'" class="report-error">{{ workspace.reportJob.error || '报告生成失败，请重新生成。确认条件后可再次点击生成。' }}</p></section>
    </aside>
  </section>
</template>

<style scoped>
.vtl-review-workspace{grid-column:2/4;grid-row:2/4;display:grid;grid-template-columns:minmax(0,1fr) 330px;grid-template-rows:72px minmax(0,1fr);min-width:0;min-height:0;overflow:hidden;background:#eef3f0;color:#203d33}.vtl-review-commandbar{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:15px;padding:10px 15px;border-bottom:1px solid #c8d5ce;background:#f8faf9}.vtl-review-commandbar>div:first-child{display:grid;gap:2px}.vtl-review-commandbar span,.vtl-review-commandbar small,.review-actions,.review-actions button{font-size: 11px;color:#6b8177}.vtl-review-commandbar strong{font-size:15px;color:#193f32}.review-actions{display:flex;align-items:center;gap:7px}.review-actions button,.student-summary button,.teacher-actions button,.report-panel button{display:inline-flex;align-items:center;justify-content:center;gap:5px;border:1px solid #bdccc4;padding:7px 9px;background:#fff;color:#2b4e40;font:inherit;font-size: 11px;cursor:pointer}.review-actions svg,.student-summary svg,.report-panel svg{width:13px}.review-actions button:last-child{padding:6px}.report-status{color:#287252!important}.vtl-review-main,.vtl-review-side{min-height:0;overflow:auto}.vtl-review-main{display:grid;grid-template-columns:1fr 1fr;align-content:start;gap:10px;padding:12px}.vtl-review-side{border-left:1px solid #c8d5ce;background:#f7f9f8}.review-metrics,.review-plan-map,.result-columns,.vtl-review-timeline,.reorg-panel,.student-summary,.teacher-evaluation,.report-panel{border:1px solid #d1ddd7;background:#f9fbfa}.review-metrics,.review-plan-map,.result-columns,.vtl-review-timeline,.reorg-panel{grid-column:1/-1;padding:11px}.review-metrics>header,.review-plan-map>header,.vtl-review-timeline>header,.result-columns>header,.reorg-panel>header,.student-summary>header,.teacher-evaluation>header,.report-panel>header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.review-metrics header span,.review-plan-map header span,.vtl-review-timeline header span,.teacher-evaluation header span{display:block;color:#71847a;font-size: 11px}.review-metrics header strong,.review-plan-map header strong,.vtl-review-timeline header strong,.result-columns header strong,.reorg-panel header strong,.student-summary header strong,.teacher-evaluation header strong,.report-panel header strong{font-size:10px}.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}.metric-grid article{display:grid;gap:3px;padding:8px;background:#edf4ef;border-left:3px solid #2b7857}.metric-grid article.risk{border-color:#bd8531;background:#f8f0df}.metric-grid article.info{border-color:#6b8b9c;background:#edf3f5}.metric-grid span,.metric-grid small{color:#667a71;font-size: 11px}.metric-grid strong{font-size:15px}.review-map{height:270px}.review-plan-map>header small,.result-columns header span,.reorg-panel header span{color:#71847a;font-size: 11px}.result-columns{display:grid;grid-template-columns:1fr 1.4fr;gap:12px}.task-results,.aircraft-results{min-width:0}.task-results header,.aircraft-results header{display:flex;justify-content:space-between;margin-bottom:7px}.incomplete-list{display:grid;gap:5px}.incomplete-list article{display:grid;gap:2px;padding:7px;background:#fbf0e4;border-left:3px solid #bb772f;font-size: 11px}.incomplete-list span{color:#765f49}.passed{display:flex;align-items:center;gap:5px;color:#267252;font-size: 11px}.passed svg{width:14px}.aircraft-table{border:1px solid #d3dfd8;background:#fff}.table-head,.table-row{display:grid;grid-template-columns:1.4fr .8fr .7fr .8fr;gap:5px;padding:6px 8px;font-size: 11px;border-bottom:1px solid #e2e9e5}.table-head{color:#6c8076;background:#f0f5f2}.table-row:last-child{border-bottom:0}.vtl-review-timeline select,.vtl-review-side textarea,.vtl-review-side input{border:1px solid #c8d5ce;background:#fff;color:#284a3d;font:inherit;font-size: 11px;padding:6px;box-sizing:border-box}.vtl-review-timeline ol{display:grid;gap:5px;margin:0;padding:0;list-style:none;max-height:220px;overflow:auto}.vtl-review-timeline li{display:grid;grid-template-columns:48px minmax(0,1fr);gap:8px;padding:6px;border-bottom:1px solid #e1e9e4}.vtl-review-timeline time,.vtl-review-timeline small{color:#71827a;font-size: 11px}.vtl-review-timeline li div{display:grid;gap:2px}.vtl-review-timeline li strong{font-size: 11px}.empty{color:#76887f;font-size: 11px}.reorg-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}.reorg-grid article{display:grid;gap:3px;padding:7px;background:#eef4f0;font-size: 11px}.reorg-grid span,.reorg-grid small{color:#6f8178}.student-summary,.teacher-evaluation,.report-panel{margin:12px;padding:12px}.student-summary,.teacher-evaluation{display:grid;gap:8px}.student-summary textarea,.teacher-evaluation>textarea{width:100%;resize:vertical}.student-summary>div,.teacher-actions{display:flex;justify-content:flex-end;gap:6px}.student-summary button:disabled,.teacher-actions button:disabled,.report-panel button:disabled{opacity:.45;cursor:not-allowed}.primary{background:#246d50!important;border-color:#246d50!important;color:#fff!important}.score-list{display:grid;gap:6px;max-height:410px;overflow:auto}.score-list article{display:grid;grid-template-columns:minmax(0,1fr) 52px;gap:5px;padding:7px;background:#fff;border:1px solid #d5e0da}.score-list article>div{display:grid;gap:2px}.score-list strong{font-size: 11px}.score-list small{color:#778880;font-size: 11px}.score-list input{width:52px}.score-list textarea{grid-column:1/-1;width:100%;resize:vertical}.teacher-evaluation>header b{color:#247052;font-size:14px}.blocked-reason{margin:0;color:#9d6c28;font-size: 11px}.report-panel{display:grid;gap:8px}.report-panel p{margin:0;color:#667a70;font-size: 11px;line-height:1.5}.report-panel button{width:100%}@media(max-width:900px){.vtl-review-workspace{grid-template-columns:1fr}.vtl-review-side{border-left:0;border-top:1px solid #c8d5ce}.vtl-review-main{grid-column:1}.metric-grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:680px){.vtl-review-workspace{grid-column:1;grid-row:3/5;grid-template-rows:auto auto auto}.vtl-review-commandbar{grid-column:1}.vtl-review-main{grid-column:1;padding:8px}.result-columns{grid-template-columns:1fr}.metric-grid{grid-template-columns:1fr}.reorg-grid{grid-template-columns:1fr}.review-map{height:220px}}
.review-map{position:relative;height:320px}.vtl-review-timeline li{cursor:pointer}.vtl-review-timeline li:hover,.vtl-review-timeline li.selected{background:#e7f1ec}.vtl-review-timeline li:focus-visible{outline:2px solid #2b7857;outline-offset:-2px;background:#edf6f0}.vtl-review-timeline li div>span{color:#61776c;font-size: 11px;line-height:1.4}.report-panel select{box-sizing:border-box;width:100%;border:1px solid #c8d5ce;padding:7px;background:#fff;color:#284a3d;font:inherit;font-size: 11px}
.review-load-error{color:#a14b3f!important}
.vtl-review-mutation-error{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:16px;margin:8px 12px 0;border-left:3px solid #b05a45;padding:10px 12px;color:#653b31;background:#fff4f1;font-size: 11px}.vtl-review-mutation-error>span{display:grid;min-width:0;gap:3px}.vtl-review-mutation-error strong{font-size:10px}.vtl-review-mutation-error small{overflow-wrap:anywhere}.vtl-review-mutation-error p{margin:0;color:#765b54;line-height:1.5}.vtl-review-mutation-error button{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:0 0 auto;border:1px solid #bdccc4;padding:7px 9px;background:#fff;color:#2b4e40;font:inherit;font-size: 11px;cursor:pointer}.vtl-review-mutation-error button:disabled{opacity:.45;cursor:not-allowed}
.vtl-review-load-error{display:flex;align-items:center;justify-content:space-between;gap:16px;border-left:3px solid #b05a45;padding:12px 14px;color:#653b31!important;background:#fff4f1;font-size: 11px}.vtl-review-load-error-full{grid-column:1/-1;align-self:start;margin:24px}.vtl-review-load-error-inline{grid-column:1/-1;margin:0 0 2px}.vtl-review-load-error>span{display:grid;min-width:0;gap:3px}.vtl-review-load-error strong{font-size:10px}.vtl-review-load-error small{overflow-wrap:anywhere}.vtl-review-load-error p{margin:0;color:#765b54;line-height:1.5}.vtl-review-load-error button{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:0 0 auto;border:1px solid #bdccc4;padding:7px 9px;background:#fff;color:#2b4e40;font:inherit;font-size: 11px;cursor:pointer}.vtl-review-load-error button:disabled{opacity:.45;cursor:not-allowed}
.review-metric-boundary{grid-column:1/-1;margin:0;border-left:3px solid #6b8b9c;padding:8px 10px;background:#edf3f5;color:#5d7169;font-size: 11px;line-height:1.5}
.review-section-empty{display:grid;gap:4px;border:1px dashed #bdcec4;padding:12px;background:#f1f6f3;color:#60766b;font-size: 11px;line-height:1.5}.review-section-empty strong{color:#365e4d;font-size: 11px}
.review-map-empty{position:absolute;inset:12px 12px 58px;display:grid;place-content:center;gap:5px;padding:16px;text-align:center;background:rgba(247,251,249,.88);border:1px dashed #b9cbc0;color:#60766b;font-size: 11px;line-height:1.5;pointer-events:none}.review-map-empty strong{color:#365e4d;font-size:10px}
@media(max-width:680px){.vtl-review-workspace{height:auto;min-height:0;overflow:visible;grid-template-rows:auto auto auto;align-content:start}.vtl-review-main,.vtl-review-side{height:auto;min-height:0;overflow:visible}.score-list{max-height:none;overflow:visible}.review-map{height:220px}.vtl-review-mutation-error,.vtl-review-load-error{align-items:stretch;flex-direction:column}.vtl-review-mutation-error{margin:8px}.vtl-review-load-error-full{margin:12px}}

@media (max-width: 1080px) {
  .vtl-review-workspace { grid-column: 2 / 4; grid-template-columns: 1fr; grid-template-rows: auto auto auto; overflow: auto; }
  .vtl-review-commandbar { grid-column: 1; flex-wrap: wrap; align-items: flex-start; }
  .vtl-review-main { grid-column: 1; grid-row: 2; }
  .vtl-review-side { grid-column: 1; grid-row: 3; border-top: 1px solid #c8d5ce; border-left: 0; overflow: visible; }
}
@media (max-width: 760px) {
  .vtl-review-workspace { grid-column: 1; grid-row: 3 / 5; }
  .vtl-review-commandbar { padding: 9px; }
  .review-actions { width: 100%; flex-wrap: wrap; }
  .review-actions button { flex: 1 1 auto; }
  .vtl-review-main { padding: 9px; }
}
@media (max-width: 420px) {
  .vtl-review-commandbar strong { font-size: 13px; }
  .review-actions .report-status, .review-actions .report-job-status { width: 100%; }
  .review-map { height: 280px; }
}

</style>
