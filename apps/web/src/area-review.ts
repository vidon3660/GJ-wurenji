import type { ShowAreaCheckResult, ShowAreaFeatureView, ShowAreaPlanVersionView } from "@wurenji/shared"

export function preferredAreaReviewVersion(versions: readonly ShowAreaPlanVersionView[]): ShowAreaPlanVersionView | null {
  return versions.find((version) => version.status === "SUBMITTED")
    ?? versions.find((version) => version.status === "ACCEPTED")
    ?? versions.find((version) => version.status === "RETURNED")
    ?? versions[0]
    ?? null
}

export function areaFeatureCoordinateRows(feature: ShowAreaFeatureView): string[] {
  return feature.positions.map((point, index) => `${String(index + 1).padStart(2, "0")} · ${point.longitude.toFixed(7)}, ${point.latitude.toFixed(7)}`)
}

export function areaSpatialRelationRows(result: ShowAreaCheckResult | null, features: readonly ShowAreaFeatureView[]): Array<{ key: string; severity: string; label: string }> {
  const featureNames = new Map(features.map((feature) => [feature.id, feature.label]))
  if (result?.spatialRelations?.length) {
    return result.spatialRelations.map((relation) => ({
      key: `${relation.leftFeatureId}:${relation.rightFeatureId}`,
      severity: relation.relation === "DISJOINT" ? "INFO" : "ATTENTION",
      label: relation.message
    }))
  }
  return (result?.evidence ?? [])
    .filter((item) => item.featureIds.length >= 2)
    .map((item) => ({
      key: `${item.code}:${item.featureIds.join(":")}`,
      severity: item.severity,
      label: `${item.message}（${item.featureIds.map((id) => featureNames.get(id) ?? id).join(" / ")}）`
    }))
}
