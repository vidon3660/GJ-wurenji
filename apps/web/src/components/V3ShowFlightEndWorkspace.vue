<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { CircleCheck, Refresh, Upload } from "@element-plus/icons-vue"
import type { AuthUser, ShowFlightEndReportView, StudentProjectStageView, StudentProjectView } from "@wurenji/shared"
import { api } from "../api"
import { formatPlatformDateTime } from "../platform-date"

const props = defineProps<{ user: AuthUser; project: StudentProjectView; stage: StudentProjectStageView }>()
const emit = defineEmits<{ refreshProject: [] }>()
const loading = ref(false)
const loadError = ref("")
const report = ref<ShowFlightEndReportView | null>(null)
const completionStatus = ref<"NORMAL" | "ABNORMAL" | "ABORTED">("NORMAL")
const normalLandedCount = ref(0)
const abnormalCount = ref(0)
const abnormalDescription = ref("")
const canSubmit = computed(() => Boolean(report.value?.canSubmit && (props.user.role !== "student" || props.project.assessmentTiming.canWrite)))

onMounted(load)
watch(() => props.project.id, load)

async function load() {
  loading.value = true
  loadError.value = ""
  try {
    report.value = await api<ShowFlightEndReportView>(`/v3/show-projects/${props.project.id}/flight-end-report`)
    completionStatus.value = report.value.completionStatus ?? "NORMAL"
    normalLandedCount.value = report.value.normalLandedCount ?? report.value.suggestedNormalLandedCount
    abnormalCount.value = report.value.abnormalCount ?? report.value.suggestedAbnormalCount
    abnormalDescription.value = report.value.abnormalDescription
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "飞行结束报备加载失败"
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

async function saveEndReport() {
  await persist(false)
}

async function submitEndReport() {
  try {
    await ElMessageBox.confirm("确认提交飞行结束报备？提交后将进入飞后运行评估阶段。", "提交飞行结束报备", {
      confirmButtonText: "确认提交",
      cancelButtonText: "取消",
      type: "warning"
    })
  } catch {
    return
  }
  await persist(true)
}

async function persist(submitValue: boolean) {
  if (!report.value) return
  loading.value = true
  try {
    report.value = await api<ShowFlightEndReportView>(`/v3/show-projects/${props.project.id}/flight-end-report${submitValue ? "/submit" : ""}`, {
      method: submitValue ? "POST" : "PUT",
      body: JSON.stringify({
        expectedRevision: report.value.revision,
        completionStatus: completionStatus.value,
        normalLandedCount: normalLandedCount.value,
        abnormalCount: abnormalCount.value,
        abnormalDescription: abnormalDescription.value
      })
    })
    ElMessage.success(submitValue ? "飞行结束报备已提交" : "结束报备草稿已保存")
    if (submitValue) emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "结束报备保存失败")
    await load()
  } finally {
    loading.value = false
  }
}

function formatTime(value: string | null) {
  return value ? formatPlatformDateTime(value) : "-"
}
</script>

<template>
  <section class="flight-end-workspace" v-loading="loading">
    <header>
      <div><span>FLIGHT END REPORT</span><h2>飞行结束报备</h2><p>{{ report?.status === 'SUBMITTED' ? '信息已提交' : '降落清点与异常确认' }}</p></div>
      <el-button :icon="Refresh" circle title="刷新" @click="load" />
    </header>

    <div v-if="loadError && !report" class="flight-end-load-error flight-end-load-error-full" role="alert" aria-live="assertive"><span><strong>飞行结束报备加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的报备数据，请检查连接后重新加载。</p></span><el-button type="primary" :icon="Refresh" :loading="loading" @click="load">重新加载报备</el-button></div>

    <main v-if="report || !loadError">
      <div v-if="loadError && report" class="flight-end-load-error" role="alert" aria-live="assertive"><span><strong>报备数据同步失败</strong><small>{{ loadError }}</small><p>当前页面数据已保留，可继续查看；重新加载成功后再保存或提交。</p></span><el-button type="warning" :icon="Refresh" :loading="loading" @click="load">重试同步</el-button></div>
      <section class="flight-end-summary">
        <div><span>计划架数</span><strong>{{ report?.plannedCount ?? 0 }}</strong></div>
        <div><span>实际起飞</span><strong>{{ report?.actualTakeoffCount ?? 0 }}</strong></div>
        <div><span>建议正常降落</span><strong>{{ report?.suggestedNormalLandedCount ?? 0 }}</strong></div>
        <div><span>建议异常数量</span><strong>{{ report?.suggestedAbnormalCount ?? 0 }}</strong></div>
      </section>
      <section class="flight-end-times">
        <div><span>实际起飞时间</span><strong>{{ formatTime(report?.actualTakeoffAt ?? null) }}</strong></div>
        <div><span>降落完成时间</span><strong>{{ formatTime(report?.landingCompletedAt ?? null) }}</strong></div>
      </section>
      <section class="flight-end-form">
        <header><strong>降落清点与项目完成确认</strong><span>{{ (normalLandedCount ?? 0) + (abnormalCount ?? 0) }} / {{ report?.actualTakeoffCount ?? 0 }}</span></header>
        <div class="completion-options">
          <button v-for="item in [{ code: 'NORMAL', label: '正常完成' }, { code: 'ABNORMAL', label: '存在异常' }, { code: 'ABORTED', label: '运行中止' }]" :key="item.code" type="button" :class="{ active: completionStatus === item.code }" :disabled="!canSubmit" @click="completionStatus = item.code as typeof completionStatus"><i /><strong>{{ item.label }}</strong></button>
        </div>
        <div class="count-inputs">
          <label><span>正常降落数量</span><el-input-number v-model="normalLandedCount" :min="0" :max="report?.actualTakeoffCount ?? 0" :disabled="!canSubmit" /></label>
          <label><span>异常数量</span><el-input-number v-model="abnormalCount" :min="0" :max="report?.actualTakeoffCount ?? 0" :disabled="!canSubmit" /></label>
        </div>
        <label><span>异常说明</span><el-input v-model="abnormalDescription" type="textarea" :rows="5" maxlength="2000" show-word-limit :disabled="!canSubmit" /></label>
      </section>
      <section v-if="report?.status === 'SUBMITTED'" class="flight-end-authority">
        <header><strong>系统清点结果</strong><el-tag :type="report.answerCorrect ? 'success' : 'danger'">{{ report.answerCorrect ? '判定正确' : '需处理' }}</el-tag></header>
        <div><span>系统正常降落</span><strong>{{ report.authoritativeNormalLandedCount }}</strong><small>学生填报 {{ report.normalLandedCount ?? '-' }}</small></div>
        <div><span>系统异常数量</span><strong>{{ report.authoritativeAbnormalCount }}</strong><small>学生填报 {{ report.abnormalCount ?? '-' }}</small></div>
      </section>
    </main>

    <aside v-if="report || !loadError">
      <div class="flight-end-mark" :class="report?.status.toLowerCase()"><el-icon><CircleCheck /></el-icon><strong>{{ report?.status === 'SUBMITTED' ? '报备已提交' : '等待提交' }}</strong><span>{{ report?.submittedAt ? formatTime(report.submittedAt) : '教学仿真流程记录' }}</span></div>
      <dl>
        <div><dt>是否按计划完成</dt><dd>{{ completionStatus === 'NORMAL' ? '是' : completionStatus ? '否' : '待确认' }}</dd></div>
        <div><dt>数量核对</dt><dd>{{ normalLandedCount + abnormalCount === (report?.actualTakeoffCount ?? 0) ? '一致' : '待处理' }}</dd></div>
        <div><dt>异常说明</dt><dd>{{ completionStatus === 'NORMAL' ? '不要求' : abnormalDescription.trim().length >= 5 ? '已填写' : '待填写' }}</dd></div>
        <div><dt>系统判定</dt><dd>{{ report?.answerCorrect === null ? '待提交' : report?.answerCorrect ? '清点正确' : '清点需处理' }}</dd></div>
        <div><dt>提交人</dt><dd>{{ report?.submittedBy ?? '待提交' }}</dd></div>
      </dl>
      <footer v-if="canSubmit && user.role === 'student'"><el-button native-type="button" :icon="Upload" @click="saveEndReport">保存草稿</el-button><el-button native-type="button" type="primary" @click="submitEndReport">提交结束报备</el-button></footer>
      <div v-else class="flight-end-readonly"><strong>{{ user.role === 'student' ? '结束报备已锁定' : '教师只读查看' }}</strong><span>{{ report?.status === 'SUBMITTED' ? '学生已完成本阶段' : '等待学生完成报备' }}</span></div>
    </aside>
  </section>
</template>

<style scoped>
.flight-end-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: minmax(0,1fr) 320px; grid-template-rows: 78px minmax(0,1fr); min-width: 0; min-height: 0; background: #edf2ef; }
.flight-end-workspace > header { display: flex; grid-column: 1 / 3; align-items: center; justify-content: space-between; border-bottom: 1px solid #d1ddd7; padding: 10px 18px; background: white; }
.flight-end-workspace > header div { display: grid; gap: 2px; }
.flight-end-workspace > header span { color: #247354; font-size: 11px; font-weight: 800; }
.flight-end-workspace h2 { margin: 0; font-size: 16px; }
.flight-end-workspace > header p { margin: 0; color: #71847b; font-size: 11px; }
.flight-end-load-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 14px; border-left: 3px solid #b05a45; padding: 12px 14px; color: #653b31; background: #fff4f1; }
.flight-end-load-error-full { grid-column: 1 / 3; align-self: start; margin: 24px; }
.flight-end-load-error > span { display: grid; min-width: 0; gap: 3px; }
.flight-end-load-error strong { font-size: 10px; }
.flight-end-load-error small { overflow-wrap: anywhere; font-size: 11px; }
.flight-end-load-error p { margin: 0; color: #765b54; font-size: 11px; line-height: 1.5; }
.flight-end-load-error .el-button { flex: 0 0 auto; }
.flight-end-workspace > main { min-height: 0; overflow: auto; padding: 24px; }
.flight-end-summary { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid #ccd8d2; border-left: 1px solid #ccd8d2; background: white; }
.flight-end-summary div { display: grid; gap: 5px; border-right: 1px solid #ccd8d2; border-bottom: 1px solid #ccd8d2; padding: 16px; }
.flight-end-summary span, .flight-end-times span, .flight-end-form label > span { color: #71847b; font-size: 11px; }
.flight-end-summary strong { font-size: 24px; }
.flight-end-times { display: grid; grid-template-columns: 1fr 1fr; margin-top: 12px; border: 1px solid #d2ddd7; background: white; }
.flight-end-times div { display: grid; gap: 4px; border-right: 1px solid #d2ddd7; padding: 12px 14px; }
.flight-end-times div:last-child { border-right: 0; }
.flight-end-times strong { font-size: 10px; }
.flight-end-form { margin-top: 18px; border: 1px solid #d1ddd7; padding: 16px; background: white; }
.flight-end-form > header { display: flex; justify-content: space-between; margin-bottom: 12px; }
.flight-end-form > header strong { font-size: 11px; }
.flight-end-form > header span { color: #247354; font-size: 11px; font-weight: 800; }
.completion-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }
.completion-options button { display: flex; align-items: center; gap: 7px; min-height: 38px; border: 1px solid #d4dfd9; padding: 8px 10px; color: #63776e; text-align: left; background: #f8faf9; cursor: pointer; }
.completion-options button i { width: 9px; height: 9px; border: 1px solid #8ea198; border-radius: 50%; }
.completion-options button.active { border-color: #247354; color: #194b3a; background: #edf6f1; }
.completion-options button.active i { border: 3px solid #247354; }
.completion-options button:disabled { cursor: default; }
.completion-options strong { font-size: 11px; }
.count-inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 15px 0; }
.flight-end-form label { display: grid; gap: 6px; }
.flight-end-authority { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1px; margin-top: 18px; border: 1px solid #d1ddd7; background: #d1ddd7; }
.flight-end-authority > header { display: flex; grid-column: 1 / -1; align-items: center; justify-content: space-between; padding: 12px 14px; background: white; }
.flight-end-authority > header strong { font-size: 11px; }
.flight-end-authority > div { display: grid; gap: 4px; padding: 12px 14px; background: #f8fbf9; }
.flight-end-authority span, .flight-end-authority small { color: #71847b; font-size: 11px; }
.flight-end-authority strong { font-size: 20px; }
.flight-end-workspace > aside { min-height: 0; overflow: auto; border-left: 1px solid #d1ddd7; padding: 20px; background: #f9fbfa; }
.flight-end-mark { display: grid; justify-items: center; gap: 5px; border-bottom: 1px solid #d6e0db; padding: 20px 0 24px; }
.flight-end-mark .el-icon { display: grid; width: 46px; height: 46px; place-items: center; border: 1px solid #aac0b5; border-radius: 50%; color: #247354; font-size: 23px; }
.flight-end-mark.submitted .el-icon { color: white; background: #247354; }
.flight-end-mark strong { font-size: 13px; }
.flight-end-mark span { color: #71847b; font-size: 11px; }
.flight-end-workspace > aside dl { display: grid; margin: 18px 0; border-top: 1px solid #d8e1dd; }
.flight-end-workspace > aside dl div { display: flex; justify-content: space-between; border-bottom: 1px solid #d8e1dd; padding: 9px 0; }
.flight-end-workspace > aside dt, .flight-end-workspace > aside dd { margin: 0; font-size: 11px; }
.flight-end-workspace > aside dt { color: #71847b; }
.flight-end-workspace > aside footer { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.flight-end-readonly { display: grid; gap: 4px; border-left: 3px solid #247354; padding: 10px 12px; background: #eaf3ee; }
.flight-end-readonly strong { font-size: 10px; }
.flight-end-readonly span { color: #64786e; font-size: 11px; }
@media (max-width: 900px) { .flight-end-summary { grid-template-columns: 1fr 1fr; } }
@media (max-width: 760px) { .flight-end-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: auto 620px auto; } .flight-end-workspace > header { grid-column: 1; } .flight-end-workspace > aside { border-top: 1px solid #d1ddd7; border-left: 0; } .flight-end-load-error { align-items: stretch; flex-direction: column; } .flight-end-load-error-full { margin: 12px; } }

@media (max-width: 760px) {
  .flight-end-workspace { display: flex; grid-column: 1; grid-row: 3 / 5; min-height: 0; overflow: auto; flex-direction: column; }
  .flight-end-workspace > header { flex: 0 0 auto; }
  .flight-end-workspace > main { flex: 1 1 auto; min-height: 520px; padding: 18px 12px; }
  .flight-end-workspace > aside { flex: 0 0 auto; border-top: 1px solid #d1ddd7; border-left: 0; }
}
@media (max-width: 420px) {
  .flight-end-workspace > header { align-items: flex-start; flex-direction: column; gap: 8px; padding: 12px; }
  .flight-end-summary strong { font-size: 20px; }
  .flight-end-times { grid-template-columns: 1fr; }
  .completion-options { grid-template-columns: 1fr; }
  .count-inputs { grid-template-columns: 1fr; gap: 8px; }
}
</style>
