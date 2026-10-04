import type { StudentProjectStageView, StudentProjectView, V3StageCode } from "@wurenji/shared"

const simulationStageCodes = new Set<V3StageCode>([
  "SHOW_RUNTIME",
  "LOGISTICS_DELIVERY_RUNTIME",
  "LOGISTICS_EMERGENCY_HANDLING",
  "VTL_RUNTIME",
  "VTL_EMERGENCY_HANDLING"
])

export function projectSimulationStage(project: StudentProjectView | null | undefined): StudentProjectStageView | null {
  if (!project) return null
  const candidates = project.stages.filter((stage) => simulationStageCodes.has(stage.stageCode))
  return candidates.find((stage) => stage.stageCode === project.currentStageCode)
    ?? candidates.find((stage) => stage.status !== "LOCKED")
    ?? candidates[0]
    ?? null
}

export function isSimulationStage(stageCode: V3StageCode | string | null | undefined): boolean {
  return Boolean(stageCode && simulationStageCodes.has(stageCode as V3StageCode))
}

export function simulationEntryStatus(stage: StudentProjectStageView | null | undefined): string {
  if (!stage) return "待开放"
  if (stage.status === "LOCKED") return stage.openCondition ? `待开放 · ${stage.openCondition}` : "待开放 · 完成前置阶段后开放"
  if (stage.status === "AVAILABLE") return "可进入"
  if (stage.status === "IN_PROGRESS" || stage.status === "RETURNED") return "运行中"
  if (stage.status === "SUBMITTED") return "待评分"
  return "已完成"
}

export function simulationEntryCondition(stage: StudentProjectStageView | null | undefined): string {
  if (!stage) return "完成前置阶段后开放"
  if (stage.status !== "LOCKED") return "当前已满足进入条件"
  return stage.openCondition?.trim() || "完成前置阶段后开放"
}
