<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue"
import { ElMessage } from "element-plus"
import { Bell, Box, Collection, DataBoard, Help, MapLocation, Refresh, SwitchButton, User } from "@element-plus/icons-vue"
import type { AssignmentDraftStatus, AuthUser, ClassroomSummary, OnboardingState, SceneType, StudentProjectView, V3TeachingMetric, V3TeachingOverview } from "@wurenji/shared"
import { api } from "../api"
import { clearWorkspaceResumeTarget, loadWorkspaceResumeTarget, saveWorkspaceResumeTarget } from "../workspace-resume"
import { teacherMetricNavigation } from "../teacher-progress"
import { clearOnboardingMission, clearOnboardingProgress, loadOnboardingMission, saveOnboardingMission, type OnboardingAction, type OnboardingMission } from "../onboarding-flow"
import EducationHomeView from "./EducationHomeView.vue"
import { defineAsyncComponentWithLoading } from "../async-component"

const ClassManagementView = defineAsyncComponentWithLoading(() => import("./ClassManagementView.vue"))
const OnboardingGuide = defineAsyncComponentWithLoading(() => import("./OnboardingGuide.vue"))
const V3AssignmentWizard = defineAsyncComponentWithLoading(() => import("./V3AssignmentWizard.vue"))
const V3ProjectWorkspaceView = defineAsyncComponentWithLoading(() => import("./V3ProjectWorkspaceView.vue"))
const V3RegionLibraryView = defineAsyncComponentWithLoading(() => import("./V3RegionLibraryView.vue"))
const V3ResourcePackageManagementView = defineAsyncComponentWithLoading(() => import("./V3ResourcePackageManagementView.vue"))
const V3TeachingProgressView = defineAsyncComponentWithLoading(() => import("./V3TeachingProgressView.vue"))
const QuestionBankManagementView = defineAsyncComponentWithLoading(() => import("./QuestionBankManagementView.vue"))


const props = defineProps<{ user: AuthUser }>()
const emit = defineEmits<{ logout: [] }>()
type PlatformSection = "home" | "assignments" | "regions" | "resources" | "progress" | "classes" | "question-banks" | "student-show" | "student-logistics" | "student-vtl" | "workspace"
type WorkspaceTarget = { id: string; alertId?: string }

const activeSection = ref<PlatformSection>("home")
const workspaceTarget = ref<WorkspaceTarget | null>(null)
const classrooms = ref<ClassroomSummary[] | null>(null)
const teachingOverview = ref<V3TeachingOverview | null>(null)
const studentProjects = ref<StudentProjectView[]>([])
const onboarding = ref<OnboardingState | null>(null)
const showGuide = ref(false)
const onboardingMission = ref<OnboardingMission | null>(null)
const onboardingMissionSaving = ref(false)
const guidedSceneType = ref<SceneType | null>(null)
const showAssignmentWizard = ref(false)
const assignmentWizardKey = ref(0)
const wizardSceneType = ref<SceneType>("CITY_SHOW")
const wizardRegionId = ref("")
const wizardDraftId = ref("")
const progressAlertState = ref<"" | "OPEN">("")
const progressSubmissionState = ref<"" | "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED">("")
const progressEvaluationState = ref<"" | "NOT_STARTED" | "PENDING" | "PUBLISHED">("")
const teacherAssignmentFocus = ref<AssignmentDraftStatus | "">("")
const includeInternalTeachingData = ref(false)
const includeInternalStudentData = ref(false)
const overviewLoading = ref(false)
const v3Loading = ref(false)
const platformRetryInFlight = ref(false)
const contextError = ref("")
const v3Error = ref("")
const loading = computed(() => overviewLoading.value || v3Loading.value)
let platformRefreshTimer: number | null = null
let overviewReloadGeneration = 0
let v3ReloadGeneration = 0

const isTeacher = computed(() => props.user.role === "teacher" || props.user.role === "admin")
const openAlertCount = computed(() => teachingOverview.value?.metrics.find((metric) => metric.key === "ALERTS")?.value ?? 0)
const serviceState = computed<"SYNCING" | "CONNECTED" | "ERROR">(() => {
  if (loading.value) return "SYNCING"
  if (contextError.value || v3Error.value) return "ERROR"
  if (!classrooms.value) return "SYNCING"
  if (isTeacher.value ? !teachingOverview.value : studentProjects.value === null) return "SYNCING"
  return "CONNECTED"
})
const serviceLabel = computed(() => serviceState.value === "SYNCING" ? "正在同步" : serviceState.value === "ERROR" ? "连接异常" : "教学服务正常")
const serviceDetail = computed(() => serviceState.value === "SYNCING" ? "正在读取教学数据" : serviceState.value === "ERROR" ? "部分数据未能读取" : "班级与实训数据已同步")
const onboardingStudentProject = computed(() => studentProjects.value.find((item) => item.status === "IN_PROGRESS") ?? studentProjects.value.find((item) => item.status === "NOT_STARTED") ?? studentProjects.value[0] ?? null)
const onboardingMissionTitle = computed(() => onboardingMission.value?.action === "teacher-first-assignment" ? "创建首个场景任务" : "完成首个学生操作")
const onboardingMissionDetail = computed(() => onboardingMission.value?.action === "teacher-first-assignment"
  ? "在预设区域中选择一个区域，然后点击“用此区域创建任务”"
  : "进入当前实训，开始或恢复阶段；仿真已开放时可进入仿真运行")
const navItems = computed(() => isTeacher.value
  ? [
      { key: "home" as const, label: "教学概览", icon: DataBoard },
      { key: "assignments" as const, label: "任务库", icon: Collection },
      ...(props.user.role === "admin" ? [{ key: "resources" as const, label: "资源包管理", icon: Box }] : []),
      { key: "classes" as const, label: "班级", icon: User },
      { key: "question-banks" as const, label: "题库", icon: Collection }
    ]
  : [
      { key: "home" as const, label: "学习概览", icon: DataBoard },
      { key: "student-show" as const, label: "编队表演", icon: DataBoard },
      { key: "student-logistics" as const, label: "低空物流", icon: DataBoard },
      { key: "student-vtl" as const, label: "广域巡检", icon: DataBoard }
    ])

onMounted(async () => {
  document.addEventListener("visibilitychange", refreshWhenVisible)
  platformRefreshTimer = window.setInterval(refreshWhenVisible, 60_000)
  await Promise.all([reloadEducationContext(), reloadV3()])
  await restoreWorkspace()
  try {
    onboarding.value = await api<OnboardingState>("/v1/education/onboarding")
    if (onboarding.value.completed) clearOnboardingProgress(localStorage, props.user.id, onboarding.value)
    else onboardingMission.value = loadOnboardingMission(localStorage, props.user.id, onboarding.value)
    guidedSceneType.value = onboardingMission.value?.sceneType ?? null
    showGuide.value = !onboarding.value.completed && !onboardingMission.value
  } catch {
  }
})

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", refreshWhenVisible)
  if (platformRefreshTimer !== null) window.clearInterval(platformRefreshTimer)
})

function refreshWhenVisible() {
  if (document.visibilityState !== "visible" || activeSection.value === "workspace" || loading.value) return
  void retryPlatformData()
}

async function reloadEducationContext() {
  const generation = ++overviewReloadGeneration
  overviewLoading.value = true
  contextError.value = ""
  try {
    const value = await api<ClassroomSummary[]>("/v1/education/classes")
    if (generation !== overviewReloadGeneration) return
    classrooms.value = value
  } catch (error) {
    if (generation !== overviewReloadGeneration) return
    contextError.value = error instanceof Error ? error.message : "班级信息加载失败"
    ElMessage.error(error instanceof Error ? error.message : "班级信息加载失败")
  } finally {
    if (generation !== overviewReloadGeneration) return
    overviewLoading.value = false
  }
}

async function reloadV3(includeInternalData = isTeacher.value ? includeInternalTeachingData.value : includeInternalStudentData.value) {
  const generation = ++v3ReloadGeneration
  v3Loading.value = true
  v3Error.value = ""
  try {
    if (isTeacher.value) {
      const query = includeInternalData ? "?includeInternalData=true" : ""
      const value = await api<V3TeachingOverview>(`/v3/teaching/overview${query}`)
      if (generation !== v3ReloadGeneration) return
      teachingOverview.value = value
    }
    else {
      const value = await api<StudentProjectView[]>(`/v3/my-projects${includeInternalData ? "?includeInternalData=true" : ""}`)
      if (generation !== v3ReloadGeneration) return
      studentProjects.value = value
    }
  } catch (error) {
    if (generation !== v3ReloadGeneration) return
    v3Error.value = error instanceof Error ? error.message : "教学任务数据加载失败"
    ElMessage.error(error instanceof Error ? error.message : "教学任务数据加载失败")
  } finally {
    if (generation === v3ReloadGeneration) v3Loading.value = false
  }
}

async function retryPlatformData() {
  if (platformRetryInFlight.value) return
  platformRetryInFlight.value = true
  try {
    await Promise.all([reloadEducationContext(), reloadV3()])
  } finally {
    platformRetryInFlight.value = false
  }
}

async function changeTeachingDataScope(includeInternalData: boolean) {
  includeInternalTeachingData.value = includeInternalData
  await reloadV3(includeInternalData)
}

function navigate(section: PlatformSection) {
  if (section === "home") showAssignmentWizard.value = false
  if (section !== "progress") {
    progressAlertState.value = ""
    progressSubmissionState.value = ""
    progressEvaluationState.value = ""
  }
  if (section !== "home") teacherAssignmentFocus.value = ""
  if (section === "workspace") {
    if (workspaceTarget.value) activeSection.value = "workspace"
    return
  }
  activeSection.value = section
}

function openStudentScene(sceneType: SceneType) {
  activeSection.value = sceneType === "CITY_LOGISTICS" ? "student-logistics" : sceneType === "VTOL_INSPECTION" ? "student-vtl" : "student-show"
}

const activeStudentScene = computed<SceneType>(() => activeSection.value === "student-logistics" ? "CITY_LOGISTICS" : activeSection.value === "student-vtl" ? "VTOL_INSPECTION" : "CITY_SHOW")

function openTeacherMetric(key: V3TeachingMetric["key"]) {
  const navigation = teacherMetricNavigation(key)
  teacherAssignmentFocus.value = navigation.assignmentFocus
  progressSubmissionState.value = navigation.submissionState
  progressAlertState.value = navigation.alertState
  progressEvaluationState.value = navigation.evaluationState
  activeSection.value = key === "DRAFTS" ? "assignments" : "classes"
}

function openAlertCenter() {
  if (isTeacher.value) {
    openTeacherMetric("ALERTS")
    return
  }
  const activeProject = studentProjects.value.find((project) => project.status === "IN_PROGRESS") ?? studentProjects.value[0]
  if (activeProject) {
    openV3Project(activeProject.id)
    return
  }
  ElMessage.info("进入进行中的实训后，可在运行工作区查看告警")
}

function openV3Project(projectId: string, alertId?: string) {
  workspaceTarget.value = alertId
    ? { id: projectId, alertId }
    : { id: projectId }
  activeSection.value = "workspace"
  saveWorkspaceResumeTarget(localStorage, props.user.id, projectId)
}

async function restoreWorkspace() {
  const target = loadWorkspaceResumeTarget(localStorage, props.user.id)
  if (!target) return
  try {
    await api<StudentProjectView>(`/v3/projects/${target.id}/stages`)
    workspaceTarget.value = { id: target.id }
    activeSection.value = "workspace"
  } catch {
    clearWorkspaceResumeTarget(localStorage, props.user.id)
  }
}

function openAssignmentWizard(sceneType: SceneType = "CITY_SHOW", regionPackageId = "", draftId = "") {
  assignmentWizardKey.value += 1
  wizardSceneType.value = sceneType
  wizardRegionId.value = regionPackageId
  wizardDraftId.value = draftId
  showAssignmentWizard.value = true
}

function editAssignment(draftId: string, sceneType: SceneType) {
  openAssignmentWizard(sceneType, "", draftId)
}

async function assignmentPublished() {
  activeSection.value = "home"
  wizardDraftId.value = ""
  await reloadV3()
}

async function leaveWorkspace() {
  clearWorkspaceResumeTarget(localStorage, props.user.id)
  workspaceTarget.value = null
  activeSection.value = "home"
  await Promise.all([reloadEducationContext(), reloadV3()])
}

function finishGuide() {
  showGuide.value = false
  if (onboarding.value) onboarding.value.completed = true
  onboardingMission.value = null
}

function deferGuide() {
  showGuide.value = false
}

function startGuideMission(action: OnboardingAction, sceneType: SceneType | null) {
  if (!onboarding.value) return
  const mission = { action, sceneType }
  onboardingMission.value = mission
  guidedSceneType.value = sceneType
  saveOnboardingMission(localStorage, props.user.id, onboarding.value, mission)
  showGuide.value = false
  resumeOnboardingMission()
}

function resumeOnboardingMission() {
  if (onboardingMission.value?.action === "teacher-first-assignment") {
    activeSection.value = "regions"
    return
  }
  const project = onboardingStudentProject.value
  if (project) openV3Project(project.id)
  else {
    activeSection.value = "home"
    ElMessage.info("当前还没有可进入的实训，教师发布任务后可继续")
  }
}

function deferOnboardingMission() {
  if (onboarding.value) clearOnboardingMission(localStorage, props.user.id, onboarding.value)
  onboardingMission.value = null
}

async function completeOnboardingMission(action: OnboardingAction) {
  if (!onboarding.value || onboardingMission.value?.action !== action || onboardingMissionSaving.value) return
  onboardingMissionSaving.value = true
  try {
    onboarding.value = await api<OnboardingState>(`/v1/education/onboarding/${onboarding.value.guideKey}/complete`, {
      method: "POST",
      body: JSON.stringify({ version: onboarding.value.version, skipped: false })
    })
    clearOnboardingProgress(localStorage, props.user.id, onboarding.value)
    onboardingMission.value = null
    ElMessage.success("首次实操已完成，后续可从帮助入口重新查看引导")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "首次实操状态保存失败")
  } finally {
    onboardingMissionSaving.value = false
  }
}

function createAssignmentFromRegion(sceneType: SceneType, regionPackageId: string) {
  openAssignmentWizard(sceneType, regionPackageId)
}

function openRegionsFromWizard() {
  showAssignmentWizard.value = false
  activeSection.value = "regions"
}

function handleStudentOnboardingAction(action: "stage-started" | "simulation-opened") {
  if (action === "stage-started" || action === "simulation-opened") void completeOnboardingMission("student-first-stage")
}

function replayGuide() {
  if (onboarding.value) clearOnboardingMission(localStorage, props.user.id, onboarding.value)
  onboardingMission.value = null
  showGuide.value = true
}

function handleUserCommand(command: string) {
  if (command === "logout") emit("logout")
}
</script>

<template>
  <V3ProjectWorkspaceView v-if="activeSection === 'workspace' && workspaceTarget" :key="workspaceTarget.id" :user="user" :project-id="workspaceTarget.id" :initial-alert-id="workspaceTarget.alertId ?? ''" @back="leaveWorkspace" @onboarding-action="handleStudentOnboardingAction" />
  <div v-else class="platform-shell">
    <header class="platform-header">
      <div class="platform-brand"><span>GJ</span><div><strong>高巨低空</strong><small>无人集群仿真教学平台</small></div></div>
      <div class="platform-context"><span>{{ user.role === 'admin' ? '管理端' : isTeacher ? '教师端' : '学生端' }}</span><strong>{{ navItems.find((item) => item.key === activeSection)?.label }}</strong></div>
      <div class="platform-actions">
        <button type="button" class="platform-alert-button" :class="{ active: isTeacher && activeSection === 'progress' && progressAlertState === 'OPEN' }" :title="isTeacher ? `告警中心${openAlertCount ? ` · ${openAlertCount} 条开放告警` : ''}` : '进入最近运行任务查看告警'" :aria-label="isTeacher ? `告警中心${openAlertCount ? `，${openAlertCount} 条开放告警` : ''}` : '进入最近运行任务查看告警'" @click="openAlertCenter"><el-icon><Bell /></el-icon><span v-if="isTeacher && openAlertCount > 0" class="platform-alert-count">{{ openAlertCount > 99 ? '99+' : openAlertCount }}</span></button>
        <button type="button" title="重新播放引导" aria-label="重新播放引导" @click="replayGuide"><el-icon><Help /></el-icon></button>
        <el-dropdown trigger="click" @command="handleUserCommand">
          <button type="button" class="platform-user" title="账户菜单" :aria-label="`${user.displayName}，${user.role === 'admin' ? '管理员' : isTeacher ? '教师' : '学生'}，账户菜单`">
            <span class="platform-user-avatar">{{ user.displayName.slice(0, 1) }}</span>
            <span class="platform-user-copy"><strong>{{ user.displayName }}</strong><small>{{ user.role === 'admin' ? '管理员' : isTeacher ? '教师' : '学生' }}</small></span>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="logout" :icon="SwitchButton">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>
    <aside class="platform-nav"><nav><template v-for="item in navItems" :key="item.key"><button v-if="item.key !== 'assignments'" type="button" :class="{ active: activeSection === item.key }" :aria-label="item.label" :title="item.label" :aria-current="activeSection === item.key ? 'page' : undefined" @click="navigate(item.key)"><el-icon><component :is="item.icon" /></el-icon><span>{{ item.label }}</span></button><div v-else class="nav-group"><button type="button" :class="{ active: activeSection === 'assignments' || activeSection === 'regions' }" aria-label="任务库" title="任务库" @click="navigate('assignments')"><el-icon><component :is="item.icon" /></el-icon><span>任务库</span></button><button type="button" class="nav-sub-item" :class="{ active: activeSection === 'regions' }" aria-label="预设区域管理" title="预设区域管理" @click="navigate('regions')"><el-icon><MapLocation /></el-icon><span>预设区域管理</span></button></div></template></nav><div class="nav-status" :class="serviceState.toLowerCase()"><span></span><div><strong>{{ serviceLabel }}</strong><small>{{ serviceDetail }}</small></div><button v-if="serviceState === 'ERROR'" type="button" class="nav-status-retry" title="重新同步教学数据" aria-label="重新同步教学数据" :disabled="platformRetryInFlight" :aria-busy="platformRetryInFlight" @click="retryPlatformData"><el-icon><Refresh /></el-icon></button></div></aside>
    <main class="platform-content">
      <EducationHomeView
        v-if="activeSection === 'home'"
        :user="user"
        :classrooms="classrooms ?? []"
        :teaching-overview="teachingOverview"
        :student-projects="studentProjects"
        :loading="loading"
        :error-message="[contextError, v3Error].filter(Boolean).join('；')"
        :teacher-assignment-focus="teacherAssignmentFocus"
        :teacher-include-internal-data="includeInternalTeachingData"
        :student-include-internal-data="includeInternalStudentData"
        teacher-view="overview"
        student-view="overview"
        @navigate="navigate"
        @project="openV3Project"
        @create-assignment="openAssignmentWizard"
        @edit-assignment="editAssignment"
        @teacher-metric="openTeacherMetric"
        @teacher-data-scope-changed="changeTeachingDataScope"
        @student-scene="openStudentScene"
        @assignments-changed="reloadV3"
        @retry="retryPlatformData"
      />
      <EducationHomeView
        v-else-if="activeSection === 'assignments' && isTeacher"
        :user="user"
        :classrooms="classrooms ?? []"
        :teaching-overview="teachingOverview"
        :student-projects="studentProjects"
        :loading="loading"
        :error-message="[contextError, v3Error].filter(Boolean).join('；')"
        :teacher-assignment-focus="teacherAssignmentFocus"
        :teacher-include-internal-data="includeInternalTeachingData"
        teacher-view="assignments"
        @navigate="navigate"
        @project="openV3Project"
        @create-assignment="openAssignmentWizard"
        @edit-assignment="editAssignment"
        @teacher-metric="openTeacherMetric"
        @teacher-data-scope-changed="changeTeachingDataScope"
        @student-scene="openStudentScene"
        @assignments-changed="reloadV3"
        @retry="retryPlatformData"
      />
      <EducationHomeView
        v-else-if="activeSection === 'student-show' || activeSection === 'student-logistics' || activeSection === 'student-vtl'"
        :user="user"
        :classrooms="classrooms ?? []"
        :teaching-overview="teachingOverview"
        :student-projects="studentProjects"
        :loading="loading"
        :error-message="[contextError, v3Error].filter(Boolean).join('；')"
        student-view="scene"
        :initial-scene-type="activeStudentScene"
        @navigate="navigate"
        @project="openV3Project"
        @student-scene="openStudentScene"
        @retry="retryPlatformData"
      />
      <V3RegionLibraryView v-else-if="activeSection === 'regions' && isTeacher" :initial-scene-type="guidedSceneType" @create-assignment="createAssignmentFromRegion" />
      <V3ResourcePackageManagementView v-else-if="activeSection === 'resources' && user.role === 'admin'" />
      <V3TeachingProgressView v-else-if="activeSection === 'progress' && isTeacher" :initial-alert-state="progressAlertState" :initial-submission-state="progressSubmissionState" :initial-evaluation-state="progressEvaluationState" :teaching-overview="teachingOverview" @project="openV3Project" />
      <ClassManagementView v-else-if="activeSection === 'classes' && isTeacher" :teaching-overview="teachingOverview" @create-assignment="openAssignmentWizard" @edit-assignment="editAssignment" @view-progress="navigate('progress')" @project="openV3Project" @changed="retryPlatformData" />
      <QuestionBankManagementView v-else-if="activeSection === 'question-banks' && isTeacher" />
    </main>
    <OnboardingGuide v-if="showGuide && onboarding" :user="user" :state="onboarding" :student-scene-type="onboardingStudentProject?.sceneType ?? null" @done="finishGuide" @later="deferGuide" @start="startGuideMission" />
    <V3AssignmentWizard v-if="isTeacher" :key="assignmentWizardKey" v-model:visible="showAssignmentWizard" :initial-scene-type="wizardSceneType" :initial-region-id="wizardRegionId" :initial-draft-id="wizardDraftId" @opened="completeOnboardingMission('teacher-first-assignment')" @published="assignmentPublished" @open-regions="openRegionsFromWizard" />
  </div>
  <section v-if="onboardingMission" class="onboarding-mission" role="status" aria-live="polite" :data-onboarding-mission="onboardingMission.action">
    <div><span>首次实操</span><strong>{{ onboardingMissionTitle }}</strong><small>{{ onboardingMissionDetail }}</small></div>
    <el-button text :disabled="onboardingMissionSaving" @click="deferOnboardingMission">稍后继续</el-button>
    <el-button type="primary" :loading="onboardingMissionSaving" @click="resumeOnboardingMission">继续任务</el-button>
  </section>
</template>
