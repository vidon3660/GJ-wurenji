export type V3OperationProgressStatus = "RUNNING" | "SUCCEEDED" | "FAILED"

export interface V3OperationProgressState {
  title: string
  steps: readonly string[]
  activeStep: number
  status: V3OperationProgressStatus
  detail: string
  result: string | null
}

export function startV3OperationProgress(title: string, steps: readonly string[]): V3OperationProgressState {
  if (steps.length === 0) throw new Error("Operation progress requires at least one step")
  return {
    title,
    steps: [...steps],
    activeStep: 0,
    status: "RUNNING",
    detail: steps[0]!,
    result: null
  }
}

export function advanceV3OperationProgress(
  state: V3OperationProgressState,
  activeStep: number,
  detail?: string
): V3OperationProgressState {
  const nextStep = Math.min(state.steps.length - 1, Math.max(state.activeStep, Math.trunc(activeStep)))
  return {
    ...state,
    activeStep: nextStep,
    status: "RUNNING",
    detail: detail ?? state.steps[nextStep]!,
    result: null
  }
}

export function completeV3OperationProgress(state: V3OperationProgressState, result: string): V3OperationProgressState {
  return {
    ...state,
    activeStep: state.steps.length - 1,
    status: "SUCCEEDED",
    detail: state.steps[state.steps.length - 1]!,
    result
  }
}

export function failV3OperationProgress(state: V3OperationProgressState, result: string): V3OperationProgressState {
  return {
    ...state,
    status: "FAILED",
    result
  }
}

export function v3OperationStepState(
  state: V3OperationProgressState,
  stepIndex: number
): "PENDING" | "ACTIVE" | "COMPLETE" | "FAILED" {
  if (stepIndex < state.activeStep || state.status === "SUCCEEDED") return "COMPLETE"
  if (stepIndex > state.activeStep) return "PENDING"
  return state.status === "FAILED" ? "FAILED" : state.status === "RUNNING" ? "ACTIVE" : "COMPLETE"
}

export function v3OperationStatusLabel(state: V3OperationProgressState): string {
  if (state.status === "SUCCEEDED") return "处理完成"
  if (state.status === "FAILED") return `第 ${state.activeStep + 1} 步失败`
  return `第 ${state.activeStep + 1}/${state.steps.length} 步`
}
