import type { ShowReviewWorkspaceView } from "@wurenji/shared"

export type LogisticsReviewSnapshotSource = {
  mapResourceVersion: string
  sceneResourceVersion: string
  planVersion: string
  config: { scenarioOverlayVersionId?: string | null }
}

export function serializeLogisticsReviewSnapshotFields(snapshot: LogisticsReviewSnapshotSource): Pick<ShowReviewWorkspaceView, "mapResourceVersion" | "sceneResourceVersion" | "planVersion" | "scenarioOverlayVersionId"> {
  return {
    mapResourceVersion: snapshot.mapResourceVersion,
    sceneResourceVersion: snapshot.sceneResourceVersion,
    planVersion: snapshot.planVersion,
    scenarioOverlayVersionId: snapshot.config.scenarioOverlayVersionId ?? null
  }
}
