import { describe, expect, it, vi } from "vitest"
import type { AuthUser } from "@wurenji/shared"
import type { Repository } from "typeorm"
import type { StudentProjectEntity } from "../assignments/assignment.entities.js"
import { AssessmentWindowService } from "./assessment-window.service.js"

const student = { id: "student-1", role: "student" } as AuthUser

function project(sceneType: "CITY_SHOW" | "CITY_LOGISTICS" | "VTOL_INSPECTION", mode: "ASSESSMENT" | "TRAINING", dueAt: Date): StudentProjectEntity {
  return {
    id: `${sceneType}-${mode}`,
    student,
    snapshot: {
      sceneType,
      mode,
      config: {
        availableAt: new Date(Date.now() - 60_000).toISOString(),
        dueAt: dueAt.toISOString(),
        assessmentDurationMinutes: 60
      }
    },
    assessmentStartedAt: mode === "ASSESSMENT" ? new Date(Date.now() - 60_000) : null,
    assessmentDeadlineAt: mode === "ASSESSMENT" ? dueAt : null,
    assessmentSubmittedAt: null,
    assessmentEndedAt: null,
    assessmentAvailableAtOverride: null,
    assessmentDueAtOverride: null
  } as unknown as StudentProjectEntity
}

describe("AssessmentWindowService", () => {
  it.each(["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"] as const)("allows writable assessment projects in %s", async (sceneType) => {
    const repository = { findOne: vi.fn(), save: vi.fn() } as unknown as Repository<StudentProjectEntity>
    const service = new AssessmentWindowService(repository)
    const value = project(sceneType, "ASSESSMENT", new Date(Date.now() + 60 * 60_000))
    vi.mocked(repository.findOne).mockResolvedValue(value)

    await expect(service.assertWritable(value.id, student, false)).resolves.toBeUndefined()
    expect(repository.save).not.toHaveBeenCalled()
  })

  it.each(["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"] as const)("freezes expired assessment writes in %s", async (sceneType) => {
    const repository = { findOne: vi.fn(), save: vi.fn() } as unknown as Repository<StudentProjectEntity>
    const service = new AssessmentWindowService(repository)
    const value = project(sceneType, "ASSESSMENT", new Date(Date.now() - 60_000))
    vi.mocked(repository.findOne).mockResolvedValue(value)
    vi.mocked(repository.save).mockResolvedValue(value)

    await expect(service.assertWritable(value.id, student, false)).rejects.toThrow("考核时间已结束")
    expect(repository.save).toHaveBeenCalledOnce()
    expect(value.assessmentEndedAt).toBeTruthy()
  })

  it("does not apply an assessment window to training projects", async () => {
    const repository = { findOne: vi.fn(), save: vi.fn() } as unknown as Repository<StudentProjectEntity>
    const service = new AssessmentWindowService(repository)
    const value = project("CITY_LOGISTICS", "TRAINING", new Date(Date.now() - 60_000))
    vi.mocked(repository.findOne).mockResolvedValue(value)

    await expect(service.assertWritable(value.id, student, false)).resolves.toBeUndefined()
    expect(repository.save).not.toHaveBeenCalled()
  })
})
