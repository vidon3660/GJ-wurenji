import type { AssignmentPreflightCheckView, AssignmentPreflightFocusTarget } from "@wurenji/shared"

const focusTargets = new Set<AssignmentPreflightFocusTarget>([
  "task-title",
  "question-bank",
  "scale-template",
  "region",
  "show-program",
  "resource-dependencies",
  "map-resource",
  "show-schedule",
  "logistics-candidate-points",
  "logistics-runtime-schedule",
  "logistics-order-config",
  "vtl-runtime-schedule",
  "vtl-main-landing-site",
  "vtl-task-objects",
  "vtl-task-area",
  "vtl-open-stages",
  "vtl-evaluation-items",
  "scenario-events",
  "publish-classroom",
  "publish-schedule"
])

const legacyTargets: Record<string, AssignmentPreflightFocusTarget> = {
  CONFIGURATION: "task-title",
  QUESTION_BANK: "question-bank",
  RESOURCE_AVAILABILITY: "resource-dependencies",
  RESOURCE_COVERAGE: "resource-dependencies",
  SCALE_TEMPLATE: "scale-template",
  EVALUATION_RUBRIC: "resource-dependencies",
  SHOW_PROGRAM: "show-program",
  REGION_SCOPE: "region",
  MAP_RESOURCE: "map-resource",
  SCENARIO_RULES: "scenario-events",
  PUBLISH_SCOPE: "publish-classroom"
}

export function assignmentPreflightTarget(check: Pick<AssignmentPreflightCheckView, "code" | "focusTarget">): AssignmentPreflightFocusTarget | null {
  if (check.focusTarget && focusTargets.has(check.focusTarget)) return check.focusTarget
  return legacyTargets[check.code] ?? null
}

export function assignmentPreflightTargetSelector(check: Pick<AssignmentPreflightCheckView, "code" | "focusTarget">): string | null {
  const target = assignmentPreflightTarget(check)
  return target ? `[data-preflight-target="${target}"]` : null
}

export function firstPreflightFocusable(target: HTMLElement): HTMLElement {
  if (isFocusable(target)) return target
  return target.querySelector<HTMLElement>([
    "input:not([disabled])",
    "button:not([disabled])",
    "textarea:not([disabled])",
    "select:not([disabled])",
    "[tabindex]:not([tabindex=\"-1\"]):not([aria-disabled=\"true\"])",
    "[role=\"button\"]:not([aria-disabled=\"true\"])",
    "[role=\"combobox\"]:not([aria-disabled=\"true\"])"
  ].join(",")) ?? target
}

export function shouldInvalidateAssignmentPreview(status: number, message: string): boolean {
  return status === 409 && /版本冲突|配置已变化|重新预览|预览/.test(message)
}

function isFocusable(element: HTMLElement): boolean {
  return element.matches("input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"]):not([aria-disabled=\"true\"]), [role=\"button\"]:not([aria-disabled=\"true\"]), [role=\"combobox\"]:not([aria-disabled=\"true\"])")
}
