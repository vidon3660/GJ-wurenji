import { describe, expect, it } from "vitest"
import { freezeRuntimeResourceVersions, resourceVersionIdentity } from "@wurenji/shared"

describe("runtime resource versions", () => {
  it("creates stable identities from frozen package references", () => {
    const versions = freezeRuntimeResourceVersions([
      { packageId: "region-1", packageType: "REGION", version: "2.1.0", sha256: "region-sha" },
      { packageId: "scale-1", packageType: "SCALE_TEMPLATE", version: "1.4.0", sha256: "scale-sha" }
    ], "schedule:17")

    expect(versions).toEqual({
      mapResourceVersion: "REGION:region-1@2.1.0#region-sha",
      sceneResourceVersion: "SCALE_TEMPLATE:scale-1@1.4.0#scale-sha",
      planVersion: "schedule:17"
    })
  })

  it("has explicit unresolved values when resources are incomplete", () => {
    expect(resourceVersionIdentity(undefined)).toBe("UNRESOLVED")
    expect(freezeRuntimeResourceVersions([], "")).toEqual({
      mapResourceVersion: "UNRESOLVED",
      sceneResourceVersion: "UNRESOLVED",
      planVersion: "UNRESOLVED"
    })
  })
})
