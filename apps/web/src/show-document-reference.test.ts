import { describe, expect, it } from "vitest"
import type { ShowDocumentReferencePanel } from "@wurenji/shared"
import { planningMapPreviewPath, showDocumentReferenceCoordinates } from "./show-document-reference"

describe("show document task reference", () => {
  it("projects every takeoff and airspace coordinate for student reference", () => {
    const rows = showDocumentReferenceCoordinates(reference())

    expect(rows).toEqual([
      { id: "takeoff-0", label: "起降点 1", coordinate: "114.072900, 22.691750" },
      { id: "boundary-0", label: "空域边界 1", coordinate: "114.070000, 22.690000" },
      { id: "boundary-1", label: "空域边界 2", coordinate: "114.080000, 22.700000" }
    ])
  })

  it("uses the authenticated inline planning-map endpoint", () => {
    expect(planningMapPreviewPath(reference().planningMapAsset)).toBe("/v3/files/map/preview")
    expect(planningMapPreviewPath(null)).toBeNull()
  })
})

function reference(): ShowDocumentReferencePanel {
  return {
    projectName: "城市表演任务",
    projectBackground: "背景",
    taskBrief: "说明",
    completionRequirements: "完成要求",
    scaleTemplateCode: "SHOW_100",
    aircraftCount: 100,
    plannedStartAt: "2026-08-20T12:00:00.000Z",
    plannedEndAt: "2026-08-20T12:20:00.000Z",
    plannedAudienceCount: 2000,
    aircraftModel: "SHOW-UAV-01",
    contactName: "教师",
    contactPhone: "13800000000",
    regionName: "深圳教学区",
    areaPlanVersion: 2,
    planningMapAsset: {
      id: "map",
      category: "PLANNING_MAP",
      originalName: "区域规划图.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      createdAt: "2026-08-20T11:00:00.000Z",
      downloadPath: "/v3/files/map/download"
    },
    takeoffPoints: [{ longitude: 114.0729, latitude: 22.69175 }],
    airspaceBoundary: [{ longitude: 114.07, latitude: 22.69 }, { longitude: 114.08, latitude: 22.7 }],
    maximumHeightMeters: 120
  }
}
