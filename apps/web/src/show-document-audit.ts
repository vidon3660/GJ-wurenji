import type { ShowProjectDocumentView } from "@wurenji/shared"

export interface ShowDocumentAuditEntry {
  id: string
  type: "SUBMISSION" | "VIEWED" | "RETURNED" | "COMMENTED"
  versionNo: number
  title: string
  actor: string
  occurredAt: string
  comment: string | null
}

export function showDocumentAuditTimeline(document: ShowProjectDocumentView): ShowDocumentAuditEntry[] {
  const submissions = document.versions
    .filter((version) => version.kind === "SUBMISSION")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((version, index) => ({
      id: `submission-${version.id}`,
      type: "SUBMISSION" as const,
      versionNo: version.versionNo,
      title: index === 0 ? "学生提交" : "学生重新提交",
      actor: version.createdBy,
      occurredAt: version.createdAt,
      comment: null
    }))
  const reviews = document.reviews.map((review) => ({
    id: `review-${review.id}`,
    type: review.action,
    versionNo: review.versionNo,
    title: reviewTitle(review.action),
    actor: review.reviewedBy,
    occurredAt: review.createdAt,
    comment: review.comment.trim() || null
  }))
  return [...submissions, ...reviews].sort((left, right) => {
    const timeDifference = Date.parse(right.occurredAt) - Date.parse(left.occurredAt)
    return timeDifference || right.id.localeCompare(left.id)
  })
}

function reviewTitle(action: ShowProjectDocumentView["reviews"][number]["action"]): string {
  if (action === "RETURNED") return "教师退回修改"
  if (action === "COMMENTED") return "教师补充批注"
  return "教师记录查看"
}
