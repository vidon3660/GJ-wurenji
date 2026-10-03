import type { V3Coordinate, V3RegionCatalogItem } from "@wurenji/shared"
import {
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  Cartographic,
  HeadingPitchRange,
  Math as CesiumMath,
  PolygonHierarchy,
  Rectangle,
  SceneMode,
  type Viewer
} from "cesium"

export interface V3RegionBounds {
  west: number
  south: number
  east: number
  north: number
}

export interface V3CameraDiagnostics {
  longitude: number
  latitude: number
  heightMeters: number
  headingRadians: number
  pitchRadians: number
  groundLongitude: number | null
  groundLatitude: number | null
  groundRangeMeters: number | null
}

/** Camera state captured before a Cesium projection morph. */
export interface V3CameraTransitionSnapshot {
  center: Pick<V3Coordinate, "longitude" | "latitude">
  metersPerPixel: number
  viewWidthMeters: number
  rangeMeters: number | null
  headingRadians: number
  pitchRadians: number
  viewportWidthPixels: number
  sourceMode: "2d" | "3d"
}

interface V3RotationState {
  mode: "2d" | "3d"
  target: Cartesian3
  range: number
  pitch: number
  requestedHeading: number
}

const rotationStates = new WeakMap<Viewer, V3RotationState>()
const DEFAULT_TWO_DIMENSIONAL_SCALE_METERS = 200
const SCALE_BAR_REFERENCE_WIDTH_PIXELS = 148
const TWO_DIMENSIONAL_MINIMUM_ZOOM_DISTANCE = 1

export function normalizeHeadingRadians(heading: number): number {
  if (!Number.isFinite(heading)) return 0
  const fullTurn = CesiumMath.TWO_PI
  const normalized = heading % fullTurn
  return normalized < 0 ? normalized + fullTurn : normalized
}

export function regionBounds(region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined): V3RegionBounds | null {
  const points = region?.boundary ?? []
  if (points.length === 0) return null
  const validPoints = points.filter(isValidCoordinate)
  if (validPoints.length < 3) return null
  return {
    west: Math.min(...validPoints.map((point) => point.longitude)),
    south: Math.max(-90, Math.min(...validPoints.map((point) => point.latitude))),
    east: Math.max(...validPoints.map((point) => point.longitude)),
    north: Math.min(90, Math.max(...validPoints.map((point) => point.latitude)))
  }
}

export function regionRectangle(
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  paddingRatio = 0
): Rectangle | null {
  const bounds = regionBounds(region)
  if (!bounds) return null
  const longitudePadding = Math.max(0, bounds.east - bounds.west) * Math.max(0, paddingRatio)
  const latitudePadding = Math.max(0, bounds.north - bounds.south) * Math.max(0, paddingRatio)
  let west = Math.max(-180, bounds.west - longitudePadding)
  let south = Math.max(-90, bounds.south - latitudePadding)
  let east = Math.min(180, bounds.east + longitudePadding)
  let north = Math.min(90, bounds.north + latitudePadding)
  // Cesium rejects zero-width/zero-height rectangles. This can happen with
  // imported regions whose three boundary points share one longitude or
  // latitude, so keep a small valid span even before any camera operation.
  if (!(east > west)) {
    const center = Math.max(-180, Math.min(180, (bounds.west + bounds.east) / 2))
    west = Math.max(-180, center - 0.00005)
    east = Math.min(180, center + 0.00005)
    if (!(east > west)) {
      west = -180
      east = 180
    }
  }
  if (!(north > south)) {
    const center = Math.max(-90, Math.min(90, (bounds.south + bounds.north) / 2))
    south = Math.max(-90, center - 0.00005)
    north = Math.min(90, center + 0.00005)
    if (!(north > south)) {
      south = -90
      north = 90
    }
  }
  return Rectangle.fromDegrees(west, south, east, north)
}

export function regionCenter(region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined): V3Coordinate | null {
  const bounds = regionBounds(region)
  if (!bounds) return null
  return {
    longitude: (bounds.west + bounds.east) / 2,
    latitude: (bounds.south + bounds.north) / 2
  }
}

export function isCoordinateInsideRegion(
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  coordinate: Pick<V3Coordinate, "longitude" | "latitude"> | null | undefined
): boolean {
  if (!coordinate || !Number.isFinite(coordinate.longitude) || !Number.isFinite(coordinate.latitude)) return false
  const points = region?.boundary.filter(isValidCoordinate) ?? []
  if (points.length < 3) return false

  let inside = false
  for (let index = 0, previousIndex = points.length - 1; index < points.length; previousIndex = index++) {
    const current = points[index]!
    const previous = points[previousIndex]!
    if (pointOnSegment(coordinate.longitude, coordinate.latitude, previous, current)) return true
    const crossesLatitude = (current.latitude > coordinate.latitude) !== (previous.latitude > coordinate.latitude)
    if (crossesLatitude) {
      const intersectionLongitude = (previous.longitude - current.longitude)
        * (coordinate.latitude - current.latitude)
        / (previous.latitude - current.latitude)
        + current.longitude
      if (coordinate.longitude < intersectionLongitude) inside = !inside
    }
  }
  return inside
}

export function regionSpanMeters(region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined): number {
  const rectangle = regionRectangle(region)
  if (!rectangle) return 0
  const westSouth = Cartographic.fromRadians(rectangle.west, rectangle.south)
  const eastNorth = Cartographic.fromRadians(rectangle.east, rectangle.north)
  return Cartesian3.distance(
    Cartographic.toCartesian(westSouth),
    Cartographic.toCartesian(eastNorth)
  )
}

export function regionMaximumZoomDistance(region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined): number {
  const spanMeters = Math.max(500, regionSpanMeters(region))
  return Math.max(800, spanMeters * 1.35)
}

export function regionMinimumZoomDistance(region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined): number {
  const spanMeters = Math.max(500, regionSpanMeters(region))
  // 2D 模式也复用 Cesium 的最小距离约束；过大的下限会让相机在
  // 小区域上很快卡在约 1:200。保留一个很小的安全值即可避免数值异常。
  return Math.max(12, spanMeters * 0.008)
}

export function clampV3CameraRange(
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  range: number
): number {
  const spanMeters = Math.max(500, regionSpanMeters(region))
  const minimumRange = regionMinimumZoomDistance(region)
  const maximumRange = Math.max(800, spanMeters * 1.15)
  return Math.min(maximumRange, Math.max(minimumRange, Number.isFinite(range) ? range : maximumRange))
}

export function v3CameraDiagnostics(viewer: Viewer): V3CameraDiagnostics {
  const position = viewer.camera.positionCartographic
  const groundCenter = cameraGroundCenter(viewer)
  return {
    longitude: CesiumMath.toDegrees(position.longitude),
    latitude: CesiumMath.toDegrees(position.latitude),
    heightMeters: position.height,
    headingRadians: viewer.camera.heading,
    pitchRadians: viewer.camera.pitch,
    groundLongitude: groundCenter ? CesiumMath.toDegrees(groundCenter.longitude) : null,
    groundLatitude: groundCenter ? CesiumMath.toDegrees(groundCenter.latitude) : null,
    groundRangeMeters: groundCenter
      ? Cartesian3.distance(viewer.camera.positionWC, Cartographic.toCartesian(groundCenter))
      : null
  }
}

/**
 * Capture the user camera in screen-space terms so a 2D/3D morph can restore
 * the same ground center and apparent scale after Cesium changes frustums.
 */
export function captureV3Camera(viewer: Viewer): V3CameraTransitionSnapshot | null {
  if (!isViewerUsable(viewer)) return null
  try {
    const canvas = viewer.scene.canvas
    const viewportWidthPixels = Number(canvas.clientWidth || canvas.width)
    const viewportHeightPixels = Number(canvas.clientHeight || canvas.height)
    if (!(viewportWidthPixels > 0) || !(viewportHeightPixels > 0)) return null
    const center = cameraScreenCenter(viewer, viewportWidthPixels, viewportHeightPixels)
    if (!center) return null
    const viewWidthMeters = cameraGroundWidth(viewer, viewportWidthPixels, viewportHeightPixels)
    if (!Number.isFinite(viewWidthMeters) || viewWidthMeters <= 0) return null
    const sourceMode: "2d" | "3d" = viewer.scene.mode === SceneMode.SCENE2D ? "2d" : "3d"
    const rangeMeters = sourceMode === "3d" ? currentCameraRange(viewer) : null
    return {
      center: { longitude: CesiumMath.toDegrees(center.longitude), latitude: CesiumMath.toDegrees(center.latitude) },
      metersPerPixel: viewWidthMeters / viewportWidthPixels,
      viewWidthMeters,
      rangeMeters: Number.isFinite(rangeMeters) && (rangeMeters ?? 0) > 0 ? rangeMeters : null,
      headingRadians: Number.isFinite(viewer.camera.heading) ? viewer.camera.heading : 0,
      pitchRadians: Number.isFinite(viewer.camera.pitch) ? viewer.camera.pitch : CesiumMath.toRadians(-44),
      viewportWidthPixels,
      sourceMode
    }
  } catch {
    return null
  }
}

/** Restore a previously captured camera after Cesium has completed a morph. */
export function restoreV3Camera(
  viewer: Viewer,
  snapshot: V3CameraTransitionSnapshot | null,
  mode: "2d" | "3d",
  duration = 0
): boolean {
  if (!snapshot || !isViewerUsable(viewer)) return false
  const { center } = snapshot
  if (!Number.isFinite(center.longitude) || !Number.isFinite(center.latitude)) return false
  try {
    const canvas = viewer.scene.canvas
    const widthPixels = Number(canvas.clientWidth || canvas.width)
    const viewWidthMeters = snapshot.metersPerPixel * (widthPixels > 0 ? widthPixels : snapshot.viewportWidthPixels)
    if (!Number.isFinite(viewWidthMeters) || viewWidthMeters <= 0) return false
    viewer.camera.cancelFlight()
    if (mode === "2d") {
      repairV3TwoDimensionalFrustum(viewer)
      viewer.camera.flyTo({
        destination: Cartesian3.fromDegrees(center.longitude, center.latitude, viewWidthMeters),
        duration,
        orientation: { heading: snapshot.headingRadians, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 }
      })
      return true
    }
    const frustum = viewer.camera.frustum as { fovy?: number; aspectRatio?: number }
    const fovy = Number(frustum.fovy)
    const aspect = Number(frustum.aspectRatio) > 0 ? Number(frustum.aspectRatio) : 1
    const derivedRange = Number.isFinite(fovy) && fovy > 0
      ? viewWidthMeters / (2 * Math.tan(fovy / 2) * aspect)
      : viewWidthMeters
    const range = snapshot.rangeMeters && snapshot.sourceMode === "3d"
      ? snapshot.rangeMeters
      : derivedRange
    if (!Number.isFinite(range) || range <= 0) return false
    const target = Cartesian3.fromDegrees(center.longitude, center.latitude)
    viewer.camera.lookAt(target, new HeadingPitchRange(
      normalizeHeadingRadians(snapshot.headingRadians),
      Math.min(CesiumMath.toRadians(-5), snapshot.pitchRadians),
      range
    ))
    viewer.scene.requestRender()
    return true
  } catch {
    return false
  }
}

export function regionMaskHierarchy(
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  paddingRatio = 1.2
): PolygonHierarchy | null {
  const bounds = regionBounds(region)
  const points = region?.boundary.filter(isValidCoordinate) ?? []
  if (!bounds || points.length < 3) return null

  const longitudePadding = Math.max((bounds.east - bounds.west) * Math.max(0, paddingRatio), 0.02)
  const latitudePadding = Math.max((bounds.north - bounds.south) * Math.max(0, paddingRatio), 0.02)
  const outerWest = Math.max(-180, bounds.west - longitudePadding)
  const outerSouth = Math.max(-90, bounds.south - latitudePadding)
  const outerEast = Math.min(180, bounds.east + longitudePadding)
  const outerNorth = Math.min(90, bounds.north + latitudePadding)

  return new PolygonHierarchy(
    Cartesian3.fromDegreesArray([
      outerWest, outerSouth,
      outerEast, outerSouth,
      outerEast, outerNorth,
      outerWest, outerNorth
    ]),
    [new PolygonHierarchy(Cartesian3.fromDegreesArray(points.flatMap((point) => [point.longitude, point.latitude])))]
  )
}

export function focusV3Region(
  viewer: Viewer,
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  mode: "2d" | "3d",
  duration = 0.35
): boolean {
  const rectangle = regionRectangle(region, 0.12)
  if (!rectangle) return false
  if (mode === "2d") {
    repairV3TwoDimensionalFrustum(viewer)
    const center = Rectangle.center(rectangle)
    viewer.camera.flyTo({
      destination: Cartesian3.fromRadians(
        center.longitude,
        center.latitude,
        initialTwoDimensionalViewWidth(viewer)
      ),
      duration
    })
    return true
  }
  const points = region?.boundary.filter(isValidCoordinate).map((point) => Cartesian3.fromDegrees(
    point.longitude,
    point.latitude,
    Math.max(0, point.altitudeMeters ?? 0)
  )) ?? []
  if (points.length < 3) return false
  const sphere = BoundingSphere.fromPoints(points)
  viewer.camera.flyToBoundingSphere(sphere, {
    duration,
    offset: {
      heading: CesiumMath.toRadians(25),
      pitch: CesiumMath.toRadians(-44),
      range: clampV3CameraRange(region, Math.max(500, sphere.radius * 2.8))
    }
  })
  return true
}

export function focusV3Coordinates(
  viewer: Viewer,
  coordinates: readonly V3Coordinate[],
  mode: "2d" | "3d",
  duration = 0.35
): boolean {
  const validCoordinates = coordinates.filter(isValidCoordinate)
  if (validCoordinates.length === 0) return false
  const rectangle = rectangleFromCoordinates(validCoordinates, 0.2)
  if (mode === "2d") {
    repairV3TwoDimensionalFrustum(viewer)
    const center = Rectangle.center(rectangle)
    viewer.camera.flyTo({
      destination: Cartesian3.fromRadians(
        center.longitude,
        center.latitude,
        currentTwoDimensionalViewWidth(viewer)
      ),
      duration
    })
    return true
  }
  const points = validCoordinates.map((point) => Cartesian3.fromDegrees(
    point.longitude,
    point.latitude,
    Math.max(0, point.altitudeMeters ?? 0)
  ))
  const sphere = BoundingSphere.fromPoints(points)
  const currentRange = currentCameraRange(viewer)
  viewer.camera.flyToBoundingSphere(sphere, {
    duration,
    offset: {
      heading: normalizeHeadingRadians(viewer.camera.heading),
      pitch: Math.min(CesiumMath.toRadians(-35), viewer.camera.pitch),
      range: Number.isFinite(currentRange) && currentRange > 0
        ? currentRange
        : Math.max(250, sphere.radius * 3.2)
    }
  })
  return true
}

export function rotateV3Camera(
  viewer: Viewer,
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  mode: "2d" | "3d",
  deltaHeadingDegrees: number
): boolean {
  const focus = cameraGroundCenter(viewer) ?? regionCenterCartographic(region)
  if (!focus) return false
  const target = Cartographic.toCartesian(focus)
  const range = clampV3CameraRange(region, Cartesian3.distance(viewer.camera.positionWC, target))
  const pitch = mode === "2d" ? -CesiumMath.PI_OVER_TWO : Math.min(CesiumMath.toRadians(-35), viewer.camera.pitch)
  const currentHeading = normalizeHeadingRadians(viewer.camera.heading)
  const previousState = rotationStates.get(viewer)
  const stateIsCompatible = previousState
    && previousState.mode === mode
    && Cartesian3.distance(previousState.target, target) <= 25
    && Math.abs(previousState.range - range) <= Math.max(25, range * 0.02)
  const state = stateIsCompatible
    ? previousState
    : {
        mode,
        target: Cartesian3.clone(target),
        range,
        pitch,
        requestedHeading: currentHeading
      }
  state.requestedHeading = normalizeHeadingRadians(state.requestedHeading + CesiumMath.toRadians(deltaHeadingDegrees))
  rotationStates.set(viewer, state)
  viewer.camera.cancelFlight()
  viewer.camera.lookAt(target, new HeadingPitchRange(
    state.requestedHeading,
    state.pitch,
    state.range
  ))
  viewer.scene.requestRender()
  return true
}

export function resetV3CameraNorth(
  viewer: Viewer,
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  mode: "2d" | "3d"
): boolean {
  const focus = cameraGroundCenter(viewer) ?? regionCenterCartographic(region)
  if (!focus) return false
  const target = Cartographic.toCartesian(focus)
  const range = clampV3CameraRange(region, Cartesian3.distance(viewer.camera.positionWC, target))
  viewer.camera.cancelFlight()
  rotationStates.delete(viewer)
  viewer.camera.lookAt(target, new HeadingPitchRange(
    0,
    mode === "2d" ? -CesiumMath.PI_OVER_TWO : CesiumMath.toRadians(-44),
    range
  ))
  viewer.scene.requestRender()
  return true
}

export type V3CameraPreset = "top-down" | "flight"

export function setV3CameraPreset(
  viewer: Viewer,
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  mode: "2d" | "3d",
  preset: V3CameraPreset
): boolean {
  if (mode === "2d") return false
  const focus = cameraGroundCenter(viewer) ?? regionCenterCartographic(region)
  if (!focus) return false
  const target = Cartographic.toCartesian(focus)
  const range = clampV3CameraRange(region, Cartesian3.distance(viewer.camera.positionWC, target))
  viewer.camera.cancelFlight()
  rotationStates.delete(viewer)
  viewer.camera.lookAt(target, new HeadingPitchRange(
    preset === "top-down" ? 0 : normalizeHeadingRadians(viewer.camera.heading),
    preset === "top-down" ? -CesiumMath.PI_OVER_TWO : CesiumMath.toRadians(-35),
    range
  ))
  viewer.scene.requestRender()
  return true
}

export function zoomV3Camera(
  viewer: Viewer,
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined,
  mode: "2d" | "3d",
  direction: "in" | "out"
): boolean {
  if (!isViewerUsable(viewer) || viewer.scene.mode === SceneMode.MORPHING) return false
  if (mode === "2d") {
    repairV3TwoDimensionalFrustum(viewer)
    const frustum = viewer.camera.frustum as { left?: number; right?: number; top?: number; bottom?: number }
    if (![frustum.left, frustum.right, frustum.top, frustum.bottom].every(Number.isFinite)) return false
    const factor = direction === "in" ? 0.68 : 1.4
    const width = frustum.right! - frustum.left!
    const height = frustum.top! - frustum.bottom!
    if (!(width > 0) || !(height > 0)) return false
    const shortestSpan = Math.min(width, height)
    const requestedAmount = shortestSpan * Math.abs(1 - factor)
    // Cesium OrthographicFrustum moves all four planes by the zoom amount.
    // Bounding the amount by less than half of the shortest span prevents
    // right <= left / top <= bottom on narrow or repeatedly zoomed views.
    const amount = direction === "in"
      ? Math.max(0.01, Math.min(requestedAmount, shortestSpan * 0.45))
      : Math.max(1, requestedAmount)
    viewer.camera.cancelFlight()
    if (direction === "in") viewer.camera.zoomIn(amount)
    else viewer.camera.zoomOut(amount)
    viewer.scene.requestRender()
    return true
  }
  const viewRectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid)
  const viewSpan = viewRectangle
    ? Cartesian3.distance(
        Cartographic.toCartesian(Cartographic.fromRadians(viewRectangle.west, Rectangle.center(viewRectangle).latitude)),
        Cartographic.toCartesian(Cartographic.fromRadians(viewRectangle.east, Rectangle.center(viewRectangle).latitude))
      )
    : regionSpanMeters(region)
  const amount = Math.max(20, viewSpan * 0.16)
  viewer.camera.cancelFlight()
  if (direction === "in") viewer.camera.zoomIn(amount)
  else viewer.camera.zoomOut(amount)
  viewer.scene.requestRender()
  return true
}

/**
 * Keep Cesium's 2D off-center frustum valid before it reaches the renderer.
 * Layout changes and morph transitions can briefly produce a zero/negative
 * span even when the user did not click a camera control.
 */
export function repairV3TwoDimensionalFrustum(viewer: Viewer): boolean {
  if (!isViewerUsable(viewer)) return false
  let frustum: { left?: number; right?: number; top?: number; bottom?: number }
  try {
    frustum = viewer.camera.frustum as typeof frustum
  } catch {
    return false
  }
  // Perspective/orthographic 3D frustums do not expose these four planes.
  // During a morph Cesium may already have switched to an off-center 2D
  // frustum while scene.mode is still MORPHING, so inspect the shape rather
  // than relying solely on the scene mode.
  const isOffCenterFrustum = ["left", "right", "top", "bottom"]
    .every((key) => key in (frustum as object))
  if (!isOffCenterFrustum) return true
  const values = [frustum.left, frustum.right, frustum.top, frustum.bottom]
  const valid = values.every(Number.isFinite)
    && frustum.right! > frustum.left!
    && frustum.top! > frustum.bottom!
  if (valid) return true

  const finiteMagnitudes = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) > 0)
    .map((value) => Math.abs(value))
  const existingHalfSpan = finiteMagnitudes.length > 0 ? Math.max(...finiteMagnitudes) : 0
  const halfHeight = Math.min(Math.max(existingHalfSpan, 500), 100_000_000)
  const canvas = viewer.scene.canvas
  const canvasWidth = Number(canvas.clientWidth || canvas.width)
  const canvasHeight = Number(canvas.clientHeight || canvas.height)
  const aspect = canvasWidth > 0 && canvasHeight > 0 ? canvasWidth / canvasHeight : 1
  const halfWidth = Math.min(Math.max(halfHeight * aspect, 500), 100_000_000)
  frustum.left = -halfWidth
  frustum.right = halfWidth
  frustum.bottom = -halfHeight
  frustum.top = halfHeight
  return true
}

export function configureRegionMapConstraints(
  viewer: Viewer,
  region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined
): () => void {
  const removeFrustumGuard = viewer.scene.preUpdate.addEventListener(() => {
    repairV3TwoDimensionalFrustum(viewer)
    const controller = viewer.scene.screenSpaceCameraController
    const desiredMinimum = viewer.scene.mode === SceneMode.SCENE2D
      ? TWO_DIMENSIONAL_MINIMUM_ZOOM_DISTANCE
      : regionMinimumZoomDistance(region)
    if (controller.minimumZoomDistance !== desiredMinimum) controller.minimumZoomDistance = desiredMinimum
  })
  const rectangle = regionRectangle(region)
  if (!rectangle) {
    return () => removeFrustumGuard()
  }
  const cameraController = viewer.scene.screenSpaceCameraController
  const previousMaximumZoomDistance = cameraController.maximumZoomDistance
  const previousMinimumZoomDistance = cameraController.minimumZoomDistance
  const previousMaximumZoomFactor = viewer.camera.maximumZoomFactor
  const previousPercentageChanged = viewer.camera.percentageChanged
  const minimumZoomDistance = regionMinimumZoomDistance(region)
  const maximumZoomDistance = regionMaximumZoomDistance(region)
  let correcting = false
  let pendingCheck: number | null = null
  let correctionFallback: number | null = null
  let correctionAttempts = 0

  cameraController.maximumZoomDistance = maximumZoomDistance
  cameraController.minimumZoomDistance = viewer.scene.mode === SceneMode.SCENE2D
    ? TWO_DIMENSIONAL_MINIMUM_ZOOM_DISTANCE
    : minimumZoomDistance
  viewer.camera.maximumZoomFactor = 1.05
  viewer.camera.percentageChanged = Math.min(previousPercentageChanged, 0.01)

  const keepInsideRegion = () => {
    if (correcting || !isViewerUsable(viewer) || viewer.scene.mode === SceneMode.MORPHING) return
    const is2d = viewer.scene.mode === SceneMode.SCENE2D
    // Cesium can temporarily return no view rectangle at close 2D zoom levels.
    // Treat that as a valid user zoom state; otherwise moveEnd would frame the
    // whole teaching region again and make the map appear to have a fixed scale.
    if (is2d) return
    const center = cameraGroundCenter(viewer)
    const heightMeters = viewer.camera.positionCartographic.height
    const heightInvalid = !Number.isFinite(heightMeters)
      || heightMeters < minimumZoomDistance * 0.7
      || heightMeters > maximumZoomDistance * 1.2
    if (!heightInvalid && center && containsWithPadding(rectangle, center, 0.18)) return
    if (correctionAttempts >= 3) {
      correctionAttempts = 0
      return
    }
    correctionAttempts += 1
    correcting = true
    viewer.camera.cancelFlight()
    if (correctionFallback !== null) window.clearTimeout(correctionFallback)
    correctionFallback = window.setTimeout(() => {
      correctionFallback = null
      correcting = false
      if (!isViewerUsable(viewer)) return
      const correctedCenter = cameraGroundCenter(viewer)
      const correctedHeight = viewer.camera.positionCartographic.height
      const corrected = viewer.scene.mode === SceneMode.SCENE2D
        ? Boolean(correctedCenter && containsWithPadding(rectangle, correctedCenter, 0.18))
        : Number.isFinite(correctedHeight)
          && correctedHeight >= minimumZoomDistance * 0.7
          && correctedHeight <= maximumZoomDistance * 1.2
          && Boolean(correctedCenter)
          && containsWithPadding(rectangle, correctedCenter!, 0.18)
      if (!corrected) keepInsideRegion()
      else correctionAttempts = 0
    }, 300)
    focusV3Region(viewer, region, "3d", 0.25)
  }

  const scheduleInsideCheck = () => {
    if (pendingCheck !== null) window.clearTimeout(pendingCheck)
    pendingCheck = window.setTimeout(() => {
      pendingCheck = null
      keepInsideRegion()
    }, 180)
  }

  const handleCameraChanged = () => {
    if (!isViewerUsable(viewer)) return
    const heightMeters = viewer.camera.positionCartographic.height
    if (viewer.scene.mode !== SceneMode.SCENE2D
      && (!Number.isFinite(heightMeters) || heightMeters < minimumZoomDistance * 0.7 || heightMeters > maximumZoomDistance * 1.2)) {
      keepInsideRegion()
      return
    }
    scheduleInsideCheck()
  }

  const removeMoveEndListener = viewer.camera.moveEnd.addEventListener(keepInsideRegion)
  const removeChangedListener = viewer.camera.changed.addEventListener(handleCameraChanged)
  return () => {
    removeFrustumGuard()
    removeMoveEndListener()
    removeChangedListener()
    if (pendingCheck !== null) window.clearTimeout(pendingCheck)
    if (correctionFallback !== null) window.clearTimeout(correctionFallback)
    if (viewer.isDestroyed()) return
    cameraController.maximumZoomDistance = previousMaximumZoomDistance
    cameraController.minimumZoomDistance = previousMinimumZoomDistance
    viewer.camera.maximumZoomFactor = previousMaximumZoomFactor
    viewer.camera.percentageChanged = previousPercentageChanged
  }
}

export function initialTwoDimensionalViewWidth(viewer: Pick<Viewer, "scene">): number {
  const canvasWidth = Number(viewer.scene.canvas.clientWidth || viewer.scene.canvas.width)
  const usableWidth = Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : 960
  return DEFAULT_TWO_DIMENSIONAL_SCALE_METERS * usableWidth / SCALE_BAR_REFERENCE_WIDTH_PIXELS * 1.02
}

function currentTwoDimensionalViewWidth(viewer: Viewer): number {
  const frustum = viewer.camera.frustum as { left?: number; right?: number }
  const width = Number(frustum.right) - Number(frustum.left)
  if (Number.isFinite(width) && width > 0) return width
  const height = viewer.camera.positionCartographic?.height
  return Number.isFinite(height) && height > 0 ? height : initialTwoDimensionalViewWidth(viewer)
}

function currentCameraRange(viewer: Viewer): number {
  const center = cameraGroundCenter(viewer)
  if (center) return Cartesian3.distance(viewer.camera.positionWC, Cartographic.toCartesian(center))
  return viewer.camera.positionCartographic?.height ?? Number.NaN
}

function rectangleFromCoordinates(coordinates: readonly V3Coordinate[], paddingRatio: number): Rectangle {
  const west = Math.min(...coordinates.map((point) => point.longitude))
  const east = Math.max(...coordinates.map((point) => point.longitude))
  const south = Math.min(...coordinates.map((point) => point.latitude))
  const north = Math.max(...coordinates.map((point) => point.latitude))
  const longitudePadding = Math.max((east - west) * paddingRatio, 0.001)
  const latitudePadding = Math.max((north - south) * paddingRatio, 0.001)
  let rectangleWest = Math.max(-180, west - longitudePadding)
  let rectangleSouth = Math.max(-90, south - latitudePadding)
  let rectangleEast = Math.min(180, east + longitudePadding)
  let rectangleNorth = Math.min(90, north + latitudePadding)
  if (!(rectangleEast > rectangleWest)) {
    const center = Math.max(-180, Math.min(180, (west + east) / 2))
    rectangleWest = Math.max(-180, center - 0.0005)
    rectangleEast = Math.min(180, center + 0.0005)
  }
  if (!(rectangleNorth > rectangleSouth)) {
    const center = Math.max(-90, Math.min(90, (south + north) / 2))
    rectangleSouth = Math.max(-90, center - 0.0005)
    rectangleNorth = Math.min(90, center + 0.0005)
  }
  return Rectangle.fromDegrees(rectangleWest, rectangleSouth, rectangleEast, rectangleNorth)
}

function cameraScreenCenter(viewer: Viewer, width: number, height: number): Cartographic | null {
  const center = new Cartesian2(width / 2, height / 2)
  let terrainPoint: Cartesian3 | null = null
  try {
    const ray = viewer.camera.getPickRay(center)
    terrainPoint = (ray ? viewer.scene.globe.pick(ray, viewer.scene) : null) ?? null
  } catch {
    terrainPoint = null
  }
  let ellipsoidPoint: Cartesian3 | null = null
  try {
    ellipsoidPoint = viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid) ?? null
  } catch {
    ellipsoidPoint = null
  }
  const point = terrainPoint ?? ellipsoidPoint
  if (point) return Cartographic.fromCartesian(point)
  const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid)
  return rectangle ? Rectangle.center(rectangle) : null
}

function cameraGroundWidth(viewer: Viewer, width: number, height: number): number {
  if (viewer.scene.mode === SceneMode.SCENE2D) {
    const frustum = viewer.camera.frustum as { left?: number; right?: number }
    const frustumWidth = Number(frustum.right) - Number(frustum.left)
    if (Number.isFinite(frustumWidth) && frustumWidth > 0) return frustumWidth
    const rectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid)
    if (rectangle) {
      const latitude = Rectangle.center(rectangle).latitude
      return Cartesian3.distance(
        Cartographic.toCartesian(Cartographic.fromRadians(rectangle.west, latitude)),
        Cartographic.toCartesian(Cartographic.fromRadians(rectangle.east, latitude))
      )
    }
  }
  const y = height / 2
  const half = Math.max(1, Math.min(width / 2 - 1, 240))
  const left = pickCameraGround(viewer, new Cartesian2(width / 2 - half, y))
  const right = pickCameraGround(viewer, new Cartesian2(width / 2 + half, y))
  if (left && right) {
    const distance = Cartesian3.distance(Cartographic.toCartesian(left), Cartographic.toCartesian(right))
    if (Number.isFinite(distance) && distance > 0) return distance * width / (half * 2)
  }
  const range = currentCameraRange(viewer)
  const frustum = viewer.camera.frustum as { fovy?: number; aspectRatio?: number }
  const fovy = Number(frustum.fovy)
  const aspect = Number(frustum.aspectRatio) > 0 ? Number(frustum.aspectRatio) : width / Math.max(1, height)
  return Number.isFinite(range) && range > 0 && Number.isFinite(fovy) && fovy > 0
    ? range * 2 * Math.tan(fovy / 2) * aspect
    : Number.NaN
}

function pickCameraGround(viewer: Viewer, position: Cartesian2): Cartographic | null {
  let terrainPoint: Cartesian3 | null = null
  try {
    const ray = viewer.camera.getPickRay(position)
    terrainPoint = (ray ? viewer.scene.globe.pick(ray, viewer.scene) : null) ?? null
  } catch {
    terrainPoint = null
  }
  let ellipsoidPoint: Cartesian3 | null = null
  try {
    ellipsoidPoint = viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid) ?? null
  } catch {
    ellipsoidPoint = null
  }
  const point = terrainPoint ?? ellipsoidPoint
  return point ? Cartographic.fromCartesian(point) : null
}

function cameraGroundCenter(viewer: Viewer | null | undefined): Cartographic | null {
  if (!isViewerUsable(viewer)) return null
  try {
    if (viewer.scene.mode === SceneMode.SCENE2D) {
      const viewRectangle = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid)
      return viewRectangle ? Rectangle.center(viewRectangle) : null
    }
    const canvas = viewer.scene.canvas
    const center = new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2)
    const ellipsoidPoint = viewer.camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid)
    const ray = viewer.camera.getPickRay(center)
    const terrainPoint = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined
    const point = ellipsoidPoint ?? terrainPoint
    return point ? Cartographic.fromCartesian(point) : null
  } catch {
    // Camera diagnostics and boundary correction must never take down the
    // render loop while Cesium is transitioning between projection modes.
    return null
  }
}

function isViewerUsable(viewer: Viewer | null | undefined): viewer is Viewer {
  if (!viewer) return false
  try {
    const destroyed = typeof viewer.isDestroyed === "function" ? viewer.isDestroyed() : false
    return !destroyed && Boolean(viewer.scene)
  } catch {
    return false
  }
}

function regionCenterCartographic(region: Pick<V3RegionCatalogItem, "boundary"> | null | undefined): Cartographic | null {
  const center = regionCenter(region)
  return center ? Cartographic.fromDegrees(center.longitude, center.latitude) : null
}

function containsWithPadding(rectangle: Rectangle, point: Cartographic, paddingRatio: number): boolean {
  const longitudePadding = (rectangle.east - rectangle.west) * paddingRatio
  const latitudePadding = (rectangle.north - rectangle.south) * paddingRatio
  return point.longitude >= rectangle.west - longitudePadding
    && point.longitude <= rectangle.east + longitudePadding
    && point.latitude >= rectangle.south - latitudePadding
    && point.latitude <= rectangle.north + latitudePadding
}

function isValidCoordinate(point: V3Coordinate): boolean {
  return Number.isFinite(point.longitude)
    && Number.isFinite(point.latitude)
    && point.longitude >= -180
    && point.longitude <= 180
    && point.latitude >= -90
    && point.latitude <= 90
}

function pointOnSegment(
  longitude: number,
  latitude: number,
  start: V3Coordinate,
  end: V3Coordinate
): boolean {
  const crossProduct = (longitude - start.longitude) * (end.latitude - start.latitude)
    - (latitude - start.latitude) * (end.longitude - start.longitude)
  if (Math.abs(crossProduct) > 1e-10) return false
  return longitude >= Math.min(start.longitude, end.longitude) - 1e-10
    && longitude <= Math.max(start.longitude, end.longitude) + 1e-10
    && latitude >= Math.min(start.latitude, end.latitude) - 1e-10
    && latitude <= Math.max(start.latitude, end.latitude) + 1e-10
}
