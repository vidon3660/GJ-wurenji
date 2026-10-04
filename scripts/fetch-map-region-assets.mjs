import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { gunzipSync } from "node:zlib"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const DEFAULT_EXTENT = [113.287, 23.067, 113.323, 23.103]
export const DEFAULT_REGION = "gd-north-core"
// Network-derived data is written outside the shipped demo map by default.
// Pass MAP_NETWORK_OUTPUT_DIR when preparing a reviewed resource package.
const DEFAULT_OUTPUT = resolve("data/map/network-sources")
const USER_AGENT = "GJ-wurenji-map-import/1.0 (educational offline asset preparation)"
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
]
const execFileAsync = promisify(execFile)

export async function fetchMapRegionAssets(options = {}) {
  const extent = options.extent ?? DEFAULT_EXTENT
  const region = options.region ?? DEFAULT_REGION
  const outputDirectory = resolve(options.outputDirectory ?? DEFAULT_OUTPUT)
  const sampleGrid = options.sampleGrid ?? 37
  validateExtent(extent)
  if (!Number.isInteger(sampleGrid) || sampleGrid < 2 || sampleGrid > 181) throw new Error("sampleGrid 必须是 2 到 181 的整数")

  const [west, south, east, north] = extent
  const fetchedAt = new Date().toISOString()
  const overpassQuery = `[out:json][timeout:90];way[building](${south},${west},${north},${east});out geom;`
  const overpassResult = await fetchOverpass(overpassQuery)
  const buildings = overpassBuildings(overpassResult.payload.elements ?? [], extent)
  if (buildings.features.length === 0) throw new Error("OSM 返回范围内没有可用建筑多边形")

  const hgtTile = hgtTileFor(south, west)
  if (north > hgtTile.south + 1 || east > hgtTile.west + 1) {
    throw new Error("当前版本只支持落在同一个 1°×1° HGT 瓦片内的 extent")
  }
  const hgtUrl = `https://s3.amazonaws.com/elevation-tiles-prod/skadi/${hgtTile.latitudeName}/${hgtTile.fileName}.hgt.gz`
  const hgtGzip = await fetchBuffer(hgtUrl)
  const hgt = decodeHgt(gunzipSync(hgtGzip), hgtTile)
  const elevation = createElevationSnapshot(hgt, extent, sampleGrid, {
    sourceUrl: hgtUrl,
    sourceDocumentation: "https://github.com/tilezen/joerd/blob/master/docs/formats.md#skadi",
    fetchedAt
  })

  await mkdir(outputDirectory, { recursive: true })
  const buildingsPath = join(outputDirectory, `${region}-buildings-osm.geojson`)
  const elevationPath = join(outputDirectory, `${region}-elevation-samples.json`)
  const hgtPath = join(outputDirectory, `${region}-${hgtTile.fileName}.hgt.gz`)
  const manifestPath = join(outputDirectory, `${region}-network-source.json`)
  await writeFile(buildingsPath, `${JSON.stringify(buildings, null, 2)}\n`, "utf8")
  await writeFile(elevationPath, `${JSON.stringify(elevation, null, 2)}\n`, "utf8")
  await writeFile(hgtPath, hgtGzip)
  const buildingsContent = Buffer.from(JSON.stringify(buildings, null, 2) + "\n")
  const elevationContent = Buffer.from(JSON.stringify(elevation, null, 2) + "\n")
  const sourceManifest = {
    region,
    extent,
    coordinateReference: "EPSG:4326",
    fetchedAt,
    buildings: {
      path: `${region}-buildings-osm.geojson`,
      source: "OpenStreetMap contributors",
      sourceUrl: overpassResult.endpoint,
      query: overpassQuery,
      elementTypes: ["way"],
      coverageNote: "仅提取带 building 标签的闭合 way；复杂 multipolygon relation 需在资源制作阶段另行转换。",
      license: "ODbL 1.0; attribution and share-alike obligations apply",
      featureCount: buildings.features.length,
      sha256: sha256(buildingsContent)
    },
    elevation: {
      path: `${region}-elevation-samples.json`,
      source: "Mapzen Terrain Tiles / Skadi（AWS Open Data Terrain Tiles）",
      sourceUrl: hgtUrl,
      sourceDocumentation: "https://github.com/tilezen/joerd/blob/master/docs/formats.md#skadi",
      rawHgtPath: `${region}-${hgtTile.fileName}.hgt.gz`,
      rawHgtSha256: sha256(hgtGzip),
      sourceGridSize: hgt.size,
      sourceAngularResolutionDegrees: 1 / (hgt.size - 1),
      sourceHeightEncoding: "signed big-endian int16; -32768 is NoData",
      license: "Mapzen/Terrain Tiles source notices and upstream elevation data terms apply",
      verticalDatum: "EGM96_ORTHOMETRIC",
      sampleGrid,
      sampleCount: elevation.samples.length,
      sampling: elevation.sampling,
      sha256: sha256(elevationContent)
    },
    imagery: {
      status: "NOT_DOWNLOADED",
      provider: "OSM_RASTER_OPTIONAL",
      template: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      attribution: "© OpenStreetMap contributors",
      policyUrl: "https://operations.osmfoundation.org/policies/tiles/",
      note: "公共瓦片仅可按政策在线使用；不在本脚本中批量抓取或打包离线影像。"
    },
    terrainTiles: {
      status: "SOURCE_AVAILABLE_NOT_QUANTIZED_MESH",
      terrariumTemplate: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
      geoTiffTemplate: "https://s3.amazonaws.com/elevation-tiles-prod/geotiff/{z}/{x}/{y}.tif",
      note: "这些来源需要在资源制作阶段裁剪、核对基准并转换；不能直接填入 VITE_DEM_TERRAIN_URL。"
    },
    terrain: {
      status: "NOT_QUANTIZED_MESH",
      note: "HGT is retained only as the source for the JSON elevation snapshot. Convert a reviewed DEM to Cesium quantized-mesh before publishing a formal region package."
    }
  }
  await writeFile(manifestPath, `${JSON.stringify(sourceManifest, null, 2)}\n`, "utf8")
  return { buildingsPath, elevationPath, hgtPath, manifestPath, sourceManifest }
}

export function overpassBuildings(elements, extent) {
  const [west, south, east, north] = extent
  const features = []
  for (const element of elements) {
    if (element?.type !== "way" || !Array.isArray(element.geometry) || element.geometry.length < 4) continue
    const coordinates = element.geometry.map((point) => [coordinateNumber(point?.lon, -180, 180), coordinateNumber(point?.lat, -90, 90)])
    if (coordinates.some((point) => point === null)) continue
    const normalizedCoordinates = coordinates
    if (normalizedCoordinates.length < 4 || normalizedCoordinates[0]?.[0] !== normalizedCoordinates.at(-1)?.[0] || normalizedCoordinates[0]?.[1] !== normalizedCoordinates.at(-1)?.[1]) continue
    const distinctVertices = new Set(normalizedCoordinates.slice(0, -1).map(([longitude, latitude]) => `${longitude},${latitude}`))
    if (distinctVertices.size < 3) continue
    const longitudes = normalizedCoordinates.map(([longitude]) => longitude)
    const latitudes = normalizedCoordinates.map(([, latitude]) => latitude)
    if (Math.max(...longitudes) < west || Math.min(...longitudes) > east || Math.max(...latitudes) < south || Math.min(...latitudes) > north) continue
    const tags = element.tags && typeof element.tags === "object" ? element.tags : {}
    const height = parseBuildingHeightDetails(tags)
    features.push({
      type: "Feature",
      id: `osm-building-${element.id}`,
      properties: {
        name: String(tags["name:zh"] ?? tags.name ?? `OSM 建筑 ${element.id}`),
        category: "BUILDING",
        source: "OPENSTREETMAP",
        osmId: element.id,
        ...(height.heightMeters === null ? {} : { height: height.heightMeters }),
        heightSource: height.heightSource,
        heightEstimated: height.heightEstimated,
        ...(height.rawHeight ? { sourceHeight: height.rawHeight } : {}),
        ...(height.rawLevels ? { sourceBuildingLevels: height.rawLevels } : {}),
        ...(tags.building ? { building: String(tags.building) } : {}),
        ...(height.levels === null ? {} : { buildingLevels: height.levels })
      },
      geometry: { type: "Polygon", coordinates: [normalizedCoordinates] }
    })
  }
  return { type: "FeatureCollection", name: "OpenStreetMap buildings", features }
}

export function parseBuildingHeight(tags) {
  return parseBuildingHeightDetails(tags).heightMeters
}

export function parseBuildingHeightDetails(tags) {
  const rawHeight = typeof tags?.height === "string" ? tags.height.trim() : ""
  const direct = parseMeters(rawHeight)
  if (direct !== null) return { heightMeters: direct, heightSource: "OSM_HEIGHT", heightEstimated: false, rawHeight, rawLevels: null, levels: null }
  const rawLevels = typeof tags?.["building:levels"] === "string" ? tags["building:levels"].trim() : ""
  const levelMatch = rawLevels.match(/^(?:0*[1-9][0-9]{0,2})(?:\.0+)?$/)
  const levels = levelMatch ? Number(rawLevels) : null
  if (levels !== null && levels > 0 && levels <= 200) {
    return { heightMeters: Math.round(levels * 3.2 * 10) / 10, heightSource: "ESTIMATED_FROM_LEVELS", heightEstimated: true, rawHeight: rawHeight || null, rawLevels, levels }
  }
  return { heightMeters: null, heightSource: "UNKNOWN", heightEstimated: false, rawHeight: rawHeight || null, rawLevels: rawLevels || null, levels: null }
}

export function decodeHgt(buffer, tile) {
  const size = Math.sqrt(buffer.byteLength / 2)
  if (!Number.isInteger(size) || size < 2) throw new Error("HGT 文件大小不是有效的方形 16 位栅格")
  return { buffer, size, south: tile.south, west: tile.west }
}

export function createElevationSnapshot(hgt, extent, grid, source) {
  const [west, south, east, north] = extent
  const samples = []
  for (let row = 0; row < grid; row += 1) {
    const latitude = south + (north - south) * row / (grid - 1)
    for (let column = 0; column < grid; column += 1) {
      const longitude = west + (east - west) * column / (grid - 1)
      const heightMeters = sampleHgt(hgt, longitude, latitude)
      if (heightMeters === null) throw new Error(`HGT 高程采样缺失：${longitude},${latitude}`)
      samples.push({ longitude: roundCoordinate(longitude), latitude: roundCoordinate(latitude), heightMeters })
    }
  }
  const gridSpacingDegrees = {
    longitude: (east - west) / (grid - 1),
    latitude: (north - south) / (grid - 1)
  }
  return {
    coordinateReference: "EPSG:4326",
    verticalDatum: "EGM96_ORTHOMETRIC",
    extent,
    source,
    sampling: {
      method: "nearest",
      gridRows: grid,
      gridColumns: grid,
      gridSpacingDegrees,
      gridSpacingApproxMeters: {
        longitude: Math.abs(gridSpacingDegrees.longitude) * 111_320 * Math.cos((south + north) / 2 * Math.PI / 180),
        latitude: Math.abs(gridSpacingDegrees.latitude) * 110_574
      },
      sourceGridSize: hgt.size,
      noDataCount: 0
    },
    samples
  }
}

export function sampleHgt(hgt, longitude, latitude) {
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < hgt.west || longitude > hgt.west + 1 || latitude < hgt.south || latitude > hgt.south + 1) return null
  const column = Math.round((longitude - hgt.west) * (hgt.size - 1))
  const row = Math.round((hgt.south + 1 - latitude) * (hgt.size - 1))
  if (column < 0 || column >= hgt.size || row < 0 || row >= hgt.size) return null
  const value = hgt.buffer.readInt16BE((row * hgt.size + column) * 2)
  return value === -32768 ? null : value
}

function hgtTileFor(latitude, longitude) {
  const south = Math.floor(latitude)
  const west = Math.floor(longitude)
  const latitudeName = `${south >= 0 ? "N" : "S"}${String(Math.abs(south)).padStart(2, "0")}`
  const fileName = `${latitudeName}${west >= 0 ? "E" : "W"}${String(Math.abs(west)).padStart(3, "0")}`
  return { south, west, latitudeName, fileName }
}

async function fetchOverpass(query) {
  let lastError = null
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return { payload: await fetchJson(`${endpoint}?data=${encodeURIComponent(query)}`), endpoint }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error("Overpass 请求失败")
}

async function fetchJson(url) {
  const response = await fetchWithNetworkFallback(url, { headers: { "user-agent": USER_AGENT, accept: "application/json" } })
  if (!response.ok) throw new Error(`网络请求失败 ${response.status}: ${url}`)
  return response.json()
}

async function fetchBuffer(url) {
  const response = await fetchWithNetworkFallback(url, { headers: { "user-agent": USER_AGENT } })
  if (!response.ok) throw new Error(`网络请求失败 ${response.status}: ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

async function fetchWithTimeout(url, options, timeoutMs = 120_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Node's built-in fetch intentionally does not read HTTP(S)_PROXY. The
 * execution environment used for asset preparation may require a proxy, so
 * retry a failed request through the installed curl client without putting
 * credentials or shell-expanded user input into a command string.
 */
async function fetchWithNetworkFallback(url, options) {
  try {
    const response = await fetchWithTimeout(url, options)
    if (response.ok || (!process.env.HTTPS_PROXY && !process.env.https_proxy)) return response
    return await fetchWithCurl(url)
  } catch (error) {
    if (!process.env.HTTPS_PROXY && !process.env.https_proxy) throw error
    return fetchWithCurl(url)
  }
}

async function fetchWithCurl(url) {
  const { stdout } = await execFileAsync("curl", [
    "--fail", "--location", "--silent", "--show-error", "--max-time", "120",
    "--user-agent", USER_AGENT, url
  ], { maxBuffer: 64 * 1024 * 1024, encoding: "buffer" })
  return new Response(stdout, { status: 200 })
}

function parseMeters(value) {
  const match = String(value ?? "").trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(?:m|meter|metre)?$/i)
  if (!match) return null
  const number = Number(match[1])
  return Number.isFinite(number) && number > 0 && number <= 1000 ? number : null
}

function coordinateNumber(value, minimum, maximum) {
  if ((typeof value !== "number" && typeof value !== "string") || value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null
}

function validateExtent(extent) {
  if (!Array.isArray(extent) || extent.length !== 4 || !extent.every(Number.isFinite) || extent[0] < -180 || extent[2] > 180 || extent[1] < -90 || extent[3] > 90 || extent[0] >= extent[2] || extent[1] >= extent[3]) throw new Error("extent 必须是有效的 [west, south, east, north]")
}

function roundCoordinate(value) { return Math.round(value * 1e7) / 1e7 }
function sha256(value) { return createHash("sha256").update(value).digest("hex") }

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const outputDirectory = process.env.MAP_NETWORK_OUTPUT_DIR ?? DEFAULT_OUTPUT
  const region = process.env.MAP_NETWORK_REGION ?? DEFAULT_REGION
  const extent = process.env.MAP_NETWORK_EXTENT
    ? process.env.MAP_NETWORK_EXTENT.split(",").map(Number)
    : DEFAULT_EXTENT
  const sampleGrid = process.env.MAP_NETWORK_SAMPLE_GRID ? Number(process.env.MAP_NETWORK_SAMPLE_GRID) : undefined
  const result = await fetchMapRegionAssets({ outputDirectory, region, extent, sampleGrid })
  process.stdout.write(`${JSON.stringify(result.sourceManifest, null, 2)}\n`)
}
