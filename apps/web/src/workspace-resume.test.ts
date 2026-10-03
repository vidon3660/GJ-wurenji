import { describe, expect, it, vi } from "vitest"
import {
  clearWorkspaceResumeTarget,
  loadWorkspaceResumeTarget,
  parseWorkspaceResumeTarget,
  saveWorkspaceResumeTarget,
  workspaceResumeKey
} from "./workspace-resume"

describe("workspace resume", () => {
  it("parses only a valid versioned V3 target", () => {
    expect(parseWorkspaceResumeTarget('{"version":1,"kind":"V3","id":" project-1 "}')).toEqual({ version: 1, kind: "V3", id: "project-1" })
    expect(parseWorkspaceResumeTarget('{"version":2,"kind":"V3","id":"project-1"}')).toBeNull()
    expect(parseWorkspaceResumeTarget('{"version":1,"kind":"V2","id":"practice-1"}')).toBeNull()
    expect(parseWorkspaceResumeTarget("not-json")).toBeNull()
  })

  it("isolates saved projects by user and clears explicit exits", () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key))
    }

    saveWorkspaceResumeTarget(storage, "student-1", "project-1")
    expect(loadWorkspaceResumeTarget(storage, "student-1")?.id).toBe("project-1")
    expect(loadWorkspaceResumeTarget(storage, "student-2")).toBeNull()

    clearWorkspaceResumeTarget(storage, "student-1")
    expect(values.has(workspaceResumeKey("student-1"))).toBe(false)
  })
})
