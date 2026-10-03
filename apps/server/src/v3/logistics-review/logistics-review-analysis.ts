import type {
  LogisticsRuntimeSummaryView,
  LogisticsScheduleItemView,
  ShowObjectiveMetricState,
  V3LogisticsReviewAnalysisMetricView,
  V3LogisticsReviewAnalysisSectionView,
  V3LogisticsReviewAnalysisView
} from "@wurenji/shared"
import type { RuntimeEventEntity, StudentRuntimeActionEntity } from "../runtime/runtime.entities.js"
import type { LogisticsRoutePlanVersionEntity, LogisticsRouteValidationRunEntity } from "../logistics-route/logistics-route.entities.js"
import type { LogisticsScheduleVersionEntity } from "../logistics-scheduling/logistics-scheduling.entities.js"
import type { LogisticsDynamicScheduleVersionEntity, LogisticsRuntimeSnapshotEntity } from "../logistics-runtime/logistics-runtime.entities.js"

export interface LogisticsReviewAnalysisSources {
  routeVersion: LogisticsRoutePlanVersionEntity | null
  validation: LogisticsRouteValidationRunEntity | null
  schedule: LogisticsScheduleVersionEntity | null
  scheduleItems: LogisticsScheduleItemView[]
  snapshots: LogisticsRuntimeSnapshotEntity[]
  events: RuntimeEventEntity[]
  actions: StudentRuntimeActionEntity[]
  dynamicScheduleVersions: LogisticsDynamicScheduleVersionEntity[]
}

export function computeLogisticsReviewAnalysis(sources: LogisticsReviewAnalysisSources): V3LogisticsReviewAnalysisView {
  const finalProjection = sources.snapshots.at(-1)?.projection
  const summary = finalProjection?.summary ?? emptySummary()
  const triggeredEvents = sources.events.filter((event) => event.triggeredAt)
  const controlledEvents = triggeredEvents.filter(isControlledEvent)
  const unresolvedEvents = triggeredEvents.filter((event) => !isControlledEvent(event))
  const responseSeconds = responseTimes(sources.actions, triggeredEvents)
  const deadlineResults = sources.actions
    .map((action) => action.result?.withinDeadline)
    .filter((value): value is boolean => typeof value === "boolean")
  const submittedReschedules = sources.dynamicScheduleVersions.filter((version) => version.status === "SUBMITTED")
  const latestReschedule = submittedReschedules.at(-1) ?? null

  return {
    routeValidation: routeValidationAnalysis(sources),
    onTimeDelivery: onTimeDeliveryAnalysis(sources.scheduleItems.length, finalProjection?.orders ?? [], summary),
    runtimeConflicts: runtimeConflictAnalysis(sources, triggeredEvents, controlledEvents, unresolvedEvents),
    aircraftUtilization: aircraftUtilizationAnalysis(sources, summary),
    abnormalResponse: abnormalResponseAnalysis(triggeredEvents, controlledEvents, sources.actions, responseSeconds, deadlineResults),
    rescheduleOutcome: rescheduleOutcomeAnalysis(submittedReschedules, latestReschedule, triggeredEvents.length, summary)
  }
}

function routeValidationAnalysis(sources: LogisticsReviewAnalysisSources): V3LogisticsReviewAnalysisSectionView {
  const result = sources.validation?.result
  const blockingCount = result?.evidence.filter((item) => item.blocking).length ?? 0
  const riskCount = result?.evidence.filter((item) => item.severity === "RISK").length ?? 0
  const passed = sources.validation?.status === "PASSED" || sources.validation?.status === "WITH_RISK"
  const roundTrips = result?.completedRoundTripCount ?? 0
  const requiredRoundTrips = result?.requiredRoundTripCount ?? 0
  return section(
    "ROUTE_VALIDATION",
    "航线验证",
    sources.validation ? (passed ? "PASS" : "RISK") : "INFO",
    sources.validation ? `${roundTrips}/${requiredRoundTrips} 组往返验证完成` : "尚无航线验证结果",
    sources.validation
      ? `第 ${sources.validation.attemptNo} 次验证状态为 ${sources.validation.status}，阻断项 ${blockingCount} 个、风险项 ${riskCount} 个。`
      : "提交并验证正式航线后，系统将汇总往返可达性和风险证据。",
    [
      analysisMetric("ROUTE_COUNT", "正式航线", sources.routeVersion?.routes?.length ?? 0, "条"),
      analysisMetric("ROUND_TRIP", "完成往返", roundTrips, "组"),
      analysisMetric("BLOCKING", "阻断项", blockingCount, "个"),
      analysisMetric("RISK", "风险项", riskCount, "个")
    ]
  )
}

function onTimeDeliveryAnalysis(
  scheduledOrderCount: number,
  orders: Array<{ status: string; expectedArrivalTimeMs: number | null; latestArrivalTimeMs: number }>,
  summary: LogisticsRuntimeSummaryView
): V3LogisticsReviewAnalysisSectionView {
  const deliveredCount = summary.completedOrders + summary.delayedOrders
  const onTimeCount = orders.filter((order) => order.status === "COMPLETED" && order.expectedArrivalTimeMs !== null && order.expectedArrivalTimeMs <= order.latestArrivalTimeMs).length
  const onTimeRate = percentage(onTimeCount, deliveredCount)
  const completionRate = percentage(deliveredCount, scheduledOrderCount)
  const state: ShowObjectiveMetricState = scheduledOrderCount > 0 && deliveredCount === scheduledOrderCount && onTimeCount === deliveredCount ? "PASS" : "RISK"
  return section(
    "ON_TIME_DELIVERY",
    "按时完成率",
    state,
    `${formatPercent(onTimeRate)} 准时送达`,
    `${deliveredCount}/${scheduledOrderCount} 单完成配送，其中 ${summary.delayedOrders} 单延误、${summary.failedOrders} 单失败。`,
    [
      analysisMetric("COMPLETION_RATE", "配送完成率", completionRate, "%"),
      analysisMetric("ON_TIME_RATE", "准时送达率", onTimeRate, "%"),
      analysisMetric("DELAYED", "延误订单", summary.delayedOrders, "单"),
      analysisMetric("FAILED", "失败订单", summary.failedOrders, "单")
    ]
  )
}

function runtimeConflictAnalysis(
  sources: LogisticsReviewAnalysisSources,
  triggeredEvents: RuntimeEventEntity[],
  controlledEvents: RuntimeEventEntity[],
  unresolvedEvents: RuntimeEventEntity[]
): V3LogisticsReviewAnalysisSectionView {
  const affectedAircraft = uniquePayloadIds(triggeredEvents, "affectedAircraftIds")
  const affectedRoutes = uniquePayloadIds(triggeredEvents, "affectedRouteIds")
  const initialConflicts = sources.schedule?.checkResult.conflictCount ?? 0
  const state: ShowObjectiveMetricState = initialConflicts === 0 && unresolvedEvents.length === 0 ? "PASS" : "RISK"
  return section(
    "RUNTIME_CONFLICTS",
    "运行冲突",
    state,
    unresolvedEvents.length ? `${unresolvedEvents.length} 个冲突尚未闭环` : `${controlledEvents.length}/${triggeredEvents.length} 个运行事件已闭环`,
    `初始调度硬冲突 ${initialConflicts} 个；运行中 ${affectedAircraft.size} 架无人机、${affectedRoutes.size} 条航线受到事件影响。`,
    [
      analysisMetric("INITIAL_CONFLICTS", "初始硬冲突", initialConflicts, "个"),
      analysisMetric("TRIGGERED_EVENTS", "触发事件", triggeredEvents.length, "个"),
      analysisMetric("UNRESOLVED_EVENTS", "未闭环事件", unresolvedEvents.length, "个"),
      analysisMetric("AFFECTED_AIRCRAFT", "受影响无人机", affectedAircraft.size, "架")
    ]
  )
}

function aircraftUtilizationAnalysis(sources: LogisticsReviewAnalysisSources, summary: LogisticsRuntimeSummaryView): V3LogisticsReviewAnalysisSectionView {
  const usedAircraft = new Set(sources.scheduleItems.map((item) => item.aircraftId))
  const totalAircraft = summary.totalAircraft || usedAircraft.size
  const utilizationRate = percentage(usedAircraft.size, totalAircraft)
  const peakAirborne = sources.snapshots.reduce((maximum, snapshot) => Math.max(maximum, snapshot.projection.summary.airborneAircraft), 0)
  const averageMissions = usedAircraft.size ? round(sources.scheduleItems.length / usedAircraft.size, 1) : 0
  const state: ShowObjectiveMetricState = sources.scheduleItems.length === 0 ? "INFO" : usedAircraft.size === totalAircraft ? "PASS" : "INFO"
  return section(
    "AIRCRAFT_UTILIZATION",
    "无人机利用",
    state,
    `${usedAircraft.size}/${totalAircraft} 架投入任务`,
    `机群任务覆盖率 ${formatPercent(utilizationRate)}，峰值同时在航 ${peakAirborne} 架，已使用无人机平均执行 ${averageMissions} 单。`,
    [
      analysisMetric("FLEET_UTILIZATION", "机群任务覆盖率", utilizationRate, "%"),
      analysisMetric("USED_AIRCRAFT", "投入任务", usedAircraft.size, "架"),
      analysisMetric("PEAK_AIRBORNE", "峰值在航", peakAirborne, "架"),
      analysisMetric("MISSIONS_PER_AIRCRAFT", "平均任务", averageMissions, "单/架")
    ]
  )
}

function abnormalResponseAnalysis(
  triggeredEvents: RuntimeEventEntity[],
  controlledEvents: RuntimeEventEntity[],
  actions: StudentRuntimeActionEntity[],
  responseSeconds: number[],
  deadlineResults: boolean[]
): V3LogisticsReviewAnalysisSectionView {
  const discoveredCount = triggeredEvents.filter((event) => nullableNumber(event.payload.detectedSimulationTimeMs) !== null).length
  const averageResponseSeconds = responseSeconds.length ? round(responseSeconds.reduce((sum, value) => sum + value, 0) / responseSeconds.length, 1) : 0
  const deadlinePassCount = deadlineResults.filter(Boolean).length
  const deadlinePassRate = percentage(deadlinePassCount, deadlineResults.length)
  const controlRate = percentage(controlledEvents.length, triggeredEvents.length)
  const state: ShowObjectiveMetricState = triggeredEvents.length === 0
    ? "INFO"
    : actions.length === 0
      ? "RISK"
      : controlledEvents.length === triggeredEvents.length && (deadlineResults.length === 0 || deadlinePassCount === deadlineResults.length) ? "PASS" : "RISK"
  return section(
    "ABNORMAL_RESPONSE",
    "异常响应",
    state,
    triggeredEvents.length === 0 ? "运行中未触发异常事件" : actions.length === 0 ? "未记录学生处置" : `${formatPercent(controlRate)} 事件已控制`,
    responseSeconds.length
      ? `共执行 ${actions.length} 次处置，平均响应 ${averageResponseSeconds} 秒，${deadlinePassCount}/${deadlineResults.length} 次有时限记录的处置达标。`
      : `共执行 ${actions.length} 次处置，当前没有可关联的响应时长记录。`,
    [
      analysisMetric("DISCOVERED_EVENTS", "发现事件", discoveredCount, "个"),
      analysisMetric("CONTROL_RATE", "事件控制率", controlRate, "%"),
      analysisMetric("AVERAGE_RESPONSE", "平均响应", responseSeconds.length ? averageResponseSeconds : "无记录", responseSeconds.length ? "秒" : null),
      analysisMetric("DEADLINE_PASS_RATE", "时限达标率", deadlineResults.length ? deadlinePassRate : "未设置", deadlineResults.length ? "%" : null)
    ]
  )
}

function rescheduleOutcomeAnalysis(
  versions: LogisticsDynamicScheduleVersionEntity[],
  latestVersion: LogisticsDynamicScheduleVersionEntity | null,
  triggeredEventCount: number,
  summary: LogisticsRuntimeSummaryView
): V3LogisticsReviewAnalysisSectionView {
  const affectedOrders = new Set(versions.flatMap((version) => version.affectedOrderIds))
  const affectedAircraft = new Set(versions.flatMap((version) => version.affectedAircraftIds))
  const affectedRoutes = new Set(versions.flatMap((version) => version.affectedRouteIds))
  const remainingConflicts = latestVersion?.checkResult.conflictCount ?? 0
  const state: ShowObjectiveMetricState = versions.length === 0 ? "INFO" : remainingConflicts === 0 && summary.failedOrders === 0 ? "PASS" : "RISK"
  return section(
    "RESCHEDULE_OUTCOME",
    "重调度结果",
    state,
    versions.length ? `${versions.length} 个动态调度版本已生效` : "未提交动态重调度",
    versions.length
      ? `最新为 V${latestVersion?.versionNo ?? "-"}，影响 ${affectedOrders.size} 单、${affectedAircraft.size} 架无人机和 ${affectedRoutes.size} 条航线；生效方案剩余硬冲突 ${remainingConflicts} 个。`
      : triggeredEventCount ? "运行中已出现事件，但当前尝试没有提交动态调度版本。" : "本次运行没有触发需要重调度的场景。",
    [
      analysisMetric("SUBMITTED_VERSIONS", "生效版本", versions.length, "个"),
      analysisMetric("AFFECTED_ORDERS", "调整订单", affectedOrders.size, "单"),
      analysisMetric("AFFECTED_AIRCRAFT", "调整无人机", affectedAircraft.size, "架"),
      analysisMetric("REMAINING_CONFLICTS", "剩余硬冲突", remainingConflicts, "个")
    ]
  )
}

function section(
  code: V3LogisticsReviewAnalysisSectionView["code"],
  label: string,
  state: ShowObjectiveMetricState,
  headline: string,
  detail: string,
  metrics: V3LogisticsReviewAnalysisMetricView[]
): V3LogisticsReviewAnalysisSectionView {
  return { code, label, state, headline, detail, metrics }
}

function analysisMetric(code: string, label: string, value: number | string, unit: string | null): V3LogisticsReviewAnalysisMetricView {
  const normalized = typeof value === "number" ? round(value, 1) : value
  return { code, label, value: normalized, displayValue: `${normalized}${unit ?? ""}`, unit }
}

function responseTimes(actions: StudentRuntimeActionEntity[], events: RuntimeEventEntity[]): number[] {
  const eventsById = new Map(events.map((event) => [event.id, event]))
  return actions.map((action) => {
    const detectedAt = action.eventId ? nullableNumber(eventsById.get(action.eventId)?.payload.detectedSimulationTimeMs) : null
    return detectedAt === null ? null : Math.max(0, Number(action.simulationTimeMs) - detectedAt) / 1_000
  }).filter((value): value is number => value !== null)
}

function uniquePayloadIds(events: RuntimeEventEntity[], key: string): Set<string> {
  return new Set(events.flatMap((event) => {
    const values = event.payload[key]
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : []
  }))
}

function isControlledEvent(event: RuntimeEventEntity): boolean {
  return event.status === "RESOLVED" || event.payload.lifecycleStatus === "CONTROLLED" || event.payload.lifecycleStatus === "ENDED"
}

function emptySummary(): LogisticsRuntimeSummaryView {
  return {
    totalAircraft: 0,
    availableAircraft: 0,
    assignedAircraft: 0,
    airborneAircraft: 0,
    holdingAircraft: 0,
    warningAircraft: 0,
    disabledAircraft: 0,
    totalOrders: 0,
    unreleasedOrders: 0,
    waitingOrders: 0,
    deliveringOrders: 0,
    completedOrders: 0,
    delayedOrders: 0,
    failedOrders: 0,
    cancelledOrders: 0
  }
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? round(numerator / denominator * 100, 1) : 0
}

function formatPercent(value: number): string {
  return `${round(value, 1)}%`
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
