import { BadRequestException } from "@nestjs/common"
import {
  minimumShowAircraftForCommunicationState,
  minimumShowAircraftForDeviceScope,
  minimumShowAircraftForPositioningState,
  resolveShowInitialConditions,
  showCommunicationControlStates,
  showGustStates,
  showInitialDeviceScopes,
  showInitialDeviceStates,
  showPositioningElectromagneticStates,
  showRainStates,
  showTemplateAircraftCount,
  showWindDirections,
  showWindForceStates,
  type ShowInitialConditionsConfig
} from "@wurenji/shared"

export function normalizeShowInitialConditions(scenario: Record<string, unknown>, scaleTemplateCode: string): ShowInitialConditionsConfig {
  const raw = scenario.showInitialConditions
  if (raw !== undefined && !isRecord(raw)) throw new BadRequestException("表演初始条件格式无效")
  const source = isRecord(raw) ? raw : {}
  assertOptionalEnum(source.windDirection, showWindDirections, "初始风向")
  assertOptionalEnum(source.windForceState, showWindForceStates, "初始风力状态")
  assertOptionalEnum(source.gustState, showGustStates, "初始阵风状态")
  assertOptionalEnum(source.rainState, showRainStates, "初始降雨状态")
  assertOptionalEnum(source.positioningElectromagneticState, showPositioningElectromagneticStates, "初始定位与电磁状态")
  assertOptionalEnum(source.communicationControlState, showCommunicationControlStates, "初始通信与控制状态")
  assertOptionalEnum(source.deviceState, showInitialDeviceStates, "初始设备状态")
  assertOptionalEnum(source.deviceImpactScope, showInitialDeviceScopes, "初始设备影响范围")
  const totalAircraft = showTemplateAircraftCount(scaleTemplateCode)
  const normalized = resolveShowInitialConditions(scenario, totalAircraft)
  if (totalAircraft < minimumShowAircraftForPositioningState(normalized.positioningElectromagneticState)) throw new BadRequestException("当前架数模板未开放所选定位与电磁状态")
  if (totalAircraft < minimumShowAircraftForCommunicationState(normalized.communicationControlState)) throw new BadRequestException("当前架数模板未开放所选通信与控制状态")
  if (totalAircraft < minimumShowAircraftForDeviceScope(normalized.deviceImpactScope)) throw new BadRequestException("当前架数模板未开放所选设备影响范围")
  return normalized
}

function assertOptionalEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) throw new BadRequestException(`${label}无效`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
