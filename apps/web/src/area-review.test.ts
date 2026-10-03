import { describe, expect, it } from "vitest"
import type { ShowAreaCheckResult, ShowAreaFeatureView, ShowAreaPlanVersionView } from "@wurenji/shared"
import { areaFeatureCoordinateRows, areaSpatialRelationRows, preferredAreaReviewVersion } from "./area-review"

describe("teacher area review presentation", () => {
  it("prefers the authoritative submitted or accepted version over the draft", () => {
    expect(preferredAreaReviewVersion([version("RETURNED", 3), version("ACCEPTED", 2), version("SNAPSHOT", 1)])?.versionNo).toBe(2)
    expect(preferredAreaReviewVersion([version("SUBMITTED", 4), version("ACCEPTED", 2)])?.versionNo).toBe(4)
  })

  it("formats every WGS84 vertex for review", () => {
    expect(areaFeatureCoordinateRows(feature())).toEqual([
      "01 · 114.0012345, 22.0012345",
      "02 · 114.0023456, 22.0023456",
      "03 · 114.0034567, 22.0012345"
    ])
  })

  it("presents structured spatial relationships and supports historical evidence", () => {
    const current = result({
      spatialRelations: [{ leftFeatureId: "area-1", rightFeatureId: "area-2", relation: "DISJOINT", centroidDistanceMeters: 120, message: "起降区与观众区相离，中心距 120.0 m" }]
    })
    expect(areaSpatialRelationRows(current, [feature()])).toEqual([{ key: "area-1:area-2", severity: "INFO", label: "起降区与观众区相离，中心距 120.0 m" }])

    const historical = result({ evidence: [{ code: "AREA_OVERLAP", severity: "RISK", blocking: false, message: "区域存在重叠", featureIds: ["area-1", "area-2"] }] })
    expect(areaSpatialRelationRows(historical, [feature(), { ...feature(), id: "area-2", label: "观众区" }])[0]?.label).toContain("起降区 / 观众区")
  })
})

function feature(): ShowAreaFeatureView {
  return {
    id: "area-1",
    type: "TAKEOFF_LANDING",
    label: "起降区",
    positions: [
      { longitude: 114.0012345, latitude: 22.0012345 },
      { longitude: 114.0023456, latitude: 22.0023456 },
      { longitude: 114.0034567, latitude: 22.0012345 }
    ],
    properties: { capacity: 100, orientationDegrees: 0 },
    measurement: { areaSquareMeters: 1000, perimeterMeters: 140, centroid: { longitude: 114.002, latitude: 22.0016 } }
  }
}

function version(status: ShowAreaPlanVersionView["status"], versionNo: number): ShowAreaPlanVersionView {
  return { id: `version-${versionNo}`, versionNo, sourceDraftRevision: versionNo, status, features: [], annotations: [], checkResult: result({}), planningMapAsset: null, review: null, createdAt: "2026-08-14T00:00:00.000Z", submittedAt: null }
}

function result(input: Partial<ShowAreaCheckResult>): ShowAreaCheckResult {
  return { passed: true, checkedAt: "2026-08-14T00:00:00.000Z", featureCount: 2, completeTypeCount: 2, requiredTypeCount: 9, evidence: [], ...input }
}
