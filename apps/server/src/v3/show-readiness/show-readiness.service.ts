import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common"
import { InjectRepository } from "@nestjs/typeorm"
import type {
  AuthUser,
  ShowPreflightItemView,
  ShowPreflightResolution,
  ShowPreflightWorkspaceView,
  ShowTakeoffDecision,
  ShowT60ConfirmationView,
  ShowT60WorkspaceView,
  V3Coordinate
} from "@wurenji/shared"
import {
  resolveShowInitialConditions,
  showCommunicationControlLabel,
  showGustLabel,
  showInitialDeviceScopeLabel,
  showInitialDeviceStateLabel,
  showPositioningElectromagneticLabel,
  showRainLabel,
  showWindDirectionLabel,
  showWindForceLabel
} from "@wurenji/shared"
import { DataSource, EntityManager, Repository } from "typeorm"
import { UserEntity } from "../../entities.js"
import { ActivityLogService } from "../activities/activity-log.service.js"
import {
  StudentProjectEntity,
  StudentProjectStageEntity
} from "../assignments/assignment.entities.js"
import { ShowProjectDocumentEntity } from "../documents/show-document.entities.js"
import { ShowAreaFeatureEntity, ShowAreaPlanVersionEntity } from "../show-project/show-project.entities.js"
import { areaFeatureView, positionsFromGeometry } from "../show-project/area-plan-validation.js"
import { ShowPreflightRecordEntity, ShowSimulationClockEntity } from "./show-readiness.entities.js"
import { resolveShowAssignmentParameters } from "../assignments/show-assignment-parameters.js"
import { createShowT60SubmissionSnapshot, parseLegacyShowT60Confirmation, parseShowT60SubmissionSnapshot } from "./show-t60-submission.js"

interface PreflightResponseInput {
  code?: string
  confirmed?: boolean
  resolution?: ShowPreflightResolution | null
  resolved?: boolean
  note?: string
}

interface PreflightSaveInput {
  expectedRevision?: number
  responses?: PreflightResponseInput[]
  decision?: ShowTakeoffDecision | null
  rationale?: string
}

@Injectable()
export class ShowReadinessService {
  constructor(
    @InjectRepository(StudentProjectEntity) private readonly projects: Repository<StudentProjectEntity>,
    @InjectRepository(StudentProjectStageEntity) private readonly stages: Repository<StudentProjectStageEntity>,
    @InjectRepository(ShowPreflightRecordEntity) private readonly preflights: Repository<ShowPreflightRecordEntity>,
    @InjectRepository(ShowSimulationClockEntity) private readonly clocks: Repository<ShowSimulationClockEntity>,
    @InjectRepository(ShowProjectDocumentEntity) private readonly documents: Repository<ShowProjectDocumentEntity>,
    @InjectRepository(ShowAreaPlanVersionEntity) private readonly areaVersions: Repository<ShowAreaPlanVersionEntity>,
    @InjectRepository(ShowAreaFeatureEntity) private readonly areaFeatures: Repository<ShowAreaFeatureEntity>,
    private readonly activities: ActivityLogService,
    private readonly dataSource: DataSource
  ) {}

  async preflightWorkspace(projectId: string, user: AuthUser): Promise<ShowPreflightWorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    this.requireShowProject(project)
    const stage = await this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_PREFLIGHT" } })
    const record = await this.ensurePreflight(project, user)
    return serializePreflight(record, actor === "STUDENT" && stage?.status === "IN_PROGRESS" && this.isAssignmentActive(project))
  }

  async savePreflight(projectId: string, user: AuthUser, input: PreflightSaveInput): Promise<ShowPreflightWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以填写飞前检查")
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "SHOW_PREFLIGHT")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("飞前准备阶段不在可编辑状态")
      await manager.query('SELECT "id" FROM "show_preflight_records" WHERE "projectId" = $1 FOR UPDATE', [projectId])
      const record = await manager.findOne(ShowPreflightRecordEntity, { where: { project: { id: projectId } } })
      if (!record) throw new ConflictException("飞前检查记录尚未初始化")
      if (record.status === "COMPLETED") throw new ConflictException("飞前检查已经完成")
      const expectedRevision = normalizeRevision(input.expectedRevision)
      if (record.revision !== expectedRevision) throw new ConflictException(`飞前检查版本冲突，当前版本为 ${record.revision}`)
      const responses = normalizeResponses(input.responses, record.items)
      const beforeRevision = record.revision
      record.items = record.items.map((item) => ({ ...item, ...responses.get(item.code) }))
      record.decision = normalizeDecision(input.decision)
      record.rationale = normalizeRationale(input.rationale)
      record.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      record.revision += 1
      await manager.save(record)
      project.lastActivityAt = new Date()
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_PREFLIGHT",
        actor: user,
        eventType: "PREFLIGHT_SAVED",
        objectType: "PREFLIGHT",
        objectId: record.id,
        beforeRevision,
        afterRevision: record.revision,
        result: { confirmedCount: record.items.filter((item) => item.confirmed).length, itemCount: record.items.length, decision: record.decision }
      })
    })
    return this.preflightWorkspace(projectId, user)
  }

  async completePreflight(projectId: string, user: AuthUser, expectedRevision: number): Promise<ShowPreflightWorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以完成飞前检查")
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "SHOW_PREFLIGHT")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("飞前准备阶段不在可提交状态")
      await manager.query('SELECT "id" FROM "show_preflight_records" WHERE "projectId" = $1 FOR UPDATE', [projectId])
      const record = await manager.findOne(ShowPreflightRecordEntity, { where: { project: { id: projectId } } })
      if (!record) throw new ConflictException("飞前检查记录尚未初始化")
      if (record.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`飞前检查版本冲突，当前版本为 ${record.revision}`)
      assertPreflightComplete(record.items, record.decision, record.rationale)
      const now = new Date()
      const beforeRevision = record.revision
      record.status = "COMPLETED"
      record.completedAt = now
      record.updatedBy = await manager.findOneByOrFail(UserEntity, { id: user.id })
      record.revision += 1
      await manager.save(record)
      stage.status = "ACCEPTED"
      stage.submittedAt = now
      stage.acceptedAt = now
      stage.revision += 1
      await manager.save(stage)
      const next = await this.lockStage(manager, projectId, "SHOW_T_MINUS_60")
      if (next.status === "LOCKED") {
        next.status = "AVAILABLE"
        next.revision += 1
        await manager.save(next)
      }
      project.currentStageCode = "SHOW_T_MINUS_60"
      project.lastActivityAt = now
      await manager.save(project)
      await this.ensureClock(manager, project, user)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_PREFLIGHT",
        actor: user,
        eventType: "PREFLIGHT_COMPLETED",
        objectType: "PREFLIGHT",
        objectId: record.id,
        beforeRevision,
        afterRevision: record.revision,
        result: { decision: record.decision, unresolvedCount: record.items.filter((item) => !item.resolved).length }
      })
    })
    return this.preflightWorkspace(projectId, user)
  }

  async t60Workspace(projectId: string, user: AuthUser): Promise<ShowT60WorkspaceView> {
    const { project, actor } = await this.requireProjectAccess(projectId, user)
    this.requireShowProject(project)
    const [clock, stage] = await Promise.all([
      this.clocks.findOne({ where: { project: { id: projectId } } }),
      this.stages.findOne({ where: { project: { id: projectId }, stageCode: "SHOW_T_MINUS_60" } })
    ])
    if (!clock) throw new ConflictException("请先完成飞前准备")
    const simulationTimeMs = currentSimulationTime(clock)
    const prerequisites = await this.t60Prerequisites(projectId)
    const ready = simulationTimeMs >= Number(clock.thresholdSimulationTimeMs)
    const storedSubmission = parseShowT60SubmissionSnapshot(clock.submissionSnapshot)
    const legacyConfirmation = storedSubmission ? null : parseLegacyShowT60Confirmation(clock.submissionSnapshot)
    const confirmation = storedSubmission?.confirmation ?? legacyConfirmation ?? await this.t60Confirmation(project)
    const submission = clock.submittedAt ? storedSubmission?.submission ?? {
      reportCode: null,
      submittedAt: clock.submittedAt.toISOString(),
      submittedBy: clock.submittedBy ? { id: clock.submittedBy.id, displayName: clock.submittedBy.displayName } : null,
      simulationTimeMs: null
    } : null
    return {
      projectId,
      revision: clock.revision,
      canSubmit: actor === "STUDENT" && stage?.status === "IN_PROGRESS" && !clock.submittedAt && ready && prerequisites,
      status: clock.submittedAt ? "SUBMITTED" : ready ? "READY" : "NOT_OPEN",
      clockStatus: clock.status,
      simulationTimeMs,
      plannedTakeoffSimulationTimeMs: Number(clock.plannedTakeoffSimulationTimeMs),
      thresholdSimulationTimeMs: Number(clock.thresholdSimulationTimeMs),
      millisecondsUntilOpen: Math.max(0, Number(clock.thresholdSimulationTimeMs) - simulationTimeMs),
      clockRate: clock.rate,
      submittedAt: clock.submittedAt?.toISOString() ?? null,
      submission,
      confirmation
    }
  }

  async submitT60(projectId: string, user: AuthUser, expectedRevision: number): Promise<ShowT60WorkspaceView> {
    await this.dataSource.transaction(async (manager) => {
      const { project, actor } = await this.requireProjectAccess(projectId, user, manager)
      if (actor !== "STUDENT") throw new ForbiddenException("仅学生可以提交起飞前一小时申请")
      this.ensureAssignmentActive(project)
      const stage = await this.lockStage(manager, projectId, "SHOW_T_MINUS_60")
      if (stage.status !== "IN_PROGRESS") throw new ConflictException("起飞前报备阶段不在可提交状态")
      await manager.query('SELECT "id" FROM "show_simulation_clocks" WHERE "projectId" = $1 FOR UPDATE', [projectId])
      const clock = await manager.findOne(ShowSimulationClockEntity, { where: { project: { id: projectId } } })
      if (!clock) throw new ConflictException("仿真时钟尚未初始化")
      if (clock.revision !== normalizeRevision(expectedRevision)) throw new ConflictException(`报备版本冲突，当前版本为 ${clock.revision}`)
      if (clock.submittedAt) return
      if (currentSimulationTime(clock) < Number(clock.thresholdSimulationTimeMs)) throw new ConflictException("仿真时间尚未到达 T-60 节点")
      if (!await this.t60Prerequisites(projectId, manager)) throw new ConflictException("区域规划、申报材料或飞前准备尚未完成")
      const submitter = await manager.findOneByOrFail(UserEntity, { id: user.id })
      const confirmation = await this.t60Confirmation(project, manager)
      const now = new Date()
      const beforeRevision = clock.revision
      const submissionSimulationTimeMs = currentSimulationTime(clock)
      const submissionSnapshot = createShowT60SubmissionSnapshot({
        reportCode: `T60-${clock.id.replaceAll("-", "").slice(0, 8).toUpperCase()}-${String(beforeRevision + 1).padStart(2, "0")}`,
        submittedAt: now.toISOString(),
        submittedBy: { id: submitter.id, displayName: submitter.displayName },
        simulationTimeMs: submissionSimulationTimeMs,
        confirmation
      })
      clock.submittedAt = now
      clock.submittedBy = submitter
      clock.submissionSnapshot = submissionSnapshot as unknown as Record<string, unknown>
      clock.revision += 1
      await manager.save(clock)
      stage.status = "ACCEPTED"
      stage.submittedAt = now
      stage.acceptedAt = now
      stage.revision += 1
      await manager.save(stage)
      const next = await this.lockStage(manager, projectId, "SHOW_RUNTIME")
      if (next.status === "LOCKED") {
        next.status = "AVAILABLE"
        next.revision += 1
        await manager.save(next)
      }
      project.currentStageCode = "SHOW_RUNTIME"
      project.lastActivityAt = now
      await manager.save(project)
      await this.activities.record(manager, {
        assignmentId: project.snapshot.draft.id,
        projectId,
        stageCode: "SHOW_T_MINUS_60",
        actor: user,
        eventType: "T60_REPORT_SUBMITTED",
        objectType: "REPORTING",
        objectId: clock.id,
        simulationTimeMs: submissionSimulationTimeMs,
        beforeRevision,
        afterRevision: clock.revision,
        payload: submissionSnapshot as unknown as Record<string, unknown>,
        result: { status: "SUBMITTED", reportCode: submissionSnapshot.submission.reportCode }
      })
    })
    return this.t60Workspace(projectId, user)
  }

  private async ensurePreflight(project: StudentProjectEntity, actor: AuthUser): Promise<ShowPreflightRecordEntity> {
    const existing = await this.preflights.findOne({ where: { project: { id: project.id } } })
    if (existing) return existing
    const user = await this.dataSource.manager.findOneByOrFail(UserEntity, { id: project.student.id })
    try {
      return await this.preflights.save(this.preflights.create({
        project,
        status: "DRAFT",
        revision: 1,
        items: buildPreflightItems(project),
        decision: null,
        rationale: "",
        updatedBy: user,
        completedAt: null
      }))
    } catch {
      const concurrent = await this.preflights.findOne({ where: { project: { id: project.id } } })
      if (!concurrent) throw new ConflictException("飞前检查记录初始化失败")
      return concurrent
    }
  }

  private async ensureClock(manager: EntityManager, project: StudentProjectEntity, actor: AuthUser): Promise<void> {
    const existing = await manager.findOne(ShowSimulationClockEntity, { where: { project: { id: project.id } } })
    if (existing) return
    const rate = numberScenario(project.snapshot.config.scenario, "simulationClockRate", 60, 1, 600)
    const leadMinutes = numberScenario(project.snapshot.config.scenario, "simulationStartLeadMinutes", 75, 61, 240)
    const durationMinutes = plannedDurationMinutes(project)
    const plannedTakeoff = leadMinutes * 60_000
    const threshold = plannedTakeoff - 60 * 60_000
    const clock = await manager.save(ShowSimulationClockEntity, manager.create(ShowSimulationClockEntity, {
      project,
      status: "RUNNING",
      originSimulationTimeMs: 0,
      originRealTime: new Date(),
      rate,
      plannedTakeoffSimulationTimeMs: plannedTakeoff,
      thresholdSimulationTimeMs: threshold,
      plannedEndSimulationTimeMs: plannedTakeoff + durationMinutes * 60_000,
      revision: 1,
      submittedAt: null,
      submittedBy: null,
      submissionSnapshot: null
    }))
    await this.activities.record(manager, {
      assignmentId: project.snapshot.draft.id,
      projectId: project.id,
      stageCode: "SHOW_T_MINUS_60",
      actor,
      eventType: "T60_CLOCK_STARTED",
      objectType: "SIMULATION_CLOCK",
      objectId: clock.id,
      simulationTimeMs: 0,
      result: { rate, plannedTakeoffSimulationTimeMs: plannedTakeoff, thresholdSimulationTimeMs: threshold }
    })
  }

  private async t60Prerequisites(projectId: string, manager: EntityManager = this.dataSource.manager): Promise<boolean> {
    const [areaCount, documents, preflight] = await Promise.all([
      manager.count(ShowAreaPlanVersionEntity, { where: { project: { id: projectId }, status: "ACCEPTED" } }),
      manager.find(ShowProjectDocumentEntity, { where: { project: { id: projectId } } }),
      manager.findOne(ShowPreflightRecordEntity, { where: { project: { id: projectId }, status: "COMPLETED" } })
    ])
    return areaCount > 0 && documents.length === 3 && documents.every((document) => ["SUBMITTED", "VIEWED", "RESUBMITTED"].includes(document.status)) && Boolean(preflight)
  }

  private async t60Confirmation(project: StudentProjectEntity, manager: EntityManager = this.dataSource.manager): Promise<ShowT60ConfirmationView> {
    const area = await manager.findOne(ShowAreaPlanVersionEntity, {
      where: { project: { id: project.id }, status: "ACCEPTED" },
      order: { versionNo: "DESC" }
    })
    const entities = area ? await manager.find(ShowAreaFeatureEntity, { where: { version: { id: area.id } } }) : []
    const features = entities.map((feature) => areaFeatureView({
      id: feature.featureKey,
      type: feature.type,
      label: feature.label,
      positions: positionsFromGeometry(feature.geometry),
      ...(feature.heightDatum && feature.minimumHeightMeters !== null && feature.maximumHeightMeters !== null
        ? { heightRange: { datum: feature.heightDatum, minimumMeters: feature.minimumHeightMeters, maximumMeters: feature.maximumHeightMeters } }
        : {}),
      properties: feature.properties
    }))
    const takeoff = features.find((feature) => feature.type === "TAKEOFF_LANDING")
    const airspace = features.find((feature) => feature.type === "GEOFENCE") ?? features.find((feature) => feature.type === "FLIGHT")
    const maximumHeights = features.flatMap((feature) => feature.heightRange ? [feature.heightRange.maximumMeters] : [])
    const scenario = project.snapshot.config.scenario
    const parameters = resolveShowAssignmentParameters(project.snapshot.config)
    const initial = resolveShowInitialConditions(scenario, parseAircraftCount(project.snapshot.config.scaleTemplateCode))
    return {
      projectName: project.snapshot.title,
      plannedStartAt: parameters.plannedStartAt,
      plannedEndAt: parameters.plannedEndAt,
      takeoffPoint: takeoff?.measurement.centroid ?? null,
      airspaceBoundary: airspace?.positions ?? [],
      maximumHeightMeters: maximumHeights.length > 0 ? Math.min(parameters.maximumHeightMeters, Math.max(...maximumHeights)) : parameters.maximumHeightMeters,
      aircraftModel: parameters.aircraftModel,
      aircraftCount: parseAircraftCount(project.snapshot.config.scaleTemplateCode),
      contactName: parameters.contactName,
      contactPhone: parameters.contactPhone,
      environment: {
        风向: showWindDirectionLabel(initial.windDirection),
        风力状态: showWindForceLabel(initial.windForceState),
        阵风状态: showGustLabel(initial.gustState),
        降雨状态: showRainLabel(initial.rainState),
        定位与电磁: showPositioningElectromagneticLabel(initial.positioningElectromagneticState),
        通信与控制: showCommunicationControlLabel(initial.communicationControlState),
        设备状态: `${showInitialDeviceStateLabel(initial.deviceState)} · ${showInitialDeviceScopeLabel(initial.deviceImpactScope)} · ${initial.deviceAffectedCount} 架`
      }
    }
  }

  private async lockStage(manager: EntityManager, projectId: string, stageCode: "SHOW_PREFLIGHT" | "SHOW_T_MINUS_60" | "SHOW_RUNTIME") {
    await manager.query('SELECT "id" FROM "student_project_stages" WHERE "projectId" = $1 AND "stageCode" = $2 FOR UPDATE', [projectId, stageCode])
    const stage = await manager.findOne(StudentProjectStageEntity, { where: { project: { id: projectId }, stageCode } })
    if (!stage) throw new ConflictException("项目阶段记录不存在")
    return stage
  }

  private async requireProjectAccess(projectId: string, user: AuthUser, manager: EntityManager = this.projects.manager) {
    const project = await manager.findOne(StudentProjectEntity, { where: { id: projectId } })
    if (!project) throw new NotFoundException("学生项目不存在")
    if (user.role === "student" && project.student.id === user.id) return { project, actor: "STUDENT" as const }
    if (user.role === "teacher" && project.snapshot.draft.createdBy.id === user.id) return { project, actor: "TEACHER" as const }
    throw new ForbiddenException("无权访问该学生项目")
  }

  private requireShowProject(project: StudentProjectEntity): void {
    if (project.snapshot.sceneType !== "CITY_SHOW") throw new BadRequestException("该项目不是城市编队表演场景")
  }

  private isAssignmentActive(project: StudentProjectEntity): boolean {
    return project.snapshot.draft.status === "PUBLISHED" || project.snapshot.draft.status === "IN_PROGRESS"
  }

  private ensureAssignmentActive(project: StudentProjectEntity): void {
    if (!this.isAssignmentActive(project)) throw new ConflictException("任务已结束、归档或撤回，不能继续操作")
  }
}

const preflightDefinitions: Array<Pick<ShowPreflightItemView, "code" | "category" | "title" | "detail">> = [
  { code: "AIRFRAME", category: "AIRCRAFT", title: "机体状态", detail: "确认结构、外观和安装状态" },
  { code: "POWER", category: "AIRCRAFT", title: "动力系统", detail: "确认电机、桨叶和动力输出" },
  { code: "BATTERY", category: "AIRCRAFT", title: "电池", detail: "确认电量、一致性和异常数量" },
  { code: "FLIGHT_CONTROL", category: "AIRCRAFT", title: "飞控", detail: "确认飞控自检和参数状态" },
  { code: "NAVIGATION", category: "AIRCRAFT", title: "导航", detail: "确认导航源和航向状态" },
  { code: "SENSOR", category: "AIRCRAFT", title: "传感器", detail: "确认关键传感器状态" },
  { code: "GROUND_STATION", category: "GROUND_SYSTEM", title: "地面站", detail: "确认地面站设备可用" },
  { code: "CONTROL_SOFTWARE", category: "GROUND_SYSTEM", title: "控制软件", detail: "确认控制软件和任务数据" },
  { code: "DATA_RECORDING", category: "GROUND_SYSTEM", title: "数据记录", detail: "确认日志和数据记录功能" },
  { code: "EMERGENCY_FUNCTIONS", category: "GROUND_SYSTEM", title: "应急功能", detail: "确认暂停、返航、降落和中止功能" },
  { code: "POSITION_QUALITY", category: "POSITIONING", title: "定位质量", detail: "确认当前定位质量" },
  { code: "RTK_BASE", category: "POSITIONING", title: "差分基站", detail: "确认基站和差分链路" },
  { code: "EM_ENVIRONMENT", category: "POSITIONING", title: "电磁环境", detail: "确认电磁环境状态" },
  { code: "CONTROL_LINK", category: "COMMUNICATION", title: "控制链路", detail: "确认控制链路覆盖" },
  { code: "DATA_LINK", category: "COMMUNICATION", title: "数据链路", detail: "确认遥测数据链路" },
  { code: "WIND_DIRECTION", category: "WEATHER", title: "风向", detail: "确认风向与表演朝向关系" },
  { code: "WIND_FORCE", category: "WEATHER", title: "风力", detail: "确认风力满足放飞判断" },
  { code: "GUST", category: "WEATHER", title: "阵风", detail: "确认阵风变化" },
  { code: "RAIN", category: "WEATHER", title: "降雨", detail: "确认降雨状态" },
  { code: "TAKEOFF_AREA", category: "SITE_AREA", title: "起降区", detail: "确认现场与规划一致" },
  { code: "PERFORMANCE_AREA", category: "SITE_AREA", title: "表演区", detail: "确认现场与规划一致" },
  { code: "BUFFER_AREA", category: "SITE_AREA", title: "缓冲区", detail: "确认缓冲范围" },
  { code: "ISOLATION_AREA", category: "SITE_AREA", title: "隔离区", detail: "确认人员隔离" },
  { code: "AUDIENCE_AREA", category: "SITE_AREA", title: "观众区", detail: "确认观众区状态" },
  { code: "EMERGENCY_LANDING_AREA", category: "SITE_AREA", title: "应急降落区", detail: "确认应急降落区可用" },
  { code: "THREE_DOCUMENTS", category: "APPLICATION_SUPPORT", title: "三份申报材料", detail: "确认三份材料已经提交" },
  { code: "SECURITY", category: "PERSONNEL", title: "安保人员", detail: "确认教学情景中的安保人员到位" },
  { code: "FIRE", category: "PERSONNEL", title: "消防人员", detail: "确认教学情景中的消防人员到位" },
  { code: "MEDICAL", category: "PERSONNEL", title: "医疗人员", detail: "确认教学情景中的医疗人员到位" },
  { code: "EMERGENCY_PLAN", category: "APPLICATION_SUPPORT", title: "应急预案", detail: "确认安全应急预案已准备" }
]

export function buildPreflightItems(project: StudentProjectEntity): ShowPreflightItemView[] {
  const scenario = project.snapshot.config.scenario
  const configuredIssues = new Set(Array.isArray(scenario.preflightIssueCodes) ? scenario.preflightIssueCodes.filter((value): value is string => typeof value === "string") : [])
  const aircraftCount = parseAircraftCount(project.snapshot.config.scaleTemplateCode)
  const initial = resolveShowInitialConditions(scenario, aircraftCount)
  const initialIssues = showInitialPreflightIssues(initial)
  return preflightDefinitions.map((definition) => {
    const configured = configuredIssues.has(definition.code)
    const source = initialIssues.get(definition.code)
    const sourceStatus = configured ? (definition.code === "WIND_FORCE" ? "ABNORMAL" : "WARNING") : source?.status ?? "NORMAL"
    return {
      ...definition,
      detail: source?.detail ?? definition.detail,
      sourceStatus,
      affectedCount: sourceStatus === "NORMAL" ? (definition.category === "AIRCRAFT" ? aircraftCount : 0) : source?.affectedCount ?? (definition.category === "AIRCRAFT" ? Math.max(1, Math.ceil(aircraftCount * 0.01)) : 1),
      confirmed: false,
      resolution: null,
      resolved: sourceStatus === "NORMAL",
      note: ""
    }
  })
}

function showInitialPreflightIssues(initial: ReturnType<typeof resolveShowInitialConditions>): Map<string, { status: "WARNING" | "ABNORMAL"; detail: string; affectedCount: number }> {
  const issues = new Map<string, { status: "WARNING" | "ABNORMAL"; detail: string; affectedCount: number }>()
  const add = (codes: string[], status: "WARNING" | "ABNORMAL", detail: string, affectedCount = 1) => codes.forEach((code) => issues.set(code, { status, detail, affectedCount }))
  if (initial.windForceState !== "NORMAL") add(["WIND_FORCE"], initial.windForceState === "OVER_LIMIT" ? "ABNORMAL" : "WARNING", `教师冻结风力状态：${showWindForceLabel(initial.windForceState)}`)
  if (initial.gustState !== "NONE") add(["GUST"], initial.gustState === "CONTINUOUS" ? "ABNORMAL" : "WARNING", `教师冻结阵风状态：${showGustLabel(initial.gustState)}`)
  if (initial.rainState !== "NONE") add(["RAIN"], initial.rainState === "OVER_LIMIT" ? "ABNORMAL" : "WARNING", `教师冻结降雨状态：${showRainLabel(initial.rainState)}`)
  if (initial.positioningElectromagneticState !== "NORMAL") {
    const abnormal = initial.positioningElectromagneticState === "CONTINUOUS_INTERFERENCE" || initial.positioningElectromagneticState === "WIDE_AREA_INTERFERENCE"
    const detail = `教师冻结定位与电磁状态：${showPositioningElectromagneticLabel(initial.positioningElectromagneticState)}`
    add(["POSITION_QUALITY", "RTK_BASE"], abnormal ? "ABNORMAL" : "WARNING", detail)
    if (initial.positioningElectromagneticState !== "LOCAL_WEAK") add(["EM_ENVIRONMENT"], abnormal ? "ABNORMAL" : "WARNING", detail)
  }
  if (initial.communicationControlState !== "NORMAL") {
    const abnormal = ["SINGLE_LOST", "SMALL_BATCH_LOST", "GROUP_ABNORMAL", "MULTI_GROUP_ABNORMAL"].includes(initial.communicationControlState)
    const detail = `教师冻结通信与控制状态：${showCommunicationControlLabel(initial.communicationControlState)}`
    add(["CONTROL_LINK", "DATA_LINK"], abnormal ? "ABNORMAL" : "WARNING", detail)
  }
  if (initial.deviceState !== "NORMAL") {
    const codes = ({
      SELF_TEST_FAILURE: ["FLIGHT_CONTROL"],
      BATTERY_ABNORMAL: ["BATTERY"],
      VOLTAGE_IMBALANCE: ["BATTERY"],
      POWER_SYSTEM_ABNORMAL: ["POWER"],
      FLIGHT_CONTROL_SENSOR_ABNORMAL: ["FLIGHT_CONTROL", "SENSOR"],
      RETURN_LANDING_ABNORMAL: ["EMERGENCY_FUNCTIONS"]
    } as const)[initial.deviceState]
    const abnormal = ["POWER_SYSTEM_ABNORMAL", "FLIGHT_CONTROL_SENSOR_ABNORMAL", "RETURN_LANDING_ABNORMAL"].includes(initial.deviceState)
    add([...codes], abnormal ? "ABNORMAL" : "WARNING", `教师冻结设备状态：${showInitialDeviceStateLabel(initial.deviceState)}，影响${showInitialDeviceScopeLabel(initial.deviceImpactScope)}`, initial.deviceAffectedCount)
  }
  return issues
}

function normalizeResponses(value: PreflightResponseInput[] | undefined, items: ShowPreflightItemView[]): Map<string, Pick<ShowPreflightItemView, "confirmed" | "resolution" | "resolved" | "note">> {
  if (!Array.isArray(value)) throw new BadRequestException("飞前检查响应不能为空")
  const validCodes = new Set(items.map((item) => item.code))
  const result = new Map<string, Pick<ShowPreflightItemView, "confirmed" | "resolution" | "resolved" | "note">>()
  for (const response of value) {
    const code = response.code?.trim()
    if (!code || !validCodes.has(code) || result.has(code)) throw new BadRequestException("飞前检查项无效或重复")
    const resolution = response.resolution ?? null
    if (resolution && !["CONFIRMED", "EXCLUDED", "REPLACED", "RECHECKED", "PAUSED"].includes(resolution)) throw new BadRequestException("飞前处置方式无效")
    const note = response.note?.trim() ?? ""
    if (note.length > 500) throw new BadRequestException("单项检查说明不能超过 500 个字符")
    result.set(code, { confirmed: response.confirmed === true, resolution, resolved: response.resolved === true, note })
  }
  for (const item of items) {
    if (!result.has(item.code)) result.set(item.code, { confirmed: item.confirmed, resolution: item.resolution, resolved: item.resolved, note: item.note })
  }
  return result
}

function normalizeDecision(value: ShowTakeoffDecision | null | undefined): ShowTakeoffDecision | null {
  if (value === undefined || value === null) return null
  if (!["ALLOW", "ALLOW_AFTER_RECTIFICATION", "DELAY", "CANCEL"].includes(value)) throw new BadRequestException("起飞决策无效")
  return value
}

function normalizeRationale(value: string | undefined): string {
  const rationale = value?.trim() ?? ""
  if (rationale.length > 2_000) throw new BadRequestException("起飞决策依据不能超过 2000 个字符")
  return rationale
}

function assertPreflightComplete(items: ShowPreflightItemView[], decision: ShowTakeoffDecision | null, rationale: string): void {
  if (!items.every((item) => item.confirmed)) throw new ConflictException("请确认全部飞前检查项")
  if (!decision) throw new ConflictException("请选择起飞决策")
  if (!rationale.trim()) throw new ConflictException("请填写起飞决策判断依据")
  if ((decision === "ALLOW" || decision === "ALLOW_AFTER_RECTIFICATION") && items.some((item) => item.sourceStatus !== "NORMAL" && (!item.resolution || !item.resolved))) {
    throw new ConflictException("存在尚未处置完成的异常检查项，不能选择当前起飞决策")
  }
}

function serializePreflight(record: ShowPreflightRecordEntity, canEdit: boolean): ShowPreflightWorkspaceView {
  return {
    projectId: record.project.id,
    canEdit,
    revision: record.revision,
    status: record.status,
    items: normalizePreflightCategories(record.items),
    decision: record.decision,
    rationale: record.rationale,
    completedAt: record.completedAt?.toISOString() ?? null,
    updatedAt: record.updatedAt?.toISOString() ?? null
  }
}

export function normalizePreflightCategories(items: ShowPreflightItemView[]): ShowPreflightItemView[] {
  const categoryOrder = new Map([
    "AIRCRAFT",
    "GROUND_SYSTEM",
    "POSITIONING",
    "COMMUNICATION",
    "WEATHER",
    "SITE_AREA",
    "PERSONNEL",
    "APPLICATION_SUPPORT"
  ].map((category, index) => [category, index]))
  return items.map((item, index) => {
    let normalized = item
    if ((item.category as string) === "POSITIONING_COMMUNICATION") {
      normalized = {
        ...item,
        category: item.code === "CONTROL_LINK" || item.code === "DATA_LINK" ? "COMMUNICATION" : "POSITIONING"
      }
    } else if (item.category === "APPLICATION_SUPPORT" && ["SECURITY", "FIRE", "MEDICAL"].includes(item.code)) {
      normalized = { ...item, category: "PERSONNEL" }
    }
    return { item: normalized, index }
  }).sort((left, right) => (
    (categoryOrder.get(left.item.category) ?? categoryOrder.size) - (categoryOrder.get(right.item.category) ?? categoryOrder.size)
    || left.index - right.index
  )).map(({ item }) => item)
}

function currentSimulationTime(clock: ShowSimulationClockEntity): number {
  const origin = Number(clock.originSimulationTimeMs)
  if (clock.status === "PAUSED") return origin
  return Math.max(0, Math.floor(origin + (Date.now() - clock.originRealTime.getTime()) * clock.rate))
}

function parseAircraftCount(code: string): number {
  const value = Number(code.match(/(\d+)/)?.[1] ?? 0)
  return Number.isInteger(value) && value > 0 ? value : 100
}

function numberScenario(scenario: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(scenario[key] ?? fallback)
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback
}

function plannedDurationMinutes(project: StudentProjectEntity): number {
  const scenario = project.snapshot.config.scenario
  const start = Date.parse(stringScenario(scenario, "plannedFlightStartAt", ""))
  const end = Date.parse(stringScenario(scenario, "plannedFlightEndAt", ""))
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) return Math.min(180, Math.max(10, Math.round((end - start) / 60_000)))
  return numberScenario(scenario, "plannedFlightDurationMinutes", 30, 10, 180)
}

function stringScenario(scenario: Record<string, unknown>, key: string, fallback: string): string {
  const value = scenario[key]
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function normalizeRevision(value: number | undefined): number {
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision < 1) throw new BadRequestException("expectedRevision 必须为正整数")
  return revision
}
