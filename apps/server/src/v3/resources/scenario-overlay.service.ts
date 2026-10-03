import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { createHash, randomUUID } from "node:crypto"
import { EntityManager, Repository } from "typeorm"
import type {
  AuthUser,
  SceneType,
  V3Coordinate,
  V3RegionCatalogItem,
  V3ScenarioOverlayGeometry,
  V3ScenarioOverlayObject,
  V3ScenarioOverlayObjectType,
  V3ScenarioOverlayVersionView
} from "@wurenji/shared"
import { v3ScenarioOverlayObjectTypes } from "@wurenji/shared"
import { ResourcePackageService } from "./resource-package.service.js"
import { ScenarioOverlayEntity, ScenarioOverlayVersionEntity } from "./scenario-overlay.entity.js"
import { canonicalJson } from "../common/canonical-json.js"

type OverlayInput = {
  sceneType?: SceneType
  regionPackageId?: string
  title?: string
  objects?: unknown
}

type OverlayMutationInput = { title?: string; objects?: unknown; expectedRevision?: unknown }

@Injectable()
export class ScenarioOverlayService {
  constructor(
    @InjectRepository(ScenarioOverlayEntity) private readonly overlays: Repository<ScenarioOverlayEntity>,
    @InjectRepository(ScenarioOverlayVersionEntity) private readonly versions: Repository<ScenarioOverlayVersionEntity>,
    private readonly resources: ResourcePackageService
  ) {}

  async list(user: AuthUser, regionPackageId?: string): Promise<V3ScenarioOverlayVersionView[]> {
    const rows = await this.versions.find({
      where: regionPackageId ? { regionPackageId } : {},
      relations: { overlay: true },
      order: { updatedAt: "DESC" }
    })
    return rows.filter((row) => this.canRead(row.overlay.createdBy.id, user)).map((row) => this.serialize(row))
  }

  async detail(id: string, user: AuthUser): Promise<V3ScenarioOverlayVersionView> {
    const row = await this.load(id)
    this.assertOwner(row.overlay.createdBy.id, user, false)
    return this.serialize(row)
  }

  async publishedDetail(id: string): Promise<V3ScenarioOverlayVersionView> {
    const row = await this.versions.findOne({ where: [{ id, status: "PUBLISHED" }, { id, status: "ARCHIVED" }], relations: { overlay: true } })
    if (!row) throw new NotFoundException("已发布场景覆盖层版本不存在")
    return this.serialize(row)
  }

  async create(user: AuthUser, input: OverlayInput & { name?: string }): Promise<V3ScenarioOverlayVersionView> {
    this.assertTeacher(user)
    const sceneType = this.readSceneType(input.sceneType)
    const regionPackageId = this.requiredText(input.regionPackageId, "区域资源")
    const title = this.normalizeTitle(input.title ?? input.name)
    const region = await this.resources.findRegion(regionPackageId)
    if (region.sceneType !== sceneType) throw new BadRequestException("场景类型与区域资源不一致")
    const objects = validateScenarioOverlayObjects(input.objects === undefined ? [] : input.objects, region)
    return this.overlays.manager.transaction(async (manager) => {
      // The editor may start from a clean draft after a published version was
      // loaded. Reuse that overlay scope and allocate the next version instead
      // of inserting another version 1 with the same (scene, region, title)
      // key, which previously surfaced as an opaque HTTP 500.
      const latest = await manager.findOne(ScenarioOverlayVersionEntity, {
        where: { sceneType, regionPackageId, title },
        order: { versionNo: "DESC" },
        relations: { overlay: true }
      })
      if (latest?.status === "DRAFT") {
        latest.objects = objects
        latest.revision += 1
        latest.checksum = checksum({ sceneType, regionPackageId, title, versionNo: latest.versionNo, objects })
        return this.serialize(await manager.save(latest))
      }
      if (latest) {
        const versionNo = latest.versionNo + 1
        const version = await manager.save(ScenarioOverlayVersionEntity, manager.create(ScenarioOverlayVersionEntity, {
          overlay: latest.overlay, versionNo, revision: 1, sceneType, regionPackageId, title, status: "DRAFT", objects,
          checksum: checksum({ sceneType, regionPackageId, title, versionNo, objects }), createdBy: { id: user.id, displayName: user.displayName } as never
        }))
        return this.serialize(version)
      }
      const overlay = await manager.save(ScenarioOverlayEntity, manager.create(ScenarioOverlayEntity, {
        sceneType, regionPackageId, title, createdBy: { id: user.id, displayName: user.displayName } as never
      }))
      const version = await manager.save(ScenarioOverlayVersionEntity, manager.create(ScenarioOverlayVersionEntity, {
        overlay, versionNo: 1, revision: 1, sceneType, regionPackageId, title, status: "DRAFT", objects,
        checksum: checksum({ sceneType, regionPackageId, title, versionNo: 1, objects }), createdBy: { id: user.id, displayName: user.displayName } as never
      }))
      return this.serialize(version)
    })
  }

  async update(id: string, user: AuthUser, input: OverlayMutationInput): Promise<V3ScenarioOverlayVersionView> {
    this.assertTeacher(user)
    const expectedRevision = this.readExpectedRevision(input.expectedRevision)
    return this.versions.manager.transaction(async (manager) => {
      const current = await this.findVersionForUpdate(manager, id)
      if (!current) throw new NotFoundException("场景覆盖层版本不存在")
      this.assertOwner(current.overlay.createdBy.id, user)
      if (current.status !== "DRAFT") throw new ConflictException("已发布或已归档版本不可修改，请创建新草稿")
      if (current.revision !== expectedRevision) throw new ConflictException(`覆盖层草稿版本冲突，当前版本为 ${current.revision}`)
      const region = await this.resources.findRegion(current.regionPackageId, manager)
      const title = input.title === undefined ? current.title : this.normalizeTitle(input.title)
      const objects = validateScenarioOverlayObjects(input.objects === undefined ? current.objects : input.objects, region)
      current.title = title
      current.objects = objects
      current.revision += 1
      current.checksum = checksum({ sceneType: current.sceneType, regionPackageId: current.regionPackageId, title, versionNo: current.versionNo, objects })
      return this.serialize(await manager.save(current))
    })
  }

  async fork(id: string, user: AuthUser): Promise<V3ScenarioOverlayVersionView> {
    this.assertTeacher(user)
    const current = await this.load(id)
    this.assertOwner(current.overlay.createdBy.id, user)
    return this.overlays.manager.transaction(async (manager) => {
      const latest = await manager.findOne(ScenarioOverlayVersionEntity, { where: { overlay: { id: current.overlay.id } }, order: { versionNo: "DESC" }, relations: { overlay: true } })
      if (!latest) throw new NotFoundException("覆盖层版本不存在")
      const versionNo = latest.versionNo + 1
      const version = await manager.save(ScenarioOverlayVersionEntity, manager.create(ScenarioOverlayVersionEntity, {
        overlay: latest.overlay, versionNo, revision: 1, sceneType: latest.sceneType,
        regionPackageId: latest.regionPackageId, title: latest.title, status: "DRAFT", objects: structuredClone(latest.objects),
        checksum: checksum({ sceneType: latest.sceneType, regionPackageId: latest.regionPackageId, title: latest.title, versionNo, objects: latest.objects }), createdBy: { id: user.id, displayName: user.displayName } as never
      }))
      return this.serialize(version)
    })
  }

  async publish(id: string, user: AuthUser, expectedRevision?: unknown): Promise<V3ScenarioOverlayVersionView> {
    this.assertTeacher(user)
    return this.overlays.manager.transaction(async (manager) => {
      const current = await this.findVersionForUpdate(manager, id)
      if (!current) throw new NotFoundException("场景覆盖层版本不存在")
      this.assertOwner(current.overlay.createdBy.id, user)
      if (current.status !== "DRAFT") throw new ConflictException("只有草稿版本可以发布")
      if (expectedRevision !== undefined && current.revision !== this.readExpectedRevision(expectedRevision)) throw new ConflictException(`覆盖层草稿版本冲突，当前版本为 ${current.revision}`)
      const region = await this.resources.findRegion(current.regionPackageId, manager)
      validateScenarioOverlayPublish(current.sceneType, current.objects, region)
      const existingLock = await manager.createQueryBuilder(ScenarioOverlayVersionEntity, "version")
        .innerJoin("version.overlay", "overlay")
        .select("version.id", "id")
        .where("overlay.id = :overlayId", { overlayId: current.overlay.id })
        .andWhere("version.status = :status", { status: "PUBLISHED" })
        .setLock("pessimistic_write", undefined, ["version"])
        .getRawOne<{ id: string }>()
      const existing = existingLock
        ? await manager.findOne(ScenarioOverlayVersionEntity, { where: { id: existingLock.id }, relations: { overlay: true } })
        : null
      if (existing) {
        existing.status = "ARCHIVED"
        existing.archivedAt = new Date()
        await manager.save(existing)
      }
      current.status = "PUBLISHED"
      current.publishedAt = new Date()
      return this.serialize(await manager.save(current))
    })
  }

  async archive(id: string, user: AuthUser): Promise<V3ScenarioOverlayVersionView> {
    this.assertTeacher(user)
    const current = await this.load(id)
    this.assertOwner(current.overlay.createdBy.id, user)
    if (current.status === "ARCHIVED") return this.serialize(current)
    current.status = "ARCHIVED"
    current.archivedAt = new Date()
    return this.serialize(await this.versions.save(current))
  }

  async assertPublished(id: string, sceneType: SceneType, regionPackageId: string, manager: EntityManager = this.versions.manager): Promise<ScenarioOverlayVersionEntity> {
    const version = await manager.findOne(ScenarioOverlayVersionEntity, { where: { id, status: "PUBLISHED" }, relations: { overlay: true } })
    if (!version || version.sceneType !== sceneType || version.regionPackageId !== regionPackageId) throw new BadRequestException("场景覆盖层版本不存在或与任务区域不一致")
    return version
  }

  private async load(id: string): Promise<ScenarioOverlayVersionEntity> {
    const row = await this.versions.findOne({ where: { id }, relations: { overlay: true } })
    if (!row) throw new NotFoundException("场景覆盖层版本不存在")
    return row
  }

  private async findVersionForUpdate(manager: EntityManager, id: string): Promise<ScenarioOverlayVersionEntity | null> {
    // Keep lightweight service tests and alternate transaction managers
    // compatible; the real TypeORM manager supports the locking query below.
    if (typeof (manager as EntityManager & { createQueryBuilder?: unknown }).createQueryBuilder !== "function") {
      return manager.findOne(ScenarioOverlayVersionEntity, { where: { id }, relations: { overlay: true } })
    }
    const locked = await manager.createQueryBuilder(ScenarioOverlayVersionEntity, "version")
      .select("version.id", "id")
      .where("version.id = :id", { id })
      .setLock("pessimistic_write", undefined, ["version"])
      .getRawOne<{ id: string }>()
    return locked
      ? manager.findOne(ScenarioOverlayVersionEntity, { where: { id: locked.id }, relations: { overlay: true } })
      : null
  }

  private serialize(row: ScenarioOverlayVersionEntity): V3ScenarioOverlayVersionView {
    return {
      id: row.id, overlayId: row.overlay.id, versionNo: row.versionNo, sceneType: row.sceneType,
      regionPackageId: row.regionPackageId, title: row.title, name: row.title, status: row.status, revision: row.revision, objects: row.objects,
      checksum: row.checksum, createdById: row.createdBy.id, createdByName: row.createdBy.displayName,
      publishedAt: row.publishedAt?.toISOString() ?? null, archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString()
    }
  }

  private canRead(ownerId: string, user: AuthUser): boolean { return user.role === "admin" || ownerId === user.id }
  private assertTeacher(user: AuthUser): void { if (user.role !== "teacher" && user.role !== "admin") throw new ForbiddenException("仅教师可以管理场景覆盖层") }
  private assertOwner(ownerId: string, user: AuthUser, manage = true): void {
    if (user.role !== "admin" && ownerId !== user.id) throw new ForbiddenException(manage ? "无权管理该场景覆盖层" : "无权查看该场景覆盖层")
  }
  private requiredText(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new BadRequestException(`${label}无效`)
    return value.trim()
  }
  private normalizeTitle(value: unknown): string { return this.requiredText(value, "覆盖层名称") }
  private readExpectedRevision(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 1) throw new BadRequestException("expectedRevision必须是正整数")
    return Number(value)
  }
  private readSceneType(value: unknown): SceneType {
    if (value === "CITY_LOGISTICS" || value === "CITY_SHOW" || value === "VTOL_INSPECTION") return value
    throw new BadRequestException("场景类型无效")
  }
}

function checksum(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex") }

export function validateScenarioOverlayObjects(input: unknown, region: V3RegionCatalogItem): V3ScenarioOverlayObject[] {
  if (!Array.isArray(input) || input.length > 500) throw new BadRequestException("覆盖层对象必须为数组且不超过 500 个")
  const ids = new Set<string>()
  const codes = new Set<string>()
  const immutableIds = new Set([
    ...(region.layers ?? []).flatMap((layer) => layer.features.map((feature) => feature.id)),
    ...(region.logisticsNodes ?? []).flatMap((node) => [node.id, node.code])
  ])
  return input.map((value, index) => {
    if (!value || typeof value !== "object") throw new BadRequestException(`第 ${index + 1} 个覆盖层对象无效`)
    const item = value as Record<string, unknown>
    const id = text(item.id) || randomUUID()
    const code = text(item.code) || id
    const name = text(item.name)
    const type = normalizeObjectType(item.type)
    const geometry = item.geometry && typeof item.geometry === "object" ? item.geometry as Record<string, unknown> : null
    const geometryType = item.geometryType ?? (geometry?.type === "Point" ? "POINT" : geometry?.type === "LineString" ? "LINESTRING" : geometry?.type === "Polygon" ? "POLYGON" : undefined)
    if (ids.has(id)) throw new BadRequestException(`覆盖层对象 ID 重复：${id}`)
    if (codes.has(code)) throw new BadRequestException(`覆盖层对象编码重复：${code}`)
    if (immutableIds.has(id) || immutableIds.has(code)) throw new BadRequestException(`覆盖层对象不能覆盖基础地图对象：${id}`)
    if (!code || !name || !type || (geometryType !== "POINT" && geometryType !== "LINESTRING" && geometryType !== "POLYGON")) throw new BadRequestException(`第 ${index + 1} 个覆盖层对象字段无效`)
    if (geometry && ((geometryType === "POINT" && geometry.type !== "Point") || (geometryType === "LINESTRING" && geometry.type !== "LineString") || (geometryType === "POLYGON" && geometry.type !== "Polygon"))) throw new BadRequestException(`覆盖层对象 ${name} 的几何类型不一致`)
    ids.add(id)
    codes.add(code)
    if (geometryType === "POINT" && item.positions !== undefined) throw new BadRequestException(`点对象 ${name} 只能使用 position`)
    const rawPosition = item.position ?? (geometry?.type === "Point" ? coordinateFromGeometry(geometry.coordinates) : undefined)
    const rawPositions = item.positions ?? (geometry?.type === "LineString" ? coordinateArrayFromGeometry(geometry.coordinates) : geometry?.type === "Polygon" ? (Array.isArray(geometry.coordinates) ? coordinateArrayFromGeometry(geometry.coordinates[0]) : undefined) : undefined)
    const coordinates = geometryType === "POINT" ? [readCoordinate(rawPosition, `${name}.position`)] : readCoordinates(rawPositions, `${name}.positions`, geometryType === "LINESTRING" ? 2 : 4)
    if (geometryType === "POLYGON") {
      if (!samePoint(coordinates[0]!, coordinates[coordinates.length - 1]!)) throw new BadRequestException(`多边形 ${name} 必须首尾闭合`)
      if (selfIntersects(coordinates)) throw new BadRequestException(`多边形 ${name} 不能自相交`)
    }
    if (!coordinates.every((point) => insideRegion(point, region.boundary))) throw new BadRequestException(`覆盖层对象 ${name} 超出区域范围`)
    const properties: Record<string, string | number | boolean> = {}
    if (item.properties !== undefined) {
      if (!item.properties || typeof item.properties !== "object" || Array.isArray(item.properties)) throw new BadRequestException(`对象 ${name} 的属性必须是对象`)
      for (const [key, prop] of Object.entries(item.properties as Record<string, unknown>)) {
        if (!key.trim() || key.length > 64) throw new BadRequestException(`对象 ${name} 的属性键无效`)
        if (typeof prop === "string" && prop.length <= 1_000) properties[key] = prop
        else if (typeof prop === "number" && Number.isFinite(prop)) properties[key] = prop
        else if (typeof prop === "boolean") properties[key] = prop
        else throw new BadRequestException(`对象 ${name} 的属性值必须是有限基础类型`)
      }
    }
    if (geometryType === "POINT") {
      const point = coordinates[0]!
      return { id, code, name, type: type as V3ScenarioOverlayObjectType, geometryType, position: point, geometry: { type: "Point", coordinates: toTuple(point) }, properties }
    }
    const positions = coordinates
    return {
      id, code, name, type: type as V3ScenarioOverlayObjectType, geometryType, positions,
      geometry: geometryType === "LINESTRING" ? { type: "LineString", coordinates: positions.map(toTuple) } : { type: "Polygon", coordinates: [[...positions, positions[0]!].map(toTuple)] }, properties
    }
  })
}

export function validateScenarioOverlayPublish(sceneType: SceneType, objects: V3ScenarioOverlayObject[], region: V3RegionCatalogItem): void {
  if (objects.length === 0) throw new BadRequestException("覆盖层至少需要一个教学对象")
  if (sceneType !== "CITY_LOGISTICS") {
    if (region.sceneType !== sceneType) throw new BadRequestException("覆盖层场景与区域资源不一致")
    return
  }

  const count = (type: V3ScenarioOverlayObjectType) => objects.filter((item) => item.type === type).length
  if (count("LOGISTICS_CENTER") < 1) throw new BadRequestException("物流覆盖层至少需要一个物流中心")
  if (count("DELIVERY_POINT") < 3) throw new BadRequestException("物流覆盖层至少需要三个配送点")
  if (count("ALTERNATE_LANDING_POINT") < 2) throw new BadRequestException("物流覆盖层至少需要两个备降点")
  if (count("WAITING_POINT") < 2) throw new BadRequestException("物流覆盖层至少需要两个等待点")
  if (count("EVENT_AREA") < 1) throw new BadRequestException("物流覆盖层至少需要一个教学事件区域")
  if (region.sceneType !== sceneType) throw new BadRequestException("覆盖层场景与区域资源不一致")
}

function text(value: unknown): string { return typeof value === "string" ? value.trim() : "" }
function normalizeObjectType(value: unknown): V3ScenarioOverlayObjectType | null {
  const aliases: Record<string, V3ScenarioOverlayObjectType> = { FLIGHT_CORRIDOR: "AIRWAY", MISSION_POINT: "TASK_POINT", TEACHING_EVENT_AREA: "EVENT_AREA" }
  if (typeof value !== "string") return null
  return aliases[value] ?? ((v3ScenarioOverlayObjectTypes as readonly string[]).includes(value) ? value as V3ScenarioOverlayObjectType : null)
}
function coordinateFromGeometry(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  return { longitude: value[0], latitude: value[1], ...(value.length > 2 ? { altitudeMeters: value[2] } : {}) }
}
function coordinateArrayFromGeometry(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((point) => coordinateFromGeometry(point)).filter((point): point is Record<string, unknown> => Boolean(point))
}
function toTuple(point: V3Coordinate): [number, number] | [number, number, number] {
  return point.altitudeMeters === undefined ? [point.longitude, point.latitude] : [point.longitude, point.latitude, point.altitudeMeters]
}
function readCoordinate(value: unknown, label: string): V3Coordinate {
  if (!value || typeof value !== "object") throw new BadRequestException(`${label} 无效`)
  const point = value as Record<string, unknown>
  const longitude = Number(point.longitude), latitude = Number(point.latitude)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new BadRequestException(`${label} 坐标无效`)
  const result: V3Coordinate = { longitude, latitude }
  if (point.altitudeMeters !== undefined) { const altitudeMeters = Number(point.altitudeMeters); if (!Number.isFinite(altitudeMeters)) throw new BadRequestException(`${label} 高度无效`); result.altitudeMeters = altitudeMeters }
  return result
}
function readCoordinates(value: unknown, label: string, minimum: number): V3Coordinate[] { if (!Array.isArray(value) || value.length < minimum) throw new BadRequestException(`${label} 至少需要 ${minimum} 个坐标点`); return value.map((point) => readCoordinate(point, label)) }
function insideRegion(point: V3Coordinate, boundary: V3Coordinate[]): boolean {
  if (boundary.some((vertex, index) => pointOnSegment(point, vertex, boundary[(index + 1) % boundary.length]!))) return true
  let inside = false
  for (let index = 0, previous = boundary.length - 1; index < boundary.length; previous = index++) {
    const current = boundary[index]!, prior = boundary[previous]!
    const intersects = (current.latitude > point.latitude) !== (prior.latitude > point.latitude)
      && point.longitude < (prior.longitude - current.longitude) * (point.latitude - current.latitude) / (prior.latitude - current.latitude) + current.longitude
    if (intersects) inside = !inside
  }
  return inside
}

function samePoint(left: V3Coordinate, right: V3Coordinate): boolean {
  return left.longitude === right.longitude && left.latitude === right.latitude
}

function selfIntersects(points: readonly V3Coordinate[]): boolean {
  const segmentCount = points.length - 1
  for (let left = 0; left < segmentCount; left++) for (let right = left + 1; right < segmentCount; right++) {
    if (right === left + 1 || (left === 0 && right === segmentCount - 1)) continue
    if (segmentsIntersect(points[left]!, points[left + 1]!, points[right]!, points[right + 1]!)) return true
  }
  return false
}

function segmentsIntersect(a: V3Coordinate, b: V3Coordinate, c: V3Coordinate, d: V3Coordinate): boolean {
  const orientation = (p: V3Coordinate, q: V3Coordinate, r: V3Coordinate) => (q.longitude - p.longitude) * (r.latitude - p.latitude) - (q.latitude - p.latitude) * (r.longitude - p.longitude)
  const ab = orientation(a, b, c), ad = orientation(a, b, d), cd = orientation(c, d, a), cb = orientation(c, d, b)
  return ((ab > 0 && ad < 0) || (ab < 0 && ad > 0)) && ((cd > 0 && cb < 0) || (cd < 0 && cb > 0))
}

function pointOnSegment(point: V3Coordinate, start: V3Coordinate, end: V3Coordinate): boolean {
  const cross = (point.latitude - start.latitude) * (end.longitude - start.longitude) - (point.longitude - start.longitude) * (end.latitude - start.latitude)
  if (Math.abs(cross) > 1e-10) return false
  return point.longitude >= Math.min(start.longitude, end.longitude) - 1e-10 && point.longitude <= Math.max(start.longitude, end.longitude) + 1e-10
    && point.latitude >= Math.min(start.latitude, end.latitude) - 1e-10 && point.latitude <= Math.max(start.latitude, end.latitude) + 1e-10
}
