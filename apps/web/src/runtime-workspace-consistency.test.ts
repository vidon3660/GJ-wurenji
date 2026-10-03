import { describe, expect, it } from "vitest"
import { shouldApplyRuntimeWorkspace, type RuntimeWorkspaceVersion } from "./runtime-workspace-consistency"

const workspace = (id: string, attemptNo: number, revision: number): RuntimeWorkspaceVersion => ({ session: { id, attemptNo, revision } })

describe("runtime workspace consistency", () => {
  it("rejects an older revision from a delayed HTTP response", () => {
    expect(shouldApplyRuntimeWorkspace(workspace("session-1", 1, 8), workspace("session-1", 1, 7))).toBe(false)
    expect(shouldApplyRuntimeWorkspace(workspace("session-1", 1, 8), workspace("session-1", 1, 8))).toBe(true)
  })

  it("prefers a newly created attempt over a stale response from the previous attempt", () => {
    expect(shouldApplyRuntimeWorkspace(workspace("session-2", 2, 1), workspace("session-1", 1, 9))).toBe(false)
    expect(shouldApplyRuntimeWorkspace(workspace("session-1", 1, 9), workspace("session-2", 2, 1))).toBe(true)
  })

  it("allows an explicit historical-attempt selection", () => {
    expect(shouldApplyRuntimeWorkspace(workspace("session-2", 2, 1), workspace("session-1", 1, 9), { allowOlderAttempt: true })).toBe(true)
  })
})
