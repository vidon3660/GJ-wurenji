import type { EvaluationDimension, SceneType } from "@wurenji/shared"

export function defaultEvaluationForScene(type: SceneType): EvaluationDimension[] {
  if (type === "CITY_LOGISTICS") {
    return [
      { name: "飞行安全", weight: 35, metrics: ["碰撞", "禁飞区", "返航余量"] },
      { name: "完成与准时", weight: 30, metrics: ["完成率", "准时率"] },
      { name: "调度效率", weight: 20, metrics: ["总航程", "资源利用率"] },
      { name: "应急处置", weight: 15, metrics: ["响应时间", "处置结果"] }
    ]
  }
  if (type === "VTOL_INSPECTION") {
    return [
      { name: "飞行安全", weight: 35, metrics: ["碰撞", "地形净距", "备降可用"] },
      { name: "任务覆盖", weight: 30, metrics: ["对象覆盖率", "航段完成率"] },
      { name: "能量与航段", weight: 20, metrics: ["能量余度", "阶段用时"] },
      { name: "应急处置", weight: 15, metrics: ["响应时间", "返航/备降结果"] }
    ]
  }
  return [
    { name: "飞行安全", weight: 40, metrics: ["碰撞", "间距", "场地边界"] },
    { name: "轨迹与时序", weight: 25, metrics: ["轨迹完整", "同步误差"] },
    { name: "运行组织", weight: 20, metrics: ["编号映射", "起降编排"] },
    { name: "应急处置", weight: 15, metrics: ["响应时间", "处置结果"] }
  ]
}
