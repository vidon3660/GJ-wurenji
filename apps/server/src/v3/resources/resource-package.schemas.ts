import { Ajv, type ValidateFunction } from "ajv"
import { resourcePackageTypes, type ResourcePackageType, type V3ResourceArchiveManifest } from "@wurenji/shared"
import { inspectEvaluationRubrics } from "./evaluation-rubric.js"

const semanticVersionPattern = "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$"
const sha256Pattern = "^[a-f0-9]{64}$"

const baseManifestSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "formatVersion", "packageType", "name", "version", "schemaVersion", "minimumPlatformVersion",
    "publishedAt", "signature", "dependencies", "files", "content"
  ],
  properties: {
    formatVersion: { const: 1 },
    packageType: { enum: resourcePackageTypes },
    name: { type: "string", minLength: 1, maxLength: 120 },
    version: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
    schemaVersion: { type: "integer", minimum: 1, maximum: 1000 },
    minimumPlatformVersion: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
    publishedAt: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T" },
    signature: {
      type: "object",
      additionalProperties: false,
      required: ["algorithm", "keyId"],
      properties: {
        algorithm: { const: "Ed25519" },
        keyId: { type: "string", minLength: 1, maxLength: 120, pattern: "^[A-Za-z0-9._:-]+$" }
      }
    },
    dependencies: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["packageType", "name", "version"],
        properties: {
          packageType: { enum: resourcePackageTypes },
          name: { type: "string", minLength: 1, maxLength: 120 },
          version: { type: "string", pattern: semanticVersionPattern, maxLength: 40 }
        }
      }
    },
    files: {
      type: "array",
      minItems: 2,
      maxItems: 196,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "role", "mimeType", "sizeBytes", "sha256"],
        properties: {
          path: { type: "string", minLength: 1, maxLength: 500 },
          role: { type: "string", minLength: 1, maxLength: 80 },
          mimeType: { type: "string", minLength: 1, maxLength: 120 },
          sizeBytes: { type: "integer", minimum: 0, maximum: 104857600 },
          sha256: { type: "string", pattern: sha256Pattern }
        }
      }
    },
    content: { type: "object" }
  }
} as const

const contentSchemas: Record<ResourcePackageType, Record<string, unknown>> = {
  RULE: objectWithRequired("rules", { rules: { type: "array", minItems: 1 } }),
  REGION: objectWithRequired("sceneType", {
    sceneType: sceneTypeSchema(),
    regionCode: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    center: { type: "object" },
    boundary: { type: "array", minItems: 3 },
    heightDatum: { enum: ["AGL", "AMSL"] },
    mapResourceVersion: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
    coordinateReference: { const: "EPSG:4326" },
    mapResourceManifest: mapResourceManifestSchema(),
    terrain: terrainResourceSchema(),
    imagery: imageryResourceSchema(),
    layers: { type: "array", minItems: 1, items: regionLayerSchema() }
  }, ["regionCode", "title", "center", "boundary", "heightDatum", "layers"]),
  SCALE_TEMPLATE: objectWithRequired("sceneType", {
    sceneType: sceneTypeSchema(),
    templates: { type: "array", minItems: 1 }
  }, ["templates"]),
  AIRCRAFT: objectWithRequired("modelCode", { modelCode: { type: "string", minLength: 1 } }),
  EVENT: {
    type: "object",
    required: ["sceneType"],
    properties: {
      sceneType: sceneTypeSchema(),
      categories: { anyOf: [{ type: "integer", minimum: 1 }, { type: "array", minItems: 1 }] },
      events: { type: "array", minItems: 1, maxItems: 100, items: eventDefinitionSchema() }
    },
    anyOf: [{ required: ["categories"] }, { required: ["events"] }]
  },
  SHOW_PROGRAM: objectWithRequired("sceneType", {
    sceneType: { const: "CITY_SHOW" },
    format: { const: "LOCAL_ENU_CSV_V1" },
    sourceSoftware: { type: "string", minLength: 1, maxLength: 120 },
    aircraftCount: { enum: [100, 500, 1000, 3000] },
    groupSize: { const: 100 },
    keyframeCount: { type: "integer", minimum: 2, maximum: 1000000 },
    sourceRowCount: { type: "integer", minimum: 200, maximum: 5000000 },
    durationMs: { type: "integer", minimum: 10000, maximum: 1800000 },
    maximumAltitudeMeters: { type: "number", minimum: 0, maximum: 500 },
    horizontalRadiusMeters: { type: "number", minimum: 0, maximum: 5000 },
    maximumSpeedMetersPerSecond: { type: "number", minimum: 0, maximum: 40 },
    groupTracks: {
      type: "array",
      minItems: 1,
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["groupId", "points"],
        properties: {
          groupId: { type: "string", pattern: "^G\\d{2}$" },
          points: {
            type: "array",
            minItems: 2,
            maxItems: 301,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["timeMs", "eastMeters", "northMeters", "upMeters"],
              properties: {
                timeMs: { type: "integer", minimum: 0, maximum: 1800000 },
                eastMeters: { type: "number", minimum: -5000, maximum: 5000 },
                northMeters: { type: "number", minimum: -5000, maximum: 5000 },
                upMeters: { type: "number", minimum: 0, maximum: 500 }
              }
            }
          }
        }
      }
    }
  }, ["format", "sourceSoftware", "aircraftCount", "groupSize", "keyframeCount", "sourceRowCount", "durationMs", "maximumAltitudeMeters", "horizontalRadiusMeters", "maximumSpeedMetersPerSecond", "groupTracks"]),
  DOCUMENT_TEMPLATE: objectWithRequired("documents", {
    sceneType: { const: "CITY_SHOW" },
    documents: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        required: ["code", "title", "path"],
        properties: {
          code: { enum: ["AIRSPACE_APPLICATION_FORM", "AIRSPACE_APPLICATION_LETTER", "SAFETY_EMERGENCY_PLAN"] },
          title: { type: "string", minLength: 1, maxLength: 160 },
          filename: { type: "string", minLength: 6, maxLength: 240, pattern: "\\.docx$" },
          path: { type: "string", pattern: "^payload/.+\\.docx$", maxLength: 500 }
        }
      }
    }
  }, ["sceneType"]),
  REPORT: {
    type: "object",
    properties: {
      output: { type: "string", minLength: 1, maxLength: 80 },
      outputs: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
      include: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 120 } },
      rubrics: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["sceneType", "version", "title", "sourceReferences", "items"],
          properties: {
            sceneType: sceneTypeSchema(),
            version: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
            title: { type: "string", minLength: 1, maxLength: 160 },
            sourceReferences: sourceReferencesSchema(),
            items: {
              type: "array",
              minItems: 1,
              maxItems: 50,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["code", "label", "maxScore", "sourceReferences"],
                properties: {
                  code: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Z][A-Z0-9_:-]*$" },
                  label: { type: "string", minLength: 1, maxLength: 160 },
                  maxScore: { type: "number", exclusiveMinimum: 0, maximum: 100 },
                  sourceReferences: sourceReferencesSchema()
                }
              }
            }
          }
        }
      }
    },
    anyOf: [
      { required: ["output"], properties: { output: { type: "string", minLength: 1 } } },
      { required: ["outputs"], properties: { outputs: { type: "array", minItems: 1 } } }
    ]
  }
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validateManifest = ajv.compile(baseManifestSchema)
const contentValidators = Object.fromEntries(resourcePackageTypes.map((packageType) => [
  packageType,
  ajv.compile(contentSchemas[packageType])
])) as Record<ResourcePackageType, ValidateFunction>

export function validateResourceManifest(value: unknown): { manifest: V3ResourceArchiveManifest | null; errors: string[] } {
  if (!validateManifest(value)) return { manifest: null, errors: formatErrors(validateManifest) }
  const manifest = value as V3ResourceArchiveManifest
  const validateContent = contentValidators[manifest.packageType]
  if (!validateContent(manifest.content)) return { manifest: null, errors: formatErrors(validateContent).map((error) => `content${error}`) }
  if (manifest.packageType === "REPORT") {
    const inspection = inspectEvaluationRubrics(manifest.content)
    if (inspection.errors.length > 0) return { manifest: null, errors: inspection.errors.map((error) => `content${error}`) }
  }
  if (manifest.packageType === "REGION") {
    const mapErrors = validateMapResourceSemantics(manifest.content)
    if (mapErrors.length > 0) return { manifest: null, errors: mapErrors.map((error) => `content${error}`) }
  }
  return { manifest, errors: [] }
}

function validateMapResourceSemantics(content: Record<string, unknown>): string[] {
  const errors: string[] = []
  const mapVersion = content.mapResourceVersion
  const mapManifest = content.mapResourceManifest
  if (mapManifest && typeof mapManifest === "object" && !Array.isArray(mapManifest)) {
    const declared = (mapManifest as Record<string, unknown>).mapResourceVersion
    if (typeof mapVersion === "string" && declared !== mapVersion) errors.push("/mapResourceManifest/mapResourceVersion 必须与 mapResourceVersion 一致")
    const coverage = (mapManifest as Record<string, unknown>).coverage
    if (Array.isArray(coverage) && !validExtent(coverage)) errors.push("/mapResourceManifest/coverage 覆盖范围无效")
  }
  for (const key of ["terrain", "imagery"] as const) {
    const resource = content[key]
    if (resource && typeof resource === "object" && !Array.isArray(resource)) {
      const value = resource as Record<string, unknown>
      if (typeof value.url === "string" && isUnsafeMapPath(value.url)) errors.push(`/${key}/url 路径无效或包含目录穿越`)
      if (Array.isArray(value.extent) && !validExtent(value.extent)) errors.push(`/${key}/extent 覆盖范围无效`)
    }
  }
  const layers = Array.isArray(content.layers) ? content.layers : []
  layers.forEach((layer, index) => {
    if (typeof layer !== "object" || layer === null || Array.isArray(layer)) return
    const value = layer as Record<string, unknown>
    if (typeof value.dataUrl === "string" && isUnsafeMapPath(value.dataUrl)) errors.push(`/layers/${index}/dataUrl 路径无效或包含目录穿越`)
    if (Array.isArray(value.extent) && !validExtent(value.extent)) errors.push(`/layers/${index}/extent 覆盖范围无效`)
    if (value.format && value.format !== "GEOJSON" && value.format !== "MVT") errors.push(`/layers/${index}/format 必须为 GEOJSON 或 MVT`)
  })
  return errors
}

function validExtent(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === "number" && Number.isFinite(item))
    && value[0]! >= -180 && value[2]! <= 180 && value[1]! >= -90 && value[3]! <= 90
    && value[0]! < value[2]! && value[1]! < value[3]!
}

function isUnsafeMapPath(value: string): boolean {
  try {
    const parsed = new URL(value, "http://local.map")
    if (parsed.origin !== "http://local.map") return false
    const path = decodeURIComponent(parsed.pathname)
    return !path.startsWith("/map/") || path.split("/").some((part) => part === ".." || part === "\\")
  } catch {
    return true
  }
}

function objectWithRequired(
  primary: string,
  properties: Record<string, unknown>,
  additionalRequired: string[] = []
): Record<string, unknown> {
  return { type: "object", required: [primary, ...additionalRequired], properties }
}

function sceneTypeSchema() {
  return { enum: ["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"] }
}

function sourceReferencesSchema() {
  return { type: "array", minItems: 1, maxItems: 30, items: { type: "string", minLength: 1, maxLength: 240 } }
}

function terrainResourceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["provider", "url", "version", "sha256", "verticalDatum", "extent"],
    properties: {
      provider: { const: "CESIUM_QUANTIZED_MESH" },
      url: { type: "string", minLength: 1, maxLength: 1000 },
      version: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
      sha256: { type: "string", pattern: sha256Pattern },
      verticalDatum: { enum: ["AMSL", "ELLIPSOID"] },
      extent: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } },
      coordinateReference: { const: "EPSG:4326" },
      elevationSampleUrl: { type: "string", minLength: 1, maxLength: 1000 },
      elevationSampleSha256: { type: "string", pattern: sha256Pattern }
    }
  }
}

function imageryResourceSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["provider", "url", "version", "sha256", "extent"],
    properties: {
      provider: { enum: ["XYZ", "TMS", "SINGLE_TILE"] },
      url: { type: "string", minLength: 1, maxLength: 1000 },
      version: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
      sha256: { type: "string", pattern: sha256Pattern },
      extent: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } },
      coordinateReference: { const: "EPSG:4326" }
    }
  }
}

function regionLayerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {
      code: { enum: ["BUILDINGS", "RESTRICTIONS", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"] },
      title: { type: "string", minLength: 1, maxLength: 160 },
      state: { enum: ["AVAILABLE", "DEGRADED", "UNAVAILABLE"] },
      source: { type: "string", minLength: 1, maxLength: 240 },
      version: { type: "string", minLength: 1, maxLength: 40 },
      features: { type: "array", maxItems: 200000 },
      dataUrl: { type: "string", minLength: 1, maxLength: 1000 },
      format: { enum: ["GEOJSON", "MVT"] },
      coordinateReference: { const: "EPSG:4326" },
      sha256: { type: "string", pattern: sha256Pattern },
      extent: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } }
    }
  }
}

function mapResourceManifestSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["manifestVersion", "mapResourceVersion", "coordinateReference", "heightDatum", "coverage"],
    properties: {
      manifestVersion: { const: 1 },
      mapResourceVersion: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
      coordinateReference: { const: "EPSG:4326" },
      heightDatum: { enum: ["AGL", "AMSL"] },
      coverage: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } },
      baseLayers: { type: "array", maxItems: 20, items: mapManifestLayerSchema() },
      vectorLayers: { type: "array", maxItems: 100, items: mapManifestLayerSchema() },
      terrain: { type: "object" },
      imagery: { type: "object" }
    }
  }
}

function mapManifestLayerSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["id", "format", "path", "version", "sha256", "coordinateReference", "extent"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 120 },
      format: { enum: ["XYZ", "TMS", "SINGLE_TILE", "GEOJSON", "MVT", "CESIUM_QUANTIZED_MESH"] },
      path: { type: "string", minLength: 1, maxLength: 1000 },
      version: { type: "string", pattern: semanticVersionPattern, maxLength: 40 },
      sha256: { type: "string", pattern: sha256Pattern },
      coordinateReference: { const: "EPSG:4326" },
      verticalDatum: { enum: ["AGL", "AMSL", "ELLIPSOID"] },
      extent: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } }
    }
  }
}

function eventDefinitionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["code", "title", "category", "severity"],
    properties: {
      code: { type: "string", minLength: 1, maxLength: 80, pattern: "^[A-Z0-9_:-]+$" },
      title: { type: "string", minLength: 1, maxLength: 160 },
      detail: { type: "string", maxLength: 2_000 },
      category: { type: "string", minLength: 1, maxLength: 80 },
      severity: { enum: ["INFO", "WARNING", "ERROR", "CRITICAL"] },
      affectedRatio: { type: "number", minimum: 0, maximum: 1 },
      detectionDelaySeconds: { type: "number", minimum: 0, maximum: 86_400 },
      escalationDelaySeconds: { type: "number", minimum: 0, maximum: 86_400 },
      recommendedActions: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 80 } },
      supportedStages: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
      defaultScenario: { type: "object" }
    }
  }
}

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "不符合 schema"}`)
}
