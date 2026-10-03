import type { SceneType, V3RegionLayerCode } from "@wurenji/shared"

/**
 * The map layer contract shared by teacher and student workspaces.
 *
 * A layer definition describes how a layer is presented and edited; it does
 * not contain Cesium entities or a Viewer instance. Keeping this registry as
 * plain data lets every map surface use the same ordering, labels and
 * permissions while still owning its own Viewer lifecycle.
 */
export type MapLayerKind = "BASE" | "OVERLAY"
export type MapLayerGeometryType = "POINT" | "LINESTRING" | "POLYGON"
export type MapLayerCode =
  | "BUILDINGS"
  | "ROADS"
  | "WATER"
  | "GREENLAND"
  | "TERRAIN"
  | "IMAGERY"
  | "OBSTACLES"
  | "RESTRICTIONS"
  | "OPERATING_AREA"
  | "TASK_POINTS"
  | "TASK_AREAS"
  | "ROUTES"
  | "WAYPOINTS"
  | "TAKEOFF_LANDING"
  | "ALTERNATE_AREAS"
  | "SHOW_ZONES"

export interface MapLayerDefinition {
  code: MapLayerCode
  kind: MapLayerKind
  title: string
  order: number
  defaultVisible: boolean
  editable: boolean
  allowedScenes: readonly SceneType[]
  geometryTypes: readonly MapLayerGeometryType[]
}

const allScenes: readonly SceneType[] = ["CITY_SHOW", "CITY_LOGISTICS", "VTOL_INSPECTION"]

export const mapLayerDefinitions: readonly MapLayerDefinition[] = [
  { code: "IMAGERY", kind: "BASE", title: "影像底图", order: 10, defaultVisible: true, editable: false, allowedScenes: allScenes, geometryTypes: [] },
  { code: "TERRAIN", kind: "BASE", title: "地形", order: 20, defaultVisible: true, editable: false, allowedScenes: allScenes, geometryTypes: [] },
  { code: "BUILDINGS", kind: "BASE", title: "建筑", order: 30, defaultVisible: true, editable: false, allowedScenes: allScenes, geometryTypes: ["POLYGON"] },
  { code: "ROADS", kind: "BASE", title: "道路", order: 40, defaultVisible: true, editable: false, allowedScenes: allScenes, geometryTypes: ["LINESTRING", "POLYGON"] },
  { code: "WATER", kind: "BASE", title: "水域", order: 50, defaultVisible: true, editable: false, allowedScenes: allScenes, geometryTypes: ["LINESTRING", "POLYGON"] },
  { code: "GREENLAND", kind: "BASE", title: "森林/绿地", order: 60, defaultVisible: true, editable: false, allowedScenes: allScenes, geometryTypes: ["LINESTRING", "POLYGON"] },
  { code: "OBSTACLES", kind: "OVERLAY", title: "障碍物", order: 110, defaultVisible: true, editable: true, allowedScenes: ["CITY_LOGISTICS", "VTOL_INSPECTION"], geometryTypes: ["POINT", "POLYGON"] },
  { code: "RESTRICTIONS", kind: "OVERLAY", title: "禁限区域", order: 120, defaultVisible: true, editable: true, allowedScenes: allScenes, geometryTypes: ["POLYGON"] },
  { code: "OPERATING_AREA", kind: "OVERLAY", title: "运行范围", order: 130, defaultVisible: true, editable: true, allowedScenes: ["CITY_LOGISTICS", "VTOL_INSPECTION"], geometryTypes: ["POLYGON"] },
  { code: "TASK_POINTS", kind: "OVERLAY", title: "任务点", order: 140, defaultVisible: true, editable: true, allowedScenes: ["CITY_LOGISTICS", "VTOL_INSPECTION"], geometryTypes: ["POINT"] },
  { code: "TASK_AREAS", kind: "OVERLAY", title: "任务区域", order: 150, defaultVisible: true, editable: true, allowedScenes: ["CITY_LOGISTICS", "VTOL_INSPECTION"], geometryTypes: ["POLYGON"] },
  { code: "ROUTES", kind: "OVERLAY", title: "航线", order: 160, defaultVisible: true, editable: true, allowedScenes: allScenes, geometryTypes: ["LINESTRING"] },
  { code: "WAYPOINTS", kind: "OVERLAY", title: "航点", order: 170, defaultVisible: true, editable: true, allowedScenes: allScenes, geometryTypes: ["POINT"] },
  { code: "TAKEOFF_LANDING", kind: "OVERLAY", title: "起降点", order: 180, defaultVisible: true, editable: true, allowedScenes: ["CITY_LOGISTICS", "VTOL_INSPECTION"], geometryTypes: ["POINT"] },
  { code: "ALTERNATE_AREAS", kind: "OVERLAY", title: "等待/备降区", order: 190, defaultVisible: true, editable: true, allowedScenes: ["CITY_LOGISTICS", "VTOL_INSPECTION"], geometryTypes: ["POLYGON"] },
  { code: "SHOW_ZONES", kind: "OVERLAY", title: "表演功能区", order: 200, defaultVisible: true, editable: true, allowedScenes: ["CITY_SHOW"], geometryTypes: ["POLYGON"] }
]

const definitionByCode = new Map(mapLayerDefinitions.map((definition) => [definition.code, definition]))

export function getMapLayerDefinition(code: string): MapLayerDefinition | undefined {
  return definitionByCode.get(code as MapLayerCode)
}

export function mapLayersForScene(scene: SceneType, kind?: MapLayerKind): readonly MapLayerDefinition[] {
  return mapLayerDefinitions.filter((definition) =>
    definition.allowedScenes.includes(scene) && (kind === undefined || definition.kind === kind)
  )
}

export function editableMapLayersForScene(scene: SceneType): readonly MapLayerDefinition[] {
  return mapLayersForScene(scene, "OVERLAY").filter((definition) => definition.editable)
}

/**
 * Existing region manifests still use V3RegionLayerCode. This helper keeps
 * compatibility explicit while allowing the registry to contain new base
 * layers such as roads, terrain and imagery.
 */
export function isRegisteredRegionLayer(code: V3RegionLayerCode | string): code is MapLayerCode {
  return definitionByCode.has(code as MapLayerCode)
}

