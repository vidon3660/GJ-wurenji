import { describe, expect, it } from "vitest"
import { buildStudentWorkspaceFlow, studentWorkspacePermission, studentWorkspacePhaseForStage } from "./student-workspace-flow"

const stages = [
  { stageCode: "LOGISTICS_REGION_ANALYSIS", status: "ACCEPTED", sequence: 1 },
  { stageCode: "LOGISTICS_ROUTE_PLANNING", status: "IN_PROGRESS", sequence: 2 },
  { stageCode: "LOGISTICS_ROUTE_VALIDATION", status: "LOCKED", sequence: 3 },
  { stageCode: "LOGISTICS_DELIVERY_RUNTIME", status: "LOCKED", sequence: 4 },
  { stageCode: "LOGISTICS_EMERGENCY_HANDLING", status: "LOCKED", sequence: 5 },
  { stageCode: "LOGISTICS_REVIEW", status: "LOCKED", sequence: 6 }
] as never

describe("student workspace flow", () => {
  it("maps scene stages onto the single teaching path", () => {
    const flow = buildStudentWorkspaceFlow({ currentStageCode: "LOGISTICS_ROUTE_PLANNING", status: "IN_PROGRESS", stages }, "LOGISTICS_ROUTE_PLANNING")

    expect(flow.map((phase) => phase.key)).toEqual(["BRIEFING", "PLANNING", "CHECKING", "RUNTIME", "HANDLING", "REVIEW"])
    expect(flow[0]).toMatchObject({ status: "AVAILABLE", stageCode: null })
    expect(flow.find((phase) => phase.key === "PLANNING")).toMatchObject({ status: "ACTIVE", isCurrent: true, isSelected: true, stageCode: "LOGISTICS_ROUTE_PLANNING" })
    expect(flow.find((phase) => phase.key === "CHECKING")).toMatchObject({ status: "LOCKED", isCurrent: false })
  })

  it("keeps the selected historical stage visible without changing the current phase", () => {
    const flow = buildStudentWorkspaceFlow({ currentStageCode: "LOGISTICS_ROUTE_VALIDATION", status: "IN_PROGRESS", stages }, "LOGISTICS_ROUTE_PLANNING")
    expect(flow.find((phase) => phase.key === "PLANNING")).toMatchObject({ isSelected: true, isCurrent: false })
    expect(flow.find((phase) => phase.key === "CHECKING")).toMatchObject({ isCurrent: true, isSelected: false })
    expect(studentWorkspacePhaseForStage("VTL_EMERGENCY_HANDLING")).toBe("HANDLING")
  })

  it("exposes server-authoritative training and assessment permissions", () => {
    const student = { role: "student" } as const
    expect(studentWorkspacePermission({ mode: "TRAINING", status: "IN_PROGRESS", assignmentStatus: "PUBLISHED", assessmentTiming: { canStart: true, canWrite: true } } as never, student)).toMatchObject({ kind: "TRAINING", canEdit: true })
    expect(studentWorkspacePermission({ mode: "ASSESSMENT", status: "IN_PROGRESS", assignmentStatus: "PUBLISHED", assessmentTiming: { canStart: false, canWrite: false, blockedReason: "考核尚未开放" } } as never, student)).toMatchObject({ kind: "ASSESSMENT_BLOCKED", canEdit: false, detail: "考核尚未开放" })
    expect(studentWorkspacePermission({ mode: "ASSESSMENT", status: "IN_PROGRESS", assignmentStatus: "PUBLISHED", assessmentTiming: { canStart: true, canWrite: true } } as never, { role: "teacher" })).toMatchObject({ kind: "READ_ONLY", canEdit: false })
    expect(studentWorkspacePermission({ mode: "TRAINING", status: "BLOCKED", assignmentStatus: "PUBLISHED", assessmentTiming: { canStart: true, canWrite: true } } as never, student)).toMatchObject({ kind: "PROJECT_BLOCKED", canEdit: false })
  })
})
