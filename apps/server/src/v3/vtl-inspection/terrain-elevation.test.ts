import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { workspaceRoot } from "../../config/runtime-paths.js"
import { buildVtlTerrainProfile, loadVtlElevationSamples } from "./terrain-elevation.js"

const root = join(process.cwd(), "artifacts", "vtl-terrain-test")

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe("VTL terrain elevation source", () => {
  it("loads configured relative map paths from the workspace rather than the server cwd", async () => {
    await mkdir(join(root, "regions", "VTL-TEST"), { recursive: true })
    await writeFile(join(root, "regions", "VTL-TEST", "elevation-samples.json"), JSON.stringify({ samples: [{ longitude: 114, latitude: 22, heightMeters: 18 }] }))
    vi.stubEnv("MAP_DATA_DIR", relative(workspaceRoot, root))
    const samples = await loadVtlElevationSamples({
      provider: "CESIUM_QUANTIZED_MESH",
      url: "/map/regions/VTL-TEST/terrain",
      version: "1.0.0",
      sha256: "a".repeat(64),
      verticalDatum: "AMSL",
      extent: [113, 21, 115, 23],
      elevationSampleUrl: "/map/regions/VTL-TEST/elevation-samples.json",
      elevationSampleSha256: "b".repeat(64)
    })
    expect(samples).toEqual([{ longitude: 114, latitude: 22, heightMeters: 18 }])
  })

  it("loads the local authoritative sample snapshot", async () => {
    await mkdir(join(root, "regions", "VTL-TEST"), { recursive: true })
    await writeFile(join(root, "regions", "VTL-TEST", "elevation-samples.json"), JSON.stringify({ samples: [{ longitude: 114, latitude: 22, heightMeters: 18 }] }))
    const samples = await loadVtlElevationSamples({
      provider: "CESIUM_QUANTIZED_MESH",
      url: "/map/regions/VTL-TEST/terrain",
      version: "1.0.0",
      sha256: "a".repeat(64),
      verticalDatum: "AMSL",
      extent: [113, 21, 115, 23],
      elevationSampleUrl: "/map/regions/VTL-TEST/elevation-samples.json",
      elevationSampleSha256: "b".repeat(64)
    }, root)
    expect(samples).toEqual([{ longitude: 114, latitude: 22, heightMeters: 18 }])
  })

  it("interpolates terrain and preserves route distance in the profile", () => {
    const profile = buildVtlTerrainProfile([
      { id: "a", sequence: 0, phase: "VERTICAL_TAKEOFF", position: { longitude: 114, latitude: 22, altitudeMeters: 80 }, altitudeMeters: 80, speedMps: 4, taskObjectId: null },
      { id: "b", sequence: 1, phase: "CLIMB", position: { longitude: 114.001, latitude: 22, altitudeMeters: 100 }, altitudeMeters: 100, speedMps: 10, taskObjectId: null }
    ], [
      { longitude: 114, latitude: 22, heightMeters: 20 },
      { longitude: 114.002, latitude: 22, heightMeters: 40 }
    ])
    expect(profile).toHaveLength(2)
    expect(profile?.[0]).toMatchObject({ distanceMeters: 0, terrainElevationMeters: 20, clearanceMeters: 60 })
    expect(profile?.[1]?.distanceMeters).toBeGreaterThan(100)
    expect(profile?.[1]?.terrainElevationMeters).toBeCloseTo(30, 3)
  })
})
