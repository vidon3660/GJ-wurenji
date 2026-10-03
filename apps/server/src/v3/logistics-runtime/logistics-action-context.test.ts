import { describe, expect, it } from "vitest"
import type { RuntimeAlertEntity, RuntimeEventEntity } from "../runtime/runtime.entities.js"
import { assertLogisticsActionContextPending } from "./logistics-action-context.js"

describe("logistics resolved action protection", () => {
  it("rejects a new action linked to a resolved event", () => {
    const event = { status: "RESOLVED", payload: { lifecycleStatus: "CONTROLLED" } } as RuntimeEventEntity
    const alert = { status: "RESOLVED" } as RuntimeAlertEntity
    expect(() => assertLogisticsActionContextPending(event, alert, "REDUCE_SPEED")).toThrowError("当前物流事件已经处置完成")
  })

  it("rejects a new action linked to a controlled event lifecycle", () => {
    const event = { status: "ACTIVE", payload: { lifecycleStatus: "CONTROLLED" } } as RuntimeEventEntity
    expect(() => assertLogisticsActionContextPending(event, null, "HOLD_POSITION")).toThrowError("当前物流事件已经处置完成")
  })

  it("rejects acknowledgement of a resolved or acknowledged alert", () => {
    expect(() => assertLogisticsActionContextPending(null, { status: "RESOLVED" } as RuntimeAlertEntity, "ACKNOWLEDGE_ALERT"))
      .toThrowError("当前物流告警已经处置完成")
    expect(() => assertLogisticsActionContextPending(null, { status: "ACKNOWLEDGED" } as RuntimeAlertEntity, "ACKNOWLEDGE_ALERT"))
      .toThrowError("当前物流告警已经确认")
  })

  it("allows an action while the event and alert are still pending", () => {
    const event = { status: "ACTIVE", payload: { lifecycleStatus: "DISCOVERED" } } as RuntimeEventEntity
    const alert = { status: "OPEN" } as RuntimeAlertEntity
    expect(() => assertLogisticsActionContextPending(event, alert, "REDUCE_SPEED")).not.toThrow()
  })
})
