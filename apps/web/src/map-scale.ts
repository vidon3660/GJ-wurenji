import {
  Cartesian2,
  Cartographic,
  EllipsoidGeodesic,
  Math as CesiumMath,
  SceneMode,
  type Viewer
} from "cesium"

export interface MapScaleValue {
  distanceMeters: number
  widthPixels: number
  label: string
}

const DEFAULT_SCALE_WIDTH_PX = 148

export function mapScaleValue(viewer: Viewer, requestedWidthPixels = DEFAULT_SCALE_WIDTH_PX): MapScaleValue | null {
  if (viewer.isDestroyed()) return null
  const canvas = viewer.scene.canvas
  const widthPixels = Math.max(90, Math.min(180, requestedWidthPixels))
  const groundDistance = viewer.scene.mode === SceneMode.SCENE2D
    ? distanceFromViewRectangle(viewer)
    : distanceAcrossGround(viewer, widthPixels)
  if (!Number.isFinite(groundDistance) || groundDistance <= 0) return null

  const distanceMeters = niceScaleDistance(groundDistance * widthPixels / Math.max(1, canvas.clientWidth))
  const visibleWidthPixels = Math.max(42, Math.min(widthPixels, distanceMeters / groundDistance * widthPixels))
  return {
    distanceMeters,
    widthPixels: Math.round(visibleWidthPixels),
    label: formatScaleDistance(distanceMeters)
  }
}

export function niceScaleDistance(maximumMeters: number): number {
  if (!Number.isFinite(maximumMeters) || maximumMeters <= 0) return 0
  const exponent = Math.pow(10, Math.floor(Math.log10(maximumMeters)))
  const normalized = maximumMeters / exponent
  const factor = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1
  return factor * exponent
}

export function formatScaleDistance(distanceMeters: number): string {
  if (distanceMeters < 1) return `${distanceMeters.toFixed(1)} m`
  if (distanceMeters >= 1000) {
    const kilometers = distanceMeters / 1000
    return `${kilometers >= 10 ? kilometers.toFixed(0) : kilometers.toFixed(1)} km`
  }
  return `${Math.round(distanceMeters)} m`
}

function distanceAcrossGround(viewer: Viewer, widthPixels: number): number {
  const canvas = viewer.scene.canvas
  const y = canvas.clientHeight * 0.52
  const left = pickGround(viewer, new Cartesian2(Math.max(1, canvas.clientWidth / 2 - widthPixels / 2), y))
  const right = pickGround(viewer, new Cartesian2(Math.min(canvas.clientWidth - 1, canvas.clientWidth / 2 + widthPixels / 2), y))
  if (!left || !right) return distanceFromViewRectangle(viewer)
  return surfaceDistance(left, right) * canvas.clientWidth / widthPixels
}

function pickGround(viewer: Viewer, position: Cartesian2): Cartographic | null {
  const ray = viewer.camera.getPickRay(position)
  const cartesian = ray
    ? viewer.scene.globe.pick(ray, viewer.scene)
    : viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid)
  if (!cartesian) return null
  const cartographic = Cartographic.fromCartesian(cartesian)
  return Number.isFinite(cartographic.longitude) && Number.isFinite(cartographic.latitude)
    ? cartographic
    : null
}

function distanceFromViewRectangle(viewer: Viewer): number {
  const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid)
  if (rectangle) {
    const centerLatitude = (rectangle.south + rectangle.north) / 2
    const distance = surfaceDistance(
      Cartographic.fromRadians(rectangle.west, centerLatitude),
      Cartographic.fromRadians(rectangle.east, centerLatitude)
    )
    if (distance > 0) return distance
  }

  const frustum = viewer.camera.frustum as { left?: number; right?: number; fovy?: number; aspectRatio?: number }
  if (Number.isFinite(frustum.left) && Number.isFinite(frustum.right) && (frustum.right! - frustum.left!) > 0) {
    return frustum.right! - frustum.left!
  }

  const height = viewer.camera.positionCartographic?.height
  if (Number.isFinite(height) && height! > 0 && Number.isFinite(frustum.fovy) && frustum.fovy! > 0) {
    const aspectRatio = Number.isFinite(frustum.aspectRatio) && frustum.aspectRatio! > 0 ? frustum.aspectRatio! : 1
    return height! * 2 * Math.tan(frustum.fovy! / 2) * aspectRatio
  }

  return 0
}

function surfaceDistance(start: Cartographic, end: Cartographic): number {
  const geodesic = new EllipsoidGeodesic(start, end)
  return Number.isFinite(geodesic.surfaceDistance) && geodesic.surfaceDistance > 0
    ? geodesic.surfaceDistance
    : CesiumMath.toDegrees(Math.abs(end.longitude - start.longitude)) * 111_320
}

export const mapScaleDefaults = {
  widthPixels: DEFAULT_SCALE_WIDTH_PX
} as const
