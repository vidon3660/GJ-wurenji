import type {
  LogisticsRouteCheckEvidence,
  LogisticsRouteInput,
  LogisticsRouteMetricView
} from "@wurenji/shared"

export interface LogisticsProblemLocationView {
  problemType: string
  severity: LogisticsRouteCheckEvidence["severity"]
  routeLabel: string
  segmentLabel: string
  simulatedAtLabel: string
  message: string
  positionLabel: string | null
  runtimeData: Array<{ key: string; label: string; value: string }>
}

const dataLabels: Record<string, string> = {
  routeDirection: "航向",
  routeDistanceMeters: "航线航程",
  routeFlightTimeSeconds: "航线时间",
  segmentNumber: "航段序号",
  segmentAltitudeMeters: "航段高度",
  speedMps: "规划速度",
  startAltitudeMeters: "起点高度",
  endAltitudeMeters: "终点高度",
  maximumHeightMeters: "机型高度上限",
  heightMarginMeters: "高度余量",
  clearanceMeters: "净空余量",
  distanceMeters: "往返航程",
  remainingBatteryPercent: "剩余电量",
  detourRatio: "绕行系数",
  crossingCount: "交叉数量",
  expectedType: "期望节点类型"
}

export function logisticsProblemLocation(
  evidence: LogisticsRouteCheckEvidence,
  routes: readonly LogisticsRouteInput[],
  metrics: readonly LogisticsRouteMetricView[] = []
): LogisticsProblemLocationView {
  const route = routes.find((item) => item.id === evidence.routeIds[0])
  const segmentIndexes = evidence.segmentIndexes.filter((value) => Number.isInteger(value) && value >= 0)
  const segmentLabel = route && segmentIndexes.length > 0
    ? segmentIndexes.map((index) => segmentName(route, index)).join("、")
    : evidence.routeIds.length > 1 ? "多航线空间关系" : "整条航线 / 运行节点"
  const metric = metrics.find((item) => item.routeId === route?.id)
  const runtimeData = Object.entries({
    ...derivedMetricData(metric),
    ...evidence.data
  }).map(([key, value]) => ({ key, label: dataLabels[key] ?? key, value: formatRuntimeValue(key, value) }))

  return {
    problemType: `${categoryLabel(evidence.category)} · ${evidence.code}`,
    severity: evidence.severity,
    routeLabel: route ? `${route.name} · ${directionLabel(route.direction)}` : evidence.routeIds.length > 0 ? evidence.routeIds.join("、") : "项目级检查",
    segmentLabel,
    simulatedAtLabel: typeof evidence.simulatedAtSeconds === "number" ? formatSimulatedTime(evidence.simulatedAtSeconds) : "检查时刻",
    message: evidence.message,
    positionLabel: evidence.position ? `${evidence.position.longitude.toFixed(6)}, ${evidence.position.latitude.toFixed(6)}` : null,
    runtimeData
  }
}

function segmentName(route: LogisticsRouteInput, index: number): string {
  const start = route.waypoints[index]
  const end = route.waypoints[index + 1]
  return start && end ? `第 ${index + 1} 航段 · ${start.name} -> ${end.name}` : `第 ${index + 1} 航段`
}

function derivedMetricData(metric: LogisticsRouteMetricView | undefined): Record<string, number> {
  return metric ? {
    routeDistanceMeters: metric.distanceMeters,
    routeFlightTimeSeconds: metric.flightTimeSeconds
  } : {}
}

function formatRuntimeValue(key: string, value: string | number | boolean): string {
  if (key.endsWith("Meters") && typeof value === "number") return `${value.toFixed(1)} m`
  if (key.endsWith("Seconds") && typeof value === "number") return formatDuration(value)
  if (key.endsWith("Percent") && typeof value === "number") return `${value.toFixed(1)}%`
  if (key === "speedMps" && typeof value === "number") return `${value.toFixed(1)} m/s`
  if (key === "routeDirection" && typeof value === "string") return directionLabel(value)
  return String(value)
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)} min ${total % 60} s`
}

function formatSimulatedTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `T+${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
}

function directionLabel(direction: string): string {
  return direction === "OUTBOUND" ? "去程" : direction === "RETURN" ? "返程" : direction
}

function categoryLabel(category: LogisticsRouteCheckEvidence["category"]): string {
  return ({ SPATIAL: "空间与障碍", AIRCRAFT: "机型能力", COVERAGE: "定位通信", NODES: "运行节点", ROUTE_RELATION: "多航线关系", EFFICIENCY: "效率提示" } as const)[category]
}
