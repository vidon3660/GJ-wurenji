export const VTL_DENSE_TASK_LABEL_THRESHOLD = 10

export interface VtlTaskLabelOptions {
  taskCount: number
  taskId: string
  code: string
  title: string
  selectedTaskId?: string | null
  selectedAircraftTaskIds?: readonly string[]
}

export interface VtlLandingSiteLabelOptions {
  aircraftCount: number
  siteId: string
  mainLandingSiteId: string
  code: string
  title: string
}

export function vtlTaskLabelText(options: VtlTaskLabelOptions): string | null {
  const fullLabel = `${options.code} ${options.title}`
  if (options.taskCount <= VTL_DENSE_TASK_LABEL_THRESHOLD) return fullLabel
  if (options.taskId === options.selectedTaskId) return fullLabel
  if (options.selectedAircraftTaskIds?.includes(options.taskId)) return options.code
  return null
}

export function vtlLandingSiteLabelText(options: VtlLandingSiteLabelOptions): string | null {
  if (options.aircraftCount <= VTL_DENSE_TASK_LABEL_THRESHOLD || options.siteId === options.mainLandingSiteId) return `${options.code} ${options.title}`
  return null
}
