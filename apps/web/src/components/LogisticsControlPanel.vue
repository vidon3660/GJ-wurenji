<script setup lang="ts">
import { computed, ref } from "vue"
import { ArrowDown, ArrowUp, Clock, DataAnalysis, Operation } from "@element-plus/icons-vue"
import type { FlightMissionStatus, LogisticsControlSnapshot } from "@wurenji/shared"

const props = defineProps<{
  snapshot: LogisticsControlSnapshot | null
  playbackTime: number
  selectedDroneId: string
  loading: boolean
}>()

const emit = defineEmits<{
  selectMission: [droneId: string, orderId: string]
}>()

const activeView = ref<"missions" | "schedule" | "aircraft">("missions")
const collapsed = ref(false)

const activeMissionId = computed(() => {
  const missions = props.snapshot?.missions ?? []
  return missions.find((mission) => props.playbackTime >= mission.plannedStartSeconds && props.playbackTime <= mission.plannedArrivalSeconds + 10)?.id ?? null
})

function formatTime(seconds: number | null) {
  if (seconds === null) return "--:--"
  const value = Math.max(0, Math.round(seconds))
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
}

function statusLabel(status: FlightMissionStatus) {
  return ({ PLANNED: "计划", COMPLETED: "准时", DELAYED: "延误", FAILED: "异常" } as const)[status]
}

function statusClass(status: FlightMissionStatus) {
  return status.toLowerCase()
}
</script>

<template>
  <section class="logistics-control-panel" :class="{ collapsed }" aria-label="物流运行控制">
    <header>
      <div class="control-title">
        <span><el-icon><Operation /></el-icon></span>
        <div><strong>运行控制</strong><small>物流任务与时刻</small></div>
      </div>
      <div v-if="snapshot" class="control-kpis">
        <span><small>订单</small><strong>{{ snapshot.metrics.assignedOrders }}/{{ snapshot.metrics.totalOrders }}</strong></span>
        <span><small>准时率</small><strong>{{ Math.round(snapshot.metrics.onTimeRate * 100) }}%</strong></span>
        <span><small>在用飞机</small><strong>{{ snapshot.metrics.activeAircraft }}</strong></span>
      </div>
      <nav v-if="!collapsed" aria-label="运行控制视图">
        <button type="button" :class="{ active: activeView === 'missions' }" :aria-pressed="activeView === 'missions'" @click="activeView = 'missions'"><el-icon><Operation /></el-icon>任务条</button>
        <button type="button" :class="{ active: activeView === 'schedule' }" :aria-pressed="activeView === 'schedule'" @click="activeView = 'schedule'"><el-icon><Clock /></el-icon>时刻表</button>
        <button type="button" :class="{ active: activeView === 'aircraft' }" :aria-pressed="activeView === 'aircraft'" @click="activeView = 'aircraft'"><el-icon><DataAnalysis /></el-icon>飞机状态</button>
      </nav>
      <button type="button" class="collapse-control" :title="collapsed ? '展开运行控制' : '收起运行控制'" :aria-label="collapsed ? '展开运行控制' : '收起运行控制'" :aria-expanded="!collapsed" @click="collapsed = !collapsed">
        <el-icon><ArrowUp v-if="collapsed" /><ArrowDown v-else /></el-icon>
      </button>
    </header>

    <div v-if="!collapsed" class="control-body" v-loading="loading">
      <div v-if="!snapshot" class="control-empty">保存方案后生成物流运行计划</div>

      <div v-else-if="activeView === 'missions'" class="mission-strip">
        <button
          v-for="mission in snapshot.missions"
          :key="mission.id"
          type="button"
          :class="['mission-card', statusClass(mission.status), { selected: selectedDroneId === mission.droneId, current: activeMissionId === mission.id }]"
          :aria-pressed="selectedDroneId === mission.droneId"
          :aria-label="`${mission.droneId}，${mission.orderName}，计划到达 ${formatTime(mission.plannedArrivalSeconds)}，${statusLabel(mission.status)}${selectedDroneId === mission.droneId ? '，已选中' : ''}`"
          @click="emit('selectMission', mission.droneId, mission.orderId)"
        >
          <span class="mission-sequence">{{ String(mission.sequence).padStart(2, '0') }}</span>
          <span class="mission-aircraft"><strong>{{ mission.droneId }}</strong><small>{{ mission.orderName }}</small></span>
          <span class="mission-time"><small>计划到达</small><strong>{{ formatTime(mission.plannedArrivalSeconds) }}</strong></span>
          <span class="mission-status">{{ statusLabel(mission.status) }}</span>
        </button>
      </div>

      <div v-else-if="activeView === 'schedule'" class="schedule-table">
        <div class="schedule-head"><span>计划</span><span>飞机</span><span>任务</span><span>实际</span><span>偏差</span><span>状态</span></div>
        <button v-for="item in snapshot.schedule" :key="item.id" type="button" :aria-pressed="selectedDroneId === item.droneId" :aria-label="`${item.droneId}，${item.orderName}，计划 ${formatTime(item.plannedTimeSeconds)}，${statusLabel(item.status)}`" @click="emit('selectMission', item.droneId, item.orderId)">
          <strong>{{ formatTime(item.plannedTimeSeconds) }}</strong>
          <span>{{ item.droneId }}</span>
          <span>{{ item.orderName }}</span>
          <span>{{ formatTime(item.actualTimeSeconds) }}</span>
          <span :class="{ late: (item.varianceSeconds ?? 0) > 0 }">{{ item.varianceSeconds === null ? '-' : `${item.varianceSeconds > 0 ? '+' : ''}${Math.round(item.varianceSeconds)}s` }}</span>
          <em :class="statusClass(item.status)">{{ statusLabel(item.status) }}</em>
        </button>
      </div>

      <div v-else class="aircraft-board">
        <button v-for="aircraft in snapshot.aircraft" :key="aircraft.droneId" type="button" :class="{ selected: selectedDroneId === aircraft.droneId, attention: aircraft.status === 'ATTENTION' }" :aria-pressed="selectedDroneId === aircraft.droneId" :aria-label="`${aircraft.droneId}，${aircraft.missionCount} 项任务，${aircraft.status === 'ATTENTION' ? '需关注' : aircraft.status === 'IDLE' ? '待命' : aircraft.status === 'COMPLETED' ? '完成' : '计划'}${selectedDroneId === aircraft.droneId ? '，已选中' : ''}`" @click="emit('selectMission', aircraft.droneId, snapshot?.missions.find((mission) => mission.droneId === aircraft.droneId)?.orderId ?? '')">
          <span class="aircraft-state" />
          <strong>{{ aircraft.droneId }}</strong>
          <span><small>任务链</small>{{ aircraft.missionCount }} 项</span>
          <span><small>下一任务</small>{{ snapshot.missions.find((mission) => mission.id === aircraft.nextMissionId)?.orderName ?? '待命' }}</span>
          <span><small>计划完成</small>{{ formatTime(aircraft.plannedFinishSeconds) }}</span>
          <em>{{ aircraft.status === 'ATTENTION' ? '需关注' : aircraft.status === 'IDLE' ? '待命' : aircraft.status === 'COMPLETED' ? '完成' : '计划' }}</em>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.logistics-control-panel {
  position: absolute;
  z-index: 16;
  right: 12px;
  bottom: 86px;
  left: 12px;
  height: 214px;
  overflow: hidden;
  border: 1px solid rgba(210, 219, 215, 0.92);
  border-radius: 6px;
  background: rgba(250, 252, 251, 0.97);
  box-shadow: 0 8px 28px rgba(11, 37, 29, 0.16);
  transition: height 160ms ease;
  container-type: inline-size;
}

.logistics-control-panel.collapsed {
  height: 52px;
}

.logistics-control-panel > header {
  display: grid;
  grid-template-columns: minmax(150px, 0.8fr) auto minmax(250px, 1fr) 32px;
  align-items: center;
  min-height: 51px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid #d9e1de;
  background: #f7faf8;
}

.control-title,
.control-title > span,
.control-kpis,
.logistics-control-panel nav,
.logistics-control-panel nav button,
.mission-card,
.aircraft-board button {
  display: flex;
  align-items: center;
}

.control-title {
  gap: 9px;
}

.control-title > span {
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 4px;
  color: #fff;
  background: #0c7156;
}

.control-title div {
  display: grid;
}

.control-title strong {
  color: #15251f;
  font-size: 13px;
}

.control-title small,
.control-kpis small,
.mission-aircraft small,
.mission-time small,
.aircraft-board small {
  color: #78857f;
  font-size: 10px;
}

.control-kpis {
  gap: 18px;
  padding: 0 18px;
  border-right: 1px solid #d9e1de;
  border-left: 1px solid #d9e1de;
}

.control-kpis span {
  display: grid;
  min-width: 52px;
}

.control-kpis strong {
  color: #15251f;
  font-size: 15px;
}

.logistics-control-panel nav {
  justify-content: center;
  gap: 2px;
}

.logistics-control-panel nav button {
  gap: 5px;
  height: 32px;
  padding: 0 6px;
  border: 0;
  border-radius: 4px;
  color: #607069;
  background: transparent;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
}

.logistics-control-panel nav button.active {
  color: #075e48;
  background: #e4f0eb;
}

.collapse-control {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 4px;
  color: #5f6d67;
  background: transparent;
  cursor: pointer;
}

.control-body {
  height: 162px;
  padding: 10px 12px;
}

.control-empty {
  display: grid;
  height: 100%;
  place-items: center;
  color: #7f8b86;
  font-size: 12px;
}

.mission-strip {
  display: flex;
  gap: 8px;
  height: 100%;
  overflow-x: auto;
  padding-bottom: 4px;
}

.mission-card {
  position: relative;
  flex: 0 0 218px;
  display: grid;
  grid-template-columns: 30px 1fr auto;
  grid-template-rows: 1fr auto;
  gap: 4px 9px;
  padding: 12px;
  border: 1px solid #d6dfdb;
  border-top: 3px solid #6b7c74;
  border-radius: 5px;
  text-align: left;
  background: #fff;
  cursor: pointer;
  /* The card is a horizontal-strip item, but it must still honour the
   * available panel width. A 620px minimum made the control surface spill
   * out of the map on tablets and phones. */
  min-width: 218px;
  white-space: normal;
}

.mission-card.selected {
  border-color: #168565;
  box-shadow: inset 0 0 0 1px #168565;
}

.mission-card.current::after {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #0c8a66;
  content: "";
}

.mission-card.completed { border-top-color: #168565; }
.mission-card.delayed { border-top-color: #c97818; }
.mission-card.failed { border-top-color: #c64b4b; }

.mission-sequence {
  grid-row: 1 / span 2;
  color: #97a29d;
  font-size: 18px;
  font-weight: 700;
}

.mission-aircraft,
.mission-time {
  display: grid;
}

.mission-aircraft strong,
.mission-time strong {
  color: #17251f;
  font-size: 12px;
}

.mission-aircraft small {
  overflow: hidden;
  max-width: 92px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mission-time {
  text-align: right;
}

.mission-status {
  grid-column: 2 / span 2;
  color: #5e6c66;
  font-size: 10px;
}

.schedule-table {
  height: 100%;
  overflow: auto;
}

.schedule-head,
.schedule-table button {
  display: grid;
  grid-template-columns: 70px 72px minmax(150px, 1fr) 70px 70px 64px;
  align-items: center;
  min-width: 610px;
}

.schedule-head {
  height: 28px;
  padding: 0 10px;
  color: #7c8983;
  font-size: 10px;
}

.schedule-table button {
  width: 100%;
  min-height: 38px;
  padding: 0 10px;
  border: 0;
  border-top: 1px solid #e5eae8;
  color: #33443d;
  text-align: left;
  background: #fff;
  cursor: pointer;
}

.schedule-table button:hover {
  background: #f1f7f4;
}

.schedule-table em {
  width: fit-content;
  padding: 2px 7px;
  border-radius: 3px;
  color: #53625c;
  background: #edf1ef;
  font-style: normal;
  font-size: 10px;
}

.schedule-table em.completed { color: #087252; background: #e2f2eb; }
.schedule-table em.delayed { color: #a75e0a; background: #fff0dc; }
.schedule-table em.failed { color: #a83434; background: #fbe6e6; }
.schedule-table .late { color: #b76609; }

.aircraft-board {
  display: grid;
  gap: 5px;
  height: 100%;
  overflow: auto;
}

.aircraft-board button {
  display: grid;
  grid-template-columns: 12px 70px repeat(3, minmax(90px, 1fr)) 60px;
  gap: 10px;
  min-height: 42px;
  padding: 0 10px;
  border: 1px solid #e0e6e3;
  border-radius: 4px;
  color: #33443d;
  text-align: left;
  background: #fff;
  cursor: pointer;
}

.aircraft-board button.selected {
  border-color: #168565;
}

.aircraft-board button > span:not(.aircraft-state) {
  display: grid;
}

.aircraft-state {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #168565;
}

.aircraft-board button.attention .aircraft-state {
  background: #c97818;
}

.aircraft-board em {
  color: #607069;
  font-style: normal;
  font-size: 11px;
}

@media (max-width: 980px) {
  .logistics-control-panel {
    right: 8px;
    left: 8px;
  }

  .logistics-control-panel > header {
    grid-template-columns: minmax(130px, 1fr) minmax(240px, 1.5fr) 32px;
  }

  .control-kpis {
    display: none;
  }
}

@container (max-width: 620px) {
  .logistics-control-panel > header {
    grid-template-columns: minmax(126px, 1fr) auto 32px;
  }

  .control-kpis {
    display: none;
  }

  .logistics-control-panel nav {
    justify-content: flex-end;
  }
}

@container (max-width: 450px) {
  .logistics-control-panel > header {
    grid-template-columns: 34px minmax(210px, 1fr) 32px;
    padding-left: 9px;
  }

  .control-title div {
    display: none;
  }

  .logistics-control-panel nav button {
    padding: 0 4px;
  }
}


@media (max-width: 760px) {
  .logistics-control-panel { right: 8px; bottom: 72px; left: 8px; height: 206px; }
  .mission-card { min-width: 300px; }
}
@media (max-width: 420px) {
  .logistics-control-panel { right: 5px; bottom: 58px; left: 5px; height: 198px; }
  .logistics-control-panel > header { grid-template-columns: 30px minmax(0, 1fr) 30px; min-height: 46px; padding: 0 6px; }
  .control-title > span { width: 26px; height: 26px; }
  .control-title div { display: none; }
  .logistics-control-panel nav { gap: 0; overflow-x: auto; justify-content: flex-end; }
  .logistics-control-panel nav button { min-width: 54px; padding: 0 3px; }
  .control-body { height: 152px; padding: 8px; }
  .mission-card { flex-basis: 280px; min-width: 280px; grid-template-columns: 24px minmax(0, 1fr) auto; padding: 9px; }
  .mission-status { white-space: normal; }
}

</style>
