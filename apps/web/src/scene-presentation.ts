import type { SceneType } from "@wurenji/shared"

export interface V3ScenePresentation {
  type: SceneType
  code: string
  label: string
  shortLabel: string
  className: "show" | "logistics" | "vtl"
  description: string
  catalogTitle: string
}

export const v3SceneTypes: SceneType[] = ["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"]

export const v3ScenePresentation: Record<SceneType, V3ScenePresentation> = {
  CITY_SHOW: {
    type: "CITY_SHOW",
    code: "SHOW",
    label: "城市编队表演",
    shortLabel: "表演",
    className: "show",
    description: "学习区域规划、飞行申报、运行报备与异常处置",
    catalogTitle: "表演教学区域"
  },
  CITY_LOGISTICS: {
    type: "CITY_LOGISTICS",
    code: "LOGISTICS",
    label: "城市低空物流",
    shortLabel: "物流",
    className: "logistics",
    description: "学习空域分析、航线验证、订单调度、配送运行与应急救援",
    catalogTitle: "物流教学区域"
  },
  VTOL_INSPECTION: {
    type: "VTOL_INSPECTION",
    code: "VTOL",
    label: "垂起广域巡检",
    shortLabel: "巡检",
    className: "vtl",
    description: "学习任务分区、八阶段航线、能量管理与动态集群重组",
    catalogTitle: "垂起巡检教学区域"
  }
}

export function v3SceneLabel(type: SceneType): string {
  return v3ScenePresentation[type].label
}

export function v3SceneShortLabel(type: SceneType): string {
  return v3ScenePresentation[type].shortLabel
}

export function v3SceneClass(type: SceneType): V3ScenePresentation["className"] {
  return v3ScenePresentation[type].className
}
