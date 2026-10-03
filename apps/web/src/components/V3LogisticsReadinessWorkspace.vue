<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Check, CircleCheck, Refresh, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  LogisticsReadinessCheckCategory,
  LogisticsReadinessDecision,
  LogisticsRuntimeReadinessWorkspaceView,
  StudentProjectStageView,
  StudentProjectView
} from "@wurenji/shared"
import { api } from "../api"
import { formatPlatformDateTime } from "../platform-date"
import { formatScaleTemplateCode } from "../terminology"
import { logisticsReadinessGatePresentation } from "../logistics-readiness-presentation"

const props = defineProps<{ user: AuthUser; project: StudentProjectView; stage: StudentProjectStageView }>()
const emit = defineEmits<{ refreshProject: [] }>()

const loading = ref(false)
const loadError = ref("")
const workspace = ref<LogisticsRuntimeReadinessWorkspaceView | null>(null)
const decision = ref<LogisticsReadinessDecision | null>(null)
const decisionBasis = ref("")

const categoryDefinitions: Array<{ code: LogisticsReadinessCheckCategory; title: string }> = [
  { code: "SCHEDULE", title: "调度与任务" },
  { code: "AIRCRAFT", title: "无人机状态" },
  { code: "ROUTE", title: "正式航线" },
  { code: "ORDER", title: "订单完整性" },
  { code: "NODE", title: "运行节点" },
  { code: "ENVIRONMENT", title: "运行环境" }
]

const decisionOptions: Array<{ value: LogisticsReadinessDecision; label: string }> = [
  { value: "PROCEED", label: "允许执行" },
  { value: "PROCEED_AFTER_ADJUSTMENT", label: "调整后执行" },
  { value: "DELAY", label: "延迟执行" },
  { value: "CANCEL", label: "取消任务" }
]

const isStudent = computed(() => props.user.role === "student")
const canEdit = computed(() => Boolean(workspace.value?.canEdit && isStudent.value && props.project.assessmentTiming.canWrite))
const checks = computed(() => workspace.value?.readiness.checks ?? [])
const groupedChecks = computed(() => categoryDefinitions
  .map((category) => ({ ...category, items: checks.value.filter((item) => item.category === category.code) }))
  .filter((category) => category.items.length > 0))
const passCount = computed(() => checks.value.filter((item) => item.status === "PASS").length)
const warningCount = computed(() => checks.value.filter((item) => item.status === "WARNING").length)
const failCount = computed(() => checks.value.filter((item) => item.status === "FAIL").length)
const gatePresentation = computed(() => logisticsReadinessGatePresentation(workspace.value?.readiness.status ?? "DRAFT", Boolean(workspace.value?.canConfirm), failCount.value))

onMounted(loadWorkspace)
watch(() => props.project.id, loadWorkspace)

async function loadWorkspace() {
  loading.value = true
  loadError.value = ""
  try {
    applyWorkspace(await api<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${props.project.id}/runtime-readiness`))
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "运行准备工作台加载失败"
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

function applyWorkspace(value: LogisticsRuntimeReadinessWorkspaceView) {
  workspace.value = value
  decision.value = value.readiness.decision
  decisionBasis.value = value.readiness.decisionBasis
}

async function save(showMessage = true) {
  if (!workspace.value || !canEdit.value) return false
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${props.project.id}/runtime-readiness`, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: workspace.value.readiness.revision,
        decision: decision.value,
        decisionBasis: decisionBasis.value
      })
    }))
    if (showMessage) ElMessage.success("运行准备结论已保存")
    return true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "运行准备保存失败")
    await loadWorkspace()
    return false
  } finally {
    loading.value = false
  }
}

async function runCheck() {
  if (!(await save(false)) || !workspace.value) return
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${props.project.id}/runtime-readiness/check`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: workspace.value.readiness.revision })
    }))
    ElMessage.success(failCount.value === 0 ? "运行条件复核通过" : `复核完成，仍有 ${failCount.value} 项阻断`)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "运行条件复核失败")
  } finally {
    loading.value = false
  }
}

async function confirmReadiness() {
  if (!(await save(false)) || !workspace.value) return
  await runCheck()
  if (!workspace.value?.canConfirm) return
  try {
    await ElMessageBox.confirm("确认后将锁定运行准备结论，并开放配送运行阶段。", "确认进入配送运行", {
      type: "warning",
      confirmButtonText: "确认进入",
      cancelButtonText: "返回检查"
    })
  } catch {
    return
  }
  loading.value = true
  try {
    applyWorkspace(await api<LogisticsRuntimeReadinessWorkspaceView>(`/v3/logistics-projects/${props.project.id}/runtime-readiness/confirm`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: workspace.value.readiness.revision })
    }))
    ElMessage.success("运行准备已确认")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "运行准备确认失败")
  } finally {
    loading.value = false
  }
}

function checkStatusLabel(value: string) {
  return ({ PASS: "通过", WARNING: "关注", FAIL: "阻断" } as Record<string, string>)[value] ?? value
}
</script>

<template>
  <section class="logistics-readiness-workspace" v-loading="loading">
    <header class="readiness-header">
      <div><span>OPERATION READINESS</span><h2>配送运行准备</h2><p>基于正式航线、订单、机队和初始调度执行权威复核</p></div>
      <dl><div><dt>通过</dt><dd>{{ passCount }}</dd></div><div><dt>关注</dt><dd class="warning">{{ warningCount }}</dd></div><div><dt>阻断</dt><dd class="danger">{{ failCount }}</dd></div><div><dt>调度版本</dt><dd>V{{ workspace?.submittedSchedule.versionNo ?? '-' }}</dd></div></dl>
      <el-button :icon="Refresh" circle title="刷新运行准备" @click="loadWorkspace" />
    </header>

    <div v-if="loadError && !workspace" class="readiness-load-error readiness-load-error-full" role="alert" aria-live="assertive"><span><strong>运行准备数据加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的权威复核结果，请检查连接后重新加载。</p></span><el-button type="primary" :icon="Refresh" :loading="loading" @click="loadWorkspace">重新加载运行准备</el-button></div>

    <main v-if="workspace || !loadError" class="readiness-checks">
      <div v-if="loadError && workspace" class="readiness-load-error" role="alert" aria-live="assertive"><span><strong>运行准备数据同步失败</strong><small>{{ loadError }}</small><p>当前检查结果和决策内容已保留，确认进入运行前请先重试同步。</p></span><el-button type="warning" :icon="Refresh" :loading="loading" @click="loadWorkspace">重试同步</el-button></div>
      <section v-for="category in groupedChecks" :key="category.code">
        <header><strong>{{ category.title }}</strong><span>{{ category.items.filter(item => item.status === 'PASS').length }}/{{ category.items.length }}</span></header>
        <article v-for="item in category.items" :key="item.code" :class="item.status.toLowerCase()">
          <el-icon><CircleCheck v-if="item.status === 'PASS'" /><Warning v-else /></el-icon>
          <div><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></div>
          <em>{{ checkStatusLabel(item.status) }}</em>
          <span>{{ item.blocking ? '运行门禁' : '提示项' }}</span>
        </article>
      </section>
    </main>

    <aside v-if="workspace || !loadError" class="readiness-decision">
      <header><span>GO / NO-GO</span><strong>运行决策</strong><small>R{{ workspace?.readiness.revision ?? 1 }}</small></header>
      <div class="readiness-schedule-summary">
        <span>正式初始调度</span><strong>V{{ workspace?.submittedSchedule.versionNo ?? '-' }}</strong><small>{{ workspace?.submittedSchedule.items.length ?? 0 }} 班配送任务 · {{ formatScaleTemplateCode(workspace?.scaleTemplateCode) }}</small>
      </div>
      <el-radio-group v-model="decision" :disabled="!canEdit" class="readiness-decisions">
        <el-radio-button v-for="option in decisionOptions" :key="option.value" :value="option.value">{{ option.label }}</el-radio-button>
      </el-radio-group>
      <label><span>判断依据</span><el-input v-model="decisionBasis" :disabled="!canEdit" type="textarea" :rows="6" maxlength="2000" show-word-limit placeholder="记录对航线、调度、机队和环境的复核依据" /></label>
      <div class="readiness-gate-state" :class="{ passed: gatePresentation.passed }">
        <el-icon><Check v-if="gatePresentation.passed" /><Warning v-else /></el-icon>
        <div><strong>{{ gatePresentation.title }}</strong><span>{{ gatePresentation.detail }}</span></div>
      </div>
      <footer v-if="canEdit"><el-button @click="save()">保存结论</el-button><el-button @click="runCheck">重新复核</el-button><el-button type="primary" :disabled="!workspace?.canConfirm" :icon="CircleCheck" @click="confirmReadiness">确认进入运行</el-button></footer>
      <div v-else class="readiness-readonly"><strong>{{ workspace?.readiness.status === 'CONFIRMED' ? '确认记录已锁定' : '教师只读查看' }}</strong><span>{{ workspace?.readiness.confirmedAt ? formatPlatformDateTime(workspace.readiness.confirmedAt) : '等待学生形成运行决策' }}</span></div>
    </aside>
    <aside v-else class="readiness-decision readiness-decision-error" role="alert"><div><strong>运行准备暂不可用</strong><span>复核结果加载成功后，才能形成运行决策或进入配送运行。</span><el-button type="primary" :icon="Refresh" :loading="loading" @click="loadWorkspace">重新加载</el-button></div></aside>
  </section>
</template>

<style scoped>
.logistics-readiness-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0,1fr) 340px; grid-template-rows: 82px minmax(0,1fr); min-width: 0; min-height: 0; color: #20322b; background: #edf1ef; }
.readiness-header { grid-column: 1 / 3; display: grid; grid-template-columns: minmax(240px,1fr) auto 36px; align-items: center; gap: 22px; border-bottom: 1px solid #d1dbd6; padding: 11px 18px; background: #fff; }.readiness-header > div:first-child { display: grid; gap: 2px; }.readiness-header span,.readiness-decision > header span { color: #247354; font-size: 11px; font-weight: 800; }.readiness-header h2 { margin: 0; font-size: 16px; }.readiness-header p { margin: 0; color: #74867e; font-size: 11px; }.readiness-header dl { display: flex; margin: 0; }.readiness-header dl div { min-width: 66px; border-left: 1px solid #dde4e1; padding: 0 12px; }.readiness-header dt { color: #788981; font-size: 11px; }.readiness-header dd { margin: 2px 0 0; font-size: 17px; font-weight: 800; }.readiness-header dd.warning { color: #94691d; }.readiness-header dd.danger { color: #a5423b; }
.readiness-load-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px; border-left: 3px solid #b05a45; padding: 12px 14px; color: #653b31; background: #fff4f1; }.readiness-load-error-full { grid-column: 1 / 3; align-self: start; margin: 24px; }.readiness-load-error > span, .readiness-decision-error > div { display: grid; min-width: 0; gap: 4px; }.readiness-load-error strong, .readiness-decision-error strong { font-size: 10px; }.readiness-load-error small { overflow-wrap: anywhere; font-size: 11px; }.readiness-load-error p, .readiness-decision-error span { margin: 0; color: #765b54; font-size: 11px; line-height: 1.5; }.readiness-load-error .el-button { flex: 0 0 auto; }
.readiness-checks { min-width: 0; min-height: 0; overflow: auto; padding: 13px 16px 20px; }.readiness-checks > section { margin-bottom: 11px; border: 1px solid #d5ded9; background: #fff; }.readiness-checks > section > header { display: flex; justify-content: space-between; border-bottom: 1px solid #dce4e0; padding: 8px 11px; background: #f5f8f6; }.readiness-checks > section > header strong { font-size: 10px; }.readiness-checks > section > header span { color: #276f54; font-size: 11px; font-weight: 800; }.readiness-checks article { display: grid; grid-template-columns: 20px minmax(160px,1fr) 45px 55px; align-items: center; gap: 9px; min-height: 53px; border-bottom: 1px solid #e2e8e5; border-left: 3px solid #2d775a; padding: 7px 10px; }.readiness-checks article:last-child { border-bottom: 0; }.readiness-checks article.warning { border-left-color: #ba842b; background: #fffdf7; }.readiness-checks article.fail { border-left-color: #b44740; background: #fff9f8; }.readiness-checks article > .el-icon { color: #247354; }.readiness-checks article.warning > .el-icon { color: #aa7924; }.readiness-checks article.fail > .el-icon { color: #aa403a; }.readiness-checks article > div { display: grid; gap: 3px; }.readiness-checks article strong { font-size: 11px; }.readiness-checks article small { color: #74867e; font-size: 11px; line-height: 1.4; }.readiness-checks article em,.readiness-checks article > span { font-size: 11px; font-style: normal; }.readiness-checks article em { color: #277054; font-weight: 800; }.readiness-checks article.warning em { color: #93691d; }.readiness-checks article.fail em { color: #a34039; }.readiness-checks article > span { color: #72847c; text-align: right; }
.readiness-decision { min-height: 0; overflow: auto; border-left: 1px solid #d1dbd6; padding: 17px; background: #f9fbfa; }.readiness-decision > header { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 2px 8px; }.readiness-decision > header span { grid-column: 1 / 3; }.readiness-decision > header strong { font-size: 15px; }.readiness-decision > header small { color: #71837b; font-size: 11px; }.readiness-schedule-summary { display: grid; gap: 3px; margin: 15px 0; border-left: 3px solid #297356; padding: 10px 12px; background: #eaf3ee; }.readiness-schedule-summary span,.readiness-schedule-summary small { color: #657970; font-size: 11px; }.readiness-schedule-summary strong { font-size: 18px; }.readiness-decisions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; width: 100%; }.readiness-decisions :deep(.el-radio-button__inner) { width: 100%; border: 1px solid #d5ded9; border-radius: 3px; box-shadow: none; font-size: 11px; }.readiness-decision > label { display: grid; gap: 6px; margin-top: 16px; }.readiness-decision > label > span { color: #62766d; font-size: 11px; }.readiness-gate-state { display: grid; grid-template-columns: 22px minmax(0,1fr); gap: 8px; margin-top: 16px; border: 1px solid #ead3d0; padding: 10px; color: #9c413b; background: #fff8f7; }.readiness-gate-state.passed { border-color: #c8dfd3; color: #216b4f; background: #edf7f2; }.readiness-gate-state > div { display: grid; gap: 2px; }.readiness-gate-state strong { font-size: 11px; }.readiness-gate-state span { font-size: 11px; }.readiness-decision footer { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 18px; }.readiness-decision footer .el-button:last-child { grid-column: 1 / 3; }.readiness-readonly { display: grid; gap: 3px; margin-top: 17px; border-top: 1px solid #dce3df; padding-top: 13px; }.readiness-readonly strong { font-size: 10px; }.readiness-readonly span { color: #687b72; font-size: 11px; }
.readiness-decision-error { display: grid; place-items: center; }.readiness-decision-error > div { border-left: 3px solid #b05a45; padding: 14px; color: #653b31; background: #fff4f1; }.readiness-decision-error .el-button { margin-top: 8px; }
@media (max-width: 980px) { .readiness-header dl { display: none; } }
@media (max-width: 760px) { .logistics-readiness-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: auto 620px auto; }.readiness-header { grid-column: 1; grid-template-columns: 1fr 36px; }.readiness-decision { border-top: 1px solid #d1dbd6; border-left: 0; }.readiness-checks article { grid-template-columns: 20px minmax(120px,1fr) 42px; }.readiness-checks article > span { display: none; }.readiness-load-error { align-items: stretch; flex-direction: column; }.readiness-load-error-full { margin: 12px; } }
</style>
