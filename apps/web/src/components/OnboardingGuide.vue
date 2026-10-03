<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { Bell, Collection, DataAnalysis, MapLocation, Promotion, User } from "@element-plus/icons-vue"
import type { AuthUser, OnboardingState, SceneType } from "@wurenji/shared"
import { api } from "../api"
import { clearOnboardingProgress, getOnboardingStorage, loadOnboardingStep, saveOnboardingStep, type OnboardingAction } from "../onboarding-flow"

const props = defineProps<{ user: AuthUser; state: OnboardingState; studentSceneType?: SceneType | null; studentHasProject?: boolean }>()
const emit = defineEmits<{ done: []; later: []; start: [action: OnboardingAction, sceneType: SceneType | null] }>()
const activeStep = ref(0)
const saving = ref(false)
const selectedSceneType = ref<SceneType>(props.studentSceneType ?? "CITY_SHOW")
const storage = getOnboardingStorage()

const teacherSteps = [
  { title: "选择教学场景", text: "先确定本次教学目标。表演关注编队与时序，物流关注订单与调度，垂起关注航线、能源和巡检安全。", icon: Collection },
  { title: "核对教学区域", text: "选择预设教学区域，核对地图资源、禁飞区、起降点和高程状态，再进入任务配置。", icon: MapLocation },
  { title: "配置并发布", text: "完成题库、规模、时段、事件、评价与班级配置；发布检查会定位仍需处理的项目。", icon: Promotion },
  { title: "开始首个任务", text: "前往预设区域，选择一个区域并点击“用此区域创建任务”。系统确认任务配置已打开后才完成引导。", icon: User, action: { target: "teacher-first-assignment" as const, label: "选择区域并开始配置" } }
]

const studentSteps = [
  { title: "找到当前实训", text: "从待处理任务进入实训，先确认场景、截止时间、当前阶段和唯一下一步。", icon: Collection },
  { title: "按阶段完成规划", text: "2D 用于航线和任务规划，3D 用于检查地形、高度、建筑和安全距离。", icon: MapLocation },
  { title: "运行并处置告警", text: "仿真运行中根据任务表和时间轴判断状态；发生告警后记录发现、依据、动作和预期结果。", icon: Bell },
  { title: "开始首个操作", text: "进入当前实训，开始或恢复一个阶段；若仿真已经开放，也可以直接进入仿真运行。系统确认操作成功后完成引导。", icon: DataAnalysis, action: { target: "student-first-stage" as const, label: "进入实训并开始操作" } }
]

const steps = computed(() => props.user.role === "student" ? studentSteps : teacherSteps)
const selectedSceneLabel = computed(() => ({ CITY_SHOW: "城市表演", CITY_LOGISTICS: "城市物流", VTOL_INSPECTION: "垂起巡检" } as Record<SceneType, string>)[selectedSceneType.value])
const canStartOperation = computed(() => props.user.role !== "student" || props.studentHasProject !== false)

onMounted(() => {
  activeStep.value = loadOnboardingStep(storage, props.user.id, props.state, steps.value.length)
})

watch(activeStep, (step) => saveOnboardingStep(storage, props.user.id, props.state, step))

async function skipGuide() {
  saving.value = true
  try {
    await api(`/v1/education/onboarding/${props.state.guideKey}/complete`, {
      method: "POST",
      body: JSON.stringify({ version: props.state.version, skipped: true })
    })
    clearOnboardingProgress(storage, props.user.id, props.state)
    emit("done")
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "引导状态保存失败")
  } finally {
    saving.value = false
  }
}

function continueLater() {
  saveOnboardingStep(storage, props.user.id, props.state, activeStep.value)
  emit("later")
}

function startOperation() {
  const action = steps.value[activeStep.value]?.action
  if (!action) return
  saveOnboardingStep(storage, props.user.id, props.state, activeStep.value)
  emit("start", action.target, props.user.role === "student" ? props.studentSceneType ?? null : selectedSceneType.value)
}
</script>

<template>
  <el-dialog class="onboarding-dialog" :model-value="true" :title="user.role === 'student' ? '学生首次引导' : '教师首次引导'" :aria-label="user.role === 'student' ? '学生首次引导' : '教师首次引导'" width="680px" :show-close="false" :close-on-click-modal="false" :close-on-press-escape="false" @keydown.esc="continueLater">
    <div class="onboarding-layout">
      <aside>
        <button type="button" class="onboarding-close" aria-label="关闭引导" :disabled="saving" @click="continueLater">关闭</button>
        <span class="onboarding-count" aria-live="polite">{{ String(activeStep + 1).padStart(2, '0') }}</span>
        <strong>{{ user.role === 'student' ? '学生首次引导' : '教师首次引导' }}</strong>
        <span class="onboarding-progress">第 {{ activeStep + 1 }} 步，共 {{ steps.length }} 步</span>
        <nav aria-label="引导步骤">
          <button v-for="(step, index) in steps" :key="step.title" type="button" :class="{ active: activeStep === index, complete: index < activeStep }" :aria-current="activeStep === index ? 'step' : undefined" :aria-label="`${index + 1}. ${step.title}${index < activeStep ? '，已完成' : activeStep === index ? '，当前步骤' : ''}`" :disabled="saving" @click="activeStep = index">
            <span>{{ index + 1 }}</span>{{ step.title }}
          </button>
        </nav>
      </aside>
      <section aria-live="polite" :aria-label="`第 ${activeStep + 1} 步：${steps[activeStep]?.title ?? ''}`">
        <el-icon><component :is="steps[activeStep]?.icon" /></el-icon>
        <div><small>首次实操任务</small><h2>{{ steps[activeStep]?.title }}</h2><p>{{ steps[activeStep]?.text }}</p>
          <div v-if="user.role !== 'student' && activeStep === 0" class="onboarding-scene-picker" aria-label="选择首次教学场景">
            <button v-for="option in [{ value: 'CITY_SHOW', label: '城市表演' }, { value: 'CITY_LOGISTICS', label: '城市物流' }, { value: 'VTOL_INSPECTION', label: '垂起巡检' }]" :key="option.value" type="button" :class="{ active: selectedSceneType === option.value }" :aria-pressed="selectedSceneType === option.value" @click="selectedSceneType = option.value as SceneType">{{ option.label }}</button>
          </div>
          <div v-else class="onboarding-task-context"><span>本次实操</span><strong>{{ user.role === 'student' ? (studentSceneType ? selectedSceneLabel : '等待教师分配实训') : selectedSceneLabel }}</strong></div>
        </div>
        <footer>
          <el-button text :disabled="saving" @click="skipGuide">跳过引导</el-button>
          <el-button text :disabled="saving" @click="continueLater">稍后继续</el-button>
          <span />
          <el-button v-if="activeStep > 0" @click="activeStep -= 1">上一步</el-button>
          <el-button v-if="activeStep < steps.length - 1" type="primary" @click="activeStep += 1">下一步</el-button>
          <el-button v-else type="primary" :loading="saving" :disabled="!canStartOperation" @click="startOperation">{{ canStartOperation ? steps[activeStep]?.action?.label : '等待教师分配' }}</el-button>
        </footer>
      </section>
    </div>
  </el-dialog>
</template>
