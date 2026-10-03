<script setup lang="ts">
import { computed } from "vue"
import { Check, Lock } from "@element-plus/icons-vue"
import type { StudentProjectStageView, StudentProjectView } from "@wurenji/shared"
import { buildStudentWorkspaceFlow } from "../student-workspace-flow"
import { studentStageOpenConditionLabel, studentStageStatusLabel } from "../student-task-presentation"

const props = defineProps<{
  project: StudentProjectView | null
  selectedStageCode: string
}>()
const emit = defineEmits<{ select: [stageCode: string] }>()

const flow = computed(() => props.project ? buildStudentWorkspaceFlow(props.project, props.selectedStageCode) : [])

function stageStatusLabel(stage: StudentProjectStageView) {
  return studentStageStatusLabel(stage.status, stage.stageCode, props.project?.assignmentStatus)
}
</script>

<template>
  <aside class="v3-stage-nav" aria-label="项目阶段导航">
    <header><strong>阶段</strong></header>
    <ol v-if="project" class="v3-stage-phase-strip" aria-label="教学路径">
      <li v-for="phase in flow" :key="phase.key" :class="[phase.status.toLowerCase(), { active: phase.isSelected, current: phase.isCurrent }]">
        <button type="button" :disabled="!phase.stageCode" :aria-current="phase.isSelected ? 'step' : undefined" :aria-label="`${phase.label}，${phase.status === 'LOCKED' ? '未开放' : phase.status === 'COMPLETED' ? '已完成' : phase.isCurrent ? '当前阶段' : '可查看'}`" @click="phase.stageCode && emit('select', phase.stageCode)">
          <span>{{ phase.label }}</span><small>{{ phase.isCurrent ? '当前' : phase.status === 'COMPLETED' ? '已完成' : phase.status === 'LOCKED' ? '未开放' : '可查看' }}</small>
        </button>
      </li>
    </ol>
    <button v-for="stage in project?.stages ?? []" :key="stage.stageCode" type="button" :disabled="stage.status === 'LOCKED'" :class="{ active: selectedStageCode === stage.stageCode, locked: stage.status === 'LOCKED' }" :aria-current="selectedStageCode === stage.stageCode ? 'step' : undefined" :aria-label="`${stage.title}，${stageStatusLabel(stage)}${stage.status === 'LOCKED' ? `，开放条件：${studentStageOpenConditionLabel(stage)}` : ''}`" @click="stage.status !== 'LOCKED' && emit('select', stage.stageCode)">
      <span>{{ String(stage.sequence).padStart(2, '0') }}</span>
      <div><strong>{{ stage.title }}</strong><small>{{ stageStatusLabel(stage) }}</small></div>
      <el-icon v-if="stage.status === 'LOCKED'"><Lock /></el-icon><el-icon v-else-if="stage.status === 'ACCEPTED'"><Check /></el-icon><i v-else />
    </button>
  </aside>
</template>
