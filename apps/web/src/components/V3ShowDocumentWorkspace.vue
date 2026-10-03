<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { Check, Clock, Document, Download, EditPen, Refresh, Upload, View, Warning } from "@element-plus/icons-vue"
import type {
  AuthUser,
  OnlyOfficeEditorConfigView,
  ShowProjectDocumentView,
  ShowDocumentWorkspaceView,
  StudentProjectStageView,
  StudentProjectView
} from "@wurenji/shared"
import { api, downloadApiFile } from "../api"
import { formatPlatformDate } from "../platform-date"
import { showDocumentAuditTimeline } from "../show-document-audit"
import { compareShowDocumentVersions, showDocumentSubmissionLabel } from "../show-document-version-comparison"
import V3OnlyOfficeEditor from "./V3OnlyOfficeEditor.vue"
import V3ShowDocumentReferencePanel from "./V3ShowDocumentReferencePanel.vue"

const props = defineProps<{
  user: AuthUser
  project: StudentProjectView
  stage: StudentProjectStageView
}>()
const emit = defineEmits<{ refreshProject: [] }>()

const loading = ref(false)
const workspaceLoading = ref(false)
const loadError = ref("")
const workspace = ref<ShowDocumentWorkspaceView | null>(null)
const selectedDocumentId = ref("")
const editorVisible = ref(false)
const editorConfig = ref<OnlyOfficeEditorConfigView | null>(null)
const comparisonEditorVisible = ref(false)
const comparisonEditorConfigs = ref<{ baseline: OnlyOfficeEditorConfigView; target: OnlyOfficeEditorConfigView } | null>(null)
const comparisonBaselineId = ref("")
const comparisonTargetId = ref("")
const reviewComment = ref("")
const reviewScore = ref<number | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
let workspaceRequest = 0
let workspaceAbortController: AbortController | undefined
let refreshTimer: number | undefined
let disposed = false

const selectedDocument = computed(() => workspace.value?.documents.find((item) => item.id === selectedDocumentId.value) ?? workspace.value?.documents[0] ?? null)
const isStudent = computed(() => props.user.role === "student")
const canEditSelected = computed(() => Boolean(workspace.value?.canEdit && selectedDocument.value && props.project.assessmentTiming.canWrite && !isSubmitted(selectedDocument.value.status)))
const teacherSubmittedCount = computed(() => workspace.value?.documents.filter((document) => document.currentAsset).length ?? 0)
const submittedDocumentCount = computed(() => workspace.value?.documents.filter((document) => isSubmitted(document.status)).length ?? 0)
const auditTimeline = computed(() => selectedDocument.value ? showDocumentAuditTimeline(selectedDocument.value) : [])
const versionComparison = computed(() => selectedDocument.value
  ? compareShowDocumentVersions(selectedDocument.value, comparisonBaselineId.value, comparisonTargetId.value)
  : null)
const returnButtonReason = computed(() => {
  if (!selectedDocument.value?.canReturn) return selectedDocument.value?.returnBlockedReason ?? "当前材料不能退回修改"
  if (!reviewComment.value.trim()) return "请先填写退回原因"
  return "退回当前提交版本"
})
const canSubmitReturn = computed(() => Boolean(selectedDocument.value?.canReturn && reviewComment.value.trim()))

onMounted(loadWorkspace)
onBeforeUnmount(() => {
  disposed = true
  workspaceRequest += 1
  workspaceAbortController?.abort()
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
})
watch(() => props.project.id, loadWorkspace)
watch(selectedDocument, (document) => {
  reviewComment.value = document?.reviewComment ?? ""
  reviewScore.value = document?.reviewScore ?? null
  synchronizeVersionComparison(document)
})

async function loadWorkspace() {
  if (disposed) return
  const requestId = ++workspaceRequest
  workspaceAbortController?.abort()
  const abortController = new AbortController()
  workspaceAbortController = abortController
  workspaceLoading.value = true
  loadError.value = ""
  try {
    const value = await api<ShowDocumentWorkspaceView>(`/v3/show-projects/${props.project.id}/documents`, { signal: abortController.signal })
    if (disposed || requestId !== workspaceRequest) return
    workspace.value = value
    if (!workspace.value.documents.some((document) => document.id === selectedDocumentId.value)) selectedDocumentId.value = workspace.value.documents[0]?.id ?? ""
  } catch (error) {
    if (disposed || requestId !== workspaceRequest || (error instanceof DOMException && error.name === "AbortError")) return
    loadError.value = error instanceof Error ? error.message : "飞行申报工作台加载失败"
    ElMessage.error(loadError.value)
  } finally {
    if (requestId === workspaceRequest) workspaceLoading.value = false
  }
}

async function openEditor() {
  if (!selectedDocument.value) return
  if (!workspace.value?.editorPublicUrl) {
    ElMessage.warning("在线文档服务当前未启动")
    return
  }
  loading.value = true
  try {
    editorConfig.value = await api<OnlyOfficeEditorConfigView>(`/v3/show-projects/${props.project.id}/documents/${selectedDocument.value.id}/editor-session`, { method: "POST" })
    editorVisible.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文档编辑会话创建失败")
  } finally {
    loading.value = false
  }
}

function closeEditor() {
  editorVisible.value = false
  editorConfig.value = null
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined
    if (!disposed) void loadWorkspace()
  }, 500)
}

function synchronizeVersionComparison(document: ShowProjectDocumentView | null) {
  const versions = document?.versions.filter((version) => version.kind === "SUBMISSION") ?? []
  const versionIds = new Set(versions.map((version) => version.id))
  if (versionIds.has(comparisonBaselineId.value) && versionIds.has(comparisonTargetId.value) && comparisonBaselineId.value !== comparisonTargetId.value) return
  comparisonTargetId.value = versions[0]?.id ?? ""
  comparisonBaselineId.value = versions[1]?.id ?? ""
}

async function openVersionComparison() {
  const document = selectedDocument.value
  const comparison = versionComparison.value
  if (!document || !comparison) return
  if (!workspace.value?.editorPublicUrl) {
    ElMessage.warning("在线文档服务当前未启动")
    return
  }
  loading.value = true
  try {
    const sessionPath = (versionId: string) => `/v3/show-projects/${props.project.id}/documents/${document.id}/versions/${versionId}/editor-session`
    const [baseline, target] = await Promise.all([
      api<OnlyOfficeEditorConfigView>(sessionPath(comparison.baseline.id), { method: "POST" }),
      api<OnlyOfficeEditorConfigView>(sessionPath(comparison.target.id), { method: "POST" })
    ])
    comparisonEditorConfigs.value = { baseline, target }
    comparisonEditorVisible.value = true
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "历史版本审阅会话创建失败")
  } finally {
    loading.value = false
  }
}

function closeVersionComparison() {
  comparisonEditorConfigs.value = null
}

function chooseUpload() {
  fileInput.value?.click()
}

async function uploadRevision(event: Event) {
  const document = selectedDocument.value
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!document || !file) return
  const form = new FormData()
  form.append("file", file)
  form.append("expectedRevision", String(document.revision))
  form.append("saveMode", "MANUAL_SAVE")
  loading.value = true
  try {
    workspace.value = await api<ShowDocumentWorkspaceView>(`/v3/show-projects/${props.project.id}/documents/${document.id}/content`, { method: "PUT", body: form })
    ElMessage.success("修订版已保存")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文档保存失败")
  } finally {
    loading.value = false
  }
}

async function submitDocument() {
  const document = selectedDocument.value
  if (!document) return
  loading.value = true
  try {
    workspace.value = await api<ShowDocumentWorkspaceView>(`/v3/show-projects/${props.project.id}/documents/${document.id}/submit`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: document.revision })
    })
    ElMessage.success(workspace.value.allRequiredSubmitted ? "三份申报材料均已提交" : "材料已提交")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "材料提交失败")
  } finally {
    loading.value = false
  }
}

async function teacherReview(target: "viewed" | "return") {
  const document = selectedDocument.value
  if (!document) return
  if (target === "return" && !canSubmitReturn.value) {
    ElMessage.warning(returnButtonReason.value)
    return
  }
  loading.value = true
  try {
    workspace.value = await api<ShowDocumentWorkspaceView>(`/v3/show-projects/${props.project.id}/documents/${document.id}/${target}`, {
      method: "POST",
      body: JSON.stringify({ comment: reviewComment.value, score: reviewScore.value })
    })
    ElMessage.success(target === "return" ? "材料已退回修改" : "教师查看已记录")
    emit("refreshProject")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "材料审核失败")
  } finally {
    loading.value = false
  }
}

async function download(path: string, filename: string) {
  try {
    await downloadApiFile(path, filename)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文件下载失败")
  }
}

function downloadPlanningMap() {
  const asset = workspace.value?.reference.planningMapAsset
  if (asset) void download(asset.downloadPath, asset.originalName)
}

function isSubmitted(status: ShowProjectDocumentView["status"]) {
  return status === "SUBMITTED" || status === "VIEWED" || status === "RESUBMITTED"
}

function statusLabel(status: ShowProjectDocumentView["status"]) {
  return ({ NOT_STARTED: "未开始", EDITING: "编辑中", SUBMITTED: "已提交", VIEWED: "教师已查看", RETURNED: "教师退回", RESUBMITTED: "已重新提交" } as const)[status]
}

function versionKind(kind: ShowProjectDocumentView["versions"][number]["kind"]) {
  return ({ TEMPLATE_COPY: "母版副本", AUTO_SAVE: "自动保存", MANUAL_SAVE: "手动保存", ONLYOFFICE_CALLBACK: "在线保存", SUBMISSION: "提交节点" } as const)[kind]
}

function formatFileSize(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatSizeDelta(value: number) {
  if (value === 0) return "无变化"
  return `${value > 0 ? "+" : "-"}${formatFileSize(Math.abs(value))}`
}

function reviewActionLabel(action: ShowProjectDocumentView["reviews"][number]["action"]) {
  return ({ VIEWED: "记录查看", RETURNED: "退回修改", COMMENTED: "教师批注" } as const)[action]
}

function formatTime(value: string | null) {
  return value ? formatPlatformDate(value) : "-"
}
</script>

<template>
  <section class="show-document-workspace" v-loading="workspaceLoading || loading">
    <aside class="document-index">
      <header><span>飞行申报</span><strong>飞行申报材料</strong><small>{{ workspace?.documents.filter((item) => isSubmitted(item.status)).length ?? 0 }} / 3 已提交</small></header>
      <button v-for="(document, index) in workspace?.documents ?? []" :key="document.id" type="button" :class="{ active: selectedDocument?.id === document.id }" :aria-pressed="selectedDocument?.id === document.id" @click="selectedDocumentId = document.id">
        <span>{{ String(index + 1).padStart(2, '0') }}</span>
        <div><strong>{{ document.title }}</strong><small>V{{ document.currentVersionNo }} · {{ statusLabel(document.status) }}</small></div>
        <el-icon v-if="isSubmitted(document.status)"><Check /></el-icon><i v-else />
      </button>
      <footer><span>教学仿真材料</span><small>不向真实行政或管制系统发送</small></footer>
    </aside>

    <main class="document-stage" :class="{ 'teacher-view': !isStudent }">
      <div v-if="loadError && !workspace" class="document-load-error document-load-error-full" role="alert" aria-live="assertive"><span><strong>飞行申报材料加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的材料和审核记录，请检查连接后重新加载。</p></span><el-button type="primary" :icon="Refresh" :loading="workspaceLoading" @click="loadWorkspace">重新加载材料</el-button></div>
      <div v-if="loadError && workspace" class="document-load-error" role="alert" aria-live="assertive"><span><strong>材料数据同步失败</strong><small>{{ loadError }}</small><p>当前材料、版本和审核记录已保留，继续编辑或提交前请先重试同步。</p></span><el-button type="warning" :icon="Refresh" :loading="workspaceLoading" @click="loadWorkspace">重试同步</el-button></div>
      <section v-if="isStudent" class="document-submission-state" :class="{ complete: workspace?.allRequiredSubmitted }">
        <el-icon><Check v-if="workspace?.allRequiredSubmitted" /><Clock v-else /></el-icon>
        <div>
          <strong>{{ workspace?.allRequiredSubmitted ? '申报材料已提交' : `已提交 ${submittedDocumentCount} / 3` }}</strong>
          <small>{{ workspace?.allRequiredSubmitted ? '三份文件均已形成独立提交版本，飞前准备阶段已开放。' : `还需分别提交 ${3 - submittedDocumentCount} 份文件；系统只核验提交状态。` }}</small>
        </div>
      </section>
      <header v-if="selectedDocument">
        <div><span>{{ selectedDocument.templateCode }}</span><h2>{{ selectedDocument.title }}</h2><p>{{ selectedDocument.filename }}</p></div>
        <div class="document-command-row">
          <el-button :icon="Refresh" circle :loading="workspaceLoading" :disabled="workspaceLoading" title="刷新文档状态" @click="loadWorkspace" />
          <el-button v-if="selectedDocument.currentAsset" :icon="Download" circle title="下载当前Word" @click="download(selectedDocument.currentAsset.downloadPath, selectedDocument.filename)" />
          <el-button :icon="isStudent ? EditPen : View" type="primary" :disabled="!selectedDocument.currentAsset" @click="openEditor">{{ isStudent && canEditSelected ? '编辑原模板' : '在线查看' }}</el-button>
        </div>
      </header>

      <section v-if="!isStudent" class="teacher-evidence-banner">
        <el-icon><Check /></el-icon>
        <strong>{{ teacherSubmittedCount }} / {{ workspace?.documents.length ?? 3 }} 已提交</strong>
        <span>可对比历史提交证据并人工审阅 Word 内容。系统只核验是否提交，不自动判断内容正确性或完整性。</span>
      </section>

      <div v-if="selectedDocument" class="document-body">
        <div class="document-paper-preview">
          <div class="paper-mark"><el-icon><Document /></el-icon><span>DOCX</span></div>
          <strong>{{ selectedDocument.title }}</strong>
          <p>当前版本 V{{ selectedDocument.currentVersionNo }}</p>
          <dl>
            <div><dt>状态</dt><dd>{{ statusLabel(selectedDocument.status) }}</dd></div>
            <div><dt>最近保存</dt><dd>{{ formatTime(selectedDocument.lastSavedAt) }}</dd></div>
            <div><dt>提交时间</dt><dd>{{ formatTime(selectedDocument.submittedAt) }}</dd></div>
            <div><dt>重新提交</dt><dd>{{ formatTime(selectedDocument.resubmittedAt) }}</dd></div>
          </dl>
          <blockquote v-if="selectedDocument.reviewComment"><span>最近教师意见</span>{{ selectedDocument.reviewComment }}</blockquote>
        </div>

        <section v-if="!isStudent && selectedDocument.versions.length > 1" class="document-version-comparison" aria-label="申报材料历史版本对比">
          <header>
            <div><span>版本对比</span><strong>历史提交版本对比</strong></div>
            <small>文件证据与审核记录</small>
          </header>
          <div class="version-compare-selectors">
            <label><span>基线版本</span><el-select v-model="comparisonBaselineId" aria-label="选择基线版本"><el-option v-for="version in selectedDocument.versions" :key="version.id" :label="`V${version.versionNo} · ${showDocumentSubmissionLabel(selectedDocument, version.versionNo)}`" :value="version.id" :disabled="version.id === comparisonTargetId" /></el-select></label>
            <label><span>目标版本</span><el-select v-model="comparisonTargetId" aria-label="选择目标版本"><el-option v-for="version in selectedDocument.versions" :key="version.id" :label="`V${version.versionNo} · ${showDocumentSubmissionLabel(selectedDocument, version.versionNo)}`" :value="version.id" :disabled="version.id === comparisonBaselineId" /></el-select></label>
          </div>
          <template v-if="versionComparison">
            <div class="version-evidence-grid">
              <article v-for="version in [versionComparison.baseline, versionComparison.target]" :key="version.id">
                <header><strong>V{{ version.versionNo }}</strong><span>{{ showDocumentSubmissionLabel(selectedDocument, version.versionNo) }}</span></header>
                <dl>
                  <div><dt>提交人</dt><dd>{{ version.createdBy }}</dd></div>
                  <div><dt>提交时间</dt><dd>{{ formatTime(version.createdAt) }}</dd></div>
                  <div><dt>文件大小</dt><dd>{{ formatFileSize(version.asset.sizeBytes) }}</dd></div>
                  <div><dt>SHA-256</dt><dd><code>{{ version.asset.sha256.slice(0, 12) }}…</code></dd></div>
                </dl>
                <button type="button" @click="download(version.asset.downloadPath, version.asset.originalName)"><el-icon><Download /></el-icon>下载 V{{ version.versionNo }}</button>
                <ul v-if="selectedDocument.reviews.some(review => review.versionNo === version.versionNo)">
                  <li v-for="review in selectedDocument.reviews.filter(item => item.versionNo === version.versionNo)" :key="review.id"><strong>{{ reviewActionLabel(review.action) }}</strong><span>{{ review.comment || '无文字意见' }}</span><small>{{ review.reviewedBy }} · {{ formatTime(review.createdAt) }}</small></li>
                </ul>
                <p v-else>该提交版本暂无教师审核记录。</p>
              </article>
            </div>
            <footer>
              <div><strong>{{ versionComparison.sameContent ? '文件内容哈希一致' : '文件内容哈希不同' }}</strong><span>目标版本大小 {{ formatSizeDelta(versionComparison.sizeDeltaBytes) }}；内容差异由教师在只读 Word 中人工判断。</span></div>
              <el-button type="primary" :icon="View" @click="openVersionComparison">并排审阅 Word</el-button>
            </footer>
          </template>
        </section>

        <section class="document-audit" aria-label="材料审核与重提记录">
          <header><div><strong>审核与重提记录</strong></div><small>{{ auditTimeline.length }} 条留痕</small></header>
          <ol v-if="auditTimeline.length">
            <li v-for="entry in auditTimeline" :key="entry.id" :class="`audit-${entry.type.toLowerCase()}`">
              <i><el-icon><Warning v-if="entry.type === 'RETURNED'" /><Check v-else-if="entry.type === 'SUBMISSION'" /><View v-else /></el-icon></i>
              <div><div><strong>{{ entry.title }}</strong><span>关联 V{{ entry.versionNo }}</span></div><p v-if="entry.comment">{{ entry.comment }}</p><small>{{ entry.actor }} · {{ formatTime(entry.occurredAt) }}</small></div>
            </li>
          </ol>
          <div v-else class="document-audit-empty"><el-icon><Clock /></el-icon><span>提交后将在这里形成审核留痕</span></div>
        </section>
      </div>

      <footer v-if="selectedDocument && isStudent && canEditSelected" class="document-submit-bar">
        <input ref="fileInput" type="file" accept=".docx" hidden @change="uploadRevision" />
        <el-button :icon="Upload" @click="chooseUpload">导入修订版</el-button>
        <el-button type="primary" :disabled="isSubmitted(selectedDocument.status)" @click="submitDocument">提交本文件</el-button>
      </footer>

      <section v-else-if="selectedDocument && !isStudent && isSubmitted(selectedDocument.status)" class="document-review-bar">
        <el-input v-model="reviewComment" type="textarea" :rows="2" maxlength="2000" placeholder="教师批注意见" />
        <el-input-number v-model="reviewScore" :min="0" :max="100" placeholder="分数" />
        <el-button :icon="View" @click="teacherReview('viewed')">记录查看</el-button>
        <el-tooltip :content="returnButtonReason" placement="top">
          <span class="return-action"><el-button type="danger" plain :disabled="!canSubmitReturn" @click="teacherReview('return')">退回修改</el-button></span>
        </el-tooltip>
      </section>
    </main>

    <aside class="document-reference">
      <V3ShowDocumentReferencePanel v-if="workspace" :reference="workspace.reference" @download-planning-map="downloadPlanningMap" />

      <section v-if="selectedDocument">
        <header><strong>版本记录</strong><small>{{ selectedDocument.versions.length }}</small></header>
        <button v-for="version in selectedDocument.versions" :key="version.id" type="button" @click="download(version.asset.downloadPath, version.asset.originalName)">
          <span>V{{ version.versionNo }}</span><div><strong>{{ versionKind(version.kind) }}</strong><small>{{ version.createdBy }} · {{ formatTime(version.createdAt) }}</small></div><el-icon><Download /></el-icon>
        </button>
      </section>
    </aside>

    <el-dialog v-model="editorVisible" width="min(1440px, calc(100vw - 28px))" top="2vh" class="onlyoffice-dialog" destroy-on-close @closed="closeEditor">
      <template #header><div class="onlyoffice-title"><strong>{{ selectedDocument?.title }}</strong><span>{{ canEditSelected ? '原模板编辑' : '只读模式' }}</span></div></template>
      <div class="onlyoffice-reference-layout" :class="{ 'with-reference': isStudent && workspace }">
        <V3OnlyOfficeEditor v-if="editorConfig" :public-api-url="editorConfig.publicApiUrl" :config="editorConfig.config" @error="ElMessage.error($event)" />
        <aside v-if="isStudent && workspace" class="onlyoffice-reference-sidebar">
          <V3ShowDocumentReferencePanel :reference="workspace.reference" @download-planning-map="downloadPlanningMap" />
        </aside>
      </div>
    </el-dialog>

    <el-dialog v-model="comparisonEditorVisible" width="min(1760px, calc(100vw - 20px))" top="2vh" class="onlyoffice-dialog comparison-editor-dialog" destroy-on-close @closed="closeVersionComparison">
      <template #header><div class="onlyoffice-title"><strong>{{ selectedDocument?.title }} · 历史版本对比</strong><span>只读人工审阅</span></div></template>
      <div v-if="comparisonEditorConfigs && versionComparison" class="comparison-editor-grid">
        <section><header><strong>V{{ versionComparison.baseline.versionNo }} · {{ showDocumentSubmissionLabel(selectedDocument!, versionComparison.baseline.versionNo) }}</strong><small>{{ formatTime(versionComparison.baseline.createdAt) }}</small></header><V3OnlyOfficeEditor :public-api-url="comparisonEditorConfigs.baseline.publicApiUrl" :config="comparisonEditorConfigs.baseline.config" @error="ElMessage.error($event)" /></section>
        <section><header><strong>V{{ versionComparison.target.versionNo }} · {{ showDocumentSubmissionLabel(selectedDocument!, versionComparison.target.versionNo) }}</strong><small>{{ formatTime(versionComparison.target.createdAt) }}</small></header><V3OnlyOfficeEditor :public-api-url="comparisonEditorConfigs.target.publicApiUrl" :config="comparisonEditorConfigs.target.config" @error="ElMessage.error($event)" /></section>
      </div>
    </el-dialog>
  </section>
</template>

<style scoped>
.show-document-workspace { display: grid; grid-column: 2 / 4; grid-template-columns: 240px minmax(0, 1fr) 300px; min-width: 0; min-height: 0; background: #edf1ef; }
.document-index, .document-reference { min-height: 0; overflow: auto; background: #f8faf9; }
.document-index { border-right: 1px solid #d4ddd8; }
.document-index > header { display: grid; gap: 3px; min-height: 88px; border-bottom: 1px solid #d4ddd8; padding: 16px; }
.document-index > header span { color: #237153; font-size: 11px; font-weight: 800; }
.document-index > header strong { font-size: 15px; }
.document-index > header small { color: #71847c; font-size: 11px; }
.document-index > button { display: grid; grid-template-columns: 24px minmax(0, 1fr) 18px; align-items: center; gap: 8px; width: 100%; min-height: 78px; border: 0; border-bottom: 1px solid #dde4e0; padding: 11px 13px; color: #283a33; text-align: left; background: transparent; cursor: pointer; }
.document-index > button.active { box-shadow: inset 3px 0 #247354; background: #eaf2ee; }
.document-index > button > span { color: #7e8d87; font-size: 11px; font-weight: 700; }
.document-index > button div { display: grid; gap: 5px; min-width: 0; }
.document-index > button strong { font-size: 11px; line-height: 1.45; }
.document-index > button small { color: #71847c; font-size: 11px; }
.document-index > button .el-icon { color: #247354; }
.document-index > button i { width: 7px; height: 7px; border-radius: 50%; background: #c0cbc6; }
.document-index > footer { display: grid; gap: 3px; padding: 14px 16px; color: #667a71; font-size: 11px; }
.document-stage { display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; min-height: 0; }
.document-load-error { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 14px 18px 0; border-left: 3px solid #b05a45; padding: 12px 14px; color: #653b31; background: #fff4f1; }
.document-load-error-full { align-self: start; margin: 24px; }
.document-load-error > span { display: grid; min-width: 0; gap: 3px; }
.document-load-error strong { font-size: 10px; }.document-load-error small { overflow-wrap: anywhere; font-size: 11px; }.document-load-error p { margin: 0; color: #765b54; font-size: 11px; line-height: 1.5; }.document-load-error .el-button { flex: 0 0 auto; }
.document-stage.teacher-view { grid-template-rows: auto auto minmax(0, 1fr) auto; }
.document-stage > header { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 82px; border-bottom: 1px solid #d5ddd9; padding: 12px 20px; background: white; }
.document-stage > header > div:first-child { display: grid; gap: 2px; min-width: 0; }
.document-stage > header span { color: #247354; font-size: 11px; font-weight: 700; }
.document-stage h2 { margin: 0; font-size: 15px; }
.document-stage header p { overflow: hidden; margin: 0; color: #73857d; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.document-command-row { display: flex; flex: 0 0 auto; gap: 6px; }
.teacher-evidence-banner { display: grid; grid-template-columns: 18px auto minmax(0, 1fr); align-items: center; gap: 8px; border-bottom: 1px solid #cfe0d8; padding: 9px 20px; color: #315d4b; background: #e9f3ee; }
.teacher-evidence-banner .el-icon { color: #247354; font-size: 15px; }
.teacher-evidence-banner strong { font-size: 11px; white-space: nowrap; }
.teacher-evidence-banner span { min-width: 0; color: #5d746a; font-size: 11px; line-height: 1.5; }
.document-body { min-width: 0; min-height: 0; overflow: auto; padding: 18px; }
.document-paper-preview { display: grid; width: min(520px, 100%); min-height: 520px; align-content: start; box-sizing: border-box; margin: 0 auto; border: 1px solid #d5dad7; padding: 62px 64px; background: white; box-shadow: 0 10px 28px rgba(36, 55, 47, .08); }
.paper-mark { display: flex; align-items: center; gap: 7px; color: #267153; font-size: 11px; font-weight: 800; }
.paper-mark .el-icon { font-size: 20px; }
.document-paper-preview > strong { margin-top: 55px; text-align: center; font-family: serif; font-size: 21px; }
.document-paper-preview > p { margin: 12px 0 36px; color: #77867f; text-align: center; font-size: 11px; }
.document-paper-preview dl, .document-reference dl { display: grid; gap: 0; margin: 0; border-top: 1px solid #dde3e0; }
.document-paper-preview dl > div, .document-reference dl > div { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: 10px; border-bottom: 1px solid #e1e6e3; padding: 9px 0; font-size: 11px; }
.document-paper-preview dt, .document-reference dt { color: #798a82; }
.document-paper-preview dd, .document-reference dd { margin: 0; }
.document-paper-preview blockquote { margin: 25px 0 0; border-left: 3px solid #cc7448; padding: 10px 12px; color: #5e463b; background: #fbf1eb; font-size: 11px; line-height: 1.6; }
.document-paper-preview blockquote span { display: block; color: #a55531; font-size: 11px; font-weight: 700; }
.document-version-comparison { width: min(720px, 100%); box-sizing: border-box; margin: 18px auto 0; border-top: 2px solid #31483e; background: #f8faf9; }
.document-version-comparison > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #d7dfdb; padding: 12px 2px; }
.document-version-comparison > header > div { display: grid; gap: 2px; }.document-version-comparison > header span { color: #247354; font-size: 11px; font-weight: 800; }.document-version-comparison > header strong { font-size: 11px; }.document-version-comparison > header small { color: #71847c; font-size: 11px; }
.version-compare-selectors { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 12px 0; }.version-compare-selectors label { display: grid; min-width: 0; gap: 5px; }.version-compare-selectors label > span { color: #657970; font-size: 11px; font-weight: 700; }
.version-evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid #d8e0dc; background: white; }.version-evidence-grid > article { min-width: 0; padding: 12px; }.version-evidence-grid > article + article { border-left: 1px solid #d8e0dc; }.version-evidence-grid article > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }.version-evidence-grid article > header strong { font-size: 14px; }.version-evidence-grid article > header span { color: #247354; font-size: 11px; font-weight: 700; }.version-evidence-grid dl { display: grid; margin: 0; border-top: 1px solid #e0e6e3; }.version-evidence-grid dl > div { display: grid; grid-template-columns: 66px minmax(0, 1fr); gap: 8px; border-bottom: 1px solid #e0e6e3; padding: 6px 0; font-size: 11px; }.version-evidence-grid dt { color: #75877f; }.version-evidence-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }.version-evidence-grid code { color: #315d4b; font-size: 11px; }.version-evidence-grid article > button { display: flex; align-items: center; gap: 5px; margin: 9px 0; border: 1px solid #cbd8d2; border-radius: 3px; padding: 5px 8px; color: #285f49; background: white; font-size: 11px; cursor: pointer; }.version-evidence-grid ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }.version-evidence-grid li { display: grid; gap: 2px; border-left: 2px solid #cc7448; padding: 5px 7px; background: #fbf3ee; }.version-evidence-grid li strong { color: #8f4f30; font-size: 11px; }.version-evidence-grid li span { color: #594b43; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }.version-evidence-grid li small,.version-evidence-grid article > p { margin: 0; color: #7a8a83; font-size: 11px; }.document-version-comparison > footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 0; }.document-version-comparison > footer > div { display: grid; gap: 3px; }.document-version-comparison > footer strong { font-size: 11px; }.document-version-comparison > footer span { color: #657970; font-size: 11px; line-height: 1.5; }
.document-audit { width: min(520px, 100%); box-sizing: border-box; margin: 18px auto 0; border-top: 2px solid #31483e; background: #f8faf9; }
.document-audit > header { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-bottom: 1px solid #d7dfdb; padding: 12px 2px; }
.document-audit > header > div { display: grid; gap: 2px; }
.document-audit > header span { color: #247354; font-size: 11px; font-weight: 800; }
.document-audit > header strong { font-size: 11px; }
.document-audit > header small { color: #71847c; font-size: 11px; }
.document-audit ol { margin: 0; padding: 0; list-style: none; }
.document-audit li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; border-bottom: 1px solid #dde4e0; padding: 12px 2px; }
.document-audit li > i { display: grid; width: 24px; height: 24px; place-items: center; border: 1px solid #b7c9c0; border-radius: 50%; color: #247354; background: #edf5f1; }
.document-audit li.audit-returned > i { border-color: #e0b7a2; color: #a55531; background: #fbf1eb; }
.document-audit li > div { display: grid; gap: 5px; min-width: 0; }
.document-audit li > div > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.document-audit li strong { font-size: 11px; }
.document-audit li span { flex: 0 0 auto; color: #247354; font-size: 11px; font-weight: 800; }
.document-audit li p { margin: 0; color: #53675e; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.document-audit li small { color: #7a8a83; font-size: 11px; }
.document-audit-empty { display: flex; align-items: center; gap: 8px; padding: 18px 2px; color: #7a8a83; font-size: 11px; }
.document-submit-bar, .document-review-bar { display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #d4ddd8; padding: 10px 14px; background: white; }
.document-submission-state { display: flex; align-items: center; gap: 9px; border-bottom: 1px solid #e2ded2; padding: 9px 16px; color: #80631f; background: #f8f3e4; }.document-submission-state.complete { color: #21684e; background: #e8f2ed; }.document-submission-state > .el-icon { flex: 0 0 auto; font-size: 17px; }.document-submission-state > div { display: grid; min-width: 0; gap: 2px; }.document-submission-state strong { font-size: 10px; }.document-submission-state small { color: inherit; font-size: 11px; line-height: 1.45; opacity: .78; }
.document-review-bar { display: grid; grid-template-columns: minmax(0, 1fr) 110px auto auto; align-items: center; }
.return-action { display: inline-flex; }
.document-reference { border-left: 1px solid #d4ddd8; }
.document-reference > section { border-bottom: 1px solid #d4ddd8; padding: 15px; }
.document-reference section > header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 11px; }
.document-reference header strong { font-size: 10px; }
.document-reference header small { color: #247354; font-size: 11px; }
.document-reference section > p { margin: 0 0 12px; color: #5f736a; font-size: 11px; line-height: 1.55; }
.document-reference section > button { display: grid; grid-template-columns: 28px minmax(0, 1fr) 18px; align-items: center; gap: 7px; width: 100%; border: 0; border-top: 1px solid #e0e6e3; padding: 9px 0; text-align: left; background: transparent; cursor: pointer; }
.document-reference section > button > span { color: #247354; font-size: 11px; font-weight: 700; }
.document-reference section > button div { display: grid; gap: 2px; }
.document-reference section > button strong { font-size: 11px; }
.document-reference section > button small { color: #7c8c85; font-size: 11px; }
.onlyoffice-title { display: flex; align-items: center; gap: 12px; }
.onlyoffice-title span { color: #247354; font-size: 11px; }
:global(.onlyoffice-dialog .el-dialog__body) { height: calc(96vh - 64px); padding: 0; }
:global(.comparison-editor-dialog .el-dialog__body) { height: calc(94vh - 64px); }
.onlyoffice-reference-layout { width: 100%; height: 100%; min-width: 0; min-height: 0; }
.onlyoffice-reference-layout.with-reference { display: grid; grid-template-columns: minmax(0,1fr) 320px; }
.onlyoffice-reference-sidebar { min-width: 0; min-height: 0; overflow: auto; border-left: 1px solid #d4ddd8; background: #f8faf9; }
.comparison-editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; height: 100%; min-width: 0; min-height: 0; background: #d7dfdb; gap: 1px; }.comparison-editor-grid > section { display: grid; grid-template-rows: 34px minmax(0, 1fr); min-width: 0; min-height: 0; background: white; }.comparison-editor-grid section > header { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid #d4ddd8; padding: 0 10px; }.comparison-editor-grid section > header strong { font-size: 11px; }.comparison-editor-grid section > header small { color: #71847c; font-size: 11px; }
@media (max-width: 1080px) { .show-document-workspace { grid-template-columns: 210px minmax(0, 1fr); } .document-reference { display: none; } }
@media (max-width: 760px) { .show-document-workspace { grid-column: 1; grid-row: 3 / 5; grid-template-columns: 1fr; grid-template-rows: auto 680px; } .document-index { display: grid; grid-template-columns: repeat(3, 1fr); border-right: 0; } .document-index > header, .document-index > footer { display: none; } .document-index > button { grid-template-columns: 20px minmax(0, 1fr); min-height: 68px; } .document-index > button .el-icon, .document-index > button i { display: none; } .document-stage, .document-stage.teacher-view { display: block; max-width: 100%; overflow-x: hidden; overflow-y: auto; } .document-stage > * { box-sizing: border-box; min-width: 0; max-width: 100%; } .document-load-error { align-items: stretch; flex-direction: column; margin: 12px; }.document-load-error-full { margin: 12px; } .teacher-evidence-banner { grid-template-columns: 18px minmax(0, 1fr); padding: 8px 12px; } .teacher-evidence-banner span { grid-column: 1 / -1; padding-left: 26px; } .document-body { overflow: visible; padding: 16px 12px; } .document-paper-preview { min-height: 470px; padding: 42px 30px; } .version-compare-selectors,.version-evidence-grid,.comparison-editor-grid { grid-template-columns: minmax(0, 1fr); }.version-evidence-grid > article + article { border-top: 1px solid #d8e0dc; border-left: 0; }.document-version-comparison > footer { align-items: stretch; flex-direction: column; }.document-version-comparison > footer :deep(.el-button) { width: 100%; margin: 0; }.comparison-editor-grid { grid-template-rows: repeat(2, minmax(560px, 1fr)); height: auto; min-height: 1120px; }.comparison-editor-dialog :deep(.el-dialog__body) { overflow: auto; } .document-review-bar { grid-template-columns: minmax(0, 1fr) 104px; width: 100%; } .document-review-bar > * { min-width: 0; } .document-review-bar > :first-child { grid-column: 1 / -1; } .document-review-bar > :last-child { grid-column: 1 / -1; } .document-review-bar :deep(.el-input-number) { width: 100%; } .return-action, .return-action .el-button { width: 100%; } .onlyoffice-reference-layout.with-reference { grid-template-columns: minmax(0,1fr); grid-template-rows: minmax(420px,62%) minmax(0,38%); overflow: hidden; } .onlyoffice-reference-sidebar { border-top: 1px solid #d4ddd8; border-left: 0; } }
</style>
