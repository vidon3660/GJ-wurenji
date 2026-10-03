import { describe, expect, it } from "vitest"
import type { V3ResourceReference } from "@wurenji/shared"
import { freezeAssignmentResourceVersions } from "./assignment.service.js"

const references: V3ResourceReference[] = [
  { packageId: "region-v2", packageType: "REGION", name: "教学区域", version: "2.0.0", sha256: "region-sha" },
  { packageId: "rule-v1", packageType: "RULE", name: "规则", version: "1.0.0", sha256: "rule-sha" }
]

describe("assignment snapshot resource versions", () => {
  it("freezes the region identity and published overlay identity", () => {
    expect(freezeAssignmentResourceVersions(references, { id: "overlay-version-1", versionNo: 3, checksum: "overlay-sha" }, "assignment:draft-1@4#config-sha")).toEqual({
      mapResourceVersion: "REGION:region-v2@2.0.0#region-sha",
      sceneResourceVersion: "SCENARIO_OVERLAY:overlay-version-1@3#overlay-sha",
      planVersion: "assignment:draft-1@4#config-sha"
    })
  })

  it("uses explicit unresolved values when an optional resource is absent", () => {
    expect(freezeAssignmentResourceVersions([], null, "  ")).toEqual({
      mapResourceVersion: "UNRESOLVED",
      sceneResourceVersion: "UNRESOLVED",
      planVersion: "UNRESOLVED"
    })
  })
})
