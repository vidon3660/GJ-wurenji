<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Clock, Position, Promotion, Refresh } from "@element-plus/icons-vue"
import type { AuthUser, ShowT60WorkspaceView, StudentProjectStageView, StudentProjectView } from "@wurenji/shared"
import { api } from "../api"
import { formatPlatformDate, formatPlatformDateTime } from "../platform-date"
import { formatSubmissionStatus } from "../terminology"

const props = defineProps<{ user: AuthUser; project: StudentProjectView; stage: StudentProjectStageView }>()
const emit = defineEmits<{ refreshProject: [] }>()
const loading = ref(false)
const loadError = ref("")
const workspace = ref<ShowT60WorkspaceView | null>(null)
const fetchedAt = ref(Date.now())
const now = ref(Date.now())
let displayTimer: number | null = null
let refreshTimer: number | null = null

const projectedSimulationTime = computed(() => {
  if (!workspace.value) return 0
  if (workspace.value.clockStatus === "PAUSED") return workspace.value.simulationTimeMs
  return Math.floor(workspace.value.simulationTimeMs + (now.value - fetchedAt.value) * workspace.value.clockRate)
})
const untilOpen = computed<number | null>(() => {
  if (!workspace.value) return null
  return Math.max(0, workspace.value.thresholdSimulationTimeMs - projectedSimulationTime.value)
})
const localCanSubmit = computed(() => Boolean(workspace.value?.canSubmit && (props.user.role !== "student" || props.project.assessmentTiming.canWrite)))

onMounted(() => {
  void loadWorkspace()
  displayTimer = window.setInterval(() => { now.value = Date.now() }, 250)
  refreshTimer = window.setInterval(() => void loadWorkspace(false), 3_000)
})
onBeforeUnmount(() => {
  if (displayTimer !== null) window.clearInterval(displayTimer)
  if (refreshTimer !== null) window.clearInterval(refreshTimer)
})
watch(() => props.project.id, () => void loadWorkspace())
watch(untilOpen, (value, previous) => {
  if (value === 0 && previous !== null && previous > 0) void loadWorkspace(false)
})

async function loadWorkspace(showError = true) {
  if (showError) loading.value = true
  try {
    workspace.value = await api<ShowT60WorkspaceView>(`/v3/show-projects/${props.project.id}/t60-report`)
    loadError.value = ""
    fetchedAt.value = Date.now()
    now.value = fetchedAt.value
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "起飞前报备加载失败"
    if (showError) ElMessage.error(loadError.value)
  } finally {
    if (showError) loading.value = false
  }
}

async function submit() {
  if (!workspace.value) return
  try {
    await ElMessageBox.confirm(
      "确认提交本次教学仿真的起飞前一小时申请？提交后将记录当前项目、区域、机群和环境快照。",
      "提交起飞前一小时申请",
      { confirmButtonText: "确认提交", cancelButtonText: "取消", type: "warning" }
    )
  } catch {
    return
  }
  loading.value = true
  try {
    workspace.value = await api<ShowT60WorkspaceView>(`/v3/show-projects/${props.project.id}/t60-report/submit`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: workspace.value.revision })
    })
    ElMessage.success("起飞前一小时申请已提交")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "起飞前一小时申请提交失败")
    await loadWorkspace(false)
  } finally {
    loading.value = false
  }
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.ceil(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

function formatTime(value: string) {
  return formatPlatformDate(value, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
}

function coordinate(value: { longitude: number; latitude: number } | null) {
  return value ? `${value.longitude.toFixed(6)}, ${value.latitude.toFixed(6)}` : "未生成"
}

function simulationTime(value: number | null) {
  return value === null ? "历史记录未保存" : `T+${formatDuration(value)}`
}

const environmentFieldLabels: Record<string, string> = {
  windDirection: "风向",
  windState: "风力状态",
  gustState: "阵风状态",
  rainState: "降雨状态",
  positioningQuality: "定位质量",
  electromagneticState: "电磁状态",
  communicationQuality: "通信质量",
  equipmentState: "设备状态",
  geofenceState: "电子围栏"
}

const environmentValueLabels: Record<string, string> = {
  N: "北风",
  NE: "东北风",
  E: "东风",
  SE: "东南风",
  S: "南风",
  SW: "西南风",
  W: "西风",
  NW: "西北风",
  NORMAL: "正常",
  NEAR_LIMIT: "接近限制",
  OVER_LIMIT: "超限",
  NONE: "无",
  OCCASIONAL: "间歇",
  CONTINUOUS: "持续",
  BELOW_LIMIT: "限制内",
  GOOD: "良好",
  DEGRADED: "下降",
  LOST: "丢失",
  INTERFERENCE: "受干扰",
  WARNING: "告警",
  FAULT: "故障"
}

function environmentFieldLabel(key: string) {
  return environmentFieldLabels[key] ?? key
}

function environmentValueLabel(value: string | number | boolean) {
  if (typeof value !== "string") return String(value)
  return environmentValueLabels[value] ?? value
}
</script>

<template>
  <section class="t60-workspace" v-loading="loading">
    <header>
      <div><span>DYNAMIC REPORTING</span><h2>起飞前一小时申请</h2><p>仿真管制流程节点</p></div>
      <el-button :icon="Refresh" circle title="刷新" @click="loadWorkspace" />
    </header>

    <div v-if="loadError && !workspace" class="t60-load-error t60-load-error-full" role="alert" aria-live="assertive"><span><strong>起飞前一小时申请加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的仿真时钟和申请数据，请检查连接后重新加载。</p></span><el-button type="primary" :icon="Refresh" :loading="loading" @click="loadWorkspace">重新加载申请</el-button></div>

    <main v-if="workspace || !loadError">
      <div v-if="loadError && workspace" class="t60-load-error" role="alert" aria-live="assertive"><span><strong>申请数据同步失败</strong><small>{{ loadError }}</small><p>当前页面数据已保留，系统会继续尝试同步；需要提交前可手动重试。</p></span><el-button type="warning" :icon="Refresh" :loading="loading" @click="loadWorkspace">重试同步</el-button></div>
      <section class="clock-panel" :class="workspace?.status.toLowerCase()">
        <div class="clock-symbol"><el-icon><Clock /></el-icon></div>
        <span>{{ workspace?.status === 'SUBMITTED' ? formatSubmissionStatus(workspace.status) : untilOpen === null ? '正在加载仿真时钟' : untilOpen === 0 ? 'T-60 节点已到' : '仿真时钟' }}</span>
        <strong v-if="workspace?.status === 'SUBMITTED'">已提交</strong><strong v-else-if="untilOpen === 0">T-60</strong><strong v-else-if="untilOpen !== null">{{ formatDuration(untilOpen) }}</strong><strong v-else>--</strong>
        <p v-if="workspace?.status === 'SUBMITTED'">{{ workspace.submittedAt ? formatPlatformDateTime(workspace.submittedAt) : '' }}</p>
        <p v-else-if="untilOpen === 0">已到达起飞前一小时节点</p><p v-else-if="untilOpen !== null">距离按钮开放 · {{ workspace?.clockRate ?? '--' }}x</p><p v-else>正在加载仿真时钟</p>
        <div class="clock-track"><i :style="{ width: `${Math.min(100, projectedSimulationTime / Math.max(1, workspace?.thresholdSimulationTimeMs ?? 1) * 100)}%` }" /></div>
      </section>

      <section class="confirmation-grid">
        <header><span>CONFIRMATION SNAPSHOT</span><strong>{{ workspace?.submission ? '已提交申请快照' : '申请信息确认' }}</strong></header>
        <dl>
          <div><dt>项目名称</dt><dd>{{ workspace?.confirmation.projectName }}</dd></div>
          <div><dt>计划开始</dt><dd>{{ workspace ? formatTime(workspace.confirmation.plannedStartAt) : '-' }}</dd></div>
          <div><dt>计划结束</dt><dd>{{ workspace ? formatTime(workspace.confirmation.plannedEndAt) : '-' }}</dd></div>
          <div><dt>无人机型号</dt><dd>{{ workspace?.confirmation.aircraftModel }}</dd></div>
          <div><dt>计划架数</dt><dd>{{ workspace?.confirmation.aircraftCount }} 架</dd></div>
          <div><dt>最大高度</dt><dd>{{ workspace?.confirmation.maximumHeightMeters ?? '-' }} m</dd></div>
          <div><dt>起降点</dt><dd><el-icon><Position /></el-icon>{{ coordinate(workspace?.confirmation.takeoffPoint ?? null) }}</dd></div>
          <div><dt>空域边界</dt><dd>{{ workspace?.confirmation.airspaceBoundary.length }} 个坐标点</dd></div>
          <div><dt>联系人</dt><dd>{{ workspace?.confirmation.contactName }}</dd></div>
          <div><dt>联系电话</dt><dd>{{ workspace?.confirmation.contactPhone }}</dd></div>
        </dl>
      </section>
    </main>

    <aside v-if="workspace || !loadError">
      <section v-if="workspace?.submission" class="submission-record">
        <header><strong>报备记录</strong><span>FROZEN</span></header>
        <dl>
          <div><dt>记录编号</dt><dd>{{ workspace.submission.reportCode ?? '历史记录' }}</dd></div>
          <div><dt>提交人</dt><dd>{{ workspace.submission.submittedBy?.displayName ?? '历史记录未保存' }}</dd></div>
          <div><dt>提交时间</dt><dd>{{ formatTime(workspace.submission.submittedAt) }}</dd></div>
          <div><dt>仿真时刻</dt><dd>{{ simulationTime(workspace.submission.simulationTimeMs) }}</dd></div>
        </dl>
      </section>
      <section>
        <header><strong>{{ workspace?.submission ? '提交环境快照' : '当前环境' }}</strong><span>SNAPSHOT</span></header>
        <dl><div v-for="(value, key) in workspace?.confirmation.environment ?? {}" :key="key"><dt>{{ environmentFieldLabel(String(key)) }}</dt><dd>{{ environmentValueLabel(value) }}</dd></div></dl>
      </section>
      <section class="report-boundary"><strong>教学仿真报备</strong><p>本次操作只在系统内形成流程记录，不向真实空军、飞行管制或行政系统发送数据。</p></section>
      <el-button v-if="props.user.role === 'student'" type="primary" size="large" :icon="Promotion" :disabled="!localCanSubmit || workspace?.status === 'SUBMITTED'" @click="submit">{{ workspace?.status === 'SUBMITTED' ? '申请已提交' : untilOpen === 0 ? '提交起飞前一小时申请' : '等待 T-60 节点' }}</el-button>
      <div v-else class="teacher-report-state"><strong>{{ workspace?.status === 'SUBMITTED' ? '学生已完成报备' : '等待学生提交' }}</strong><span>{{ workspace?.submittedAt ? formatPlatformDateTime(workspace.submittedAt) : '当前记录只读' }}</span></div>
    </aside>
  </section>
</template>

<style scoped>
.t60-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0, 1fr) 320px; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; background: #edf1ef; }
.t60-workspace > header { grid-column: 1 / 3; display: flex; align-items: center; justify-content: space-between; min-height: 82px; border-bottom: 1px solid #d3ddd8; padding: 12px 18px; background: white; }
.t60-workspace > header div { display: grid; gap: 2px; }
.t60-workspace > header span, .confirmation-grid > header span { color: #247354; font-size: 11px; font-weight: 800; }
.t60-workspace h2 { margin: 0; font-size: 16px; }
.t60-workspace > header p { margin: 0; color: #74867e; font-size: 11px; }
.t60-load-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; border-left: 3px solid #b05a45; padding: 12px 14px; color: #653b31; background: #fff4f1; }
.t60-load-error-full { grid-column: 1 / 3; align-self: start; margin: 24px; }
.t60-load-error > span { display: grid; min-width: 0; gap: 3px; }
.t60-load-error strong { font-size: 10px; }
.t60-load-error small { overflow-wrap: anywhere; font-size: 11px; }
.t60-load-error p { margin: 0; color: #765b54; font-size: 11px; line-height: 1.5; }
.t60-load-error .el-button { flex: 0 0 auto; }
.t60-workspace > main { min-height: 0; overflow: auto; padding: 28px; }
.clock-panel { display: grid; justify-items: center; border-bottom: 1px solid #d4ddd8; padding: 18px 0 32px; }
.clock-symbol { display: grid; width: 54px; height: 54px; place-items: center; border: 1px solid #b9c9c1; border-radius: 50%; color: #247354; background: white; }
.clock-symbol .el-icon { font-size: 25px; }
.clock-panel > span { margin-top: 14px; color: #6e8178; font-size: 11px; font-weight: 800; }
.clock-panel > strong { margin-top: 5px; font-variant-numeric: tabular-nums; font-size: 64px; letter-spacing: 0; }
.clock-panel > p { margin: 3px 0 0; color: #72847b; font-size: 11px; }
.clock-track { width: min(460px, 80%); height: 3px; margin-top: 22px; overflow: hidden; background: #dbe2de; }
.clock-track i { display: block; height: 100%; background: #247354; transition: width .25s linear; }
.clock-panel.ready .clock-symbol, .clock-panel.submitted .clock-symbol { border-color: #247354; color: white; background: #247354; }
.confirmation-grid { margin-top: 25px; }
.confirmation-grid > header { display: grid; gap: 2px; margin-bottom: 10px; }
.confirmation-grid > header strong { font-size: 13px; }
.confirmation-grid dl { display: grid; grid-template-columns: 1fr 1fr; margin: 0; border-top: 1px solid #ccd8d2; border-left: 1px solid #ccd8d2; background: white; }
.confirmation-grid dl > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 10px; border-right: 1px solid #ccd8d2; border-bottom: 1px solid #ccd8d2; padding: 11px; font-size: 11px; }
.confirmation-grid dt { color: #75877e; }
.confirmation-grid dd { display: flex; align-items: center; gap: 4px; margin: 0; overflow-wrap: anywhere; }
.t60-workspace > aside { min-height: 0; overflow: auto; border-left: 1px solid #d3ddd8; padding: 18px; background: #f9fbfa; }
.t60-workspace > aside > section { margin-bottom: 18px; border-bottom: 1px solid #dce3df; padding-bottom: 16px; }
.t60-workspace > aside section > header { display: flex; justify-content: space-between; margin-bottom: 10px; }
.t60-workspace > aside section > header strong { font-size: 10px; }
.t60-workspace > aside section > header span { color: #247354; font-size: 11px; }
.t60-workspace > aside dl { display: grid; gap: 7px; margin: 0; }
.t60-workspace > aside dl > div { display: grid; grid-template-columns: 110px 1fr; gap: 8px; font-size: 11px; }
.t60-workspace > aside dt { color: #778980; }
.t60-workspace > aside dd { margin: 0; text-align: right; }
.report-boundary { border-left: 3px solid #c98c36; padding: 10px 12px 10px 14px; background: #fff9ec; }
.report-boundary strong { font-size: 11px; }
.report-boundary p { margin: 5px 0 0; color: #78653e; font-size: 11px; line-height: 1.55; }
.t60-workspace > aside > .el-button { width: 100%; }
.teacher-report-state { display: grid; gap: 4px; border-left: 3px solid #247354; padding: 10px 12px; background: #eaf3ee; }
.teacher-report-state strong { font-size: 10px; }
.teacher-report-state span { color: #64786e; font-size: 11px; }
.submission-record { border-left: 3px solid #247354; padding: 10px 12px 14px; background: #eef6f2; }
.submission-record dd { overflow-wrap: anywhere; }
@media (max-width: 900px) { .confirmation-grid dl { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .t60-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: auto 620px auto; } .t60-workspace > header { grid-column: 1; } .t60-workspace > aside { border-top: 1px solid #d3ddd8; border-left: 0; } .t60-load-error { align-items: stretch; flex-direction: column; } .t60-load-error-full { margin: 12px; } }

@media (max-width: 760px) {
  .t60-workspace { display: flex; grid-column: 1; grid-row: 3 / 5; min-height: 0; overflow: auto; flex-direction: column; }
  .t60-workspace > header { flex: 0 0 auto; }
  .t60-workspace > main { flex: 1 1 auto; min-height: 520px; padding: 18px 12px; }
  .t60-workspace > aside { flex: 0 0 auto; border-top: 1px solid #d3ddd8; border-left: 0; }
}
@media (max-width: 420px) {
  .t60-workspace > header { align-items: flex-start; flex-direction: column; gap: 9px; padding: 12px; }
  .clock-panel > strong { font-size: clamp(42px, 18vw, 60px); }
  .clock-track { width: 100%; }
  .confirmation-grid dl > div { grid-template-columns: 74px minmax(0, 1fr); gap: 7px; padding: 9px; }
}
</style>
