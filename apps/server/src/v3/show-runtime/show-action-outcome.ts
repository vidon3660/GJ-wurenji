import type {
  ShowRuntimeActionCode,
  ShowRuntimeGroupView,
  ShowRuntimePhase,
  ShowRuntimeTotalsView
} from "@wurenji/shared"

export interface ShowActionProjection {
  phase: ShowRuntimePhase
  phaseTitle: string
  totals: ShowRuntimeTotalsView
  groups: ShowRuntimeGroupView[]
}

export interface ShowActionOutcomeInput {
  actionCode: ShowRuntimeActionCode
  targetId: string | null
  before: ShowActionProjection
  after: ShowActionProjection
}

export interface ShowActionBusinessOutcome {
  outcome: string
  businessConsequences: string[]
}

export function showActionWithinDeadline(deadlineAtSimulationTimeMs: number | null, actionSimulationTimeMs: number): boolean | null {
  return deadlineAtSimulationTimeMs === null ? null : actionSimulationTimeMs <= deadlineAtSimulationTimeMs
}

export function showActionBusinessOutcome(input: ShowActionOutcomeInput): ShowActionBusinessOutcome {
  const consequences = new Set<string>()
  const groupId = targetGroupId(input.targetId)
  const beforeGroup = groupId ? input.before.groups.find((item) => item.groupId === groupId) ?? null : null
  const afterGroup = groupId ? input.after.groups.find((item) => item.groupId === groupId) ?? null : null

  if (input.targetId && ["SINGLE_LAND", "REMOVE_FROM_MISSION"].includes(input.actionCode)) {
    consequences.add(`${input.targetId}：已退出当前表演任务并计入提前降落`)
  }
  if (beforeGroup && afterGroup) {
    addCountChange(consequences, afterGroup.label, "空中数量", beforeGroup.airborneCount, afterGroup.airborneCount)
    addCountChange(consequences, afterGroup.label, "已降落数量", beforeGroup.landedCount, afterGroup.landedCount)
    if (beforeGroup.status !== afterGroup.status) consequences.add(`${afterGroup.label}：运行状态由“${groupStatusLabel(beforeGroup.status)}”变为“${groupStatusLabel(afterGroup.status)}”`)
    const newGap = Math.max(0, beforeGroup.airborneCount - afterGroup.airborneCount)
    if (newGap > 0) {
      consequences.add(`${afterGroup.label}：本次处置形成 ${newGap} 架编队缺口，图案完整性需按当前空中 ${afterGroup.airborneCount}/${afterGroup.plannedCount} 架复核`)
    }
  }

  addCountChange(consequences, "表演机群", "空中数量", input.before.totals.airborneCount, input.after.totals.airborneCount)
  addCountChange(consequences, "表演机群", "已降落数量", input.before.totals.landedCount, input.after.totals.landedCount)
  if (input.before.phase === input.after.phase && ["SINGLE_LAND", "REMOVE_FROM_MISSION", "BATCH_LAND", "GROUP_LAND", "ZONE_LAND"].includes(input.actionCode)) {
    consequences.add(`节目仍处于“${phaseLabel(input.after.phase)}”阶段，现有节目时序未由本次处置自动重排`)
  } else if (input.before.phase !== input.after.phase) {
    consequences.add(`节目阶段由“${phaseLabel(input.before.phase)}”变为“${phaseLabel(input.after.phase)}”`)
  }
  if (["SINGLE_LAND", "REMOVE_FROM_MISSION", "BATCH_LAND", "GROUP_RETURN", "GROUP_LAND", "MULTI_GROUP_RETURN", "ZONE_LAND"].includes(input.actionCode)) {
    consequences.add("邻机安全间距尚无单机轨迹判定证据，需要结合后续轨迹继续复核")
  }
  if (consequences.size === 0) consequences.add(fallbackConsequences[input.actionCode])
  const businessConsequences = [...consequences]
  return { outcome: businessConsequences.join("；"), businessConsequences }
}

function addCountChange(values: Set<string>, objectName: string, field: string, before: number, after: number): void {
  if (before === after) return
  values.add(`${objectName}：${field}由 ${before} 架变为 ${after} 架`)
}

function targetGroupId(targetId: string | null): string | null {
  return targetId?.match(/G\d{2,3}/)?.[0] ?? null
}

function phaseLabel(value: ShowRuntimePhase): string {
  return ({
    READY: "待起飞", TAKEOFF_PREPARATION: "起飞准备", BATCH_TAKEOFF: "分批起飞", TRANSIT_TO_SHOW: "前往表演区",
    PERFORMANCE: "表演运行", RETURN_TO_LAUNCH: "返回起降区", BATCH_LANDING: "分批降落", COMPLETED: "表演完成", ABORTED: "表演已中止"
  } satisfies Record<ShowRuntimePhase, string>)[value]
}

function groupStatusLabel(value: ShowRuntimeGroupView["status"]): string {
  return ({
    GROUND: "地面", TAKING_OFF: "起飞中", AIRBORNE: "空中", RETURNING: "返航", LANDING: "降落中",
    LANDED: "已降落", WARNING: "告警", ABNORMAL: "异常", LOST: "失联"
  } satisfies Record<ShowRuntimeGroupView["status"], string>)[value]
}

const fallbackConsequences = {
  ACKNOWLEDGE_ALERT: "已确认表演告警，等待学生选择处置动作",
  CONTINUE_MONITORING: "表演继续运行，当前风险保持监控",
  PAUSE_NEXT_TAKEOFF: "后续起飞已暂停，未起飞编队保持地面等待",
  RESUME_NEXT_TAKEOFF: "后续起飞已恢复，编队继续按既定时序执行",
  PAUSE_PROGRAM: "表演程序已暂停，当前机群状态保持等待",
  RESUME_PROGRAM: "表演程序已恢复，机群继续按既定时序执行",
  ABORT_PROGRAM: "表演程序已中止，后续节目段不再执行",
  SINGLE_LAND: "目标单机已退出当前表演任务",
  BATCH_LAND: "目标批次已开始退出当前表演任务",
  REMOVE_FROM_MISSION: "目标单机已移出当前表演任务",
  GROUP_RETURN: "目标编队已进入返航状态",
  GROUP_LAND: "目标编队已完成降落",
  SWITCH_EMERGENCY_ZONE: "目标编队已切换至应急降落流程",
  MULTI_GROUP_RETURN: "目标编队已进入联合返航状态",
  ZONE_LAND: "目标分区编队已完成降落",
  RETURN_ALL: "全部空中编队已进入返航状态",
  EMERGENCY_LAND_ALL: "全部空中编队已完成应急降落"
} satisfies Record<ShowRuntimeActionCode, string>
