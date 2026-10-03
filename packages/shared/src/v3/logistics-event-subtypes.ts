export const logisticsScenarioEventSubtypes = [
  "BATTERY_CONSUMPTION_ANOMALY",
  "PROPULSION_ALERT",
  "FLIGHT_CONTROL_ALERT",
  "SENSOR_ALERT",
  "RETURN_OR_LANDING_UNAVAILABLE",
  "SEGMENT_CONDITION_DETERIORATION",
  "ROUTE_SUSPENSION",
  "DELIVERY_POINT_STATE_CHANGE",
  "WAITING_POINT_STATE_CHANGE",
  "ALTERNATE_LANDING_POINT_STATE_CHANGE"
] as const

export type LogisticsScenarioEventSubtype = (typeof logisticsScenarioEventSubtypes)[number]

export interface LogisticsScenarioEventSubtypeDefinition {
  code: LogisticsScenarioEventSubtype
  eventCode: "AIRCRAFT_FAULT" | "ROUTE_SUSPENDED" | "NODE_UNAVAILABLE"
  label: string
}

const definitions: readonly LogisticsScenarioEventSubtypeDefinition[] = [
  { code: "BATTERY_CONSUMPTION_ANOMALY", eventCode: "AIRCRAFT_FAULT", label: "电池消耗异常" },
  { code: "PROPULSION_ALERT", eventCode: "AIRCRAFT_FAULT", label: "动力系统告警" },
  { code: "FLIGHT_CONTROL_ALERT", eventCode: "AIRCRAFT_FAULT", label: "飞控系统告警" },
  { code: "SENSOR_ALERT", eventCode: "AIRCRAFT_FAULT", label: "传感器告警" },
  { code: "RETURN_OR_LANDING_UNAVAILABLE", eventCode: "AIRCRAFT_FAULT", label: "无法正常返航或降落" },
  { code: "SEGMENT_CONDITION_DETERIORATION", eventCode: "ROUTE_SUSPENDED", label: "航段运行条件恶化" },
  { code: "ROUTE_SUSPENSION", eventCode: "ROUTE_SUSPENDED", label: "航线暂停运行" },
  { code: "DELIVERY_POINT_STATE_CHANGE", eventCode: "NODE_UNAVAILABLE", label: "配送点状态变化" },
  { code: "WAITING_POINT_STATE_CHANGE", eventCode: "NODE_UNAVAILABLE", label: "等待点状态变化" },
  { code: "ALTERNATE_LANDING_POINT_STATE_CHANGE", eventCode: "NODE_UNAVAILABLE", label: "备降点状态变化" }
]

export function logisticsEventSubtypeDefinitions(eventCode?: string): LogisticsScenarioEventSubtypeDefinition[] {
  return definitions
    .filter((item) => !eventCode || item.eventCode === eventCode)
    .map((item) => ({ ...item }))
}

export function logisticsEventSubtypesForCode(eventCode: string): LogisticsScenarioEventSubtype[] {
  return definitions.filter((item) => item.eventCode === eventCode).map((item) => item.code)
}

export function defaultLogisticsEventSubtype(eventCode: string): LogisticsScenarioEventSubtype | null {
  return definitions.find((item) => item.eventCode === eventCode)?.code ?? null
}

export function isLogisticsScenarioEventSubtype(value: unknown): value is LogisticsScenarioEventSubtype {
  return typeof value === "string" && logisticsScenarioEventSubtypes.includes(value as LogisticsScenarioEventSubtype)
}

export function isLogisticsEventSubtypeAllowed(eventCode: string, subtype: unknown): subtype is LogisticsScenarioEventSubtype {
  return isLogisticsScenarioEventSubtype(subtype) && definitions.some((item) => item.eventCode === eventCode && item.code === subtype)
}

export function logisticsEventSubtypeLabel(value: unknown): string | null {
  return definitions.find((item) => item.code === value)?.label ?? null
}
