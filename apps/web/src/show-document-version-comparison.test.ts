import { describe, expect, it } from "vitest"
import type { ShowProjectDocumentView, V3FileAssetView } from "@wurenji/shared"
import { compareShowDocumentVersions, showDocumentSubmissionLabel } from "./show-document-version-comparison"

describe("show document version comparison", () => {
  it("compares immutable file evidence and associates reviews with each submission", () => {
    const document = documentFixture()
    const comparison = compareShowDocumentVersions(document, "version-2", "version-4")

    expect(comparison).toMatchObject({ sameContent: false, sizeDeltaBytes: 256 })
    expect(comparison?.baselineReviews.map((review) => review.action)).toEqual(["RETURNED", "VIEWED"])
    expect(comparison?.targetReviews).toEqual([])
    expect(showDocumentSubmissionLabel(document, 2)).toBe("首次提交")
    expect(showDocumentSubmissionLabel(document, 4)).toBe("第 2 次提交")
  })

  it("does not compare a version with itself", () => {
    expect(compareShowDocumentVersions(documentFixture(), "version-4", "version-4")).toBeNull()
  })
})

function documentFixture(): ShowProjectDocumentView {
  const firstAsset = asset("asset-2", 512, "a")
  const secondAsset = asset("asset-4", 768, "b")
  return {
    id: "document-1",
    templateCode: "AIRSPACE_APPLICATION_FORM",
    title: "无人机临时飞行空域申请表",
    filename: "申请表.docx",
    status: "RESUBMITTED",
    revision: 6,
    currentVersionNo: 4,
    currentAsset: secondAsset,
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
      { id: "version-4", versionNo: 4, kind: "SUBMISSION", asset: secondAsset, createdBy: "张同学", createdAt: "2026-08-14T08:30:00.000Z" },
      { id: "version-2", versionNo: 2, kind: "SUBMISSION", asset: firstAsset, createdBy: "张同学", createdAt: "2026-08-14T08:00:00.000Z" }
    ],
    reviews: [
      { id: "review-return", versionNo: 2, action: "RETURNED", comment: "请补充应急联系人", score: 80, reviewedBy: "王老师", createdAt: "2026-08-14T08:10:00.000Z" },
      { id: "review-view", versionNo: 2, action: "VIEWED", comment: "已查看", score: 88, reviewedBy: "王老师", createdAt: "2026-08-14T08:05:00.000Z" }
    ]
  }
}

function asset(id: string, sizeBytes: number, hashCharacter: string): V3FileAssetView {
  return {
    id,
    category: "DOCUMENT",
    originalName: "申请表.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes,
    sha256: hashCharacter.repeat(64),
    createdAt: "2026-08-14T08:00:00.000Z",
    downloadPath: `/api/files/${id}/download`
  }
}
