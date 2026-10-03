import { describe, expect, it } from "vitest"
import { formatPlatformDate, formatPlatformDateTime, PLATFORM_TIME_ZONE } from "./platform-date"

describe("platform date formatting", () => {
  it("uses the platform timezone instead of the browser timezone", () => {
    expect(PLATFORM_TIME_ZONE).toBe("Asia/Shanghai")
    expect(formatPlatformDateTime("2026-09-09T00:30:00.000Z")).toBe("2026/09/09 08:30:00")
  })

  it("returns a clear fallback for invalid timestamps", () => {
    expect(formatPlatformDate("not-a-date")).toBe("-")
  })
})
