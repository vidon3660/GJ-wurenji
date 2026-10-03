import { describe, expect, it } from "vitest"
import type { AssignmentDraftView, V3TeacherProgressItem } from "@wurenji/shared"
import { buildTeachingAssignmentQueue } from "./assignment-queue.js"

function assignment(id: string, status: AssignmentDraftView["status"], updatedAt: string): AssignmentDraftView {
  return { id, title: id, sceneType: "CITY_SHOW", mode: "TRAINING", status, isDemo: false, isAcceptanceData: false, config: {} as AssignmentDraftView["config"], revision: 1, configHash: null, endedAt: null, archivedAt: null, lifecycleReason: null, createdAt: updatedAt, updatedAt } as AssignmentDraftView
}

function progress(input: Partial<V3TeacherProgressItem> & Pick<V3TeacherProgressItem, "assignmentId">): Pick<V3TeacherProgressItem, "assignmentId" | "submissionState" | "projectStatus" | "alerts" | "evaluationState"> {
  return {
    assignmentId: input.assignmentId,
    submissionState: input.submissionState ?? "NOT_STARTED",
    projectStatus: input.projectStatus ?? "NOT_STARTED",
    alerts: input.alerts ?? [],
    evaluationState: input.evaluationState ?? "NOT_STARTED"
  }
}

describe("teaching assignment queue", () => {
  it("summarizes student work and puts actionable assignments first", () => {
    const items = buildTeachingAssignmentQueue(
      [assignment("published", "PUBLISHED", "2026-09-01T00:00:00.000Z"), assignment("draft", "DRAFT", "2026-08-01T00:00:00.000Z"), assignment("evaluation", "IN_PROGRESS", "2026-09-02T00:00:00.000Z")],
      [
        progress({ assignmentId: "published", projectStatus: "BLOCKED" }),
        progress({ assignmentId: "evaluation", projectStatus: "SUBMITTED", submissionState: "SUBMITTED", evaluationState: "PENDING" })
      ]
    )

    expect(items.map((item) => item.id)).toEqual(["draft", "evaluation", "published"])
    expect(items[1]?.summary).toMatchObject({ projectCount: 1, submittedProjectCount: 1, pendingEvaluationCount: 1 })
    expect(items[2]?.summary.studentAttentionCount).toBe(1)
  })

  it("keeps formal and internal classification untouched", () => {
    const internal = { ...assignment("demo", "PUBLISHED", "2026-09-01T00:00:00.000Z"), isDemo: true }
    const [result] = buildTeachingAssignmentQueue([internal], [])
    expect(result).toMatchObject({ isDemo: true, isAcceptanceData: false })
  })
})
