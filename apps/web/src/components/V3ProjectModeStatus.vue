<script setup lang="ts">
import type { AuthUser, StudentProjectView } from "@wurenji/shared"
import { computed } from "vue"
import { studentWorkspacePermission } from "../student-workspace-flow"

const props = defineProps<{
  project: StudentProjectView | null
  actorRole: AuthUser["role"]
}>()

const permission = computed(() => props.project
  ? studentWorkspacePermission(props.project, { role: props.actorRole })
  : null)
</script>

<template>
  <div class="v3-project-context mode-status" :class="permission?.kind.toLowerCase() ?? 'loading'" :title="permission?.detail ?? '正在读取任务权限'">
    <span>{{ project?.mode === 'TRAINING' ? '训练模式' : project ? `考核模式 · 第 ${project.assessmentAttempt.attemptNumber} 次` : '任务模式' }}</span>
    <strong>{{ permission?.label ?? '正在读取权限' }}</strong>
    <small>{{ permission?.detail ?? '正在读取服务端权限状态。' }}</small>
  </div>
</template>
