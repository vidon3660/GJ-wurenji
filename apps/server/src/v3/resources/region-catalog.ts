import {
  v3RegionLayerCodes,
  v3LogisticsNodeTypes,
  type SceneType,
  type V3Coordinate,
  type V3LogisticsNode,
  type V3RegionCatalogItem,
  type V3RegionFeature,
  type V3RegionLayerCode,
  type V3RegionLayerDefinition,
  type V3RegionLayerState,
  type V3TerrainResource
} from "@wurenji/shared"
import type { V3ImageryResource, V3MapResourceManifest, V3MapResourceManifestLayer, VtlAircraftParameters, VtlLandingSiteView, VtlTaskObjectView } from "@wurenji/shared"
import { ResourcePackageEntity } from "./resource-package.entity.js"
import { createBuiltinLogisticsNodes } from "./builtin-logistics-nodes.js"

export function parseRegionCatalogItem(item: ResourcePackageEntity): V3RegionCatalogItem | null {
  const manifest = item.manifest
  if (manifest.catalogVersion !== 1) return null
  const sceneType = readSceneType(manifest.sceneType)
  const layers = readArray(manifest.layers, "layers").map(readLayer).map((layer) => ({
    ...layer,
    // Obstacles are teacher-authored overlay objects. Older imported region
    // manifests may still contain a base OBSTACLE feature; hide it from the
    // catalog so it cannot leak into the shared student/teacher base map.
    features: layer.features.filter((feature) => String(feature.properties.category ?? "").toUpperCase() !== "OBSTACLE")
  }))
  const layerCodes = new Set(layers.map((layer) => layer.code))
  const requiredLayerCodes = ["BUILDINGS", "RESTRICTIONS", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"] as const
  if (layerCodes.size !== layers.length || requiredLayerCodes.some((code) => !layerCodes.has(code)) || layers.some((layer) => !v3RegionLayerCodes.includes(layer.code))) {
    throw new Error(`区域包 ${item.name} 必须且只能包含五类专题图层，并可按资源增加水域或绿地图层`)
  }
  const center = readCoordinate(manifest.center, "center")
  const boundary = readCoordinates(manifest.boundary, "boundary", 3)
  const regionCode = readString(manifest.regionCode, "regionCode")
  const logisticsNodes = sceneType === "CITY_LOGISTICS"
    ? manifest.logisticsNodes === undefined
      ? createBuiltinLogisticsNodes(regionCode, center, legacyVariant(regionCode))
      : readArray(manifest.logisticsNodes, "logisticsNodes").map(readLogisticsNode)
    : undefined
  if (sceneType === "CITY_LOGISTICS") {
    validateLogisticsNodes(logisticsNodes ?? [])
    validateLogisticsEnvironment(layers)
  }
  const vtlTaskObjects = sceneType === "VTOL_INSPECTION" ? readVtlTaskObjects(manifest.vtlTaskObjects, boundary) : undefined
  const vtlLandingSites = sceneType === "VTOL_INSPECTION" ? readVtlLandingSites(manifest.vtlLandingSites, boundary) : undefined
  const vtlAircraftParameters = sceneType === "VTOL_INSPECTION" ? readVtlAircraftParameters(manifest.vtlAircraftParameters) : undefined
  if (sceneType === "VTOL_INSPECTION") validateVtlResources(vtlTaskObjects!, vtlLandingSites!, boundary)
  return {
    packageId: item.id,
    packageVersion: item.version,
    checksum: item.sha256,
    sceneType,
    regionCode,
    title: readString(manifest.title, "title"),
    summary: readString(manifest.summary, "summary"),
    center,
    boundary,
    heightDatum: manifest.heightDatum === "AGL" || manifest.heightDatum === "AMSL" ? manifest.heightDatum : fail("heightDatum"),
    terrainResourceVersion: readString(manifest.terrainResourceVersion, "terrainResourceVersion"),
    mapResourceVersion: typeof manifest.mapResourceVersion === "string" ? manifest.mapResourceVersion.trim() : null,
    mapResourceManifest: readMapResourceManifest(manifest.mapResourceManifest),
    terrain: readTerrainResource(manifest.terrain, boundary),
    imagery: readImageryResource(manifest.imagery, boundary),
    imageryState: readLayerState(manifest.imageryState),
    layers,
    ...(logisticsNodes ? { logisticsNodes } : {}),
    ...(vtlTaskObjects ? { vtlTaskObjects } : {}),
    ...(vtlLandingSites ? { vtlLandingSites } : {}),
    ...(vtlAircraftParameters ? { vtlAircraftParameters } : {})
  }
}

function readTerrainResource(value: unknown, boundary: V3Coordinate[]): V3TerrainResource | null {
  if (value === undefined || value === null) return null
  const terrain = readObject(value, "terrain")
  const provider = terrain.provider === "CESIUM_QUANTIZED_MESH" ? terrain.provider : fail("terrain.provider")
  const sha256 = readString(terrain.sha256, "terrain.sha256")
  if (!/^[a-f0-9]{64}$/.test(sha256)) return fail("terrain.sha256")
  const verticalDatum = terrain.verticalDatum === "AMSL" || terrain.verticalDatum === "ELLIPSOID"
    ? terrain.verticalDatum
    : fail("terrain.verticalDatum")
  const extent = readExtent(terrain.extent)
  if (extent[0] >= extent[2] || extent[1] >= extent[3]) return fail("terrain.extent")
  if (!boundary.every((point) => point.longitude >= extent[0]! && point.longitude <= extent[2]! && point.latitude >= extent[1]! && point.latitude <= extent[3]!)) return fail("terrain.extent 覆盖范围不足")
  const elevationSampleUrl = typeof terrain.elevationSampleUrl === "string" && terrain.elevationSampleUrl.trim()
    ? terrain.elevationSampleUrl.trim()
    : null
  const elevationSampleSha256 = typeof terrain.elevationSampleSha256 === "string" && terrain.elevationSampleSha256.trim()
    ? terrain.elevationSampleSha256.trim().toLowerCase()
    : null
  if (elevationSampleUrl && (!elevationSampleSha256 || !/^[a-f0-9]{64}$/.test(elevationSampleSha256))) {
    return fail("terrain.elevationSampleSha256")
  }
  return {
    provider,
    url: readMapResourceUrl(terrain.url, "terrain.url"),
    version: readString(terrain.version, "terrain.version"),
    sha256,
    verticalDatum,
    extent,
    ...(terrain.coordinateReference === undefined ? {} : { coordinateReference: readCoordinateReference(terrain.coordinateReference, "terrain.coordinateReference") }),
    ...(elevationSampleUrl ? { elevationSampleUrl } : {}),
    ...(elevationSampleSha256 ? { elevationSampleSha256 } : {})
  }
}

function readImageryResource(value: unknown, boundary: V3Coordinate[]): V3ImageryResource | null {
  if (value === undefined || value === null) return null
  const imagery = readObject(value, "imagery")
  const provider = imagery.provider === "XYZ" || imagery.provider === "TMS" || imagery.provider === "SINGLE_TILE" ? imagery.provider : fail("imagery.provider")
  const sha256 = readString(imagery.sha256, "imagery.sha256")
  if (!/^[a-f0-9]{64}$/.test(sha256)) return fail("imagery.sha256")
  const extent = readExtent(imagery.extent)
  if (!boundary.every((point) => point.longitude >= extent[0]! && point.longitude <= extent[2]! && point.latitude >= extent[1]! && point.latitude <= extent[3]!)) return fail("imagery.extent 覆盖范围不足")
  return {
    provider,
    url: readMapResourceUrl(imagery.url, "imagery.url"),
    version: readString(imagery.version, "imagery.version"),
    sha256,
    extent,
    ...(imagery.coordinateReference === undefined ? {} : { coordinateReference: readCoordinateReference(imagery.coordinateReference, "imagery.coordinateReference") })
  }
}

function readLogisticsNode(value: unknown): V3LogisticsNode {
  const node = readObject(value, "logisticsNode")
  const type = typeof node.type === "string" && (v3LogisticsNodeTypes as readonly string[]).includes(node.type)
    ? node.type as V3LogisticsNode["type"]
    : fail("logisticsNode.type")
  const geometryType = node.geometryType === "POINT" || node.geometryType === "POLYGON" ? node.geometryType : fail("logisticsNode.geometryType")
  const properties = readObject(node.properties ?? {}, "logisticsNode.properties")
  const normalizedProperties: Record<string, string | number | boolean> = {}
  for (const [key, property] of Object.entries(properties)) {
    if (typeof property === "string" || typeof property === "number" || typeof property === "boolean") normalizedProperties[key] = property
  }
  return {
    id: readString(node.id, "logisticsNode.id"),
    code: readString(node.code, "logisticsNode.code"),
    type,
    name: readString(node.name, "logisticsNode.name"),
    geometryType,
    ...(geometryType === "POINT" ? { position: readCoordinate(node.position, "logisticsNode.position") } : {}),
    ...(geometryType === "POLYGON" ? { positions: readCoordinates(node.positions, "logisticsNode.positions", 3) } : {}),
    enabled: node.enabled !== false,
    properties: normalizedProperties
  }
}

function validateLogisticsNodes(nodes: V3LogisticsNode[]): void {
  const ids = new Set(nodes.map((node) => node.id))
  if (ids.size !== nodes.length) fail("logisticsNodes 包含重复 ID")
  const requiredSingletons: V3LogisticsNode["type"][] = ["CENTER_AIRPORT", "TAKEOFF_POINT", "LANDING_POINT", "PARKING_POINT"]
  for (const type of requiredSingletons) {
    if (nodes.filter((node) => node.type === type && node.enabled).length !== 1) fail(`logisticsNodes 必须包含一个 ${type}`)
  }
  if (nodes.filter((node) => node.type === "DELIVERY_POINT" && node.enabled).length < 12) fail("logisticsNodes 至少需要 12 个候选配送点")
  if (!nodes.some((node) => node.type === "WAITING_POINT" && node.enabled)) fail("logisticsNodes 缺少候选等待点")
  if (!nodes.some((node) => node.type === "ALTERNATE_LANDING_POINT" && node.enabled)) fail("logisticsNodes 缺少候选备降点")
  if (!nodes.some((node) => node.type === "EMERGENCY_AREA" && node.enabled)) fail("logisticsNodes 缺少应急运行区域")
}

function validateLogisticsEnvironment(layers: V3RegionLayerDefinition[]): void {
  const features = layers.find((layer) => layer.code === "BUILDINGS")?.features ?? []
  if (features.length === 0) fail("物流区域 BUILDINGS 图层缺少建筑要素")
  for (const feature of features) {
    if (typeof feature.heightMeters !== "number" || !Number.isFinite(feature.heightMeters) || feature.heightMeters <= 0) {
      fail(`物流区域环境要素 ${feature.id} 缺少有效 heightMeters`)
    }
  }
}

function legacyVariant(regionCode: string): number {
  if (regionCode.includes("COAST")) return 5
  if (regionCode.includes("HILL")) return 6
  return 4
}

function readLayer(value: unknown): V3RegionLayerDefinition {
  const layer = readObject(value, "layer")
  const code = readLayerCode(layer.code)
  return {
    code,
    title: readString(layer.title, `${code}.title`),
    state: readLayerState(layer.state),
    source: readString(layer.source, `${code}.source`),
    version: readString(layer.version, `${code}.version`),
    features: readArray(layer.features, `${code}.features`).map(readFeature),
    ...(typeof layer.dataUrl === "string" && layer.dataUrl.trim() ? { dataUrl: readMapResourceUrl(layer.dataUrl, `${code}.dataUrl`) } : {}),
    ...(layer.format === "GEOJSON" || layer.format === "MVT" ? { format: layer.format } : layer.format === undefined ? {} : fail(`${code}.format`)),
    ...(layer.coordinateReference === undefined ? {} : { coordinateReference: readCoordinateReference(layer.coordinateReference, `${code}.coordinateReference`) }),
    ...(layer.sha256 === undefined ? {} : typeof layer.sha256 === "string" && /^[a-f0-9]{64}$/.test(layer.sha256) ? { sha256: layer.sha256 } : fail(`${code}.sha256`)),
    ...(layer.extent === undefined ? {} : { extent: readExtent(layer.extent) })
  }
}

function readMapResourceManifest(value: unknown): V3MapResourceManifest | null {
  if (value === undefined || value === null) return null
  const manifest = readObject(value, "mapResourceManifest") as Partial<V3MapResourceManifest>
  if (manifest.manifestVersion !== 1) return fail("mapResourceManifest.manifestVersion")
  if (manifest.coordinateReference !== "EPSG:4326") return fail("mapResourceManifest.coordinateReference")
  if (manifest.heightDatum !== "AGL" && manifest.heightDatum !== "AMSL") return fail("mapResourceManifest.heightDatum")
  const mapResourceVersion = readString(manifest.mapResourceVersion, "mapResourceManifest.mapResourceVersion")
  const coverage = readExtent(manifest.coverage)
  const readLayers = (layers: unknown, label: string): V3MapResourceManifestLayer[] | null => (layers === undefined ? null : readArray(layers, label).map((item): V3MapResourceManifestLayer => {
    const layer = readObject(item, label) as Record<string, unknown>
    const format = ["XYZ", "TMS", "SINGLE_TILE", "GEOJSON", "MVT", "CESIUM_QUANTIZED_MESH"].includes(String(layer.format))
      ? layer.format as V3MapResourceManifestLayer["format"]
      : fail(`${label}.format`)
    const sha256 = readString(layer.sha256, `${label}.sha256`)
    if (!/^[a-f0-9]{64}$/.test(sha256)) return fail(`${label}.sha256`)
    if (layer.coordinateReference !== "EPSG:4326") return fail(`${label}.coordinateReference`)
    return { id: readString(layer.id, `${label}.id`), format, path: readMapResourceUrl(layer.path, `${label}.path`), version: readString(layer.version, `${label}.version`), sha256, coordinateReference: "EPSG:4326" as const, extent: readExtent(layer.extent) }
  }))
  return {
    manifestVersion: 1,
    mapResourceVersion,
    coordinateReference: "EPSG:4326",
    heightDatum: manifest.heightDatum,
    coverage,
    ...(readLayers(manifest.baseLayers, "mapResourceManifest.baseLayers") ? { baseLayers: readLayers(manifest.baseLayers, "mapResourceManifest.baseLayers")! } : {}),
    ...(readLayers(manifest.vectorLayers, "mapResourceManifest.vectorLayers") ? { vectorLayers: readLayers(manifest.vectorLayers, "mapResourceManifest.vectorLayers")! } : {}),
    ...(manifest.terrain ? { terrain: readObject(manifest.terrain, "mapResourceManifest.terrain") } : {}),
    ...(manifest.imagery ? { imagery: readObject(manifest.imagery, "mapResourceManifest.imagery") } : {})
  }
}

function readMapResourceUrl(value: unknown, label: string): string {
  const url = readString(value, label)
  try {
    const parsed = new URL(url, "http://local.map")
    if (parsed.origin === "http://local.map") {
      const path = decodeURIComponent(parsed.pathname)
      if (!path.startsWith("/map/") || path.split("/").some((part) => part === ".." || part.includes("\\"))) return fail(`${label} 路径无效`)
    }
  } catch {
    return fail(`${label} 路径无效`)
  }
  return url
}

function readCoordinateReference(value: unknown, label: string): "EPSG:4326" {
  return value === "EPSG:4326" ? value : fail(label)
}

function readFeature(value: unknown): V3RegionFeature {
  const feature = readObject(value, "feature")
  const geometryType = feature.geometryType === "POINT" || feature.geometryType === "LINESTRING" || feature.geometryType === "POLYGON" ? feature.geometryType : fail("feature.geometryType")
  const properties = readObject(feature.properties ?? {}, "feature.properties")
  const normalizedProperties: Record<string, string | number | boolean> = {}
  for (const [key, property] of Object.entries(properties)) {
    if (typeof property === "string" || typeof property === "number" || typeof property === "boolean") normalizedProperties[key] = property
  }
  const result: V3RegionFeature = {
    id: readString(feature.id, "feature.id"),
    name: readString(feature.name, "feature.name"),
    geometryType,
    properties: normalizedProperties
  }
  if (geometryType === "POINT") result.position = readCoordinate(feature.position, "feature.position")
  if (geometryType === "LINESTRING") result.positions = readCoordinates(feature.positions, "feature.positions", 2)
  if (geometryType === "POLYGON") result.positions = readCoordinates(feature.positions, "feature.positions", 3)
  if (typeof feature.heightMeters === "number" && Number.isFinite(feature.heightMeters)) result.heightMeters = feature.heightMeters
  return result
}

function readCoordinate(value: unknown, label: string): V3Coordinate {
  const point = readObject(value, label)
  const longitude = Number(point.longitude)
  const latitude = Number(point.latitude)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return fail(`${label}.longitude`)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return fail(`${label}.latitude`)
  const result: V3Coordinate = { longitude, latitude }
  if (point.altitudeMeters !== undefined) {
    const altitudeMeters = Number(point.altitudeMeters)
    if (!Number.isFinite(altitudeMeters)) return fail(`${label}.altitudeMeters`)
    result.altitudeMeters = altitudeMeters
  }
  return result
}

function readCoordinates(value: unknown, label: string, minimumLength: number): V3Coordinate[] {
  const points = readArray(value, label)
  if (points.length < minimumLength) return fail(`${label} 至少需要 ${minimumLength} 个坐标点`)
  return points.map((point) => readCoordinate(point, `${label} point`))
}

function readExtent(value: unknown): [number, number, number, number] {
  const extent = readArray(value, "terrain.extent").map((item) => Number(item))
  if (extent.length !== 4 || extent.some((item) => !Number.isFinite(item))) return fail("terrain.extent")
  if (extent[0]! < -180 || extent[2]! > 180 || extent[1]! < -90 || extent[3]! > 90) return fail("terrain.extent")
  return [extent[0]!, extent[1]!, extent[2]!, extent[3]!]
}

function readSceneType(value: unknown): SceneType {
  return value === "CITY_SHOW" || value === "CITY_LOGISTICS" || value === "VTOL_INSPECTION" ? value : fail("sceneType")
}

function readVtlTaskObjects(value: unknown, boundary: V3Coordinate[]): VtlTaskObjectView[] {
  return readArray(value, "vtlTaskObjects").map((item, index) => {
    const object = readObject(item, `vtlTaskObjects[${index}]`)
    const type: VtlTaskObjectView["type"] = object.type === "POINT" || object.type === "LINE" || object.type === "AREA" ? object.type : fail(`vtlTaskObjects[${index}].type`)
    return {
      id: readString(object.id, `vtlTaskObjects[${index}].id`),
      code: readString(object.code, `vtlTaskObjects[${index}].code`),
      title: readString(object.title, `vtlTaskObjects[${index}].title`),
      type,
      positions: readCoordinates(object.positions, `vtlTaskObjects[${index}].positions`, type === "POINT" ? 1 : type === "AREA" ? 3 : 2),
      requirement: readString(object.requirement, `vtlTaskObjects[${index}].requirement`),
      completionRule: readString(object.completionRule, `vtlTaskObjects[${index}].completionRule`),
      required: object.required !== false,
      estimatedWorkSeconds: readPositiveNumber(object.estimatedWorkSeconds, `vtlTaskObjects[${index}].estimatedWorkSeconds`),
      status: "UNASSIGNED" as const,
      incompleteReason: null
    }
  }).map((task, index) => {
    if (task.positions.some((position) => !pointInsideBoundary(position, boundary))) throw new Error(`区域包字段无效：vtlTaskObjects[${index}] 超出 boundary`)
    return task
  })
}

function readVtlLandingSites(value: unknown, boundary: V3Coordinate[]): VtlLandingSiteView[] {
  return readArray(value, "vtlLandingSites").map((item, index) => {
    const object = readObject(item, `vtlLandingSites[${index}]`)
    const type: VtlLandingSiteView["type"] = object.type === "MAIN" || object.type === "ALTERNATE" ? object.type : fail(`vtlLandingSites[${index}].type`)
    const status: VtlLandingSiteView["status"] = object.status === "AVAILABLE" || object.status === "RESTRICTED" || object.status === "UNAVAILABLE" ? object.status : fail(`vtlLandingSites[${index}].status`)
    const position = readCoordinate(object.position, `vtlLandingSites[${index}].position`)
    if (!pointInsideBoundary(position, boundary)) throw new Error(`区域包字段无效：vtlLandingSites[${index}] 超出 boundary`)
    return {
      id: readString(object.id, `vtlLandingSites[${index}].id`),
      code: readString(object.code, `vtlLandingSites[${index}].code`),
      title: readString(object.title, `vtlLandingSites[${index}].title`),
      type,
      position,
      elevationMeters: readNumber(object.elevationMeters, `vtlLandingSites[${index}].elevationMeters`),
      status,
      relatedAlternateSiteIds: readArray(object.relatedAlternateSiteIds ?? [], `vtlLandingSites[${index}].relatedAlternateSiteIds`).map((id) => readString(id, "alternateSiteId"))
    }
  })
}

function validateVtlResources(taskObjects: VtlTaskObjectView[], landingSites: VtlLandingSiteView[], boundary: V3Coordinate[]): void {
  assertUnique(taskObjects.map((item) => item.id), "vtlTaskObjects.id")
  assertUnique(taskObjects.map((item) => item.code), "vtlTaskObjects.code")
  assertUnique(landingSites.map((item) => item.id), "vtlLandingSites.id")
  assertUnique(landingSites.map((item) => item.code), "vtlLandingSites.code")
  if (taskObjects.length === 0) fail("vtlTaskObjects")
  if (!landingSites.some((site) => site.type === "MAIN")) fail("vtlLandingSites 缺少 MAIN 主起降点")
  if (!landingSites.some((site) => site.type === "ALTERNATE")) fail("vtlLandingSites 缺少 ALTERNATE 备降点")
  const landingSiteById = new Map(landingSites.map((site) => [site.id, site]))
  for (const site of landingSites) {
    for (const relatedId of site.relatedAlternateSiteIds) {
      const related = landingSiteById.get(relatedId)
      if (!related || related.type !== "ALTERNATE") fail(`vtlLandingSites.${site.code}.relatedAlternateSiteIds`)
    }
  }
  if (boundary.length < 3) fail("boundary")
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} 不能重复`)
}

function pointInsideBoundary(point: V3Coordinate, boundary: readonly V3Coordinate[]): boolean {
  if (boundary.some((vertex, index) => pointOnSegment(point, vertex, boundary[(index + 1) % boundary.length]!))) return true
  let inside = false
  for (let index = 0, previous = boundary.length - 1; index < boundary.length; previous = index++) {
    const current = boundary[index]!
    const prior = boundary[previous]!
    const intersects = ((current.latitude > point.latitude) !== (prior.latitude > point.latitude))
      && point.longitude < (prior.longitude - current.longitude) * (point.latitude - current.latitude) / (prior.latitude - current.latitude) + current.longitude
    if (intersects) inside = !inside
  }
  return inside
}

function pointOnSegment(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): boolean {
  const cross = (point.latitude - start.latitude) * (end.longitude - start.longitude)
    - (point.longitude - start.longitude) * (end.latitude - start.latitude)
  if (Math.abs(cross) > 1e-10) return false
  return point.longitude >= Math.min(start.longitude, end.longitude) - 1e-10
    && point.longitude <= Math.max(start.longitude, end.longitude) + 1e-10
    && point.latitude >= Math.min(start.latitude, end.latitude) - 1e-10
    && point.latitude <= Math.max(start.latitude, end.latitude) + 1e-10
}

function readVtlAircraftParameters(value: unknown): VtlAircraftParameters {
  const object = readObject(value, "vtlAircraftParameters")
  return {
    modelCode: readString(object.modelCode, "vtlAircraftParameters.modelCode"),
    version: readString(object.version, "vtlAircraftParameters.version"),
    batteryCapacityWh: readPositiveNumber(object.batteryCapacityWh, "vtlAircraftParameters.batteryCapacityWh"),
    reserveEnergyRatio: readRatio(object.reserveEnergyRatio, "vtlAircraftParameters.reserveEnergyRatio"),
    verticalPowerWatts: readPositiveNumber(object.verticalPowerWatts, "vtlAircraftParameters.verticalPowerWatts"),
    hoverPowerWatts: readPositiveNumber(object.hoverPowerWatts, "vtlAircraftParameters.hoverPowerWatts"),
    cruisePowerWatts: readPositiveNumber(object.cruisePowerWatts, "vtlAircraftParameters.cruisePowerWatts"),
    taskPowerWatts: readPositiveNumber(object.taskPowerWatts, "vtlAircraftParameters.taskPowerWatts"),
    climbSpeedMps: readPositiveNumber(object.climbSpeedMps, "vtlAircraftParameters.climbSpeedMps"),
    cruiseSpeedMps: readPositiveNumber(object.cruiseSpeedMps, "vtlAircraftParameters.cruiseSpeedMps"),
    transitionSpeedMps: readPositiveNumber(object.transitionSpeedMps, "vtlAircraftParameters.transitionSpeedMps"),
    minimumTransitionHeightMeters: readPositiveNumber(object.minimumTransitionHeightMeters, "vtlAircraftParameters.minimumTransitionHeightMeters"),
    maximumOperatingAltitudeMeters: readPositiveNumber(object.maximumOperatingAltitudeMeters, "vtlAircraftParameters.maximumOperatingAltitudeMeters")
  }
}

function readNumber(value: unknown, label: string): number {
  const number = Number(value)
  return Number.isFinite(number) ? number : fail(label)
}

function readPositiveNumber(value: unknown, label: string): number {
  const number = readNumber(value, label)
  return number > 0 ? number : fail(label)
}

function readRatio(value: unknown, label: string): number {
  const number = readNumber(value, label)
  return number >= 0 && number < 1 ? number : fail(label)
}

function readLayerCode(value: unknown): V3RegionLayerCode {
  return typeof value === "string" && (v3RegionLayerCodes as readonly string[]).includes(value)
    ? value as V3RegionLayerCode
    : fail("layer.code")
}

function readLayerState(value: unknown): V3RegionLayerState {
  return value === "AVAILABLE" || value === "DEGRADED" || value === "UNAVAILABLE" ? value : fail("layer.state")
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) return fail(label)
  return value.trim()
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) return fail(label)
  return value
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail(label)
  return value as Record<string, unknown>
}

function fail(label: string): never {
  throw new Error(`区域包字段无效：${label}`)
}
