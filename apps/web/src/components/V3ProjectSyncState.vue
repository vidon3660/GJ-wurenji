<script setup lang="ts">
import { Refresh, Warning } from "@element-plus/icons-vue"

const props = defineProps<{
  state: "CONNECTING" | "CONNECTED" | "ERROR"
  hasProject: boolean
  loading: boolean
}>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <section v-if="props.state === 'ERROR' && !props.hasProject" class="v3-project-load-error" role="alert">
    <div class="v3-project-load-error-icon"><el-icon><Warning /></el-icon></div>
    <div><strong>项目暂时无法加载</strong><p>项目状态没有同步成功，当前没有可展示的任务内容。</p><small>请检查网络或服务状态后重试；已保存的任务数据不会因本次加载失败被清除。</small></div>
    <el-button type="primary" :loading="props.loading" :icon="Refresh" @click="emit('retry')">重新加载项目</el-button>
  </section>
  <section v-else-if="props.state === 'ERROR' && props.hasProject" class="v3-project-sync-warning" role="alert" aria-live="assertive">
    <div><strong>项目状态同步失败</strong><span>页面保留最近一次已加载内容；重新连接后会刷新阶段、活动和题库状态。</span></div>
    <el-button size="small" type="warning" :loading="props.loading" :icon="Refresh" aria-label="重新连接并刷新项目状态" @click="emit('retry')">重新连接</el-button>
  </section>
</template>
