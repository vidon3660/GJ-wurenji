import { describe, expect, it } from "vitest"
import type { ShowRuntimeEventView, ShowRuntimeGroupView } from "@wurenji/shared"
import { buildShowRuntimeSchedule } from "./show-runtime-schedule"

const group = (groupId: string): ShowRuntimeGroupView => ({
  groupId,
  label: `编队 ${groupId}`,
  plannedCount: 10,
  airborneCount: 10,
  landedCount: 0,
  normalCount: 10,
  warningCount: 0,
  abnormalCount: 0,
  lostCount: 0,
  status: "AIRBORNE",
  center: { longitude: 120, latitude: 30, altitudeMeters: 0 },
  radiusMeters: 20
})

const event = (id: string, time: number, affectedGroupIds: string[], title = id): ShowRuntimeEventView => ({
  id,
  projectId: "project-1",
  sessionId: "session-1",
  stageCode: "SHOW_RUNTIME",
  code: id,
  category: "WEATHER",
  status: "SCHEDULED",
  severity: "INFO",
  lifecycleStatus: "SCHEDULED",
  title,
  detail: title,
  affectedCount: 10,
  affectedGroupIds,
  recommendedActions: [],
  detectedSimulationTimeMs: null,
  controlledSimulationTimeMs: null,
  scheduledSimulationTimeMs: time,
  triggeredSimulationTimeMs: null,
  resolvedSimulationTimeMs: null,
  triggeredAt: null,
  resolvedAt: null,
  payload: {},
  correlationId: `correlation-${id}`
})

describe("show runtime schedule", () => {
  it("orders groups and derives current and next events from real schedule times", () => {
    const rows = buildShowRuntimeSchedule(
      [group("G10"), group("G02")],
      [event("landing", 20_000, ["G02"], "G02 降落"), event("formation", 40_000, ["G02"], "G02 变阵")],
      25_000
    )

    expect(rows.map((row) => row.groupId)).toEqual(["G02", "G10"])
    expect(rows[0]).toMatchObject({ currentEventTitle: "G02 降落", currentEventTimeMs: 20_000, nextEventTitle: "G02 变阵", nextEventTimeMs: 40_000 })
  })

  it("keeps missing plan data explicit instead of inventing a time", () => {
    const row = buildShowRuntimeSchedule([group("G01")], [event("global", 10_000, [], "全局事件")], 0)[0]

    expect(row).toMatchObject({ currentEventTitle: null, currentEventTimeMs: null, nextEventTitle: null, nextEventTimeMs: null })
  })
})
