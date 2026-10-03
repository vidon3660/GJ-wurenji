import { describe, expect, it } from "vitest"
import type { ShowProjectDocumentView } from "@wurenji/shared"
import { showDocumentAuditTimeline } from "./show-document-audit"

describe("show document audit timeline", () => {
  it("connects reviews to immutable submissions and labels resubmission", () => {
    const timeline = showDocumentAuditTimeline(documentFixture())

    expect(timeline.map((entry) => [entry.title, entry.versionNo])).toEqual([
      ["学生重新提交", 4],
      ["教师退回修改", 2],
      ["教师记录查看", 2],
      ["学生提交", 2]
    ])
    expect(timeline[1]).toMatchObject({ actor: "王老师", comment: "请补充应急联系人" })
  })

  it("excludes editable drafts from the review trail", () => {
    const timeline = showDocumentAuditTimeline(documentFixture())

    expect(timeline.some((entry) => entry.versionNo === 3)).toBe(false)
  })
})

function documentFixture(): ShowProjectDocumentView {
  const asset = {
    id: "asset-1",
    category: "DOCUMENT" as const,
    originalName: "申请表.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 128,
    sha256: "a".repeat(64),
    downloadPath: "/api/files/asset-1/download",
    createdAt: "2026-08-14T08:00:00.000Z"
  }
  return {
    id: "document-1",
    templateCode: "AIRSPACE_APPLICATION_FORM",
    title: "无人机临时飞行空域申请表",
    filename: "申请表.docx",
    status: "RESUBMITTED",
    revision: 6,
    currentVersionNo: 4,
    currentAsset: asset,
    lastSavedAt: "2026-08-14T08:30:00.000Z",
    submittedAt: "2026-08-14T08:00:00.000Z",
    viewedAt: "2026-08-14T08:05:00.000Z",
    returnedAt: "2026-08-14T08:10:00.000Z",
    resubmittedAt: "2026-08-14T08:30:00.000Z",
    reviewComment: "请补充应急联系人",
    reviewScore: 80,
    canReturn: true,
    returnBlockedReason: null,
    versions: [
      { id: "version-4", versionNo: 4, kind: "SUBMISSION", asset, createdBy: "张同学", createdAt: "2026-08-14T08:30:00.000Z" },
      { id: "version-3", versionNo: 3, kind: "MANUAL_SAVE", asset, createdBy: "张同学", createdAt: "2026-08-14T08:20:00.000Z" },
      { id: "version-2", versionNo: 2, kind: "SUBMISSION", asset, createdBy: "张同学", createdAt: "2026-08-14T08:00:00.000Z" }
    ],
    reviews: [
      { id: "review-2", versionNo: 2, action: "RETURNED", comment: "请补充应急联系人", score: 80, reviewedBy: "王老师", createdAt: "2026-08-14T08:10:00.000Z" },
      { id: "review-1", versionNo: 2, action: "VIEWED", comment: "已查看材料", score: 88, reviewedBy: "王老师", createdAt: "2026-08-14T08:05:00.000Z" }
    ]
  }
}
