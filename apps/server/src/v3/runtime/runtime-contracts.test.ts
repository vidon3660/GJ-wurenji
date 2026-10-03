import { describe, expect, it } from "vitest"
import {
  runtimeActionErrorCodes,
  runtimeContract,
  runtimeEventStatuses,
  runtimeModes,
  runtimeSessionStatuses,
  type RuntimeSseMessage
} from "@wurenji/shared"

describe("runtime contract", () => {
  it("freezes shared protocol and measurement conventions", () => {
    expect(runtimeContract).toEqual({
      protocol: "wurenji-runtime-contract-v1",
      coordinateOrder: "longitude,latitude,altitudeMeters",
      coordinateReference: "WGS84",
      displayProjection: "EPSG:3857",
      heightUnit: "meters",
      timeUnit: "milliseconds",
      timestamps: "RFC3339 UTC"
    })
  })

  it("keeps lifecycle values explicit and non-overlapping", () => {
    expect(runtimeModes).toEqual(["TRAINING", "ASSESSMENT"])
    expect(runtimeSessionStatuses).toContain("READY")
    expect(runtimeSessionStatuses).toContain("FAILED")
    expect(runtimeEventStatuses).toEqual(["PLANNED", "SCHEDULED", "ACTIVE", "RESOLVED", "CANCELLED"])
    expect(new Set(runtimeActionErrorCodes).size).toBe(runtimeActionErrorCodes.length)
  })

  it("models each SSE message as a discriminated union", () => {
    const message: RuntimeSseMessage = {
      type: "ERROR",
      revision: 3,
      error: {
        code: "STALE_SESSION_REVISION",
        message: "session revision is stale",
        requestId: "request-1",
        sessionId: "session-1",
        revision: 3,
        details: {}
      }
    }
    expect(message.type).toBe("ERROR")
    expect(message.error.code).toBe("STALE_SESSION_REVISION")
  })
})
