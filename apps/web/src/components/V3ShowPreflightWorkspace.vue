<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { Check, CircleCheck, Refresh, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  ShowPreflightCategory,
  ShowPreflightItemView,
  ShowPreflightResolution,
  ShowPreflightWorkspaceView,
  ShowTakeoffDecision,
  StudentProjectStageView,
  StudentProjectView
} from "@wurenji/shared"
import { api } from "../api"
import { formatPlatformDateTime } from "../platform-date"
import { showTakeoffDecisionGate } from "../show-takeoff-decision"

const props = defineProps<{ user: AuthUser; project: StudentProjectView; stage: StudentProjectStageView }>()
const emit = defineEmits<{ refreshProject: [] }>()
const loading = ref(false)
const loadError = ref("")
const workspace = ref<ShowPreflightWorkspaceView | null>(null)
const items = ref<ShowPreflightItemView[]>([])
const decision = ref<ShowTakeoffDecision | null>(null)
const rationale = ref("")

const isStudent = computed(() => props.user.role === "student")
const canEdit = computed(() => Boolean(workspace.value?.canEdit && isStudent.value && props.project.assessmentTiming.canWrite))
const confirmedCount = computed(() => items.value.filter((item) => item.confirmed).length)
const issueCount = computed(() => items.value.filter((item) => item.sourceStatus !== "NORMAL").length)
const unresolvedCount = computed(() => items.value.filter((item) => item.sourceStatus !== "NORMAL" && !item.resolved).length)
const groupedItems = computed(() => categoryDefinitions.map((category) => ({ ...category, items: items.value.filter((item) => item.category === category.code) })))
const decisionGate = computed(() => showTakeoffDecisionGate(items.value, decision.value, rationale.value))

const categoryDefinitions: Array<{ code: ShowPreflightCategory; title: string }> = [
  { code: "AIRCRAFT", title: "无人机" },
  { code: "GROUND_SYSTEM", title: "地面站" },
  { code: "POSITIONING", title: "定位" },
  { code: "COMMUNICATION", title: "通信" },
  { code: "WEATHER", title: "气象" },
  { code: "SITE_AREA", title: "区域" },
  { code: "PERSONNEL", title: "人员" },
  { code: "APPLICATION_SUPPORT", title: "申报保障" }
]

const resolutionOptions: Array<{ value: ShowPreflightResolution; label: string }> = [
  { value: "CONFIRMED", label: "确认状态" },
  { value: "EXCLUDED", label: "排除异常" },
  { value: "REPLACED", label: "更换设备" },
  { value: "RECHECKED", label: "重新检查" },
  { value: "PAUSED", label: "暂停放飞" }
]

onMounted(loadWorkspace)
watch(() => props.project.id, loadWorkspace)

async function loadWorkspace() {
  loading.value = true
  loadError.value = ""
  try {
    const value = await api<ShowPreflightWorkspaceView>(`/v3/show-projects/${props.project.id}/preflight`)
    workspace.value = value
    items.value = value.items.map((item) => ({ ...item }))
    decision.value = value.decision
    rationale.value = value.rationale
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "飞前检查加载失败"
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

function confirmNormalItems() {
  if (!canEdit.value) return
  items.value = items.value.map((item) => item.sourceStatus === "NORMAL"
    ? { ...item, confirmed: true, resolution: "CONFIRMED", resolved: true }
    : item)
}

function updateResolution(item: ShowPreflightItemView, value: ShowPreflightResolution | null) {
  item.resolution = value
  if (value === "EXCLUDED" || value === "REPLACED" || value === "RECHECKED") item.resolved = true
  if (value === "PAUSED") item.resolved = false
}

async function save(showMessage = true) {
  if (!workspace.value || !canEdit.value) return
  loading.value = true
  try {
    const value = await api<ShowPreflightWorkspaceView>(`/v3/show-projects/${props.project.id}/preflight`, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: workspace.value.revision,
        responses: items.value.map(({ code, confirmed, resolution, resolved, note }) => ({ code, confirmed, resolution, resolved, note })),
        decision: decision.value,
        rationale: rationale.value
      })
    })
    workspace.value = value
    items.value = value.items.map((item) => ({ ...item }))
    if (showMessage) ElMessage.success("飞前检查已保存")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "飞前检查保存失败")
    await loadWorkspace()
  } finally {
    loading.value = false
  }
}

async function complete() {
  if (!workspace.value) return
  await save(false)
  if (!workspace.value) return
  loading.value = true
  try {
    workspace.value = await api<ShowPreflightWorkspaceView>(`/v3/show-projects/${props.project.id}/preflight/complete`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: workspace.value.revision })
    })
    ElMessage.success("飞前准备已完成，仿真时钟已启动")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "飞前准备提交失败")
  } finally {
    loading.value = false
  }
}

function sourceLabel(status: ShowPreflightItemView["sourceStatus"]) {
  return ({ NORMAL: "正常", WARNING: "关注", ABNORMAL: "异常" } as const)[status]
}
</script>

<template>
  <section class="preflight-workspace" v-loading="loading">
    <header class="preflight-header">
      <div><span>PRE-FLIGHT CHECK</span><h2>飞前准备与起飞决策</h2><p>逐项确认设备、环境、区域与保障状态</p><p v-if="loadError" class="preflight-load-error" role="alert">检查数据加载失败：{{ loadError }}，请重新加载。</p></div>
      <dl><div><dt>已确认</dt><dd>{{ confirmedCount }}/{{ items.length }}</dd></div><div><dt>异常项</dt><dd>{{ issueCount }}</dd></div><div><dt>未处置</dt><dd>{{ unresolvedCount }}</dd></div></dl>
      <el-button :icon="Refresh" circle :disabled="loading" :title="loadError ? '重新加载飞前检查' : '刷新飞前检查'" :aria-label="loadError ? '重新加载飞前检查' : '刷新飞前检查'" @click="loadWorkspace" />
    </header>

    <section v-if="loadError && !workspace" class="preflight-load-panel" role="alert">
      <el-icon><Warning /></el-icon>
      <strong>飞前检查暂时无法加载</strong>
      <span>{{ loadError }}</span>
      <el-button type="primary" :loading="loading" :disabled="loading" @click="loadWorkspace">重新加载</el-button>
    </section>

    <main v-if="workspace || !loadError" class="preflight-list">
      <section v-for="category in groupedItems" :key="category.code">
        <header><strong>{{ category.title }}</strong><span>{{ category.items.filter((item) => item.confirmed).length }}/{{ category.items.length }}</span></header>
        <div v-for="item in category.items" :key="item.code" class="preflight-row" :class="item.sourceStatus.toLowerCase()">
          <el-checkbox v-model="item.confirmed" :disabled="!canEdit" />
          <div class="preflight-item-name"><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></div>
          <span class="source-state"><el-icon v-if="item.sourceStatus !== 'NORMAL'"><Warning /></el-icon>{{ sourceLabel(item.sourceStatus) }}<small v-if="item.affectedCount">{{ item.affectedCount }}</small></span>
          <el-select :model-value="item.resolution" :disabled="!canEdit" placeholder="处置" clearable @update:model-value="updateResolution(item, $event)">
            <el-option v-for="option in resolutionOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
          <el-checkbox v-if="item.sourceStatus !== 'NORMAL'" v-model="item.resolved" :disabled="!canEdit" label="已解决" />
          <span v-else class="normal-mark"><el-icon><Check /></el-icon></span>
          <el-input v-model="item.note" :disabled="!canEdit" maxlength="500" placeholder="记录" />
        </div>
      </section>
    </main>

    <aside v-if="workspace || !loadError" class="preflight-decision">
      <header><span>TAKEOFF DECISION</span><strong>起飞决策</strong></header>
      <p class="decision-instruction">全部检查项确认后作出判断，四种决策均须填写简要依据。</p>
      <el-radio-group v-model="decision" :disabled="!canEdit || !decisionGate.checksComplete" class="decision-options">
        <el-radio-button value="ALLOW">允许起飞</el-radio-button>
        <el-radio-button value="ALLOW_AFTER_RECTIFICATION">整改后起飞</el-radio-button>
        <el-radio-button value="DELAY">推迟起飞</el-radio-button>
        <el-radio-button value="CANCEL">取消表演</el-radio-button>
      </el-radio-group>
      <label><span>判断依据</span><el-input v-model="rationale" :disabled="!canEdit || !decision" type="textarea" :rows="5" maxlength="2000" show-word-limit placeholder="简要说明检查结论、风险判断和决策原因" /></label>
      <div class="decision-summary"><span :class="{ complete: confirmedCount === items.length }">{{ confirmedCount === items.length ? '检查项已全部确认' : `尚有 ${items.length - confirmedCount} 项未确认` }}</span><span :class="{ complete: unresolvedCount === 0 }">{{ unresolvedCount === 0 ? '异常项已形成处置结果' : `${unresolvedCount} 项异常未处置` }}</span></div>
      <footer v-if="canEdit"><el-button @click="confirmNormalItems">确认全部正常项</el-button><el-button @click="save()">保存</el-button><el-button type="primary" :icon="CircleCheck" :disabled="!decisionGate.canComplete" @click="complete">完成飞前准备</el-button></footer>
      <div v-else class="preflight-readonly"><strong>{{ workspace?.status === 'COMPLETED' ? '飞前准备已完成' : '只读查看' }}</strong><span>{{ workspace?.completedAt ? formatPlatformDateTime(workspace.completedAt) : '等待学生提交' }}</span></div>
    </aside>
  </section>
</template>

<style scoped>
.preflight-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0, 1fr) 330px; grid-template-rows: auto minmax(0, 1fr); min-width: 0; min-height: 0; background: #eef2f0; }
.preflight-header { grid-column: 1 / 3; display: grid; grid-template-columns: minmax(0, 1fr) auto 36px; align-items: center; gap: 22px; min-height: 82px; border-bottom: 1px solid #d3ddd8; padding: 12px 18px; background: white; }
.preflight-header > div:first-child { display: grid; gap: 2px; }
.preflight-header span, .preflight-decision > header span { color: #247354; font-size: 11px; font-weight: 800; }
.preflight-header h2 { margin: 0; font-size: 16px; }
.preflight-header p { margin: 0; color: #74867e; font-size: 11px; }
.preflight-header dl { display: flex; gap: 18px; margin: 0; }
.preflight-header dl div { display: grid; gap: 2px; min-width: 48px; }
.preflight-header dt { color: #7b8b84; font-size: 11px; }
.preflight-header dd { margin: 0; font-size: 17px; font-weight: 700; }
.preflight-list { min-height: 0; overflow: auto; padding: 12px 16px 20px; }
.preflight-list > section { margin-bottom: 12px; border: 1px solid #d6dfda; background: white; }
.preflight-list > section > header { display: flex; justify-content: space-between; border-bottom: 1px solid #dce4e0; padding: 9px 11px; background: #f5f8f6; }
.preflight-list > section > header strong { font-size: 10px; }
.preflight-list > section > header span { color: #247354; font-size: 11px; font-weight: 700; }
.preflight-row { display: grid; grid-template-columns: 22px minmax(130px, 1fr) 72px 118px 74px minmax(110px, .8fr); align-items: center; gap: 8px; min-height: 54px; border-bottom: 1px solid #e3e8e5; padding: 7px 10px; }
.preflight-row:last-child { border-bottom: 0; }
.preflight-row.warning { box-shadow: inset 3px 0 #c49535; background: #fffdf7; }
.preflight-row.abnormal { box-shadow: inset 3px 0 #b54e48; background: #fff9f8; }
.preflight-item-name { display: grid; gap: 2px; }
.preflight-item-name strong { font-size: 11px; }
.preflight-item-name small { color: #798981; font-size: 11px; }
.source-state { display: flex; align-items: center; gap: 3px; color: #247354; font-size: 11px; font-weight: 700; }
.warning .source-state { color: #9a6f1e; }
.abnormal .source-state { color: #a13d38; }
.source-state small { border-radius: 2px; padding: 1px 3px; background: currentColor; color: white; font-size: 11px; }
.normal-mark { color: #247354; text-align: center; }
.preflight-decision { min-height: 0; overflow: auto; border-left: 1px solid #d3ddd8; padding: 18px; background: #f9fbfa; }
.preflight-decision > header { display: grid; gap: 3px; margin-bottom: 17px; }
.preflight-decision > header strong { font-size: 15px; }
.decision-instruction { margin: -8px 0 12px; color: #697c73; font-size: 11px; line-height: 1.55; }
.decision-options { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; width: 100%; }
.decision-options :deep(.el-radio-button__inner) { width: 100%; border: 1px solid #d6dfda; border-radius: 3px; box-shadow: none; font-size: 11px; }
.preflight-decision > label { display: grid; gap: 6px; margin-top: 16px; }
.preflight-decision > label > span { color: #64776e; font-size: 11px; }
.decision-summary { display: grid; gap: 7px; margin-top: 16px; border-top: 1px solid #dce3df; padding-top: 13px; }
.decision-summary span { color: #a14a43; font-size: 11px; }
.decision-summary span.complete { color: #247354; }
.preflight-decision footer { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 20px; }
.preflight-decision footer .el-button:last-child { grid-column: 1 / 3; }
.preflight-readonly { display: grid; gap: 4px; margin-top: 20px; border-left: 3px solid #247354; padding: 10px 12px; background: #eaf3ee; }
.preflight-readonly strong { font-size: 10px; }
.preflight-readonly span { color: #62766d; font-size: 11px; }
@media (max-width: 1120px) { .preflight-row { grid-template-columns: 22px minmax(120px, 1fr) 64px 105px 68px; } .preflight-row > :last-child { grid-column: 2 / 6; } }
@media (max-width: 760px) { .preflight-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: auto 620px auto; } .preflight-header { grid-column: 1; grid-template-columns: 1fr 36px; } .preflight-header dl { display: none; } .preflight-row { grid-template-columns: 22px minmax(0,1fr) 64px; align-items: start; gap: 7px; padding: 9px 8px; }.preflight-row > :first-child { grid-column: 1; grid-row: 1; }.preflight-item-name { grid-column: 2; grid-row: 1; }.source-state { grid-column: 3; grid-row: 1; justify-self: end; }.preflight-row > :nth-child(4) { grid-column: 2 / 4; grid-row: 2; min-width: 0; width: 100%; }.preflight-row > :nth-child(5) { grid-column: 1; grid-row: 2; align-self: center; }.preflight-row > :last-child { grid-column: 2 / 4; grid-row: 3; min-width: 0; width: 100%; }.preflight-decision { border-top: 1px solid #d3ddd8; border-left: 0; } }
.preflight-load-error { color: #a14b3f!important; }
.preflight-load-panel { grid-column: 1 / 3; display: grid; place-items: center; align-content: center; gap: 9px; min-height: 300px; padding: 32px; color: #71847c; text-align: center; background: #eef3f0; }
.preflight-load-panel .el-icon { color: #a14b3f; font-size: 28px; }
.preflight-load-panel strong { color: #8b3f35; font-size: 13px; }
.preflight-load-panel span { max-width: 48ch; font-size: 11px; line-height: 1.6; }

@media (max-width: 760px) {
  .preflight-workspace { display: flex; grid-column: 1; grid-row: 3 / 5; min-height: 0; overflow: auto; flex-direction: column; }
  .preflight-header { flex: 0 0 auto; }
  .preflight-list { flex: 1 1 auto; min-height: 520px; }
  .preflight-decision { flex: 0 0 auto; border-top: 1px solid #d3ddd8; border-left: 0; }
}
@media (max-width: 420px) {
  .preflight-header { align-items: flex-start; gap: 9px; padding: 12px; }
  .preflight-row { grid-template-columns: 20px minmax(0, 1fr) 58px; gap: 6px; }
  .preflight-list { padding: 10px 9px 18px; }
}
</style>
