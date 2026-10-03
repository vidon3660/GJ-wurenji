import type { AssignmentTargetClassroomView } from "@wurenji/shared"

export interface AssignmentTargetClassroomSource {
  snapshot: { draft: { id: string } }
  classroom: { id: string; code: string; name: string; course: { name: string } } | null
}

export function collectTargetClassroomsByDraftId(targets: readonly AssignmentTargetClassroomSource[]) {
  const classroomsByDraftId = new Map<string, AssignmentTargetClassroomView[]>()
  for (const target of targets) {
    if (!target.classroom) continue
    const draftId = target.snapshot.draft.id
    const classrooms = classroomsByDraftId.get(draftId) ?? []
    if (!classrooms.some((item) => item.id === target.classroom!.id)) {
      classrooms.push({
        id: target.classroom.id,
        code: target.classroom.code,
        name: target.classroom.name,
        courseName: target.classroom.course.name
      })
    }
    classroomsByDraftId.set(draftId, classrooms)
  }
  return classroomsByDraftId
}
