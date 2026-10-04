import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createElevationSnapshot,
  decodeHgt,
  overpassBuildings,
  parseBuildingHeight,
  sampleHgt
} from "./fetch-map-region-assets.mjs"

test("OSM building geometry is converted to WGS84 GeoJSON with stable height fields", () => {
  const result = overpassBuildings([
    {
      type: "way",
      id: 101,
      tags: { building: "school", "building:levels": "4", "name:zh": "实训楼" },
      geometry: [
        { lon: 113.287, lat: 23.067 },
        { lon: 113.288, lat: 23.067 },
        { lon: 113.288, lat: 23.068 },
        { lon: 113.287, lat: 23.067 }
      ]
    },
    { type: "node", id: 102, lat: 23.067, lon: 113.287 },
    {
      type: "way",
      id: 103,
      tags: { building: "yes", height: "18 m" },
      geometry: [
        { lon: 114, lat: 24 },
        { lon: 114.001, lat: 24 },
        { lon: 114.001, lat: 24.001 },
        { lon: 114, lat: 24 }
      ]
    }
  ], [113.287, 23.067, 113.323, 23.103])

  assert.equal(result.features.length, 1)
  assert.equal(result.features[0].id, "osm-building-101")
  assert.equal(result.features[0].properties.name, "实训楼")
  assert.equal(result.features[0].properties.height, 12.8)
  assert.equal(result.features[0].properties.heightSource, "ESTIMATED_FROM_LEVELS")
  assert.equal(result.features[0].properties.heightEstimated, true)
})

test("building heights prefer metres and fall back to 3.2m per level", () => {
  assert.equal(parseBuildingHeight({ height: "24.5m", "building:levels": "2" }), 24.5)
  assert.equal(parseBuildingHeight({ "building:levels": "5" }), 16)
  assert.equal(parseBuildingHeight({ height: "unknown" }), null)
})

test("SRTM HGT decoding samples north-up big-endian cells", () => {
  const size = 3
  const buffer = Buffer.alloc(size * size * 2)
  const values = [100, 101, 102, 110, 111, 112, 120, 121, 122]
  values.forEach((value, index) => buffer.writeInt16BE(value, index * 2))
  const hgt = decodeHgt(buffer, { south: 23, west: 113 })
  assert.equal(sampleHgt(hgt, 113, 24), 100)
  assert.equal(sampleHgt(hgt, 114, 23), 122)
  assert.equal(sampleHgt(hgt, 113.5, 23.5), 111)
  assert.equal(sampleHgt(hgt, 112, 23.5), null)
  assert.equal(sampleHgt(hgt, 113, 24.01), null)
})

test("elevation snapshot keeps source, datum, extent and complete grid", () => {
  const size = 3
  const buffer = Buffer.alloc(size * size * 2)
  for (let index = 0; index < size * size; index += 1) buffer.writeInt16BE(10 + index, index * 2)
  const snapshot = createElevationSnapshot(
    decodeHgt(buffer, { south: 23, west: 113 }),
    [113, 23, 114, 24],
    3,
    { sourceUrl: "https://example.test/N23E113.hgt.gz", fetchedAt: "2026-10-04T00:00:00.000Z" }
  )
  assert.equal(snapshot.coordinateReference, "EPSG:4326")
  assert.equal(snapshot.verticalDatum, "EGM96_ORTHOMETRIC")
  assert.equal(snapshot.samples.length, 9)
  assert.equal(snapshot.source.sourceUrl, "https://example.test/N23E113.hgt.gz")
  assert.equal(snapshot.sampling.noDataCount, 0)
})

test("NoData samples are rejected instead of being interpolated as ground", () => {
  const buffer = Buffer.alloc(3 * 3 * 2)
  for (let index = 0; index < 9; index += 1) buffer.writeInt16BE(index === 4 ? -32768 : 10, index * 2)
  assert.throws(() => createElevationSnapshot(
    decodeHgt(buffer, { south: 23, west: 113 }),
    [113, 23, 114, 24],
    3,
    { sourceUrl: "https://example.test/N23E113.hgt.gz" }
  ), /高程采样缺失/)
})
