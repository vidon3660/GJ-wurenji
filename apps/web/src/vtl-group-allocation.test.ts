import { describe, expect, it } from "vitest"
import type { VtlAircraftAssignmentView, VtlGroupView, VtlTaskObjectView, VtlTaskZoneView } from "@wurenji/shared"
import { distributeVtlTasksToGroup, moveVtlTaskInSequence, synchronizeVtlTaskZoneGroups, vtlGroupAllocationSummaries } from "./vtl-group-allocation"

function fixture() {
  const groups: VtlGroupView[] = Array.from({ length: 4 }, (_, groupIndex) => ({
    id: `group-${groupIndex + 1}`,
    code: `G-${String(groupIndex + 1).padStart(2, "0")}`,
    title: `${groupIndex + 1} 组`,
    aircraftIds: Array.from({ length: 5 }, (_, index) => `aircraft-${groupIndex * 5 + index + 1}`),
    taskObjectIds: []
  }))
  const assignments: VtlAircraftAssignmentView[] = Array.from({ length: 20 }, (_, index) => ({
    aircraftId: `aircraft-${index + 1}`,
    aircraftCode: `VTL-${String(index + 1).padStart(2, "0")}`,
    groupId: groups[Math.floor(index / 5)]!.id,
    available: true,
    taskObjectIds: [],
    taskSequence: [],
    estimatedDurationSeconds: 0
  }))
  const taskObjects: VtlTaskObjectView[] = Array.from({ length: 20 }, (_, index) => ({
    id: `task-${index + 1}`,
    code: `T-${String(index + 1).padStart(2, "0")}`,
    title: `任务 ${index + 1}`,
    type: "POINT",
    positions: [{ longitude: 113 + index * 0.001, latitude: 22 }],
    requirement: "巡检",
    completionRule: "覆盖",
    required: true,
    estimatedWorkSeconds: 60 + index * 10,
    status: "UNASSIGNED",
    incompleteReason: null
  }))
  return { groups, assignments, taskObjects }
}

describe("VTL group allocation", () => {
  it("moves an assigned task while preserving a complete unique sequence", () => {
    expect(moveVtlTaskInSequence(["task-1", "task-2", "task-3"], ["task-1", "task-2", "task-2"], "task-3", -2)).toEqual(["task-3", "task-1", "task-2"])
    expect(moveVtlTaskInSequence(["task-1", "task-2"], ["task-1", "task-2"], "task-1", -1)).toEqual(["task-1", "task-2"])
  })

  it("balances selected tasks across available aircraft in a 20-aircraft group", () => {
    const value = fixture()
    value.assignments[0]!.available = false
    const selectedTaskIds = value.taskObjects.slice(0, 8).map((task) => task.id)
    const result = distributeVtlTasksToGroup({ ...value, groupId: "group-1", taskObjectIds: selectedTaskIds })
    const owners = selectedTaskIds.map((taskId) => result.assignments.filter((assignment) => assignment.taskObjectIds.includes(taskId)))
    const groupLoads = result.assignments.filter((assignment) => assignment.groupId === "group-1" && assignment.available).map((assignment) => assignment.estimatedDurationSeconds)

    expect(owners.every((items) => items.length === 1 && items[0]?.groupId === "group-1")).toBe(true)
    expect(result.assignments[0]?.taskObjectIds).toEqual([])
    expect(result.targetAircraftIds).toHaveLength(4)
    expect(Math.max(...groupLoads) - Math.min(...groupLoads)).toBeLessThanOrEqual(Math.max(...value.taskObjects.slice(0, 8).map((task) => task.estimatedWorkSeconds)))
    expect(result.groups[0]?.taskObjectIds).toHaveLength(8)
  })

  it("replaces previous ownership and preserves unrelated task sequence", () => {
    const value = fixture()
    value.assignments[5]!.taskObjectIds = ["task-1", "task-20"]
    value.assignments[5]!.taskSequence = ["task-20", "task-1"]
    value.assignments[5]!.estimatedDurationSeconds = 310
    value.groups[1]!.taskObjectIds = ["task-1", "task-20"]
    const result = distributeVtlTasksToGroup({ ...value, groupId: "group-1", taskObjectIds: ["task-1"] })

    expect(result.assignments[5]).toMatchObject({ taskObjectIds: ["task-20"], taskSequence: ["task-20"], estimatedDurationSeconds: 250 })
    expect(result.assignments.filter((assignment) => assignment.taskObjectIds.includes("task-1"))).toHaveLength(1)
    expect(result.groups[1]?.taskObjectIds).toEqual(["task-20"])
  })

  it("builds group-level aircraft, task and workload statistics", () => {
    const value = fixture()
    value.assignments[0]!.taskObjectIds = ["task-1", "task-2"]
    value.assignments[0]!.estimatedDurationSeconds = 130
    value.assignments[1]!.available = false
    const summaries = vtlGroupAllocationSummaries(value.groups, value.assignments)

    expect(summaries[0]).toMatchObject({ groupId: "group-1", aircraftCount: 5, availableAircraftCount: 4, taskObjectCount: 2, estimatedWorkSeconds: 130 })
  })

  it("splits a shared task zone when only part of it moves to another group", () => {
    const value = fixture()
    value.assignments[5]!.taskObjectIds = ["task-1", "task-2", "task-3"]
    value.assignments[5]!.taskSequence = ["task-1", "task-2", "task-3"]
    value.assignments[5]!.estimatedDurationSeconds = 210
    const distributed = distributeVtlTasksToGroup({ ...value, groupId: "group-1", taskObjectIds: ["task-1"] })
    const taskZones: VtlTaskZoneView[] = [{
      id: "zone-1",
      title: "共享分区",
      boundary: [
        { longitude: 112.9, latitude: 21.9 },
        { longitude: 113.2, latitude: 21.9 },
        { longitude: 113.2, latitude: 22.1 },
        { longitude: 112.9, latitude: 22.1 }
      ],
      groupId: "group-2",
      taskObjectIds: ["task-1", "task-2", "task-3"],
      estimatedWorkSeconds: 210
    }]

    const zones = synchronizeVtlTaskZoneGroups({
      taskZones,
      assignments: distributed.assignments,
      groups: distributed.groups,
      taskObjects: value.taskObjects
    })

    expect(zones).toHaveLength(2)
    expect(zones.find((zone) => zone.groupId === "group-2")).toMatchObject({ id: "zone-1", taskObjectIds: ["task-2", "task-3"], estimatedWorkSeconds: 150 })
    expect(zones.find((zone) => zone.groupId === "group-1")).toMatchObject({ taskObjectIds: ["task-1"], estimatedWorkSeconds: 60 })
    expect(zones[0]?.boundary).not.toBe(taskZones[0]?.boundary)
  })
})
