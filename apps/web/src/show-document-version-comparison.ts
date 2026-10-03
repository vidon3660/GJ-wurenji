import type { ShowDocumentReviewView, ShowDocumentVersionView, ShowProjectDocumentView } from "@wurenji/shared"

export interface ShowDocumentVersionComparison {
  baseline: ShowDocumentVersionView
  target: ShowDocumentVersionView
  sameContent: boolean
  sizeDeltaBytes: number
  baselineReviews: ShowDocumentReviewView[]
  targetReviews: ShowDocumentReviewView[]
}

export function compareShowDocumentVersions(
  document: ShowProjectDocumentView,
  baselineVersionId: string,
  targetVersionId: string
): ShowDocumentVersionComparison | null {
  const baseline = document.versions.find((version) => version.id === baselineVersionId)
  const target = document.versions.find((version) => version.id === targetVersionId)
  if (!baseline || !target || baseline.id === target.id) return null
  return {
    baseline,
    target,
    sameContent: baseline.asset.sha256 === target.asset.sha256,
    sizeDeltaBytes: target.asset.sizeBytes - baseline.asset.sizeBytes,
    baselineReviews: reviewsForVersion(document, baseline.versionNo),
    targetReviews: reviewsForVersion(document, target.versionNo)
  }
}

export function showDocumentSubmissionLabel(document: ShowProjectDocumentView, versionNo: number): string {
  const submissionVersions = document.versions
    .filter((version) => version.kind === "SUBMISSION")
    .sort((left, right) => left.versionNo - right.versionNo)
  const submissionIndex = submissionVersions.findIndex((version) => version.versionNo === versionNo)
  if (submissionIndex < 0) return `V${versionNo}`
  return submissionIndex === 0 ? "首次提交" : `第 ${submissionIndex + 1} 次提交`
}

function reviewsForVersion(document: ShowProjectDocumentView, versionNo: number): ShowDocumentReviewView[] {
  return document.reviews
    .filter((review) => review.versionNo === versionNo)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}
