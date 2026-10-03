import { describe, expect, it, vi } from "vitest"
import type { Repository } from "typeorm"
import { RuntimeSessionEntity, StudentRuntimeActionEntity } from "./runtime.entities.js"
import { persistRejectedRuntimeAction } from "./runtime-action-failure.js"

describe("rejected runtime action persistence", () => {
  it("writes a rejected action with a stable error code after rollback", async () => {
    const create = vi.fn((value: Partial<StudentRuntimeActionEntity>) => value)
    const save = vi.fn(async (value: Partial<StudentRuntimeActionEntity>) => value)
    const actions = { create, save } as unknown as Repository<StudentRuntimeActionEntity>
    const sessions = {
      findOne: vi.fn(async () => ({ id: "session-1", projectId: "project-1", simulationTimeMs: 12_000, createdAt: new Date("2026-09-27T00:00:00Z") }))
    } as unknown as Repository<RuntimeSessionEntity>

    await persistRejectedRuntimeAction(actions, sessions, {
      projectId: "project-1",
      actorId: "student-1",
      actionCode: "RETURN_AIRCRAFT",
      requestId: "request-1",
      targetId: "aircraft-1",
      error: new Error("目标航空器不能再次返航")
    })

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      status: "REJECTED",
      sessionId: "session-1",
      actionCode: "RETURN_AIRCRAFT",
      targetId: "aircraft-1",
      simulationTimeMs: 12_000,
      payload: { rejected: true, _requestId: "request-1" },
      result: { applied: false, errorCode: "TARGET_STATE_INVALID", message: "目标航空器不能再次返航" },
      appliedAt: null
    }))
    expect(save).toHaveBeenCalledOnce()
  })

  it("does not create an orphan action when no session exists", async () => {
    const actions = { create: vi.fn(), save: vi.fn() } as unknown as Repository<StudentRuntimeActionEntity>
    const sessions = { findOne: vi.fn(async () => null) } as unknown as Repository<RuntimeSessionEntity>

    await persistRejectedRuntimeAction(actions, sessions, {
      projectId: "project-1",
      actorId: "student-1",
      actionCode: "UNKNOWN",
      requestId: null,
      error: new Error("运行批次不存在")
    })

    expect(actions.create).not.toHaveBeenCalled()
    expect(actions.save).not.toHaveBeenCalled()
  })
})
