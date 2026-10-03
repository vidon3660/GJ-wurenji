import type { RuntimeEventStatus, RuntimeJsonObject, RuntimeMode } from "@wurenji/shared"
import { deterministicWindowTime } from "./scenario-event-rules.js"

export type RuntimeEventTriggerSource = "FIXED" | "WINDOW" | "MANUAL"

export interface RuntimeEventScheduleDefinition {
  id: string
  code: string
  source: RuntimeEventTriggerSource
  fixedTimeMs?: number
  windowMs?: [number, number]
  manualAllowedModes?: RuntimeMode[]
  payload?: RuntimeJsonObject
}

export interface ScheduledRuntimeEvent {
  id: string
  code: string
  source: RuntimeEventTriggerSource
  status: RuntimeEventStatus
  scheduledSimulationTimeMs: number | null
  triggeredSimulationTimeMs: number | null
  resolvedSimulationTimeMs: number | null
  payload: RuntimeJsonObject
  seed: string
  index: number
}

export type RuntimeEventSchedulerErrorCode = "EVENT_NOT_FOUND" | "EVENT_ALREADY_TRIGGERED" | "MANUAL_TRIGGER_NOT_ALLOWED" | "MANUAL_TRIGGER_OUTSIDE_WINDOW"

export function scheduleRuntimeWindowTime(seed: string, code: string, index: number, durationMs: number, windowSeconds: [number, number]): number {
  return deterministicWindowTime(seed, code, index, durationMs, windowSeconds)
}

export class RuntimeEventSchedulerError extends Error {
  constructor(readonly code: RuntimeEventSchedulerErrorCode, message: string) {
    super(message)
    this.name = "RuntimeEventSchedulerError"
  }
}

export function buildRuntimeEventSchedule(
  definitions: readonly RuntimeEventScheduleDefinition[],
  seed: string,
  durationMs: number
): ScheduledRuntimeEvent[] {
  return definitions.map((definition, index) => ({
    id: definition.id,
    code: definition.code,
    source: definition.source,
    status: "SCHEDULED",
    scheduledSimulationTimeMs: scheduleTime(definition, seed, index, durationMs),
    triggeredSimulationTimeMs: null,
    resolvedSimulationTimeMs: null,
    payload: definition.payload ?? {},
    seed,
    index
  }))
}

export function activateDueRuntimeEvents(events: readonly ScheduledRuntimeEvent[], simulationTimeMs: number): ScheduledRuntimeEvent[] {
  const now = Math.max(0, Math.floor(simulationTimeMs))
  return events.map((event) => event.status === "SCHEDULED" && event.scheduledSimulationTimeMs !== null && event.scheduledSimulationTimeMs <= now
    ? { ...event, status: "ACTIVE", triggeredSimulationTimeMs: now }
    : { ...event })
}

export function triggerRuntimeEventManually(
  events: readonly ScheduledRuntimeEvent[],
  eventId: string,
  mode: RuntimeMode,
  simulationTimeMs: number
): ScheduledRuntimeEvent[] {
  const index = events.findIndex((event) => event.id === eventId)
  if (index < 0) throw new RuntimeEventSchedulerError("EVENT_NOT_FOUND", "运行事件不存在")
  const event = events[index]
  if (!event) throw new RuntimeEventSchedulerError("EVENT_NOT_FOUND", "运行事件不存在")
  if (event.status !== "SCHEDULED") throw new RuntimeEventSchedulerError("EVENT_ALREADY_TRIGGERED", "事件已经触发或结束")
  const definitionWindow = event.payload.manualWindowStartMs !== undefined && event.payload.manualWindowEndMs !== undefined
    ? [Number(event.payload.manualWindowStartMs), Number(event.payload.manualWindowEndMs)] as const
    : null
  const allowedModes = event.payload.manualAllowedModes
  if (allowedModes !== undefined && (!Array.isArray(allowedModes) || !allowedModes.every((item): item is RuntimeMode => item === "TRAINING" || item === "ASSESSMENT") || !allowedModes.includes(mode))) {
    throw new RuntimeEventSchedulerError("MANUAL_TRIGGER_NOT_ALLOWED", "当前模式不允许手动触发该事件")
  }
  const now = Math.max(0, Math.floor(simulationTimeMs))
  if (definitionWindow && (now < definitionWindow[0] || now > definitionWindow[1])) {
    throw new RuntimeEventSchedulerError("MANUAL_TRIGGER_OUTSIDE_WINDOW", "不在事件允许窗口内")
  }
  return events.map((candidate, candidateIndex) => candidateIndex === index
    ? { ...candidate, status: "ACTIVE", source: "MANUAL", scheduledSimulationTimeMs: now, triggeredSimulationTimeMs: now }
    : { ...candidate })
}

export function resolveRuntimeEvent(events: readonly ScheduledRuntimeEvent[], eventId: string, simulationTimeMs: number): ScheduledRuntimeEvent[] {
  return events.map((event) => event.id === eventId && event.status === "ACTIVE"
    ? { ...event, status: "RESOLVED", resolvedSimulationTimeMs: Math.max(0, Math.floor(simulationTimeMs)) }
    : { ...event })
}

function scheduleTime(definition: RuntimeEventScheduleDefinition, seed: string, index: number, durationMs: number): number | null {
  if (definition.source === "MANUAL") return null
  if (definition.source === "FIXED") return clampTime(definition.fixedTimeMs ?? 0, durationMs)
  if (!definition.windowMs) return null
  return scheduleRuntimeWindowTime(seed, definition.code, index, durationMs, [definition.windowMs[0] / 1_000, definition.windowMs[1] / 1_000])
}

function clampTime(value: number, durationMs: number): number {
  return Math.max(0, Math.min(Math.max(0, Math.floor(durationMs)), Math.floor(value)))
}
