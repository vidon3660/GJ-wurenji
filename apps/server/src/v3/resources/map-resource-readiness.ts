import { createHash } from "node:crypto"
import { readdir, readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import type {
  V3EnvironmentDiagnostics,
  V3MapResourceKind,
  V3MapResourceReadinessCheck,
  V3RegionLayerDefinition,
  V3RegionCatalogItem
} from "@wurenji/shared"
import { resolveMapDataPath } from "../../config/runtime-paths.js"

interface MapResourceManifest {
  terrain?: { sha256?: unknown; version?: unknown }
  imagery?: { sha256?: unknown; version?: unknown }
}

export async function checkRegionMapReadiness(
  region: Pick<V3RegionCatalogItem, "packageId" | "packageVersion" | "regionCode" | "heightDatum" | "terrainResourceVersion" | "terrain" | "imagery" | "boundary"> & { layers?: V3RegionLayerDefinition[] },
  mapRoot = resolveMapDataPath()
) {
  const checks: V3MapResourceReadinessCheck[] = []
  const root = resolve(mapRoot)
  const regionRoot = resolve(root, "regions", region.regionCode)
  if (!isInside(regionRoot, resolve(root, "regions"))) {
    const message = "区域编码不能解析为地图目录"
    checks.push(invalid("TERRAIN", null, null, region.terrain?.sha256 ?? null, message))
    checks.push(invalid("IMAGERY", null, null, region.imagery?.sha256 ?? null, message))
    checks.push(invalid("ELEVATION_SNAPSHOT", null, null, region.terrain?.elevationSampleSha256 ?? null, message))
    return {
      regionPackageId: region.packageId,
      regionCode: region.regionCode,
      packageVersion: region.packageVersion,
      checkedAt: new Date().toISOString(),
      formalReady: false,
      checks,
      environmentDiagnostics: diagnoseEnvironment(region.layers)
    }
  }
  const mapManifest = await readMapManifest(join(regionRoot, "manifest.json"))

  checks.push(await checkTerrain(region.terrain ?? null, region, regionRoot, root, mapManifest))
  checks.push(await checkImagery(region.imagery ?? null, regionRoot, root, mapManifest))
  checks.push(await checkElevationSnapshot(region.terrain ?? null, region, regionRoot, root))

  return {
    regionPackageId: region.packageId,
    regionCode: region.regionCode,
    packageVersion: region.packageVersion,
    checkedAt: new Date().toISOString(),
    formalReady: checks.every((check) => !check.required || check.status === "READY"),
    checks,
    environmentDiagnostics: diagnoseEnvironment(region.layers)
  }
}

/** Reads the authoritative offline elevation snapshot and returns the nearest sample. */
export async function sampleRegionElevation(
  terrain: NonNullable<V3RegionCatalogItem["terrain"]> | null | undefined,
  coordinate: { longitude: number; latitude: number },
  mapRoot = resolveMapDataPath()
): Promise<number | null> {
  if (!terrain?.elevationSampleUrl || !Number.isFinite(coordinate.longitude) || !Number.isFinite(coordinate.latitude)) return null
  if (!insideExtent(coordinate, terrain.extent)) return null
  const localPath = localMapPath(terrain.elevationSampleUrl, mapRoot)
  if (!localPath) return null
  try {
    const value = JSON.parse(await readFile(localPath, "utf8")) as Record<string, unknown> | unknown[]
    const samples = Array.isArray(value) ? value : value.samples
    if (!Array.isArray(samples)) return null
    const normalized = samples.map(normalizeElevationSample).filter((sample): sample is { longitude: number; latitude: number; heightMeters: number } => sample !== null)
      .filter((sample) => insideExtent(sample, terrain.extent))
    if (normalized.length === 0) return null
    return normalized.reduce((closest, sample) => {
      const distance = (sample.longitude - coordinate.longitude) ** 2 + (sample.latitude - coordinate.latitude) ** 2
      return distance < closest.distance ? { distance, height: sample.heightMeters } : closest
    }, { distance: Number.POSITIVE_INFINITY, height: null as number | null }).height
  } catch {
    return null
  }
}

function diagnoseEnvironment(layers: V3RegionLayerDefinition[] | undefined): V3EnvironmentDiagnostics {
  const layer = layers?.find((candidate) => candidate.code === "BUILDINGS")
  if (!layer) {
    return {
      status: "UNAVAILABLE",
      layerPresent: false,
      buildingCount: 0,
      obstacleCount: 0,
      missingHeightCount: 0,
      authoritativeSourceDeclared: false,
      source: null,
      version: null,
      message: "未找到 BUILDINGS 环境图层，无法判断建筑物和障碍物数据"
    }
  }
  const obstacles = layer.features.filter((feature) => String(feature.properties.category ?? "").toUpperCase() === "OBSTACLE")
  const buildings = layer.features.filter((feature) => String(feature.properties.category ?? "").toUpperCase() !== "OBSTACLE")
  const missingHeightCount = layer.features.filter((feature) => typeof feature.heightMeters !== "number" || !Number.isFinite(feature.heightMeters) || feature.heightMeters <= 0).length
  const authoritativeSourceDeclared = layer.source.trim().length > 0 && layer.version.trim().length > 0
  const complete = buildings.length > 0 && obstacles.length > 0 && missingHeightCount === 0 && authoritativeSourceDeclared
  return {
    status: complete ? "READY" : "INCOMPLETE",
    layerPresent: true,
    buildingCount: buildings.length,
    obstacleCount: obstacles.length,
    missingHeightCount,
    authoritativeSourceDeclared,
    source: layer.source,
    version: layer.version,
    message: complete
      ? `环境图层已包含 ${buildings.length} 个建筑物和 ${obstacles.length} 个障碍物，可用于正式资源进一步验收`
      : "建筑物/障碍物可用于教学表达，但尚未达到正式资源验收"
  }
}

async function checkTerrain(
  terrain: NonNullable<V3RegionCatalogItem["terrain"]> | null,
  region: Pick<V3RegionCatalogItem, "terrainResourceVersion" | "boundary">,
  regionRoot: string,
  mapRoot: string,
  mapManifest: MapResourceManifest | null
): Promise<V3MapResourceReadinessCheck> {
  const kind: V3MapResourceKind = "TERRAIN"
  if (!terrain) return missing(kind, "区域包未配置版本化 DEM 地形资源")
  if (terrain.version !== region.terrainResourceVersion) {
    return invalid(kind, terrain.url, null, terrain.sha256, "区域地形资源版本与 terrainResourceVersion 不一致")
  }
  if (!extentCoversRegion(terrain.extent, region.boundary)) {
    return invalid(kind, terrain.url, null, terrain.sha256, "DEM 覆盖范围无效或未覆盖整个教学区域")
  }
  const localPath = localMapPath(terrain.url, mapRoot)
  if (!localPath) return external(kind, terrain.url, "地形服务为外部地址，未完成本地离线验收")
  const layerPath = await resolveTerrainLayerPath(localPath, regionRoot)
  if (!layerPath) return invalid(kind, terrain.url, localPath, terrain.sha256, "未找到 Cesium quantized-mesh layer.json")
  const terrainRoot = dirname(layerPath)
  if (!(await isInsideAsync(terrainRoot, regionRoot))) return invalid(kind, terrain.url, terrainRoot, terrain.sha256, "DEM 目录必须位于当前区域目录内")
  try {
    const layer = JSON.parse(await readFile(layerPath, "utf8")) as Record<string, unknown>
    const validLayer = (Array.isArray(layer.tiles) && layer.tiles.length > 0)
      || (typeof layer.format === "string" && layer.format.toLowerCase().includes("quantized"))
    if (!validLayer) return invalid(kind, terrain.url, layerPath, terrain.sha256, "layer.json 不是有效的 quantized-mesh 地形清单")
    if (!(await findTerrainTileFile(terrainRoot))) return invalid(kind, terrain.url, terrainRoot, terrain.sha256, "DEM 目录中没有可用的 .terrain 瓦片")
  } catch {
    return invalid(kind, terrain.url, layerPath, terrain.sha256, "layer.json 无法读取或解析")
  }
  const actualSha256 = await directorySha256(terrainRoot)
  if (stringHash(mapManifest?.terrain?.sha256) !== terrain.sha256 || mapManifest?.terrain?.version !== terrain.version || actualSha256 !== terrain.sha256) {
    return invalid(kind, terrain.url, layerPath, terrain.sha256, "DEM 文件树或地图清单 SHA-256 与区域包不一致", actualSha256)
  }
  return ready(kind, terrain.url, layerPath, terrain.sha256, actualSha256, `DEM ${terrain.version} 已就绪（${terrain.verticalDatum}）`)
}

async function checkImagery(
  imagery: NonNullable<V3RegionCatalogItem["imagery"]> | null,
  regionRoot: string,
  mapRoot: string,
  mapManifest: MapResourceManifest | null
): Promise<V3MapResourceReadinessCheck> {
  const kind: V3MapResourceKind = "IMAGERY"
  if (!imagery) return missing(kind, "区域包未配置版本化影像资源")
  if (!isValidExtent(imagery.extent)) {
    return invalid(kind, imagery.url, null, imagery.sha256, "影像覆盖范围无效")
  }
  const localPath = localMapPath(imagery.url, mapRoot)
  if (!localPath) return external(kind, imagery.url, "影像服务为外部地址，未完成本地离线验收")
  if (imagery.provider === "SINGLE_TILE") {
    if (!(await existsFile(localPath)) || !(await isInsideAsync(localPath, rootPath(mapRoot)))) {
      return invalid(kind, imagery.url, localPath, imagery.sha256, "未找到本地单张离线影像文件")
    }
    try {
      const actualSha256 = await fileSha256(localPath)
      if (actualSha256 !== imagery.sha256) {
        return invalid(kind, imagery.url, localPath, imagery.sha256, "单张离线影像 SHA-256 与区域包不一致", actualSha256)
      }
      return ready(kind, imagery.url, localPath, imagery.sha256, actualSha256, `单张影像 ${imagery.version} 已就绪`)
    } catch {
      return invalid(kind, imagery.url, localPath, imagery.sha256, "单张离线影像无法读取")
    }
  }
  const imageryRoot = imageryDirectory(localPath)
  if (!imageryRoot || !(await existsDirectory(imageryRoot)) || !(await isInsideAsync(imageryRoot, regionRoot))) {
    return invalid(kind, imagery.url, imageryRoot, imagery.sha256, "未找到区域目录内的离线影像瓦片目录")
  }
  if (!(await findTileFile(imageryRoot))) {
    return invalid(kind, imagery.url, imageryRoot, imagery.sha256, "离线影像目录中没有可用瓦片")
  }
  const actualSha256 = await directorySha256(imageryRoot)
  if (stringHash(mapManifest?.imagery?.sha256) !== imagery.sha256 || mapManifest?.imagery?.version !== imagery.version || actualSha256 !== imagery.sha256) {
    return invalid(kind, imagery.url, imageryRoot, imagery.sha256, "影像文件树或地图清单 SHA-256 与区域包不一致", actualSha256)
  }
  return ready(kind, imagery.url, imageryRoot, imagery.sha256, actualSha256, `影像 ${imagery.version} 已就绪`)
}

async function checkElevationSnapshot(
  terrain: NonNullable<V3RegionCatalogItem["terrain"]> | null,
  region: Pick<V3RegionCatalogItem, "boundary">,
  regionRoot: string,
  mapRoot: string
): Promise<V3MapResourceReadinessCheck> {
  const kind: V3MapResourceKind = "ELEVATION_SNAPSHOT"
  if (!terrain?.elevationSampleUrl) return missing(kind, "区域包未配置高程采样快照")
  const localPath = localMapPath(terrain.elevationSampleUrl, mapRoot)
  if (!localPath) return external(kind, terrain.elevationSampleUrl, "高程采样快照为外部地址，不能作为本地数据")
  if (!(await isInsideAsync(localPath, regionRoot))) return invalid(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256 ?? null, "高程快照必须位于当前区域目录内")
  try {
    const content = await readFile(localPath, "utf8")
    const value = JSON.parse(content) as Record<string, unknown> | unknown[]
    const samples = Array.isArray(value) ? value : value.samples
    if (!Array.isArray(samples) || samples.length === 0) return invalid(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256 ?? null, "高程快照必须包含非空 samples 数组")
    const normalizedSamples = samples.map((sample) => normalizeElevationSample(sample))
    if (normalizedSamples.some((sample) => sample === null)) return invalid(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256 ?? null, "高程快照包含非法经纬度或高程值")
    if (normalizedSamples.some((sample) => !insideExtent(sample!, terrain.extent))) return invalid(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256 ?? null, "高程快照包含超出 DEM 覆盖范围的采样点")
    if (!region.boundary.every((point) => insideExtent(point, terrain.extent))) return invalid(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256 ?? null, "DEM 覆盖范围未覆盖区域边界")
    const actualSha256 = sha256(Buffer.from(content, "utf8"))
    if (!terrain.elevationSampleSha256 || terrain.elevationSampleSha256 !== actualSha256) {
      return invalid(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256 ?? null, "高程快照 SHA-256 缺失或不一致", actualSha256)
    }
    return ready(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256, actualSha256, `高程采样快照已就绪，共 ${samples.length} 个采样点`)
  } catch {
    return invalid(kind, terrain.elevationSampleUrl, localPath, terrain.elevationSampleSha256 ?? null, "高程快照无法读取或解析")
  }
}

async function readMapManifest(path: string): Promise<MapResourceManifest | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as MapResourceManifest : null
  } catch {
    return null
  }
}

async function resolveTerrainLayerPath(localPath: string, regionRoot: string): Promise<string | null> {
  const candidate = localPath.toLowerCase().endsWith("layer.json") ? localPath : join(localPath, "layer.json")
  return await existsFile(candidate) && await isInsideAsync(candidate, regionRoot) ? candidate : null
}

function localMapPath(url: string, mapRoot: string): string | null {
  try {
    const parsed = new URL(url, "http://local.map")
    if (parsed.origin !== "http://local.map" || !parsed.pathname.startsWith("/map/")) return null
    const relativePath = decodeURIComponent(parsed.pathname.slice("/map/".length))
    if (!relativePath || relativePath.includes("\\") || relativePath.split("/").includes("..")) return null
    const result = resolve(mapRoot, relativePath)
    return isInside(result, resolve(mapRoot)) ? result : null
  } catch {
    return null
  }
}

function imageryDirectory(localPath: string): string | null {
  const marker = localPath.search(/\{z\}|\{x\}|\{y\}|\{reverseY\}/i)
  if (marker < 0) return localPath
  return localPath.slice(0, marker).replace(/[\\/]$/, "")
}

async function findTileFile(directory: string): Promise<string | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = await findTileFile(path)
        if (nested) return nested
      } else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) return path
    }
  } catch {
    return null
  }
  return null
}

async function findTerrainTileFile(directory: string): Promise<string | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const nested = await findTerrainTileFile(path)
        if (nested) return nested
      } else if (/\.terrain$/i.test(entry.name)) return path
    }
  } catch {
    return null
  }
  return null
}

async function directorySha256(directory: string): Promise<string | null> {
  const files: string[] = []
  await collectFiles(directory, directory, files)
  if (files.length === 0) return null
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

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}

function rootPath(mapRoot: string): string {
  return resolve(mapRoot)
}

async function collectFiles(directory: string, root: string, files: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collectFiles(path, root, files)
    else if (entry.isFile()) files.push(path)
  }
}

async function existsFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile() } catch { return false }
}

async function existsDirectory(path: string | null): Promise<boolean> {
  if (!path) return false
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function isInsideAsync(path: string, root: string): Promise<boolean> {
  return isInside(path, root)
}

function isInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path))
  return relativePath === "" || (!relativePath.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) && !isAbsolute(relativePath))
}

function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex") }
function stringHash(value: unknown): string | null { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null }

function normalizeElevationSample(value: unknown): { longitude: number; latitude: number; heightMeters: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const sample = value as Record<string, unknown>
  const longitude = Number(sample.longitude)
  const latitude = Number(sample.latitude)
  const heightMeters = Number(sample.heightMeters ?? sample.elevationMeters)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(heightMeters)) return null
  return { longitude, latitude, heightMeters }
}

function insideExtent(point: { longitude: number; latitude: number }, extent: readonly [number, number, number, number]): boolean {
  return point.longitude >= extent[0]! && point.longitude <= extent[2]! && point.latitude >= extent[1]! && point.latitude <= extent[3]!
}

function isValidExtent(extent: readonly [number, number, number, number] | undefined): boolean {
  return Boolean(extent
    && extent.length === 4
    && Number.isFinite(extent[0])
    && Number.isFinite(extent[1])
    && Number.isFinite(extent[2])
    && Number.isFinite(extent[3])
    && extent[0] >= -180
    && extent[2] <= 180
    && extent[1] >= -90
    && extent[3] <= 90
    && extent[0] < extent[2]
    && extent[1] < extent[3])
}

function extentCoversRegion(
  extent: readonly [number, number, number, number] | undefined,
  boundary: readonly { longitude: number; latitude: number }[]
): boolean {
  return isValidExtent(extent) && boundary.length >= 3 && boundary.every((point) => insideExtent(point, extent!))
}

function ready(kind: V3MapResourceKind, url: string, localPath: string, expectedSha256: string, actualSha256: string | null, message: string): V3MapResourceReadinessCheck {
  return { kind, status: "READY", required: true, message, url, localPath, expectedSha256, actualSha256 }
}

function missing(kind: V3MapResourceKind, message: string): V3MapResourceReadinessCheck {
  return { kind, status: "UNCONFIGURED", required: true, message, url: null, localPath: null, expectedSha256: null, actualSha256: null }
}

function external(kind: V3MapResourceKind, url: string, message: string): V3MapResourceReadinessCheck {
  return { kind, status: "EXTERNAL", required: true, message, url, localPath: null, expectedSha256: null, actualSha256: null }
}

function invalid(kind: V3MapResourceKind, url: string | null, localPath: string | null, expectedSha256: string | null, message: string, actualSha256: string | null = null): V3MapResourceReadinessCheck {
  return { kind, status: "INVALID", required: true, message, url, localPath, expectedSha256, actualSha256 }
}
