import type { SceneType } from "@wurenji/shared"

export interface SceneEducationProfile {
  objective: string
  studentRole: string
  systemRoles: string[]
  focus: string[]
}

const profiles: Record<SceneType, SceneEducationProfile> = {
  CITY_SHOW: {
    objective: "在观演区和安全边界内完成编队表演，保持图案、时序与机群间距稳定。",
    studentRole: "表演运行指挥员",
    systemRoles: ["空域协调员", "气象与通信席", "机群系统"],
    focus: ["编队图案", "同步误差", "起降编排", "观演区安全"]
  },
  CITY_LOGISTICS: {
    objective: "在订单时窗和飞行安全约束下完成配送，并根据运行事件调整调度方案。",
    studentRole: "低空物流调度员",
    systemRoles: ["仓站调度员", "配送点 NPC", "气象与通信席"],
    focus: ["订单时窗", "航线与返程", "飞机周转", "异常重调度"]
  },
  VTOL_INSPECTION: {
    objective: "结合地形、任务对象和能量余度完成巡检航段，并在异常时选择返航、备降或任务转移。",
    studentRole: "垂起巡检任务指挥员",
    systemRoles: ["巡检对象系统", "空域与气象席", "机队控制系统"],
    focus: ["任务覆盖", "地形净距", "能量管理", "返航与备降"]
  }
}

export function sceneEducationProfile(sceneType: SceneType): SceneEducationProfile {
  return profiles[sceneType]
}
