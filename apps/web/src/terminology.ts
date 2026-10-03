export function formatCoordinateReference(value: string | null | undefined): string {
  if (!value) return "坐标系未指定"
  if (value === "WGS84") return "全球坐标系 WGS84"
  return value
}

export function formatLocalCoordinateFrame(value: string | null | undefined): string {
  if (!value) return "局部坐标系未指定"
  if (value === "ENU") return "局部东-北-天坐标 ENU"
  return value
}

export function formatHeightDatum(value: string | null | undefined): string {
  if (!value) return "高度基准未指定"
  if (value === "AGL") return "相对地面高度 AGL"
  if (value === "AMSL") return "平均海平面高度 AMSL"
  return value
}

export function formatMapResourceSource(value: string | null | undefined): string {
  if (!value) return "来源未指定"
  const labels: Record<string, string> = {
    BUILT_IN: "平台内置资源",
    FORMAL: "正式教学资源",
    TEACHING: "教学示例资源",
    UNSIGNED_TEST: "测试资源",
    SIGNED_ARCHIVE: "已签名资源包",
    IMPORTED_TRAJECTORY: "导入轨迹资源"
  }
  return labels[value] ?? value
}

export function formatScaleTemplateCode(value: string | null | undefined): string {
  if (!value) return "规模模板未指定"
  const match = /^(SHOW|LOGISTICS|VTL)_(\d+)$/.exec(value)
  if (!match) return value
  const sceneLabel = ({ SHOW: "城市表演", LOGISTICS: "城市物流", VTL: "垂起巡检" } as Record<string, string>)[match[1]!]!
  return `${sceneLabel} ${match[2]} 架`
}

export function formatAircraftModelCode(value: string | null | undefined): string {
  if (!value) return "机型未提供"
  const labels: Record<string, string> = {
    "LOGISTICS-TEACHING-01": "物流教学无人机",
    "VTOL-TEACHING-01": "垂起教学无人机"
  }
  return labels[value] ? `${labels[value]}（${value}）` : value
}

export function formatVtlGroupCode(value: string | null | undefined): string {
  if (!value) return "机组未指定"
  const match = /^GROUP[_-]?(\d+|[A-Z])$/i.exec(value)
  if (!match) return value
  return `巡检机组 ${match[1]}（${value}）`
}

export function formatShowGroupCode(value: string | null | undefined): string {
  if (!value) return "表演编队未指定"
  const match = /^(?:GROUP[_-]?|G)(\d+)$/i.exec(value)
  if (!match) return value
  return `表演编队 ${match[1]}（${value}）`
}

export function formatLogisticsEvidenceCode(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    AIRCRAFT_CAPABILITY: "机型能力不满足",
    ALTITUDE_LIMIT: "高度超出限制",
    BATTERY_RESERVE: "剩余电量不足",
    NODE_UNREACHABLE: "运行节点不可达",
    ROUTE_CONFLICT: "航线存在冲突",
    ROUTE_DISCONTINUITY: "航线不连续",
    SPATIAL_CONFLICT: "空间安全距离不足",
    SPEED_LIMIT: "速度超出限制",
    TAKEOFF_LANDING: "起降条件不满足"
  }
  return labels[value ?? ""] ? `${labels[value!]}（${value}）` : value ?? "检查项未命名"
}

export function formatSubmissionStatus(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    SUBMITTED: "已提交，等待教师处理",
    LOCKED: "未开放或被前置条件锁定",
    IN_PROGRESS: "进行中",
    AVAILABLE: "可开始",
    SNAPSHOT: "候选版本",
    VALIDATED: "已验证",
    DRAFT: "草稿",
    PENDING: "等待处理",
    REVIEWED: "教师已复核",
    PUBLISHED: "已发布",
    GRADED: "自动判定已完成"
  }
  if (value && labels[value]) return labels[value]
  return value ?? "状态未指定"
}

export function formatValidationStatus(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    PENDING: "尚未检查",
    PASSED: "验证通过",
    WITH_RISK: "存在风险，可继续",
    HARD_CONFLICT: "存在硬性冲突",
    INFEASIBLE: "当前方案无法完成",
    FAILED: "检查失败"
  }
  return value && labels[value] ? labels[value] : value ?? "验证状态未指定"
}

export function formatLandingSiteStatus(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    AVAILABLE: "可用",
    RESTRICTED: "受限使用",
    UNAVAILABLE: "不可用"
  }
  return value && labels[value] ? labels[value] : value ?? "可用状态未指定"
}

export function formatVtlTaskType(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    POINT: "点状巡检",
    LINE: "线状巡检",
    AREA: "区域巡检"
  }
  return value && labels[value] ? labels[value] : value ?? "任务类型未指定"
}

export function formatEvaluationStatus(value: string | null | undefined): string {
  return ({ PENDING: "待教师评价", REVIEWED: "教师已复核", PUBLISHED: "评价已发布" } as Record<string, string>)[value ?? ""] ?? "评价状态未指定"
}

export function formatReportJobStatus(value: string | null | undefined): string {
  return ({ PENDING: "排队中", RUNNING: "生成中", RETRY_WAIT: "等待重试", SUCCEEDED: "已完成", DEAD_LETTER: "生成失败" } as Record<string, string>)[value ?? ""] ?? "状态未指定"
}

export function formatRuntimeSessionStatus(value: string | null | undefined): string {
  return ({ READY: "等待启动", RUNNING: "运行中", PAUSED: "已暂停", COMPLETED: "已完成", ABORTED: "已中止", FAILED: "运行失败" } as Record<string, string>)[value ?? ""] ?? "运行状态未指定"
}

export function formatTimelineStatus(value: string | null | undefined): string {
  return ({
    RECORDED: "已记录",
    TRIGGERED: "已触发",
    OPEN: "待确认",
    ESCALATED: "已升级",
    ACKNOWLEDGED: "已确认",
    CONTROLLED: "已控制",
    RESOLVED: "已解除",
    APPLIED: "已执行",
    FAILED: "失败",
    REJECTED: "已拒绝",
    READY: "准备",
    RUNNING: "运行中",
    PAUSED: "已暂停",
    COMPLETED: "已完成",
    ABORTED: "已中止"
  } as Record<string, string>)[value ?? ""] ?? value ?? "状态未指定"
}
