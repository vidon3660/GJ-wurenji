import type { SceneType } from "@wurenji/shared"

export interface SceneRoleProfile {
  studentRole: string
  systemRoles: string[]
  objective: string
  coreObjects: string
  keyConstraints: string
}

const profiles: Record<SceneType, SceneRoleProfile> = {
  CITY_SHOW: {
    studentRole: "编队运行规划员",
    systemRoles: ["运行指挥 / 安全员", "气象与通信服务", "演出现场联系人"],
    objective: "完成编队航迹、同步时刻和观演区安全规划，并在运行中处理异常。",
    coreObjects: "编队、舞步航迹、起降区、观演区、禁限飞区",
    keyConstraints: "同步时刻、编队间距、高度层、安全边界"
  },
  CITY_LOGISTICS: {
    studentRole: "物流调度与运行控制员",
    systemRoles: ["物流调度员", "仓站 / 配送点", "气象与通信服务"],
    objective: "在时间窗和资源约束下完成订单分配、航线规划与配送运行。",
    coreObjects: "订单、仓站、配送点、无人机、航线",
    keyConstraints: "配送时间窗、订单优先级、载荷、电量、动态调度"
  },
  VTOL_INSPECTION: {
    studentRole: "巡检任务飞行控制员",
    systemRoles: ["任务指挥 / 安全员", "巡检对象 / 场站", "气象与通信服务"],
    objective: "完成分区巡检、阶段飞行和能量管理，并在异常时执行返航或备降。",
    coreObjects: "巡检分区、任务对象、起降点、航线、机群",
    keyConstraints: "起飞与过渡、巡检覆盖、能量余量、返航与备降"
  }
}

export function sceneRoleProfile(sceneType: SceneType): SceneRoleProfile {
  return profiles[sceneType]
}
