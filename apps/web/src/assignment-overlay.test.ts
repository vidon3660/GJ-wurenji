import { describe, expect, it } from "vitest"
import type { V3ScenarioOverlayVersionView } from "@wurenji/shared"
import { assignmentPlanVersion, publishedScenarioOverlayVersions, scenarioOverlayResourceVersion } from "./assignment-overlay"

function version(overrides: Partial<V3ScenarioOverlayVersionView> = {}): V3ScenarioOverlayVersionView {
  return {
    id: "overlay-v1",
    overlayId: "overlay",
    versionNo: 1,
    revision: 1,
    sceneType: "CITY_LOGISTICS",
    regionPackageId: "region-1",
    title: "物流覆盖层",
    name: "物流覆盖层",
    status: "PUBLISHED",
    objects: [],
    checksum: "sha-1",
    createdById: "teacher",
    createdByName: "教师",
    publishedAt: "2026-09-28T00:00:00.000Z",
    archivedAt: null,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    ...overrides
  }
}

describe("assignment overlay references", () => {
  it("only exposes published overlays matching the selected scene and region", () => {
    const visible = publishedScenarioOverlayVersions([
      version({ id: "archived", status: "ARCHIVED", versionNo: 4 }),
      version({ id: "other-region", regionPackageId: "region-2", versionNo: 5 }),
      version({ id: "other-scene", sceneType: "CITY_SHOW", versionNo: 6 }),
      version({ id: "older", versionNo: 2 }),
      version({ id: "newer", versionNo: 3 })
    ], "CITY_LOGISTICS", "region-1")
    expect(visible.map((item) => item.id)).toEqual(["newer", "older"])
  })

  it("uses immutable D2 and assignment snapshot identities", () => {
    expect(scenarioOverlayResourceVersion(version({ id: "overlay-v7", versionNo: 7, checksum: "sha-7" }))).toBe("SCENARIO_OVERLAY:overlay-v7@7#sha-7")
    expect(scenarioOverlayResourceVersion(null)).toBe("UNRESOLVED")
    expect(assignmentPlanVersion("draft-1", 4, "config-sha")).toBe("assignment:draft-1@4#config-sha")
    expect(assignmentPlanVersion(undefined, undefined, undefined)).toBe("发布后由服务端冻结")
  })
})
