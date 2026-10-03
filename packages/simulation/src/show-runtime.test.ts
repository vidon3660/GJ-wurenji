import { describe, expect, it } from "vitest"
import {
  computeShowRuntimeProjection,
  showRuntimeActionsFor,
  showRuntimePhaseAt,
  showRuntimeTimeline
} from "./show-runtime.js"

const config = {
  totalAircraft: 5000,
  groupCount: 50,
  durationMs: 600_000,
  maximumHeightMeters: 120,
  performanceCenter: { longitude: 114.0579, latitude: 22.5431 },
  performanceRadiusMeters: 260
}

describe("show runtime aggregate engine", () => {
  it.each([100, 500, 1000, 3000])("preserves aircraft conservation at the V1.0 %s-aircraft scale", (totalAircraft) => {
    const scaleConfig = { ...config, totalAircraft, groupCount: Math.min(10, totalAircraft) }
    for (const simulationTimeMs of [0, 120_000, 300_000, 600_000]) {
      const projection = computeShowRuntimeProjection(scaleConfig, simulationTimeMs, {
        aborted: false,
        earlyLandedCount: Math.floor(totalAircraft / 10),
        takeoffLimitCount: null,
        eventImpacts: []
      })
      expect(projection.totals.plannedCount).toBe(totalAircraft)
      expect(projection.groups.reduce((sum, group) => sum + group.plannedCount, 0)).toBe(totalAircraft)
      expect(projection.totals.airborneCount + projection.totals.landedCount).toBe(projection.totals.takeoffCount)
      expect(projection.groups.reduce((sum, group) => sum + group.airborneCount, 0)).toBe(projection.totals.airborneCount)
      expect(projection.groups.reduce((sum, group) => sum + group.landedCount, 0)).toBe(projection.totals.landedCount)
    }
  })

  it("advances through the fixed program deterministically", () => {
    const timeline = showRuntimeTimeline(config.durationMs)
    expect(timeline.map((item) => item.phase)).toEqual([
      "TAKEOFF_PREPARATION",
      "BATCH_TAKEOFF",
      "TRANSIT_TO_SHOW",
      "PERFORMANCE",
      "RETURN_TO_LAUNCH",
      "BATCH_LANDING"
    ])
    expect(showRuntimePhaseAt(config.durationMs, 0)).toBe("TAKEOFF_PREPARATION")
    expect(showRuntimePhaseAt(config.durationMs, config.durationMs)).toBe("COMPLETED")
    expect(showRuntimePhaseAt(config.durationMs, 100, true)).toBe("ABORTED")
  })

  it("projects 5000 aircraft as bounded group aggregates", () => {
    const first = computeShowRuntimeProjection(config, 300_000, {
      aborted: false,
      earlyLandedCount: 0,
      takeoffLimitCount: null,
      eventImpacts: [{
        category: "COMMUNICATION_CONTROL",
        severity: "ERROR",
        affectedCount: 80,
        affectedGroupIds: ["G01"]
      }]
    })
    const second = computeShowRuntimeProjection(config, 300_000, {
      aborted: false,
      earlyLandedCount: 0,
      takeoffLimitCount: null,
      eventImpacts: [{
        category: "COMMUNICATION_CONTROL",
        severity: "ERROR",
        affectedCount: 80,
        affectedGroupIds: ["G01"]
      }]
    })
    expect(first).toEqual(second)
    expect(first.groups).toHaveLength(50)
    expect(first.groups.reduce((sum, group) => sum + group.plannedCount, 0)).toBe(5000)
    expect(first.totals.lostCount).toBe(80)
    expect(first.groups[0]).toMatchObject({ groupId: "G01", lostCount: 80, status: "LOST" })
  })

  it("opens scale-specific response actions", () => {
    const small = showRuntimeActionsFor(100, "RUNNING")
    const limitedGroup = showRuntimeActionsFor(500, "RUNNING")
    const large = showRuntimeActionsFor(3000, "RUNNING")
    expect(small.find((item) => item.code === "SINGLE_LAND")?.enabled).toBe(true)
    expect(small.find((item) => item.code === "SINGLE_LAND")?.requiresTarget).toBe(true)
    expect(small.find((item) => item.code === "GROUP_RETURN")?.enabled).toBe(false)
    expect(small.find((item) => item.code === "RETURN_ALL")?.enabled).toBe(true)
    expect(small.find((item) => item.code === "EMERGENCY_LAND_ALL")?.enabled).toBe(true)
    expect(limitedGroup.find((item) => item.code === "GROUP_RETURN")?.enabled).toBe(true)
    expect(large.find((item) => item.code === "GROUP_RETURN")?.enabled).toBe(true)
    expect(large.find((item) => item.code === "RETURN_ALL")?.enabled).toBe(true)
  })

  it("projects targeted group recovery and return state without reallocating another group", () => {
    const projection = computeShowRuntimeProjection(config, 300_000, {
      aborted: false,
      earlyLandedCount: 100,
      takeoffLimitCount: null,
      eventImpacts: [],
      groupRecoveryCounts: { G03: 100 },
      groupStatusOverrides: { G02: "RETURNING", G03: "LANDED" }
    })
    expect(projection.totals).toMatchObject({ takeoffCount: 5000, airborneCount: 4900, landedCount: 100 })
    expect(projection.groups[0]).toMatchObject({ groupId: "G01", airborneCount: 100, landedCount: 0 })
    expect(projection.groups[1]).toMatchObject({ groupId: "G02", status: "RETURNING", airborneCount: 100, landedCount: 0 })
    expect(projection.groups[2]).toMatchObject({ groupId: "G03", status: "LANDED", airborneCount: 0, landedCount: 100 })
  })

  it("keeps the program active when one group has a local abnormality or returns early", () => {
    const projection = computeShowRuntimeProjection(config, 300_000, {
      aborted: false,
      earlyLandedCount: 100,
      takeoffLimitCount: null,
      eventImpacts: [{
        category: "COMMUNICATION_CONTROL",
        severity: "ERROR",
        affectedCount: 40,
        affectedGroupIds: ["G01"]
      }],
      groupRecoveryCounts: { G02: 100 },
      groupStatusOverrides: { G02: "LANDED" }
    })

    expect(projection.phase).toBe("PERFORMANCE")
    expect(projection.totals.takeoffCount).toBe(5000)
    expect(projection.totals.airborneCount + projection.totals.landedCount).toBe(projection.totals.takeoffCount)
    expect(projection.groups[0]).toMatchObject({ groupId: "G01", lostCount: 40, status: "LOST" })
    expect(projection.groups[1]).toMatchObject({ groupId: "G02", landedCount: 100, status: "LANDED" })
  })

  it("uses an imported choreography track for the runtime group center", () => {
    const projection = computeShowRuntimeProjection({
      ...config,
      totalAircraft: 100,
      groupCount: 1,
      durationMs: 10_000,
      programTracks: [{ groupId: "G01", points: [
        { timeMs: 0, eastMeters: 0, northMeters: 0, upMeters: 0 },
        { timeMs: 10_000, eastMeters: 111.32, northMeters: 55.66, upMeters: 40 }
      ] }]
    }, 5_000, {
      aborted: false,
      earlyLandedCount: 0,
      takeoffLimitCount: null,
      eventImpacts: []
    })

    const expectedLongitudeOffset = 55.66 / (111_320 * Math.cos(config.performanceCenter.latitude * Math.PI / 180))
    expect(projection.groups[0]?.center.longitude).toBeCloseTo(config.performanceCenter.longitude + expectedLongitudeOffset, 6)
    expect(projection.groups[0]?.center.latitude).toBeCloseTo(config.performanceCenter.latitude + 0.00025, 5)
    expect(projection.groups[0]?.center.altitudeMeters).toBeCloseTo(20, 5)
  })

  it("starts from frozen teacher conditions and lets runtime events worsen them", () => {
    const initialEnvironment = {
      windDirection: "NW",
      windForceState: "NEAR_LIMIT",
      gustState: "OCCASIONAL",
      rainState: "BELOW_LIMIT",
      positioningElectromagneticState: "LOCAL_ABNORMAL",
      communicationControlState: "DELAY",
      deviceState: "BATTERY_ABNORMAL",
      deviceImpactScope: "SMALL_BATCH",
      deviceAffectedCount: 100
    } as const
    const initial = computeShowRuntimeProjection({ ...config, initialEnvironment }, 300_000, {
      aborted: false,
      earlyLandedCount: 0,
      takeoffLimitCount: null,
      eventImpacts: []
    })
    expect(initial.environment).toMatchObject({
      windDirection: "NW",
      windState: "NEAR_LIMIT",
      gustState: "OCCASIONAL",
      rainState: "BELOW_LIMIT",
      positioningQuality: "DEGRADED",
      electromagneticState: "INTERFERENCE",
      communicationQuality: "DEGRADED",
      equipmentState: "WARNING"
    })
    expect(initial.totals).toMatchObject({ warningCount: 100, abnormalCount: 0, lostCount: 0 })
    expect(initial.groups[0]).toMatchObject({ warningCount: 100, status: "WARNING" })
    expect(initial.groups.reduce((sum, group) => sum + group.warningCount, 0)).toBe(initial.totals.warningCount)

    const worsened = computeShowRuntimeProjection({ ...config, initialEnvironment }, 300_000, {
      aborted: false,
      earlyLandedCount: 0,
      takeoffLimitCount: null,
      eventImpacts: [
        { category: "WEATHER", severity: "CRITICAL", affectedCount: 100, affectedGroupIds: ["G01"] },
        { category: "COMMUNICATION_CONTROL", severity: "ERROR", affectedCount: 100, affectedGroupIds: ["G01"] }
      ]
    })
    expect(worsened.environment).toMatchObject({ windState: "OVER_LIMIT", gustState: "CONTINUOUS", rainState: "OVER_LIMIT", communicationQuality: "LOST" })
    expect(worsened.totals).toMatchObject({ warningCount: 0, abnormalCount: 0, lostCount: 100 })
  })

  it("caps initial device impact to airborne aircraft and maps severe faults to abnormal", () => {
    const initialEnvironment = {
      windDirection: "SE",
      windForceState: "NORMAL",
      gustState: "NONE",
      rainState: "NONE",
      positioningElectromagneticState: "NORMAL",
      communicationControlState: "NORMAL",
      deviceState: "POWER_SYSTEM_ABNORMAL",
      deviceImpactScope: "GROUP",
      deviceAffectedCount: 100
    } as const
    const beforeTakeoff = computeShowRuntimeProjection({ ...config, initialEnvironment }, 0, {
      aborted: false,
      earlyLandedCount: 0,
      takeoffLimitCount: null,
      eventImpacts: []
    })
    expect(beforeTakeoff.totals).toMatchObject({ airborneCount: 0, abnormalCount: 0 })

    const airborne = computeShowRuntimeProjection({ ...config, initialEnvironment }, 300_000, {
      aborted: false,
      earlyLandedCount: 0,
      takeoffLimitCount: null,
      eventImpacts: []
    })
    expect(airborne.totals).toMatchObject({ abnormalCount: 100, warningCount: 0, lostCount: 0 })
    expect(airborne.groups[0]).toMatchObject({ abnormalCount: 100, status: "ABNORMAL" })
    expect(airborne.groups.reduce((sum, group) => sum + group.abnormalCount, 0)).toBe(airborne.totals.abnormalCount)
  })
})
