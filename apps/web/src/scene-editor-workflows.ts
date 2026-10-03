import type { SceneType, V3ScenarioOverlayObjectType } from "@wurenji/shared"

export interface SceneEditorStep {
  id: string
  title: string
  hint: string
  types: readonly V3ScenarioOverlayObjectType[]
}

const saveStep: SceneEditorStep = {
  id: "publish",
  title: "保存并发布",
  hint: "先保存草稿，确认地图对象和参数后再发布给任务使用。",
  types: []
}

const baseStep: SceneEditorStep = {
  id: "base",
  title: "基础地图与图层",
  hint: "选择建筑、障碍物和禁限区域等实体图层，基础地图保持只读。",
  types: []
}

export const sceneEditorWorkflows: Record<SceneType, readonly SceneEditorStep[]> = {
  CITY_LOGISTICS: [
    baseStep,
    { id: "network", title: "配送网络与备降点", hint: "配置物流中心、等待点和备降点。", types: ["LOGISTICS_CENTER", "WAITING_POINT", "ALTERNATE_LANDING_POINT"] },
    { id: "tasks", title: "配送点与任务对象", hint: "补充学生调度时需要覆盖的配送点。", types: ["DELIVERY_POINT"] },
    { id: "limits", title: "禁限区与障碍物", hint: "添加禁限区域和需要避让的障碍物。", types: ["FLYABLE_AREA", "OBSTACLE"] },
    { id: "routes", title: "航路与发布检查", hint: "补充可复用航路，发布前再统一检查。", types: ["AIRWAY"] },
    saveStep
  ],
  CITY_SHOW: [
    baseStep,
    { id: "areas", title: "表演功能区与安全边界", hint: "绘制表演功能区、禁限区域和需要避让的障碍物。", types: ["FLYABLE_AREA", "OBSTACLE"] },
    { id: "points", title: "起降与应急点", hint: "标注起降、应急处置等需要在地图上联动的点位。", types: ["EMERGENCY_POINT", "TASK_POINT"] },
    { id: "routes", title: "航路与发布检查", hint: "补充表演航路，发布前再统一检查。", types: ["FLIGHT_CORRIDOR"] },
    saveStep
  ],
  VTOL_INSPECTION: [
    baseStep,
    { id: "objects", title: "障碍物与任务对象", hint: "配置障碍物、任务点和任务区。", types: ["OBSTACLE", "TASK_POINT", "MISSION_POINT"] },
    { id: "airfields", title: "起降与备降点", hint: "配置候选起降点和备降点，供航线与运行阶段复用。", types: ["ALTERNATE_LANDING_POINT"] },
    { id: "limits", title: "禁限区", hint: "补充巡检区域内的禁限区，发布前检查越界风险。", types: ["FLYABLE_AREA"] },
    { id: "routes", title: "航线与发布检查", hint: "补充垂起航路，发布前再统一检查。", types: ["AIRWAY"] },
    saveStep
  ]
}

export function sceneEditorWorkflowFor(sceneType: SceneType): readonly SceneEditorStep[] {
  return sceneEditorWorkflows[sceneType]
}

export function firstDrawableType(sceneType: SceneType): V3ScenarioOverlayObjectType {
  return sceneEditorWorkflowFor(sceneType).find((step) => step.types.length > 0)?.types[0] ?? "TASK_POINT"
}
