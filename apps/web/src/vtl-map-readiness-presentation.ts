import type { V3MapResourceKind, V3MapResourceReadinessStatus, V3RegionMapReadinessView } from "@wurenji/shared"

const resourceLabels: Record<V3MapResourceKind, string> = {
  TERRAIN: "DEM",
  IMAGERY: "影像",
  ELEVATION_SNAPSHOT: "高程快照"
}

export interface VtlMapReadinessPresentation {
  state: "UNKNOWN" | "READY" | "FALLBACK" | "BLOCKED"
  title: string
  detail: string
  publishBlocked: boolean
  issues: Array<{ kind: V3MapResourceKind; label: string; status: V3MapResourceReadinessStatus; statusLabel: string; message: string; nextStep: string }>
}

export function vtlMapResourceStatusLabel(status: V3MapResourceReadinessStatus): string {
  return ({ READY: "已就绪", MISSING: "缺失", INVALID: "校验失败", EXTERNAL: "外部待验收", UNCONFIGURED: "待配置" } as Record<V3MapResourceReadinessStatus, string>)[status]
}

export function vtlMapReadinessPresentation(
  readiness: V3RegionMapReadinessView | null,
  formalMapRequired: boolean
): VtlMapReadinessPresentation {
  if (!readiness) {
    return {
      state: "UNKNOWN",
      title: "地图资源尚未检查",
      detail: "当前检查暂不可用，不阻塞任务发布；可稍后重新检查 DEM、影像和高程快照。",
      publishBlocked: false,
      issues: []
    }
  }
  const issues = readiness.checks
    .filter((check) => check.required && check.status !== "READY")
    .map((check) => ({ kind: check.kind, label: resourceLabels[check.kind], status: check.status, statusLabel: vtlMapResourceStatusLabel(check.status), message: check.message, nextStep: resourceNextStep(check.kind, check.status) }))
  if (readiness.formalReady) {
    return {
      state: "READY",
      title: "正式地图资源已就绪",
      detail: `${readiness.regionCode} v${readiness.packageVersion} 的 DEM、影像和高程快照均已校验。`,
      publishBlocked: false,
      issues: []
    }
  }
  if (formalMapRequired) {
    return {
      state: "FALLBACK",
      title: "正式地图资源未就绪",
      detail: "当前仅提示资源缺口，不阻塞任务发布；正式验收前请由管理员补齐资源并重新检查。",
      publishBlocked: false,
      issues
    }
  }
  return {
    state: "FALLBACK",
    title: "当前使用教学地图回退",
    detail: "可用于本地教学演示，但不能作为正式 DEM、净空或报告复现依据。",
    publishBlocked: false,
    issues
  }
}

function resourceNextStep(kind: V3MapResourceKind, status: V3MapResourceReadinessStatus): string {
  if (status === "EXTERNAL") return "确认服务授权、可达性和版本；正式交付建议导入区域内离线资源包"
  if (status === "INVALID") return kind === "TERRAIN"
    ? "重新导出区域内 quantized-mesh DEM，并更新 manifest SHA-256"
    : kind === "IMAGERY"
      ? "重新生成区域影像瓦片，并更新 manifest SHA-256"
      : "修正 samples、覆盖范围和 SHA-256 后重新检查"
  if (status === "UNCONFIGURED") return kind === "TERRAIN"
    ? "在区域包中配置 DEM 地址、版本、垂直基准和 SHA-256"
    : kind === "IMAGERY"
      ? "在区域包中配置影像地址、版本和 SHA-256"
      : "在区域包中配置高程采样快照地址和 SHA-256"
  return kind === "TERRAIN"
    ? "提供区域内 quantized-mesh DEM 目录和有效瓦片"
    : kind === "IMAGERY"
      ? "提供区域内影像瓦片目录并登记版本和 SHA-256"
      : "提供覆盖区域边界的高程 samples 快照并登记 SHA-256"
}
