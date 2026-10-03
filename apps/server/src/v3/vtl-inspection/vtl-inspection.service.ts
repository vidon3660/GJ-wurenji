import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import { DataSource, EntityManager, Repository } from "typeorm"
import { randomUUID } from "node:crypto"
import {
  vtlFlightPhases,
  vtlTemplatePolicy,
  type AuthUser,
  type VtlAircraftAssignmentView,
  type VtlAllocationIssueView,
  type VtlAllocationPlanView,
  type VtlExecutionPlanView,
  type VtlFlightPhase,
  type VtlGroupView,
  type VtlPlanningWorkspaceView,
  type VtlProjectPlanView,
  type VtlRouteWaypointInput,
  type VtlTaskZoneView,
  type VtlStageCode
} from "@wurenji/shared"
import { buildVtlRoutePlan, validateVtlPlan } from "@wurenji/simulation"
import { UserEntity } from "../../entities.js"
import { StudentProjectEntity, StudentProjectStageEntity } from "../assignments/assignment.entities.js"
import { ResourcePackageService } from "../resources/resource-package.service.js"
import { VtlProjectPlanEntity } from "./vtl-inspection.entities.js"
import { buildVtlTerrainProfile, loadVtlElevationSamples } from "./terrain-elevation.js"
import { validateVtlAllocationGeometry } from "./vtl-allocation-validation.js"
import { completeVtlStage, configuredMainLandingSiteId } from "./vtl-stage-flow.js"
import { assessmentTimingForProject } from "../assessment/assessment-window.service.js"
import { vtlPlanCheckResultIsCurrent } from "./vtl-check-freshness.js"

@Injectable()
export class VtlInspectionService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly resources: ResourcePackageService,
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(VtlProjectPlanEntity) private readonly plans: Repository<VtlProjectPlanEntity>
  ) {}

  async workspace(projectId: string, user: AuthUser): Promise<VtlPlanningWorkspaceView> {
    await this.ensurePlan(projectId, user)
    const { project, plan, actor } = await this.load(projectId, user)
    const region = await this.resources.findRegion(project.snapshot.config.regionPackageId)
    const stages = await this.dataSource.getRepository(StudentProjectStageEntity).find({ where: { project: { id: projectId } }, order: { sequence: "ASC" } })
    const status = (code: VtlStageCode) => stages.find((stage) => stage.stageCode === code)?.status
    const mutable = actor === "STUDENT"
      && project.snapshot.draft.status !== "ENDED"
      && project.snapshot.draft.status !== "ARCHIVED"
      && assessmentTimingForProject(project).canWrite
    return {
      projectId,
      actor,
      mode: project.snapshot.mode,
      scaleTemplateCode: project.snapshot.config.scaleTemplateCode,
      region,
      plan: this.serialize(plan),
      canConfirmArea: mutable && status("VTL_AREA_OBJECTS") === "IN_PROGRESS",
      canEditAllocation: mutable && status("VTL_TASK_ALLOCATION") === "IN_PROGRESS",
      canSubmitAllocation: mutable && status("VTL_TASK_ALLOCATION") === "IN_PROGRESS" && plan.allocation.valid,
      canEditRoutes: mutable && status("VTL_ROUTE_PLANNING") === "IN_PROGRESS",
      canValidate: mutable && status("VTL_PLAN_VALIDATION") === "IN_PROGRESS" && plan.routes.length > 0,
       canSubmitValidation: mutable && status("VTL_PLAN_VALIDATION") === "IN_PROGRESS" && vtlPlanCheckResultIsCurrent(this.serialize(plan)),
       canSubmitExecutionPlan: mutable && status("VTL_EXECUTION_PLAN") === "IN_PROGRESS" && vtlPlanCheckResultIsCurrent(this.serialize(plan))
    }
  }

  async confirmArea(projectId: string, user: AuthUser, input: { expectedRevision?: number }) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
      this.assertRevision(input.expectedRevision, plan.revision)
      const mainLandingSiteId = configuredMainLandingSiteId(project)
      const mainLandingSite = plan.landingSites.find((site) => site.id === mainLandingSiteId && site.type === "MAIN" && site.status === "AVAILABLE")
      if (plan.taskObjects.length === 0 || !mainLandingSite) throw new ConflictException("巡检任务对象或教师选择的主起降点资源不可用")
      plan.areaConfirmedAt = new Date()
      plan.revision += 1
      plan.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(plan)
      await completeVtlStage(manager, project, "VTL_AREA_OBJECTS")
    })
    return this.workspace(projectId, user)
  }

  async saveAllocation(projectId: string, user: AuthUser, input: Record<string, unknown>) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
      await this.requireStage(manager, projectId, "VTL_TASK_ALLOCATION")
      this.assertRevision(numberOrUndefined(input.expectedRevision), plan.revision)
      const policy = vtlTemplatePolicy(project.snapshot.config.scaleTemplateCode)
      const groups = normalizeGroups(input.groups, policy.totalAircraft, plan.allocation.groups)
      const assignments = normalizeAssignments(input.assignments, policy.totalAircraft, groups, plan.taskObjects)
      const taskZones = normalizeTaskZones(input.taskZones, plan.taskObjects, groups)
      const region = await this.resources.findRegion(project.snapshot.config.regionPackageId)
      const issues = [
        ...allocationIssues(assignments, plan.taskObjects),
        ...validateVtlAllocationGeometry({
          taskObjects: plan.taskObjects,
          taskZones,
          assignments,
          groups,
          regionBoundary: project.snapshot.config.vtlParameters?.taskAreaBoundary ?? region.boundary
        })
      ]
      plan.taskObjects = plan.taskObjects.map((task) => ({ ...task, status: assignments.some((assignment) => assignment.taskObjectIds.includes(task.id)) ? "ASSIGNED" : "UNASSIGNED", incompleteReason: null }))
      plan.allocation = {
        projectId,
        revision: plan.allocation.revision + 1,
        taskZones,
        assignments,
        groups,
        issues,
        valid: issues.every((issue) => !issue.blocking),
        updatedAt: new Date().toISOString()
      }
      plan.routes = []
      plan.checkResult = null
      plan.executionPlan = null
      plan.revision += 1
      plan.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(plan)
      project.status = "IN_PROGRESS"
      project.lastActivityAt = new Date()
      await manager.save(project)
    })
    return this.workspace(projectId, user)
  }

  async submitAllocation(projectId: string, user: AuthUser, input: { expectedRevision?: number }) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
      this.assertRevision(input.expectedRevision, plan.revision)
      if (!plan.allocation.valid) throw new ConflictException("任务分配仍存在遗漏或重复，不能提交")
      await completeVtlStage(manager, project, "VTL_TASK_ALLOCATION")
    })
    return this.workspace(projectId, user)
  }

  async saveRoute(projectId: string, aircraftId: string, user: AuthUser, input: Record<string, unknown>) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
      await this.requireStage(manager, projectId, "VTL_ROUTE_PLANNING")
      this.assertRevision(numberOrUndefined(input.expectedRevision), plan.revision)
      const assignment = plan.allocation.assignments.find((item) => item.aircraftId === aircraftId)
      if (!assignment || assignment.taskObjectIds.length === 0) throw new BadRequestException("航空器未分配巡检任务")
      const waypoints = normalizeWaypoints(input.waypoints, assignment.taskObjectIds)
      const transitionHeightMeters = positiveNumber(input.transitionHeightMeters, "转换高度")
      const alternateLandingSiteId = text(input.alternateLandingSiteId, "备降点")
      const alternate = plan.landingSites.find((site) => site.id === alternateLandingSiteId && site.type === "ALTERNATE" && site.status === "AVAILABLE")
      if (!alternate) throw new BadRequestException("备降点不可用")
      const existing = plan.routes.find((route) => route.aircraftId === aircraftId)
      const region = await this.resources.findRegion(project.snapshot.config.regionPackageId)
      const elevationSamples = await loadVtlElevationSamples(region.terrain)
      const terrainProfile = buildVtlTerrainProfile(waypoints, elevationSamples)
      const computed = buildVtlRoutePlan({
        routeId: existing?.id ?? randomUUID(),
        projectId,
        aircraftId,
        parameterVersion: plan.aircraftParameters.version,
        transitionHeightMeters,
        alternateLandingSiteId,
        alternateLandingSitePosition: alternate.position,
        waypoints,
        ...(terrainProfile ? { terrainProfile } : {}),
        parameters: plan.aircraftParameters
      })
      computed.route.revision = (existing?.revision ?? 0) + 1
      plan.routes = [...plan.routes.filter((route) => route.aircraftId !== aircraftId), computed.route].sort((left, right) => left.aircraftId.localeCompare(right.aircraftId))
      plan.checkResult = null
      plan.executionPlan = null
      plan.revision += 1
      plan.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(plan)
    })
    return this.workspace(projectId, user)
  }

  async completeRoutes(projectId: string, user: AuthUser, input: { expectedRevision?: number }) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
      this.assertRevision(input.expectedRevision, plan.revision)
      const requiredAircraftIds = plan.allocation.assignments.filter((assignment) => assignment.taskObjectIds.length > 0).map((assignment) => assignment.aircraftId)
      const missing = requiredAircraftIds.filter((aircraftId) => !plan.routes.some((route) => route.aircraftId === aircraftId))
      if (missing.length > 0) throw new ConflictException(`以下航空器尚未完成航线：${missing.join("、")}`)
      await completeVtlStage(manager, project, "VTL_ROUTE_PLANNING")
    })
    return this.workspace(projectId, user)
  }

  async validate(projectId: string, user: AuthUser) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
      await this.requireStage(manager, projectId, "VTL_PLAN_VALIDATION")
      const mainLandingSiteId = configuredMainLandingSiteId(project)
      const mainLandingSite = plan.landingSites.find((site) => site.id === mainLandingSiteId && site.type === "MAIN" && site.status === "AVAILABLE")
      if (!mainLandingSite) throw new ConflictException("教师选择的主起降点不可用")
      plan.checkResult = validateVtlPlan({
        projectId,
        allocationRevision: plan.allocation.revision,
        routes: plan.routes,
        assignments: plan.allocation.assignments,
        taskObjects: plan.taskObjects,
        parameters: plan.aircraftParameters,
        mainLandingSiteId: mainLandingSite.id,
        availableAlternateLandingSiteIds: plan.landingSites.filter((site) => site.type === "ALTERNATE" && site.status === "AVAILABLE").map((site) => site.id),
        mainLandingSitePosition: mainLandingSite.position
      })
      if (!plan.checkResult.passed) {
        const now = new Date()
        const routeStage = await manager.findOne(StudentProjectStageEntity, {
          where: { project: { id: projectId }, stageCode: "VTL_ROUTE_PLANNING" },
          lock: { mode: "pessimistic_write" }
        })
        const validationStage = await manager.findOne(StudentProjectStageEntity, {
          where: { project: { id: projectId }, stageCode: "VTL_PLAN_VALIDATION" },
          lock: { mode: "pessimistic_write" }
        })
        if (!routeStage || !validationStage) throw new NotFoundException("垂起巡检航线或检查阶段不存在")
        routeStage.status = "RETURNED"
        routeStage.submittedAt = null
        routeStage.acceptedAt = null
        routeStage.returnedAt = now
        routeStage.revision += 1
        validationStage.status = "LOCKED"
        validationStage.submittedAt = null
        validationStage.acceptedAt = null
        validationStage.returnedAt = null
        validationStage.revision += 1
        plan.executionPlan = null
        project.currentStageCode = "VTL_ROUTE_PLANNING"
        project.status = "IN_PROGRESS"
        project.lastActivityAt = now
        await manager.save([routeStage, validationStage, project])
      }
      plan.revision += 1
      plan.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(plan)
    })
    return this.workspace(projectId, user)
  }

  async submitValidation(projectId: string, user: AuthUser, input: { expectedRevision?: number }) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
      this.assertRevision(input.expectedRevision, plan.revision)
       this.assertCurrentPassedCheck(plan)
      await completeVtlStage(manager, project, "VTL_PLAN_VALIDATION")
    })
    return this.workspace(projectId, user)
  }

  async submitExecutionPlan(projectId: string, user: AuthUser, input: Record<string, unknown>) {
    this.requireStudent(user)
    await this.dataSource.transaction(async (manager) => {
      const { project, plan } = await this.lock(manager, projectId, user)
       await this.requireStage(manager, projectId, "VTL_EXECUTION_PLAN")
       this.assertRevision(numberOrUndefined(input.expectedRevision), plan.revision)
       this.assertCurrentPassedCheck(plan)
       const currentCheckResult = plan.checkResult!
       const activeAircraftIds = plan.allocation.assignments.filter((assignment) => assignment.taskObjectIds.length > 0).map((assignment) => assignment.aircraftId)
      const takeoffOrder = exactOrder(input.takeoffOrder, activeAircraftIds, "起飞顺序")
      const landingOrder = exactOrder(input.landingOrder, activeAircraftIds, "降落顺序")
      const executionPlan: VtlExecutionPlanView = {
        projectId,
        version: (plan.executionPlan?.version ?? 0) + 1,
        takeoffOrder,
        landingOrder,
        taskOrderByAircraft: Object.fromEntries(plan.allocation.assignments.map((assignment) => [assignment.aircraftId, assignment.taskSequence])),
        allocationRevision: plan.allocation.revision,
        routeRevisions: Object.fromEntries(plan.routes.map((route) => [route.aircraftId, route.revision])),
         checkResult: currentCheckResult,
        status: "SUBMITTED",
        submittedAt: new Date().toISOString()
      }
      plan.executionPlan = executionPlan
      plan.revision += 1
      plan.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(plan)
      await completeVtlStage(manager, project, "VTL_EXECUTION_PLAN")
    })
    return this.workspace(projectId, user)
  }

  private async ensurePlan(projectId: string, user: AuthUser): Promise<void> {
    const existing = await this.plans.findOne({ where: { project: { id: projectId } } })
    if (existing) return
    await this.dataSource.transaction(async (manager) => {
      await manager.findOne(StudentProjectEntity, { where: { id: projectId }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
      const project = await this.loadProject(manager, projectId, user)
      const duplicate = await manager.getRepository(VtlProjectPlanEntity)
        .createQueryBuilder("plan")
        .where('plan."projectId" = :projectId', { projectId })
        .setLock("pessimistic_write")
        .getOne()
      if (duplicate) return
      const region = await this.resources.findRegion(project.snapshot.config.regionPackageId)
      if (!region.vtlTaskObjects?.length || !region.vtlLandingSites?.length || !region.vtlAircraftParameters) throw new ConflictException("垂起区域资源缺少任务对象、起降点或机型参数")
      const policy = vtlTemplatePolicy(project.snapshot.config.scaleTemplateCode)
      const configuredTaskObjectIds = project.snapshot.config.vtlParameters?.taskObjectIds
      const selectedTaskObjectIds = configuredTaskObjectIds?.length
        ? configuredTaskObjectIds
        : region.vtlTaskObjects.slice(0, policy.defaultTaskObjectCount).map((item) => item.id)
      const taskObjects = selectedTaskObjectIds
        .map((id) => region.vtlTaskObjects!.find((item) => item.id === id))
        .filter((item): item is NonNullable<typeof region.vtlTaskObjects>[number] => Boolean(item))
        .map((item) => ({ ...item, positions: item.positions.map((position) => ({ ...position })) }))
      if (taskObjects.length !== selectedTaskObjectIds.length) throw new ConflictException("任务快照引用了不存在的垂起巡检对象")
      const groups = defaultGroups(policy.totalAircraft, policy.defaultGroupCount)
      const assignments = defaultAssignments(policy.totalAircraft, groups)
      const issues = allocationIssues(assignments, taskObjects)
      const now = new Date().toISOString()
      const allocation: VtlAllocationPlanView = { projectId, revision: 1, taskZones: [], assignments, groups, issues, valid: false, updatedAt: now }
      const actor = await manager.findOneByOrFail(UserEntity, { id: user.id })
      await manager.save(VtlProjectPlanEntity, manager.create(VtlProjectPlanEntity, {
        project,
        revision: 1,
        areaConfirmedAt: null,
        taskObjects,
        landingSites: region.vtlLandingSites,
        aircraftParameters: region.vtlAircraftParameters,
        allocation,
        routes: [],
        checkResult: null,
        executionPlan: null,
        updatedBy: actor
      }))
    })
  }

  private async load(projectId: string, user: AuthUser) {
    const project = await this.loadProject(this.dataSource.manager, projectId, user)
    const plan = await this.plans.findOne({ where: { project: { id: projectId } } })
    if (!plan) throw new NotFoundException("垂起巡检方案不存在")
    return { project, plan, actor: this.requireAccess(project, user) }
  }

  private async lock(manager: EntityManager, projectId: string, user: AuthUser) {
    await manager.findOne(StudentProjectEntity, { where: { id: projectId }, loadEagerRelations: false, lock: { mode: "pessimistic_write" } })
    const project = await this.loadProject(manager, projectId, user)
    const plan = await manager.getRepository(VtlProjectPlanEntity)
      .createQueryBuilder("plan")
      .where('plan."projectId" = :projectId', { projectId })
      .setLock("pessimistic_write")
      .getOne()
    if (!plan) throw new NotFoundException("垂起巡检方案不存在")
    plan.project = project
    return { project, plan }
  }

  private async loadProject(manager: EntityManager, projectId: string, user: AuthUser): Promise<StudentProjectEntity> {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    this.requireAccess(project, user)
    if (project.snapshot.sceneType !== "VTOL_INSPECTION") throw new BadRequestException("当前项目不是垂起广域巡检场景")
    return project
  }

  private requireAccess(project: StudentProjectEntity, user: AuthUser): "STUDENT" | "TEACHER" {
    if (user.role === "student") {
      if (project.student.id !== user.id) throw new ForbiddenException("无权访问该学生项目")
      return "STUDENT"
    }
    if (user.role === "admin" || project.snapshot.draft.createdBy.id === user.id) return "TEACHER"
    throw new ForbiddenException("无权访问该学生项目")
  }

  private requireStudent(user: AuthUser) {
    if (user.role !== "student") throw new ForbiddenException("仅学生可以修改垂起巡检方案")
  }

  private async requireStage(manager: EntityManager, projectId: string, stageCode: VtlStageCode) {
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode } })
    if (!stage) throw new NotFoundException("垂起巡检阶段不存在")
    if (stage.status !== "IN_PROGRESS") throw new ConflictException("请先开始当前垂起巡检阶段")
    return stage
  }

  private assertRevision(expected: number | undefined, actual: number) {
    if (expected !== undefined && expected !== actual) throw new ConflictException("巡检方案已被其他操作更新，请刷新后重试")
  }

  private assertCurrentPassedCheck(plan: VtlProjectPlanEntity) {
    const serialized = this.serialize(plan)
    if (!serialized.checkResult?.passed) throw new ConflictException("单机或多机检查尚未通过")
    if (!vtlPlanCheckResultIsCurrent(serialized)) throw new ConflictException("检查结果已过期，请重新执行检查")
  }

  private serialize(plan: VtlProjectPlanEntity): VtlProjectPlanView {
    return {
      projectId: plan.project.id,
      revision: plan.revision,
      areaConfirmedAt: plan.areaConfirmedAt?.toISOString() ?? null,
      taskObjects: structuredClone(plan.taskObjects),
      landingSites: structuredClone(plan.landingSites),
      aircraftParameters: structuredClone(plan.aircraftParameters),
      allocation: structuredClone(plan.allocation),
      routes: structuredClone(plan.routes),
      checkResult: plan.checkResult ? structuredClone(plan.checkResult) : null,
      executionPlan: plan.executionPlan ? structuredClone(plan.executionPlan) : null,
      updatedAt: plan.updatedAt.toISOString()
    }
  }
}

function defaultGroups(totalAircraft: number, groupCount: number): VtlGroupView[] {
  return Array.from({ length: groupCount }, (_, groupIndex) => {
    const aircraftIds = Array.from({ length: totalAircraft }, (_, index) => aircraftId(index + 1)).filter((_, index) => index % groupCount === groupIndex)
    return { id: `VTL-GROUP-${groupIndex + 1}`, code: `G-${String(groupIndex + 1).padStart(2, "0")}`, title: `巡检 ${groupIndex + 1} 组`, aircraftIds, taskObjectIds: [] }
  })
}

function defaultAssignments(totalAircraft: number, groups: VtlGroupView[]): VtlAircraftAssignmentView[] {
  return Array.from({ length: totalAircraft }, (_, index) => {
    const id = aircraftId(index + 1)
    const group = groups.find((item) => item.aircraftIds.includes(id))!
    return { aircraftId: id, aircraftCode: `VTL-${String(index + 1).padStart(2, "0")}`, groupId: group.id, available: true, taskObjectIds: [], taskSequence: [], estimatedDurationSeconds: 0 }
  })
}

function normalizeGroups(value: unknown, totalAircraft: number, fallback: VtlGroupView[]): VtlGroupView[] {
  if (value === undefined) return structuredClone(fallback)
  if (!Array.isArray(value) || value.length === 0 || value.length > totalAircraft) throw new BadRequestException("分组数量无效")
  const validAircraftIds = new Set(Array.from({ length: totalAircraft }, (_, index) => aircraftId(index + 1)))
  const groups = value.map((item, index) => {
    const record = object(item, `分组 ${index + 1}`)
    const aircraftIds = stringArray(record.aircraftIds, `分组 ${index + 1} 航空器`)
    if (aircraftIds.some((id) => !validAircraftIds.has(id))) throw new BadRequestException("分组包含未知航空器")
    return { id: text(record.id, "分组标识"), code: text(record.code, "分组代码"), title: text(record.title, "分组名称"), aircraftIds, taskObjectIds: [] }
  })
  const allAircraftIds = groups.flatMap((group) => group.aircraftIds)
  if (allAircraftIds.length !== totalAircraft || new Set(allAircraftIds).size !== totalAircraft) throw new BadRequestException("每架航空器必须且只能属于一个分组")
  return groups
}

function normalizeAssignments(value: unknown, totalAircraft: number, groups: VtlGroupView[], taskObjects: VtlProjectPlanEntity["taskObjects"]): VtlAircraftAssignmentView[] {
  if (!Array.isArray(value) || value.length !== totalAircraft) throw new BadRequestException(`任务分配必须包含 ${totalAircraft} 架航空器`)
  const validTaskIds = new Set(taskObjects.map((item) => item.id))
  const validAircraftIds = new Set(Array.from({ length: totalAircraft }, (_, index) => aircraftId(index + 1)))
  const assignments = value.map((item, index) => {
    const record = object(item, `航空器分配 ${index + 1}`)
    const id = text(record.aircraftId, "航空器标识")
    const groupId = text(record.groupId, "分组标识")
    if (!validAircraftIds.has(id) || !groups.some((group) => group.id === groupId && group.aircraftIds.includes(id))) throw new BadRequestException("航空器或分组关系无效")
    const taskObjectIds = stringArray(record.taskObjectIds ?? [], "任务对象")
    if (taskObjectIds.some((taskId) => !validTaskIds.has(taskId))) throw new BadRequestException("任务分配包含未知任务对象")
    const taskSequence = stringArray(record.taskSequence ?? taskObjectIds, "任务顺序")
    if (taskSequence.length !== taskObjectIds.length || new Set(taskSequence).size !== taskObjectIds.length || taskSequence.some((taskId) => !taskObjectIds.includes(taskId))) throw new BadRequestException("任务顺序必须与任务对象一致")
    const estimatedDurationSeconds = taskObjectIds.reduce((sum, taskId) => sum + (taskObjects.find((task) => task.id === taskId)?.estimatedWorkSeconds ?? 0), 0)
    return { aircraftId: id, aircraftCode: `VTL-${id.slice(-2)}`, groupId, available: record.available !== false, taskObjectIds, taskSequence, estimatedDurationSeconds }
  })
  if (new Set(assignments.map((item) => item.aircraftId)).size !== totalAircraft) throw new BadRequestException("航空器任务分配不能重复")
  for (const group of groups) group.taskObjectIds = [...new Set(assignments.filter((item) => item.groupId === group.id).flatMap((item) => item.taskObjectIds))]
  return assignments
}

function normalizeTaskZones(value: unknown, taskObjects: VtlProjectPlanEntity["taskObjects"], groups: VtlGroupView[]): VtlTaskZoneView[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) throw new BadRequestException("任务分区格式无效")
  const taskIds = new Set(taskObjects.map((item) => item.id))
  const groupIds = new Set(groups.map((item) => item.id))
  return value.map((item, index) => {
    const record = object(item, `任务分区 ${index + 1}`)
    const assignedTaskIds = stringArray(record.taskObjectIds ?? [], "分区任务对象")
    if (assignedTaskIds.some((id) => !taskIds.has(id))) throw new BadRequestException("任务分区包含未知任务对象")
    const groupId = record.groupId === null || record.groupId === undefined || record.groupId === "" ? null : text(record.groupId, "分区机组")
    if (groupId && !groupIds.has(groupId)) throw new BadRequestException("任务分区关联未知机组")
    return {
      id: text(record.id, "分区标识"),
      title: text(record.title, "分区名称"),
      boundary: coordinates(record.boundary),
      groupId,
      taskObjectIds: assignedTaskIds,
      estimatedWorkSeconds: assignedTaskIds.reduce((sum, id) => sum + (taskObjects.find((task) => task.id === id)?.estimatedWorkSeconds ?? 0), 0)
    }
  })
}

function allocationIssues(assignments: VtlAircraftAssignmentView[], tasks: VtlProjectPlanEntity["taskObjects"]): VtlAllocationIssueView[] {
  const issues: VtlAllocationIssueView[] = []
  for (const task of tasks.filter((item) => item.required)) {
    const owners = assignments.filter((assignment) => assignment.taskObjectIds.includes(task.id))
    if (owners.length === 0) issues.push({ code: "UNASSIGNED", taskObjectId: task.id, aircraftId: null, message: `必做任务对象 ${task.code} 尚未分配`, blocking: true })
    if (owners.length > 1) issues.push({ code: "DUPLICATE", taskObjectId: task.id, aircraftId: null, message: `任务对象 ${task.code} 被重复分配`, blocking: true })
    if (owners.some((owner) => !owner.available)) issues.push({ code: "AIRCRAFT_UNAVAILABLE", taskObjectId: task.id, aircraftId: owners.find((owner) => !owner.available)?.aircraftId ?? null, message: `任务对象 ${task.code} 分配给不可用航空器`, blocking: true })
  }
  return issues
}

function normalizeWaypoints(value: unknown, assignedTaskIds: string[]): VtlRouteWaypointInput[] {
  if (!Array.isArray(value) || value.length < 8 || value.length > 500) throw new BadRequestException("航线至少需要八阶段航点")
  const waypoints = value.map((item, index) => {
    const record = object(item, `航点 ${index + 1}`)
    const phase = record.phase
    if (typeof phase !== "string" || !vtlFlightPhases.includes(phase as VtlFlightPhase)) throw new BadRequestException("航点阶段无效")
    const position = coordinate(record.position)
    const altitudeMeters = positiveNumber(record.altitudeMeters ?? position.altitudeMeters, "航点高度")
    const taskObjectId = record.taskObjectId === null || record.taskObjectId === undefined || record.taskObjectId === "" ? null : text(record.taskObjectId, "任务对象")
    if (taskObjectId && !assignedTaskIds.includes(taskObjectId)) throw new BadRequestException("航线关联了未分配给该航空器的任务对象")
    return { id: text(record.id, "航点标识"), sequence: index, phase: phase as VtlFlightPhase, position: { ...position, altitudeMeters }, altitudeMeters, speedMps: positiveNumber(record.speedMps, "航点速度"), taskObjectId }
  })
  let previousPhaseIndex = -1
  for (const waypoint of waypoints) {
    const phaseIndex = vtlFlightPhases.indexOf(waypoint.phase)
    if (phaseIndex < previousPhaseIndex) throw new BadRequestException("八阶段航点顺序无效")
    previousPhaseIndex = phaseIndex
  }
  if (vtlFlightPhases.some((phase) => !waypoints.some((waypoint) => waypoint.phase === phase))) throw new BadRequestException("航线必须包含完整八阶段")
  return waypoints
}

function exactOrder(value: unknown, expectedIds: string[], label: string): string[] {
  const ids = stringArray(value, label)
  if (ids.length !== expectedIds.length || new Set(ids).size !== ids.length || ids.some((id) => !expectedIds.includes(id))) throw new BadRequestException(`${label}必须包含全部执行航空器且不能重复`)
  return ids
}

function aircraftId(index: number) {
  return `VTL-AIRCRAFT-${String(index).padStart(2, "0")}`
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BadRequestException(`${label}格式无效`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160) throw new BadRequestException(`${label}无效`)
  return value.trim()
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new BadRequestException(`${label}必须为数组`)
  const result = value.map((item) => text(item, label))
  if (new Set(result).size !== result.length) throw new BadRequestException(`${label}不能重复`)
  return result
}

function positiveNumber(value: unknown, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new BadRequestException(`${label}必须大于 0`)
  return number
}

function numberOrUndefined(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new BadRequestException("版本号无效")
  return number
}

function coordinate(value: unknown) {
  const record = object(value, "坐标")
  const longitude = Number(record.longitude)
  const latitude = Number(record.latitude)
  const altitudeMeters = record.altitudeMeters === undefined ? undefined : Number(record.altitudeMeters)
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || (altitudeMeters !== undefined && !Number.isFinite(altitudeMeters))) throw new BadRequestException("坐标无效")
  return { longitude, latitude, ...(altitudeMeters === undefined ? {} : { altitudeMeters }) }
}

function coordinates(value: unknown) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 500) throw new BadRequestException("任务分区边界至少需要 3 个点")
  return value.map(coordinate)
}
