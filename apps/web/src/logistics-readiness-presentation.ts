import type { LogisticsReadinessStatus } from "@wurenji/shared"

export interface LogisticsReadinessGatePresentation {
  passed: boolean
  title: string
  detail: string
}

export function logisticsReadinessGatePresentation(status: LogisticsReadinessStatus, canConfirm: boolean, failCount: number): LogisticsReadinessGatePresentation {
  if (status === "CONFIRMED") return {
    passed: true,
    title: "运行准备已确认",
    detail: "检查结论已锁定，配送运行阶段已开放"
  }
  if (canConfirm) return {
    passed: true,
    title: "满足运行门禁",
    detail: "可确认并开放配送运行阶段"
  }
  return {
    passed: false,
    title: "尚不能进入运行",
    detail: failCount > 0 ? `仍有 ${failCount} 项阻断条件` : "请选择决策并填写判断依据"
  }
}
