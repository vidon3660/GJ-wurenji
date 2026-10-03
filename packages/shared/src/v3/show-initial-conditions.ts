import {
  showCommunicationControlStates,
  showGustStates,
  showInitialDeviceScopes,
  showInitialDeviceStates,
  showPositioningElectromagneticStates,
  showRainStates,
  showWindDirections,
  showWindForceStates,
  type ShowCommunicationControlState,
  type ShowInitialConditionsConfig,
  type ShowInitialDeviceScope,
  type ShowInitialDeviceState,
  type ShowPositioningElectromagneticState
} from "./types.js"

export const showScaleTemplateCodes = ["SHOW_100", "SHOW_500", "SHOW_1000", "SHOW_3000"] as const

export type ShowScaleTemplateCode = (typeof showScaleTemplateCodes)[number]

export function isSupportedShowScaleTemplateCode(value: string): value is ShowScaleTemplateCode {
  return (showScaleTemplateCodes as readonly string[]).includes(value)
}

export function showTemplateAircraftCount(scaleTemplateCode: string): number {
  const value = Number(scaleTemplateCode.match(/(100|500|1000|3000|5000)(?!\d)/)?.[1] ?? scaleTemplateCode.match(/(\d+)/)?.[1] ?? 100)
  return [100, 500, 1000, 3000, 5000].includes(value) ? value : 100
}

export function resolveShowInitialConditions(scenario: Record<string, unknown>, totalAircraft: number): ShowInitialConditionsConfig {
  const source = record(scenario.showInitialConditions)
  const legacyWindProfile = text(scenario.windProfile) ?? "CALM"
  const positioningLegacy = text(scenario.positioningProfile)
  const communicationLegacy = text(scenario.communicationProfile)
  const deviceState = enumValue(source.deviceState, showInitialDeviceStates, "NORMAL")
  const requestedScope = enumValue(source.deviceImpactScope, showInitialDeviceScopes, deviceState === "NORMAL" ? "NONE" : "SINGLE")
  const deviceImpactScope = deviceState === "NORMAL" ? "NONE" : requestedScope === "NONE" ? "SINGLE" : requestedScope
  return {
    windDirection: enumValue(source.windDirection, showWindDirections, "SE"),
    windForceState: enumValue(source.windForceState, showWindForceStates, legacyWindProfile === "CROSSWIND" ? "NEAR_LIMIT" : "NORMAL"),
    gustState: enumValue(source.gustState, showGustStates, legacyWindProfile === "GUST" ? "OCCASIONAL" : "NONE"),
    rainState: enumValue(source.rainState, showRainStates, text(scenario.visibilityLevel) === "LIMITED" ? "BELOW_LIMIT" : "NONE"),
    positioningElectromagneticState: enumValue(source.positioningElectromagneticState ?? positioningLegacy, showPositioningElectromagneticStates, "NORMAL"),
    communicationControlState: enumValue(source.communicationControlState ?? communicationLegacy, showCommunicationControlStates, "NORMAL"),
    deviceState,
    deviceImpactScope,
    deviceAffectedCount: showInitialDeviceAffectedCount(totalAircraft, deviceState, deviceImpactScope)
  }
}

export function showInitialDeviceAffectedCount(totalAircraft: number, state: ShowInitialDeviceState, scope: ShowInitialDeviceScope): number {
  if (state === "NORMAL" || scope === "NONE") return 0
  const total = Math.max(1, Math.floor(totalAircraft))
  if (scope === "SINGLE") return 1
  if (scope === "SMALL_BATCH") return Math.min(total, Math.max(2, Math.ceil(total * 0.02)))
  const groupSize = Math.max(1, Math.ceil(total / Math.max(1, Math.ceil(total / 100))))
  return Math.min(total, scope === "MULTI_GROUP" ? groupSize * 2 : groupSize)
}

export function minimumShowAircraftForPositioningState(state: ShowPositioningElectromagneticState): number {
  return ({ NORMAL: 100, LOCAL_WEAK: 500, LOCAL_ABNORMAL: 1000, CONTINUOUS_INTERFERENCE: 3000, WIDE_AREA_INTERFERENCE: 5000 } as const)[state]
}

export function minimumShowAircraftForCommunicationState(state: ShowCommunicationControlState): number {
  return ({ NORMAL: 100, DELAY: 100, PACKET_LOSS: 100, SINGLE_LOST: 100, SMALL_BATCH_LOST: 500, GROUP_ABNORMAL: 1000, MULTI_GROUP_ABNORMAL: 3000 } as const)[state]
}

export function minimumShowAircraftForDeviceScope(scope: ShowInitialDeviceScope): number {
  return ({ NONE: 100, SINGLE: 100, SMALL_BATCH: 500, GROUP: 1000, MULTI_GROUP: 3000 } as const)[scope]
}

export function showWindDirectionLabel(value: ShowInitialConditionsConfig["windDirection"]): string {
  return ({ N: "北风", NE: "东北风", E: "东风", SE: "东南风", S: "南风", SW: "西南风", W: "西风", NW: "西北风" } as const)[value]
}

export function showWindForceLabel(value: ShowInitialConditionsConfig["windForceState"]): string {
  return ({ NORMAL: "正常", NEAR_LIMIT: "接近限制", OVER_LIMIT: "超过限制" } as const)[value]
}

export function showGustLabel(value: ShowInitialConditionsConfig["gustState"]): string {
  return ({ NONE: "无", OCCASIONAL: "偶发", CONTINUOUS: "持续" } as const)[value]
}

export function showRainLabel(value: ShowInitialConditionsConfig["rainState"]): string {
  return ({ NONE: "无", BELOW_LIMIT: "低于限制", OVER_LIMIT: "超过限制" } as const)[value]
}

export function showPositioningElectromagneticLabel(value: ShowPositioningElectromagneticState): string {
  return ({ NORMAL: "正常", LOCAL_WEAK: "局部较弱", LOCAL_ABNORMAL: "局部异常", CONTINUOUS_INTERFERENCE: "持续干扰", WIDE_AREA_INTERFERENCE: "大范围干扰" } as const)[value]
}

export function showCommunicationControlLabel(value: ShowCommunicationControlState): string {
  return ({ NORMAL: "正常", DELAY: "延迟", PACKET_LOSS: "丢包", SINGLE_LOST: "单架失联", SMALL_BATCH_LOST: "小批量失联", GROUP_ABNORMAL: "分组异常", MULTI_GROUP_ABNORMAL: "多分组异常" } as const)[value]
}

export function showInitialDeviceStateLabel(value: ShowInitialDeviceState): string {
  return ({ NORMAL: "正常", SELF_TEST_FAILURE: "自检失败", BATTERY_ABNORMAL: "电池异常", VOLTAGE_IMBALANCE: "电压压差异常", POWER_SYSTEM_ABNORMAL: "动力系统异常", FLIGHT_CONTROL_SENSOR_ABNORMAL: "飞控/传感器异常", RETURN_LANDING_ABNORMAL: "返航或降落异常" } as const)[value]
}

export function showInitialDeviceScopeLabel(value: ShowInitialDeviceScope): string {
  return ({ NONE: "无", SINGLE: "单架", SMALL_BATCH: "小批量", GROUP: "分组", MULTI_GROUP: "多分组" } as const)[value]
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T[number] : fallback
}
