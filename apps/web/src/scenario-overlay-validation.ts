import type { V3Coordinate, V3ScenarioOverlayObject } from "@wurenji/shared"

export type ScenarioOverlayValidation = { valid: true; errors: [] } | { valid: false; errors: string[] }

export function validateScenarioOverlayDraft(name: string, objects: readonly V3ScenarioOverlayObject[], boundary: readonly V3Coordinate[]): ScenarioOverlayValidation {
  const errors: string[] = []
  if (!name.trim()) errors.push("请填写覆盖层名称")
  if (boundary.length < 3) errors.push("基础区域边界无效")
  const ids = new Set<string>()
  for (const item of objects) {
    if (!item.id || ids.has(item.id)) errors.push(`对象 ID 重复或为空：${item.id || "未命名"}`)
    ids.add(item.id)
    if (!item.code?.trim() || !item.name?.trim()) errors.push("每个对象都需要编码和名称")
    for (const point of pointsOf(item)) {
      if (!validCoordinate(point)) errors.push(`对象 ${item.name || item.id} 包含无效坐标`)
      else if (!inside(point, boundary)) errors.push(`对象 ${item.name || item.id} 超出基础区域边界`)
    }
    const points = pointsOf(item)
    if (item.geometry.type === "LineString" && points.length < 2) errors.push(`对象 ${item.name} 至少需要两个航点`)
    if (item.geometry.type === "Polygon") {
      if (points.length < 3) errors.push(`对象 ${item.name} 至少需要三个边界点`)
      else if (!samePoint(points[0]!, points[points.length - 1]!)) errors.push(`对象 ${item.name} 的多边形必须闭合`)
      else if (selfIntersects(points)) errors.push(`对象 ${item.name} 的多边形边界不能自相交`)
    }
    for (const value of Object.values(item.properties ?? {})) if (!["string", "number", "boolean"].includes(typeof value)) errors.push(`对象 ${item.name} 的属性必须是基础类型`)
  }
  return errors.length ? { valid: false, errors } : { valid: true, errors: [] }
}

function pointsOf(item: V3ScenarioOverlayObject): V3Coordinate[] {
  if (item.geometry.type === "Point") return [{ longitude: item.geometry.coordinates[0], latitude: item.geometry.coordinates[1] }]
  if (item.geometry.type === "LineString") return item.geometry.coordinates.map((point) => ({ longitude: point[0], latitude: point[1] }))
  return (item.geometry.coordinates[0] ?? []).map((point) => ({ longitude: point[0], latitude: point[1] }))
}

function validCoordinate(point: V3Coordinate): boolean {
  return Number.isFinite(point.longitude) && point.longitude >= -180 && point.longitude <= 180 && Number.isFinite(point.latitude) && point.latitude >= -90 && point.latitude <= 90
}

function samePoint(left: V3Coordinate, right: V3Coordinate): boolean { return left.longitude === right.longitude && left.latitude === right.latitude }

function inside(point: V3Coordinate, boundary: readonly V3Coordinate[]): boolean {
  let result = false
  for (let index = 0, previous = boundary.length - 1; index < boundary.length; previous = index++) {
    const current = boundary[index]!, prior = boundary[previous]!
    const intersects = (current.latitude > point.latitude) !== (prior.latitude > point.latitude)
      && point.longitude < (prior.longitude - current.longitude) * (point.latitude - current.latitude) / (prior.latitude - current.latitude) + current.longitude
    if (intersects) result = !result
  }
  return result
}

function selfIntersects(points: readonly V3Coordinate[]): boolean {
  const count = points.length - 1
  for (let first = 0; first < count; first++) for (let second = first + 1; second < count; second++) {
    if (second === first + 1 || (first === 0 && second === count - 1)) continue
    if (segmentsIntersect(points[first]!, points[first + 1]!, points[second]!, points[second + 1]!)) return true
  }
  return false
}

function segmentsIntersect(a: V3Coordinate, b: V3Coordinate, c: V3Coordinate, d: V3Coordinate): boolean {
  const orient = (p: V3Coordinate, q: V3Coordinate, r: V3Coordinate) => (q.longitude - p.longitude) * (r.latitude - p.latitude) - (q.latitude - p.latitude) * (r.longitude - p.longitude)
  const ab = orient(a, b, c), ad = orient(a, b, d), cd = orient(c, d, a), cb = orient(c, d, b)
  return ((ab > 0 && ad < 0) || (ab < 0 && ad > 0)) && ((cd > 0 && cb < 0) || (cd < 0 && cb > 0))
}
