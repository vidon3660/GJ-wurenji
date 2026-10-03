import type { LogisticsScheduleItemView, LogisticsSchedulingOrderView } from "@wurenji/shared"

export type LogisticsTimelineStageCode =
  | "OUTBOUND"
  | "ARRIVAL_SERVICE"
  | "RETURNING"
  | "LANDING"
  | "AVAILABLE_AGAIN"

export type LogisticsTimelineSegmentCode = "OUTBOUND" | "ARRIVAL_SERVICE" | "RETURNING" | "RECOVERY"

export interface LogisticsTimelineStage {
  code: LogisticsTimelineStageCode
  label: string
  startTimeMs: number
  endTimeMs: number
}

export interface LogisticsTimelineSegment {
  code: LogisticsTimelineSegmentCode
  label: string
  startTimeMs: number
  endTimeMs: number
}

export interface LogisticsTaskTimeline {
  stages: LogisticsTimelineStage[]
  segments: LogisticsTimelineSegment[]
}

export function buildLogisticsTaskTimeline(
  item: LogisticsScheduleItemView,
  order: LogisticsSchedulingOrderView
): LogisticsTaskTimeline {
  return {
    stages: [
      stage("OUTBOUND", "起飞与去程飞行", item.plannedTakeoffTimeMs, item.arrivalTimeMs),
      stage("ARRIVAL_SERVICE", "到达确认与服务", item.arrivalTimeMs, item.returnStartTimeMs),
      stage("RETURNING", "返程飞行", item.returnStartTimeMs, item.landingTimeMs),
      stage("LANDING", "降落", item.landingTimeMs),
      stage("AVAILABLE_AGAIN", "再次可用", item.nextAvailableTimeMs)
    ],
    segments: [
      segment("OUTBOUND", "去程", item.plannedTakeoffTimeMs, item.arrivalTimeMs),
      segment("ARRIVAL_SERVICE", "到达确认与服务", item.arrivalTimeMs, item.returnStartTimeMs),
      segment("RETURNING", "返程", item.returnStartTimeMs, item.landingTimeMs),
      segment("RECOVERY", "恢复", item.landingTimeMs, item.nextAvailableTimeMs)
    ]
  }
}

function stage(code: LogisticsTimelineStageCode, label: string, startTimeMs: number, endTimeMs = startTimeMs): LogisticsTimelineStage {
  return { code, label, startTimeMs, endTimeMs }
}

function segment(code: LogisticsTimelineSegmentCode, label: string, startTimeMs: number, endTimeMs: number): LogisticsTimelineSegment {
  return { code, label, startTimeMs, endTimeMs }
}
