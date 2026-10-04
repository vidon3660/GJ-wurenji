import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { checkRegionMapReadiness, sampleRegionElevation } from "./map-resource-readiness.js"
import { assertFormalMapReadiness, assertFormalVtlMapReadiness, formalMapResourcesRequired, formalVtlMapResourcesRequired } from "./resource-package.service.js"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("offline region map readiness", () => {
  it("requires terrain, imagery and an authoritative elevation snapshot", async () => {
    const root = await fixtureRoot()
    const result = await checkRegionMapReadiness(region(), root)

    expect(result.formalReady).toBe(true)
    expect(result.checks.map((check) => check.status)).toEqual(["READY", "READY", "READY"])
  })

  it("samples the nearest authoritative offline elevation", async () => {
    const root = await fixtureRoot()
    await expect(sampleRegionElevation(region().terrain, { longitude: 114.0001, latitude: 22.5001 }, root)).resolves.toBe(12)
    await expect(sampleRegionElevation(region().terrain, { longitude: 120, latitude: 30 }, root)).resolves.toBeNull()
  })

  it("reports complete building and obstacle diagnostics without changing formal map checks", async () => {
    const root = await fixtureRoot()
    const result = await checkRegionMapReadiness({
      ...region(),
      layers: [environmentLayer([
        { id: "building-1", category: "BUILDING", heightMeters: 24 },
        { id: "obstacle-1", category: "OBSTACLE", heightMeters: 8 }
      ])]
    }, root)

    expect(result.formalReady).toBe(true)
    expect(result.environmentDiagnostics).toMatchObject({
      status: "READY",
      layerPresent: true,
      buildingCount: 1,
      obstacleCount: 1,
      missingHeightCount: 0,
      authoritativeSourceDeclared: true,
      source: "authoritative-test-source",
      version: "2026.09.12"
    })
  })

  it("distinguishes teachable environment data from authoritative readiness", async () => {
    const root = await fixtureRoot()
    const result = await checkRegionMapReadiness({
      ...region(),
      layers: [environmentLayer([
        { id: "building-1", category: "BUILDING" },
        { id: "obstacle-1", category: "OBSTACLE", heightMeters: 8 }
      ])]
    }, root)

    expect(result.formalReady).toBe(true)
    expect(result.environmentDiagnostics).toMatchObject({
      status: "INCOMPLETE",
      buildingCount: 1,
      obstacleCount: 1,
      missingHeightCount: 1,
      message: "建筑物/障碍物可用于教学表达，但尚未达到正式资源验收"
    })
  })

  it("reports unavailable environment diagnostics when no building layer exists", async () => {
    const root = await fixtureRoot()
    const result = await checkRegionMapReadiness(region(), root)

    expect(result.environmentDiagnostics).toMatchObject({
      status: "UNAVAILABLE",
      layerPresent: false,
      buildingCount: 0,
      obstacleCount: 0
    })
  })

  it("reports missing local assets instead of silently passing", async () => {
    const root = await mkdtemp(join(process.cwd(), "map-readiness-test-"))
    temporaryDirectories.push(root)
    const result = await checkRegionMapReadiness(region(), root)

    expect(result.formalReady).toBe(false)
    expect(result.checks.every((check) => check.status === "INVALID")).toBe(true)
  })

  it("identifies external services as non-formal offline evidence", async () => {
    const result = await checkRegionMapReadiness({ ...region(), terrain: { ...region().terrain!, url: "https://terrain.example/layer.json" } }, "map-readiness-not-used")

    expect(result.formalReady).toBe(false)
    expect(result.checks[0]).toMatchObject({ status: "EXTERNAL", required: true })
  })

  it("rejects a snapshot that points at another region directory", async () => {
    const root = await fixtureRoot()
    const value = region()
    value.terrain!.elevationSampleUrl = "/map/regions/OTHER-REGION/elevation-samples.json"
    const result = await checkRegionMapReadiness(value, root)

    expect(result.formalReady).toBe(false)
    expect(result.checks[2]).toMatchObject({ status: "INVALID", message: "高程快照必须位于当前区域目录内" })
  })

  it("rejects a DEM package without a local terrain tile", async () => {
    const root = await fixtureRoot()
    await rm(join(root, "regions", "TEST-REGION", "terrain", "0", "0", "0.terrain"))
    const result = await checkRegionMapReadiness(region(), root)

    expect(result.formalReady).toBe(false)
    expect(result.checks[0]).toMatchObject({ status: "INVALID", message: "DEM 目录中没有可用的 .terrain 瓦片" })
  })

  it("rejects a terrain resource version that differs from the region declaration", async () => {
    const root = await fixtureRoot()
    const value = region()
    value.terrainResourceVersion = "2.0.0"
    const result = await checkRegionMapReadiness(value, root)

    expect(result.formalReady).toBe(false)
    expect(result.checks[0]).toMatchObject({ status: "INVALID", message: "区域地形资源版本与 terrainResourceVersion 不一致" })
  })

  it("rejects a DEM extent that does not cover the teaching boundary", async () => {
    const root = await fixtureRoot()
    const value = region()
    value.terrain!.extent = [114, 22.25, 114.5, 22.75]
    const result = await checkRegionMapReadiness(value, root)

    expect(result.formalReady).toBe(false)
    expect(result.checks[0]).toMatchObject({ status: "INVALID", message: "DEM 覆盖范围无效或未覆盖整个教学区域" })
  })

  it("rejects an imagery extent with invalid bounds", async () => {
    const root = await fixtureRoot()
    const value = region()
    value.imagery!.extent = [115, 22, 113, 23]
    const result = await checkRegionMapReadiness(value, root)

    expect(result.formalReady).toBe(false)
    expect(result.checks[1]).toMatchObject({ status: "INVALID", message: "影像覆盖范围无效" })
  })

  it("rejects malformed authoritative elevation samples", async () => {
    const root = await fixtureRoot()
    await writeFile(join(root, "regions", "TEST-REGION", "elevation-samples.json"), JSON.stringify({ samples: [{ longitude: "invalid" }] }))
    const result = await checkRegionMapReadiness(region(), root)

    expect(result.formalReady).toBe(false)
    expect(result.checks[2]).toMatchObject({ status: "INVALID", message: "高程快照包含非法经纬度或高程值" })
  })

  it("blocks formal VTOL assignment publishing with named missing resources", async () => {
    const root = await mkdtemp(join(process.cwd(), "map-readiness-test-"))
    temporaryDirectories.push(root)
    const result = await checkRegionMapReadiness(region(), root)

    expect(() => assertFormalVtlMapReadiness({
      packageId: "region-id",
      regionCode: "TEST-REGION",
      title: "测试广域巡检区",
      sceneType: "VTOL_INSPECTION"
    }, result, true)).toThrow("测试广域巡检区\u201d未达到正式发布条件：DEM")
  })

  it("allows formal VTOL assignment publishing only after all map resources are ready", async () => {
    const root = await fixtureRoot()
    const result = await checkRegionMapReadiness(region(), root)

    expect(() => assertFormalVtlMapReadiness({
      packageId: "region-id",
      regionCode: "TEST-REGION",
      title: "测试广域巡检区",
      sceneType: "VTOL_INSPECTION"
    }, result, true)).not.toThrow()
  })

  it.each(["CITY_SHOW", "CITY_LOGISTICS"] as const)("applies the formal map gate to %s", (sceneType) => {
    expect(() => assertFormalMapReadiness({
      packageId: "region-id",
      regionCode: "TEST-REGION",
      title: sceneType === "CITY_SHOW" ? "编队教学区" : "物流教学区",
      sceneType
    }, {
      ...regionReadiness(false),
      regionPackageId: "region-id",
      regionCode: "TEST-REGION"
    }, true)).toThrow("未达到正式发布条件")
  })

  it("requires the formal map gate only in production", () => {
    expect(formalMapResourcesRequired({ NODE_ENV: "production" })).toBe(true)
    expect(formalMapResourcesRequired({ NODE_ENV: "development" })).toBe(false)
    expect(formalMapResourcesRequired({ NODE_ENV: "development", FORMAL_MAP_RESOURCES_REQUIRED: "true" })).toBe(true)
    expect(formalMapResourcesRequired({ NODE_ENV: "production", FORMAL_MAP_RESOURCES_REQUIRED: "false" })).toBe(true)
    expect(formalVtlMapResourcesRequired({ NODE_ENV: "production" })).toBe(true)
    expect(formalVtlMapResourcesRequired({ NODE_ENV: "development" })).toBe(false)
    expect(formalVtlMapResourcesRequired({ NODE_ENV: "test" })).toBe(false)
  })
})

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), "map-readiness-test-"))
  temporaryDirectories.push(root)
    const regionRoot = join(root, "regions", "TEST-REGION")
  await mkdir(join(regionRoot, "terrain", "0", "0"), { recursive: true })
  await mkdir(join(regionRoot, "imagery", "0", "0"), { recursive: true })
  const elevation = JSON.stringify({ samples: [{ longitude: 114, latitude: 22.5, heightMeters: 12 }] })
  await writeFile(join(regionRoot, "terrain", "layer.json"), JSON.stringify({ format: "quantized-mesh-1.0", tiles: ["{z}/{x}/{y}.terrain"] }))
  await writeFile(join(regionRoot, "terrain", "0", "0", "0.terrain"), Buffer.from([1, 2, 3]))
  await writeFile(join(regionRoot, "imagery", "0", "0", "0.png"), Buffer.from([137, 80, 78, 71]))
  await writeFile(join(regionRoot, "elevation-samples.json"), elevation)
  const terrainSha256 = await directoryHash(join(regionRoot, "terrain"))
  const imagerySha256 = await directoryHash(join(regionRoot, "imagery"))
  await writeFile(join(regionRoot, "manifest.json"), JSON.stringify({
    terrain: { version: "1.0.0", sha256: terrainSha256 },
    imagery: { version: "1.0.0", sha256: imagerySha256 }
  }))
  fixtureTerrainSha256 = terrainSha256
  fixtureImagerySha256 = imagerySha256
  return root
}

function regionReadiness(formalReady: boolean) {
  return {
    regionPackageId: "region-id",
    regionCode: "TEST-REGION",
    packageVersion: "1.0.0",
    checkedAt: new Date().toISOString(),
    formalReady,
    checks: [
      { kind: "TERRAIN" as const, status: formalReady ? "READY" as const : "UNCONFIGURED" as const, required: true, message: "DEM" },
      { kind: "IMAGERY" as const, status: formalReady ? "READY" as const : "UNCONFIGURED" as const, required: true, message: "影像" },
      { kind: "ELEVATION_SNAPSHOT" as const, status: formalReady ? "READY" as const : "UNCONFIGURED" as const, required: true, message: "高程快照" }
    ]
  }
}

let fixtureTerrainSha256 = ""
let fixtureImagerySha256 = ""


function region() {
  const root = "/map/regions/TEST-REGION"
  return {
    packageId: "region-id",
    packageVersion: "1.0.0",
    regionCode: "TEST-REGION",
    heightDatum: "AGL" as const,
    terrainResourceVersion: "1.0.0",
    boundary: [{ longitude: 113, latitude: 22 }, { longitude: 115, latitude: 22 }, { longitude: 114, latitude: 23 }],
    terrain: {
      provider: "CESIUM_QUANTIZED_MESH" as const,
      url: `${root}/terrain/layer.json`,
      version: "1.0.0",
      sha256: fixtureTerrainSha256,
      verticalDatum: "AMSL" as const,
      extent: [113, 22, 115, 23] as [number, number, number, number],
      elevationSampleUrl: `${root}/elevation-samples.json`,
      elevationSampleSha256: hash(JSON.stringify({ samples: [{ longitude: 114, latitude: 22.5, heightMeters: 12 }] }))
    },
    imagery: {
      provider: "XYZ" as const,
      url: `${root}/imagery/{z}/{x}/{y}.png`,
      version: "1.0.0",
      sha256: fixtureImagerySha256,
      extent: [113, 22, 115, 23] as [number, number, number, number]
    }
  }
}

function environmentLayer(features: Array<{ id: string; category: string; heightMeters?: number }>) {
  return {
    code: "BUILDINGS" as const,
    title: "建筑物与障碍物",
    state: "AVAILABLE" as const,
    source: "authoritative-test-source",
    version: "2026.09.12",
    features: features.map((feature) => ({
      id: feature.id,
      name: feature.id,
      geometryType: "POINT" as const,
      position: { longitude: 114, latitude: 22.5 },
      properties: { category: feature.category },
      ...(feature.heightMeters === undefined ? {} : { heightMeters: feature.heightMeters })
    }))
  }
}

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex") }

async function directoryHash(directory: string): Promise<string> {
  const files: string[] = []
  const collect = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) await collect(path)
      else files.push(path)
    }
  }
  await collect(directory)
  const digest = createHash("sha256")
  for (const file of files.sort()) {
    digest.update(file.slice(directory.length + 1).replaceAll("\\", "/"))
    digest.update("\0")
    digest.update(hash(await readFile(file)))
    digest.update("\n")
  }
  return digest.digest("hex")
}
