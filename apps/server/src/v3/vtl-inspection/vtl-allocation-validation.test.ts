import { describe, expect, it } from "vitest"
import type { V3Coordinate, VtlAircraftAssignmentView, VtlGroupView, VtlTaskObjectView, VtlTaskZoneView } from "@wurenji/shared"
import { isSimplePolygon, pointsStayInsidePolygon, polygonStaysInsidePolygon, validateVtlAllocationGeometry } from "./vtl-allocation-validation.js"

const regionBoundary: V3Coordinate[] = [
  { longitude: 0, latitude: 0 },
  { longitude: 10, latitude: 0 },
  { longitude: 10, latitude: 10 },
  { longitude: 0, latitude: 10 }
]

function taskObject(overrides: Partial<VtlTaskObjectView> = {}): VtlTaskObjectView {
  return {
    id: "task-1",
    code: "T-01",
    title: "巡检对象 01",
    type: "POINT",
    positions: [{ longitude: 5, latitude: 5 }],
    requirement: "完成检查",
    completionRule: "进入任务范围",
    required: true,
    estimatedWorkSeconds: 90,
    status: "UNASSIGNED",
    incompleteReason: null,
    ...overrides
  }
}

function zone(overrides: Partial<VtlTaskZoneView> = {}): VtlTaskZoneView {
  return {
    id: "zone-1",
    title: "任务分区 01",
    boundary: [
      { longitude: 2, latitude: 2 },
      { longitude: 8, latitude: 2 },
      { longitude: 8, latitude: 8 },
      { longitude: 2, latitude: 8 }
    ],
    groupId: "group-1",
    taskObjectIds: ["task-1"],
    estimatedWorkSeconds: 90,
    ...overrides
  }
}

const groups: VtlGroupView[] = [{ id: "group-1", code: "G-01", title: "巡检 1 组", aircraftIds: ["aircraft-1"], taskObjectIds: ["task-1"] }]
const assignments: VtlAircraftAssignmentView[] = [{
  aircraftId: "aircraft-1",
  aircraftCode: "VTL-01",
  groupId: "group-1",
  available: true,
  taskObjectIds: ["task-1"],
  taskSequence: ["task-1"],
  estimatedDurationSeconds: 90
}]

function validate(task: VtlTaskObjectView = taskObject(), taskZones: VtlTaskZoneView[] = [zone()], assignmentList = assignments, groupList = groups) {
  return validateVtlAllocationGeometry({ taskObjects: [task], taskZones, assignments: assignmentList, groups: groupList, regionBoundary })
}

describe("validateVtlAllocationGeometry", () => {
  it("accepts an in-region task and matching group zone", () => {
    expect(validate()).toEqual([])
  })

  it("rejects a task outside its zone", () => {
    const issues = validate(taskObject({ positions: [{ longitude: 9, latitude: 9 }] }))
    expect(issues.some((issue) => issue.code === "OUTSIDE_AREA" && issue.taskObjectId === "task-1")).toBe(true)
  })

  it("rejects a zone that crosses the region boundary", () => {
    const issues = validate(taskObject({ positions: [{ longitude: 1, latitude: 1 }] }), [zone({ boundary: [
      { longitude: -1, latitude: 2 },
      { longitude: 8, latitude: 2 },
      { longitude: 8, latitude: 8 },
      { longitude: -1, latitude: 8 }
    ] })])
    expect(issues.some((issue) => issue.code === "OUTSIDE_AREA" && issue.taskObjectId === null)).toBe(true)
  })

  it("rejects duplicate task zones", () => {
    const issues = validate(taskObject(), [zone(), zone({ id: "zone-2", title: "任务分区 02" })])
    expect(issues.some((issue) => issue.code === "DUPLICATE" && issue.taskObjectId === "task-1")).toBe(true)
  })

  it("rejects a zone assigned to a different group", () => {
    const issues = validate(taskObject(), [zone({ groupId: "group-2" })])
    expect(issues.some((issue) => issue.code === "ORDER_INVALID" && issue.taskObjectId === "task-1")).toBe(true)
  })

  it("rejects self-intersecting and zero-area polygons", () => {
    expect(isSimplePolygon([
      { longitude: 0, latitude: 0 },
      { longitude: 2, latitude: 2 },
      { longitude: 0, latitude: 2 },
      { longitude: 2, latitude: 0 }
    ])).toBe(false)
    expect(isSimplePolygon([
      { longitude: 0, latitude: 0 },
      { longitude: 1, latitude: 0 },
      { longitude: 2, latitude: 0 }
    ])).toBe(false)
  })

  it("requires custom task areas and task objects to stay inside the region", () => {
    const inner = [
      { longitude: 1, latitude: 1 },
      { longitude: 9, latitude: 1 },
      { longitude: 9, latitude: 9 },
      { longitude: 1, latitude: 9 }
    ]
    expect(polygonStaysInsidePolygon(inner, regionBoundary)).toBe(true)
    expect(pointsStayInsidePolygon([{ longitude: 5, latitude: 5 }, { longitude: 8, latitude: 8 }], inner)).toBe(true)
    expect(polygonStaysInsidePolygon([
      { longitude: -1, latitude: 1 },
      { longitude: 9, latitude: 1 },
      { longitude: 9, latitude: 9 },
      { longitude: -1, latitude: 9 }
    ], regionBoundary)).toBe(false)
  })
})
