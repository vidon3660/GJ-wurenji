import {
  logisticsGustStates,
  logisticsRainStates,
  logisticsSignalStates,
  logisticsTimeWindowProfiles,
  logisticsWindDirections,
  logisticsWindForceStates,
  type LogisticsInitialEnvironmentConfig,
  type LogisticsInitialFleetConfig,
  type LogisticsTimeWindowProfile
} from "./types.js"

export function logisticsTimeWindowMinutes(profile: LogisticsTimeWindowProfile): number {
  if (profile === "NONE") return 240
  if (profile === "RELAXED") return 120
  if (profile === "TIGHT") return 20
  return 45
}

export function resolveLogisticsTimeWindowProfile(scenario: Record<string, unknown>): LogisticsTimeWindowProfile {
  if (typeof scenario.timeWindowProfile === "string" && (logisticsTimeWindowProfiles as readonly string[]).includes(scenario.timeWindowProfile)) {
    return scenario.timeWindowProfile as LogisticsTimeWindowProfile
  }
  const minutes = Number(scenario.timeWindowMinutes)
  if (!Number.isFinite(minutes)) return "NORMAL"
  if (minutes >= 240) return "NONE"
  if (minutes >= 90) return "RELAXED"
  if (minutes <= 25) return "TIGHT"
  return "NORMAL"
}

export function resolveLogisticsInitialFleet(scenario: Record<string, unknown>, totalAircraft: number): LogisticsInitialFleetConfig {
  const unavailableAircraftCount = nonNegativeCount(scenario.initialUnavailableAircraftCount)
  const lowBatteryAircraftCount = nonNegativeCount(scenario.initialLowBatteryAircraftCount)
  const standbyAircraftCount = nonNegativeCount(scenario.initialStandbyAircraftCount)
  const preflightAbnormalAircraftCount = nonNegativeCount(scenario.initialPreflightAbnormalAircraftCount)
  return {
    readyAircraftCount: Math.max(0, totalAircraft - unavailableAircraftCount - lowBatteryAircraftCount - standbyAircraftCount - preflightAbnormalAircraftCount),
    standbyAircraftCount,
    lowBatteryAircraftCount,
    preflightAbnormalAircraftCount,
    unavailableAircraftCount
  }
}

export function resolveLogisticsInitialEnvironment(scenario: Record<string, unknown>): LogisticsInitialEnvironmentConfig {
  const legacyWindProfile = typeof scenario.windProfile === "string" ? scenario.windProfile : "CALM"
  return {
    windDirection: enumValue(scenario.initialWindDirection, logisticsWindDirections, "N"),
    windForceState: enumValue(scenario.initialWindForceState, logisticsWindForceStates, legacyWindProfile === "CROSSWIND" ? "NEAR_LIMIT" : "NORMAL"),
    gustState: enumValue(scenario.initialGustState, logisticsGustStates, legacyWindProfile === "GUST" ? "OCCASIONAL" : "NONE"),
    rainState: enumValue(scenario.initialRainState, logisticsRainStates, "NONE"),
    positioningState: enumValue(scenario.initialPositioningState, logisticsSignalStates, "NORMAL"),
    communicationState: enumValue(scenario.initialCommunicationState, logisticsSignalStates, "NORMAL")
  }
}

function nonNegativeCount(value: unknown): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T[number] : fallback
}
