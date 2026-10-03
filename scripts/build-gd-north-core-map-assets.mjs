import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import sharp from "sharp"

const sourceExtent = [113.1722106, 23.0143734, 113.4221699, 23.1774611]
const coreExtent = [113.287, 23.067, 113.323, 23.103]
const publicDirectory = resolve("apps/web/public/map/logistics")
const distributionDirectory = resolve("apps/web/dist/map/logistics")
const sourceImage = resolve(publicDirectory, "l17-orthophoto.jpg")
const sourceBuildings = resolve(publicDirectory, "buildings_clean.geojson")
const imageName = "gd-north-core-orthophoto.jpg"
const buildingsName = "gd-north-core-buildings.geojson"

const metadata = await sharp(sourceImage).metadata()
if (!metadata.width || !metadata.height) throw new Error("无法读取离线影像尺寸")

const [sourceWest, sourceSouth, sourceEast, sourceNorth] = sourceExtent
const [coreWest, coreSouth, coreEast, coreNorth] = coreExtent
const left = Math.floor((coreWest - sourceWest) / (sourceEast - sourceWest) * metadata.width)
const top = Math.floor((sourceNorth - coreNorth) / (sourceNorth - sourceSouth) * metadata.height)
const width = Math.ceil((coreEast - coreWest) / (sourceEast - sourceWest) * metadata.width)
const height = Math.ceil((coreNorth - coreSouth) / (sourceNorth - sourceSouth) * metadata.height)
const image = await sharp(sourceImage)
  .extract({ left, top, width, height })
  .jpeg({ quality: 86, progressive: true, mozjpeg: true })
  .toBuffer()

const geojson = JSON.parse(await readFile(sourceBuildings, "utf8"))
const features = Array.isArray(geojson.features)
  ? geojson.features.filter((feature) => intersectsExtent(feature?.geometry?.coordinates, coreExtent))
  : []
const buildings = Buffer.from(`${JSON.stringify({ ...geojson, features })}\n`, "utf8")

for (const directory of [publicDirectory, distributionDirectory]) {
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, imageName), image)
  await writeFile(resolve(directory, buildingsName), buildings)
}

process.stdout.write(`${JSON.stringify({
  extent: coreExtent,
  image: { name: imageName, width, height, bytes: image.length, sha256: sha256(image) },
  buildings: { name: buildingsName, features: features.length, bytes: buildings.length, sha256: sha256(buildings) }
}, null, 2)}\n`)

function intersectsExtent(coordinates, extent) {
  const bounds = coordinateBounds(coordinates)
  if (!bounds) return false
  return bounds.west <= extent[2]
    && bounds.east >= extent[0]
    && bounds.south <= extent[3]
    && bounds.north >= extent[1]
}

function coordinateBounds(value, bounds = null) {
  if (Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
    const next = bounds ?? { west: value[0], south: value[1], east: value[0], north: value[1] }
    next.west = Math.min(next.west, value[0])
    next.south = Math.min(next.south, value[1])
    next.east = Math.max(next.east, value[0])
    next.north = Math.max(next.north, value[1])
    return next
  }
  if (!Array.isArray(value)) return bounds
  let next = bounds
  for (const child of value) next = coordinateBounds(child, next)
  return next
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}
