import { BadRequestException, ConflictException } from "@nestjs/common"
import {
  logisticsGustStates,
  logisticsOrderDistributionModes,
  logisticsOrderReleasePhases,
  logisticsOrderReleaseModes,
  logisticsPriorityProfiles,
  logisticsRainStates,
  logisticsSignalStates,
  logisticsTimeWindowMinutes,
  logisticsTimeWindowProfiles,
  logisticsTemplatePolicy,
  logisticsWindDirections,
  logisticsWindForceStates,
  resolveLogisticsInitialEnvironment,
  resolveLogisticsInitialFleet,
  resolveLogisticsTimeWindowProfile,
  type LogisticsOrderGenerationConfig,
  type LogisticsScheduleItemInput
} from "@wurenji/shared"

export function logisticsOrderConfig(scaleTemplateCode: string, scenario: Record<string, unknown>, fallbackSeed: string): LogisticsOrderGenerationConfig {
  const policy = logisticsTemplatePolicy(scaleTemplateCode)
  const orderCount = Number(scenario.orderCount ?? policy.defaultOrderCount)
  if (!Number.isInteger(orderCount) || orderCount < policy.orderCountRange.minimum || orderCount > policy.orderCountRange.maximum) {
    throw new BadRequestException(`当前模板订单数量须在 ${policy.orderCountRange.minimum} 到 ${policy.orderCountRange.maximum} 之间`)
  }
  const releaseMode = scenario.orderReleaseMode ?? policy.allowedReleaseModes[0]
  if (typeof releaseMode !== "string" || !(logisticsOrderReleaseModes as readonly string[]).includes(releaseMode) || !policy.allowedReleaseModes.includes(releaseMode as never)) {
    throw new BadRequestException("当前模板不支持所选订单释放方式")
  }
  const releasePhase = scenario.orderReleasePhase ?? null
  if (releaseMode === "AT_PHASE") {
    if (typeof releasePhase !== "string" || !(logisticsOrderReleasePhases as readonly string[]).includes(releasePhase) || !policy.allowedReleasePhases.includes(releasePhase as never)) {
      throw new BadRequestException("指定阶段释放必须选择当前模板开放的运行阶段")
    }
  } else if (releasePhase !== null && releasePhase !== undefined) {
    throw new BadRequestException("仅指定阶段释放方式可以设置订单释放阶段")
  }
  const priorityProfile = scenario.priorityProfile ?? policy.defaultPriorityProfile
  if (typeof priorityProfile !== "string" || !(logisticsPriorityProfiles as readonly string[]).includes(priorityProfile) || !policy.allowedPriorityProfiles.includes(priorityProfile as never)) {
    throw new BadRequestException("当前模板不支持所选订单优先级结构")
  }
  const deliveryDistributionMode = scenario.deliveryDistributionMode ?? "UNIFORM"
  if (typeof deliveryDistributionMode !== "string" || !(logisticsOrderDistributionModes as readonly string[]).includes(deliveryDistributionMode)) throw new BadRequestException("配送点需求分布方式无效")
  const timeWindowProfile = resolveLogisticsTimeWindowProfile(scenario)
  assertOptionalEnum(scenario.timeWindowProfile, logisticsTimeWindowProfiles, "订单时间窗口类型")
  const timeWindowMinutes = scenario.timeWindowProfile === undefined
    ? Number(scenario.timeWindowMinutes ?? logisticsTimeWindowMinutes(timeWindowProfile))
    : logisticsTimeWindowMinutes(timeWindowProfile)
  if (!Number.isInteger(timeWindowMinutes) || timeWindowMinutes < 5 || timeWindowMinutes > 240) throw new BadRequestException("订单时间窗口须在 5 到 240 分钟之间")
  const seed = typeof scenario.orderSeed === "string" && scenario.orderSeed.trim() ? scenario.orderSeed.trim() : fallbackSeed
  if (seed.length > 120) throw new BadRequestException("订单随机种子不能超过 120 个字符")
  const initialUnavailableAircraftCount = count(scenario.initialUnavailableAircraftCount, 0, policy.totalAircraft, "初始不可用无人机数量")
  const initialLowBatteryAircraftCount = count(scenario.initialLowBatteryAircraftCount, 0, policy.totalAircraft, "初始低电量无人机数量")
  const initialStandbyAircraftCount = count(scenario.initialStandbyAircraftCount, 0, policy.totalAircraft, "初始待用无人机数量")
  const initialPreflightAbnormalAircraftCount = count(scenario.initialPreflightAbnormalAircraftCount, 0, policy.totalAircraft, "初始飞前异常无人机数量")
  if (initialUnavailableAircraftCount + initialLowBatteryAircraftCount + initialStandbyAircraftCount + initialPreflightAbnormalAircraftCount > policy.totalAircraft) throw new BadRequestException("初始非正常无人机总数不能超过模板机数")
  const initialFleet = resolveLogisticsInitialFleet({ ...scenario, initialUnavailableAircraftCount, initialLowBatteryAircraftCount, initialStandbyAircraftCount, initialPreflightAbnormalAircraftCount }, policy.totalAircraft)
  assertOptionalEnum(scenario.initialWindDirection, logisticsWindDirections, "初始风向")
  assertOptionalEnum(scenario.initialWindForceState, logisticsWindForceStates, "初始风力状态")
  assertOptionalEnum(scenario.initialGustState, logisticsGustStates, "初始阵风状态")
  assertOptionalEnum(scenario.initialRainState, logisticsRainStates, "初始降雨状态")
  assertOptionalEnum(scenario.initialPositioningState, logisticsSignalStates, "初始定位状态")
  assertOptionalEnum(scenario.initialCommunicationState, logisticsSignalStates, "初始通信状态")
  const initialEnvironment = resolveLogisticsInitialEnvironment(scenario)
  assertSignalStateAllowed(initialEnvironment.positioningState, policy.totalAircraft, "定位状态")
  assertSignalStateAllowed(initialEnvironment.communicationState, policy.totalAircraft, "通信状态")
  return {
    orderCount,
    releaseMode: releaseMode as LogisticsOrderGenerationConfig["releaseMode"],
    releasePhase: releaseMode === "AT_PHASE" ? releasePhase as NonNullable<LogisticsOrderGenerationConfig["releasePhase"]> : null,
    priorityProfile: priorityProfile as LogisticsOrderGenerationConfig["priorityProfile"],
    deliveryDistributionMode: deliveryDistributionMode as LogisticsOrderGenerationConfig["deliveryDistributionMode"],
    timeWindowProfile,
    timeWindowMinutes,
    seed,
    initialUnavailableAircraftCount,
    initialLowBatteryAircraftCount,
    initialFleet,
    initialEnvironment
  }
}

function assertSignalStateAllowed(value: LogisticsOrderGenerationConfig["initialEnvironment"]["positioningState"], totalAircraft: number, label: string): void {
  const minimumAircraft = { NORMAL: 3, LOCAL_WEAK: 5, LOCAL_ABNORMAL: 10, CONTINUOUS_ABNORMAL: 20, RECOVERING: 50 } as const
  if (totalAircraft < minimumAircraft[value]) throw new BadRequestException(`${label} ${value} 未向当前规模模板开放`)
}

function assertOptionalEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) throw new BadRequestException(`${label}无效`)
}

export function normalizeScheduleItems(value: unknown): LogisticsScheduleItemInput[] {
  if (!Array.isArray(value) || value.length > 100) throw new BadRequestException("调度计划必须为不超过 100 项的数组")
  const ids = new Set<string>()
  return value.map((item, index) => {
    const record = asRecord(item, `第 ${index + 1} 个调度项`)
    const id = text(record.id, 80, `第 ${index + 1} 个调度项 ID`)
    if (ids.has(id)) throw new BadRequestException(`调度项 ID 重复：${id}`)
    ids.add(id)
    const plannedTakeoffTimeMs = Number(record.plannedTakeoffTimeMs)
    if (!Number.isInteger(plannedTakeoffTimeMs) || plannedTakeoffTimeMs < 0 || plannedTakeoffTimeMs > 86_400_000) throw new BadRequestException(`第 ${index + 1} 个计划起飞时刻无效`)
    return {
      id,
      orderId: text(record.orderId, 80, `第 ${index + 1} 个订单 ID`),
      aircraftId: text(record.aircraftId, 80, `第 ${index + 1} 个无人机 ID`),
      outboundRouteId: text(record.outboundRouteId, 80, `第 ${index + 1} 个去程航线 ID`),
      returnRouteId: text(record.returnRouteId, 80, `第 ${index + 1} 个返程航线 ID`),
      plannedTakeoffTimeMs
    }
  })
}

export function assertScheduleRevision(value: unknown, current: number, label: string): void {
  const expected = Number(value)
  if (!Number.isInteger(expected) || expected < 1) throw new BadRequestException(`${label}必须为正整数`)
  if (expected !== current) throw new ConflictException(`${label}冲突，当前版本为 ${current}`)
}

function count(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) throw new BadRequestException(`${label}须在 0 到 ${maximum} 之间`)
  return parsed
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new BadRequestException(`${label}不能为空且不能超过 ${maximum} 个字符`)
  return value.trim()
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequestException(`${label}格式无效`)
  return value as Record<string, unknown>
}
