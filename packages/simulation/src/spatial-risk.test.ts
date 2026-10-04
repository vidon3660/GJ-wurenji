import { describe, expect, it } from "vitest"
import { createDemoScene } from "@wurenji/shared"
import type { MissionPlan } from "@wurenji/shared"
import { evaluateSpatialRisk } from "./spatial-risk.js"

function plan(scene: ReturnType<typeof createDemoScene>, waypoints: MissionPlan["dronePlans"][number]["waypoints"][], delays: number[] = []): MissionPlan {
  return {
    id: "spatial-test",
    sceneId: scene.id,
    sceneVersion: scene.version,
    version: 1,
    updatedAt: new Date(0).toISOString(),
    dronePlans: waypoints.map((items, index) => ({
      droneId: `U-${index + 1}`,
      groupId: "G",
      assignedTaskIds: [],
      takeoffDelaySeconds: delays[index] ?? 0,
      waypoints: items
    }))
  }
}

describe("evaluateSpatialRisk", () => {
  it("detects a building crossing between coarse samples", () => {
    const scene = createDemoScene()
    const building = scene.obstacles[0]!
    const left = { ...building.center, longitude: building.center.longitude - 0.0012, altitude: 20 }
    const right = { ...building.center, longitude: building.center.longitude + 0.0012, altitude: 20 }
    const result = evaluateSpatialRisk(scene, plan(scene, [[
      { id: "a", position: { ...left, groundHeightMeters: 0 }, speedMps: 120, waitSeconds: 0 },
      { id: "b", position: { ...right, groundHeightMeters: 0 }, speedMps: 120, waitSeconds: 0 }
    ]]))
    expect(result.some((finding) => finding.code === "BUILDING_COLLISION" && finding.objectIds.includes(building.id))).toBe(true)
  })

  it("finds synchronized air separation loss at segment midpoint", () => {
    const scene = createDemoScene()
    scene.obstacles = []
    const center = scene.takeoffPoint
    const result = evaluateSpatialRisk(scene, plan(scene, [
      [
        { id: "a0", position: { ...center, longitude: center.longitude - 0.0006, altitude: 80 }, speedMps: 20, waitSeconds: 0 },
        { id: "a1", position: { ...center, longitude: center.longitude + 0.0006, altitude: 80 }, speedMps: 20, waitSeconds: 0 }
      ],
      [
        { id: "b0", position: { ...center, latitude: center.latitude - 0.0006, altitude: 80 }, speedMps: 20, waitSeconds: 0 },
        { id: "b1", position: { ...center, latitude: center.latitude + 0.0006, altitude: 80 }, speedMps: 20, waitSeconds: 0 }
      ]
    ]))
    expect(result.some((finding) => finding.code === "AIR_CONFLICT")).toBe(true)
    expect(result.find((finding) => finding.code === "AIR_CONFLICT")?.timeSeconds).toBeGreaterThan(0)
  })

  it("evaluates terrain clearance from endpoint ground elevations", () => {
    const scene = createDemoScene()
    scene.obstacles = []
    scene.rules.minimumTerrainClearanceMeters = 30
    const start = { ...scene.takeoffPoint, altitude: 40, groundHeightMeters: 20 }
    const end = { ...scene.landingPoint, altitude: 40, groundHeightMeters: 20 }
    const result = evaluateSpatialRisk(scene, plan(scene, [[
      { id: "a", position: start, speedMps: 10, waitSeconds: 0 },
      { id: "b", position: end, speedMps: 10, waitSeconds: 0 }
    ]]))
    expect(result.some((finding) => finding.code === "GROUND_CLEARANCE")).toBe(true)
  })

  it("detects a polygon restriction crossed between waypoints", () => {
    const scene = createDemoScene()
    scene.obstacles = []
    scene.noFlyZones = [{
      id: "zone-test",
      name: "临时限制区",
      positions: [
        { longitude: scene.takeoffPoint.longitude - 0.0002, latitude: scene.takeoffPoint.latitude - 0.0002, altitude: 0 },
        { longitude: scene.takeoffPoint.longitude + 0.0002, latitude: scene.takeoffPoint.latitude - 0.0002, altitude: 0 },
        { longitude: scene.takeoffPoint.longitude + 0.0002, latitude: scene.takeoffPoint.latitude + 0.0002, altitude: 0 },
        { longitude: scene.takeoffPoint.longitude - 0.0002, latitude: scene.takeoffPoint.latitude + 0.0002, altitude: 0 }
      ],
      minimumAltitudeMeters: 0,
      maximumAltitudeMeters: 120
    }]
    const result = evaluateSpatialRisk(scene, plan(scene, [[
      { id: "a", position: { ...scene.takeoffPoint, longitude: scene.takeoffPoint.longitude - 0.0008, altitude: 60 }, speedMps: 20, waitSeconds: 0 },
      { id: "b", position: { ...scene.takeoffPoint, longitude: scene.takeoffPoint.longitude + 0.0008, altitude: 60 }, speedMps: 20, waitSeconds: 0 }
    ]]))
    expect(result.some((finding) => finding.code === "NO_FLY_INTRUSION" && finding.objectIds.includes("zone-test"))).toBe(true)
  })

  it("does not compare a route before its takeoff delay as airborne", () => {
    const scene = createDemoScene()
    scene.obstacles = []
    scene.noFlyZones = []
    scene.rules.horizontalSeparationMeters = 20
    scene.rules.verticalSeparationMeters = 10
    const center = { ...scene.takeoffPoint, altitude: 80 }
    const result = evaluateSpatialRisk(scene, plan(scene, [
      [
        { id: "delayed-start", position: center, speedMps: 20, waitSeconds: 0 },
        { id: "delayed-end", position: { ...center, longitude: center.longitude + 0.001 }, speedMps: 20, waitSeconds: 0 }
      ],
      [
        { id: "active-start", position: center, speedMps: 20, waitSeconds: 0 },
        { id: "active-end", position: { ...center, latitude: center.latitude + 0.001 }, speedMps: 20, waitSeconds: 0 }
      ]
    ], [10, 0]))
    expect(result.some((finding) => finding.code === "AIR_CONFLICT")).toBe(false)
  })

  it("finds a vertical separation conflict inside a long horizontal overlap", () => {
    const scene = createDemoScene()
    scene.obstacles = []
    scene.noFlyZones = []
    scene.rules.horizontalSeparationMeters = 20
    scene.rules.verticalSeparationMeters = 10
    const center = { ...scene.takeoffPoint, altitude: 80 }
    const result = evaluateSpatialRisk(scene, plan(scene, [
      [
        { id: "left-start", position: { ...center, longitude: center.longitude - 0.00005, altitude: 0 }, speedMps: 0.5, waitSeconds: 0 },
        { id: "left-end", position: { ...center, longitude: center.longitude + 0.00005, altitude: 0 }, speedMps: 0.5, waitSeconds: 0 }
      ],
      [
        { id: "right-start", position: { ...center, altitude: 100 }, speedMps: 20, waitSeconds: 0 },
        { id: "right-end", position: { ...center, altitude: 0 }, speedMps: 20, waitSeconds: 0 }
      ]
    ]))
    expect(result.some((finding) => finding.code === "AIR_CONFLICT")).toBe(true)
  })

  it("marks a configured terrain check unavailable when an endpoint lacks elevation", () => {
    const scene = createDemoScene()
    scene.obstacles = []
    scene.noFlyZones = []
    scene.rules.minimumTerrainClearanceMeters = 20
    const result = evaluateSpatialRisk(scene, plan(scene, [[
      { id: "start", position: { ...scene.takeoffPoint, altitude: 60, groundHeightMeters: 10 }, speedMps: 20, waitSeconds: 0 },
      { id: "end", position: { ...scene.landingPoint, altitude: 60 }, speedMps: 20, waitSeconds: 0 }
    ]]))
    expect(result.some((finding) => finding.code === "GROUND_CLEARANCE_UNAVAILABLE")).toBe(true)
    expect(result.some((finding) => finding.code === "GROUND_CLEARANCE")).toBe(false)
  })
})
