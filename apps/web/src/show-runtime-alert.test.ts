import { describe, expect, it } from "vitest"
import type { V3AlertSeverity } from "@wurenji/shared"
import { showRuntimeAlertPresentation, showRuntimeAlertSeverityLabel } from "./show-runtime-alert"

describe("show runtime alert presentation", () => {
  it("maps the four STU-023 alert levels to the required labels", () => {
    const severities: V3AlertSeverity[] = ["INFO", "WARNING", "ERROR", "CRITICAL"]

    expect(severities.map(showRuntimeAlertSeverityLabel)).toEqual(["提示", "一般", "重要", "紧急"])
  })

  it("exposes affected aircraft count and group scope", () => {
    expect(showRuntimeAlertPresentation(
      { severity: "ERROR" },
      { affectedCount: 80, affectedGroupIds: ["G01", "G03"] }
    )).toEqual({
      severityLabel: "重要",
      affectedCount: 80,
      affectedGroupsLabel: "G01、G03",
      impactLabel: "80 架 · G01、G03"
    })
  })

  it("keeps a stable scope before an event is linked", () => {
    expect(showRuntimeAlertPresentation({ severity: "INFO" }, null).impactLabel).toBe("0 架 · 未指定分组")
  })
})
