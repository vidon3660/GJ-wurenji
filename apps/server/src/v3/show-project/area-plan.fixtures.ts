import type { ShowAreaFeatureInput, ShowAreaFeatureType, V3RegionCatalogItem } from "@wurenji/shared"

export function completeFeatures(): ShowAreaFeatureInput[] {
  const types: ShowAreaFeatureType[] = [
    "TAKEOFF_LANDING",
    "FLIGHT",
    "PERFORMANCE",
    "BUFFER",
    "GROUND_ISOLATION",
    "AUDIENCE",
    "OPERATION",
    "EMERGENCY_LANDING",
    "GEOFENCE"
  ]
  return types.map((type, index) => {
    const column = index % 3
    const row = Math.floor(index / 3)
    const longitude = 113.993 + column * 0.006
    const latitude = 21.993 + row * 0.006
    return {
      id: `feature-${index + 1}`,
      type,
      label: `测试${type}`,
      positions: rectangle(longitude, latitude, 0.0016),
      ...((type === "FLIGHT" || type === "PERFORMANCE" || type === "GEOFENCE")
        ? { heightRange: { datum: "AGL" as const, minimumMeters: 20, maximumMeters: 120 } }
        : {}),
      properties: properties(type)
    }
  })
}

export function region(): V3RegionCatalogItem {
  return {
    packageId: "region-1",
    packageVersion: "1.0.0",
    checksum: "a".repeat(64),
    sceneType: "CITY_SHOW",
    regionCode: "SHOW-TEST",
    title: "测试区域",
    summary: "测试",
    center: { longitude: 114, latitude: 22 },
    boundary: rectangle(113.989, 21.989, 0.022),
    heightDatum: "AGL",
    terrainResourceVersion: "DEM-TEST",
    imageryState: "AVAILABLE",
    layers: ["BUILDINGS", "RESTRICTIONS", "POSITIONING", "COMMUNICATION", "ENVIRONMENT"].map((code) => ({
      code: code as V3RegionCatalogItem["layers"][number]["code"],
      title: code,
      state: "AVAILABLE",
      source: "test",
      version: "1",
      features: []
    }))
  }
}

function rectangle(longitude: number, latitude: number, size: number) {
  return [
    { longitude, latitude },
    { longitude: longitude + size, latitude },
    { longitude: longitude + size, latitude: latitude + size },
    { longitude, latitude: latitude + size }
  ]
}

function properties(type: ShowAreaFeatureType): Record<string, string | number | boolean> {
  if (type === "TAKEOFF_LANDING") return { capacity: 100, orientationDegrees: 0 }
  if (type === "PERFORMANCE") return { orientationDegrees: 0 }
  if (type === "BUFFER") return { referenceWidthMeters: 30 }
  if (type === "GROUND_ISOLATION" || type === "OPERATION") return { purpose: "教学" }
  if (type === "AUDIENCE") return { orientationDegrees: 0, capacityLevel: "中型" }
  if (type === "EMERGENCY_LANDING") return { availability: "全程可用", capacityLevel: "单组" }
  if (type === "GEOFENCE") return { policy: "越界告警" }
  return {}
}
