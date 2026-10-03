import type { LearningMode, SceneType, StageDefinition, V3StageCode } from "@wurenji/shared"
import type { MapLayerDefinition } from "../../map-layer-registry"

export type ValidationSeverity = "INFO" | "WARNING" | "ERROR"

export interface ValidationIssue {
  code: string
  severity: ValidationSeverity
  message: string
  objectId?: string
}

export interface ValidationContext {
  mode: LearningMode
  stageCode: V3StageCode
  resourceVersions: Readonly<Record<string, string>>
}

export interface WorkspaceTool {
  id: string
  title: string
  icon: string
  allowedStageCodes: readonly V3StageCode[]
}

export interface PanelDefinition {
  id: string
  title: string
  placement: "LEFT" | "RIGHT" | "BOTTOM"
  order: number
}

export interface WorkspaceCapabilities {
  selectObject(objectId: string | null): void
  focusObject(objectId: string): void
  executeCommand<TPayload>(command: string, payload: TPayload): Promise<void>
}

export interface WorkspaceContext<TDraft, TRuntime> {
  draft: TDraft
  runtime: TRuntime | null
  capabilities: WorkspaceCapabilities
}

export interface ScenarioWorkspacePlugin<TConfig, TDraft, TRuntime> {
  code: SceneType
  stageDefinitions: readonly StageDefinition[]
  createDraft(config: TConfig): TDraft
  validateDraft(draft: TDraft, context: ValidationContext): ValidationIssue[]
  mapLayers(context: WorkspaceContext<TDraft, TRuntime>): MapLayerDefinition[]
  tools(context: WorkspaceContext<TDraft, TRuntime>): WorkspaceTool[]
  panels(context: WorkspaceContext<TDraft, TRuntime>): PanelDefinition[]
  serializeDraft(draft: TDraft): unknown
  applyServerSnapshot(snapshot: unknown): TDraft
}
