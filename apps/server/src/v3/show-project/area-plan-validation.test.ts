import { describe, expect, it } from "vitest"
import { checkAreaPlan, normalizeAreaAnnotations, normalizeAreaFeatures } from "./area-plan-validation.js"
import { completeFeatures, region } from "./area-plan.fixtures.js"

describe("show area plan validation", () => {
  it("accepts a complete nine-area teaching plan", () => {
    const result = checkAreaPlan(completeFeatures(), region())

    expect(result.passed).toBe(true)
    expect(result.completeTypeCount).toBe(9)
    expect(result.requiredTypeCount).toBe(9)
    expect(result.evidence.every((item) => !item.blocking)).toBe(true)
    expect(result.spatialRelations).toHaveLength(36)
    expect(result.spatialRelations?.every((item) => item.relation === "DISJOINT" && item.centroidDistanceMeters > 0)).toBe(true)
  })

  it("blocks missing, self-intersecting and out-of-bound geometry", () => {
    const features = completeFeatures().slice(0, 8)
    features[0] = {
      ...features[0]!,
      positions: [
        { longitude: 113.99, latitude: 21.99 },
        { longitude: 114.02, latitude: 22.02 },
        { longitude: 113.99, latitude: 22.02 },
        { longitude: 114.02, latitude: 21.99 }
      ]
    }
    const result = checkAreaPlan(features, region())

    expect(result.passed).toBe(false)
    expect(result.evidence.map((item) => item.code)).toEqual(expect.arrayContaining([
      "REQUIRED_AREA_MISSING",
      "SELF_INTERSECTION",
      "OUTSIDE_TASK_REGION"
    ]))
  })

  it("normalizes an explicitly closed WGS84 ring", () => {
    const source = completeFeatures()[0]!
    const normalized = normalizeAreaFeatures([{ ...source, positions: [...source.positions, source.positions[0]] }])

    expect(normalized[0]?.positions).toHaveLength(4)
  })

  it("blocks airspace heights above the teacher-defined task limit", () => {
    const features = completeFeatures()
    const performance = features.find((item) => item.type === "PERFORMANCE")!
    performance.heightRange = { datum: "AGL", minimumMeters: 30, maximumMeters: 130 }

    const result = checkAreaPlan(features, region(), new Date("2026-08-12T00:00:00.000Z"), 120)

    expect(result.passed).toBe(false)
    expect(result.evidence).toContainEqual(expect.objectContaining({ code: "TASK_HEIGHT_LIMIT_EXCEEDED", blocking: true, featureIds: [performance.id] }))
  })

  it("normalizes persistent WGS84 text annotations", () => {
    expect(normalizeAreaAnnotations([{
      id: "annotation-1",
      label: "应急通道入口",
      position: { longitude: 114.001, latitude: 22.002 },
      heightMeters: 18.4
    }])).toEqual([{
      id: "annotation-1",
      label: "应急通道入口",
      position: { longitude: 114.001, latitude: 22.002 },
      heightMeters: 18.4
    }])
  })

  it("distinguishes containment from generic overlap for teacher review", () => {
    const features = completeFeatures()
    features[0]!.positions = [
      { longitude: 113.992, latitude: 21.992 },
      { longitude: 113.998, latitude: 21.992 },
      { longitude: 113.998, latitude: 21.998 },
      { longitude: 113.992, latitude: 21.998 }
    ]
    features[1]!.positions = [
      { longitude: 113.993, latitude: 21.993 },
      { longitude: 113.994, latitude: 21.993 },
      { longitude: 113.994, latitude: 21.994 },
      { longitude: 113.993, latitude: 21.994 }
    ]

    const relation = checkAreaPlan(features, region()).spatialRelations?.find((item) => item.leftFeatureId === features[0]!.id && item.rightFeatureId === features[1]!.id)

    expect(relation).toMatchObject({ relation: "CONTAINS" })
    expect(relation?.message).toContain("包含")
  })
})
