import pg from "pg"
import { readFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve("data/map/regions")
const items = [
  ["GZ-NORTH-LOGISTICS-01", "广州北部城市低空物流演示区"],
  ["GZ-MOUNTAIN-VTOL-01", "贵州山区垂起广域巡检演示区"],
  ["SH-BUND-SHOW-01", "上海外滩城市无人机编队表演演示区"]
]

const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://wurenji@localhost:55432/wurenji" })
await client.connect()

try {
  for (const [code, name] of items) {
    const directory = path.join(root, code)
    const buildings = JSON.parse(await readFile(path.join(directory, "buildings.geojson"), "utf8"))
    const obstacles = JSON.parse(await readFile(path.join(directory, "obstacles.geojson"), "utf8"))
    const features = [
      ...buildings.features.map((feature, index) => normalizeFeature(feature, index, "BUILDING")),
      ...obstacles.features.map((feature, index) => normalizeFeature(feature, index, "OBSTACLE"))
    ].filter(Boolean)

    const result = await client.query(
      "select id, manifest from resource_packages where name=$1 and status=$2 limit 1",
      [name, "ACTIVE"]
    )
    if (!result.rows[0]) throw new Error(`missing active region: ${name}`)
    const manifest = result.rows[0].manifest
    const layer = manifest.layers?.find((item) => item.code === "BUILDINGS")
    if (!layer) throw new Error(`missing BUILDINGS layer: ${code}`)
    layer.title = "建筑与障碍物"
    layer.version = "2026.10.01"
    layer.state = "AVAILABLE"
    layer.features = features
    manifest.updatedFrom = "out.rar"
    manifest.updatedAt = "2026-10-01T00:00:00.000Z"
    await client.query(
      'update resource_packages set manifest=$1::jsonb, "updatedAt"=now() where id=$2',
      [JSON.stringify(manifest), result.rows[0].id]
    )
    console.log(`${code}: ${features.length} features`)
  }
} finally {
  await client.end()
}

function normalizeFeature(feature, index, category) {
  const geometry = feature.geometry
  if (!geometry) return null
  const properties = { ...(feature.properties ?? {}), category, source: "OUT-20261001" }
  const id = String(feature.id ?? feature.properties?.osm_id ?? `${category.toLowerCase()}-${index}`)
  const name = String(feature.properties?.name ?? id)
  const heightValue = Number(feature.properties?.height ?? feature.properties?.height_m)
  const heightMeters = Number.isFinite(heightValue) ? heightValue : undefined
  if (geometry.type === "Polygon") {
    const positions = (geometry.coordinates?.[0] ?? []).map(toCoordinate)
    return { id, name, geometryType: "POLYGON", positions, ...(heightMeters === undefined ? {} : { heightMeters }), properties }
  }
  if (geometry.type === "Point") {
    return { id, name, geometryType: "POINT", position: toCoordinate(geometry.coordinates), ...(heightMeters === undefined ? {} : { heightMeters }), properties }
  }
  if (geometry.type === "LineString") {
    const coordinates = geometry.coordinates ?? []
    const midpoint = coordinates[Math.floor(coordinates.length / 2)] ?? coordinates[0]
    if (!midpoint) return null
    return { id, name, geometryType: "POINT", position: toCoordinate(midpoint), properties: { ...properties, sourceGeometry: "LINESTRING" } }
  }
  return null
}

function toCoordinate(value) {
  return { longitude: Number(value[0]), latitude: Number(value[1]) }
}
