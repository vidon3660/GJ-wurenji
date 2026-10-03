import { describe, expect, it } from "vitest"
import { collectTargetClassroomsByDraftId, type AssignmentTargetClassroomSource } from "./assignment-targets.js"

function target(draftId: string, classroomId: string, name = classroomId): AssignmentTargetClassroomSource {
  return {
    snapshot: { draft: { id: draftId } },
    classroom: { id: classroomId, code: `C-${classroomId}`, name, course: { name: "低空无人机基础" } }
  }
}

describe("assignment target classrooms", () => {
  it("groups unique classroom targets by assignment draft", () => {
    const result = collectTargetClassroomsByDraftId([target("draft-1", "class-1", "一班"), target("draft-1", "class-1", "重复一班"), target("draft-2", "class-2", "二班")])
    expect(result.get("draft-1")).toEqual([{ id: "class-1", code: "C-class-1", name: "一班", courseName: "低空无人机基础" }])
    expect(result.get("draft-2")?.[0]?.name).toBe("二班")
  })

  it("ignores direct student targets without a classroom", () => {
    const result = collectTargetClassroomsByDraftId([{ snapshot: { draft: { id: "draft-1" } }, classroom: null }])
    expect(result.size).toBe(0)
  })
})
