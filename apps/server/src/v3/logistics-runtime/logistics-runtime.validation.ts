import { BadRequestException, ConflictException } from "@nestjs/common"
import {
  logisticsReadinessDecisions,
  logisticsRuntimeActionCodes,
  type LogisticsReadinessDecision,
  type LogisticsRuntimeActionCode
} from "@wurenji/shared"

export function runtimeRevision(value: unknown, current?: number): number {
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision < 1) throw new BadRequestException("expectedRevision 必须为正整数")
  if (current !== undefined && revision !== current) throw new ConflictException(`运行版本冲突，当前版本为 ${current}`)
  return revision
}

export function readinessDecision(value: unknown): LogisticsReadinessDecision | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value !== "string" || !(logisticsReadinessDecisions as readonly string[]).includes(value)) throw new BadRequestException("运行准备决定无效")
  return value as LogisticsReadinessDecision
}

export function normalizedBasis(value: unknown, required = false): string {
  if (value === null || value === undefined) {
    if (required) throw new BadRequestException("请填写运行决定依据")
    return ""
  }
  if (typeof value !== "string" || value.trim().length > 2_000) throw new BadRequestException("运行决定依据不能超过 2000 个字符")
  if (required && value.trim().length < 4) throw new BadRequestException("请填写至少 4 个字符的运行决定依据")
  return value.trim()
}

export function runtimeActionCode(value: unknown): LogisticsRuntimeActionCode {
  if (typeof value !== "string" || !(logisticsRuntimeActionCodes as readonly string[]).includes(value)) throw new BadRequestException("运行处置动作无效")
  return value as LogisticsRuntimeActionCode
}

export function optionalId(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new BadRequestException(`${label}无效`)
  return value.trim()
}

export function optionalUuid(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || !uuidPattern.test(value.trim())) throw new BadRequestException(`${label}无效`)
  return value.trim()
}

export function requiredUuid(value: unknown, label: string): string {
  const uuid = optionalUuid(value, label)
  if (!uuid) throw new BadRequestException(`${label}不能为空`)
  return uuid
}

export function positiveDelay(value: unknown, fallback = 60_000): number {
  if (value === undefined || value === null) return fallback
  const delay = Number(value)
  if (!Number.isInteger(delay) || delay < 1_000 || delay > 3_600_000) throw new BadRequestException("延迟时间须在 1 秒到 60 分钟之间")
  return delay
}

export function clockRate(value: unknown, current: number): number {
  if (value === undefined || value === null) return current
  const rate = Number(value)
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 3_600) throw new BadRequestException("运行倍速须在 0.25 到 3600 之间")
  return rate
}

export function dynamicReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 4 || value.trim().length > 1_000) throw new BadRequestException("动态调整原因须为 4 到 1000 个字符")
  return value.trim()
}

export function dynamicMode(value: unknown): "SINGLE" | "BATCH" | "GLOBAL" {
  if (value === undefined || value === null) return "SINGLE"
  if (value !== "SINGLE" && value !== "BATCH" && value !== "GLOBAL") throw new BadRequestException("动态重调度模式无效")
  return value
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
