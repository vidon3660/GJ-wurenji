import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"

const main = async () => {
  const argumentsByName = parseArguments(process.argv.slice(2))
  const configPath = resolveRequired(argumentsByName.config, "--config")
  const configDirectory = dirname(configPath)
  const config = JSON.parse(await readFile(configPath, "utf8"))
  const outputRoot = resolve(argumentsByName["output-root"] ?? "data/map")
  const dryRun = argumentsByName["dry-run"] === "true" || argumentsByName["dry-run"] === "1"
  const force = argumentsByName.force === "true" || argumentsByName.force === "1"
  const result = await importMapRegion({ config, configDirectory, outputRoot, force, dryRun })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

export async function importMapRegion({ config, configDirectory, outputRoot, force = false, dryRun = false }) {
  const normalized = await validateConfig(config, configDirectory)
  const destination = join(outputRoot, "regions", normalized.regionCode)
  if (await exists(destination) && !force && !dryRun) {
    throw new Error(`目标区域已存在：${destination}；如需替换请显式传入 --force`)
  }

  const hashes = {
    terrain: await directorySha256(normalized.terrain.sourceDirectory),
    imagery: await directorySha256(normalized.imagery.sourceDirectory),
    elevationSnapshot: sha256(normalized.elevationSamples.content)
  }
  const extent = boundingExtent(normalized.boundary)
  const mapManifest = createMapManifest(normalized, hashes, extent)
  const descriptor = createRegionDescriptor(normalized, hashes, extent)
  if (dryRun) {
    return {
      dryRun: true,
      regionCode: normalized.regionCode,
      destination,
      terrainSha256: hashes.terrain,
      imagerySha256: hashes.imagery,
      elevationSampleSha256: hashes.elevationSnapshot,
      descriptor
    }
  }

  await mkdir(outputRoot, { recursive: true })
  const stagingRoot = await mkdtemp(join(outputRoot, ".map-region-import-"))
  const stagedRegion = join(stagingRoot, normalized.regionCode)
  try {
    await mkdir(stagedRegion, { recursive: true })
    await copyDirectory(normalized.terrain.sourceDirectory, join(stagedRegion, "terrain"))
    await copyDirectory(normalized.imagery.sourceDirectory, join(stagedRegion, "imagery"))
    await writeFile(join(stagedRegion, "elevation-samples.json"), normalized.elevationSamples.content)
    await writeFile(join(stagedRegion, "manifest.json"), `${JSON.stringify(mapManifest, null, 2)}\n`)
    await mkdir(join(stagedRegion, "package", "payload"), { recursive: true })
    await writeFile(join(stagedRegion, "package", "payload", "region-manifest.json"), `${JSON.stringify(mapManifest, null, 2)}\n`)
    await writeFile(join(stagedRegion, "package", "payload", "elevation-samples.json"), normalized.elevationSamples.content)
    await writeFile(join(stagedRegion, "package", "region-package.json"), `${JSON.stringify(descriptor, null, 2)}\n`)

    await mkdir(dirname(destination), { recursive: true })
    await replaceDestination(stagedRegion, destination, force)
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }

  return {
    dryRun: false,
    regionCode: normalized.regionCode,
    destination,
    mapManifest: join(destination, "manifest.json"),
    descriptor: join(destination, "package", "region-package.json"),
    terrainSha256: hashes.terrain,
    imagerySha256: hashes.imagery,
    elevationSampleSha256: hashes.elevationSnapshot,
    next: `node scripts/build-resource-package.mjs --manifest "${join(destination, "package", "region-package.json")}" --source-dir "${join(destination, "package")}" --private-key <key> --key-id <key-id>`
  }
}

async function validateConfig(value, configDirectory) {
  const config = plainObject(value, "配置")
  const regionCode = stringValue(config.regionCode, "regionCode")
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,79}$/.test(regionCode)) throw new Error("regionCode 只能使用字母、数字、下划线和短横线")
  const sceneType = stringValue(config.sceneType, "sceneType")
  if (sceneType !== "CITY_SHOW" && sceneType !== "CITY_LOGISTICS" && sceneType !== "VTOL_INSPECTION") throw new Error("sceneType 必须是 CITY_SHOW、CITY_LOGISTICS 或 VTOL_INSPECTION")
  const title = stringValue(config.title, "title")
  const summary = stringValue(config.summary, "summary")
  const version = stringValue(config.version, "version")
  if (!isSemanticVersion(version)) throw new Error("version 必须使用语义版本，例如 1.0.0")
  const heightDatum = stringValue(config.heightDatum, "heightDatum")
  if (heightDatum !== "AGL" && heightDatum !== "AMSL") throw new Error("heightDatum 必须是 AGL 或 AMSL")
  const center = coordinate(config.center, "center")
  const boundary = coordinates(config.boundary, "boundary", 3)
  const extent = boundingExtent(boundary)
  if (!insideBoundary(center, boundary)) {
    throw new Error("center 必须位于 boundary 范围内")
  }
  const layers = await readLayers(config, configDirectory)
  const terrain = await validateTerrain(config.terrain, configDirectory)
  const imagery = await validateImagery(config.imagery, configDirectory)
  const elevationSamples = await readElevationSamples(config.elevationSamplesPath, configDirectory, boundary)
  const authorization = validateAuthorization(config.authorization)
  const logisticsNodes = config.logisticsNodes === undefined ? undefined : config.logisticsNodes
  const vtl = sceneType === "VTOL_INSPECTION"
    ? await validateVtlResources(config, configDirectory, boundary)
    : {}
  return { regionCode, sceneType, title, summary, version, heightDatum, center, boundary, layers, terrain, imagery, elevationSamples, authorization, logisticsNodes, ...vtl }
}

async function validateVtlResources(config, configDirectory, boundary) {
  const taskObjects = await readJsonInput(config.vtlTaskObjects, config.vtlTaskObjectsPath, configDirectory, "vtlTaskObjects")
  const landingSites = await readJsonInput(config.vtlLandingSites, config.vtlLandingSitesPath, configDirectory, "vtlLandingSites")
  const aircraftParameters = await readJsonInput(config.vtlAircraftParameters, config.vtlAircraftParametersPath, configDirectory, "vtlAircraftParameters")
  if (!Array.isArray(taskObjects) || taskObjects.length === 0) throw new Error("VTOL_INSPECTION 必须提供非空 vtlTaskObjects")
  if (!Array.isArray(landingSites) || landingSites.length === 0) throw new Error("VTOL_INSPECTION 必须提供非空 vtlLandingSites")
  const normalizedTaskObjects = taskObjects.map((value, index) => normalizeVtlTaskObject(value, index, boundary))
  const normalizedLandingSites = landingSites.map((value, index) => normalizeVtlLandingSite(value, index, boundary))
  assertUnique(normalizedTaskObjects.map((item) => item.id), "vtlTaskObjects.id")
  assertUnique(normalizedTaskObjects.map((item) => item.code), "vtlTaskObjects.code")
  assertUnique(normalizedLandingSites.map((item) => item.id), "vtlLandingSites.id")
  assertUnique(normalizedLandingSites.map((item) => item.code), "vtlLandingSites.code")
  if (!normalizedLandingSites.some((item) => item.type === "MAIN")) throw new Error("vtlLandingSites 至少需要一个 MAIN 主起降点")
  if (!normalizedLandingSites.some((item) => item.type === "ALTERNATE")) throw new Error("vtlLandingSites 至少需要一个 ALTERNATE 备降点")
  const landingIds = new Set(normalizedLandingSites.map((item) => item.id))
  for (const site of normalizedLandingSites) {
    if (site.relatedAlternateSiteIds.some((id) => !landingIds.has(id))) throw new Error(`起降点 ${site.code} 关联了不存在的备降点`)
  }
  return {
    vtlTaskObjects: normalizedTaskObjects,
    vtlLandingSites: normalizedLandingSites,
    vtlAircraftParameters: normalizeVtlAircraftParameters(aircraftParameters)
  }
}

async function readJsonInput(value, pathValue, configDirectory, label) {
  if (pathValue !== undefined) {
    const path = resolve(configDirectory, stringValue(pathValue, `${label}Path`))
    try { return JSON.parse(await readFile(path, "utf8")) } catch (error) { throw new Error(`${label}Path 无法读取或解析：${error instanceof Error ? error.message : String(error)}`) }
  }
  return value
}

function normalizeVtlTaskObject(value, index, boundary) {
  const item = plainObject(value, `vtlTaskObjects[${index}]`)
  const type = stringValue(item.type, `vtlTaskObjects[${index}].type`)
  if (!["POINT", "LINE", "AREA"].includes(type)) throw new Error(`vtlTaskObjects[${index}].type 无效`)
  const minimumPositions = type === "POINT" ? 1 : type === "AREA" ? 3 : 2
  const positions = coordinates(item.positions, `vtlTaskObjects[${index}].positions`, minimumPositions, type !== "AREA")
  if (type === "LINE" && new Set(positions.map((point) => `${point.longitude},${point.latitude}`)).size < 2) throw new Error(`vtlTaskObjects[${index}].positions 至少需要两个不同坐标点`)
  if (positions.some((point) => !insideBoundary(point, boundary))) throw new Error(`vtlTaskObjects[${index}] 超出 boundary 覆盖范围`)
  const estimatedWorkSeconds = finiteNumber(item.estimatedWorkSeconds, `vtlTaskObjects[${index}].estimatedWorkSeconds`)
  if (estimatedWorkSeconds <= 0) throw new Error(`vtlTaskObjects[${index}].estimatedWorkSeconds 必须大于 0`)
  return {
    id: stringValue(item.id, `vtlTaskObjects[${index}].id`),
    code: stringValue(item.code, `vtlTaskObjects[${index}].code`),
    title: stringValue(item.title, `vtlTaskObjects[${index}].title`),
    type,
    positions,
    requirement: stringValue(item.requirement, `vtlTaskObjects[${index}].requirement`),
    completionRule: stringValue(item.completionRule, `vtlTaskObjects[${index}].completionRule`),
    required: item.required !== false,
    estimatedWorkSeconds,
    status: "UNASSIGNED",
    incompleteReason: null
  }
}

function normalizeVtlLandingSite(value, index, boundary) {
  const item = plainObject(value, `vtlLandingSites[${index}]`)
  const type = stringValue(item.type, `vtlLandingSites[${index}].type`)
  if (!["MAIN", "ALTERNATE"].includes(type)) throw new Error(`vtlLandingSites[${index}].type 无效`)
  const status = item.status === undefined ? "AVAILABLE" : stringValue(item.status, `vtlLandingSites[${index}].status`)
  if (!["AVAILABLE", "RESTRICTED", "UNAVAILABLE"].includes(status)) throw new Error(`vtlLandingSites[${index}].status 无效`)
  const position = coordinate(item.position, `vtlLandingSites[${index}].position`)
  if (!insideBoundary(position, boundary)) throw new Error(`vtlLandingSites[${index}] 超出 boundary 覆盖范围`)
  const elevationMeters = finiteNumber(item.elevationMeters, `vtlLandingSites[${index}].elevationMeters`)
  const relatedAlternateSiteIds = item.relatedAlternateSiteIds === undefined ? [] : stringArray(item.relatedAlternateSiteIds, `vtlLandingSites[${index}].relatedAlternateSiteIds`)
  return {
    id: stringValue(item.id, `vtlLandingSites[${index}].id`),
    code: stringValue(item.code, `vtlLandingSites[${index}].code`),
    title: stringValue(item.title, `vtlLandingSites[${index}].title`),
    type,
    position,
    elevationMeters,
    status,
    relatedAlternateSiteIds
  }
}

function normalizeVtlAircraftParameters(value) {
  const item = plainObject(value, "vtlAircraftParameters")
  const result = {
    modelCode: stringValue(item.modelCode, "vtlAircraftParameters.modelCode"),
    version: stringValue(item.version, "vtlAircraftParameters.version"),
    batteryCapacityWh: positiveNumber(item.batteryCapacityWh, "vtlAircraftParameters.batteryCapacityWh"),
    reserveEnergyRatio: finiteNumber(item.reserveEnergyRatio, "vtlAircraftParameters.reserveEnergyRatio"),
    verticalPowerWatts: positiveNumber(item.verticalPowerWatts, "vtlAircraftParameters.verticalPowerWatts"),
    hoverPowerWatts: positiveNumber(item.hoverPowerWatts, "vtlAircraftParameters.hoverPowerWatts"),
    cruisePowerWatts: positiveNumber(item.cruisePowerWatts, "vtlAircraftParameters.cruisePowerWatts"),
    taskPowerWatts: positiveNumber(item.taskPowerWatts, "vtlAircraftParameters.taskPowerWatts"),
    climbSpeedMps: positiveNumber(item.climbSpeedMps, "vtlAircraftParameters.climbSpeedMps"),
    cruiseSpeedMps: positiveNumber(item.cruiseSpeedMps, "vtlAircraftParameters.cruiseSpeedMps"),
    transitionSpeedMps: positiveNumber(item.transitionSpeedMps, "vtlAircraftParameters.transitionSpeedMps"),
    minimumTransitionHeightMeters: positiveNumber(item.minimumTransitionHeightMeters, "vtlAircraftParameters.minimumTransitionHeightMeters"),
    maximumOperatingAltitudeMeters: positiveNumber(item.maximumOperatingAltitudeMeters, "vtlAircraftParameters.maximumOperatingAltitudeMeters")
  }
  if (result.reserveEnergyRatio < 0 || result.reserveEnergyRatio >= 1) throw new Error("vtlAircraftParameters.reserveEnergyRatio 必须在 0 到 1 之间")
  return result
}

function positiveNumber(value, label) {
  const result = finiteNumber(value, label)
  if (result <= 0) throw new Error(`${label} 必须大于 0`)
  return result
}

function stringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  return value.map((item, index) => stringValue(item, `${label}[${index}]`))
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(`${label} 不能重复`)
}

function insideBoundary(point, boundary) {
  let inside = false
  for (let index = 0, previousIndex = boundary.length - 1; index < boundary.length; previousIndex = index++) {
    const current = boundary[index]
    const previous = boundary[previousIndex]
    if (pointOnSegment(point, previous, current)) return true
    const crosses = (current.latitude > point.latitude) !== (previous.latitude > point.latitude)
    if (crosses && point.longitude < (previous.longitude - current.longitude) * (point.latitude - current.latitude) / (previous.latitude - current.latitude) + current.longitude) inside = !inside
  }
  return inside
}

function pointOnSegment(point, start, end) {
  const cross = (point.latitude - start.latitude) * (end.longitude - start.longitude) - (point.longitude - start.longitude) * (end.latitude - start.latitude)
  if (Math.abs(cross) > 1e-10) return false
  return point.longitude >= Math.min(start.longitude, end.longitude) - 1e-10
    && point.longitude <= Math.max(start.longitude, end.longitude) + 1e-10
    && point.latitude >= Math.min(start.latitude, end.latitude) - 1e-10
    && point.latitude <= Math.max(start.latitude, end.latitude) + 1e-10
}

async function validateTerrain(value, configDirectory) {
  const terrain = plainObject(value, "terrain")
  const sourcePath = resolve(configDirectory, stringValue(terrain.sourceDir, "terrain.sourceDir"))
  const sourceFormat = stringValue(terrain.sourceFormat ?? "CESIUM_QUANTIZED_MESH", "terrain.sourceFormat")
  if (sourceFormat !== "CESIUM_QUANTIZED_MESH") throw new Error("terrain.sourceFormat 必须是 CESIUM_QUANTIZED_MESH")
  if (/[.]tiff?$/i.test(sourcePath)) throw new Error("普通 GeoTIFF 不能直接导入；请先转换为 WGS84 Cesium quantized-mesh，并提供包含 layer.json 与 .terrain 瓦片的目录")
  const sourceCrs = stringValue(terrain.sourceCrs ?? "WGS84", "terrain.sourceCrs")
  if (sourceCrs.toUpperCase() !== "WGS84") throw new Error("terrain.sourceCrs 必须是 WGS84；请在导入前完成投影转换")
  const version = stringValue(terrain.version, "terrain.version")
  if (!isSemanticVersion(version)) throw new Error("terrain.version 必须使用语义版本")
  const verticalDatum = stringValue(terrain.verticalDatum, "terrain.verticalDatum")
  if (verticalDatum !== "AMSL" && verticalDatum !== "ELLIPSOID") throw new Error("terrain.verticalDatum 必须是 AMSL 或 ELLIPSOID")
  const conversion = plainObject(terrain.conversion, "terrain.conversion")
  await validateTerrainDirectory(sourcePath)
  return { sourceDirectory: sourcePath, sourceFormat, sourceCrs: "WGS84", version, verticalDatum, conversion: { tool: stringValue(conversion.tool, "terrain.conversion.tool"), version: stringValue(conversion.version, "terrain.conversion.version") } }
}

async function validateImagery(value, configDirectory) {
  const imagery = plainObject(value, "imagery")
  const sourceDirectory = resolve(configDirectory, stringValue(imagery.sourceDir, "imagery.sourceDir"))
  const provider = stringValue(imagery.provider ?? "XYZ", "imagery.provider")
  if (provider !== "XYZ" && provider !== "TMS") throw new Error("imagery.provider 必须是 XYZ 或 TMS")
  const sourceCrs = stringValue(imagery.sourceCrs ?? "WGS84", "imagery.sourceCrs")
  if (sourceCrs.toUpperCase() !== "WGS84") throw new Error("imagery.sourceCrs 必须是 WGS84")
  const version = stringValue(imagery.version, "imagery.version")
  if (!isSemanticVersion(version)) throw new Error("imagery.version 必须使用语义版本")
  const tileExtension = normalizeTileExtension(imagery.tileExtension ?? ".png")
  await validateImageryDirectory(sourceDirectory)
  return { sourceDirectory, provider, sourceCrs: "WGS84", version, tileExtension }
}

async function readElevationSamples(value, configDirectory, boundary) {
  const path = resolve(configDirectory, stringValue(value, "elevationSamplesPath"))
  if (/[.]tiff?$/i.test(path)) throw new Error("高程快照必须是 JSON，不能直接使用 GeoTIFF")
  const content = await readFile(path, "utf8")
  let parsed
  try { parsed = JSON.parse(content) } catch { throw new Error("elevationSamplesPath 不是有效 JSON") }
  const samples = Array.isArray(parsed) ? parsed : plainObject(parsed, "elevation samples").samples
  if (!Array.isArray(samples) || samples.length === 0) throw new Error("高程快照必须包含非空 samples 数组")
  for (const [index, sample] of samples.entries()) {
    const point = coordinate(sample, `samples[${index}]`)
    const heightMeters = Number(plainObject(sample, `samples[${index}]`).heightMeters)
    if (!Number.isFinite(heightMeters)) throw new Error(`samples[${index}].heightMeters 必须是有限数字`)
    if (!insideBoundary(point, boundary)) {
      throw new Error(`samples[${index}] 超出 boundary 覆盖范围`)
    }
  }
  return { content: `${JSON.stringify(Array.isArray(parsed) ? { samples } : parsed, null, 2)}\n`, count: samples.length }
}

async function readLayers(config, configDirectory) {
  let value = config.layers
  if (config.layersPath !== undefined) value = JSON.parse(await readFile(resolve(configDirectory, stringValue(config.layersPath, "layersPath")), "utf8"))
  if (!Array.isArray(value)) throw new Error("必须提供 layers 数组或 layersPath")
  const expected = ["BUILDINGS", "RESTRICTIONS", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"]
  const layers = value.map((layer, index) => {
    const item = plainObject(layer, `layers[${index}]`)
    const code = stringValue(item.code, `layers[${index}].code`)
    if (!expected.includes(code)) throw new Error(`layers[${index}].code 不是受支持的专题图层`)
    const features = item.features === undefined ? [] : item.features
    if (!Array.isArray(features)) throw new Error(`layers[${index}].features 必须是数组`)
    return {
      code,
      title: stringValue(item.title ?? code, `layers[${index}].title`),
      state: item.state === undefined ? "AVAILABLE" : stringValue(item.state, `layers[${index}].state`),
      source: stringValue(item.source ?? "授权专题数据", `layers[${index}].source`),
      version: stringValue(item.version ?? "1.0.0", `layers[${index}].version`),
      features
    }
  })
  for (const layer of layers) {
    if (!["AVAILABLE", "DEGRADED", "UNAVAILABLE"].includes(layer.state)) throw new Error(`专题图层 ${layer.code} 的 state 无效`)
    if (!isSemanticVersion(layer.version)) throw new Error(`专题图层 ${layer.code} 的 version 必须使用语义版本`)
  }
  if (new Set(layers.map((layer) => layer.code)).size !== expected.length || expected.some((code) => !layers.some((layer) => layer.code === code))) {
    throw new Error("layers 必须且只能包含 BUILDINGS、RESTRICTIONS、POSITIONING、COMMUNICATION、ENVIRONMENT 五类图层")
  }
  return layers
}

function validateAuthorization(value) {
  const authorization = plainObject(value, "authorization")
  const validUntil = stringValue(authorization.validUntil, "authorization.validUntil")
  if (!Number.isFinite(Date.parse(validUntil))) throw new Error("authorization.validUntil 必须是有效日期")
  if (Date.parse(validUntil) < Date.now()) throw new Error("授权已过期，不能导入为正式地图资源")
  return {
    provider: stringValue(authorization.provider, "authorization.provider"),
    authorizationId: stringValue(authorization.authorizationId, "authorization.authorizationId"),
    validUntil,
    sourceDescription: stringValue(authorization.sourceDescription, "authorization.sourceDescription")
  }
}

function createMapManifest(config, hashes, extent) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    regionCode: config.regionCode,
    coordinateReferenceSystem: "WGS84",
    heightDatum: config.heightDatum,
    authorization: config.authorization,
    terrain: {
      version: config.terrain.version,
      sha256: hashes.terrain,
      verticalDatum: config.terrain.verticalDatum,
      extent,
      provider: "CESIUM_QUANTIZED_MESH",
      conversion: config.terrain.conversion
    },
    imagery: {
      provider: config.imagery.provider,
      version: config.imagery.version,
      sha256: hashes.imagery,
      extent,
      tileExtension: config.imagery.tileExtension
    },
    elevationSnapshot: {
      path: "elevation-samples.json",
      sha256: hashes.elevationSnapshot,
      sampleCount: config.elevationSamples.count
    }
  }
}

function createRegionDescriptor(config, hashes, extent) {
  const root = `/map/regions/${config.regionCode}`
  return {
    packageType: "REGION",
    name: `${config.title}区域资源`,
    version: config.version,
    schemaVersion: 1,
    minimumPlatformVersion: "0.1.0",
    keyId: "REPLACE_WITH_SIGNING_KEY_ID",
    content: {
      catalogVersion: 1,
      sceneType: config.sceneType,
      regionCode: config.regionCode,
      title: config.title,
      summary: config.summary,
      center: config.center,
      boundary: config.boundary,
      heightDatum: config.heightDatum,
      terrainResourceVersion: config.terrain.version,
      terrain: {
        provider: "CESIUM_QUANTIZED_MESH",
        url: `${root}/terrain`,
        version: config.terrain.version,
        sha256: hashes.terrain,
        verticalDatum: config.terrain.verticalDatum,
        extent,
        elevationSampleUrl: `${root}/elevation-samples.json`,
        elevationSampleSha256: hashes.elevationSnapshot
      },
      imagery: {
        provider: config.imagery.provider,
        url: `${root}/imagery/{z}/{x}/{y}${config.imagery.tileExtension}`,
        version: config.imagery.version,
        sha256: hashes.imagery,
        extent
      },
      imageryState: "AVAILABLE",
      layers: config.layers,
      ...(config.logisticsNodes === undefined ? {} : { logisticsNodes: config.logisticsNodes }),
      ...(config.vtlTaskObjects === undefined ? {} : { vtlTaskObjects: config.vtlTaskObjects }),
      ...(config.vtlLandingSites === undefined ? {} : { vtlLandingSites: config.vtlLandingSites }),
      ...(config.vtlAircraftParameters === undefined ? {} : { vtlAircraftParameters: config.vtlAircraftParameters })
    },
    files: [
      { path: "payload/region-manifest.json", source: "payload/region-manifest.json", role: "REGION_MAP_MANIFEST", mimeType: "application/json" },
      { path: "payload/elevation-samples.json", source: "payload/elevation-samples.json", role: "ELEVATION_SNAPSHOT", mimeType: "application/json" }
    ]
  }
}

async function copyDirectory(source, destination) {
  const sourceStat = await stat(source).catch(() => null)
  if (!sourceStat?.isDirectory()) throw new Error(`资源目录不存在或不是目录：${source}`)
  await mkdir(destination, { recursive: true })
  await copyDirectoryEntries(source, destination)
}

async function validateTerrainDirectory(directory) {
  const sourceStat = await stat(directory).catch(() => null)
  if (!sourceStat?.isDirectory()) throw new Error(`terrain.sourceDir 不存在或不是目录：${directory}`)
  const layerPath = join(directory, "layer.json")
  const layerStat = await stat(layerPath).catch(() => null)
  if (!layerStat?.isFile()) throw new Error(`terrain.sourceDir 缺少 layer.json：${directory}`)
  let layer
  try { layer = JSON.parse(await readFile(layerPath, "utf8")) } catch { throw new Error("terrain/layer.json 不是有效 JSON") }
  const validLayer = (Array.isArray(layer.tiles) && layer.tiles.length > 0)
    || (typeof layer.format === "string" && layer.format.toLowerCase().includes("quantized"))
  if (!validLayer) throw new Error("terrain/layer.json 不是有效的 quantized-mesh 地形清单")
  const files = []
  await collectFiles(directory, directory, files)
  if (!files.some((file) => /[.]terrain(?:[.]gz)?$/i.test(file))) throw new Error("terrain.sourceDir 至少需要一个 .terrain 或 .terrain.gz 瓦片")
}

async function validateImageryDirectory(directory) {
  const sourceStat = await stat(directory).catch(() => null)
  if (!sourceStat?.isDirectory()) throw new Error(`imagery.sourceDir 不存在或不是目录：${directory}`)
  const files = []
  await collectFiles(directory, directory, files)
  if (!files.some((file) => /[.](png|jpe?g|webp)$/i.test(file))) throw new Error("imagery.sourceDir 至少需要一张 PNG、JPEG 或 WebP 瓦片")
}

function normalizeTileExtension(value) {
  const extension = stringValue(value, "imagery.tileExtension").toLowerCase()
  if (!/^\.(png|jpe?g|webp)$/.test(extension)) throw new Error("imagery.tileExtension 必须是 .png、.jpg、.jpeg 或 .webp")
  return extension
}

async function replaceDestination(stagedRegion, destination, force) {
  if (!(await exists(destination))) {
    await rename(stagedRegion, destination)
    return
  }
  if (!force) throw new Error(`目标区域已存在：${destination}；如需替换请显式传入 --force`)
  const backup = `${destination}.previous-${randomUUID()}`
  await rename(destination, backup)
  try {
    await rename(stagedRegion, destination)
  } catch (error) {
    await rename(backup, destination).catch(() => undefined)
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

async function copyDirectoryEntries(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const destinationPath = join(destination, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`资源目录不允许包含符号链接：${sourcePath}`)
    if (entry.isDirectory()) await copyDirectoryEntries(sourcePath, destinationPath)
    else if (entry.isFile()) await copyFile(sourcePath, destinationPath)
    else throw new Error(`资源目录包含不支持的文件类型：${sourcePath}`)
  }
}

async function directorySha256(directory) {
  const sourceStat = await stat(directory).catch(() => null)
  if (!sourceStat?.isDirectory()) throw new Error(`资源目录不存在或不是目录：${directory}`)
  const files = []
  await collectFiles(directory, directory, files)
  if (files.length === 0) throw new Error(`资源目录为空：${directory}`)
  const hash = createHash("sha256")
  for (const file of files.sort()) {
    const content = await readFile(file)
    const relativePath = relative(directory, file).replaceAll("\\", "/")
    hash.update(relativePath)
    hash.update("\0")
    hash.update(sha256(content))
    hash.update("\n")
  }
  return hash.digest("hex")
}

async function collectFiles(directory, root, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`资源目录不允许包含符号链接：${path}`)
    if (entry.isDirectory()) await collectFiles(path, root, files)
    else if (entry.isFile()) files.push(path)
  }
}

function boundingExtent(points) {
  return [
    Math.min(...points.map((point) => point.longitude)),
    Math.min(...points.map((point) => point.latitude)),
    Math.max(...points.map((point) => point.longitude)),
    Math.max(...points.map((point) => point.latitude))
  ]
}

function coordinate(value, label) {
  const point = plainObject(value, label)
  const longitude = Number(point.longitude)
  const latitude = Number(point.latitude)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error(`${label}.longitude 无效`)
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error(`${label}.latitude 无效`)
  return { longitude, latitude, ...(point.altitudeMeters === undefined ? {} : { altitudeMeters: finiteNumber(point.altitudeMeters, `${label}.altitudeMeters`) }) }
}

function coordinates(value, label, minimumLength, allowDegenerateExtent = false) {
  if (!Array.isArray(value) || value.length < minimumLength) throw new Error(`${label} 至少需要 ${minimumLength} 个坐标点`)
  const points = value.map((item, index) => coordinate(item, `${label}[${index}]`))
  const extent = boundingExtent(points)
  if (!allowDegenerateExtent && (extent[0] === extent[2] || extent[1] === extent[3])) throw new Error(`${label} 必须覆盖非零范围`)
  return points
}

function finiteNumber(value, label) {
  const result = Number(value)
  if (!Number.isFinite(result)) throw new Error(`${label} 必须是有限数字`)
  return result
}

function plainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`)
  return value
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须是非空字符串`)
  return value.trim()
}

function parseArguments(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index]
    if (name === "--force" || name === "--dry-run") {
      result[name.slice(2)] = "true"
      continue
    }
    const value = values[index + 1]
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error(`参数无效：${name ?? ""}`)
    result[name.slice(2)] = value
    index += 1
  }
  return result
}

function resolveRequired(value, name) {
  if (!value?.trim()) throw new Error(`缺少 ${name}`)
  return resolve(value)
}

function isSemanticVersion(value) { return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }
async function exists(path) { return Boolean(await stat(path).catch(() => null)) }

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
