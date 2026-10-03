import type { ShowDocumentReferencePanel, V3Coordinate, V3FileAssetView } from "@wurenji/shared"

export interface ShowDocumentReferenceCoordinateRow {
  id: string
  label: string
  coordinate: string
}

export function showDocumentReferenceCoordinates(reference: ShowDocumentReferencePanel): ShowDocumentReferenceCoordinateRow[] {
  return [
    ...reference.takeoffPoints.map((coordinate, index) => ({
      id: `takeoff-${index}`,
      label: `起降点 ${index + 1}`,
      coordinate: formatReferenceCoordinate(coordinate)
    })),
    ...reference.airspaceBoundary.map((coordinate, index) => ({
      id: `boundary-${index}`,
      label: `空域边界 ${index + 1}`,
      coordinate: formatReferenceCoordinate(coordinate)
    }))
  ]
}

export function formatReferenceCoordinate(coordinate: V3Coordinate): string {
  return `${coordinate.longitude.toFixed(6)}, ${coordinate.latitude.toFixed(6)}`
}

export function planningMapPreviewPath(asset: V3FileAssetView | null): string | null {
  return asset ? asset.downloadPath.replace(/\/download$/, "/preview") : null
}
