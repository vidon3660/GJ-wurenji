import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { importMapRegion } from "./import-map-region.mjs"

const execFileAsync = promisify(execFile)

test("imports a validated WGS84 quantized-mesh region and writes an unsigned package descriptor", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-map-region-import-"))
  try {
    const input = await createInput(root)
    const result = await importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot: join(root, "map") })
    assert.equal(result.regionCode, "TEST-REGION")
    assert.match(result.terrainSha256, /^[a-f0-9]{64}$/)
    assert.match(result.imagerySha256, /^[a-f0-9]{64}$/)
    const descriptor = JSON.parse(await readFile(join(root, "map", "regions", "TEST-REGION", "package", "region-package.json"), "utf8"))
    assert.equal(descriptor.packageType, "REGION")
    assert.equal(descriptor.content.terrain.url, "/map/regions/TEST-REGION/terrain")
    assert.equal(descriptor.content.terrain.elevationSampleSha256, result.elevationSampleSha256)
    assert.equal(descriptor.content.layers.length, 5)
    assert.equal(descriptor.content.layers.every((layer) => layer.features.length === 0), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects a GeoTIFF and incomplete terrain instead of treating it as Cesium terrain", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-map-region-reject-"))
  try {
    const input = await createInput(root)
    await writeFile(join(input.terrainDirectory, "source.tif"), Buffer.from("not-converted"))
    await rm(join(input.terrainDirectory, "0.terrain"))
    await assert.rejects(
      importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot: join(root, "map") }),
      /至少需要一个 \.terrain/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects expired authorization and duplicate destination without force", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-map-region-policy-"))
  try {
    const input = await createInput(root)
    input.config.authorization.validUntil = "2020-01-01T00:00:00Z"
    await assert.rejects(
      importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot: join(root, "map") }),
      /授权已过期/
    )
    input.config.authorization.validUntil = "2099-01-01T00:00:00Z"
    const outputRoot = join(root, "map")
    await importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot })
    await assert.rejects(
      importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot }),
      /目标区域已存在/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects elevation samples inside the bounding box but outside a polygon boundary", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-map-region-polygon-boundary-"))
  try {
    const input = await createInput(root)
    input.config.boundary = [
      { longitude: 113.99, latitude: 22.49 },
      { longitude: 114.01, latitude: 22.49 },
      { longitude: 114, latitude: 22.51 }
    ]
    await writeFile(join(root, "elevation-samples.json"), JSON.stringify({ samples: [{ longitude: 114.009, latitude: 22.505, heightMeters: 12 }] }))
    await assert.rejects(
      importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot: join(root, "map") }),
      /samples\[0\] 超出 boundary 覆盖范围/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("rejects a region center inside the bounding box but outside a polygon boundary", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-map-region-center-boundary-"))
  try {
    const input = await createInput(root)
    input.config.boundary = [
      { longitude: 113.99, latitude: 22.49 },
      { longitude: 114.01, latitude: 22.49 },
      { longitude: 114, latitude: 22.51 }
    ]
    input.config.center = { longitude: 114.009, latitude: 22.505 }
    await assert.rejects(
      importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot: join(root, "map") }),
      /center 必须位于 boundary 范围内/
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("produces a descriptor consumable by the signed resource package builder", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-map-region-package-"))
  try {
    const input = await createInput(root)
    const outputRoot = join(root, "map")
    const result = await importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot })
    const { privateKey } = generateKeyPairSync("ed25519")
    const privateKeyPath = join(root, "region-private.pem")
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    const archivePath = join(root, "region-package.zip")
    await execFileAsync(process.execPath, [
      resolve(process.cwd(), "scripts/build-resource-package.mjs"),
      "--manifest", result.descriptor,
      "--source-dir", join(result.destination, "package"),
      "--private-key", privateKeyPath,
      "--key-id", "test-region-key",
      "--output", archivePath
    ])
    const archiveStat = await stat(archivePath)
    assert.ok(archiveStat.size > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("imports a VTOL inspection region with task objects, landing sites and aircraft parameters", async () => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-vtl-map-region-import-"))
  try {
    const input = await createInput(root)
    input.config.sceneType = "VTOL_INSPECTION"
    input.config.vtlTaskObjects = [
      {
        id: "task-1",
        code: "T-01",
        title: "输电塔巡检",
        type: "POINT",
        positions: [{ longitude: 114, latitude: 22.5 }],
        requirement: "完成塔体巡检",
        completionRule: "到达任务点并保持 30 秒",
        estimatedWorkSeconds: 60
      },
      {
        id: "task-2",
        code: "T-02",
        title: "东西向廊道巡检",
        type: "LINE",
        positions: [{ longitude: 113.995, latitude: 22.502 }, { longitude: 114.005, latitude: 22.502 }],
        requirement: "沿线完成连续巡检",
        completionRule: "航段覆盖率达到 100%",
        estimatedWorkSeconds: 120
      }
    ]
    input.config.vtlLandingSites = [
      { id: "main-1", code: "MAIN-01", title: "主起降点", type: "MAIN", position: { longitude: 114, latitude: 22.5 }, elevationMeters: 10, relatedAlternateSiteIds: ["alternate-1"] },
      { id: "alternate-1", code: "ALT-01", title: "备降点", type: "ALTERNATE", position: { longitude: 114.005, latitude: 22.505 }, elevationMeters: 12, relatedAlternateSiteIds: [] }
    ]
    input.config.vtlAircraftParameters = {
      modelCode: "VTOL-TEST-01",
      version: "1.0.0",
      batteryCapacityWh: 1200,
      reserveEnergyRatio: 0.2,
      verticalPowerWatts: 2400,
      hoverPowerWatts: 1800,
      cruisePowerWatts: 900,
      taskPowerWatts: 1050,
      climbSpeedMps: 4,
      cruiseSpeedMps: 22,
      transitionSpeedMps: 12,
      minimumTransitionHeightMeters: 60,
      maximumOperatingAltitudeMeters: 300
    }
    const result = await importMapRegion({ config: input.config, configDirectory: input.configDirectory, outputRoot: join(root, "map") })
    const descriptor = JSON.parse(await readFile(join(root, "map", "regions", "TEST-REGION", "package", "region-package.json"), "utf8"))

    assert.equal(descriptor.content.sceneType, "VTOL_INSPECTION")
    assert.equal(descriptor.content.vtlTaskObjects[0].status, "UNASSIGNED")
    assert.equal(descriptor.content.vtlTaskObjects[1].type, "LINE")
    assert.equal(descriptor.content.vtlLandingSites.filter((site) => site.type === "MAIN").length, 1)
    assert.equal(descriptor.content.vtlAircraftParameters.modelCode, "VTOL-TEST-01")
    assert.equal(result.regionCode, "TEST-REGION")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function createInput(root) {
  const configDirectory = join(root, "config")
  const terrainDirectory = join(root, "terrain")
  const imageryDirectory = join(root, "imagery", "0", "0")
  await mkdir(configDirectory, { recursive: true })
  await mkdir(terrainDirectory, { recursive: true })
  await mkdir(imageryDirectory, { recursive: true })
  await writeFile(join(terrainDirectory, "layer.json"), JSON.stringify({ format: "quantized-mesh-1.0", tiles: ["{z}/{x}/{y}.terrain"] }))
  await writeFile(join(terrainDirectory, "0.terrain"), Buffer.from("quantized-mesh-test"))
  await writeFile(join(imageryDirectory, "0.png"), Buffer.from([137, 80, 78, 71]))
  const elevationSamplesPath = join(root, "elevation-samples.json")
  await writeFile(elevationSamplesPath, JSON.stringify({ samples: [{ longitude: 114, latitude: 22.5, heightMeters: 12 }] }))
  return {
    configDirectory,
    terrainDirectory,
    config: {
      regionCode: "TEST-REGION",
      sceneType: "CITY_LOGISTICS",
      title: "测试物流区域",
      summary: "用于导入回归的授权教学区域",
      version: "1.0.0",
      heightDatum: "AGL",
      center: { longitude: 114, latitude: 22.5 },
      boundary: [{ longitude: 113.99, latitude: 22.49 }, { longitude: 114.01, latitude: 22.49 }, { longitude: 114.01, latitude: 22.51 }, { longitude: 113.99, latitude: 22.51 }],
      terrain: { sourceDir: "../terrain", sourceFormat: "CESIUM_QUANTIZED_MESH", sourceCrs: "WGS84", version: "1.0.0", verticalDatum: "AMSL", conversion: { tool: "test-terrain-builder", version: "1.0.0" } },
      imagery: { sourceDir: "../imagery", provider: "XYZ", sourceCrs: "WGS84", version: "1.0.0" },
      elevationSamplesPath: "../elevation-samples.json",
      authorization: { provider: "测试授权单位", authorizationId: "AUTH-TEST-001", validUntil: "2099-01-01T00:00:00Z", sourceDescription: "授权 DEM 和影像测试数据" },
      layers: ["BUILDINGS", "RESTRICTIONS", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"].map((code) => ({ code, title: code, state: "AVAILABLE", source: "授权专题数据", version: "1.0.0", features: [] }))
    }
  }
}
