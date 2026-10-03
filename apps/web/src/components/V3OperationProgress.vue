<script setup lang="ts">
import { CircleCheck, Loading, WarningFilled } from "@element-plus/icons-vue"
import type { V3OperationProgressState } from "../operation-progress"
import { v3OperationStatusLabel, v3OperationStepState } from "../operation-progress"

defineProps<{
  state: V3OperationProgressState | null
}>()
</script>

<template>
  <div v-if="state" class="v3-operation-progress" :class="state.status.toLowerCase()" role="status" aria-live="polite">
    <header>
      <el-icon v-if="state.status === 'RUNNING'" class="is-loading"><Loading /></el-icon>
      <el-icon v-else-if="state.status === 'SUCCEEDED'"><CircleCheck /></el-icon>
      <el-icon v-else><WarningFilled /></el-icon>
      <div><strong>{{ state.title }}</strong><small>{{ v3OperationStatusLabel(state) }}</small></div>
    </header>
    <ol>
      <li v-for="(step, index) in state.steps" :key="step" :class="v3OperationStepState(state, index).toLowerCase()">
        <i><el-icon v-if="v3OperationStepState(state, index) === 'COMPLETE'"><CircleCheck /></el-icon><template v-else>{{ index + 1 }}</template></i>
        <span>{{ step }}</span>
      </li>
    </ol>
    <p :class="{ result: state.status === 'SUCCEEDED', error: state.status === 'FAILED' }">{{ state.result ?? state.detail }}</p>
  </div>
</template>

<style scoped>
.v3-operation-progress { display: grid; gap: 8px; min-width: 0; border: 1px solid #d5dfda; border-left: 3px solid #327559; border-radius: 4px; padding: 9px 10px; color: #263a32; background: #f8fbf9; }
.v3-operation-progress.failed { border-left-color: #ad443d; background: #fff8f7; }
.v3-operation-progress.succeeded { border-left-color: #267052; background: #f4faf7; }
.v3-operation-progress > header { display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: 7px; }
.v3-operation-progress > header > .el-icon { color: #287255; font-size: 15px; }
.v3-operation-progress.failed > header > .el-icon { color: #ad443d; }
.v3-operation-progress > header div { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 8px; }
.v3-operation-progress > header strong { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.v3-operation-progress > header small { flex: 0 0 auto; color: #60756b; font-size: 11px; }
.v3-operation-progress ol { display: grid; grid-template-columns: repeat(var(--operation-step-count, 3), minmax(0, 1fr)); gap: 4px; margin: 0; padding: 0; list-style: none; }
.v3-operation-progress li { display: grid; grid-template-columns: 16px minmax(0, 1fr); align-items: center; gap: 4px; min-width: 0; color: #83918b; font-size: 11px; }
.v3-operation-progress li i { display: grid; width: 16px; height: 16px; place-items: center; border: 1px solid #cbd7d1; border-radius: 50%; font-size: 11px; font-style: normal; }
.v3-operation-progress li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v3-operation-progress li.active { color: #276f54; font-weight: 750; }
.v3-operation-progress li.active i { border-color: #327559; color: white; background: #327559; }
.v3-operation-progress li.complete { color: #526b60; }
.v3-operation-progress li.complete i { border-color: #78a28f; color: #267052; background: #e4f1eb; }
.v3-operation-progress li.failed { color: #9f433d; font-weight: 750; }
.v3-operation-progress li.failed i { border-color: #ad443d; color: white; background: #ad443d; }
.v3-operation-progress p { margin: 0; color: #5f736a; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
.v3-operation-progress p.result { color: #24694f; }
.v3-operation-progress p.error { color: #9f433d; }
@media (max-width: 520px) { .v3-operation-progress ol { grid-template-columns: 1fr; }.v3-operation-progress > header div { align-items: flex-start; flex-direction: column; gap: 2px; } }
</style>
