<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { ArrowRight, Collection, MapLocation, MoreFilled, Plus, Search } from "@element-plus/icons-vue"
import { ElMessage, ElMessageBox } from "element-plus"
import type {
  AssignmentDraftStatus,
  AssignmentDraftView,
  AssignmentUpgradePreviewView,
  AssignmentUpgradeResultView,
  AuthUser,
  ClassroomSummary,
  SceneType,
  StudentProjectView,
  V3TeachingAssignmentView,
  V3TeachingMetric,
  V3TeachingOverview
} from "@wurenji/shared"
import { api } from "../api"
import {
  filterStudentProjects,
  firstStudentSceneWithProjects,
  studentTaskCategories,
  studentTaskCategory,
  studentTaskCategoryLabels,
  studentProjectCurrentStage,
  studentProjectIsInternal,
  studentProjectTitle,
  studentProjectStatusLabel,
  sortStudentProjects,
} from "../student-task-presentation"
import { v3SceneClass, v3SceneLabel, v3ScenePresentation, v3SceneShortLabel, v3SceneTypes } from "../scene-presentation"
import { assignmentQueuePriority, teacherAssignmentIsInternal, teacherAssignmentMatchesDateRange, teacherAssignmentMatchesSearch, teacherAssignmentTitle, type TeacherAssignmentDataFilter } from "../teacher-assignment-presentation"
import { formatPlatformDate } from "../platform-date"

const props = defineProps<{
  user: AuthUser
  classrooms: ClassroomSummary[]
  teachingOverview: V3TeachingOverview | null
  studentProjects: StudentProjectView[]
  loading: boolean
  errorMessage?: string
  teacherAssignmentFocus?: AssignmentDraftStatus | ""
  teacherIncludeInternalData?: boolean
  studentIncludeInternalData?: boolean
  teacherView?: "overview" | "assignments"
  studentView?: "overview" | "scene"
  initialSceneType?: SceneType
}>()

const emit = defineEmits<{
  navigate: [view: "regions" | "progress" | "classes" | "assignments"]
  studentScene: [sceneType: SceneType]
  project: [projectId: string]
  createAssignment: [sceneType: SceneType]
  editAssignment: [draftId: string, sceneType: SceneType]
  teacherMetric: [key: V3TeachingMetric["key"]]
  teacherDataScopeChanged: [includeInternalData: boolean]
  assignmentsChanged: []
  retry: []
}>()

const activeScene = ref<SceneType>(props.initialSceneType ?? "CITY_SHOW")
const taskSearch = ref("")
const studentStatusFilter = ref<"ALL" | (typeof studentTaskCategories)[number]>("ALL")
const includeInternalProjects = ref(false)
const projectPage = ref(1)
const projectPageSize = 20
const assignmentStatusFilter = ref<AssignmentDraftStatus | "">(props.teacherAssignmentFocus ?? "")
const assignmentSceneFilter = ref<SceneType | "">("")
const assignmentClassFilter = ref("")
const assignmentDataFilter = ref<TeacherAssignmentDataFilter>("FORMAL")
const assignmentSearch = ref("")
const assignmentDateRange = ref<[Date, Date] | null>(null)
const assignmentPage = ref(1)
const assignmentPageSize = 8
const timingNow = ref(Date.now())
let timingTimer: number | null = null
const isStudent = computed(() => props.user.role === "student")
const teacherView = computed(() => props.teacherView ?? "overview")
const isTeacherLibrary = computed(() => !isStudent.value && teacherView.value === "assignments")
const studentView = computed(() => props.studentView ?? "overview")
const isStudentOverview = computed(() => isStudent.value && studentView.value === "overview")
const studentProjectPool = computed(() => props.studentProjects.filter((project) => includeInternalProjects.value || !studentProjectIsInternal(project)))
const sceneProjects = computed(() => studentProjectPool.value.filter((project) => project.sceneType === activeScene.value))
const sceneOptions = v3SceneTypes.map((type) => v3ScenePresentation[type])
const studentSceneLabels: Record<SceneType, string> = {
  CITY_SHOW: "城市无人机编队表演场景",
  CITY_LOGISTICS: "城市低空物流场景",
  VTOL_INSPECTION: "垂起广域巡检场景"
}
const visibleSceneProjects = computed(() => sortStudentProjects(
  [...filterStudentProjects(sceneProjects.value, studentStatusFilter.value)]
    .filter(projectMatchesSearch),
  "ATTENTION",
  timingNow.value
))
const displayedSceneProjects = computed(() => visibleSceneProjects.value.slice(0, projectPage.value * projectPageSize))
const hasMoreProjects = computed(() => displayedSceneProjects.value.length < visibleSceneProjects.value.length)
function sceneProjectCount(type: SceneType) {
  return props.studentProjects.filter((project) => project.sceneType === type && (includeInternalProjects.value || !studentProjectIsInternal(project))).length
}
const v3Assignments = computed(() => props.teachingOverview?.assignments ?? props.teachingOverview?.drafts ?? [])
const assignmentClassOptions = computed(() => {
  const classes = new Map<string, { id: string; label: string }>()
  for (const assignment of v3Assignments.value) {
    for (const classroom of assignment.targetClassrooms ?? []) {
      classes.set(classroom.id, { id: classroom.id, label: `${classroom.name} · ${classroom.code}` })
    }
  }
  return [...classes.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN"))
})
const visibleV3Assignments = computed(() => v3Assignments.value
  .filter((assignment) => assignmentDataFilter.value === "INTERNAL" ? teacherAssignmentIsInternal(assignment) : !teacherAssignmentIsInternal(assignment))
  .filter((assignment) => !assignmentStatusFilter.value || assignment.status === assignmentStatusFilter.value)
  .filter((assignment) => !assignmentSceneFilter.value || assignment.sceneType === assignmentSceneFilter.value)
  .filter((assignment) => !assignmentClassFilter.value || (assignment.targetClassrooms ?? []).some((classroom) => classroom.id === assignmentClassFilter.value))
  .filter((assignment) => teacherAssignmentMatchesDateRange(assignment, assignmentDateRange.value))
  .filter((assignment) => teacherAssignmentMatchesSearch(assignment, assignmentSearch.value, sceneLabel(assignment.sceneType)))
  .sort((left, right) => {
    const leftPriority = assignmentQueuePriority(left)
    const rightPriority = assignmentQueuePriority(right)
    const priorityDifference = leftPriority[0] - rightPriority[0] || leftPriority[1] - rightPriority[1]
    return priorityDifference || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  }))
const assignmentFilterSummary = computed(() => {
  const filters: string[] = []
  if (assignmentStatusFilter.value) filters.push(assignmentStatusLabel(assignmentStatusFilter.value))
  if (assignmentSceneFilter.value) filters.push(sceneLabel(assignmentSceneFilter.value))
  if (assignmentClassFilter.value) filters.push(assignmentClassOptions.value.find((item) => item.id === assignmentClassFilter.value)?.label ?? "指定教学班")
  if (assignmentSearch.value.trim()) filters.push(`关键词“${assignmentSearch.value.trim()}”`)
  if (assignmentDateRange.value) filters.push("最近更新时间")
  if (assignmentDataFilter.value === "INTERNAL") filters.push("演示/验收数据")
  return filters.length ? `当前筛选：${filters.join(" · ")}` : "优先处理待发布、待评价和风险任务"
})
const displayedV3Assignments = computed(() => visibleV3Assignments.value.slice(0, assignmentPage.value * assignmentPageSize))
const hasMoreV3Assignments = computed(() => displayedV3Assignments.value.length < visibleV3Assignments.value.length)
watch([activeScene, taskSearch, includeInternalProjects], () => { projectPage.value = 1 })
watch(studentStatusFilter, () => { projectPage.value = 1 })
watch(() => props.initialSceneType, (value) => {
  if (value && isStudent.value && studentView.value === "scene") activeScene.value = value
}, { immediate: true })
watch([() => props.studentProjects, includeInternalProjects], () => {
  if (!isStudent.value || studentView.value !== "overview" || props.initialSceneType) return
  const currentSceneHasProjects = props.studentProjects.some((project) => (
    project.sceneType === activeScene.value && (includeInternalProjects.value || !studentProjectIsInternal(project))
  ))
  if (currentSceneHasProjects) return
  const nextScene = firstStudentSceneWithProjects(props.studentProjects, includeInternalProjects.value)
  if (nextScene) activeScene.value = nextScene
}, { immediate: true })
watch([assignmentStatusFilter, assignmentSceneFilter, assignmentClassFilter, assignmentDataFilter, assignmentSearch, assignmentDateRange], () => { assignmentPage.value = 1 })
watch(() => props.teacherAssignmentFocus, (value) => { assignmentStatusFilter.value = value ?? "" })
watch(() => props.teacherIncludeInternalData, (value) => {
  assignmentDataFilter.value = value ? "INTERNAL" : "FORMAL"
})
watch(assignmentDataFilter, (value) => {
  if (!isStudent.value) emit("teacherDataScopeChanged", value === "INTERNAL")
})

onMounted(() => {
  timingTimer = window.setInterval(() => { timingNow.value = Date.now() }, 15_000)
})

onBeforeUnmount(() => {
  if (timingTimer !== null) window.clearInterval(timingTimer)
})

function sceneLabel(type: SceneType) {
  return v3SceneLabel(type)
}

function studentSceneLabel(type: SceneType) {
  return studentSceneLabels[type]
}

function assignmentStatusLabel(status: AssignmentDraftStatus) {
  return ({ DRAFT: "草稿", PUBLISHED: "已发布", IN_PROGRESS: "进行中", ENDED: "已结束", ARCHIVED: "已归档" } as Record<AssignmentDraftStatus, string>)[status]
}

function assignmentClassDescription(assignment: V3TeachingAssignmentView) {
  const classrooms = assignment.targetClassrooms ?? []
  return classrooms.length ? classrooms.map((classroom) => classroom.name).join("、") : "未绑定班级或个人目标"
}

function clearAssignmentFilters() {
  assignmentStatusFilter.value = ""
  assignmentSceneFilter.value = ""
  assignmentClassFilter.value = ""
  assignmentSearch.value = ""
  assignmentDateRange.value = null
  assignmentDataFilter.value = "FORMAL"
}

function assignmentActions(status: AssignmentDraftStatus) {
  if (status === "DRAFT") return [
    { command: "edit", label: "继续编辑" },
    { command: "copy", label: "复制任务" },
    { command: "delete", label: "删除草稿", divided: true }
  ]
  if (status === "PUBLISHED") return [
    { command: "copy", label: "复制任务" },
    { command: "resource-upgrade", label: "检查资源更新" },
    { command: "withdraw", label: "撤回任务" },
    { command: "end", label: "结束任务", divided: true }
  ]
  if (status === "IN_PROGRESS") return [
    { command: "copy", label: "复制任务" },
    { command: "end", label: "结束任务", divided: true }
  ]
  if (status === "ENDED") return [
    { command: "copy", label: "复制任务" },
    { command: "archive", label: "归档任务", divided: true }
  ]
  return [{ command: "copy", label: "复制任务" }]
}

async function handleAssignmentCommand(command: string, assignment: AssignmentDraftView) {
  try {
    if (command === "edit") {
      emit("editAssignment", assignment.id, assignment.sceneType)
      return
    }
    if (command === "copy") {
      const copied = await api<AssignmentDraftView>(`/v3/assignments/drafts/${assignment.id}/copy`, { method: "POST" })
      ElMessage.success(`已创建副本：${teacherAssignmentTitle(copied)}`)
    } else if (command === "delete") {
      await ElMessageBox.confirm(`确定删除草稿“${teacherAssignmentTitle(assignment)}”吗？此操作不可恢复。`, "删除草稿", { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" })
      await api(`/v3/assignments/drafts/${assignment.id}`, { method: "DELETE" })
      ElMessage.success("草稿已删除")
    } else if (command === "resource-upgrade") {
      if (!await checkResourceUpgrade(assignment)) return
    } else if (command === "withdraw" || command === "end") {
      const actionLabel = command === "withdraw" ? "撤回" : "结束"
      const { value } = await ElMessageBox.prompt(`请填写${actionLabel}原因`, `${actionLabel}任务`, {
        inputType: "textarea",
        inputValidator: (input) => Boolean(input.trim()) || "原因不能为空",
        confirmButtonText: actionLabel,
        cancelButtonText: "取消"
      })
      await api(`/v3/assignments/${assignment.id}/${command}`, { method: "POST", body: JSON.stringify({ reason: value }) })
      ElMessage.success(`任务已${actionLabel}`)
    } else if (command === "archive") {
      await ElMessageBox.confirm(`归档后任务将进入历史记录，确定归档“${teacherAssignmentTitle(assignment)}”吗？`, "归档任务", { confirmButtonText: "归档", cancelButtonText: "取消" })
      await api(`/v3/assignments/${assignment.id}/archive`, { method: "POST", body: JSON.stringify({}) })
      ElMessage.success("任务已归档")
    }
    emit("assignmentsChanged")
  } catch (error) {
    if (error === "cancel" || error === "close") return
    ElMessage.error(error instanceof Error ? error.message : "任务操作失败")
  }
}

async function checkResourceUpgrade(assignment: AssignmentDraftView): Promise<boolean> {
  const preview = await api<AssignmentUpgradePreviewView>(`/v3/assignments/${assignment.id}/resource-upgrade`)
  if (!preview.eligible) {
    ElMessage.warning(preview.reason ?? "当前任务不能切换资源版本")
    return false
  }
  if (preview.changes.length === 0) {
    ElMessage.success("当前任务已使用最新资源版本")
    return false
  }
  const resourceTypeLabels = {
    RULE: "规则",
    REGION: "区域",
    SCALE_TEMPLATE: "规模模板",
    AIRCRAFT: "飞机属性",
    EVENT: "事件",
    SHOW_PROGRAM: "表演程序",
    DOCUMENT_TEMPLATE: "文档模板",
    REPORT: "评价报告"
  } as const
  const content = h("div", { class: "assignment-upgrade-confirm" }, [
    h("p", `任务“${teacherAssignmentTitle(assignment)}”尚未开始，可继续使用原版本，或切换以下新版本：`),
    h("ul", preview.changes.map((change) => h("li", { key: change.packageType }, [
      h("strong", resourceTypeLabels[change.packageType]),
      h("span", `${change.current.name}@${change.current.version}`),
      h("em", "→"),
      h("span", `${change.replacement.name}@${change.replacement.version}`)
    ])))
  ])
  try {
    await ElMessageBox.confirm(content, "发现资源更新", {
      type: "warning",
      confirmButtonText: "切换新版本",
      cancelButtonText: "继续原版本",
      distinguishCancelAndClose: true
    })
  } catch (error) {
    if (error === "cancel" || error === "close") {
      ElMessage.info("已继续使用原资源版本")
      return false
    }
    throw error
  }
  const result = await api<AssignmentUpgradeResultView>(`/v3/assignments/${assignment.id}/resource-upgrade`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision: preview.expectedRevision, snapshotChecksum: preview.snapshotChecksum })
  })
  ElMessage.success(`已切换 ${result.changes.length} 项资源，当前资源修订为 R${result.snapshot.resourceRevision}`)
  return true
}

function formatDate(value: string) {
  return formatPlatformDate(value)
}

function currentStageTitle(project: StudentProjectView) {
  return studentProjectCurrentStage(project)?.title ?? "阶段待初始化"
}

function projectMatchesSearch(project: StudentProjectView) {
  const query = taskSearch.value.trim().toLocaleLowerCase()
  if (!query) return true
  const stage = studentProjectCurrentStage(project)
  return [studentProjectTitle(project), project.title, stage?.title, sceneLabel(project.sceneType)].some((value) => value?.toLocaleLowerCase().includes(query))
}

function studentStatusCount(category: "ALL" | (typeof studentTaskCategories)[number]) {
  if (category === "ALL") return sceneProjects.value.length
  return sceneProjects.value.filter((project) => studentTaskCategory(project.status) === category).length
}
</script>

<template>
  <div class="education-page v3-home-page" v-loading="loading">
    <header class="page-heading">
      <div>
        <span>{{ isStudent ? '学习任务' : isTeacherLibrary ? '教学资源' : '教学运行' }}</span>
        <h1>{{ isStudent ? '我的实训' : isTeacherLibrary ? '任务库' : '教学概览' }}</h1>
      </div>
      <div v-if="isTeacherLibrary" class="heading-actions">
        <el-button :icon="MapLocation" @click="emit('navigate', 'regions')">预设区域管理</el-button>
        <el-button type="primary" :icon="Plus" @click="emit('createAssignment', 'CITY_SHOW')">新建任务</el-button>
      </div>
    </header>

    <el-alert
      v-if="errorMessage"
      class="home-data-error"
      type="error"
      :closable="false"
      title="教学数据暂时未能同步"
    >
      <template #default>
        <div class="home-data-error-content">
          <span>{{ errorMessage }}</span>
          <el-button size="small" type="danger" plain :loading="loading" @click="emit('retry')">重新同步</el-button>
        </div>
      </template>
    </el-alert>

    <section v-if="!isStudent && !isTeacherLibrary" class="metric-band v3-home-metrics teacher-metrics">
      <template v-if="!isStudent">
        <button v-for="metric in teachingOverview?.metrics ?? []" :key="metric.key" class="metric-card" type="button" :aria-label="`${metric.label}，${metric.value}，${metric.detail}，点击查看详情`" @click="emit('teacherMetric', metric.key)">
          <span>{{ metric.label }}</span><strong>{{ metric.value }}</strong><small>{{ metric.detail }}</small>
        </button>
      </template>
    </section>

    <template v-if="isStudent && isStudentOverview">
      <section class="student-scene-cards" aria-label="场景入口">
        <button v-for="option in sceneOptions" :key="option.type" type="button" class="student-scene-card" :class="v3SceneClass(option.type)" @click="emit('studentScene', option.type)">
          <span class="student-scene-card-code">{{ option.code }}</span>
          <strong>{{ studentSceneLabel(option.type) }}</strong>
          <small>{{ option.description.split('、')[0] }}</small>
          <em>{{ sceneProjectCount(option.type) }} 个任务 <i>进入</i></em>
          <el-icon><ArrowRight /></el-icon>
        </button>
      </section>
    </template>

    <template v-else-if="isStudent">
      <section class="student-scene-page">
        <header class="student-scene-page-heading"><div><span>{{ v3ScenePresentation[activeScene].code }}</span><h2>{{ studentSceneLabel(activeScene) }}</h2><p>{{ v3ScenePresentation[activeScene].description }}</p></div><strong>{{ sceneProjects.length }} 个任务</strong></header>
        <div class="student-scene-toolbar">
          <div class="student-status-tabs" role="tablist" aria-label="按任务状态筛选">
            <button type="button" :class="{ active: studentStatusFilter === 'ALL' }" @click="studentStatusFilter = 'ALL'">全部 <b>{{ studentStatusCount('ALL') }}</b></button>
            <button v-for="category in studentTaskCategories" :key="category" type="button" :class="{ active: studentStatusFilter === category }" @click="studentStatusFilter = category">{{ studentTaskCategoryLabels[category] }} <b>{{ studentStatusCount(category) }}</b></button>
          </div>
          <el-input v-model="taskSearch" :prefix-icon="Search" clearable placeholder="搜索任务" aria-label="搜索当前场景任务" />
        </div>
        <div v-if="visibleSceneProjects.length" class="student-scene-task-list">
          <button v-for="projectItem in displayedSceneProjects" :key="projectItem.id" type="button" :data-project-id="projectItem.id" @click="emit('project', projectItem.id)">
            <span class="scene-code" :class="v3SceneClass(projectItem.sceneType)">{{ v3SceneShortLabel(projectItem.sceneType) }}</span>
            <span><strong>{{ studentProjectTitle(projectItem) }}</strong><small>{{ currentStageTitle(projectItem) }} · 最近活动 {{ formatDate(projectItem.lastActivityAt) }}</small></span>
            <em class="project-state" :class="projectItem.status.toLowerCase()">{{ studentProjectStatusLabel(projectItem.status) }}</em>
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div v-else class="section-empty" role="status"><el-icon><Collection /></el-icon><strong>{{ taskSearch || studentStatusFilter !== 'ALL' ? '没有匹配的任务' : `暂无${studentSceneLabel(activeScene)}任务` }}</strong><span>{{ taskSearch || studentStatusFilter !== 'ALL' ? '调整筛选条件后重试' : '教师发布任务后会显示在这里' }}</span></div>
      </section>
    </template>

    <template v-else-if="isTeacherLibrary">
      <section class="content-section assignment-library-page">
        <header class="assignment-library-heading"><div><h2>任务列表</h2><p>按场景、班级或更新时间查找和编辑任务</p></div><strong>{{ visibleV3Assignments.length }}</strong></header>
        <div class="assignment-filter-toolbar">
          <el-input v-model="assignmentSearch" :prefix-icon="Search" clearable placeholder="搜索任务名称或场景" aria-label="搜索教师任务" />
          <el-select v-model="assignmentSceneFilter" clearable placeholder="全部场景" aria-label="按场景筛选任务"><el-option v-for="option in sceneOptions" :key="option.type" :label="option.label" :value="option.type" /></el-select>
          <el-select v-model="assignmentClassFilter" clearable placeholder="全部教学班" aria-label="按教学班筛选任务"><el-option v-for="option in assignmentClassOptions" :key="option.id" :label="option.label" :value="option.id" /></el-select>
          <el-date-picker v-model="assignmentDateRange" type="daterange" range-separator="至" start-placeholder="开始日期" end-placeholder="结束日期" aria-label="按最近更新时间筛选任务" />
        </div>
        <div v-if="visibleV3Assignments.length" class="draft-todo-list assignment-todo-list">
          <div v-for="assignment in displayedV3Assignments" :key="assignment.id" class="assignment-todo-item">
            <span :class="v3SceneClass(assignment.sceneType)">{{ v3SceneShortLabel(assignment.sceneType) }}</span>
            <button class="assignment-todo-summary" type="button" :aria-label="`${teacherAssignmentTitle(assignment)}，${assignmentStatusLabel(assignment.status)}`" @click="assignment.status === 'DRAFT' ? emit('editAssignment', assignment.id, assignment.sceneType) : emit('teacherMetric', 'IN_PROGRESS')">
              <strong>{{ teacherAssignmentTitle(assignment) }}</strong><small>{{ assignment.mode === 'TRAINING' ? '训练' : '考核' }} · {{ assignmentClassDescription(assignment) }} · 更新于 {{ formatDate(assignment.updatedAt) }}</small>
            </button>
            <i class="assignment-status" :class="assignment.status.toLowerCase()">{{ assignmentStatusLabel(assignment.status) }}</i>
            <el-dropdown trigger="click" @command="(command: string) => handleAssignmentCommand(command, assignment)"><button type="button" class="assignment-more" title="任务操作" aria-label="任务操作"><el-icon><MoreFilled /></el-icon></button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="action in assignmentActions(assignment.status)" :key="action.command" :command="action.command" :divided="action.divided">{{ action.label }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
          </div>
        </div>
        <button v-if="hasMoreV3Assignments" class="student-load-more" type="button" @click="assignmentPage += 1">加载更多 · 还有 {{ visibleV3Assignments.length - displayedV3Assignments.length }} 个</button>
        <div v-else-if="!visibleV3Assignments.length" class="compact-empty" role="status"><span>{{ assignmentSearch || assignmentSceneFilter || assignmentClassFilter || assignmentDateRange ? '当前筛选条件下没有任务' : '尚未创建任务' }}</span><button v-if="assignmentSearch || assignmentSceneFilter || assignmentClassFilter || assignmentDateRange" class="compact-empty-action" type="button" @click="clearAssignmentFilters">清除筛选</button></div>
      </section>
    </template>

    <template v-else>
      <section class="teacher-entry-cards" aria-label="教师常用入口">
        <button type="button" class="teacher-entry-card" @click="emit('navigate', 'assignments')"><span>01</span><div><strong>任务库</strong><small>创建、编辑和发布场景任务</small></div><el-icon><ArrowRight /></el-icon></button>
        <button type="button" class="teacher-entry-card" @click="emit('navigate', 'classes')"><span>02</span><div><strong>班级与学生</strong><small>查看班级任务和学生完成情况</small></div><el-icon><ArrowRight /></el-icon></button>
      </section>
    </template>

  </div>
</template>
