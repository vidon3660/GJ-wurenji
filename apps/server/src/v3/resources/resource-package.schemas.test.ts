import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { validateResourceManifest } from "./resource-package.schemas.js"
import { assertFormalRegionManifest, assertFormalShowDocumentManifest } from "./resource-package.service.js"

describe("resource package terrain schema", () => {
  it("accepts an explicit offline map manifest and vector layer", () => {
    const value = manifest()
    const content = value.content as Record<string, unknown>
    content.mapResourceVersion = "1.0.0"
    content.mapResourceManifest = {
      manifestVersion: 1,
      mapResourceVersion: "1.0.0",
      coordinateReference: "EPSG:4326",
      heightDatum: "AGL",
      coverage: [113.99, 22.49, 114.01, 22.51],
      baseLayers: [],
      vectorLayers: [{ id: "buildings", format: "GEOJSON", path: "/map/regions/LOG-TEST-01/buildings.geojson", version: "1.0.0", sha256: "a".repeat(64), coordinateReference: "EPSG:4326", extent: [113.99, 22.49, 114.01, 22.51] }]
    }
    content.layers = [{ code: "BUILDINGS", title: "建筑", state: "AVAILABLE", source: "offline", version: "1.0.0", features: [], dataUrl: "/map/regions/LOG-TEST-01/buildings.geojson", format: "GEOJSON", coordinateReference: "EPSG:4326", sha256: "a".repeat(64), extent: [113.99, 22.49, 114.01, 22.51] }]
    expect(validateResourceManifest(value).errors).toEqual([])
  })

  it("rejects vector paths that escape the local map mount", () => {
    const value = manifest()
    ;(value.content as Record<string, unknown>).layers = [{ code: "BUILDINGS", title: "建筑", state: "AVAILABLE", source: "offline", version: "1.0.0", features: [], dataUrl: "/map/../secrets.geojson", format: "GEOJSON" }]
    expect(validateResourceManifest(value).errors.join("\n")).toContain("dataUrl 路径无效")
  })

  it("accepts a versioned Cesium terrain resource in a region package", () => {
    const result = validateResourceManifest(manifest())

    expect(result.errors).toEqual([])
    expect(result.manifest?.content).toMatchObject({ terrain: { provider: "CESIUM_QUANTIZED_MESH", verticalDatum: "AMSL" } })
  })

  it("rejects an unsupported terrain provider", () => {
    const value = manifest()
    ;(value.content as Record<string, unknown>).terrain = { ...(value.content as Record<string, unknown>).terrain as Record<string, unknown>, provider: "GEOTIFF" }

    expect(validateResourceManifest(value).errors.join("\n")).toContain("content/terrain/provider")
  })

  it("accepts a VTOL inspection region package", () => {
    const value = manifest()
    value.content = {
      ...(value.content as Record<string, unknown>),
      sceneType: "VTOL_INSPECTION",
      vtlTaskObjects: [{ id: "task-1", type: "POINT" }],
      vtlLandingSites: [{ id: "main-1", type: "MAIN" }]
    }

    expect(validateResourceManifest(value).errors).toEqual([])
  })

  it("runs region catalog semantics during formal preflight", () => {
    const incomplete = manifest()
    expect(validateResourceManifest(incomplete).errors).toEqual([])
    expect(() => assertFormalRegionManifest(incomplete as never, resourceIdentity())).toThrow("catalogVersion")

    const valid = manifest()
    valid.content = validVtlRegionContent()
    const checks = []
    const region = assertFormalRegionManifest(valid as never, resourceIdentity(), checks)
    expect(region).toMatchObject({ sceneType: "VTOL_INSPECTION", regionCode: "VTL-TEST-01" })
    expect(checks).toEqual([{ code: "REGION_CATALOG", passed: true, message: "区域目录 VTL-TEST-01 语义校验通过" }])
  })
})

describe("resource package event schema", () => {
  it("accepts formal event definitions", () => {
    const value = manifest()
    value.packageType = "EVENT"
    value.content = {
      sceneType: "CITY_LOGISTICS",
      events: [{
        code: "WEATHER_CHANGE",
        title: "局部天气变化",
        category: "WEATHER_ENVIRONMENT",
        severity: "WARNING",
        detectionDelaySeconds: 5,
        escalationDelaySeconds: 45
      }]
    }

    expect(validateResourceManifest(value).errors).toEqual([])
  })

  it("rejects an event definition without a code", () => {
    const value = manifest()
    value.packageType = "EVENT"
    value.content = {
      sceneType: "CITY_SHOW",
      events: [{ title: "缺少代码", category: "WEATHER", severity: "WARNING" }]
    }

    expect(validateResourceManifest(value).errors.join("\n")).toContain("content/events/0")
  })
})

describe("formal show document package", () => {
  it("accepts exactly three declared DOCX master templates", () => {
    const value = documentManifest()

    expect(validateResourceManifest(value).errors).toEqual([])
    expect(() => assertFormalShowDocumentManifest(value as never, documentEntries(value))).not.toThrow()
  })

  it("rejects a placeholder document package", () => {
    const value = documentManifest()
    value.content = { sceneType: "CITY_SHOW", documents: [] }

    expect(validateResourceManifest(value).errors.join("\n")).toContain("content/documents")
    expect(() => assertFormalShowDocumentManifest(value as never)).toThrow("exactly three")
  })

  it("rejects a formal code with a non-fixed template title", () => {
    const value = documentManifest()
    ;(value.content as { documents: Array<{ title: string }> }).documents[0]!.title = "Custom application form"

    expect(() => assertFormalShowDocumentManifest(value as never)).toThrow("title does not match")
  })

  it("rejects a DOCX payload whose bytes do not match the manifest", () => {
    const value = documentManifest()
    const entries = documentEntries(value)
    entries.set("payload/form.docx", Buffer.from("not-a-docx"))

    expect(() => assertFormalShowDocumentManifest(value as never, entries)).toThrow("archive content is invalid")
  })
})

describe("REPORT evaluation rubric schema", () => {
  it("accepts one unique 100-point rubric for each scene", () => {
    const value = reportManifest()

    expect(validateResourceManifest(value).errors).toEqual([])
  })

  it("rejects a rubric whose item scores do not total 100", () => {
    const value = reportManifest()
    ;((value.content as { rubrics: Array<{ items: Array<{ maxScore: number }> }> }).rubrics[0]!.items[0]!).maxScore = 14

    expect(validateResourceManifest(value).errors.join("\n")).toContain("maxScore total must equal 100")
  })

  it("rejects duplicated item codes and duplicated scenes", () => {
    const value = reportManifest()
    const content = value.content as { rubrics: Array<{ sceneType: string; items: Array<{ code: string }> }> }
    content.rubrics[0]!.items[1]!.code = content.rubrics[0]!.items[0]!.code
    content.rubrics[1]!.sceneType = content.rubrics[0]!.sceneType

    const errors = validateResourceManifest(value).errors.join("\n")
    expect(errors).toContain("duplicate codes")
    expect(errors).toContain("duplicate sceneType")
  })
})

function manifest(): Record<string, unknown> {
  const checksum = "a".repeat(64)
  return {
    formatVersion: 1,
    packageType: "REGION",
    name: "区域资源包",
    version: "1.0.0",
    schemaVersion: 1,
    minimumPlatformVersion: "0.1.0",
    publishedAt: "2026-08-12T00:00:00.000Z",
    signature: { algorithm: "Ed25519", keyId: "test-key" },
    dependencies: [],
    files: [
      { path: "manifest.json", role: "manifest", mimeType: "application/json", sizeBytes: 1, sha256: checksum },
      { path: "terrain/layer.json", role: "terrain", mimeType: "application/json", sizeBytes: 1, sha256: checksum }
    ],
    content: {
      sceneType: "CITY_LOGISTICS",
      regionCode: "LOG-TEST-01",
      title: "测试物流区域",
      center: { longitude: 114, latitude: 22.5 },
      boundary: [{ longitude: 113.99, latitude: 22.49 }, { longitude: 114.01, latitude: 22.49 }, { longitude: 114.01, latitude: 22.51 }],
      heightDatum: "AGL",
      terrain: {
        provider: "CESIUM_QUANTIZED_MESH",
        url: "/map/terrain/log-test/1.0.0/layer.json",
        version: "1.0.0",
        sha256: checksum,
        verticalDatum: "AMSL",
        extent: [113.99, 22.49, 114.01, 22.51]
      },
      layers: [{ code: "BUILDINGS" }]
    }
  }
}

function documentManifest(): Record<string, unknown> {
  const documents = [
    { code: "AIRSPACE_APPLICATION_FORM", title: "无人机临时飞行空域申请表", path: "payload/form.docx" },
    { code: "AIRSPACE_APPLICATION_LETTER", title: "关于申请无人机临时飞行空域的函", path: "payload/letter.docx" },
    { code: "SAFETY_EMERGENCY_PLAN", title: "安全应急预案", path: "payload/plan.docx" }
  ]
  const content = Buffer.from([0x50, 0x4b, 0x03, 0x04])
  const checksum = "a".repeat(64)
  return {
    formatVersion: 1,
    packageType: "DOCUMENT_TEMPLATE",
    name: "Formal show documents",
    version: "1.0.0",
    schemaVersion: 1,
    minimumPlatformVersion: "0.1.0",
    publishedAt: "2026-08-12T00:00:00.000Z",
    signature: { algorithm: "Ed25519", keyId: "test-key" },
    dependencies: [],
    files: [
      { path: "schemas/manifest.schema.json", role: "MANIFEST_SCHEMA", mimeType: "application/schema+json", sizeBytes: 1, sha256: checksum },
      ...documents.map((document) => ({ path: document.path, role: document.code, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sizeBytes: content.byteLength, sha256: sha256ForTest(content) }))
    ],
    content: { sceneType: "CITY_SHOW", documents }
  }
}

function documentEntries(value: Record<string, unknown>): Map<string, Buffer> {
  const documents = (value.content as { documents: Array<{ path: string }> }).documents
  return new Map(documents.map((document) => [document.path, Buffer.from([0x50, 0x4b, 0x03, 0x04])]))
}

function reportManifest(): Record<string, unknown> {
  const value = manifest()
  value.packageType = "REPORT"
  value.content = {
    outputs: ["SINGLE_DOCX", "SINGLE_PDF"],
    rubrics: [
      rubricDefinition("CITY_SHOW", [15, 15, 15, 25, 15, 15]),
      rubricDefinition("CITY_LOGISTICS", [20, 15, 20, 15, 20, 10])
    ]
  }
  return value
}

function rubricDefinition(sceneType: "CITY_SHOW" | "CITY_LOGISTICS", scores: number[]) {
  return {
    sceneType,
    version: "1.0.0",
    title: `${sceneType} 评价量表`,
    sourceReferences: ["需求规格说明书 12.2"],
    items: scores.map((maxScore, index) => ({
      code: `${sceneType}_${index + 1}`,
      label: `评价项 ${index + 1}`,
      maxScore,
      sourceReferences: ["需求规格说明书 13.2"]
    }))
  }
}

function sha256ForTest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex")
}

function resourceIdentity() {
  return { id: "region-id", name: "垂起测试区域", version: "1.0.0", sha256: "a".repeat(64) }
}

function validVtlRegionContent() {
  return {
    catalogVersion: 1,
    sceneType: "VTOL_INSPECTION",
    regionCode: "VTL-TEST-01",
    title: "垂起测试区域",
    summary: "用于正式资源语义预检",
    center: { longitude: 114, latitude: 22.5 },
    boundary: [{ longitude: 113.99, latitude: 22.49 }, { longitude: 114.01, latitude: 22.49 }, { longitude: 114.01, latitude: 22.51 }, { longitude: 113.99, latitude: 22.51 }],
    heightDatum: "AGL",
    terrainResourceVersion: "1.0.0",
    imageryState: "AVAILABLE",
    layers: ["BUILDINGS", "RESTRICTIONS", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"].map((code) => ({ code, title: code, state: "AVAILABLE", source: "正式资源", version: "1.0.0", features: [] })),
    vtlTaskObjects: [{ id: "task-1", code: "T-01", title: "巡检对象", type: "POINT", positions: [{ longitude: 114, latitude: 22.5 }], requirement: "完成巡检", completionRule: "到达并观察", required: true, estimatedWorkSeconds: 60 }],
    vtlLandingSites: [
      { id: "main-1", code: "MAIN-01", title: "主起降点", type: "MAIN", position: { longitude: 114, latitude: 22.5 }, elevationMeters: 10, status: "AVAILABLE", relatedAlternateSiteIds: ["alternate-1"] },
      { id: "alternate-1", code: "ALT-01", title: "备降点", type: "ALTERNATE", position: { longitude: 114.005, latitude: 22.505 }, elevationMeters: 12, status: "AVAILABLE", relatedAlternateSiteIds: [] }
    ],
    vtlAircraftParameters: {
      modelCode: "VTOL-TEST-01", version: "1.0.0", batteryCapacityWh: 1200, reserveEnergyRatio: 0.2,
      verticalPowerWatts: 2400, hoverPowerWatts: 1800, cruisePowerWatts: 900, taskPowerWatts: 1050,
      climbSpeedMps: 4, cruiseSpeedMps: 22, transitionSpeedMps: 12, minimumTransitionHeightMeters: 60, maximumOperatingAltitudeMeters: 300
    }
  }
}
