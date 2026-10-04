<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { ElMessage } from "element-plus"
import { Bell, Collection, DocumentChecked, MapLocation, Promotion } from "@element-plus/icons-vue"
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
  { title: "配置首个场景任务", text: "进入场景任务库，配置场景需求、任务项和仿真指标，保存版本并发布；学生任务只能绑定已发布版本。", icon: DocumentChecked },
  { title: "检查区域与任务条件", text: "选择预设区域，检查建筑、限制区、起降点和高程状态；回到任务向导绑定刚发布的场景任务，再检查规模、时段和事件。", icon: MapLocation },
  { title: "发布并分发首个任务", text: "从预设区域进入任务向导，确认场景任务、班级、开放时间和预检结果，点击“确认发布”。系统会在任务真正发布后完成引导。", icon: Promotion, action: { target: "teacher-first-question-bank" as const, label: "进入场景任务库并配置任务项" } }
]

const studentSteps = [
  { title: "找到当前实训", text: "从待处理任务进入实训，先确认场景、截止时间、当前阶段和唯一下一步。", icon: Collection },
  { title: "按阶段完成规划", text: "先阅读任务条件，再用 2D 完成区域、点位或航线规划，用 3D 检查地形、高度、建筑和安全距离。", icon: MapLocation },
  { title: "打开场景任务并提交方案", text: "进入实训后打开“方案”，填写航线、调度或处置参数并保存版本；确认方案后点击“提交方案”，系统将运行仿真并计算指标。", icon: DocumentChecked },
  { title: "查看判定与运行结果", text: "提交后在同一方案面板查看指标状态、风险项和教师评分；教师发布成绩后可再次打开查看最终结果。", icon: Bell, action: { target: "student-first-questionnaire" as const, label: "进入实训并提交方案" } }
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
