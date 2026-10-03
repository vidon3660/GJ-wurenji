import { describe, expect, it } from "vitest"
import { eligibleRuntimeRoutesForTarget, eligibleRuntimeTargets, runtimeActionEventId, runtimeActionOptionLabel } from "./runtime-action-targets"

describe("runtime action target presentation", () => {
  it("keeps only targets authorized by the server action contract", () => {
    const items = [{ id: "standby", status: "STANDBY" }, { id: "airborne", status: "OUTBOUND" }, { id: "landed", status: "AVAILABLE" }]
    expect(eligibleRuntimeTargets(items, ["airborne"])).toEqual([{ id: "airborne", status: "OUTBOUND" }])
  })

  it("shows the reason when a template or runtime state disables an action", () => {
    expect(runtimeActionOptionLabel("分组返航", false, "当前规模未开放该操作")).toBe("分组返航 · 当前规模未开放该操作")
    expect(runtimeActionOptionLabel("整体返航", true, null)).toBe("整体返航")
  })

  it("uses the server-authorized alternate routes for the selected order", () => {
    const routes = [{ id: "primary" }, { id: "alternate-a" }, { id: "alternate-b" }]
    expect(eligibleRuntimeRoutesForTarget(routes, { "order-1": ["alternate-b"] }, "order-1")).toEqual([{ id: "alternate-b" }])
    expect(eligibleRuntimeRoutesForTarget(routes, {}, "order-1")).toEqual([])
  })

  it("does not attach a resolved event to a new aircraft action", () => {
    expect(runtimeActionEventId({ id: "event-open", status: "HANDLING" })).toBe("event-open")
    expect(runtimeActionEventId({ id: "event-done", status: "RESOLVED" })).toBeUndefined()
    expect(runtimeActionEventId(null)).toBeUndefined()
  })
})
