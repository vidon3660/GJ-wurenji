import { describe, expect, it } from "vitest"
import { vtlTaskTransferDecision } from "./vtl-task-transfer.js"

describe("vtl task transfer lifecycle", () => {
  it("waits for the source aircraft to finish its safe exit", () => {
    expect(vtlTaskTransferDecision("RETURNING", "ACTIVE")).toBe("WAITING_FOR_SOURCE_EXIT")
    expect(vtlTaskTransferDecision("HOLDING", "WAITING")).toBe("WAITING_FOR_SOURCE_EXIT")
  })

  it("assigns only after the source lands and the destination is available", () => {
    expect(vtlTaskTransferDecision("LANDED", "WAITING")).toBe("READY_TO_ASSIGN")
    expect(vtlTaskTransferDecision("LANDED", "ACTIVE")).toBe("READY_TO_ASSIGN")
  })

  it("records a failed transfer when the destination has exited", () => {
    expect(vtlTaskTransferDecision("LANDED", "LANDED")).toBe("DESTINATION_UNAVAILABLE")
    expect(vtlTaskTransferDecision("LANDED", "CANCELLED")).toBe("DESTINATION_UNAVAILABLE")
  })
})
