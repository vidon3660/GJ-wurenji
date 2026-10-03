import { describe, expect, it } from "vitest"
import type { LogisticsRouteCheckResult } from "@wurenji/shared"
import { summarizeRequiredLogisticsRouteChecks } from "./logistics-route-check-summary"

describe("STU-011 logistics route check summary", () => {
  it("shows all five required categories before and after a check", () => {
    const pending = summarizeRequiredLogisticsRouteChecks(null)
    const completed = summarizeRequiredLogisticsRouteChecks(resultFixture())

    expect(pending.map((item) => item.title)).toEqual(["空间与障碍", "设备能力", "定位通信", "运行节点", "多航线关系"])
    expect(pending.every((item) => !item.checked && !item.passed && item.evidenceCount === 0)).toBe(true)
    expect(completed.find((item) => item.category === "SPATIAL")).toMatchObject({ checked: true, passed: false, conflictCount: 1 })
    expect(completed.find((item) => item.category === "COVERAGE")).toMatchObject({ checked: true, passed: true, evidenceCount: 0 })
  })

  it("supports historical results without category summaries", () => {
    const completed = summarizeRequiredLogisticsRouteChecks(resultFixture(false))

    expect(completed.find((item) => item.category === "SPATIAL")).toMatchObject({ checked: true, passed: false, evidenceCount: 1 })
    expect(completed.find((item) => item.category === "NODES")).toMatchObject({ checked: true, passed: true, evidenceCount: 0 })
  })
})

function resultFixture(withSummaries = true): LogisticsRouteCheckResult {
  return {
    passed: false,
    checkedAt: "2026-08-14T00:00:00.000Z",
    routeCount: 2,
    selectedDeliveryPointCount: 1,
    conflictCount: 1,
    riskCount: 0,
    infoCount: 0,
    ...(withSummaries ? { categorySummaries: [
      { category: "SPATIAL", checked: true, passed: false, conflictCount: 1, riskCount: 0, infoCount: 0, evidenceCount: 1 },
      { category: "AIRCRAFT", checked: true, passed: true, conflictCount: 0, riskCount: 0, infoCount: 0, evidenceCount: 0 },
      { category: "COVERAGE", checked: true, passed: true, conflictCount: 0, riskCount: 0, infoCount: 0, evidenceCount: 0 },
      { category: "NODES", checked: true, passed: true, conflictCount: 0, riskCount: 0, infoCount: 0, evidenceCount: 0 },
      { category: "ROUTE_RELATION", checked: true, passed: true, conflictCount: 0, riskCount: 0, infoCount: 0, evidenceCount: 0 }
    ] } : {}),
    evidence: [{
      code: "BUILDING_CLEARANCE_CONFLICT",
      category: "SPATIAL",
      severity: "CONFLICT",
      blocking: true,
      message: "净空不足",
      routeIds: ["route-1"],
      waypointIds: [],
      segmentIndexes: [0],
      position: null,
      data: {}
    }]
  }
}
