<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Check, CircleCheck, DocumentChecked, Loading, Lock, Refresh } from "@element-plus/icons-vue"
import type { AuthUser, QuestionAnswer, QuestionResponseView, QuestionnaireView, QuestionType } from "@wurenji/shared"
import { api } from "../api"
import { answerFieldsFor, fieldValuesFromAnswer, isQuestionAnswerComplete, isStructuredQuestion as isStructuredQuestionType, questionFieldLabel, structuredAnswerFromFields } from "../questionnaire-form"

const props = defineProps<{ visible: boolean; projectId: string; user: AuthUser; questionnaire: QuestionnaireView | null; loading?: boolean }>()
const emit = defineEmits<{ "update:visible": [value: boolean]; updated: [value: QuestionnaireView]; retry: [] }>()
const answerValues = ref<Record<string, QuestionAnswer>>({})
const textValues = ref<Record<string, string>>({})
const fieldValues = ref<Record<string, Record<string, string>>>({})
const teacherScores = ref<Record<string, number | null>>({})
const teacherComments = ref<Record<string, string>>({})
const reviewComment = ref("")
const saving = ref(false)
const errorText = ref("")
const lastFailedAction = ref<"SAVE" | "SUBMIT" | "REVIEW" | "REGRADE" | null>(null)

const isTeacher = computed(() => props.questionnaire?.actor === "TEACHER")
const canEdit = computed(() => props.questionnaire?.canEdit === true)
const canSubmit = computed(() => props.questionnaire?.canSubmit === true)
const canRetryFailedAction = computed(() => Boolean(lastFailedAction.value && (canEdit.value || (isTeacher.value && (props.questionnaire?.canReview || props.questionnaire?.canRegrade)))))
const retryActionLabel = computed(() => ({ SAVE: "重试保存", SUBMIT: "重试提交", REVIEW: "重试复核", REGRADE: "重试判定" } as const)[lastFailedAction.value ?? "SAVE"])
const hasAttempt = computed(() => Boolean(props.questionnaire?.attempt))
const pendingEvidenceCount = computed(() => (props.questionnaire?.responses ?? []).filter((response) => response.judgment === "PENDING").length)
const autoScore = computed(() => round((props.questionnaire?.responses ?? []).reduce((sum, item) => sum + (item.autoScore ?? 0), 0)))
const teacherScore = computed(() => round((props.questionnaire?.responses ?? []).reduce((sum, item) => sum + (item.teacherScore ?? 0), 0)))
const manualQuestions = computed(() => (props.questionnaire?.questions ?? []).filter((question) => question.type !== "SIMULATION_EVIDENCE"))
const evidenceQuestionCount = computed(() => (props.questionnaire?.questions ?? []).filter((question) => question.type === "SIMULATION_EVIDENCE").length)
const unansweredQuestions = computed(() => manualQuestions.value.filter((question) => !questionAnswered(question)))
const answeredQuestionCount = computed(() => manualQuestions.value.length - unansweredQuestions.value.length)

watch(() => props.questionnaire, (value) => { if (value) syncValues(value) }, { immediate: true })

function syncValues(value: QuestionnaireView) {
  const nextAnswers: Record<string, QuestionAnswer> = {}
  const nextTexts: Record<string, string> = {}
  const nextFields: Record<string, Record<string, string>> = {}
  const nextScores: Record<string, number | null> = {}
  const nextComments: Record<string, string> = {}
  const responseByCode = new Map(value.responses.map((response) => [response.questionCode, response]))
  for (const question of value.questions) {
    const response = responseByCode.get(question.code)
    nextAnswers[question.code] = question.type === "MULTIPLE_CHOICE"
      ? Array.isArray(response?.answer) ? response.answer : []
      : response?.answer ?? null
    const answerFields = answerFieldsFor(question)
    nextFields[question.code] = fieldValuesFromAnswer(response?.answer ?? null, answerFields)
    nextTexts[question.code] = isStructuredQuestion(question.type) && answerFields.length === 0 ? formatAnswer(response?.answer ?? null) : ""
    nextScores[question.code] = response?.teacherScore ?? response?.autoScore ?? null
    nextComments[question.code] = response?.teacherComment ?? ""
  }
  answerValues.value = nextAnswers
  textValues.value = nextTexts
  fieldValues.value = nextFields
  teacherScores.value = nextScores
  teacherComments.value = nextComments
  reviewComment.value = value.attempt?.reviewComment ?? ""
  errorText.value = ""
  lastFailedAction.value = null
}

async function saveAnswers(submit = false, alreadyConfirmed = false) {
  if (!props.questionnaire || (submit ? !canSubmit.value : !canEdit.value)) return
  if (submit && !alreadyConfirmed) {
    const unansweredCount = unansweredQuestions.value.length
    try {
      await ElMessageBox.confirm(
        unansweredCount > 0
          ? `仍有 ${unansweredCount} 道题未完成，提交后将按未作答判定且不能继续修改。仍要提交吗？`
          : "提交后本次题库作答不能继续修改，确定提交吗？",
        "提交作答",
        { type: "warning", confirmButtonText: unansweredCount > 0 ? "仍然提交" : "提交", cancelButtonText: unansweredCount > 0 ? "返回补充" : "继续编辑" }
      )
    } catch {
      if (unansweredCount > 0) await locateFirstUnanswered()
      return
    }
  }
  try {
    const responses = props.questionnaire.questions.map((question) => ({ questionCode: question.code, answer: answerFor(question) }))
    saving.value = true
    const value = await api<QuestionnaireView>(submit ? `/v3/projects/${props.projectId}/questionnaire/submit` : `/v3/projects/${props.projectId}/questionnaire`, {
      method: submit ? "POST" : "PUT",
      body: JSON.stringify({ expectedRevision: props.questionnaire.attempt?.revision ?? 1, responses })
    })
    emit("updated", value)
    ElMessage.success(submit ? "作答已提交，系统已生成自动判定" : "作答已保存")
  } catch (error) {
    lastFailedAction.value = submit ? "SUBMIT" : "SAVE"
    errorText.value = error instanceof Error ? error.message : "题库作答保存失败"
  } finally {
    saving.value = false
  }
}

function retryLastAction() {
  if (saving.value) return
  if (lastFailedAction.value === "SAVE") void saveAnswers(false, true)
  else if (lastFailedAction.value === "SUBMIT") void saveAnswers(true, true)
  else if (lastFailedAction.value === "REVIEW") void saveReview()
  else if (lastFailedAction.value === "REGRADE") void regrade()
}

async function saveReview() {
  if (!props.questionnaire || !isTeacher.value || !props.questionnaire.canReview) return
  try {
    saving.value = true
    const value = await api<QuestionnaireView>(`/v3/projects/${props.projectId}/questionnaire/review`, {
      method: "PUT",
      body: JSON.stringify({
        expectedRevision: props.questionnaire.attempt?.revision ?? 1,
        reviewComment: reviewComment.value,
        responses: props.questionnaire.questions.map((question) => ({ questionCode: question.code, teacherScore: teacherScores.value[question.code], teacherComment: teacherComments.value[question.code] ?? "" }))
      })
    })
    emit("updated", value)
    ElMessage.success("题库作答复核已保存")
  } catch (error) {
    lastFailedAction.value = "REVIEW"
    errorText.value = error instanceof Error ? error.message : "题库复核保存失败"
  } finally {
    saving.value = false
  }
}

async function regrade() {
  if (!props.questionnaire || !isTeacher.value || !props.questionnaire.canRegrade) return
  try {
    saving.value = true
    const value = await api<QuestionnaireView>(`/v3/projects/${props.projectId}/questionnaire/regrade`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: props.questionnaire.attempt?.revision ?? 1 })
    })
    emit("updated", value)
    ElMessage.success("已按最新仿真评价指标重新判定")
  } catch (error) {
    lastFailedAction.value = "REGRADE"
    errorText.value = error instanceof Error ? error.message : "题库重新判定失败"
  } finally {
    saving.value = false
  }
}

function answerFor(question: QuestionnaireView["questions"][number]): QuestionAnswer {
  if (question.type === "SIMULATION_EVIDENCE") return null
  if (!isStructuredQuestion(question.type)) return answerValues.value[question.code] ?? null
  const answerFields = answerFieldsFor(question)
  if (answerFields.length > 0) return structuredAnswerFromFields(fieldValues.value[question.code], answerFields)
  const raw = textValues.value[question.code]?.trim() ?? ""
  if (!raw) return null
  try { return JSON.parse(raw) as QuestionAnswer } catch { throw new Error(`题目 ${question.code} 的结构化答案不是有效 JSON`) }
}

function responseFor(code: string): QuestionResponseView | undefined {
  return props.questionnaire?.responses.find((response) => response.questionCode === code)
}

function isStructuredQuestion(type: QuestionType) {
  return isStructuredQuestionType(type)
}

function questionAnswered(question: QuestionnaireView["questions"][number]): boolean {
  if (question.type === "SIMULATION_EVIDENCE") return true
  if (!isStructuredQuestion(question.type)) return isQuestionAnswerComplete(answerValues.value[question.code] ?? null)
  const fields = answerFieldsFor(question)
  if (fields.length > 0) return isQuestionAnswerComplete(structuredAnswerFromFields(fieldValues.value[question.code], fields), fields)
  return Boolean(textValues.value[question.code]?.trim())
}

async function locateFirstUnanswered() {
  const question = unansweredQuestions.value[0]
  if (!question) return
  await nextTick()
  document.querySelector<HTMLElement>(`[data-question-code="${CSS.escape(question.code)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })
}

function questionTypeLabel(type: QuestionType) {
  return ({ SINGLE_CHOICE: "单选题", MULTIPLE_CHOICE: "多选题", TRUE_FALSE: "判断题", PLANNING: "规划题", SCHEDULE: "时刻表题", SCENARIO_DECISION: "场景决策题", SIMULATION_EVIDENCE: "仿真证据题" } as Record<QuestionType, string>)[type]
}

function formatAnswer(value: QuestionAnswer): string {
  if (value === null) return ""
  if (typeof value === "object") return JSON.stringify(value, null, 2)
  return String(value)
}

function judgmentLabel(response: QuestionResponseView | undefined) {
  return ({ CORRECT: "正确", PARTIAL: "部分得分", INCORRECT: "未通过", UNANSWERED: "未作答", PENDING: "等待仿真证据" } as Record<string, string>)[response?.judgment ?? "UNANSWERED"]
}

function judgmentClass(response: QuestionResponseView | undefined) {
  return (response?.judgment ?? "UNANSWERED").toLowerCase()
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
</script>

<template>
  <el-drawer :model-value="visible" title="题库作答与判定" size="min(720px, 100%)" append-to-body @update:model-value="emit('update:visible', $event)">
    <div class="questionnaire-panel" v-loading="saving || loading">
      <template v-if="questionnaire?.available && questionnaire.bank">
        <header class="questionnaire-header"><div><span class="eyebrow">{{ isTeacher ? 'TEACHER REVIEW' : 'QUESTIONNAIRE' }}</span><h2>{{ questionnaire.bank.title }}</h2><p>版本 V{{ questionnaire.bank.version }} · {{ questionnaire.questions.length }} 道题</p><p v-if="!isTeacher" class="questionnaire-scoring-guide"><span>手动作答 {{ manualQuestions.length }} 题</span><span>仿真自动判定 {{ evidenceQuestionCount }} 题</span></p></div><div class="questionnaire-score"><span>{{ !isTeacher && canEdit ? '作答进度' : '自动得分' }}</span><strong>{{ !isTeacher && canEdit ? answeredQuestionCount : autoScore }}</strong><small>/ {{ !isTeacher && canEdit ? manualQuestions.length : questionnaire.attempt?.maxScore ?? questionnaire.questions.reduce((sum, question) => sum + question.maxScore, 0) }}</small><em v-if="isTeacher">教师得分 {{ teacherScore }}</em><button v-else-if="canEdit && unansweredQuestions.length" type="button" @click="locateFirstUnanswered">定位 {{ unansweredQuestions.length }} 道未答题</button></div></header>
        <div v-if="errorText" class="questionnaire-error" role="alert" aria-live="assertive"><strong>{{ errorText }}</strong><div class="questionnaire-error-actions"><el-button v-if="canRetryFailedAction" text :icon="Refresh" :disabled="saving" @click="retryLastAction">{{ retryActionLabel }}</el-button><el-button text @click="errorText = ''; lastFailedAction = null">关闭</el-button></div></div>
        <div class="questionnaire-state" role="status" aria-live="polite" :class="{ submitted: hasAttempt && questionnaire.attempt?.status !== 'IN_PROGRESS' }"><Check v-if="hasAttempt && questionnaire.attempt?.status !== 'IN_PROGRESS'" /><span v-if="isTeacher && pendingEvidenceCount > 0">有 {{ pendingEvidenceCount }} 道仿真证据题等待指标，可重新判定后再复核</span><span v-else-if="questionnaire.attempt?.status === 'SUBMITTED'">已提交，等待教师复核</span><span v-else-if="questionnaire.attempt?.status === 'GRADED'">自动判定已完成，等待教师复核</span><span v-else-if="questionnaire.attempt?.status === 'REVIEWED'">教师复核已完成</span><span v-else>{{ questionnaire.canEdit ? '尚未开始，可先填写并保存草稿' : '当前为只读查看' }}</span></div>
        <section class="questionnaire-list">
          <article v-for="(question, index) in questionnaire.questions" :key="question.code" class="question-card" :class="{ unanswered: canEdit && question.type !== 'SIMULATION_EVIDENCE' && !questionAnswered(question) }" :data-question-code="question.code">
            <header><div><span class="question-number">{{ String(index + 1).padStart(2, '0') }}</span><strong>{{ questionTypeLabel(question.type) }}</strong><small>{{ question.code }} · {{ question.maxScore }} 分</small></div><span v-if="isTeacher" class="judgment" :class="judgmentClass(responseFor(question.code))">{{ judgmentLabel(responseFor(question.code)) }}</span><span v-else-if="responseFor(question.code)?.judgment !== 'UNANSWERED'" class="judgment" :class="judgmentClass(responseFor(question.code))">{{ judgmentLabel(responseFor(question.code)) }}</span></header>
            <h3>{{ question.prompt }}</h3>
            <el-radio-group v-if="question.type === 'SINGLE_CHOICE' || question.type === 'TRUE_FALSE'" v-model="answerValues[question.code]" :disabled="!canEdit" :aria-label="`${question.code} 单选答案`"><el-radio v-for="option in question.options" :key="option.key" :label="option.key">{{ option.label }}</el-radio></el-radio-group>
            <el-checkbox-group v-else-if="question.type === 'MULTIPLE_CHOICE'" v-model="answerValues[question.code]" :disabled="!canEdit" :aria-label="`${question.code} 多选答案`"><el-checkbox v-for="option in question.options" :key="option.key" :label="option.key">{{ option.label }}</el-checkbox></el-checkbox-group>
            <div v-else-if="isStructuredQuestion(question.type) && answerFieldsFor(question).length" class="structured-answer-fields">
              <p>按任务要求填写以下字段，保存后系统会根据字段完整度判定。</p>
              <label v-for="field in answerFieldsFor(question)" :key="field">
                <span>{{ questionFieldLabel(field) }}</span>
                <el-input v-model="fieldValues[question.code]![field]" :disabled="!canEdit" :placeholder="`填写 ${questionFieldLabel(field)}`" :aria-label="`${question.code} ${questionFieldLabel(field)}`" />
              </label>
            </div>
            <el-input v-else-if="isStructuredQuestion(question.type)" v-model="textValues[question.code]" type="textarea" :rows="5" :disabled="!canEdit" :aria-label="`${question.code} 结构化答案`" placeholder="填写结构化 JSON 答案，例如 routePlan 等字段" />
            <div v-else class="evidence-placeholder"><DocumentChecked /><span>本题不需要另行填写，系统会读取服务端仿真评价指标。</span></div>
            <div v-if="isTeacher" class="teacher-review-row"><div><label>教师评分</label><el-input-number v-model="teacherScores[question.code]" :min="0" :max="question.maxScore" :precision="2" :disabled="!questionnaire.canReview" :aria-label="`${question.code} 教师评分`" /></div><div class="teacher-comment"><label>教师评语</label><el-input v-model="teacherComments[question.code]" maxlength="1000" placeholder="可选" :disabled="!questionnaire.canReview" :aria-label="`${question.code} 教师评语`" /></div></div>
            <div v-if="isTeacher" class="answer-reference"><strong>标准答案</strong><code>{{ formatAnswer(question.correctAnswer ?? null) || '按评分规则或仿真指标判定' }}</code><p v-if="question.explanation">{{ question.explanation }}</p></div>
            <div v-if="responseFor(question.code)?.evidence.length" class="evidence-list"><strong>判定证据</strong><span v-for="evidence in responseFor(question.code)?.evidence ?? []" :key="`${question.code}-${evidence.detail}`"><CircleCheck />{{ evidence.detail }}</span></div>
          </article>
        </section>
        <section v-if="isTeacher" class="review-comment"><label>总体复核意见</label><el-input v-model="reviewComment" type="textarea" :rows="3" maxlength="2000" aria-label="总体复核意见" /></section>
        <footer class="questionnaire-footer"><el-button @click="emit('update:visible', false)">关闭</el-button><template v-if="!isTeacher && questionnaire.available && questionnaire.canEdit"><el-button @click="saveAnswers(false)" :loading="saving" aria-label="保存题库作答草稿">保存草稿</el-button><el-button type="primary" :icon="Check" :disabled="!questionnaire.canSubmit" :aria-label="questionnaire.canSubmit ? '提交题库作答' : `暂不能提交题库作答：${questionnaire.reason || '请完成提交条件'}`" @click="saveAnswers(true)" :loading="saving">提交作答</el-button></template><el-button v-if="isTeacher && questionnaire.canRegrade" type="warning" :icon="Refresh" @click="regrade" :loading="saving">重新判定仿真题</el-button><el-button v-if="isTeacher && questionnaire.canReview" type="primary" :icon="Check" @click="saveReview" :loading="saving">保存教师复核</el-button><span v-if="!isTeacher && questionnaire.reason" class="questionnaire-submit-hint">{{ questionnaire.reason }}</span></footer>
      </template>
      <div v-else-if="loading" class="questionnaire-empty"><Loading class="is-loading" /><strong>正在加载题库</strong><span>正在读取当前任务绑定的题库版本。</span></div>
      <div v-else class="questionnaire-empty"><Lock /><strong>{{ questionnaire?.reason ?? '题库数据加载失败' }}</strong><span>{{ questionnaire ? '教师发布题库后，该项目将在这里显示作答入口。' : '题库暂时无法加载，已保存内容不会被清除。' }}</span><el-button v-if="!questionnaire" type="primary" :icon="Refresh" @click="emit('retry')">重新加载</el-button></div>
    </div>
  </el-drawer>
</template>

<style scoped>
.questionnaire-panel { min-height: 100%; color: #24352d; }.eyebrow { color: #789087; font-size: 10px; font-weight: 800; letter-spacing: .08em; } h2, h3, p { margin: 0; } h2 { margin-top: 4px; font-size: 20px; } .questionnaire-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; border-bottom: 1px solid #e5eee8; padding-bottom: 16px; }.questionnaire-header p { margin-top: 6px; color: #84948c; font-size: 11px; }.questionnaire-score { display: grid; justify-items: end; grid-template-columns: auto auto; align-items: baseline; column-gap: 4px; color: #71847a; font-size: 10px; }.questionnaire-score strong { grid-row: span 2; color: #2e7653; font-size: 26px; }.questionnaire-score em { grid-column: 1 / -1; color: #6c7e75; font-style: normal; }.questionnaire-state { display: flex; align-items: center; gap: 7px; margin: 14px 0; border-left: 3px solid #75a688; padding: 9px 11px; background: #f1f8f4; color: #527263; font-size: 11px; }.questionnaire-state.submitted { border-color: #9aa9a1; background: #f6f8f7; color: #687a71; }.questionnaire-state svg { width: 15px; }.questionnaire-error { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 12px; border: 1px solid #e2bcb8; padding: 9px 11px; background: #fff8f7; color: #a04e46; font-size: 11px; }.questionnaire-error > strong { min-width: 0; overflow-wrap: anywhere; }.questionnaire-error-actions { display: flex; flex: 0 0 auto; gap: 4px; }.questionnaire-list { display: grid; gap: 13px; }.question-card { border: 1px solid #dce8e0; padding: 14px; background: #fbfdfc; }.question-card > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.question-card > header div { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.question-number { display: grid; place-items: center; width: 27px; height: 27px; background: #dceee3; color: #397255; font-size: 11px; font-weight: 800; }.question-card > header strong { color: #3e6654; font-size: 11px; }.question-card > header small { color: #94a29b; font-size: 10px; }.question-card h3 { margin: 14px 0 12px; color: #273930; font-size: 13px; line-height: 1.6; }.question-card .el-radio-group, .question-card .el-checkbox-group { display: grid; gap: 8px; }.judgment { padding: 3px 7px; font-size: 10px; font-weight: 700; }.judgment.correct { background: #e6f5eb; color: #347353; }.judgment.partial, .judgment.pending { background: #fff4df; color: #956a2d; }.judgment.incorrect, .judgment.unanswered { background: #fff0ef; color: #9f4d46; }.evidence-placeholder { display: flex; align-items: center; gap: 8px; padding: 10px; background: #f3f7f5; color: #667a70; font-size: 11px; }.evidence-placeholder svg { width: 16px; color: #6ea084; }.teacher-review-row { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 12px; margin-top: 13px; border-top: 1px solid #e7efea; padding-top: 12px; }.teacher-review-row > div { display: grid; gap: 5px; }.teacher-review-row label, .review-comment label { color: #718279; font-size: 10px; font-weight: 700; }.teacher-comment :deep(.el-input) { width: 100%; }.answer-reference, .evidence-list { display: grid; gap: 6px; margin-top: 12px; border-top: 1px solid #e7efea; padding-top: 10px; }.answer-reference strong, .evidence-list strong { color: #64776d; font-size: 10px; }.answer-reference code { white-space: pre-wrap; color: #3d624f; font-family: Consolas, monospace; font-size: 10px; }.answer-reference p { color: #74867d; font-size: 10px; line-height: 1.5; }.evidence-list span { display: flex; align-items: flex-start; gap: 5px; color: #62766c; font-size: 10px; line-height: 1.5; }.evidence-list svg { flex: 0 0 auto; width: 13px; color: #6b9b80; }.review-comment { display: grid; gap: 6px; margin-top: 16px; }.questionnaire-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; border-top: 1px solid #e4ede8; padding-top: 14px; }.questionnaire-empty { display: grid; place-items: center; gap: 9px; min-height: 360px; color: #778b81; text-align: center; }.questionnaire-empty svg { width: 30px; height: 30px; color: #a5b9ae; }.questionnaire-empty strong { color: #50675b; font-size: 13px; }.questionnaire-empty span { font-size: 11px; }
 .structured-answer-fields { display: grid; gap: 8px; border: 1px solid #dce8e0; padding: 10px; background: #f5faf7; }.structured-answer-fields p { color: #63786d; font-size: 10px; line-height: 1.5; }.structured-answer-fields label { display: grid; gap: 4px; }.structured-answer-fields label span { color: #60756a; font-size: 10px; font-weight: 700; }.questionnaire-submit-hint { margin-left: auto; color: #9a6b2c; font-size: 10px; line-height: 1.4; overflow-wrap: anywhere; }
.questionnaire-score button { grid-column: 1 / -1; border: 0; padding: 3px 0 0; color: #8f6127; background: transparent; font-size: 10px; cursor: pointer; }.questionnaire-score button:hover,.questionnaire-score button:focus-visible { color: #694313; text-decoration: underline; }.question-card.unanswered { border-left: 3px solid #c18a42; }
@media (max-width: 560px) { .questionnaire-header { display: grid; }.questionnaire-score { justify-items: start; }.teacher-review-row { grid-template-columns: 1fr; }.questionnaire-error { flex-wrap: wrap; }.questionnaire-error-actions { width: 100%; justify-content: flex-end; }.questionnaire-footer { flex-wrap: wrap; }.questionnaire-footer .el-button { flex: 1; min-width: 100px; }.questionnaire-submit-hint { flex-basis: 100%; margin-left: 0; } }
.questionnaire-scoring-guide { display: flex; flex-wrap: wrap; gap: 6px; }
.questionnaire-scoring-guide span { border: 1px solid #d8e8dd; padding: 3px 6px; background: #f2f8f4; color: #527263; font-size: 10px; }
.questionnaire-scoring-guide span:last-child { border-color: #e4d8bb; background: #fff8e9; color: #8b6b35; }
</style>
