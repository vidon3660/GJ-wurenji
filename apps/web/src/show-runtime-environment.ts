import type { ShowRuntimeEnvironmentView } from "@wurenji/shared"

export interface ShowRuntimeEnvironmentMetric {
  code: "WIND_DIRECTION" | "WIND_FORCE" | "GUST" | "RAIN" | "POSITIONING" | "ELECTROMAGNETIC" | "COMMUNICATION"
  label: string
  value: string
  tone: "neutral" | "normal" | "warning" | "danger"
}

export interface ShowRuntimeSupportMetric {
  code: "EQUIPMENT" | "GEOFENCE"
  label: string
  value: string
  tone: "normal" | "warning" | "danger"
}

const windDirectionLabels: Record<ShowRuntimeEnvironmentView["windDirection"], string> = {
  N: "北风",
  NE: "东北风",
  E: "东风",
  SE: "东南风",
  S: "南风",
  SW: "西南风",
  W: "西风",
  NW: "西北风"
}

export function showRuntimeEnvironmentMetrics(environment: ShowRuntimeEnvironmentView | null | undefined): ShowRuntimeEnvironmentMetric[] {
  if (!environment) return emptyEnvironmentMetrics()
  return [
    { code: "WIND_DIRECTION", label: "风向", value: windDirectionLabels[environment.windDirection], tone: "neutral" },
    { code: "WIND_FORCE", label: "风力", ...windState(environment.windState) },
    { code: "GUST", label: "阵风", ...gustState(environment.gustState) },
    { code: "RAIN", label: "降雨", ...rainState(environment.rainState) },
    { code: "POSITIONING", label: "定位质量", ...qualityState(environment.positioningQuality) },
    { code: "ELECTROMAGNETIC", label: "电磁状态", ...electromagneticState(environment.electromagneticState) },
    { code: "COMMUNICATION", label: "通信质量", ...qualityState(environment.communicationQuality) }
  ]
}

export function showRuntimeSupportMetrics(environment: ShowRuntimeEnvironmentView | null | undefined): ShowRuntimeSupportMetric[] {
  if (!environment) return [
    { code: "EQUIPMENT", label: "设备", value: "--", tone: "normal" },
    { code: "GEOFENCE", label: "电子围栏", value: "--", tone: "normal" }
  ]
  return [
    {
      code: "EQUIPMENT",
      label: "设备",
      value: ({ NORMAL: "正常", WARNING: "告警", FAULT: "故障" } as const)[environment.equipmentState],
      tone: ({ NORMAL: "normal", WARNING: "warning", FAULT: "danger" } as const)[environment.equipmentState]
    },
    {
      code: "GEOFENCE",
      label: "电子围栏",
      value: ({ NORMAL: "正常", WARNING: "告警" } as const)[environment.geofenceState],
      tone: ({ NORMAL: "normal", WARNING: "warning" } as const)[environment.geofenceState]
    }
  ]
}

export function showRuntimeEnvironmentSummary(environment: ShowRuntimeEnvironmentView | null | undefined): string {
  if (!environment) return "历史记录未提供"
  const metrics = showRuntimeEnvironmentMetrics(environment)
  const valueByCode = new Map(metrics.map((metric) => [metric.code, metric.value]))
  return `风向 ${valueByCode.get("WIND_DIRECTION") ?? "--"} · 风力 ${valueByCode.get("WIND_FORCE") ?? "--"} · 通信 ${valueByCode.get("COMMUNICATION") ?? "--"}`
}

function emptyEnvironmentMetrics(): ShowRuntimeEnvironmentMetric[] {
  return [
    { code: "WIND_DIRECTION", label: "风向", value: "--", tone: "neutral" },
    { code: "WIND_FORCE", label: "风力", value: "--", tone: "neutral" },
    { code: "GUST", label: "阵风", value: "--", tone: "neutral" },
    { code: "RAIN", label: "降雨", value: "--", tone: "neutral" },
    { code: "POSITIONING", label: "定位质量", value: "--", tone: "neutral" },
    { code: "ELECTROMAGNETIC", label: "电磁状态", value: "--", tone: "neutral" },
    { code: "COMMUNICATION", label: "通信质量", value: "--", tone: "neutral" }
  ]
}

function windState(value: ShowRuntimeEnvironmentView["windState"]): Pick<ShowRuntimeEnvironmentMetric, "value" | "tone"> {
  return {
    value: ({ NORMAL: "正常", NEAR_LIMIT: "接近限制", OVER_LIMIT: "超限" } as const)[value],
    tone: ({ NORMAL: "normal", NEAR_LIMIT: "warning", OVER_LIMIT: "danger" } as const)[value]
  }
}

function gustState(value: ShowRuntimeEnvironmentView["gustState"]): Pick<ShowRuntimeEnvironmentMetric, "value" | "tone"> {
  return {
    value: ({ NONE: "无阵风", OCCASIONAL: "间歇阵风", CONTINUOUS: "持续阵风" } as const)[value],
    tone: ({ NONE: "normal", OCCASIONAL: "warning", CONTINUOUS: "danger" } as const)[value]
  }
}

function rainState(value: ShowRuntimeEnvironmentView["rainState"]): Pick<ShowRuntimeEnvironmentMetric, "value" | "tone"> {
  return {
    value: ({ NONE: "无降雨", BELOW_LIMIT: "限制内", OVER_LIMIT: "超限" } as const)[value],
    tone: ({ NONE: "normal", BELOW_LIMIT: "warning", OVER_LIMIT: "danger" } as const)[value]
  }
}

function qualityState(value: ShowRuntimeEnvironmentView["positioningQuality"]): Pick<ShowRuntimeEnvironmentMetric, "value" | "tone"> {
  return {
    value: ({ GOOD: "良好", DEGRADED: "下降", LOST: "丢失" } as const)[value],
    tone: ({ GOOD: "normal", DEGRADED: "warning", LOST: "danger" } as const)[value]
  }
}

function electromagneticState(value: ShowRuntimeEnvironmentView["electromagneticState"]): Pick<ShowRuntimeEnvironmentMetric, "value" | "tone"> {
  return {
    value: ({ NORMAL: "正常", INTERFERENCE: "受干扰" } as const)[value],
    tone: ({ NORMAL: "normal", INTERFERENCE: "danger" } as const)[value]
  }
}
