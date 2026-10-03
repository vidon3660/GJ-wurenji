import type { SceneType, V3RegionCatalogItem, V3ScenarioOverlayVersionView } from "@wurenji/shared"

export function publishedScenarioOverlayVersions(
  versions: readonly V3ScenarioOverlayVersionView[],
  sceneType: SceneType,
  regionPackageId: string
): V3ScenarioOverlayVersionView[] {
  return versions
    .filter((version) => version.status === "PUBLISHED" && version.sceneType === sceneType && version.regionPackageId === regionPackageId)
    .sort((left, right) => right.versionNo - left.versionNo || right.updatedAt.localeCompare(left.updatedAt))
}

export function scenarioOverlayResourceVersion(version: V3ScenarioOverlayVersionView | null | undefined): string {
  return version ? `SCENARIO_OVERLAY:${version.id}@${version.versionNo}#${version.checksum}` : "UNRESOLVED"
}

export function mapResourceVersion(region: V3RegionCatalogItem | null | undefined): string {
  return region?.mapResourceVersion?.trim() || "UNRESOLVED"
}

export function assignmentPlanVersion(draftId: string | undefined, revision: number | undefined, configHash: string | undefined): string {
  if (!draftId || !Number.isSafeInteger(revision) || !configHash) return "发布后由服务端冻结"
  return `assignment:${draftId}@${revision}#${configHash}`
}
