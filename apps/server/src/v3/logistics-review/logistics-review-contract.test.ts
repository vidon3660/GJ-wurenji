import { describe, expect, it } from "vitest"
import { serializeLogisticsReviewSnapshotFields } from "./logistics-review-contract.js"

describe("logistics review response contract", () => {
  it("serializes all frozen snapshot fields without deriving them", () => {
    const fields = serializeLogisticsReviewSnapshotFields({
      mapResourceVersion: "REGION:region@1#map-checksum",
      sceneResourceVersion: "SCENARIO_OVERLAY:overlay@2#scene-checksum",
      planVersion: "assignment:draft@3#plan-checksum",
      config: { scenarioOverlayVersionId: "overlay-version-2" }
    })

    expect(fields).toEqual({
      mapResourceVersion: "REGION:region@1#map-checksum",
      sceneResourceVersion: "SCENARIO_OVERLAY:overlay@2#scene-checksum",
      planVersion: "assignment:draft@3#plan-checksum",
      scenarioOverlayVersionId: "overlay-version-2"
    })
  })

  it("returns null when the frozen assignment has no scenario overlay", () => {
    expect(serializeLogisticsReviewSnapshotFields({
      mapResourceVersion: "UNRESOLVED",
      sceneResourceVersion: "UNRESOLVED",
      planVersion: "assignment:draft@1#plan-checksum",
      config: {}
    })).toEqual({
      mapResourceVersion: "UNRESOLVED",
      sceneResourceVersion: "UNRESOLVED",
      planVersion: "assignment:draft@1#plan-checksum",
      scenarioOverlayVersionId: null
    })
  })
})
