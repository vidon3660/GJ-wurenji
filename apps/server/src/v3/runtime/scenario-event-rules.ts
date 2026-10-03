import type {
  V3ScenarioEventCondition,
  V3ScenarioEventConfig,
  V3ScenarioEventImpactScope,
  V3ScenarioEventTriggerMode,
  V3ScenarioEventVisibilityMode
} from "@wurenji/shared"
import { isLogisticsScenarioEventSubtype } from "@wurenji/shared"

export interface ScenarioEventConditionContext {
  phase?: string | undefined
  phaseOrder?: string[] | undefined
  currentSimulationTimeMs: number
  eventStatuses?: Record<string, string> | undefined
  values?: Record<string, number | string> | undefined
}

export function parseScenarioEventConfig(input: Record<string, unknown>, code: string, defaultPhase: string): V3ScenarioEventConfig {
  const triggerMode = isTriggerMode(input.triggerMode) ? input.triggerMode : "AUTO"
  return {
    code,
    eventSubtype: isLogisticsScenarioEventSubtype(input.eventSubtype) ? input.eventSubtype : null,
    triggerMode,
    triggerTimeSeconds: optionalNumber(input.triggerTimeSeconds),
    triggerPhase: typeof input.triggerPhase === "string" && input.triggerPhase.trim() ? input.triggerPhase.trim() : defaultPhase,
    triggerOffsetSeconds: numberOrZero(input.triggerOffsetSeconds),
    severity: isSeverity(input.severity) ? input.severity : null,
    detectionDelaySeconds: optionalNumber(input.detectionDelaySeconds),
    escalationDelaySeconds: optionalNumber(input.escalationDelaySeconds),
    durationSeconds: optionalNumber(input.durationSeconds),
    recoveryMode: input.recoveryMode === "AUTO" || input.recoveryMode === "CONDITION" || input.recoveryMode === "UNTIL_END" ? input.recoveryMode : "STUDENT",
    triggerWindowSeconds: scenarioWindow(input.triggerWindowSeconds),
    triggerCondition: scenarioCondition(input.triggerCondition),
    triggerAfterEventCode: optionalCode(input.triggerAfterEventCode),
    impactScope: isImpactScope(input.impactScope) ? input.impactScope : "DEFAULT",
    impactCount: optionalNumber(input.impactCount),
    targetIds: stringArray(input.targetIds),
    visibilityMode: isVisibilityMode(input.visibilityMode) ? input.visibilityMode : "AFTER_STATE_CHANGE",
    escalationEnabled: input.escalationEnabled !== false,
    followUpEventCode: optionalCode(input.followUpEventCode),
    recoveryCondition: scenarioCondition(input.recoveryCondition),
    actionDeadlineSeconds: optionalNumber(input.actionDeadlineSeconds)
  }
}

export function deterministicWindowTime(
  seed: string,
  code: string,
  index: number,
  durationMs: number,
  windowSeconds: [number, number]
): number {
  const lower = Math.max(0, Math.min(durationMs, Math.round(windowSeconds[0] * 1_000)))
  const upper = Math.max(lower, Math.min(durationMs, Math.round(windowSeconds[1] * 1_000)))
  if (upper === lower) return lower
  const hash = stableHash(`${seed}:${code}:${index}`)
  return lower + (hash % (upper - lower + 1))
}

export function visibilityDelayMs(config: V3ScenarioEventConfig | null, fallbackMs: number): number {
  if (config?.visibilityMode === "DIRECT") return 0
  if (config?.detectionDelaySeconds !== null && config?.detectionDelaySeconds !== undefined) {
    return Math.max(0, Math.round(config.detectionDelaySeconds * 1_000))
  }
  return Math.max(0, fallbackMs)
}

export function escalationDelayMs(config: V3ScenarioEventConfig | null, fallbackMs: number): number | null {
  if (config?.escalationEnabled === false) return null
  if (config?.escalationDelaySeconds !== null && config?.escalationDelaySeconds !== undefined) {
    return Math.max(0, Math.round(config.escalationDelaySeconds * 1_000))
  }
  return Math.max(0, fallbackMs)
}

export function manualTriggerWindowOpen(config: V3ScenarioEventConfig | null, simulationTimeMs: number): boolean {
  const window = config?.triggerWindowSeconds
  if (!window) return true
  const now = Math.max(0, Math.floor(simulationTimeMs))
  const start = Math.max(0, Math.round(window[0] * 1_000))
  const end = Math.max(start, Math.round(window[1] * 1_000))
  return now >= start && now <= end
}

export function triggerSatisfied(config: V3ScenarioEventConfig, context: ScenarioEventConditionContext): boolean {
  if (config.triggerMode === "AFTER_EVENT") {
    const code = config.triggerAfterEventCode
    return Boolean(code && context.eventStatuses?.[code] === "ACTIVE")
  }
  if (config.triggerMode !== "CONDITION" || !config.triggerCondition) return false
  return conditionSatisfied(config.triggerCondition, context)
}

export function recoverySatisfied(config: V3ScenarioEventConfig | null, context: ScenarioEventConditionContext): boolean {
  return config && config.recoveryMode === "CONDITION" && config.recoveryCondition
    ? conditionSatisfied(config.recoveryCondition, context)
    : false
}

export function canActivateScenarioEvent(activeEventCount: number, maximumConcurrentEvents: number): boolean {
  return activeEventCount < Math.max(1, Math.floor(maximumConcurrentEvents))
}

export function scenarioEventActiveCountAfterTransition(
  activeEventCount: number,
  previousStatus: "SCHEDULED" | "ACTIVE" | "RESOLVED",
  nextStatus: "SCHEDULED" | "ACTIVE" | "RESOLVED"
): number {
  if (previousStatus !== "ACTIVE" && nextStatus === "ACTIVE") return activeEventCount + 1
  if (previousStatus === "ACTIVE" && nextStatus !== "ACTIVE") return Math.max(0, activeEventCount - 1)
  return activeEventCount
}

function conditionSatisfied(condition: V3ScenarioEventCondition, context: ScenarioEventConditionContext): boolean {
  if (condition.type === "PHASE") {
    const current = context.phaseOrder?.indexOf(context.phase ?? "") ?? -1
    const expected = context.phaseOrder?.indexOf(String(condition.value)) ?? -1
    if (current < 0 || expected < 0) return context.phase === condition.value
    return compare(current, expected, condition.operator)
  }
  if (condition.type === "SIMULATION_TIME") return compare(context.currentSimulationTimeMs, Number(condition.value) * 1_000, condition.operator)
  if (condition.type === "EVENT_STATUS") {
    const actual = context.eventStatuses?.[condition.targetId ?? String(condition.value)]
    return condition.operator === "EQ" && actual === (condition.targetId ? String(condition.value) : "ACTIVE")
  }
  const key = condition.type === "MIN_AIRBORNE_AIRCRAFT"
    ? "airborneAircraft"
    : condition.type === "MIN_ACTIVE_ORDERS"
      ? "activeOrders"
      : condition.targetId ? `routeStatus:${condition.targetId}` : "routeStatus"
  const actual = context.values?.[key]
  if (actual === undefined) return false
  if (condition.type === "ROUTE_STATUS") return condition.operator === "EQ" && actual === condition.value
  return compare(Number(actual), Number(condition.value), condition.operator)
}

function compare(actual: number, expected: number, operator: V3ScenarioEventCondition["operator"]): boolean {
  if (operator === "GTE") return actual >= expected
  if (operator === "LTE") return actual <= expected
  return actual === expected
}

function stableHash(value: string): number {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
}

function isTriggerMode(value: unknown): value is V3ScenarioEventTriggerMode {
  return value === "AUTO" || value === "SIMULATION_TIME" || value === "PHASE" || value === "TIME_RANGE" || value === "CONDITION" || value === "AFTER_EVENT"
}

function isVisibilityMode(value: unknown): value is V3ScenarioEventVisibilityMode {
  return value === "DIRECT" || value === "AFTER_STATE_CHANGE" || value === "PARTIAL_DELAY"
}

function isImpactScope(value: unknown): value is V3ScenarioEventImpactScope {
  return value === "DEFAULT" || value === "SINGLE" || value === "SMALL_BATCH" || value === "GROUP" || value === "MULTI_GROUP" || value === "LOCAL_AREA" || value === "MOST" || value === "WHOLE" || value === "SINGLE_ROUTE" || value === "MULTI_ROUTE" || value === "OVERALL"
}

function isSeverity(value: unknown): value is V3ScenarioEventConfig["severity"] {
  return value === "INFO" || value === "WARNING" || value === "ERROR" || value === "CRITICAL"
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function numberOrZero(value: unknown): number {
  return optionalNumber(value) ?? 0
}

function optionalCode(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function scenarioWindow(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const start = optionalNumber(value[0])
  const end = optionalNumber(value[1])
  return start !== null && end !== null && start <= end ? [start, end] : null
}

function scenarioCondition(value: unknown): V3ScenarioEventCondition | null {
  if (!isRecord(value)) return null
  const type = value.type
  const operator = value.operator
  if (type !== "PHASE" && type !== "SIMULATION_TIME" && type !== "MIN_AIRBORNE_AIRCRAFT" && type !== "MIN_ACTIVE_ORDERS" && type !== "ROUTE_STATUS" && type !== "EVENT_STATUS") return null
  if (operator !== "EQ" && operator !== "GTE" && operator !== "LTE") return null
  if (typeof value.value !== "string" && typeof value.value !== "number") return null
  return {
    type,
    operator,
    value: value.value,
    targetId: typeof value.targetId === "string" && value.targetId.trim() ? value.targetId.trim() : null
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 500) : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
