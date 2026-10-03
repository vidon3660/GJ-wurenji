import type { V3Coordinate, V3LogisticsNode } from "@wurenji/shared"

export function createBuiltinLogisticsNodes(
  regionCode: string,
  center: V3Coordinate,
  variant: number
): V3LogisticsNode[] {
  const point = (longitudeOffset: number, latitudeOffset: number): V3Coordinate => ({
    longitude: round(center.longitude + longitudeOffset),
    latitude: round(center.latitude + latitudeOffset)
  })
  const polygon = (position: V3Coordinate, longitudeRadius: number, latitudeRadius: number): V3Coordinate[] => [
    { longitude: round(position.longitude - longitudeRadius), latitude: round(position.latitude - latitudeRadius) },
    { longitude: round(position.longitude + longitudeRadius), latitude: round(position.latitude - latitudeRadius) },
    { longitude: round(position.longitude + longitudeRadius), latitude: round(position.latitude + latitudeRadius) },
    { longitude: round(position.longitude - longitudeRadius), latitude: round(position.latitude + latitudeRadius) }
  ]
  const airportPosition = point(-0.0007, -0.00045)
  const nodes: V3LogisticsNode[] = [
    {
      id: `${regionCode}-airport`,
      code: "APT-01",
      type: "CENTER_AIRPORT",
      name: "中心物流机场",
      geometryType: "POLYGON",
      positions: polygon(airportPosition, 0.00055, 0.00038),
      enabled: true,
      properties: { fixed: true, teachingOnly: true }
    },
    {
      id: `${regionCode}-takeoff`,
      code: "APT-TO",
      type: "TAKEOFF_POINT",
      name: "机场起飞点",
      geometryType: "POINT",
      position: point(-0.0009, -0.00045),
      enabled: true,
      properties: { fixed: true, altitudeMeters: 0 }
    },
    {
      id: `${regionCode}-landing`,
      code: "APT-LD",
      type: "LANDING_POINT",
      name: "机场降落点",
      geometryType: "POINT",
      position: point(-0.0005, -0.00045),
      enabled: true,
      properties: { fixed: true, altitudeMeters: 0 }
    },
    {
      id: `${regionCode}-parking`,
      code: "APT-PK",
      type: "PARKING_POINT",
      name: "无人机初始停放点",
      geometryType: "POINT",
      position: airportPosition,
      enabled: true,
      properties: { fixed: true }
    }
  ]

  const longitudeScale = 0.0045 + variant * 0.00008
  const latitudeScale = 0.0032 + variant * 0.00006
  for (let index = 0; index < 12; index += 1) {
    const angle = ((index * 137.5 + variant * 17) * Math.PI) / 180
    const ring = index < 5 ? 0.78 : index < 9 ? 1.25 : 1.7
    nodes.push({
      id: `${regionCode}-delivery-${index + 1}`,
      code: `DP-${String(index + 1).padStart(2, "0")}`,
      type: "DELIVERY_POINT",
      name: `候选配送点 ${String(index + 1).padStart(2, "0")}`,
      geometryType: "POINT",
      position: point(Math.cos(angle) * longitudeScale * ring, Math.sin(angle) * latitudeScale * ring),
      enabled: true,
      properties: {
        serviceWindowMinutes: 30 + (index % 3) * 15,
        priorityBand: index % 4 === 0 ? "URGENT" : "STANDARD",
        fixed: true
      }
    })
  }

  const waitingOffsets: Array<[number, number]> = [[0.0024, 0.0008], [-0.0021, 0.0017], [0.0012, -0.0023]]
  waitingOffsets.forEach(([longitude, latitude], index) => nodes.push({
    id: `${regionCode}-waiting-${index + 1}`,
    code: `WAIT-${index + 1}`,
    type: "WAITING_POINT",
    name: `候选等待点 ${index + 1}`,
    geometryType: "POINT",
    position: point(longitude, latitude),
    enabled: true,
    properties: { maximumHoldingSeconds: 300 + index * 120 }
  }))

  const alternateOffsets: Array<[number, number]> = [[-0.0038, -0.0026], [0.0043, 0.0024], [0.0032, -0.0031]]
  alternateOffsets.forEach(([longitude, latitude], index) => nodes.push({
    id: `${regionCode}-alternate-${index + 1}`,
    code: `ALT-${index + 1}`,
    type: "ALTERNATE_LANDING_POINT",
    name: `候选备降点 ${index + 1}`,
    geometryType: "POINT",
    position: point(longitude, latitude),
    enabled: true,
    properties: { surface: index === 0 ? "HARD" : "OPEN_GROUND", available: true }
  }))

  const emergencyCenters = [point(-0.001, 0.0031), point(0.0028, -0.0012)]
  emergencyCenters.forEach((position, index) => nodes.push({
    id: `${regionCode}-emergency-${index + 1}`,
    code: `EMG-${index + 1}`,
    type: "EMERGENCY_AREA",
    name: `应急运行区域 ${index + 1}`,
    geometryType: "POLYGON",
    positions: polygon(position, 0.00065, 0.0005),
    enabled: true,
    properties: { maximumHoldingSeconds: 480, teachingOnly: true }
  }))

  return nodes
}

function round(value: number): number {
  return Math.round(value * 10_000_000) / 10_000_000
}
