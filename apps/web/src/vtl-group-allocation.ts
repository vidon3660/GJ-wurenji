import type { VtlAircraftAssignmentView, VtlGroupView, VtlTaskObjectView, VtlTaskZoneView } from "@wurenji/shared"

export interface VtlGroupAllocationSummary {
  groupId: string
  code: string
  title: string
  aircraftCount: number
  availableAircraftCount: number
  taskObjectCount: number
  estimatedWorkSeconds: number
}

export interface VtlGroupDistributionResult {
  assignments: VtlAircraftAssignmentView[]
  groups: VtlGroupView[]
  taskObjectIds: string[]
  targetAircraftIds: string[]
}

export function moveVtlTaskInSequence(
  taskObjectIds: readonly string[],
  taskSequence: readonly string[],
  taskObjectId: string,
  offset: number
): string[] {
  const validTaskIds = new Set(taskObjectIds)
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const id of taskSequence) {
    if (!validTaskIds.has(id) || seen.has(id)) continue
    seen.add(id)
    normalized.push(id)
  }
  for (const id of taskObjectIds) {
    if (seen.has(id)) continue
    seen.add(id)
    normalized.push(id)
  }
  const currentIndex = normalized.indexOf(taskObjectId)
  if (currentIndex < 0 || !Number.isInteger(offset) || offset === 0) return normalized
  const targetIndex = Math.max(0, Math.min(normalized.length - 1, currentIndex + offset))
  if (targetIndex === currentIndex) return normalized
  const next = [...normalized]
  const [taskId] = next.splice(currentIndex, 1)
  if (taskId) next.splice(targetIndex, 0, taskId)
  return next
}

export function vtlGroupAllocationSummaries(
  groups: readonly VtlGroupView[],
  assignments: readonly VtlAircraftAssignmentView[]
): VtlGroupAllocationSummary[] {
  return groups.map((group) => {
    const groupAssignments = assignments.filter((assignment) => assignment.groupId === group.id)
    return {
      groupId: group.id,
      code: group.code,
      title: group.title,
      aircraftCount: groupAssignments.length,
      availableAircraftCount: groupAssignments.filter((assignment) => assignment.available).length,
      taskObjectCount: new Set(groupAssignments.flatMap((assignment) => assignment.taskObjectIds)).size,
      estimatedWorkSeconds: groupAssignments.reduce((sum, assignment) => sum + assignment.estimatedDurationSeconds, 0)
    }
  })
}

export function distributeVtlTasksToGroup(input: {
  groupId: string
  taskObjectIds: readonly string[]
  groups: readonly VtlGroupView[]
  assignments: readonly VtlAircraftAssignmentView[]
  taskObjects: readonly VtlTaskObjectView[]
}): VtlGroupDistributionResult {
  const group = input.groups.find((item) => item.id === input.groupId)
  if (!group) throw new Error("请选择有效机组")
  const taskById = new Map(input.taskObjects.map((task) => [task.id, task]))
  const taskObjectIds = [...new Set(input.taskObjectIds)].filter((taskId) => taskById.has(taskId))
  if (taskObjectIds.length === 0) throw new Error("请至少选择一个任务对象")
  const selectedTaskIds = new Set(taskObjectIds)
  const assignments = input.assignments.map((assignment): VtlAircraftAssignmentView => {
    const nextTaskObjectIds = assignment.taskObjectIds.filter((taskId) => !selectedTaskIds.has(taskId))
    const nextTaskSequence = assignment.taskSequence.filter((taskId) => !selectedTaskIds.has(taskId))
    return {
      ...assignment,
      taskObjectIds: nextTaskObjectIds,
      taskSequence: nextTaskSequence,
      estimatedDurationSeconds: workSeconds(nextTaskObjectIds, taskById)
    }
  })
  const candidates = assignments.filter((assignment) => assignment.groupId === group.id && assignment.available && group.aircraftIds.includes(assignment.aircraftId))
  if (candidates.length === 0) throw new Error(`${group.code} 没有可用航空器`)
  const orderedTasks = taskObjectIds
    .map((taskId) => taskById.get(taskId)!)
    .sort((left, right) => right.estimatedWorkSeconds - left.estimatedWorkSeconds || left.code.localeCompare(right.code))
  const targetAircraftIds = new Set<string>()
  for (const task of orderedTasks) {
    const target = [...candidates].sort((left, right) =>
      left.estimatedDurationSeconds - right.estimatedDurationSeconds
      || left.taskObjectIds.length - right.taskObjectIds.length
      || left.aircraftCode.localeCompare(right.aircraftCode)
    )[0]!
    target.taskObjectIds.push(task.id)
    target.taskSequence.push(task.id)
    target.estimatedDurationSeconds += task.estimatedWorkSeconds
    targetAircraftIds.add(target.aircraftId)
  }
  const groups = input.groups.map((item): VtlGroupView => ({
    ...item,
    aircraftIds: [...item.aircraftIds],
    taskObjectIds: [...new Set(assignments.filter((assignment) => assignment.groupId === item.id).flatMap((assignment) => assignment.taskObjectIds))]
  }))
  return { assignments, groups, taskObjectIds, targetAircraftIds: [...targetAircraftIds] }
}

export function synchronizeVtlTaskZoneGroups(input: {
  taskZones: readonly VtlTaskZoneView[]
  assignments: readonly VtlAircraftAssignmentView[]
  groups: readonly VtlGroupView[]
  taskObjects: readonly VtlTaskObjectView[]
}): VtlTaskZoneView[] {
  const ownerGroupByTaskId = new Map<string, string>()
  for (const assignment of input.assignments) {
    for (const taskObjectId of assignment.taskObjectIds) ownerGroupByTaskId.set(taskObjectId, assignment.groupId)
  }
  const taskById = new Map(input.taskObjects.map((task) => [task.id, task]))
  const groupCodeById = new Map(input.groups.map((group) => [group.id, group.code]))
  const usedZoneIds = new Set(input.taskZones.map((zone) => zone.id))

  return input.taskZones.flatMap((zone) => {
    const tasksByGroup = new Map<string | null, string[]>()
    for (const taskObjectId of zone.taskObjectIds) {
      const groupId = ownerGroupByTaskId.get(taskObjectId) ?? null
      tasksByGroup.set(groupId, [...(tasksByGroup.get(groupId) ?? []), taskObjectId])
    }
    const entries = [...tasksByGroup.entries()].sort(([left], [right]) => {
      if (left === zone.groupId) return -1
      if (right === zone.groupId) return 1
      if (left === null) return 1
      if (right === null) return -1
      return (groupCodeById.get(left) ?? left).localeCompare(groupCodeById.get(right) ?? right)
    })
    if (entries.length === 0) return [{ ...zone, boundary: zone.boundary.map((point) => ({ ...point })), groupId: null, taskObjectIds: [], estimatedWorkSeconds: 0 }]

    return entries.map(([groupId, taskObjectIds], index): VtlTaskZoneView => ({
      ...zone,
      id: index === 0 ? zone.id : uniqueZoneId(zone.id, groupId, usedZoneIds),
      title: index === 0 ? zone.title : `${zone.title} · ${groupId ? groupCodeById.get(groupId) ?? groupId : "未分配"}`,
      boundary: zone.boundary.map((point) => ({ ...point })),
      groupId,
      taskObjectIds,
      estimatedWorkSeconds: workSeconds(taskObjectIds, taskById)
    }))
  })
}

function uniqueZoneId(zoneId: string, groupId: string | null, usedZoneIds: Set<string>): string {
  const suffix = (groupId ?? "unassigned").replace(/[^a-zA-Z0-9_-]/g, "-")
  const base = `${zoneId}-${suffix}`
  let candidate = base
  let sequence = 2
  while (usedZoneIds.has(candidate)) {
    candidate = `${base}-${sequence}`
    sequence += 1
  }
  usedZoneIds.add(candidate)
  return candidate
}

function workSeconds(taskObjectIds: readonly string[], taskById: ReadonlyMap<string, VtlTaskObjectView>): number {
  return taskObjectIds.reduce((sum, taskId) => sum + (taskById.get(taskId)?.estimatedWorkSeconds ?? 0), 0)
}
