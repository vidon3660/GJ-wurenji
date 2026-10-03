import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { DataSource, EntityManager, Repository } from "typeorm"
import {
  decideStageTransition,
  logisticsTemplatePolicy,
  type AuthUser,
  type LogisticsAircraftInstanceView,
  type LogisticsScheduleCheckResult,
  type LogisticsScheduleItemInput,
  type LogisticsScheduleItemView,
  type LogisticsScheduleVersionView,
  type LogisticsSchedulingAircraftView,
  type LogisticsSchedulingOrderView,
  type LogisticsSchedulingRouteView,
  type LogisticsSchedulingWorkspaceView
} from "@wurenji/shared"
import { checkLogisticsSchedule, generateLogisticsOrders, logisticsOrderGeneratorVersion } from "@wurenji/simulation"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import { ProjectActivityCounterEntity, StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { sha256Canonical } from "../common/canonical-json.js"
import {
  LogisticsRegionAnalysisEntity,
  LogisticsRouteEntity,
  LogisticsRoutePlanVersionEntity,
  LogisticsWaypointEntity
} from "../logistics-route/logistics-route.entities.js"
import { logisticsAircraftCapability } from "../logistics-route/logistics-route.validation.js"
import {
  LogisticsAircraftInstanceEntity,
  LogisticsDispatchItemEntity,
  LogisticsOrderBatchEntity,
  LogisticsOrderEntity,
  LogisticsScheduleDraftEntity,
  LogisticsScheduleVersionEntity
} from "./logistics-scheduling.entities.js"
import {
  applyLogisticsBatchScheduleAdjustment,
  normalizeLogisticsBatchScheduleAdjustment
} from "./logistics-batch-scheduling.js"
import { assertScheduleRevision, logisticsOrderConfig, normalizeScheduleItems } from "./logistics-scheduling.validation.js"

interface SchedulingRecords {
  project: StudentProjectEntity
  batch: LogisticsOrderBatchEntity
  orders: LogisticsOrderEntity[]
  aircraft: LogisticsAircraftInstanceEntity[]
  routeVersion: LogisticsRoutePlanVersionEntity
  routes: LogisticsSchedulingRouteView[]
  draft: LogisticsScheduleDraftEntity
}

@Injectable()
export class LogisticsSchedulingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly activities: ActivityLogService,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(LogisticsOrderBatchEntity) private readonly batches: Repository<LogisticsOrderBatchEntity>,
    @InjectRepository(LogisticsOrderEntity) private readonly orders: Repository<LogisticsOrderEntity>,
    @InjectRepository(LogisticsAircraftInstanceEntity) private readonly aircraft: Repository<LogisticsAircraftInstanceEntity>,
    @InjectRepository(LogisticsScheduleDraftEntity) private readonly drafts: Repository<LogisticsScheduleDraftEntity>,
    @InjectRepository(LogisticsScheduleVersionEntity) private readonly versions: Repository<LogisticsScheduleVersionEntity>
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<LogisticsSchedulingWorkspaceView> {
    await this.ensureWorkspaceRecords(projectId, user)
    return this.buildWorkspace(projectId, user)
  }

  async saveDraft(projectId: string, user: AuthUser, input: { expectedRevision?: number; items?: unknown }): Promise<LogisticsSchedulingWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockRecords(manager, projectId, user)
      await this.requireSchedulingStage(manager, projectId, true)
      this.ensureAssignmentActive(records.project)
      assertScheduleRevision(input.expectedRevision, records.draft.revision, "调度草稿版本")
      const beforeRevision = records.draft.revision
      records.draft.items = normalizeScheduleItems(input.items)
      records.draft.lastCheckResult = null
      records.draft.revision += 1
      records.draft.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.draft)
      records.project.lastActivityAt = new Date()
      await manager.save(records.project)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ORDER_SCHEDULING",
        actor: user,
        eventType: "LOGISTICS_SCHEDULE_DRAFT_SAVED",
        objectType: "LOGISTICS_SCHEDULE_DRAFT",
        objectId: records.draft.id,
        beforeRevision,
        afterRevision: records.draft.revision,
        result: { itemCount: records.draft.items.length }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async batchAdjustDraft(projectId: string, user: AuthUser, rawInput: unknown): Promise<LogisticsSchedulingWorkspaceView> {
    this.requireStudent(user)
    const input = normalizeLogisticsBatchScheduleAdjustment(rawInput)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockRecords(manager, projectId, user)
      await this.requireSchedulingStage(manager, projectId, true)
      this.ensureAssignmentActive(records.project)
      assertScheduleRevision(input.expectedRevision, records.draft.revision, "调度草稿版本")
      const policy = logisticsTemplatePolicy(records.project.snapshot.config.scaleTemplateCode)
      const beforeRevision = records.draft.revision
      records.draft.items = applyLogisticsBatchScheduleAdjustment(input, {
        mode: policy.batchSchedulingMode,
        items: records.draft.items,
        orders: records.orders.map((order) => this.serializeOrder(order, true)),
        aircraft: records.aircraft.map((aircraft) => this.serializeAircraft(aircraft)),
        routes: records.routes
      })
      records.draft.lastCheckResult = null
      records.draft.revision += 1
      records.draft.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.draft)
      records.project.lastActivityAt = new Date()
      await manager.save(records.project)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ORDER_SCHEDULING",
        actor: user,
        eventType: "LOGISTICS_SCHEDULE_BATCH_ADJUSTED",
        objectType: "LOGISTICS_SCHEDULE_DRAFT",
        objectId: records.draft.id,
        beforeRevision,
        afterRevision: records.draft.revision,
        payload: { groupType: input.group.type, groupValue: input.group.value },
        result: {
          orderCount: input.orderIds.length,
          aircraftChanged: Boolean(input.adjustment.aircraftId),
          routeChanged: Boolean(input.adjustment.outboundRouteId || input.adjustment.returnRouteId),
          takeoffShiftMs: input.adjustment.takeoffShiftMs ?? 0
        }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async checkDraft(projectId: string, user: AuthUser): Promise<LogisticsSchedulingWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockRecords(manager, projectId, user)
      await this.requireSchedulingStage(manager, projectId, true)
      this.ensureAssignmentActive(records.project)
      const result = this.check(records)
      records.draft.lastCheckResult = result
      records.draft.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.draft)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ORDER_SCHEDULING",
        actor: user,
        eventType: "LOGISTICS_SCHEDULE_CHECKED",
        objectType: "LOGISTICS_SCHEDULE_DRAFT",
        objectId: records.draft.id,
        beforeRevision: records.draft.revision,
        afterRevision: records.draft.revision,
        result: { status: result.status, submittable: result.submittable, conflictCount: result.conflictCount, riskCount: result.riskCount, assignedOrderCount: result.assignedOrderCount }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async createVersion(projectId: string, user: AuthUser): Promise<LogisticsSchedulingWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockRecords(manager, projectId, user)
      await this.requireSchedulingStage(manager, projectId, true)
      this.ensureAssignmentActive(records.project)
      const result = this.check(records)
      records.draft.lastCheckResult = result
      await manager.save(records.draft)
      await this.persistVersion(manager, records, user, result)
    })
    return this.buildWorkspace(projectId, user)
  }

  async restoreVersion(projectId: string, versionId: string, user: AuthUser, input: { expectedDraftRevision?: number }): Promise<LogisticsSchedulingWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockRecords(manager, projectId, user)
      await this.requireSchedulingStage(manager, projectId, true)
      this.ensureAssignmentActive(records.project)
      assertScheduleRevision(input.expectedDraftRevision, records.draft.revision, "调度草稿版本")
      const version = await this.loadVersion(manager, projectId, versionId, true)
      const beforeRevision = records.draft.revision
      records.draft.items = this.itemsFromVersion(version)
      records.draft.lastCheckResult = version.checkResult
      records.draft.revision += 1
      records.draft.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(records.draft)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ORDER_SCHEDULING",
        actor: user,
        eventType: "LOGISTICS_SCHEDULE_VERSION_RESTORED",
        objectType: "LOGISTICS_SCHEDULE_VERSION",
        objectId: version.id,
        beforeRevision,
        afterRevision: records.draft.revision,
        result: { versionNo: version.versionNo, itemCount: records.draft.items.length }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  async submitVersion(projectId: string, versionId: string, user: AuthUser, input: { expectedDraftRevision?: number; expectedStageRevision?: number }): Promise<LogisticsSchedulingWorkspaceView> {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const records = await this.lockRecords(manager, projectId, user)
      const stage = await this.requireSchedulingStage(manager, projectId, true)
      this.ensureAssignmentActive(records.project)
      assertScheduleRevision(input.expectedDraftRevision, records.draft.revision, "调度草稿版本")
      assertScheduleRevision(input.expectedStageRevision, stage.revision, "阶段版本")
      const version = await this.loadVersion(manager, projectId, versionId, true)
      if (version.status !== "SNAPSHOT") throw new ConflictException("调度版本已经提交")
      if (version.sourceDraftRevision !== records.draft.revision) throw new ConflictException("只能提交当前草稿对应的调度版本")
      if (!version.checkResult.submittable || version.checkResult.status === "HARD_CONFLICT") throw new ConflictException("调度仍有硬冲突或未分配订单，不能提交")
      const decision = decideStageTransition(stage.status, "SUBMITTED", {
        actor: "STUDENT",
        mode: records.project.snapshot.mode,
        allowResubmission: records.project.snapshot.config.allowResubmission,
        prerequisitesSatisfied: true,
        submissionGatePassed: true
      })
      if (!decision.allowed) throw new ConflictException("当前阶段不能提交")
      const now = new Date()
      version.status = "SUBMITTED"
      version.submittedAt = now
      await manager.save(version)
      const scheduledOrderIds = version.items.map((item) => item.order.id)
      await manager.createQueryBuilder().update(LogisticsOrderEntity).set({ status: "UNASSIGNED" }).where('"batchId" = :batchId', { batchId: records.batch.id }).execute()
      if (scheduledOrderIds.length > 0) await manager.createQueryBuilder().update(LogisticsOrderEntity).set({ status: "SCHEDULED" }).whereInIds(scheduledOrderIds).execute()
      await this.acceptStageAndUnlockNext(manager, records.project, stage, now)
      await manager.increment(ProjectActivityCounterEntity, { project: { id: projectId } }, "submissionCount", 1)
      await this.activities.record(manager, {
        assignmentId: records.project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ORDER_SCHEDULING",
        actor: user,
        eventType: "LOGISTICS_INITIAL_SCHEDULE_SUBMITTED",
        objectType: "LOGISTICS_SCHEDULE_VERSION",
        objectId: version.id,
        result: { versionNo: version.versionNo, itemCount: version.items.length, status: version.checkResult.status, nextStageCode: "LOGISTICS_RUNTIME_PREPARATION" }
      })
    })
    return this.buildWorkspace(projectId, user)
  }

  private async ensureWorkspaceRecords(projectId: string, user: AuthUser): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.findOne(StudentProjectEntity, { where: { id: projectId }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
      const project = await this.loadProject(manager, projectId, user)
      const existing = await manager.findOne(LogisticsOrderBatchEntity, { where: { project: { id: projectId } }, loadEagerRelations: false })
      if (existing) return
      const analysis = await manager.findOne(LogisticsRegionAnalysisEntity, { where: { project: { id: projectId } } })
      if (!analysis || analysis.status !== "CONFIRMED") throw new ConflictException("请先确认物流配送点")
      const routeVersion = await manager.findOne(LogisticsRoutePlanVersionEntity, { where: { project: { id: projectId }, status: "SUBMITTED" }, order: { versionNo: "DESC" } })
      if (!routeVersion) throw new ConflictException("请先提交已通过完整往返验证的航线版本")
      const actor = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const config = logisticsOrderConfig(project.snapshot.config.scaleTemplateCode, project.snapshot.config.scenario, `${project.snapshot.checksum}:${project.id}`)
      const generated = generateLogisticsOrders(config, analysis.selectedDeliveryPointIds)
      const batch = await manager.save(LogisticsOrderBatchEntity, manager.create(LogisticsOrderBatchEntity, {
        project,
        generatorVersion: logisticsOrderGeneratorVersion,
        seed: config.seed,
        checksum: sha256Canonical({ generatorVersion: logisticsOrderGeneratorVersion, config, orders: generated }),
        config
      }))
      await manager.save(LogisticsOrderEntity, generated.map((order) => manager.create(LogisticsOrderEntity, { ...order, batch, status: order.releaseTimeMs > 0 ? "UNRELEASED" : "UNASSIGNED" })))
      const policy = logisticsTemplatePolicy(project.snapshot.config.scaleTemplateCode)
      await manager.save(LogisticsAircraftInstanceEntity, Array.from({ length: policy.totalAircraft }, (_, index) => {
        const unavailableStart = policy.totalAircraft - config.initialFleet.unavailableAircraftCount
        const preflightAbnormalStart = unavailableStart - config.initialFleet.preflightAbnormalAircraftCount
        const lowBatteryStart = preflightAbnormalStart - config.initialFleet.lowBatteryAircraftCount
        const standbyStart = lowBatteryStart - config.initialFleet.standbyAircraftCount
        const status = index >= preflightAbnormalStart ? "UNAVAILABLE" : index >= lowBatteryStart ? "LOW_BATTERY" : "READY"
        return manager.create(LogisticsAircraftInstanceEntity, {
          project,
          code: `UAV-${String(index + 1).padStart(3, "0")}`,
          modelCode: logisticsAircraftCapability.modelCode,
          initialBatteryPercent: status === "LOW_BATTERY" ? 35 : 100,
          availableAtMs: index >= standbyStart && index < lowBatteryStart ? 10 * 60_000 : 0,
          status
        })
      }))
      const draft = await manager.save(LogisticsScheduleDraftEntity, manager.create(LogisticsScheduleDraftEntity, { project, revision: 1, items: [], lastCheckResult: null, updatedBy: actor }))
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "LOGISTICS_ORDER_SCHEDULING",
        actor: user,
        eventType: "LOGISTICS_ORDER_BATCH_GENERATED",
        objectType: "LOGISTICS_ORDER_BATCH",
        objectId: batch.id,
        result: { orderCount: generated.length, aircraftCount: policy.totalAircraft, checksum: batch.checksum, draftId: draft.id }
      })
    })
  }

  private async buildWorkspace(projectId: string, user: AuthUser): Promise<LogisticsSchedulingWorkspaceView> {
    const records = await this.readRecords(this.dataSource.manager, projectId, user)
    const versions = await this.versions.find({ where: { project: { id: projectId } }, relations: { items: { order: true, aircraft: true, outboundRoute: true, returnRoute: true } }, order: { versionNo: "DESC" } })
    const stage = await this.dataSource.manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "LOGISTICS_ORDER_SCHEDULING" } })
    const actor = this.requireProjectAccess(records.project, user)
    const mutable = actor === "STUDENT" && stage?.status === "IN_PROGRESS" && records.project.snapshot.draft.status !== "ENDED" && records.project.snapshot.draft.status !== "ARCHIVED"
    const latestVersion = versions.find((version) => version.sourceDraftRevision === records.draft.revision && version.checkResult.submittable && version.status === "SNAPSHOT")
    const redact = actor === "STUDENT" && records.project.snapshot.mode === "ASSESSMENT"
    const assignedOrderIds = new Set(records.draft.items.map((item) => item.orderId))
    const scheduleProjection = this.check(records)
    const templatePolicy = logisticsTemplatePolicy(records.project.snapshot.config.scaleTemplateCode)
    return {
      projectId,
      actor,
      mode: records.project.snapshot.mode,
      scaleTemplateCode: records.project.snapshot.config.scaleTemplateCode,
      strictSerialOperation: templatePolicy.strictSerialOperation,
      batchSchedulingMode: templatePolicy.batchSchedulingMode,
      canEdit: mutable,
      canCheck: mutable && records.draft.items.length > 0,
      canCreateVersion: mutable && records.draft.lastCheckResult !== null,
      canSubmit: mutable && Boolean(latestVersion),
      orderBatch: { id: records.batch.id, generatorVersion: records.batch.generatorVersion, seed: records.batch.seed, checksum: records.batch.checksum, config: records.batch.config, createdAt: records.batch.createdAt.toISOString() },
      orders: records.orders.map((order) => this.serializeOrder(order, assignedOrderIds.has(order.id))),
      aircraft: records.aircraft.map((aircraft) => this.serializeSchedulingAircraft(aircraft, scheduleProjection.items)),
      routes: records.routes,
      draft: { id: records.draft.id, revision: records.draft.revision, items: records.draft.items, lastCheckResult: records.draft.lastCheckResult ? this.redactCheck(records.draft.lastCheckResult, redact) : null, updatedAt: records.draft.updatedAt.toISOString() },
      versions: versions.map((version) => this.serializeVersion(version, redact))
    }
  }

  private async lockRecords(manager: EntityManager, projectId: string, user: AuthUser): Promise<SchedulingRecords> {
    await manager.findOne(StudentProjectEntity, { where: { id: projectId }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
    const draft = await manager.findOne(LogisticsScheduleDraftEntity, { where: { project: { id: projectId } }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
    if (!draft) throw new ConflictException("订单调度工作区尚未初始化，请重新打开项目")
    return this.readRecords(manager, projectId, user, draft)
  }

  private async readRecords(manager: EntityManager, projectId: string, user: AuthUser, lockedDraft?: LogisticsScheduleDraftEntity): Promise<SchedulingRecords> {
    const project = await this.loadProject(manager, projectId, user)
    const [batch, orders, aircraft, routeVersion, draft] = await Promise.all([
      manager.findOne(LogisticsOrderBatchEntity, { where: { project: { id: projectId } } }),
      manager.find(LogisticsOrderEntity, { where: { batch: { project: { id: projectId } } }, order: { code: "ASC" } }),
      manager.find(LogisticsAircraftInstanceEntity, { where: { project: { id: projectId } }, order: { code: "ASC" } }),
      manager.findOne(LogisticsRoutePlanVersionEntity, { where: { project: { id: projectId }, status: "SUBMITTED" }, relations: { routes: { waypoints: true } }, order: { versionNo: "DESC" } }),
      lockedDraft ? Promise.resolve(lockedDraft) : manager.findOne(LogisticsScheduleDraftEntity, { where: { project: { id: projectId } } })
    ])
    if (!batch || !draft || !routeVersion) throw new ConflictException("订单调度工作区数据不完整")
    return { project, batch, orders, aircraft, routeVersion, routes: this.schedulingRoutes(routeVersion), draft }
  }

  private check(records: SchedulingRecords): LogisticsScheduleCheckResult {
    return checkLogisticsSchedule(records.draft.items, {
      orders: records.orders.map((order) => this.serializeOrder(order, false)),
      aircraft: records.aircraft.map((aircraft) => this.serializeAircraft(aircraft)),
      routes: records.routes,
      strictSerialOperation: logisticsTemplatePolicy(records.project.snapshot.config.scaleTemplateCode).strictSerialOperation
    })
  }

  private async persistVersion(manager: EntityManager, records: SchedulingRecords, user: AuthUser, checkResult: LogisticsScheduleCheckResult): Promise<void> {
    const raw = await manager.createQueryBuilder(LogisticsScheduleVersionEntity, "version").select("COALESCE(MAX(version.versionNo), 0)", "maximum").where("version.projectId = :projectId", { projectId: records.project.id }).getRawOne<{ maximum: string | number }>()
    const versionNo = Number(raw?.maximum ?? 0) + 1
    const version = await manager.save(LogisticsScheduleVersionEntity, manager.create(LogisticsScheduleVersionEntity, {
      project: records.project,
      versionNo,
      sourceDraftRevision: records.draft.revision,
      status: "SNAPSHOT",
      checkResult,
      createdBy: await manager.findOneByOrFail(UserEntity, { id: user.id }),
      submittedAt: null
    }))
    const orderMap = new Map(records.orders.map((order) => [order.id, order]))
    const aircraftMap = new Map(records.aircraft.map((aircraft) => [aircraft.id, aircraft]))
    const routeEntities = records.routeVersion.routes ?? []
    const routeMap = new Map(routeEntities.map((route) => [route.id, route]))
    const computedMap = new Map(checkResult.items.map((item) => [item.id, item]))
    for (const [sequence, item] of records.draft.items.entries()) {
      const computed = computedMap.get(item.id)
      const order = orderMap.get(item.orderId)
      const aircraft = aircraftMap.get(item.aircraftId)
      const outboundRoute = routeMap.get(item.outboundRouteId)
      const returnRoute = routeMap.get(item.returnRouteId)
      if (!computed || !order || !aircraft || !outboundRoute || !returnRoute) throw new ConflictException("调度包含无效引用，不能保存版本")
      await manager.save(LogisticsDispatchItemEntity, manager.create(LogisticsDispatchItemEntity, {
        version,
        sequence,
        itemKey: item.id,
        order,
        aircraft,
        outboundRoute,
        returnRoute,
        plannedTakeoffTimeMs: computed.plannedTakeoffTimeMs,
        arrivalTimeMs: computed.arrivalTimeMs,
        returnStartTimeMs: computed.returnStartTimeMs,
        landingTimeMs: computed.landingTimeMs,
        nextAvailableTimeMs: computed.nextAvailableTimeMs,
        batteryAfterMissionPercent: computed.batteryAfterMissionPercent
      }))
    }
    await manager.increment(ProjectActivityCounterEntity, { project: { id: records.project.id } }, "savedVersionCount", 1)
    await this.activities.record(manager, {
      assignmentId: records.project.snapshot.draft.id,
      projectId: records.project.id,
      stageCode: "LOGISTICS_ORDER_SCHEDULING",
      actor: user,
      eventType: "LOGISTICS_SCHEDULE_VERSION_CREATED",
      objectType: "LOGISTICS_SCHEDULE_VERSION",
      objectId: version.id,
      result: { versionNo, itemCount: records.draft.items.length, status: checkResult.status, submittable: checkResult.submittable }
    })
  }

  private async loadVersion(manager: EntityManager, projectId: string, versionId: string, lock = false): Promise<LogisticsScheduleVersionEntity> {
    if (lock) {
      const locked = await manager.findOne(LogisticsScheduleVersionEntity, { where: { id: versionId, project: { id: projectId } }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
      if (!locked) throw new NotFoundException("调度版本不存在")
    }
    const version = await manager.findOne(LogisticsScheduleVersionEntity, { where: { id: versionId, project: { id: projectId } }, relations: { items: { order: true, aircraft: true, outboundRoute: true, returnRoute: true } } })
    if (!version) throw new NotFoundException("调度版本不存在")
    return version
  }

  private itemsFromVersion(version: LogisticsScheduleVersionEntity): LogisticsScheduleItemInput[] {
    return [...(version.items ?? [])].sort((left, right) => left.sequence - right.sequence).map((item) => ({ id: item.itemKey, orderId: item.order.id, aircraftId: item.aircraft.id, outboundRouteId: item.outboundRoute.id, returnRouteId: item.returnRoute.id, plannedTakeoffTimeMs: item.plannedTakeoffTimeMs }))
  }

  private serializeVersion(version: LogisticsScheduleVersionEntity, redact: boolean): LogisticsScheduleVersionView {
    return {
      id: version.id,
      versionNo: version.versionNo,
      sourceDraftRevision: version.sourceDraftRevision,
      status: version.status,
      items: this.itemsFromVersion(version),
      checkResult: this.redactCheck(version.checkResult, redact),
      createdBy: version.createdBy.displayName,
      createdAt: version.createdAt.toISOString(),
      submittedAt: version.submittedAt?.toISOString() ?? null
    }
  }

  private serializeOrder(order: LogisticsOrderEntity, scheduled: boolean): LogisticsSchedulingOrderView {
    return { id: order.id, code: order.code, destinationNodeId: order.destinationNodeId, releaseTimeMs: order.releaseTimeMs, priority: order.priority, earliestStartTimeMs: order.earliestStartTimeMs, latestArrivalTimeMs: order.latestArrivalTimeMs, status: scheduled ? "SCHEDULED" : order.releaseTimeMs > 0 ? "UNRELEASED" : "UNASSIGNED" }
  }

  private serializeAircraft(aircraft: LogisticsAircraftInstanceEntity): LogisticsAircraftInstanceView {
    return { id: aircraft.id, code: aircraft.code, modelCode: aircraft.modelCode, initialBatteryPercent: aircraft.initialBatteryPercent, availableAtMs: aircraft.availableAtMs, status: aircraft.status }
  }

  private serializeSchedulingAircraft(aircraft: LogisticsAircraftInstanceEntity, scheduleItems: LogisticsScheduleItemView[]): LogisticsSchedulingAircraftView {
    const taskQueue = scheduleItems
      .filter((item) => item.aircraftId === aircraft.id)
      .sort((left, right) => left.plannedTakeoffTimeMs - right.plannedTakeoffTimeMs)
      .map((item) => ({
        scheduleItemId: item.id,
        orderId: item.orderId,
        orderCode: item.orderCode,
        destinationNodeId: item.destinationNodeId,
        plannedTakeoffTimeMs: item.plannedTakeoffTimeMs,
        arrivalTimeMs: item.arrivalTimeMs,
        landingTimeMs: item.landingTimeMs,
        nextAvailableTimeMs: item.nextAvailableTimeMs
      }))
    const lastTask = taskQueue.at(-1)
    return {
      ...this.serializeAircraft(aircraft),
      currentLocation: { type: "CENTER_AIRPORT", label: "中心机场" },
      taskQueue,
      estimatedReturnTimeMs: lastTask?.landingTimeMs ?? null,
      nextAvailableTimeMs: Math.max(aircraft.availableAtMs, lastTask?.nextAvailableTimeMs ?? 0)
    }
  }

  private schedulingRoutes(version: LogisticsRoutePlanVersionEntity): LogisticsSchedulingRouteView[] {
    return [...(version.routes ?? [])].sort((left, right) => left.routeKey.localeCompare(right.routeKey)).map((route) => {
      const metric = version.validationResult?.routeMetrics.find((item) => item.routeId === route.routeKey)
      return {
        id: route.id,
        versionId: version.id,
        versionNo: version.versionNo,
        validationStatus: version.validationResult?.status ?? "INFEASIBLE",
        route: this.serializeRoute(route),
        distanceMeters: metric?.distanceMeters ?? 0,
        flightTimeMs: Math.max(1_000, Math.round((metric?.flightTimeSeconds ?? 60) * 1_000)),
        batteryConsumptionPercent: metric?.batteryConsumptionPercent ?? 10
      }
    })
  }

  private serializeRoute(route: LogisticsRouteEntity) {
    return {
      id: route.routeKey,
      name: route.name,
      mode: route.mode ?? "FIXED_ROUND_TRIP",
      destinationNodeId: route.destinationNodeId,
      direction: route.direction,
      role: route.role,
      groupCode: route.groupCode,
      departureNodeId: route.departureNodeId,
      arrivalNodeId: route.arrivalNodeId,
      protectionRadiusMeters: route.protectionRadiusMeters,
      waitingNodeIds: route.waitingNodeIds,
      alternateLandingNodeIds: route.alternateLandingNodeIds,
      emergencyAreaNodeIds: route.emergencyAreaNodeIds,
      entryDirectionDegrees: route.entryDirectionDegrees,
      exitDirectionDegrees: route.exitDirectionDegrees,
      waypoints: [...(route.waypoints ?? [])].sort((left, right) => left.sequence - right.sequence).map((waypoint: LogisticsWaypointEntity) => ({ id: waypoint.waypointKey, name: waypoint.name, position: { longitude: waypoint.longitude, latitude: waypoint.latitude }, altitudeMeters: waypoint.altitudeMeters, segmentAltitudeMeters: waypoint.segmentAltitudeMeters, speedMps: waypoint.speedMps, nodeId: waypoint.nodeId, locked: waypoint.locked }))
    }
  }

  private redactCheck(result: LogisticsScheduleCheckResult, redact: boolean): LogisticsScheduleCheckResult {
    return redact ? { ...result, items: [], evidence: [] } : result
  }

  private async loadProject(manager: EntityManager, projectId: string, user: AuthUser): Promise<StudentProjectEntity> {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    this.requireProjectAccess(project, user)
    if (project.snapshot.sceneType !== "CITY_LOGISTICS") throw new BadRequestException("当前项目不是城市低空物流场景")
    return project
  }

  private requireProjectAccess(project: StudentProjectEntity, user: AuthUser): "STUDENT" | "TEACHER" {
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return "STUDENT"
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return "TEACHER"
    throw new ForbiddenException("无权访问该学生项目")
  }

  private requireStudent(user: AuthUser): void {
    if (user.role !== "student") throw new ForbiddenException("仅学生可以修改物流调度方案")
  }

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    if (project.snapshot.draft.status === "ENDED" || project.snapshot.draft.status === "ARCHIVED") throw new ConflictException("任务已结束或归档，不能继续修改")
  }

  private async requireSchedulingStage(manager: EntityManager, projectId: string, lock: boolean): Promise<StudentProjectStageEntity> {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode: "LOGISTICS_ORDER_SCHEDULING" }, ...(lock ? { lock: { mode: "pessimistic_write" as const } } : {}) })
    if (!stage) throw new NotFoundException("订单调度阶段不存在")
    if (stage.status !== "IN_PROGRESS") throw new ConflictException("请先开始订单调度阶段")
    return stage
  }

  private async acceptStageAndUnlockNext(manager: EntityManager, project: StudentProjectEntity, stage: StudentProjectStageEntity, now: Date): Promise<void> {
    stage.status = "ACCEPTED"
    stage.revision += 1
    stage.submittedAt = now
    stage.acceptedAt = now
    await manager.save(stage)
    const next = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: project.id }, sequence: stage.sequence + 1 }, lock: { mode: "pessimistic_write" } })
    if (next?.status === "LOCKED") {
      next.status = "AVAILABLE"
      next.revision += 1
      await manager.save(next)
      project.currentStageCode = next.stageCode
    }
    project.status = "IN_PROGRESS"
    project.lastActivityAt = now
    await manager.save(project)
  }
}
