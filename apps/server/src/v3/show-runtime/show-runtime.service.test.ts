import { describe, expect, it } from "vitest"
import type { RuntimeAlertEntity, RuntimeEventEntity } from "../runtime/runtime.entities.js"
import { assertShowActionContextPending, nextShowSnapshotSequence } from "./show-runtime.service.js"

describe("show runtime snapshot sequence", () => {
  it("continues after the greater checkpoint or database sequence", () => {
    expect(nextShowSnapshotSequence(3, 4)).toBe(5)
    expect(nextShowSnapshotSequence(6, 4)).toBe(7)
  })

  it("accepts PostgreSQL numeric results", () => {
    expect(nextShowSnapshotSequence(3, "9")).toBe(10)
  })

  it("starts from one when both sources are invalid", () => {
    expect(nextShowSnapshotSequence(Number.NaN, null)).toBe(1)
    expect(nextShowSnapshotSequence(-4, "invalid")).toBe(1)
  })
})

describe("show runtime resolved event protection", () => {
  it("rejects a new action linked to an already resolved event", () => {
    const event = { status: "RESOLVED", payload: { lifecycleStatus: "CONTROLLED" } } as RuntimeEventEntity
    const alert = { status: "RESOLVED" } as RuntimeAlertEntity
    expect(() => assertShowActionContextPending(event, alert, "SINGLE_LAND")).toThrowError("当前事件已经处置完成")
  })

  it("allows an action while the event is still active", () => {
    const event = { status: "ACTIVE", payload: { lifecycleStatus: "DISCOVERED" } } as RuntimeEventEntity
    const alert = { status: "OPEN" } as RuntimeAlertEntity
    expect(() => assertShowActionContextPending(event, alert, "SINGLE_LAND")).not.toThrow()
  })

  it("does not allow a resolved alert to be acknowledged again", () => {
    const alert = { status: "RESOLVED" } as RuntimeAlertEntity
    expect(() => assertShowActionContextPending(null, alert, "ACKNOWLEDGE_ALERT")).toThrowError("当前告警已经处置完成")
  })
})
