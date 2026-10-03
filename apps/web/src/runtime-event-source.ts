export type RuntimeSceneType = "CITY_SHOW" | "CITY_LOGISTICS" | "VTOL_INSPECTION"

const sourceByScene: Record<RuntimeSceneType, Record<string, string>> = {
  CITY_SHOW: {
    WEATHER: "气象服务",
    POSITIONING_ELECTROMAGNETIC: "定位与电磁服务",
    COMMUNICATION_CONTROL: "通信与控制服务",
    AIRCRAFT_DEVICE: "机队设备监控",
    DEFAULT: "运行指挥 / 安全员"
  },
  CITY_LOGISTICS: {
    WEATHER_ENVIRONMENT: "气象服务",
    POSITIONING_NAVIGATION: "定位与导航服务",
    COMMUNICATION_LINK: "通信服务",
    AIRCRAFT_DEVICE: "机队设备监控",
    ROUTE_OPERATION: "物流调度员",
    ORDER_TASK_CHANGE: "仓站 / 配送点",
    DEFAULT: "物流运行指挥"
  },
  VTOL_INSPECTION: {
    WEATHER: "气象服务",
    POSITIONING: "定位服务",
    COMMUNICATION: "通信服务",
    ENERGY_POWER: "能源管理服务",
    DEVICE: "机队设备监控",
    MODE_TRANSITION: "飞行控制服务",
    ROUTE_AREA: "巡检任务指挥",
    TASK_CONDITION: "巡检对象 / 场站",
    DEFAULT: "巡检运行指挥"
  }
}

const sourceByEvent: Record<RuntimeSceneType, Record<string, string>> = {
  CITY_SHOW: {},
  CITY_LOGISTICS: {
    NODE_UNAVAILABLE: "仓站 / 配送点",
    DELIVERY_POINT_STATE_CHANGE: "仓站 / 配送点",
    WAITING_POINT_STATE_CHANGE: "仓站 / 配送点",
    ALTERNATE_LANDING_POINT_STATE_CHANGE: "仓站 / 配送点",
    DYNAMIC_ORDER: "仓站 / 配送点",
    ORDER_CANCELLED: "仓站 / 配送点",
    ORDER_PRIORITY_CHANGED: "仓站 / 配送点"
  },
  VTOL_INSPECTION: {}
}

export function runtimeEventSource(sceneType: RuntimeSceneType, category: string, code?: string): string {
  const sources = sourceByScene[sceneType]
  return (code ? sourceByEvent[sceneType][code] : undefined) ?? sources[category] ?? sources.DEFAULT ?? "系统模拟角色"
}

export function runtimeEventCategoryLabel(sceneType: RuntimeSceneType, category: string): string {
  const labels: Record<RuntimeSceneType, Record<string, string>> = {
    CITY_SHOW: {
      WEATHER: "气象",
      POSITIONING_ELECTROMAGNETIC: "定位与电磁",
      COMMUNICATION_CONTROL: "通信与控制",
      AIRCRAFT_DEVICE: "航空器设备"
    },
    CITY_LOGISTICS: {
      WEATHER_ENVIRONMENT: "气象环境",
      POSITIONING_NAVIGATION: "定位与导航",
      COMMUNICATION_LINK: "通信链路",
      AIRCRAFT_DEVICE: "航空器设备",
      ROUTE_OPERATION: "航线运行",
      ORDER_TASK_CHANGE: "订单与任务"
    },
    VTOL_INSPECTION: {
      WEATHER: "气象",
      POSITIONING: "定位",
      COMMUNICATION: "通信",
      ENERGY_POWER: "能源与动力",
      DEVICE: "航空器设备",
      MODE_TRANSITION: "模式转换",
      ROUTE_AREA: "航线与区域",
      TASK_CONDITION: "任务条件"
    }
  }
  return labels[sceneType][category] ?? category
}
