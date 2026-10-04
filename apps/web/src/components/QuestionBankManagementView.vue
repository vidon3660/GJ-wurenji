<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { Check, CircleCheck, DocumentAdd, FolderDelete, Plus, Refresh, Search, Upload, WarningFilled } from "@element-plus/icons-vue"
import type {
  QuestionAnswer,
  QuestionBankCreateInput,
  QuestionBankDetail,
  QuestionBankAuditResult,
  QuestionBankSummary,
  QuestionBankVersionArchiveResult,
  QuestionBankCleanupPreview,
  QuestionBankCleanupBatchResult,
  QuestionBankVersionDetail,
  QuestionBankVersionInput,
  QuestionDefinitionInput,
  QuestionDifficulty,
  QuestionGradingRule,
  QuestionOption,
  QuestionType,
  SceneType
} from "@wurenji/shared"
import { questionDifficulties, questionTypes } from "@wurenji/shared"
import { api } from "../api"
import { questionBankStageOptions } from "../question-bank-stage-options"

interface QuestionEditor {
  code: string
  type: QuestionType
  difficulty: QuestionDifficulty
  knowledgePointsText: string
  prompt: string
  optionsText: string
  correctAnswerText: string
  explanation: string
  maxScore: number
  stageCode: string
  ruleKind: QuestionGradingRule["kind"]
  requiredFieldsText: string
  metricCode: string
  metricOperator: "GTE" | "LTE" | "EQ"
  threshold: number
}

const emit = defineEmits<{ published: [bankId: string] }>()

const banks = ref<QuestionBankSummary[]>([])
const selectedBank = ref<QuestionBankDetail | null>(null)
const selectedBankId = ref("")
const selectedVersionId = ref("")
const editors = ref<QuestionEditor[]>([])
const loading = ref(false)
const saving = ref(false)
const detailError = ref("")
const showCreate = ref(false)
const createForm = ref({ title: "", sceneType: null as SceneType | null, summary: "" })
const versionNote = ref("")
const errorText = ref("")
const searchText = ref("")
const sceneFilter = ref<SceneType | "">("")
const questionTypeFilter = ref<QuestionType | "">("")
const difficultyFilter = ref<QuestionDifficulty | "">("")
const knowledgePointFilter = ref("")
const usageFilter = ref<"USED" | "UNUSED" | "">("")
const savedEditorSnapshot = ref("")
const showAudit = ref(false)
const auditLoading = ref(false)
const auditError = ref("")
const audit = ref<QuestionBankAuditResult | null>(null)
const auditScope = ref<"ISSUES" | "ALL" | "ARCHIVED">("ISSUES")
const archivingVersionId = ref("")
const cleanupPreview = ref<QuestionBankCleanupPreview | null>(null)
const cleanupPreviewLoading = ref(false)
const selectedCleanupVersionIds = ref<string[]>([])
const cleanupBatchLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let bankLoadSequence = 0

const selectedVersion = computed(() => selectedBank.value?.versions.find((version) => version.id === selectedVersionId.value) ?? null)
const isPublished = computed(() => selectedVersion.value?.status === "PUBLISHED")
const sceneOptions: Array<{ value: SceneType | null; label: string }> = [
  { value: null, label: "通用场景任务" },
  { value: "CITY_SHOW", label: "城市编队表演" },
  { value: "CITY_LOGISTICS", label: "城市低空物流" },
  { value: "VTOL_INSPECTION", label: "垂起广域巡检" }
]
const sceneFilterOptions: Array<{ value: SceneType | ""; label: string }> = [
  { value: "", label: "全部场景" },
  { value: "CITY_SHOW", label: "城市编队表演" },
  { value: "CITY_LOGISTICS", label: "城市低空物流" },
  { value: "VTOL_INSPECTION", label: "垂起广域巡检" }
]

const hasBankFilters = computed(() => Boolean(searchText.value.trim() || sceneFilter.value || questionTypeFilter.value || difficultyFilter.value || knowledgePointFilter.value.trim() || usageFilter.value))
const hasUnsavedChanges = computed(() => Boolean(selectedBank.value) && savedEditorSnapshot.value.length > 0 && (serializeEditors() !== savedEditorSnapshot.value || versionNote.value.trim().length > 0))
const visibleAuditVersions = computed(() => audit.value?.versions.filter((item) => {
  if (auditScope.value === "ARCHIVED") return item.status === "ARCHIVED"
  if (item.status === "ARCHIVED") return false
  return auditScope.value === "ALL" || !item.valid
}) ?? [])

onMounted(() => { void loadBanks() })

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

watch([searchText, sceneFilter, questionTypeFilter, difficultyFilter, knowledgePointFilter, usageFilter], () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { void loadBanks() }, searchText.value.trim() || knowledgePointFilter.value.trim() ? 250 : 0)
})

async function loadBanks(selectId = selectedBankId.value) {
  const loadSequence = ++bankLoadSequence
  loading.value = true
  errorText.value = ""
  try {
    const query = new URLSearchParams()
    if (sceneFilter.value) query.set("sceneType", sceneFilter.value)
    if (searchText.value.trim()) query.set("search", searchText.value.trim())
    if (questionTypeFilter.value) query.set("questionType", questionTypeFilter.value)
    if (difficultyFilter.value) query.set("difficulty", difficultyFilter.value)
    if (knowledgePointFilter.value.trim()) query.set("knowledgePoint", knowledgePointFilter.value.trim())
    if (usageFilter.value) query.set("usage", usageFilter.value)
    const queryString = query.toString()
    const result = await api<QuestionBankSummary[]>(`/v1/education/question-banks${queryString ? `?${queryString}` : ""}`)
    if (loadSequence !== bankLoadSequence) return
    banks.value = result
    const targetId = selectId && banks.value.some((bank) => bank.id === selectId) ? selectId : banks.value[0]?.id ?? ""
    if (targetId && (targetId !== selectedBankId.value || !selectedBank.value)) await selectBank(targetId, loadSequence)
    else if (!targetId) {
      selectedBankId.value = ""
      selectedBank.value = null
      editors.value = []
    }
  } catch (error) {
    if (loadSequence !== bankLoadSequence) return
    errorText.value = error instanceof Error ? error.message : "场景任务加载失败"
  } finally {
    if (loadSequence === bankLoadSequence) loading.value = false
  }
}

async function loadAudit() {
  auditLoading.value = true
  auditError.value = ""
  try {
    audit.value = await api<QuestionBankAuditResult>("/v1/education/question-banks/audit")
  } catch (error) {
    auditError.value = error instanceof Error ? error.message : "任务版本检查加载失败"
  } finally {
    auditLoading.value = false
  }
}

async function loadCleanupPreview() {
  cleanupPreviewLoading.value = true
  try {
    cleanupPreview.value = await api<QuestionBankCleanupPreview>("/v1/education/question-banks/cleanup-preview")
    const allowed = new Set(cleanupPreview.value.banks.flatMap((bank) => bank.versions.filter((version) => version.action === "ARCHIVE").map((version) => version.versionId)))
    selectedCleanupVersionIds.value = selectedCleanupVersionIds.value.filter((id) => allowed.has(id))
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "批量治理预览加载失败")
  } finally {
    cleanupPreviewLoading.value = false
  }
}

async function archiveSelectedEmptyDrafts() {
  if (!selectedCleanupVersionIds.value.length) return
  try {
    await ElMessageBox.confirm(`将归档 ${selectedCleanupVersionIds.value.length} 个已确认安全的空草稿。操作记录可查且不会删除数据，是否继续？`, "批量归档确认", { type: "warning", confirmButtonText: "确认归档", cancelButtonText: "取消" })
    cleanupBatchLoading.value = true
    const result = await api<QuestionBankCleanupBatchResult>("/v1/education/question-banks/cleanup", { method: "POST", body: JSON.stringify({ versionIds: selectedCleanupVersionIds.value }) })
    selectedCleanupVersionIds.value = []
    ElMessage.success(`已归档 ${result.archivedVersionCount} 个空草稿`)
    await Promise.all([loadAudit(), loadCleanupPreview(), loadBanks(selectedBankId.value)])
  } catch (error) {
    if (error === "cancel" || error === "close") return
    ElMessage.error(error instanceof Error ? error.message : "批量归档失败，未完成操作")
  } finally {
    cleanupBatchLoading.value = false
  }
}

async function openAudit() {
  auditScope.value = "ISSUES"
  showAudit.value = true
  await Promise.all([loadAudit(), loadCleanupPreview()])
}

async function openAuditVersion(item: QuestionBankAuditResult["versions"][number]) {
  if (item.status === "ARCHIVED") return
  showAudit.value = false
  await selectBank(item.bankId)
  if (selectedBank.value?.versions.some((version) => version.id === item.versionId)) await selectVersion(item.versionId)
}

async function archiveEmptyDraft(item: QuestionBankAuditResult["versions"][number]) {
  if (item.issueCategory !== "EMPTY_DRAFT" || item.status !== "DRAFT") return
  try {
    await ElMessageBox.confirm(
      `归档“${item.bankTitle}”V${item.version} 后，该空草稿会从工作区和待处理列表移出，但版本检查记录仍会保留。此操作不会删除数据。`,
      "归档空草稿",
      { type: "warning", confirmButtonText: "确认归档", cancelButtonText: "取消" }
    )
    archivingVersionId.value = item.versionId
    const result = await api<QuestionBankVersionArchiveResult>(`/v1/education/question-banks/${item.bankId}/versions/${item.versionId}/archive`, { method: "POST" })
    ElMessage.success(result.bankArchived ? "空草稿已归档，场景任务已从工作区移出" : "空草稿已归档，已恢复到最近可用版本")
    await Promise.all([loadAudit(), loadBanks(selectedBankId.value)])
  } catch (error) {
    if (error === "cancel" || error === "close") return
    ElMessage.error(error instanceof Error ? error.message : "空草稿归档失败")
  } finally {
    archivingVersionId.value = ""
  }
}

function auditIssueLabel(category: QuestionBankAuditResult["versions"][number]["issueCategory"]) {
  if (category === "EMPTY_DRAFT") return "空草稿"
  if (category === "INVALID_CONTENT") return "内容不可执行"
  return "通过"
}

function auditVersionStatusLabel(item: QuestionBankAuditResult["versions"][number]) {
  if (item.status === "ARCHIVED") return "已归档"
  return item.status === "PUBLISHED" ? "已发布" : "草稿"
}

function auditStatusClass(item: QuestionBankAuditResult["versions"][number]) {
  return item.valid ? "audit-good" : "audit-bad"
}

function clearBankFilters() {
  searchText.value = ""
  sceneFilter.value = ""
  questionTypeFilter.value = ""
  difficultyFilter.value = ""
  knowledgePointFilter.value = ""
  usageFilter.value = ""
}

async function selectBank(id: string, expectedLoadSequence = bankLoadSequence) {
  if (id === selectedBankId.value && selectedBank.value) return
  if (!await confirmDiscardChanges()) return
  const previousBankId = selectedBankId.value
  selectedBankId.value = id
  detailError.value = ""
  loading.value = true
  try {
    const detail = await api<QuestionBankDetail>(`/v1/education/question-banks/${id}`)
    if (expectedLoadSequence !== bankLoadSequence) return
    selectedBank.value = detail
    selectedVersionId.value = detail.currentVersionId ?? detail.versions[0]?.id ?? ""
    syncEditors(detail.questions)
  } catch (error) {
    selectedBankId.value = previousBankId
    detailError.value = error instanceof Error ? error.message : "场景任务详情加载失败"
    ElMessage.error(detailError.value)
  } finally {
    loading.value = false
  }
}

function syncEditors(questions: QuestionBankDetail["questions"]) {
  editors.value = questions.map((question) => ({
    code: question.code,
    type: question.type,
    difficulty: question.difficulty,
    knowledgePointsText: question.knowledgePoints.join("，"),
    prompt: question.prompt,
    optionsText: question.options.map((option) => `${option.key}|${option.label}`).join("\n"),
    correctAnswerText: formatAnswer(question.correctAnswer ?? null),
    explanation: question.explanation ?? "",
    maxScore: question.maxScore,
    stageCode: question.stageCode ?? "",
    ruleKind: question.gradingRule?.kind ?? "EXACT",
    requiredFieldsText: question.gradingRule?.kind === "REQUIRED_FIELDS" ? question.gradingRule.fields.join(", ") : "",
    metricCode: question.gradingRule?.kind === "METRIC_THRESHOLD" ? question.gradingRule.metricCode : "",
    metricOperator: question.gradingRule?.kind === "METRIC_THRESHOLD" ? question.gradingRule.operator : "GTE",
    threshold: question.gradingRule?.kind === "METRIC_THRESHOLD" ? question.gradingRule.threshold : 0
  }))
  savedEditorSnapshot.value = serializeEditors()
  versionNote.value = ""
}

async function confirmDiscardChanges(): Promise<boolean> {
  if (!hasUnsavedChanges.value) return true
  try {
    await ElMessageBox.confirm("当前版本有未保存的任务项或版本说明，切换后这些内容会丢失。确定继续吗？", "放弃未保存内容", {
      type: "warning",
      confirmButtonText: "继续切换",
      cancelButtonText: "留在当前版本"
    })
    return true
  } catch {
    return false
  }
}

function serializeEditors() {
  return JSON.stringify(editors.value)
}

function addQuestion() {
  editors.value.push({ code: `QUESTION-${String(editors.value.length + 1).padStart(2, "0")}`, type: "SINGLE_CHOICE", difficulty: "BEGINNER", knowledgePointsText: "", prompt: "", optionsText: "A|选项 A\nB|选项 B", correctAnswerText: "A", explanation: "", maxScore: 10, stageCode: "", ruleKind: "EXACT", requiredFieldsText: "", metricCode: "", metricOperator: "GTE", threshold: 0 })
}

function removeQuestion(index: number) {
  editors.value.splice(index, 1)
}

async function selectVersion(versionId: string) {
  const version = selectedBank.value?.versions.find((item) => item.id === versionId)
  if (!version || !selectedBank.value) return
  const previousVersionId = selectedVersionId.value
  if (!await confirmDiscardChanges()) {
    selectedVersionId.value = previousVersionId
    return
  }
  selectedVersionId.value = versionId
  detailError.value = ""
  loading.value = true
  try {
    const detail = await api<QuestionBankVersionDetail>(`/v1/education/question-banks/${selectedBank.value.id}/versions/${versionId}`)
    if (selectedVersionId.value === versionId) syncEditors(detail.questions)
    if (version.status === "PUBLISHED") ElMessage.info("已切换到已发布版本，发布版本不可直接修改")
  } catch (error) {
    selectedVersionId.value = previousVersionId
    detailError.value = error instanceof Error ? error.message : "场景任务版本加载失败"
    ElMessage.error(detailError.value)
  } finally {
    loading.value = false
  }
}

async function createBank() {
  if (saving.value) return
  if (!createForm.value.title.trim() || !createForm.value.summary.trim()) {
    ElMessage.warning("请填写场景任务名称和说明")
    return
  }
  saving.value = true
  try {
    const body: QuestionBankCreateInput = { title: createForm.value.title, summary: createForm.value.summary, sceneType: createForm.value.sceneType, questions: [] }
    const detail = await api<QuestionBankDetail>("/v1/education/question-banks", { method: "POST", body: JSON.stringify(body) })
    showCreate.value = false
    createForm.value = { title: "", sceneType: null, summary: "" }
    await loadBanks(detail.id)
    ElMessage.success("场景任务已创建，请继续配置当前版本")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "场景任务创建失败")
  } finally {
    saving.value = false
  }
}

async function saveVersion() {
  if (!selectedBank.value || saving.value) return
  saving.value = true
  try {
    const questions = editors.value.map(toQuestionInput)
    const body: QuestionBankVersionInput = { questions, changeNote: versionNote.value.trim() || "更新任务项内容" }
    const detail = await api<QuestionBankDetail>(`/v1/education/question-banks/${selectedBank.value.id}/versions`, { method: "POST", body: JSON.stringify(body) })
    versionNote.value = ""
    selectedBank.value = detail
    selectedBankId.value = detail.id
    selectedVersionId.value = detail.currentVersionId ?? ""
    syncEditors(detail.questions)
    await loadBanks(detail.id)
    ElMessage.success("新场景任务版本已保存")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "场景任务版本保存失败")
  } finally {
    saving.value = false
  }
}

async function publishVersion() {
  if (!selectedBank.value || !selectedVersionId.value || saving.value) return
  saving.value = true
  try {
    await ElMessageBox.confirm("发布后该版本将不可直接修改，学生任务会绑定此版本。确定发布吗？", "发布场景任务版本", { type: "warning", confirmButtonText: "发布", cancelButtonText: "取消" })
    const detail = await api<QuestionBankDetail>(`/v1/education/question-banks/${selectedBank.value.id}/versions/${selectedVersionId.value}/publish`, { method: "POST" })
    selectedBank.value = detail
    selectedVersionId.value = detail.currentVersionId ?? selectedVersionId.value
    syncEditors(detail.questions)
    await loadBanks(detail.id)
    ElMessage.success("场景任务版本已发布")
    emit("published", detail.id)
  } catch (error) {
    if (error === "cancel" || error === "close") return
    ElMessage.error(error instanceof Error ? error.message : "场景任务发布失败")
  } finally {
    saving.value = false
  }
}

function toQuestionInput(editor: QuestionEditor, index: number): QuestionDefinitionInput {
  const options = editor.optionsText.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf("|")
    if (separator < 1) throw new Error(`第 ${index + 1} 项任务选项格式应为“编号|内容”`)
    return { key: line.slice(0, separator).trim(), label: line.slice(separator + 1).trim() } satisfies QuestionOption
  })
  const correctAnswer = parseAnswer(editor.correctAnswerText, index)
  if (editor.type === "SIMULATION_EVIDENCE" && editor.ruleKind !== "METRIC_THRESHOLD") {
    throw new Error(`第 ${index + 1} 项仿真指标必须选择“仿真指标阈值”评分规则`)
  }
  if ((editor.type === "PLANNING" || editor.type === "SCHEDULE" || editor.type === "SCENARIO_DECISION") && editor.ruleKind === "EXACT" && correctAnswer === null) {
    throw new Error(`第 ${index + 1} 道结构化题请配置“必填字段”评分规则，或填写结构化判定参数`)
  }
  let gradingRule: QuestionGradingRule = { kind: "EXACT" }
  if (editor.ruleKind === "REQUIRED_FIELDS") gradingRule = { kind: "REQUIRED_FIELDS", fields: editor.requiredFieldsText.split(",").map((field) => field.trim()).filter(Boolean) }
  if (editor.ruleKind === "METRIC_THRESHOLD") gradingRule = { kind: "METRIC_THRESHOLD", metricCode: editor.metricCode.trim(), operator: editor.metricOperator, threshold: Number(editor.threshold) }
  const explanation = editor.explanation.trim()
  return { code: editor.code, type: editor.type, difficulty: editor.difficulty, knowledgePoints: editor.knowledgePointsText.split(/[，,]/).map((item) => item.trim()).filter(Boolean), prompt: editor.prompt, options, correctAnswer, ...(explanation ? { explanation } : {}), maxScore: Number(editor.maxScore), stageCode: editor.stageCode.trim() || null, gradingRule, sortOrder: index + 1 }
}

function parseAnswer(value: string, index: number): QuestionAnswer {
  const input = value.trim()
  if (!input) return null
  if (input === "true" || input === "false") return input === "true"
  if (input.startsWith("[") || input.startsWith("{")) {
    try { return JSON.parse(input) as QuestionAnswer } catch { throw new Error(`第 ${index + 1} 项任务判定参数 JSON 格式无效`) }
  }
  return input
}

function formatAnswer(value: QuestionAnswer): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  return value === null ? "" : JSON.stringify(value)
}

function sceneLabel(sceneType: SceneType | null) {
  return sceneOptions.find((item) => item.value === sceneType)?.label ?? "通用场景任务"
}

function questionTypeLabel(type: QuestionType) {
  return ({ SINGLE_CHOICE: "方案选项", MULTIPLE_CHOICE: "方案多选", TRUE_FALSE: "条件判断", PLANNING: "航线规划", SCHEDULE: "运行时序", SCENARIO_DECISION: "场景决策", SIMULATION_EVIDENCE: "仿真结果" } as Record<QuestionType, string>)[type]
}

function difficultyLabel(value: QuestionDifficulty) {
  return ({ BEGINNER: "基础", INTERMEDIATE: "进阶", ADVANCED: "高级" } as Record<QuestionDifficulty, string>)[value]
}

function stageOptionsFor(stageCode: string) {
  return questionBankStageOptions(selectedBank.value?.sceneType ?? null, stageCode)
}
</script>

<template>
  <div class="question-bank-page" v-loading="loading">
    <header class="question-bank-page-header">
      <div><span class="eyebrow">SCENARIO TASKS</span><h1>场景任务库</h1><p>配置场景需求、方案任务项和仿真指标规则。</p></div>
      <div class="question-bank-actions"><el-button :icon="Refresh" @click="loadBanks()">刷新</el-button><el-button :icon="WarningFilled" @click="openAudit">版本检查</el-button><el-button type="primary" :icon="Plus" @click="showCreate = true">新建场景任务</el-button></div>
    </header>
    <div v-if="errorText" class="question-bank-error" role="alert"><strong>{{ errorText }}</strong><el-button native-type="button" text @click="loadBanks">重新加载</el-button></div>
    <div class="question-bank-layout">
      <aside class="question-bank-list">
        <header><strong>我的场景任务</strong><span>{{ banks.length }}</span></header>
        <div class="question-bank-filters">
          <el-input v-model="searchText" clearable :prefix-icon="Search" aria-label="搜索场景任务名称或说明" placeholder="搜索场景任务名称或说明" />
          <el-select v-model="sceneFilter" clearable aria-label="按适用场景筛选场景任务" placeholder="全部场景">
            <el-option v-for="item in sceneFilterOptions" :key="item.value || 'ALL'" :label="item.label" :value="item.value" />
          </el-select>
          <el-select v-model="questionTypeFilter" clearable aria-label="按任务项类型筛选场景任务" placeholder="全部任务项类型">
            <el-option v-for="type in questionTypes" :key="type" :label="questionTypeLabel(type)" :value="type" />
          </el-select>
          <el-select v-model="difficultyFilter" clearable aria-label="按难度筛选场景任务" placeholder="全部难度">
            <el-option v-for="difficulty in questionDifficulties" :key="difficulty" :label="difficultyLabel(difficulty)" :value="difficulty" />
          </el-select>
          <el-input v-model="knowledgePointFilter" clearable aria-label="按知识点筛选场景任务" placeholder="筛选知识点" />
          <el-select v-model="usageFilter" clearable aria-label="按任务使用状态筛选场景任务" placeholder="全部使用状态">
            <el-option label="已用于任务" value="USED" />
            <el-option label="尚未使用" value="UNUSED" />
          </el-select>
        </div>
        <button v-for="bank in banks" :key="bank.id" type="button" :class="{ active: bank.id === selectedBankId }" :aria-pressed="bank.id === selectedBankId" :aria-label="`${bank.title}，${sceneLabel(bank.sceneType)}，${bank.questionCount} 题${bank.id === selectedBankId ? '，已选中' : ''}`" @click="selectBank(bank.id)">
          <span class="bank-list-mark">{{ bank.title.slice(0, 1) }}</span><div><strong>{{ bank.title }}</strong><small>{{ sceneLabel(bank.sceneType) }} · V{{ bank.currentVersion }} · {{ bank.questionCount }} 题 · 已用于 {{ bank.usageCount }} 个任务</small></div>
        </button>
        <div v-if="!banks.length && !errorText" class="question-bank-empty" role="status" aria-live="polite"><DocumentAdd /><strong>{{ hasBankFilters ? '没有匹配场景任务' : '还没有场景任务' }}</strong><span>{{ hasBankFilters ? '换一个关键词或场景筛选条件试试' : '创建场景任务并配置任务项' }}</span><el-button v-if="hasBankFilters" text @click="clearBankFilters">清除筛选</el-button></div>
      </aside>
      <main v-if="selectedBank" class="question-bank-editor">
        <div v-if="detailError" class="question-bank-detail-error" role="alert" aria-live="assertive"><span><strong>场景任务详情同步失败</strong><small>{{ detailError }}</small><p>当前已保留上一次可用的任务项内容，保存或发布前请重新加载详情。</p></span><el-button type="warning" :icon="Refresh" :loading="loading" @click="selectBank(selectedBankId)">重试详情</el-button></div>
        <header class="editor-header"><div><span class="eyebrow">{{ sceneLabel(selectedBank.sceneType) }}</span><h2>{{ selectedBank.title }}</h2><p>{{ selectedBank.summary }}</p></div><div class="editor-status"><span :class="isPublished ? 'status-published' : 'status-draft'">{{ isPublished ? '已发布版本' : '草稿版本' }}</span><strong>{{ editors.length }} 题</strong></div></header>
        <section class="version-toolbar"><label>编辑版本<select v-model="selectedVersionId" aria-label="选择场景任务编辑版本" @change="selectVersion(selectedVersionId)"><option v-for="version in selectedBank.versions" :key="version.id" :value="version.id">V{{ version.version }} · {{ version.status === 'PUBLISHED' ? '已发布' : '草稿' }} · {{ version.questionCount }} 项</option></select></label><small v-if="selectedVersion">{{ selectedVersion.changeNote || '暂无版本说明' }}</small></section>
        <div v-if="isPublished" class="editor-notice" role="status" aria-live="polite"><Check /><span>已发布版本不可直接修改。如需调整，请先创建新版本。</span></div>
        <section class="question-list">
          <article v-for="(question, index) in editors" :key="`${question.code}-${index}`" class="question-editor-card">
            <header><div><span>任务项 {{ String(index + 1).padStart(2, '0') }}</span><strong>{{ questionTypeLabel(question.type) }}</strong></div><el-button v-if="!isPublished" native-type="button" text type="danger" :aria-label="`删除第 ${index + 1} 项任务`" @click="removeQuestion(index)">删除</el-button></header>
            <div class="question-editor-grid"><el-form-item label="任务项编号"><el-input v-model="question.code" :disabled="isPublished" /></el-form-item><el-form-item label="任务项类型"><el-select v-model="question.type" :disabled="isPublished"><el-option v-for="type in questionTypes" :key="type" :label="questionTypeLabel(type)" :value="type" /></el-select></el-form-item><el-form-item label="难度"><el-select v-model="question.difficulty" :disabled="isPublished"><el-option v-for="difficulty in questionDifficulties" :key="difficulty" :label="difficultyLabel(difficulty)" :value="difficulty" /></el-select></el-form-item><el-form-item label="知识点"><el-input v-model="question.knowledgePointsText" placeholder="飞行安全，时刻规划" :disabled="isPublished" /></el-form-item><el-form-item label="分值"><el-input-number v-model="question.maxScore" :min="0.1" :max="1000" :precision="2" :disabled="isPublished" /></el-form-item><el-form-item label="所属阶段"><el-select v-model="question.stageCode" clearable placeholder="通用 / 不指定阶段" :disabled="isPublished"><el-option v-for="stage in stageOptionsFor(question.stageCode)" :key="stage.value || 'GENERAL'" :label="stage.label" :value="stage.value" /></el-select></el-form-item></div>
            <el-form-item label="任务要求"><el-input v-model="question.prompt" type="textarea" :rows="2" :disabled="isPublished" /></el-form-item>
            <div class="question-editor-grid"><el-form-item label="选项"><el-input v-model="question.optionsText" type="textarea" :rows="3" placeholder="每行一个，格式：A|选项内容" :disabled="isPublished" /></el-form-item><el-form-item label="判定参数"><el-input v-model="question.correctAnswerText" type="textarea" :rows="3" placeholder="指标阈值由评分规则计算；结构化参数使用 JSON" :disabled="isPublished" /></el-form-item></div>
            <div class="question-editor-grid"><el-form-item label="评分规则"><el-select v-model="question.ruleKind" :disabled="isPublished"><el-option label="精确匹配" value="EXACT" /><el-option label="必填字段" value="REQUIRED_FIELDS" /><el-option label="仿真指标阈值" value="METRIC_THRESHOLD" /></el-select></el-form-item><el-form-item label="解析"><el-input v-model="question.explanation" :disabled="isPublished" /></el-form-item></div>
            <div v-if="question.ruleKind === 'REQUIRED_FIELDS'" class="rule-row"><el-form-item label="必填字段"><el-input v-model="question.requiredFieldsText" placeholder="用逗号分隔，如 routePlan,safetyCheck" :disabled="isPublished" /></el-form-item></div>
            <div v-if="question.ruleKind === 'METRIC_THRESHOLD'" class="rule-row"><el-form-item label="指标代码"><el-input v-model="question.metricCode" placeholder="如 ON_TIME_DELIVERY" :disabled="isPublished" /></el-form-item><el-form-item label="比较"><el-select v-model="question.metricOperator" :disabled="isPublished"><el-option label=">=" value="GTE" /><el-option label="<=" value="LTE" /><el-option label="=" value="EQ" /></el-select></el-form-item><el-form-item label="阈值"><el-input-number v-model="question.threshold" :disabled="isPublished" /></el-form-item></div>
          </article>
        </section>
        <footer class="editor-footer" v-if="!isPublished"><el-button native-type="button" text :icon="Plus" @click="addQuestion">添加任务项</el-button><div><el-input v-model="versionNote" aria-label="新场景任务版本说明" placeholder="本次版本说明（可选）" /><el-button native-type="button" :icon="Upload" @click="saveVersion" :loading="saving">保存新版本</el-button><el-button native-type="button" type="primary" :icon="Check" @click="publishVersion" :loading="saving" :disabled="!selectedVersionId || editors.length === 0 || hasUnsavedChanges" :title="hasUnsavedChanges ? '请先保存修改，再发布当前版本' : '发布当前版本'">发布当前版本</el-button></div><small v-if="hasUnsavedChanges" class="editor-unsaved-hint" role="status" aria-live="polite">有未保存修改，请先保存新版本，再发布给学生。</small></footer>
        <footer v-else class="editor-footer"><el-button native-type="button" type="primary" :icon="Plus" @click="saveVersion">创建可编辑新版本</el-button></footer>
      </main>
      <main v-else class="question-bank-no-selection"><DocumentAdd /><h2>选择一个场景任务</h2><p>从左侧选择场景任务，或创建一套新的场景任务。</p><el-button type="primary" :icon="Plus" @click="showCreate = true">新建场景任务</el-button></main>
    </div>
    <el-dialog v-model="showAudit" title="任务版本检查" width="min(920px, calc(100vw - 32px))" class="question-bank-audit-dialog">
      <div v-loading="auditLoading" class="audit-content">
        <div v-if="auditError" class="question-bank-error" role="alert"><strong>{{ auditError }}</strong><el-button native-type="button" text @click="loadAudit">重新加载</el-button></div>
        <template v-if="audit">
          <div class="audit-summary" aria-label="任务版本检查汇总"><div><strong>{{ audit.summary.versionCount }}</strong><span>使用中版本</span></div><div class="audit-summary-good"><strong>{{ audit.summary.validVersionCount }}</strong><span>可执行</span></div><div class="audit-summary-bad"><strong>{{ audit.summary.invalidVersionCount }}</strong><span>待处理</span></div><div class="audit-summary-draft"><strong>{{ audit.summary.emptyDraftCount }}</strong><span>空草稿</span></div><div class="audit-summary-archived"><strong>{{ audit.summary.archivedVersionCount }}</strong><span>已归档</span></div></div>
          <section v-loading="cleanupPreviewLoading" class="cleanup-preview" aria-label="历史空草稿治理预览"><div><strong>历史空草稿治理预览</strong><small>先确认影响范围，再批量归档已确认安全的空草稿；不会删除数据</small></div><div class="cleanup-preview-stats"><span><b>{{ cleanupPreview?.summary.candidateCount ?? 0 }}</b>可归档</span><span><b>{{ cleanupPreview?.summary.blockedReferenceCount ?? 0 }}</b>被任务引用</span><span><b>{{ cleanupPreview?.summary.bankCount ?? 0 }}</b>个场景任务</span><el-button size="small" type="warning" :loading="cleanupBatchLoading" :disabled="!selectedCleanupVersionIds.length" @click="archiveSelectedEmptyDrafts">批量归档已选 {{ selectedCleanupVersionIds.length }}</el-button></div><div v-if="cleanupPreview?.banks.length" class="cleanup-preview-banks"><span v-for="bank in cleanupPreview.banks" :key="bank.bankId"><b>{{ bank.bankTitle }}</b><small>{{ bank.candidateCount }} 可归档 · {{ bank.blockedReferenceCount }} 项阻断</small><template v-for="version in bank.versions" :key="version.versionId"><label v-if="version.action === 'ARCHIVE'" class="cleanup-version-choice"><input v-model="selectedCleanupVersionIds" type="checkbox" :value="version.versionId" :aria-label="`${bank.bankTitle} V${version.version} 空草稿`">V{{ version.version }}</label></template></span></div><p v-else class="cleanup-preview-empty">当前没有可治理的空草稿。</p></section>
          <div class="audit-toolbar"><p class="audit-help">检查版本是否具备可判分内容。空草稿可安全归档，不会物理删除；已发布、有任务项或已被任务引用的版本不能归档。</p><el-radio-group v-model="auditScope" size="small" aria-label="任务版本检查范围"><el-radio-button value="ISSUES">待处理 {{ audit.summary.invalidVersionCount }}</el-radio-button><el-radio-button value="ALL">全部版本 {{ audit.summary.versionCount }}</el-radio-button><el-radio-button value="ARCHIVED">已归档 {{ audit.summary.archivedVersionCount }}</el-radio-button></el-radio-group></div>
          <div v-if="!audit.versions.length" class="question-bank-empty" role="status" aria-live="polite"><CircleCheck /><strong>暂无场景任务版本</strong><span>创建场景任务后可在这里检查版本是否可发布。</span></div>
          <div v-else-if="visibleAuditVersions.length" class="audit-table" role="table" aria-label="任务版本检查结果"><div class="audit-row audit-row-head" role="row"><span>场景任务 / 版本</span><span>任务项类型与数量</span><span>仿真指标</span><span>状态</span><span>问题</span><span>操作</span></div><div v-for="item in visibleAuditVersions" :key="item.versionId" class="audit-row" :class="[auditStatusClass(item), { 'audit-row-interactive': item.status !== 'ARCHIVED' }]" role="row" :tabindex="item.status === 'ARCHIVED' ? -1 : 0" @click="openAuditVersion(item)" @keydown.enter.self="openAuditVersion(item)" @keydown.space.self.prevent="openAuditVersion(item)"><span data-label="场景任务 / 版本"><strong>{{ item.bankTitle }}</strong><small>V{{ item.version }} · {{ auditVersionStatusLabel(item) }}</small></span><span data-label="任务项类型与数量">{{ item.questionCount }} 项 · {{ item.questionTypes.map(questionTypeLabel).join('、') || '未配置任务项' }}</span><span data-label="仿真指标">{{ item.metricCodes.join('、') || '无' }}</span><span data-label="状态"><CircleCheck v-if="item.valid" /><WarningFilled v-else /> {{ item.status === 'ARCHIVED' ? '已归档' : item.valid ? '可执行' : '待处理' }}</span><span data-label="问题">{{ item.status === 'ARCHIVED' ? '保留版本检查记录' : auditIssueLabel(item.issueCategory) }}<small v-for="issue in item.issues" :key="issue">{{ issue }}</small></span><span class="audit-row-action" data-label="操作"><el-button v-if="item.issueCategory === 'EMPTY_DRAFT' && item.status === 'DRAFT'" native-type="button" text type="warning" :icon="FolderDelete" :loading="archivingVersionId === item.versionId" @click.stop="archiveEmptyDraft(item)">归档</el-button><small v-else>{{ item.status === 'ARCHIVED' ? '只读' : '打开' }}</small></span></div></div>
          <div v-else class="audit-empty-filter" role="status"><CircleCheck /><strong>{{ auditScope === 'ARCHIVED' ? '暂无已归档版本' : auditScope === 'ALL' ? '暂无使用中版本' : '没有待处理版本' }}</strong><span>{{ auditScope === 'ARCHIVED' ? '归档的空草稿会保留在这里，便于查看版本记录。' : auditScope === 'ALL' ? '创建场景任务后可在这里查看版本明细。' : '当前所有使用中版本均具备可执行内容，可切换到“全部版本”查看明细。' }}</span></div>
        </template>
      </div>
      <template #footer><el-button :icon="Refresh" :loading="auditLoading" @click="loadAudit">刷新检查</el-button><el-button type="primary" @click="showAudit = false">关闭</el-button></template>
    </el-dialog>
    <el-dialog v-model="showCreate" title="新建场景任务" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><el-form-item label="场景任务名称"><el-input v-model="createForm.title" maxlength="160" show-word-limit /></el-form-item><el-form-item label="适用场景"><el-select v-model="createForm.sceneType" placeholder="可选"><el-option v-for="item in sceneOptions" :key="String(item.value)" :label="item.label" :value="item.value" /></el-select></el-form-item><el-form-item label="场景任务说明"><el-input v-model="createForm.summary" type="textarea" :rows="3" maxlength="2000" show-word-limit /></el-form-item></el-form><template #footer><el-button @click="showCreate = false">取消</el-button><el-button type="primary" :loading="saving" @click="createBank">创建</el-button></template></el-dialog>
  </div>
</template>

<style scoped>
.question-bank-page { min-height: 100%; padding: 30px 34px 46px; background: #f4f7f5; color: #1e2b26; }
.audit-content { min-height: 180px; }
.audit-summary { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-bottom: 14px; }
.audit-summary > div { display: grid; gap: 3px; padding: 12px; border: 1px solid #dce8e1; background: #f7faf8; }
.audit-summary strong { font-size: 22px; }
.audit-summary span { color: #6e8178; font-size: 11px; }
.audit-summary-good strong, .audit-good > span:nth-child(4) { color: #198754; }
.audit-summary-bad strong, .audit-bad > span:nth-child(4), .audit-summary-draft strong { color: #b54708; }
.audit-summary-archived strong { color: #66766e; }
.cleanup-preview { display: grid; gap: 10px; margin-bottom: 14px; padding: 12px; border: 1px solid #dce8e1; background: #fbfdfc; }
.cleanup-preview > div:first-child { display: grid; gap: 3px; }
.cleanup-preview strong { color: #315d49; font-size: 13px; }
.cleanup-preview small { color: #81938b; font-size: 10px; }
.cleanup-preview-stats { display: flex; flex-wrap: wrap; gap: 14px; color: #66766e; font-size: 11px; }
.cleanup-preview-stats b { margin-right: 3px; color: #b54708; font-size: 16px; }
.cleanup-preview-banks { display: flex; flex-wrap: wrap; gap: 8px; }
.cleanup-preview-banks span { display: grid; gap: 2px; min-width: 150px; padding: 8px; border: 1px solid #e4ece7; background: #fff; }
.cleanup-version-choice { display: flex; align-items: center; gap: 5px; margin-top: 5px; color: #315d49; font-size: 11px; }
.cleanup-version-choice input { accent-color: #24835a; }
.cleanup-preview-empty { margin: 0; color: #81938b; font-size: 11px; }
.audit-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px; }
.audit-help { margin: 0; color: #6e8178; font-size: 12px; line-height: 1.6; }
.audit-empty-filter { display: grid; place-items: center; gap: 8px; min-height: 180px; border: 1px solid #dce8e1; color: #71857c; text-align: center; }
.audit-empty-filter svg { width: 28px; color: #24835a; }
.audit-empty-filter strong { color: #315d49; font-size: 14px; }
.audit-empty-filter span { max-width: 420px; font-size: 11px; }
.audit-table { overflow: auto; border: 1px solid #dce8e1; }
.audit-row { display: grid; grid-template-columns: 1.35fr 1.25fr 1fr .75fr 1.5fr .55fr; align-items: start; width: 100%; gap: 10px; padding: 11px 12px; border: 0; border-bottom: 1px solid #edf2ef; background: #fff; color: #30443a; text-align: left; font: inherit; font-size: 12px; line-height: 1.45; }
.audit-row-interactive { cursor: pointer; }
.audit-row-interactive:hover, .audit-row-interactive:focus-visible { background: #f3f8f5; outline: 2px solid #71a88d; outline-offset: -2px; }
.audit-row:last-child { border-bottom: 0; }
.audit-row-head { background: #f7faf8; color: #74867e; font-size: 10px; font-weight: 800; }
.audit-row span { min-width: 0; }
.audit-row strong, .audit-row small { display: block; }
.audit-row small { color: #81938b; font-size: 10px; }
.audit-row > span:nth-child(4) { display: flex; align-items: center; gap: 4px; font-weight: 700; }
.audit-row > span:nth-child(4) svg { width: 14px; height: 14px; }
.audit-row-action { display: flex; justify-content: flex-end; }
.audit-row-action .el-button { min-height: 28px; padding-inline: 6px; }
.question-bank-page-header, .editor-header, .version-toolbar, .editor-footer, .question-bank-list header, .question-editor-card > header { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.question-bank-page-header { margin-bottom: 22px; }
.eyebrow { color: #6c8177; font-size: 10px; font-weight: 800; letter-spacing: .08em; }
h1, h2, p { margin: 0; }
h1 { margin-top: 4px; font-size: 26px; letter-spacing: 0; }
h2 { margin-top: 5px; font-size: 20px; letter-spacing: 0; }
.question-bank-page-header p, .editor-header p { margin-top: 7px; color: #6b7c74; font-size: 12px; }
.question-bank-actions { display: flex; gap: 8px; }
.question-bank-error { display: flex; align-items: center; justify-content: space-between; border: 1px solid #e2bcb8; padding: 12px 14px; margin-bottom: 14px; background: #fff8f7; color: #9c4942; }
.question-bank-layout { display: grid; grid-template-columns: 270px minmax(0, 1fr); gap: 16px; align-items: start; }
.question-bank-list, .question-bank-editor, .question-bank-no-selection { border: 1px solid #dce6e0; background: #fff; }
.question-bank-list { min-height: 580px; }
.question-bank-list header { padding: 15px 16px; border-bottom: 1px solid #e8efeb; color: #50645b; font-size: 12px; }
.question-bank-list header span { display: grid; place-items: center; min-width: 22px; height: 22px; background: #edf4ef; color: #527263; font-weight: 800; }
.question-bank-filters { display: grid; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #eef3f0; background: #fbfdfc; }
.question-bank-filters .el-select { width: 100%; }
.question-bank-list > button { display: flex; width: 100%; align-items: center; gap: 10px; padding: 13px 14px; border: 0; border-bottom: 1px solid #eef3f0; background: transparent; color: #24332d; text-align: left; cursor: pointer; }
.question-bank-list > button:hover, .question-bank-list > button.active { background: #eff7f2; }
.bank-list-mark { display: grid; place-items: center; flex: 0 0 30px; height: 30px; background: #dbece2; color: #3d6b56; font-weight: 800; }
.question-bank-list button div { display: grid; min-width: 0; gap: 4px; }
.question-bank-list button strong { overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.question-bank-list button small { color: #7a8d84; font-size: 10px; }
.question-bank-empty, .question-bank-no-selection { display: grid; place-items: center; gap: 9px; min-height: 400px; color: #789087; text-align: center; }
.question-bank-empty svg, .question-bank-no-selection svg { width: 32px; height: 32px; color: #97b5a4; }
.question-bank-empty strong, .question-bank-no-selection h2 { color: #496359; font-size: 14px; }
.question-bank-empty span, .question-bank-no-selection p { font-size: 11px; }
.question-bank-editor { min-width: 0; }
.editor-header { align-items: flex-start; padding: 20px 22px; border-bottom: 1px solid #e7eeea; }
.editor-status { display: grid; justify-items: end; gap: 10px; color: #597067; font-size: 12px; }
.status-published, .status-draft { padding: 4px 8px; font-size: 10px; font-weight: 800; }
.status-published { background: #e6f3eb; color: #327052; }.status-draft { background: #fff4df; color: #9a6c25; }
.version-toolbar { align-items: end; padding: 12px 22px; border-bottom: 1px solid #edf2ef; background: #fafcfb; }
.version-toolbar label { display: grid; gap: 5px; color: #64776e; font-size: 10px; font-weight: 700; }
.version-toolbar select { min-width: 230px; border: 1px solid #cfddd5; padding: 8px 10px; background: #fff; color: #2a3b33; }
.version-toolbar small { color: #82948c; font-size: 10px; }
.editor-notice { display: flex; align-items: center; gap: 8px; margin: 14px 22px 0; border-left: 3px solid #6ca482; padding: 9px 11px; background: #f1f8f4; color: #527263; font-size: 11px; }
.editor-notice svg { flex: 0 0 16px; width: 16px; height: 16px; }
.question-list { display: grid; gap: 12px; padding: 16px 22px; }
.question-editor-card { border: 1px solid #dbe7df; padding: 14px; background: #fbfdfc; }
.question-editor-card > header { margin-bottom: 13px; }
.question-editor-card > header div { display: flex; align-items: center; gap: 10px; }.question-editor-card > header span { color: #789087; font-size: 10px; }.question-editor-card > header strong { color: #305b48; font-size: 12px; }
.question-editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
.rule-row { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(100px, .6fr) 100px; gap: 14px; }
.editor-footer { position: relative; margin: 0 22px; border-top: 1px solid #e7eeea; padding: 16px 0 20px; }.editor-footer > div { display: flex; align-items: center; gap: 8px; }.editor-footer .el-input { width: 210px; }.editor-unsaved-hint { position: absolute; right: 0; bottom: 3px; color: #a46c1e; font-size: 10px; }
@media (max-width: 900px) { .question-bank-layout { grid-template-columns: 1fr; }.question-bank-list { min-height: 0; }.question-bank-list > button { display: inline-flex; width: calc(50% - 2px); vertical-align: top; }.question-bank-list { padding-bottom: 8px; }.question-bank-list header { margin-bottom: 4px; }.question-bank-page { padding: 20px 16px 32px; } }
@media (max-width: 620px) { .question-bank-page-header, .editor-header, .version-toolbar, .editor-footer { display: grid; }.question-bank-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }.question-bank-actions .el-button { width: 100%; margin-left: 0; }.question-bank-actions .el-button:last-child { grid-column: 1 / -1; }.editor-footer > div { width: 100%; grid-template-columns: 1fr; }.editor-footer .el-input { width: 100%; }.editor-unsaved-hint { position: static; }.question-editor-grid, .rule-row { grid-template-columns: 1fr; }.question-bank-list > button { width: 100%; }.version-toolbar select { min-width: 0; width: 100%; } }
@media (max-width: 700px) { .audit-summary { grid-template-columns: repeat(2, 1fr); }.audit-toolbar { align-items: stretch; flex-direction: column; }.audit-toolbar .el-radio-group { display: grid; grid-template-columns: repeat(3, 1fr); width: 100%; }.audit-toolbar .el-radio-button { min-width: 0; }.audit-toolbar :deep(.el-radio-button__inner) { width: 100%; padding-inline: 6px; }.audit-table { margin-inline: -1px; overflow: visible; border: 0; }.audit-row-head { display: none; }.audit-row { grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 0; gap: 9px 12px; margin-bottom: 8px; border: 1px solid #dce8e1; padding: 12px; }.audit-row > span { display: grid; min-width: 0; gap: 3px; align-content: start; }.audit-row > span::before { content: attr(data-label); color: #81938b; font-size: 10px; font-weight: 700; }.audit-row > span:nth-child(1), .audit-row > span:nth-child(5) { grid-column: 1 / -1; }.audit-row > span:nth-child(4) { align-items: flex-start; }.audit-row-action { align-items: flex-start; justify-content: flex-start; } }
@media (max-width: 380px) {
  .audit-row { grid-template-columns: 1fr; }
  .audit-row > span:nth-child(1), .audit-row > span:nth-child(5) { grid-column: auto; }
  .question-bank-page { padding-inline: 10px; }
  .question-bank-actions { grid-template-columns: 1fr; }
  .question-bank-actions .el-button,
  .question-bank-actions .el-button:last-child { grid-column: auto; width: 100%; }
  .audit-summary { grid-template-columns: 1fr 1fr; gap: 6px; }
  .audit-summary > div { padding: 9px; }
  .audit-summary strong { font-size: 19px; }
  .question-list { padding-inline: 12px; }
  .editor-header { padding-inline: 14px; }
  .version-toolbar { padding-inline: 14px; }
  .editor-footer { margin-inline: 14px; }
}
</style>
