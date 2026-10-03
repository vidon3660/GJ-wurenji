import {
  Credit,
  Event as CesiumEvent,
  Cartographic,
  GeographicTilingScheme,
  HeightmapTerrainData,
  Math as CesiumMath,
  Rectangle,
  SingleTileImageryProvider,
  TerrainProvider,
  TileAvailability,
  WebMercatorTilingScheme,
  type ImageryProvider,
  type Request,
  type TerrainData
} from "cesium"
import type { V3RegionCatalogItem } from "@wurenji/shared"
import { mapBasemapColors } from "./map-visual-theme"
import { regionRectangle } from "./map-region-constraints"

const TILE_SIZE = 256
const HEIGHTMAP_SIZE = 33
const MAX_IMAGERY_LEVEL = 16
const MAX_TERRAIN_LEVEL = 12
const MAX_TERRAIN_CACHE_SIZE = 96
const MAX_REGION_IMAGERY_CACHE_SIZE = 8
const regionImageryCache = new Map<string, string>()

class TeachingImageryProvider {
  readonly tileWidth = TILE_SIZE
  readonly tileHeight = TILE_SIZE
  readonly maximumLevel = MAX_IMAGERY_LEVEL
  readonly minimumLevel = 0
  readonly tilingScheme = new WebMercatorTilingScheme()
  readonly rectangle = this.tilingScheme.rectangle
  readonly tileDiscardPolicy = undefined
  readonly errorEvent = new CesiumEvent()
  readonly credit = new Credit("教学底图（非导航数据）")
  readonly proxy = undefined
  readonly hasAlphaChannel = false

  getTileCredits() {
    return [this.credit]
  }

  requestImage(x: number, y: number, level: number, _request?: Request): Promise<HTMLCanvasElement> {
    const canvas = document.createElement("canvas")
    canvas.width = TILE_SIZE
    canvas.height = TILE_SIZE
    const context = canvas.getContext("2d")
    if (context) drawTeachingTile(context, x, y, level)
    return Promise.resolve(canvas)
  }

  pickFeatures() {
    return undefined
  }
}

class TeachingTerrainProvider {
  readonly errorEvent = new CesiumEvent()
  readonly credit = new Credit("教学起伏地形（非正式 DEM）")
  readonly tilingScheme = new GeographicTilingScheme()
  readonly hasWaterMask = false
  readonly hasVertexNormals = false
  readonly availability = new TileAvailability(this.tilingScheme, MAX_TERRAIN_LEVEL)
  readonly rectangle: Rectangle
  private readonly levelZeroGeometricError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
    this.tilingScheme.ellipsoid,
    HEIGHTMAP_SIZE,
    this.tilingScheme.getNumberOfXTilesAtLevel(0)
  )
  private readonly tileCache = new Map<string, TerrainData>()

  constructor(region?: V3RegionCatalogItem | null) {
    this.rectangle = regionRectangle(region, 0.5) ?? this.tilingScheme.rectangle
    for (let level = 0; level <= MAX_TERRAIN_LEVEL; level += 1) {
      const tileRange = tileRangeForRectangle(this.tilingScheme, this.rectangle, level)
      if (!tileRange) continue
      this.availability.addAvailableTileRange(
        level,
        tileRange.startX,
        tileRange.startY,
        tileRange.endX,
        tileRange.endY
      )
    }
  }

  requestTileGeometry(x: number, y: number, level: number, _request?: Request): Promise<TerrainData> | undefined {
    if (!this.getTileDataAvailable(x, y, level)) return undefined
    const cacheKey = `${level}:${x}:${y}`
    const cached = this.tileCache.get(cacheKey)
    if (cached) return Promise.resolve(cached)
    const rectangle = this.tilingScheme.tileXYToRectangle(x, y, level)
    const heights = new Float32Array(HEIGHTMAP_SIZE * HEIGHTMAP_SIZE)

    for (let row = 0; row < HEIGHTMAP_SIZE; row += 1) {
      const latitude = rectangle.north - (rectangle.north - rectangle.south) * row / (HEIGHTMAP_SIZE - 1)
      for (let column = 0; column < HEIGHTMAP_SIZE; column += 1) {
        const longitude = rectangle.west + (rectangle.east - rectangle.west) * column / (HEIGHTMAP_SIZE - 1)
        heights[row * HEIGHTMAP_SIZE + column] = teachingTerrainHeightMeters(
          CesiumMath.toDegrees(longitude),
          CesiumMath.toDegrees(latitude)
        )
      }
    }

    const terrainData = new HeightmapTerrainData({
      buffer: heights,
      width: HEIGHTMAP_SIZE,
      height: HEIGHTMAP_SIZE,
      childTileMask: level < MAX_TERRAIN_LEVEL ? childTileMask(this, x, y, level) : 0
    })
    this.tileCache.set(cacheKey, terrainData)
    if (this.tileCache.size > MAX_TERRAIN_CACHE_SIZE) {
      const oldestKey = this.tileCache.keys().next().value
      if (oldestKey) this.tileCache.delete(oldestKey)
    }
    return Promise.resolve(terrainData)
  }

  getLevelMaximumGeometricError(level: number) {
    return this.levelZeroGeometricError / (1 << level)
  }

  getTileDataAvailable(x: number, y: number, level: number) {
    return level >= 0 && level <= MAX_TERRAIN_LEVEL && this.availability.isTileAvailable(level, x, y)
  }

  loadTileDataAvailability() {
    return undefined
  }
}

export function createTeachingImageryProvider(region?: V3RegionCatalogItem | null): ImageryProvider {
  if (region && region.boundary.length >= 3) return createRegionTeachingImageryProvider(region)
  return new TeachingImageryProvider() as unknown as ImageryProvider
}

export function createTeachingTerrainProvider(region?: V3RegionCatalogItem | null): TerrainProvider {
  return new TeachingTerrainProvider(region) as unknown as TerrainProvider
}

export function teachingTerrainHeightMeters(longitude: number, latitude: number): number {
  const broadRidge = Math.sin(longitude * 52.7 + latitude * 31.9)
  const crossRidge = Math.sin(longitude * 119.3 - latitude * 83.1)
  const localRelief = Math.cos(longitude * 211.7 + latitude * 177.5)
  const height = 32 + broadRidge * 18 + crossRidge * 10 + localRelief * 5
  return Math.round(Math.max(3, Math.min(68, height)) * 10) / 10
}

export const teachingMapLimits = {
  maximumImageryLevel: MAX_IMAGERY_LEVEL,
  maximumTerrainLevel: MAX_TERRAIN_LEVEL,
  heightmapSize: HEIGHTMAP_SIZE
} as const

function drawTeachingTile(context: CanvasRenderingContext2D, tileX: number, tileY: number, level: number) {
  const originX = tileX * TILE_SIZE
  const originY = tileY * TILE_SIZE

  context.fillStyle = mapBasemapColors.land
  context.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
  drawLandUse(context, originX, originY, level)
  drawWater(context, originX, originY)
  drawRoadGrid(context, originX, originY, level)
  if (level >= 11) drawBuildings(context, originX, originY, level)
  drawTileEdge(context)
}

function createRegionTeachingImageryProvider(region: V3RegionCatalogItem): ImageryProvider {
  const longitudes = region.boundary.map((point) => point.longitude)
  const latitudes = region.boundary.map((point) => point.latitude)
  const west = Math.min(...longitudes)
  const east = Math.max(...longitudes)
  const south = Math.min(...latitudes)
  const north = Math.max(...latitudes)
  const longitudePadding = Math.max((east - west) * 0.5, 0.002)
  const latitudePadding = Math.max((north - south) * 0.5, 0.002)
  const cacheKey = `${region.regionCode}:${west}:${south}:${east}:${north}`
  let imageryUrl = regionImageryCache.get(cacheKey)
  if (!imageryUrl) {
    const canvas = document.createElement("canvas")
    canvas.width = 1024
    canvas.height = 1024
    const context = canvas.getContext("2d")
    if (context) {
      for (let tileY = 0; tileY < 4; tileY += 1) {
        for (let tileX = 0; tileX < 4; tileX += 1) {
          context.save()
          context.translate(tileX * TILE_SIZE, tileY * TILE_SIZE)
          drawTeachingTile(context, tileX, tileY, 14)
          context.restore()
        }
      }
    }
    imageryUrl = canvas.toDataURL("image/png")
    regionImageryCache.set(cacheKey, imageryUrl)
    if (regionImageryCache.size > MAX_REGION_IMAGERY_CACHE_SIZE) {
      const oldestKey = regionImageryCache.keys().next().value
      if (oldestKey) regionImageryCache.delete(oldestKey)
    }
  }

  return new SingleTileImageryProvider({
    url: imageryUrl,
    tileWidth: 1024,
    tileHeight: 1024,
    rectangle: Rectangle.fromDegrees(
      west - longitudePadding,
      south - latitudePadding,
      east + longitudePadding,
      north + latitudePadding
    ),
    credit: "教学底图（非导航数据）"
  })
}

function drawLandUse(context: CanvasRenderingContext2D, originX: number, originY: number, level: number) {
  const blockSize = level >= 12 ? 192 : 128
  const startColumn = Math.floor(originX / blockSize)
  const endColumn = Math.floor((originX + TILE_SIZE) / blockSize)
  const startRow = Math.floor(originY / blockSize)
  const endRow = Math.floor((originY + TILE_SIZE) / blockSize)

  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      const value = hash(column, row, level)
      if (value % 7 > 1) continue
      const left = column * blockSize - originX + 12
      const top = row * blockSize - originY + 12
      context.fillStyle = value % 2 === 0 ? mapBasemapColors.greenAreaLight : mapBasemapColors.greenAreaSoft
      context.fillRect(left, top, blockSize - 24, blockSize - 24)
    }
  }
}

function drawWater(context: CanvasRenderingContext2D, originX: number, originY: number) {
  context.beginPath()
  for (let localX = -24; localX <= TILE_SIZE + 24; localX += 8) {
    const globalX = originX + localX
    const globalY = 1400 + Math.sin(globalX / 420) * 72 + Math.sin(globalX / 150) * 18
    const localY = positiveModulo(globalY - originY, 1900)
    if (localX === -24) context.moveTo(localX, localY)
    else context.lineTo(localX, localY)
  }
  context.strokeStyle = mapBasemapColors.waterEdge
  context.lineWidth = 26
  context.stroke()
  context.strokeStyle = mapBasemapColors.waterCore
  context.lineWidth = 13
  context.stroke()
}

function drawRoadGrid(context: CanvasRenderingContext2D, originX: number, originY: number, level: number) {
  const streetSpacing = level >= 13 ? 96 : 128
  const arterialSpacing = streetSpacing * 4
  drawAxisRoads(context, originX, originY, streetSpacing, mapBasemapColors.roadMinor, 3)
  drawAxisRoads(context, originX, originY, arterialSpacing, mapBasemapColors.roadMajorCasing, 7)
  drawAxisRoads(context, originX, originY, arterialSpacing, mapBasemapColors.roadMajor, 3)

  context.save()
  context.translate(-originX, -originY)
  const worldStart = originY - originX * 0.58
  const firstBand = Math.floor(worldStart / 620) - 2
  context.strokeStyle = mapBasemapColors.roadMinor
  context.lineWidth = 5
  for (let band = firstBand; band < firstBand + 6; band += 1) {
    const intercept = band * 620
    context.beginPath()
    context.moveTo(originX - 180, (originX - 180) * 0.58 + intercept)
    context.lineTo(originX + TILE_SIZE + 180, (originX + TILE_SIZE + 180) * 0.58 + intercept)
    context.stroke()
  }
  context.restore()
}

function drawAxisRoads(
  context: CanvasRenderingContext2D,
  originX: number,
  originY: number,
  spacing: number,
  color: string,
  width: number
) {
  context.strokeStyle = color
  context.lineWidth = width
  context.beginPath()
  for (let globalX = Math.ceil(originX / spacing) * spacing; globalX <= originX + TILE_SIZE; globalX += spacing) {
    const localX = globalX - originX
    context.moveTo(localX, 0)
    context.lineTo(localX, TILE_SIZE)
  }
  for (let globalY = Math.ceil(originY / spacing) * spacing; globalY <= originY + TILE_SIZE; globalY += spacing) {
    const localY = globalY - originY
    context.moveTo(0, localY)
    context.lineTo(TILE_SIZE, localY)
  }
  context.stroke()
}

function drawBuildings(context: CanvasRenderingContext2D, originX: number, originY: number, level: number) {
  const cellSize = 48
  const startColumn = Math.floor(originX / cellSize)
  const endColumn = Math.floor((originX + TILE_SIZE) / cellSize)
  const startRow = Math.floor(originY / cellSize)
  const endRow = Math.floor((originY + TILE_SIZE) / cellSize)

  for (let row = startRow; row <= endRow; row += 1) {
    for (let column = startColumn; column <= endColumn; column += 1) {
      const value = hash(column, row, level)
      if (value % 5 === 0) continue
      const left = column * cellSize - originX + 8 + value % 5
      const top = row * cellSize - originY + 8 + (value >> 3) % 5
      const width = 19 + value % 13
      const height = 15 + (value >> 5) % 17
      context.fillStyle = value % 3 === 0 ? mapBasemapColors.buildingFootprintAlt : mapBasemapColors.buildingFootprint
      context.fillRect(left, top, width, height)
      context.strokeStyle = mapBasemapColors.buildingFootprintEdge
      context.lineWidth = 1
      context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1)
    }
  }
}

function drawTileEdge(context: CanvasRenderingContext2D) {
  context.strokeStyle = "rgba(71, 91, 82, 0.08)"
  context.lineWidth = 1
  context.strokeRect(0.5, 0.5, TILE_SIZE - 1, TILE_SIZE - 1)
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor
}

function hash(x: number, y: number, level: number) {
  let value = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(level, 2246822519)
  value = Math.imul(value ^ (value >>> 13), 1274126177)
  return (value ^ (value >>> 16)) >>> 0
}

function tileRangeForRectangle(
  tilingScheme: GeographicTilingScheme,
  rectangle: Rectangle,
  level: number
): { startX: number; startY: number; endX: number; endY: number } | null {
  const corners = [
    Cartographic.fromRadians(rectangle.west, rectangle.south),
    Cartographic.fromRadians(rectangle.west, rectangle.north),
    Cartographic.fromRadians(rectangle.east, rectangle.south),
    Cartographic.fromRadians(rectangle.east, rectangle.north)
  ]
  const tiles = corners.map((corner) => tilingScheme.positionToTileXY(corner, level)).filter(Boolean)
  if (tiles.length === 0) return null
  const maxX = tilingScheme.getNumberOfXTilesAtLevel(level) - 1
  const maxY = tilingScheme.getNumberOfYTilesAtLevel(level) - 1
  return {
    startX: Math.max(0, Math.min(maxX, Math.min(...tiles.map((tile) => tile!.x)))),
    startY: Math.max(0, Math.min(maxY, Math.min(...tiles.map((tile) => tile!.y)))),
    endX: Math.max(0, Math.min(maxX, Math.max(...tiles.map((tile) => tile!.x)))),
    endY: Math.max(0, Math.min(maxY, Math.max(...tiles.map((tile) => tile!.y))))
  }
}

function childTileMask(provider: TeachingTerrainProvider, x: number, y: number, level: number): number {
  let mask = 0
  const childLevel = level + 1
  const childCoordinates = [
    [x * 2, y * 2],
    [x * 2 + 1, y * 2],
    [x * 2, y * 2 + 1],
    [x * 2 + 1, y * 2 + 1]
  ]
  childCoordinates.forEach(([childX, childY], index) => {
    if (provider.getTileDataAvailable(childX!, childY!, childLevel)) mask |= 1 << index
  })
  return mask
}
