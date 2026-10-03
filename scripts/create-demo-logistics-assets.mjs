import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import sharp from "sharp"

const extent = [113.287, 23.067, 113.323, 23.103]
const outputDirectory = resolve("apps/web/public/map/logistics")
const imagePath = resolve(outputDirectory, "gd-north-core-orthophoto.jpg")
const buildingsPath = resolve(outputDirectory, "gd-north-core-buildings.geojson")

await mkdir(outputDirectory, { recursive: true })
const buildings = createBuildings(extent)
const buildingsContent = `${JSON.stringify({ type: "FeatureCollection", name: "教学区建筑白模（示例资源）", features: buildings }, null, 2)}\n`
await writeFile(buildingsPath, buildingsContent, "utf8")

const svg = createTeachingBasemapSvg(extent, buildings)
await sharp(Buffer.from(svg))
  .jpeg({ quality: 86, progressive: true, mozjpeg: true })
  .toFile(imagePath)

const image = await readFile(imagePath)
const report = {
  extent,
  image: { path: "apps/web/public/map/logistics/gd-north-core-orthophoto.jpg", bytes: image.byteLength, sha256: sha256(image) },
  buildings: { path: "apps/web/public/map/logistics/gd-north-core-buildings.geojson", features: buildings.length, bytes: Buffer.byteLength(buildingsContent), sha256: sha256(Buffer.from(buildingsContent)) }
}
console.log(JSON.stringify(report, null, 2))

function createBuildings([west, south, east, north]) {
  const result = []
  const columns = 6
  const rows = 4
  const cellWidth = (east - west) / (columns + 1)
  const cellHeight = (north - south) / (rows + 1)
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const centerLongitude = west + cellWidth * (column + 1)
      const centerLatitude = south + cellHeight * (row + 1)
      const width = cellWidth * (0.45 + ((row + column) % 2) * 0.1)
      const height = cellHeight * (0.45 + ((row * 2 + column) % 3) * 0.06)
      const ring = [
        [centerLongitude - width, centerLatitude - height],
        [centerLongitude + width, centerLatitude - height],
        [centerLongitude + width, centerLatitude + height],
        [centerLongitude - width, centerLatitude + height],
        [centerLongitude - width, centerLatitude - height]
      ]
      const index = row * columns + column + 1
      result.push({
        type: "Feature",
        id: `gd-north-building-${String(index).padStart(2, "0")}`,
        properties: { name: `教学楼 ${String(index).padStart(2, "0")}`, height: 12 + ((row * 7 + column * 5) % 28), category: "BUILDING", source: "DEMO_TEACHING_DATA" },
        geometry: { type: "Polygon", coordinates: [ring] }
      })
    }
  }
  return result
}

function createTeachingBasemapSvg([west, south, east, north], buildings) {
  const width = 1200
  const height = 900
  const project = ([longitude, latitude]) => [((longitude - west) / (east - west)) * width, height - ((latitude - south) / (north - south)) * height]
  const roads = [
    [[west, south + (north - south) * 0.21], [east, south + (north - south) * 0.21]],
    [[west, south + (north - south) * 0.53], [east, south + (north - south) * 0.53]],
    [[west, south + (north - south) * 0.82], [east, south + (north - south) * 0.82]],
    [[west + (east - west) * 0.18, south], [west + (east - west) * 0.18, north]],
    [[west + (east - west) * 0.49, south], [west + (east - west) * 0.49, north]],
    [[west + (east - west) * 0.79, south], [west + (east - west) * 0.79, north]]
  ]
  const roadMarkup = roads.map(([a, b]) => {
    const [x1, y1] = project(a)
    const [x2, y2] = project(b)
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#f4f0e7" stroke-width="24"/><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#d5cbbb" stroke-width="2"/>`
  }).join("")
  const buildingMarkup = buildings.map((feature) => {
    const points = feature.geometry.coordinates[0].slice(0, -1).map(project).map(([x, y]) => `${x},${y}`).join(" ")
    return `<polygon points="${points}" fill="#c8d2cc" stroke="#8ba095" stroke-width="2"/>`
  }).join("")
  const [campusX, campusY] = project([113.303, 23.087])
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs><linearGradient id="base" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dce9df"/><stop offset="1" stop-color="#c9ddcf"/></linearGradient><pattern id="grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#bdd2c2" stroke-width="1" opacity=".45"/></pattern></defs>
  <rect width="${width}" height="${height}" fill="url(#base)"/><rect width="${width}" height="${height}" fill="url(#grid)"/>
  <path d="M0 155 C210 125 305 200 470 165 S790 110 1200 160 L1200 265 C970 230 780 245 580 275 S240 255 0 285Z" fill="#b6d4bc" opacity=".7"/>
  ${roadMarkup}
  ${buildingMarkup}
  <circle cx="${campusX}" cy="${campusY}" r="34" fill="#f5b85e" opacity=".9"/><circle cx="${campusX}" cy="${campusY}" r="11" fill="#fff7dc"/>
  <text x="32" y="52" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#385346">教学区离线底图 · GD-NORTH</text>
  <text x="32" y="84" font-family="Arial, sans-serif" font-size="18" fill="#5a7466">道路、建筑白模与配送教学节点示例资源</text>
  <text x="${campusX + 48}" y="${campusY + 8}" font-family="Arial, sans-serif" font-size="18" fill="#4d5d52">无人机实训中心</text>
  <text x="32" y="${height - 28}" font-family="Arial, sans-serif" font-size="16" fill="#668072">WGS84 · EPSG:4326 · 113.287°–113.323°E / 23.067°–23.103°N</text>
</svg>`
}

function sha256(value) { return createHash("sha256").update(value).digest("hex") }
