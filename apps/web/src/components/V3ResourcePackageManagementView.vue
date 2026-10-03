<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue"
import { ElMessage, ElMessageBox } from "element-plus"
import { CircleCheck, CircleClose, Delete, DocumentChecked, Download, Refresh, Upload } from "@element-plus/icons-vue"
import Papa from "papaparse"
import type { ResourcePackageStatus, ResourcePackageType, ShowProgramManifest, V3ResourcePackageView } from "@wurenji/shared"
import { api, downloadApiFile } from "../api"
import { formatPlatformDateTime } from "../platform-date"

type ResourceDetail = {
  package: V3ResourcePackageView
  validations: Array<{
    id: string
    status: "PASSED" | "FAILED"
    archiveSha256: string
    signatureKeyId: string | null
    checks: Array<{ code: string; passed: boolean; message: string }>
    errorMessage: string | null
    actorName: string
    completedAt: string
  }>
  lifecycle: Array<{
    id: string
    action: string
    previousPackageId: string | null
    reason: string | null
    actorName: string
    createdAt: string
  }>
}

const packages = ref<V3ResourcePackageView[]>([])
const selectedId = ref("")
const detail = ref<ResourceDetail | null>(null)
const loading = ref(false)
const loadError = ref("")
const detailError = ref("")
const actionLoading = ref(false)
const selectedType = ref<"ALL" | ResourcePackageType>("ALL")
const selectedStatus = ref<"ALL" | ResourcePackageStatus>("ALL")
const uploadInput = ref<HTMLInputElement | null>(null)
const trajectoryInput = ref<HTMLInputElement | null>(null)
const trajectoryDialogVisible = ref(false)
const trajectoryFile = ref<File | null>(null)
const trajectoryPreview = ref<{ header: string[]; sampleRows: string[][]; truncated: boolean; error: string | null } | null>(null)
const trajectoryForm = reactive({ name: "", version: "1.0.0", sourceSoftware: "" })
const trajectoryPreviewBlocksSubmit = computed(() => Boolean(trajectoryPreview.value?.error))

const packageTypeLabels: Record<ResourcePackageType, string> = {
  RULE: "规则",
  REGION: "区域",
  SCALE_TEMPLATE: "规模模板",
  AIRCRAFT: "机型",
  EVENT: "事件",
  SHOW_PROGRAM: "表演程序",
  DOCUMENT_TEMPLATE: "文档模板",
  REPORT: "报告"
}

const statusLabels: Record<ResourcePackageStatus, string> = {
  UPLOADED: "已上传",
  VALIDATING: "校验中",
  STAGED: "待激活",
  ACTIVE: "已激活",
  REJECTED: "已拒绝",
  RETIRED: "已退役"
}

const filteredPackages = computed(() => packages.value.filter((item) =>
  (selectedType.value === "ALL" || item.packageType === selectedType.value)
  && (selectedStatus.value === "ALL" || item.status === selectedStatus.value)
))
const selectedPackage = computed(() => packages.value.find((item) => item.id === selectedId.value) ?? null)
const latestValidation = computed(() => detail.value?.validations[0] ?? null)
const selectedShowProgram = computed<ShowProgramManifest | null>(() => {
  const manifest = selectedPackage.value?.manifest
  if (!manifest || manifest.sceneType !== "CITY_SHOW" || manifest.format !== "LOCAL_ENU_CSV_V1") return null
  return manifest as unknown as ShowProgramManifest
})

onMounted(loadPackages)

async function loadPackages(preferredId = selectedId.value) {
  loading.value = true
  loadError.value = ""
  try {
    packages.value = await api<V3ResourcePackageView[]>("/v3/resource-packages")
    const nextId = preferredId && packages.value.some((item) => item.id === preferredId)
      ? preferredId
      : packages.value[0]?.id ?? ""
    selectedId.value = nextId
    await loadDetail(nextId)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : "资源包列表加载失败"
    ElMessage.error(loadError.value)
  } finally {
    loading.value = false
  }
}

async function loadDetail(id: string) {
  if (!id) {
    detail.value = null
    return
  }
  detailError.value = ""
  try {
    detail.value = await api<ResourceDetail>(`/v3/resource-packages/${id}`)
  } catch (error) {
    detailError.value = error instanceof Error ? error.message : "资源包详情加载失败"
    ElMessage.error(detailError.value)
  }
}

async function selectPackage(id: string) {
  selectedId.value = id
  await loadDetail(id)
}

function chooseUpload() {
  uploadInput.value?.click()
}

async function uploadArchive(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file) return
  if (!file.name.toLowerCase().endsWith(".zip")) {
    ElMessage.warning("资源包必须是 ZIP 文件")
    return
  }
  actionLoading.value = true
  try {
    const form = new FormData()
    form.append("file", file)
    const created = await api<V3ResourcePackageView>("/v3/resource-packages/upload", { method: "POST", body: form })
    ElMessage.success(`${created.name} v${created.version} 已完成预检`)
    await loadPackages(created.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "资源包上传失败")
  } finally {
    actionLoading.value = false
  }
}

function openTrajectoryDialog() {
  trajectoryFile.value = null
  trajectoryPreview.value = null
  trajectoryForm.name = ""
  trajectoryForm.version = "1.0.0"
  trajectoryForm.sourceSoftware = ""
  trajectoryDialogVisible.value = true
}

function chooseTrajectory() {
  trajectoryInput.value?.click()
}

async function selectTrajectory(event: Event) {
  const input = event.target as HTMLInputElement
  trajectoryFile.value = input.files?.[0] ?? null
  input.value = ""
  if (trajectoryFile.value && !trajectoryForm.name) trajectoryForm.name = trajectoryFile.value.name.replace(/\.csv$/i, "")
  trajectoryPreview.value = null
  if (!trajectoryFile.value) return
  try {
    const previewBytes = await trajectoryFile.value.slice(0, 128 * 1024).text()
    const parsed = Papa.parse<string[]>(previewBytes.replace(/^\uFEFF/, ""), { skipEmptyLines: "greedy", preview: 7 })
    const header = (parsed.data[0] ?? []).map((value) => canonicalTrajectoryHeader(String(value)))
    const required = ["aircraft_id", "time_ms", "east_m", "north_m", "up_m"]
    const missing = required.filter((field) => !header.includes(field))
    trajectoryPreview.value = {
      header,
      sampleRows: parsed.data.slice(1, 4).map((row) => row.map((value) => String(value))),
      truncated: trajectoryFile.value.size > 128 * 1024,
      error: missing.length ? `预览缺少字段：${missing.join("、")}` : parsed.errors.length ? `预览解析提示：${parsed.errors[0]?.message ?? "CSV 格式需要检查"}` : null
    }
  } catch (error) {
    trajectoryPreview.value = { header: [], sampleRows: [], truncated: false, error: error instanceof Error ? error.message : "文件预览失败" }
  }
}

function canonicalTrajectoryHeader(value: string) {
  const normalized = value.replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  return ({
    drone_id: "aircraft_id",
    droneid: "aircraft_id",
    aircraftid: "aircraft_id",
    timestamp_ms: "time_ms",
    x: "east_m",
    x_m: "east_m",
    east: "east_m",
    y: "north_m",
    y_m: "north_m",
    north: "north_m",
    z: "up_m",
    z_m: "up_m",
    altitude_m: "up_m",
    altitude: "up_m"
  } as Record<string, string>)[normalized] ?? normalized
}

function downloadTrajectoryTemplate() {
  const rows = ["aircraft_id,time_ms,east_m,north_m,up_m"]
  for (let index = 1; index <= 100; index += 1) {
    const aircraftId = `UAV-${String(index).padStart(3, "0")}`
    const east = Math.round(((index - 50.5) % 10) * 3 * 1000) / 1000
    const north = Math.round((Math.floor((index - 1) / 10) - 4.5) * 3 * 1000) / 1000
    rows.push(`${aircraftId},0,${east},${north},0`)
    rows.push(`${aircraftId},10000,${east},${north},30`)
  }
  const url = URL.createObjectURL(new Blob([`\uFEFF${rows.join("\n")}`], { type: "text/csv;charset=utf-8" }))
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = "show-program-local-enu-100-template.csv"
  anchor.click()
  URL.revokeObjectURL(url)
}

async function importTrajectory() {
  if (!trajectoryFile.value) return ElMessage.warning("请选择舞步轨迹 CSV 文件")
  if (!trajectoryForm.name.trim() || !trajectoryForm.sourceSoftware.trim()) return ElMessage.warning("请填写程序名称和来源软件")
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trajectoryForm.version.trim())) return ElMessage.warning("版本号需使用语义版本，例如 1.0.0")
  actionLoading.value = true
  try {
    const form = new FormData()
    form.append("file", trajectoryFile.value)
    form.append("name", trajectoryForm.name.trim())
    form.append("version", trajectoryForm.version.trim())
    form.append("sourceSoftware", trajectoryForm.sourceSoftware.trim())
    const created = await api<V3ResourcePackageView>("/v3/resource-packages/show-programs/import", { method: "POST", body: form })
    trajectoryDialogVisible.value = false
    ElMessage.success(`${created.name} v${created.version} 已导入，激活后可用于表演任务`)
    await loadPackages(created.id)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "舞步轨迹导入失败")
  } finally {
    actionLoading.value = false
  }
}

async function runPreflight() {
  if (!selectedPackage.value) return
  try {
    await performAction("正在重新预检资源包", async () => {
      await api<V3ResourcePackageView>(`/v3/resource-packages/${selectedPackage.value!.id}/preflight`, { method: "POST" })
    })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "资源包预检失败")
  }
}

async function activatePackage() {
  await actionWithReason("激活资源包", "激活后同名旧版本会自动退役，是否继续？", "激活", async (reason) => {
    await api<V3ResourcePackageView>(`/v3/resource-packages/${selectedPackage.value!.id}/activate`, { method: "POST", body: JSON.stringify({ reason }) })
  })
}

async function rollbackPackage() {
  await actionWithReason("回滚资源包", "回滚会让当前激活版本退役，并恢复此版本，是否继续？", "回滚", async (reason) => {
    await api<V3ResourcePackageView>(`/v3/resource-packages/${selectedPackage.value!.id}/rollback`, { method: "POST", body: JSON.stringify({ reason }) })
  })
}

async function retirePackage() {
  await actionWithReason("退役资源包", "退役后该版本不能再被新任务引用，是否继续？", "退役", async (reason) => {
    await api<V3ResourcePackageView>(`/v3/resource-packages/${selectedPackage.value!.id}/retire`, { method: "POST", body: JSON.stringify({ reason }) })
  })
}

async function actionWithReason(title: string, message: string, confirmText: string, action: (reason: string) => Promise<void>) {
  if (!selectedPackage.value) return
  try {
    await ElMessageBox.confirm(message, title, { type: "warning", confirmButtonText: confirmText, cancelButtonText: "取消" })
    const { value } = await ElMessageBox.prompt("记录本次操作原因（可选）", title, {
      confirmButtonText: confirmText,
      cancelButtonText: "取消",
      inputPlaceholder: "例如：校验通过，切换到新版本",
      inputValidator: (value: string) => value.length <= 1_000 || "原因不能超过 1000 个字符"
    })
    await performAction(`正在${title}`, () => action(value))
  } catch (error) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof Error ? error.message : `${title}失败`)
  }
}

async function performAction(progressText: string, action: () => Promise<void>) {
  actionLoading.value = true
  try {
    await action()
    ElMessage.success(progressText.replace("正在", "") + "完成")
    await loadPackages(selectedId.value)
  } finally {
    actionLoading.value = false
  }
}

async function downloadArchive() {
  if (!selectedPackage.value?.archiveAsset) return
  try {
    await downloadApiFile(`/v3/resource-packages/${selectedPackage.value.id}/archive`, selectedPackage.value.archiveAsset.originalName)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "归档下载失败")
  }
}

function statusClass(status: ResourcePackageStatus) {
  return status.toLowerCase().replace("_", "-")
}

function formatTime(value: string | null) {
  return value ? formatPlatformDateTime(value) : "未发生"
}
</script>

<template>
  <div class="education-page resource-management-page" v-loading="loading">
    <header class="page-heading resource-page-heading">
      <div><span>平台治理 · R0-07</span><h1>资源包管理</h1><p>签名归档与受控舞步导入是教学资源进入任务前的统一入口。</p></div>
      <div class="resource-heading-actions">
        <input ref="uploadInput" type="file" accept=".zip,application/zip" hidden @change="uploadArchive" />
        <input ref="trajectoryInput" type="file" accept=".csv,text/csv" hidden @change="selectTrajectory" />
        <el-button :icon="Refresh" @click="loadPackages()">刷新</el-button>
        <el-button :icon="Upload" :loading="actionLoading" @click="openTrajectoryDialog">导入舞步 CSV</el-button>
        <el-button type="primary" :icon="Upload" :loading="actionLoading" @click="chooseUpload">上传签名 ZIP</el-button>
      </div>
    </header>

    <div v-if="loadError && !packages.length" class="resource-load-error resource-load-error-full" role="alert" aria-live="assertive"><span><strong>资源包列表加载失败</strong><small>{{ loadError }}</small><p>当前没有可保留的资源版本，请检查连接后重新加载。</p></span><el-button type="primary" :icon="Refresh" :loading="loading" @click="loadPackages()">重新加载资源</el-button></div>
    <div v-else-if="loadError" class="resource-load-error" role="alert" aria-live="assertive"><span><strong>资源包列表同步失败</strong><small>{{ loadError }}</small><p>当前列表和已选资源仍保留，可继续查看；上传或治理前请先重试同步。</p></span><el-button type="warning" :icon="Refresh" :loading="loading" @click="loadPackages()">重试同步</el-button></div>

    <section class="resource-summary-band">
      <div><small>资源总数</small><strong>{{ packages.length }}</strong></div>
      <div><small>已激活</small><strong>{{ packages.filter((item) => item.status === 'ACTIVE').length }}</strong></div>
      <div><small>待处理</small><strong>{{ packages.filter((item) => ['STAGED', 'VALIDATING'].includes(item.status)).length }}</strong></div>
      <div><small>校验拒绝</small><strong class="danger-number">{{ packages.filter((item) => item.status === 'REJECTED').length }}</strong></div>
    </section>

    <div class="resource-management-layout">
      <section class="resource-list-section">
        <header class="resource-list-toolbar">
          <strong>资源版本</strong>
          <div>
            <el-select v-model="selectedType" size="small" aria-label="按资源类型筛选">
              <el-option label="全部类型" value="ALL" />
              <el-option v-for="(label, type) in packageTypeLabels" :key="type" :label="label" :value="type" />
            </el-select>
            <el-select v-model="selectedStatus" size="small" aria-label="按资源状态筛选">
              <el-option label="全部状态" value="ALL" />
              <el-option v-for="(label, status) in statusLabels" :key="status" :label="label" :value="status" />
            </el-select>
          </div>
        </header>
        <div v-if="filteredPackages.length" class="resource-list">
          <button v-for="item in filteredPackages" :key="item.id" type="button" :class="{ active: item.id === selectedId }" :aria-pressed="item.id === selectedId" :aria-label="`${item.name}，${packageTypeLabels[item.packageType]}，${statusLabels[item.status]}${item.id === selectedId ? '，已选中' : ''}`" @click="selectPackage(item.id)">
            <span class="resource-type-mark">{{ item.packageType.slice(0, 3) }}</span>
            <span class="resource-list-copy"><strong>{{ item.name }}</strong><small>v{{ item.version }} · {{ packageTypeLabels[item.packageType] }}</small></span>
            <span class="resource-status" :class="statusClass(item.status)">{{ statusLabels[item.status] }}</span>
          </button>
        </div>
        <div v-else-if="!loadError" class="resource-empty"><el-icon><DocumentChecked /></el-icon><strong>没有匹配的资源包</strong><span>上传签名 ZIP 后，系统会自动执行结构、摘要和签名预检。</span></div>
        <div v-else class="resource-empty resource-empty-error"><el-icon><Warning /></el-icon><strong>资源列表暂不可用</strong><span>重新加载成功后才能确认资源版本和状态。</span></div>
      </section>

      <section v-if="selectedPackage" class="resource-detail-section">
        <div v-if="detailError" class="resource-detail-error" role="alert" aria-live="assertive"><span><strong>资源详情同步失败</strong><small>{{ detailError }}</small><p>当前资源基本信息已保留，重试后才能查看最新校验和生命周期记录。</p></span><el-button type="warning" :icon="Refresh" :loading="loading" @click="loadDetail(selectedId)">重试详情</el-button></div>
        <header class="resource-detail-header">
          <div><span class="resource-kicker">{{ packageTypeLabels[selectedPackage.packageType] }} · {{ selectedPackage.source === 'SIGNED_ARCHIVE' ? '签名归档' : selectedPackage.source }}</span><h2>{{ selectedPackage.name }}</h2><p>版本 v{{ selectedPackage.version }} · 创建于 {{ formatTime(selectedPackage.createdAt) }}</p></div>
          <span class="resource-status large" :class="statusClass(selectedPackage.status)">{{ statusLabels[selectedPackage.status] }}</span>
        </header>

        <div class="resource-action-row">
          <el-button v-if="selectedPackage.status === 'STAGED'" type="primary" :loading="actionLoading" :icon="CircleCheck" @click="activatePackage">激活版本</el-button>
          <el-button v-if="selectedPackage.status === 'RETIRED'" type="warning" :loading="actionLoading" :icon="Refresh" @click="rollbackPackage">回滚到此版本</el-button>
          <el-button v-if="['ACTIVE', 'STAGED'].includes(selectedPackage.status)" :loading="actionLoading" :icon="Delete" @click="retirePackage">退役版本</el-button>
          <el-button v-if="['UPLOADED', 'REJECTED', 'VALIDATING'].includes(selectedPackage.status)" :loading="actionLoading" :icon="DocumentChecked" @click="runPreflight">重新预检</el-button>
          <el-button v-if="selectedPackage.archiveAsset" :icon="Download" @click="downloadArchive">下载归档</el-button>
        </div>

        <div class="resource-facts-grid">
          <div><small>最低平台版本</small><strong>{{ selectedPackage.minimumPlatformVersion }}</strong></div>
          <div><small>Schema 版本</small><strong>{{ selectedPackage.schemaVersion }}</strong></div>
          <div><small>签名密钥</small><strong>{{ selectedPackage.source === 'BUILT_IN' ? '内置信任' : selectedPackage.validation.signatureKeyId ?? '未通过' }}</strong></div>
          <div><small>最后校验</small><strong>{{ formatTime(selectedPackage.validation.validatedAt) }}</strong></div>
        </div>

        <section v-if="selectedShowProgram" class="resource-check-section">
          <header><div><strong>舞步轨迹摘要</strong><small>{{ selectedShowProgram.sourceSoftware }} · LOCAL ENU</small></div><el-icon><DocumentChecked /></el-icon></header>
          <div class="resource-facts-grid">
            <div><small>机群规模</small><strong>{{ selectedShowProgram.aircraftCount }} 架</strong></div>
            <div><small>程序时长</small><strong>{{ Math.round(selectedShowProgram.durationMs / 1000) }} 秒</strong></div>
            <div><small>高度包络</small><strong>{{ selectedShowProgram.maximumAltitudeMeters }} m</strong></div>
            <div><small>水平半径</small><strong>{{ selectedShowProgram.horizontalRadiusMeters }} m</strong></div>
          </div>
        </section>

        <section class="resource-check-section">
          <header><div><strong>预检清单</strong><small>{{ selectedPackage.validation.passed ? '所有必要检查均已通过' : '存在未通过的检查项' }}</small></div><el-icon><CircleCheck v-if="selectedPackage.validation.passed" /><CircleClose v-else /></el-icon></header>
          <div v-if="selectedPackage.validation.checks.length" class="resource-check-list">
            <div v-for="check in selectedPackage.validation.checks" :key="check.code"><el-icon :class="check.passed ? 'check-pass' : 'check-fail'"><component :is="check.passed ? CircleCheck : CircleClose" /></el-icon><span><strong>{{ check.code }}</strong><small>{{ check.message }}</small></span></div>
          </div>
          <p v-if="selectedPackage.validation.rejectionReason" class="resource-rejection">{{ selectedPackage.validation.rejectionReason }}</p>
        </section>

        <section class="resource-history-section">
          <header><strong>生命周期</strong><small>{{ detail?.lifecycle.length ?? 0 }} 条记录</small></header>
          <div v-if="detail?.lifecycle.length" class="resource-history-list">
            <div v-for="event in detail.lifecycle.slice(0, 6)" :key="event.id"><span>{{ event.action }}</span><strong>{{ formatTime(event.createdAt) }}</strong><small>{{ event.actorName }}<template v-if="event.reason"> · {{ event.reason }}</template></small></div>
          </div>
          <div v-else class="resource-history-empty">暂无生命周期记录</div>
        </section>

        <p v-if="latestValidation?.errorMessage" class="resource-last-error">最近一次预检：{{ latestValidation.errorMessage }}</p>
      </section>
    </div>

    <el-dialog v-model="trajectoryDialogVisible" title="导入外部舞步轨迹" width="min(560px, calc(100vw - 32px))" :close-on-click-modal="false">
      <el-form label-position="top">
        <div class="wizard-form-grid">
          <el-form-item label="程序名称"><el-input v-model="trajectoryForm.name" maxlength="120" /></el-form-item>
          <el-form-item label="版本"><el-input v-model="trajectoryForm.version" maxlength="40" placeholder="1.0.0" /></el-form-item>
        </div>
        <el-form-item label="来源舞步软件"><el-input v-model="trajectoryForm.sourceSoftware" maxlength="120" placeholder="填写生成轨迹的软件名称与版本" /></el-form-item>
        <el-form-item label="轨迹文件">
          <div class="resource-heading-actions">
            <el-button :icon="Upload" @click="chooseTrajectory">选择 CSV</el-button>
            <span>{{ trajectoryFile ? `${trajectoryFile.name} · ${(trajectoryFile.size / 1024).toFixed(1)} KB` : '尚未选择文件' }}</span>
          </div>
        </el-form-item>
        <section v-if="trajectoryPreview" class="trajectory-preview" aria-live="polite">
          <header><strong>导入前预览</strong><small>仅读取文件前 128 KB；提交时仍由服务端执行完整校验</small></header>
          <p v-if="trajectoryPreview.error" class="resource-rejection">{{ trajectoryPreview.error }}</p>
          <p v-else class="trajectory-preview-ok">字段预览通过：{{ trajectoryPreview.header.join('、') }}</p>
          <div v-if="trajectoryPreview.sampleRows.length" class="trajectory-preview-table" role="table" aria-label="舞步轨迹样例"><div class="trajectory-preview-row header" role="row"><span v-for="field in trajectoryPreview.header" :key="field">{{ field }}</span></div><div v-for="(row, index) in trajectoryPreview.sampleRows" :key="index" class="trajectory-preview-row" role="row"><span v-for="(value, cellIndex) in row" :key="cellIndex">{{ value || '—' }}</span></div></div>
          <small v-if="trajectoryPreview.truncated">文件较大，当前仅展示前几行预览。</small>
        </section>
      </el-form>
      <p class="resource-rejection">字段要求：aircraft_id、time_ms、east_m、north_m、up_m。坐标采用以表演区中心为原点的 ENU 米制坐标。</p>
      <template #footer><el-button :icon="Download" @click="downloadTrajectoryTemplate">下载 CSV 模板</el-button><el-button @click="trajectoryDialogVisible = false">取消</el-button><el-button type="primary" :loading="actionLoading" :disabled="trajectoryPreviewBlocksSubmit" @click="importTrajectory">校验并导入</el-button></template>
    </el-dialog>
  </div>
</template>
