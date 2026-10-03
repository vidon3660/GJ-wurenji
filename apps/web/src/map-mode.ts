export type TeachingMapMode = "2d" | "3d"

const precisionPlanningStages = new Set([
  "SHOW_AREA_PLANNING",
  "LOGISTICS_REGION_ANALYSIS",
  "LOGISTICS_ROUTE_PLANNING",
  "LOGISTICS_ROUTE_VALIDATION",
  "LOGISTICS_ORDER_SCHEDULING",
  "LOGISTICS_RUNTIME_PREPARATION",
  "VTL_AREA_OBJECTS",
  "VTL_TASK_ALLOCATION",
  "VTL_ROUTE_PLANNING",
  "VTL_PLAN_VALIDATION",
  "VTL_EXECUTION_PLAN"
])

export function preferredV3MapMode(stageCode: string | null | undefined): TeachingMapMode {
  return stageCode && precisionPlanningStages.has(stageCode) ? "2d" : "3d"
}

/** 模式文案：2D 精确规划、3D 空间理解（chip 文案与无障碍标签保持一致） */
export const teachingMapModeLabels: Record<TeachingMapMode, string> = {
  "2d": "精确规划视角",
  "3d": "空间理解视角"
}

export function teachingMapModeLabel(mode: TeachingMapMode): string {
  return teachingMapModeLabels[mode]
}
