import type { DronePlan, MissionPlan, PracticeScene, SceneType, Waypoint } from "./types.js"

const origin = { longitude: 113.9485, latitude: 22.5389, altitude: 0 }

function point(id: string, longitude: number, latitude: number, altitude: number, speedMps = 10): Waypoint {
  return {
    id,
    position: { longitude, latitude, altitude },
    speedMps,
    waitSeconds: 0
  }
}

export function createDemoScene(): PracticeScene {
  return {
    id: "practice-logistics-demo",
    title: "城市物流配送实验",
    type: "CITY_LOGISTICS",
    origin,
    aircraft: {
      name: "教学物流无人机",
      count: 8,
      cruiseSpeedMps: 10,
      maxSpeedMps: 15,
      maxAltitudeMeters: 150,
      maxRangeMeters: 12_000,
      maxPayloadKg: 5
    },
    boundary: {
      id: "boundary-main",
      name: "城市作业边界",
      positions: [
        { longitude: 113.9448, latitude: 22.5362, altitude: 0 },
        { longitude: 113.9522, latitude: 22.5362, altitude: 0 },
        { longitude: 113.9522, latitude: 22.5420, altitude: 0 },
        { longitude: 113.9448, latitude: 22.5420, altitude: 0 }
      ]
    },
    takeoffPoint: { longitude: 113.9460, latitude: 22.5371, altitude: 0 },
    landingPoint: { longitude: 113.9460, latitude: 22.5371, altitude: 0 },
    noFlyZones: [
      {
        id: "no-fly-01",
        name: "临时禁飞区 N-01",
        positions: [
          { longitude: 113.9481, latitude: 22.5390, altitude: 0 },
          { longitude: 113.9495, latitude: 22.5390, altitude: 0 },
          { longitude: 113.9495, latitude: 22.5403, altitude: 0 },
          { longitude: 113.9481, latitude: 22.5403, altitude: 0 }
        ],
        minimumAltitudeMeters: 0,
        maximumAltitudeMeters: 150
      }
    ],
    obstacles: [
      {
        id: "building-01",
        name: "教学楼障碍物",
        center: { longitude: 113.9472, latitude: 22.5395, altitude: 0 },
        widthMeters: 70,
        lengthMeters: 55,
        heightMeters: 48
      },
      {
        id: "building-02",
        name: "商业楼障碍物",
        center: { longitude: 113.9504, latitude: 22.5381, altitude: 0 },
        widthMeters: 60,
        lengthMeters: 80,
        heightMeters: 65
      }
    ],
    taskPoints: [
      { id: "order-01", name: "配送点 D-01", position: { longitude: 113.9510, latitude: 22.5410, altitude: 70 }, payloadKg: 2.5, deadlineSeconds: 300, stage: 1 },
      { id: "order-02", name: "配送点 D-02", position: { longitude: 113.9512, latitude: 22.5385, altitude: 80 }, payloadKg: 1.2, deadlineSeconds: 360, stage: 1 },
      { id: "order-03", name: "配送点 D-03", position: { longitude: 113.9490, latitude: 22.5412, altitude: 90 }, payloadKg: 4.5, deadlineSeconds: 360, stage: 1 },
      { id: "order-04", name: "配送点 D-04", position: { longitude: 113.9500, latitude: 22.5372, altitude: 60 }, payloadKg: 2.0, deadlineSeconds: 420, stage: 1 },
      { id: "order-05", name: "配送点 D-05", position: { longitude: 113.9475, latitude: 22.5411, altitude: 75 }, payloadKg: 1.5, deadlineSeconds: 450, stage: 1 },
      { id: "order-06", name: "配送点 D-06", position: { longitude: 113.9515, latitude: 22.5370, altitude: 85 }, payloadKg: 3.0, deadlineSeconds: 480, stage: 1 }
    ],
    environment: {
      wind: { enabled: true, directionDegrees: 135, speedMps: 4 },
      rainLevel: "LIGHT",
      magneticDriftMeters: 1.5
    },
    rules: {
      horizontalSeparationMeters: 5,
      verticalSeparationMeters: 3,
      maximumDurationSeconds: 600,
      minimumAltitudeMeters: 20,
      maximumAltitudeMeters: 150
    },
    version: 1
  }
}

export function createSceneTemplate(type: SceneType): PracticeScene {
  const scene = createDemoScene()
  scene.id = crypto.randomUUID()
  scene.title = type === "CITY_SHOW" ? "城市集群表演实训" : type === "CITY_LOGISTICS" ? "城市物流配送实训" : "垂起广域巡检实训"
  scene.type = type
  scene.taskPoints = []
  scene.noFlyZones = []
  scene.obstacles = []
  scene.environment = {
    wind: { enabled: false, directionDegrees: 0, speedMps: 0 },
    rainLevel: "NONE",
    magneticDriftMeters: 0
  }
  scene.version = 0
  return scene
}

export function createDemoPlan(scene = createDemoScene()): MissionPlan {
  const count = Math.max(1, Math.min(50, scene.aircraft.count))
  const dronePlans: DronePlan[] = Array.from({ length: count }, (_, index) => {
    const offset = (index - (count - 1) / 2) * 0.00003
    const tasks = scene.taskPoints.filter((_, taskIndex) => taskIndex % count === index)
    const altitude = 65 + (index % 3) * 12
    const routePoints = tasks.flatMap((task, taskIndex) => {
      const position = { ...task.position, altitude: Math.max(task.position.altitude, altitude) }
      if (taskIndex > 0) return [point(`wp-${index}-task-${taskIndex}`, position.longitude, position.latitude, position.altitude, scene.aircraft.cruiseSpeedMps)]
      return [
        point(`wp-${index}-climb`, scene.takeoffPoint.longitude + offset, scene.takeoffPoint.latitude, altitude, Math.min(6, scene.aircraft.cruiseSpeedMps)),
        point(`wp-${index}-task-${taskIndex}`, position.longitude, position.latitude, position.altitude, scene.aircraft.cruiseSpeedMps)
      ]
    })
    return {
      droneId: `U-${String(index + 1).padStart(2, "0")}`,
      groupId: `GROUP-${String.fromCharCode(65 + Math.floor(index / 10))}`,
      assignedTaskIds: tasks.map((task) => task.id),
      takeoffDelaySeconds: index * 3,
      waypoints: [
        point(`wp-${index}-0`, scene.takeoffPoint.longitude + offset, scene.takeoffPoint.latitude, 0, 4),
        ...routePoints,
        point(`wp-${index}-3`, scene.landingPoint.longitude + offset, scene.landingPoint.latitude, 0, 8)
      ]
    }
  })

  return {
    id: "solution-demo",
    sceneId: scene.id,
    sceneVersion: scene.version,
    version: 1,
    dronePlans,
    updatedAt: new Date(0).toISOString()
  }
}
