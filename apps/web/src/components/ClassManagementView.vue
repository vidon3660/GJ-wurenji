<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { ArrowLeft, CirclePlus, Download, Edit, Refresh, Search, TrendCharts, Upload, User } from "@element-plus/icons-vue"
import type { ClassroomStudent, ClassroomSummary, SceneType, V3TeacherProgressItem, V3TeachingOverview } from "@wurenji/shared"
import { api } from "../api"
import { parseStudentCsv, type ParsedStudentRow } from "../student-import"
import { v3SceneClass, v3SceneShortLabel } from "../scene-presentation"
import { formatPlatformDate } from "../platform-date"

interface CourseSummary {
  id: string
  code: string
  name: string
  term: string
}

const props = defineProps<{ teachingOverview: V3TeachingOverview | null }>()
const emit = defineEmits<{ changed: []; createAssignment: []; editAssignment: [draftId: string, sceneType: SceneType]; viewProgress: []; project: [projectId: string] }>()
const classes = ref<ClassroomSummary[]>([])
const courses = ref<CourseSummary[]>([])
const students = ref<ClassroomStudent[]>([])
const selectedClassId = ref("")
const loading = ref(false)
const studentsLoading = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)
const importRows = ref<ParsedStudentRow[]>([])
const importVisible = ref(false)
const importing = ref(false)
const errorText = ref("")
const studentsErrorText = ref("")
const actionError = ref("")
const classVisible = ref(false)
const courseVisible = ref(false)
const classSaving = ref(false)
const courseSaving = ref(false)
let loadGeneration = 0
let studentLoadGeneration = 0
const classForm = reactive({ courseId: "", code: "", name: "" })
const courseForm = reactive({ code: "", name: "", term: "2026 秋季" })
const studentKeyword = ref("")
const activeClassView = ref<"students" | "assignments" | "completion" | "assignment-detail" | "assignment-progress" | "student-detail">("students")
const completionKeyword = ref("")
const completionAssignmentId = ref("")
const selectedProgressStudentId = ref("")
const selectedAssignmentId = ref("")
const selectedAssignmentProgressId = ref("")
const studentDetailKeyword = ref("")
const assignmentProgressKeyword = ref("")
const assignmentPage = ref(1)
const completionPage = ref(1)
const assignmentProgressPage = ref(1)
const assignmentPageSize = 8
const completionPageSize = 10
const assignmentProgressPageSize = 10
const progressItems = ref<V3TeacherProgressItem[]>([])
const progressLoading = ref(false)

const selectedClass = computed(() => classes.value.find((classroom) => classroom.id === selectedClassId.value) ?? null)
const classAssignments = computed(() => (props.teachingOverview?.assignments ?? [])
  .filter((assignment) => assignment.targetClassrooms?.some((classroom) => classroom.id === selectedClassId.value))
  .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)))
const selectedAssignment = computed(() => classAssignments.value.find((assignment) => assignment.id === selectedAssignmentId.value) ?? null)
const filteredStudents = computed(() => {
  const keyword = studentKeyword.value.trim().toLocaleLowerCase("zh-CN")
  if (!keyword) return students.value
  return students.value.filter((student) => `${student.displayName} ${student.email}`.toLocaleLowerCase("zh-CN").includes(keyword))
})
const classProgress = computed(() => {
  const assignmentIds = new Set(classAssignments.value.map((assignment) => assignment.id))
  const source = progressItems.value.length ? progressItems.value : (props.teachingOverview?.recentProgress ?? [])
  return source.filter((item) => assignmentIds.has(item.assignmentId))
})
const classProgressStats = computed(() => ({
  notStarted: classProgress.value.filter((item) => item.submissionState === "NOT_STARTED").length,
  inProgress: classProgress.value.filter((item) => item.submissionState === "IN_PROGRESS").length,
  submitted: classProgress.value.filter((item) => item.submissionState === "SUBMITTED").length,
  pending: classProgress.value.filter((item) => item.evaluationState === "PENDING").length
}))
const filteredClassProgress = computed(() => {
  const keyword = completionKeyword.value.trim().toLocaleLowerCase("zh-CN")
  return classProgress.value.filter((item) => {
    const matchesAssignment = !completionAssignmentId.value || item.assignmentId === completionAssignmentId.value
    const matchesKeyword = !keyword || `${item.studentName} ${item.assignmentDisplayTitle ?? item.assignmentTitle}`.toLocaleLowerCase("zh-CN").includes(keyword)
    return matchesAssignment && matchesKeyword
  })
})
const completionAssignmentRows = computed(() => classAssignments.value.map((assignment) => {
  const items = classProgress.value.filter((item) => item.assignmentId === assignment.id)
  return {
    assignment,
    items,
    notStarted: items.filter((item) => item.submissionState === "NOT_STARTED").length,
    inProgress: items.filter((item) => item.submissionState === "IN_PROGRESS").length,
    submitted: items.filter((item) => item.submissionState === "SUBMITTED").length,
    pending: items.filter((item) => item.evaluationState === "PENDING").length
  }
}))
const filteredCompletionAssignmentRows = computed(() => {
  const keyword = completionKeyword.value.trim().toLocaleLowerCase("zh-CN")
  return completionAssignmentRows.value.filter((row) => {
    const matchesAssignment = !completionAssignmentId.value || row.assignment.id === completionAssignmentId.value
    const matchesKeyword = !keyword || `${row.assignment.displayTitle ?? row.assignment.title} ${row.items.map((item) => item.studentName).join(" ")}`.toLocaleLowerCase("zh-CN").includes(keyword)
    return matchesAssignment && matchesKeyword
  })
})
const selectedAssignmentProgress = computed(() => classProgress.value.filter((item) => item.assignmentId === selectedAssignmentProgressId.value))
const selectedAssignmentProgressAssignment = computed(() => classAssignments.value.find((assignment) => assignment.id === selectedAssignmentProgressId.value) ?? null)
const filteredSelectedAssignmentProgress = computed(() => {
  const keyword = assignmentProgressKeyword.value.trim().toLocaleLowerCase("zh-CN")
  return selectedAssignmentProgress.value.filter((item) => !keyword || `${item.studentName} ${item.currentStageTitle} ${progressStatusLabel(item)}`.toLocaleLowerCase("zh-CN").includes(keyword))
})
const selectedStudentProgress = computed(() => selectedProgressStudentId.value
  ? classProgress.value.filter((item) => item.studentId === selectedProgressStudentId.value)
  : [])
const filteredSelectedStudentProgress = computed(() => {
  const keyword = studentDetailKeyword.value.trim().toLocaleLowerCase("zh-CN")
  return selectedStudentProgress.value.filter((item) => !keyword || `${item.assignmentDisplayTitle ?? item.assignmentTitle} ${item.currentStageTitle} ${progressStatusLabel(item)}`.toLocaleLowerCase("zh-CN").includes(keyword))
})
const paginatedClassAssignments = computed(() => classAssignments.value.slice((assignmentPage.value - 1) * assignmentPageSize, assignmentPage.value * assignmentPageSize))
const paginatedCompletionAssignmentRows = computed(() => filteredCompletionAssignmentRows.value.slice((completionPage.value - 1) * completionPageSize, completionPage.value * completionPageSize))
const paginatedSelectedAssignmentProgress = computed(() => filteredSelectedAssignmentProgress.value.slice((assignmentProgressPage.value - 1) * assignmentProgressPageSize, assignmentProgressPage.value * assignmentProgressPageSize))
const configLabels: Record<string, string> = {
  taskBrief: "任务说明",
  projectBackground: "项目背景",
  completionRequirements: "完成要求",
  scaleTemplateCode: "规模模板",
  regionPackageId: "预设区域",
  scenarioOverlayVersionId: "场景覆盖层",
  questionBankVersionId: "题库版本",
  showProgramPackageId: "表演方案",
  availableAt: "开放时间",
  dueAt: "截止时间",
  assessmentDurationMinutes: "考核时长（分钟）",
  allowResubmission: "允许重新提交",
  allowedValidationAttempts: "方案检查次数",
  allowedRuntimeAttempts: "仿真运行次数",
  plannedStartAt: "计划开始时间",
  plannedEndAt: "计划结束时间",
  contactName: "联系人",
  contactPhone: "联系电话",
  aircraftModel: "无人机型号",
  plannedAudienceCount: "预计观众人数",
  maximumHeightMeters: "最大高度（米）",
  mainLandingSiteId: "主起降点",
  aircraftModelCode: "航空器型号",
  aircraftParameterVersion: "航空器参数版本",
  taskObjectIds: "任务对象",
  taskAreaBoundary: "任务区域边界",
  openStageCodes: "开放阶段",
  evaluationItems: "评价项目",
  eventCodes: "事件编码",
  eventConfigs: "事件配置",
  simulationClockRate: "仿真时钟倍率",
  simulationStartLeadMinutes: "仿真提前分钟数",
  showInitialConditions: "表演初始环境",
  orderCount: "订单数量",
  orderReleaseMode: "订单释放方式",
  orderReleasePhase: "订单释放阶段",
  priorityProfile: "优先级策略",
  deliveryDistributionMode: "配送分布方式",
  candidateDeliveryPointIds: "候选配送点",
  timeWindowProfile: "时间窗策略",
  orderSeed: "订单随机种子",
  initialUnavailableAircraftCount: "初始不可用航空器",
  initialLowBatteryAircraftCount: "初始低电量航空器",
  initialStandbyAircraftCount: "初始待命航空器",
  initialPreflightAbnormalAircraftCount: "初始检查异常航空器",
  initialWindDirection: "初始风向",
  initialWindForceState: "初始风力",
  initialGustState: "初始阵风",
  initialRainState: "初始降雨",
  initialPositioningState: "初始定位状态",
  initialCommunicationState: "初始通信状态"
}

function configValueLabel(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "未设置"
  if (typeof value === "boolean") return value ? "是" : "否"
  if (typeof value === "number" || typeof value === "string") {
    if (typeof value === "string" && /At$/.test(key)) return formatDate(value)
    return String(value)
  }
  if (Array.isArray(value)) return value.length ? `${value.length} 项` : "无"
  if (typeof value === "object") return `${Object.keys(value as Record<string, unknown>).length} 项配置`
  return String(value)
}

function configFields(value: unknown): Array<{ key: string; label: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => ({ key, label: configLabels[key] ?? key, value: configValueLabel(key, item) }))
}

const selectedAssignmentConfigSections = computed(() => {
  const config = selectedAssignment.value?.config as Record<string, unknown> | undefined
  if (!config) return []
  const parameterKey = selectedAssignment.value?.sceneType === "CITY_SHOW" ? "showParameters" : selectedAssignment.value?.sceneType === "CITY_LOGISTICS" ? "logisticsParameters" : "vtlParameters"
  return [
    { title: "基础配置", fields: configFields(config).filter((item) => !["showParameters", "logisticsParameters", "vtlParameters", "scenario"].includes(item.key)) },
    { title: "场景初始化", fields: configFields(config[parameterKey]) },
    { title: "事件与运行规则", fields: configFields(config.scenario) }
  ].filter((section) => section.fields.length)
})

onMounted(async () => {
  await loadAll()
  await loadProgress()
})

watch(activeClassView, (view) => {
  if (view === "completion" && !progressItems.value.length) void loadProgress()
})

watch([completionKeyword, completionAssignmentId], () => { completionPage.value = 1 })
watch(assignmentProgressKeyword, () => { assignmentProgressPage.value = 1 })

async function loadAll() {
  const generation = ++loadGeneration
  loading.value = true
  errorText.value = ""
  try {
    const [loadedClasses, loadedCourses] = await Promise.all([
      api<ClassroomSummary[]>("/v1/education/classes"),
      api<CourseSummary[]>("/v1/education/courses")
    ])
    if (generation !== loadGeneration) return
    classes.value = loadedClasses
    courses.value = loadedCourses
    selectedClassId.value ||= loadedClasses[0]?.id ?? ""
    classForm.courseId ||= loadedCourses[0]?.id ?? ""
    await loadStudents()
  } catch (error) {
    if (generation !== loadGeneration) return
    errorText.value = error instanceof Error ? error.message : "班级信息加载失败"
    ElMessage.error(errorText.value)
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

async function loadStudents() {
  const generation = ++studentLoadGeneration
  const classId = selectedClassId.value
  studentsErrorText.value = ""
  if (!selectedClassId.value) {
    students.value = []
    studentsLoading.value = false
    return
  }
  studentsLoading.value = true
  try {
    const loadedStudents = await api<ClassroomStudent[]>(`/v1/education/classes/${classId}/students`)
    if (generation === studentLoadGeneration && classId === selectedClassId.value) students.value = loadedStudents
  } catch (error) {
    if (generation !== studentLoadGeneration || classId !== selectedClassId.value) return
    studentsErrorText.value = error instanceof Error ? error.message : "学生名单加载失败"
    ElMessage.error(studentsErrorText.value)
  } finally {
    if (generation === studentLoadGeneration) studentsLoading.value = false
  }
}

async function selectClass(id: string) {
  selectedClassId.value = id
  activeClassView.value = "students"
  studentKeyword.value = ""
  completionKeyword.value = ""
  completionAssignmentId.value = ""
  selectedProgressStudentId.value = ""
  selectedAssignmentId.value = ""
  selectedAssignmentProgressId.value = ""
  assignmentProgressKeyword.value = ""
  assignmentPage.value = 1
  completionPage.value = 1
  assignmentProgressPage.value = 1
  errorText.value = ""
  await loadStudents()
}

async function createCourse() {
  if (!courseForm.code.trim() || !courseForm.name.trim() || !courseForm.term.trim()) {
    ElMessage.warning("请填写课程代码、课程名称和学期")
    return
  }
  courseSaving.value = true
  actionError.value = ""
  try {
    const course = await api<CourseSummary>("/v1/education/courses", { method: "POST", body: JSON.stringify(courseForm) })
    courses.value.unshift(course)
    classForm.courseId = course.id
    courseVisible.value = false
    Object.assign(courseForm, { code: "", name: "", term: "2026 秋季" })
    ElMessage.success("课程已创建")
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "课程创建失败"
    ElMessage.error(actionError.value)
  } finally {
    courseSaving.value = false
  }
}

async function createClass() {
  if (!classForm.courseId || !classForm.code.trim() || !classForm.name.trim()) {
    ElMessage.warning("请选择所属课程，并填写班级代码和班级名称")
    return
  }
  classSaving.value = true
  actionError.value = ""
  try {
    const classroom = await api<ClassroomSummary>("/v1/education/classes", { method: "POST", body: JSON.stringify(classForm) })
    classes.value.unshift(classroom)
    selectedClassId.value = classroom.id
    classVisible.value = false
    Object.assign(classForm, { courseId: courses.value[0]?.id ?? "", code: "", name: "" })
    students.value = []
    emit("changed")
    ElMessage.success("班级已创建")
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "班级创建失败"
    ElMessage.error(actionError.value)
  } finally {
    classSaving.value = false
  }
}

async function readCsv(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ""
  if (!file) return
  try {
    importRows.value = parseStudentCsv(await file.text())
    importVisible.value = true
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "CSV 解析失败"
    ElMessage.error(actionError.value)
  }
}

async function importStudents() {
  if (!selectedClassId.value) return
  importing.value = true
  actionError.value = ""
  try {
    const result = await api<{ received: number; created: number; added: number }>(`/v1/education/classes/${selectedClassId.value}/students/import`, {
      method: "POST",
      body: JSON.stringify({ students: importRows.value })
    })
    importVisible.value = false
    await loadAll()
    emit("changed")
    ElMessage.success(`已加入 ${result.added} 名学生，其中新建账号 ${result.created} 个`)
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : "学生导入失败"
    ElMessage.error(actionError.value)
  } finally {
    importing.value = false
  }
}

function downloadTemplate() {
  const content = "\uFEFF邮箱,姓名,初始密码\nstudent3@demo.local,王同学,请填写至少8位密码\n"
  const anchor = document.createElement("a")
  anchor.href = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }))
  anchor.download = "学生导入模板.csv"
  anchor.click()
  URL.revokeObjectURL(anchor.href)
}

async function loadProgress() {
  progressLoading.value = true
  try {
    const value = await api<{ items: V3TeacherProgressItem[] }>("/v3/teaching/progress?page=1&pageSize=100")
    progressItems.value = value.items
  } catch {
    progressItems.value = []
  } finally {
    progressLoading.value = false
  }
}

function progressStatusLabel(item: Pick<V3TeacherProgressItem, "submissionState" | "evaluationState">) {
  if (item.evaluationState === "PENDING") return "待评价"
  if (item.submissionState === "SUBMITTED") return "已提交"
  if (item.submissionState === "IN_PROGRESS") return "正在进行"
  return "尚未开始"
}

function openAssignmentProgress(assignmentId: string) {
  selectedAssignmentProgressId.value = assignmentId
  assignmentProgressKeyword.value = ""
  assignmentProgressPage.value = 1
  activeClassView.value = "assignment-progress"
}

function openCompletionAssignment(row: { assignment: { id: string } }) {
  openAssignmentProgress(row.assignment.id)
}

function selectedStudentName() {
  return students.value.find((student) => student.id === selectedProgressStudentId.value)?.displayName
    ?? classProgress.value.find((item) => item.studentId === selectedProgressStudentId.value)?.studentName
    ?? "学生"
}

function assignmentStatusLabel(status: string) {
  if (status === "DRAFT") return "草稿"
  if (status === "PUBLISHED") return "已发布"
  if (status === "IN_PROGRESS") return "进行中"
  if (status === "ENDED") return "已结束"
  return "已归档"
}

function formatDate(value: string) {
  return formatPlatformDate(value)
}
</script>

<template>
  <div class="education-page class-page" v-loading="loading">
    <header class="page-heading"><div><span>教学组织</span><h1>班级与学生</h1></div><div class="heading-actions"><el-button @click="courseVisible = true">新建课程</el-button><el-button type="primary" :icon="CirclePlus" @click="classVisible = true">新建班级</el-button></div></header>
    <div v-if="errorText" class="class-page-error" role="alert"><strong>班级数据同步失败</strong><span>{{ errorText }}，页面仍保留上一次成功加载的数据。</span><el-button text :icon="Refresh" :loading="loading" :disabled="loading" @click="loadAll">重新加载</el-button></div>
    <div v-if="actionError" class="class-page-error class-action-error" role="alert" aria-live="assertive"><strong>操作未完成</strong><span>{{ actionError }}，当前已加载的数据未被清除。</span><el-button text @click="actionError = ''">关闭</el-button></div>
    <div class="class-layout">
      <aside class="class-list">
        <button v-for="classroom in classes" :key="classroom.id" type="button" :class="{ active: classroom.id === selectedClassId }" :aria-pressed="classroom.id === selectedClassId" @click="selectClass(classroom.id)">
          <span>{{ classroom.code }}</span><strong>{{ classroom.name }}</strong><small>{{ classroom.studentCount }} 名学生 · {{ classroom.term }}</small>
        </button>
        <div v-if="classes.length === 0" class="section-empty"><el-icon><User /></el-icon><strong>暂无班级</strong><span>先创建课程和教学班级</span><div class="section-empty-actions"><el-button size="small" @click="courseVisible = true">新建课程</el-button><el-button type="primary" size="small" :icon="CirclePlus" @click="classVisible = true">新建班级</el-button></div></div>
      </aside>

      <main class="class-detail">
        <header><div><h2>{{ selectedClass?.name ?? '请选择班级' }}</h2><p>{{ selectedClass?.courseName }} · {{ selectedClass?.term }}</p></div><div class="heading-actions"><el-button v-if="activeClassView === 'students'" :icon="Download" @click="downloadTemplate">导入模板</el-button><el-button v-if="activeClassView === 'students'" :icon="Upload" :disabled="!selectedClass" @click="fileInput?.click()">导入学生</el-button><input ref="fileInput" class="visually-hidden" type="file" accept=".csv,text/csv" @change="readCsv" /></div></header>
        <nav class="class-view-tabs" aria-label="班级管理视图"><button type="button" :class="{ active: activeClassView === 'students' }" @click="activeClassView = 'students'">学生名单</button><button type="button" :class="{ active: activeClassView === 'assignments' }" @click="activeClassView = 'assignments'">班级任务 <small>{{ classAssignments.length }}</small></button><button type="button" :class="{ active: activeClassView === 'completion' }" @click="activeClassView = 'completion'">任务完成情况</button></nav>
        <section v-if="activeClassView === 'students'" class="class-view-panel">
          <div class="student-list-toolbar"><div><strong>学生名单</strong><span>{{ filteredStudents.length }} / {{ students.length }} 人</span><span v-if="studentsLoading" role="status">正在加载...</span></div><el-input v-model="studentKeyword" :prefix-icon="Search" clearable aria-label="搜索当前班级学生" placeholder="搜索姓名或邮箱" /></div>
          <div v-if="studentsErrorText" class="class-page-error class-action-error" role="alert"><strong>学生名单加载失败</strong><span>{{ studentsErrorText }}，当前班级和实训数据仍可使用。</span><el-button text :icon="Refresh" :loading="studentsLoading" :disabled="studentsLoading" @click="loadStudents">重新加载</el-button></div>
          <div v-if="selectedClass && !studentsLoading && !studentsErrorText && students.length === 0 && !studentKeyword.trim()" class="inline-empty student-empty-hint"><span>该班级还没有学生，可以先下载模板或直接导入名单。</span><div><el-button text size="small" :icon="Download" @click="downloadTemplate">下载导入模板</el-button><el-button text size="small" :icon="Upload" @click="fileInput?.click()">导入学生</el-button></div></div>
          <el-table :data="filteredStudents" :empty-text="studentsLoading ? '正在加载学生名单...' : studentKeyword.trim() ? '没有匹配的学生' : '班级中暂无学生'" height="330"><el-table-column prop="displayName" label="学生" min-width="140" /><el-table-column prop="email" label="账号邮箱" min-width="240" /><el-table-column label="加入时间" width="170"><template #default="scope">{{ formatDate(scope.row.joinedAt) }}</template></el-table-column></el-table>
        </section>
        <section v-else-if="activeClassView === 'assignments'" class="class-view-panel class-assignments">
          <header><div><h3>发布到此班级的任务</h3><span>{{ classAssignments.length }} 项</span></div></header>
          <div v-for="assignment in paginatedClassAssignments" :key="assignment.id" class="class-assignment-row">
            <button type="button" class="assignment-open class-assignment-summary" @click="selectedAssignmentId = assignment.id; activeClassView = 'assignment-detail'">
              <span class="scene-code" :class="v3SceneClass(assignment.sceneType)">{{ v3SceneShortLabel(assignment.sceneType) }}</span>
              <span><strong>{{ assignment.displayTitle || assignment.title }}</strong><small>{{ assignment.mode === 'TRAINING' ? '训练' : '考核' }} · {{ assignmentStatusLabel(assignment.status) }} · 更新于 {{ formatDate(assignment.updatedAt) }}</small></span>
              <span><strong>{{ assignment.summary.submittedProjectCount }}/{{ assignment.summary.projectCount }}</strong><small>已提交</small></span>
            </button>
            <el-tooltip :content="assignment.status === 'DRAFT' ? '编辑任务' : '查看学生进度'" placement="top"><button type="button" class="assignment-tool" :aria-label="assignment.status === 'DRAFT' ? '编辑任务' : '查看学生进度'" @click.stop="assignment.status === 'DRAFT' ? emit('editAssignment', assignment.id, assignment.sceneType) : (activeClassView = 'completion', completionAssignmentId = assignment.id)"><el-icon><component :is="assignment.status === 'DRAFT' ? Edit : TrendCharts" /></el-icon></button></el-tooltip>
          </div>
          <div v-if="classAssignments.length === 0" class="inline-empty">该班级暂无任务</div>
          <el-pagination v-if="classAssignments.length > assignmentPageSize" v-model:current-page="assignmentPage" class="class-pagination" background layout="prev, pager, next" :page-size="assignmentPageSize" :total="classAssignments.length" />
        </section>
        <section v-else-if="activeClassView === 'assignment-progress'" class="class-view-panel detail-view-panel assignment-progress">
          <div v-if="selectedAssignmentProgressAssignment" class="detail-view-content">
            <header class="detail-view-heading"><el-button text :icon="ArrowLeft" @click="activeClassView = 'completion'">返回任务完成情况</el-button><div><span>任务学生进度</span><h3>{{ selectedAssignmentProgressAssignment.displayTitle || selectedAssignmentProgressAssignment.title }}</h3><p>{{ v3SceneShortLabel(selectedAssignmentProgressAssignment.sceneType) }} · {{ selectedClass?.name ?? '当前班级' }}</p></div></header>
            <div class="detail-summary-grid"><div><span>学生项目</span><strong>{{ selectedAssignmentProgress.length }}</strong></div><div><span>尚未开始</span><strong>{{ selectedAssignmentProgress.filter((item) => item.submissionState === 'NOT_STARTED').length }}</strong></div><div><span>正在进行</span><strong>{{ selectedAssignmentProgress.filter((item) => item.submissionState === 'IN_PROGRESS').length }}</strong></div><div><span>已提交</span><strong>{{ selectedAssignmentProgress.filter((item) => item.submissionState === 'SUBMITTED').length }}</strong></div><div><span>待评价</span><strong>{{ selectedAssignmentProgress.filter((item) => item.evaluationState === 'PENDING').length }}</strong></div></div>
            <div class="completion-toolbar"><el-input v-model="assignmentProgressKeyword" :prefix-icon="Search" clearable placeholder="搜索学生、阶段或状态" aria-label="搜索任务学生进度" /></div>
            <el-table :data="paginatedSelectedAssignmentProgress" :empty-text="assignmentProgressKeyword ? '没有匹配的学生项目' : '该任务暂无学生项目'" @row-click="(item: V3TeacherProgressItem) => emit('project', item.projectId)"><el-table-column prop="studentName" label="学生" min-width="160" /><el-table-column prop="currentStageTitle" label="当前阶段" min-width="200" /><el-table-column label="实训状态" width="130"><template #default="scope"><span class="progress-state" :class="scope.row.submissionState.toLowerCase()">{{ progressStatusLabel(scope.row) }}</span></template></el-table-column><el-table-column label="最近活动" width="180"><template #default="scope">{{ formatDate(scope.row.lastActivityAt) }}</template></el-table-column><el-table-column label="操作" width="120"><template #default="scope"><el-button text :icon="TrendCharts" @click.stop="emit('project', scope.row.projectId)">查看实训</el-button></template></el-table-column></el-table>
            <el-pagination v-if="filteredSelectedAssignmentProgress.length > assignmentProgressPageSize" v-model:current-page="assignmentProgressPage" class="class-pagination" background layout="prev, pager, next" :page-size="assignmentProgressPageSize" :total="filteredSelectedAssignmentProgress.length" />
          </div>
          <div v-else class="inline-empty">任务不存在或已被移除</div>
        </section>
        <section v-else-if="activeClassView === 'assignment-detail'" class="class-view-panel detail-view-panel">
          <div v-if="selectedAssignment" class="detail-view-content">
            <header class="detail-view-heading"><el-button text :icon="ArrowLeft" @click="activeClassView = 'assignments'">返回班级任务</el-button><div><span>班级任务详情</span><h3>{{ selectedAssignment.displayTitle || selectedAssignment.title }}</h3><p>{{ v3SceneShortLabel(selectedAssignment.sceneType) }} · {{ selectedAssignment.mode === 'TRAINING' ? '训练' : '考核' }}</p></div></header>
            <div class="detail-fact-grid"><div><span>状态</span><strong>{{ assignmentStatusLabel(selectedAssignment.status) }}</strong></div><div><span>修订号</span><strong>v{{ selectedAssignment.revision }}</strong></div><div><span>创建时间</span><strong>{{ formatDate(selectedAssignment.createdAt) }}</strong></div><div><span>更新时间</span><strong>{{ formatDate(selectedAssignment.updatedAt) }}</strong></div><div class="detail-fact-wide"><span>目标班级</span><strong>{{ selectedClass?.name ?? '当前班级' }}</strong></div></div>
            <div class="detail-summary-grid"><div><span>任务总数</span><strong>{{ selectedAssignment.summary.projectCount }}</strong></div><div><span>尚未开始</span><strong>{{ selectedAssignment.summary.notStartedProjectCount }}</strong></div><div><span>正在进行</span><strong>{{ selectedAssignment.summary.inProgressProjectCount }}</strong></div><div><span>已提交</span><strong>{{ selectedAssignment.summary.submittedProjectCount }}</strong></div><div><span>待评价</span><strong>{{ selectedAssignment.summary.pendingEvaluationCount }}</strong></div><div><span>告警</span><strong>{{ selectedAssignment.summary.openAlertCount }}</strong></div></div>
            <section class="assignment-config-form"><header><strong>创建时配置</strong><span>只读查看任务初始化参数</span></header><div v-for="section in selectedAssignmentConfigSections" :key="section.title" class="assignment-config-section"><h4>{{ section.title }}</h4><dl><div v-for="field in section.fields" :key="field.key"><dt>{{ field.label }}</dt><dd>{{ field.value }}</dd></div></dl></div></section>
          </div>
          <div v-else class="inline-empty">任务不存在或已被移除</div>
        </section>
        <section v-else-if="activeClassView === 'student-detail'" class="class-view-panel detail-view-panel">
          <div class="detail-view-content"><header class="detail-view-heading"><el-button text :icon="ArrowLeft" @click="activeClassView = 'completion'">返回任务完成情况</el-button><div><span>学生任务明细</span><h3>{{ selectedStudentName() }}</h3><p>{{ selectedStudentProgress.length }} 项任务 · {{ selectedClass?.name ?? '当前班级' }}</p></div></header><div class="student-detail-toolbar"><el-input v-model="studentDetailKeyword" :prefix-icon="Search" clearable placeholder="搜索任务、阶段或状态" aria-label="搜索学生任务明细" /></div><el-table :data="filteredSelectedStudentProgress" :empty-text="studentDetailKeyword ? '没有匹配的任务' : '该学生暂无任务记录'"><el-table-column label="任务" min-width="240"><template #default="scope">{{ scope.row.assignmentDisplayTitle || scope.row.assignmentTitle }}</template></el-table-column><el-table-column prop="currentStageTitle" label="当前阶段" min-width="180" /><el-table-column label="状态" width="110"><template #default="scope"><span class="progress-state" :class="scope.row.submissionState.toLowerCase()">{{ progressStatusLabel(scope.row) }}</span></template></el-table-column><el-table-column label="最近活动" width="170"><template #default="scope">{{ formatDate(scope.row.lastActivityAt) }}</template></el-table-column></el-table></div>
        </section>
        <section v-else class="class-view-panel class-completion-panel">
          <div class="class-stat-grid"><button type="button" class="class-stat-card" @click="completionKeyword = ''; completionAssignmentId = ''"><span>尚未开始</span><strong>{{ classProgressStats.notStarted }}</strong></button><button type="button" class="class-stat-card" @click="completionKeyword = ''; completionAssignmentId = ''"><span>正在进行</span><strong>{{ classProgressStats.inProgress }}</strong></button><button type="button" class="class-stat-card" @click="completionKeyword = ''; completionAssignmentId = ''"><span>已提交</span><strong>{{ classProgressStats.submitted }}</strong></button><button type="button" class="class-stat-card" @click="completionKeyword = ''; completionAssignmentId = ''"><span>待评价</span><strong>{{ classProgressStats.pending }}</strong></button></div>
          <div class="completion-toolbar"><el-input v-model="completionKeyword" :prefix-icon="Search" clearable placeholder="搜索学生或任务" aria-label="搜索学生或任务" /><el-select v-model="completionAssignmentId" clearable placeholder="全部任务" aria-label="按任务筛选"><el-option v-for="assignment in classAssignments" :key="assignment.id" :label="assignment.displayTitle || assignment.title" :value="assignment.id" /></el-select></div>
          <el-table :data="paginatedCompletionAssignmentRows" :empty-text="progressLoading ? '正在加载任务进度...' : '当前班级暂无任务进度'" @row-click="openCompletionAssignment"><el-table-column label="任务" min-width="260"><template #default="scope"><strong>{{ scope.row.assignment.displayTitle || scope.row.assignment.title }}</strong><small class="completion-task-meta">{{ v3SceneShortLabel(scope.row.assignment.sceneType) }} · {{ assignmentStatusLabel(scope.row.assignment.status) }}</small></template></el-table-column><el-table-column label="学生项目" width="110"><template #default="scope">{{ scope.row.items.length }}</template></el-table-column><el-table-column label="尚未开始" width="110"><template #default="scope">{{ scope.row.notStarted }}</template></el-table-column><el-table-column label="正在进行" width="110"><template #default="scope">{{ scope.row.inProgress }}</template></el-table-column><el-table-column label="已提交" width="100"><template #default="scope">{{ scope.row.submitted }}</template></el-table-column><el-table-column label="待评价" width="100"><template #default="scope">{{ scope.row.pending }}</template></el-table-column><el-table-column label="操作" width="130"><template #default="scope"><el-button text :icon="TrendCharts" @click.stop="openAssignmentProgress(scope.row.assignment.id)">查看进度</el-button></template></el-table-column></el-table>
          <el-pagination v-if="filteredCompletionAssignmentRows.length > completionPageSize" v-model:current-page="completionPage" class="class-pagination" background layout="prev, pager, next" :page-size="completionPageSize" :total="filteredCompletionAssignmentRows.length" />
        </section>
      </main>
    </div>

    <el-dialog v-model="courseVisible" title="新建课程" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><div class="form-grid"><el-form-item label="课程代码"><el-input v-model="courseForm.code" placeholder="UAV-SIM-2026" /></el-form-item><el-form-item label="学期"><el-input v-model="courseForm.term" /></el-form-item></div><el-form-item label="课程名称"><el-input v-model="courseForm.name" /></el-form-item></el-form><template #footer><el-button :disabled="courseSaving" @click="courseVisible = false">取消</el-button><el-button type="primary" :loading="courseSaving" @click="createCourse">{{ courseSaving ? '创建中...' : '创建课程' }}</el-button></template></el-dialog>
    <el-dialog v-model="classVisible" title="新建班级" width="min(520px, calc(100vw - 32px))"><el-form label-position="top"><el-form-item label="所属课程"><el-select v-model="classForm.courseId" class="full-input"><el-option v-for="course in courses" :key="course.id" :label="`${course.name} · ${course.term}`" :value="course.id" /></el-select></el-form-item><div class="form-grid"><el-form-item label="班级代码"><el-input v-model="classForm.code" placeholder="LOW-2402" /></el-form-item><el-form-item label="班级名称"><el-input v-model="classForm.name" placeholder="低空 2402" /></el-form-item></div></el-form><template #footer><el-button :disabled="classSaving" @click="classVisible = false">取消</el-button><el-button type="primary" :loading="classSaving" @click="createClass">{{ classSaving ? '创建中...' : '创建班级' }}</el-button></template></el-dialog>
    <el-dialog v-model="importVisible" title="确认导入学生" width="min(720px, calc(100vw - 32px))"><p class="dialog-note">将以下 {{ importRows.length }} 名学生加入 {{ selectedClass?.name }}。请为每名学生填写至少 8 位初始密码。</p><el-table :data="importRows" max-height="360"><el-table-column prop="displayName" label="姓名" width="150" /><el-table-column prop="email" label="邮箱" min-width="260" /><el-table-column prop="password" label="初始密码" width="150" /></el-table><template #footer><el-button @click="importVisible = false">取消</el-button><el-button type="primary" :loading="importing" @click="importStudents">确认导入</el-button></template></el-dialog>
  </div>
</template>
